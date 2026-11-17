import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';

const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
const response=()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
const make=(fetchImpl,options={})=>new ModelGateway({
  baseUrl:'http://127.0.0.1:18080/v1',apiKey:'private-key',protocol:'relationship_agent',
  agentFormat:'prompt',reasoningEffort:'omit',timeoutMs:0,retryFailures:true,retryDelayMs:1,
  diagnosticLogger:()=>{},fetchImpl,...options,
});
const stage=(gateway,operation,name='guide_write')=>
  gateway.agentComplete(name,'synthetic',{},schema,operation,value=>value);
const waitForAbort=signal=>new Promise((resolve,reject)=>{
  const abort=()=>reject(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
});

test('persistent HTTP 500 stops after two operation restarts even without a timeout',{timeout:1000},async()=>{
  let calls=0;const records=[];
  const gateway=make(async()=>{calls++;return new Response('private upstream detail',{status:500});},
    {diagnosticLogger:entry=>records.push(entry)});
  await assert.rejects(gateway.operation({},operation=>stage(gateway,operation)),
    {code:'MODEL_UPSTREAM_ERROR',modelReason:'http_transient'});
  assert.equal(calls,3);
  assert.deepEqual(records.filter(row=>row.event==='model_operation_retry').map(row=>row.attempt),[1,2]);
  assert.doesNotMatch(JSON.stringify(records),/private upstream detail|private-key/);
});

test('successful recovery after two transient failures retains the original operation deadline',async()=>{
  let calls=0;const deadlines=[];
  const gateway=make(async()=>++calls<=2?new Response('',{status:500}):response(),{timeoutMs:2000});
  const result=await gateway.operation({},operation=>{
    deadlines.push(operation.deadline);
    return stage(gateway,operation);
  });
  assert.deepEqual(result,{ok:true});
  assert.equal(calls,3);assert.equal(deadlines.length,3);
  assert.ok(Number.isFinite(deadlines[0]));
  assert.equal(new Set(deadlines).size,1);
});

test('operation deadline interrupts retry backoff before any subsequent request',{timeout:1000},async()=>{
  let calls=0;const records=[];
  const gateway=make(async()=>{calls++;return new Response('',{status:500});},
    {timeoutMs:80,retryDelayMs:2000,diagnosticLogger:entry=>records.push(entry)});
  const started=performance.now();
  await assert.rejects(gateway.operation({},operation=>stage(gateway,operation)),{code:'MODEL_TIMEOUT'});
  assert.equal(calls,1);
  assert.equal(records.filter(row=>row.event==='model_operation_retry').length,1);
  assert.ok(performance.now()-started<800,'deadline must interrupt the two-second backoff');
});

test('reviewer with no timeout inherits the parent deadline and preserves its timeout reason',{timeout:1000},async()=>{
  let calls=0,writerDeadline,reviewDeadline,reviewError,reviewSignal;
  const writer=make(()=>assert.fail('review request must use the reviewer'),{timeoutMs:80});
  const reviewer=make((_url,{signal})=>{calls++;reviewSignal=signal;return waitForAbort(signal);});
  const runReview=reviewer.operation.bind(reviewer);
  reviewer.operation=(options,generate,settings)=>runReview(options,operation=>{
    reviewDeadline=operation.deadline;return generate(operation);
  },settings).catch(error=>{reviewError=error;throw error;});
  writer.reviewGateway=reviewer;
  await assert.rejects(writer.operation({},operation=>{
    writerDeadline=operation.deadline;
    return stage(writer,operation,'guide_review');
  }),{code:'MODEL_TIMEOUT'});
  assert.equal(calls,1);
  assert.equal(reviewDeadline,writerDeadline);
  assert.equal(reviewSignal.aborted,true);
  assert.equal(reviewError.code,'MODEL_TIMEOUT');
});

test('a reviewer retains its own shorter timeout within the parent budget',{timeout:1000},async()=>{
  let calls=0,writerDeadline,reviewDeadline;
  const writer=make(()=>assert.fail('review request must use the reviewer'),{timeoutMs:2000,retryFailures:false});
  const reviewer=make((_url,{signal})=>{calls++;return waitForAbort(signal);},{timeoutMs:40});
  const runReview=reviewer.operation.bind(reviewer);
  reviewer.operation=(options,generate,settings)=>runReview(options,operation=>{
    reviewDeadline=operation.deadline;return generate(operation);
  },settings);
  writer.reviewGateway=reviewer;
  await assert.rejects(writer.operation({},operation=>{
    writerDeadline=operation.deadline;return stage(writer,operation,'guide_review');
  }),{code:'MODEL_TIMEOUT'});
  assert.equal(calls,1);
  assert.ok(reviewDeadline<writerDeadline);
});
