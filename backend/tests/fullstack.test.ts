import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,databaseUrl} from './v2-fixture.ts';
import {LocalAgentModel} from '../src/v2/model.ts';
const integration=databaseUrl?test:test.skip;
integration('demo sessions cannot outlive the temporary account',async t=>{
  const f=await fixture(t),visitor=await f.runtime.createDemoUser();
  const token=await f.runtime.newSession(visitor.id);
  assert.equal((await f.runtime.getUser(visitor.id))?.is_demo,true);
  assert.equal(await f.runtime.authenticate(token),visitor.id);
  const lifetime=await f.admin.pool.query('SELECT s.expires_at<=u.demo_expires_at AS bounded FROM sessions s JOIN users u ON u.id=s.owner WHERE s.owner=$1',[visitor.id]);
  assert.equal(lifetime.rows[0].bounded,true);
  await f.admin.pool.query("UPDATE users SET demo_expires_at=now()-interval '1 minute' WHERE id=$1",[visitor.id]);
  assert.equal(await f.runtime.authenticate(token),null);
  assert.equal(await f.runtime.getUser(visitor.id),null);
  await assert.rejects(f.runtime.newSession(visitor.id));
});
integration('browser resume snapshots, conversation pagination and ownership are enforced',async t=>{
  const f=await fixture(t),u=await f.user(),other=await f.user();
  const second=await f.service.createConversation(u.owner,u.pid,{request_id:crypto.randomUUID(),goal:'what_to_say'});
  const first=await f.service.listConversations(u.owner,u.pid,1);
  assert.equal(first.conversations.length,1);assert.ok(first.next_cursor);
  const next=await f.service.listConversations(u.owner,u.pid,1,first.next_cursor!);
  assert.equal(next.conversations.length,1);assert.equal(next.next_cursor,null);
  assert.deepEqual(new Set([first.conversations[0].conversation_id,next.conversations[0].conversation_id]),new Set([u.cid,second.conversation_id]));
  await assert.rejects(f.service.listConversations(other.owner,u.pid),(e:any)=>e.status===404);
  await assert.rejects(f.service.listConversations(u.owner,u.pid,51));
  await f.answer(u,{text:'합성친구'});
  const c=await f.service.readConversation(u.owner,u.cid);
  assert.equal(c.question_history[0].question_id,'N00');assert.equal(c.answers[0].value.text,'합성친구');
  assert.equal(c.latest_guidance,null);assert.deepEqual(c.plans,[]);
});
integration('safety hold exposes episode on reload; explicit resume stays possible',async t=>{
  const f=await fixture(t),u=await f.user();
  await f.turn(u,'message',{text:'친구가 지금 자해하고 있어요'});
  const c=await f.service.readConversation(u.owner,u.cid);
  assert.equal(c.state,'SAFETY_HOLD');assert.match(c.safety_episode_id,/^[a-f0-9-]{36}$/);
  await f.turn(u,'resume_after_safety',{safety_episode_id:c.safety_episode_id,acknowledgement:'no_current_immediate_danger',text:'현재 즉각적인 위험은 없고 안전한 곳에 있어요.'});
  assert.notEqual((await f.service.readConversation(u.owner,u.cid)).state,'SAFETY_HOLD');
});
test('container model origins are opt-in, exact and cannot carry credentials or query secrets',()=>{
  assert.throws(()=>new LocalAgentModel('http://model:8081/v1','test'));
  assert.doesNotThrow(()=>new LocalAgentModel('http://model:8081/v1','test','',['http://model:8081']));
  for(const url of ['http://model:8082/v1','http://model.attacker:8081/v1','http://u:p@model:8081/v1','http://model:8081/v1?key=x'])assert.throws(()=>new LocalAgentModel(url,'test','',['http://model:8081']));
});
