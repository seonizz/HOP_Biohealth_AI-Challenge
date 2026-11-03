import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {HttpError} from '../src/errors.js';

const revision='a'.repeat(64),newRevision='b'.repeat(64);
const policy=(extra={})=>new Response(JSON.stringify({model:'synthetic-model',max_output_tokens:8192,max_context_tokens:32768,token_policy_revision:revision,...extra}));
const answer=()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));
const changed=()=>new Response(JSON.stringify({error:{code:'token_policy_changed'}}),{status:409});
const create=(fetchImpl,options={})=>new ModelGateway({baseUrl:'https://synthetic.invalid/v1',model:'synthetic-model',apiKey:'synthetic-key',
  protocol:'relationship_agent',timeoutMs:0,discoverTokenLimits:true,reuseTokenPolicy:true,diagnosticLogger:null,fetchImpl,...options});
const complete=(gateway,operation,stage='guide_review')=>gateway.agentComplete(stage,'Synthetic instructions',{source:'synthetic'},
  {type:'object'},operation,value=>value);

test('concurrent delegated reviews share one authenticated policy lookup while preserving separate writer capacity',async()=>{
  let writerGets=0,reviewGets=0;const calls=[];
  const reviewer=create(async(_url,options)=>{
    if(options.method==='GET'){reviewGets++;await new Promise(resolve=>setImmediate(resolve));return policy({max_output_tokens:4096});}
    calls.push({role:'review',options});return answer();
  });
  const writer=create(async(_url,options)=>{
    if(options.method==='GET'){writerGets++;return policy();}
    calls.push({role:'writer',options});return answer();
  },{reviewGateway:reviewer});
  await writer.operation({},async operation=>{
    await complete(writer,operation,'guide_write');
    await Promise.all(Array.from({length:14},()=>complete(writer,operation)));
  });
  assert.equal(writerGets,1);assert.equal(reviewGets,1);assert.equal(calls.length,15);
  for(const {role,options} of calls){
    assert.equal(JSON.parse(options.body).max_tokens,role==='writer'?8192:4096);
    assert.equal(options.headers['X-Malssi-Token-Policy-Revision'],revision);
  }
  await writer.operation({},operation=>complete(writer,operation));
  assert.equal(writerGets,2);assert.equal(reviewGets,2,'New operations never reuse old metadata');
});

test('legacy metadata, unsupported endpoints and disabled reuse keep fresh reviewer discovery',async()=>{
  for(const mode of ['legacy','unsupported','disabled']){
    let gets=0;const headers=[];
    const reviewer=create(async(_url,options)=>{
      if(options.method==='GET'){gets++;return mode==='unsupported'?new Response('',{status:404}):policy(mode==='legacy'?{token_policy_revision:undefined}:{});}
      headers.push(options.headers);return answer();
    },{reuseTokenPolicy:mode!=='disabled'});
    const writer=create(async()=>assert.fail('writer discovery disabled'),{discoverTokenLimits:false,reviewGateway:reviewer});
    await writer.operation({},async operation=>{for(let i=0;i<3;i++)await complete(writer,operation);});
    assert.equal(gets,3,mode);
    assert.ok(headers.every(value=>!Object.hasOwn(value,'X-Malssi-Token-Policy-Revision')),mode);
  }
});

test('concurrent legacy reviews retain independent discovery when their first lookup has no guarded revision',async()=>{
  for(const unsupported of [false,true]){
    let gets=0;
    const reviewer=create(async(_url,options)=>{
      if(options.method==='GET'){
        gets++;await new Promise(resolve=>setImmediate(resolve));
        return unsupported?new Response('',{status:404}):policy({token_policy_revision:undefined});
      }
      assert.equal(options.headers['X-Malssi-Token-Policy-Revision'],undefined);
      return answer();
    });
    const writer=create(async()=>assert.fail('no writer fetch'),{discoverTokenLimits:false,reviewGateway:reviewer});
    await writer.operation({},operation=>Promise.all(Array.from({length:3},()=>complete(writer,operation))));
    assert.equal(gets,3);
  }
});

