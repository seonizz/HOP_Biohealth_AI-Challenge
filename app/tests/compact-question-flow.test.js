import test from 'node:test';
import assert from 'node:assert/strict';
import {activeQuestionSet} from '../src/question-bank.js';
import {createIntake,currentView,buildContext,prepareModelAnswer,completeModelAnswer,discardModelAnswer,backIntake,answerIntake} from '../src/intake.js';

const start=()=>createIntake(activeQuestionSet);
const model=extra=>({name_index:null,patient_state:{},question_plan:{skip:[]},...extra});
function pending(state,text='일정을 거절하는 말을 쓰고 싶어요.',extra={}) {
 const q=currentView(state).question;
 return prepareModelAnswer(state,{question_id:q.id,instance_id:q.instance_id,follow_up:Boolean(q.follow_up),
  ...(q.type==='text'?{text}:{custom:text}),...extra},state.v3.input_revision);
}
const finish=(prepared,extra={})=>completeModelAnswer(prepared,model(extra));
const step=(state,text,extra={})=>finish(pending(state,text),extra);
function next(prepared,id,{kind='next',question=null,focus=null}={}) {
 const context=buildContext(prepared),field=context.supporter.fields.q3_01;
 return {kind,question_id:id,subject:id?activeQuestionSet.questions.find(q=>q.id===id).subject:'patient',
  source_question_id:'q3_01',source_revision:field.source_revision,component:'rawText',quote:field.rawText,
  quote_start:0,quote_end:Array.from(field.rawText).length,question,focus,
  reason:'제안에 넣을 실제 가능한 시간을 아직 몰라 행동 선택에 필요한 범위를 확인해요.'};
}
function scenePending(){return pending(step(start()),'친구가 내일 이사를 도와 달라고 했지만 일 때문에 어렵습니다.');}

test('new conversations ask purpose then scene and finish after two with no optional decision',()=>{
 const initial=start();assert.deepEqual(initial.questionSet,activeQuestionSet);
 assert.equal(currentView(initial).question.id,'q3_01');
 const scene=step(initial);assert.equal(currentView(scene).question.id,'q3_03');
 const prepared=pending(scene,'친구의 이사 도움 요청을 거절하고 싶어요.');
 assert.ok(buildContext(prepared).question_candidates.some(q=>q.id==='q3_08'),'ready preparation retains candidates for essential decisions');
 const final=finish(prepared);assert.equal(final.status,'ready');assert.equal(currentView(final).question,null);
 assert.deepEqual(Object.keys(final.v3.issued),['q3_01','q3_03']);
 assert.equal(buildContext(final).patient.fields.q3_02.status,'not_asked');
 assert.equal(buildContext(final).supporter.fields.q3_08.status,'not_asked');
 assert.deepEqual(final.modelSkipped,{});assert.equal(buildContext(final).payload.answers.length,2);
 const policy=buildContext(final).question_policy.compact_flow;
 assert.equal(policy.target_questions,4);assert.equal(policy.issued_questions,2);assert.equal(policy.essential_only,true);
});

test('an optional decision cannot preempt the core scene or consume a hidden question slot',()=>{
 for(const kind of ['next','follow_up']) {
  const prepared=pending(start());const choice=kind==='next'?next(prepared,'q3_08'):next(prepared,null,{kind,question:'다른 날짜에 가능한 시간이 있나요?',focus:'support'});
  const state=finish(prepared,{personalization:choice});
  assert.equal(currentView(state).question.id,'q3_03');
  assert.deepEqual(Object.keys(state.v3.issued),['q3_01','q3_03']);
  assert.deepEqual(state.v3.personalization.presentations,{});assert.deepEqual(state.v3.personalization.questions,{});
 }
});

test('a scene already covered by the first answer is skipped with its genuine evidence',()=>{
 const text='친구가 내일 이사를 도와 달라고 했지만 일 때문에 어려워 거절하고 싶어요.',prepared=pending(start(),text);
 const skip={question_id:'q3_03',reason:'already_covered',explanation:'앞선 답변에 친구의 이사 요청과 거절하려는 상황을 직접 밝혔어요.',
  evidence:[{subject:'supporter',question_id:'q3_01',quote:text}]};
 const state=finish(prepared,{question_plan:{skip:[skip]}});
 assert.equal(state.status,'ready');assert.deepEqual(Object.keys(state.v3.issued),['q3_01']);
 assert.equal(buildContext(state).patient.fields.q3_03.status,'auto_skipped');assert.equal(state.ans.q3_03,undefined);
});

