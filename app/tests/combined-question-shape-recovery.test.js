import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {scopeProbe} from './helpers/turn-input-optimization-fixture.js';

// Match the recorded 12B failure's structure: a list of skip proposals occupies
// the entire questions object and has no clarify/safety/personalization fields.
const malformed=value=>({...structuredClone(value),questions:value.questions.skip.map(({question_id,...item})=>({id:question_id,...item}))});
const probe=(response,options={})=>scopeProbe(ModelGateway,{stateMode:'combined',...options,response(call,value){
  if(call.stage==='turn_draft')return malformed(value);
  return response?.(call,value);
}});

test('an array-shaped questions output regenerates only questions and independently reviews every retained decision',async t=>{
  const p=probe(),original=structuredClone(p.ctx),logs=[];
  p.gateway.diagnosticLogger=entry=>logs.push(entry);
  const result=await p.run({signal:t.signal});
  assert.deepEqual(p.calls.map(call=>call.stage),[
    'turn_draft','turn_draft_block_questions','turn_review','question_review','safety_review']);
  const questionKeys=Object.keys(p.calls[0].output_schema.properties.questions.properties);
  assert.ok(p.calls[0].prompt.includes('questions는 배열이 아니라 '+questionKeys.join(', ')+' 키를 모두 포함하는 객체'));
  assert.match(p.calls[0].prompt,/생략 제안 배열은 questions\.skip 안에만/u);
  const repair=p.calls[1],feedback=JSON.parse(repair.data.combined_validation_feedback);
  assert.equal(feedback.path,'output.questions');assert.equal(feedback.keyword,'type');
  assert.equal(feedback.expected.type,'object');assert.equal(feedback.actual.type,'array');
  assert.equal(repair.output_schema.type,'object');
  assert.match(repair.prompt,/questions 또는 state라는 바깥 키로 다시 감싸지 마세요/u);
  assert.equal(Object.hasOwn(repair.data,'failed_combined_candidate'),false);
  assert.equal(Object.hasOwn(repair.data,'generated_blocks'),false);
  assert.equal(Object.hasOwn(repair,'rejected_output'),false);
  assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(result.state_agent.stages,p.calls.map(call=>call.stage));
  assert.equal(result.question_plan.skip[0].question_id,'daily');
  assert.equal(result.clarification,'support_requested');
  assert.deepEqual(result.relationship_memory.patient[0].evidence,p.value.state.relationship_memory.patient[0].evidence);
  assert.deepEqual(result.relationship_memory.unknowns,p.value.state.relationship_memory.unknowns);
  assert.deepEqual(p.ctx,original);
  const recovered=logs.filter(entry=>entry.event==='model_output_recovery');
  assert.equal(recovered.length,1);assert.equal(recovered[0].reason,'questions_array');
  assert.equal(recovered[0].retained_state,true);
  assert.ok(!JSON.stringify(recovered).includes(p.ctx.patient.fields.mood.rawText));
});

