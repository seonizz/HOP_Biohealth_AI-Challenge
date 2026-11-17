import test from 'node:test';
import assert from 'node:assert/strict';
import { activeQuestionSet } from '../src/question-bank.js';
import { createIntake, currentView, answerIntake, prepareModelAnswer, completeModelAnswer,
  buildContext, backIntake, discardModelAnswer } from '../src/intake.js';
import { continuationCardContext, continuationInput } from '../src/continuation-model.js';

// Preserve the pre-compact v3 snapshot contract; new compact intakes have dedicated tests.
const start = () => { const state=createIntake(activeQuestionSet); delete state.v3.compact_flow; return state; };
const input = (state, text='친구가 내일 만나서 이야기하자고 했어요.') => {
  const question = currentView(state).question;
  return {question_id:question.id, follow_up:Boolean(question.follow_up), instance_id:question.instance_id,
    ...(question.type === 'text' ? {text} : {custom:text})};
};
const prepare = (state, text) => prepareModelAnswer(state, input(state, text), state.v3.input_revision);
const model = personalization => ({name_index:null, patient_state:{}, question_plan:{skip:[]}, personalization});
const done = (pending, personalization=null) => completeModelAnswer(pending, model(personalization));
function decision(pending, extra={}) {
  const context = buildContext(pending);
  const field = context.supporter.fields.q3_01;
  return {kind:'follow_up', question_id:null, subject:'patient', source_question_id:field.id,
    source_revision:field.source_revision, component:'rawText', quote:field.rawText,
    quote_start:0, quote_end:Array.from(field.rawText).length,
    question:'친구가 만나서 나누고 싶다고 말한 주제가 있나요?', focus:'goal', reason:'원한 대화의 범위를 확인해요.', ...extra};
}

test('new intakes enable bounded personalization; historical snapshots keep the legacy budget', () => {
  const state = start();
  assert.equal(currentView(state).maxQuestions, 12);
  assert.equal(buildContext(state).personalization.remaining_follow_ups, 2);
  delete state.v3.personalization;
  assert.equal(currentView(state).maxQuestions, 10);
  assert.equal(buildContext(state).personalization, undefined);
  const pending = prepare(state);
  assert.throws(() => done(pending, decision(pending)), {code:'MODEL_INVALID_RESPONSE'});
});

test('next adapts order and literal context while preserving canonical questions/options and progress', () => {
  const pending = prepare(start(), '🙂 친구가 {name}라는 표현을 썼어요.');
  const choice = decision(pending, {kind:'next', question_id:'q3_09', subject:'supporter', question:null, focus:null});
  const state = done(pending, choice), view = currentView(state);
  assert.equal(view.question.id, 'q3_09');
  assert.match(view.question.q, /🙂 친구가 \{name\}라는 표현/);
  assert.ok(view.question.q.endsWith(activeQuestionSet.questions[8].q));
  assert.deepEqual(view.question.opts, activeQuestionSet.questions[8].opts);
  assert.deepEqual(state.questionSet, activeQuestionSet);
  assert.deepEqual(Object.keys(state.v3.issued), ['q3_01','q3_09']);
  const next = done(prepare(state, '도움의 범위를 정하고 싶어요.'));
  assert.equal(currentView(next).question.id, 'q3_02');
  assert.ok(currentView(next).progress >= view.progress);
  assert.equal(backIntake(next).v3.editingQuestion, 'q3_09');
  assert.equal(backIntake(backIntake(next)).v3.editingQuestion, 'q3_01');
  const stored = buildContext(next).supporter.fields.q3_09;
  assert.equal(stored.question, view.question.q);
  assert.equal(stored.asked_question, view.question.q);
  assert.equal(stored.canonical_question, activeQuestionSet.questions[8].q);
});

test('a generated follow-up is not evidence until answered and its exact wording survives storage round trips', () => {
  const pending = prepare(start()), choice = decision(pending);
  let state = done(pending, choice);
  assert.equal(currentView(state).question.id, 'q3_personal_01');
  assert.equal(currentView(state).question.type, 'text');
  assert.equal(buildContext(state).patient.fields.q3_personal_01, undefined);
  assert.deepEqual(Object.keys(state.v3.issued), ['q3_01','q3_personal_01']);
  state = done(prepare(state, '그 친구는 이직에 관해 이야기하고 싶다고 했어요.'));
  state = JSON.parse(JSON.stringify(state));
  assert.equal(currentView(state).question.id, 'q3_02');
  const field = buildContext(state).patient.fields.q3_personal_01;
  assert.equal(field.question, choice.question);
  assert.equal(field.rawText, '그 친구는 이직에 관해 이야기하고 싶다고 했어요.');
  assert.deepEqual(field.personalization, choice);
  assert.equal(field.assignment, undefined);
  assert.equal(buildContext(state).payload.answers.find(row=>row.id==='q3_personal_01').question, choice.question);
});

