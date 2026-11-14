import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createApp} from '../src/server.js';
import {safetySources,agentContext} from '../src/relationship-agent.js';
import {HttpError} from '../src/errors.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
async function fixture(t,{clarify=false,failStopOnce=false}={}) {
  const schema='test_v3_api_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const seen=[];
  let failedStop=false;
  const gateway={model:'synthetic-v3-interface-test',protocol:'relationship_agent',async updateState(context){
    seen.push(context);
    if(failStopOnce&&context.user_stopped&&!failedStop){failedStop=true;throw new HttpError(503,'MODEL_UNAVAILABLE','합성 모델 연결 실패');}
    const field=context.patient.fields.q3_03;
    return {patient_state:{summary:'인터페이스 검사용',facts:[],unknowns:[],user_goal:context.user_goal.message?.text||'확인되지 않음'},name_index:null,question_plan:{skip:[]},
      ...(clarify&&context.clarification_available&&field?.status==='answered'?{clarification:{source_question_id:field.id,source_revision:field.source_revision,component:'rawText',event_id:'reported_speech',quote:field.rawText,quote_start:0,quote_end:Array.from(field.rawText).length,axis:'actor',role:'speaker'}}:{})};
  },async respond(context){return {patient_state:{summary:'합성 인터페이스 결과',facts:[],unknowns:[],user_goal:context.user_goal.message?.text||'확인되지 않음'},name_index:null,
    assessment:{safety:false},guide:{top:'통합',script:'내가 가능한 범위에서 이야기하고 싶어.',doList:['가능한 범위를 말해 보세요.'],avoid:['상대의 마음을 단정하지 마세요.'],next:'서로 원하는 범위를 확인해 보세요.',care:{feel:'나의 마음도 살펴봐 주세요.',tips:['잠시 쉬어도 괜찮아요.']}}};}};
  const app=await createApp({databaseUrl,schema,key:randomBytes(32),gateway,referralProvider:null});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{
    await new Promise(resolve=>app.server.close(resolve));await app.store.close().catch(()=>{});
    try{await admin.query(`DROP SCHEMA ${schema} CASCADE`);}finally{await admin.end();}
  });
  const response=await fetch(base+'/api/bootstrap'),bootstrap=await response.json();
  const headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-csrf-token':bootstrap.csrf_token,'content-type':'application/json'};
  async function request(path,method='GET',data){
    const result=await fetch(base+path,{method,headers,...(data?{body:JSON.stringify(data)}:{})});
    return {status:result.status,data:await result.json()};
  }
  const created=await request('/api/intakes','POST',{conversation_epoch:bootstrap.conversation_epoch});
  assert.equal(created.status,201);
  async function answer(view,input){
    const result=await request(`/api/intakes/${view.id}/answers`,'POST',{revision:view.revision,question_id:view.question.id,instance_id:view.question.instance_id,follow_up:!!view.question.follow_up,...input});
    assert.equal(result.status,200,JSON.stringify(result.data));return result.data;
  }
  return {request,answer,view:created.data,bootstrap,seen};
}

test('v3 HTTP preserves option+custom, one help display, refusal/stop and persisted bundle', {skip:!databaseUrl},async t=>{
  const f=await fixture(t);
  assert.equal(f.bootstrap.questions.length,9);
  let v=f.view;
  assert.equal(v.question.id,'q3_01');
  v=await f.answer(v,{selected:[0],custom:'이번에는 맡지 않겠다고 말하고 싶어요.'});
  assert.equal(v.question.id,'q3_02');
  const id=v.question.instance_id;
  v=await f.answer(v,{response_event:'not_understood'});
  assert.equal(v.question.instance_id,id);
  assert.equal(v.log.filter(row=>row.text.includes('실명은 필요하지 않습니다')).length,1);
  v=await f.answer(v,{response_event:'not_understood'});
  assert.equal(v.question.id,'q3_03');
  v=await f.answer(v,{response_event:'refused',text:'이 내용은 답하지 않지만 이 원문은 안전 검토에 남겨요.'});
  assert.equal(v.question.id,'q3_04');
  const refused=f.seen.at(-1);
  assert.equal(refused.patient.fields.q3_03.status,'refused');
  assert.ok(safetySources(refused).some(source=>source.question_id==='q3_03'));
  assert.ok(!agentContext(refused).patient.find(row=>row.question_id==='q3_03')?.answers.length);
  v=await f.answer(v,{response_event:'stop'});
  assert.equal(v.status,'ready');
  assert.equal(v.question,null);
  const restored=await f.request(`/api/intakes/${v.id}`);
  assert.deepEqual(restored.data,v);
  const context=(await f.request(`/api/intakes/${v.id}/context`)).data.context;
  assert.equal(context.bundle_id,'malssi-intake-3.0.0-rc1');
  assert.equal(context.user_stopped,true);
  assert.equal(context.user_goal.message.id,'q3_01');
  assert.match(context.user_goal.message.text,/이번에는/);
  const result=await f.request(`/api/intakes/${v.id}/result`,'POST',{revision:v.revision});
  assert.equal(result.status,409);
  assert.equal(result.data.error.code,'INTAKE_STOPPED');
});

