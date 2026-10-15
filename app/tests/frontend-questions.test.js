import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { Store } from '../src/store.js';
import { initialQuestionRows, initialQuestionSet, createQuestionSet } from '../src/question-bank.js';
import { renderQuestion } from '../src/catalog.js';
import { createIntake, currentView, answerIntake, backIntake, buildContext,
  prepareModelAnswer, completeModelAnswer, discardModelAnswer } from '../src/intake.js';

const migration = readFileSync(new URL('../migrations/004_frontend_questions.sql', import.meta.url), 'utf8');
const updates = JSON.parse(migration.split('$frontend_defaults$')[1]);
function latestRows() {
  return structuredClone(initialQuestionRows).map(row => {
    if (row.id === 'name') {
      row.definition.required = true;
      delete row.definition.follow_up;
    }
    const update = updates.find(update => update.id === row.id);
    if (update) row.definition = structuredClone(update.after);
    if (row.id === 'coping') row.enabled = false;
    return row;
  });
}
const latestSet = createQuestionSet(latestRows());
const output = { patient_state:{summary:'입력한 상황',facts:[],unknowns:[],user_goal:'확인되지 않음'}, name_index:null, question_plan:{skip:[]} };
function reply(state, input = {}) {
  const question = currentView(state).question;
  return answerIntake(state, { question_id:question.id, follow_up:Boolean(question.follow_up), ...input });
}
function advanceTo(id, set = latestSet) {
  let state = createIntake(set);
  for (let step = 0; step < 70 && state.status === 'active'; step++) {
    const question = currentView(state).question;
    if (question.id === id && !question.follow_up) return state;
    state = reply(state, question.type === 'text' ? {text:'입력한 상황을 충분히 자세히 설명합니다.'} : {selected:[0]});
  }
  throw new Error(`Question ${id} not reached`);
}

test('latest default catalog merges coping into help while preserving legacy question snapshots', () => {
  assert.equal(latestSet.questions.length, 29);
  assert.equal(latestSet.questions.some(q => q.id === 'coping'), false);
  const legacy = createIntake(initialQuestionSet);
  assert.equal(legacy.questionSet.questions.length, 30);
  assert.equal(legacy.questionSet.questions.some(q => q.id === 'coping'), true);
  const help = currentView(advanceTo('help')).question;
  assert.equal(help.ownPh, '예: 술을 마시거나, 친구를 만나 이야기해요');
  assert.match(help.q, /어려움을 견디거나 해결하려고 어떤 방법/);
  const answered = reply(advanceTo('help'), { selected:[6], custom:'강아지와 산책을 해요.' });
  const field = buildContext(answered).patient.fields.help;
  assert.equal(field.custom, '강아지와 산책을 해요.');
  assert.equal(field.freeText, true);
  assert.equal(field.text, '가족·친구의 도움, 강아지와 산책을 해요.');
  assert.equal(buildContext(answered).patient.fields.coping, undefined);
  assert.equal(currentView(advanceTo('moment')).question.q, '요즘 당신이 가장 마음 쓰였거나 힘들었던 순간은 언제였나요?');
  const extra = currentView(advanceTo('extra')).question;
  assert.match(extra.q, /추가적으로 걱정되는 부분/);
  assert.equal(extra.ph, '예: 요즘 술 마시는 날이 부쩍 늘어서 걱정돼요');
});

test('dynamic answer examples follow selected event metadata, ordering and removal with a fallback', () => {
  const source = latestSet.questions.find(q => q.id === 'events');
  const question = latestSet.questions.find(q => q.id === 'others_why');
  const state = {questionSet:latestSet,name:'지수',tags:[],ans:{events:{sel:[3,0]}}};
  assert.equal(renderQuestion(question, state).ph, '예: 헤어지고 나서 많이 무너졌다고들 해요');
  assert.equal(renderQuestion(question, {...state,ans:{events:{sel:[1]}}}).ph, '예: 할머니가 돌아가신 뒤로 기운이 없다고들 해요');
  assert.equal(renderQuestion(question, {...state,ans:{events:{sel:[8]}}}).ph, question.ph);
  assert.equal(renderQuestion(question, {...state,ans:{}}).ph, question.ph);
  const rows = latestRows(); rows.find(q => q.id === 'events').definition.opts.reverse();
  const reordered = createQuestionSet(rows);
  assert.equal(renderQuestion(question, {...state,questionSet:reordered,ans:{events:{sel:[source.opts.length - 1]}}}).ph,
    '예: 헤어지고 나서 많이 무너졌다고들 해요');
  rows.find(q => q.id === 'events').enabled = false;
  assert.equal(renderQuestion(question, {...state,questionSet:createQuestionSet(rows)}).ph, question.ph);
  assert.equal(renderQuestion(question, state).ph_by_option, undefined);
});

