import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createApp} from '../src/server.js';
import {createIntake} from '../src/intake.js';
import {syntheticAnswer} from '../scripts/verify-questionnaire-v3-live.mjs';
import {HttpError} from '../src/errors.js';
import {Store} from '../src/store.js';
const databaseUrl=process.env.TEST_DATABASE_URL;
const dbtest=(name,fn)=>test(name,{skip:!databaseUrl},fn);
const guide={top:'통합',script:'편할 때 이야기해 줘.',doList:['천천히 듣기'],avoid:['재촉하기'],next:'원하는 도움을 확인해 보세요.',care:{feel:'내 마음도 돌봐 주세요.',tips:['쉬어도 괜찮아요.']}};
const memory=context=>({summary:'합성 검증 상태',facts:[],unknowns:[],user_goal:context.user_goal?.message?.text||'확인되지 않음'});
async function fixture(t,{gpuAvailable=true,legacy=false,fromEnvironment=false}={}){
 const admin=new pg.Pool({connectionString:databaseUrl}),schema='model_profiles_'+randomBytes(8).toString('hex');await admin.query(`CREATE SCHEMA ${schema}`);
 const seen=[],model=name=>({model:name,protocol:'relationship_agent',async updateState(context){seen.push([name,'answer']);return {patient_state:memory(context),name_index:null,question_plan:{skip:[]}};},
  async respond(context){seen.push([name,'result']);return {patient_state:memory(context),name_index:null,assessment:{safety:false},guide};},
  async continueConversation({messages}){seen.push([name,'continuation']);return {answer:'편할 때 이야기해 보세요.',clarification:null,facts:messages.filter(x=>x.role==='user'&&!x.skipped&&x.text.startsWith('상황:')).map(x=>({message_id:x.id,subject:'supporter',quote:x.text})),superseded:[],safety:{urgent:false}};},
  async referralGuidance(){seen.push([name,'referral']);return {schema_version:'1.0',subject:'patient',urgency:'undetermined',reviewed:true,evidence_source_ids:[],institution_ids:[],model_version:name};}});
 const local=model('synthetic-local12b'),gpu=model('synthetic-gpu31b');
 const key=randomBytes(32);
 const app=await createApp({databaseUrl,schema,key,gateway:local,...(fromEnvironment?{}:{modelProfiles:legacy?null:{local12b:local,gpu31b:gpuAvailable?gpu:null}})});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{await app.shutdown();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 const base=`http://127.0.0.1:${app.server.address().port}`,r=await fetch(base+'/api/bootstrap'),bootstrap=await r.json();
 const cookie=r.headers.get('set-cookie').split(';')[0],headers={cookie,'x-csrf-token':bootstrap.csrf_token,'content-type':'application/json'};
 const owner=(await app.store.browser(cookie.slice(15))).id;
 const request=async(path,method='GET',body,extraHeaders={})=>{const r=await fetch(base+path,{method,headers:{...headers,...extraHeaders},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 const start=async id=>{if(id!==undefined){const selected=await request('/api/admin/models','PUT',{model_profile_id:id});assert.equal(selected.status,200,JSON.stringify(selected));}
  const r=await request('/api/intakes','POST',{conversation_epoch:bootstrap.conversation_epoch});assert.equal(r.status,201,JSON.stringify(r));return r.data;};
 const answer=async view=>{const r=await request(`/api/intakes/${view.id}/answers`,'POST',{revision:view.revision,...syntheticAnswer(view.question)});assert.equal(r.status,200,JSON.stringify(r));return r.data;};
 const assertStored=async record=>{
  const api=await request(`/api/records/${record.id}`);assert.equal(api.status,200);assert.deepEqual(api.data.record,record);
  const rows=await app.store.pool.query('SELECT id,owner,content FROM records WHERE id=$1 AND owner=$2',[record.id,owner]);assert.equal(rows.rowCount,1);
  assert.deepEqual(app.store.openRecord(rows.rows[0].content,owner,record.id),record);
 };
 return {...app,request,start,answer,assertStored,bootstrap,owner,seen,local,gpu,schema,key};
}

dbtest('selected models stay isolated across concurrent answers, result storage, referral and continuations',async t=>{
 const f=await fixture(t);
 assert.equal(f.bootstrap.model_profiles,undefined);assert.equal(f.bootstrap.default_model_profile,undefined);
 const settings=await f.request('/api/admin/models');assert.equal(settings.status,200);
 assert.deepEqual(settings.data.profiles.map(x=>[x.id,x.available]),[['local12b',true],['gpu31b',true]]);
 let a=await f.start('local12b'),b=await f.start('gpu31b');
 [a,b]=await Promise.all([f.answer(a),f.answer(b)]);
 assert.equal(a.model_profile_id,'local12b');assert.equal(b.model_profile_id,'gpu31b');
 assert.deepEqual(f.seen.map(x=>x.join(':')).sort(),['synthetic-gpu31b:answer','synthetic-local12b:answer']);
 while(b.status!=='ready')b=await f.answer(b);
 const result=await f.request(`/api/intakes/${b.id}/result`,'POST',{revision:b.revision});assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(result.data.record.provenance.model_profile_id,'gpu31b');assert.equal(result.data.record.provenance.model,'synthetic-gpu31b');
 await f.assertStored(result.data.record);
 const persisted=await f.store.intake(f.owner,b.id);assert.equal(persisted.state.modelProfileId,'gpu31b');
 const restored=await f.request(`/api/intakes/${b.id}`);assert.equal(restored.data.model_profile_id,'gpu31b');
 const guidance=await f.request(`/api/intakes/${b.id}/guidance`,'POST',{revision:result.data.revision});assert.equal(guidance.status,200,JSON.stringify(guidance));
 assert.ok(f.seen.some(([name,kind])=>name==='synthetic-gpu31b'&&kind==='referral'));
 const c=await f.request(`/api/records/${result.data.record.id}/continuations`,'POST',{request_id:randomUUID(),conversation_epoch:0});assert.equal(c.status,201,JSON.stringify(c));
 const response=await f.request(`/api/continuations/${c.data.continuation.id}/messages`,'POST',{revision:0,request_id:randomUUID(),text:'상황: 저는 오늘 쉬려고 해요.'});assert.equal(response.status,200,JSON.stringify(response));
 assert.ok(f.seen.some(([name,kind])=>name==='synthetic-gpu31b'&&kind==='continuation'));
 const card=await f.request(`/api/continuations/${c.data.continuation.id}/cards`,'POST',{revision:response.data.continuation.revision,request_id:randomUUID()});assert.equal(card.status,200,JSON.stringify(card));
 assert.equal(card.data.card.provenance.model_profile_id,'gpu31b');assert.equal(card.data.card.provenance.model,'synthetic-gpu31b');
 assert.equal(f.seen.filter(([name])=>name==='synthetic-local12b').length,1);
 const back=await f.request(`/api/intakes/${a.id}/back`,'POST',{revision:a.revision});assert.equal(back.status,200);assert.equal(back.data.model_profile_id,'local12b');
 f.gpu.referralGuidance=async()=>{throw new Error('synthetic selected provider outage');};
 // Invalidate only this cached assessment to exercise provider failure, not the cache.
 await f.store.updateIntake(f.owner,b.id,persisted.revision,state=>{delete state.referralAssessment;return state;},'model_update');
 const refreshed=await f.store.intake(f.owner,b.id);
 const failedGuidance=await f.request(`/api/intakes/${b.id}/guidance`,'POST',{revision:refreshed.revision});assert.equal(failedGuidance.status,200);assert.equal(failedGuidance.data.status,'model_unavailable');
 assert.equal(f.seen.filter(([name])=>name==='synthetic-local12b').length,1);
 a=back.data;while(a.status!=='ready')a=await f.answer(a);
 const localResult=await f.request(`/api/intakes/${a.id}/result`,'POST',{revision:a.revision});assert.equal(localResult.status,200,JSON.stringify(localResult));
 assert.equal(localResult.data.record.provenance.model_profile_id,'local12b');assert.equal(localResult.data.record.provenance.model,'synthetic-local12b');
 await f.assertStored(localResult.data.record);
});

dbtest('unknown or unconfigured profiles are rejected and requests cannot switch an existing conversation',async t=>{
 const f=await fixture(t,{gpuAvailable:false});
 assert.equal((await f.request('/api/admin/models','PUT',{model_profile_id:'bad'})).status,422);
 const unavailable=await f.request('/api/admin/models','PUT',{model_profile_id:'gpu31b'});assert.equal(unavailable.status,503);assert.equal(unavailable.data.error.code,'MODEL_PROFILE_UNAVAILABLE');
 assert.equal((await f.request('/api/intakes','POST',{conversation_epoch:0,model_profile_id:'local12b'})).status,422);
 const orphan=createIntake(await f.store.questionSet());orphan.modelProfileId='gpu31b';
 const oldBound=await f.store.createIntake(f.owner,orphan,0);
 const oldView=(await f.request(`/api/intakes/${oldBound.id}`)).data;
 const missing=await f.request(`/api/intakes/${oldBound.id}/answers`,'POST',{revision:oldView.revision,...syntheticAnswer(oldView.question)});assert.equal(missing.status,503);assert.equal(f.seen.length,0);
 const a=await f.start();assert.equal(a.model_profile_id,'local12b');
 const changed=await f.request(`/api/intakes/${a.id}/answers`,'POST',{revision:a.revision,...syntheticAnswer(a.question),model_profile_id:'gpu31b'});assert.equal(changed.status,422);assert.equal(f.seen.length,0);
});

dbtest('failed selected gateway never falls back and its pending answer survives retry',async t=>{
 const f=await fixture(t);const view=await f.start('gpu31b');
 const original=f.gpu.updateState;f.gpu.updateState=async()=>{throw new HttpError(503,'MODEL_UNAVAILABLE','합성 연결 실패');};
 const input={revision:view.revision,...syntheticAnswer(view.question)};
 const failed=await f.request(`/api/intakes/${view.id}/answers`,'POST',input);assert.equal(failed.status,503);assert.equal(f.seen.length,0);
 const pending=await f.store.intake(f.owner,view.id);assert.equal(pending.state.modelProfileId,'gpu31b');assert.ok(pending.state.modelPending);
 f.gpu.updateState=original;
 const retried=await f.request(`/api/intakes/${view.id}/answers`,'POST',input);assert.equal(retried.status,200);assert.deepEqual(f.seen,[['synthetic-gpu31b','answer']]);
});

dbtest('legacy unbound conversations keep the legacy gateway when selectable profiles are enabled',async t=>{
 const f=await fixture(t),state=createIntake(await f.store.questionSet());
 const legacy=await f.store.createIntake(f.owner,state,0);const response=await f.request(`/api/intakes/${legacy.id}`);assert.equal(response.data.model_profile_id,undefined);
 await f.answer(response.data);assert.deepEqual(f.seen,[['synthetic-local12b','answer']]);
 const old=await fixture(t,{legacy:true});assert.equal(old.bootstrap.model_profiles,undefined);
 const view=await old.start();assert.equal(view.model_profile_id,undefined);
 assert.equal((await old.request('/api/intakes','POST',{conversation_epoch:0,model_profile_id:'local12b'})).status,422);
 const bound=createIntake(await old.store.questionSet());bound.modelProfileId='gpu31b';
 const row=await old.store.createIntake(old.owner,bound,0),restored=(await old.request(`/api/intakes/${row.id}`)).data;
 const unavailable=await old.request(`/api/intakes/${row.id}/answers`,'POST',{revision:restored.revision,...syntheticAnswer(restored.question)});
 assert.equal(unavailable.status,503);assert.equal(unavailable.data.error.code,'MODEL_PROFILE_UNAVAILABLE');assert.equal(old.seen.length,0);
});


dbtest('CLI-style explicit gateway still loads the enabled profile registry from environment',async t=>{
 const keys=Object.keys(process.env).filter(key=>key==='MODEL_SELECTION_ENABLED'||key.startsWith('GPU31B_MODEL_'));
 const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 for(const key of keys)delete process.env[key];process.env.MODEL_SELECTION_ENABLED='true';
 try{
  const f=await fixture(t,{fromEnvironment:true});
  assert.equal(f.bootstrap.model_profiles,undefined);
  assert.deepEqual((await f.request('/api/admin/models')).data.profiles,[{id:'local12b',label:'12B',available:true},{id:'gpu31b',label:'31B',available:false}]);
  const v=await f.start('local12b');assert.equal(v.model_profile_id,'local12b');
 }finally{
  delete process.env.MODEL_SELECTION_ENABLED;
  for(const [key,value]of Object.entries(before))process.env[key]=value;
 }
});

dbtest('administrator selection persists across connections and cannot be overridden by public requests',async t=>{
 const f=await fixture(t),initial=await f.start();assert.equal(initial.model_profile_id,'local12b');
 const change=await f.request('/api/admin/models','PUT',{model_profile_id:'gpu31b'});assert.equal(change.status,200);
 assert.equal(change.data.selected_model_profile,'gpu31b');
 const reopened=await Store.connect(databaseUrl,f.key,30,{schema:f.schema});
 try{assert.equal(await reopened.selectedModelProfile(),'gpu31b');}finally{await reopened.close();}
 assert.equal((await f.start()).model_profile_id,'gpu31b');
 const continued=await f.answer(initial);assert.equal(continued.model_profile_id,'local12b');
 for(const id of ['local12b','gpu31b','bad']){
  const response=await f.request('/api/intakes','POST',{conversation_epoch:0,model_profile_id:id});assert.equal(response.status,422);
 }
 assert.equal((await f.request('/api/admin/models')).data.selected_model_profile,'gpu31b');
});

dbtest('administrator settings reject missing CSRF, foreign origins and forwarded requests without mutation',async t=>{
 const f=await fixture(t),input={model_profile_id:'gpu31b'};
 for(const [headers,code]of [
  [{'x-csrf-token':''},'CSRF_REJECTED'],
  [{origin:'https://foreign.example'},'ORIGIN_REJECTED'],
  [{'sec-fetch-site':'cross-site'},'ORIGIN_REJECTED'],
  [{forwarded:'for=127.0.0.1'},'LOCAL_ADMIN_REQUIRED'],
  [{'x-forwarded-for':'127.0.0.1'},'LOCAL_ADMIN_REQUIRED'],
  [{'x-forwarded-host':'localhost'},'LOCAL_ADMIN_REQUIRED'],
 ]){
  const denied=await f.request('/api/admin/models','PUT',input,headers);assert.equal(denied.status,403);assert.equal(denied.data.error.code,code);
  assert.equal(await f.store.selectedModelProfile(),'local12b');
 }
 assert.equal((await f.request('/api/admin/models','GET',undefined,{cookie:''})).status,401);
 const metadata=await f.request('/api/admin/models');assert.equal(metadata.status,200);
 assert.doesNotMatch(JSON.stringify(metadata.data),/synthetic-|api_key|base_url|secret/i);
});
