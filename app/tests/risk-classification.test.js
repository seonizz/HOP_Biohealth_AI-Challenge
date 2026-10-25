import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from '../src/errors.js';
import { ModelGateway } from '../src/model.js';
import { TRIAGE_VERSION, TRIAGE_PROMPT, triageSources, triageRequest, validateTriageFinding,
  classifyForReferral, assertCurrentTriage, publicTriageSummary } from '../src/risk-classification.js';

const identity = { intakeId:'a73812de-329a-4035-8bd0-795675613b2a', revision:7 };
const field = (text, extra = {}) => ({ id:'describe', status:'answered', question:'관찰한 내용', rawText:text, text, ...extra });
const context = (text = '친구가 상담을 알아봐 달라고 했어요.') => ({
  patient:{ fields:{ describe:field(text) } }, supporter:{ fields:{} }, user_goal:{},
});
const finding = (ctx, extra = {}) => ({ signals:[{ code:'support_requested', person:'patient', assertion:'reported',
  timeframe:'current', report_type:'patient_words', statement:'상담을 알아봐 달라고 했다는 보고.', source_ids:[triageSources(ctx)[0].id], ...extra }], unknowns:[] });
const fake = (responses, calls = []) => ({
  async operation(_options, run) { return run({ controller:new AbortController() }); },
  async agentComplete(stage, prompt, data, schema, _operation, validate) {
    calls.push({ stage, prompt, data:structuredClone(data), schema });
    const value = responses.shift();
    if (value instanceof Error) throw value;
    return validate(structuredClone(value));
  },
});
async function classifyTwice(ctx, value) {
  return classifyForReferral(fake([value, value]), ctx, identity);
}
const modelFailure = () => new HttpError(502, 'MODEL_UPSTREAM_ERROR', 'model unavailable');

test('source bundles include full long answers and all current corrections without truncation', () => {
  const original = '과거 이야기입니다. ' + '기록 '.repeat(4000) + ' 지금 본인의 일은 아니라고 정정했어요.';
  const ctx = context(original);
  ctx.patient.fields.describe.custom = '다른 사람을 인용한 말입니다.';
  ctx.patient.fields.describe.followUp = { question:'누구의 일인가요?', answer:{ rawText:'뉴스 속 인물 이야기입니다.' } };
  const request = triageRequest(ctx, identity), [source] = request.data.sources;
  assert.equal(source.components[0].text, original);
  assert.deepEqual(source.components[0].fields, ['rawText', 'text']);
  assert.equal(source.components.length, 3);
  assert.equal(source.components[2].origin, 'follow_up');
  assert.equal(JSON.stringify(request.data).includes('뉴스 속 인물 이야기입니다.'), true);
  assert.equal(request.data.informant, 'supporter');
  assert.equal(JSON.stringify(request.schema).includes(original), false);
});

test('source provenance and revised source content change the snapshot identity', () => {
  const ctx = context(), before = triageRequest(ctx, identity);
  assert.deepEqual(triageRequest(structuredClone(ctx), identity), before);
  const changes = [
    value => { value.patient.fields.describe.followUp = { question:'확인', answer:{ text:value.patient.fields.describe.text } }; },
    value => { value.supporter.fields.describe = value.patient.fields.describe; delete value.patient.fields.describe; },
    value => { value.patient.fields.describe.rawText += ' 정정'; },
  ];
  for (const change of changes) {
    const value = structuredClone(ctx); change(value);
    assert.notEqual(triageRequest(value, identity).data.snapshot_id, before.data.snapshot_id);
  }
});

test('unknown free-text normalization is preserved, while skipped answers cannot become source evidence', () => {
  const ctx = context('잘 모르겠어요');
  Object.assign(ctx.patient.fields.describe, { status:'unknown', selected:[{ label:'잘 모르겠어요' }], custom:'오늘 상담을 원한다고 했어요.' });
  assert.equal(triageSources(ctx)[0].status, 'answered');
  ctx.patient.fields.describe.skipped = true;
  assert.deepEqual(triageSources(ctx), []);
});

test('an unknown-only source cannot be promoted to a reported or denied fact', () => {
  const ctx = context('잘 모르겠어요'); ctx.patient.fields.describe.status = 'unknown';
  const request = triageRequest(ctx, identity);
  for (const assertion of ['reported', 'negated', 'uncertain', 'hypothetical']) {
    assert.throws(() => validateTriageFinding(finding(ctx, { assertion }), request), { modelReason:'triage_unknown_as_fact' });
  }
  assert.doesNotThrow(() => validateTriageFinding({signals:[], unknowns:['current_safety']}, request));
});

