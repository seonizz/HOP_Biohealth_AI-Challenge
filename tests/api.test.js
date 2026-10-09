import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { createIntake } from '../src/intake.js';
import { HttpError } from '../src/errors.js';

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
  assert.equal(a.bootstrap.questions.length, 30);
  assert.equal(a.bootstrap.columns.length, 10);
  assert.equal(a.bootstrap.model_connected, true);
  assert.equal((await fetch(f.base + '/')).status, 200);
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

test('model failure retains original input, and revision conflict prevents duplicate answer', { skip:!databaseUrl }, async t => {
  const f = await fixture(t, { updateState:async () => { throw new HttpError(503, 'MODEL_UNAVAILABLE', '모델에 연결하지 못했어요.'); } }), session = await f.browser();
  const row = (await f.request(session, '/api/intakes', 'POST', {})).data;
  const input = { revision:0, question_id:'name', text:'친구', selected:[] };
  const saved = await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', input);
  assert.equal(saved.status, 200);
  assert.ok(saved.data.model_warning);
  assert.equal(saved.data.name, '친구');
  assert.equal((await f.request(session, `/api/intakes/${row.id}/answers`, 'POST', input)).status, 409);
  const ctx = await f.request(session, `/api/intakes/${row.id}/context`);
  assert.equal(ctx.data.context.patient.fields.name.rawText, '친구');
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
  assert.equal(saved.data.name, '친구');
  assert.equal(saved.data.question.id, 'want');
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
