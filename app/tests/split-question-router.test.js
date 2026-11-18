import test from 'node:test';
import assert from 'node:assert/strict';
import { activeQuestionSet } from '../src/question-bank.js';
import { ModelGateway } from '../src/model.js';
import {
  applyModelUpdate, backIntake, buildContext, completeSplitModelAnswer, createIntake,
  currentView, prepareModelAnswer, splitQuestionPreflight,
} from '../src/intake.js';
import { splitQuestionRequest, validateSplitQuestion } from '../src/split-question-router.js';

function splitIntake() {
  return {...createIntake(activeQuestionSet),resultModelProfileId:'gpu31b'};
}

function submit(state, input) {
  const question=currentView(state).question;
  const answer=typeof input==='string'?(question.type==='text'?{text:input}:{custom:input}):input;
  return prepareModelAnswer(state,{question_id:question.id,instance_id:question.instance_id,
    follow_up:Boolean(question.follow_up),...answer},state.v3.input_revision);
}

function route(pending, wire) {
  return validateSplitQuestion(wire,buildContext(pending));
}

const goal='친구의 발표 도입에 의견을 주면서 제 일정도 지킬 말을 만들고 싶어요.';
const finish={action:'finish'};

test('split interview stores the purpose immediately and never creates a reply for unasked fields',()=>{
  const pending=submit(splitIntake(),goal),context=buildContext(pending),request=splitQuestionRequest(context);
  assert.equal(currentView(pending).question.id,'q3_01');
  assert.equal(context.supporter.fields.q3_01.rawText,goal);
  assert.equal(request.data.latest.id,'q3_01');
  assert.equal(request.data.candidates.some(row=>row.id==='q3_02'),false);
  assert.equal(request.data.candidates.some(row=>row.id==='q3_03'),false);
  assert.equal(request.data.candidates.some(row=>row.id==='q3_08'),false);
  assert.equal(request.data.draft_context_complete,true);
  assert.equal(splitQuestionPreflight(pending),null);
  const state=completeSplitModelAnswer(pending,route(pending,finish));
  assert.equal(state.status,'ready');
  assert.equal(currentView(state).question,null);
  assert.equal(currentView(state).canGoBack,true);
  assert.deepEqual(Object.keys(state.v3.issued),['q3_01']);
  assert.equal(buildContext(state).patient.fields.q3_03.status,'not_asked');
  assert.equal(state.modelPending,undefined);
  assert.deepEqual(state.modelSkipped,{});
  const withResult=applyModelUpdate(state,{patient_state:null,name_index:null,question_plan:{skip:[]}});
  assert.equal(withResult.status,'ready');
  assert.equal(currentView(withResult).question,null);
  const edit=backIntake(state);
  assert.equal(edit.status,'active');
  assert.equal(currentView(edit).question.id,'q3_01');
  const edited=submit(edit,'발표가 아니라 과제라서 짧게 도움을 주고 싶어요.');
  assert.equal(buildContext(edited).supporter.fields.q3_01.source_revision,2);
  assert.equal(buildContext(edited).supporter.fields.q3_01.rawText,'발표가 아니라 과제라서 짧게 도움을 주고 싶어요.');
});

test('a selected bank question is shown once even during correction and stays the existing question',()=>{
  const pending=submit(splitIntake(),'부담되는 부탁을 거절할 말을 준비하고 싶어요.');
  const next=route(pending,{action:'existing',question_id:'q3_03',source_id:'s1',quote:'부담되는 부탁',why:'거절할 부탁의 범위가 필요해요.'});
  const state=completeSplitModelAnswer(pending,next);
  assert.equal(currentView(state).question.id,'q3_03');
  assert.match(currentView(state).question.q,/이번에 다루고 싶은 일은 누구와의 어떤 일인가요/u);
  const editing=backIntake(state);
  const corrected=submit(editing,'동료가 주말 자료 정리를 부탁해서 일부만 돕는 말을 만들고 싶어요.');
  const candidates=splitQuestionRequest(buildContext(corrected)).data.candidates.map(row=>row.id);
  assert.equal(candidates.includes('q3_01'),false);
  assert.equal(candidates.includes('q3_02'),false);
  assert.equal(candidates.includes('q3_03'),false);
  assert.throws(()=>route(corrected,{action:'existing',question_id:'q3_03',source_id:'s1',quote:'주말 자료',why:'범위를 확인해요.'}),
    {code:'MODEL_INVALID_RESPONSE'});
});

test('a purpose alone leads to the situation question in a fresh intake',()=>{
  for (const input of [{selected:[3]},'상황을 정리하고 싶어요.']) {
    const pending=submit(splitIntake(),input);
    const next=completeSplitModelAnswer(pending,splitQuestionPreflight(pending));
    assert.equal(currentView(next).question.id,'q3_03');
    assert.equal(next.status,'active');
  }
  assert.equal(splitQuestionPreflight(submit(splitIntake(),'상황을 정리하고 싶어요. 어제 친구와 말다툼했어요.')),null);
});

