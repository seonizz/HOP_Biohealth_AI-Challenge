import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {configuredModelGateway} from '../src/model-config.js';
import {activeQuestionSet} from '../src/question-bank.js';
import {createIntake,currentView,prepareModelAnswer,buildContext} from '../src/intake.js';
import {relationshipQuestionRequest,currentReviewedSafety} from '../src/relationship-agent.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';
import {PROMPT_VERSION} from '../src/relationship-prompts.js';

const settings={baseUrl:'http://127.0.0.1:11434/v1',apiKey:'synthetic-only',model:'synthetic-model',
  protocol:'relationship_agent',stateMode:'combined',agentFormat:'json_object',timeoutMs:0,
  singleCallTurns:true,singleCallQuestionOnly:true,combinedTurnEvidenceIds:true,retryFailures:true,diagnosticLogger:null};
function context(text='친구가 동호회 발표를 준비한다고 말했어요. 무리하지 않는 범위에서 도울 방법을 정리하고 싶어요.') {
  const intake=createIntake(activeQuestionSet),q=currentView(intake).question;
  return buildContext(prepareModelAnswer(intake,{question_id:q.id,instance_id:q.instance_id,
    response_event:'answered',custom:text},0));
}
const nonurgent=()=>({skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}});
function probe({ctx=context(),value=nonurgent(),response,overrides={}}={}) {
  const calls=[];
  const gateway=new ModelGateway({...settings,...overrides,fetchImpl:async(_url,init)=>{
    const body=JSON.parse(init.body),input=JSON.parse(body.messages.at(-1).content);calls.push({body,input});
    const custom=await response?.(input,structuredClone(value));
    if(custom instanceof Response)return custom;
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(evidenceWireFixture(input,custom??value))}}]}));
  }});
  return {gateway,ctx,calls,run:options=>gateway.updateState(ctx,null,options)};
}

