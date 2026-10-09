import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model.js';

const REQUEST_ID = '9a281bfc-24e3-4fd5-a28a-bcf8a494870b';
const field = (id, text) => ({ id, status: 'answered', question: id, rawText: text, text, custom: '' });
const context = () => ({
  schema_version: '1.0',
  patient: { alias: '민지', fields: { name: field('name', '민지'), mood: field('mood', '밤에 잠들기 어렵대요') } },
  supporter: { role: 'informant', fields: {} },
  user_goal: { message: field('want', '네 편이라고 말하고 싶어요') },
  answered_count: 3, question_candidates: [],
  name_index: { alias: '민지', source_question_id: 'name', quote: '민지' },
});
const state = () => ({
  patient_state: {
    summary: '이용자가 수면 어려움을 전해 들었습니다.',
    facts: [{ subject: 'patient', question_id: 'mood', quote: '잠들기 어렵대요', interpretation: '수면 어려움에 관한 전언입니다.', certainty: 'reported' }],
    unknowns: ['원인은 확인되지 않았습니다.'],
  },
  name_index: context().name_index, question_plan: { skip: [] },
});
const memory = () => ({ ...state().patient_state, user_goal: context().user_goal.message.text });
const guide = () => ({
  guide: { top: '통합', script: '네가 원한다면 이야기를 들어줄게.',
    doList: ['대화가 편한지 먼저 물어보세요.'], avoid: ['답변을 재촉하지 마세요.'], next: '편한 때 다시 이야기해 보세요.',
    care: { feel: '내 마음도 돌보세요.', tips: ['잠시 쉴 시간을 마련하세요.'] } },
  assessment: { safety: false },
});
const envelope = (content, finish = 'stop', extra = {}) => new Response(JSON.stringify({
  choices: [{ finish_reason: finish, message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], ...extra,
}));
const makeGateway = (fetchImpl, options = {}) => new ModelGateway({
  baseUrl: 'https://example.test/v1', apiKey: 'private-credential-value',
  model: 'malssi-gemma4-31b-step100', fetchImpl, diagnosticLogger: () => {}, ...options,
});

test('transient connection then busy status recover within three attempts without changing the context', async () => {
  const bodies = []; const records = [];
  const gateway = makeGateway(async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    if (bodies.length === 1) throw new TypeError('private connection detail', { cause: { code: 'ECONNRESET' } });
    if (bodies.length === 2) return new Response('private upstream detail', { status: 429, headers: { 'Retry-After': '0' } });
    return envelope(state());
  }, { diagnosticLogger: entry => records.push(entry) });
  const result = await gateway.updateState(context(), null, { requestId: REQUEST_ID });
  assert.deepEqual(result.patient_state, memory());
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[0], bodies[1]); assert.deepEqual(bodies[1], bodies[2]);
  assert.deepEqual(records.map(entry => entry.reason), ['connection_transient', 'http_transient', 'success']);
  assert.ok(records.every(entry => entry.request_id === REQUEST_ID));
});

test('JSON and source validation failures repair the system prompt while preserving exact source context', async () => {
  const bodies = []; const records = [];
  const forged = state(); forged.patient_state.facts[0].quote = '사실에 없는 내용';
  const gateway = makeGateway(async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    return envelope(bodies.length === 1 ? '{' : bodies.length === 2 ? forged : state());
  }, { diagnosticLogger: entry => records.push(entry) });
  assert.deepEqual((await gateway.updateState(context())).patient_state, memory());
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies.map(body => body.messages[0].content)).size, 3);
  assert.equal(new Set(bodies.map(body => body.messages.at(-1).content)).size, 1);
  assert.ok(bodies.every(body => body.temperature === 0 && body.max_tokens === 2048));
  assert.match(bodies[2].messages[0].content, /정확히 복사한 인용/);
  assert.equal(bodies[2].messages[0].content.includes('사실에 없는 내용'), false);
  assert.deepEqual(records.map(entry => entry.reason), ['content_json', 'patient_state_validation', 'success']);
});

test('structural state schema failures recover without dropping required validation', async () => {
  const broken = state(); broken.unexpected = 'private-invalid-value';
  let attempts = 0;
  const gateway = makeGateway(async () => envelope(++attempts === 1 ? broken : state()));
  assert.deepEqual((await gateway.updateState(context())).patient_state, memory());
  assert.equal(attempts, 2);
});

