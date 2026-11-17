import test from 'node:test';import assert from 'node:assert/strict';
import {createQueueEventParser} from '../src/queue-event-stream.js';
const id='d37d204e-8366-4fc5-9380-0b234366258a';
const chunk={event:'chunk',id,seq:1,delta:'한글🙂',at:123.5},terminal={event:'result',envelope:{id,response:{ok:true}}};
const bytes=events=>Buffer.from(events.map(event=>JSON.stringify(event)+'\n').join(''));
test('queue NDJSON decodes split UTF8 and delivers chunks before terminal',()=>{
 const seen=[],parser=createQueueEventParser({id,onChunk:event=>seen.push(event)}),first=bytes([chunk]);
 for(const byte of first)parser.push(Uint8Array.of(byte));assert.deepEqual(seen,[chunk]);parser.push(bytes([terminal]));assert.deepEqual(parser.finish(),terminal.envelope);
});
test('queue NDJSON rejects malformed order, IDs, terminal duplication, truncation, and invalid UTF8',()=>{
 for(const events of [[{...chunk,seq:2}],[{...chunk,id:'wrong'}],[{...chunk,delta:''}],[{...chunk,at:Infinity}],[terminal,terminal],[terminal,chunk],[{event:'error'}]]){
  const parser=createQueueEventParser({id});assert.throws(()=>{parser.push(bytes(events));parser.finish();});
 }
 const truncated=createQueueEventParser({id});truncated.push(bytes([chunk]));assert.throws(()=>truncated.finish(),{code:'queue_stream_truncated'});
 const encoding=createQueueEventParser({id});assert.throws(()=>encoding.push(Uint8Array.of(255)),{code:'queue_stream_encoding'});
 const bound=createQueueEventParser({id,maxBytes:2});assert.throws(()=>bound.push(Buffer.from('xxx')),{code:'queue_stream_bound'});
 const line=createQueueEventParser({id,maxLineBytes:2});assert.throws(()=>line.push(Buffer.from('xxx')),{code:'queue_stream_bound'});
});
