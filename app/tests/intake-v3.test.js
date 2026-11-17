import test from 'node:test';
import assert from 'node:assert/strict';
import { activeQuestionSet } from '../src/question-bank.js';
import { createIntake, currentView, answerIntake, backIntake, buildContext, prepareModelAnswer,
  completeModelAnswer, applyModelUpdate, createTestIntake, discardModelAnswer } from '../src/intake.js';
import { safetySources } from '../src/relationship-agent.js';

const start = () => createIntake(activeQuestionSet);
const reply = (state, input = {}) => {
  const q = currentView(state).question;
  return answerIntake(state, { question_id:q.id, instance_id:q.instance_id, follow_up:Boolean(q.follow_up), ...input });
};
const model = (extra = {}) => ({ name_index:null, patient_state:{}, question_plan:{skip:[]}, ...extra });
function pendingGoal(text = '🙂友人が明日来ると言いました。') {
  return prepareModelAnswer(start(), { question_id:'q3_01', custom:text }, 0);
}
function binding(state, extra = {}) {
  const source = buildContext(state).supporter.fields.q3_01;
  return { source_question_id:'q3_01', source_revision:source.source_revision, component:'rawText', event_id:'visit',
    quote:source.rawText, quote_start:0, quote_end:Array.from(source.rawText).length, axis:'execution', role:'', agreement_item_id:'', ...extra };
}

test('v3 has nine optional base prompts, no required name or old follow-ups, and ends after skips', () => {
  let state = start();
  const ids = [];
  while (state.status === 'active') {
    const q = currentView(state).question;
    assert.equal(Boolean(q.required || q.noSkip), false);
    assert.equal(Boolean(q.follow_up), false);
    ids.push(q.id);
    state = reply(state, { response_event:'skipped' });
    assert.ok(ids.length <= 9);
  }
  assert.deepEqual(ids, activeQuestionSet.questions.map(q => q.id));
  assert.equal(buildContext(state).answered_count, 0);
  assert.equal(buildContext(state).question_policy.minimum_answer_count, 0);
  assert.deepEqual(buildContext(state).clarification_candidates, []);
  assert.equal(Object.keys(state.v3.issued).length, 9);
});

test('registered help redisplays the same instance once, then records not understood and advances', () => {
  let state = start();
  const first = currentView(state).question;
  state = reply(state, { response_event:'not_understood' });
  assert.equal(currentView(state).question.instance_id, first.instance_id);
  assert.equal(Object.keys(state.v3.issued).length, 1);
  assert.equal(state.v3.issued.q3_01.help_displays, 1);
  assert.equal(state.log.at(-2).text, first.help);
  assert.equal(state.ans.q3_01, undefined);
  state = reply(state, { response_event:'not_understood' });
  assert.equal(currentView(state).question.id, 'q3_02');
  assert.equal(state.ans.q3_01.response_event, 'not_understood');
  assert.equal(buildContext(state).supporter.fields.q3_01.status, 'skipped');
});

test('model preparation does not consume the next prompt and retries preserve the visible instance', () => {
  const state = pendingGoal();
  assert.deepEqual(Object.keys(state.v3.issued), ['q3_01']);
  assert.deepEqual(Object.keys(state.modelPending.prepared.v3.issued), ['q3_01']);
  assert.equal(currentView(state).question.id, 'q3_01');
  const done = completeModelAnswer(state, model());
  assert.deepEqual(Object.keys(done.v3.issued), ['q3_01','q3_02']);
  assert.equal(currentView(done).question.id, 'q3_02');
});

test('unknown with substantive text preserves both uncertainty and the explicit report', () => {
  const state = reply(start(), { response_event:'unknown', text:'언제인지는 모르지만 친구가 연락을 원하지 않는다고 말했어요.' });
  const field = buildContext(state).supporter.fields.q3_01;
  assert.equal(field.response_event, 'unknown');
  assert.equal(field.selection_status, 'unknown');
  assert.equal(field.status, 'answered');
  assert.equal(field.ordinary_usable, true);
  assert.match(field.rawText, /연락을 원하지 않는다고/);
  const unknown = buildContext(reply(start(), { response_event:'unknown' })).supporter.fields.q3_01;
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.ordinary_usable, false);
});

