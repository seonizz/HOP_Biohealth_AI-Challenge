import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {activeQuestionSet} from '../src/question-bank.js';
import {createIntake,currentView,prepareModelAnswer,buildContext} from '../src/intake.js';
import {scopeProbe,scopeContext,scopeDraft,scopeReview} from './helpers/turn-input-optimization-fixture.js';
import {restoreReviewSources} from '../src/final-review-bundle.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';

const envelope=value=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]});
const settings={baseUrl:'http://127.0.0.1:18101/v1',apiKey:'synthetic-only',model:'generic-12b',
  protocol:'relationship_agent',agentFormat:'json_object',reasoningEffort:'omit',stateMode:'combined',
  timeoutMs:0,retryFailures:true,retryDelayMs:1,diagnosticLogger:null};
const questionContext=()=>{
  const intake=createIntake(activeQuestionSet),question=currentView(intake).question;
  return buildContext(prepareModelAnswer(intake,{question_id:question.id,custom:'친구가 발표 준비를 한다고 말했어요. 도울 방법을 알고 싶어요.'},0));
};
function twoCalls({sameModel=false,response}={}) {
  const calls=[],logs=[],ctx=scopeContext(),draft=scopeDraft(ctx);
  const fetchImpl=async(url,request)=>{
    const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);
    const call={url,body,...input};calls.push(call);
    const override=await response?.(call);
    if(override instanceof Response)return override;
    let output;
    if(input.stage==='turn_draft')output=structuredClone(draft);
    else if(input.data.tasks){
      output={};
      const restored=restoreReviewSources(input.data);
      for(const task of restored.tasks){
        const data={...task.input,...Object.fromEntries(Object.entries(task.shared_input_keys).map(([key,id])=>[key,restored.shared_inputs[id]]))};
        output[task.id]=scopeReview(data);
      }
    }else assert.fail('Unexpected stage after fixed two-call boundary: '+input.stage);
    return envelope(evidenceWireFixture(input,output));
  };
  const reviewer=new ModelGateway({...settings,model:sameModel?'generic-12b':'generic-reviewer',
    baseUrl:sameModel?settings.baseUrl:'http://127.0.0.1:18102/v1',fetchImpl,diagnosticLogger:entry=>logs.push(entry)});
  const gateway=new ModelGateway({...settings,questionCallLimit:2,bundleCombinedTurnReviews:true,
    fetchImpl,reviewGateway:reviewer,diagnosticLogger:entry=>logs.push(entry)});
  return {gateway,reviewer,ctx,calls,logs,run:options=>gateway.updateState(ctx,null,options)};
}

test('question execution settings reject invalid values while legacy defaults stay unchanged',()=>{
  const base=new ModelGateway({...settings,fetchImpl:async()=>envelope({})});
  assert.equal(base.configured,true);assert.equal(base.questionCallLimit,0);assert.equal(base.questionExecution,'parallel');
  for(const questionCallLimit of [-1,3,1.5,'1',null,true])assert.equal(new ModelGateway({...settings,questionCallLimit}).configured,false);
  for(const questionExecution of ['serial','',null,true])assert.equal(new ModelGateway({...settings,questionExecution}).configured,false);
});

test('a generic 12B question gateway performs one POST and does not replace the general final route',async()=>{
  let calls=0;
  const question=new ModelGateway({...settings,singleCallTurns:true,singleCallQuestionOnly:true,questionCallLimit:1,questionExecution:'individual',
    fetchImpl:async(_url,request)=>{
      calls++;const input=JSON.parse(JSON.parse(request.body).messages.at(-1).content);
      assert.equal(input.stage,'question_plan');
      return envelope(evidenceWireFixture(input,{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]},personalization:null}));
    }});
  const general=new ModelGateway({...settings,fetchImpl:()=>assert.fail('Question must use its configured gateway')});
  general.questionGateway=question;
  const context=questionContext(),result=await general.updateState(context);
  assert.equal(calls,1);assert.equal(result.state_agent.mode,'single_call');assert.equal(result.state_agent.reviewed,false);
  assert.equal(result.state_agent.memory_deferred,true);
  general.operation=async()=>({route:'general-final'});
  assert.deepEqual(await general.respond(context),{route:'general-final'});
  assert.equal(calls,1);
});

