import { TRIAGE_SIGNALS, TRIAGE_VERSION } from './risk-classification.js';

const CAPABILITIES = ['emergency_response', 'crisis_assessment', 'mental_health_counseling',
  'addiction_counseling', 'safeguarding'];
const SERVICE_NEEDS = ['mental_health_counseling', 'addiction_counseling', 'safeguarding'];
const URGENCY = { emergency:'immediate', prompt_assessment:'soon', routine_support:'planned', insufficient_information:'undetermined' };
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const REGION = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;
const fail = () => { throw new TypeError('Invalid institution catalog'); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const age = value => Number.isSafeInteger(value) && value >= 0;
const uniqueArray = (value, accepts, min = 0, max = 500) => Array.isArray(value) &&
  value.length >= min && value.length <= max && new Set(value).size === value.length && Array.from(value).every(accepts);

function exact(value, fields, required = fields) {
  if (!record(value) || Object.keys(value).some(key => !fields.includes(key)) ||
      required.some(key => !Object.hasOwn(value, key))) fail();
}

function officialUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s<>\\{}]/u.test(value)) fail();
  let url;
  try { url = new URL(value); } catch { fail(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      !url.hostname.includes('.') || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
      /^[\d.]+$/.test(url.hostname) || url.hostname.startsWith('[')) fail();
  return url.href;
}

// institutions must come from the existing server-owned directory.list().
// Contact validation and activation stay in that directory. This catalog joins
// its active IDs to approved eligibility metadata, never another contact list.
export function validateInstitutionCatalog(catalog) {
  exact(catalog, ['institutions', 'eligibilityById'], ['institutions']);
  if (!Array.isArray(catalog.institutions) || catalog.institutions.length > 500) fail();
  const metadata = catalog.eligibilityById ?? {};
  if (!record(metadata) || Object.keys(metadata).length > 500) fail();
  const eligibilityById = {};
  for (const [id, row] of Object.entries(metadata)) {
    const required = ['capabilities', 'country', 'regions', 'nationwide', 'min_age', 'max_age',
      'accepts_supporter', 'official_source_url', 'valid_until', 'availability'];
    exact(row, [...required, 'signal_codes', 'matches_unknown'], required);
    if (!ID.test(id) || !uniqueArray(row.capabilities, value => CAPABILITIES.includes(value), 1, CAPABILITIES.length) ||
        row.country !== 'KR' || !uniqueArray(row.regions, value => typeof value === 'string' && REGION.test(value)) ||
        typeof row.nationwide !== 'boolean' || !row.nationwide && !row.regions.length ||
        !age(row.min_age) || !(row.max_age === null || age(row.max_age) && row.max_age >= row.min_age) ||
        typeof row.accepts_supporter !== 'boolean' || !date(row.valid_until) ||
        !['always', 'check_with_institution'].includes(row.availability) ||
        row.signal_codes !== undefined && !uniqueArray(row.signal_codes, value => TRIAGE_SIGNALS.includes(value), 1, TRIAGE_SIGNALS.length) ||
        row.matches_unknown !== undefined && typeof row.matches_unknown !== 'boolean') fail();
    eligibilityById[id] = { ...row, capabilities:[...row.capabilities], regions:[...row.regions],
      ...(row.signal_codes ? {signal_codes:[...row.signal_codes]} : {}), official_source_url:officialUrl(row.official_source_url) };
  }
  const ids = new Set();
  const institutions = Array.from(catalog.institutions, row => {
    if (!record(row) || typeof row.id !== 'string' || !ID.test(row.id) || ids.has(row.id) ||
        !uniqueArray(row.urgencies, value => Object.values(URGENCY).includes(value), 1, 4) ||
        !date(row.last_verified_on) || !Array.isArray(row.actions) || !row.actions.length ||
        !Array.from(row.actions).every(action => record(action) && ['phone', 'booking'].includes(action.kind))) fail();
    if (Object.hasOwn(eligibilityById, row.id) && row.last_verified_on > eligibilityById[row.id].valid_until) fail();
    ids.add(row.id);
    // Only contact presence is needed for immediate routing. Do not copy names,
    // URLs or phone numbers into this module's result or maintain another copy.
    return { id:row.id, urgencies:[...row.urgencies], last_verified_on:row.last_verified_on,
      actions:row.actions.map(action => ({ kind:action.kind })) };
  });
  return { institutions, eligibilityById };
}

