import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.js';
import { createIntake, answerIntake, currentView } from '../src/intake.js';
import { HttpError } from '../src/errors.js';
import { ModelGateway } from '../src/model.js';
import { PROMPT_VERSION } from '../src/relationship-prompts.js';
import { agentContext, safetySources } from '../src/relationship-agent.js';
import { retrieveSources, sourceDocuments } from '../src/relationship-retrieval.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const invisibleAnswers = ['\u200B', '\u2060', '\u200D', '\uFE0F', '\0', '(건너뛰었어요)\u200B', ' \u200B\u2060\u200D\uFE0F\0 '];
const memory = { summary:'사용자가 전한 상황', facts:[], unknowns:['당사자의 직접 의향'], user_goal:'부담 없는 첫마디' };
const update = state => ({ patient_state:state, name_index:null, question_plan:{ skip:[] } });
const guide = { top:'통합', script:'요즘 어떻게 지내는지 듣고 싶어.', doList:['판단하지 않고 듣기'], avoid:['대답을 재촉하기'], next:'상대가 원하는 도움을 확인해 보세요.', care:{ feel:'곁에서 돕는 마음도 소중해요.', tips:['잠시 쉬어도 괜찮아요.','주변에 도움을 나누세요.'] } };

async function fixture(t, gateway = { model:'gemma4:12b', updateState:async () => update(memory), respond:async () => ({ patient_state:memory, guide, assessment:{ safety:false }, name_index:null }) }, options = {}) {
  const schema = 'api_test_' + randomBytes(8).toString('hex');
  const admin = new pg.Pool({ connectionString:databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const app = await createApp({ databaseUrl, schema, key:randomBytes(32), gateway, referralProvider:null, ...options });
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
    if (path === '/api/intakes' && method === 'POST' && data && !Object.hasOwn(data, 'conversation_epoch')) data = { ...data, conversation_epoch:session.bootstrap?.conversation_epoch ?? 0 };
    const response = await fetch(base + path, { method, headers:{ cookie:session.cookie, 'x-csrf-token':session.csrf, 'content-type':'application/json', ...extra }, ...(data !== undefined ? { body:JSON.stringify(data) } : {}) });
    return { status:response.status, data:await response.json() };
  };
  return { ...app, base, browser, request };
}

test('health identifies the configured protocol without attributing relationship prompts to other protocols', {skip:!databaseUrl}, async t => {
  for(const protocol of ['relationship_agent','json_schema','json_prompt',null]) {
    const gateway=protocol?{model:'test-model',protocol}:null;
    const f=await fixture(t,gateway);
    const health=await (await fetch(f.base+'/health')).json();
    assert.equal(health.model_protocol,protocol);
    assert.equal(health.prompt_version,protocol==='relationship_agent'?PROMPT_VERSION:null);
    assert.equal(health.model_requested,protocol?'test-model':null);
    assert.equal(health.runtime_model_identity_verified,false);
  }
});

test('relationship agent updates and persists internal analysis even for a skipped optional answer', {skip:!databaseUrl}, async t => {
  const observed=[];
  const internal={patient:[],supporter:[],relationship:[],unknowns:['추가 관찰은 아직 확인되지 않았어요.']};
  const gateway={model:'gemma4:12b',protocol:'relationship_agent',updateState:async context=>{
    observed.push(context);
    return {...update(memory),relationship_memory:internal};
  }};
  const f=await fixture(t,gateway), session=await f.browser();
  await f.store.pool.query(`INSERT INTO questions(id,kind,sort_order,enabled,subject,definition) VALUES ('reflection_note','base',150,TRUE,'patient',$1)`,
    [{type:'text',q:'추가로 관찰한 내용을 들려주세요.',sec:'관찰'}]);
  let view=(await f.request(session,'/api/intakes','POST',{})).data;
  view=(await f.request(session,`/api/intakes/${view.id}/answers`,'POST',{revision:view.revision,question_id:'name',text:'지민'})).data;
  assert.equal(view.question.id,'reflection_note');
  const skipped=await f.request(session,`/api/intakes/${view.id}/answers`,'POST',{
    revision:view.revision,question_id:'reflection_note',skipped:true});
  assert.equal(skipped.status,200);view=skipped.data;
  assert.equal(observed.length,2);
  assert.equal(observed[1].patient.fields.reflection_note.status,'skipped');
  assert.deepEqual(observed[1].relationship_state,internal);
  const context=(await f.request(session,`/api/intakes/${view.id}/context`)).data.context;
  assert.deepEqual(context.relationship_state,internal);
  const back=await f.request(session,`/api/intakes/${view.id}/back`,'POST',{revision:view.revision});
  assert.equal(back.status,200);
  assert.equal((await f.request(session,`/api/intakes/${view.id}/context`)).data.context.relationship_state,null);
});

async function sendCurrent(f, session, view, input) {
  const response = await f.request(session, `/api/intakes/${view.id}/answers`, 'POST', {
    revision:view.revision, question_id:view.question.id, follow_up:Boolean(view.question.follow_up), ...input,
  });
  assert.equal(response.status, 200, JSON.stringify(response.data));
  return response.data;
}

async function intakeAtDescribe(f, session) {
  const created = await f.request(session, '/api/intakes', 'POST', {});
  assert.equal(created.status, 201);
  let view = created.data;
  for (const [id, input] of [['name',{text:'합성 친구'}], ['want',{text:'친구의 이야기를 부담 없이 듣고 싶어요.'}],
    ['goal',{skipped:true}], ['rel',{selected:[4]}], ['contact',{skipped:true}]]) {
    assert.equal(view.question.id, id);
    view = await sendCurrent(f, session, view, input);
  }
  assert.equal(view.question.id, 'mood');
  view = await sendCurrent(f, session, view, {selected:[view.question.opts.length - 1]});
  assert.equal(view.question.id, 'describe');
  return view;
}

function assertDescribeSkipped(context) {
  const field = context.patient.fields.describe;
  assert.equal(field.status, 'skipped');
  assert.equal(field.skipped, true);
  assert.equal(field.text, '(건너뛰었어요)');
  assert.deepEqual(field.selected, []);
  assert.equal(field.custom, '');
  assert.equal(context.payload.answers.find(answer => answer.id === 'describe').skipped, true);
  assert.deepEqual(agentContext(context).patient.find(answer => answer.question_id === 'describe').answers, []);
  assert.equal(sourceDocuments(context).some(source => source.question_id === 'describe'), false);
  assert.equal(retrieveSources(context).documents.some(source => source.question_id === 'describe'), false);
  assert.equal(safetySources(context).some(source => source.question_id === 'describe'), false);
  return {status:field.status, skipped:field.skipped, text:field.text, selected:field.selected, custom:field.custom};
}

test('blank and invisible optional text match explicit skip through HTTP, persisted context and final records', {skip:!databaseUrl}, async t => {
  const updates = [], finalContexts = [];
  const gateway = {model:'synthetic-model', protocol:'relationship_agent', updateState:async context => {
    updates.push(context); return update(memory);
  }, respond:async context => {
    finalContexts.push(context); return {patient_state:memory, guide, assessment:{safety:false}, name_index:null};
  }};
  const f = await fixture(t, gateway), session = await f.browser();
  assert.equal(session.bootstrap.questions.length, 29);
  let expected, skippedView;
  for (const input of [{text:'(건너뛰었어요)',skipped:true}, {text:''}, {text:' \t\n '}, {text:'(건너뛰었어요)'}, ...invisibleAnswers.map(text => ({text}))]) {
    let view = await intakeAtDescribe(f, session);
    const before = (await f.request(session, `/api/intakes/${view.id}/context`)).data.context;
    view = await sendCurrent(f, session, view, input);
    assert.equal(view.question.id, 'concern');
    assert.equal(view.pendingFollow, false);
    const reloaded = await f.request(session, `/api/intakes/${view.id}`);
    assert.deepEqual(reloaded.data, view);
    const context = (await f.request(session, `/api/intakes/${view.id}/context`)).data.context;
    const actual = assertDescribeSkipped(context);
    assert.equal(context.patient.fields.describe.rawText, input.text);
    expected ||= actual;
    assert.deepEqual(actual, expected);
    assert.equal(context.answered_count, before.answered_count);
    assertDescribeSkipped(updates.at(-1));
    const stored = (await f.store.pool.query('SELECT content,owner FROM intakes WHERE id=$1', [view.id])).rows[0];
    const state = f.store.open(stored.content, `${stored.owner}:intake:${view.id}`);
    assert.equal(state.ans.describe.skipped, true);
    assert.equal(state.ans.describe.text, '(건너뛰었어요)');
    assert.equal(state.ans.describe.rawText, input.text);
    assert.equal(view.log.filter(row => row.who === 'me').at(-1).text, '(건너뛰었어요)');
    if (input.text === '\0') skippedView = view;
  }
  let view = skippedView, turns = 0;
  while (view.status === 'active') {
    const question = view.question;
    const input = question.type === 'text'
      ? question.required || question.noSkip ? {text:'친구의 말을 존중하며 차분히 듣고 싶어요.'} : {skipped:true}
      : ['cause','support','burden','cgchange_more'].includes(question.id) ? {selected:[1]}
        : question.required || question.noSkip ? {selected:[0]} : {skipped:true};
    view = await sendCurrent(f, session, view, input);
    assert.ok(++turns <= 35, 'The default intake must finish without a follow-up loop');
  }
  const result = await f.request(session, `/api/intakes/${view.id}/result`, 'POST', {revision:view.revision});
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(finalContexts.length, 1);
  assertDescribeSkipped(finalContexts[0]);
  assert.equal(finalContexts[0].patient.fields.describe.rawText, '\0');
  assertDescribeSkipped(result.data.record.context);
  const saved = await f.request(session, `/api/records/${result.data.record.id}`);
  assert.equal(saved.status, 200);
  assertDescribeSkipped(saved.data.record.context);
  assert.deepEqual(saved.data.record.context, result.data.record.context);
});

test('back after invisible optional text restores a prompt and visible Unicode remains exact evidence', {skip:!databaseUrl}, async t => {
  const gateway = {model:'synthetic-model', protocol:'relationship_agent', updateState:async () => update(memory)};
  const f = await fixture(t, gateway), session = await f.browser();
  let view = await intakeAtDescribe(f, session);
  const answeredBefore = (await f.request(session, `/api/intakes/${view.id}/context`)).data.context.answered_count;
  view = await sendCurrent(f, session, view, {text:'\u200B'});
  for (const text of ['최근 저녁 식사를 거르는 모습을 보았어요.', '모름', '없음', '👨‍👩‍👧‍👦', 'e\u0301', '한글', ' \u200B한글\u2060 ']) {
    const back = await f.request(session, `/api/intakes/${view.id}/back`, 'POST', {revision:view.revision});
    assert.equal(back.status, 200); view = back.data;
    assert.equal(view.question.id, 'describe');
    const reverted = (await f.request(session, `/api/intakes/${view.id}/context`)).data.context;
    assert.equal(reverted.patient.fields.describe.status, 'not_asked');
    assert.equal(reverted.answered_count, answeredBefore);
    assert.equal(reverted.agent_state, null);
    view = await sendCurrent(f, session, view, {text});
    const context = (await f.request(session, `/api/intakes/${view.id}/context`)).data.context;
    const field = context.patient.fields.describe;
    assert.equal(field.status, 'answered');
    assert.equal(field.skipped, false);
    assert.equal(field.rawText, text);
    assert.equal(field.text, text);
    assert.equal(context.answered_count, answeredBefore + 1);
    assert.ok(sourceDocuments(context).some(source => source.question_id === 'describe' && source.text === text));
    assert.equal(safetySources(context).filter(source => source.question_id === 'describe').length, 1);
  }
});

test('required and noSkip text reject empty, invisible, marker and explicit skip without changing persisted state', {skip:!databaseUrl}, async t => {
  let calls = 0;
  const gateway = {model:'synthetic-model', protocol:'relationship_agent', updateState:async () => {calls++;return update(memory);}};
  const f = await fixture(t, gateway), session = await f.browser();
  await f.store.pool.query(`INSERT INTO questions(id,kind,sort_order,enabled,subject,definition)
    VALUES ('no_skip_note','base',150,TRUE,'patient',$1)`, [{type:'text',q:'현재 관찰 내용을 알려 주세요.',sec:'관찰',noSkip:true}]);
  let view = (await f.request(session, '/api/intakes', 'POST', {})).data;
  for (const id of ['name','no_skip_note','want']) {
    assert.equal(view.question.id, id);
    assert.equal(view.question.type, 'text');
    assert.ok(view.question.required || view.question.noSkip);
    const contextBefore = (await f.request(session, `/api/intakes/${view.id}/context`)).data;
    const storedBefore = (await f.store.pool.query('SELECT revision,content FROM intakes WHERE id=$1', [view.id])).rows[0];
    const countBefore = (await f.store.pool.query('SELECT count(*)::int AS count FROM patient_state_revisions WHERE intake_id=$1', [view.id])).rows[0].count;
    const callsBefore = calls;
    for (const input of [{text:''}, {text:' \t\n '}, {text:'(건너뛰었어요)'}, {skipped:true}, ...invisibleAnswers.map(text => ({text}))]) {
      const rejected = await f.request(session, `/api/intakes/${view.id}/answers`, 'POST', {
        revision:view.revision, question_id:id, ...input,
      });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
      assert.equal(rejected.data.error.code, 'answer_required');
      assert.deepEqual((await f.request(session, `/api/intakes/${view.id}`)).data, view);
      assert.deepEqual((await f.request(session, `/api/intakes/${view.id}/context`)).data, contextBefore);
    }
    assert.equal(calls, callsBefore);
    assert.deepEqual((await f.store.pool.query('SELECT revision,content FROM intakes WHERE id=$1', [view.id])).rows[0], storedBefore);
    assert.equal((await f.store.pool.query('SELECT count(*)::int AS count FROM patient_state_revisions WHERE intake_id=$1', [view.id])).rows[0].count, countBefore);
    view = await sendCurrent(f, session, view, {text:id === 'name' ? '합성 친구' : '실제로 확인한 내용을 적었어요.'});
  }
});

test('required follow-up rejects invisible answers without persistence and preserves visible Unicode provenance', {skip:!databaseUrl}, async t => {
  let calls = 0;
  const gateway = {model:'synthetic-model', protocol:'relationship_agent', updateState:async () => {calls++;return update(memory);}};
  const f = await fixture(t, gateway), session = await f.browser();
  for (const text of ['모름', '👨‍👩‍👧‍👦', 'e\u0301', ' \u200B한글\u2060 ']) {
    let view = await intakeAtDescribe(f, session);
    view = await sendCurrent(f, session, view, {skipped:true});
    view = await sendCurrent(f, session, view, {text:'식사'});
    assert.equal(view.question.id, 'concern');
    assert.equal(view.question.follow_up, true);
    assert.equal(view.question.required, true);
    const contextBefore = (await f.request(session, `/api/intakes/${view.id}/context`)).data;
    const storedBefore = (await f.store.pool.query('SELECT revision,content FROM intakes WHERE id=$1', [view.id])).rows[0];
    const countBefore = (await f.store.pool.query('SELECT count(*)::int AS count FROM patient_state_revisions WHERE intake_id=$1', [view.id])).rows[0].count;
    const callsBefore = calls;
    for (const value of invisibleAnswers) {
      const rejected = await f.request(session, `/api/intakes/${view.id}/answers`, 'POST', {
        revision:view.revision, question_id:'concern', follow_up:true, text:value,
      });
      assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
      assert.equal(rejected.data.error.code, 'answer_required');
      assert.deepEqual((await f.request(session, `/api/intakes/${view.id}`)).data, view);
      assert.deepEqual((await f.request(session, `/api/intakes/${view.id}/context`)).data, contextBefore);
    }
    assert.equal(calls, callsBefore);
    assert.deepEqual((await f.store.pool.query('SELECT revision,content FROM intakes WHERE id=$1', [view.id])).rows[0], storedBefore);
    assert.equal((await f.store.pool.query('SELECT count(*)::int AS count FROM patient_state_revisions WHERE intake_id=$1', [view.id])).rows[0].count, countBefore);
    view = await sendCurrent(f, session, view, {text});
    assert.notEqual(view.question.id, 'concern');
    const context = (await f.request(session, `/api/intakes/${view.id}/context`)).data.context;
    const field = context.patient.fields.concern;
    assert.equal(field.status, 'answered');
    assert.equal(field.rawText, '식사');
    assert.equal(field.followUp.answer.rawText, text);
    assert.equal(field.followUp.answer.text, text);
    assert.equal(context.answered_count, contextBefore.context.answered_count);
    assert.ok(sourceDocuments(context).some(source => source.question_id === 'concern' && source.origin === 'follow_up' && source.text === text));
    assert.equal(safetySources(context).filter(source => source.question_id === 'concern').length, 1);
    const stored = (await f.store.pool.query('SELECT content,owner FROM intakes WHERE id=$1', [view.id])).rows[0];
    const state = f.store.open(stored.content, `${stored.owner}:intake:${view.id}`);
    assert.equal(state.ans.concern.followUp.answer.rawText, text);
  }
});

test('choice custom input rejects invisible required content through HTTP while valid choices and Unicode persist', {skip:!databaseUrl}, async t => {
  let calls = 0;
  const gateway = {model:'synthetic-model', protocol:'relationship_agent', updateState:async () => {calls++;return update(memory);}};
  const f = await fixture(t, gateway), session = await f.browser();
  const variants = ['one','multi'].flatMap(type => ['required','noSkip'].map(rule => ({id:`custom_${type}_${rule.toLowerCase()}`,type,rule})));
  for (const [index,{id,type,rule}] of variants.entries()) {
    await f.store.pool.query(`INSERT INTO questions(id,kind,sort_order,enabled,subject,definition) VALUES ($1,'base',$2,TRUE,'patient',$3)`,
      [id,140+index,{type,q:'추가로 알려 주실 내용인가요?',sec:'관찰',opts:['보기'],[rule]:true}]);
  }
  await f.store.pool.query(`INSERT INTO questions(id,kind,sort_order,enabled,subject,definition) VALUES ('yes_note','base',150,TRUE,'patient',$1)`,
    [{type:'one',q:'확인한 내용이 있나요?',sec:'관찰',noSkip:true,noOwn:true,opts:[['네',{input:true}],'아니요']}]);
  let view = (await f.request(session, '/api/intakes', 'POST', {})).data;
  view = await sendCurrent(f, session, view, {text:'합성 친구'});
  for (const [index,{id}] of variants.entries()) {
    assert.equal(view.question.id,id);
    const before = (await f.request(session, `/api/intakes/${view.id}/context`)).data;
    const storedBefore = (await f.store.pool.query('SELECT revision,content FROM intakes WHERE id=$1',[view.id])).rows[0];
    const callsBefore = calls;
    for (const text of invisibleAnswers) {
      const rejected = await f.request(session, `/api/intakes/${view.id}/answers`, 'POST', {
        revision:view.revision,question_id:id,text,custom:text,
      });
      assert.equal(rejected.status,400,JSON.stringify(rejected.data));
      assert.equal(rejected.data.error.code,'answer_required');
      assert.deepEqual((await f.request(session, `/api/intakes/${view.id}/context`)).data,before);
    }
    assert.equal(calls,callsBefore);
    assert.deepEqual((await f.store.pool.query('SELECT revision,content FROM intakes WHERE id=$1',[view.id])).rows[0],storedBefore);
    const text = ['👨‍👩‍👧‍👦','e\u0301',' \u200B한글\u2060 ','모름'][index];
    view = await sendCurrent(f, session, view, {text,custom:text});
    const context = (await f.request(session, `/api/intakes/${view.id}/context`)).data.context;
    assert.equal(context.patient.fields[id].custom,text);
    assert.equal(context.patient.fields[id].rawText,text);
    assert.ok(sourceDocuments(context).some(source => source.question_id===id&&source.text===text));
  }
  assert.equal(view.question.id,'yes_note');
  view = await sendCurrent(f, session, view, {selected:[0],text:'\u200B'});
  const field = (await f.request(session, `/api/intakes/${view.id}/context`)).data.context.patient.fields.yes_note;
  assert.equal(field.status,'answered');
  assert.equal(field.text,'네');
  assert.equal(field.rawText,'\u200B');
});

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
  const health=await (await fetch(f.base+'/health')).json();
  assert.match(health.source_sha256,/^[a-f0-9]{64}$/);
  assert.equal(result.data.record.provenance.source_sha256,health.source_sha256);
  assert.equal(result.data.record.provenance.model_protocol,health.model_protocol);
  assert.equal(result.data.record.provenance.runtime_model_identity_verified,false);
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
  assert.deepEqual(diagnostics.filter(entry=>entry.event==='model_attempt').map(entry=>entry.reason),
    ['http_transient','content_json','success']);
  assert.deepEqual(diagnostics.filter(entry=>entry.event==='model_retry_wait').map(entry=>entry.reason),['retry_ready']);
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

async function assertDeletedOwner(f, owner) {
  for (const table of ['intakes','records','patient_states','patient_state_revisions']) {
    assert.equal((await f.store.pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${table} WHERE owner=$1`, [owner])).rows[0].count, 0, table);
  }
}

test('incomplete-only and mixed history deletion is owner-scoped, CSRF protected, and preserves column state', {skip:!databaseUrl}, async t => {
  const f = await fixture(t, null), session = await f.browser(), other = await f.browser();
  const owner = (await f.store.browser(session.cookie.slice(15))).id;
  assert.deepEqual(session.bootstrap.incomplete_intakes, []);
  assert.equal(session.bootstrap.conversation_epoch, 0);
  const initial = (await f.request(session, '/api/intakes', 'POST', {})).data;
  let history = (await f.request(session, '/api/records')).data;
  assert.deepEqual(history.records, []);
  assert.equal(history.incomplete_intakes[0].id, initial.id);
  assert.deepEqual(Object.keys(history.incomplete_intakes[0]).sort(), ['id','title','updated_at']);
  assert.equal((await f.request(other, `/api/intakes/${initial.id}`, 'DELETE')).status, 404);
  for (const path of [`/api/intakes/${initial.id}`, '/api/conversations']) {
    assert.equal((await f.request(session, path, 'DELETE', undefined, {'x-csrf-token':'invalid'})).status, 403);
    assert.equal((await f.request(session, path, 'DELETE', undefined, {origin:'https://other.example'})).status, 403);
  }
  assert.equal((await f.request(session, `/api/intakes/${initial.id}`, 'DELETE')).status, 200);
  await assertDeletedOwner(f, owner);
  const incomplete = await f.store.createIntake(owner, createIntake(), 0);
  const completed = await f.store.createIntake(owner, createIntake(), 0);
  await f.store.saveRecord(owner, {id:123,date:new Date().toISOString()}, completed.id);
  await f.store.setColumnState(owner, 'food', {read:true,saved:true});
  const foreign = (await f.request(other, '/api/intakes', 'POST', {})).data;
  const deleted = await f.request(session, '/api/conversations', 'DELETE');
  assert.deepEqual(deleted, {status:200,data:{deleted:true,conversation_epoch:1}});
  await assertDeletedOwner(f, owner);
  for (const id of [incomplete.id, completed.id]) assert.equal((await f.request(session, `/api/intakes/${id}`)).status, 404);
  assert.equal((await f.request(other, `/api/intakes/${foreign.id}`)).status, 200);
  assert.deepEqual(await f.store.columnState(owner), {read:['food'],saved:['food']});
  history = (await f.request(session, '/api/records')).data;
  assert.deepEqual(history, {records:[],incomplete_intakes:[],conversation_epoch:1});
  const stale = await f.request(session, '/api/intakes', 'POST', {conversation_epoch:0});
  assert.equal(stale.status, 409);assert.equal(stale.data.error.code, 'CONVERSATIONS_CHANGED');
  assert.equal((await f.request(session, '/api/intakes', 'POST', {conversation_epoch:1})).status, 201);
  for (const value of [null,-1,1.2,'1']) assert.equal((await f.request(session, '/api/intakes', 'POST', {conversation_epoch:value})).status, 422);
  const missing = await fetch(f.base+'/api/intakes', {method:'POST',headers:{cookie:session.cookie,'x-csrf-token':session.csrf,'content-type':'application/json'},body:'{}'});
  assert.equal(missing.status, 422);
});

for (const action of ['answer', 'result']) {
  test(`deleting an intake while ${action} work waits rejects the late save and leaves no connected rows`, {skip:!databaseUrl}, async t => {
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const gateway = {
      updateState:async () => { entered();await blocked;return update(memory); },
      respond:async () => { entered();await blocked;return {patient_state:memory,guide,assessment:{safety:false},name_index:null}; },
    };
    const f = await fixture(t, gateway), session = await f.browser();
    const owner = (await f.store.browser(session.cookie.slice(15))).id;
    const row = await f.store.createIntake(owner, {...createIntake(),...(action==='result'?{status:'ready'}:{})}, 0);
    const pending = f.request(session, `/api/intakes/${row.id}/${action==='result'?'result':'answers'}`, 'POST', action==='result'?{revision:0}:{revision:0,question_id:'name',text:'합성 친구'});
    await started;
    let deleted;
    try { deleted = await f.request(session, action==='result'?'/api/conversations':`/api/intakes/${row.id}`, 'DELETE'); }
    finally { release(); }
    assert.equal(deleted.status, 200);
    const response = await pending;
    assert.equal(response.status, 404);assert.equal(response.data.error.code, 'NOT_FOUND');
    await assertDeletedOwner(f, owner);
    assert.equal((await f.request(session, '/api/records')).data.records.length, 0);
  });
}

test('an HTTP creation paused before persistence is rejected after whole-history deletion', {skip:!databaseUrl}, async t => {
  const f = await fixture(t, null), session = await f.browser();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const create = f.store.createIntake.bind(f.store);
  f.store.createIntake = async (...args) => { entered();await blocked;return create(...args); };
  const pending = f.request(session, '/api/intakes', 'POST', {conversation_epoch:0});
  await started;
  let deleted;
  try { deleted = await f.request(session, '/api/conversations', 'DELETE'); }
  finally { release(); }
  assert.equal(deleted.status, 200);
  const response = await pending;
  assert.equal(response.status, 409);assert.equal(response.data.error.code, 'CONVERSATIONS_CHANGED');
  const owner = (await f.store.browser(session.cookie.slice(15))).id;
  await assertDeletedOwner(f, owner);
  assert.equal((await f.request(session, '/api/intakes', 'POST', {conversation_epoch:1})).status, 201);
});

test('generation progress is owner-only, shared by duplicate requests, and contains no draft text', {skip:!databaseUrl},async t=>{
  let release,started,calls=0;
  const entered=new Promise(resolve=>started=resolve),gate=new Promise(resolve=>release=resolve);
  const detail={opening:{excerpt:'요즘',why:'설명',evidence:[]}};
  const f=await fixture(t,{model:'future-31b',respond:async(_context,_memory,{onProgress})=>{
    calls++;onProgress({stage:'speech_opening',status:'started',attempt:1});
    onProgress({stage:'speech_opening',status:'completed',attempt:1});
    onProgress({stage:'speech_write',status:'started',attempt:2});started();await gate;
    return {patient_state:memory,guide,assessment:{safety:false},name_index:null,conversation_detail:detail};
  }});
  const a=await f.browser(),b=await f.browser(),owner=(await f.store.browser(a.cookie.slice(15))).id;
  const row=await f.store.createIntake(owner,{...createIntake(),status:'ready'},0);
  const path=`/api/intakes/${row.id}`;
  const first=f.request(a,path+'/result','POST',{revision:0});await entered;
  const status=await f.request(a,path+'/progress');
  assert.equal(status.status,200);assert.equal(status.data.progress.completed.length,1);assert.equal(status.data.progress.attempt,2);
  assert.equal(JSON.stringify(status.data).includes(guide.script),false);
  assert.equal((await f.request(b,path+'/progress')).status,404);
  const duplicate=f.request(a,path+'/result','POST',{revision:0});
  release();const results=await Promise.all([first,duplicate]);
  assert.equal(calls,1);assert.ok(results.every(result=>result.status===200));
  assert.deepEqual(results[0].data.record.conversation_detail,detail);
  assert.equal((await f.request(a,path+'/progress')).data.progress.status,'complete');
});

for (const deleted of [false,true]) test(`progress cannot survive a ${deleted?'deleted intake':'failed generation'} or restore its result`, {skip:!databaseUrl},async t=>{
  let entered,release;
  const started=new Promise(resolve=>entered=resolve),blocked=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{respond:async(_context,_memory,{onProgress})=>{
    onProgress({stage:'guide_write',status:'started',attempt:1});entered();await blocked;
    if(!deleted)throw new HttpError(502,'MODEL_INVALID_RESPONSE','다시 시도해 주세요.');
    onProgress({stage:'guide_write',status:'completed',attempt:1});
    return {patient_state:memory,guide,assessment:{safety:false},name_index:null};
  }});
  const session=await f.browser(),owner=(await f.store.browser(session.cookie.slice(15))).id;
  const row=await f.store.createIntake(owner,{...createIntake(),status:'ready'},0),path=`/api/intakes/${row.id}`;
  const pending=f.request(session,path+'/result','POST',{revision:0});await started;
  try {
    const progress=await f.request(session,path+'/progress');
    assert.equal(progress.data.progress.status,'running');assert.deepEqual(progress.data.progress.completed,[]);
    if(deleted)assert.equal((await f.request(session,'/api/conversations','DELETE')).status,200);
  } finally {release();}
  assert.equal((await pending).status,deleted?404:502);
  const after=await f.request(session,path+'/progress');
  if(deleted){assert.equal(after.status,404);await assertDeletedOwner(f,owner);}
  else {assert.equal(after.data.progress.status,'idle');assert.deepEqual(after.data.progress.completed,[]);}
  assert.deepEqual((await f.request(session,'/api/records')).data.records,[]);
});
