import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createApp} from '../src/server.js';
import {buildContext} from '../src/intake.js';
import {HttpError} from '../src/errors.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const databaseTest=(name,run)=>test(name,{skip:!databaseUrl&&'Requires isolated PostgreSQL test database'},run);
const purpose='합성 검사에서는 친구에게 이사 도움을 거절하는 짧은 문장을 전하고 싶어요.';
const scene='합성 친구가 내일 이사를 도와 달라고 했지만 저는 이미 근무가 잡혀 있어요.';
const guide={top:'통합',script:'내일은 근무가 있어 이사를 도와주기 어려워.',doList:['가능한 범위를 먼저 확인해 보세요.'],
  avoid:['상대의 마음을 단정하지 마세요.'],next:'가능한 도움을 정한 뒤 전달해 보세요.',care:{feel:'내 여건도 살펴봐 주세요.',tips:['잠시 쉬어도 괜찮아요.']}};

// Synthetic provider, real HTTP and encrypted PostgreSQL. Model latency and
// live model decision quality are intentionally outside this regression.
async function fixture(t,{update=()=>({}),failFirst=false}={}){
  const schema='compact_storage_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});
  let app;
  t.after(async()=>{try{await app?.shutdown();}finally{
    try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await admin.end();}
  }});
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const seen=[],finalContexts=[];
  const memory=context=>({summary:'짧은 질문 흐름 합성 검사',facts:[],unknowns:[],user_goal:context.user_goal.message?.text||'확인되지 않음'});
  const gateway={model:'synthetic-compact-storage',protocol:'relationship_agent',async updateState(context){
    seen.push(structuredClone(context));
    if(failFirst&&seen.length===1)throw new HttpError(503,'MODEL_UNAVAILABLE','합성 일시 실패');
    return {patient_state:memory(context),name_index:null,question_plan:{skip:[]},...update(context)};
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
  const input=(view,value)=>({revision:view.revision,question_id:view.question.id,instance_id:view.question.instance_id,
    follow_up:Boolean(view.question.follow_up),...value});
  async function answer(view,value){
    const result=await request(`/api/intakes/${view.id}/answers`,'POST',input(view,value));
    assert.equal(result.status,200,JSON.stringify(result.data));return result.data;
  }
  async function persisted(id){
    const owner=(await app.store.pool.query('SELECT owner FROM intakes WHERE id=$1',[id])).rows[0].owner;
    const row=await app.store.intake(owner,id),context=(await app.store.context(owner,id)).context;
    assert.deepEqual(context,buildContext(row.state));return {owner,row,context};
  }
  async function finish(view){
    assert.equal(view.status,'ready');assert.equal(view.question,null);
    const result=await request(`/api/intakes/${view.id}/result`,'POST',{revision:view.revision});
    assert.equal(result.status,200,JSON.stringify(result.data));
    const loaded=await request(`/api/records/${result.data.record.id}`);
    assert.equal(loaded.status,200);assert.deepEqual(loaded.data.record,result.data.record);
    const {owner}=await persisted(view.id);
    assert.deepEqual(await app.store.record(owner,result.data.record.id),result.data.record);
    return result.data.record;
  }
  return {app,request,input,answer,persisted,finish,view:created.data,bootstrap,seen,finalContexts};
}

function decision(context,id,{kind='next',question=null,focus=null}={}){
  const source=context.latest_answer.question_id;
  const field=context.patient.fields[source]||context.supporter.fields[source];
  const target=context.question_candidates.find(candidate=>candidate.id===id);
  if(id)assert.ok(target,'An optional question must be a currently unasked candidate');
  return {kind,question_id:id,subject:target?.subject||'patient',source_question_id:source,source_revision:field.source_revision,
    component:'rawText',quote:field.rawText,quote_start:0,quote_end:Array.from(field.rawText).length,
    question,focus,reason:'실제로 제안할 수 있는 도움의 범위가 아직 없어 전달할 문장을 정하기 위해 확인해요.'};
}

databaseTest('new HTTP conversations ask purpose then situation and save cards after exactly two answers',async t=>{
  const f=await fixture(t);
  assert.equal(f.bootstrap.questions.length,9,'The reference question bank remains intact');
  assert.equal(f.view.question.id,'q3_01');
  let view=await f.answer(f.view,{custom:purpose});
  assert.equal(view.question.id,'q3_03');assert.equal(view.question_instances,2);
  assert.deepEqual((await f.request(`/api/intakes/${view.id}`)).data,view);
  view=await f.answer(view,{text:scene});
  assert.equal(view.status,'ready');assert.equal(view.question_instances,2);
  assert.equal(f.seen.length,2,'Default question processing has one provider call per answer');
  const stored=await f.persisted(view.id);
  assert.equal(stored.row.state.v3.compact_flow.version,1);
  assert.deepEqual(Object.keys(stored.row.state.v3.issued),['q3_01','q3_03']);
  assert.deepEqual(stored.row.state.modelSkipped,{},'Unneeded optional questions are not fabricated model skip decisions');
  assert.deepEqual(stored.context.payload.answers.map(answer=>answer.id),['q3_01','q3_03']);
  for(const id of ['q3_02','q3_04','q3_05','q3_06','q3_07','q3_08','q3_09']){
    const field=stored.context.patient.fields[id]||stored.context.supporter.fields[id];
    assert.equal(field.status,'not_asked');assert.equal(stored.row.state.ans[id],undefined);
  }
  const record=await f.finish(view);
  assert.equal(f.finalContexts.length,1);
  assert.equal(record.context.supporter.fields.q3_01.rawText,purpose);
  assert.equal(record.context.patient.fields.q3_03.rawText,scene);
  assert.deepEqual(record.context.payload.answers.map(answer=>answer.id),['q3_01','q3_03']);
  assert.deepEqual(record.guide,guide);
  const encrypted=await f.app.store.pool.query(`SELECT content FROM intakes WHERE id=$1
    UNION ALL SELECT content FROM patient_states WHERE intake_id=$1
    UNION ALL SELECT content FROM patient_state_revisions WHERE intake_id=$1
    UNION ALL SELECT content FROM records WHERE intake_id=$1`,[view.id]);
  for(const row of encrypted.rows)for(const text of [purpose,scene])assert.equal(row.content.includes(text),false);
  const continuation=await f.request(`/api/records/${record.id}/continuations`,'POST',{
    request_id:randomUUID(),conversation_epoch:f.bootstrap.conversation_epoch});
  assert.equal(continuation.status,201,JSON.stringify(continuation.data));
  assert.equal(f.seen.length,2,'Creating a continuation does not rerun the completed questionnaire');
});

databaseTest('only explicit essential questions extend compact HTTP flow to three or four and remain exact in storage',async t=>{
  for(const optionalIds of [['q3_08'],['q3_08','q3_09']]){
    const f=await fixture(t,{update(context){
      const index=['q3_03',...optionalIds].indexOf(context.latest_answer.question_id);
      if(index<0||index>=optionalIds.length)return {};
      return {personalization:decision(context,optionalIds[index])};
    }});
    let view=await f.answer(f.view,{custom:purpose});
    view=await f.answer(view,{text:scene});
    for(const id of optionalIds){
      assert.equal(view.question.id,id);
      assert.deepEqual((await f.request(`/api/intakes/${view.id}`)).data,view);
      const submitted='합성 검사에서는 주말에 한 시간만 도울 수 있어요.';
      view=await f.answer(view,view.question.type==='text'?{text:submitted}:{custom:submitted});
    }
    assert.equal(view.question_instances,optionalIds.length+2);
    assert.equal(f.seen.length,optionalIds.length+2);
    const record=await f.finish(view);
    assert.deepEqual(record.context.payload.answers.map(answer=>answer.id),['q3_01','q3_03',...optionalIds]);
    assert.equal(record.context.patient.fields.q3_02.status,'not_asked');
    for(const context of f.seen)assert.ok(context.question_candidates.every(candidate=>
      !context.payload.answers.some(answer=>answer.id===candidate.id)),'Answered questions never reappear as candidates');
  }
});

databaseTest('compact HTTP follow-up starts only after situation and its answer reaches the final stored card context',async t=>{
  const question='주말에 대신 도울 수 있는 시간을 이미 정했나요?';
  const f=await fixture(t,{update(context){
    if(!['q3_01','q3_03'].includes(context.latest_answer.question_id))return {};
    return {personalization:decision(context,null,{kind:'follow_up',question,focus:'support'})};
  }});
  let view=await f.answer(f.view,{custom:purpose});
  assert.equal(view.question.id,'q3_03');
  let stored=await f.persisted(view.id);
  assert.deepEqual(stored.row.state.v3.personalization.questions,{},'An ignored early proposal consumes no hidden follow-up slot');
  view=await f.answer(view,{text:scene});
  assert.equal(view.question.id,'q3_personal_01');assert.equal(view.question.q,question);
  stored=await f.persisted(view.id);
  assert.equal(stored.context.patient.fields.q3_personal_01,undefined,'A displayed question is not a user fact');
  const answer='합성 검사에서는 주말 오전 한 시간만 도울 수 있다고 정했어요.';
  view=await f.answer(view,{text:answer});
  assert.equal(view.question_instances,3);
  const record=await f.finish(view);
  assert.equal(record.context.patient.fields.q3_personal_01.rawText,answer);
  assert.equal(record.context.patient.fields.q3_personal_01.question,question);
  assert.equal(record.context.patient.fields.q3_personal_01.assignment,undefined);
});

databaseTest('a situation already answered with exact evidence is not asked or invented in compact DB records',async t=>{
  const combined=purpose+' '+scene;
  const f=await fixture(t,{update(context){
    const source=context.supporter.fields.q3_01;
    return {question_plan:{skip:[{question_id:'q3_03',reason:'already_covered',explanation:'목적 답변에 친구의 이사 요청과 근무로 어려운 상황을 함께 밝혔어요.',
      evidence:[{subject:'supporter',question_id:'q3_01',quote:source.rawText}]}]}};
  }});
  const view=await f.answer(f.view,{custom:combined});
  assert.equal(view.question_instances,1);assert.equal(view.status,'ready');
  const {row,context}=await f.persisted(view.id);
  assert.equal(row.state.ans.q3_03,undefined);assert.equal(context.patient.fields.q3_03.status,'auto_skipped');
  assert.equal(context.patient.fields.q3_03.rawText,undefined);
  const record=await f.finish(view);
  assert.deepEqual(record.context.payload.answers.map(answer=>answer.id),['q3_01']);
  assert.equal(record.context.supporter.fields.q3_01.rawText,combined);
});

databaseTest('compact failed turn retries the same answer once and then completes without duplicate questions or records',async t=>{
  const f=await fixture(t,{failFirst:true});
  const path=`/api/intakes/${f.view.id}/answers`,input=f.input(f.view,{custom:purpose});
  assert.equal((await f.request(path,'POST',input)).status,503);
  const pending=(await f.request(`/api/intakes/${f.view.id}`)).data;
  assert.equal(pending.model_pending,true);assert.equal(pending.question_instances,1);
  const retried=await f.request(path,'POST',input);
  assert.equal(retried.status,200,JSON.stringify(retried.data));
  assert.equal(retried.data.question.id,'q3_03');assert.equal(retried.data.question_instances,2);
  assert.equal(f.seen[0].input_revision,f.seen[1].input_revision);
  assert.equal((await f.request(path,'POST',input)).status,409);
  assert.equal(f.seen.length,2,'A duplicate answer never calls the provider again');
  const view=await f.answer(retried.data,{text:scene});
  const record=await f.finish(view);
  assert.equal(f.finalContexts.length,1);assert.equal(view.question_instances,2);
  const count=await f.app.store.pool.query('SELECT count(*)::int AS count FROM records WHERE intake_id=$1',[view.id]);
  assert.equal(count.rows[0].count,1);assert.equal(record.context.payload.answers.length,2);
});