test('persistent invalid JSON and fabricated evidence are rejected at exactly three attempts', async () => {
  for (const makeInvalid of [() => '{', () => {
    const value = state(); value.patient_state.facts[0].quote = 'fabricated private source'; return value;
  }]) {
    let attempts = 0;
    const gateway = makeGateway(async () => { attempts++; return envelope(makeInvalid()); });
    await assert.rejects(gateway.updateState(context()), { code: 'MODEL_INVALID_RESPONSE' });
    assert.equal(attempts, 3);
  }
});

test('final guide truncated output and invalid schema repair before a validated response returns', async () => {
  const bodies = []; const records = [];
  const invalid = guide(); invalid.guide.care.tips = [];
  const gateway = makeGateway(async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    if (bodies.length === 1) return envelope(guide(), 'length');
    return envelope(bodies.length === 2 ? invalid : guide());
  }, { diagnosticLogger: entry => records.push(entry) });
  const output = await gateway.respond(context(), memory());
  assert.deepEqual(output, { ...guide(), patient_state: memory(), name_index: context().name_index });
  assert.equal(bodies.length, 3);
  assert.equal(new Set(bodies.map(body => body.messages[0].content)).size, 3);
  assert.equal(new Set(bodies.map(body => body.messages.at(-1).content)).size, 1);
  assert.deepEqual(records.map(entry => entry.reason), ['finish_reason', 'guide_validation', 'success']);
  assert.ok(records.every(entry => entry.generation === 'guide'));
});

test('transport envelopes are validated and retry failures share the same attempt ceiling', async () => {
  let attempts = 0;
  const records = [];
  const gateway = makeGateway(async () => {
    attempts++;
    if (attempts === 1) return new Response('bad envelope private body');
    if (attempts === 2) return new Response(JSON.stringify({ choices: [] }));
    return new Response('busy private body', { status: 503 });
  }, { diagnosticLogger: entry => records.push(entry) });
  await assert.rejects(gateway.updateState(context()), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(attempts, 3);
  assert.deepEqual(records.map(entry => entry.reason), ['envelope_json', 'envelope', 'http_transient']);
});

test('authentication, arbitrary errors and unrelated 422 do not retry', async () => {
  for (const [fetchImpl, code] of [
    [() => new Response('secret', { status: 401 }), 'MODEL_AUTH_FAILED'],
    [() => new Response('secret', { status: 403 }), 'MODEL_AUTH_FAILED'],
    [() => new Response(JSON.stringify({ error: { code: 'unsupported_field' } }), { status: 422 }), 'MODEL_UPSTREAM_ERROR'],
    [() => { throw new Error('arbitrary private failure'); }, 'MODEL_UNAVAILABLE'],
  ]) {
    let attempts = 0;
    const gateway = makeGateway(async () => { attempts++; return fetchImpl(); });
    await assert.rejects(gateway.updateState(context()), { code });
    assert.equal(attempts, 1);
  }
  let attempts = 0;
  const invalid = makeGateway(async () => { attempts++; }, { apiKey: 'invalid\ncredential' });
  await assert.rejects(invalid.updateState(context()), { code: 'MODEL_NOT_CONFIGURED' });
  assert.equal(attempts, 0);
});

test('current 422 context budget tightens once and uses the same three-attempt recovery allowance', async () => {
  const bodies = [];
  const budget = () => new Response(JSON.stringify({ error: {
    code: 'context_budget_exceeded', message: 'Rendered input or total token budget exceeded.', type: 'request_error',
  } }), { status: 422 });
  const gateway = makeGateway(async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    if (bodies.length === 1) return envelope('{');
    if (bodies.length === 2) return budget();
    return envelope(state());
  });
  const ctx = context(); ctx.user_goal.message = field('want', '전하고 싶은 마음 '.repeat(30));
  await gateway.updateState(ctx);
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].messages.at(-1).content, bodies[1].messages.at(-1).content);
  assert.notEqual(bodies[1].messages.at(-1).content, bodies[2].messages.at(-1).content);
  let attempts = 0;
  await assert.rejects(makeGateway(async () => { attempts++; return budget(); }).updateState(context()), { code: 'MODEL_CONTEXT_TOO_LONG' });
  assert.equal(attempts, 2);
});

