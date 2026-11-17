import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createApp} from '../src/server.js';
import {contextGoal} from '../src/agent-state.js';
import {runRelationshipAgent,safetySources,relationshipQuestionRequest,safetyReviewRequest,validateSafetyReview} from '../src/relationship-agent.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const danger='합성 상황에서 현재 위험한 행동이 계속되고 있어요.';
const guide={top:'통합',script:'합성 검증 안내입니다.',doList:['안전한 곳에서 도움을 요청하세요.'],avoid:['혼자 개입하지 마세요.'],next:'도움을 요청하세요.',care:{feel:'자신의 안전도 살펴보세요.',tips:['안전한 거리를 두세요.']}};

for(const stopped of [false,true])for(const urgent of [false,true])test(`provisional urgent HTTP answer resolves before record persistence (stop=${stopped}, urgent=${urgent})`,{skip:!databaseUrl},async t=>{
  const schema='single_urgent_'+randomUUID().replaceAll('-',''),admin=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});
  await admin.query(`CREATE SCHEMA ${schema}`);
  let answerCalls=0,resultCalls=0;
  const gateway={protocol:'relationship_agent',model:'synthetic-single-call-safety',async updateState(context){
    answerCalls++;
    const source=safetySources(context).find(x=>x.subject==='supporter'&&x.question_id==='q3_01');
    const ref={subject:source.subject,question_id:source.question_id,quote:source.components[0].text};
    return {name_index:null,patient_state:{summary:'합성 원문 보고',facts:stopped?[]:[{...ref,interpretation:'이용자의 보고',certainty:'reported'}],unknowns:[],user_goal:contextGoal(context)},
      question_plan:{skip:[]},finish_early:true,state_agent:{mode:'single_call',reviewed:false,stages:['turn_draft']},safety_signal:{urgent:true,evidence:[ref]}};
  },async respond(context,memory){
    resultCalls++;
    assert.equal(context.safety_signal,undefined);assert.equal(context.safety_review_pending,true);assert.equal(context.safety_review_required,true);
    const verdict={basis:urgent?'current_physical_danger':'unclear',reason:'합성 독립 검토 결과',evidence_ids:urgent?[safetySources(context).find(x=>x.subject==='supporter'&&x.question_id==='q3_01').id]:[]};
    if(stopped&&!urgent) {
      return runRelationshipAgent({async agentComplete(stage,prompt,data,schema,operation,validate){
        assert.equal(stage,'safety_review_final','Stopped nonurgent review must not generate a guide');return validate(verdict);
      }},context,memory,null,{});
    }
    const request=safetyReviewRequest(relationshipQuestionRequest(context),{safety_signal:{urgent:false,evidence:[]}});
    const signal=validateSafetyReview(verdict,context,request);
    return {patient_state:memory,name_index:null,assessment:{safety:urgent},guide,agent:{reviewed:true,safety_signal:signal}};
  }};
  const app=await createApp({databaseUrl,schema,key:randomBytes(32),gateway,referralProvider:null});
  t.after(async()=>{await app.shutdown();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const response=await fetch(base+'/api/bootstrap'),bootstrap=await response.json();
  const cookie=response.headers.get('set-cookie').split(';')[0];
  const headers={cookie,'x-csrf-token':bootstrap.csrf_token,'content-type':'application/json'};
  const request=async(path,body)=>{const r=await fetch(base+path,{method:'POST',headers,body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
  const owner=await app.store.browser(cookie.slice('malssi_session='.length));
  const created=await request('/api/intakes',{conversation_epoch:bootstrap.conversation_epoch});assert.equal(created.status,201);
  const v=created.data;
  const answered=await request(`/api/intakes/${v.id}/answers`,{revision:v.revision,question_id:v.question.id,instance_id:v.question.instance_id,
    response_event:stopped?'stop':'answered',...(stopped?{text:danger}:{custom:danger})});
  assert.equal(answered.status,200,JSON.stringify(answered.data));assert.equal(answerCalls,1);
  assert.equal(answered.data.status,'ready');assert.equal(answered.data.safety_urgent,false);assert.equal(answered.data.safety_review_pending,true);
  const before=await app.store.intake(owner.id,v.id);assert.equal(before.state.safetySignal,undefined);
  assert.equal(before.state.safetyReviewPending.urgent,true);
  const result=await request(`/api/intakes/${v.id}/result`,{revision:answered.data.revision});
  assert.equal(resultCalls,1);assert.equal(result.status,stopped&&!urgent?409:200,JSON.stringify(result.data));
  const after=await app.store.intake(owner.id,v.id);
  assert.equal(after.state.safetyReviewPending,undefined);assert.equal(after.state.safetySignal.urgent,urgent);
  const {context}=await app.store.context(owner.id,v.id);
  assert.equal(context.safety_signal.urgent,urgent);assert.equal(context.safety_review_required,undefined);
  const count=await app.store.pool.query('SELECT count(*) AS count FROM records WHERE intake_id=$1',[v.id]);
  assert.equal(Number(count.rows[0].count),stopped&&!urgent?0:1);
  if(stopped&&!urgent){
    assert.equal(result.data.error.code,'INTAKE_STOPPED');
    const again=await request(`/api/intakes/${v.id}/result`,{revision:after.revision});
    assert.equal(again.status,409);assert.equal(resultCalls,1,'Persisted nonurgent stopped verdict must not re-run the model');
  } else {
    assert.equal(result.data.record.profile.safety,urgent);
    const saved=await(await fetch(`${base}/api/records/${result.data.record.id}`,{headers})).json();
    assert.deepEqual(saved.record,result.data.record);assert.equal(saved.record.context.safety_signal.urgent,urgent);
  }
});
