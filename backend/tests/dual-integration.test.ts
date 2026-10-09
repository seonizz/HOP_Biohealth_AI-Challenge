import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture,databaseUrl} from './v2-fixture.ts';
import {AgentWorker} from '../src/v2/worker.ts';
import {RunBudget} from '../src/v2/model.ts';
import {unknownAssessment} from '../src/v2/assessment.ts';
import {createModelApi} from '../src/model-api/server.ts';
import {ModelApiClient} from '../src/v2/model-api.ts';
const integration=databaseUrl?test:test.skip;
const assessment=(content:string,score=2,index=0)=>({schema_version:1,...unknownAssessment(),anxiety:{score,source:2,timeframe:1,evidence:[{message_index:index,start_cp:0,end_cp:[...content].length}]}});
const input=(revision:number,text:string,request_id=randomUUID())=>({request_id,expected_revision:revision,action:'message',payload:{text}});

integration('real user turn uses HTTP model API B then A and persists only verified results',async t=>{
  const keys=['HOP_DUAL_MODEL_ID','HOP_DUAL_MODEL_SHA256','HOP_DUAL_PROMPT_PROFILE','HOP_DUAL_PROMPT_VERSION'],prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{HOP_DUAL_MODEL_ID:'synthetic-api-checkpoint',HOP_DUAL_MODEL_SHA256:'a'.repeat(64),HOP_DUAL_PROMPT_PROFILE:'test',HOP_DUAL_PROMPT_VERSION:'v1'});
  t.after(()=>{for(const key of keys){if(prior[key]===undefined)delete process.env[key];else process.env[key]=prior[key];}});
  const f=await fixture(t,true,true),u=await f.user(),calls:string[]=[];
  const identity={model_id:'synthetic-api-checkpoint',checkpoint_sha256:'a'.repeat(64),prompt_profile:'test',prompt_version:'v1'},token='synthetic-integration-key-1234567890';
  const api=createModelApi({token,identity,inferenceEnabled:true,model:{countTokens:async()=>100,call:async(kind:string,context:any)=>{calls.push(kind);if(kind==='assess')return assessment(context.messages.at(-1).content,3,context.messages.length-1);assert.equal(context.patient_cue_context.current.anxiety.score,3);return {message:'그분의 이야기를 천천히 확인해 주세요.'};}}});
  await new Promise<void>(resolve=>api.server.listen(0,'127.0.0.1',resolve));t.after(()=>api.close());
  const client=new ModelApiClient(`http://127.0.0.1:${(api.server.address() as any).port}`,token,identity);
  const accepted=await f.service.turn(u.owner,u.cid,input(0,'엄마가 요즘 매우 불안해요'));
  await new AgentWorker(f.db,f.service,client).tick();
  assert.equal((await f.service.run(u.owner,accepted.run_id)).status,'SUCCEEDED');assert.deepEqual(calls,['assess','respond']);
  const messages=(await f.service.messages(u.owner,u.cid)).messages,alerts=(await f.service.alerts(u.owner,u.cid)).alerts;
  const reply=messages.find((item:any)=>item.kind==='dual_reply');assert.ok(reply);assert.equal(alerts[0].response_id,reply.id);
  const row=await f.db.transaction(u.owner,async tx=>(await tx.query('SELECT model_id,model_sha256 FROM turn_assessments WHERE owner_id=$1',[u.owner])).rows[0]);
  assert.equal(row.model_id,identity.model_id);assert.equal(row.model_sha256,identity.checkpoint_sha256);
});

