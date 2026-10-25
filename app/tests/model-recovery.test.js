import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model.js';
import { HttpError } from '../src/errors.js';
import { attemptMetrics } from '../../ai/scripts/evaluation_evidence.mjs';

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
  const attempts = records.filter(entry => entry.event === 'model_attempt');
  assert.deepEqual(attempts.map(entry => entry.reason), ['connection_transient', 'http_transient', 'success']);
  assert.equal(new Set(attempts.map(entry => entry.attempt_id)).size, 3);
  assert.equal(new Set(records.map(entry => entry.generation_id)).size, 1);
  const waits = records.filter(entry => entry.event === 'model_retry_wait');
  assert.ok(waits.length > 0);
  assert.ok(waits.every(entry => entry.reason === 'retry_ready' && attempts.some(attempt => attempt.attempt_id === entry.after_attempt_id)));
  assert.equal(attemptMetrics(records).attempts, bodies.length);
  assert.equal(attemptMetrics(records).retries, 2);
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
  assert.ok(bodies.every(body => body.temperature === 0 && !Object.hasOwn(body, 'max_tokens')));
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

test('a 422 server context budget stops recovery without shrinking the original input', async () => {
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
  await assert.rejects(gateway.updateState(ctx), { code: 'MODEL_CONTEXT_TOO_LONG' });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].messages.at(-1).content, bodies[1].messages.at(-1).content);
  assert.equal(JSON.parse(bodies[0].messages.at(-1).content).goal, ctx.user_goal.message.text);
  let attempts = 0;
  await assert.rejects(makeGateway(async () => { attempts++; return budget(); }).updateState(context()), { code: 'MODEL_CONTEXT_TOO_LONG' });
  assert.equal(attempts, 1);
});

test('relationship memory input-budget rejections keep their cause without retrying or truncating source', async () => {
  for (const message of [
    'Prompt (65537) exceeds the 65536-token input budget; no text was truncated',
    'Prompt (61441) plus max_tokens (8192) exceeds the 69632-token context budget; no text was truncated',
    'Prompt (8193) exceeds the 8192-token input budget; no text was truncated',
    'Prompt (8192) plus max_tokens (4097) exceeds the 12288-token context budget; no text was truncated',
    'Prompt exceeds the input budget; no text was truncated',
    'Prompt exceeds the v11 input budget; no text was truncated',
    'unrecognized private upstream detail',
    'Prompt (8193) exceeds the 8192-token input budget; no text was truncated\nprivate source',
  ]) {
    const bodies = [], logs = [];
    const gateway = makeGateway(async (_url, request) => {
      bodies.push(JSON.parse(request.body));
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message } }), { status: 400 });
    }, { protocol: 'relationship_agent', agentFormat: 'prompt', diagnosticLogger: entry => logs.push(entry) });
    const source = { answers: ['원문과 정정은 그대로 보존합니다.'] };
    const known = !message.includes('private');
    await assert.rejects(gateway.operation({}, operation => gateway.agentComplete(
      'relationship_memory', 'synthetic system prompt', source,
      { type: 'object', properties: {}, additionalProperties: false },operation, value => value,
    )), { code: known ? 'MODEL_CONTEXT_TOO_LONG' : 'MODEL_UPSTREAM_ERROR' });
    assert.equal(bodies.length, 1);
    assert.deepEqual(JSON.parse(bodies[0].messages.at(-1).content).data, source);
    assert.equal(logs[0].reason, known ? 'context_budget' : 'http_rejected');
    assert.equal(JSON.stringify(logs).includes(message), false);
    assert.equal(JSON.stringify(logs).includes(source.answers[0]), false);
  }
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
  }, { timeoutMs: 100, diagnosticLogger: entry => records.push(entry) });
  await assert.rejects(gateway.updateState(context()), { code: 'MODEL_TIMEOUT' });
  assert.equal(calls, 1); assert.equal(signal.aborted, true);
  assert.equal(records.at(-1).reason, 'deadline');
  assert.deepEqual(records.map(entry => entry.event), ['model_attempt', 'model_retry_wait']);
  assert.equal(records[1].after_attempt_id, records[0].attempt_id);
  assert.equal(records[1].generation_id, records[0].generation_id);
  assert.equal(Object.hasOwn(records[1], 'usage'), false);
  const metrics = attemptMetrics(records);
  assert.equal(metrics.attempt_count_verified, true);
  assert.equal(metrics.attempts, 1);
  assert.equal(metrics.failed_attempts, 1);
  assert.equal(metrics.retries, 0);
  assert.equal(metrics.retry_wait_events, 1);
  assert.equal(metrics.retry_wait_deadlines, 1);
  assert.equal(metrics.attempt_wait_ms, records[0].duration_ms);
  assert.equal(metrics.retry_wait_ms, records[1].duration_ms);
});

