import { HttpError, object } from './errors.js';
import { createHash } from 'node:crypto';
import { buildContext } from './intake.js';
import { safetySources } from './relationship-agent.js';
import { REFERRAL_URGENCIES, createReferralDirectory } from './referral-directory.js';
import { createCharacterRegistry } from './guide-characters.js';
import { createReferralMessages } from './referral-messages.js';
import { validReferralConcerns, resolveReferralConcerns } from './referral-concerns.js';

const invalid = () => new HttpError(502, 'REFERRAL_INVALID_RESPONSE', '도움 안내를 확인하지 못했어요. 잠시 후 다시 확인해 주세요.');
const conflict = () => new HttpError(409, 'REVISION_CONFLICT', '대화가 변경됐어요. 최신 내용으로 다시 확인해 주세요.');
const cancelled = () => new HttpError(499, 'REFERRAL_CANCELLED', '도움 안내 요청이 취소됐어요.');
const uniqueStrings = (value, max) => Array.isArray(value) && value.length <= max &&
  value.every(item => typeof item === 'string') && new Set(value).size === value.length;
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Only reported source bundles and the separately approved safety signal can
// justify carrying an assessment across final guide generation.
export const referralSnapshotFingerprint = state => fingerprint([safetySources(buildContext(state)),state.safetySignal ?? null]);

function existingSafety(state, sources) {
  const signal = state.safetySignal;
  if (signal?.urgent !== true) return {urgent:false, evidence_source_ids:[]};
  const stale = () => { throw new HttpError(409, 'REFERRAL_SAFETY_STALE', '기존 긴급 안내의 근거를 다시 확인해야 해요.'); };
  // An approved urgent turn ends intake. Corrections clear safetySignal; never
  // turn an old partial quote or an unreviewed proposal into current urgency.
  if (state.status !== 'ready' || signal.review?.basis !== 'current_physical_danger' ||
      !Array.isArray(signal.evidence) || !signal.evidence.length) stale();
  const selected = new Map();
  for (const ref of signal.evidence) {
    const source = sources.find(row => row.subject === ref?.subject && row.question_id === ref?.question_id);
    if (!source || typeof ref.quote !== 'string' || !source.components.some(row => row.text === ref.quote)) stale();
    if (!selected.has(source.id)) selected.set(source.id, {source, quotes:new Set()});
    const quotes = selected.get(source.id).quotes;
    if (quotes.has(ref.quote)) stale();
    quotes.add(ref.quote);
  }
  for (const {source, quotes} of selected.values()) {
    if (source.components.some(row => !quotes.has(row.text))) stale();
  }
  return {urgent:true, evidence_source_ids:[...selected.keys()]};
}

function checkedPlan(value, sources, directory) {
  const sourceIds = new Set(sources.map(source => source.id));
  const keys = ['schema_version','subject','urgency','reviewed','evidence_source_ids','institution_ids','model_version'];
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key) && !['safety_alert','concerns'].includes(key)) || keys.some(key => !Object.hasOwn(value,key)) ||
      value.schema_version !== '1.0' || value.subject !== 'patient' || !REFERRAL_URGENCIES.includes(value.urgency) ||
      typeof value.reviewed !== 'boolean' || typeof value.model_version !== 'string' || !value.model_version.trim() || value.model_version.length > 160 ||
      !uniqueStrings(value.evidence_source_ids, 100) || value.evidence_source_ids.some(id => !sourceIds.has(id)) ||
      !uniqueStrings(value.institution_ids, 20) || value.institution_ids.some(id => !directory.has(id)) ||
      (value.urgency !== 'undetermined' && !value.evidence_source_ids.length)) throw invalid();
  if (!validReferralConcerns(value.concerns, sources)) throw invalid();
  if (value.safety_alert !== undefined && value.safety_alert !== null) {
    const alert = value.safety_alert;
    const fields = ['urgency', 'subjects', 'evidence_source_ids'];
    if (!alert || typeof alert !== 'object' || Array.isArray(alert) ||
        Object.keys(alert).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(alert,key)) ||
        !['immediate','soon'].includes(alert.urgency) || !uniqueStrings(alert.subjects, 4) || !alert.subjects.length ||
        alert.subjects.some(subject => !['patient','supporter','other','unclear'].includes(subject)) ||
        !uniqueStrings(alert.evidence_source_ids, 100) || !alert.evidence_source_ids.length ||
        alert.evidence_source_ids.some(id => !sourceIds.has(id))) throw invalid();
  }
  return structuredClone(value);
}