test('display follow-up styling on events does not change the answer protocol', () => {
  const state = advanceTo('events');
  const question = currentView(state).question;
  assert.equal(question.fu, true);
  assert.equal(question.follow_up, undefined);
  assert.equal(currentView(state).pendingFollow, false);
  assert.equal(state.log.at(-1).fu, true);
  assert.equal(question.q, `어떤 일이 있었나요?\n최근 1년 사이 ${state.name}에게 있었던 일을 모두 골라 주세요.`);
  assert.throws(() => reply(state, { selected:[0], follow_up:true }), {code:'question_mismatch'});
  assert.equal(currentView(reply(state, {selected:[0]})).question.id, 'others_why');
});

test('optional yes detail prompts are persisted with the answer and remain stable during model retry and back', () => {
  for (const id of ['support','burden']) {
    const state = advanceTo(id);
    const question = currentView(state).question;
    const ask = question.opts[0][1].ask;
    const text = '네, 함께 산책하며 이야기해요.';
    const pending = prepareModelAnswer(state, {question_id:id,selected:[0],text}, 7);
    assert.deepEqual(pending.log.slice(state.log.length), [
      {who:'ai',text:ask,face:question.face,fu:true}, {who:'me',text,fu:false},
    ]);
    assert.equal(currentView(pending).question.id, id);
    const field = buildContext(pending).patient.fields[id];
    assert.equal(field.text, text);
    for (const key of ['ask','ph','input']) assert.equal(field.selected[0].meta[key], undefined);
    assert.deepEqual(discardModelAnswer(pending), state);
    const complete = completeModelAnswer(pending, output);
    assert.equal(complete.log.filter(message => message.text === ask).length, 1);
    assert.equal(complete.log.filter(message => message.who === 'me' && message.text === text).length, 1);
    const back = backIntake(complete);
    assert.equal(currentView(back).question.id, id);
    assert.equal(back.ans[id], undefined);
    assert.equal(back.log.some(message => message.text === ask), false);
    const skippedDetail = reply(state, {selected:[0],text:'네'});
    assert.equal(skippedDetail.ans[id].text, '네');
    assert.equal(skippedDetail.ans[id].skipped, false);
    assert.equal(skippedDetail.ans[id].followUp, undefined);
    assert.equal(skippedDetail.fuCount, state.fuCount);
  }
});

test('caregiver changes detail is optional text and its evidence stays with the supporter', () => {
  const state = advanceTo('cgchange_more');
  const question = currentView(state).question;
  assert.equal(question.type, 'text');
  assert.equal(question.noSkip, undefined);
  assert.equal(question.required, undefined);
  assert.equal(question.opts, undefined);
  const next = reply(state, {text:'최근 제 수면도 부족해졌어요.'});
  assert.equal(buildContext(next).supporter.fields.cgchange_more.text, '최근 제 수면도 부족해졌어요.');
  assert.equal(buildContext(next).patient.fields.cgchange_more, undefined);
  assert.equal(currentView(reply(state, {skipped:true})).question.id, 'mycoping');
});

test('customized option detail prompts and examples use the snapshot name without changing source metadata', () => {
  const rows = latestRows();
  const source = rows.find(q => q.id === 'support').definition.opts[0][1];
  source.ask = '{name}에게 어떤 활동이 도움이 되나요?';
  source.ph = '예: {name:와} 함께 산책해요';
  const state = advanceTo('support', createQuestionSet(rows));
  state.name = '지수';
  const question = currentView(state).question;
  assert.equal(question.opts[0][1].ask, '지수에게 어떤 활동이 도움이 되나요?');
  assert.equal(question.opts[0][1].ph, '예: 지수와 함께 산책해요');
  const answered = reply(state, {selected:[0],text:'네, 산책'});
  assert.equal(answered.log.at(-3).text, question.opts[0][1].ask);
  assert.equal(source.ask, '{name}에게 어떤 활동이 도움이 되나요?');
  assert.equal(state.questionSet.questions.find(q => q.id === 'support').opts[0][1].ask, source.ask);
});

test('encouragement uses the configured question count and fires across conditional jumps', () => {
  const rows = Array.from({length:12}, (_, i) => ({id:`question_${i}`,kind:'base',sort_order:i,enabled:true,subject:'patient',
    definition:{type:'text',q:`질문 ${i}`, ...(i >= 3 && i <= 4 ? {when:{custom:'question_0'}} : {})}}));
  let state = createIntake(createQuestionSet(rows));
  const cheers = [];
  while (state.status === 'active') {
    const previous = state.log.length;
    state = reply(state, {text:'자세한 답변'});
    const cheer = state.log.slice(previous).find(message => message.face === 'cheer');
    if (cheer) {
      cheers.push(state.i);
      assert.equal(backIntake(state).log.some(message => message.text === cheer.text), false);
    }
  }
  assert.deepEqual(cheers, [5,8]);
});