test('refusal and stop retain raw safety content while excluding ordinary facts and further questions', () => {
  const text = '답변은 멈출게요. 지금 친구가 다쳤어요.';
  const stopped = reply(start(), { response_event:'stop', text });
  const context = buildContext(stopped);
  assert.equal(stopped.status, 'ready');
  assert.equal(context.user_stopped, true);
  assert.equal(context.clarification_available, false);
  assert.equal(context.supporter.fields.q3_01.rawText, text);
  assert.equal(context.supporter.fields.q3_01.status, 'stopped');
  assert.equal(context.supporter.fields.q3_01.ordinary_usable, false);
  assert.equal(context.answered_count, 0);
  assert.throws(() => answerIntake(stopped, { question_id:'q3_01', text:'다시' }), { code:'INTAKE_STOPPED' });
  const refused = reply(start(), { response_event:'refused', text });
  assert.equal(buildContext(refused).supporter.fields.q3_01.status, 'refused');
  assert.equal(buildContext(refused).supporter.fields.q3_01.rawText, text);
});

test('quoted stop words remain ordinary text and single selections can retain custom detail', () => {
  const text = '친구가 “그만”이라고 말했지만 저는 문장을 정리하고 싶어요.';
  const state = reply(start(), { selected:[0], custom:text });
  assert.equal(state.status, 'active');
  assert.equal(state.v3.stopped, false);
  const context = buildContext(state);
  assert.equal(context.user_goal.message.id, 'q3_01');
  assert.equal(context.user_goal.message.custom, text);
  assert.equal(context.user_goal.message.source_revision, 1);
  assert.equal(context.bundle_id, activeQuestionSet.bundle_id);
  assert.equal(context.questionnaire_bundle.policy.limits.minimum_answer_count, 0);
});

test('back corrects the same instance, retains later answers, and never refunds display or source revisions', () => {
  let state = reply(start(), { selected:[0] });
  state = reply(state, { selected:[5] });
  const before = structuredClone(state.v3.issued);
  state = backIntake(state);
  assert.equal(currentView(state).question.id, 'q3_02');
  state = reply(state, { custom:'친한 친구' });
  assert.equal(currentView(state).question.id, 'q3_03');
  assert.deepEqual(state.v3.issued, before);
  assert.equal(state.ans.q3_02.source_revision, 3);
  assert.equal(state.ans.q3_01.sel[0], 0);
  assert.throws(() => reply(state, { instance_id:'obsolete', text:'상황' }), { code:'question_mismatch' });
});

test('Q10 binds exact Unicode source and changes only the selected axis', () => {
  const pending = pendingGoal();
  let state = completeModelAnswer(pending, model({ clarification:binding(pending) }));
  assert.equal(currentView(state).question.id, 'q3_10');
  assert.deepEqual(Object.keys(state.v3.issued), ['q3_01','q3_10']);
  assert.equal(state.v3.clarification.binding.source_message_id, 'q3_01:1');
  state = reply(state, { selected:[0] });
  assert.equal(currentView(state).question.id, 'q3_02');
  assert.deepEqual(state.clarificationAnswers.q3_10.assignment, { event_id:'visit', axis:'execution', value:'occurred' });
  assert.equal(buildContext(state).clarification_available, false);
  assert.equal(buildContext(state).supporter.fields.q3_10.binding.quote_start, 0);
  assert.throws(() => applyModelUpdate(state, model({ clarification:binding(pending) })), { code:'INVALID_CLARIFICATION' });
});

function clarificationAfterSkips() {
  const pending = pendingGoal('친구에게 자료를 읽어 준다고 했어요.');
  const context = buildContext(pending);
  const skip = context.question_candidates.map(q => ({question_id:q.id,reason:'not_needed',
    explanation:'현재 요청은 보고한 범위만 정리합니다.',
    evidence:[{subject:'supporter',question_id:'q3_01',quote:context.supporter.fields.q3_01.rawText}]}));
  return {state:completeModelAnswer(pending, model({question_plan:{skip},clarification:binding(pending)})),skip};
}

