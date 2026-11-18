import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { activeQuestionRows, activeQuestionSet } from '../src/question-bank.js';
import { createIntake, currentView } from '../src/intake.js';
import { isV3Intake } from '../src/intake-v3.js';
import { isV3Context } from '../src/agent-state.js';
import { V3_BUNDLE_IDS, ACTIVE_V3_BUNDLE_ID } from '../src/v3-bundles.js';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const json = path => JSON.parse(read(path));
const v30 = json('../seeds/questionnaire-v3/questions.json');
const v31 = json('../seeds/questionnaire-v3.1/questions.json');
const rows30 = json('../seeds/questions-v3.0.json');
const CHANGED = ['Q3-03','Q3-04','Q3-05','Q3-07','Q3-08','Q3-09'];

test('v3.1 is the active bundle and keeps the 3.0 question count, ids and input shapes', () => {
  assert.equal(activeQuestionSet.bundle_id, ACTIVE_V3_BUNDLE_ID);
  assert.equal(v31.bundle_id, ACTIVE_V3_BUNDLE_ID);
  assert.deepEqual(v31.questions.map(q => q.id), v30.questions.map(q => q.id));
  assert.equal(v31.questions.length, 10);
  assert.equal(activeQuestionRows.length, 9);
  for (const [index, row] of activeQuestionRows.entries()) {
    const old = rows30[index];
    // The browser renders from these fields. Only wording may differ.
    for (const key of ['id','kind','sort_order','enabled','subject']) assert.deepEqual(row[key], old[key]);
    const {q, help, ...rest} = row.definition, {q:oldQ, help:oldHelp, ...oldRest} = old.definition;
    assert.deepEqual(rest, oldRest);
    assert.equal(q !== oldQ, CHANGED.includes(row.definition.source_id));
  }
  for (const [index, question] of v31.questions.entries()) {
    const old = v30.questions[index];
    for (const key of ['format','options','topic_scope','title','max_instances_per_intake','required_by_default']) {
      assert.deepEqual(question[key], old[key]);
    }
    assert.ok(old.collects.every(item => question.collects.includes(item)));
  }
  assert.deepEqual(v31.clarification, {...v30.clarification});
});

test('v3.1 wording separates past action from future capacity and asks one thing per sentence', () => {
  const text = id => v31.questions.find(q => q.id === id).text;
  assert.match(text('Q3-05'), /지금까지/u);
  assert.doesNotMatch(text('Q3-05'), /앞으로/u);
  assert.match(text('Q3-08'), /앞으로/u);
  assert.match(text('Q3-08'), /시간/u);
  assert.doesNotMatch(text('Q3-07'), /도움/u);
  assert.match(text('Q3-03'), /누구와/u);
  for (const question of v31.questions) {
    const marks = (question.text.match(/\?/gu) || []).length;
    assert.equal(marks, question.id === 'Q3-05' ? 2 : 1, question.id);
    assert.ok(Array.from(question.text).length <= 60, question.id);
    assert.ok(question.help.text.trim());
  }
  assert.equal(new Set(v31.questions.map(q => q.text)).size, 10);
});

test('v3.1 bundle hashes match its files and both bundle ids follow the v3 contract', () => {
  const manifest = json('../seeds/questionnaire-v3.1/bundle.json');
  for (const name of ['questions','tasks','policy','codebook']) {
    const raw = readFileSync(new URL(`../seeds/questionnaire-v3.1/${name}.json`, import.meta.url));
    const asset = manifest.assets.find(item => item.path === `active/${name}.json`);
    assert.equal(asset.bytes, raw.length);
    assert.equal(asset.sha256, createHash('sha256').update(raw).digest('hex'));
    assert.equal(JSON.parse(raw).bundle_id, ACTIVE_V3_BUNDLE_ID);
  }
  assert.deepEqual([...V3_BUNDLE_IDS], ['malssi-intake-3.0.0-rc1', ACTIVE_V3_BUNDLE_ID]);
  for (const bundle_id of V3_BUNDLE_IDS) {
    assert.equal(isV3Intake({questionSet:{bundle_id}}), true);
    assert.equal(isV3Context({bundle_id}), true);
  }
  assert.equal(isV3Intake({questionSet:{bundle_id:'malssi-intake-2.0.0'}}), false);
});

test('a stored 3.0 snapshot keeps its own wording while new intakes start on 3.1', () => {
  const fresh = createIntake(activeQuestionSet);
  assert.equal(currentView(fresh).question.id, 'q3_01');
  assert.equal(fresh.questionSet.questions.find(q => q.id === 'q3_08').q, '앞으로 본인이 할 수 있는 일과 가능한 시간은 어느 정도인가요?');
  const snapshot = structuredClone(activeQuestionSet);
  snapshot.bundle_id = 'malssi-intake-3.0.0-rc1';
  snapshot.questions = rows30.map(row => ({id:row.id, subject:row.subject, ...structuredClone(row.definition)}));
  const old = createIntake(snapshot);
  assert.equal(isV3Intake(old), true);
  assert.equal(currentView(old).question.id, 'q3_01');
  assert.equal(old.questionSet.questions.find(q => q.id === 'q3_08').q,
    '이번 상황에서 본인이 할 수 있는 도움의 방법과 범위는 어느 정도인가요?');
});

test('tasks keep every 3.0 requirement and the documented priority starts with purpose then situation', () => {
  const tasks30 = json('../seeds/questionnaire-v3/tasks.json').tasks, tasks31 = json('../seeds/questionnaire-v3.1/tasks.json').tasks;
  assert.deepEqual(tasks31.map(task => task.id), tasks30.map(task => task.id));
  for (const [index, task] of tasks31.entries()) {
    assert.deepEqual(task.required_facts, tasks30[index].required_facts);
    assert.deepEqual([...task.allowed_question_ids].sort(), [...tasks30[index].allowed_question_ids].sort());
  }
  assert.deepEqual(v31.default_priority.slice(0, 3), ['Q3-01','Q3-03','Q3-02']);
  assert.deepEqual(json('../seeds/questionnaire-v3.1/policy.json').question_progression.base_order, v31.default_priority);
});
