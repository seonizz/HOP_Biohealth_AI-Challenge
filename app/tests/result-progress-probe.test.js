import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {startResultProgressProbe} from '../scripts/probe-result-progress.mjs';

async function serve(t,handler){
  const server=http.createServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}/api/intakes/synthetic/result`;
}
async function until(predicate){
  const deadline=Date.now()+1500;
  while(!predicate()){assert.ok(Date.now()<deadline,'probe condition timeout');await delay(5);}
}

test('real transport sends authenticated bodyless GET, rejects stale revision and records first cards once without content',async t=>{
  const received=[],events=[];
  const url=await serve(t,(req,res)=>{
    received.push({method:req.method,url:req.url,cookie:req.headers.cookie,csrf:req.headers['x-csrf-token'],length:req.headers['content-length']});
    res.end(JSON.stringify({revision:received.length===1?6:7,cards:[{id:'script',value:'private generated content'}]}));
  });
  const probe=startResultProgressProbe({url,revision:7,intervalMs:5,headers:{cookie:'synthetic-cookie','x-csrf-token':'synthetic-csrf'},record:event=>events.push(event)});
  t.after(()=>probe.stop());await until(()=>probe.snapshot().requests>=4);const result=await probe.stop();
  assert.equal(result.status,'passed');assert.equal(result.revision_mismatches,1);assert.equal(result.errors,0);
  assert.equal(result.first_cards.length,1);assert.equal(events.filter(e=>e.event==='first_card').length,1);
  assert.ok(result.poll_latency_seconds.count>=3);assert.ok(result.poll_latency_seconds.max>=0);
  for(const request of received)assert.deepEqual(request,{method:'GET',url:'/api/intakes/synthetic/progress',cookie:'synthetic-cookie',csrf:'synthetic-csrf',length:undefined});
  assert.doesNotMatch(JSON.stringify([result,events]),/private generated content|synthetic-cookie|synthetic-csrf/);
});

test('successful HTTP without script remains unobserved',async t=>{
  const url=await serve(t,(_req,res)=>res.end(JSON.stringify({revision:1,cards:[]})));
  const probe=startResultProgressProbe({url,revision:1,intervalMs:5});t.after(()=>probe.stop());
  await until(()=>probe.snapshot().poll_latency_seconds.count>0);
  assert.equal((await probe.stop()).status,'unobserved');
});

test('HTTP failure is observable and 429 waits 60 seconds but stop interrupts backoff',async t=>{
  let count=0;const events=[];
  const url=await serve(t,(_req,res)=>{count++;res.writeHead(429);res.end('private error');});
  const probe=startResultProgressProbe({url,revision:1,intervalMs:5,record:e=>events.push(e)});t.after(()=>probe.stop());
  await until(()=>probe.snapshot().errors===1);await delay(30);
  const start=performance.now(),result=await probe.stop();
  assert.ok(performance.now()-start<200);assert.equal(count,1);assert.equal(result.status,'failed');
  assert.equal(result.rate_limited,1);assert.equal(events[0].retry_after_ms,60000);assert.equal(events[0].http_status,429);
});

test('timeout covers a response body that never completes and cancellation settles immediately',async t=>{
  const url=await serve(t,(_req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.write('{');});
  const events=[],probe=startResultProgressProbe({url,revision:1,intervalMs:5,timeoutMs:25,record:e=>events.push(e)});t.after(()=>probe.stop());
  await until(()=>probe.snapshot().timeouts>0);const result=await probe.stop();
  assert.equal(result.status,'failed');assert.equal(events[0].kind,'timeout');
});

test('external cancellation aborts an in-flight real HTTP request without counting a failure',async t=>{
  let received=false;
  const url=await serve(t,()=>{received=true;});const controller=new AbortController();
  const probe=startResultProgressProbe({url,revision:1,signal:controller.signal,timeoutMs:1000});t.after(()=>probe.stop());
  await until(()=>received);controller.abort();const result=await probe.stop();
  assert.equal(result.status,'unobserved');assert.equal(result.errors,0);assert.equal(result.cancelled_requests,1);
});

test('synchronous transport exceptions cannot silently pass or leak exception content',async()=>{
  const events=[],probe=startResultProgressProbe({url:'http://127.0.0.1:1/api/intakes/synthetic/result',revision:1,intervalMs:5,
    fetchImpl:()=>{throw new TypeError('private secret');},record:e=>events.push(e)});
  await until(()=>probe.snapshot().errors>0);const result=await probe.stop();
  assert.equal(result.status,'failed');assert.equal(events[0].kind,'transport_or_payload');
  assert.doesNotMatch(JSON.stringify(events),/private secret/);
});

test('stop settles even if a custom transport ignores cancellation',async()=>{
  const probe=startResultProgressProbe({url:'http://127.0.0.1:1/api/intakes/synthetic/result',revision:1,
    fetchImpl:()=>new Promise(()=>{}),timeoutMs:10000});
  const start=performance.now(),result=await probe.stop();
  assert.ok(performance.now()-start<200);assert.equal(result.status,'unobserved');assert.equal(result.cancelled_requests,1);
});

test('non-Error transport throws and rejecting record callbacks remain observable without unhandled rejection',async()=>{
  const probe=startResultProgressProbe({url:'http://127.0.0.1:1/api/intakes/synthetic/result',revision:1,
    fetchImpl:()=>{throw null;},record:async()=>{throw new Error('private recording problem');},intervalMs:5});
  await until(()=>probe.snapshot().record_errors>0);const result=await probe.stop();
  assert.equal(result.status,'failed');assert.ok(result.errors>0);assert.ok(result.record_errors>0);
});
