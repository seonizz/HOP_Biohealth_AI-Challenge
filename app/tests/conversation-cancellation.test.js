import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const script=path=>readFileSync(new URL(`../public/js/${path}`,import.meta.url),'utf8');
function fixture(){
  const calls=[];
  const context=vm.createContext({AbortController,fetch:(_path,options)=>{
    calls.push(options);
    return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
  }});
  vm.runInContext(script('core/api.js')+script('core/conversation.js')+'\nglobalThis.flow={requestConversation,cancelConversationRequest,token:()=>conversationToken};',context);
  return {calls,flow:context.flow};
}

test('leaving a conversation cancels the owned HTTP generation and invalidates its token',async()=>{
  const {calls,flow}=fixture();
  const pending=flow.requestConversation('/api/intakes/synthetic/result',{method:'POST',body:{revision:1}},0);
  assert.equal(calls[0].signal.aborted,false);
  flow.cancelConversationRequest();
  await assert.rejects(pending,{code:'REQUEST_CANCELLED',status:499});
  assert.equal(calls[0].signal.aborted,true);assert.equal(flow.token(),1);
  await assert.rejects(flow.requestConversation('/api/intakes/synthetic/result',{},0),{code:'REQUEST_CANCELLED'});
  assert.equal(calls.length,1);
});

test('replacing a request cancels the old request without canceling the new one',async()=>{
  const {calls,flow}=fixture();
  const old=flow.requestConversation('/api/intakes/synthetic/answers',{method:'POST',body:{revision:1}},0);
  const current=flow.requestConversation('/api/intakes/synthetic/answers',{method:'POST',body:{revision:2}},0);
  await assert.rejects(old,{code:'REQUEST_CANCELLED'});
  assert.equal(calls[0].signal.aborted,true);assert.equal(calls[1].signal.aborted,false);
  flow.cancelConversationRequest();await assert.rejects(current,{code:'REQUEST_CANCELLED'});
  assert.equal(calls[1].signal.aborted,true);
});

test('a replaced response cannot return stale data even when its body has already arrived',async()=>{
  const queue=[];
  const context=vm.createContext({AbortController,API:{request:()=>new Promise(resolve=>queue.push(resolve))}});
  vm.runInContext(script('core/conversation.js')+'\nglobalThis.request=requestConversation;',context);
  const old=context.request('/api/intakes/synthetic/answers',{method:'POST'},0);
  const current=context.request('/api/intakes/synthetic/answers',{method:'POST'},0);
  queue[0]({revision:1});queue[1]({revision:2});
  await assert.rejects(old,{code:'REQUEST_CANCELLED'});
  assert.equal((await current).revision,2);
});
