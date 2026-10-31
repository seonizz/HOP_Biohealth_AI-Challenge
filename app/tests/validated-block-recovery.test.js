import test from 'node:test';
import assert from 'node:assert/strict';
import {runCombinedRelationshipState} from '../src/relationship-turn.js';
import {HttpError} from '../src/errors.js';
import {safetyReviewFixture} from './helpers/safety-review.js';

const blocks=['patient_state','name_index','relationship_memory','questions'];
const field=(id,text)=>({id,question:id,status:'answered',text,rawText:text,custom:''});
const context=()=>({patient:{alias:'지민',fields:{name:field('name','지민'),mood:field('mood','저녁에 산책하고 싶다고 말했어요.')}},
  supporter:{fields:{feeling:field('feeling','함께 이야기를 듣고 싶어요.')}},user_goal:{message:field('want','원할 때 이야기를 듣고 싶어요.')},
  latest_answer:{subject:'patient',question_id:'mood'},answered_count:4,adaptive_questions:true,
  question_candidates:[{id:'daily',subject:'patient',question:'생활은 어떤가요?'}],clarification_candidates:[]});
const ref=ctx=>({subject:'patient',question_id:'mood',quote:ctx.patient.fields.mood.rawText});
const draft=ctx=>({patient_state:{facts:[{...ref(ctx),certainty:'reported'}],unknowns:[]},
  name_index:{alias:'지민',source_question_id:'name',quote:'지민'},
  relationship_memory:{patient:[{certainty:'reported',evidence:[ref(ctx)]}],supporter:[],relationship:[],unknowns:[]},
  questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}});