test('separate state generations have unique request IDs even when no public request ID is supplied', async () => {
  const records = [];
  const gateway = makeGateway(async () => envelope(state()), { diagnosticLogger: entry => records.push(entry) });
  await gateway.updateState(context());
  await gateway.updateState(context());
  assert.equal(new Set(records.map(entry => entry.generation_id)).size, 2);
  assert.equal(new Set(records.map(entry => entry.attempt_id)).size, 2);
  assert.ok(records.every(entry => entry.request_id === null && entry.attempt === 1));
  assert.equal(attemptMetrics(records).attempts, 2);
});

test('request body failures are recorded without inventing an upstream attempt', async () => {
  const records = []; let calls = 0;
  const gateway = makeGateway(async () => { calls++; return envelope(state()); }, { diagnosticLogger: entry => records.push(entry) });
  await assert.rejects(gateway.operation({}, operation => gateway.request(() => {
    throw new Error('private request detail');
  }, operation, value => value, 'state')), { code: 'MODEL_UNAVAILABLE' });
  assert.equal(calls, 0);
  assert.equal(records[0].event, 'model_request_failure');
  assert.equal(records[0].attempt_id, null);
  assert.equal(attemptMetrics(records).attempts, 0);
  assert.equal(attemptMetrics(records).preflight_failures, 1);
  assert.equal(JSON.stringify(records).includes('private request detail'), false);
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

test('progress counts only validated calls while retry feedback stays out of diagnostics', async () => {
  const records=[],events=[],bodies=[];
  const gateway=makeGateway(async(_url,request)=>{
    bodies.push(JSON.parse(request.body));return envelope({ok:true});
  },{protocol:'relationship_agent',diagnosticLogger:entry=>records.push(entry)});
  const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
  let validations=0;
  await gateway.operation({onProgress:event=>events.push(event)},operation=>
    gateway.agentComplete('guide_repair','검토 지침',{},schema,operation,value=>{
      if(++validations===1){
        const error=new HttpError(502,'MODEL_INVALID_RESPONSE','검증 실패');
        error.modelReason='agent_speech_goal';error.modelFeedback='private repair feedback';throw error;
      }
      return value;
    }));
  assert.deepEqual(events.map(event=>[event.status,event.attempt]),[['started',1],['started',2],['completed',2]]);
  assert.equal(JSON.parse(bodies[1].messages[1].content).validation_feedback,'private repair feedback');
  assert.equal(JSON.stringify(records).includes('private repair feedback'),false);
  assert.equal(new Set(records.map(entry=>entry.generation_id)).size,1);
  assert.equal(new Set(records.map(entry=>entry.attempt_id)).size,2);
});

test('internal operation recovery restarts exhausted validation with a fresh controller and preserves sources',async()=>{
  const records=[],events=[],signals=[],bodies=[];
  const gateway=makeGateway(async(_url,request)=>{
    signals.push(request.signal);bodies.push(JSON.parse(request.body));return envelope(bodies.length<=3?'{':state());
  },{timeoutMs:0,retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>records.push(entry)});
  const output=await gateway.updateState(context(),null,{requestId:REQUEST_ID,onProgress:event=>events.push(event)});
  assert.deepEqual(output.patient_state,memory());assert.equal(bodies.length,4);
  assert.equal(signals[0],signals[2]);assert.notEqual(signals[2],signals[3]);
  assert.equal(new Set(bodies.map(body=>body.messages.at(-1).content)).size,1);
  const retries=records.filter(entry=>entry.event==='model_operation_retry');assert.equal(retries.length,1);
  assert.deepEqual(retries[0],{event:'model_operation_retry',request_id:REQUEST_ID,attempt:1,code:'MODEL_INVALID_RESPONSE',reason:'content_json',delay_ms:1});
  assert.ok(events.some(event=>event.stage==='retry'&&event.status==='started'));
  assert.equal(JSON.stringify(retries).includes(context().patient.fields.mood.text),false);
});

test('internal recovery retries unavailable and transient upstream failures without returning them to callers',async()=>{
  for(const status of [503,500,408,425]){
    let calls=0;
    const failures=status===503?3:1;
    const gateway=makeGateway(async()=>++calls<=failures?new Response('',{status}):envelope(state()),
      {timeoutMs:0,retryFailures:true,retryDelayMs:1});
    assert.deepEqual((await gateway.updateState(context())).patient_state,memory());assert.equal(calls,failures+1,status);
  }
});

test('exhausted content reviews cannot restart the whole guide with recovery enabled',async()=>{
  for(const reason of ['agent_analysis_review_rejected','agent_plan_review_rejected',
    'agent_quality_review_rejected','agent_review_rejected','agent_detail_review_rejected','agent_review_stale','agent_review_noop']){
    const records=[],events=[];let operations=0,calls=0;
    const gateway=makeGateway(async()=>{calls++;return envelope(state());},
      {timeoutMs:0,retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>records.push(entry)});
    await assert.rejects(gateway.operation({requestId:REQUEST_ID,onProgress:event=>events.push(event)},async operation=>{
      // An unexpected second operation fails immediately, so a regression
      // cannot leave this test stuck in the old unbounded loop.
      assert.equal(++operations,1,'The reviewed guide must not restart');
      await gateway.request(()=>({messages:[]}),operation,value=>value);
      throw Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','Synthetic review rejected'),{modelReason:reason});
    }),{code:'MODEL_INVALID_RESPONSE',modelReason:reason,modelRequestId:REQUEST_ID});
    assert.equal(calls,1);assert.equal(operations,1);
    assert.equal(records.some(entry=>entry.event==='model_operation_retry'),false);
    assert.equal(events.some(event=>event.stage==='retry'),false);
  }
});

test('internal recovery cannot bypass an excessive Retry-After limit',async()=>{
  for(const status of [429,503])for(const retryAfter of ['60',new Date(Date.now()+60000).toUTCString(),'9'.repeat(400)]){
    let calls=0;
    const records=[];
    const gateway=makeGateway(async()=>++calls===1?new Response('',{status,headers:{'Retry-After':retryAfter}}):envelope(state()),
      {timeoutMs:0,retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>records.push(entry)});
    await assert.rejects(gateway.updateState(context(),null,{requestId:REQUEST_ID}),
      {code:'MODEL_UNAVAILABLE',modelReason:'retry_after_limit',modelRequestId:REQUEST_ID});
    assert.equal(calls,1);
    assert.equal(records.some(entry=>entry.event==='model_operation_retry'),false);
  }
});

test('internal recovery preserves default backoff for malformed Retry-After headers',async()=>{
  for(const status of [429,503]){
    let calls=0;
    const records=[];
    const gateway=makeGateway(async()=>++calls===1?new Response('',{status,headers:{'Retry-After':'not-a-valid-delay'}}):envelope(state()),
      {timeoutMs:0,retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>records.push(entry)});
    assert.deepEqual((await gateway.updateState(context())).patient_state,memory());
    assert.equal(calls,2);
    assert.equal(records.find(entry=>entry.event==='model_retry_wait').delay_ms,250);
    assert.equal(records.some(entry=>entry.event==='model_operation_retry'),false);
  }
});

test('internal recovery renews an explicit expired deadline rather than reusing an aborted controller',async()=>{
  const signals=[];
  const gateway=makeGateway((_url,request)=>{
    signals.push(request.signal);
    if(signals.length===1)return new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
    return Promise.resolve(envelope(state()));
  },{timeoutMs:20,retryFailures:true,retryDelayMs:1});
  assert.deepEqual((await gateway.updateState(context())).patient_state,memory());
  assert.equal(signals.length,2);assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,false);
});

test('authentication, configuration and input-budget errors remain terminal with internal recovery enabled',async()=>{
  for(const [status,body,code] of [
    [401,'private authentication error','MODEL_AUTH_FAILED'],[403,'private authentication error','MODEL_AUTH_FAILED'],
    [400,'private request error','MODEL_UPSTREAM_ERROR'],
    [422,JSON.stringify({error:{code:'context_budget_exceeded'}}),'MODEL_CONTEXT_TOO_LONG'],
  ]){
    let calls=0;
    const gateway=makeGateway(async()=>{calls++;return new Response(body,{status});},{timeoutMs:0,retryFailures:true,retryDelayMs:1});
    await assert.rejects(gateway.updateState(context()),{code});assert.equal(calls,1);
  }
  let calls=0;
  const gateway=makeGateway(async()=>{calls++;},{apiKey:'',timeoutMs:0,retryFailures:true});
  await assert.rejects(gateway.updateState(context()),{code:'MODEL_NOT_CONFIGURED'});assert.equal(calls,0);
});

test('external cancellation aborts an in-flight model request without retrying or reporting a timeout',async()=>{
  const controller=new AbortController();let calls=0,started;
  const waiting=new Promise(resolve=>{started=resolve;});
  const gateway=makeGateway((_url,request)=>{
    calls++;started();return new Promise((resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new Error('private abort reason')),{once:true}));
  },{timeoutMs:0,retryFailures:true,retryDelayMs:1});
  const work=gateway.updateState(context(),null,{signal:controller.signal,requestId:REQUEST_ID});
  await waiting;controller.abort('private external reason');
  await assert.rejects(work,error=>error.code==='MODEL_CANCELLED'&&error.status===499&&error.modelRequestId===REQUEST_ID&&!error.message.includes('private'));
  assert.equal(calls,1);
});

