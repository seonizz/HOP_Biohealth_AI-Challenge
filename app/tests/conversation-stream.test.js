import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('../public/js/core/conversation.js',import.meta.url),'utf8');
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {resolve,promise};};
function fixture(){
  const requests=[],updates=[],cards=[],opened=[],timers=new Map(),result={hidden:false};let sequence=0;
  const context=vm.createContext({
    AbortController,
    API:{request:(path,options)=>{const pending=deferred();requests.push({path,options,...pending});return pending.promise;}},
    ChatScreen:{think(){},thinkProgress:value=>updates.push(value),typing:(_face,work)=>work(),sync(){}},
    ChatInput:{clear(){},waitForQuestion(){}},
    ResultScreen:{prepare(){},progress:value=>updates.push(value),partial:value=>cards.push(value),open:(...args)=>opened.push(args)},
    $:()=>result,rememberRec(){},
    setTimeout:(work,delay)=>{const id=++sequence;timers.set(id,{work,delay});return id;},
    clearTimeout:id=>timers.delete(id),
  });
  vm.runInContext(source+'\nglobalThis.flow={finish,submitConversation,requestConversation,cancelConversationRequest,setState:value=>S=value};',context);
  return {context,flow:context.flow,requests,updates,cards,opened,timers,result};
}

test('pushed cards arrive before saving and disable fallback polling without a second request',async()=>{
  const f=fixture();f.flow.setState({id:'one',revision:1});
  const finishing=f.flow.finish();assert.equal(f.requests.length,1);assert.equal(f.timers.size,1);
  const request=f.requests[0],snapshot={revision:1,progress:{status:'running'},cards:[{id:'script',value:'검토된 문장'}]};
  request.options.onEvent('progress',snapshot);
  assert.equal(f.timers.size,0);assert.deepEqual(f.cards,[snapshot.cards]);assert.equal(f.opened.length,0);
  request.options.onEvent('progress',{...snapshot,revision:99});assert.equal(f.cards.length,1);
  request.resolve({revision:2,record:{id:3,profile:{},guide:{script:'검토된 문장'}}});await finishing;
  assert.equal(f.opened.length,1);assert.equal(f.requests.length,1);
  request.options.onEvent('progress',snapshot);assert.equal(f.cards.length,1,'terminal response retires its progress callback');
});

test('result snapshots cannot update a hidden screen or a cancelled conversation',async()=>{
  const f=fixture();f.flow.setState({id:'one',revision:1});
  const finishing=f.flow.finish(),request=f.requests[0];
  f.result.hidden=true;request.options.onEvent('progress',{revision:1,progress:{status:'running'},cards:[]});
  assert.equal(f.cards.length,0);f.flow.cancelConversationRequest();
  request.options.onEvent('progress',{revision:1,progress:{status:'running'},cards:[]});assert.equal(f.cards.length,0);
  request.resolve({revision:2,record:{id:3,profile:{},guide:{}}});await finishing;
  assert.equal(f.opened.length,0);assert.equal(f.timers.size,0);
});

test('answer streams update loading only for the submitted revision and stop after cancellation',async()=>{
  const f=fixture();f.flow.setState({id:'one',revision:1,question:{id:'q1'},log:[]});
  const pending=f.flow.submitConversation('/api/intakes/one/answers',{revision:1,question_id:'q1',text:'합성 답변'},0);
  const request=f.requests[0];
  request.options.onEvent('progress',{revision:99,progress:{status:'running'},cards:[{id:'script'}]});assert.equal(f.updates.length,0);
  request.options.onEvent('progress',{revision:1,progress:{status:'running'},cards:[{id:'script'}]});assert.equal(f.updates.length,1);assert.equal(f.cards.length,0);
  f.flow.cancelConversationRequest();request.options.onEvent('progress',{revision:1,progress:{status:'running'}});assert.equal(f.updates.length,1);
  request.resolve({revision:2});await pending;
});

test('a replaced request cannot publish events even when the token is unchanged',async()=>{
  const f=fixture(),events=[];
  const first=f.flow.requestConversation('/answers',{onEvent:()=>events.push('old')},0);
  const second=f.flow.requestConversation('/answers',{onEvent:()=>events.push('current')},0);
  f.requests[0].options.onEvent('progress',{revision:1});f.requests[1].options.onEvent('progress',{revision:1});
  assert.deepEqual(events,['current']);
  f.requests[0].resolve({revision:2});f.requests[1].resolve({revision:2});
  await assert.rejects(first,{code:'REQUEST_CANCELLED'});assert.equal((await second).revision,2);
});
