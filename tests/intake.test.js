import test from 'node:test';
import assert from 'node:assert/strict';
import { questions, questionCatalog, columns, categories, optLabel } from '../src/catalog.js';
import { createIntake, currentView, answerIntake, backIntake, buildContext, applyModelUpdate } from '../src/intake.js';

const questionIds = ['name', 'want', 'goal', 'rel', 'contact', 'mood', 'dur', 'freq', 'describe', 'concern', 'cause', 'events', 'others_why', 'support', 'burden', 'values', 'values_effect', 'extra', 'coping', 'help', 'barrier', 'need', 'others_help', 'moment', 'moment_freq', 'feeling', 'cgchange', 'cgchange_more', 'mycoping', 'mysupport'];

function reply(state, input = {}) {
  const question = currentView(state).question;
  return answerIntake(state, { question_id: question.id, follow_up: Boolean(question.follow_up), ...input });
}

function defaultReply(state) {
  const question = currentView(state).question;
  if (question.type === 'text') return reply(state, { text: '요즘 상황에 대해 충분히 자세한 이야기를 들려드릴게요.' });
  return reply(state, { selected: [0] });
}

function advanceTo(id, overrides = {}) {
  let state = createIntake();
  for (let step = 0; step < 70; step++) {
    const question = currentView(state).question;
    if (question?.id === id && !question.follow_up) return state;
    assert.equal(state.status, 'active', `question ${id} should be reachable`);
    state = overrides[question.id] ? reply(state, overrides[question.id]) : defaultReply(state);
  }
  throw new Error(`Question ${id} not reached`);
}

const modelOutput = (skip = [], nameIndex = null) => ({
  patient_state:{ summary:'사용자가 보고한 현재 상황', facts:[], unknowns:[], user_goal:'확인되지 않음' },
  name_index:nameIndex, question_plan:{ skip },
});

test('model indexes an explicit alias and rebuilds the next prompt without changing the name evidence', () => {
  const raw = reply(createIntake(), { text:'내 동생 지수' });
  const next = applyModelUpdate(raw, modelOutput([], { alias:'지수', source_question_id:'name', quote:'지수' }));
  assert.equal(next.name, '지수');
  assert.equal(next.chatTitle, '지수');
  assert.equal(buildContext(next).patient.fields.name.rawText, '내 동생 지수');
  assert.match(currentView(next).question.q, /지수에게/);
  assert.equal(next.log.filter(item => item.text.includes('꼭 전하고 싶은 말')).length, 1);
  assert.equal(raw.name, '내 동생 지수');
  const previous = backIntake(next);
  assert.equal(currentView(previous).question.id, 'name');
  assert.equal(previous.chatTitle, '');
  assert.equal(previous.nameIndex, null);
});

test('model skips a covered current question without fabricating an answer and back removes that decision', () => {
  const goal = advanceTo('goal', { want:{ text:'내가 곁에 있다는 것을 전하고 싶어요.' } });
  const skip = { question_id:'goal', reason:'already_covered', explanation:'전하고 싶은 말에 원하는 결과를 알려 주었습니다.',
    evidence:[{ subject:'user_goal', question_id:'want', quote:'내가 곁에 있다는 것' }] };
  const next = applyModelUpdate(goal, modelOutput([skip]));
  assert.equal(currentView(next).question.id, 'rel');
  assert.equal(next.ans.goal, undefined);
  assert.equal(buildContext(next).user_goal.desired_outcomes.status, 'auto_skipped');
  assert.equal(next.log.some(item => item.text === '그 말을 통해 바라는 것은 무엇인가요?'), false);
  assert.deepEqual(next.modelSkipped.goal, skip);
  const previous = backIntake(next);
  assert.equal(currentView(previous).question.id, 'want');
  assert.equal(previous.ans.want, undefined);
  assert.deepEqual(previous.modelSkipped, {});
});

test('an unresolved name follow-up clears the previous model title', () => {
  const pending = reply(createIntake(), { text:'잘 모르겠지만 친구' });
  assert.equal(Boolean(pending.pendingFollow), true);
  const indexed = applyModelUpdate(pending, modelOutput([], { alias:'친구', source_question_id:'name', quote:'친구' }));
  assert.equal(indexed.chatTitle, '친구');
  const resolved = reply(indexed, { text:'없어' });
  const next = applyModelUpdate(resolved, modelOutput());
  assert.equal(next.name, '그분');
  assert.equal(next.chatTitle, '');
  assert.equal(next.nameIndex, null);
  assert.match(currentView(next).question.q, /그분에게/);
});

