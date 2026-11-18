import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import vm from 'node:vm';
import pg from 'pg';
import { activeQuestionRows, activeQuestionSet, initialQuestionSet, createQuestionSet } from '../src/question-bank.js';
import { createIntake, currentView, buildContext } from '../src/intake.js';
import { Store } from '../src/store.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

test('v3 native adapter retains each source question, option and registered help exactly', () => {
  const source = JSON.parse(read('../seeds/questionnaire-v3.1/questions.json'));
  assert.equal(activeQuestionSet.bundle_id, source.bundle_id);
  assert.equal(activeQuestionSet.questions.length, 9);
  assert.equal(activeQuestionSet.gapQuestion, null);
  for (const [index, question] of activeQuestionSet.questions.entries()) {
    const original = source.questions[index];
    assert.equal(question.source_id, original.id);
    assert.equal(question.q, original.text);
    assert.equal(question.help, original.help.text);
    assert.deepEqual((question.opts || []).map(([label, meta]) => ({ label, value:meta.value })),
      original.options.map(({label,value})=>({label,value})));
    assert.ok(!question.required && !question.noSkip && !question.follow_up);
  }
  assert.equal(initialQuestionSet.questions[0].id, 'name');
  assert.equal(currentView(createIntake(activeQuestionSet)).question.id, 'q3_01');
});

test('v3 rejects mixed, missing or edited rows and versions the whole behavior snapshot', () => {
  for (const mutate of [
    rows => rows.pop(),
    rows => { rows[0].definition.q += ' 변경'; },
    rows => { rows[1].enabled = false; },
    rows => { rows[2].subject = 'supporter'; },
    rows => rows.push({ id:'extra_legacy',kind:'base',sort_order:1000,enabled:true,subject:'supporter',definition:{type:'text',q:'다른 질문'} }),
  ]) {
    const rows = structuredClone(activeQuestionRows); mutate(rows);
    assert.throws(() => createQuestionSet(rows), {code:'QUESTION_BANK_INVALID'});
  }
  const state = createIntake(activeQuestionSet);
  const original = state.questionSet.bundle.policy.limits.minimum_answer_count;
  state.questionSet.bundle.policy.limits.minimum_answer_count = 2;
  assert.equal(activeQuestionSet.bundle.policy.limits.minimum_answer_count, original);
});

test('v3 migration embeds the exact adapted seed and archives previous administrative rows', () => {
  const sql = read('../migrations/015_questionnaire_v3_1.sql');
  assert.deepEqual(JSON.parse(sql.match(/\$v31\$([\s\S]+?)\$v31\$/)[1]), activeQuestionRows);
  // The 3.0 migration stays byte-for-byte tied to the preserved 3.0 rows.
  assert.deepEqual(JSON.parse(read('../migrations/010_questionnaire_v3.sql').match(/\$v3\$([\s\S]+?)\$v3\$/)[1]),
    JSON.parse(read('../seeds/questions-v3.0.json')));
  assert.match(sql, /INSERT INTO question_bank_archive/);
  assert.doesNotMatch(sql, /DELETE FROM (?:intakes|records)|UPDATE (?:intakes|records)/i);
});

test('current browser test example uses the v3 bank and preserves selection plus text', () => {
  const input = vm.runInNewContext(read('../public/js/test-input.js')+';TestInput', {TextEncoder});
  const example = input.parse(input.example(activeQuestionSet.questions), activeQuestionSet.questions)[0];
  assert.ok(example.answers.every(answer=>answer.question_id.startsWith('q3_')));
  assert.ok(example.answers.find(answer=>answer.question_id==='q3_01').custom);
});

const databaseUrl = process.env.TEST_DATABASE_URL;
test('v3 DB migration updates only the new default, preserves encrypted old conversations and restarts idempotently', {skip:!databaseUrl}, async t => {
  const schema = `test_v3_${randomUUID().replaceAll('-','')}`;
  const admin = new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});
  const key = randomBytes(32);
  let store;
  t.after(async()=>{
    await store?.close();
    try {await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);} finally {await admin.end();}
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  store = await Store.connect(databaseUrl,key,30,{schema});
  assert.equal((await store.questionSet()).bundle_id,activeQuestionSet.bundle_id);
  // Reconstruct the prior deployment inside this disposable test schema.
  await store.pool.query("UPDATE questions SET enabled=NOT (id LIKE 'q3_%')");
  await store.pool.query("UPDATE questions SET definition=jsonb_set(definition,'{q}',to_jsonb('보관할 관리자 질문'::text)) WHERE id='name'");
  await store.pool.query("DELETE FROM schema_migrations WHERE version IN ('010_questionnaire_v3.sql','015_questionnaire_v3_1.sql')");
  await store.pool.query('DELETE FROM question_bank_archive');
  const browser = await store.createBrowser();
  const old = await store.createIntake(browser.id,createIntake(initialQuestionSet));
  const oldContext = buildContext(old.state);
  const saved = (await store.pool.query('SELECT content FROM intakes WHERE id=$1',[old.id])).rows[0].content;
  await store.close();store = await Store.connect(databaseUrl,key,30,{schema});
  assert.deepEqual((await store.questionSet()).questions.map(q=>q.id),activeQuestionSet.questions.map(q=>q.id));
  assert.equal((await store.pool.query('SELECT content FROM intakes WHERE id=$1',[old.id])).rows[0].content,saved);
  assert.deepEqual((await store.context(browser.id,old.id)).context,oldContext);
  const archived = (await store.pool.query("SELECT rows FROM question_bank_archive WHERE bundle_id='before-malssi-intake-3.0.0-rc1'")).rows[0].rows;
  // 3.1 archives the 3.0 administrative rows under its own key before replacing the wording.
  const archived30 = (await store.pool.query("SELECT rows FROM question_bank_archive WHERE bundle_id='before-malssi-intake-3.1.0-rc1'")).rows[0].rows;
  assert.equal(archived30.find(q=>q.id==='q3_08').definition.q,'이번 상황에서 본인이 할 수 있는 도움의 방법과 범위는 어느 정도인가요?');
  assert.equal(archived.find(q=>q.id==='name').definition.q,'보관할 관리자 질문');
  const current = await store.createIntake(browser.id,createIntake(await store.questionSet()));
  assert.equal(current.state.questionSet.bundle.policy.limits.collection_instances_per_intake,10);
  await store.close();store = await Store.connect(databaseUrl,key,30,{schema});
  assert.deepEqual((await store.intake(browser.id,current.id)).state,current.state);
  assert.equal((await store.pool.query('SELECT count(*)::int n FROM question_bank_archive')).rows[0].n,2);
});
