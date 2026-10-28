import {safetyReviewFixture} from './helpers/safety-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runCombinedRelationshipState} from '../src/relationship-turn.js';
import {canonicalRelationshipMemory,currentRelationshipMemory,validateRelationshipMemory,
  relationshipStateRequest,relationshipQuestionRequest,runRelationshipAgent} from '../src/relationship-agent.js';
import {createIntake,buildContext,applyModelUpdate} from '../src/intake.js';

function fixture(count=4,subject='patient') {
  const ids=subject==='patient'?['mood','burden','support','describe','concern','values','extra']:
    ['moment','feeling','moment_freq','cgchange','mycoping','mysupport','cgchange_more'];
  const texts=ids.map((id,index)=>`${index+1}번째 원문 보고예요. 예전 추측과 지금 확인한 사실은 달라요.`);
  const state=createIntake();state.name='지민';
  for(const [id,text]of [['name','지민'],['rel','친구'],['want','이야기를 듣고 싶어요.'],...ids.map((id,index)=>[id,texts[index]])])
    state.ans[id]={text,rawText:text,custom:'',sel:[]};
  const ctx=buildContext(state),latest=ids[count-1];ctx.latest_answer={subject,question_id:latest};
  const ref=id=>({subject,question_id:id,quote:ctx[subject].fields[id].rawText});
  const refs=ids.slice(0,count).map(ref),hypothesis={certainty:'tentative',
    interpretation:'가능한 해석: 지금 필요한 도움의 범위를 더 확인할 필요가 있을 수 있어요.',evidence:[refs[0]]};
  const value={state:{patient_state:{facts:[{...refs.at(-1),certainty:'reported'}],unknowns:[]},name_index:null,
    relationship_memory:{patient:[],supporter:[],relationship:[],unknowns:[]}},
    questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}};
  value.state.relationship_memory[subject]=count===4?[{certainty:'reported',evidence:refs.slice(0,3)},hypothesis]:
    [{certainty:'reported',evidence:refs.slice(0,3)},{certainty:'reported',evidence:refs.slice(3)},hypothesis];
  return {state,ctx,value,subject,ids,refs,hypothesis,ref};
}
const approve=data=>data.safety_sources?safetyReviewFixture(data):({state:{approved:true,issues:[],audits:data.review_target.claims.map(claim=>({id:claim.id,
  verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문 전체 대조'}))},questions:null,safety:null});
function gateway(f,review=approve) {
  const calls=[];
  return {calls,async agentComplete(stage,prompt,data,schema,operation,validate){
    calls.push({stage,prompt,data,schema});return validate(stage.startsWith('turn_draft')?f.value:stage.startsWith('safety_review')?safetyReviewFixture(data):review(data));
  }};
}

for(const subject of ['patient','supporter'])for(const count of [4,6])test(`server retains ${count} literal references and the hypothesis: ${subject}`,async()=>{
  const f=fixture(count,subject),before=structuredClone(f.value),ctxBefore=structuredClone(f.ctx),model=gateway(f);
  const output=await runCombinedRelationshipState(model,f.ctx,null,{}),rows=output.relationship_memory[subject];
  assert.equal(rows.length,2);assert.equal(rows[0].evidence.length,count);
  for(const ref of f.refs)assert.ok(rows[0].evidence.some(next=>JSON.stringify(next)===JSON.stringify(ref)));
  assert.deepEqual(rows[1],f.hypothesis);assert.deepEqual(f.value,before);assert.deepEqual(f.ctx,ctxBefore);
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review','safety_review']);
  assert.deepEqual(model.calls[1].data.review_target.claims[0].evidence,rows[0].evidence);
  assert.deepEqual(model.calls[1].data.review_target.claims[1].evidence,f.hypothesis.evidence);
  const schema=model.calls[0].schema.properties.state.properties.relationship_memory.properties[subject];
  assert.equal(schema.maxItems,2);
  for(const branch of schema.items.anyOf)assert.equal(branch.properties.evidence.maxItems,3);
  assert.deepEqual(validateRelationshipMemory(output.relationship_memory,f.ctx),output.relationship_memory);
});

test('a model cannot directly generate a four-reference reported finding',async()=>{
  const f=fixture();f.value.state.relationship_memory.patient[0].evidence=f.refs;
  const before=structuredClone(f.value),model=gateway(f);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{modelReason:'agent_schema'});
  assert.deepEqual(f.value,before);assert.equal(model.calls.length,1);
});

for(const [name,change]of [
  ['seven reported references',(memory,f)=>{memory.patient[0].evidence.push(f.ref('extra'));}],
  ['four tentative references',(memory,f)=>{memory.patient[1].evidence=f.refs.slice(0,4);}],
  ['four relationship references',(memory,f)=>{memory.relationship=[{...f.hypothesis,evidence:f.refs.slice(0,4)}];}],
  ['wrong subject',(memory,f)=>{memory.patient[0].evidence[0].subject='supporter';}],
  ['invented quote',(memory,f)=>{memory.patient[0].evidence[0].quote='원문에 없던 내용';}],
  ['free interpretation',(memory,f)=>{memory.patient[0].interpretation='새로 만든 자유 요약입니다.';}],
])test('stored extended memory rejects '+name,async()=>{
  const f=fixture(6),output=await runCombinedRelationshipState(gateway(f),f.ctx,null,{});
  const memory=structuredClone(output.relationship_memory);change(memory,f);
  assert.throws(()=>validateRelationshipMemory(memory,f.ctx),{code:'MODEL_INVALID_RESPONSE'});
  assert.throws(()=>canonicalRelationshipMemory(memory,f.ctx),{code:'MODEL_INVALID_RESPONSE'});
});

test('legacy three-reference report text remains readable and is canonicalized normally',()=>{
  const f=fixture(),memory=structuredClone(f.value.state.relationship_memory);
  memory.patient[0].interpretation='이용자가 전한 기존 보고입니다.';
  assert.doesNotThrow(()=>validateRelationshipMemory(memory,f.ctx));
  const canonical=canonicalRelationshipMemory(memory,f.ctx);
  assert.notEqual(canonical.patient[0].interpretation,memory.patient[0].interpretation);
  assert.deepEqual(canonical.patient[0].evidence,memory.patient[0].evidence);
});

test('storage, next-turn retrieval and final analysis preserve the complete extended memory and raw answers',async()=>{
  const f=fixture(6),output=await runCombinedRelationshipState(gateway(f),f.ctx,null,{});
  const stored=applyModelUpdate(f.state,output),context=buildContext(stored);
  assert.deepEqual(stored.agentRelationshipMemory,output.relationship_memory);
  assert.deepEqual(currentRelationshipMemory(context),output.relationship_memory);
  const assertSources=(data,retrieval)=>{
    assert.deepEqual(data.prior_relationship_memory,output.relationship_memory);
    for(const ref of f.refs) {
      assert.ok(data.patient.find(row=>row.question_id===ref.question_id).answers.some(answer=>answer.text===ref.quote));
      assert.ok(retrieval.documents.some(document=>document.subject===ref.subject&&document.question_id===ref.question_id&&document.text===ref.quote));
    }
  };
  for(const request of [relationshipStateRequest(context,context.agent_state),relationshipQuestionRequest(context)])assertSources(request.data,request.retrieval);
  const stages=[],stop=new Error('Captured final analysis and independent review');
  const finalGateway={async agentComplete(stage,prompt,data,schema,operation,validate){
    stages.push(stage);assertSources(stage==='relationship_analysis'?data:data.answers,data.retrieval);
    if(stage==='analysis_review')throw stop;
    assert.equal(stage,'relationship_analysis');
    // Final generation limits are still the original two observations and three
    // references per finding, regardless of the larger validated prior memory.
    assert.equal(schema.properties.observations.properties.patient.maxItems,2);
    assert.equal(schema.properties.relationship.properties.dynamics.items.properties.evidence.maxItems,3);
    return validate({observations:{patient:[f.refs[0]],supporter:[]},
      relationship:{label:'친구',supporter_role:'친구',dynamics:[],strengths:[],boundaries:[]},unknowns:[],safety:{urgent:false,evidence_ids:[]}});
  }};
  await assert.rejects(runRelationshipAgent(finalGateway,context,context.agent_state,null,{}),error=>error===stop);
  assert.deepEqual(stages,['relationship_analysis','analysis_review']);
});

test('all retained reports still need supported independent audits',async()=>{
  const f=fixture(6),model=gateway(f,data=>{const result=approve(data);result.state.audits.shift();return result;});
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{code:'MODEL_INVALID_RESPONSE'});
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review']);
});
