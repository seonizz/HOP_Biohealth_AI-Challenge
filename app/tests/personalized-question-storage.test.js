import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createApp} from '../src/server.js';
import {buildContext} from '../src/intake.js';
import {activeQuestionSet} from '../src/question-bank.js';
import {HttpError} from '../src/errors.js';
import {restoreLegacyV3Flow} from './helpers/legacy-v3-flow.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const databaseTest=(name,run)=>test(name,{skip:!databaseUrl&&'Requires isolated PostgreSQL test database'},run);
const report='합성 친구가 내일 이직에 관한 이야기를 나누자고 했어요.';
const extraAnswer='합성 친구는 새 직장의 면접 경험을 들어 달라고 했어요.';
const extraQuestion='그 이야기와 관련해 친구가 요청한 도움이 있나요?';
const guide={top:'통합',script:'네가 원하는 범위에서 이야기를 듣고 싶어.',doList:['원하는 도움을 확인해 보세요.'],
  avoid:['상대의 마음을 단정하지 마세요.'],next:'편한 대화 시간을 물어보세요.',care:{feel:'나의 여건도 살펴봐 주세요.',tips:['잠시 쉬어도 괜찮아요.']}};

function decision(context,sourceId='q3_01',extra={}){
  const field=context.patient.fields[sourceId]||context.supporter.fields[sourceId];
  assert.ok(field,'The synthetic question must bind to a submitted answer');
  const component=field.rawText?'rawText':'custom',quote=field[component];
  return {kind:'follow_up',question_id:null,subject:'patient',source_question_id:sourceId,source_revision:field.source_revision,
    component,quote,quote_start:0,quote_end:Array.from(quote).length,question:extraQuestion,focus:'support',
    reason:'요청한 도움의 범위를 확인해요.',...extra};
}

