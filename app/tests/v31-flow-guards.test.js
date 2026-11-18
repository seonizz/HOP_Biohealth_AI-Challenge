import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { activeQuestionSet } from '../src/question-bank.js';
import { backIntake, buildContext, completeSplitModelAnswer, createIntake, currentView, prepareModelAnswer } from '../src/intake.js';
import { splitQuestionRequest, validateSplitQuestion } from '../src/split-question-router.js';
import { allowedCustomFocuses, personalizationSchema, validatePersonalization } from '../src/personalized-questions.js';

// Reproduces the reported conversation: "what can you do" was asked first,
// then two model-written questions repeated it, then "what did you already do".
const json = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const goal = '요즘 연락이 뜸해진 친구를 어떻게 도울지 정하고 싶어요.';
const scene = '고등학교 친구가 회사를 그만둔 뒤로 모임에 나오지 않고 있어요.';
const intake = (questionSet = activeQuestionSet) => ({...createIntake(questionSet), resultModelProfileId:'gpu31b'});
const submit = (state, input) => {
  const question = currentView(state).question;
  const answer = typeof input === 'string' ? (question.type === 'text' ? {text:input} : {custom:input}) : input;
  return prepareModelAnswer(state, {question_id:question.id, instance_id:question.instance_id,
    follow_up:Boolean(question.follow_up), ...answer}, state.v3.input_revision);
};
const route = (pending, wire) => validateSplitQuestion(wire, buildContext(pending));
const existing = (question_id, quote) => ({action:'existing', question_id, source_id:'s1', quote, why:'도울 방법을 고르는 데 필요해요.'});
const ids = pending => splitQuestionRequest(buildContext(pending)).data.candidates.map(row => row.id);
// purpose -> situation -> the given registered question is shown and answered
function afterShown(questionId, answer, questionSet) {
  let pending = submit(intake(questionSet), goal);
  let state = completeSplitModelAnswer(pending, route(pending, existing('q3_03', '친구를 어떻게 도울지')));
  pending = submit(state, scene);
  state = completeSplitModelAnswer(pending, route(pending, existing(questionId, '모임에 나오지 않고')));
  assert.equal(currentView(state).question.id, questionId);
  return submit(state, answer);
}
const support = {selected:[1]}; // 연락할 수 있어요

test('after the future-capacity question is shown, earlier questions are no longer offered or accepted', () => {
  const pending = afterShown('q3_08', support);
  assert.deepEqual(ids(pending), ['q3_09']);
  for (const id of ['q3_02','q3_04','q3_05','q3_06','q3_07']) {
    assert.equal(buildContext(pending).question_candidates.some(row => row.id === id), false, id);
    assert.throws(() => route(pending, existing(id, '연락할 수 있어요')), {code:'MODEL_INVALID_RESPONSE'});
  }
  assert.equal(buildContext(pending).supporter.fields.q3_05.status, 'not_asked');
  assert.equal(pending.ans.q3_05, undefined);
});

test('past action can be asked first and future capacity still follows it', () => {
  const pending = afterShown('q3_05', {selected:[0]});
  assert.deepEqual(ids(pending), ['q3_06','q3_07','q3_08','q3_09']);
  const state = completeSplitModelAnswer(pending, route(pending, existing('q3_08', '아직 아무것도 하지 않았어요')));
  assert.equal(currentView(state).question.q, '앞으로 본인이 할 수 있는 일과 가능한 시간은 어느 정도인가요?');
  assert.deepEqual(Object.keys(state.v3.issued), ['q3_01','q3_03','q3_05','q3_08']);
});