test('refusal consumes a follow-up slot and two issued follow-ups exhaust the budget', () => {
  let pending = prepare(start());
  let state = done(pending, decision(pending));
  pending = prepareModelAnswer(state, {...input(state), text:'', response_event:'refused'}, 1);
  state = done(pending, decision(pending, {focus:'behavior', question:'친구가 만나기 전에 요청한 준비가 있나요?'}));
  assert.equal(currentView(state).question.id, 'q3_personal_02');
  assert.equal(buildContext(state).personalization.remaining_follow_ups, 0);
  assert.equal(buildContext(state).patient.fields.q3_personal_01.status, 'refused');
  pending = prepare(state, '준비는 따로 부탁하지 않았어요.');
  assert.throws(() => done(pending, decision(pending, {focus:'change', question:'전과 달라진 점은 무엇인가요?'})), {code:'MODEL_INVALID_RESPONSE'});
  assert.equal(buildContext(pending).payload.answers.filter(row=>row.id.startsWith('q3_personal_')).length, 1);
});

test('help replay and stop cannot issue a new personalized question', () => {
  const pending = prepare(start());
  const state = done(pending, decision(pending));
  const help = prepareModelAnswer(state, {...input(state), text:'', response_event:'not_understood'}, 1);
  assert.equal(buildContext(help).personalization.available, false);
  assert.throws(() => done(help, decision(help, {focus:'change'})), {code:'MODEL_INVALID_RESPONSE'});
  const replay = done(help);
  assert.equal(currentView(replay).question.id, 'q3_personal_01');
  assert.equal(buildContext(replay).personalization.remaining_follow_ups, 1);
  const stopped = prepareModelAnswer(state, {...input(state), text:'', response_event:'stop'}, 1);
  assert.equal(buildContext(stopped).personalization.available, false);
  assert.equal(done(stopped).status, 'ready');
});

test('discard/retry does not consume an invisible follow-up or mutate the source intake', () => {
  const source = start(), pending = prepare(source), choice = decision(pending);
  const before = JSON.stringify(pending);
  const completed = done(pending, choice);
  assert.equal(JSON.stringify(pending), before);
  assert.equal(currentView(discardModelAnswer(pending)).question.id, 'q3_01');
  assert.deepEqual(done(pending, choice), completed);
  assert.equal(buildContext(source).personalization.remaining_follow_ups, 2);
});

test('leaving an unanswered follow-up consumes it and returns to the latest answered base without issuing another prompt', () => {
  const pending = prepare(start());
  const follow = done(pending, decision(pending));
  const before = Object.keys(follow.v3.issued);
  const back = backIntake(follow);
  assert.equal(currentView(back).question.id, 'q3_01');
  assert.equal(back.v3.personalization.questions.q3_personal_01.status, 'obsolete');
  assert.equal(buildContext(back).personalization.remaining_follow_ups, 1);
  assert.deepEqual(Object.keys(back.v3.issued), before);
  assert.equal(currentView(back).canGoBack, false);
});

test('stale follow-up responses cannot be saved after their bound revision changes', () => {
  const pending = prepare(start());
  const follow = done(pending, decision(pending));
  follow.ans.q3_01.source_revision++;
  assert.throws(() => answerIntake(follow, input(follow, '이전 질문에 대한 답입니다.')), {code:'STALE_PERSONALIZED_QUESTION'});
  assert.equal(follow.clarificationAnswers, undefined);
});

test('nine base prompts, two personalized prompts and one axis clarification fit the enforced twelve-instance limit', () => {
  let pending = prepare(start());
  let state = done(pending, decision(pending));
  pending = prepare(state, '친구는 이직 이야기를 하고 싶다고 했어요.');
  state = done(pending, decision(pending, {focus:'behavior', question:'친구가 미리 준비해 달라고 한 것이 있나요?'}));
  pending = prepare(state, '없어요.');
  const source = buildContext(pending).supporter.fields.q3_01;
  state = completeModelAnswer(pending, {...model(null), clarification:{source_question_id:source.id,
    source_revision:source.source_revision, component:'rawText', event_id:'meeting', quote:source.rawText,
    quote_start:0, quote_end:Array.from(source.rawText).length, axis:'execution', role:null, agreement_item_id:null}});
  assert.equal(currentView(state).question.id, 'q3_10');
  state = done(prepareModelAnswer(state, {...input(state), custom:'', response_event:'skipped'}, 3));
  while (state.status === 'active') state = done(prepare(state));
  assert.equal(Object.keys(state.v3.issued).length, 12);
  assert.equal(currentView(state).progress, 100);
  assert.equal(state.fuCount, 3);
});

function chain() {
  let pending = prepare(start());
  let state = done(pending, decision(pending));
  pending = prepare(state, '친구가 이직 이야기를 나누고 싶다고 했어요.');
  const source = buildContext(pending).patient.fields.q3_personal_01;
  state = done(pending, decision(pending, {source_question_id:source.id, source_revision:source.source_revision,
    quote:source.rawText, quote_end:Array.from(source.rawText).length, focus:'support',
    question:'그 이야기와 관련해 친구가 요청한 도움이 있나요?'}));
  return done(prepare(state, '경험을 들어 달라고 했어요.'));
}

