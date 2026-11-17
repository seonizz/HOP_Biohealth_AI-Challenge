import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {getEventListeners} from 'node:events';
import vm from 'node:vm';

const script=readFileSync(new URL('../public/js/core/api.js',import.meta.url),'utf8');
const encoder=new TextEncoder();
const event=(type,value)=>`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
const fixture=fetch=>{
  const context=vm.createContext({fetch,TextDecoder});
  vm.runInContext(script+'\nglobalThis.api=API;',context);
  return context.api;
};
const response=(wire,{open=false,onCancel=()=>{}}={})=>new Response(new ReadableStream({
  start(controller){for(const byte of encoder.encode(wire))controller.enqueue(Uint8Array.of(byte));if(!open)controller.close();},
  cancel:onCancel,
}),{headers:{'content-type':'text/event-stream; charset=utf-8'}});
const plain=value=>JSON.parse(JSON.stringify(value));

test('streaming POST preserves session/CSRF and decodes UTF-8, CRLF, comments and multiline data',async()=>{
  const progress={revision:1,progress:{current:'한글 😀'},cards:[{id:'script',value:'안녕'}]};
  const wire=': heartbeat\r\n\r\n'+event('progress',progress).replaceAll('\n','\r\n')+
    'event: result\r\ndata: {"revision":2,\r\ndata: "record":{"id":3,"guide":{"script":"친구 😀"}}}\r\n\r\n';
  let options,cancels=0;const incoming=response(wire,{open:true,onCancel:()=>cancels++}),events=[];
  const api=fixture(async(path,input)=>{assert.equal(path,'/api/intakes/example/result');options=input;return incoming;});
  api.csrf='csrf-token';
  const result=await api.request('/api/intakes/example/result',{method:'POST',body:{revision:1},onEvent:(type,value)=>events.push([type,plain(value)])});
  assert.equal(options.headers.Accept,'text/event-stream');assert.equal(options.headers['X-CSRF-Token'],'csrf-token');
  assert.equal(options.credentials,'same-origin');assert.deepEqual(JSON.parse(options.body),{revision:1});
  assert.deepEqual(events,[['progress',progress]]);assert.deepEqual(plain(result),{revision:2,record:{id:3,guide:{script:'친구 😀'}}});
  assert.equal(cancels,1);assert.equal(incoming.body.locked,false);
});

test('streaming requests retain ordinary JSON success and early HTTP errors without resending',async()=>{
  for(const status of [200,409]){
    let calls=0;const payload=status===200?{revision:2}:{error:{code:'REVISION_CONFLICT',message:'다시 확인해 주세요.'}};
    const api=fixture(async()=>{calls++;return new Response(JSON.stringify(payload),{status,headers:{'content-type':'application/json'}});});
    const pending=api.request('/api/intakes/example/answers',{method:'POST',onEvent(){throw new Error('unexpected event');}});
    if(status===200)assert.deepEqual(plain(await pending),payload);
    else await assert.rejects(pending,{status,code:'REVISION_CONFLICT',message:'다시 확인해 주세요.'});
    assert.equal(calls,1);
  }
});

test('stream errors preserve public status/code and release their response',async()=>{
  const incoming=response(event('progress',{revision:1})+event('error',{status:502,error:{code:'MODEL_INVALID_RESPONSE',message:'답변 확인 실패'}}),{open:true});
  const api=fixture(async()=>incoming);
  await assert.rejects(api.request('/result',{onEvent(){}}),{status:502,code:'MODEL_INVALID_RESPONSE',message:'답변 확인 실패'});
  assert.equal(incoming.body.locked,false);
});

for(const [name,wire] of [
  ['missing terminal',event('progress',{revision:1})],
  ['unframed terminal','event: result\ndata: {"revision":2}\n'],
  ['invalid JSON','event: progress\ndata: PRIVATE_SENTINEL\n\n'],
  ['invalid payload',event('result',null)],
])test(`a ${name} is recoverable and never retries the POST`,async()=>{
  let calls=0;const incoming=response(wire),api=fixture(async()=>{calls++;return incoming;});
  await assert.rejects(api.request('/answers',{method:'POST',onEvent(){}}),error=>{
    assert.equal(error.status,0);assert.doesNotMatch(error.message,/PRIVATE_SENTINEL/);return true;
  });
  assert.equal(calls,1);assert.equal(incoming.body.locked,false);
});

test('invalid UTF-8 is rejected and UI callback failure does not lose the saved result',async()=>{
  const invalid=new Response(new ReadableStream({start(controller){controller.enqueue(Uint8Array.of(255));controller.close();}}),{headers:{'content-type':'text/event-stream'}});
  const api=fixture(async()=>invalid);
  await assert.rejects(api.request('/result',{onEvent(){}}),{status:0});assert.equal(invalid.body.locked,false);
  const valid=fixture(async()=>response(event('progress',{revision:1})+event('result',{revision:2})));
  assert.equal((await valid.request('/result',{onEvent(){throw new Error('presentation failure');}})).revision,2);
});

test('cancellation interrupts a stalled stream and removes the listener and reader lock',async()=>{
  let entered,cancels=0;const started=new Promise(resolve=>entered=resolve),controller=new AbortController();
  const incoming=new Response(new ReadableStream({pull(){entered();},cancel(){cancels++;}}),{headers:{'content-type':'text/event-stream'}});
  const api=fixture(async()=>incoming);
  const pending=api.request('/result',{method:'POST',signal:controller.signal,onEvent(){}});
  await started;controller.abort();
  await assert.rejects(pending,{status:499,code:'REQUEST_CANCELLED'});
  assert.equal(cancels,1);assert.equal(incoming.body.locked,false);assert.equal(getEventListeners(controller.signal,'abort').length,0);
});

test('ordinary requests still negotiate JSON',async()=>{
  const api=fixture(async(_path,options)=>{assert.equal(options.headers.Accept,'application/json');return new Response('{"okay":true}');});
  assert.equal((await api.request('/api/bootstrap')).okay,true);
});
