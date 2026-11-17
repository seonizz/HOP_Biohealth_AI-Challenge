import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import * as helpers from './run_controlled_full_flow.mjs';
import {modelStageRole} from '../../app/src/model-operation-metrics.js';
import {fileURLToPath} from 'node:url';
import {PROFILE,REGIMES,hash,pinIdentity,verifyReply,createTransport,localQueueBackend,remoteQueueBackend,REMOTE_FS_SCRIPT,run} from './ubuntu_controlled_full_flow.mjs';

const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
const stableHash=value=>hash(sorted(value));
const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');};
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ubuntu-flow-test-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'work'));
  const protocol={base_files:[{name:'config.json',sha256:'b'.repeat(64)}],base_snapshot:'/bound/base',base_revision:'revision',models:[
    {id:'baseline',adapter:null},{id:'B_original',adapter:'/bound/B',adapter_sha256:'c'.repeat(64)},
    {id:'C_user_provided',adapter:'/bound/C',adapter_sha256:'d'.repeat(64)}]};
  write(path.join(root,'protocol.json'),protocol);write(path.join(root,'SOURCE_SHA256.json'),{});
  const runtime={protocol_sha256:hash(fs.readFileSync(path.join(root,'protocol.json'))),base_model_digest:stableHash({'config.json':'b'.repeat(64)}),base_snapshot:protocol.base_snapshot,base_revision:protocol.base_revision};
  write(path.join(root,'work/RUNTIME.json'),runtime);
  return {root,identity:pinIdentity(root)};
}
function response(request,identity,status=200) {
  const model=identity.models.get(request.model),adapter=model.adapter?model.adapter_sha256:null;
  return {request_id:request.request_id,status,response:status===200?{model:request.model,choices:[{message:{role:'assistant',content:'{}'},finish_reason:'stop'}]}:{error:{code:'context_length_exceeded'}},
    proof:{model:request.model,adapter_sha256:adapter,adapter_source_sha256:adapter,protocol_sha256:identity.protocol_sha256,
      runtime_sha256:identity.runtime_sha256,base_model_digest:identity.base_model_digest,
      actual_adapter_enabled:Boolean(model.adapter),all_lora_flags_verified:true,lora_layer_count:10,
      fresh_kv_cache:true,input_truncated:false,activation:model.adapter?{all_named_lora_tensors_equal:true}:{mode:'PEFT.disable_adapter'}}};
}
function requestOptions(stage='state_observations',extra={}) {
  return {method:'POST',body:JSON.stringify({messages:[{role:'user',content:JSON.stringify({stage,data:{synthetic:true}})}],max_tokens:128}),...extra};
}
const endpoint='http://127.0.0.1/v1/chat/completions';

// Exact frozen fixture/stage helpers execute; only model generation is replaced.
function deps(Gateway) {
  const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  return {helpers,Gateway,modelStageRole,sourceFingerprint:()=>({files:[],sha256:hash([])}),
    questions:JSON.parse(fs.readFileSync(path.join(repository,'ai/local_api/agent_data/questions.json')))};
}

test('eighteen early model failures preserve six-per-regime denominators and zero HTTP posts',async t=>{
  const {root}=fixture(t);let dispatches=0;
  class Gateway {
    constructor(options){this.options=options;}
    async agentComplete(){throw Object.assign(new Error('synthetic model contract failure'),{code:'MODEL_INVALID_RESPONSE'});}
    async respond(){return this.agentComplete('state_observations','prompt',{synthetic:true},{type:'object'});}
  }
  const backend={write:async()=>{dispatches++;},description:{kind:'mock_no_network'}};
  const result=await run({root,work:path.join(root,'work/flow'),queue:path.join(root,'work/queue'),backend,deps:deps(Gateway)});
  assert.equal(result.status,'completed');assert.equal(result.assigned,18);assert.equal(result.completed,18);
  assert.equal(result.failed_count,18);assert.equal(result.not_run_count,0);assert.equal(result.actual_http_posts,0);assert.equal(dispatches,0);
  for(const regime of REGIMES){assert.equal(result.M02.by_regime[regime.id].denominator,6);assert.equal(result.M02.by_regime[regime.id].value,0);}
  assert.equal(result.M02.comparisons.B_reviewer_vs_baseline.comparison_scope,'reviewer_effect_writer_fixed_baseline');
  assert.equal(result.M02.comparisons.C_combined_vs_baseline.comparison_scope,'combined_configuration_effect_not_isolated_generator_effect');
  assert.equal(PROFILE.agentFormat,'prompt');
});

