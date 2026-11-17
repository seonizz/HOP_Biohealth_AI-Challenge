import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {scopeProbe} from './helpers/turn-input-optimization-fixture.js';

const envelope=content=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
// Reproduce the recorded 12B shape without retaining its text: input fields
// copied into questions and repeated object keys must fail strict JSON parsing.
const duplicate=value=>envelope('{"state":'+JSON.stringify(value.state)+',"questions":{'+
  '"relative_time_policy":"PRIVATE_UNVALIDATED_COPY","personalization":null,'+
  '"relative_time_policy":"repeated","personalization":null}}');
const probe=(response,options={})=>scopeProbe(ModelGateway,{stateMode:'combined',...options,response(call,value){
  if(call.stage==='turn_draft')return duplicate(value);
  return response?.(call,value);
}});
const blocks=['patient_state','name_index','relationship_memory','questions'];

test('duplicate combined keys trigger fresh blocks immediately and never salvage an unparsed state',async t=>{
  const p=probe(),logs=[],original=structuredClone(p.ctx);
  p.gateway.diagnosticLogger=entry=>logs.push(entry);
  const requestId='11111111-2222-3333-4444-555555555555';
  const result=await p.run({signal:t.signal,requestId});
  assert.equal(p.calls.filter(call=>call.stage==='turn_draft').length,1);
  for(const block of blocks)assert.equal(p.calls.filter(call=>call.stage==='turn_draft_block_'+block).length,1);
  assert.deepEqual(p.calls.slice(-3).map(call=>call.stage),['turn_review','question_review','safety_review']);
  for(const call of p.calls.filter(call=>call.data.output_block)) {
    const issue=JSON.parse(call.data.combined_validation_feedback);
    assert.equal(issue.path,'output');assert.equal(issue.keyword,'jsonSyntax');assert.equal(issue.problem,'duplicate_key');
    assert.equal(Object.hasOwn(call.data,'failed_combined_candidate'),false);
    assert.equal(Object.hasOwn(call,'rejected_output'),false);
    assert.equal(JSON.stringify(call).includes('PRIVATE_UNVALIDATED_COPY'),false);
  }
  assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(result.state_agent.stages,[...blocks.map(block=>'turn_draft_block_'+block),'turn_review','question_review','safety_review']);
  assert.equal(result.question_plan.skip[0].question_id,'daily');
  assert.equal(result.clarification,'support_requested');
  assert.deepEqual(p.ctx,original);
  const recoveries=logs.filter(entry=>entry.event==='model_output_recovery');
  assert.deepEqual(recoveries,[{event:'model_output_recovery',generation:'turn_draft',reason:'duplicate_json_key',
    retained_state:false,request_id:requestId}]);
  assert.ok(!JSON.stringify(recoveries).includes(p.ctx.patient.fields.mood.rawText));
});

test('duplicate keys in a repair block stop after three attempts without another full-draft fallback',async t=>{
  const p=probe(call=>call.stage==='turn_draft_block_questions'?envelope('{"skip":[],"skip":[]}'):undefined);
  p.gateway.retryFailures=true;
  await assert.rejects(p.run({signal:t.signal}),{code:'MODEL_INVALID_RESPONSE',modelReason:'content_json',modelAttempts:3});
  assert.equal(p.calls.filter(call=>call.stage==='turn_draft').length,1);
  assert.equal(p.calls.filter(call=>call.stage==='turn_draft_block_questions').length,3);
  for(const block of blocks.filter(block=>block!=='questions'))
    assert.equal(p.calls.filter(call=>call.stage==='turn_draft_block_'+block).length,1);
  assert.equal(p.calls.some(call=>call.stage.includes('review')),false);
});

test('duplicate JSON after an earlier rejected draft clears that parsed candidate before block recovery',async t=>{
  let drafts=0;
  const p=scopeProbe(ModelGateway,{stateMode:'combined',response(call,value){
    if(call.stage!=='turn_draft')return;
    if(++drafts===1){delete value.state.relationship_memory.unknowns;return value;}
    return duplicate(value);
  }});
  const complete=p.gateway.agentComplete.bind(p.gateway);
  p.gateway.agentComplete=(stage,prompt,payload,schema,operation,...rest)=>{
    if(stage.startsWith('turn_draft_block_'))assert.equal(Object.hasOwn(operation.recovery.combinedDraft,'candidate'),false);
    return complete(stage,prompt,payload,schema,operation,...rest);
  };
  const result=await p.run({signal:t.signal});
  assert.equal(drafts,2);
  for(const block of blocks)assert.equal(p.calls.filter(call=>call.stage==='turn_draft_block_'+block).length,1);
  assert.equal(result.state_agent.reviewed,true);
});

test('a block missing decisions is rejected instead of receiving server-created defaults',async t=>{
  const p=probe((call,value)=>call.stage==='turn_draft_block_questions'?{skip:value.skip}:undefined);
  await assert.rejects(p.run({signal:t.signal}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema',modelAttempts:3});
  assert.equal(p.calls.filter(call=>call.stage==='turn_draft').length,1);
  assert.equal(p.calls.filter(call=>call.stage==='turn_draft_block_questions').length,3);
  assert.equal(p.calls.some(call=>call.stage.includes('review')),false);
});

test('fresh independent review can reject choices regenerated after duplicate JSON',async t=>{
  const p=probe((call,value)=>call.stage==='question_review'?{audits:value.audits.map(row=>({...row,
    verdict:'unsupported',reason:'선택을 뒷받침하는 원문 근거가 부족합니다.'}))}:undefined);
  const result=await p.run({signal:t.signal});
  assert.equal(result.state_agent.reviewed,true);assert.deepEqual(result.question_plan.skip,[]);
  assert.equal(result.clarification,null);
  assert.equal(result.patient_state.facts.some(fact=>fact.question_id==='daily'),false);
});

test('cancellation during the first fresh block prevents later generation and reviews',async()=>{
  const controller=new AbortController();
  const p=probe(call=>{if(call.stage==='turn_draft_block_patient_state')controller.abort();});
  await assert.rejects(p.run({signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.deepEqual(p.calls.map(call=>call.stage),['turn_draft','turn_draft_block_patient_state']);
});

test('31B single-call policy rejects duplicate JSON after its sole request',async t=>{
  const p=probe();p.gateway.singleCallTurns=true;p.gateway.retryFailures=true;
  await assert.rejects(p.run({signal:t.signal}),{code:'MODEL_INVALID_RESPONSE',modelReason:'content_json',modelAttempts:1});
  assert.deepEqual(p.calls.map(call=>call.stage),['turn_draft']);
});

test('other JSON syntax errors retain the ordinary combined attempt budget',async t=>{
  const p=scopeProbe(ModelGateway,{stateMode:'combined',response(call,value){
    if(call.stage==='turn_draft')return envelope(JSON.stringify(value)+' trailing');
  }});
  const result=await p.run({signal:t.signal});
  assert.equal(p.calls.filter(call=>call.stage==='turn_draft').length,3);
  for(const block of blocks)assert.equal(p.calls.filter(call=>call.stage==='turn_draft_block_'+block).length,1);
  assert.equal(result.state_agent.reviewed,true);
});