test('skipping the last optional question completes the intake without leaving an unseen prompt', () => {
  const last = advanceTo('mysupport');
  const skip = { question_id:'mysupport', reason:'not_needed', explanation:'주변인의 대처와 도움에 대한 현재 답변으로 안내할 수 있습니다.',
    evidence:[{ subject:'supporter', question_id:'mycoping', quote:last.ans.mycoping.text }] };
  const ready = applyModelUpdate(last, modelOutput([skip]));
  assert.equal(ready.status, 'ready');
  assert.equal(currentView(ready).question, null);
  assert.equal(ready.ans.mysupport, undefined);
  assert.equal(buildContext(ready).supporter.fields.mysupport.status, 'auto_skipped');
  assert.equal(ready.log.some(item => item.text === currentView(last).question.q), false);
});

test('future skip decisions survive intervening answers and never hide conditional branch gates', () => {
  const duration = advanceTo('dur', { mood:{ selected:[0] } });
  const context = buildContext(duration);
  assert.ok(context.answered_count >= 5);
  assert.equal(context.question_candidates.some(candidate => ['name','want','cause'].includes(candidate.id)), false);
  const skip = { question_id:'describe', reason:'not_needed', explanation:'현재 모습에 대한 보고로 안내를 구성할 수 있습니다.',
    evidence:[{ subject:'patient', question_id:'mood', quote:'자주 우울하거나 가라앉아 보여요' }] };
  let state = applyModelUpdate(duration, modelOutput([skip]));
  assert.equal(currentView(state).question.id, 'dur');
  state = reply(state, { selected:[2] });
  state = reply(state, { selected:[2] });
  assert.equal(currentView(state).question.id, 'concern');
  assert.equal(state.ans.describe, undefined);
  assert.equal(buildContext(state).patient.fields.describe.status, 'auto_skipped');
  assert.equal(state.log.some(item => item.text.includes('상황을 설명한다면')), false);
  const previous = backIntake(state);
  assert.equal(currentView(previous).question.id, 'freq');
  assert.deepEqual(previous.modelSkipped.describe, skip);
});

test('catalog reuses all 30 UI question IDs, wording, option metadata and columns', () => {
  assert.deepEqual(questions.map(question => question.id), questionIds);
  assert.equal(questionCatalog.length, 30);
  assert.equal(columns.length, 10);
  assert.equal(categories.length, 4);
  assert.equal(questions[5].opts.at(-1)[0], '특별히 관찰된 변화가 없음');
  assert.doesNotThrow(() => JSON.stringify(questionCatalog));
  assert.equal(questionCatalog.find(question => question.id === 'events').conditional, true);
});

test('welcome/current prompt are persisted once and view reads are pure', () => {
  const state = createIntake();
  const before = structuredClone(state);
  assert.equal(currentView(state).question.id, 'name');
  assert.equal(currentView(state).canGoBack, false);
  assert.equal(state.log.length, 2);
  assert.deepEqual(state, before);
  const next = reply(state, { text: '엄마' });
  assert.equal(state.name, '');
  assert.equal(next.name, '엄마');
  assert.match(currentView(next).question.intro, /엄마에게/);
  assert.equal(next.log.at(-1).text, currentView(next).question.q);
});

test('required answers, current question, option bounds, single/exclusive selection are checked', () => {
  const required = advanceTo('want');
  assert.throws(() => reply(required, { text: '' }), { code: 'answer_required' });
  assert.throws(() => reply(required, { skipped: true }), { code: 'answer_required' });
  assert.throws(() => answerIntake(required, { question_id: 'mood', text: 'test' }), { code: 'question_mismatch' });

  const relationship = advanceTo('rel');
  assert.throws(() => reply(relationship, { selected: [0, 1] }), { code: 'invalid_selection' });
  assert.throws(() => reply(relationship, { selected: [99] }), { code: 'invalid_selection' });
  assert.throws(() => reply(relationship, { selected: [-1] }), { code: 'invalid_selection' });
  assert.throws(() => reply(relationship, { selected: [0, 0] }), { code: 'invalid_selection' });

  const mood = advanceTo('mood');
  assert.throws(() => reply(mood, { selected: [] }), { code: 'answer_required' });
  assert.throws(() => reply(mood, { selected: [0, currentView(mood).question.opts.length - 1] }), { code: 'exclusive_selection' });
  const cause = advanceTo('cause');
  assert.throws(() => reply(cause, { custom: 'maybe', text: 'maybe' }), { code: 'custom_not_allowed' });
  assert.throws(() => reply(cause, { skipped: true }), { code: 'answer_required' });
});

