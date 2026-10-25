import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferralDirectory } from '../src/referral-directory.js';
import { routeInstitutions, validateInstitutionCatalog } from '../src/institution-routing.js';
import { TRIAGE_VERSION } from '../src/risk-classification.js';

// Synthetic fixtures only. Contacts continue to belong to the existing directory.
const eligibility = (extra = {}) => ({ capabilities:['mental_health_counseling'], country:'KR', regions:[], nationwide:true,
  min_age:0, max_age:null, accepts_supporter:true, official_source_url:'https://routing.example.invalid/services',
  valid_until:'2026-10-31', availability:'check_with_institution', ...extra });
const institution = (extra = {}, scope = {}) => ({ id:'synthetic-general', name:'합성 라우팅 검증 기관', active:true,
  urgencies:['planned', 'soon', 'undetermined'], phone:null, booking_url:'https://routing.example.invalid/contact',
  last_verified_on:'2026-10-01', ...extra, eligibility:eligibility(scope) });
const catalog = (rows = [institution()]) => ({
  institutions:createReferralDirectory({ schema_version:'1.0', institutions:rows.map(({ eligibility, ...row }) => row) }).list().institutions,
  eligibilityById:Object.fromEntries(rows.map(row => [row.id, row.eligibility])),
});
const triage = (extra = {}) => ({ version:TRIAGE_VERSION, intake_id:'11111111-2222-4333-8444-555555555555',
  revision:0, snapshot_id:'a'.repeat(64), action:'routine_support', status:'assessed', service_needs:[],
  professional_review_required:false, ...extra });
const context = (extra = {}) => ({ country:'KR', region:null, age:null, requester:'supporter', asOf:'2026-10-18', ...extra });
const route = (rows, finding = {}, eligibilityContext = {}) => routeInstitutions(triage(finding), catalog(rows), context(eligibilityContext));
const reject = value => assert.throws(() => validateInstitutionCatalog(value), /Invalid institution catalog/);

test('emergency requires immediate capability, verified always-available response and a directory phone', () => {
  const rows = [institution(),
    institution({ id:'synthetic-assessment', urgencies:['immediate'], phone:'000-000-0000' },
      { capabilities:['crisis_assessment'], availability:'always' }),
    institution({ id:'synthetic-emergency', urgencies:['immediate'], phone:'000-000-0000' },
      { capabilities:['emergency_response'], availability:'always' }),
    institution({ id:'synthetic-limited-emergency', urgencies:['immediate'], phone:'000-000-0000' },
      { capabilities:['emergency_response'] }),
    institution({ id:'synthetic-booking-only', urgencies:['immediate'] },
      { capabilities:['emergency_response'], availability:'always' }),
    institution({ id:'synthetic-planned-only', phone:'000-000-0000' },
      { capabilities:['emergency_response'], availability:'always' })];
  const finding = { action:'emergency', status:'needs_review', professional_review_required:true };
  const result = route(rows, finding);
  assert.equal(result.action, 'emergency');
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.institution_ids, ['synthetic-emergency']);
  assert.ok(result.reason_codes.includes('emergency_response_required'));
  const noMatch = route(rows.filter(row => row.id !== 'synthetic-emergency'), finding);
  assert.equal(noMatch.action, 'emergency');
  assert.equal(noMatch.status, 'no_verified_match');
  assert.deepEqual(noMatch.institution_ids, []);
});

test('prompt, insufficient, failed and review-required classifications require crisis assessment', () => {
  const rows = [institution(), institution({ id:'synthetic-addiction' }, { capabilities:['addiction_counseling'] }),
    institution({ id:'synthetic-assessment' }, { capabilities:['crisis_assessment'] })];
  for (const finding of [{ action:'prompt_assessment' }, { action:'insufficient_information' }, { status:'unavailable' },
    { status:'needs_review', service_needs:['addiction_counseling'] }, { professional_review_required:true }]) {
    const result = route(rows, finding);
    assert.equal(result.action, finding.action || 'routine_support');
    assert.deepEqual(result.institution_ids, ['synthetic-assessment']);
    assert.ok(result.reason_codes.includes('professional_assessment_required'));
    assert.equal(route([institution()], finding).status, 'no_verified_match');
  }
  assert.deepEqual(route([institution({ urgencies:['immediate'], phone:'000-000-0000' },
    { capabilities:['emergency_response'], availability:'always' })],
  { action:'emergency', status:'unavailable', professional_review_required:true }).institution_ids, ['synthetic-general']);
});