integration('each accepted turn runs B before A, stores encrypted history and shows one linked alert',async t=>{
  const f=await fixture(t,true,true),u=await f.user(),calls:string[]=[];
  let score=2;
  const model={countTokens:async()=>100,call:async(kind:string,context:any)=>{calls.push(kind);if(kind==='assess')return assessment(context.messages.at(-1).content,score,context.messages.length-1);assert.equal(context.patient_cue_context.current.anxiety.score,score);return {message:'그분의 마음을 천천히 확인해 보세요.'};}};
  const worker=new AgentWorker(f.db,f.service,model);
  const first=input(0,'엄마가 요즘 불안해요');
  const accepted=await f.service.turn(u.owner,u.cid,first);
  const replay=await f.service.turn(u.owner,u.cid,first);
  assert.equal(replay.replayed,true);assert.equal(replay.run_id,accepted.run_id);
  await worker.tick();assert.deepEqual(calls,['assess','respond']);
  score=3;const current=await f.service.readConversation(u.owner,u.cid);
  await f.service.turn(u.owner,u.cid,input(current.resource_revision,'엄마가 요즘 매우 불안해요'));
  await worker.tick();assert.deepEqual(calls,['assess','respond','assess','respond']);
  const rows=await f.db.transaction(u.owner,async tx=>{await tx.project(u.pid);const result=await tx.query('SELECT * FROM turn_assessments WHERE owner_id=$1 ORDER BY created_at,id',[u.owner]);return result.rows.map(row=>({row,data:tx.decode(row).data}));});
  assert.equal(rows.length,2);assert.equal(rows[1].data.previous_valid.anxiety.score,2);
  assert.equal(rows[1].data.trend.anxiety.delta,1);
  assert.ok(!JSON.stringify(rows[1].row.encrypted_payload).includes('엄마가'));
  const alerts=(await f.service.alerts(u.owner,u.cid)).alerts;assert.equal(alerts.length,1);
  const messages=(await f.service.messages(u.owner,u.cid)).messages;
  assert.equal(messages.filter((m:any)=>m.kind==='dual_reply').length,2);
  assert.equal(alerts[0].response_id,rows[1].row.response_id);
  assert.equal(messages.find((m:any)=>m.id===alerts[0].response_id).turn_id,alerts[0].turn_id);
  await f.service.acknowledgeAlert(u.owner,alerts[0].id,alerts[0].response_id);
  await f.service.acknowledgeAlert(u.owner,alerts[0].id,alerts[0].response_id);
  assert.ok((await f.service.alerts(u.owner,u.cid)).alerts[0].shown_at);
  const original=messages.find((m:any)=>m.kind==='message');
  await f.service.deleteSource(u.owner,original.id,{request_id:randomUUID(),expected_revision:original.revision,scope:'delete_source'});
  const after=await f.db.transaction(u.owner,async tx=>(await tx.query('SELECT count(*)::integer AS n FROM turn_assessments WHERE owner_id=$1',[u.owner])).rows[0].n);
  assert.equal(after,0);assert.equal((await f.service.alerts(u.owner,u.cid)).alerts.length,0);
});

integration('invalid B output retries once, records unavailable instead of zero, and A receives failure status',async t=>{
  const f=await fixture(t,true,true),u=await f.user();let bCalls=0,aStatus=-1;
  const model={countTokens:async()=>100,call:async(kind:string,context:any)=>{if(kind==='assess'){bCalls++;return {...assessment(context.messages.at(-1).content),explanation:'invalid'};}aStatus=context.patient_cue_context.evaluation_status;return {message:'지금 이야기해 주신 상황을 함께 확인해 볼게요.'};}};
  await f.service.turn(u.owner,u.cid,input(0,'엄마가 요즘 불안해요'));
  await new AgentWorker(f.db,f.service,model).tick();
  assert.equal(bCalls,2);assert.equal(aStatus,3);
  const saved=await f.db.transaction(u.owner,async tx=>(await tx.query('SELECT evaluation_status,encrypted_payload FROM turn_assessments WHERE owner_id=$1',[u.owner])).rows[0]);
  assert.equal(saved.evaluation_status,3);
  assert.equal((await f.service.alerts(u.owner,u.cid)).alerts[0].reason_code,'assessment_unavailable');
});

integration('A schema failure hides the draft while retaining B assessment and retryable run error',async t=>{
  const f=await fixture(t,true,true),u=await f.user();let bCalls=0,aCalls=0;
  const model={countTokens:async()=>100,call:async(kind:string,context:any)=>{if(kind==='assess'){bCalls++;return assessment(context.messages.at(-1).content);}aCalls++;return aCalls===1?{message:'출력',score:9}:{message:'검증된 재시도 응답입니다.'};}};
  const accepted=await f.service.turn(u.owner,u.cid,input(0,'엄마가 요즘 불안해요'));
  await new AgentWorker(f.db,f.service,model).tick();
  const run=await f.service.run(u.owner,accepted.run_id);assert.equal(run.status,'FAILED');assert.equal(run.error.retryable,true);
  assert.equal((await f.service.messages(u.owner,u.cid)).messages.filter((m:any)=>m.kind==='dual_reply').length,0);
  assert.equal((await f.service.alerts(u.owner,u.cid)).alerts.length,0);
  assert.equal((await f.db.transaction(u.owner,async tx=>(await tx.query('SELECT count(*)::integer AS n FROM turn_assessments WHERE owner_id=$1',[u.owner])).rows[0].n)),1);
  await f.service.retryRun(u.owner,accepted.run_id,{request_id:randomUUID()});
  await new AgentWorker(f.db,f.service,model).tick();
  assert.equal(bCalls,1);assert.equal(aCalls,2);
  assert.equal((await f.service.run(u.owner,accepted.run_id)).status,'SUCCEEDED');
  assert.equal((await f.service.messages(u.owner,u.cid)).messages.filter((m:any)=>m.kind==='dual_reply').length,1);
});