test('no observed change skips duration/frequency unless extra observations exist', () => {
  const mood = advanceTo('mood');
  const noneIndex = currentView(mood).question.opts.length - 1;
  const next = reply(mood, { selected: [noneIndex] });
  assert.equal(currentView(next).question.id, 'describe');
  assert.equal(next.tags.includes('no_change'), true);
  assert.equal(next.ans.dur, undefined);
  assert.equal(next.ans.freq, undefined);
  const withObservation = reply(mood, { selected: [noneIndex], custom: '다만 며칠 전부터 식사량이 줄었어요.' });
  assert.equal(currentView(withObservation).question.id, 'dur');
});

test('rare contact changes exact wording and Korean name particles', () => {
  const contact = advanceTo('contact', { name: { text: '지수' } });
  assert.match(currentView(contact).question.q, /지수와/);
  const mood = reply(contact, { selected: [3] });
  assert.equal(currentView(mood).question.q,
    '마지막으로 지수를 보거나 연락했을 때 보인 모습을 모두 골라 주세요.\n다른 사람에게 전해 들은 모습도 괜찮아요.');
  const duration = reply(mood, { selected: [0] });
  assert.equal(currentView(duration).question.q, '이런 모습을 처음 알게 된 지 얼마나 됐나요?');
  const frequency = reply(duration, { selected: [0] });
  assert.equal(currentView(frequency).question.q, '최근 2주 동안 이런 모습을 얼마나 자주 보거나 전해 들었나요?');
});

test('conditional event and caregiver detail branches follow the original rules', () => {
  const cause = advanceTo('cause');
  assert.equal(currentView(reply(cause, { selected: [0] })).question.id, 'events');
  assert.equal(currentView(reply(cause, { selected: [1] })).question.id, 'others_why');
  const changes = advanceTo('cgchange');
  const noChanges = reply(changes, { selected: [7] });
  assert.equal(currentView(noChanges).question.id, 'mycoping');
  const changesSelected = reply(changes, { selected: [0] });
  assert.equal(currentView(changesSelected).question.id, 'cgchange_more');
  const customChanges = reply(changes, { selected: [7], custom: '직장에서 자주 실수해요.' });
  assert.equal(currentView(customChanges).question.id, 'cgchange_more');
});

test('one follow-up uses original merge and preserves original and follow-up evidence', () => {
  const concern = advanceTo('concern');
  const original = structuredClone(concern);
  const pending = reply(concern, { text: '식사' });
  assert.equal(currentView(pending).question.id, 'concern');
  assert.equal(currentView(pending).question.follow_up, true);
  assert.equal(pending.fuCount, concern.fuCount + 1);
  assert.equal(buildContext(pending).patient.fields.concern.rawText, '식사');
  assert.equal(buildContext(pending).patient.fields.concern.follow_up_pending, true);
  assert.equal(currentView(pending).canGoBack, false);
  assert.throws(() => answerIntake(pending, { question_id: 'concern', text: '식사' }), { code: 'question_mismatch' });
  assert.throws(() => reply(pending, { text: '' }), { code: 'answer_required' });
  const next = reply(pending, { text: '불안' });
  assert.equal(currentView(next).question.id, 'cause');
  assert.equal(next.ans.concern.text, '불안');
  assert.equal(next.fuCount, pending.fuCount);
  assert.equal(next.ans.concern.rawText, '식사');
  assert.equal(next.ans.concern.followUp.answer.rawText, '불안');
  assert.deepEqual(concern, original);
});

test('follow-up selection labels merge into feeling without carrying invalid base option indices', () => {
  const feeling = advanceTo('feeling');
  const pending = reply(feeling, { text: '음' });
  assert.equal(currentView(pending).question.type, 'multi');
  const next = reply(pending, { selected: [1, 3], text: 'tampered display' });
  assert.equal(next.ans.feeling.text, '무섭고 걱정됐어요, 지치고 막막했어요');
  assert.deepEqual(next.ans.feeling.sel, []);
  assert.equal(buildContext(next).supporter.fields.feeling.followUp.answer.rawText, '무섭고 걱정됐어요, 지치고 막막했어요');
});

