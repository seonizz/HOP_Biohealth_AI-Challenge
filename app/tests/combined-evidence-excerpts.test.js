import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runCombinedRelationshipState } from '../src/relationship-turn.js';

const field=(id,text)=>({id,question:id,text,rawText:text,custom:'',status:'answered'});
function fixture(subject='supporter',text='저는 밤 열 시에는 쉬어야 해요. 주말에는 이야기를 들을 수 있지만 긴 통화는 어려워요.',quote='긴 통화는 어려워요.') {
  const id=subject==='patient'?'burden':'cgchange_more';
  const ctx={patient:{alias:'지민',fields:{name:field('name','지민'),rel:field('rel','친구')}},supporter:{fields:{}},
    user_goal:{message:field('want','이야기를 듣고 싶어요.')},answered_count:4,latest_answer:{subject,question_id:id},
    adaptive_questions:true,question_candidates:[],clarification_candidates:[]};
  ctx[subject].fields[id]=field(id,text);
  const full={subject,question_id:id,quote:text},short={...full,quote};
  const rows=[{certainty:'reported',evidence:[full]},
    {certainty:'tentative',interpretation:'가능한 해석: 대화할 수 있는 시간의 범위를 확인할 필요가 있을 수 있어요.',evidence:[short]}];
  const value={state:{patient_state:{facts:[{...full,certainty:'reported'}],unknowns:[]},name_index:null,
    relationship_memory:{patient:[],supporter:[],relationship:[],unknowns:[]}},
    questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}};
  value.state.relationship_memory[subject]=rows;
  return {ctx,value,subject,id,full,short,rows};
}
const approve=data=>({state:{approved:true,issues:[],audits:data.review_target.claims.map(claim=>({id:claim.id,
  verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 검토 결과'}))},questions:null,safety:null});
function gateway(value,review=approve) {
  const calls=[],diagnostics=[];
  return {calls,diagnostics,diagnosticLogger:entry=>diagnostics.push(entry),
    async agentComplete(stage,prompt,data,schema,operation,validate) {
      calls.push({stage,prompt,data,schema});
      return validate(stage.startsWith('turn_draft')?value:review(data));
    }};
}
const digest=value=>createHash('sha256').update(value).digest('hex');

for(const subject of ['patient','supporter'])test('literal clause expands to the unique allowed complete sentence before independent review: '+subject,async()=>{
  const f=fixture(subject),before=structuredClone(f.value),ctxBefore=structuredClone(f.ctx);
  const expanded={...f.full,quote:f.full.quote.split('. ')[1]},model=gateway(f.value);
  const result=await runCombinedRelationshipState(model,f.ctx,null,{});
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review']);
  assert.deepEqual(result.relationship_memory[subject][1],{...f.rows[1],evidence:[expanded]});
  const claim=model.calls[1].data.review_target.claims.find(claim=>claim.id===subject+'.1');
  assert.equal(claim.claim,f.rows[1].interpretation);assert.equal(claim.certainty,'tentative');
  assert.deepEqual(claim.evidence,[expanded]);assert.ok(expanded.quote.includes(f.short.quote));
  assert.deepEqual(f.value,before);assert.deepEqual(f.ctx,ctxBefore);
  assert.equal(model.diagnostics.length,1);
  const diagnostic=model.diagnostics[0];
  assert.deepEqual(Object.keys(diagnostic).sort(),['event','path','enum_index','from_length','to_length','from_sha256','to_sha256','generation'].sort());
  assert.equal(diagnostic.event,'citation_excerpt_expanded');
  assert.equal(diagnostic.generation,'turn_draft');
  assert.equal(diagnostic.path,`output.state.relationship_memory.${subject}[1].evidence[0]`);
  assert.equal(diagnostic.from_length,f.short.quote.length);assert.equal(diagnostic.to_length,expanded.quote.length);
  assert.equal(diagnostic.from_sha256,digest(f.short.quote));assert.equal(diagnostic.to_sha256,digest(expanded.quote));
  const node=model.calls[0].schema.properties.state.properties.relationship_memory.properties[subject].items.anyOf[1].properties.evidence.items;
  assert.deepEqual(node.enum[diagnostic.enum_index],expanded);
  for(const sourceValue of [f.full.quote,f.short.quote,f.id,'지민'])assert.ok(!JSON.stringify(diagnostic).includes(sourceValue));
});

test('a complete single answer can contain an excerpt without inventing a sentence',async()=>{
  const f=fixture('supporter','저는 긴 통화를 하기 어려워요','긴 통화'),model=gateway(f.value);
  const result=await runCombinedRelationshipState(model,f.ctx,null,{});
  assert.deepEqual(result.relationship_memory.supporter[1].evidence,[f.full]);
});

test('valid enum references and the original prompt/schema pass through unchanged',async()=>{
  const f=fixture();f.rows[1].evidence=[f.full];const before=structuredClone(f.value),model=gateway(f.value);
  const result=await runCombinedRelationshipState(model,f.ctx,null,{});
  assert.deepEqual(result.relationship_memory.supporter[1],f.rows[1]);
  assert.deepEqual(f.value,before);assert.deepEqual(model.diagnostics,[]);
  assert.equal(model.calls.length,2);
  const branch=model.calls[0].schema.properties.state.properties.relationship_memory.properties.supporter.items.anyOf[1];
  assert.equal(branch.properties.evidence.maxItems,3);
  assert.ok(branch.properties.evidence.items.enum.every(ref=>ref.quote!==f.short.quote));
  assert.ok(!model.calls[0].prompt.includes('citation_excerpt_expanded'));
});

for(const [name,change]of [
  ['wrong actor',f=>{f.rows[1].evidence[0].subject='patient';}],
  ['wrong question',f=>{f.rows[1].evidence[0].question_id='missing';}],
  ['fabricated clause',f=>{f.rows[1].evidence[0].quote='매일 긴 통화를 원해요.';}],
  ['changed whitespace',f=>{f.rows[1].evidence[0].quote='긴  통화는 어려워요.';}],
  ['additional reference field',f=>{f.rows[1].evidence[0].extra='not allowed';}],
  ['unknown field',f=>{f.ctx[f.subject].fields[f.id].status='unknown';}],
  ['refused field',f=>{f.ctx[f.subject].fields[f.id].status='refused';}],
  ['four references',f=>{f.rows[1].evidence=Array.from({length:4},()=>structuredClone(f.short));}],
  ['three hypotheses',f=>{f.value.state.relationship_memory[f.subject]=Array.from({length:3},()=>structuredClone(f.rows[1]));}],
  ['extra row field',f=>{f.rows[1].extra='not allowed';}],
  ['malformed questions',f=>{f.value.questions.extra='not allowed';}],
  ['invalid finding label',f=>{f.rows[1].interpretation='가능한 해석: 수면장애가 있을 수 있어요.';}],
])test('excerpt expansion cannot hide another invalid draft component: '+name,async()=>{
  const f=fixture();change(f);const before=structuredClone(f.value),model=gateway(f.value);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(model.calls.length,1);assert.deepEqual(model.diagnostics,[]);assert.deepEqual(f.value,before);
});

for(const [name,text]of [
  ['equal length','아침에는 긴 통화는 어려워요. 저녁에는 긴 통화는 어려워요.'],
  ['different lengths','아침에는 긴 통화는 어려워요. 퇴근하고 늦은 저녁에는 긴 통화는 어려워요.'],
])test('competing complete sentences remain ambiguous regardless of length: '+name,async()=>{
  const f=fixture('supporter',text),model=gateway(f.value);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{modelReason:'agent_schema'});
  assert.equal(model.calls.length,1);assert.deepEqual(model.diagnostics,[]);
});

test('nested but distinct sentences in separate source components are not disambiguated by length',async()=>{
  const f=fixture('supporter','지금은 긴 통화는 어려워요.');
  f.ctx.supporter.fields[f.id].custom='긴 통화는 어려워요.';
  f.rows[1].evidence[0].quote='긴 통화';
  const model=gateway(f.value);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{modelReason:'agent_schema'});
  assert.deepEqual(model.diagnostics,[]);
});

test('an allowed 1000-character chunk is not a complete answer or sentence',async()=>{
  const text='앞'.repeat(200)+'긴 통화는 어려워요'+ '뒤'.repeat(1000);
  const f=fixture('supporter',text,'긴 통화는 어려워요');
  // Keep other draft fields valid so the only initial defect is the excerpt enum.
  const chunk={...f.full,quote:text.slice(0,1000)};
  f.value.state.patient_state.facts=[{...chunk,certainty:'reported'}];f.rows[0].evidence=[chunk];
  const model=gateway(f.value);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{modelReason:'agent_schema'});
  const node=model.calls[0].schema.properties.state.properties.relationship_memory.properties.supporter.items.anyOf[1].properties.evidence.items;
  assert.ok(node.enum.some(ref=>ref.quote===chunk.quote));assert.deepEqual(model.diagnostics,[]);
});

for(const outside of ['relationship','facts'])test('normalization does not extend to '+outside,async()=>{
  const f=fixture();f.rows[1].evidence=[f.full];
  if(outside==='relationship')f.value.state.relationship_memory.relationship=[{...f.rows[1],evidence:[f.short]}];
  else f.value.state.patient_state.facts=[{...f.short,certainty:'reported'}];
  const model=gateway(f.value);
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(model.calls.length,1);assert.deepEqual(model.diagnostics,[]);
});

test('negation surrounding the clause reaches review unchanged and a rejected interpretation is never accepted',async()=>{
  const f=fixture('supporter','긴 통화는 어렵다는 말은 하지 않았어요.','긴 통화는 어렵');
  f.rows[1].interpretation='가능한 해석: 긴 통화가 어려울 수 있어요.';
  const model=gateway(f.value,data=>{
    const claim=data.review_target.claims.find(claim=>claim.id==='supporter.1');
    assert.equal(claim.claim,f.rows[1].interpretation);assert.deepEqual(claim.evidence,[f.full]);
    const result=approve(data);result.state.approved=false;
    result.state.issues=[{reason:'부정된 내용을 사실처럼 해석했어요.',repair:'전체 원문의 부정을 대조하세요.'}];
    result.state.audits.find(audit=>audit.id==='supporter.1').verdict='unsupported';return result;
  });
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{modelReason:'state_review_rejected'});
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review','turn_draft_after_review','turn_review_after_review']);
  assert.equal(model.diagnostics.length,2); // Validated drafts, not semantic approvals.
});

test('all expanded claims still require independent audits',async()=>{
  const f=fixture(),model=gateway(f.value,data=>{const result=approve(data);result.state.audits.pop();return result;});
  await assert.rejects(runCombinedRelationshipState(model,f.ctx,null,{}),{code:'MODEL_INVALID_RESPONSE'});
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review']);
});

test('diagnostics run only after draft validation and cannot fail a validated draft',async()=>{
  const f=fixture(),model=gateway(f.value);
  model.diagnosticLogger=()=>{assert.equal(model.calls.length,1);throw new Error('diagnostic sink unavailable');};
  const result=await runCombinedRelationshipState(model,f.ctx,null,{});
  assert.equal(result.state_agent.reviewed,true);assert.equal(model.calls.length,2);
});

test('a diagnostic can be correlated with its request without including source identifiers',async()=>{
  const f=fixture(),model=gateway(f.value);
  await runCombinedRelationshipState(model,f.ctx,null,{requestId:'synthetic-request'});
  assert.equal(model.diagnostics[0].request_id,'synthetic-request');
  assert.equal(model.diagnostics[0].generation,'turn_draft');
  assert.ok(!JSON.stringify(model.diagnostics[0]).includes(f.id));
});
