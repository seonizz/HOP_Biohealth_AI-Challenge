import test from 'node:test';
import assert from 'node:assert/strict';
import {createIntake,currentView,answerIntake,applyModelUpdate,buildContext} from '../src/intake.js';
import {agentContext,canonicalPatientState,currentApprovedSafety,currentReviewedSafety,runRelationshipAgent,
  safetySnapshotFingerprint,safetySources,urgentGuideActions,validateSchema} from '../src/relationship-agent.js';

const historical='두 달 전에 위험한 행동을 했다고 들었고 지금 상황은 확인하지 못했어요.';
const current='지금 다른 사람을 때리는 행동이 계속되고 있어요.';
function intakeWithReview(basis='past_only') {
  let state=createIntake();
  for(let index=0;index<8;index++) {
    const question=currentView(state).question;
    const answer=question.id==='name'?{text:'서윤'}:question.id==='want'?{text:'걱정된다는 말을 전하고 싶어요.'}
      :question.id==='rel'?{selected:[4]}:question.id==='mood'?{selected:[],custom:historical}:{selected:[0]};
    state=answerIntake(state,{question_id:question.id,follow_up:!!question.follow_up,...answer});
    if(question.id==='mood')break;
  }
  const context=buildContext(state),ref={subject:'patient',question_id:'mood',quote:historical};
  const memory=canonicalPatientState({summary:'합성 보고',facts:[{...ref,interpretation:'이용자의 전언',certainty:'reported'}],unknowns:[],user_goal:'걱정된다는 말을 전하고 싶어요.'},context);
  return applyModelUpdate(state,{patient_state:memory,name_index:{alias:'서윤',source_question_id:'name',quote:'서윤'},question_plan:{skip:[]},
    safety_signal:{urgent:false,evidence:[ref],review:{basis,reason:'현재 즉각 위험은 원문에서 확인되지 않았습니다.'}}});
}

// Exercise the complete final analysis, independent reviews, card reuse and
// final-detail contract with synthetic model responses only.
async function finalProbe(state,{reviewBasis,analysisUrgent=true,expectedUrgent=false}={}) {
  const context=buildContext(state),stages=[],inputs=[];
  const ref={subject:'patient',question_id:'mood',quote:context.patient.fields.mood.rawText};
  const memory=canonicalPatientState({summary:'합성 현재 원문',facts:[{...ref,interpretation:'전언',certainty:'reported'}],unknowns:[],user_goal:'걱정된다는 말을 전하고 싶어요.'},context);
  const guide={top:'통합',script:'서윤아, 네 이야기를 듣고 싶어. 지금 이야기할 여유가 있으면 알려 줄래? 편한 때 말해도 괜찮아.',
    doList:['편한 시간을 물어보세요.'],avoid:['피할 말·행동: 재촉하기. 이유: 선택할 여유가 필요합니다. 대신 편한 시간을 물어보세요.'],
    next:'다음 대화 시간을 함께 정해 보세요.',care:{feel:'자신의 여유도 살펴보세요.',tips:['잠시 쉬어 보세요.']}};
  if(expectedUrgent) {
    const actions=urgentGuideActions(context.name_index);
    Object.assign(guide,actions,{care:{...guide.care,...actions.care}});
  }
  const gateway={reuseFinalDraft:true,skipFinalExtras:false,async agentComplete(stage,prompt,data,schema,operation,validate) {
    stages.push(stage);inputs.push({stage,data:structuredClone(data)});let output;
    if(stage==='safety_review_final')output={basis:reviewBasis,reason:'변경된 전체 원문을 독립적으로 대조했습니다.',evidence_ids:[safetySources(context).find(source=>source.question_id==='mood').id]};
    else if(stage==='relationship_analysis')output={observations:{patient:[ref],supporter:[]},
      relationship:{label:'친구',supporter_role:'친구',dynamics:[],strengths:[],boundaries:[]},unknowns:[],
      ...(schema.properties.safety?{safety:{urgent:analysisUrgent,evidence_ids:[safetySources(context).find(source=>source.question_id==='mood').id]}}:{})};
    else if(stage==='communication_plan')output={voice:'친구가 친구에게 건네는 말',opening_evidence:[ref],user_intent:'걱정을 전하고 싶어요.',
      patient_choice:'편한 때 말해 주세요.',supporter_care:['자신의 여유도 살펴보세요.'],avoid_patterns:['재촉하지 않기'],next_step:'다음 대화 시간을 정하기'};
    else if(stage==='guide_write')output={guide,assessment:{safety:expectedUrgent}};
    else if(stage==='guide_quality')output={improvements:[]};
    else if(stage==='speech_detail')output={opening_end:1,listening_end:2,
      ...Object.fromEntries(['opening','listening','offer'].map(key=>[key,{why:'보고한 상황을 바탕으로 이야기를 듣는 제안입니다.',evidence:[ref]}]))};
    else if(stage.includes('review'))output={approved:true,issues:[],...(schema.properties.audits?{audits:(data.claims??[]).map(claim=>({id:claim.id,
      verdict:claim.claim_kind==='avoidance_guidance'?'sound_avoidance':claim.claim_kind==='guidance'?'sound_guidance':'supported',reason:'합성 원문과 대조했습니다.'}))}:{})};
    else throw new Error('Unexpected synthetic stage '+stage);
    validateSchema(output,schema);
    return validate(output);
  }};
  const result=await runRelationshipAgent(gateway,context,memory,context.name_index,{});
  return {context,result,stages,inputs};
}