// This boundary orchestrates trusted server-side providers; it does not infer
// a risk level from keywords, guide.top, or the legacy safety:false boolean.
export function createReferralGuidance({store, provider = null, providerForState, directory = createReferralDirectory(),
  characters = createCharacterRegistry(), messages = createReferralMessages(), timeoutMs = 0,
  cacheVersion = 'referral-final-v2', cacheTtlMs = 86400000, now = () => Date.now()} = {}) {
  if (provider !== null && typeof provider !== 'function') throw new TypeError('Referral provider must be a function');
  if(providerForState!==undefined&&typeof providerForState!=='function')throw new TypeError('Invalid referral provider resolver');
  const selectedProvider=state=>providerForState?providerForState(state):provider;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 120000) throw new TypeError('Invalid referral timeout');
  if(typeof cacheVersion!=='string'||!cacheVersion||cacheVersion.length>256||!Number.isInteger(cacheTtlMs)||cacheTtlMs<1||cacheTtlMs>86400000||typeof now!=='function')throw new TypeError('Invalid referral cache configuration');
  const runs = new Map();
  const cancel = (owner, id, reason = conflict(), keepRevision) => {
    for (const [key, run] of runs) {
      if (run.owner !== owner || id !== undefined && run.id !== id || run.revision === keepRevision) continue;
      run.controller.abort(reason);
      runs.delete(key);
    }
  };
  const shutdown = () => {
    for (const run of runs.values()) run.controller.abort(cancelled());
    runs.clear();
  };
  // A request owns a subscription, not the shared assessment. One disconnected
  // caller must not cancel another caller's same-revision classification.
  const subscribe = (run, signal) => {
    const subscriber = Symbol(); run.subscribers.add(subscriber);
    let onAbort, onCancel;
    return new Promise((resolve, reject) => {
      onAbort = () => reject(cancelled());
      onCancel = () => reject(run.controller.signal.reason || cancelled());
      signal?.addEventListener('abort', onAbort, {once:true});
      run.controller.signal.addEventListener('abort', onCancel, {once:true});
      run.promise.then(resolve, reject);
      if (signal?.aborted) onAbort();
      else if (run.controller.signal.aborted) onCancel();
    }).finally(() => {
      signal?.removeEventListener('abort', onAbort);
      run.controller.signal.removeEventListener('abort', onCancel);
      run.subscribers.delete(subscriber);
      if (!run.finished && !run.subscribers.size) run.controller.abort(cancelled());
    });
  };
  async function assess(owner, id, input, requestId, {signal} = {}) {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Invalid cancellation signal');
    if (signal?.aborted) throw cancelled();
    object(input, ['revision', 'character_id']);
    if (!Number.isInteger(input.revision) || input.revision < 0 ||
        (input.character_id !== undefined && (typeof input.character_id !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(input.character_id)))) {
      throw new HttpError(422, 'INVALID_INPUT', '입력 형식을 확인해 주세요.');
    }
    const row = await store.intake(owner, id);
    if (row.revision !== input.revision) throw conflict();
    // buildContext includes a persisted, structurally validated submitted answer
    // even when the separate dialogue model has not accepted its next prompt.
    // That model's failure must not suppress independent safety classification.
    if (row.state.modelPending && !row.state.modelPending.prepared) throw new HttpError(409, 'REFERRAL_INPUT_PENDING', '저장된 답변을 확인한 뒤 도움 안내를 확인해 주세요.');
    const runKey = `${owner}:${id}:${row.revision}`;
    const run = async signal => {
      if (signal.aborted) throw signal.reason || cancelled();
      const context = buildContext(row.state), sources = safetySources(context);
      const existing = existingSafety(row.state, sources);
      const existingAlert = existing.urgent ? {urgency:'immediate', subjects:['unclear'],
        evidence_source_ids:[...existing.evidence_source_ids]} : null;
      const unavailable = (failureCode = null) => ({status:'model_unavailable', failureCode,
        concerns:resolveReferralConcerns([], sources, existing), plan:existing.urgent ? {
        urgency:'undetermined', reviewed:false, institution_ids:[],
        safety_alert:existingAlert,
      } : null});
      let activeProvider;
      try{activeProvider=selectedProvider(row.state);}catch{return unavailable();}
      if (!activeProvider) return unavailable();
      const cacheable=row.state.status==='ready'&&!row.state.modelPending;
      const sourceHash=referralSnapshotFingerprint(row.state);
      const currentTime=now();
      if(!Number.isFinite(currentTime))throw new TypeError('Invalid referral clock');
      // Routing eligibility uses a calendar date; a cached contact must not
      // outlive that date even when its 24-hour assessment TTL has not elapsed.
      const policyHash=fingerprint([cacheVersion,row.state.modelProfileId??null,activeProvider.cacheKey ?? null,directory.list(),new Date(currentTime).toISOString().slice(0,10)]);
      const cached=row.state.referralAssessment;
      let cachedPlan=null;
      if(cacheable&&cached?.schema_version==='1.0'&&cached.revision===row.revision&&cached.source_hash===sourceHash&&cached.policy_hash===policyHash&&
        Number.isFinite(cached.saved_at)&&cached.saved_at<=currentTime&&currentTime-cached.saved_at<cacheTtlMs){
        try{cachedPlan=checkedPlan(cached.plan,sources,directory);}catch{/* A changed or malformed cache must be classified again. */}
      }
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason || cancelled());
      signal.addEventListener('abort', abort, {once:true});
      if (signal.aborted) abort();
      let timer, value, onAbort;
      try {
        if(cachedPlan)value=cachedPlan;
        else{
          const stopped = new Promise((_, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, {once:true});
          if (controller.signal.aborted) onAbort();
        });
        if (timeoutMs > 0) timer = setTimeout(() => controller.abort(new Error('Referral deadline')), timeoutMs);
          value = await Promise.race([stopped, Promise.resolve().then(() => {
          if (controller.signal.aborted) throw controller.signal.reason;
          return activeProvider({
            schema_version:'1.0', subject:'patient', context:structuredClone(context),
            sources:structuredClone(sources), institutions:directory.list().institutions,
            existing_safety:structuredClone(existing),
            intake_id:id, revision:row.revision, request_id:requestId, signal:controller.signal,
          });
          })]);
        }
      } catch {
        if (signal.aborted) throw signal.reason || cancelled();
        // No provider error text or conversation is returned or logged.
        return unavailable();
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if(onAbort)controller.signal.removeEventListener('abort', onAbort);
      }
      let plan;
      try { plan = checkedPlan(value, sources, directory); }
      catch (error) {
        if (existing.urgent && error.code === 'REFERRAL_INVALID_RESPONSE') return unavailable(error.code);
        throw error;
      }
      if(signal.aborted)throw signal.reason||cancelled();
      if(cacheable&&!cachedPlan&&typeof store.saveReferralAssessment==='function'){
        const savedAt=now();
        if(!Number.isFinite(savedAt))throw new TypeError('Invalid referral clock');
        await store.saveReferralAssessment(owner,id,row.revision,{schema_version:'1.0',revision:row.revision,
          source_hash:sourceHash,policy_hash:policyHash,saved_at:savedAt,plan:structuredClone(plan)},{signal});
      }
      // Keep separately attributed concerns at their own urgency. Combining a
      // supporter's "soon" alert with an unclear emergency would misattribute it.
      const preservedAlert = plan.safety_alert ? existingAlert : null;
      if (!plan.safety_alert && existingAlert) plan.safety_alert = existingAlert;
      return {plan, preservedAlert, concerns:resolveReferralConcerns(plan.concerns, sources, existing), status:'ready'};
    };
    if (!runs.has(runKey) || runs.get(runKey).controller.signal.aborted) {
      const active = {owner, id, revision:row.revision, controller:new AbortController(), subscribers:new Set(), finished:false};
      active.promise = Promise.resolve().then(() => run(active.controller.signal)).finally(() => {
        active.finished = true;
        if (runs.get(runKey) === active) runs.delete(runKey);
      });
      runs.set(runKey, active);
    }
    const {plan, preservedAlert, concerns, failureCode = null, status:initialStatus} = await subscribe(runs.get(runKey), signal);
    if (signal?.aborted) throw cancelled();
    // A slow provider cannot restore deleted content or return an old assessment
    // after correction. Cached metadata never advances a conversation revision.
    const latest = await store.intake(owner, id);
    if (latest.revision !== row.revision) throw conflict();
    let urgency = plan?.urgency || 'undetermined';
    if (plan && !plan.reviewed && urgency === 'planned') urgency = 'undetermined';
    // A separate alert can concern the informant or an unclear person. Preserve
    // its priority without reclassifying that danger as the patient's condition.
    const alert = plan?.safety_alert;
    const priority = {planned:0, undetermined:1, soon:2, immediate:3};
    const guidanceUrgency = [alert, preservedAlert].filter(Boolean).reduce(
      (current, item) => priority[item.urgency] > priority[current] ? item.urgency : current, urgency);
    const institutions = plan ? directory.select(plan.institution_ids, guidanceUrgency) : [];
    const needsReview = !plan || !plan.reviewed || urgency === 'undetermined' || urgency === 'soon' || Boolean(alert || preservedAlert);
    let status = initialStatus === 'ready' && needsReview ? 'needs_review' : initialStatus;
    if (status === 'ready' && !institutions.length) status = directory.list().configured ? 'no_matching_institution' : 'institutions_unconfigured';
    const message = messages.get(guidanceUrgency);
    return {
      schema_version:'1.0', revision:row.revision, subject:'patient', status,
      failure_code:failureCode,
      assessment:{urgency, needs_review:needsReview, clinically_validated:false},
      safety_alert:alert ? {urgency:alert.urgency, subjects:[...alert.subjects]} : null,
      preserved_safety_alert:preservedAlert ? {urgency:preservedAlert.urgency, subjects:[...preservedAlert.subjects]} : null,
      guidance:{message:message.text, message_id:message.id, urgency:guidanceUrgency, urgent:guidanceUrgency === 'immediate',
        concerns, institutions, connection_mode:'contact_links', automatically_contacted:false,
        conversation_shared:false},
      presentation:characters.present(input.character_id,
        {immediate:'attention',soon:'speaking',planned:'empathy',undetermined:'listening'}[guidanceUrgency]),
    };
  }
  return Object.freeze({assess, cancel, shutdown, characters:() => characters.list(), institutions:() => directory.list(),
    available:state => {
      let activeProvider;try{activeProvider=selectedProvider(state);}catch{return false;}
      return activeProvider!=null && state.status === 'ready' && !state.modelPending &&
        safetySources(buildContext(state)).some(source => source.question_id !== 'name');
    }});
}
