import test from 'node:test';
import assert from 'node:assert/strict';
import {activeQuestionSet} from '../src/question-bank.js';
import {createIntake,currentView,prepareModelAnswer,completeModelAnswer,buildContext} from '../src/intake.js';
import {safetySources} from '../src/relationship-agent.js';
const text='친구가 동호회 발표를 준비 중이라고 했어요. 제 일정도 지키면서 도울 말을 정리하고 싶어요.';
function pending(input=text,event='answered'){
 const s=createIntake(activeQuestionSet),q=currentView(s).question;
 return prepareModelAnswer(s,{question_id:q.id,instance_id:q.instance_id,response_event:event,text:input,custom:input},0);
}
const output=()=>({patient_state:null,relationship_memory:null,name_index:null,question_plan:{skip:[]},clarification:null,finish_early:false,
 safety_signal:{urgent:false,evidence:[]},state_agent:{mode:'single_call',reviewed:false,memory_deferred:true,prompt_version:'synthetic-question-only-v1',stages:['question_plan']}});

test('deferred state clears stale interpretations and approvals without changing the submitted answer',()=>{
 const state=pending();state.modelPending.prepared.agentMemory={stale:true};state.modelPending.prepared.agentRelationshipMemory={stale:true};
 state.modelPending.prepared.agentStateExecution={name_reuse:{approved:true},safety_reuse:{approved:true}};
 const before=structuredClone(state),result=completeModelAnswer(state,output()),context=buildContext(result);
 assert.deepEqual(state,before);assert.equal(result.agentMemory,undefined);assert.equal(result.agentRelationshipMemory,undefined);
 assert.equal(context.agent_state,null);assert.equal(context.relationship_state,null);assert.equal(context.state_execution,undefined);
 assert.equal(result.agentStateExecution.memory_deferred,true);assert.equal(result.modelPending,undefined);
 assert.equal(context.supporter.fields.q3_01.custom,text);assert.equal(context.supporter.fields.q3_01.status,'answered');
 assert.equal(context.payload.answers.some(row=>row.id==='q3_01'),true);
});
for(const kind of ['false-marker','reviewed','wrong-mode','wrong-stage','missing-null','invented-memory','reused-approval'])test('deferred-state contract rejects '+kind,()=>{
 const value=output();
 if(kind==='false-marker')value.state_agent.memory_deferred=false;
 if(kind==='reviewed')value.state_agent.reviewed=true;
 if(kind==='wrong-mode')value.state_agent.mode='combined';
 if(kind==='wrong-stage')value.state_agent.stages=['turn_draft'];
 if(kind==='missing-null')delete value.relationship_memory;
 if(kind==='invented-memory')value.patient_state={facts:[]};
 if(kind==='reused-approval')value.state_agent.name_reuse={approved:true};
 assert.throws(()=>completeModelAnswer(pending(),value),{code:'MODEL_INVALID_RESPONSE'});
});
test('question-only urgent decision remains provisional and preserves the reported danger',()=>{
 const danger='지금 친구가 심하게 다쳐 피를 흘리고 있다고 제게 말했어요.',state=pending(danger),context=buildContext(state);
 const source=safetySources(context).find(row=>row.subject==='supporter'&&row.question_id==='q3_01'),value=output();
 value.finish_early=true;value.safety_signal={urgent:true,evidence:[{subject:source.subject,question_id:source.question_id,quote:source.components[0].text}]};
 const result=completeModelAnswer(state,value),after=buildContext(result);
 assert.equal(result.status,'ready');assert.equal(result.safetySignal,undefined);assert.equal(result.safetyReviewPending.urgent,true);
 assert.equal(after.safety_review_required,true);assert.equal(after.agent_state,null);assert.equal(after.supporter.fields.q3_01.custom,danger);
});
test('question-only stop remains stopped rather than generating an answer or resuming questions',()=>{
 const result=completeModelAnswer(pending('여기까지 할게요.','stop'),output());
 assert.equal(result.status,'ready');assert.equal(result.v3.stopped,true);assert.equal(buildContext(result).agent_state,null);
});
