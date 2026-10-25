import { HttpError } from './errors.js';
import { safetySources } from './relationship-agent.js';
import { TRIAGE_VERSION, classifyForReferral, assertCurrentTriage, triageSources } from './risk-classification.js';
import { routeInstitutions, validateInstitutionCatalog } from './institution-routing.js';

const urgencyFor = {emergency:'immediate', prompt_assessment:'soon', routine_support:'planned', insufficient_information:'undetermined'};
const immediateCodes = new Set(['current_suicidal_thoughts', 'self_harm_action', 'immediate_violence', 'physical_emergency']);
const seriousCodes = new Set([...immediateCodes, 'wish_to_die_or_self_harm_concern', 'self_harm_history', 'abuse_or_neglect', 'severe_function_impairment']);
const unique = values => [...new Set(values)].sort();
const mismatch = () => new HttpError(502, 'REFERRAL_SOURCE_MISMATCH', '분류 근거를 확인하지 못했어요.');
const bundle = source => JSON.stringify([source.record_subject ?? source.subject, source.question_id, source.components]);
const signalKey = signal => JSON.stringify([signal.code, signal.person, signal.assertion,
  signal.timeframe, signal.report_type, unique(signal.source_ids)]);

function supportsCounselingCard(signal, findings) {
  // Safety concerns keep their existing path. An ordinary concern must be a
  // current report independently selected twice, not a union of guesses.
  if (seriousCodes.has(signal.code)) return true;
  if (signal.assertion !== 'reported' || signal.person === 'unclear' ||
      !['current', 'recent'].includes(signal.timeframe) || findings.length !== 2) return false;
  const key = signalKey(signal);
  return findings.every(finding => finding.signals.some(candidate => signalKey(candidate) === key));
}

// Join full original bundles, never replace triage_/safety_ prefixes or use a
// quote substring. The HTTP boundary still owns session/revision validation.
export function referralEvidenceMap(context, sources) {
  const expected = safetySources(context);
  if (!Array.isArray(sources) || sources.length !== expected.length) throw mismatch();
  const actual = new Map(sources.map(source => [source?.id, source]));
  if (actual.size !== sources.length || expected.some(source => JSON.stringify(actual.get(source.id)) !== JSON.stringify(source))) throw mismatch();
  const byBundle = new Map(expected.map(source => [bundle(source), source.id]));
  if (byBundle.size !== expected.length) throw mismatch();
  return new Map(triageSources(context).filter(source => source.status === 'answered').map(source => {
    const id = byBundle.get(bundle(source));
    if (!id) throw mismatch();
    return [source.id, id];
  }));
}

