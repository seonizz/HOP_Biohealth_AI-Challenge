import test from 'node:test';
import assert from 'node:assert/strict';
import {createRecoverableRequestQueue,reusableRequestFailure} from '../src/queue-request-recovery.js';

const failure=(id,code='request_cancelled')=>({id,error:{code},recovery:{version:1,request_id:id,request_stopped:true,
 cache_cleared:true,adapter_unchanged:true,worker_reusable:true}});
const ack=id=>({status:'request_cancel_requested',request_id:id});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const firstId='01234567-89ab-4cde-8fab-0123456789ab';
const otherId='01234567-89ab-4cde-8fab-0123456789ac';

test('terminal timeout remains reusable only with matching cleanup proof',()=>{
 assert.equal(reusableRequestFailure(failure(firstId,'request_timeout'),firstId),true);
 assert.equal(reusableRequestFailure(failure(firstId)),true);
 for(const modified of [{...failure(firstId),id:otherId},{...failure(firstId),fatal:true},
  {...failure(firstId),recovery:{...failure(firstId).recovery,adapter_unchanged:false}},
  {...failure(firstId),recovery:undefined},failure(otherId)])assert.equal(reusableRequestFailure(modified,firstId),false);
});

test('cleanup proof cannot establish identity with missing, empty or noncanonical request IDs',()=>{
 const invalidIds=[undefined,null,'','one',firstId.toUpperCase(),firstId.replaceAll('-',''),
  '{'+firstId+'}',' '+firstId,firstId+' ',firstId.slice(0,-1),firstId.replace('a','g')];
 for(const id of invalidIds){
  const envelope=failure(id);
  assert.equal(reusableRequestFailure(envelope),false,`default identity: ${String(id)}`);
  assert.equal(reusableRequestFailure(envelope,id),false,`explicit identity: ${String(id)}`);
  assert.equal(reusableRequestFailure({...failure(firstId),id},firstId),false,`terminal identity: ${String(id)}`);
  assert.equal(reusableRequestFailure({...failure(firstId),recovery:{...failure(firstId).recovery,request_id:id}},firstId),false,
   `proof identity: ${String(id)}`);
 }
 const missing=failure(firstId);delete missing.id;delete missing.recovery.request_id;
 assert.equal(reusableRequestFailure(missing),false);
});

test('a verified request timeout permits a following request without restarting the worker',async()=>{
 const ids=[];
 const queue=createRecoverableRequestQueue({call:async({id})=>{ids.push(id);return ids.length===1?failure(id,'request_timeout'):{id,response:{ok:true}};},cancelRequest:async()=>assert.fail('No cancellation required')});
 assert.equal((await queue.request({})).error.code,'request_timeout');
 assert.equal((await queue.request({})).response.ok,true);assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);assert.equal(queue.fatal,null);
});

test('consumer cancellation preserves the transport and FIFO slot through terminal cleanup acknowledgement',async()=>{
 const started=deferred(),terminal=deferred(),controller=new AbortController(),cancelled=[];let calls=0,transportSignal,activeId;
 const queue=createRecoverableRequestQueue({call:async({id},{signal})=>{
  calls++;if(calls===1){activeId=id;transportSignal=signal;started.resolve();await terminal.promise;return failure(id);}
  return {id,response:{ok:true}};
 },cancelRequest:async id=>{cancelled.push(id);return ack(id);}});
 const first=queue.request({}, {cancelSignal:controller.signal});await started.promise;
 controller.abort();const second=queue.request({});await new Promise(done=>setImmediate(done));
 assert.equal(calls,1);assert.equal(transportSignal.aborted,false);assert.deepEqual(cancelled,[activeId]);
 terminal.resolve();assert.equal((await first).error.code,'request_cancelled');assert.equal((await second).response.ok,true);
 assert.equal(calls,2);assert.equal(queue.fatal,null);
});

test('cancel acknowledgement timeout is fatal and cannot dispatch a second request',{timeout:1000},async()=>{
 const started=deferred(),controller=new AbortController();let calls=0;
 const queue=createRecoverableRequestQueue({cancelAckTimeoutMs:10,call:async()=>{calls++;started.resolve();return new Promise(()=>{});},cancelRequest:async id=>ack(id)});
 const first=queue.request({}, {cancelSignal:controller.signal});await started.promise;controller.abort();
 await assert.rejects(first,{code:'request_cancel_ack_timeout'});await assert.rejects(queue.request({}),{code:'request_cancel_ack_timeout'});assert.equal(calls,1);
});

test('missing cleanup, worker crash and mismatched terminal IDs remain fatal',async()=>{
 for(const reply of [id=>({id,error:{code:'request_timeout'}}),id=>({id,error:{code:'worker_failed',fatal:true}}),()=>({id:'wrong',response:{ok:true}})]){
  let calls=0;const queue=createRecoverableRequestQueue({call:async({id})=>{calls++;return reply(id);},cancelRequest:async id=>ack(id)});
  await assert.rejects(queue.request({}),error=>error.fatal===true);await assert.rejects(queue.request({}),error=>error.fatal===true);assert.equal(calls,1);
 }
});

test('abort after a terminal receipt cannot cancel a later request',async()=>{
 const controller=new AbortController(),cancelled=[];
 const queue=createRecoverableRequestQueue({call:async({id})=>({id,response:{ok:true}}),cancelRequest:async id=>{cancelled.push(id);return ack(id);}});
 await queue.request({}, {cancelSignal:controller.signal});controller.abort();await queue.request({});assert.deepEqual(cancelled,[]);
});
