import test from 'node:test';
import assert from 'node:assert/strict';
import {contextGoal} from '../src/agent-state.js';
import {activeQuestionSet} from '../src/question-bank.js';
import {createIntake,currentView,prepareModelAnswer,completeModelAnswer,applyModelUpdate,buildContext,backIntake,discardModelAnswer} from '../src/intake.js';
import {currentReviewedSafety,runRelationshipAgent,safetySnapshotFingerprint,safetySources} from '../src/relationship-agent.js';

const danger='합성 검증 상황에서 지금 다른 사람을 때리는 행동이 계속되고 있어요.';
function pendingAnswer({stop=false}={}) {
  const state=createIntake(activeQuestionSet),q=currentView(state).question;
  return prepareModelAnswer(state,{question_id:q.id,instance_id:q.instance_id,
    ...(stop?{response_event:'stop',text:danger}:{response_event:'answered',custom:danger})},0);
}
function proposal(state,extra={}) {
  const context=buildContext(state),source=safetySources(context).find(x=>x.question_id==='q3_01'&&x.subject==='supporter');
  assert.ok(source);
  const ref={subject:source.subject,question_id:source.question_id,quote:source.components[0].text};
  const facts=context.supporter.fields.q3_01.status==='answered'?[{...ref,interpretation:'이용자의 보고',certainty:'reported'}]:[];
  return {patient_state:{summary:'합성 보고',facts,unknowns:[],user_goal:contextGoal(context)},name_index:null,question_plan:{skip:[]},
    state_agent:{mode:'single_call',reviewed:false,stages:['turn_draft']},finish_early:true,
    safety_signal:{urgent:true,evidence:[{subject:source.subject,question_id:source.question_id,quote:source.components[0].text}]},...extra};
}
function ready(options) {
  const pending=pendingAnswer(options);
  return completeModelAnswer(pending,proposal(pending));
}

test('urgent proposal commits one answer, ends questions, and requires independent safety review without approval',()=>{
  const pending=pendingAnswer(),original=structuredClone(pending),state=completeModelAnswer(pending,proposal(pending));
  assert.deepEqual(pending,original);
  assert.equal(state.modelPending,undefined);assert.equal(state.status,'ready');
  assert.equal(state.safetySignal,undefined);assert.equal(state.safetyReviewPending.urgent,true);
  assert.equal(state.safetyReviewPending.review,undefined);
  assert.equal(state.agentStateExecution.reviewed,false);
  assert.equal(Object.keys(state.ans).length,1);
  assert.match(state.log.at(-1).text,/지금 즉각적인 위험이 있다면/);
  const view=currentView(state);assert.equal(view.safety_urgent,false);assert.equal(view.safety_review_pending,true);
  const context=buildContext(state);
  assert.equal(context.safety_signal,undefined);assert.equal(currentReviewedSafety(context),null);
  assert.equal(context.safety_review_required,true);assert.equal(context.safety_review_pending,true);
  assert.equal(state.safetyReviewPending.source_snapshot,safetySnapshotFingerprint(context));
});

test('provisional urgency does not accept invented evidence or stale source binding',()=>{
  const pending=pendingAnswer();
  const bad=proposal(pending);bad.safety_signal.evidence[0].quote='원문에 없는 표현';
  assert.throws(()=>completeModelAnswer(pending,bad),{code:'MODEL_INVALID_RESPONSE'});
  const stale=proposal(pending);stale.safety_signal.source_snapshot='old';
  assert.throws(()=>completeModelAnswer(pending,stale),{code:'MODEL_INVALID_RESPONSE'});
  assert.throws(()=>completeModelAnswer(pending,proposal(pending,{finish_early:false})),{code:'MODEL_INVALID_RESPONSE'});
});

test('non single-call urgent output still requires independently approved metadata',()=>{
  const pending=pendingAnswer(),output=proposal(pending);delete output.state_agent;
  assert.throws(()=>completeModelAnswer(pending,output),{code:'MODEL_INVALID_RESPONSE'});
});

for(const stop of [false,true])for(const urgent of [false,true])test(`final review independently resolves provisional danger (stop=${stop}, urgent=${urgent})`,async()=>{
  const state=ready({stop}),context=buildContext(state),stages=[];let reviewed;
  const reachedAnalysis=new Error('reached independent final analysis');
  const gateway={async agentComplete(stage,prompt,data,schema,operation,validate){
    stages.push(stage);
    if(stage==='safety_review_final') {
      reviewed=validate({basis:urgent?'current_physical_danger':'unclear',reason:'합성 원문 전체를 독립적으로 대조했습니다.',
        evidence_ids:urgent?[safetySources(context).find(x=>x.question_id==='q3_01'&&x.subject==='supporter').id]:[]});
      return reviewed;
    }
    assert.equal(data.reviewed_safety.urgent,urgent);
    assert.equal(data.reviewed_safety.source_snapshot,safetySnapshotFingerprint(context));
    throw reachedAnalysis;
  }};
  if(stop&&!urgent) {
    await assert.rejects(runRelationshipAgent(gateway,context,state.agentMemory,null,{}),error=>{
      assert.equal(error.code,'INTAKE_STOPPED');assert.equal(error.status,409);
      assert.deepEqual(error.reviewedSafety,reviewed);
      assert.equal(Object.keys(error).includes('reviewedSafety'),false);
      return true;
    });
    assert.deepEqual(stages,['safety_review_final']);
  } else {
    await assert.rejects(runRelationshipAgent(gateway,context,state.agentMemory,null,{}),error=>error===reachedAnalysis);
    assert.equal(stages[0],'safety_review_final');assert.equal(stages.length,2);
  }
  // This is the same final safety persistence boundary used after full guide approval.
  const persisted=applyModelUpdate(state,{patient_state:state.agentMemory,name_index:null,question_plan:{skip:[]},safety_signal:reviewed});
  assert.equal(persisted.safetyReviewPending,undefined);assert.equal(persisted.safetySignal.urgent,urgent);
  assert.equal(buildContext(persisted).safety_review_required,undefined);
  assert.equal(currentReviewedSafety(buildContext(persisted)).urgent,urgent);
});

test('changed sources cannot reuse pending danger and normal back invalidates its marker',()=>{
  const state=ready();
  state.ans.q3_01.rawText='정정된 합성 보고';state.ans.q3_01.text='정정된 합성 보고';state.ans.q3_01.custom='정정된 합성 보고';
  const stale=buildContext(state);assert.equal(stale.safety_signal,undefined);
  assert.equal(stale.safety_review_required,true);assert.equal(stale.safety_review_pending,undefined);
  // As with independently approved urgent state, reopening is an explicit correction.
  const reopened=ready();reopened.status='active';
  const back=backIntake(reopened);
  assert.equal(back.safetyReviewPending,undefined);assert.equal(buildContext(back).safety_review_pending,undefined);
  assert.equal(buildContext(back).safety_review_required,undefined);
});

test('discarding an uncommitted source change does not retain provisional safety',()=>{
  const state=pendingAnswer();state.safetyReviewPending={urgent:true,evidence:[],source_snapshot:'old'};
  const discarded=discardModelAnswer(state);
  assert.equal(discarded.safetyReviewPending,undefined);assert.equal(discarded.modelPending,undefined);
  const stopped=pendingAnswer({stop:true});stopped.modelPending.prepared.safetyReviewPending={urgent:true,evidence:[],source_snapshot:'old'};
  const stoppedDiscarded=discardModelAnswer(stopped);
  assert.equal(stoppedDiscarded.safetyReviewPending,undefined);assert.equal(stoppedDiscarded.v3.stopped,true);
});
