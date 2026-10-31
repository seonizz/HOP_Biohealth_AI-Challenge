import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/server.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const options = {skip:!databaseUrl, timeout:15000};
const memory = {summary:'합성 테스트 입력', facts:[], unknowns:['확인하지 않은 내용'], user_goal:'합성 테스트'};
const guide = {top:'통합', script:'합성 결과 문장', doList:['합성 실천 항목'], avoid:['합성 주의 항목'],
  next:'합성 다음 단계', care:{feel:'합성 돌봄 문장', tips:['합성 도움말']}};
const output = () => ({patient_state:structuredClone(memory), name_index:null,
  guide:structuredClone(guide), assessment:{safety:false}});
const answers = [{question_id:'name', text:'합성별칭'}, {question_id:'concern', text:'  합성 원문\n둘째 줄  '}];
const runPath = id => `/api/test-runs/${id}`;

async function fixture(t, gateway) {
  const schema = `test_runner_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({connectionString:databaseUrl});
  let app;
  await admin.query(`CREATE SCHEMA ${schema}`);
  t.after(async () => {
    try { await app?.shutdown(); }
    finally {
      try { await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
      finally { await admin.end(); }
    }
  });
  app = await createApp({databaseUrl, schema, key:randomBytes(32), gateway, referralProvider:null});
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = async () => {
    const response = await fetch(`${base}/api/bootstrap`);
    assert.equal(response.status, 200);
    const bootstrap = await response.json();
    return {bootstrap, cookie:response.headers.get('set-cookie').split(';')[0], csrf:bootstrap.csrf_token};
  };
  const request = async (session, path, method = 'GET', body, {headers = {}, signal} = {}) => {
    const response = await fetch(base + path, {method, signal, headers:{
      'content-type':'application/json',
      ...(session ? {cookie:session.cookie, 'x-csrf-token':session.csrf} : {}), ...headers,
    }, ...(body !== undefined ? {body:JSON.stringify(body)} : {})});
    return {status:response.status, data:await response.json()};
  };
  const assertEmpty = async session => {
    const history = await request(session, '/api/records');
    assert.equal(history.status, 200);
    assert.deepEqual(history.data.records, []);
    assert.deepEqual(history.data.incomplete_intakes, []);
    const {rows:[counts]} = await app.store.pool.query(`SELECT
      (SELECT count(*)::int FROM intakes) AS intakes,
      (SELECT count(*)::int FROM records) AS records,
      (SELECT count(*)::int FROM patient_states) AS patient_states,
      (SELECT count(*)::int FROM patient_state_revisions) AS patient_state_revisions`);
    assert.deepEqual(counts, {intakes:0, records:0, patient_states:0, patient_state_revisions:0});
  };
  return {...app, base, browser, request, assertEmpty};
}

function controlledGateway() {
  const started = Promise.withResolvers(), aborted = Promise.withResolvers();
  let calls = 0;
  const gateway = {model:'synthetic-test', protocol:'relationship_agent',
    respond:async (_context, _memory, operation) => {
      if (++calls > 1) return output();
      operation.onProgress({stage:'card_care', status:'started'});
      operation.onCard({type:'upsert', id:'care', value:guide.care});
      started.resolve(operation);
      await new Promise((resolve, reject) => {
        const cancel = () => { aborted.resolve(operation.signal); reject(operation.signal.reason); };
        operation.signal.addEventListener('abort', cancel, {once:true});
        if (operation.signal.aborted) cancel();
      });
      return output();
    }};
  return {gateway, started:started.promise, aborted:aborted.promise, calls:() => calls};
}

test('test page is served with shared result assets and test APIs require session and CSRF', options, async t => {
  let calls = 0;
  const f = await fixture(t, {respond:async () => { calls++; return output(); }});
  const response = await fetch(`${f.base}/test-runner.html`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const html = await response.text();
  assert.match(html, /js\/components\/GuideCards\.js/);
  assert.match(html, /js\/components\/ResultScreen\.js/);
  assert.match(html, /css\/result\.css/);
  const path = runPath(randomUUID()), session = await f.browser();
  for (const [method, suffix, body] of [['POST','',{answers}], ['GET','/progress'], ['DELETE','']]) {
    const denied = await f.request(null, path + suffix, method, body);
    assert.equal(denied.status, 401);
    assert.equal(denied.data.error.code, 'SESSION_REQUIRED');
  }
  for (const method of ['POST','DELETE']) {
    const denied = await f.request(session, path, method, method === 'POST' ? {answers} : undefined,
      {headers:{'x-csrf-token':'incorrect'}});
    assert.equal(denied.status, 403);
    assert.equal(denied.data.error.code, 'CSRF_REJECTED');
  }
  assert.equal(calls, 0);
  await f.assertEmpty(session);
});

test('test generation receives exact supplied evidence and never persists an intake or result', options, async t => {
  const seen = [];
  const f = await fixture(t, {model:'synthetic-test', protocol:'relationship_agent',
    updateState:async () => assert.fail('test input must not run per-turn model updates'),
    respond:async (context, prior) => { seen.push({context, prior}); return output(); }});
  const session = await f.browser(), id = randomUUID();
  const generated = await f.request(session, runPath(id), 'POST', {answers});
  assert.equal(generated.status, 200);
  assert.equal(generated.data.test, true);
  assert.equal(generated.data.saved, false);
  assert.equal(generated.data.profile.name, '합성별칭');
  assert.deepEqual(generated.data.guide, guide);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].prior, null);
  assert.equal(seen[0].context.patient.fields.concern.rawText, answers[1].text);
  assert.equal(seen[0].context.user_goal.message.status, 'not_asked');
  assert.deepEqual(seen[0].context.payload.answers.map(answer => answer.id), ['name','concern']);
  assert.equal(seen[0].context.followUps, 0);
  assert.equal((await f.request(session, `${runPath(id)}/progress`)).status, 404);
  assert.equal((await f.request(session, runPath(id), 'DELETE')).status, 404);
  await f.assertEmpty(session);
});

test('invalid test input and IDs never call the model and release the run slot', options, async t => {
  let calls = 0;
  const f = await fixture(t, {respond:async () => { calls++; return output(); }});
  const session = await f.browser(), path = runPath(randomUUID());
  for (const [body, code] of [
    [{answers:[]}, 'invalid_test_answers'],
    [{answers:[{question_id:'unknown',text:'합성'}]}, 'invalid_test_answer'],
    [{answers:[answers[0],answers[0]]}, 'duplicate_test_answer'],
    [{answers, record:true}, 'INVALID_INPUT'],
    [{answers:[{question_id:'rel',selected:[999]}]}, 'invalid_selection'],
  ]) {
    const response = await f.request(session, path, 'POST', body);
    assert.ok([400,422].includes(response.status), JSON.stringify(response));
    assert.equal(response.data.error.code, code);
    assert.equal((await f.request(session, `${path}/progress`)).status, 404);
  }
  assert.equal((await f.request(session, runPath('invalid-id'), 'POST', {answers})).status, 404);
  assert.equal(calls, 0);
  assert.equal((await f.request(session, path, 'POST', {answers})).status, 200);
  assert.equal(calls, 1);
  await f.assertEmpty(session);
});

test('progress and cancellation are owner scoped and cancelling releases the owner run slot', options, async t => {
  const control = controlledGateway(), f = await fixture(t, control.gateway);
  const owner = await f.browser(), other = await f.browser(), path = runPath(randomUUID());
  const pending = f.request(owner, path, 'POST', {answers});
  const operation = await control.started;
  const progress = await f.request(owner, `${path}/progress`);
  assert.equal(progress.status, 200);
  assert.deepEqual(progress.data.cards, [{id:'care',value:guide.care}]);
  assert.equal((await f.request(other, `${path}/progress`)).status, 404);
  assert.equal((await f.request(other, path, 'DELETE')).status, 404);
  assert.equal(operation.signal.aborted, false);
  const duplicate = await f.request(owner, runPath(randomUUID()), 'POST', {answers});
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.data.error.code, 'TEST_RUN_ACTIVE');
  assert.equal(control.calls(), 1);
  assert.deepEqual(await f.request(owner, path, 'DELETE'), {status:200,data:{cancelled:true}});
  const cancelled = await pending;
  assert.equal(cancelled.status, 499);
  assert.equal(cancelled.data.error.code, 'MODEL_CANCELLED');
  assert.equal((await control.aborted).aborted, true);
  assert.equal((await f.request(owner, `${path}/progress`)).status, 404);
  assert.equal((await f.request(owner, runPath(randomUUID()), 'POST', {answers})).status, 200);
  await f.assertEmpty(owner);
  await f.assertEmpty(other);
});

test('disconnecting the request cancels the model and clears ephemeral progress', options, async t => {
  const control = controlledGateway(), f = await fixture(t, control.gateway);
  const session = await f.browser(), path = runPath(randomUUID()), controller = new AbortController();
  const pending = f.request(session, path, 'POST', {answers}, {signal:controller.signal});
  const rejected = assert.rejects(pending, {name:'AbortError'});
  await control.started;
  controller.abort();
  await rejected;
  assert.equal((await control.aborted).aborted, true);
  assert.equal((await f.request(session, `${path}/progress`)).status, 404);
  assert.equal((await f.request(session, runPath(randomUUID()), 'POST', {answers})).status, 200);
  await f.assertEmpty(session);
});

test('deleting the owner conversations cancels its running test without creating records', options, async t => {
  const control = controlledGateway(), f = await fixture(t, control.gateway);
  const session = await f.browser(), path = runPath(randomUUID());
  const pending = f.request(session, path, 'POST', {answers});
  await control.started;
  assert.equal((await f.request(session, '/api/conversations', 'DELETE')).status, 200);
  assert.equal((await pending).status, 499);
  assert.equal((await control.aborted).aborted, true);
  assert.equal((await f.request(session, `${path}/progress`)).status, 404);
  await f.assertEmpty(session);
});
