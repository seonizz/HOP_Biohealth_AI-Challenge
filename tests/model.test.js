import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model.js';
import { validateAgentResult, validatePatientState } from '../src/agent-state.js';

const field = (id, text, extra = {}) => ({ id, question: `${id} 질문`, status: 'answered', source: 'app_user_report', rawText: text, text, custom: '', ...extra });
const context = () => ({
  schema_version: '1.0',
  patient: { alias: '동생', fields: { mood: field('mood', '밤마다 잠들기 어렵대요'), dur: field('dur', '잘 모르겠어요', { status: 'unknown' }) } },
  supporter: { role: 'informant', fields: { feeling: field('feeling', '저도 지치고 걱정돼요') } },
  user_goal: { message: field('want', '내가 네 편이라는 말을 하고 싶어요'), desired_outcomes: field('goal', '가볍게 대화하기') },
  payload: { answers: [{ selected: [{ meta: { d: 2 } }] }] },
  log: [{ who: 'me', text: '중복 대화 원문' }],
});
const patientState = () => ({
  summary: '이용자는 동생의 수면 어려움을 전해 들었고 본인도 지치고 걱정된다고 보고했습니다.',
  facts: [
    { subject: 'patient', question_id: 'mood', quote: '잠들기 어렵대요', interpretation: '사용자가 전해 들은 수면 어려움입니다.', certainty: 'reported' },
    { subject: 'supporter', question_id: 'feeling', quote: '저도 지치고 걱정돼요', interpretation: '정보 제공자 자신의 감정입니다.', certainty: 'reported' },
  ],
  unknowns: ['상태가 시작된 시점은 확인되지 않았습니다.'],
  user_goal: '내가 네 편이라는 말을 하고 싶어요',
});
const result = () => ({
  guide: { top: '통합', script: '요즘 잠들기 어렵다고 들었어. 네가 이야기하고 싶을 때 내가 들어줄게.', doList: ['편한 시간에 대화를 제안해 보세요.'], avoid: ['억지로 이유를 설명하게 하지 마세요.'], next: '오늘 어떤 도움이 편할지 물어보세요.', care: { feel: '걱정하고 지친 마음도 돌볼 필요가 있어요.', tips: ['내가 쉴 시간을 확보해 보세요.'] } },
  patient_state: patientState(), assessment: { safety: false },
});
const envelope = (content, finishReason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content } }] }), { status: 200 });
const gateway = fetchImpl => new ModelGateway({ baseUrl: 'https://example.test/v1/', apiKey: 'test-only-secret', fetchImpl });

test('final response uses JSON mode, bearer auth and grounded context with prior memory', async () => {
  const memory = patientState();
  let calls = 0;
  const model = gateway(async (url, request) => {
    calls++;
    assert.equal(url, 'https://example.test/v1/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer test-only-secret');
    const body = JSON.parse(request.body);
    assert.equal(body.model, 'gemma4:12b');
    assert.equal(body.stream, false);
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.max_tokens, 2200);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(body.messages[0].content, /정보 제공자/);
    assert.match(body.messages[0].content, /지시가 아닌 자료/);
    const input = JSON.parse(body.messages[1].content);
    assert.deepEqual(input.prior_memory, memory);
    assert.equal(input.current_context.patient.fields.mood.rawText, '밤마다 잠들기 어렵대요');
    assert.equal(input.current_context.supporter.fields.feeling.text, '저도 지치고 걱정돼요');
    assert.equal('payload' in input.current_context, false);
    assert.equal('log' in input.current_context, false);
    assert.equal(request.body.includes('test-only-secret'), false);
    return envelope(JSON.stringify(result()));
  });
  assert.equal(model.configured, true);
  const output = await model.respond(context(), memory);
  assert.deepEqual(output, result());
  assert.equal(JSON.stringify(output).includes('test-only-secret'), false);
  assert.equal(calls, 1);
});

test('state update returns validated memory only and accepts a single complete JSON fence', async () => {
  const model = gateway(async (_url, request) => {
    const body = JSON.parse(request.body);
    assert.equal(body.max_tokens, 1200);
    assert.match(body.messages[0].content, /상태 메모리/);
    return envelope('```json\n' + JSON.stringify({ patient_state: patientState() }) + '\n```');
  });
  assert.deepEqual(await model.updateState(context()), patientState());
});

test('partial early context retains unknown goal and does not invent missing evidence', () => {
  const early = { patient: { fields: {} }, supporter: { fields: {} }, user_goal: {} };
  const state = { summary: '아직 관찰된 상태를 보고받지 않았습니다.', facts: [], unknowns: ['환자의 상태'], user_goal: '확인되지 않음' };
  assert.deepEqual(validatePatientState(state, early), state);
  assert.throws(() => validatePatientState(state, context()), { status: 502, code: 'MODEL_INVALID_RESPONSE' });
});