test('Retry-After is respected and unreasonable waits are not retried early', async () => {
  let attempts = 0; let first = 0; let second = 0;
  const gateway = makeGateway(async () => {
    attempts++;
    if (attempts === 1) {
      first = performance.now();
      return new Response('', { status: 429, headers: { 'Retry-After': '0.3' } });
    }
    second = performance.now(); return envelope(state());
  });
  await gateway.updateState(context());
  assert.equal(attempts, 2); assert.ok(second - first >= 290);
  for (const retryAfter of ['60', new Date(Date.now() + 60000).toUTCString()]) {
    let calls = 0;
    const tooLong = makeGateway(async () => {
      calls++; return new Response('', { status: 503, headers: { 'Retry-After': retryAfter } });
    });
    await assert.rejects(tooLong.updateState(context()), { code: 'MODEL_UNAVAILABLE' });
    assert.equal(calls, 1);
  }
});

test('one deadline aborts backoff without another upstream call', async () => {
  let calls = 0; let signal;
  const records = [];
  const gateway = makeGateway(async (_url, request) => {
    calls++; signal = request.signal;
    return new Response('', { status: 503, headers: { 'Retry-After': '1' } });
  }, { timeoutMs: 30, diagnosticLogger: entry => records.push(entry) });
  await assert.rejects(gateway.updateState(context()), { code: 'MODEL_TIMEOUT' });
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
  assert.equal(records.at(-1).reason, 'deadline');
});

test('state prerequisite and guide share the public respond deadline', async () => {
  const signals = [];
  const gateway = makeGateway(async (_url, request) => {
    signals.push(request.signal);
    if (signals.length === 1) {
      await new Promise(resolve => setTimeout(resolve, 20));
      return envelope(state());
    }
    return new Response('', { status: 503, headers: { 'Retry-After': '1' } });
  }, { timeoutMs: 60 });
  await assert.rejects(gateway.respond(context()), { code: 'MODEL_TIMEOUT' });
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]); assert.equal(signals[0].aborted, true);
});

test('diagnostics redact content, raw errors, arbitrary finish and usage fields while keeping correlation', async () => {
  const records = []; let calls = 0;
  const gateway = makeGateway(async () => {
    calls++;
    if (calls === 1) return envelope('private response text', 'private-finish-text', { usage: {
      prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, private: 'private-usage-text',
    } });
    return envelope(state(), 'stop', { usage: { prompt_tokens: 'private-value', completion_tokens: 5, total_tokens: -1 } });
  }, { diagnosticLogger: entry => records.push(entry) });
  await gateway.updateState(context(), null, { requestId: REQUEST_ID });
  const serialized = JSON.stringify(records);
  for (const secret of ['private response text', 'private-finish-text', 'private-usage-text', 'private-value',
    'private-credential-value', '민지', '잠들기', '네 편']) assert.equal(serialized.includes(secret), false);
  assert.equal(records[0].request_id, REQUEST_ID);
  assert.equal(records[0].finish_reason, 'other');
  assert.deepEqual(records[0].usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  assert.deepEqual(records[1].usage, { completion_tokens: 5 });
  records.length = 0;
  await gateway.updateState(context(), null, { requestId: 'private arbitrary request content' });
  assert.equal(records[0].request_id, null);
});

test('diagnostic sink failures cannot turn a validated answer into a failed response', async () => {
  const gateway = makeGateway(async () => envelope(state()), { diagnosticLogger: () => { throw new Error('sink failure'); } });
  assert.deepEqual((await gateway.updateState(context())).patient_state, memory());
});

test('unread transient bodies are cancelled and body-reader programming errors do not retry', async () => {
  let cancelled = 0; let calls = 0;
  const gateway = makeGateway(async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('private error body')); },
      cancel() { cancelled++; },
    }), { status: 503 });
    return envelope(state());
  });
  await gateway.updateState(context());
  assert.equal(calls, 2); assert.equal(cancelled, 1);
  let invalidCalls = 0;
  const broken = makeGateway(async () => {
    invalidCalls++;
    return { ok: true, status: 200, json() { throw new Error('private reader programming failure'); } };
  });
  await assert.rejects(broken.updateState(context()), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(invalidCalls, 1);
});

test('502 and 504 recover while non-transient server responses are not retried', async () => {
  for (const status of [502, 504, 500]) {
    let calls = 0;
    const gateway = makeGateway(async () => ++calls === 1 ? new Response('', { status }) : envelope(state()));
    if (status === 500) await assert.rejects(gateway.updateState(context()), { code: 'MODEL_UPSTREAM_ERROR' });
    else await gateway.updateState(context());
    assert.equal(calls, status === 500 ? 1 : 2);
  }
});
