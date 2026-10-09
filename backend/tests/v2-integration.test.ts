import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,databaseUrl} from './v2-fixture.ts';
import {AgentWorker} from '../src/v2/worker.ts';
import {ContentCipher} from '../src/v2/crypto.ts';
import {V2Database} from '../src/v2/db.ts';
import {MalssiService} from '../src/v2/service.ts';
import {replayTombstones} from '../src/v2/restore.ts';
const integration=databaseUrl?test:test.skip;
export const guide=()=>({kind:'communication_guidance',supporter_acknowledgement:'상황을 정리해 볼 수 있습니다.',situation_summary:'아직 확인되지 않은 점이 있습니다.',suggested_words:[{text:'지금 잠깐 이야기해도 괜찮을까요?',purpose:'대화 시작',source_refs:[]}],actions:[{title:'대화 시간 물어보기',how:'상대가 편한 시간을 물어보세요.',preconditions:[],stop_if:['상대가 원하지 않을 때'],source_refs:[]}],avoid:[],supporter_care:['본인의 여유도 살펴보세요.'],limitations:['일반적인 대화 예시이며 개인의 상태를 판단하지 않습니다.'],citations:[],next_actions:['choose_plan','finish']});
const model={countTokens:async()=>100,call:async(kind:string)=>kind==='guide'?guide():kind==='verify'?{approved:true,issues:[]}:{assertion_candidates:[],topic_candidates:[],safety_observations:[],contradictions:[]}};

