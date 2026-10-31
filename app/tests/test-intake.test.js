import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntake, createTestIntake, answerIntake, buildContext, currentView } from '../src/intake.js';
import { initialQuestionSet, initialQuestionRows, createQuestionSet } from '../src/question-bank.js';
import { sourceDocuments } from '../src/relationship-retrieval.js';

const fails = (answers, code) => assert.throws(() => createTestIntake(answers), error => error.code === code);

test('sparse test input preserves raw text and leaves missing required questions unasked', () => {
  const text = ' \u200B합성 입력의 줄바꿈\n둘째 줄 👨‍👩‍👧‍👦 ';
  const input = [{question_id:'concern', text}];
  const original = structuredClone(input);
  const state = createTestIntake(input), context = buildContext(state);
  assert.deepEqual(input, original);
  assert.equal(state.status, 'ready');
  assert.equal(currentView(state).question, null);
  assert.equal(state.fuCount, 0);
  assert.equal(state.pendingFollow, null);
  assert.equal(state.agentMemory, undefined);
  assert.deepEqual(state.modelSkipped, {});
  assert.deepEqual(state.history, []);
  assert.deepEqual(Object.keys(state.ans), ['concern']);
  assert.equal(state.ans.concern.rawText, text);
  assert.equal(context.patient.fields.concern.rawText, text);
  assert.equal(context.patient.fields.concern.status, 'answered');
  assert.equal(context.user_goal.message.status, 'not_asked');
  assert.equal(context.patient.fields.rel.status, 'not_asked');
  assert.equal(context.supporter.fields.feeling.status, 'not_asked');
  assert.equal(context.answered_count, 1);
  assert.equal(context.payload.answers.length, 1);
  assert.deepEqual(state.log.filter(row => row.who === 'me').map(row => row.text), [text]);
  assert.ok(sourceDocuments(context).every(source => source.question_id === 'concern'));
});

test('test inputs use question order and retain selected options, custom input and detail text', () => {
  const rows = structuredClone(initialQuestionRows);
  rows.find(row => row.id === 'concern').definition.q = '{name}에게 전할 말은 무엇인가요?';
  const questionSet = createQuestionSet(rows);
  const detail = '  합성 세부 입력\n둘째 줄  ', custom = '  합성 직접 관찰  ';
  const inputs = [
    {question_id:'support', selected:[0], text:detail},
    {question_id:'concern', text:'짧음'},
    {question_id:'mood', selected:[0], custom},
    {question_id:'name', text:'테스트별칭'},
    {question_id:'rel', selected:[4]},
  ];
  const state = createTestIntake(inputs, questionSet), context = buildContext(state);
  assert.deepEqual(Object.keys(state.ans), ['name','rel','mood','concern','support']);
  assert.equal(state.name, '테스트별칭');
  assert.ok(state.log.some(row => row.who === 'ai' && row.text === '테스트별칭에게 전할 말은 무엇인가요?'));
  assert.equal(context.patient.fields.rel.text, '친구');
  assert.equal(context.patient.fields.mood.custom, custom);
  assert.equal(state.extraObs, custom);
  assert.equal(context.patient.fields.support.rawText, detail);
  assert.equal(context.patient.fields.support.text, `네, ${detail}`);
  assert.equal(context.patient.fields.concern.followUp, undefined);
  assert.equal(state.pendingFollow, null);
  assert.equal(state.fuCount, 0);
  assert.equal(state.questionSet.version, questionSet.version);
  state.questionSet.questions[0].q = 'local mutation';
  assert.notEqual(questionSet.questions[0].q, 'local mutation');
});

test('explicit test skips remain absent from factual evidence without marking omitted answers skipped', () => {
  const state = createTestIntake([{question_id:'describe', skipped:true, text:'(건너뛰었어요)'}]);
  const context = buildContext(state);
  assert.equal(context.patient.fields.describe.status, 'skipped');
  assert.equal(context.patient.fields.describe.rawText, '(건너뛰었어요)');
  assert.equal(context.patient.fields.concern.status, 'not_asked');
  assert.equal(context.answered_count, 0);
  assert.equal(sourceDocuments(context).length, 0);
  fails([{question_id:'describe', skipped:true, text:'실제로 제공한 합성 답변'}], 'invalid_test_answer');
  fails([{question_id:'want', skipped:true}], 'answer_required');
});

test('test answers reject empty, duplicate, unknown and malformed entries', () => {
  for (const answers of [null, {}, [], Array(initialQuestionSet.questions.length + 1).fill({question_id:'name',text:'합성'})]) {
    fails(answers, 'invalid_test_answers');
  }
  fails([{question_id:'name',text:'하나'},{question_id:'name',text:'둘'}], 'duplicate_test_answer');
  for (const input of [null, [], {}, {question_id:'gap_obs',text:'합성'}, {question_id:'__proto__',text:'합성'},
    {question_id:'name',text:'합성',follow_up:true}, {question_id:'name',text:'합성',unexpected:true},
    {question_id:'name',text:3}, {question_id:'name',text:null}, {question_id:'name',custom:null},
    {question_id:'name',selected:null}, {question_id:'name',skipped:null}, {question_id:'name',skipped:'true'}]) {
    fails([input], 'invalid_test_answer');
  }
  fails([{question_id:'name',text:'x'.repeat(10001)}], 'answer_too_long');
});

test('test choices use the normal single, multi, exclusive, required and custom constraints', () => {
  for (const selected of [[-1], [999], [0,0], [0,1], ['0']]) {
    fails([{question_id:'rel',selected}], 'invalid_selection');
  }
  fails([{question_id:'mood',selected:[0,21]}], 'exclusive_selection');
  fails([{question_id:'cause',selected:[],custom:'직접 입력'}], 'custom_not_allowed');
  fails([{question_id:'rel',selected:[4],custom:'합성 직접 입력'}], 'invalid_answer');
  fails([{question_id:'concern',text:''}], 'answer_required');
  fails([{question_id:'name',selected:[0]}], 'invalid_answer');
  fails([{question_id:'rel',selected:[4],text:'이 텍스트를 유실하면 안 됩니다.'}], 'invalid_test_answer');
  fails([{question_id:'mood',selected:[0],text:'유실되는 텍스트'}], 'invalid_test_answer');
  fails([{question_id:'support',selected:[1],text:'유실되는 텍스트'}], 'invalid_test_answer');
  const state = createTestIntake([{question_id:'rel',custom:'합성 별도 관계'}]);
  assert.equal(buildContext(state).patient.fields.rel.rawText, '합성 별도 관계');
});

test('conditional supplied test answers remain explicit while normal interviews retain their flow', () => {
  const state = createTestIntake([{question_id:'dur',selected:[0]}]);
  assert.equal(buildContext(state).patient.fields.dur.status, 'answered');
  assert.equal(buildContext(state).patient.fields.mood.status, 'not_asked');
  const initial = createIntake();
  assert.equal(currentView(initial).question.id, 'name');
  assert.equal(initial.status, 'active');
  const next = answerIntake(initial, {question_id:'name',text:'합성별칭'});
  assert.equal(currentView(next).question.id, 'want');
  assert.equal(next.status, 'active');
  assert.deepEqual(initial.ans, {});
});
