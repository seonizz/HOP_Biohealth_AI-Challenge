import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { createIntake, answerIntake, currentView } from '../src/intake.js';
import { HttpError } from '../src/errors.js';
import { ModelGateway } from '../src/model.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const memory = { summary:'사용자가 전한 상황', facts:[], unknowns:['당사자의 직접 의향'], user_goal:'부담 없는 첫마디' };
const update = state => ({ patient_state:state, name_index:null, question_plan:{ skip:[] } });
const guide = { top:'통합', script:'요즘 어떻게 지내는지 듣고 싶어.', doList:['판단하지 않고 듣기'], avoid:['대답을 재촉하기'], next:'상대가 원하는 도움을 확인해 보세요.', care:{ feel:'곁에서 돕는 마음도 소중해요.', tips:['잠시 쉬어도 괜찮아요.','주변에 도움을 나누세요.'] } };

async function fixture(t, gateway = { model:'gemma4:12b', updateState:async () => update(memory), respond:async () => ({ patient_state:memory, guide, assessment:{ safety:false }, name_index:null }) }, options = {}) {
  const schema = 'api_test_' + randomBytes(8).toString('hex');
  const admin = new pg.Pool({ connectionString:databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const app = await createApp({ databaseUrl, schema, key:randomBytes(32), gateway, ...options });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    // The close event begins pool draining; wait until the connection count reaches zero.
    await app.store.close().catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const browser = async () => {
    const r = await fetch(base + '/api/bootstrap');
    assert.equal(r.status, 200);
    const bootstrap = await r.json();
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return { bootstrap, cookie, csrf:bootstrap.csrf_token };
  };
  const request = async (session, path, method = 'GET', data, extra = {}) => {
    const response = await fetch(base + path, { method, headers:{ cookie:session.cookie, 'x-csrf-token':session.csrf, 'content-type':'application/json', ...extra }, ...(data !== undefined ? { body:JSON.stringify(data) } : {}) });
    return { status:response.status, data:await response.json() };
  };
  return { ...app, base, browser, request };
}

test('UI catalog, browser isolation, CSRF and persisted column interactions', { skip:!databaseUrl }, async t => {
  const f = await fixture(t), a = await f.browser(), b = await f.browser();
  assert.equal(a.bootstrap.questions.length, 29);
  assert.equal(a.bootstrap.columns.length, 10);
  assert.equal(a.bootstrap.model_connected, true);
  assert.equal((await fetch(f.base + '/')).status, 200);
  for (const [path, mime] of [
    ['/assets/fonts/Jua-Regular.ttf', 'font/ttf'],
    ['/assets/fonts/NanumSquareRound-Regular.woff2', 'font/woff2'],
    ['/assets/fonts/NanumSquareRound-Bold.woff2', 'font/woff2'],
  ]) {
    const font = await fetch(f.base + path);
    assert.equal(font.status, 200);
    assert.equal(font.headers.get('content-type'), mime);
    assert.ok((await font.arrayBuffer()).byteLength > 1000);
  }
  assert.equal(a.bootstrap.questions[0].required, true);
  const create = await f.request(a, '/api/intakes', 'POST', {});
  assert.equal(create.status, 201);
  const id = create.data.id;
  assert.equal((await f.request(b, `/api/intakes/${id}`)).status, 404);
  assert.equal((await f.request(a, '/api/intakes', 'POST', {}, { 'x-csrf-token':'bad' })).status, 403);
  assert.equal((await f.request(a, '/api/intakes', 'POST', {}, { origin:'https://other.example' })).status, 403);
  const saved = await f.request(a, '/api/columns/listen/state', 'PATCH', { saved:true, read:true });
  assert.deepEqual(saved.data.state, { read:['listen'], saved:['listen'] });
  assert.equal((await f.request(a, '/api/columns?only=saved')).data.columns.length, 1);
  assert.equal((await f.request(b, '/api/columns?only=saved')).data.columns.length, 0);
  assert.equal((await f.request(a, '/api/columns?only=unread')).data.columns.length, 9);
  assert.equal((await f.request(a, '/api/columns/listen/state', 'PATCH', { read:false })).status, 422);
  assert.equal((await f.request(a, '/api/columns/today?date=2026-02-30')).status, 422);
  const today = await f.request(a, '/api/columns/today?date=2026-10-09');
  assert.equal(today.data.column.art, a.bootstrap.columns[(2026 * 372 + 9 * 31 + 9) % 10].art);
  assert.notEqual((await f.request(a, `/api/columns/random?exclude=${today.data.column.art}`)).data.column.art, today.data.column.art);
  const forbidden = await fetch(f.base + '/.env');
  assert.equal(forbidden.status, 404);
});

test('updated UI backs repeatedly through stored prompts and redoes a pending follow-up with server history', { skip:!databaseUrl }, async t => {
  const f = await fixture(t, null), session = await f.browser();
  let view = (await f.request(session, '/api/intakes', 'POST', {})).data;
  const send = async data => {
    const result = await f.request(session, `/api/intakes/${view.id}/answers`, 'POST', { revision:view.revision,question_id:view.question.id,follow_up:!!view.question.follow_up,...data });
    assert.equal(result.status, 200); view = result.data;
  };
  await send({text:'시연 친구'}); await send({text:'함께 이야기를 듣고 곁에 있다는 말을 하고 싶어요.'});
  await send({selected:[0]}); await send({text:'짝',custom:'짝'});
  assert.equal(view.question.follow_up, true); assert.equal(view.canGoBack, true);
  const pendingRevision = view.revision;
  view = (await f.request(session, `/api/intakes/${view.id}/back`, 'POST', {revision:view.revision})).data;
  assert.equal(view.question.id, 'rel'); assert.equal(view.pendingFollow, false);
  assert.ok(view.revision > pendingRevision);
  for (const id of ['goal','want','name']) {
    const back = await f.request(session, `/api/intakes/${view.id}/back`, 'POST', {revision:view.revision});
    assert.equal(back.status, 200); view = back.data; assert.equal(view.question.id, id);
  }
  assert.equal(view.canGoBack, false);
  const row = await f.store.pool.query('SELECT content,owner FROM intakes WHERE id=$1', [view.id]);
  const state = f.store.open(row.rows[0].content, `${row.rows[0].owner}:intake:${view.id}`);
  assert.deepEqual(state.ans, {}); assert.equal(state.history.length, 1); assert.equal(state.pendingFollow, null);
  const context = (await f.request(session, `/api/intakes/${view.id}/context`)).data.context;
  assert.equal(context.payload.answers.length, 0);
  assert.equal(context.log.some(item => item.who === 'me'), false);
});

test('DB question changes reach catalog and new conversations while previous records retain their snapshot', { skip:!databaseUrl }, async t => {
  const f = await fixture(t, null), session = await f.browser();
  const old = (await f.request(session, '/api/intakes', 'POST', {})).data;
  const owner = (await f.store.browser(session.cookie.slice(15))).id;
  await f.store.saveRecord(owner, {id:101,date:new Date().toISOString(),title:'합성 기존 기록'}, old.id);
  await f.store.pool.query(`UPDATE questions SET definition=jsonb_set(definition,'{q}',to_jsonb($1::text)) WHERE id='name'`, ['DB에서 수정한 이름 질문']);
  await f.store.pool.query(`INSERT INTO questions(id,kind,sort_order,enabled,subject,definition) VALUES ('demo_note','base',150,TRUE,'patient',$1)`,
    [{type:'text',q:'추가 관찰 메모를 알려 주세요.',sec:'관찰'}]);
  await f.store.pool.query("DELETE FROM questions WHERE id='extra'");
  await f.store.pool.query("UPDATE questions SET enabled=FALSE WHERE id='mysupport'");
  const catalog = await f.request(session, '/api/questions');
  assert.equal(catalog.status, 200);
  assert.equal(catalog.data.questions[0].q, 'DB에서 수정한 이름 질문');
  assert.equal(catalog.data.questions[1].id, 'demo_note');
  assert.equal(catalog.data.questions.some(q => ['extra','mysupport'].includes(q.id)), false);
  const boot = await f.request(session, '/api/bootstrap');
  assert.deepEqual(boot.data.questions, catalog.data.questions);
  assert.equal(boot.data.records[0].id, 101);
  const fresh = (await f.request(session, '/api/intakes', 'POST', {})).data;
  assert.equal(fresh.question.q, 'DB에서 수정한 이름 질문');
  assert.equal((await f.request(session, `/api/intakes/${old.id}`)).data.question.q, old.question.q);
  const named = await f.request(session, `/api/intakes/${fresh.id}/answers`, 'POST', {revision:0,question_id:'name',text:'지수'});
  assert.equal(named.status, 200);
  assert.equal(named.data.question.id, 'demo_note');
  const answer = await f.request(session, `/api/intakes/${fresh.id}/answers`, 'POST', {revision:named.data.revision,question_id:'demo_note',text:'요즘 식사량이 줄었다고 들었어요.'});
  assert.equal(answer.status, 200);
  assert.equal(answer.data.question.id, 'want');
  const context = (await f.request(session, `/api/intakes/${fresh.id}/context`)).data.context;
  assert.equal(context.patient.fields.demo_note.rawText, '요즘 식사량이 줄었다고 들었어요.');
  assert.equal(context.patient.fields.demo_note.question, '추가 관찰 메모를 알려 주세요.');
  assert.equal(context.question_set_version, (await f.store.questionSet()).version);
});

test('invalid current question bank returns a clear error but stored conversations remain accessible', { skip:!databaseUrl }, async t => {
  const f = await fixture(t, null), session = await f.browser();
  const old = (await f.request(session, '/api/intakes', 'POST', {})).data;
  await f.store.pool.query('UPDATE questions SET enabled=FALSE');
  for (const [path,method,data] of [['/api/questions','GET'],['/api/bootstrap','GET'],['/api/intakes','POST',{}]]) {
    const response = await f.request(session,path,method,data);
    assert.equal(response.status,503);
    assert.equal(response.data.error.code,'QUESTION_BANK_INVALID');
  }
  assert.equal((await f.request(session, `/api/intakes/${old.id}`)).status, 200);
  const answer = await f.request(session, `/api/intakes/${old.id}/answers`, 'POST', {revision:0,question_id:'name',text:'지수'});
  assert.equal(answer.status,200);
  assert.equal(answer.data.question.id,'want');
});

test('the published Funnel origin works without accepting other browser origins or hosts', { skip:!databaseUrl }, async t => {
  const origin = 'https://s-macbook-pro.tail85b0de.ts.net';
  const f = await fixture(t, null, { allowedOrigins:[origin] });
  const response = await fetch(f.base + '/api/bootstrap', { headers:{ origin, 'x-forwarded-proto':'https' } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie'), /; Secure/);
  const bootstrap = await response.json();
  const session = { cookie:response.headers.get('set-cookie').split(';')[0], csrf:bootstrap.csrf_token };
  assert.equal((await f.request(session, '/api/intakes', 'POST', {}, { origin })).status, 201);
  assert.equal((await f.request(session, '/api/intakes', 'POST', {}, { origin:'https://untrusted.example' })).status, 403);
  const hostStatus = host => new Promise((resolve, reject) => {
    const request = httpRequest(f.base + '/health', { headers:{ host } }, response => {
      response.resume(); resolve(response.statusCode);
    });
    request.on('error', reject); request.end();
  });
  assert.equal(await hostStatus('untrusted.example'), 403);
  assert.equal(await hostStatus(new URL(origin).host), 200);
});

test('server intake updates model memory and records; back/correct and deletion purge context', { skip:!databaseUrl }, async t => {
  let resultCalls = 0;
  const gateway = { model:'gemma4:12b', updateState:async () => update(memory), respond:async () => { resultCalls++; return { patient_state:memory, guide, assessment:{ safety:false }, name_index:null }; } };
  const f = await fixture(t, gateway), session = await f.browser();
  let row = (await f.request(session, '/api/intakes', 'POST', {})).data;
  const id = row.id;
  let count = 0;
  while (row.status === 'active') {
    const q = row.question;
    let text = '', selected = [], skipped = false;
    if (q.id === 'name') text = '친구';
    else if (q.type === 'text') text = '상대에게 부담 없이 말을 건네고 싶어요';
    else if (q.id === 'mood') selected = [q.opts.length - 1];
    else if (q.id === 'cause') selected = [1];
    else if (q.id === 'cgchange') selected = [q.opts.length - 1];
    else if (q.opts?.length) selected = [0];
    const answer = await f.request(session, `/api/intakes/${id}/answers`, 'POST', { revision:row.revision, question_id:q.id, text, selected, skipped, follow_up:!!q.follow_up });
    assert.equal(answer.status, 200, JSON.stringify(answer.data));
    row = answer.data;
    if (++count > 35) throw new Error('Intake did not finish');
  }
  const context = (await f.request(session, `/api/intakes/${id}/context`)).data;
  assert.equal(context.context.patient.alias, '친구');
  assert.deepEqual(context.context.agent_state, memory);
  assert.equal(context.context.supporter.role, 'informant');
  const result = await f.request(session, `/api/intakes/${id}/result`, 'POST', { revision:row.revision });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.record.guide.script, guide.script);
  assert.equal(result.data.record.provenance.kind, 'model');
  assert.deepEqual(result.data.record.profile.scores, {});
  const replay = await f.request(session, `/api/intakes/${id}/result`, 'POST', { revision:row.revision });
  assert.equal(replay.data.record.id, result.data.record.id);
  assert.equal(resultCalls, 1);
  assert.equal((await f.request(session, '/api/records')).data.records.length, 1);
  const other = await f.browser();
  assert.equal((await f.request(other, `/api/records/${result.data.record.id}`, 'DELETE')).status, 404);
  assert.equal((await f.request(session, `/api/records/${result.data.record.id}`, 'DELETE')).status, 200);
  assert.equal((await f.request(session, `/api/intakes/${id}/context`)).status, 404);
});

test('model failures retain the submitted evidence and current prompt; retries commit only one answer', { skip:!databaseUrl }, async t => {
  let calls = 0;
  const f = await fixture(t, { updateState:async context => {
    calls++;
    assert.equal(context.patient.fields.name.rawText, '친구');
    if (calls === 1) throw new HttpError(503, 'MODEL_UNAVAILABLE', '모델에 연결하지 못했어요.');
    if (calls === 2) throw new HttpError(502, 'MODEL_INVALID_RESPONSE', '모델의 답변을 확인하지 못했어요.');
    return update(memory);
  } }), session = await f.browser();
  const row = (await f.request(session, '/api/intakes', 'POST', {})).data;
  const input = { revision:0, question_id:'name', text:'친구', selected:[] };
  const saved = await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', input);
  assert.equal(saved.status, 503);
  assert.equal(saved.data.error.code, 'MODEL_UNAVAILABLE');
  assert.equal(saved.data.question, undefined);
  const pending = (await f.request(session, `/api/intakes/${row.id}`)).data;
  assert.equal(pending.question.id, 'name');
  assert.equal(pending.status, 'active');
  assert.equal(pending.progress, row.progress);
  assert.equal(pending.name, '');
  assert.equal(pending.model_pending, true);
  assert.deepEqual(pending.pending_answer, input);
  assert.deepEqual(pending.log, [...row.log, { who:'me',text:'친구',fu:false }]);
  const ctx = await f.request(session, `/api/intakes/${row.id}/context`);
  assert.equal(ctx.data.context.patient.fields.name.rawText, '친구');
  assert.deepEqual(ctx.data.context.log, pending.log);
  const repeatedFailure = await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', input);
  assert.equal(repeatedFailure.status, 502);
  assert.equal((await f.request(session, `/api/intakes/${row.id}`)).data.revision, 1);
  const completed = await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', { ...input,revision:pending.revision });
  assert.equal(completed.status, 200);
  assert.equal(completed.data.question.id, 'want');
  assert.equal(completed.data.model_pending, undefined);
  assert.equal(completed.data.log.filter(item => item.who === 'me').length, 1);
  assert.equal(calls, 3);
  assert.equal((await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', input)).status, 409);
  const history = await f.store.pool.query('SELECT revision,reason FROM patient_state_revisions WHERE intake_id=$1 ORDER BY revision', [row.id]);
  assert.deepEqual(history.rows, [{revision:0,reason:'created'},{revision:1,reason:'user_answer'},{revision:2,reason:'model_update'}]);
});

test('editing a failed pending answer replaces its current evidence and keeps both encrypted revisions', { skip:!databaseUrl }, async t => {
  let calls = 0;
  const f = await fixture(t, { updateState:async context => {
    if (++calls === 1) throw new HttpError(503, 'MODEL_UNAVAILABLE', '잠시 후 다시 시도해 주세요.');
    assert.equal(context.patient.fields.name.rawText, '내 동생 지수');
    assert.equal(context.log.some(item => item.text === '친구'), false);
    return update(memory);
  } }), session = await f.browser();
  const owner = (await f.store.browser(session.cookie.slice(15))).id;
  const row = (await f.request(session, '/api/intakes', 'POST', {})).data;
  const first = await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {revision:0,question_id:'name',text:'친구'});
  assert.equal(first.status, 503);
  const pending = (await f.request(session, `/api/intakes/${row.id}`)).data;
  const replacement = await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {revision:pending.revision,question_id:'name',text:'내 동생 지수'});
  assert.equal(replacement.status, 200);
  assert.equal(replacement.data.question.id, 'want');
  assert.deepEqual(replacement.data.log.filter(item => item.who === 'me').map(item => item.text), ['내 동생 지수']);
  const history = (await f.store.pool.query('SELECT revision,content FROM patient_state_revisions WHERE intake_id=$1 ORDER BY revision', [row.id])).rows;
  assert.equal(history.length, 4);
  assert.equal(f.store.open(history[1].content, `${owner}:patient-history:${row.id}:1`).patient.fields.name.rawText, '친구');
  assert.equal(f.store.open(history[2].content, `${owner}:patient-history:${row.id}:2`).patient.fields.name.rawText, '내 동생 지수');
  assert.equal(history[1].content.includes('친구'), false);
  assert.equal(history[2].content.includes('내 동생 지수'), false);
});

test('stale answer, back and skip requests cannot replace or cancel a newer pending answer', { skip:!databaseUrl }, async t => {
  let calls = 0;
  const f = await fixture(t, {updateState:async () => {calls++;throw new HttpError(503,'MODEL_UNAVAILABLE','잠시 후 다시 시도해 주세요.');}});
  const session = await f.browser();
  const row = (await f.request(session, '/api/intakes', 'POST', {})).data;
  const first = {revision:0,question_id:'name',text:'처음 친구'};
  const second = {question_id:'name',text:'수정 친구'};
  assert.equal((await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', first)).status, 503);
  const pending = (await f.request(session, `/api/intakes/${row.id}`)).data;
  // sourceRevision is only a retry allowance, not authority to change input.
  assert.equal((await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {...second,revision:first.revision})).status, 409);
  assert.equal((await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {...second,revision:pending.revision})).status, 503);
  const replaced = (await f.request(session, `/api/intakes/${row.id}`)).data;
  assert.equal(replaced.revision, 2);
  assert.equal(replaced.pending_answer.text, second.text);
  assert.equal((await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', first)).status, 409);
  assert.equal((await f.request(session, `/api/intakes/${row.id}/back`, 'POST', {revision:pending.revision})).status, 409);
  assert.equal((await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {revision:pending.revision,question_id:'name',skipped:true})).status, 409);
  assert.equal(calls, 2);
  const latest = (await f.request(session, `/api/intakes/${row.id}`)).data;
  assert.deepEqual(latest, replaced);
  const context = (await f.request(session, `/api/intakes/${row.id}/context`)).data.context;
  assert.equal(context.patient.fields.name.rawText, second.text);
  const history = await f.store.pool.query('SELECT revision FROM patient_state_revisions WHERE intake_id=$1 ORDER BY revision', [row.id]);
  assert.deepEqual(history.rows.map(item => item.revision), [0,1,2]);
  // The replacement's exact input can still be retried at its source revision.
  assert.equal((await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {...second,revision:pending.revision})).status, 503);
  assert.equal(calls, 3);
  assert.equal((await f.request(session, `/api/intakes/${row.id}`)).data.revision, replaced.revision);
});

test('identical concurrent pending requests share one model call and do not append a second message', { skip:!databaseUrl }, async t => {
  let entered, release, calls = 0;
  const modelEntered = new Promise(resolve => { entered = resolve; });
  const modelReleased = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {updateState:async () => { calls++; entered(); await modelReleased; return update(memory); }});
  const session = await f.browser();
  const row = (await f.request(session, '/api/intakes', 'POST', {})).data;
  const input = {revision:0,question_id:'name',text:'시연 친구'};
  const first = f.request(session, `/api/intakes/${row.id}/answers`, 'POST', input);
  await modelEntered;
  let seen;
  const secondSeen = new Promise(resolve => { seen = resolve; });
  const intake = f.store.intake;
  t.mock.method(f.store, 'intake', async function (...args) {
    const result = await intake.apply(this, args);
    if (result.state.modelPending) seen();
    return result;
  });
  const second = f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {...input,selected:[]});
  try { await secondSeen; await new Promise(resolve => setImmediate(resolve)); }
  finally { release(); }
  const results = await Promise.all([first,second]);
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.equal(result.data.revision, 2);
    assert.equal(result.data.question.id, 'want');
    assert.equal(result.data.log.filter(item => item.who === 'me').length, 1);
  }
});

