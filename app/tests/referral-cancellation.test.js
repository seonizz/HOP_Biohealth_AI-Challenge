import test from 'node:test';
import assert from 'node:assert/strict';
import {createReferralGuidance} from '../src/referral-guidance.js';
import {createIntake, answerIntake} from '../src/intake.js';
import {classifyForReferral, triageSources} from '../src/risk-classification.js';
import {HttpError} from '../src/errors.js';

const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const plan = input => ({schema_version:'1.0', subject:'patient', urgency:'planned', reviewed:true,
  evidence_source_ids:[input.sources[0].id], institution_ids:[], model_version:'synthetic-cancellation'});
const fixture = options => createReferralGuidance({store:{async intake(_owner, id) {
  return {id, revision:2, state:answerIntake(createIntake(), {question_id:'name', text:'합성 인물'})};
}}, ...options});
const assess = (service, signal, owner = 'owner', id = 'intake') => service.assess(owner, id, {revision:2}, 'request', {signal});

test('referral has no default deadline and accepts explicit timeout zero', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  for (const options of [{}, {timeoutMs:0}]) {
    const entered = deferred(), finish = deferred(); let signal, settled = false;
    const service = fixture({...options, provider:async input => {
      signal = input.signal; entered.resolve(); await finish.promise; return plan(input);
    }});
    const pending = assess(service); pending.then(() => {settled = true;}, () => {settled = true;});
    await entered.promise; t.mock.timers.tick(300000); await tick();
    assert.equal(signal.aborted, false); assert.equal(settled, false);
    finish.resolve(); assert.equal((await pending).assessment.urgency, 'planned');
  }
  for (const timeoutMs of [-1, 1.5, 120001]) assert.throws(() => fixture({timeoutMs}), TypeError);
});

test('disconnecting one referral subscriber keeps another same-revision assessment alive', async () => {
  const entered = deferred(), finish = deferred(); let calls = 0, providerSignal;
  const service = fixture({provider:async input => {
    calls++; providerSignal = input.signal; entered.resolve(); await finish.promise; return plan(input);
  }});
  const a = new AbortController(), b = new AbortController();
  const first = assess(service, a.signal); await entered.promise;
  const second = assess(service, b.signal); await tick(); a.abort();
  await assert.rejects(first, {status:499, code:'REFERRAL_CANCELLED'});
  assert.equal(providerSignal.aborted, false);
  finish.resolve(); assert.equal((await second).assessment.urgency, 'planned'); assert.equal(calls, 1);
});

test('last referral subscriber cancellation aborts the provider and permits a fresh same-revision request', async () => {
  const entered = deferred(); let calls = 0, providerSignal;
  const service = fixture({provider:async input => {
    if (++calls > 1) return plan(input);
    providerSignal = input.signal; entered.resolve(); return new Promise(() => {});
  }});
  const controller = new AbortController(), pending = assess(service, controller.signal);
  await entered.promise; controller.abort();
  await assert.rejects(pending, {code:'REFERRAL_CANCELLED'}); assert.equal(providerSignal.aborted, true);
  assert.equal((await assess(service)).assessment.urgency, 'planned'); assert.equal(calls, 2);
});

test('referral invalidation aborts only the matching owner and intake', async () => {
  const signals = new Map(), finish = deferred();
  const service = fixture({provider:async input => {
    signals.set(input.intake_id, input.signal);
    await finish.promise; return plan(input);
  }});
  const first = assess(service, undefined, 'owner-a', 'intake-a');
  const otherOwner = assess(service, undefined, 'owner-b', 'intake-b');
  const otherIntake = assess(service, undefined, 'owner-a', 'intake-c');
  await tick(); service.cancel('owner-a', 'intake-a');
  await assert.rejects(first, {status:409, code:'REVISION_CONFLICT'});
  assert.equal(signals.get('intake-a').aborted, true);
  assert.equal(signals.get('intake-b').aborted, false); assert.equal(signals.get('intake-c').aborted, false);
  finish.resolve(); await Promise.all([otherOwner, otherIntake]);
});

test('referral cancellation reaches operation setup before model token discovery', async () => {
  const controller = new AbortController(), entered = deferred(); let received;
  const gateway = {async operation(options) {
    received = options.signal; entered.resolve();
    await new Promise(resolve => received.addEventListener('abort', resolve, {once:true}));
    throw new HttpError(499, 'MODEL_CANCELLED', '취소됐어요.');
  }};
  const context = {patient:{fields:{describe:{id:'describe',status:'answered',question:'관찰',rawText:'합성 상담 요청'}}},supporter:{fields:{}},user_goal:{}};
  const pending = classifyForReferral(gateway, context,
    {intakeId:'a73812de-329a-4035-8bd0-795675613b2a', revision:2, signal:controller.signal});
  await entered.promise; assert.equal(received, controller.signal); controller.abort(); await pending;
});

test('a restarted classification operation discards findings from its failed attempt', async () => {
  const context = {patient:{fields:{describe:{id:'describe',status:'answered',question:'관찰',rawText:'합성 상담 요청'}}},supporter:{fields:{}},user_goal:{}};
  const finding = {signals:[{code:'support_requested',person:'patient',assertion:'reported',timeframe:'current',
    report_type:'patient_words',statement:'합성 상담 요청 보고.',source_ids:[triageSources(context)[0].id]}],unknowns:[]};
  let calls = 0;
  const gateway = {async operation(_options, run) {
    try {return await run({controller:new AbortController()});}
    catch {return run({controller:new AbortController()});}
  }, async agentComplete(_stage, _prompt, _request, _schema, _operation, validate) {
    if (++calls === 2) throw new HttpError(502, 'MODEL_UNAVAILABLE', '일시적 실패');
    return validate(structuredClone(finding));
  }};
  const result = await classifyForReferral(gateway, context, {intakeId:'a73812de-329a-4035-8bd0-795675613b2a',revision:2});
  assert.equal(calls, 4); assert.equal(result.findings.length, 2); assert.equal(result.review_status, 'agreed');
});
