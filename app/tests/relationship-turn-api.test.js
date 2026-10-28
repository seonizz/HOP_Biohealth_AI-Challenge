import {safetyReviewFixture} from './helpers/safety-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/server.js';
import { ModelGateway } from '../src/model.js';
import { createIntake, answerIntake, currentView } from '../src/intake.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const source='지난주부터 저녁 식사를 거르는 모습을 봤어요. 오늘은 잘 먹었다고 정정했어요.';
const audits=claims=>claims.map(claim=>({id:claim.id,verdict:claim.certainty==='reported'?'supported':'plausible',reason:'현재 합성 원문과 일치합니다.'}));
const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));

function stateDraft(input) {
  const latest=input.latest_answer;
  const answer=latest.answers[0].text;
  const evidence={subject:latest.subject,question_id:latest.question_id,quote:answer};
  const name=input.patient.find(item=>item.question_id==='name').answers[0].text;
  return {patient_state:{facts:[{...evidence,certainty:'reported'}],unknowns:[]},
    name_index:{alias:name,source_question_id:'name',quote:name},relationship_memory:{
      patient:latest.subject==='patient'&&latest.question_id!=='name'?[{evidence:[evidence],certainty:'reported'}]:[],
      supporter:[],relationship:[],unknowns:[],
    }};
}

function modelFixture(mode='combined',beforeResponse) {
  const stages=[];
  const gateway=new ModelGateway({baseUrl:'http://synthetic-model.test/v1',apiKey:'synthetic-test-key',model:'same-synthetic-model',protocol:'relationship_agent',
    stateMode:mode,diagnosticLogger:null,fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body),input=JSON.parse(body.messages[1].content),{stage,data}=input;stages.push(stage);
      assert.equal(body.model,'same-synthetic-model');
      const override=await beforeResponse?.(input);
      if(override)return override;
      if(stage==='turn_draft')return envelope({state:stateDraft({...data.shared_input,...data.state_input}),questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}});
      if(stage==='turn_review')return envelope({state:{approved:true,issues:[],audits:audits(data.review_target.claims)},questions:null,safety:null});
      if(stage==='state_observations') {const state=stateDraft(data);return envelope({patient_state:state.patient_state,name_index:state.name_index});}
      if(stage==='relationship_memory')return envelope({relationship_memory:stateDraft(data).relationship_memory});
      if(stage==='state_review')return envelope({approved:true,issues:[],audits:audits(data.claims)});
      if(stage==='safety_review')return envelope(safetyReviewFixture(data));
      if(stage==='question_plan')return envelope({skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}});
      assert.fail('Unexpected stage: '+stage);
    }});
  return {gateway,stages};
}