test('an in-flight replacement rejects late model output and preserves the replacement answer', { skip:!databaseUrl }, async t => {
  let entered, release;
  const modelEntered = new Promise(resolve => { entered = resolve; });
  const modelReleased = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {updateState:async context => {
    if (context.patient.fields.name.rawText === '처음 친구') { entered(); await modelReleased; }
    return update(memory);
  }});
  const session = await f.browser();
  const row = (await f.request(session, '/api/intakes', 'POST', {})).data;
  const first = f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {revision:0,question_id:'name',text:'처음 친구'});
  await modelEntered;
  let replacement;
  try {
    const pending = (await f.request(session, `/api/intakes/${row.id}`)).data;
    replacement = await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {revision:pending.revision,question_id:'name',text:'수정 친구'});
  } finally { release(); }
  const late = await first;
  assert.equal(replacement.status, 200);
  assert.equal(replacement.data.revision, 3);
  assert.equal(late.status, 409);
  assert.equal(late.data.error.code, 'REVISION_CONFLICT');
  const latest = (await f.request(session, `/api/intakes/${row.id}`)).data;
  assert.equal(latest.question.id, 'want');
  assert.equal(latest.model_pending, undefined);
  assert.deepEqual(latest.log.filter(item => item.who === 'me').map(item => item.text), ['수정 친구']);
  const context = (await f.request(session, `/api/intakes/${row.id}/context`)).data.context;
  assert.equal(context.patient.fields.name.rawText, '수정 친구');
});

