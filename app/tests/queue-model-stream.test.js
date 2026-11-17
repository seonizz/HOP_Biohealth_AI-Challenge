import test from 'node:test';import assert from 'node:assert/strict';
import {createQueueModelStream} from '../src/queue-model-stream.js';
import {streamJsonResponse} from '../src/model-stream.js';
const chunk={id:'queue-id',seq:1,delta:'{"text":"한글🙂"}',at:1};
const envelope={id:'queue-id',response:{model:'test-model',created:1,choices:[{index:0,finish_reason:'stop',message:{role:'assistant',content:chunk.delta}}],usage:{prompt_tokens:10,completion_tokens:5}}};
test('queue SSE emits real deltas early and validates before finish, usage and DONE',async()=>{
 const stream=createQueueModelStream({model:'test-model'});const reader=stream.response.body.getReader();stream.push(chunk);
 const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/한글🙂/);assert.doesNotMatch(first,/\[DONE\]|"finish_reason":"stop"/);
 let checked=false;stream.complete(envelope,()=>{checked=true;});assert.equal(checked,true);let tail='';for(;;){const next=await reader.read();if(next.done)break;tail+=new TextDecoder().decode(next.value);}
 assert.ok(tail.indexOf('"finish_reason":"stop"')<tail.indexOf('"usage"'));assert.ok(tail.indexOf('"usage"')<tail.indexOf('[DONE]'));
});
test('queue SSE never declares success for a failed proof or altered terminal content',async()=>{
 for(const badContent of [false,true]){
  const stream=createQueueModelStream({model:'test-model'});stream.push(chunk);
  try{stream.complete(badContent?{...envelope,response:{...envelope.response,choices:[{...envelope.response.choices[0],message:{role:'assistant',content:'different'}}]}}:envelope,()=>{if(!badContent)throw Object.assign(new Error('bad proof'),{code:'proof_failed'});});assert.fail('must fail');}catch(error){stream.fail(error);}
  const text=await stream.response.text();assert.match(text,/"error"/);assert.doesNotMatch(text,/\[DONE\]|"finish_reason":"stop"/);
 }
});
test('existing model stream reader accepts verified stream and rejects partial error streams',async()=>{
 const stream=createQueueModelStream({model:'test-model'});stream.push(chunk);stream.complete(envelope,()=>{});
 const restored=await (await streamJsonResponse(stream.response,{completeJson:false})).json();assert.equal(restored.choices[0].message.content,chunk.delta);assert.deepEqual(restored.usage,envelope.response.usage);
 const failed=createQueueModelStream({model:'test-model'});failed.push(chunk);failed.fail({code:'proof_failed'});await assert.rejects(streamJsonResponse(failed.response,{completeJson:false}),{reason:'stream_error'});
});
