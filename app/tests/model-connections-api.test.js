import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import pg from 'pg';
import {createApp} from '../src/server.js';
import {configuredModelGateway} from '../src/model-config.js';
import {ModelGateway} from '../src/model.js';
import {contextGoal} from '../src/agent-state.js';
import {syntheticAnswer} from '../scripts/verify-questionnaire-v3-live.mjs';
import {createIntake} from '../src/intake.js';
const databaseUrl=process.env.TEST_DATABASE_URL;
const dbtest=(name,fn)=>test(name,{skip:!databaseUrl},fn);
async function fixture(t,{distinctLegacy=false,referral=false}={}){
 const admin=new pg.Pool({connectionString:databaseUrl}),schema='connection_'+randomBytes(8).toString('hex');await admin.query(`CREATE SCHEMA ${schema}`);
 const seen=[],mock=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;seen.push({path:req.url,key:req.headers.authorization,body:JSON.parse(body)});
  res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic endpoint unavailable'}}));});
 await new Promise(resolve=>mock.listen(0,'127.0.0.1',resolve));
 const base_url=`http://127.0.0.1:${mock.address().port}/v1`,key=randomBytes(32);
 let app,base,headers,environmentModel='original';
 const start=async()=>{
  const local=configuredModelGateway({env:{MODEL_BASE_URL:base_url,MODEL_API_KEY:'original-key',MODEL_NAME:environmentModel,MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined',MODEL_DISCOVER_TOKEN_LIMITS:'false'},retryFailures:false,diagnosticLogger:null});
  const legacy=distinctLegacy?configuredModelGateway({env:{MODEL_BASE_URL:base_url,MODEL_API_KEY:'legacy-key',MODEL_NAME:'legacy-'+environmentModel,MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined',MODEL_DISCOVER_TOKEN_LIMITS:'false'},retryFailures:false,diagnosticLogger:null}):local;
  app=await createApp({databaseUrl,schema,key,gateway:legacy,modelProfiles:{local12b:local,gpu31b:null},...(referral?{}:{referralProvider:null})});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;
  const r=await fetch(base+'/api/bootstrap'),boot=await r.json();assert.equal(boot.model_profiles,undefined);
  if(!headers)headers={cookie:r.headers.get('set-cookie').split(';')[0],'content-type':'application/json','x-csrf-token':boot.csrf_token};
 };
 await start();t.after(async()=>{await app.shutdown();await new Promise(resolve=>mock.close(resolve));await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
 const request=async(path,method='GET',body,extra={})=>{const r=await fetch(base+path,{method,headers:{...headers,...extra},...(body?{body:JSON.stringify(body)}:{})});const raw=await r.text();return {status:r.status,raw,data:JSON.parse(raw)};};
 const save=async(model,api_key='')=>request('/api/admin/model-connections/local12b','PUT',{base_url,model,api_key});
 return {request,save,seen,base_url,get app(){return app;},async owner(){return (await app.store.browser(headers.cookie.slice('malssi_session='.length))).id;},async restart(model){await app.shutdown();if(model)environmentModel=model;await start();}};
}
dbtest('encrypted immutable connections survive restart and never reroute existing conversations',async t=>{
 const f=await fixture(t),start=()=>f.request('/api/intakes','POST',{conversation_epoch:0});
 const original=await start();assert.equal(original.data.model_profile_id,'local12b_'+'2'.repeat(32));
 const first=await f.save('first','synthetic-first-key');assert.equal(first.status,200,first.raw);assert.doesNotMatch(first.raw,/synthetic-first-key/);
 const one=await start();assert.match(one.data.model_profile_id,/^local12b_[a-f0-9]{32}$/);
 assert.equal(f.seen.length,0,'saving must not contact model endpoint');
 const second=await f.save('second');assert.equal(second.status,200);await f.restart('changed-environment');
 const two=await start();assert.notEqual(one.data.model_profile_id,two.data.model_profile_id);
 const metadata=await f.request('/api/admin/model-connections');assert.equal(metadata.data.connections.length,2);assert.equal(metadata.data.connections[0].model,'second');
 assert.equal(metadata.data.connections[0].api_key_configured,true);assert.doesNotMatch(metadata.raw,/synthetic-first-key|original-key/);
 const settings=await f.request('/api/admin/models');assert.deepEqual(settings.data.profiles.map(p=>p.id),['local12b','gpu31b']);assert.equal(settings.data.selected_model_profile,'local12b');
 const rows=await f.app.store.pool.query('SELECT id,content FROM model_connections ORDER BY sequence');assert.equal(rows.rowCount,5);assert.doesNotMatch(JSON.stringify(rows.rows),/synthetic-first-key/);
 const saved=f.app.store.open(rows.rows.at(-1).content,`model-connection:${rows.rows.at(-1).id}`);assert.equal(saved.writer.apiKey,'synthetic-first-key');
 assert.throws(()=>f.app.store.open(rows.rows.at(-1).content,'model-connection:wrong'));
 for(const [view,key,model]of [[original.data,'original-key','original'],[one.data,'synthetic-first-key','first'],[two.data,'synthetic-first-key','second']]){
  const before=f.seen.length;
  const result=await f.request(`/api/intakes/${view.id}/answers`,'POST',{revision:view.revision,...syntheticAnswer(view.question)});assert.equal(result.status,503);assert.doesNotMatch(result.raw,/synthetic-first-key|original-key/);
  const requests=f.seen.slice(before);assert.ok(requests.length>0);
  for(const request of requests){assert.equal(request.key,'Bearer '+key);assert.equal(request.body.model,model);assert.equal(request.path,'/v1/chat/completions');}
 }
 assert.equal((await f.request('/api/admin/models','PUT',{model_profile_id:one.data.model_profile_id})).status,422);
});
dbtest('connection writes enforce local origin and CSRF and reject invalid input without persistence',async t=>{
 const f=await fixture(t),input={base_url:f.base_url,model:'one',api_key:'synthetic-private-key'};
 for(const headers of [{'x-csrf-token':''},{origin:'https://foreign.example'},{'x-forwarded-for':'127.0.0.1'}]){
  const result=await f.request('/api/admin/model-connections/local12b','PUT',input,headers);assert.equal(result.status,403);assert.doesNotMatch(result.raw,/synthetic-private-key/);
 }
 for(const patch of [{base_url:'http://external.example/v1'},{base_url:'https://user:secret@external.example/v1'},{model:''},{extra:true}]){
  const result=await f.request('/api/admin/model-connections/local12b','PUT',{...input,...patch});assert.equal(result.status,422);assert.doesNotMatch(result.raw,/synthetic-private-key|user:secret/);
 }
 assert.equal((await f.app.store.pool.query('SELECT 1 FROM model_connections')).rowCount,3);assert.equal(f.seen.length,0);
});

dbtest('concurrent baseline creation preserves the first immutable encrypted configuration',async t=>{
 const f=await fixture(t),original=(await f.app.store.modelConnections())[0].config;
 const configs=['first-baseline','second-baseline'].map(model=>({...original,writer:{...original.writer,model},review:original.review?{...original.review,model}:null}));
 const rows=await Promise.all(configs.map(config=>f.app.store.createModelConnection('gpu31b',config)));
 assert.equal(rows[0].id,rows[1].id);assert.deepEqual(rows[0].config,rows[1].config);
 assert.ok(configs.some(config=>config.writer.model===rows[0].config.writer.model));
 const stored=await f.app.store.pool.query("SELECT content FROM model_connections WHERE profile_id='gpu31b'");
 assert.equal(stored.rowCount,1);assert.doesNotMatch(stored.rows[0].content,/first-baseline|second-baseline/);
});

dbtest('concurrent legacy snapshots converge without becoming the current selectable connection',async t=>{
 const f=await fixture(t),original=(await f.app.store.modelConnections()).find(row=>row.config.role==='baseline').config;
 const configs=['legacy-first','legacy-second'].map(model=>({...original,role:'legacy',writer:{...original.writer,model}}));
 // The startup snapshot already exists; neither racing save may replace it.
 const rows=await Promise.all(configs.map(config=>f.app.store.createModelConnection('local12b',config)));
 assert.equal(rows[0].id,'local12b_'+'1'.repeat(32));assert.deepEqual(rows[0],rows[1]);
 assert.equal(rows[0].config.writer.model,'original');
 const selected=await f.request('/api/admin/model-connections');assert.equal(selected.data.connections[0].model,'original');
 assert.equal((await f.app.store.modelConnections()).filter(row=>row.config.role==='legacy').length,1);
});

dbtest('unbound legacy answers, result, referral and continuations retain a distinct gateway after edit and restart',async t=>{
 const seen=[];
 Object.defineProperty(ModelGateway.prototype,'referralGuidance',{configurable:true,value:async function(){
  seen.push([this.model,'referral']);return {schema_version:'1.0',subject:'patient',urgency:'undetermined',reviewed:true,evidence_source_ids:[],institution_ids:[],model_version:this.model};
 }});
 t.after(()=>delete ModelGateway.prototype.referralGuidance);
 const f=await fixture(t,{distinctLegacy:true,referral:true}),owner=await f.owner();
 const legacyState=createIntake(await f.app.store.questionSet());
 // This unbound connection represents a saved intake predating both model
 // connection binding and compact question flow.
 delete legacyState.v3.compact_flow;
 const unbound=await f.app.store.createIntake(owner,legacyState,0);
 const view=(await f.request(`/api/intakes/${unbound.id}`)).data;assert.equal(view.model_profile_id,undefined);
 await f.save('edited-local','edited-key');await f.restart('changed-environment');
 const before=f.seen.length;
 const answer=await f.request(`/api/intakes/${view.id}/answers`,'POST',{revision:view.revision,...syntheticAnswer(view.question)});
 assert.equal(answer.status,503);assert.ok(f.seen.length>before);
 for(const request of f.seen.slice(before)){assert.equal(request.body.model,'legacy-original');assert.equal(request.key,'Bearer legacy-key');}
 t.mock.method(ModelGateway.prototype,'respond',async function(context){
  seen.push([this.model,'result']);return {patient_state:{summary:'합성 상태',facts:[],unknowns:[],user_goal:contextGoal(context)},name_index:null,assessment:{safety:false},
   guide:{top:'통합',script:'편할 때 이야기해 줘.',doList:['천천히 듣기'],avoid:['재촉하기'],next:'원하는 도움을 물어보세요.',care:{feel:'내 마음도 돌봐 주세요.',tips:['잠시 쉬어 보세요.']}}};
 });
 t.mock.method(ModelGateway.prototype,'continueConversation',async function({messages}){
  seen.push([this.model,'continuation']);return {answer:'편할 때 이야기해 보세요.',clarification:null,
   facts:messages.filter(message=>message.role==='user'&&!message.skipped).map(message=>({message_id:message.id,subject:'supporter',quote:message.text})),superseded:[],safety:{urgent:false}};
 });
 const current=await f.app.store.intake(owner,view.id);
 const ready=await f.app.store.updateIntake(owner,view.id,current.revision,state=>{delete state.modelPending;return {...state,status:'ready'};},'model_update');
 const result=await f.request(`/api/intakes/${view.id}/result`,'POST',{revision:ready.revision});assert.equal(result.status,200,result.raw);
 assert.equal(result.data.record.provenance.model,'legacy-original');assert.equal(result.data.record.provenance.model_profile_id,undefined);
 const guidance=await f.request(`/api/intakes/${view.id}/guidance`,'POST',{revision:result.data.revision});assert.equal(guidance.status,200,guidance.raw);
 const continuation=await f.request(`/api/records/${result.data.record.id}/continuations`,'POST',{request_id:randomUUID(),conversation_epoch:0});assert.equal(continuation.status,201,continuation.raw);
 const message=await f.request(`/api/continuations/${continuation.data.continuation.id}/messages`,'POST',{revision:0,request_id:randomUUID(),text:'상황: 오늘은 저도 쉬려고 해요.'});assert.equal(message.status,200,message.raw);
 assert.ok(seen.some(([model,kind])=>model==='legacy-original'&&kind==='result'));
 assert.ok(seen.some(([model,kind])=>model==='legacy-original'&&kind==='referral'));
 assert.ok(seen.some(([model,kind])=>model==='legacy-original'&&kind==='continuation'));
 assert.ok(seen.every(([model])=>model==='legacy-original'));
 const read=await f.request(`/api/records/${result.data.record.id}`);assert.deepEqual(read.data.record,result.data.record);
});

dbtest('result records keep baseline and versioned model identities after environment changes and restart',async t=>{
 const f=await fixture(t),start=async()=>{const result=await f.request('/api/intakes','POST',{conversation_epoch:0});assert.equal(result.status,201);return result.data;};
 const original=await start();await f.save('edited','edited-key');const edited=await start();await f.restart('changed-environment');
 const seen=[];
 t.mock.method(ModelGateway.prototype,'respond',async function(context){
  seen.push(this.model);
  return {patient_state:{summary:'합성 저장 검증입니다.',facts:[],unknowns:[],user_goal:contextGoal(context)},name_index:null,assessment:{safety:false},
   guide:{top:'통합',script:'편할 때 이야기해 줘.',doList:['천천히 듣기'],avoid:['재촉하기'],next:'원하는 도움을 물어보세요.',care:{feel:'내 마음도 돌봐 주세요.',tips:['잠시 쉬어 보세요.']}}};
 });
 const owner=await f.owner();
 for(const [view,model]of [[original,'original'],[edited,'edited']]){
  const ready=await f.app.store.updateIntake(owner,view.id,view.revision,state=>({...state,status:'ready'}),'model_update');
  const result=await f.request(`/api/intakes/${view.id}/result`,'POST',{revision:ready.revision});assert.equal(result.status,200,result.raw);
  assert.equal(result.data.record.provenance.model,model);assert.equal(result.data.record.provenance.model_profile_id,view.model_profile_id);
  const read=await f.request(`/api/records/${result.data.record.id}`);assert.deepEqual(read.data.record,result.data.record);
  const stored=await f.app.store.pool.query('SELECT content FROM records WHERE owner=$1 AND id=$2',[owner,result.data.record.id]);
  assert.equal(stored.rowCount,1);assert.deepEqual(f.app.store.openRecord(stored.rows[0].content,owner,result.data.record.id),result.data.record);
 }
 assert.deepEqual(seen,['original','edited']);assert.equal(f.seen.length,0);
});