test('question-only option is explicit, strict, single-call-only, and never inherited by reviewer',()=>{
  const env={MODEL_BASE_URL:'http://127.0.0.1:11434',MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined'};
  assert.equal(configuredModelGateway({env}).singleCallQuestionOnly,false);
  const enabled={...env,MODEL_SINGLE_CALL_TURNS:'true',MODEL_SINGLE_CALL_QUESTION_ONLY:'true'};
  const gateway=configuredModelGateway({env:{...enabled,MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435'}});
  assert.equal(gateway.singleCallQuestionOnly,true);assert.equal(gateway.reviewGateway.singleCallQuestionOnly,false);
  for(const value of ['1','TRUE','yes',true,null])assert.throws(()=>configuredModelGateway({env:{...enabled,MODEL_SINGLE_CALL_QUESTION_ONLY:value}}),/Invalid MODEL configuration/);
  for(const extra of [{MODEL_SINGLE_CALL_TURNS:'false'},{MODEL_STATE_MODE:'staged'},{MODEL_STATE_MODE:'combined_blocks'},{MODEL_PROTOCOL:'json_schema'},{MODEL_BUNDLE_COMBINED_TURN_REVIEWS:'true'}])
    assert.throws(()=>configuredModelGateway({env:{...enabled,...extra}}),/Invalid MODEL configuration/);
  assert.equal(new ModelGateway({...settings,singleCallQuestionOnly:'true'}).configured,false);
});

test('one routing POST returns explicit deferred state without manufacturing or reusing memory',async()=>{
  const p=probe(),before=structuredClone(p.ctx),prior={summary:'not an approved memory'};
  const output=await p.gateway.updateState(p.ctx,prior);
  assert.equal(p.calls.length,1);assert.equal(p.calls[0].input.stage,'question_plan');
  assert.deepEqual(Object.keys(p.calls[0].input.output_schema.properties),['skip','clarify','safety','personalization']);
  for(const key of ['patient_state','relationship_memory','name_index'])assert.equal(output[key],null);
  assert.deepEqual(output.state_agent,{prompt_version:PROMPT_VERSION+'-question-slots-v2-compact-v1-personalized-v1',
    stages:['question_plan'],reviewed:false,mode:'single_call',memory_deferred:true});
  assert.deepEqual(output.question_plan,{skip:[]});assert.equal(output.safety_signal.review,undefined);
  assert.throws(()=>currentReviewedSafety({...p.ctx,safety_signal:output.safety_signal}),{modelReason:'agent_safety_stale'});
  assert.deepEqual(p.ctx,before);assert.deepEqual(prior,{summary:'not an approved memory'});
});

test('routing keeps context-based skips and restores their exact evidence from source IDs',async()=>{
  const ctx=context(),quote=ctx.supporter.fields.q3_01.rawText;
  const value=nonurgent();value.skip.push({question_id:'q3_03',reason:'already_covered',
    evidence:[{subject:'supporter',question_id:'q3_01',quote}],explanation:'동호회 발표를 준비하는 상황을 이미 설명했어요.'});
  const p=probe({ctx,value}),output=await p.run();
  assert.ok(p.calls[0].input.evidence_sources?.locations.length);
  assert.deepEqual(output.question_plan.skip,value.skip);assert.equal(p.calls.length,1);
  assert.equal(ctx.supporter.fields.q3_03?.status==='answered',false);
});

for(const stream of [false,true])for(const escaped of [false,true])test(`duplicate fixed-slot JSON keys are rejected in one call; stream=${stream}, escaped=${escaped}`,async()=>{
  const ctx=context(),before=structuredClone(ctx);
  const p=probe({ctx,overrides:{streamJson:stream},response:input=>{
    const wire=evidenceWireFixture(input,nonurgent()),id=Object.keys(wire.skip)[0];
    const second=escaped?'"\\u'+id.charCodeAt(0).toString(16).padStart(4,'0')+id.slice(1)+'"':JSON.stringify(id);
    const content='{"skip":{'+JSON.stringify(id)+':null,'+second+':null,'+
      Object.keys(wire.skip).slice(1).map(key=>JSON.stringify(key)+':null').join(',')+'},"clarify":[],"safety":{"urgent":false,"evidence_ids":[]}}';
    if(stream)return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason:null}]})+'\n\n'+
      'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
  }});
  await assert.rejects(p.run(),{code:'MODEL_INVALID_RESPONSE'});assert.equal(p.calls.length,1);assert.deepEqual(ctx,before);
});

test('question identity slots are enforced even when evidence ID compression is disabled',async()=>{
  const p=probe({overrides:{combinedTurnEvidenceIds:false}});await p.run();
  assert.equal(p.calls.length,1);assert.equal(p.calls[0].input.output_schema.properties.skip.type,'object');
});