test('one custom question must cite a literal contiguous quote at the current source revision',()=>{
  const pending=submit(splitIntake(),'🙂 '+goal);
  const wire={action:'custom',subject:'supporter',focus:'support',question:'발표 도입을 보는 데 어느 정도 시간을 쓰실 수 있나요?',
    source_id:'s1',quote:'제 일정도 지킬',why:'도울 시간을 문장에 넣기 위해 필요해요.'};
  const decision=route(pending,wire);
  assert.equal(decision.decision.source_question_id,'q3_01');
  assert.equal(decision.decision.source_revision,1);
  assert.equal(decision.decision.quote_start,Array.from('🙂 친구의 발표 도입에 의견을 주면서 ').length);
  for(const change of [{quote:'일정도 지켜야 해서'},{source_id:'s17'},{focus:'relationship'},{question:'어떤가요? 가능할까요?'}]) {
    assert.throws(()=>route(pending,{...wire,...change}),{code:'MODEL_INVALID_RESPONSE'});
  }
  const state=completeSplitModelAnswer(pending,decision);
  assert.equal(currentView(state).question.q,wire.question);
  assert.equal(currentView(state).pendingFollow,true);
  const next=submit(state,'20분은 가능해요.');
  assert.equal(splitQuestionRequest(buildContext(next)).data.latest.id,'q3_personal_01');
  const finished=completeSplitModelAnswer(next,route(next,finish));
  assert.equal(buildContext(finished).supporter.fields.q3_personal_01.rawText,'20분은 가능해요.');
  const back=backIntake(finished);
  assert.equal(currentView(back).question.id,'q3_personal_01');
  assert.equal(currentView(back).pendingFollow,true);
});

test('the question request is bounded and validates exact offsets in a retained suffix',()=>{
  const long='🙂'.repeat(2000)+'마지막에 시간을 확인하기로 했어요.';
  const pending=submit(splitIntake(),long),request=splitQuestionRequest(buildContext(pending));
  assert.equal(request.data.sources.length,2);
  assert.equal(request.data.sources.flatMap(row=>Array.from(row.text)).length,1000);
  assert.equal(request.data.sources[1].text.endsWith('마지막에 시간을 확인하기로 했어요.'),true);
  const wire={action:'existing',question_id:'q3_08',source_id:'s2',quote:'마지막에 시간을 확인하기로 했어요.',why:'가능한 시간을 확인해야 해요.'};
  assert.equal(route(pending,wire).decision.quote_start,2000);
  assert.throws(()=>route(pending,{...wire,source_id:'s1'}),{code:'MODEL_INVALID_RESPONSE'});
});

test('stop, help replay and the four-question cap bypass the router',()=>{
  let pending=submit(splitIntake(),{response_event:'stop'});
  assert.deepEqual(splitQuestionPreflight(pending),finish);
  assert.equal(currentView(completeSplitModelAnswer(pending,finish)).user_stopped,true);

  pending=submit(splitIntake(),{response_event:'not_understood'});
  const help=splitQuestionPreflight(pending);
  assert.deepEqual(help,{action:'help'});
  const state=completeSplitModelAnswer(pending,help);
  assert.equal(currentView(state).question.id,'q3_01');
  assert.equal(state.v3.issued.q3_01.help_displays,1);
  assert.equal(Object.hasOwn(state.ans,'q3_01'),false);

  let longer=splitIntake();
  for(const [id,answer] of [['q3_03','애매한 부탁을 거절하고 싶어요.'],['q3_04','주말 근무를 요청받았어요.'],['q3_05','아직 분명한 말은 못 들었어요.']]){
    pending=submit(longer,answer);
    longer=completeSplitModelAnswer(pending,route(pending,{action:'existing',question_id:id,source_id:'s1',
      quote:answer,why:'어떤 범위에서 거절할지 확인해요.'}));
  }
  pending=submit(longer,{selected:[0]});
  assert.deepEqual(splitQuestionPreflight(pending),finish);
  assert.equal(Object.keys(completeSplitModelAnswer(pending,finish).v3.issued).length,4);
});

test('explicit immediate danger interrupts locally and remains provisional for final independent review',()=>{
  const report='지금 다른 사람을 때리는 행동이 계속되고 있어요.';
  for(const input of [report,{text:report,response_event:'stop'}]){
    const pending=submit(splitIntake(),input);
    const safety=splitQuestionPreflight(pending);
    assert.equal(safety.action,'urgent');
    const state=completeSplitModelAnswer(pending,safety);
    assert.match(state.log.at(-1).text,/즉각적인 위험/u);
    assert.equal(state.safetySignal,undefined);
    assert.equal(buildContext(state).safety_review_pending,true);
    assert.equal(state.status,'ready');
    assert.equal(currentView(state).question,null);
  }
  const negated=submit(splitIntake(),report+' 연극 대사였고 현재 위험은 없어요.');
  assert.equal(splitQuestionPreflight(negated),null);
});

test('question gateway uses one short inference POST without discovery or repair',async()=>{
  const pending=submit(splitIntake(),goal),context=buildContext(pending),calls=[];
  let output=finish;
  const gateway=new ModelGateway({baseUrl:'http://127.0.0.1:9999/v1',model:'synthetic-router',apiKey:'fake-key',
    protocol:'relationship_agent',discoverTokenLimits:true,retryFailures:true,diagnosticLogger:null,
    fetchImpl:async(url,options)=>{
      calls.push({url,method:options.method,body:JSON.parse(options.body)});
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
    }});
  assert.deepEqual(await gateway.routeQuestion(context),finish);
  assert.equal(calls.length,1);
  const [{url,method,body}]=calls;
  assert.match(url,/\/chat\/completions$/u);
  assert.equal(method,'POST');
  assert.equal(body.max_tokens,320);
  assert.equal(body.messages.length,2);
  assert.ok(body.messages.map(row=>row.content).join('').length<3200);
  assert.doesNotMatch(body.messages[1].content,/patient_state|relationship_memory|evidence_sources|output_schema/u);
  output={action:'finish',skip:[]};
  await assert.rejects(gateway.routeQuestion(context),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(calls.length,2);
});
