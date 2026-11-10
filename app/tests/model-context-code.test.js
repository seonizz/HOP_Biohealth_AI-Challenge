import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {fixture,reviewStages,assertDetail} from './helpers/final-flow-fixture.js';

const MODEL='synthetic-model';
const SOURCE='변경하지 않는 합성 원문 '.repeat(80);
const workerMessage='Full prompt plus requested output exceeds 32768 tokens';
const contextError=(overrides={},status=400)=>Response.json({error:{
  type:'invalid_request_error',code:'context_length_exceeded',message:workerMessage,...overrides,
}},{status});
const policy=()=>Response.json({model:MODEL,max_output_tokens:8192,max_context_tokens:32768});
const makeGateway=(fetchImpl,extra={})=>new ModelGateway({baseUrl:'https://synthetic.invalid/v1',
  apiKey:'synthetic-key',model:MODEL,protocol:'relationship_agent',agentFormat:'prompt',
  timeoutMs:0,retryFailures:false,discoverTokenLimits:true,diagnosticLogger:null,fetchImpl,...extra});
const complete=gateway=>gateway.operation({},operation=>gateway.agentComplete(
  'speech_review','독립 검토',{source:SOURCE},{type:'object'},operation,value=>value));

function discoverFixedPolicy(value) {
  const fetch=value.gateway.fetchImpl;
  value.gateway.discoverTokenLimits=true;
  value.gateway.fetchImpl=(url,options)=>options.method==='GET'?policy():fetch(url,options);
  return value;
}

test('the 31B machine context code is recognized independently of its message without retries or truncation',async()=>{
  for(const message of [workerMessage,'Different provider wording',undefined]) {
    const requests=[],logs=[];
    const gateway=makeGateway(async(_url,options)=>{
      if(options.method==='GET')return policy();
      requests.push(JSON.parse(options.body));return contextError({message});
    },{retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>logs.push(entry)});
    await assert.rejects(complete(gateway),{code:'MODEL_CONTEXT_TOO_LONG',modelReason:'context_budget'});
    assert.equal(requests.length,1);
    assert.equal(requests[0].max_tokens,8192);
    assert.equal(JSON.parse(requests[0].messages.at(-1).content).data.source,SOURCE);
    assert.equal(logs.some(entry=>entry.event==='model_operation_retry'),false);
    assert.equal(logs.find(entry=>entry.event==='model_attempt').reason,'context_budget');
    assert.equal(JSON.stringify(logs).includes(SOURCE),false);
  }
});

test('unrelated codes, wrong error types and other statuses do not become capacity rejections',async()=>{
  for(const [overrides,status,code] of [
    [{code:'invalid_model'},400,'MODEL_UPSTREAM_ERROR'],
    [{type:'server_error'},400,'MODEL_UPSTREAM_ERROR'],
    [{},422,'MODEL_UPSTREAM_ERROR'],
    [{},409,'MODEL_UPSTREAM_ERROR'],
    [{},403,'MODEL_AUTH_FAILED'],
  ]) {
    let posts=0;
    const gateway=makeGateway(async(_url,options)=>{
      if(options.method==='GET')return policy();
      posts++;return contextError(overrides,status);
    });
    await assert.rejects(complete(gateway),error=>{
      assert.equal(error.code,code);assert.notEqual(error.modelReason,'context_budget');return true;
    });
    assert.equal(posts,1);
  }
});

test('a structured capacity code preserves the complete output reservation even with a legacy numeric message',async()=>{
  const requests=[];
  const gateway=makeGateway(async(_url,options)=>{
    if(options.method==='GET')return policy();
    requests.push(JSON.parse(options.body));
    return contextError({message:'Prompt (26000) plus max_tokens (8192) exceeds the 32768-token context budget; no text was truncated'});
  });
  await assert.rejects(complete(gateway),{code:'MODEL_CONTEXT_TOO_LONG',modelReason:'context_budget'});
  assert.equal(requests.length,1,'Partitioning must receive the error instead of retrying with 6768 output tokens');
  assert.equal(requests[0].max_tokens,8192);
  assert.equal(JSON.parse(requests[0].messages.at(-1).content).data.source,SOURCE);
});

test('31B capacity codes partition combined final reviews with all inputs, schemas, prompts and fourteen gates intact',async()=>{
  const reference=discoverFixedPolicy(fixture({bundleFinalReviews:false}));
  const value=discoverFixedPolicy(fixture({bundleAnalysisPlan:true,compactReviewOutput:false,
    httpOverride:input=>input.data.tasks?.length>4?contextError():undefined}));
  const expected=await reference.run(),actual=await value.run();
  for(const key of ['guide','assessment','patient_state','name_index','relationship_analysis','relationship_memory','conversation_detail'])
    assert.deepEqual(actual[key],expected[key],key);
  assertDetail(actual);
  assert.equal(reviewStages.length,14);
  for(const stage of reviewStages) {
    const tasks=value.logicalRequests.filter(task=>task.stage===stage);
    const original=reference.logicalRequests.find(task=>task.stage===stage);
    assert.equal(tasks.length,1,stage+' executes exactly once');
    assert.deepEqual(tasks[0].data,original.data,stage+' complete source and claims');
    assert.deepEqual(tasks[0].output_schema,original.output_schema,stage+' full validator schema');
    // Existing shared-instruction encoding removes empty separator lines only.
    // Every nonempty instruction line must still match the standalone review.
    if(tasks[0].bundle_stage)assert.deepEqual(tasks[0].prompt.split('\n').filter(Boolean),
      reference.requests.find(({input})=>input.stage===stage).body.messages[0].content.split('\n').filter(Boolean),stage+' complete instructions');
    assert.ok(actual.agent.stages.includes(stage),stage+' provenance');
  }
  assert.equal(value.stages().filter(stage=>stage==='guide_write').length,1);
  assert.equal(value.stages().filter(stage=>stage==='final_analysis_plan_draft').length,1);
  assert.equal(value.requests.length,12,'One analysis-plan bundle and finite recursive 11-review partition');
  assert.ok(value.requests.every(({body})=>body.max_tokens===8192));
  assert.equal(value.gateway.compactReviewOutput,false);
});

test('an indivisible 31B review that exceeds context stays failed with no fabricated approval or shortened budget',async()=>{
  const value=discoverFixedPolicy(fixture({bundleAnalysisPlan:true,compactReviewOutput:false,
    httpOverride:input=>input.stage.startsWith('final_review_bundle_initial')||input.stage==='speech_review_card_script'
      ?contextError():undefined}));
  await assert.rejects(value.run(),{code:'MODEL_CONTEXT_TOO_LONG',modelReason:'context_budget'});
  assert.ok(value.requests.length<20,'Capacity recovery is finite');
  assert.equal(value.stages().filter(stage=>stage==='guide_write').length,1);
  assert.equal(value.logicalRequests.some(task=>task.stage==='speech_detail'),false);
  assert.equal(value.events.some(event=>event.type==='upsert'&&event.id==='script'),false);
  assert.ok(value.requests.every(({body})=>body.max_tokens===8192));
});