test('external cancellation ends request and operation retry waits before another model call',{timeout:1000},async()=>{
  for(const operationWait of [false,true]){
    const controller=new AbortController(),records=[];let calls=0,waiting;
    const ready=new Promise(resolve=>{waiting=resolve;});
    const gateway=makeGateway(async()=>{
      calls++;return operationWait?envelope('{'):new Response('',{status:503,headers:{'Retry-After':'1'}});
    },{timeoutMs:0,retryFailures:true,retryDelayMs:60000,diagnosticLogger:entry=>{
      records.push(entry);if(entry.event===(operationWait?'model_operation_retry':'model_attempt'))waiting();
    }});
    const work=gateway.updateState(context(),null,{signal:controller.signal});
    await ready;await new Promise(resolve=>setImmediate(resolve));controller.abort();
    await assert.rejects(work,{code:'MODEL_CANCELLED',status:499});assert.equal(calls,operationWait?3:1);
    if(operationWait)assert.equal(records.find(entry=>entry.event==='model_operation_retry').delay_ms,30000);
    else assert.equal(records.at(-1).reason,'cancelled');
  }
});

test('an already cancelled call performs no discovery, generation or internal retries',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;
  const gateway=makeGateway(async()=>{calls++;return envelope(state());},{timeoutMs:0,retryFailures:true,discoverTokenLimits:true});
  await assert.rejects(gateway.updateState(context(),null,{signal:controller.signal}),{code:'MODEL_CANCELLED',status:499});assert.equal(calls,0);
});