test('correcting a parent report invalidates transitive answers without refunding issued slots', () => {
  let state = chain();
  assert.equal(currentView(backIntake(state)).question.id, 'q3_personal_02');
  while (currentView(state).question.id !== 'q3_01') state = backIntake(state);
  state = done(prepare(state, '제가 잘못 기억했어요. 친구가 만나자고 한 적은 없어요.'));
  const context = buildContext(state);
  for (const id of ['q3_personal_01','q3_personal_02']) {
    assert.equal(state.v3.personalization.questions[id].status, 'obsolete');
    assert.equal(state.clarificationAnswers[id], undefined);
    assert.equal(context.patient.fields[id], undefined);
  }
  assert.equal(context.personalization.remaining_follow_ups, 0);
  assert.ok(state.v3.issued.q3_personal_01);
});

test('continuation corrections remove dependent personalized reports transitively from card evidence', () => {
  const state = chain(), record = {context:buildContext(state)};
  const messages = [{id:'m1', role:'user', text:'친구가 만나자고 한 적은 없어요.'}];
  const input = continuationInput(record, messages);
  const source = input.original_sources.find(row=>row.question_id === 'q3_01');
  const context = continuationCardContext(record, messages, {answer:'정정을 반영했어요.', clarification:null,
    facts:[{message_id:'m1', subject:'patient', quote:messages[0].text}], superseded:[source.source_id]});
  assert.equal(context.patient.fields.q3_personal_01, undefined);
  assert.equal(context.patient.fields.q3_personal_02, undefined);
  assert.ok(context.payload.answers.every(row=>!row.id.startsWith('q3_personal_')));
  assert.equal(context.personalization.available, false);
  assert.ok(record.context.patient.fields.q3_personal_01);
});

test('correcting an ordinary source propagates through an already-obsolete Q10 to personalized answers', () => {
  let state = done(prepare(start()));
  let pending = prepare(state, '친구가 내일 찾아온다고 직접 말했어요.');
  const source = buildContext(pending).patient.fields.q3_02;
  state = completeModelAnswer(pending, {...model(null),clarification:{source_question_id:source.id,
    source_revision:source.source_revision,component:'rawText',event_id:'visit',quote:source.rawText,
    quote_start:0,quote_end:Array.from(source.rawText).length,axis:'execution',role:null,agreement_item_id:null}});
  pending = prepareModelAnswer(state,{question_id:'q3_10',follow_up:true,selected:[0]},2);
  const clarified = buildContext(pending).patient.fields.q3_10;
  state = done(pending,decision(pending,{source_question_id:clarified.id,source_revision:clarified.source_revision,
    quote:clarified.rawText,quote_end:Array.from(clarified.rawText).length,question:'그때 친구가 요청한 도움이 있나요?',focus:'support'}));
  state = done(prepare(state,'이야기를 들어 달라고 했어요.'));
  assert.ok(buildContext(state).patient.fields.q3_personal_01);
  while(currentView(state).question.id !== 'q3_02') state = backIntake(state);
  state = done(prepare(state,'잘못 기억했어요. 친구가 찾아온다고 말한 적이 없어요.'));
  assert.equal(state.v3.clarification.status,'obsolete');
  assert.equal(state.v3.personalization.questions.q3_personal_01.status,'obsolete');
  assert.equal(state.clarificationAnswers.q3_10,undefined);
  assert.equal(state.clarificationAnswers.q3_personal_01,undefined);
  assert.equal(buildContext(state).patient.fields.q3_personal_01,undefined);
});


test('leaving an answered Q10 edit restores its saved status and assignment consistently', () => {
  let state = done(prepare(start()));
  const pending = prepare(state, '친구와 같은 동호회에서 만났어요.');
  const source = buildContext(pending).supporter.fields.q3_01;
  state = completeModelAnswer(pending, {...model(null),clarification:{source_question_id:source.id,
    source_revision:source.source_revision,component:'rawText',event_id:'meeting',quote:source.rawText,
    quote_start:0,quote_end:Array.from(source.rawText).length,axis:'execution',role:null,agreement_item_id:null}});
  state = done(prepareModelAnswer(state,{question_id:'q3_10',follow_up:true,selected:[0]},2));
  const assignment = structuredClone(state.clarificationAnswers.q3_10.assignment);
  state = backIntake(state);
  assert.equal(currentView(state).question.id,'q3_10');
  state = backIntake(state);
  assert.equal(currentView(state).question.id,'q3_02');
  state = done(prepare(state,'동호회에서 알게 된 친구예요.'));
  assert.equal(state.v3.clarification.status,'answered');
  assert.deepEqual(state.v3.clarification.assignment,assignment);
  assert.deepEqual(buildContext(state).supporter.fields.q3_10.assignment,assignment);
});