integration('P-01 encrypted input ledger and RLS isolate different owners',async t=>{
 const f=await fixture(t),a=await f.user(),b=await f.user();await f.answer(a,{text:'별칭검증표식'});
 const rows=await f.db.transaction(a.owner,async tx=>(await tx.query('SELECT encrypted_payload FROM v2_messages WHERE owner_id=$1',[a.owner])).rows);
 assert.ok(!JSON.stringify(rows).includes('별칭검증표식'));await assert.rejects(f.service.readConversation(b.owner,a.cid));
 const hidden=await f.db.transaction(b.owner,async tx=>({projects:(await tx.query('SELECT * FROM v2_projects WHERE id=$1',[a.pid])).rowCount,messages:(await tx.query('SELECT * FROM v2_messages WHERE conversation_id=$1',[a.cid])).rowCount}));assert.deepEqual(hidden,{projects:0,messages:0});
 assert.equal((await f.runtime.pool.query('SELECT * FROM v2_projects')).rowCount,0);
});
integration('A-02/A-03 twenty concurrent retries save exactly one answer; conflicting content is rejected',async t=>{
 const f=await fixture(t),u=await f.user(),c=await f.service.readConversation(u.owner,u.cid);
 const input={request_id:randomUUID(),expected_revision:0,action:'answer',payload:{question_instance_id:c.question.id,question_id:'N00',question_version:c.question.question_version,disposition:'answered',value:{text:'엄마'}}};
 const results=await Promise.all(Array.from({length:20},()=>f.service.turn(u.owner,u.cid,input)));
 assert.ok(results.every(r=>r.resource_revision===1));assert.equal((await f.service.messages(u.owner,u.cid)).messages.length,1);
 await assert.rejects(f.service.turn(u.owner,u.cid,{...input,payload:{...input.payload,value:{text:'형'}}}),(e:any)=>e.code==='IDEMPOTENCY_CONFLICT');
});
integration('Q-03/Q-09/Q-10 structured interview, explicit selection and six-turn guidance option work without models',async t=>{
 const f=await fixture(t),u=await f.user();await f.answer(u,{text:'엄마'});
 await f.answer(u,{relation:{status:'answered',option_id:'parent'},contact_frequency:{status:'unknown'}});
 await f.turn(u,'select_question',{question_id:'C02'});
 await f.answer(u,{option_ids:['worry']});
 for(const id of ['T02','T04','T07']){await f.turn(u,'select_question',{question_id:id});await f.answer(u,null,'skipped');}
 const c=await f.service.readConversation(u.owner,u.cid);assert.equal(c.offer_guidance,true);assert.equal(c.answers.find((a:any)=>a.question_id==='T01').value.relation.option_id,'parent');assert.equal(c.ready_for.understand,false);
});
integration('Q-06 parent correction reopens dependent questions and old rendering remains immutable',async t=>{
 const f=await fixture(t),u=await f.user();await f.answer(u,{text:'엄마'});await f.turn(u,'select_question',{question_id:'T09'});await f.answer(u,{option_ids:['none']});
 let c=await f.service.readConversation(u.owner,u.cid);assert.equal(c.coverage.not_applicable,2);
 await f.turn(u,'correct_answer',{answer_revision_id:c.answers.find((a:any)=>a.question_id==='T09').id,replacement:{disposition:'answered',value:{option_ids:['language']}}});
 c=await f.service.readConversation(u.owner,u.cid);assert.equal(c.coverage.not_applicable,0);await f.turn(u,'select_question',{question_id:'T10'});
 const before=(await f.service.readConversation(u.owner,u.cid)).question.text;
 const p=await f.service.readProject(u.owner,u.pid);await f.service.patchProject(u.owner,u.pid,{request_id:randomUUID(),expected_revision:p.revision,alias:'친구 지수'});
 assert.equal((await f.service.readConversation(u.owner,u.cid)).question.text,before);
});
integration('S-01/S-03/S-04 safety interrupts a run and generic next cannot resume',async t=>{
 const f=await fixture(t,true),u=await f.user();const pending=await f.turn(u,'request_guidance',{guidance_kind:'communication_guidance'});
 await f.turn(u,'message',{text:'제가 지금 죽고 싶어요'});
 assert.equal((await f.service.run(u.owner,pending.run_id)).status,'CANCELLED');
 let c=await f.service.readConversation(u.owner,u.cid);assert.equal(c.state,'SAFETY_HOLD');
 await assert.rejects(f.turn(u,'select_question',{question_id:'C02'}),(e:any)=>e.code==='INVALID_STATE');
 const episode=await f.db.transaction(u.owner,async tx=>(await tx.conversation(u.cid)).c.data.safety_episode_id);
 await f.turn(u,'resume_after_safety',{safety_episode_id:episode,acknowledgement:'no_current_immediate_danger',text:'현재 즉각적인 위험은 없고 안전한 곳입니다.'});
 c=await f.service.readConversation(u.owner,u.cid);assert.equal(c.state,'REVIEWING');
});
integration('A-04 two workers share a global slot and commit one verified guide',async t=>{
 const f=await fixture(t,true),u=await f.user();const accepted=await f.turn(u,'request_guidance',{guidance_kind:'communication_guidance'});
 const workers=[new AgentWorker(f.db,f.service,model),new AgentWorker(f.db,f.service,model)];
 assert.equal((await Promise.all(workers.map(w=>w.tick()))).filter(Boolean).length,1);
 const run=await f.service.run(u.owner,accepted.run_id);assert.equal(run.status,'SUCCEEDED');assert.equal(run.result.guidance.kind,'communication_guidance');
 const plans=await f.db.transaction(u.owner,async tx=>{await tx.project(u.pid);return tx.rows('action_plans',u.pid);});assert.equal(plans.length,0);
 const plan=await f.service.choosePlan(u.owner,u.cid,{request_id:randomUUID(),guidance_id:run.result.guidance_id,action_index:0});
 assert.ok(plan.plan_id);assert.equal(plan.resource_revision,0);
});
integration('A-05 stale fence token cannot commit after lease takeover',async t=>{
 const f=await fixture(t,true),u=await f.user();await f.turn(u,'request_guidance',{guidance_kind:'communication_guidance'});const worker=new AgentWorker(f.db,f.service,model),old=await worker.claim();assert.ok(old);
 await f.db.transaction(u.owner,async tx=>{await tx.query("UPDATE agent_runs SET lease_until=now()-interval '1 second' WHERE id=$1",[old.id]);await tx.query("UPDATE model_slots SET lease_until=now()-interval '1 second' WHERE id=1");});
 const fresh=await worker.claim();assert.ok(fresh);assert.ok(Number(fresh.fence_token)>Number(old.fence_token));assert.equal(await worker.commit(old,{guidance:guide()}),false);
 assert.equal(await worker.commit(fresh,{guidance:guide()}),true);assert.equal((await f.service.run(u.owner,old.id)).status,'SUCCEEDED');
});
integration('A-06 verification rejects a draft after one repair; nothing unverified is exposed',async t=>{
 const f=await fixture(t,true),u=await f.user(),calls:string[]=[];const accepted=await f.turn(u,'request_guidance',{guidance_kind:'communication_guidance'});
 const bad={...model,call:async(kind:string)=>{calls.push(kind);return kind==='guide'?guide():{approved:false,issues:['근거를 확인해 주세요.']};}};
 await new AgentWorker(f.db,f.service,bad).tick();assert.deepEqual(calls,['guide','verify','guide','verify']);
 const run=await f.service.run(u.owner,accepted.run_id);assert.equal(run.status,'FAILED');assert.equal(run.error.code,'FAILED_VERIFICATION');assert.equal(run.result,null);
 assert.equal((await f.service.messages(u.owner,u.cid)).messages.length,0);
});
integration('A-07 model failure preserves the accepted input and marks the run failed',async t=>{
 const f=await fixture(t,true),u=await f.user();const accepted=await f.turn(u,'message',{text:'요즘 연락하기가 조심스러워요.'});
 await new AgentWorker(f.db,f.service,{...model,call:async()=>{throw new Error('offline');}}).tick();
 const run=await f.service.run(u.owner,accepted.run_id);assert.equal(run.status,'FAILED');assert.equal(run.input_saved,true);assert.equal((await f.service.messages(u.owner,u.cid)).messages[0].content,'요즘 연락하기가 조심스러워요.');
});
integration('M-01/M-07 memory context is project-scoped and requires explicit cross-session consent',async t=>{
 const f=await fixture(t,true),u=await f.user(true,false);await f.turn(u,'select_question',{question_id:'C02'});await f.answer(u,{option_ids:['worry']});
 const memory=(await f.service.memories(u.owner,u.pid)).memories[0];assert.equal(memory.status,'validated');
 await assert.rejects(f.service.mutateMemory(u.owner,memory.id,{request_id:randomUUID(),expected_revision:memory.revision},'confirm'),(e:any)=>e.code==='CONSENT_REQUIRED');
 const next=await f.service.createConversation(u.owner,u.pid,{request_id:randomUUID(),goal:'support_me'});const v={...u,cid:next.conversation_id};await f.turn(v,'request_guidance',{guidance_kind:'support_me'});
 const worker=new AgentWorker(f.db,f.service,model),run=await worker.claim();const context=await worker.context(run!);assert.equal(context.context.memories.length,0);assert.equal(context.context.answers.length,0);assert.equal(context.context.recent_messages.length,0);
});
integration('M-06/M-09 expired memories become stale; forget suppresses all source input from future runs',async t=>{
 const f=await fixture(t,true),u=await f.user();await f.turn(u,'select_question',{question_id:'C02'});await f.answer(u,{option_ids:['worry']});
 let memory=(await f.service.memories(u.owner,u.pid)).memories[0];await f.service.mutateMemory(u.owner,memory.id,{request_id:randomUUID(),expected_revision:memory.revision},'confirm');
 await f.db.transaction(u.owner,async tx=>{const m=await tx.get('memory_items',memory.id);m.data.expires_at='2000-01-01T00:00:00Z';await tx.update('memory_items',m);});
 memory=(await f.service.memories(u.owner,u.pid)).memories[0];assert.equal(memory.status,'stale');
 await f.service.mutateMemory(u.owner,memory.id,{request_id:randomUUID(),expected_revision:memory.revision,scope:'forget_memory'},'forget');
 await f.turn(u,'request_guidance',{guidance_kind:'support_me'});const worker=new AgentWorker(f.db,f.service,model),run=await worker.claim(),ctx=await worker.context(run!);
 assert.equal(ctx.context.memories.length,0);assert.equal(ctx.context.answers.length,0);assert.equal(ctx.context.recent_messages.length,0);
 assert.equal((await f.service.messages(u.owner,u.cid)).messages.length,1);
});
integration('M-10 deleting source while a worker runs prevents late result resurrection',async t=>{
 const f=await fixture(t,true),u=await f.user();const accepted=await f.turn(u,'message',{text:'저는 요즘 지쳐요.'}),worker=new AgentWorker(f.db,f.service,model),run=await worker.claim();
 const message=(await f.service.messages(u.owner,u.cid)).messages[0];await f.service.deleteSource(u.owner,message.id,{request_id:randomUUID(),expected_revision:message.revision,scope:'delete_source'});
 assert.equal(await worker.commit(run!,{guidance:guide()}),false);assert.equal((await f.service.messages(u.owner,u.cid)).messages.length,0);await assert.rejects(f.service.run(u.owner,accepted.run_id));
});
integration('P-01 opt-out sessions use independent expiring keys and no cross-session active memories',async t=>{
 const f=await fixture(t),u=await f.user(false,false);const p=await f.service.readProject(u.owner,u.pid);assert.equal(p.temporary,true);assert.ok(Date.parse(p.expires_at)-Date.now()<=86400000);
 const row=await f.db.transaction(u.owner,async tx=>(await tx.query('SELECT * FROM v2_projects WHERE id=$1',[u.pid])).rows[0]);assert.throws(()=>f.cipher.open(row.encrypted_payload,u.owner+':'+u.pid));
 await f.db.transaction(u.owner,async tx=>{await tx.query('DELETE FROM temporary_content_keys WHERE id=$1',[u.pid]);});await assert.rejects(f.service.readProject(u.owner,u.pid),(e:any)=>e.code==='RESOURCE_DELETED');
});
integration('P-02 withdrawal cancels work and purges project; deletion receipt contains no content',async t=>{
 const f=await fixture(t,true),u=await f.user();await f.turn(u,'request_guidance',{guidance_kind:'communication_guidance'});
 const result=await f.service.withdraw(u.owner,{request_id:randomUUID(),purposes:['sensitive_processing']});
 await assert.rejects(f.service.readConversation(u.owner,u.cid));
 const receipt=await f.service.deletion(u.owner,result.deletion_id);assert.equal(receipt.online_purged,true);assert.ok(!JSON.stringify(receipt).includes('엄마'));
 assert.equal((await f.runtime.pool.query('SELECT * FROM agent_queue')).rowCount,0);
});