test('failed base and follow-up model turns retain their exact current prompts until retry succeeds', { skip:!databaseUrl }, async t => {
  let calls = 0;
  const f = await fixture(t, {updateState:async context => {
    if (++calls % 2) throw new HttpError(503,'MODEL_UNAVAILABLE','잠시 후 다시 시도해 주세요.');
    assert.ok(context.patient.fields.rel.rawText);
    return update(memory);
  }});
  const session = await f.browser();
  const owner = (await f.store.browser(session.cookie.slice(15))).id;
  let state = createIntake();
  for (let i = 0; currentView(state).question?.id !== 'rel' && i < 10; i++) {
    const q = currentView(state).question;
    state = answerIntake(state,{question_id:q.id,...(q.type === 'text' ? {text:'시연 친구에게 충분히 자세히 이야기하고 싶어요.'} : {selected:[0]})});
  }
  assert.equal(currentView(state).question.id, 'rel');
  const row = await f.store.createIntake(owner,state);
  const baseInput = {revision:0,question_id:'rel',text:'짝',custom:'짝'};
  assert.equal((await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', baseInput)).status, 503);
  const pendingBase = (await f.request(session, `/api/intakes/${row.id}`)).data;
  assert.equal(pendingBase.question.follow_up, undefined);
  assert.equal(pendingBase.pendingFollow, false);
  assert.equal(pendingBase.log.at(-1).text, '짝');
  const follow = (await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', baseInput)).data;
  assert.equal(follow.question.follow_up, true);
  const followInput = {revision:follow.revision,question_id:'rel',follow_up:true,text:'직장에서 함께 근무하는 동료예요.'};
  assert.equal((await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', followInput)).status, 503);
  const pendingFollow = (await f.request(session, `/api/intakes/${row.id}`)).data;
  assert.deepEqual(pendingFollow.question, follow.question);
  assert.deepEqual(pendingFollow.log.at(-1), {who:'me',text:followInput.text,fu:true});
  const context = (await f.request(session, `/api/intakes/${row.id}/context`)).data.context;
  assert.equal(context.patient.fields.rel.followUp.answer.rawText, followInput.text);
  const next = await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', followInput);
  assert.equal(next.status, 200);
  assert.equal(next.data.question.id, 'contact');
  assert.equal(next.data.model_pending, undefined);
  assert.equal(next.data.log.filter(item => item.who === 'me' && item.text === followInput.text).length, 1);
});

test('back and explicit skip use the latest pending revision and discard its uncommitted answer', { skip:!databaseUrl }, async t => {
  let calls = 0;
  const f = await fixture(t, {updateState:async () => {calls++;throw new HttpError(503,'MODEL_UNAVAILABLE','잠시 후 다시 시도해 주세요.');}});
  const session = await f.browser();
  const owner = (await f.store.browser(session.cookie.slice(15))).id;
  const first = (await f.request(session, '/api/intakes', 'POST', {})).data;
  assert.equal((await f.request(session, `/api/intakes/${first.id}/answers`, 'POST', {revision:0,question_id:'name',text:'취소할 이름'})).status, 503);
  assert.equal((await f.request(session, `/api/intakes/${first.id}/back`, 'POST', {revision:0})).status, 409);
  const pendingFirst = (await f.request(session, `/api/intakes/${first.id}`)).data;
  const back = await f.request(session, `/api/intakes/${first.id}/back`, 'POST', {revision:pendingFirst.revision});
  assert.equal(back.status, 200);
  assert.equal(back.data.question.id, 'name');
  assert.equal(back.data.model_pending, undefined);
  assert.equal(back.data.log.some(item => item.who === 'me'), false);
  let state = createIntake();
  for (const text of ['시연 친구','곁에 있다는 말을 충분히 전하고 싶어요.']) {
    state = answerIntake(state,{question_id:currentView(state).question.id,text});
  }
  assert.equal(currentView(state).question.id, 'goal');
  const row = await f.store.createIntake(owner,state);
  assert.equal((await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {revision:0,question_id:'goal',selected:[0]})).status, 503);
  assert.equal((await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {revision:0,question_id:'goal',skipped:true})).status, 409);
  const pendingGoal = (await f.request(session, `/api/intakes/${row.id}`)).data;
  const skipped = await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {revision:pendingGoal.revision,question_id:'goal',skipped:true});
  assert.equal(skipped.status, 200);
  assert.equal(skipped.data.question.id, 'rel');
  assert.equal(skipped.data.model_pending, undefined);
  const context = (await f.request(session, `/api/intakes/${row.id}/context`)).data.context;
  assert.equal(context.user_goal.desired_outcomes.status, 'skipped');
  assert.equal(context.user_goal.desired_outcomes.selected.length, 0);
  assert.equal(calls, 2);
});

test('a failed final model update cannot expose a ready view or start final result generation', { skip:!databaseUrl }, async t => {
  let resultCalls = 0;
  const f = await fixture(t, {updateState:async () => {throw new HttpError(503,'MODEL_UNAVAILABLE','잠시 후 다시 시도해 주세요.');},respond:async () => {resultCalls++;}});
  const session = await f.browser();
  const owner = (await f.store.browser(session.cookie.slice(15))).id;
  let state = createIntake();
  for (let i = 0; currentView(state).question?.id !== 'mysupport' && i < 40; i++) {
    const q = currentView(state).question;
    state = answerIntake(state,{question_id:q.id,follow_up:!!q.follow_up,...(q.type === 'text' ? {text:'시연을 위한 충분한 상황 설명을 입력합니다.'} : {selected:[0]})});
  }
  assert.equal(currentView(state).question.id, 'mysupport');
  const row = await f.store.createIntake(owner,state);
  const failed = await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', {revision:0,question_id:'mysupport',selected:[0]});
  assert.equal(failed.status, 503);
  const pending = (await f.request(session, `/api/intakes/${row.id}`)).data;
  assert.equal(pending.status, 'active');
  assert.equal(pending.question.id, 'mysupport');
  assert.ok(pending.progress < 100);
  assert.equal((await f.request(session, `/api/intakes/${row.id}/result`, 'POST', {revision:pending.revision})).status, 409);
  assert.equal(resultCalls, 0);
});

test('indexed chat names and grounded skips persist through API and correction restores the prior plan', { skip:!databaseUrl }, async t => {
  const gateway = { updateState:async context => ({ ...update(memory),
    name_index:{ alias:'지수', source_question_id:'name', quote:'지수' },
    question_plan:{ skip:context.user_goal.message.status === 'answered' ? [{
      question_id:'goal', reason:'already_covered', explanation:'원하는 대화 목표를 이미 알려 주었습니다.',
      evidence:[{ subject:'user_goal', question_id:'want', quote:'내가 곁에 있다는 것' }],
    }] : [] },
  }) };
  const f = await fixture(t, gateway), session = await f.browser();
  let row = (await f.request(session, '/api/intakes', 'POST', {})).data;
  row = (await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', { revision:0, question_id:'name', text:'내 동생 지수' })).data;
  assert.equal(row.chat_title, '지수');
  assert.match(row.question.q, /지수에게/);
  const answer = await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', { revision:row.revision, question_id:'want', text:'내가 곁에 있다는 것을 전하고 싶어요.' });
  assert.equal(answer.status, 200);
  row = answer.data;
  assert.equal(row.question.id, 'rel');
  assert.equal(row.chat_title, '지수');
  const persisted = await f.request(session, `/api/intakes/${row.id}/context`);
  assert.equal(persisted.data.context.patient.fields.name.rawText, '내 동생 지수');
  assert.equal(persisted.data.context.user_goal.desired_outcomes.status, 'auto_skipped');
  assert.equal(persisted.data.context.chat_title, '지수');
  const corrected = await f.request(session, `/api/intakes/${row.id}/back`, 'POST', { revision:row.revision });
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.question.id, 'want');
  const restored = await f.request(session, `/api/intakes/${row.id}/context`);
  assert.equal(restored.data.context.user_goal.desired_outcomes.status, 'not_asked');
});

test('model memory storage failure returns 500 and retains the committed answer', { skip:!databaseUrl }, async t => {
  const f = await fixture(t), session = await f.browser();
  const row = (await f.request(session, '/api/intakes', 'POST', {})).data;
  const updateIntake = f.store.updateIntake;
  t.mock.method(f.store, 'updateIntake', function (...args) {
    if (args[4] === 'model_update') throw new Error('Injected storage failure');
    return updateIntake.apply(this, args);
  });
  const failed = await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', { revision:0, question_id:'name', text:'친구', selected:[] });
  assert.equal(failed.status, 500);
  assert.equal(failed.data.error.code, 'INTERNAL_ERROR');
  assert.equal(failed.data.model_warning, undefined);
  const saved = await f.request(session, `/api/intakes/${row.id}`);
  assert.equal(saved.data.revision, 1);
  assert.equal(saved.data.name, '');
  assert.equal(saved.data.question.id, 'name');
  assert.equal(saved.data.model_pending, true);
  const ctx = await f.request(session, `/api/intakes/${row.id}/context`);
  assert.equal(ctx.data.revision, 1);
  assert.equal(ctx.data.context.patient.fields.name.rawText, '친구');
  assert.equal(ctx.data.context.agent_state, null);
});

test('a correction while the model waits returns 409 and preserves the latest state', { skip:!databaseUrl }, async t => {
  let entered, release;
  const modelEntered = new Promise(resolve => { entered = resolve; });
  const modelReleased = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { updateState:async () => { entered(); await modelReleased; return update(memory); } });
  const session = await f.browser();
  const row = (await f.request(session, '/api/intakes', 'POST', {})).data;
  const pending = f.request(session, `/api/intakes/${row.id}/answers`, 'POST', { revision:0, question_id:'name', text:'친구', selected:[] });
  await modelEntered;
  let corrected;
  try { corrected = await f.request(session, `/api/intakes/${row.id}/back`, 'POST', { revision:1 }); }
  finally { release(); }
  const failed = await pending;
  assert.equal(corrected.status, 200);
  assert.equal(corrected.data.revision, 2);
  assert.equal(failed.status, 409);
  assert.equal(failed.data.error.code, 'REVISION_CONFLICT');
  assert.equal(failed.data.model_warning, undefined);
  const latest = await f.request(session, `/api/intakes/${row.id}`);
  assert.equal(latest.data.revision, 2);
  assert.equal(latest.data.name, '');
  assert.equal(latest.data.question.id, 'name');
  const ctx = await f.request(session, `/api/intakes/${row.id}/context`);
  assert.equal(ctx.data.revision, 2);
  assert.equal(ctx.data.context.agent_state, null);
});

test('two results at the same clock time have distinct stable record IDs', { skip:!databaseUrl }, async t => {
  const f = await fixture(t), session = await f.browser();
  const owner = (await f.store.browser(session.cookie.slice(15))).id;
  const ready = { ...createIntake(), status:'ready' };
  const a = await f.store.createIntake(owner, ready), b = await f.store.createIntake(owner, ready);
  t.mock.method(Date, 'now', () => 1791558000000);
  const first = await f.request(session, `/api/intakes/${a.id}/result`, 'POST', { revision:0 });
  const second = await f.request(session, `/api/intakes/${b.id}/result`, 'POST', { revision:0 });
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.notEqual(first.data.record.id, second.data.record.id);
  assert.equal((await f.request(session, '/api/records')).data.records.length, 2);
  const replay = await f.request(session, `/api/intakes/${b.id}/result`, 'POST', { revision:0 });
  assert.equal(replay.data.record.id, second.data.record.id);
});


test('automatic model recovery shares duplicate requests and commits one validated answer', { skip:!databaseUrl }, async t => {
  let calls = 0;
  const diagnostics = [];
  const gateway = new ModelGateway({
    baseUrl:'https://example.test/v1', apiKey:'test-only-secret', model:'malssi-gemma4-31b-step100',
    diagnosticLogger:entry => diagnostics.push(entry),
    fetchImpl:async () => {
      calls++;
      if (calls === 1) return new Response('{}', {status:503,headers:{'Retry-After':'0'}});
      const content = calls === 2 ? '{incomplete' : JSON.stringify({
        patient_state:{
          summary:'사용자가 합성 호칭을 제공했습니다.',
          facts:[{subject:'patient',question_id:'name',quote:'검증친구',interpretation:'사용자가 제공한 호칭입니다.',certainty:'reported'}],
          unknowns:['현재 상태는 미확인입니다.'],
        },
        name_index:{alias:'검증친구',source_question_id:'name',quote:'검증친구'},
        question_plan:{skip:[]},
      });
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}), {status:200});
    },
  });
  const f = await fixture(t, gateway), session = await f.browser();
  const row = (await f.request(session, '/api/intakes', 'POST', {})).data;
  const input = {revision:0,question_id:'name',text:'검증친구',selected:[]};
  const responses = await Promise.all([
    f.request(session, `/api/intakes/${row.id}/answers`, 'POST', input),
    f.request(session, `/api/intakes/${row.id}/answers`, 'POST', input),
  ]);
  for (const response of responses) {
    assert.equal(response.status, 200, JSON.stringify(response.data));
    assert.equal(response.data.revision, 2);
    assert.equal(response.data.question.id, 'want');
    assert.equal(response.data.model_pending, undefined);
    assert.equal(response.data.log.filter(entry => entry.who === 'me').length, 1);
  }
  assert.equal(calls, 3);
  assert.deepEqual(diagnostics.map(entry => entry.reason), ['http_transient','content_json','success']);
  assert.equal(new Set(diagnostics.map(entry => entry.request_id)).size, 1);
  assert.match(diagnostics[0].request_id, /^[0-9a-f-]{36}$/);
  const logged = JSON.stringify(diagnostics);
  for (const secret of ['test-only-secret','검증친구','{incomplete']) assert.equal(logged.includes(secret), false);
  const history = await f.store.pool.query('SELECT revision,reason FROM patient_state_revisions WHERE intake_id=$1 ORDER BY revision', [row.id]);
  assert.deepEqual(history.rows, [{revision:0,reason:'created'},{revision:1,reason:'user_answer'},{revision:2,reason:'model_update'}]);
});