test('v3 HTTP renders bound Q10 once and keeps the single selected axis through reload', {skip:!databaseUrl},async t=>{
  const f=await fixture(t,{clarify:true});let v=f.view;
  v=await f.answer(v,{selected:[3]});
  v=await f.answer(v,{response_event:'skipped'});
  v=await f.answer(v,{text:'내일 만나자고 했어요.'});
  assert.equal(v.question.id,'q3_10');
  assert.equal(v.question.binding.axis,'actor');
  assert.match(v.question.q,/내일 만나자고 했어요/);
  v=await f.answer(v,{selected:[0]});
  assert.equal(v.question.id,'q3_04');
  const context=(await f.request(`/api/intakes/${v.id}/context`)).data.context;
  assert.deepEqual(context.clarification_state.assignment,{event_id:'reported_speech',axis:'actor',value:'user',role:'speaker'});
  assert.equal(context.clarification_available,false);
  const stale=await f.request(`/api/intakes/${v.id}/answers`,'POST',{revision:v.revision,question_id:'q3_10',follow_up:true,selected:[1]});
  assert.equal(stale.status,409);
});

test('v3 persisted stop survives model outage, rejects replacement and retries identical source', {skip:!databaseUrl},async t=>{
  const f=await fixture(t,{failStopOnce:true});
  const v=f.view,path=`/api/intakes/${v.id}/answers`;
  const input={revision:v.revision,question_id:v.question.id,instance_id:v.question.instance_id,response_event:'stop',text:'여기까지 남기는 원문'};
  assert.equal((await f.request(path,'POST',input)).status,503);
  const pending=(await f.request(`/api/intakes/${v.id}`)).data;
  assert.equal(pending.input_locked,true);
  assert.equal(pending.user_stopped,true);
  assert.equal(pending.pending_answer.text,input.text);
  const replacement=await f.request(path,'POST',{...input,revision:pending.revision,response_event:'answered',text:'일반 답변으로 바꾸기',custom:'일반 답변으로 바꾸기'});
  assert.equal(replacement.status,409);
  assert.equal(replacement.data.error.code,'INTAKE_STOPPED');
  const back=await f.request(`/api/intakes/${v.id}/back`,'POST',{revision:pending.revision});
  assert.equal(back.status,409);
  const retry=await f.request(path,'POST',input);
  assert.equal(retry.status,200);
  assert.equal(retry.data.user_stopped,true);
  assert.equal(retry.data.status,'ready');
  assert.equal(f.seen[0].input_revision,f.seen[1].input_revision);
});

test('v3 ordinary completion retains card and encrypted record contracts', {skip:!databaseUrl},async t=>{
  const f=await fixture(t);let v=f.view;
  v=await f.answer(v,{selected:[0],custom:'이번에는 일을 맡기 어렵다고 말하고 싶어요.'});
  while(v.status==='active')v=await f.answer(v,{skipped:true});
  assert.equal(v.user_stopped,false);
  const result=await f.request(`/api/intakes/${v.id}/result`,'POST',{revision:v.revision});
  assert.equal(result.status,200,JSON.stringify(result.data));
  const record=result.data.record;
  assert.ok(record.guide.script&&record.guide.care.feel&&record.guide.doList.length&&record.guide.avoid.length);
  assert.equal(record.context.bundle_id,'malssi-intake-3.0.0-rc1');
  const read=await f.request(`/api/records/${record.id}`);
  assert.deepEqual(read.data.record,record);
});