test('effective urgency can only match or defer non-emergency routing to undetermined', () => {
  const rows = [institution({ id:'synthetic-soon-only', urgencies:['soon'] }, { capabilities:['crisis_assessment'] }),
    institution({ id:'synthetic-undetermined', urgencies:['undetermined'] }, { capabilities:['crisis_assessment'] })];
  assert.deepEqual(route(rows, { action:'prompt_assessment' }).institution_ids, ['synthetic-soon-only']);
  const deferred = route(rows, { action:'prompt_assessment', status:'needs_review' }, { effectiveUrgency:'undetermined' });
  assert.equal(deferred.action, 'prompt_assessment');
  assert.deepEqual(deferred.institution_ids, ['synthetic-undetermined']);
  assert.deepEqual(route(rows, {}, { effectiveUrgency:'undetermined' }).institution_ids, ['synthetic-undetermined']);
  assert.equal(route([institution()], {}, { effectiveUrgency:'planned' }).status, 'matched');
  for (const [action, effectiveUrgency] of [['emergency', 'undetermined'], ['emergency', 'soon'], ['emergency', 'planned'],
    ['prompt_assessment', 'planned'], ['routine_support', 'soon'], ['insufficient_information', 'planned'],
    ['routine_support', 'unknown'], ['routine_support', null]])
    assert.throws(() => route(rows, { action }, { effectiveUrgency }), /Invalid effective referral urgency/);
});

test('routine support uses explicit services or general counseling without guessing a specialty', () => {
  const rows = [institution(), institution({ id:'synthetic-addiction' }, { capabilities:['addiction_counseling'] }),
    institution({ id:'synthetic-safeguarding' }, { capabilities:['safeguarding'] }),
    institution({ id:'synthetic-assessment' }, { capabilities:['crisis_assessment'] })];
  assert.deepEqual(route(rows).institution_ids, ['synthetic-general']);
  assert.deepEqual(route(rows, { service_needs:['addiction_counseling'] }).institution_ids, ['synthetic-addiction']);
  assert.deepEqual(route(rows, { service_needs:['safeguarding', 'mental_health_counseling'] }).institution_ids,
    ['synthetic-general', 'synthetic-safeguarding']);
  assert.equal(route(rows.slice(1)).status, 'no_verified_match');
});

test('only directory-active records within the inclusive verification window may match', () => {
  const rows = [institution({ id:'synthetic-boundary', last_verified_on:'2026-10-18' }, { valid_until:'2026-10-18' }),
    institution({ id:'synthetic-inactive', active:false }),
    institution({ id:'synthetic-expired' }, { valid_until:'2026-10-17' }),
    institution({ id:'synthetic-future', last_verified_on:'2026-10-19' })];
  assert.deepEqual(route(rows).institution_ids, ['synthetic-boundary']);
  assert.equal(route(rows.slice(1)).status, 'no_verified_match');
});

test('missing age and region admit only explicitly all-age and nationwide records', () => {
  const restricted = institution({ id:'synthetic-local' }, { nationwide:false, regions:['KR-11'], min_age:18, max_age:64 });
  const missing = route([restricted]);
  assert.equal(missing.status, 'needs_information');
  assert.deepEqual(missing.missing_fields, ['region', 'age']);
  assert.deepEqual(missing.institution_ids, []);
  assert.deepEqual(route([restricted], {}, { age:24 }).missing_fields, ['region']);
  assert.deepEqual(route([restricted], {}, { region:'KR-11' }).missing_fields, ['age']);
  const admitted = route([restricted, institution()]);
  assert.deepEqual(admitted.institution_ids, ['synthetic-general']);
  assert.deepEqual(admitted.missing_fields, []);
  for (const min_age of [0, 1]) {
    const limited = route([institution({}, { min_age, max_age:17 })]);
    assert.equal(limited.status, 'needs_information');
    assert.deepEqual(limited.missing_fields, ['age']);
  }
});

