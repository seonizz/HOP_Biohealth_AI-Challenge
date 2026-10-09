import test from 'node:test';
import assert from 'node:assert/strict';
import { HopClient, ApiError, createMessage } from '../client/index.ts';
import { getSettings } from '../src/config.ts';
import { cookie } from '../src/auth.ts';

test('cookie settings support configured sites and reject insecure cross-site cookies',()=>{
  const base={databaseUrl:'postgresql://test:test@localhost/test'};
  assert.throws(()=>getSettings({...base,cookieSameSite:'none',cookieSecure:false}),/SECURE/i);
  assert.throws(()=>getSettings({...base,corsOrigins:['https://example.com/path']}),/origin/);
  assert.throws(()=>getSettings({...base,publicOrigin:'https://example.com/'}),/origin/);
  assert.match(cookie('token',true,false,'none'),/SameSite=None.*Secure/);
  assert.match(cookie('',true,true,'none'),/Max-Age=0.*Secure/);
});

test('browser client includes cookies without exposing tokens and encodes pagination',async()=>{
  let request: RequestInit | undefined, url='';
  const client=new HopClient({baseUrl:'https://example.invalid',fetch:async(input,init)=>{url=String(input);request=init;return Response.json({messages:[],next_cursor:null});}});
  await client.messages('project id',{limit:10,cursor:'abc_def'});
  assert.equal(url,'https://example.invalid/api/projects/project%20id/messages?limit=10&cursor=abc_def');
  assert.equal(request?.credentials,'include');assert.equal(new Headers(request?.headers).get('authorization'),null);
});

test('uncertain message transport retry preserves request_id and the entire serialized body',async()=>{
  const bodies: (BodyInit|null|undefined)[]=[];
  const client=new HopClient({getToken:()=> 'session-token',retries:1,fetch:async(_url,init)=>{
    bodies.push(init?.body); assert.equal(init?.credentials,'omit');
    assert.equal(new Headers(init?.headers).get('authorization'),'Bearer session-token');
    if(bodies.length===1) throw new TypeError('network disconnected');
    return Response.json({request_id:JSON.parse(String(init?.body)).request_id});
  }});
  const input=createMessage({text:'저는 친구입니다.'});
  const result=await client.sendMessage('project-id',input);
  assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);assert.equal(result.request_id,input.request_id);
});

test('non-idempotent project creation is never automatically retried',async()=>{
  let calls=0;
  const client=new HopClient({retries:2,fetch:async()=>{calls++;throw new TypeError('network disconnected');}});
  await assert.rejects(client.createProject('새 기록'),(error: unknown)=>error instanceof ApiError && error.messageSaved===null && error.code==='network_error');
  assert.equal(calls,1);
});

test('API validation failures preserve trace and saved state without retry',async()=>{
  let calls=0;
  const client=new HopClient({retries:2,fetch:async()=>{calls++;return Response.json({detail:'확인해 주세요.',code:'invalid_input',message_saved:false},{status:422,headers:{'X-Request-Id':'trace-id'}});}});
  await assert.rejects(client.sendMessage('project-id',createMessage({text:'내용'})),(error: unknown)=>error instanceof ApiError && error.status===422 && error.traceId==='trace-id' && error.messageSaved===false && !error.retryable);
  assert.equal(calls,1);
});

test('an aborted request stops retries and propagates the caller reason',async()=>{
  const controller=new AbortController(), reason=new Error('사용자가 취소했습니다.');controller.abort(reason);
  const client=new HopClient({retries:2,fetch:async(_url,init)=>{init?.signal?.throwIfAborted();throw new Error('Unexpected');}});
  await assert.rejects(client.questions({signal:controller.signal}),error=>error===reason);
});