integration('cancelled run cannot commit a late B result',async t=>{
  const f=await fixture(t,true,true),u=await f.user();
  let release!:()=>void,started!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  const model={countTokens:async()=>100,call:async(kind:string,context:any)=>{if(kind==='assess'){started();await gate;return assessment(context.messages.at(-1).content);}return {message:'늦은 응답'};}};
  const accepted=await f.service.turn(u.owner,u.cid,input(0,'엄마가 요즘 불안해요'));
  const worker=new AgentWorker(f.db,f.service,model),run=await worker.claim();assert.ok(run);
  const active=worker.dualTurn(run!,new AbortController(),new RunBudget(Date.now()+45000,new AbortController().signal));
  await entered;await f.service.cancel(u.owner,accepted.run_id,{request_id:randomUUID()});release();await active;
  assert.equal((await f.service.messages(u.owner,u.cid)).messages.filter((m:any)=>m.kind==='dual_reply').length,0);
  assert.equal((await f.db.transaction(u.owner,async tx=>(await tx.query('SELECT count(*)::integer AS n FROM turn_assessments WHERE owner_id=$1',[u.owner])).rows[0].n)),0);
});

integration('B timeout records unavailable and still supplies that status to A',async t=>{
  const previous=process.env.HOP_DUAL_EVALUATION_TIMEOUT_MS;process.env.HOP_DUAL_EVALUATION_TIMEOUT_MS='40';
  t.after(()=>{if(previous===undefined)delete process.env.HOP_DUAL_EVALUATION_TIMEOUT_MS;else process.env.HOP_DUAL_EVALUATION_TIMEOUT_MS=previous;});
  const f=await fixture(t,true,true),u=await f.user();let aStatus=-1;
  const model={countTokens:async()=>100,call:async(kind:string,context:any,signal:AbortSignal)=>{
    if(kind==='assess')return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('timeout')),{once:true}));
    aStatus=context.patient_cue_context.evaluation_status;return {message:'평가는 완료하지 못했지만, 들려주신 이야기를 함께 정리하겠습니다.'};
  }};
  await f.service.turn(u.owner,u.cid,input(0,'엄마가 요즘 불안해요'));
  await new AgentWorker(f.db,f.service,model).tick();
  assert.equal(aStatus,3);
  const rows=await f.db.transaction(u.owner,async tx=>(await tx.query('SELECT evaluation_status,attempts FROM turn_assessments WHERE owner_id=$1',[u.owner])).rows);
  assert.equal(rows[0].evaluation_status,3);assert.ok(rows[0].attempts<=2);
});

integration('correcting an answer supersedes its pending evaluation before the next turn',async t=>{
  const f=await fixture(t,true,true),u=await f.user();
  const first=await f.answer(u,{text:'엄마'}),snapshot=await f.service.readConversation(u.owner,u.cid);
  const original=snapshot.answers.find((a:any)=>a.question_id==='N00');assert.ok(original);
  const changed=await f.service.turn(u.owner,u.cid,{request_id:randomUUID(),expected_revision:snapshot.resource_revision,action:'correct_answer',payload:{answer_revision_id:original.id,replacement:{disposition:'answered',value:{text:'어머니'}}}});
  assert.notEqual(changed.run_id,first.run_id);
  const old=await f.service.run(u.owner,first.run_id).catch(()=>null);
  assert.ok(!old||!['ACCEPTED','RUNNING'].includes(old.status));
  const queued=await f.db.transaction(u.owner,async tx=>(await tx.query('SELECT count(*)::integer AS n FROM agent_queue WHERE owner_id=$1',[u.owner])).rows[0].n);
  assert.equal(queued,1);
});