test('shared recovery exhaustion correlates both HTTP failures with one model operation', { skip:!databaseUrl }, async t => {
  let calls = 0;
  const attempts = [], failures = [];
  const gateway = new ModelGateway({
    baseUrl:'https://example.test/v1',apiKey:'test-only-secret',model:'malssi-gemma4-31b-step100',
    diagnosticLogger:entry => attempts.push(entry),
    fetchImpl:async () => ++calls === 1
      ? new Response('{}',{status:503})
      : new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{'}}]})),
  });
  const f = await fixture(t, gateway), session = await f.browser();
  const row = (await f.request(session,'/api/intakes','POST',{})).data;
  const input = {revision:0,question_id:'name',text:'검증친구',selected:[]};
  const previous = console.error;
  let responses;
  try {
    console.error = line => failures.push(JSON.parse(line));
    responses = await Promise.all([
      f.request(session,`/api/intakes/${row.id}/answers`,'POST',input),
      f.request(session,`/api/intakes/${row.id}/answers`,'POST',input),
    ]);
  } finally { console.error = previous; }
  assert.equal(calls,3);
  assert.ok(responses.every(response => response.status === 502 && response.data.error.code === 'MODEL_INVALID_RESPONSE'));
  assert.equal(failures.length,2);
  assert.equal(new Set(failures.map(entry => entry.request_id)).size,2);
  assert.ok(failures.every(entry => entry.operation_id === attempts[0].request_id));
  assert.deepEqual(new Set(failures.map(entry => entry.request_id)),new Set(responses.map(response => response.data.error.request_id)));
  const saved = (await f.request(session,`/api/intakes/${row.id}`)).data;
  assert.equal(saved.revision,1);
  assert.equal(saved.model_pending,true);
  assert.equal(saved.log.filter(entry => entry.who === 'me').length,1);
});