const failure=(reason='agent_schema',code='MODEL_INVALID_RESPONSE')=>{
  const error=new HttpError(502,code,'synthetic failure');error.modelReason=reason;
  if(reason==='agent_schema')error.modelFeedback=JSON.stringify({path:'output',keyword:'objectKeys'});
  return error;
};
const review=(data,reject=false)=>data.proposed_safety?safetyReviewFixture(data):{
  state:{approved:!reject,issues:reject?[{reason:'현재 근거를 다시 검토하세요.',repair:'원문 범위를 다시 선택하세요.'}]:[],
    audits:data.review_target.claims.map(claim=>({id:claim.id,verdict:claim.kind==='unresolved_information'?'still_unknown':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문 대조'}))},
  questions:null,safety:null};
function gateway(ctx,handler=()=>undefined){
  return {stateMode:'combined_blocks',calls:[],async agentComplete(stage,prompt,data,schema,operation,validate){
    const call={stage,prompt,data,schema,operation};this.calls.push(call);
    const override=await handler(call);
    if(override!==undefined)return validate(override);
    if(data.output_block){const value=draft(ctx)[data.output_block];return validate(structuredClone(data.output_block==='name_index'?{name_index:value}:value));}
    return validate(review(data));
  }};
}
const operation=()=>({requestId:'test-request',recovery:{},controller:new AbortController()});
const stages=g=>g.calls.map(call=>call.stage);
async function retainPrefix(ctx,op,block='questions'){
  const g=gateway(ctx,call=>{if(call.data.output_block===block)throw failure();});
  await assert.rejects(runCombinedRelationshipState(g,ctx,null,op),{code:'MODEL_INVALID_RESPONSE'});
  return g;
}

test('same structural retry reuses only validated prefix and independently reviews the assembled draft',async()=>{
  const ctx=context(),op=operation(),first=await retainPrefix(ctx,op);
  assert.deepEqual(Object.keys(op.recovery.combinedBlocks.blocks),blocks.slice(0,3));
  assert.equal(op.recovery.combinedBlocks.blocks.questions,undefined);
  const next=gateway(ctx),result=await runCombinedRelationshipState(next,ctx,null,op);
  assert.deepEqual(stages(next),['turn_draft_block_questions','turn_review','safety_review']);
  assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(result.state_agent.stages,[...blocks.map(b=>'turn_draft_block_'+b),'turn_review','safety_review']);
  assert.deepEqual(next.calls[0].data.question_input,first.calls.at(-1).data.question_input);
  assert.deepEqual(op.recovery,{});
});

test('a failing block is regenerated on every structural recovery, never cached',async()=>{
  const ctx=context(),op=operation();await retainPrefix(ctx,op,'relationship_memory');
  const again=await retainPrefix(ctx,op,'relationship_memory');
  assert.deepEqual(stages(again),['turn_draft_block_relationship_memory']);
  assert.deepEqual(Object.keys(op.recovery.combinedBlocks.blocks),['patient_state','name_index']);
  const next=gateway(ctx);await runCombinedRelationshipState(next,ctx,null,op);
  assert.deepEqual(stages(next),['turn_draft_block_relationship_memory','turn_draft_block_questions','turn_review','safety_review']);
});

for(const kind of ['source','schema','request','fresh operation'])test('cached prefix is not reused after '+kind+' changes',async()=>{
  const ctx=context(),op=operation(),first=await retainPrefix(ctx,op),changed=structuredClone(ctx);
  let nextOp=op;
  if(kind==='source')changed.patient.fields.mood=field('mood','친구와 식사하고 싶다고 말했어요.');
  if(kind==='schema')changed.clarification_candidates=[{id:'support_requested',subject:'patient',question:'원하는 도움이 있나요?'}];
  if(kind==='request')op.requestId='different-request';
  if(kind==='fresh operation')nextOp=operation();
  const next=gateway(changed);await runCombinedRelationshipState(next,changed,null,nextOp);
  assert.deepEqual(stages(next),[...blocks.map(b=>'turn_draft_block_'+b),'turn_review','safety_review']);
  if(kind==='schema')assert.notDeepEqual(next.calls[3].schema,first.calls[3].schema);
  assert.deepEqual(nextOp.recovery,{});
});

test('semantic rejection changes repair phase and regenerates all blocks before fresh reviews',async()=>{
  const ctx=context(),op=operation();await retainPrefix(ctx,op);
  let reviews=0;
  const next=gateway(ctx,call=>{if(call.stage.startsWith('turn_review'))return review(call.data,++reviews===1);});
  const result=await runCombinedRelationshipState(next,ctx,null,op);
  assert.deepEqual(stages(next),['turn_draft_block_questions','turn_review','safety_review',
    ...blocks.map(b=>'turn_draft_block_'+b+'_after_review'),'turn_review_after_review','safety_review_after_review']);
  assert.equal(reviews,2);assert.equal(result.state_agent.reviewed,true);assert.deepEqual(op.recovery,{});
});

for(const [reason,code] of [['cancelled','MODEL_CANCELLED'],['http_transient','MODEL_UNAVAILABLE']])
  test('a '+code+' failure discards previously retained blocks',async()=>{
    const ctx=context(),op=operation();await retainPrefix(ctx,op);
    const stopped=gateway(ctx,call=>{if(call.data.output_block==='questions'){
      if(code==='MODEL_CANCELLED')op.controller.abort();
      throw failure(reason,code);
    }});
    await assert.rejects(runCombinedRelationshipState(stopped,ctx,null,op),{code});
    assert.equal(op.recovery.combinedBlocks,undefined);
    op.controller=new AbortController();
    const next=gateway(ctx);await runCombinedRelationshipState(next,ctx,null,op);
    assert.deepEqual(stages(next),[...blocks.map(b=>'turn_draft_block_'+b),'turn_review','safety_review']);
  });

test('reused values are cloned and revalidated, and full-draft validation still rejects name-only evidence',async()=>{
  const ctx=context(),op=operation();await retainPrefix(ctx,op);
  op.recovery.combinedBlocks.blocks.patient_state.value.facts='invalid';
  const rejected=gateway(ctx);
  await assert.rejects(runCombinedRelationshipState(rejected,ctx,null,op),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.deepEqual(stages(rejected),[]);
  assert.deepEqual(Object.keys(op.recovery.combinedBlocks.blocks),[]);

  const fullOp=operation();await retainPrefix(ctx,fullOp);
  // Structurally valid citation, but name alone cannot support a finding.
  fullOp.recovery.combinedBlocks.blocks.relationship_memory.value.patient[0].evidence=[{subject:'patient',question_id:'name',quote:'지민'}];
  const semantic=gateway(ctx);
  await assert.rejects(runCombinedRelationshipState(semantic,ctx,null,fullOp),{code:'MODEL_INVALID_RESPONSE'});
  assert.deepEqual(stages(semantic),['turn_draft_block_questions']);
  assert.equal(fullOp.recovery.combinedBlocks,undefined);
});
