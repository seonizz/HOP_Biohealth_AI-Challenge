import {safetyReviewFixture} from './helpers/safety-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runCombinedRelationshipState} from '../src/relationship-turn.js';
import {ModelGateway} from '../src/model.js';

const field=(id,text)=>({id,question:id,text,rawText:text,custom:'',status:'answered'});
function fixture(subject='patient') {
  const ids=subject==='patient'?['mood','concern','support']:['moment','feeling','mysupport'];
  const texts=subject==='patient'?['업무 마감 뒤 피곤하다고 했어요.','업무 연락 때문에 쉬기 어렵다고 했어요.',
    '누나와 통화하면 마음이 편하다고 했어요. 지민이의 도움 관계예요.']:
    ['해결책부터 말해 아쉬웠어요.','친구가 걱정되고 미안했어요.','저는 형에게 제 어려움을 말할 수 있어요. 제 감정만 나누려고 해요.'];
  const ctx={patient:{alias:'지민',fields:{name:field('name','지민'),rel:field('rel','친구')}},supporter:{fields:{}},
    user_goal:{message:field('want','이야기를 듣고 싶어요.')},answered_count:6,latest_answer:{subject,question_id:ids[2]},
    adaptive_questions:true,question_candidates:[],clarification_candidates:[]};
  ids.forEach((id,index)=>{ctx[subject].fields[id]=field(id,texts[index]);});
  const ref=id=>({subject,question_id:id,quote:ctx[subject].fields[id].rawText});
  const full=ref(ids[2]),partial={...full,quote:full.quote.split('. ')[0]+'.'};
  const rows=[{certainty:'reported',evidence:[ref(ids[0]),ref(ids[1])]},
    {certainty:'reported',evidence:[partial]},
    {certainty:'tentative',interpretation:'가능한 해석: 현재 부담을 더 확인할 필요가 있을 수 있어요.',evidence:[ref(ids[1])]}];
  const value={state:{patient_state:{facts:[{...full,certainty:'reported'}],unknowns:[]},name_index:null,
    relationship_memory:{patient:[],supporter:[],relationship:[],unknowns:[]}},
    questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}};
  value.state.relationship_memory[subject]=rows;
  return {ctx,value,subject,ids,ref,full,partial,rows};
}
const approve=data=>data.safety_sources?safetyReviewFixture(data):({state:{approved:true,issues:[],audits:data.review_target.claims.map(claim=>({id:claim.id,
  verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문 대조'}))},questions:null,safety:null});
function gateway(value,review=approve) {
  const calls=[];
  return {calls,async agentComplete(stage,prompt,data,schema,operation,validate){
    calls.push({stage,data});
    return validate(stage.startsWith('turn_draft')?value:stage.startsWith('safety_review')?safetyReviewFixture(data):review(data));
  }};
}
const covers=(a,b)=>a.subject===b.subject&&a.question_id===b.question_id&&a.quote.includes(b.quote);

for(const subject of ['patient','supporter'])test('two reported rows and one hypothesis normalize without losing source meaning: '+subject,async()=>{
  const f=fixture(subject),before=structuredClone(f.value),ctxBefore=structuredClone(f.ctx);
  const model=gateway(f.value),output=await runCombinedRelationshipState(model,f.ctx,null,{}),rows=output.relationship_memory[subject];
  assert.equal(rows.length,2);assert.equal(rows[0].certainty,'reported');assert.equal(rows[0].evidence.length,3);
  assert.deepEqual(rows[0].evidence,[f.ref(f.ids[0]),f.ref(f.ids[1]),f.full]);
  assert.deepEqual(rows[1],before.state.relationship_memory[subject][2]);
  const originalRefs=before.state.relationship_memory[subject].flatMap(row=>row.evidence),nextRefs=rows.flatMap(row=>row.evidence);
  assert.ok(originalRefs.every(ref=>nextRefs.some(next=>covers(next,ref))));
  assert.equal(model.calls.length,3);assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review','safety_review']);
  assert.deepEqual(model.calls[1].data.review_target.claims.map(claim=>claim.id),[subject+'.0',subject+'.1']);
  assert.deepEqual(model.calls[1].data.review_target.claims[0].evidence,rows[0].evidence);
  assert.deepEqual(f.value,before);assert.deepEqual(f.ctx,ctxBefore);
});

for(const subject of ['patient','supporter'])test('streaming preserves the existing three-row representation exception: '+subject,async()=>{
  const f=fixture(subject),calls=[];
  const model=new ModelGateway({baseUrl:'http://127.0.0.1:11434/v1',apiKey:'synthetic',model:'synthetic',
    protocol:'relationship_agent',agentFormat:'prompt',streamJson:true,retryFailures:false,timeoutMs:0,diagnosticLogger:null,
    fetchImpl:async(_url,options)=>{
      const data=JSON.parse(JSON.parse(options.body).messages.at(-1).content);calls.push(data.stage);
      if(data.stage==='turn_draft')assert.equal(data.output_schema.properties.state.properties.relationship_memory.properties[subject].maxItems,2);
      const value=data.stage==='turn_draft'?f.value:approve(data.data);
      return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(value)},finish_reason:null}]})+
        '\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',
        {headers:{'content-type':'text/event-stream'}});
    }});
  const output=await model.updateState(f.ctx);
  assert.deepEqual(calls,['turn_draft','turn_review','safety_review']);assert.equal(output.state_agent.reviewed,true);
  assert.equal(output.relationship_memory[subject].length,2);
  for(const ref of f.rows.flatMap(row=>row.evidence))assert.ok(output.relationship_memory[subject].some(row=>row.evidence.some(next=>covers(next,ref))));
});