test('fabricated sources, duplicate references, invisible statements and added clinical scores fail validation', () => {
  const ctx = context(), request = triageRequest(ctx, identity);
  for (const alter of [
    value => { value.signals[0].source_ids = ['triage_fabricated']; },
    value => { value.signals[0].source_ids.push(value.signals[0].source_ids[0]); },
    value => { value.signals[0].statement = '\u200b\u2060'; },
    value => { value.suicide_probability = 0.1; },
    value => { value.signals[0].diagnosis = 'new diagnosis'; },
    value => { value.unknowns = ['current_safety', 'current_safety']; },
  ]) {
    const value = finding(ctx); alter(value);
    assert.throws(() => validateTriageFinding(value, request), { code:'MODEL_INVALID_RESPONSE' });
  }
});

test('repeated validated signals are normalized without losing distinct assertions or evidence', () => {
  const ctx=context(),request=triageRequest(ctx,identity),value=finding(ctx);
  value.signals.push({...structuredClone(value.signals[0]),statement:'같은 원문에 대한 또 다른 설명.'});
  value.signals.push({...structuredClone(value.signals[0]),assertion:'negated'});
  value.signals.push({...structuredClone(value.signals[0]),person:'supporter'});
  value.signals.push({...structuredClone(value.signals[0]),timeframe:'past'});
  value.signals.push({...structuredClone(value.signals[0]),report_type:'observation'});
  const original=structuredClone(value),normalized=validateTriageFinding(value,request);
  assert.equal(normalized.signals.length,5);
  assert.deepEqual(normalized.signals[0],value.signals[0]);
  assert.deepEqual(value,original);
  assert.equal(normalized.signals.filter(signal=>signal.assertion==='negated').length,1);
  assert.equal(normalized.signals.filter(signal=>signal.person==='supporter').length,1);
});

test('duplicate classifier signals do not force endless retries or alter the agreed action', async () => {
  const ctx=context(),value=finding(ctx);
  value.signals.push(structuredClone(value.signals[0]));
  const result=await classifyTwice(ctx,value);
  assert.equal(result.action,'routine_support');
  assert.equal(result.review_status,'agreed');
  assert.ok(result.findings.every(finding=>finding.signals.length===1));
});

test('current active suicidal thoughts take the emergency path without requiring a reported plan or second call', async () => {
  const ctx = context('지금 스스로 목숨을 끊는 생각을 하고 있다고 말했어요. 계획은 모르겠어요.');
  const value = finding(ctx, { code:'current_suicidal_thoughts', statement:'현재 적극적 자살 생각을 한다는 보고.' });
  value.unknowns = ['intent_or_plan', 'access_to_means'];
  const calls = [], result = await classifyForReferral(fake([value], calls), ctx, identity);
  assert.equal(result.action, 'emergency');
  assert.equal(result.patient_action, 'emergency');
  assert.equal(result.review_status, 'expedited_emergency');
  assert.equal(calls.length, 1);
  assert.deepEqual(result.unknowns, ['access_to_means', 'intent_or_plan']);
});

test('passive death wishes are referred for prompt assessment, even without an active plan', async () => {
  const ctx = context('차라리 죽었으면 좋겠다는 말을 했어요.'), value = finding(ctx,
    { code:'wish_to_die_or_self_harm_concern', statement:'죽었으면 좋겠다는 말을 했다는 보고.' });
  const result = await classifyTwice(ctx, value);
  assert.equal(result.action, 'prompt_assessment');
  assert.equal(result.professional_review_required, true);
});

test('past self-harm is retained for professional review but is not reclassified as a current emergency', async () => {
  const ctx = context('몇 년 전 자해를 했다고 들었고 현재 상황은 모르겠어요.');
  for (const code of ['self_harm_history', 'self_harm_action']) {
    const result = await classifyTwice(ctx, finding(ctx, { code, timeframe:'past', statement:'과거 자해 보고.' }));
    assert.equal(result.action, 'prompt_assessment');
    assert.deepEqual(result.emergency_people, []);
  }
});

test('uncertain timing or occurrence of a serious signal is not treated as routine support', async () => {
  const ctx = context('그 말이 지금 상황인지 확실하지 않아요.');
  for (const extra of [{ code:'current_suicidal_thoughts', timeframe:'unknown' },
    { code:'physical_emergency', assertion:'uncertain' }]) {
    const result = await classifyTwice(ctx, finding(ctx, extra));
    assert.equal(result.action, 'prompt_assessment');
  }
});