async function fixture(t,gateway) {
  const schema='turn_api_'+randomBytes(8).toString('hex');
  const admin=new pg.Pool({connectionString:databaseUrl});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const app=await createApp({databaseUrl,schema,key:randomBytes(32),gateway});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{
    await new Promise(resolve=>app.server.close(resolve));
    await app.store.close().catch(()=>{});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();
  });
  const base='http://127.0.0.1:'+app.server.address().port;
  const response=await fetch(base+'/api/bootstrap'),bootstrap=await response.json();
  assert.equal(response.status,200);
  const cookie=response.headers.get('set-cookie').split(';')[0];
  const request=async(path,method='GET',data)=>{
    const result=await fetch(base+path,{method,headers:{cookie,'x-csrf-token':bootstrap.csrf_token,'content-type':'application/json'},
      ...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {status:result.status,data:await result.json()};
  };
  await app.store.pool.query(`INSERT INTO questions(id,kind,sort_order,enabled,subject,definition)
    VALUES ('reflection_note','base',150,TRUE,'patient',$1)`,[{type:'text',q:'최근 관찰한 내용을 들려주세요.',sec:'관찰',required:true}]);
  const owner=(await app.store.browser(cookie.slice(15))).id;
  const state=answerIntake(createIntake(await app.store.questionSet()),{question_id:'name',text:'합성 친구'});
  assert.equal(currentView(state).question.id,'reflection_note');
  const row=await app.store.createIntake(owner,state);
  const stored=async()=>{
    const current=(await app.store.pool.query('SELECT revision,content,owner FROM intakes WHERE id=$1',[row.id])).rows[0];
    return {...current,state:app.store.open(current.content,`${current.owner}:intake:${row.id}`)};
  };
  return {...app,request,row,stored};
}

test('staged and combined HTTP answers preserve the same next prompt, source and stored memory', {skip:!databaseUrl},async t=>{
  const results=[];
  for(const mode of ['staged','combined']) {
    const model=modelFixture(mode),f=await fixture(t,model.gateway);
    const response=await f.request(`/api/intakes/${f.row.id}/answers`,'POST',{revision:0,question_id:'reflection_note',text:source});
    assert.equal(response.status,200,JSON.stringify(response.data));
    assert.equal(response.data.question.id,'want');assert.equal(response.data.revision,2);
    assert.equal(response.data.model_pending,undefined);
    const context=(await f.request(`/api/intakes/${f.row.id}/context`)).data.context,current=await f.stored();
    assert.equal(context.patient.fields.reflection_note.rawText,source);
    assert.equal(current.state.modelPending,undefined);
    assert.equal(current.state.agentMemory.facts.find(item=>item.question_id==='reflection_note').quote,source);
    assert.equal(current.state.agentRelationshipMemory.patient[0].evidence[0].quote,source);
    assert.equal(current.state.agentStateExecution.reviewed,true);
    assert.equal(current.content.includes(source),false);
    results.push({question:response.data.question,log:response.data.log,source:context.patient.fields.reflection_note,
      patient_state:current.state.agentMemory,relationship_memory:current.state.agentRelationshipMemory});
    assert.equal(model.stages.length,mode==='combined'?3:5);
  }
  assert.deepEqual(results[0],results[1]);
});

test('combined reviewer failure retains pending source and prompt; retry commits exactly once', {skip:!databaseUrl},async t=>{
  let failReview=true;
  const model=modelFixture('combined',input=>input.stage==='turn_review'&&failReview?new Response('{}',{status:400}):null);
  const f=await fixture(t,model.gateway),path=`/api/intakes/${f.row.id}`,input={revision:0,question_id:'reflection_note',text:source};
  const failed=await f.request(path+'/answers','POST',input);
  assert.equal(failed.status,502);assert.equal(failed.data.error.code,'MODEL_UPSTREAM_ERROR');
  const pending=(await f.request(path)).data,current=await f.stored();
  assert.equal(pending.question.id,'reflection_note');assert.equal(pending.model_pending,true);assert.equal(pending.revision,1);
  assert.equal(pending.pending_answer.text,source);assert.equal(current.state.agentMemory,undefined);
  assert.equal((await f.request(path+'/context')).data.context.patient.fields.reflection_note.rawText,source);
  failReview=false;
  const completed=await f.request(path+'/answers','POST',input);
  assert.equal(completed.status,200);assert.equal(completed.data.question.id,'want');assert.equal(completed.data.revision,2);
  assert.equal(completed.data.model_pending,undefined);
  assert.equal(completed.data.log.filter(item=>item.who==='me'&&item.text===source).length,1);
  assert.deepEqual(model.stages,['turn_draft','turn_review','turn_draft','turn_review','safety_review']);
  const history=await f.store.pool.query('SELECT revision,reason FROM patient_state_revisions WHERE intake_id=$1 ORDER BY revision',[f.row.id]);
  assert.deepEqual(history.rows,[{revision:0,reason:'created'},{revision:1,reason:'user_answer'},{revision:2,reason:'model_update'}]);
  assert.equal((await f.request(path+'/answers','POST',input)).status,409);
});

test('back during the second combined call invalidates its late reviewed state', {skip:!databaseUrl},async t=>{
  let entered,release;
  const reviewing=new Promise(resolve=>{entered=resolve;}),released=new Promise(resolve=>{release=resolve;});
  const model=modelFixture('combined',async input=>{if(input.stage==='turn_review'){entered();await released;}});
  const f=await fixture(t,model.gateway),path=`/api/intakes/${f.row.id}`;
  const answer=f.request(path+'/answers','POST',{revision:0,question_id:'reflection_note',text:source});
  await reviewing;let correction;
  try {correction=await f.request(path+'/back','POST',{revision:1});}
  finally {release();}
  const late=await answer;
  assert.equal(correction.status,200);assert.equal(late.status,409);assert.equal(late.data.error.code,'REVISION_CONFLICT');
  const current=await f.stored(),context=(await f.request(path+'/context')).data.context;
  assert.equal(current.revision,2);assert.equal(current.state.agentMemory,undefined);
  assert.equal(current.state.agentRelationshipMemory,undefined);assert.equal(current.state.modelPending,undefined);
  assert.equal(context.patient.fields.reflection_note.status,'not_asked');assert.equal(context.agent_state,null);
  assert.deepEqual(model.stages,['turn_draft','turn_review']);
});