test('filesystem queue mock worker routes writer and reviewer to the exact regime models',async t=>{
  const {root,identity}=fixture(t),queue=path.join(root,'work/queue'),backend=localQueueBackend(queue),models=[];
  const timer=setInterval(()=>{
    for(const name of fs.readdirSync(queue)) {
      const directory=path.join(queue,name),input=path.join(directory,'request.json'),output=path.join(directory,'response.json');
      if(!fs.existsSync(input)||fs.existsSync(output))continue;
      const request=JSON.parse(fs.readFileSync(input));models.push(request.model);write(output,response(request,identity));
    }
  },2);t.after(()=>clearInterval(timer));
  for(const regime of REGIMES) {
    const output=path.join(root,'work',regime.id);fs.mkdirSync(output);
    const transport=createTransport({output,assignment:{regime:regime.id,case_id:'abc'},backend,identity,modelStageRole});
    const generated=await transport.generatorFetch(endpoint,requestOptions());assert.equal(generated.status,200);
    const reviewed=await transport.reviewerFetch(endpoint,requestOptions('state_review'));assert.equal(reviewed.status,200);
    assert.deepEqual(transport.records.map(row=>row.model),[regime.writer,regime.reviewer]);
    assert.equal(transport.records.filter(row=>row.filesystem_dispatch).length,2);
    assert.ok(transport.records.every(row=>row.actual_http_post===false));
  }
  assert.deepEqual(models,['baseline','baseline','baseline','B_original','C_user_provided','C_user_provided']);
});

test('proof mismatch is fatal and prevents later dispatch, while linked 400/504 are model failures',async t=>{
  const {root,identity}=fixture(t),output=path.join(root,'work/transport');fs.mkdirSync(output);
  let sent=0,current,cancelled=0;
  const backend={write:async request=>{sent++;current=request;},read:async()=>{
    const reply=response(current,identity);reply.proof.runtime_sha256='0'.repeat(64);return reply;},cancel:async()=>{cancelled++;},pollMs:1};
  const transport=createTransport({output,assignment:{regime:'baseline',case_id:'a'},backend,identity,modelStageRole});
  await assert.rejects(transport.generatorFetch(endpoint,requestOptions()),/queue_runtime_identity_mismatch/);
  await assert.rejects(transport.generatorFetch(endpoint,requestOptions()),/queue_runtime_identity_mismatch/);
  assert.equal(sent,1);assert.equal(cancelled,0);assert.ok(transport.failure());
  const request={request_id:'test',model:'B_original'};
  assert.ok(verifyReply(response(request,identity,400),request,identity));
  assert.ok(verifyReply(response(request,identity,504),request,identity));
  const wrong=response(request,identity);wrong.proof.model='baseline';assert.throws(()=>verifyReply(wrong,request,identity),/model_proof/);
});

test('resident 503 stops the remaining seventeen cases as unstarted rather than a failure cascade',async t=>{
  const {root}=fixture(t);let current,count=0;
  const backend={write:async request=>{current=request;count++;},read:async()=>({request_id:current.request_id,status:503,response:{error:{code:'worker_lost'}}}),cancel:async()=>{},description:{kind:'mock_no_network'}};
  class Gateway {
    constructor(options){this.options=options;}
    async agentComplete(stage){const res=await this.options.fetchImpl(endpoint,requestOptions(stage));return res.json();}
    async respond(){return this.agentComplete('state_observations','prompt',{},{});}
  }
  const result=await run({root,work:path.join(root,'work/flow'),queue:path.join(root,'work/queue'),backend,deps:deps(Gateway)});
  assert.equal(count,1);assert.equal(result.status,'infrastructure_interrupted');assert.equal(result.completed,0);
  assert.equal(result.infrastructure_interrupted_case_count,1);assert.equal(result.not_run_count,17);
  assert.equal(result.M02.by_regime.baseline.value,null);
});

test('cancellation leaves an explicit queue marker and blocks further dispatch',async t=>{
  const {root,identity}=fixture(t),output=path.join(root,'work/transport');fs.mkdirSync(output);
  const abort=new AbortController();let writes=0,cancels=0;
  const backend={write:async()=>{writes++;},read:async()=>{abort.abort();return null;},cancel:async()=>{cancels++;},pollMs:1};
  const transport=createTransport({output,assignment:{regime:'baseline',case_id:'cancel'},backend,identity,modelStageRole,cancelSignal:abort.signal});
  await assert.rejects(transport.generatorFetch(endpoint,requestOptions('state_observations',{signal:abort.signal})),/queue_request_cancelled/);
  assert.equal(writes,1);assert.equal(cancels,1);assert.ok(transport.failure());
});

test('SSH adapter sends payload only on stdin and uses a fixed approved Python queue program',async()=>{
  const calls=[];
  const mock=(program,args,options,callback)=>{
    const record={program,args,options,input:null};calls.push(record);
    return {stdin:{on(){},end(input){record.input=input;queueMicrotask(()=>callback(null,'{"written":true}'));}}};
  };
  const backend=remoteQueueBackend({host:'chihun@chihun-ubuntu',remoteRoot:'/home/chihun/Documents/HOP/evaluations/role_eval_20261112',execFileImpl:mock});
  const dangerous='$(touch /outside) `not instructions`';
  await backend.write({request_id:'flow-safe',model:'baseline',payload:{messages:[{role:'user',content:dangerous}]}});
  assert.equal(calls[0].program,'ssh');assert.ok(calls[0].args.includes('BatchMode=yes'));
  assert.ok(!calls[0].args.at(-1).includes(dangerous));assert.ok(calls[0].input.includes(dangerous));
  assert.throws(()=>remoteQueueBackend({host:'other@host',remoteRoot:'/tmp'}),/unapproved_remote_queue/);
  execFileSync('/usr/bin/python3',['-I','-S','-B','-c','import sys;compile(sys.stdin.read(),"remote_queue","exec")'],{input:REMOTE_FS_SCRIPT});
});