test('repeated array output stops after three question block attempts without defaults or review',async t=>{
  const p=probe((call,value)=>call.data.output_block==='questions'?value.skip:undefined);
  p.gateway.retryFailures=true;
  await assert.rejects(p.run({signal:t.signal}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema',modelAttempts:3});
  assert.deepEqual(p.calls.map(call=>call.stage),['turn_draft',...Array(3).fill('turn_draft_block_questions')]);
  assert.equal(p.calls.some(call=>call.stage.includes('review')),false);
});

test('a repaired question block still requires every decision field and cannot supply silent safety defaults',async t=>{
  const p=probe((call,value)=>call.data.output_block==='questions'?{skip:value.skip}:undefined);
  await assert.rejects(p.run({signal:t.signal}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(p.calls.filter(call=>call.stage==='turn_draft_block_questions').length,3);
  assert.equal(p.calls.some(call=>call.stage.includes('review')),false);
});

test('independent question review can reject regenerated choices without inventing skipped answers',async t=>{
  const p=probe((call,value)=>call.stage==='question_review'?{
    audits:value.audits.map(row=>({...row,verdict:'unsupported',reason:'현재 원문만으로 선택을 승인할 수 없습니다.'}))}:undefined);
  const result=await p.run({signal:t.signal});
  assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(result.question_plan.skip,[]);assert.equal(result.clarification,null);
  assert.equal(result.patient_state.facts.some(item=>item.question_id==='daily'),false);
});

test('retained state receives a fresh review and rejection triggers fresh state generation',async t=>{
  const p=probe((call,value)=>call.stage==='turn_review'?{...value,state:{...value.state,approved:false,
    issues:[{reason:'상태의 현재 범위를 다시 검토해야 합니다.',repair:'원문으로 다시 생성하세요.'}]}}:undefined);
  const result=await p.run({signal:t.signal});
  assert.equal(result.state_agent.reviewed,true);
  assert.equal(p.calls.filter(call=>call.stage==='turn_draft_block_patient_state_after_review').length,1);
  assert.equal(p.calls.filter(call=>call.stage==='turn_review_after_review').length,1);
});

test('schema-valid state with invalid source meaning is regenerated rather than retained',async t=>{
  const p=scopeProbe(ModelGateway,{stateMode:'combined',response(call,value){
    if(call.stage!=='turn_draft')return;
    const bad=malformed(value);
    bad.state.relationship_memory.patient[0].evidence=[{subject:'patient',question_id:'name',quote:'지민'}];
    return bad;
  }});
  const logs=[];p.gateway.diagnosticLogger=entry=>logs.push(entry);
  const result=await p.run({signal:t.signal});
  assert.equal(p.calls.filter(call=>call.stage==='turn_draft').length,1);
  for(const block of ['patient_state','name_index','relationship_memory','questions'])
    assert.equal(p.calls.filter(call=>call.stage==='turn_draft_block_'+block).length,1);
  assert.equal(result.state_agent.reviewed,true);
  assert.ok(result.relationship_memory.patient[0].evidence.every(item=>item.question_id==='mood'));
  assert.equal(logs.find(entry=>entry.event==='model_output_recovery').retained_state,false);
});

test('a transient restart cannot treat a retained draft as an independently approved state',async t=>{
  let attempts=0;
  const p=probe(call=>call.stage==='turn_draft_block_questions'&&++attempts<=3?new Response('',{status:503}):undefined);
  p.gateway.retryFailures=true;p.gateway.retryDelayMs=1;
  const result=await p.run({signal:t.signal});
  assert.equal(p.calls.filter(call=>call.stage==='turn_draft').length,1);
  assert.equal(attempts,4);
  // Source-validated draft blocks retain their original generation provenance;
  // no reviewer approval survives or is inferred from the cache hit.
  for(const block of ['patient_state','name_index','relationship_memory'])
    assert.equal(p.calls.filter(call=>call.stage==='turn_draft_block_'+block).length,0);
  for(const stage of ['turn_review','question_review','safety_review'])
    assert.equal(p.calls.filter(call=>call.stage===stage).length,1);
  assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(result.state_agent.stages,['turn_draft','turn_draft_block_questions','turn_review','question_review','safety_review']);
});

test('cancellation during question repair stops before independent reviews',async()=>{
  const controller=new AbortController();
  const p=probe(call=>{if(call.stage==='turn_draft_block_questions')controller.abort();});
  await assert.rejects(p.run({signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.deepEqual(p.calls.map(call=>call.stage),['turn_draft','turn_draft_block_questions']);
});

test('31B single-call policy keeps its one attempt and does not invoke structural recovery',async t=>{
  const p=probe();p.gateway.singleCallTurns=true;p.gateway.retryFailures=true;
  await assert.rejects(p.run({signal:t.signal}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema',modelAttempts:1});
  assert.deepEqual(p.calls.map(call=>call.stage),['turn_draft']);
});
