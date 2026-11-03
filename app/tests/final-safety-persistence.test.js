import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/server.js';
import { createIntake, currentView, answerIntake, applyModelUpdate, buildContext } from '../src/intake.js';
import { canonicalPatientState, safetySnapshotFingerprint } from '../src/relationship-agent.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const danger='민서가 지금 다른 사람을 때리고 있어요. 폭력이 계속되고 있어요.';
const negation='앞서 말한 폭력은 연극 대사였어요. 실제 폭력이나 현재 위험은 없어요.';
const guide={top:'통합',script:'합성 검증 안내입니다.',doList:['안전한 곳에서 도움을 요청하세요.'],avoid:['혼자 개입하지 마세요.'],next:'도움을 요청하세요.',care:{feel:'자신의 안전도 살펴보세요.',tips:['안전한 거리를 두세요.']}};

function readyState(){
  let state=createIntake();
  for(let index=0;index<8;index++){
    const question=currentView(state).question;
    const answer=question.id==='name'?{text:'민서'}:question.id==='want'?{text:'걱정된다는 마음을 전하고 싶어요.'}
      :question.id==='rel'?{selected:[4]}:question.id==='mood'?{selected:[],custom:danger}:{selected:[0]};
    state=answerIntake(state,{question_id:question.id,follow_up:!!question.follow_up,...answer});
    if(question.id==='mood')break;
  }
  const context=buildContext(state),ref={subject:'patient',question_id:'mood',quote:danger};
  const memory=canonicalPatientState({summary:'합성 보고',facts:[{...ref,interpretation:'이용자 보고',certainty:'reported'}],unknowns:[],user_goal:'걱정된다는 마음을 전하고 싶어요.'},context);
  return applyModelUpdate(state,{patient_state:memory,name_index:{alias:'민서',source_question_id:'name',quote:'민서'},question_plan:{skip:[]},
    safety_signal:{urgent:true,evidence:[ref],review:{basis:'current_physical_danger',reason:'현재 폭력 보고'}},finish_early:true});
}

for(const kind of ['current_approval','current_nonurgent','legacy_approval','corrected_legacy_approval']){
  test(`final generation restores and persists safety from saved intake: ${kind}`,{skip:!databaseUrl},async t=>{
    const admin=new pg.Pool({connectionString:databaseUrl}),schema='final_safety_'+randomBytes(8).toString('hex');
    await admin.query(`CREATE SCHEMA ${schema}`);
    let observed;
    const urgent=!['current_nonurgent','corrected_legacy_approval'].includes(kind);
    const gateway={protocol:'relationship_agent',model:'synthetic-boundary-test',respond:async context=>{
      observed=context;
      if(kind==='current_approval'||kind==='current_nonurgent')assert.equal(context.safety_signal.urgent,urgent);
      else {assert.equal(context.safety_review_required,true);assert.equal(context.safety_signal,undefined);}
      const signal={urgent,evidence:urgent?[{subject:'patient',question_id:'mood',quote:danger}]:[],
        review:{basis:urgent?'current_physical_danger':'negated',reason:'합성 독립 검토 결과'},source_snapshot:safetySnapshotFingerprint(context)};
      return {patient_state:{summary:'합성 검토 결과',facts:[],unknowns:[],user_goal:''},name_index:context.name_index,guide,
        assessment:{safety:urgent},agent:{reviewed:true,safety_signal:signal}};
    }};
    const app=await createApp({databaseUrl,schema,key:randomBytes(32),gateway,referralProvider:null});
    t.after(async()=>{await app.shutdown();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${app.server.address().port}`;
    const bootstrap=await fetch(base+'/api/bootstrap'),cookie=bootstrap.headers.get('set-cookie').split(';')[0],data=await bootstrap.json();
    const owner=await app.store.browser(cookie.slice('malssi_session='.length));
    const state=readyState();
    if(kind==='legacy_approval'||kind==='corrected_legacy_approval')delete state.safetySignal.source_snapshot;
    if(kind==='current_nonurgent'||kind==='corrected_legacy_approval')Object.assign(state.ans.mood,{text:negation,rawText:negation,custom:negation});
    if(kind==='current_nonurgent')state.safetySignal={urgent:false,evidence:[{subject:'patient',question_id:'mood',quote:negation}],
      review:{basis:'negated',reason:'현재 원문의 정정 보고'},source_snapshot:safetySnapshotFingerprint(buildContext(state))};
    const row=await app.store.createIntake(owner.id,state);
    // Simulate the cached context written before the safety envelope existed.
    const oldContext=buildContext(state);delete oldContext.safety_signal;delete oldContext.safety_review_required;
    await app.store.pool.query('UPDATE patient_states SET content=$1 WHERE intake_id=$2',[
      app.store.seal(oldContext,`${owner.id}:patient:${row.id}:${row.revision}`),row.id]);
    const response=await fetch(`${base}/api/intakes/${row.id}/result`,{method:'POST',headers:{cookie,'x-csrf-token':data.csrf_token,'content-type':'application/json'},body:JSON.stringify({revision:row.revision})});
    const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));
    assert.ok(observed);assert.equal(result.record.profile.safety,urgent);
    const saved=await app.store.intake(owner.id,row.id);
    assert.equal(saved.state.safetySignal.urgent,urgent);
    assert.equal(saved.state.safetySignal.source_snapshot,safetySnapshotFingerprint(buildContext(saved.state)));
    const restored=await(await fetch(`${base}/api/records/${result.record.id}`,{headers:{cookie}})).json();
    assert.equal(restored.record.profile.safety,urgent);
    assert.equal(restored.record.context.safety_signal.urgent,urgent);
    assert.equal(restored.record.context.safety_signal.review.basis,urgent?'current_physical_danger':'negated');
    assert.equal(restored.record.context.safety_review_required,undefined);
  });
}