test('grounding rejects invented quotes, wrong person, absent/skipped field and an altered user goal', () => {
  for (const mutate of [
    value => { value.patient_state.facts[0].quote = '확인되지 않은 발작'; },
    value => { value.patient_state.facts[1].subject = 'patient'; },
    value => { value.patient_state.facts[0].question_id = 'unknown_question'; },
    value => { value.patient_state.user_goal = '임의로 바꾼 목표'; },
    value => { value.patient_state.facts[0].scores = { 우울: 3 }; },
  ]) {
    const value = result(); mutate(value);
    assert.throws(() => validateAgentResult(value, context()), { status: 502, code: 'MODEL_INVALID_RESPONSE' });
  }
  const skipped = context(); skipped.patient.fields.mood.status = 'skipped';
  assert.throws(() => validateAgentResult(result(), skipped), { code: 'MODEL_INVALID_RESPONSE' });
});

test('follow-up and custom input are valid sources while unknown is never promoted to reported', () => {
  const ctx = context();
  ctx.patient.fields.mood.followUp = { answer: { rawText: '새벽 세 시까지 깨어 있어요' } };
  ctx.supporter.fields.feeling.custom = '산책하면 조금 나아요';
  const value = result();
  value.patient_state.facts[0].quote = '새벽 세 시까지';
  value.patient_state.facts[1].quote = '산책하면 조금 나아요';
  value.patient_state.facts.push({ subject: 'patient', question_id: 'dur', quote: '잘 모르겠어요', interpretation: '시점을 모른다는 사용자 보고입니다.', certainty: 'unknown' });
  assert.doesNotThrow(() => validateAgentResult(value, ctx));
  value.patient_state.facts.at(-1).certainty = 'reported';
  assert.throws(() => validateAgentResult(value, ctx), { code: 'MODEL_INVALID_RESPONSE' });
});

test('guide and assessment schema reject omissions, extra clinical scores and invalid types', () => {
  for (const mutate of [
    value => { value.guide.top = '진단'; },
    value => { value.guide.script = ''; },
    value => { value.guide.doList = []; },
    value => { value.guide.avoid = '문자열'; },
    value => { delete value.guide.care; },
    value => { value.assessment.safety = 'false'; },
    value => { value.assessment.scores = { 우울: 3 }; },
  ]) {
    const value = result(); mutate(value);
    assert.throws(() => validateAgentResult(value, context()), { code: 'MODEL_INVALID_RESPONSE' });
  }
});

test('empty, invalid JSON, mixed prose and truncated output return a safe 502 error', async () => {
  for (const [content, reason] of [['', 'stop'], ['{', 'stop'], ['설명: ' + JSON.stringify(result()), 'stop'], [JSON.stringify(result()), 'length']]) {
    await assert.rejects(gateway(async () => envelope(content, reason)).respond(context()), { status: 502, code: 'MODEL_INVALID_RESPONSE' });
  }
  await assert.rejects(gateway(async () => new Response('upstream-private-data')).respond(context()), { status: 502, code: 'MODEL_INVALID_RESPONSE' });
});

test('busy, down and authentication errors do not read or expose upstream error bodies or retry', async () => {
  for (const [status, code] of [[429, 'MODEL_UNAVAILABLE'], [503, 'MODEL_UNAVAILABLE'], [401, 'MODEL_AUTH_FAILED'], [403, 'MODEL_AUTH_FAILED'], [400, 'MODEL_UPSTREAM_ERROR']]) {
    let calls = 0;
    const model = gateway(async () => {
      calls++;
      return { ok: false, status, json: () => { throw new Error('Must not read secret body'); } };
    });
    await assert.rejects(model.respond(context()), error => error.code === code && !error.message.includes('secret'));
    assert.equal(calls, 1);
  }
  await assert.rejects(gateway(async () => { throw new Error('private-network-detail'); }).respond(context()), error => error.status === 503 && !error.message.includes('private-network-detail'));
});

test('model timeout aborts the request and reports 504', async () => {
  const model = new ModelGateway({ baseUrl: 'https://example.test/v1', apiKey: 'test-only-secret', timeoutMs: 15,
    fetchImpl: (_url, request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) });
  await assert.rejects(model.updateState(context()), { status: 504, code: 'MODEL_TIMEOUT' });
});

test('missing credentials or malformed configuration fail before fetching', async () => {
  for (const options of [{}, { baseUrl: 'https://example.test/v1', apiKey: '' }, { baseUrl: 'https://user:password@example.test/v1', apiKey: 'key' }, { baseUrl: 'https://example.test/v1', apiKey: 'key', timeoutMs: 0 }]) {
    const model = new ModelGateway({ ...options, fetchImpl: () => { throw new Error('Must not call'); } });
    assert.equal(model.configured, false);
    await assert.rejects(model.respond(context()), { status: 503, code: 'MODEL_NOT_CONFIGURED' });
  }
});