for(const sameModel of [false,true])test('two-call questions share one budget with '+(sameModel?'the same model':'a separate reviewer'),async()=>{
  const p=twoCalls({sameModel}),result=await p.run();
  assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(p.calls.map(call=>call.stage),['turn_draft','turn_review_bundle']);
  assert.equal(p.calls[1].body.model,sameModel?'generic-12b':'generic-reviewer');
  assert.equal(p.calls[1].url.startsWith(p.reviewer.baseUrl),true);
  assert.equal(p.logs.filter(row=>row.event==='model_attempt').length,2);
  assert.equal(new Set(p.logs.filter(row=>row.event==='model_attempt').map(row=>row.operation_id)).size,1);
});

test('malformed review cannot spend a third POST or falsely approve a two-call question',async()=>{
  const p=twoCalls({response:call=>call.stage==='turn_review_bundle'?envelope({}):undefined});
  await assert.rejects(p.run(),{code:'MODEL_CALL_LIMIT',modelReason:'call_limit'});
  assert.equal(p.calls.length,2);
  assert.equal(p.logs.filter(row=>row.event==='model_attempt').length,2);
  assert.equal(p.logs.filter(row=>row.event==='model_request_failure').at(-1).reason,'call_limit');
});

test('structural fallback and parallel blocks cannot escape the two-call question budget',async()=>{
  const p=scopeProbe(ModelGateway,{stateMode:'combined',response(call,value){
    if(call.stage==='turn_draft')return {...value,questions:[]};
    if(call.data.output_block==='questions')return {skip:[]};
  }});
  p.gateway.questionCallLimit=2;p.gateway.retryFailures=true;
  await assert.rejects(p.run(),{code:'MODEL_CALL_LIMIT'});
  assert.equal(p.calls.length,2);
  assert.equal(p.calls.some(call=>call.stage.includes('review')),false);
  const parallel=scopeProbe(ModelGateway);
  parallel.gateway.questionCallLimit=2;
  await assert.rejects(parallel.run(),{code:'MODEL_CALL_LIMIT'});
  assert.equal(parallel.calls.length,2);
});

test('transient requests consume the fixed budget and never restart the question operation',async()=>{
  const p=twoCalls({response:()=>new Response('',{status:503,headers:{'Retry-After':'0'}})});
  await assert.rejects(p.run(),{code:'MODEL_CALL_LIMIT'});
  assert.equal(p.calls.length,2);
  assert.equal(p.logs.some(row=>row.event==='model_operation_retry'),false);
  const upstream=twoCalls({response:()=>new Response('',{status:500})});
  await assert.rejects(upstream.run(),{code:'MODEL_UPSTREAM_ERROR'});
  assert.equal(upstream.calls.length,1);
});

test('two-call semantic rejection cannot start an extra draft or reuse an approval',async()=>{
  const p=twoCalls({response:call=>{
    if(call.stage!=='turn_review_bundle')return;
    const restored=restoreReviewSources(call.data),output={};
    for(const task of restored.tasks){
      const data={...task.input,...Object.fromEntries(Object.entries(task.shared_input_keys).map(([key,id])=>[key,restored.shared_inputs[id]]))};
      output[task.id]=scopeReview(data,task.id==='state');
    }
    return envelope(evidenceWireFixture(call,output));
  }});
  await assert.rejects(p.run(),{code:'MODEL_CALL_LIMIT'});assert.equal(p.calls.length,2);
});

test('individual execution serializes independent work while parallel execution overlaps it',async()=>{
  const results=[];
  for(const mode of ['individual','parallel']){
    let active=0,peak=0;
    const p=scopeProbe(ModelGateway,{response:async()=>{
      peak=Math.max(peak,++active);await new Promise(resolve=>setTimeout(resolve,5));active--;
    }});
    p.gateway.questionExecution=mode;
    const {state_agent,...result}=await p.run();results.push(result);
    assert.equal(state_agent.reviewed,true);assert.equal(active,0);
    if(mode==='individual')assert.equal(peak,1);else assert.ok(peak>=2);
  }
  assert.deepEqual(results[0],results[1]);
});

test('cancellation stops an individual question before its next block',async()=>{
  const controller=new AbortController();
  const p=scopeProbe(ModelGateway,{response:()=>{controller.abort();}});
  p.gateway.questionExecution='individual';
  await assert.rejects(p.run({signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.equal(p.calls.length,1);
});

test('question routing rejects cycles and a cancelled two-call request never dispatches',async()=>{
  const p=twoCalls(),controller=new AbortController();controller.abort();
  await assert.rejects(p.run({signal:controller.signal}),{code:'MODEL_CANCELLED'});assert.equal(p.calls.length,0);
  p.gateway.questionGateway=p.gateway;
  await assert.rejects(p.run(),{code:'MODEL_NOT_CONFIGURED'});
});