test('same-source nonurgent review is restored without regeneration and all final reviews still run',async()=>{
  const state=intakeWithReview(),context=buildContext(state),snapshot=structuredClone(state.ans);
  assert.equal(context.safety_signal.urgent,false);
  assert.equal(currentApprovedSafety(context),null);
  assert.deepEqual(agentContext(context).reviewed_safety,state.safetySignal);
  const {result,stages,inputs}=await finalProbe(state);
  assert.equal(result.relationship_analysis.safety.urgent,false);
  assert.equal(result.payload.assessment.safety,false);
  assert.deepEqual(result.agent.safety_signal,state.safetySignal);
  assert.equal(result.agent.safety_signal.review.basis,'past_only');
  assert.equal(stages.includes('safety_review_final'),false);
  for(const stage of ['analysis_review','plan_review','guide_quality','guide_review','speech_detail_review'])assert.ok(stages.includes(stage),stage);
  assert.equal(result.agent.reviewed,true);assert.equal(result.agent.quality_reviewed,true);
  assert.ok(result.conversation_detail);
  assert.equal(inputs.find(input=>input.stage==='guide_write').data.analysis.safety.urgent,false);
  const saved=applyModelUpdate(state,{...result.payload,question_plan:{skip:[]},safety_signal:result.agent.safety_signal});
  assert.deepEqual(saved.ans,snapshot);
  assert.deepEqual(buildContext(saved).safety_signal,state.safetySignal);
});

test('changed sources require independent safety review and may escalate despite the old nonurgent verdict',async()=>{
  const state=intakeWithReview();
  Object.assign(state.ans.mood,{text:current,rawText:current,custom:current});
  const context=buildContext(state);
  assert.equal(context.safety_signal,undefined);assert.equal(context.safety_review_required,true);
  const {result,stages}=await finalProbe(state,{reviewBasis:'current_physical_danger',analysisUrgent:false,expectedUrgent:true});
  assert.equal(stages[0],'safety_review_final');assert.equal(result.payload.assessment.safety,true);
  assert.equal(result.agent.safety_signal.review.basis,'current_physical_danger');
  assert.equal(result.agent.safety_signal.source_snapshot,safetySnapshotFingerprint(context));
  assert.equal(result.agent.safety_guidance_version,'immediate-help-v1');
  assert.ok(result.agent.safety_signal.evidence.some(item=>item.quote===current));
  assert.equal(result.conversation_detail,undefined);
});

test('unbound legacy nonurgent records remain readable but cannot be treated as reviewed current input',async()=>{
  const state=intakeWithReview();delete state.safetySignal.source_snapshot;
  const context=buildContext(state);
  assert.equal(context.safety_signal,undefined);assert.equal(context.safety_review_required,true);
  const {result,stages}=await finalProbe(state,{reviewBasis:'unclear'});
  assert.equal(stages[0],'safety_review_final');
  assert.equal(result.agent.safety_signal.urgent,false);
  assert.equal(result.agent.safety_signal.review.basis,'unclear');
});

test('review basis, decision and complete source fingerprint must agree before either verdict is reused',()=>{
  const context=buildContext(intakeWithReview());
  for(const basis of ['distress_without_immediate_danger','negated','past_only','unclear']) {
    const signal={...context.safety_signal,review:{basis,reason:'합성 분류 사유'}};
    assert.equal(currentReviewedSafety({...context,safety_signal:signal}).urgent,false);
  }
  for(const mutate of [signal=>signal.urgent=true,signal=>signal.review.basis='current_physical_danger',
    signal=>signal.review.basis='safe',signal=>signal.source_snapshot='old',signal=>signal.review.reason='']) {
    const signal=structuredClone(context.safety_signal);mutate(signal);
    assert.throws(()=>currentReviewedSafety({...context,safety_signal:signal}),{code:'MODEL_INVALID_RESPONSE'});
  }
});
