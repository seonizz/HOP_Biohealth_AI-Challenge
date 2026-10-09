import test from 'node:test';
import assert from 'node:assert/strict';
import { initialQuestionRows, initialQuestionSet, createQuestionSet, conditionMatches } from '../src/question-bank.js';
import { createIntake, currentView, answerIntake, backIntake, buildContext, applyModelUpdate } from '../src/intake.js';

test('question snapshots retain wording, option indices, follow-up and subject through edits', () => {
  const rows = structuredClone(initialQuestionRows);
  const old = createIntake(createQuestionSet(rows));
  rows.find(row => row.id === 'name').definition.q = '수정한 이름 질문';
  rows.find(row => row.id === 'want').enabled = false;
  rows.push({ id:'patient_note', kind:'base', sort_order:150, enabled:true, subject:'patient',
    definition:{ type:'one', q:'추가 관찰을 선택하세요.', opts:['첫 관찰','둘째 관찰'] } });
  const set = createQuestionSet(rows), next = createIntake(set);
  assert.notEqual(set.version, old.questionSet.version);
  assert.equal(currentView(next).question.q, '수정한 이름 질문');
  assert.equal(currentView(old).question.q, initialQuestionSet.questions[0].q);
  const named = answerIntake(next, { question_id:'name', text:'지수' });
  assert.equal(currentView(named).question.id, 'patient_note');
  const answered = answerIntake(named, { question_id:'patient_note', selected:[1] });
  const context = buildContext(answered);
  assert.equal(context.patient.fields.patient_note.text, '둘째 관찰');
  assert.equal(context.question_set_version, set.version);
  assert.equal(context.user_goal.message, undefined);
  assert.equal(currentView(backIntake(answered)).question.id, 'patient_note');
  rows.find(row => row.id === 'patient_note').definition.opts.reverse();
  assert.equal(buildContext(answered).patient.fields.patient_note.text, '둘째 관찰');
});

test('new supporter question candidates and evidence use the DB subject', () => {
  const rows = structuredClone(initialQuestionRows);
  rows.push({ id:'supporter_note', kind:'base', sort_order:150, enabled:true, subject:'supporter',
    definition:{ type:'text', q:'당신의 추가적인 마음은 어떤가요?' } });
  let state = createIntake(createQuestionSet(rows));
  state = answerIntake(state, { question_id:'name', text:'지수' });
  assert.equal(buildContext(state).question_candidates.find(q => q.id === 'supporter_note').subject, 'supporter');
  state = answerIntake(state, { question_id:'supporter_note', text:'나는 친구의 일로 걱정이 많아요.' });
  assert.equal(buildContext(state).supporter.fields.supporter_note.text, '나는 친구의 일로 걱정이 많아요.');
  assert.equal(buildContext(state).patient.fields.supporter_note, undefined);
});

test('legacy encrypted intakes without a question snapshot keep the original flow', () => {
  const state = createIntake(); delete state.questionSet;
  const next = answerIntake(state, { question_id:'name', text:'지수' });
  assert.equal(currentView(next).question.id, 'want');
  assert.equal(buildContext(next).question_set_version, initialQuestionSet.version);
});

test('invalid DB rules, types, option metadata and empty catalogs are rejected without code execution', () => {
  assert.throws(() => createQuestionSet([]), { code:'QUESTION_BANK_INVALID' });
  for (const change of [
    row => { row.definition.when = 'process.exit()'; },
    row => { row.definition.when = { unknown:'name' }; },
    row => { row.definition.type = 'script'; },
    row => { row.definition.follow_up.merge = 'eval'; },
    row => { row.id = '__proto__'; },
  ]) {
    const rows = structuredClone(initialQuestionRows); change(rows[0]);
    assert.throws(() => createQuestionSet(rows), { code:'QUESTION_BANK_INVALID' });
  }
  const rows = structuredClone(initialQuestionRows);
  rows.find(q => q.id === 'rel').definition.opts = [['보기',{ execute:'anything' }]];
  assert.throws(() => createQuestionSet(rows), { code:'QUESTION_BANK_INVALID' });
  assert.equal(conditionMatches({ all:[{tag:'x'},{not:{tag:'y'}}] }, { tags:['x'],ans:{} }), true);
});

test('condition dependencies must exist before their question and selected labels must still exist', () => {
  for (const edit of [
    rows => rows.splice(rows.findIndex(q => q.id === 'cause'), 1),
    rows => { rows.find(q => q.id === 'cause').enabled = false; },
    rows => { rows.find(q => q.id === 'events').sort_order = 50; },
    rows => { rows.find(q => q.id === 'cause').definition.opts = ['아니요']; },
    rows => { rows.find(q => q.id === 'contact').enabled = false; },
  ]) {
    const rows = structuredClone(initialQuestionRows); edit(rows);
    assert.throws(() => createQuestionSet(rows), { code:'QUESTION_BANK_INVALID' });
  }
});

test('selected conditions bind labels after option reordering', () => {
  const rows = structuredClone(initialQuestionRows);
  rows.find(q => q.id === 'cause').definition.opts.reverse();
  const set = createQuestionSet(rows);
  const condition = set.questions.find(q => q.id === 'events').when;
  assert.equal(conditionMatches(condition, { questionSet:set, tags:[],ans:{ cause:{sel:[0]} } }), false);
  assert.equal(conditionMatches(condition, { questionSet:set, tags:[],ans:{ cause:{sel:[1]} } }), true);
});

test('new DB branch gates cannot be automatically skipped based on earlier free text', () => {
  const rows = structuredClone(initialQuestionRows);
  rows.push({ id:'experience_gate',kind:'base',sort_order:125,enabled:true,subject:'patient',
    definition:{type:'one',required:true,q:'최근 관련 경험이 있나요?',opts:['네','아니요']} });
  rows.push({ id:'experience_detail',kind:'base',sort_order:150,enabled:true,subject:'patient',
    definition:{type:'text',q:'그 경험을 알려 주세요.',when:{selected:{question_id:'experience_gate',option:'네'}}} });
  const state = answerIntake(createIntake(createQuestionSet(rows)), {question_id:'name',text:'최근 이별한 동생 지수'});
  assert.equal(buildContext(state).question_candidates.some(q => q.id === 'experience_gate'), false);
  assert.throws(() => applyModelUpdate(state, { patient_state:{},name_index:null,question_plan:{skip:[{
    question_id:'experience_gate',reason:'already_covered',explanation:'이름 답변에 경험이 있습니다.',
    evidence:[{subject:'patient',question_id:'name',quote:'최근 이별'}],
  }]}}), {code:'MODEL_INVALID_RESPONSE'});
});

test('identity and supplemental observations cannot be assigned to the supporter', () => {
  for (const id of ['name','gap_obs']) {
    const rows = structuredClone(initialQuestionRows);
    rows.find(q => q.id === id).subject = 'supporter';
    assert.throws(() => createQuestionSet(rows), {code:'QUESTION_BANK_INVALID'});
  }
});
