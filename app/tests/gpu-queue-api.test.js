import test from 'node:test';
import assert from 'node:assert/strict';
import {queueModelServer} from '../scripts/serve-gpu31b-queue.mjs';
const apiKey='synthetic-service-key-01234567890123456789';
async function fixture(t,overrides={}){
 const calls=[];const server=queueModelServer({apiKey,health:async()=>({model:'qualified',max_context_tokens:40960}),fetchImpl:async(url,init)=>{calls.push({url,init});return new Response('{"ok":true}');},...overrides});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
 return {calls,request:(path,options={})=>fetch(`http://127.0.0.1:${server.address().port}${path}`,{...options,headers:{authorization:`Bearer ${apiKey}`,...options.headers}})};
}
test('queue API authenticates health and inference without forwarding credentials',async t=>{
 const {calls,request}=await fixture(t);
 assert.equal((await request('/healthz',{headers:{authorization:'Bearer wrong'}})).status,401);
 assert.equal((await request('/healthz')).status,200);
 const r=await request('/v1/chat/completions',{method:'POST',body:'{"messages":[]}'});assert.equal(r.status,200);
 assert.equal(calls.length,1);assert.equal(calls[0].init.headers,undefined);assert.equal(calls[0].url,'http://127.0.0.1:1/v1/chat/completions');
});
test('queue API rejects malformed JSON, unknown routes and oversized requests without inference',async t=>{
 const {calls,request}=await fixture(t);
 assert.equal((await request('/v1/chat/completions',{method:'POST',body:'{'})).status,400);
 assert.equal((await request('/v1/other',{method:'POST',body:'{}'})).status,404);
 assert.equal((await request('/v1/chat/completions',{method:'POST',body:'x'.repeat(8*1024*1024+1)})).status,413);
 assert.equal(calls.length,0);
});
test('unavailable GPU returns503 without exposing internal error details or substituting a model',async t=>{
 let calls=0;const {request}=await fixture(t,{health:async()=>{throw new Error('SECRET');},fetchImpl:async()=>{calls++;throw new Error('SECRET');}});
 assert.equal((await request('/healthz')).status,503);
 const r=await request('/v1/chat/completions',{method:'POST',body:'{}'});assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/SECRET/);assert.equal(calls,1);
});
test('queue API sends real upstream SSE deltas before completion without buffering',async t=>{
 let finish;
 const gate=new Promise(done=>{finish=done;});let finished=false;
 const {request}=await fixture(t,{fetchImpl:async()=>new Response(new ReadableStream({async start(controller){controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"가"},"finish_reason":null}]}\n\n'));await gate;finished=true;controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));controller.close();}}),{headers:{'content-type':'text/event-stream'}})});
 t.after(()=>finish());
 const response=await request('/v1/chat/completions',{method:'POST',body:'{"stream":true}'});assert.match(response.headers.get('content-type'),/text\/event-stream/);
 const reader=response.body.getReader();const first=await reader.read();assert.match(new TextDecoder().decode(first.value),/가/);assert.equal(finished,false);
 finish();let tail='';for(;;){const next=await reader.read();if(next.done)break;tail+=new TextDecoder().decode(next.value);}assert.match(tail,/\[DONE\]/);
});
test('queue API cancels upstream body and signal when the HTTP client disconnects',async t=>{
 let upstreamSignal,cancelled;
 const cancellation=new Promise(done=>{cancelled=done;});
 const {request}=await fixture(t,{fetchImpl:async(_url,init)=>{upstreamSignal=init.signal;return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(': ready\n\n'));},cancel(){cancelled();}}),{headers:{'content-type':'text/event-stream'}});}});
 const response=await request('/v1/chat/completions',{method:'POST',body:'{"stream":true}'});const reader=response.body.getReader();await reader.read();await reader.cancel();
 await Promise.race([cancellation,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('UPSTREAM_NOT_CANCELLED')),2000);timer.unref();})]);assert.equal(upstreamSignal.aborted,true);
});
