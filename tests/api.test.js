import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/server.js';
import { createIntake } from '../src/intake.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const memory = { summary:'사용자가 전한 상황', facts:[], unknowns:['당사자의 직접 의향'], user_goal:'부담 없는 첫마디' };
const guide = { top:'통합', script:'요즘 어떻게 지내는지 듣고 싶어.', doList:['판단하지 않고 듣기'], avoid:['대답을 재촉하기'], next:'상대가 원하는 도움을 확인해 보세요.', care:{ feel:'곁에서 돕는 마음도 소중해요.', tips:['잠시 쉬어도 괜찮아요.','주변에 도움을 나누세요.'] } };

async function fixture(t, gateway = { model:'gemma4:12b', updateState:async () => memory, respond:async () => ({ patient_state:memory, guide, assessment:{ safety:false } }) }) {
  const schema = 'api_test_' + randomBytes(8).toString('hex');
  const admin = new pg.Pool({ connectionString:databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const app = await createApp({ databaseUrl, schema, key:randomBytes(32), gateway });
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

test('server intake updates model memory and records; back/correct and deletion purge context', { skip:!databaseUrl }, async t => {
  let resultCalls = 0;
  const gateway = { model:'gemma4:12b', updateState:async () => memory, respond:async () => { resultCalls++; return { patient_state:memory, guide, assessment:{ safety:false } }; } };
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
  const f = await fixture(t, { updateState:async () => { throw new Error('unavailable'); } }), session = await f.browser();
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