test('country is explicit and never inferred from a Korean directory or region', () => {
  const result = route([institution()], {}, { country:null, region:'KR-11', age:30 });
  assert.equal(result.status, 'needs_information');
  assert.deepEqual(result.missing_fields, ['country']);
  assert.deepEqual(result.institution_ids, []);
  const emergency = route([institution({ urgencies:['immediate'], phone:'000-000-0000' },
    { capabilities:['emergency_response'], availability:'always' })], { action:'emergency' }, { country:null });
  assert.equal(emergency.action, 'emergency');
  assert.equal(emergency.status, 'needs_information');
});

test('known age bounds and exact regions determine eligibility without prefix matching', () => {
  const rows = [institution({}, { nationwide:false, regions:['KR-11'], min_age:18, max_age:64 })];
  for (const age of [18, 64]) assert.equal(route(rows, {}, { region:'KR-11', age }).status, 'matched');
  for (const age of [0, 17, 65]) assert.equal(route(rows, {}, { region:'KR-11', age }).status, 'no_verified_match');
  for (const region of ['KR-1', 'KR-110', 'KR-26'])
    assert.equal(route(rows, {}, { region, age:30 }).status, 'no_verified_match');
  assert.equal(route(rows, {}, { region:'KR-26' }).status, 'no_verified_match');
  assert.equal(route([institution()], {}, { region:'KR-26', age:0 }).status, 'matched');
});

test('a provider that accepts only patients is never offered to a supporter', () => {
  const rows = [institution({}, { accepts_supporter:false })];
  assert.equal(route(rows).status, 'no_verified_match');
  assert.equal(route(rows, {}, { requester:'patient' }).status, 'matched');
});

test('absent and empty catalogs report not_configured and preserve emergency action', () => {
  for (const config of [null, undefined, catalog([])]) {
    const result = routeInstitutions(triage({ action:'emergency' }), config, context());
    assert.equal(result.status, 'not_configured');
    assert.equal(result.action, 'emergency');
    assert.deepEqual(result.institution_ids, []);
    assert.deepEqual(result.missing_fields, []);
    assert.equal(result.requires_user_action, true);
    assert.ok(result.reason_codes.includes('catalog_not_configured'));
  }
});

test('missing eligibility metadata fails closed without copying contacts or inventing defaults', () => {
  for (const config of [{ institutions:catalog().institutions }, { ...catalog(), eligibilityById:{} },
    { ...catalog(), eligibilityById:null }, { ...catalog(), eligibilityById:{ unregistered:eligibility() } }]) {
    const result = routeInstitutions(triage(), config, context());
    assert.equal(result.status, 'no_verified_match');
    assert.deepEqual(result.institution_ids, []);
  }
});

test('validation and routing return independent data without case text or a second contact registry', () => {
  const input = catalog(), original = structuredClone(input);
  const finding = triage({ findings:[{ statement:'synthetic private marker' }], reason_codes:['private_marker'] });
  const checked = validateInstitutionCatalog(input);
  assert.deepEqual(validateInstitutionCatalog(checked), checked);
  assert.equal(JSON.stringify(checked.institutions).includes('routing.example.invalid'), false);
  checked.eligibilityById['synthetic-general'].capabilities.push('emergency_response');
  checked.institutions[0].urgencies.push('immediate');
  assert.deepEqual(input, original);
  const result = routeInstitutions(finding, input, context());
  assert.deepEqual(Object.keys(result).sort(), ['action', 'institution_ids', 'missing_fields', 'reason_codes', 'requires_user_action', 'status']);
  assert.equal(JSON.stringify(result).includes('private'), false);
  assert.equal(JSON.stringify(result).includes('http'), false);
  assert.equal(result.requires_user_action, true);
  result.institution_ids.push('injected');
  assert.deepEqual(routeInstitutions(finding, input, context()).institution_ids, ['synthetic-general']);
  assert.deepEqual(input, original);
});

test('routing is deterministic across directory, metadata and requested-service ordering', () => {
  const rows = [institution({ id:'synthetic-z' }, { capabilities:['addiction_counseling'] }),
    institution({ id:'synthetic-a' }), institution({ id:'synthetic-m' })];
  const result = route(rows, { service_needs:['mental_health_counseling', 'addiction_counseling'] });
  assert.deepEqual(result.institution_ids, ['synthetic-a', 'synthetic-m', 'synthetic-z']);
  assert.deepEqual(route([...rows].reverse(), { service_needs:['addiction_counseling', 'mental_health_counseling'] }), result);
});