test('a model-written question cannot re-ask the topic of a shown question or ask for anything else in general', () => {
  const pending = afterShown('q3_08', support), context = buildContext(pending);
  const request = splitQuestionRequest(context);
  assert.equal(allowedCustomFocuses(context).includes('support'), false);
  assert.equal(JSON.stringify(request.schema).includes('"support"'), false);
  const custom = (question, focus) => ({action:'custom', subject:'supporter', focus, question,
    source_id:'s1', quote:'연락할 수 있어요', why:'문장에 넣을 내용을 확인해요.'});
  assert.throws(() => route(pending, custom('가능한 시간을 넣을 수 있나요?', 'support')), {code:'MODEL_INVALID_RESPONSE'});
  for (const question of ['지금 안내에 반영하고 싶은 내용이 더 있다면 자유롭게 들려주실 수 있나요?',
    '그 밖에 알려 주실 내용이 있나요?', '덧붙이고 싶은 이야기가 있나요?']) {
    assert.throws(() => route(pending, custom(question, 'change')), {code:'MODEL_INVALID_RESPONSE'});
  }
  // A specific question on a topic no shown question owns is still allowed.
  const allowed = route(pending, custom('친구가 회사를 그만둔 뒤로 달라진 점이 있나요?', 'change'));
  assert.equal(allowed.decision.kind, 'follow_up');
});

test('the combined model path applies the same limits to follow-up questions', () => {
  const pending = afterShown('q3_08', support), context = buildContext(pending);
  const follow = (question, focus) => ({kind:'follow_up', question_id:null, subject:'supporter', source_question_id:'q3_01',
    source_revision:context.supporter.fields.q3_01.source_revision, component:'custom', quote:'친구를 어떻게 도울지',
    quote_start:Array.from(goal.slice(0, goal.indexOf('친구를 어떻게 도울지'))).length,
    quote_end:Array.from(goal.slice(0, goal.indexOf('친구를 어떻게 도울지'))).length + Array.from('친구를 어떻게 도울지').length,
    question, focus, reason:'결과에 넣을 내용을 확인해요.'});
  assert.throws(() => validatePersonalization(follow('언제 연락할 수 있나요?', 'support'), context), {modelReason:'agent_personalization_registered_scope'});
  assert.throws(() => validatePersonalization(follow('더 반영하고 싶은 내용이 있으면 자유롭게 적어 주시겠어요?', 'change'), context),
    {modelReason:'agent_personalization_unspecific'});
  assert.equal(validatePersonalization(follow('친구가 그만둔 뒤로 달라진 점이 있나요?', 'change'), context).focus, 'change');
  assert.equal(JSON.stringify(personalizationSchema(context)).includes('"support"'), false);
});

test('correcting the purpose lets earlier questions be planned again', () => {
  const shown = afterShown('q3_08', support);
  const state = completeSplitModelAnswer(shown, route(shown, {action:'finish'}));
  let edit = backIntake(state);
  while (currentView(edit).question.id !== 'q3_01') edit = backIntake(edit);
  const corrected = submit(edit, '친구에게 이미 한 말을 포함해 상황을 정리하고 싶어요.');
  const candidates = buildContext(corrected).question_candidates.map(row => row.id);
  assert.ok(candidates.includes('q3_05'));
  assert.ok(candidates.includes('q3_04'));
  assert.equal(candidates.includes('q3_08'), false);
});

test('a stored 3.0 conversation keeps free question choice and its follow-up topics', () => {
  const snapshot = structuredClone(activeQuestionSet);
  snapshot.bundle_id = 'malssi-intake-3.0.0-rc1';
  snapshot.bundle = {questions:json('../seeds/questionnaire-v3/questions.json'), tasks:json('../seeds/questionnaire-v3/tasks.json'),
    policy:json('../seeds/questionnaire-v3/policy.json'), semantics:json('../seeds/questionnaire-v3/codebook.json')};
  snapshot.questions = json('../seeds/questions-v3.0.json').map(row => ({id:row.id, subject:row.subject, ...structuredClone(row.definition)}));
  const pending = afterShown('q3_08', support, snapshot), context = buildContext(pending);
  assert.ok(ids(pending).includes('q3_05'));
  assert.ok(allowedCustomFocuses(context).includes('support'));
  assert.equal(route(pending, existing('q3_05', '연락할 수 있어요')).action, 'existing');
});
