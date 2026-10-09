import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,databaseUrl} from './v2-fixture.ts';
import {createApp} from '../src/server.ts';
import {getSettings} from '../src/config.ts';
import {passwordHash} from '../src/auth.ts';
const integration=databaseUrl?test:test.skip;

integration('v2 HTTP contracts: authentication, snapshot, answer, errors, SSE and DELETE headers',async t=>{
 const f=await fixture(t),u=await f.user(),other=await f.user();
 const app=await createApp(getSettings({databaseUrl:f.runtimeUrl,databaseSchema:f.schema,migrateOnStart:false,v2Enabled:true,v2AllowDraft:true,contentKey:f.key,modelMode:'mock',port:0}));
 await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const base='http://127.0.0.1:'+(app.server.address() as any).port,token=await f.runtime.newSession(u.owner),otherToken=await f.runtime.newSession(other.owner);
 const request=(path:string,method='GET',body?:any,bearer=token,headers:any={})=>fetch(base+path,{method,headers:{Authorization:'Bearer '+bearer,...(body?{'Content-Type':'application/json'}:{}),...headers},...(body?{body:JSON.stringify(body)}:{})});
 try{
  const unauth=await fetch(base+'/api/v2/projects');assert.equal(unauth.status,401);assert.equal((await unauth.json()).error.code,'UNAUTHENTICATED');
  assert.equal((await fetch(base+'/help/safety')).status,200);assert.equal((await fetch(base+'/health/ready')).status,503);
  const snapshot=await request('/api/v2/conversations/'+u.cid);assert.equal(snapshot.status,200);const c=await snapshot.json();assert.equal(c.question.question_id,'N00');
  assert.equal((await request('/api/v2/conversations/'+u.cid,'GET',undefined,otherToken)).status,404);
  const input={request_id:randomUUID(),expected_revision:0,action:'answer',payload:{question_instance_id:c.question.id,question_id:'N00',question_version:c.question.question_version,disposition:'answered',value:{text:'엄마'}}};
  const response=await request('/api/v2/conversations/'+u.cid+'/turns','POST',input);assert.equal(response.status,200);assert.equal((await response.json()).resource_revision,1);
  const invalid=await request('/api/v2/conversations/'+u.cid+'/turns','POST',{...input,request_id:randomUUID()});assert.equal(invalid.status,409);assert.equal((await invalid.json()).error.code,'REVISION_CONFLICT');
  const csrf=await fetch(base+'/api/v2/projects',{method:'POST',headers:{Cookie:'hop_session='+token,'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID()})});assert.equal(csrf.status,403);
  const sse=await request('/api/v2/conversations/'+u.cid+'/events');assert.equal(sse.status,200);assert.ok(sse.headers.get('content-type')?.includes('text/event-stream'));const reader=sse.body!.getReader();const chunk=new TextDecoder().decode((await reader.read()).value);assert.match(chunk,/event: question.ready/);assert.ok(!chunk.includes('엄마'));await reader.cancel();
  const p=await f.service.readProject(u.owner,u.pid);
  const deletion=await request('/api/v2/projects/'+u.pid,'DELETE',undefined,token,{'Idempotency-Key':randomUUID(),'If-Match':'"'+p.revision+'"'});assert.equal(deletion.status,202);const receipt=await deletion.json();assert.ok(receipt.deletion_id);
  assert.equal((await request('/api/v2/conversations/'+u.cid)).status,404);assert.equal((await request('/api/v2/deletions/'+receipt.deletion_id)).status,200);
 }finally{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await app.store.close();}
});

integration('P-02 account deletion requires fresh password, revokes sessions and grants only a scoped receipt',async t=>{
 const f=await fixture(t),u=await f.user(),password='synthetic-password-for-delete';
 await f.admin.pool.query('UPDATE users SET password_hash=$2 WHERE id=$1',[u.owner,await passwordHash(password)]);
 const app=await createApp(getSettings({databaseUrl:f.runtimeUrl,databaseSchema:f.schema,migrateOnStart:false,v2Enabled:true,v2AllowDraft:true,contentKey:f.key,modelMode:'mock',port:0}));
 await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+(app.server.address() as any).port,token=await f.runtime.newSession(u.owner);
 try{
  const wrong=await fetch(base+'/api/v2/account',{method:'DELETE',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID(),current_password:'wrong'})});assert.equal(wrong.status,401);
  const response=await fetch(base+'/api/v2/account',{method:'DELETE',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({request_id:randomUUID(),current_password:password})});assert.equal(response.status,202);const deletion=await response.json();
  assert.equal(await f.runtime.authenticate(token),null);
  const receipt=await fetch(base+'/api/v2/deletions/'+deletion.deletion_id,{headers:{Authorization:'Deletion '+deletion.receipt}});assert.equal(receipt.status,200);assert.equal((await receipt.json()).online_purged,true);
  const forbidden=await fetch(base+'/api/v2/projects',{headers:{Authorization:'Deletion '+deletion.receipt}});assert.equal(forbidden.status,401);
 }finally{app.server.closeAllConnections();await new Promise<void>(resolve=>app.server.close(()=>resolve()));await app.store.close();}
});