test('one or two essential decisions yield three or four prompts, with no sequential bank fallback',()=>{
 for(const ids of [['q3_08'],['q3_08','q3_09']]) {
  let prepared=scenePending(),state;
  for(const id of ids){state=finish(prepared,{personalization:next(prepared,id)});assert.equal(currentView(state).question.id,id);prepared=pending(state,'주말에 한 시간은 가능하고 그 범위만 제안하고 싶어요.');}
  state=finish(prepared);assert.equal(state.status,'ready');
  assert.deepEqual(Object.keys(state.v3.issued),['q3_01','q3_03',...ids]);
  assert.equal(state.ans.q3_02,undefined);assert.ok(buildContext(state).payload.answers.every(a=>!a.skipped));
 }
});

test('an essential fifth question is permitted and the model sees the exceeded four-question target',()=>{
 let prepared=scenePending();
 for(const id of ['q3_08','q3_09','q3_07']){
  const state=finish(prepared,{personalization:next(prepared,id)});prepared=pending(state,'상대가 직접 부탁한 범위만 도우려 합니다.');
 }
 assert.equal(buildContext(prepared).question_policy.compact_flow.issued_questions,5);
 const final=finish(prepared);assert.equal(final.status,'ready');assert.equal(Object.keys(final.v3.issued).length,5);
});

test('unknown or refusal is retained and does not trigger an automatic replacement question',()=>{
 for(const response_event of ['unknown','refused','skipped']){
  const prepared=scenePending();const state=finish(prepared,{personalization:next(prepared,'q3_08')});
  const final=finish(pending(state,'',{response_event}));assert.equal(final.status,'ready');
  assert.equal(final.ans.q3_08.response_event,response_event);assert.equal(Object.keys(final.v3.issued).length,3);
 }
});

test('help, failed-model discard and retry retain the same visible question and budget',()=>{
 const state=start(),prepared=pending(state);
 assert.equal(currentView(prepared).question.id,'q3_01');assert.equal(currentView(discardModelAnswer(prepared)).question.id,'q3_01');
 assert.deepEqual(finish(prepared),finish(prepared));assert.deepEqual(Object.keys(prepared.v3.issued),['q3_01']);
 const help=finish(pending(state,'',{response_event:'not_understood'}));
 assert.equal(currentView(help).question.id,'q3_01');assert.equal(Object.keys(help.v3.issued).length,1);
 const again=finish(pending(help,'',{response_event:'not_understood'}));assert.equal(currentView(again).question.id,'q3_03');
});

test('correction resumes an already displayed unanswered optional question without duplicating it',()=>{
 const state=finish(scenePending(),{personalization:next(scenePending(),'q3_08')});
 const editing=backIntake(state);assert.equal(currentView(editing).question.id,'q3_03');
 const corrected=step(editing,'친구가 다음 주 이사 도움을 요청했다고 정정할게요.');
 assert.equal(currentView(corrected).question.id,'q3_08');
 assert.deepEqual(Object.keys(corrected.v3.issued),['q3_01','q3_03','q3_08']);
 assert.equal(step(corrected,'한 시간만 도울 수 있어요.').status,'ready');
});