function validateInputs(triage, context) {
  if (!record(triage) || triage.version !== TRIAGE_VERSION ||
      typeof triage.intake_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(triage.intake_id) ||
      !Number.isSafeInteger(triage.revision) || triage.revision < 0 ||
      typeof triage.snapshot_id !== 'string' || !/^[a-f0-9]{64}$/.test(triage.snapshot_id) ||
      typeof triage.action !== 'string' || !Object.hasOwn(URGENCY, triage.action) ||
      !['assessed', 'needs_review', 'unavailable'].includes(triage.status) ||
      !uniqueArray(triage.service_needs, value => SERVICE_NEEDS.includes(value), 0, SERVICE_NEEDS.length) ||
      typeof triage.professional_review_required !== 'boolean' || triage.routing_signals !== undefined &&
      !uniqueArray(triage.routing_signals, value => TRIAGE_SIGNALS.includes(value), 0, TRIAGE_SIGNALS.length)) throw new TypeError('Invalid referral triage');
  if (!record(context) || !Object.hasOwn(context, 'country') || !Object.hasOwn(context, 'region') ||
      !Object.hasOwn(context, 'age') || !(context.country === null || context.country === 'KR') ||
      !(context.region === null || typeof context.region === 'string' && REGION.test(context.region)) ||
      !(context.age === null || age(context.age)) || !['patient', 'supporter'].includes(context.requester) ||
      !date(context.asOf)) throw new TypeError('Invalid institution routing context');
  const urgency = URGENCY[triage.action];
  if (context.effectiveUrgency !== undefined && context.effectiveUrgency !== urgency &&
      !(['soon', 'planned'].includes(urgency) && context.effectiveUrgency === 'undetermined'))
    throw new TypeError('Invalid effective referral urgency');
}

// Pass a server-owned result checked with assertCurrentTriage. Identity shape
// validation cannot prove session ownership. Explicit context supplies the date,
// location and actual age; this function infers none and performs no I/O.
export function routeInstitutions(triage, catalog, routingContext) {
  validateInputs(triage, routingContext);
  const emergency = triage.action === 'emergency';
  const urgency = routingContext.effectiveUrgency ?? URGENCY[triage.action];
  const assessment = !emergency && (urgency === 'undetermined' || triage.action !== 'routine_support' ||
    triage.status !== 'assessed' || triage.professional_review_required);
  const capabilities = emergency ? ['emergency_response'] : assessment ? ['crisis_assessment']
    : triage.service_needs.length ? triage.service_needs : ['mental_health_counseling'];
  const reasons = emergency ? ['emergency_response_required'] : assessment ? ['professional_assessment_required'] : [];
  const result = (status, institution_ids = [], missing_fields = [], extraReasons = []) => ({
    action:triage.action, status, institution_ids, missing_fields, reason_codes:[...reasons, ...extraReasons],
    requires_user_action:true,
  });
  const checked = catalog === null || catalog === undefined ? null : validateInstitutionCatalog(catalog);
  if (!checked?.institutions.length) return result('not_configured', [], [], ['catalog_not_configured']);

  const { country, region, age:actualAge, requester, asOf } = routingContext;
  const matched = [], missing = new Set();
  for (const institution of checked.institutions) {
    if (!Object.hasOwn(checked.eligibilityById, institution.id)) continue;
    const row = checked.eligibilityById[institution.id];
    const signals = triage.routing_signals ?? [];
    if (row.signal_codes && (signals.length ? !signals.some(code => row.signal_codes.includes(code)) : !row.matches_unknown)) continue;
    if (!institution.urgencies.includes(urgency) || institution.last_verified_on > asOf || row.valid_until < asOf ||
        !row.capabilities.some(value => capabilities.includes(value)) ||
        emergency && (row.availability !== 'always' || !institution.actions.some(action => action.kind === 'phone')) ||
        requester === 'supporter' && !row.accepts_supporter || country !== null && country !== row.country ||
        region !== null && !row.nationwide && !row.regions.includes(region) ||
        actualAge !== null && (actualAge < row.min_age || row.max_age !== null && actualAge > row.max_age)) continue;
    const needed = [];
    if (country === null) needed.push('country');
    if (region === null && !row.nationwide) needed.push('region');
    if (actualAge === null && (row.min_age !== 0 || row.max_age !== null)) needed.push('age');
    if (needed.length) needed.forEach(field => missing.add(field));
    else matched.push(institution.id);
  }
  if (matched.length) return result('matched', matched.sort());
  if (missing.size) return result('needs_information', [], ['country', 'region', 'age'].filter(field => missing.has(field)),
    ['eligibility_information_required']);
  return result('no_verified_match', [], [], ['no_verified_eligible_institution']);
}