test('unsupported question identity contract fails before dispatch instead of reverting to an array',async()=>{
  const p=probe(),request=relationshipQuestionRequest(p.ctx);request.schema.properties.skip.minItems=1;
  await assert.rejects(p.gateway.operation({},operation=>p.gateway.agentComplete('question_plan',request.prompt,request.data,request.schema,operation,value=>value)),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(p.calls.length,0);
});

test('question-only mode refuses legacy or nonadaptive contexts before an HTTP call',async()=>{
  for(const mutate of [ctx=>{delete ctx.bundle_id;},ctx=>{ctx.adaptive_questions=false;}]){
    const ctx=context();mutate(ctx);const p=probe({ctx});
    await assert.rejects(p.run(),{code:'MODEL_PROTOCOL_UNSUPPORTED'});assert.equal(p.calls.length,0);
  }
});

for(const [label,response] of [
  ['malformed JSON',()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{'}}]}))],
  ['missing safety',(_input,value)=>{delete value.safety;return value;}],
  ['invented evidence',(_input,value)=>({...value,skip:[{question_id:'q3_03',reason:'already_covered',evidence:[{subject:'supporter',question_id:'q3_01',quote:'원문에 없는 합성 문구'}],explanation:'합성 검증'}]})],
  ['HTTP failure',()=>new Response('{}',{status:503})],
  ['connection failure',()=>{throw new TypeError('fetch failed');}],
])test(`question-only ${label} fails after exactly one POST`,async()=>{
  const p=probe({response});await assert.rejects(p.run());assert.equal(p.calls.length,1);
});

test('question-only SSE validates split Unicode and rejects an unfinished JSON without retry',async()=>{
  const stream=content=>new Response(new ReadableStream({start(controller){
    const body=[...content].map(ch=>'data: '+JSON.stringify({choices:[{index:0,delta:{content:ch},finish_reason:null}]})+'\n\n').join('')+
      'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';
    const bytes=new TextEncoder().encode(body);for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));controller.close();
  }}),{headers:{'content-type':'text/event-stream'}});
  const p=probe({overrides:{streamJson:true},response:(input,value)=>stream(JSON.stringify(evidenceWireFixture(input,value)))});
  assert.equal((await p.run()).state_agent.memory_deferred,true);assert.equal(p.calls.length,1);assert.equal(p.calls[0].body.stream,true);
  const bad=probe({overrides:{streamJson:true},response:()=>stream('{"skip":[')});
  await assert.rejects(bad.run(),{code:'MODEL_INVALID_RESPONSE'});assert.equal(bad.calls.length,1);
});

test('urgent routing remains provisional and carries actual current evidence in one POST',async()=>{
  const ctx=context('지금 친구가 심하게 다쳐 피를 흘린다고 직접 말했어요.'),request=relationshipQuestionRequest(ctx);
  const value={skip:[],clarify:[],safety:{urgent:true,evidence_ids:[request.data.safety_sources.find(row=>row.subject==='supporter').id]}};
  const p=probe({ctx,value}),output=await p.run();
  assert.equal(p.calls.length,1);assert.equal(output.finish_early,true);assert.equal(output.safety_signal.urgent,true);
  assert.ok(output.safety_signal.evidence.length);assert.equal(output.safety_signal.review,undefined);
  assert.equal(output.state_agent.reviewed,false);assert.equal(output.state_agent.memory_deferred,true);
});

for(const approved of [true,false])test(`final response rebuilds and independently reviews deferred V3 state (approved=${approved})`,async()=>{
  const ctx=context();ctx.agent_state=null;ctx.relationship_state=null;ctx.name_index=null;
  const evidence={subject:'supporter',question_id:'q3_01',quote:ctx.supporter.fields.q3_01.rawText};
  const before=structuredClone(ctx),gateway=new ModelGateway(settings),stages=[],reachedFinal=new Error('final generation reached');
  gateway.agentComplete=async(stage,prompt,data,schema,operation,validate)=>{
    stages.push(stage);
    if(stage.startsWith('state_observations'))return validate({patient_state:{facts:[{...evidence,certainty:'reported'}],unknowns:[]},name_index:null});
    if(stage.startsWith('relationship_memory'))return validate({relationship_memory:{patient:[],supporter:[{certainty:'reported',evidence:[evidence]}],relationship:[],unknowns:[]}});
    if(stage.startsWith('state_review'))return validate({approved,issues:approved?[]:[{reason:'합성 검증에서 반려했습니다.',repair:'현재 원문과 다시 대조하세요.'}],
      audits:data.claims.map(c=>({id:c.id,verdict:approved?'supported':'unsupported',reason:'합성 원문 대조'}))});
    throw reachedFinal;
  };
  await assert.rejects(gateway.respond(ctx),error=>approved?error===reachedFinal:error.code==='MODEL_INVALID_RESPONSE'&&error.modelReason==='state_review_rejected');
  assert.deepEqual(stages.slice(0,3),['state_observations','relationship_memory','state_review']);
  assert.ok(stages.length>3);assert.equal(stages.includes('question_plan'),false);assert.deepEqual(ctx,before);
  if(!approved)assert.deepEqual(stages.slice(3),['state_observations_after_review','relationship_memory_after_review','state_review_after_review']);
});