test('a replaced server rejects a stale revision and the same request retries with fresh limits and unchanged inputs',async()=>{
  let gets=0;const calls=[];
  const gateway=create(async(_url,options)=>{
    if(options.method==='GET')return policy(++gets===1?{}:{token_policy_revision:newRevision,max_output_tokens:4096});
    calls.push(options);return calls.length===1?changed():answer();
  });
  assert.deepEqual(await gateway.operation({},operation=>complete(gateway,operation)),{ok:true});
  assert.equal(gets,2);assert.equal(calls.length,2);
  assert.deepEqual(calls.map(call=>call.headers['X-Malssi-Token-Policy-Revision']),[revision,newRevision]);
  const [before,after]=calls.map(call=>JSON.parse(call.body));
  assert.equal(after.max_tokens,4096);assert.deepEqual({...after,max_tokens:before.max_tokens},before);
});

test('unrelated 409s and refreshed discovery failures do not dispatch or pretend to succeed',async()=>{
  for(const scenario of ['other409','auth','invalid','unavailable']){
    let gets=0,posts=0;
    const gateway=create(async(_url,options)=>{
      if(options.method==='GET'){
        if(++gets===1)return policy();
        if(scenario==='invalid')return policy({max_output_tokens:0});
        return new Response('',{status:scenario==='auth'?401:503});
      }
      posts++;return scenario==='other409'?new Response('{}',{status:409}):changed();
    });
    await assert.rejects(gateway.operation({},operation=>complete(gateway,operation)),
      {code:scenario==='other409'?'MODEL_UPSTREAM_ERROR':'MODEL_UNAVAILABLE'});
    assert.equal(posts,1,scenario);assert.equal(gets,scenario==='other409'?1:2,scenario);
  }
});

test('failed lookups are evicted and a cancelled owner never dispatches a cached review',async()=>{
  let gets=0,posts=0;
  const reviewer=create(async(_url,options)=>{
    if(options.method==='GET')return ++gets===1?new Response('',{status:401}):policy();
    posts++;return answer();
  });
  const writer=create(async()=>assert.fail('no writer fetch'),{discoverTokenLimits:false,reviewGateway:reviewer});
  const controller=new AbortController();
  await assert.rejects(writer.operation({signal:controller.signal},async operation=>{
    await assert.rejects(complete(writer,operation),{code:'MODEL_UNAVAILABLE'});
    await complete(writer,operation);
    controller.abort();
    return complete(writer,operation);
  }),{code:'MODEL_CANCELLED'});
  assert.equal(gets,2);assert.equal(posts,1);
});

test('operation restart and target credential changes invalidate the cache',async()=>{
  let gets=0,runs=0;
  const reviewer=create(async(_url,options)=>{if(options.method==='GET'){gets++;return policy();}return answer();});
  const writer=create(async()=>assert.fail('no writer fetch'),{discoverTokenLimits:false,reviewGateway:reviewer,retryFailures:true,retryDelayMs:1});
  await writer.operation({},async operation=>{
    runs++;
    await complete(writer,operation);
    if(runs===1){const error=new HttpError(502,'MODEL_INVALID_RESPONSE','Synthetic rejection');throw error;}
    reviewer.apiKey='changed-synthetic-key';
    await complete(writer,operation);
  });
  assert.equal(runs,2);assert.equal(gets,3);
});

test('backend unavailable status still rejects every POST even with a cached policy',async()=>{
  let gets=0,posts=0;
  const reviewer=create(async(_url,options)=>{
    if(options.method==='GET'){gets++;return policy();}
    if(++posts===1)return answer();
    return new Response('{}',{status:503,headers:{'Retry-After':'0'}});
  });
  const writer=create(async()=>assert.fail('no writer fetch'),{discoverTokenLimits:false,reviewGateway:reviewer});
  await assert.rejects(writer.operation({},async operation=>{await complete(writer,operation);await complete(writer,operation);}),{code:'MODEL_UNAVAILABLE'});
  assert.equal(posts,4);assert.equal(gets,3,'The two retries refresh invalidated metadata');
});