// Synthetic gateway only: this tests real HTTP, encrypted PostgreSQL persistence
// and final-record construction, not live-model quality or inference latency.
async function fixture(t,personalize,{failFirst=false}={}){
  const schema='personalized_storage_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});
  let app;
  t.after(async()=>{try{await app?.shutdown();}finally{
    try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await admin.end();}
  }});
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const seen=[],finalContexts=[];
  const memory=context=>({summary:'합성 저장 경로 검사',facts:[],unknowns:[],user_goal:context.user_goal.message?.text||'확인되지 않음'});
  const gateway={model:'synthetic-personalized-storage-test',protocol:'relationship_agent',async updateState(context){
    seen.push(structuredClone(context));
    if(failFirst&&seen.length===1)throw new HttpError(503,'MODEL_UNAVAILABLE','합성 일시 실패');
    return {patient_state:memory(context),name_index:null,question_plan:{skip:[]},personalization:personalize(context)};
  },async respond(context){
    finalContexts.push(structuredClone(context));
    return {patient_state:memory(context),name_index:null,assessment:{safety:false},guide:structuredClone(guide)};
  }};
  app=await createApp({databaseUrl,schema,key:randomBytes(32),gateway,modelProfiles:null,referralProvider:null});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const response=await fetch(base+'/api/bootstrap'),bootstrap=await response.json();
  assert.equal(response.status,200);
  const headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-csrf-token':bootstrap.csrf_token,'content-type':'application/json'};
  async function request(path,method='GET',data){
    const response=await fetch(base+path,{method,headers,...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {status:response.status,data:await response.json()};
  }
  const created=await request('/api/intakes','POST',{conversation_epoch:bootstrap.conversation_epoch});
  assert.equal(created.status,201);
  // These regressions retain the original 12-slot personalized flow for saved
  // conversations. New compact-flow HTTP/storage coverage lives separately.
  await restoreLegacyV3Flow(app.store,created.data.id);
  created.data=(await request(`/api/intakes/${created.data.id}`)).data;
  const input=(view,value)=>({revision:view.revision,question_id:view.question.id,instance_id:view.question.instance_id,
    follow_up:Boolean(view.question.follow_up),...value});
  async function answer(view,value){
    const result=await request(`/api/intakes/${view.id}/answers`,'POST',input(view,value));
    assert.equal(result.status,200,JSON.stringify(result.data));return result.data;
  }
  async function persisted(id){
    const owner=(await app.store.pool.query('SELECT owner FROM intakes WHERE id=$1',[id])).rows[0].owner;
    const row=await app.store.intake(owner,id),context=(await app.store.context(owner,id)).context;
    assert.deepEqual(context,buildContext(row.state));
    return {owner,row,context};
  }
  async function finish(view){
    let remaining=12;
    while(view.status==='active'){
      assert.ok(remaining-->0,'Question flow must finish within its bounded budget');
      view=await answer(view,{response_event:'skipped'});
    }
    const result=await request(`/api/intakes/${view.id}/result`,'POST',{revision:view.revision});
    assert.equal(result.status,200,JSON.stringify(result.data));
    const loaded=await request(`/api/records/${result.data.record.id}`);
    assert.equal(loaded.status,200);assert.deepEqual(loaded.data.record,result.data.record);
    return result.data.record;
  }
  return {app,request,input,answer,persisted,finish,view:created.data,seen,finalContexts};
}

databaseTest('legacy personalized follow-up and adapted canonical question survive HTTP reload and encrypted final storage',async t=>{
  let requested;
  const f=await fixture(t,context=>{
    if(context.latest_answer.question_id==='q3_01')return requested=decision(context);
    if(context.latest_answer.question_id==='q3_personal_01')return decision(context,'q3_personal_01',
      {kind:'next',question_id:'q3_09',subject:'supporter',question:null,focus:null});
    return null;
  });
  let view=await f.answer(f.view,{custom:report});
  assert.equal(view.question.id,'q3_personal_01');assert.equal(view.question.q,extraQuestion);
  assert.deepEqual((await f.request(`/api/intakes/${view.id}`)).data,view);
  let stored=await f.persisted(view.id);
  assert.equal(stored.context.patient.fields.q3_personal_01,undefined,'A generated question is not user evidence');
  assert.deepEqual(stored.row.state.v3.personalization.questions.q3_personal_01.decision,requested);
  view=await f.answer(view,{text:extraAnswer});
  assert.equal(view.question.id,'q3_09');
  const asked=view.question.q,canonical=activeQuestionSet.questions.find(question=>question.id==='q3_09');
  assert.ok(asked.includes(extraAnswer));assert.ok(asked.endsWith(canonical.q));
  assert.deepEqual(view.question.opts,canonical.opts);
  assert.deepEqual((await f.request(`/api/intakes/${view.id}`)).data,view);
  view=await f.answer(view,{text:'합성 검사에서는 시간을 정해 듣는 것이 가능해요.'});
  stored=await f.persisted(view.id);
  const personal=stored.context.patient.fields.q3_personal_01,adapted=stored.context.supporter.fields.q3_09;
  assert.equal(personal.question,extraQuestion);assert.equal(personal.rawText,extraAnswer);
  assert.deepEqual(personal.personalization,requested);assert.equal(personal.assignment,undefined);
  assert.equal(adapted.question,asked);assert.equal(adapted.asked_question,asked);assert.equal(adapted.canonical_question,canonical.q);
  const record=await f.finish(view);
  assert.deepEqual(record.context.patient.fields.q3_personal_01,personal);
  assert.deepEqual(record.context.supporter.fields.q3_09,adapted);
  assert.equal(f.finalContexts.length,1);assert.equal(f.finalContexts[0].patient.fields.q3_personal_01.rawText,extraAnswer);
  assert.equal(record.context.payload.answers.find(answer=>answer.id==='q3_personal_01').question,extraQuestion);
  const encrypted=await f.app.store.pool.query(`SELECT content FROM intakes WHERE id=$1
    UNION ALL SELECT content FROM patient_states WHERE intake_id=$1
    UNION ALL SELECT content FROM patient_state_revisions WHERE intake_id=$1
    UNION ALL SELECT content FROM records WHERE intake_id=$1`,[view.id]);
  for(const row of encrypted.rows)for(const text of [report,extraAnswer,extraQuestion])assert.equal(row.content.includes(text),false);
  assert.deepEqual(await f.app.store.record(stored.owner,record.id),record);
});

databaseTest('legacy persisted source correction removes transitive personalized answers from current and final evidence',async t=>{
  const f=await fixture(t,context=>{
    const latest=context.latest_answer.question_id;
    if(latest==='q3_01'&&!context.supporter.fields.q3_01.rawText.startsWith('정정'))return decision(context);
    if(latest==='q3_personal_01')return decision(context,'q3_personal_01',
      {question:'친구가 그 도움을 원하는 시점을 말했나요?',focus:'change'});
    return null;
  });
  let view=await f.answer(f.view,{custom:report});
  view=await f.answer(view,{text:extraAnswer});
  assert.equal(view.question.id,'q3_personal_02');
  view=await f.answer(view,{text:'합성 친구가 다음 주에 듣고 싶다고 했어요.'});
  const before=await f.persisted(view.id),oldRevision=before.row.revision;
  assert.equal(before.context.personalization.remaining_follow_ups,0);
  let remaining=3;
  while(view.question.id!=='q3_01'){
    assert.ok(remaining-->0);
    const back=await f.request(`/api/intakes/${view.id}/back`,'POST',{revision:view.revision});
    assert.equal(back.status,200,JSON.stringify(back.data));view=back.data;
  }
  view=await f.answer(view,{custom:'정정합니다. 친구가 만나자고 한 적도 도움을 부탁한 적도 없어요.'});
  const corrected=await f.persisted(view.id);
  for(const id of ['q3_personal_01','q3_personal_02']){
    assert.equal(corrected.row.state.v3.personalization.questions[id].status,'obsolete');
    assert.equal(corrected.row.state.clarificationAnswers[id],undefined);
    assert.equal(corrected.context.patient.fields[id],undefined);
    assert.ok(corrected.row.state.v3.issued[id],'An obsolete question must not refund a display slot');
  }
  assert.equal(corrected.context.personalization.remaining_follow_ups,0);
  assert.ok(corrected.context.payload.answers.every(answer=>!answer.id.startsWith('q3_personal_')));
  assert.deepEqual((await f.request(`/api/intakes/${view.id}/context`)).data.context,corrected.context);
  const history=(await f.app.store.pool.query('SELECT content FROM patient_state_revisions WHERE intake_id=$1 AND revision=$2',[view.id,oldRevision])).rows[0];
  const original=f.app.store.open(history.content,`${before.owner}:patient-history:${view.id}:${oldRevision}`);
  assert.equal(original.patient.fields.q3_personal_01.rawText,extraAnswer,'Immutable history remains separate from corrected current evidence');
  const record=await f.finish(view);
  assert.ok(record.context.payload.answers.every(answer=>!answer.id.startsWith('q3_personal_')));
  for(const id of ['q3_personal_01','q3_personal_02']){
    assert.equal(record.context.patient.fields[id],undefined);
    assert.equal(f.finalContexts[0].patient.fields[id],undefined);
  }
});

databaseTest('legacy persisted failed question turn retries without consuming extra personalized slots or instances',async t=>{
  const f=await fixture(t,context=>context.latest_answer.question_id==='q3_01'?decision(context):null,{failFirst:true});
  const path=`/api/intakes/${f.view.id}/answers`,input=f.input(f.view,{custom:report});
  const failed=await f.request(path,'POST',input);
  assert.equal(failed.status,503);
  const pending=(await f.request(`/api/intakes/${f.view.id}`)).data;
  assert.equal(pending.model_pending,true);assert.equal(pending.question_instances,1);
  const before=await f.persisted(f.view.id);
  assert.deepEqual(Object.keys(before.row.state.v3.personalization.questions),[]);
  const retried=await f.request(path,'POST',input);
  assert.equal(retried.status,200,JSON.stringify(retried.data));
  assert.equal(retried.data.question.id,'q3_personal_01');assert.equal(retried.data.question_instances,2);
  const stored=await f.persisted(f.view.id);
  assert.deepEqual(Object.keys(stored.row.state.v3.personalization.questions),['q3_personal_01']);
  assert.deepEqual(Object.keys(stored.row.state.v3.issued),['q3_01','q3_personal_01']);
  assert.equal(stored.context.personalization.remaining_follow_ups,1);
  assert.equal(f.seen.length,2);assert.equal(f.seen[0].input_revision,f.seen[1].input_revision);
  const duplicate=await f.request(path,'POST',input);
  assert.equal(duplicate.status,409);assert.equal(duplicate.data.error.code,'REVISION_CONFLICT');
  assert.deepEqual((await f.request(`/api/intakes/${f.view.id}`)).data,retried.data);
  assert.equal(f.seen.length,2,'A stale duplicate submission must not invoke the provider again');
});