test('runtime identity and profile failures are rejected before any model dispatch',t=>{
  const {root}=fixture(t);const file=path.join(root,'work/RUNTIME.json'),runtime=JSON.parse(fs.readFileSync(file));
  runtime.protocol_sha256='0'.repeat(64);write(file,runtime);assert.throws(()=>pinIdentity(root),/runtime_protocol_binding_mismatch/);
});

test('SSH reconnect resubmits the identical request after an ambiguous acknowledgement loss',async()=>{
  const calls=[];let attempt=0;
  const mock=(program,args,options,callback)=>({stdin:{on(){},end(input){calls.push(JSON.parse(input));queueMicrotask(()=>{
    if(++attempt===1)callback(Object.assign(new Error('connection reset after remote write'),{code:255}),'');
    else callback(null,'{"written":true,"reused":true}');
  });}}});
  const backend=remoteQueueBackend({host:'chihun@chihun-ubuntu',remoteRoot:'/home/chihun/Documents/HOP/evaluations/role_eval_20261112_resume1',execFileImpl:mock,retryMs:1});
  const receipt=await backend.write({request_id:'flow-identical',model:'baseline',payload:{messages:[]}});
  assert.equal(receipt.reused,true);assert.deepEqual(calls[0],calls[1]);
});

test('resuming a terminal failed case preserves its bytes and skips its model calls',async t=>{
  const {root}=fixture(t);let count=0;
  class Gateway {
    constructor(options){this.options=options;}
    async agentComplete(){count++;throw Object.assign(new Error('synthetic failure'),{code:'MODEL_INVALID_RESPONSE'});}
    async respond(){return this.agentComplete('state_observations','prompt',{},{});}
  }
  const backend={description:{kind:'mock_no_network'}},first=path.join(root,'work/first');
  await run({root,work:first,queue:path.join(root,'work/queue'),backend,deps:deps(Gateway)});
  const summary=JSON.parse(fs.readFileSync(path.join(first,'summary.json')));summary.results=summary.results.slice(0,1);write(path.join(first,'summary.json'),summary);
  const name=summary.results[0].logical_case_id.replace(':','-'),before=hash(fs.readFileSync(path.join(first,name,'result.json')));
  count=0;const second=path.join(root,'work/second');
  const result=await run({root,work:second,queue:path.join(root,'work/queue'),backend,deps:deps(Gateway),resumeFrom:first});
  assert.equal(count,17);assert.equal(result.completed,18);assert.equal(hash(fs.readFileSync(path.join(second,name,'result.json'))),before);
});

test('prior persisted response is consumed without another GPU queue dispatch',async t=>{
  const {root,identity}=fixture(t),output=path.join(root,'work/replay');fs.mkdirSync(output);let writes=0;
  const backend={write:async()=>{writes++;},replay:request=>({reply:response(request,identity),identity,source_sha256:'e'.repeat(64)})};
  const transport=createTransport({output,assignment:{regime:'B_reviewer',case_id:'replay'},backend,identity,modelStageRole});
  const reply=await transport.generatorFetch(endpoint,requestOptions());
  assert.equal(reply.status,200);assert.equal(writes,0);assert.equal(transport.records[0].reused_prior_response,true);
  assert.equal(transport.records[0].filesystem_dispatch,false);
});

test('remote queue write is idempotent only for byte-equivalent request content',t=>{
  const temporary=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'ubuntu-queue-idempotent-')));
  t.after(()=>fs.rmSync(temporary,{recursive:true,force:true}));fs.mkdirSync(path.join(temporary,'work/fs-requests'),{recursive:true});
  const script=REMOTE_FS_SCRIPT.replace("root=Path('/home/chihun/Documents/HOP/evaluations/role_eval_20261112')",'root=Path('+JSON.stringify(temporary)+')');
  const request={request_id:'flow-same',model:'baseline',payload:{messages:[{role:'user',content:'same'}]}};
  const call=value=>JSON.parse(execFileSync('/usr/bin/python3',['-I','-S','-B','-c',script],{input:JSON.stringify({operation:'write',request_id:value.request_id,request:value}),stdio:['pipe','pipe','pipe']}));
  assert.equal(call(request).reused,false);assert.equal(call(request).reused,true);
  const changed=structuredClone(request);changed.payload.messages[0].content='different';
  assert.throws(()=>call(changed));assert.equal(fs.readdirSync(path.join(temporary,'work/fs-requests')).length,1);
});