test('metadata rejects unknown or missing fields, unknown capabilities and invalid eligibility', () => {
  for (const scope of [{ capabilities:[] }, { capabilities:['diagnosis'] },
    { capabilities:['crisis_assessment', 'crisis_assessment'] }, { country:'US' }, { regions:['KR-11', 'KR-11'] },
    { regions:['KR-11 '] }, { nationwide:false }, { nationwide:'true' }, { min_age:-1 }, { min_age:18.5 },
    { min_age:65, max_age:64 }, { max_age:'64' }, { accepts_supporter:null }, { availability:'office_hours' },
    { automatic_send:true }, { valid_until:'2026-09-30' }, { valid_until:'2026-11-31' }, { valid_until:null }])
    reject(catalog([institution({}, scope)]));
  for (const key of Object.keys(eligibility())) {
    const input = catalog(); delete input.eligibilityById['synthetic-general'][key]; reject(input);
  }
  for (const value of [null, [], {}, { ...catalog(), extra:true }, { ...catalog(), eligibilityById:[] },
    { ...catalog(), eligibilityById:{ '../invalid':eligibility() } }]) reject(value);
});

test('directory projections reject duplicate IDs, impossible dates and malformed urgency/actions', () => {
  const input = catalog(), row = input.institutions[0];
  reject({ ...input, institutions:[row, row] });
  for (const extra of [{ id:'../invalid' }, { urgencies:[] }, { urgencies:['low'] }, { urgencies:['planned', 'planned'] },
    { last_verified_on:'2026-02-30' }, { last_verified_on:'2026-1-01' }, { last_verified_on:'2026-10-01T00:00:00Z' },
    { actions:[] }, { actions:[{ kind:'automatic_call' }] }, { actions:[null] }])
    reject({ ...input, institutions:[{ ...row, ...extra }] });
  for (const key of ['id', 'urgencies', 'last_verified_on', 'actions']) {
    const incomplete = { ...row }; delete incomplete[key]; reject({ ...input, institutions:[incomplete] });
  }
});

test('official sources reject unsafe URLs while contacts retain existing directory validation', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'http://example.invalid/contact',
    'https://user:secret@example.invalid/contact', 'https://example.invalid/#fragment', '//example.invalid/contact',
    'https://localhost/contact', 'https://sub.localhost/contact', 'https://127.0.0.1/contact', 'https://2130706433/contact',
    'https://[::1]/contact', 'https://example.invalid/a b', 'https://example.invalid/<bad>',
    'https://example.invalid/\\bad', 'https://example.invalid/{patient}', 'not a URL', null]) {
    reject(catalog([institution({}, { official_source_url:url })]));
    if (url !== null) assert.throws(() => catalog([institution({ booking_url:url })]), /Invalid referral institution configuration/);
  }
});

test('malformed classification identities, unknown services and routing context fail closed', () => {
  for (const finding of [{ version:'referral-triage-unsupported' }, { intake_id:'other' }, { revision:-1 }, { revision:0.5 },
    { snapshot_id:'a'.repeat(63) }, { action:'low_risk' }, { action:new String('routine_support') },
    { status:'failed' }, { service_needs:['unknown'] },
    { service_needs:['emergency_response'] }, { service_needs:['addiction_counseling', 'addiction_counseling'] },
    { professional_review_required:'false' }])
    assert.throws(() => route([institution()], finding), /Invalid referral triage/);
  for (const finding of [null, {}, []])
    assert.throws(() => routeInstitutions(finding, catalog(), context()), /Invalid referral triage/);
  for (const eligibilityContext of [{ country:'US' }, { region:'KR-11 ' }, { age:-1 }, { age:17.5 }, { age:'18' },
    { requester:'unknown' }, { asOf:'2026-02-30' }, { asOf:'2026-10-18T12:00:00Z' }])
    assert.throws(() => route([institution()], {}, eligibilityContext), /Invalid institution routing context/);
  for (const key of Object.keys(context())) {
    const input = context(); delete input[key];
    assert.throws(() => routeInstitutions(triage(), catalog(), input), /Invalid institution routing context/);
  }
});