integration('M-11 deletion ledger replay suppresses a forgotten memory reintroduced by a content restore',async t=>{
 const f=await fixture(t,true),u=await f.user();await f.turn(u,'select_question',{question_id:'C02'});await f.answer(u,{option_ids:['worry']});
 const memory=(await f.service.memories(u.owner,u.pid)).memories[0];
 const backup=await f.db.transaction(u.owner,async tx=>(await tx.query('SELECT * FROM memory_items WHERE id=$1',[memory.id])).rows[0]);
 await f.service.mutateMemory(u.owner,memory.id,{request_id:randomUUID(),expected_revision:memory.revision,scope:'forget_memory'},'forget');
 await f.db.transaction(u.owner,async tx=>{
  await tx.query('DELETE FROM memory_suppressions WHERE owner_id=$1',[u.owner]);
  await tx.query('INSERT INTO memory_items(id,owner_id,project_id,conversation_id,status,revision,encrypted_payload) VALUES($1,$2,$3,$4,$5,$6,$7)',[backup.id,backup.owner_id,backup.project_id,backup.conversation_id,backup.status,backup.revision,backup.encrypted_payload]);
 });
 assert.equal((await f.service.memories(u.owner,u.pid)).memories.length,1);
 await replayTombstones(f.db,[{owner_id:u.owner,scope:'forget_memory',random_resource_id:memory.id}]);
 assert.equal((await f.service.memories(u.owner,u.pid)).memories.length,0);
 await f.turn(u,'request_guidance',{guidance_kind:'support_me'});const worker=new AgentWorker(f.db,f.service,model),run=await worker.claim(),ctx=await worker.context(run!);
 assert.equal(ctx.context.answers.length,0);assert.equal(ctx.context.recent_messages.length,0);
});