for (const input of [{selected:[1]}, {response_event:'unknown'}, {response_event:'refused'}, {response_event:'skipped'}])
test('Q10 completion reconsiders unshown skips without inventing answers: '+(input.response_event||'answered'), () => {
  const {state}=clarificationAfterSkips(), issued=structuredClone(state.v3.issued);
  const pending=prepareModelAnswer(state,{question_id:'q3_10',follow_up:true,...input},2);
  const prepared=pending.modelPending.prepared;
  assert.deepEqual(buildContext(pending).question_candidates.map(q=>q.id),activeQuestionSet.questions.slice(1).map(q=>q.id));
  assert.deepEqual(pending.v3.issued,issued);
  assert.deepEqual(pending.modelSkipped,state.modelSkipped,'Uncommitted state remains available for a cancelled answer');
  assert.deepEqual(prepared.modelSkipped,{});
  assert.equal(prepared.clarificationAnswers.q3_10.assignment.value,input.selected?'in_progress':'unknown');
  assert.equal(buildContext(pending).clarification_available,false);
  const next=completeModelAnswer(pending,model());
  assert.equal(currentView(next).question.id,'q3_02');
  assert.deepEqual(Object.keys(next.ans),['q3_01']);
  assert.deepEqual(next.v3.issued.q3_10,issued.q3_10);
  assert.equal(next.clarificationAnswers.q3_10.source_revision,prepared.clarificationAnswers.q3_10.source_revision);
  assert.ok(buildContext(next).payload.answers.every(answer=>['q3_01','q3_10'].includes(answer.id)));
});

test('model may freshly skip unshown questions after Q10 while preserving the consumed clarification', () => {
  const {state,skip}=clarificationAfterSkips();
  const pending=prepareModelAnswer(state,{question_id:'q3_10',follow_up:true,selected:[1]},2);
  const next=completeModelAnswer(pending,model({question_plan:{skip}}));
  assert.equal(next.status,'ready');
  assert.deepEqual(Object.keys(next.ans),['q3_01']);
  assert.deepEqual(Object.keys(next.v3.issued),['q3_01','q3_10']);
  assert.equal(buildContext(next).clarification_available,false);
});

test('first Q10 help keeps its prompt; exhausted help replans while stop never advances', () => {
  const {state}=clarificationAfterSkips();
  const help=reply(state,{response_event:'not_understood'});
  assert.equal(currentView(help).question.id,'q3_10');
  assert.equal(help.v3.helpReplay,true);
  assert.deepEqual(help.modelSkipped,state.modelSkipped);
  assert.equal(help.clarificationAnswers?.q3_10,undefined);
  const pending=prepareModelAnswer(help,{question_id:'q3_10',follow_up:true,response_event:'not_understood'},3);
  assert.equal(buildContext(pending).question_candidates.length,8);
  const next=completeModelAnswer(pending,model());
  assert.equal(currentView(next).question.id,'q3_02');
  assert.equal(next.clarificationAnswers.q3_10.assignment.value,'unknown');
  const stopped=reply(state,{response_event:'stop'});
  assert.equal(stopped.status,'ready');assert.equal(stopped.v3.stopped,true);
  assert.deepEqual(Object.keys(stopped.v3.issued),['q3_01','q3_10']);
  assert.deepEqual(buildContext(stopped).question_candidates,[]);
});

test('Q10 rejects stale revisions, non-codepoint ranges, missing roles and unbound agreement items', () => {
  const pending = pendingGoal();
  for (const change of [ { source_revision:0 }, { quote_start:1 }, { axis:'actor' }, { axis:'agreement' } ]) {
    assert.throws(() => completeModelAnswer(pending, model({ clarification:binding(pending, change) })), { code:'INVALID_CLARIFICATION' });
  }
  assert.equal(Object.hasOwn(pending.v3.issued, 'q3_10'), false);
});

test('source correction obsoletes Q10 without rebinding it or allowing a second clarification', () => {
  const pending = pendingGoal();
  let state = completeModelAnswer(pending, model({ clarification:binding(pending) }));
  const oldInstance = currentView(state).question.instance_id;
  state = backIntake(state);
  assert.equal(currentView(state).question.id, 'q3_01');
  state = reply(state, { custom:'정정합니다. 방문한 것이 아니라 제안만 했어요.' });
  assert.equal(state.v3.clarification.status, 'obsolete');
  assert.equal(state.v3.issued.q3_10.instance_id, oldInstance);
  assert.equal(buildContext(state).clarification_available, false);
  assert.equal(state.clarificationAnswers?.q3_10, undefined);
});

test('time clarification requires explicit time text and preserves its submission time context', () => {
  const pending = pendingGoal();
  let state = completeModelAnswer(pending, model({ clarification:binding(pending, { axis:'time' }) }));
  assert.throws(() => reply(state, { selected:[0] }), { code:'answer_required' });
  state = reply(state, { selected:[0], custom:'지난주 금요일 저녁' });
  const assignment = state.clarificationAnswers.q3_10.assignment;
  assert.equal(assignment.value, 'specified');
  assert.equal(assignment.time_text, '지난주 금요일 저녁');
  assert.equal(assignment.source_timezone, 'Asia/Seoul');
  assert.equal(typeof assignment.source_timestamp, 'string');
  assert.equal(assignment.execution, undefined);
});