test('negated or hypothetical danger alone cannot establish either danger or a safe classification', async () => {
  const ctx = context('위험한 상황을 가정해서 물어본 것뿐이에요.');
  for (const assertion of ['negated', 'hypothetical']) {
    const result = await classifyTwice(ctx, finding(ctx, { code:'self_harm_action', assertion }));
    assert.equal(result.action, 'insufficient_information');
    assert.equal(result.professional_review_required, true);
  }
});

test('a supporter emergency is preserved separately and does not become the patient condition', async () => {
  const ctx = context('그분 이야기가 아니라 제가 지금 다쳤어요.');
  const result = await classifyForReferral(fake([finding(ctx, { code:'physical_emergency', person:'supporter' })]), ctx, identity);
  assert.equal(result.action, 'emergency');
  assert.equal(result.patient_action, 'insufficient_information');
  assert.deepEqual(result.emergency_people, ['supporter']);
});

test('a serious signal with uncertain actor requires assessment, not fabricated patient attribution', async () => {
  const ctx = context('누가 한 말인지는 정확하지 않아요.');
  const result = await classifyTwice(ctx, finding(ctx, { code:'wish_to_die_or_self_harm_concern', person:'unclear' }));
  assert.equal(result.action, 'prompt_assessment');
  assert.equal(result.patient_action, 'insufficient_information');
});

test('agreed current ordinary support needs can route to routine counseling without a safety score', async () => {
  const ctx = context(), result = await classifyTwice(ctx, finding(ctx));
  assert.equal(result.action, 'routine_support');
  assert.equal(result.review_status, 'agreed');
  assert.deepEqual(result.service_needs, ['mental_health_counseling']);
  assert.equal('risk_score' in result, false);
  assert.equal('risk_level' in result, false);
});

test('reviewer receives original sources and schema without seeing the first classification', async () => {
  const ctx = context(), calls = [], first = finding(ctx), second = structuredClone(first);
  second.signals[0].statement = '같은 상담 요청을 표현만 달리 요약.';
  const result = await classifyForReferral(fake([first, second], calls), ctx, identity);
  assert.equal(result.review_status, 'agreed');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].data, calls[1].data);
  assert.deepEqual(calls[0].schema, calls[1].schema);
  assert.equal('proposed' in calls[1].data, false);
  assert.equal(calls[1].stage, 'referral_triage_independent');
});

test('classifier disagreement retains the stronger action and withholds specialty routing', async () => {
  const ctx = context(), routine = finding(ctx), serious = finding(ctx, { code:'wish_to_die_or_self_harm_concern' });
  const result = await classifyForReferral(fake([routine, serious]), ctx, identity);
  assert.equal(result.action, 'prompt_assessment');
  assert.equal(result.review_status, 'disagreed');
  assert.deepEqual(result.service_needs, []);
  assert.ok(result.reason_codes.includes('classifiers_disagree'));
});

test('lack of evidence in one pass prevents an agreed routine classification', async () => {
  const ctx = context(), result = await classifyForReferral(fake([finding(ctx), { signals:[], unknowns:['current_safety'] }]), ctx, identity);
  assert.equal(result.action, 'insufficient_information');
  assert.equal(result.status, 'needs_review');
});

test('agreement does not erase explicit critical information gaps or permit routine specialty routing', async () => {
  const ctx = context();
  for (const unknown of ['current_safety', 'person', 'timeframe', 'intent_or_plan', 'access_to_means', 'recent_action']) {
    const value = finding(ctx); value.unknowns = [unknown];
    const result = await classifyTwice(ctx, value);
    assert.equal(result.action, 'insufficient_information', unknown);
    assert.equal(result.patient_action, 'insufficient_information');
    assert.equal(result.status, 'needs_review');
    assert.equal(result.professional_review_required, true);
    assert.deepEqual(result.service_needs, []);
    assert.ok(result.reason_codes.includes('critical_information_missing'));
  }
});

test('unresolved actor of a serious concern also prevents a routine patient-only projection', async () => {
  const ctx = context(), value = finding(ctx);
  value.signals.push({ ...value.signals[0], person:'unclear', code:'wish_to_die_or_self_harm_concern' });
  const result = await classifyTwice(ctx, value);
  assert.equal(result.action, 'prompt_assessment');
  assert.equal(result.patient_action, 'insufficient_information');
  assert.equal(result.professional_review_required, true);
  assert.deepEqual(result.service_needs, []);
});

test('an emergency found by the second pass is retained', async () => {
  const ctx = context(), result = await classifyForReferral(fake([finding(ctx),
    finding(ctx, { code:'physical_emergency' })]), ctx, identity);
  assert.equal(result.action, 'emergency');
  assert.equal(result.review_status, 'disagreed');
});