integration('S-04 a valid urgent answer bypasses stale revision and the active normal run',async t=>{
 const f=await fixture(t,true),u=await f.user();await f.turn(u,'select_question',{question_id:'C01'});const c=await f.service.readConversation(u.owner,u.cid);
 const accepted=await f.turn(u,'request_guidance',{guidance_kind:'communication_guidance'});
 const response=await f.service.turn(u.owner,u.cid,{request_id:randomUUID(),expected_revision:0,action:'answer',payload:{question_instance_id:c.question.id,question_id:'C01',question_version:c.question.question_version,disposition:'answered',value:{text:'제가 지금 죽고 싶어요'}}});
 assert.equal(response.state,'SAFETY_HOLD');assert.equal((await f.service.run(u.owner,accepted.run_id)).status,'CANCELLED');
});

integration('M-01 confirmed memory never crosses between two projects of the same owner',async t=>{
 const f=await fixture(t,true),u=await f.user();await f.turn(u,'select_question',{question_id:'C02'});await f.answer(u,{option_ids:['worry']});
 const memory=(await f.service.memories(u.owner,u.pid)).memories[0];await f.service.mutateMemory(u.owner,memory.id,{request_id:randomUUID(),expected_revision:memory.revision},'confirm');
 const p=await f.service.createProject(u.owner,{request_id:randomUUID(),alias:'친구'}),c=await f.service.createConversation(u.owner,p.project_id,{request_id:randomUUID(),goal:'support_me'});
 await f.turn({...u,pid:p.project_id,cid:c.conversation_id},'request_guidance',{guidance_kind:'support_me'});
 const worker=new AgentWorker(f.db,f.service,model),run=await worker.claim(),ctx=await worker.context(run!);assert.equal(ctx.context.memories.length,0);
});