test('sparse v3 test input keeps original question IDs and current source revisions', () => {
  const state = createTestIntake([{ question_id:'q3_03', text:'저는 아직 답하지 않았고 상대는 기다린다고 했어요.' }], activeQuestionSet);
  const context = buildContext(state);
  assert.equal(context.patient.fields.q3_03.source_revision, 1);
  assert.equal(context.patient.fields.q3_03.id, 'q3_03');
  assert.equal(context.user_goal.message.status, 'not_asked');
  assert.equal(context.patient.fields.q3_04.status, 'not_asked');
});

test('grounded skips can finish after one answer without creating answers or consuming unseen questions', () => {
  const pending = pendingGoal('상황 설명 없이 짧게 거절하는 말 한 문장만 원해요.');
  const context = buildContext(pending);
  const skip = context.question_candidates.map(q => ({ question_id:q.id, reason:'not_needed',
    explanation:'사용자는 상황 설명 없이 짧은 거절 문장만 요청했습니다.',
    evidence:[{ subject:'supporter', question_id:'q3_01', quote:context.supporter.fields.q3_01.rawText }] }));
  const state = completeModelAnswer(pending, model({ question_plan:{skip} }));
  assert.equal(state.status, 'ready');
  assert.deepEqual(Object.keys(state.v3.issued), ['q3_01']);
  assert.deepEqual(Object.keys(state.ans), ['q3_01']);
  assert.equal(buildContext(state).patient.fields.q3_04.status, 'auto_skipped');
});

test('replanning reconsiders only unshown skips and never reasks an answered later question', () => {
  let pending = pendingGoal('친구에게 한 문장으로 답하고 싶어요.');
  const firstSource = buildContext(pending).supporter.fields.q3_01.rawText;
  const skip = [{ question_id:'q3_02', reason:'not_needed', explanation:'현재 요청은 관계 설명 없이 간단한 답을 원합니다.',
    evidence:[{subject:'supporter',question_id:'q3_01',quote:firstSource}] }];
  let state = completeModelAnswer(pending, model({question_plan:{skip}}));
  assert.equal(currentView(state).question.id, 'q3_03');
  pending = prepareModelAnswer(state, {question_id:'q3_03',text:'친구가 오늘 만나자고 했어요.'}, 2);
  assert.equal(buildContext(pending).question_candidates[0].id, 'q3_02');
  state = completeModelAnswer(pending, model({question_plan:{skip}}));
  assert.equal(currentView(state).question.id, 'q3_04');
  assert.equal(state.ans.q3_03.text, '친구가 오늘 만나자고 했어요.');
  assert.equal(Object.hasOwn(state.v3.issued, 'q3_02'), false);
});

test('a prepared help response reveals the registered help only on commit and keeps its single budget', () => {
  const original = start();
  const pending = prepareModelAnswer(original, {question_id:'q3_01',response_event:'not_understood'}, 0);
  assert.equal(pending.log.some(row => row.text === currentView(original).question.help), false);
  const state = completeModelAnswer(pending, model());
  assert.equal(state.log.at(-2).text, currentView(original).question.help);
  assert.equal(currentView(state).question.id, 'q3_01');
  assert.equal(state.v3.issued.q3_01.help_displays, 1);
  assert.deepEqual(Object.keys(state.v3.issued), ['q3_01']);
});