// Construction is explicit; importing this module does not activate a model.
// resolveRoutingContext must use server-owned, explicitly supplied eligibility
// data for the people in the result. It must not infer age/location from prose.
export function createModelReferralProvider({gateway, eligibilityById = {}, resolveRoutingContext,
  modelVersion, now = () => new Date(), onDiagnostic = event => process.stderr.write(JSON.stringify(event) + '\n')} = {}) {
  if (!gateway || typeof gateway.operation !== 'function' || typeof gateway.agentComplete !== 'function' ||
      typeof resolveRoutingContext !== 'function' || typeof modelVersion !== 'string' || !modelVersion.trim() ||
      modelVersion.length > 100 || typeof now !== 'function' || typeof onDiagnostic !== 'function') throw new TypeError('Invalid referral provider configuration');
  const eligibility = validateInstitutionCatalog({institutions:[], eligibilityById}).eligibilityById;
  return async input => {
    if (input?.schema_version !== '1.0' || input.subject !== 'patient' || !(input.signal instanceof AbortSignal))
      throw new TypeError('Invalid referral provider input');
    const context = structuredClone(input.context);
    const identity = {intakeId:input.intake_id, revision:input.revision};
    const evidence = referralEvidenceMap(context, input.sources);
    const knownIds = new Set(input.sources.map(source => source.id));
    // Mandatory server-owned envelope prevents a new provider silently dropping
    // a previously confirmed urgent signal when the HTTP adapter is incomplete.
    const existing = input.existing_safety;
    if (!existing || typeof existing.urgent !== 'boolean' || !Array.isArray(existing.evidence_source_ids) ||
        new Set(existing.evidence_source_ids).size !== existing.evidence_source_ids.length ||
        existing.evidence_source_ids.some(id => !knownIds.has(id)) ||
        existing.urgent && !existing.evidence_source_ids.length) throw mismatch();
    if (input.signal.aborted) throw new HttpError(499, 'TRIAGE_CANCELLED', '분류 요청이 취소됐어요.');
    const triage = await classifyForReferral(gateway, context, {...identity, signal:input.signal,
      requestId:input.request_id, existingUrgent:existing.urgent});
    if (input.signal.aborted) throw new HttpError(499, 'TRIAGE_CANCELLED', '분류 요청이 취소됐어요.');
    if (triage.status === 'unavailable') throw new HttpError(502, 'REFERRAL_MODEL_UNAVAILABLE', '분류를 확인하지 못했어요.');
    assertCurrentTriage(triage, input.context, identity);
    const mapped = ids => unique(ids.map(id => {
      if (!evidence.has(id)) throw mismatch();
      return evidence.get(id);
    }));
    const signals = triage.findings.flatMap(finding => finding.signals);
    const active = signals.filter(signal => ['reported', 'uncertain'].includes(signal.assertion));
    const concernSources = new Set(input.sources.filter(source => source.question_id !== 'name').map(source => source.id));
    const concerns = [...new Map(active.filter(signal => supportsCounselingCard(signal, triage.findings)).flatMap(signal => {
      const ids = mapped(signal.source_ids).filter(id => concernSources.has(id));
      if (!ids.length) return [];
      const concern = {code:signal.code, subject:signal.person, evidence_source_ids:ids};
      return [[JSON.stringify(concern), concern]];
    })).values()];
    const alerts = active.filter(signal => signal.person !== 'patient' && seriousCodes.has(signal.code));
    const emergencyAlerts = alerts.filter(signal => signal.assertion === 'reported' && signal.timeframe === 'current' && immediateCodes.has(signal.code));
    const selectedAlerts = emergencyAlerts.length ? emergencyAlerts : alerts;
    const safetyAlert = existing.urgent ? {urgency:'immediate', subjects:['unclear'], evidence_source_ids:[...existing.evidence_source_ids]}
      : selectedAlerts.length ? {urgency:emergencyAlerts.length ? 'immediate' : 'soon', subjects:unique(selectedAlerts.map(signal => signal.person)),
        evidence_source_ids:mapped(selectedAlerts.flatMap(signal => signal.source_ids))} : null;
    const reviewed = triage.status === 'assessed' && triage.review_status === 'agreed' && !triage.professional_review_required;
    const urgency = urgencyFor[triage.patient_action];
    let institutionIds = [];
    try {
      const actualDate = now();
      if (!(actualDate instanceof Date) || !Number.isFinite(actualDate.getTime())) throw new TypeError('Invalid referral clock');
      const routing = resolveRoutingContext(input, structuredClone(triage));
      if (routing && typeof routing.then === 'function') {
        Promise.resolve(routing).catch(() => {});
        throw new TypeError('Referral eligibility must be resolved locally without waiting');
      }
      const catalog = {institutions:input.institutions, eligibilityById:eligibility};
      const effectiveUrgency = !reviewed && triage.action === 'routine_support' ? 'undetermined' : urgencyFor[triage.action];
      institutionIds = routeInstitutions(triage, catalog, {...routing, asOf:actualDate.toISOString().slice(0, 10), effectiveUrgency}).institution_ids;
    } catch {
      // Unavailable eligibility/catalog data must not erase a completed urgent
      // assessment. No guessed or stale institution is substituted.
      try {
        Promise.resolve(onDiagnostic({event:'referral_routing_failed', code:'REFERRAL_ROUTING_UNAVAILABLE'})).catch(() => {});
      } catch { /* Preserve completed urgency even if logging fails. */ }
    }
    if (input.signal.aborted) throw new HttpError(499, 'TRIAGE_CANCELLED', '분류 요청이 취소됐어요.');
    assertCurrentTriage(triage, input.context, identity);
    return {schema_version:'1.0', subject:'patient', urgency, reviewed,
      evidence_source_ids:mapped(signals.filter(signal => signal.person === 'patient').flatMap(signal => signal.source_ids)),
      concerns,
      institution_ids:institutionIds.slice(0, 20), model_version:`${modelVersion}/${TRIAGE_VERSION}`,
      ...(safetyAlert ? {safety_alert:safetyAlert} : {})};
  };
}
