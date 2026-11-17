import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {configuredModelGateway} from '../src/model-config.js';
import {scopeProbe,scopeContext,scopeDraft} from './helpers/turn-input-optimization-fixture.js';
import {relationshipQuestionRequest,currentReviewedSafety} from '../src/relationship-agent.js';
import {fixture as finalFixture,context as finalContext,envelope} from './helpers/final-flow-fixture.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';

const probe=options=>{
  const value=scopeProbe(ModelGateway,{stateMode:'combined',...options});
  Object.assign(value.gateway,{singleCallTurns:true,retryFailures:true});
  return value;
};

test('single-call turns opt in strictly and remain writer-only',()=>{
  const env={MODEL_BASE_URL:'http://127.0.0.1:11434',MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined'};
  assert.equal(configuredModelGateway({env}).singleCallTurns,false);
  const writer=configuredModelGateway({env:{...env,MODEL_SINGLE_CALL_TURNS:'true',MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435'}});
  assert.equal(writer.singleCallTurns,true);assert.equal(writer.reviewGateway.singleCallTurns,false);
  for(const value of ['yes','TRUE','1',true,null])assert.throws(()=>configuredModelGateway({env:{...env,MODEL_SINGLE_CALL_TURNS:value}}),/Invalid MODEL configuration/);
  for(const extra of [{MODEL_STATE_MODE:'combined_blocks'},{MODEL_STATE_MODE:'staged'},{MODEL_PROTOCOL:'json_schema'},{MODEL_BUNDLE_COMBINED_TURN_REVIEWS:'true'}])
    assert.throws(()=>configuredModelGateway({env:{...env,MODEL_SINGLE_CALL_TURNS:'true',...extra}}),/Invalid MODEL configuration/);
  writer.reviewGateway.singleCallTurns=true;assert.equal(writer.configured,false);
});

test('one POST keeps validated decisions and explicitly records omitted independent review',async()=>{
  const p=probe(),before=structuredClone(p.ctx),output=await p.run();
  assert.equal(p.calls.length,1);assert.equal(p.calls[0].stage,'turn_draft');
  assert.equal(output.state_agent.reviewed,false);assert.equal(output.state_agent.mode,'single_call');
  assert.deepEqual(output.state_agent.stages,['turn_draft']);
  assert.equal(output.state_agent.name_reuse,undefined);assert.equal(output.state_agent.safety_reuse,undefined);
  assert.deepEqual(output.question_plan.skip,p.value.questions.skip);
  assert.equal(output.safety_signal.review,undefined);
  assert.throws(()=>currentReviewedSafety({...p.ctx,safety_signal:output.safety_signal}),{modelReason:'agent_safety_stale'});
  assert.deepEqual(p.ctx,before);assert.equal(output.patient_state.facts.some(f=>f.question_id==='daily'),false);
});

test('context-based skipping remains a decision rather than an invented answer',async()=>{
  const ctx=scopeContext();ctx.answered_count=5;
  const value=scopeDraft(ctx);value.questions.skip[0].reason='not_needed';
  value.questions.skip[0].explanation='현재 원문과 도움 목적에서 추가 생활 질문은 필요하지 않습니다.';
  const p=probe({ctx,value}),output=await p.run();
  assert.equal(p.calls.length,1);assert.deepEqual(output.question_plan.skip,value.questions.skip);
  assert.equal(p.ctx.patient.fields.daily,undefined);
  assert.equal(output.patient_state.facts.some(f=>f.question_id==='daily'),false);
});

test('single-call SSE reconstructs split Unicode JSON and validates the same decisions with one POST',async()=>{
  const p=probe({response:(call,value)=>{
    const content=JSON.stringify(evidenceWireFixture(call,value));
    const wire=[...content].map(part=>'data: '+JSON.stringify({choices:[{index:0,delta:{content:part},finish_reason:null}]})+'\r\n\r\n').join('')+
      'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\r\n\r\ndata: [DONE]\r\n\r\n';
    const bytes=new TextEncoder().encode(wire);
    return new Response(new ReadableStream({start(controller){
      for(let index=0;index<bytes.length;index+=7)controller.enqueue(bytes.slice(index,index+7));controller.close();
    }}),{headers:{'content-type':'text/event-stream'}});
  }});
  Object.assign(p.gateway,{baseUrl:'http://127.0.0.1:11434/v1',streamJson:true});
  const progress=[],output=await p.run({onProgress:event=>progress.push(event)});
  assert.equal(p.calls.length,1);assert.equal(p.requests[0].stream,true);
  assert.equal(output.state_agent.mode,'single_call');assert.equal(output.state_agent.reviewed,false);
  assert.deepEqual(output.question_plan.skip,p.value.questions.skip);
  assert.deepEqual(progress.map(event=>event.status),['started','completed']);
});

test('a truncated single-call stream never retries or commits an incomplete decision',async()=>{
  const p=probe({response:()=>new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:'{"state":'},finish_reason:null}]})+'\n\n',
    {headers:{'content-type':'text/event-stream'}})});
  Object.assign(p.gateway,{baseUrl:'http://127.0.0.1:11434/v1',streamJson:true});
  await assert.rejects(p.run(),{code:'MODEL_INVALID_RESPONSE'});assert.equal(p.calls.length,1);
});