test('pending stop locks ordinary answers and back across failure, discard and identical retry', () => {
  const raw = '  여기서 멈출게요.\n지금 친구가 다쳤어요.  ';
  const input = {question_id:'q3_01',response_event:'stop',text:raw,custom:'연락 가능한 사람은 아직 몰라요.'};
  const pending = prepareModelAnswer(start(), input, 0);
  const view = currentView(pending);
  assert.equal(view.status, 'active');
  assert.equal(view.question.id, 'q3_01');
  assert.equal(view.model_pending, true);
  assert.equal(view.user_stopped, true);
  assert.equal(view.input_locked, true);
  assert.equal(view.canGoBack, false);
  assert.throws(() => prepareModelAnswer(pending, {question_id:'q3_01',custom:'일반 답변으로 교체'}, 1), {code:'INTAKE_STOPPED'});
  assert.throws(() => answerIntake(pending, {question_id:'q3_01',custom:'새 답변'}), {code:'INTAKE_STOPPED'});
  assert.throws(() => backIntake(pending), {code:'INTAKE_STOPPED'});
  const retry = prepareModelAnswer(pending, {...input,revision:1}, 1);
  assert.deepEqual(retry, pending);
  const discarded = discardModelAnswer(pending);
  assert.equal(discarded.status, 'ready');
  assert.equal(discarded.v3.stopped, true);
  assert.equal(discarded.modelPending, undefined);
  assert.equal(discarded.ans.q3_01.rawText, raw);
  assert.equal(discarded.ans.q3_01.custom, input.custom);
  assert.equal(buildContext(discarded).user_stopped, true);
  assert.throws(() => prepareModelAnswer(discarded, {question_id:'q3_01',custom:'다시'}, 2), {code:'INTAKE_STOPPED'});
  const completed = completeModelAnswer(retry, model());
  assert.equal(completed.status, 'ready');
  assert.equal(currentView(completed).question, null);
  assert.equal(buildContext(completed).supporter.fields.q3_01.rawText, raw);
  assert.deepEqual(Object.keys(completed.v3.issued), ['q3_01']);
});

test('changing the goal replans earlier unshown skips before returning to an already issued later prompt', () => {
  const pending = pendingGoal('제 마음만 정리하고 싶어요.');
  const quote = buildContext(pending).supporter.fields.q3_01.rawText;
  const skip = ['q3_02','q3_03','q3_04','q3_05'].map(question_id => ({question_id,reason:'not_needed',
    explanation:'현재 요청은 자신의 마음을 정리하는 범위입니다.', evidence:[{subject:'supporter',question_id:'q3_01',quote}]}));
  let state = completeModelAnswer(pending, model({question_plan:{skip}}));
  assert.equal(currentView(state).question.id, 'q3_06');
  const issuedBeforeCorrection = structuredClone(state.v3.issued);
  state = backIntake(state);
  assert.equal(currentView(state).question.id, 'q3_01');
  const corrected = prepareModelAnswer(state, {question_id:'q3_01',custom:'친구와 약속한 내용을 자세히 정리하고 싶어요.'}, 2);
  const context = buildContext(corrected);
  assert.deepEqual(context.question_candidates.slice(0,4).map(q => q.id), ['q3_02','q3_03','q3_04','q3_05']);
  assert.equal(context.question_candidates.some(q => q.id === 'q3_06'), false);
  assert.deepEqual(corrected.v3.issued, issuedBeforeCorrection);
  state = completeModelAnswer(corrected, model());
  assert.equal(currentView(state).question.id, 'q3_02');
  assert.deepEqual(state.v3.issued.q3_06, issuedBeforeCorrection.q3_06);
  assert.equal(state.v3.goal_epoch, 2);
  assert.equal(state.ans.q3_06, undefined);
});

test('correcting Q9 from a final Q10 replans unshown questions and preserves the consumed clarification across retry', () => {
  const ids = ['q3_02','q3_03','q3_04','q3_05','q3_06','q3_07','q3_08'];
  const skips = (context, sourceId) => ids.map(question_id => ({question_id, reason:'not_needed',
    explanation:'현재 요청은 이미 보고한 범위의 문안 정리입니다.',
    evidence:[{subject:'supporter',question_id:sourceId,quote:context.supporter.fields[sourceId].rawText}]}));
  let pending = pendingGoal('가능한 범위만 짧게 정리하고 싶어요.');
  let state = completeModelAnswer(pending, model({question_plan:{skip:skips(buildContext(pending),'q3_01')}}));
  assert.equal(currentView(state).question.id, 'q3_09');
  pending = prepareModelAnswer(state, {question_id:'q3_09',text:'친구에게 자료를 읽어 준다고 했어요.'}, 2);
  const source = buildContext(pending).supporter.fields.q3_09;
  state = completeModelAnswer(pending, model({question_plan:{skip:skips(buildContext(pending),'q3_09')},
    clarification:{source_question_id:'q3_09',source_revision:source.source_revision,component:'rawText',event_id:'read_material',
      quote:source.rawText,quote_start:0,quote_end:Array.from(source.rawText).length,axis:'execution',role:null,agreement_item_id:null}}));
  assert.equal(currentView(state).question.id, 'q3_10');
  const issued = structuredClone(state.v3.issued), goal = structuredClone(state.ans.q3_01);
  state = backIntake(state);
  assert.equal(currentView(state).question.id, 'q3_09');
  const input = {question_id:'q3_09',text:'정정합니다. 아직 도움을 정하지 않았고 상대의 요청과 제 여건부터 확인하고 싶어요.'};
  pending = prepareModelAnswer(state, input, 4);
  for (const attempt of [pending, prepareModelAnswer(pending, input, 5)]) {
    const context = buildContext(attempt);
    assert.deepEqual(context.question_candidates.map(q => q.id), ids);
    assert.deepEqual(attempt.v3.issued, issued);
    assert.equal(context.clarification_available, false);
    assert.equal(context.clarification_state.status, 'obsolete');
    const completed = completeModelAnswer(attempt, model());
    assert.equal(completed.status, 'active');
    assert.equal(currentView(completed).question.id, 'q3_02');
    assert.deepEqual(completed.ans.q3_01, goal);
    assert.equal(completed.ans.q3_09.rawText, input.text);
    assert.deepEqual(completed.v3.issued.q3_10, issued.q3_10);
    assert.deepEqual(Object.keys(completed.v3.issued), ['q3_01','q3_09','q3_10','q3_02']);
    assert.equal(completed.clarificationAnswers?.q3_10, undefined);
  }
});