test('hypothesis before the reports retains its exact text, evidence and relative order',async()=>{
  const f=fixture();f.rows.unshift(f.rows.pop());const hypothesis=structuredClone(f.rows[0]);
  const output=await runCombinedRelationshipState(gateway(f.value),f.ctx,null,{});
  assert.deepEqual(output.relationship_memory.patient[0],hypothesis);
  assert.equal(output.relationship_memory.patient[1].certainty,'reported');
});

test('a whole latest answer is not added to memory unless the model selected it as a reported fact',async()=>{
  const f=fixture();f.value.state.patient_state.facts=[{...f.ref(f.ids[0]),certainty:'reported'}];
  const output=await runCombinedRelationshipState(gateway(f.value),f.ctx,null,{});
  assert.ok(output.relationship_memory.patient[0].evidence.some(ref=>ref.quote===f.partial.quote));
  assert.ok(!output.relationship_memory.patient[0].evidence.some(ref=>ref.quote===f.full.quote));
  assert.ok(output.patient_state.facts.some(ref=>ref.quote===f.full.quote)); // Existing full raw answer preservation remains.
});

for(const [name,change]of [
  ['invented source',f=>{f.rows[1].evidence[0].quote='원문에 없는 보고예요.';}],
  ['wrong actor',f=>{f.rows[1].evidence[0].subject='supporter';}],
  ['reported extra interpretation',f=>{f.rows[1].interpretation='삭제하면 안 되는 잘못된 필드';}],
  ['empty reported row',f=>{f.rows[1].evidence=[];}],
  ['individual row with four duplicate references',f=>{f.rows[0].evidence=Array(4).fill(f.ref(f.ids[0]));}],
  ['unknown source',f=>{f.ctx.patient.fields[f.ids[0]].status='unknown';}],
  ['refused source',f=>{f.ctx.patient.fields[f.ids[0]].status='refused';}],
  ['tentative exceeds string limit',f=>{f.rows[2].interpretation='가'.repeat(501);}],
  ['name-only report',f=>{f.rows[0].evidence=[{subject:'patient',question_id:'name',quote:'지민'}];}],
  ['unreported diagnostic label',f=>{f.rows[2].interpretation='가능한 해석: 수면장애가 있을 수 있어요.';}],
  ['malformed sibling envelope',f=>{f.value.questions.extra='허용되지 않는 필드';}],
  ['invalid name reference',f=>{f.value.state.name_index={alias:'지영',source_question_id:'name',quote:'지민'};}],
])test('normalization cannot hide an invalid original component: '+name,async()=>{
  const f=fixture();change(f);const before=structuredClone(f.value),model=gateway(f.value);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(model.calls.length,1);assert.deepEqual(f.value,before);
});

test('equal text in different questions remains distinct in the retained report',async()=>{
  const f=fixture();f.ctx.patient.fields.other=field('other',f.full.quote);
  f.rows[0].evidence.push({subject:'patient',question_id:'other',quote:f.full.quote});
  const model=gateway(f.value);
  const output=await runCombinedRelationshipState(model,f.ctx,null,{});
  assert.equal(output.relationship_memory.patient[0].evidence.length,4);
  for(const id of [f.ids[2],'other'])assert.ok(output.relationship_memory.patient[0].evidence.some(ref=>ref.question_id===id&&ref.quote===f.full.quote));
  assert.equal(model.calls.length,3);
});

test('seven different citations cannot be dropped or rewritten to satisfy the retained evidence limit',async()=>{
  const f=fixture();for(const id of ['extra1','extra2','extra3','values'])f.ctx.patient.fields[id]=field(id,id+'의 다른 현재 보고가 있어요.');
  f.rows[0].evidence.push(f.ref('extra1'));
  f.rows[1].evidence.push(f.ref('extra2'),f.ref('extra3'));
  f.ctx.latest_answer.question_id='values';f.value.state.patient_state.facts=[{...f.ref('values'),certainty:'reported'}];
  const model=gateway(f.value),before=structuredClone(f.value);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{modelReason:'agent_schema'});
  assert.equal(model.calls.length,1);assert.deepEqual(f.value,before);
});

for(const [name,change]of [
  ['four rows',f=>{f.rows.push(structuredClone(f.rows[1]));}],
  ['three reported rows',f=>{f.rows[2]={certainty:'reported',evidence:[f.ref(f.ids[0])]};}],
  ['two hypotheses',f=>{f.rows[1]=structuredClone(f.rows[2]);}],
])test('the representation exception does not generalize to '+name,async()=>{
  const f=fixture();change(f);const model=gateway(f.value);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{modelReason:'agent_schema'});
  assert.equal(model.calls.length,1);
});

test('reported rows in the relationship hypothesis group are not normalized',async()=>{
  const f=fixture();f.value.state.relationship_memory.patient=[];f.value.state.relationship_memory.relationship=f.rows;
  const model=gateway(f.value);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{modelReason:'agent_schema'});
  assert.equal(model.calls.length,1);
});

test('normalization still fails closed if the new complete independent audit is missing',async()=>{
  const f=fixture(),model=gateway(f.value,data=>{const result=approve(data);result.state.audits.pop();return result;});
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{code:'MODEL_INVALID_RESPONSE'});
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review']);
});

test('a normalized state rejected twice by the independent reviewer is never accepted',async()=>{
  const f=fixture(),model=gateway(f.value,data=>{const result=approve(data);result.state.approved=false;
    result.state.issues=[{reason:'합성 검토 거절',repair:'원문을 다시 대조하세요.'}];
    result.state.audits[0].verdict='unsupported';return result;});
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{modelReason:'state_review_rejected'});
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review','safety_review','turn_draft_after_review','turn_review_after_review','safety_review_after_review']);
});