test('previous-question action restores answers, flow tags, follow-ups and log and is only available once', () => {
  const mood = advanceTo('mood');
  const pending = reply(mood, { custom: '잠' });
  const duration = reply(pending, { text: '주말 내내 잠만 자는 모습을 봤어요.' });
  assert.equal(currentView(duration).question.id, 'dur');
  assert.equal(duration.fuCount, 1);
  const back = backIntake(duration);
  assert.equal(currentView(back).question.id, 'mood');
  assert.equal(back.ans.mood, undefined);
  assert.equal(back.extraObs, '');
  assert.equal(back.fuCount, 0);
  assert.equal(currentView(back).canGoBack, false);
  assert.equal(back.log.some(item => item.fu), false);
  assert.throws(() => backIntake(back), { code: 'back_unavailable' });
  assert.deepEqual(back.log, mood.log);

  const durationWithTag = reply(mood, { selected: [0] });
  const frequency = reply(durationWithTag, { selected: [2] });
  assert.equal(frequency.tags.includes('dur_long'), true);
  const previousDuration = backIntake(frequency);
  assert.equal(previousDuration.tags.includes('dur_long'), false);
  assert.equal(previousDuration.ans.dur, undefined);
});

test('option labels are canonical and input-option detail is retained', () => {
  const relationship = advanceTo('rel');
  const next = reply(relationship, { selected: [4], text: 'not the chosen option' });
  assert.equal(next.ans.rel.text, '친구');
  assert.equal(next.ans.rel.rawText, '친구');
  const support = advanceTo('support');
  const withDetail = reply(support, { selected: [0], text: '네, 교회 친구들과 산책해요.' });
  assert.equal(withDetail.ans.support.text, '네, 교회 친구들과 산책해요.');
  assert.deepEqual(buildContext(withDetail).patient.fields.support.selected, [{ label: '네', meta: { p: 'social_support' } }]);
});

test('context separates reported patient state, user goal and supporter feelings with exact UI payload', () => {
  let state = advanceTo('dur', { name: { text: '동생' }, want: { text: '내가 네 편이라는 말을 해주고 싶어요.' }, mood: { selected: [0] } });
  state = reply(state, { selected: [5] });
  state = reply(state, { selected: [4] });
  while (state.status === 'active') {
    const question = currentView(state).question;
    if (question.id === 'feeling') state = reply(state, { text: '  무섭고 걱정됐어요.  ' });
    else if (question.id === 'values') state = reply(state, { skipped: true });
    else state = defaultReply(state);
  }
  const context = buildContext(state);
  assert.equal(state.status, 'ready');
  assert.equal(currentView(state).question, null);
  assert.equal(context.schema_version, '1.0');
  assert.equal(context.model_status, 'not_connected');
  assert.equal(context.patient.alias, '동생');
  assert.equal(context.patient.fields.feeling, undefined);
  assert.equal(context.supporter.fields.mood, undefined);
  assert.equal(context.supporter.fields.feeling.text, '  무섭고 걱정됐어요.  ');
  assert.equal(context.patient.fields.values.status, 'skipped');
  assert.equal(context.patient.fields.dur.status, 'unknown');
  assert.equal(context.patient.fields.freq.status, 'unknown');
  assert.equal(context.user_goal.message.text, '내가 네 편이라는 말을 해주고 싶어요.');
  const mood = context.payload.answers.find(answer => answer.id === 'mood');
  assert.deepEqual(mood.selected, [{ label: optLabel(questions[5].opts[0]), meta: { d: 2, s: 'depressive_mood' } }]);
  assert.deepEqual(Object.keys(mood), ['id', 'question', 'type', 'freeText', 'text', 'custom', 'skipped', 'selected']);
  assert.equal('scores' in context.profileInput, false);
  assert.equal('guide' in context, false);
  assert.doesNotThrow(() => structuredClone(context));
  assert.doesNotThrow(() => JSON.stringify(context));
  assert.throws(() => answerIntake(state, { question_id: 'mysupport', text: 'late' }), { code: 'intake_complete' });
});