const databaseUrl = process.env.TEST_DATABASE_URL;
async function fixture(t) {
  const schema = `test_frontend_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});
  const f = {schema,admin,key:randomBytes(32),store:null};
  t.after(async () => {
    await f.store?.close();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await admin.end(); }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  f.store = await Store.connect(databaseUrl, f.key, 30, {schema});
  return f;
}
async function restorePreviousDefaults(f) {
  await f.store.pool.query("DELETE FROM schema_migrations WHERE version='004_frontend_questions.sql'");
  for (const row of initialQuestionRows.filter(row => updates.some(update => update.id === row.id) || row.id === 'coping')) {
    await f.store.pool.query('UPDATE questions SET definition=$1::jsonb,enabled=$2 WHERE id=$3', [JSON.stringify(row.definition),row.enabled,row.id]);
  }
}
async function restart(f) {
  await f.store.close(); f.store = null;
  f.store = await Store.connect(databaseUrl, f.key, 30, {schema:f.schema});
}

test('frontend migration upgrades defaults while encrypted legacy intake snapshots stay unchanged', {skip:!databaseUrl}, async t => {
  const f = await fixture(t);
  assert.equal((await f.store.questionSet()).questions.length, 29);
  await restorePreviousDefaults(f);
  const browser = await f.store.createBrowser();
  const old = await f.store.createIntake(browser.id, createIntake(await f.store.questionSet()));
  const context = await f.store.context(browser.id, old.id);
  const encrypted = async () => (await f.store.pool.query(`SELECT content FROM intakes WHERE id=$1
    UNION ALL SELECT content FROM patient_states WHERE intake_id=$1
    UNION ALL SELECT content FROM patient_state_revisions WHERE intake_id=$1`, [old.id])).rows;
  const before = await encrypted();
  await restart(f);
  const latest = await f.store.questionSet();
  assert.equal(latest.questions.length, 29);
  for (const update of updates) assert.deepEqual(latest.questions.find(q => q.id === update.id), {id:update.id,subject:update.subject,...update.after});
  assert.equal((await f.store.pool.query("SELECT enabled FROM questions WHERE id='coping'")).rows[0].enabled, false);
  assert.deepEqual((await f.store.intake(browser.id, old.id)).state, old.state);
  assert.deepEqual(await f.store.context(browser.id, old.id), context);
  assert.deepEqual(await encrypted(), before);
  assert.equal(old.state.questionSet.questions.length, 30);
});

test('frontend migration preserves customized definitions and settings and retains coping with custom help', {skip:!databaseUrl}, async t => {
  const f = await fixture(t);
  await restorePreviousDefaults(f);
  await f.store.pool.query("UPDATE questions SET definition=jsonb_set(definition,'{q}',to_jsonb('관리자 문구'::text)) WHERE id='help'");
  await f.store.pool.query("UPDATE questions SET definition=jsonb_set(definition,'{opts,0,1,ph}',to_jsonb('관리자 예시'::text)) WHERE id='support'");
  await f.store.pool.query("UPDATE questions SET sort_order=1350 WHERE id='burden'");
  await f.store.pool.query("UPDATE questions SET enabled=FALSE WHERE id='extra'");
  await f.store.pool.query("UPDATE questions SET subject='patient' WHERE id='moment'");
  const customIds = ['help','support','burden','extra','moment','coping'];
  const before = (await f.store.pool.query('SELECT * FROM questions WHERE id=ANY($1::text[]) ORDER BY id', [customIds])).rows;
  await restart(f);
  const after = (await f.store.pool.query('SELECT * FROM questions WHERE id=ANY($1::text[]) ORDER BY id', [customIds])).rows;
  assert.deepEqual(after, before);
  assert.equal((await f.store.questionSet()).questions.some(q => q.id === 'coping'), true);
  const event = (await f.store.questionSet()).questions.find(q => q.id === 'events');
  assert.equal(event.fu, true);
  // A later deliberate return to old wording is not overwritten on subsequent startup.
  await f.store.pool.query("UPDATE questions SET definition=$1::jsonb WHERE id='events'", [JSON.stringify(initialQuestionRows.find(q => q.id === 'events').definition)]);
  await restart(f);
  assert.deepEqual((await f.store.questionSet()).questions.find(q => q.id === 'events'), {id:'events',subject:'patient',...initialQuestionRows.find(q => q.id === 'events').definition});
});