test('ordinary correction can reskip earlier candidates and return to the same unanswered issued question', () => {
  const skips = (context, ids, sourceId, subject) => ids.map(question_id => ({question_id, reason:'not_needed',
    explanation:'현재 요청은 원문에 보고한 범위만 정리하면 됩니다.',
    evidence:[{subject,question_id:sourceId,quote:context[subject].fields[sourceId].rawText}]}));
  let pending = pendingGoal('지금 말한 내용만 짧게 정리하고 싶어요.');
  let state = completeModelAnswer(pending, model({question_plan:{skip:skips(buildContext(pending),['q3_02'],'q3_01','supporter')}}));
  assert.equal(currentView(state).question.id, 'q3_03');
  pending = prepareModelAnswer(state, {question_id:'q3_03',text:'친구에게 제 여건을 설명했어요.'}, 2);
  state = completeModelAnswer(pending, model({question_plan:{skip:skips(buildContext(pending),['q3_02','q3_04','q3_05'],'q3_03','patient')}}));
  assert.equal(currentView(state).question.id, 'q3_06');
  const issued = structuredClone(state.v3.issued), goalEpoch = state.v3.goal_epoch;
  state = backIntake(state);
  assert.equal(currentView(state).question.id, 'q3_03');
  pending = prepareModelAnswer(state, {question_id:'q3_03',text:'정정합니다. 아직 여건을 설명하지 않았어요.'}, 4);
  const context = buildContext(pending);
  assert.deepEqual(context.question_candidates.slice(0,3).map(q => q.id), ['q3_02','q3_04','q3_05']);
  assert.equal(context.question_candidates.some(q => Object.hasOwn(issued,q.id)), false);
  assert.deepEqual(pending.v3.issued, issued);
  state = completeModelAnswer(pending, model({question_plan:{skip:skips(context,['q3_02','q3_04','q3_05'],'q3_03','patient')}}));
  assert.equal(currentView(state).question.id, 'q3_06');
  assert.equal(currentView(state).question.instance_id, issued.q3_06.instance_id);
  assert.deepEqual(state.v3.issued, issued);
  assert.equal(state.v3.goal_epoch, goalEpoch);
  assert.equal(state.ans.q3_06, undefined);
  assert.equal(state.ans.q3_03.rawText, '정정합니다. 아직 여건을 설명하지 않았어요.');
});

test('v3 selected answers preserve independent submitted raw text for complete safety review', () => {
  const raw = '  지금 친구가 다쳤어요.\n제가 직접 본 상황이에요.  ';
  const state = reply(start(), {selected:[0],text:raw,custom:'짧은 거절 문장도 필요해요.'});
  const field = buildContext(state).supporter.fields.q3_01;
  assert.equal(field.rawText, raw);
  assert.equal(field.custom, '짧은 거절 문장도 필요해요.');
  assert.match(field.text, /거절하거나 선을 긋는 말을 쓰고 싶어요/);
  assert.notEqual(field.text, raw);
  assert.ok(safetySources(buildContext(state)).some(source => source.components.some(component => component.text === raw)));
  const canonical = reply(start(), {selected:[0],text:activeQuestionSet.questions[0].opts[0][0]});
  assert.equal(canonical.ans.q3_01.rawText, canonical.ans.q3_01.text);
});
