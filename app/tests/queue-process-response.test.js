import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';
import {queueProcessResponse} from '../src/queue-process-response.js';
const id='c8abec0d-69e2-4f55-9107-b2800aaac015';
const first={event:'chunk',id,seq:1,delta:'한글🙂',at:123};const last={event:'result',envelope:{id,response:{ok:true}}};
const run=code=>spawn(process.execPath,['-e',code],{stdio:['pipe','pipe','pipe']});
test('process parser invokes live chunks before terminal and preserves UTF8 byte splits',async()=>{
 const source=Buffer.from(JSON.stringify(first)+'\n'+JSON.stringify(last)+'\n').toString('base64');
 const child=run(`const b=Buffer.from('${source}','base64');let i=0;const t=setInterval(()=>{if(i===b.length){clearInterval(t);return;}process.stdout.write(b.subarray(i,i+1));i++;},1)`);
 let saw=false;const result=await queueProcessResponse(child,{id,stream:true,onChunk:event=>{saw=true;assert.deepEqual(event,first);assert.equal(child.exitCode,null);}});assert.equal(saw,true);assert.deepEqual(result,last.envelope);
});
test('process parser fails truncated, invalid sequence, nonzero exit and trailing terminal',async()=>{
 for(const [events,exit]of [[[first],0],[[{...first,seq:3},last],0],[[first,last],2],[[first,last,last],0]]){
  const child=run(`process.stdout.write(${JSON.stringify(events.map(event=>JSON.stringify(event)+'\n').join(''))});process.exitCode=${exit}`);
  await assert.rejects(queueProcessResponse(child,{id,stream:true}));
 }
 const child=run(`process.stdout.write(JSON.stringify(${JSON.stringify(last.envelope)}))`);assert.deepEqual(await queueProcessResponse(child,{id}),last.envelope);
});
test('process parser abort stops owned child and cannot resolve partial output',async()=>{
 const child=run(`process.stdout.write(${JSON.stringify(JSON.stringify(first)+'\n')});setInterval(()=>{},1000)`),controller=new AbortController();
 const result=queueProcessResponse(child,{id,stream:true,signal:controller.signal,onChunk:()=>controller.abort()});await assert.rejects(result,{code:'REQUEST_CANCELLED'});
});