test('classification failure cannot turn incomplete review into a routine or safe result', async () => {
  const ctx = context();
  const unavailable = await classifyForReferral(fake([modelFailure()]), ctx, identity);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.action, 'insufficient_information');
  const incomplete = await classifyForReferral(fake([finding(ctx), modelFailure()]), ctx, identity);
  assert.equal(incomplete.review_status, 'failed');
  assert.equal(incomplete.action, 'insufficient_information');
  assert.deepEqual(incomplete.service_needs, []);
});

test('failed independent review preserves an already detected need for prompt assessment', async () => {
  const ctx = context(), first = finding(ctx, { code:'wish_to_die_or_self_harm_concern' });
  const result = await classifyForReferral(fake([first, modelFailure()]), ctx, identity);
  assert.equal(result.action, 'prompt_assessment');
  assert.equal(result.review_status, 'failed');
});

test('server-owned existing urgency bypasses model calls and cannot be downgraded', async () => {
  const calls = [], ctx = context(), result = await classifyForReferral(fake([], calls), ctx, { ...identity, existingUrgent:true });
  assert.equal(calls.length, 0);
  assert.equal(result.action, 'emergency');
  assert.equal(result.patient_action, 'insufficient_information');
  assert.ok(result.reason_codes.includes('existing_urgent_preserved'));
});

test('empty evidence causes no model call, and invalid identities are rejected before execution', async () => {
  const calls = [], result = await classifyForReferral(fake([], calls), {}, identity);
  assert.equal(result.action, 'insufficient_information');
  assert.equal(calls.length, 0);
  for (const extra of [{ revision:-1 }, { revision:0.1 }, { intakeId:'other' }])
    assert.throws(() => triageRequest(context(), { ...identity, ...extra }), TypeError);
});

test('results are bound to intake, revision and the unchanged source snapshot', async () => {
  const ctx = context(), result = await classifyTwice(ctx, finding(ctx));
  assert.equal(assertCurrentTriage(result, ctx, identity), result);
  for (const value of [{ ...identity, revision:8 }, { ...identity, intakeId:'b73812de-329a-4035-8bd0-795675613b2a' }])
    assert.throws(() => assertCurrentTriage(result, ctx, value), { code:'TRIAGE_STALE' });
  ctx.patient.fields.describe.rawText += ' 정정';
  assert.throws(() => assertCurrentTriage(result, ctx, identity), { code:'TRIAGE_STALE' });
});

test('public projection contains no raw answers, internal findings, scores or model details', async () => {
  const ctx = context(), result = await classifyTwice(ctx, finding(ctx)), summary = publicTriageSummary(result);
  assert.deepEqual(Object.keys(summary).sort(), ['action', 'professional_review_required', 'revision', 'snapshot_id', 'status', 'version']);
  assert.equal(summary.version, TRIAGE_VERSION);
  assert.equal(JSON.stringify(summary).includes(ctx.patient.fields.describe.rawText), false);
});

test('the existing gateway emits actual prompt-format wire requests with no additional dependencies or network', async () => {
  const ctx = context(), value = finding(ctx), requests = [];
  const gateway = new ModelGateway({ baseUrl:'http://127.0.0.1:9/v1', apiKey:'synthetic-test-key',
    protocol:'relationship_agent', agentFormat:'prompt', reasoningEffort:'omit', timeoutMs:5000,
    diagnosticLogger:() => {}, fetchImpl:async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices:[{ finish_reason:'stop', message:{ content:JSON.stringify(value) } }] }),
        { status:200, headers:{ 'content-type':'application/json' } });
    } });
  const result = await classifyForReferral(gateway, ctx, identity);
  assert.equal(result.action, 'routine_support');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].messages[0].content, TRIAGE_PROMPT);
  for (const request of requests) {
    assert.equal(Object.hasOwn(request, 'max_tokens'), false);
    assert.equal('reasoning_effort' in request, false);
    assert.equal('response_format' in request, false);
  }
  assert.deepEqual(JSON.parse(requests[0].messages[1].content).data, JSON.parse(requests[1].messages[1].content).data);
});

test('cancellation aborts the gateway operation and does not start the independent pass', async () => {
  const ctx = context(), controller = new AbortController(), calls = [];
  const gateway = fake([finding(ctx), finding(ctx)], calls), complete = gateway.agentComplete;
  gateway.agentComplete = async function (...args) {
    const result = await complete(...args);
    controller.abort();
    assert.equal(args[4].controller.signal.aborted, true);
    return result;
  };
  const result = await classifyForReferral(gateway, ctx, { ...identity, signal:controller.signal });
  assert.equal(calls.length, 1);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.action, 'insufficient_information');
});