for(const [name,response] of [
  ['malformed JSON',()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{'}}]}))],
  ['missing schema field',(_call,value)=>{delete value.state.relationship_memory.unknowns;return value;}],
  ['invented evidence',(_call,value)=>{value.state.patient_state.facts[0].quote='원문에 없는 합성 인용';return value;}],
  ['context overflow',()=>new Response(JSON.stringify({error:{type:'invalid_request_error',message:'Prompt (20000) exceeds the 10000-token input budget; no text was truncated'}}),{status:400})],
  ['transient HTTP failure',()=>new Response('{}',{status:503})],
  ['connection failure',()=>{throw new TypeError('fetch failed');}],
])test('single-call '+name+' cannot retry or split blocks',async()=>{
  const p=probe({response});
  await assert.rejects(p.run());
  assert.equal(p.calls.length,1);assert.deepEqual(p.calls.map(x=>x.stage),['turn_draft']);
});

test('urgent unreviewed proposal remains explicitly provisional after one POST',async()=>{
  const ctx=scopeContext();ctx.patient.fields.mood.text=ctx.patient.fields.mood.rawText='지금 자신을 해치겠다고 말했어요.';
  const value=scopeDraft(ctx),request=relationshipQuestionRequest(ctx);
  value.questions={skip:[],clarify:[],safety:{urgent:true,evidence_ids:[request.schema.properties.safety.properties.evidence_ids.items.enum[0]]}};
  const p=probe({ctx,value});
  const output=await p.run();
  assert.equal(output.finish_early,true);assert.equal(output.safety_signal.urgent,true);
  assert.equal(output.safety_signal.review,undefined);assert.equal(output.state_agent.reviewed,false);
  assert.equal(output.state_agent.mode,'single_call');assert.equal(p.calls.length,1);
});

test('default combined mode still runs independent reviews',async()=>{
  const p=scopeProbe(ModelGateway,{stateMode:'combined'}),output=await p.run();
  assert.equal(p.calls.length,4);assert.equal(output.state_agent.reviewed,true);
  assert.ok(p.calls.some(x=>x.stage==='safety_review'));
});

test('request attempt budgets reject invalid values before any HTTP call',async()=>{
  const p=probe();
  for(const maxAttempts of [0,4,-1,1.5,'1',null])await assert.rejects(
    p.gateway.request(null,null,null,null,null,{maxAttempts}),RangeError);
  assert.equal(p.calls.length,0);
});


test('single-call option preserves independent final safety and result reviews',async()=>{
  const ctx=finalContext();ctx.safety_review_required=true;
  const p=finalFixture({ctx,httpOverride:input=>input.stage==='safety_review_final'
    ?envelope({basis:'unclear',reason:'현재 원문 전체에서 즉각 위험을 확정할 근거가 없습니다.',evidence_ids:[]}):undefined});
  p.gateway.singleCallTurns=true;
  const output=await p.run();
  assert.equal(p.stages()[0],'safety_review_final');
  assert.ok(p.stages().some(stage=>stage.startsWith('final_review_bundle')));
  assert.equal(output.agent.reviewed,true);
  assert.equal(output.agent.safety_signal.review.basis,'unclear');
});