test('resuming an issued question suppresses competing next, follow-up and Q10 without hidden issuance',()=>{
 for(const kind of ['next','follow_up','clarification']) {
  const initial=scenePending(),state=finish(initial,{personalization:next(initial,'q3_08')});
  const correction=pending(backIntake(state),'친구가 다음 주 이사 도움을 요청했다고 정정할게요.');
  const field=buildContext(correction).supporter.fields.q3_01;
  const decision=kind==='clarification'?{clarification:{source_question_id:field.id,source_revision:field.source_revision,
   component:'rawText',event_id:'request',quote:field.rawText,quote_start:0,quote_end:Array.from(field.rawText).length,
   axis:'modality',role:'',agreement_item_id:''}}
   :{personalization:kind==='next'?next(correction,'q3_09')
    :next(correction,null,{kind,question:'다른 날짜에 가능한 시간이 있나요?',focus:'support'})};
  const resumed=finish(correction,decision);
  assert.equal(currentView(resumed).question.id,'q3_08',kind);
  assert.deepEqual(Object.keys(resumed.v3.issued),['q3_01','q3_03','q3_08'],kind);
  assert.equal(resumed.v3.personalization.presentations.q3_09,undefined,kind);
  assert.deepEqual(resumed.v3.personalization.questions,{},kind);
  assert.equal(resumed.v3.clarification,undefined,kind);
  assert.equal(resumed.fuCount,state.fuCount,kind);
  assert.equal(resumed.v3.compact_flow.selected_question_id,undefined,kind);
  assert.equal(step(resumed,'한 시간은 가능해요.').status,'ready',kind);
 }
});

test('stop and urgent proposals end the compact path without manufacturing safety approval',()=>{
 const stopped=finish(pending(start(),'그만할게요.',{response_event:'stop'}));
 assert.equal(stopped.v3.stopped,true);assert.equal(stopped.status,'ready');assert.equal(Object.keys(stopped.v3.issued).length,1);
 const prepared=pending(start(),'지금 도움이 필요해요.');
 const urgent=finish(prepared,{finish_early:true});assert.equal(urgent.status,'ready');
 assert.equal(urgent.safetySignal,undefined);assert.equal(urgent.ans.q3_03,undefined);
});

test('historical v3 snapshots do not acquire compact flow on resume',()=>{
 const old=start();delete old.v3.compact_flow;
 const resumed=JSON.parse(JSON.stringify(old));
 const after=step(resumed);assert.equal(currentView(after).question.id,'q3_02');assert.equal(after.v3.compact_flow,undefined);
 const plain=answerIntake(start(),{question_id:'q3_01',response_event:'skipped'});
 assert.equal(currentView(plain).question.id,'q3_03');
});


test('unchanged covered scene is not asked again after an optional answer, while a source correction replans it',()=>{
 const text='친구가 내일 이사를 도와 달라고 했지만 일이 있어 거절하려고 해요.',prepared=pending(start(),text);
 const skip={question_id:'q3_03',reason:'already_covered',explanation:'이사 요청과 거절하려는 상황이 원문에 있어요.',evidence:[{subject:'supporter',question_id:'q3_01',quote:text}]};
 const optional=finish(prepared,{question_plan:{skip:[skip]},personalization:next(prepared,'q3_08')});
 assert.equal(currentView(optional).question.id,'q3_08');
 const completed=step(optional,'다른 날에도 도울 여력은 없어요.');
 assert.equal(completed.status,'ready');assert.equal(completed.v3.issued.q3_03,undefined);
 assert.equal(completed.modelSkipped.q3_03.reason,'already_covered');
 const correcting=backIntake(optional);
 const replanned=step(correcting,'다른 문제에 관해 상담하고 싶어요.');
 assert.equal(currentView(replanned).question.id,'q3_03');assert.equal(replanned.modelSkipped.q3_03,undefined);
});

test('Q10 remains one bound axis and one slot after the core scene',()=>{
 const prepared=scenePending(),field=buildContext(prepared).supporter.fields.q3_01;
 const binding={source_question_id:field.id,source_revision:field.source_revision,component:'rawText',event_id:'request',
  quote:field.rawText,quote_start:0,quote_end:Array.from(field.rawText).length,axis:'modality',role:'',agreement_item_id:''};
 const state=finish(prepared,{clarification:binding});assert.equal(currentView(state).question.id,'q3_10');
 const ended=finish(pending(state,'',{response_event:'unknown'}));assert.equal(ended.status,'ready');
 assert.deepEqual(Object.keys(ended.v3.issued),['q3_01','q3_03','q3_10']);
 assert.equal(buildContext(ended).clarification_available,false);assert.equal(ended.clarificationAnswers.q3_10.assignment.value,'unknown');
});
