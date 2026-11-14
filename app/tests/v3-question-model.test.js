import test from 'node:test';
import assert from 'node:assert/strict';
import { validateQuestionPlan, validatePatientState } from '../src/agent-state.js';
import { modelResponseFormat } from '../src/model-schema.js';
import { relationshipQuestionRequest, validateRelationshipQuestions, questionReviewRequest, applyQuestionReview,
  canonicalPatientState, agentContext, safetySources, safetyReviewRequest, validateSafetyReview,
  relationshipStateRequest, validateEvidence, validateV3Clarification, runRelationshipAgent, urgentGuideActions } from '../src/relationship-agent.js';
import { runCombinedRelationshipState } from '../src/relationship-turn.js';
import { ModelGateway } from '../src/model.js';

const field=(id,text,status='answered',revision=1)=>({id,question:id,text,rawText:text,custom:'',status,source_revision:revision});
const context=()=>{
  const goal=field('q3_01','지금은 이유나 다른 시간을 덧붙이지 않고 거절할 말만 정리하고 싶어요.');
  return {bundle_id:'malssi-intake-3.0.0-rc1',question_policy:{minimum_answer_count:0},
    patient:{fields:{q3_02:field('q3_02','친구'),q3_03:field('q3_03','🙂 내일 찾아가자고 말했어요.', 'answered',3)}},
    supporter:{fields:{q3_01:goal,q3_05:field('q3_05','제가 물었고 상대는 아직 모르겠다고 답했어요.','answered',4)}},
    user_goal:{message:goal},answered_count:1,adaptive_questions:true,
    question_candidates:[{id:'q3_08',subject:'supporter',question:'가능한 도움은 무엇인가요?',required:false,noSkip:false}],
    clarification_available:true,clarification_candidates:[],
    clarification_axes:{execution:{text:'표시된 「…」의 한 행동은 어느 상태인가요?'}},
    questionnaire_bundle:{tasks:{tasks:[]}},latest_answer:{subject:'supporter',question_id:'q3_05'}};
};
const binding=(ctx=context())=>({source_question_id:'q3_03',source_revision:3,component:'rawText',event_id:'event_visit',
  quote:'내일 찾아가자고 말했어요.',quote_start:2,quote_end:Array.from(ctx.patient.fields.q3_03.rawText).length,
  axis:'execution',role:null,agreement_item_id:null});
const proposal=({skip=[],clarify=[]}={})=>({skip,clarify,safety:{urgent:false,evidence_ids:[]}});
const skip=ctx=>({question_id:'q3_08',reason:'not_needed',explanation:'거절문만 요청하므로 대안 시간이나 제공 가능한 도움을 수집할 필요가 없습니다.',
  evidence:[{subject:'user_goal',question_id:'q3_01',quote:ctx.user_goal.message.rawText}]});

test('v3 allows grounded optional skipping from the first answer and includes the final candidate',()=>{
  const ctx=context(),request=relationshipQuestionRequest(ctx),decision=skip(ctx);
  assert.equal(request.data.question_candidates.at(-1).id,'q3_08');
  assert.deepEqual(validateQuestionPlan({skip:[decision]},ctx),{skip:[decision]});
  assert.deepEqual(validateRelationshipQuestions(proposal({skip:[decision]}),ctx,request).question_plan.skip,[decision]);
  assert.match(request.prompt,/최소 답변 수는 0/);
  assert.doesNotMatch(request.prompt,/answered_count>=5/);
  const schema=modelResponseFormat(ctx).json_schema.schema.properties.question_plan;
  assert.ok(schema.properties.skip.items.anyOf.some(v=>v.properties.reason.const==='not_needed'));
  decision.evidence[0].quote='없는 목적';
  assert.throws(()=>validateQuestionPlan({skip:[decision]},ctx),{code:'MODEL_INVALID_RESPONSE'});
});

test('v3 cross-bucket coverage preserves provenance and never fills an unanswered field',()=>{
  const ctx=context();ctx.patient.fields.q3_07=field('q3_07','','not_asked');
  ctx.question_candidates=[{id:'q3_07',subject:'patient',question:'상대가 원한다고 말한 도움은 무엇인가요?',required:false,noSkip:false}];
  ctx.supporter.fields.q3_01=field('q3_01','상대가 조언은 싫고 이야기를 들어 달라고 말했어요.');
  const decision={question_id:'q3_07',reason:'already_covered',explanation:'상대가 직접 전한 도움 선호가 목적 답변에 있어요.',
    evidence:[{subject:'supporter',question_id:'q3_01',quote:ctx.supporter.fields.q3_01.text}]};
  assert.equal(validateRelationshipQuestions(proposal({skip:[decision]}),ctx,relationshipQuestionRequest(ctx)).question_plan.skip.length,1);
  assert.equal(ctx.patient.fields.q3_07.status,'not_asked');
  const state=canonicalPatientState({summary:'임시',facts:[{...decision.evidence[0],certainty:'reported',interpretation:'임시'}],unknowns:[],user_goal:ctx.user_goal.message.text},ctx);
  assert.match(state.facts[0].interpretation,/이 문항에서/);
  assert.doesNotMatch(state.facts[0].interpretation,/자신의 상황에 관해/);
  assert.equal(state.facts[0].subject,'supporter');
});

test('v3 Q10 binds a Unicode source slice and survives only independent approval',()=>{
  const ctx=context(),request=relationshipQuestionRequest(ctx),bound=binding(ctx);
  const decision=validateRelationshipQuestions(proposal({clarify:[bound]}),ctx,request);
  assert.deepEqual(decision.clarification,bound);
  const review=questionReviewRequest(decision,request);
  assert.equal(review.claims[0].id,'clarify.q3_10');
  assert.deepEqual(review.claims[0].binding,bound);
  assert.equal(review.claims[0].evidence[0].subject,'patient');
  for(const verdict of ['supported','unsupported','plausible']){
    const result=applyQuestionReview({audits:[{id:'clarify.q3_10',verdict,reason:'원문 사건과 필요한 축을 독립적으로 대조했습니다.'}]},decision,review);
    assert.deepEqual(result.clarification,verdict==='supported'?bound:null);
  }
  for(const edit of [value=>value.source_revision++,value=>value.quote_start++,value=>value.quote_end--,
    value=>value.component='custom',value=>value.axis='actor',value=>value.axis='agreement',value=>value.role='actor',
    value=>value.quote_start='2',value=>value.quote_start=2.1,value=>value.quote_end=-1]){
    const invalid=structuredClone(bound);edit(invalid);
    assert.throws(()=>validateRelationshipQuestions(proposal({clarify:[invalid]}),ctx,request),{code:'MODEL_INVALID_RESPONSE'});
  }
  const changed=structuredClone(ctx);changed.patient.fields.q3_03.rawText='정정된 다른 사건입니다.';
  assert.throws(()=>validateV3Clarification(bound,changed),{code:'MODEL_INVALID_RESPONSE'});
});

test('v3 Q10 is unavailable after use or when the source is unknown/refused/stopped',()=>{
  for(const change of [ctx=>ctx.clarification_available=false,...['unknown','refused','stopped'].map(status=>ctx=>ctx.patient.fields.q3_03.status=status)]){
    const ctx=context(),bound=binding(ctx);change(ctx);
    assert.throws(()=>validateRelationshipQuestions(proposal({clarify:[bound]}),ctx,relationshipQuestionRequest(ctx)),{code:'MODEL_INVALID_RESPONSE'});
  }
});

for(const status of ['refused','stopped'])test(`v3 ${status} text remains safety-only and supports independent current-source review`,()=>{
  const ctx=context(),text='이 질문에는 답하지 않을게요. 방금 상대가 저를 때리려고 달려오고 있어요.';
  ctx.patient.fields.q3_03={...field('q3_03',text,status,5),ordinary_usable:false};
  const ref={subject:'patient',question_id:'q3_03',quote:text};
  assert.throws(()=>validateEvidence(ref,ctx),{code:'MODEL_INVALID_RESPONSE'});
  assert.throws(()=>validatePatientState({summary:'원문',facts:[{...ref,certainty:'reported',interpretation:'사건'}],unknowns:[],user_goal:ctx.user_goal.message.text},ctx),{code:'MODEL_INVALID_RESPONSE'});
  const raw=agentContext(ctx);
  assert.deepEqual(raw.patient.find(row=>row.question_id==='q3_03').answers,[]);
  assert.ok(raw.safety_sources.some(source=>source.question_id==='q3_03'&&source.components.some(component=>component.text===text)));
  assert.equal(relationshipStateRequest(ctx,null).retrieval.documents.some(row=>row.question_id==='q3_03'),false);
  const request=relationshipQuestionRequest(ctx),decision=validateRelationshipQuestions(proposal(),ctx,request);
  const safety=safetyReviewRequest(request,decision),source=safetySources(ctx).find(row=>row.subject==='patient'&&row.question_id==='q3_03');
  assert.ok(safety.data.safety_sources.some(row=>row.id===source.id));
  const reviewed=validateSafetyReview({basis:'current_physical_danger',reason:'현재 직접 보고한 신체 위험입니다.',evidence_ids:[source.id]},ctx,safety);
  assert.equal(reviewed.urgent,true);
  assert.ok(reviewed.evidence.some(row=>row.quote===text));
});

test('combined v3 turn carries a bound Q10 object through independent reviews',async()=>{
  const ctx=context(),bound=binding(ctx),calls=[];
  const ref={subject:'supporter',question_id:'q3_05',quote:ctx.supporter.fields.q3_05.rawText};
  const model={async agentComplete(stage,prompt,data,schema,operation,validate){
    calls.push({stage,prompt,data});
    const audits=claims=>claims.map(claim=>({id:claim.id,verdict:claim.certainty==='tentative'?'plausible':'supported',reason:'현재 원문 범위와 일치합니다.'}));
    if(stage==='turn_draft')return validate({state:{patient_state:{facts:[{...ref,certainty:'reported'}],unknowns:[]},name_index:null,
      relationship_memory:{patient:[],supporter:[{evidence:[ref],certainty:'reported'}],relationship:[],unknowns:[]}},questions:proposal({clarify:[bound]})});
    if(stage==='turn_review')return validate({state:{approved:true,issues:[],audits:audits(data.review_target.claims)},questions:null,safety:null});
    if(stage==='question_review')return validate({audits:audits(data.claims)});
    if(stage==='safety_review')return validate({basis:'distress_without_immediate_danger',reason:'현재 즉각적인 신체 위험 보고는 없습니다.',evidence_ids:[]});
    assert.fail('Unexpected model stage '+stage);
  }};
  const result=await runCombinedRelationshipState(model,ctx,null,{});
  assert.deepEqual(result.clarification,bound);
  assert.ok(calls.some(call=>call.stage==='question_review'));
  assert.match(calls[0].prompt,/clarification_available=false/);
  assert.doesNotMatch(calls[0].prompt,/clarification_candidates가 비었으면 반드시/);
});

test('v3 refuses incompatible legacy protocols before making any model request',async()=>{
  for(const protocol of ['json_schema','json_prompt']){
    const gateway=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'fixture',protocol,
      fetchImpl:async()=>assert.fail('Incompatible v3 protocol must not make a network request')});
    await assert.rejects(gateway.updateState(context()),{code:'MODEL_PROTOCOL_UNSUPPORTED'});
    await assert.rejects(gateway.respond(context()),{code:'MODEL_PROTOCOL_UNSUPPORTED'});
    assert.doesNotThrow(()=>gateway.requireQuestionnaireProtocol({patient:{fields:{}}}));
  }
});

test('v3 model input preserves the Q10 single-axis assignment and original binding',()=>{
  const ctx=context(),bound=binding(ctx);
  ctx.clarification_state={binding:bound,status:'answered',assignment:{event_id:bound.event_id,axis:'execution',value:'unknown'}};
  const data=agentContext(ctx);
  assert.deepEqual(data.clarification_state,ctx.clarification_state);
  assert.equal(data.source_subject_policy,'input_provenance_not_event_actor');
  assert.equal(data.clarification_state.assignment.actor,undefined);
  assert.equal(data.clarification_state.assignment.agreement,undefined);
});

test('staged v3 model flow preserves Q10 binding and performs independent question review',async()=>{
  const ctx=context(),bound=binding(ctx),stages=[];
  const ref={subject:'supporter',question_id:'q3_05',quote:ctx.supporter.fields.q3_05.rawText};
  const gateway=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'fixture',protocol:'relationship_agent',stateMode:'staged'});
  gateway.agentComplete=async(stage,prompt,data,schema,operation,validate)=>{
    stages.push(stage);
    const audits=(data.claims||[]).map(claim=>({id:claim.id,verdict:'supported',reason:'원문과 확인 범위를 독립적으로 대조했습니다.'}));
    if(stage==='state_observations')return validate({patient_state:{facts:[{...ref,certainty:'reported'}],unknowns:[]},name_index:null});
    if(stage==='relationship_memory')return validate({relationship_memory:{patient:[],supporter:[{evidence:[ref],certainty:'reported'}],relationship:[],unknowns:[]}});
    if(stage==='state_review')return validate({approved:true,issues:[],audits});
    if(stage==='question_plan')return validate(proposal({clarify:[bound]}));
    if(stage==='safety_review')return validate({basis:'distress_without_immediate_danger',reason:'현재 즉각적인 위험의 보고는 없습니다.',evidence_ids:[]});
    if(stage==='question_review')return validate({audits});
    assert.fail('Unexpected stage '+stage);
  };
  const result=await gateway.relationshipState(ctx,null,{});
  assert.deepEqual(result.clarification,bound);
  assert.deepEqual(stages,['state_observations','relationship_memory','state_review','question_plan','safety_review','question_review']);
});

for(const alreadyReviewed of [false,true])test(`v3 final safety retains refused input without promoting it to ordinary observations (reviewed=${alreadyReviewed})`,async()=>{
  const ctx=context(),text='이 질문은 그만할게요. 지금 상대가 저를 때리려고 달려오고 있어요.',stages=[];
  ctx.patient.fields.q3_03={...field('q3_03',text,'refused',5),ordinary_usable:false};
  const source=safetySources(ctx).find(row=>row.subject==='patient'&&row.question_id==='q3_03');
  const review={basis:'current_physical_danger',reason:'현재 신체 위험을 직접 보고했습니다.',evidence_ids:[source.id]};
  if(alreadyReviewed){
    const request=safetyReviewRequest(relationshipQuestionRequest(ctx),{safety_signal:{urgent:false,evidence:[]}});
    ctx.safety_signal=validateSafetyReview(review,ctx,request);
  }
  const ref={subject:'supporter',question_id:'q3_05',quote:ctx.supporter.fields.q3_05.rawText};
  const memory=canonicalPatientState({summary:'원문',facts:[{...ref,certainty:'reported',interpretation:'원문'}],unknowns:[],user_goal:ctx.user_goal.message.text},ctx);
  const actions=urgentGuideActions(null),guide={top:'통합',...actions,care:{...actions.care,feel:'당신의 안전도 소중해요.'}};
  const gateway={skipFinalExtras:true,async agentComplete(stage,prompt,data,schema,operation,validate){
    stages.push(stage);
    if(stage==='safety_review_final')return validate(review);
    if(stage==='relationship_analysis'){
      assert.ok(data.retrieval.documents.some(doc=>doc.question_id==='q3_03'&&doc.retrieved_for.includes('v3_safety_only')));
      assert.equal(schema.properties.observations.properties.patient.items.enum?.some(ref=>ref.question_id==='q3_03')||false,false);
      return validate({observations:{patient:[],supporter:[]},relationship:{label:'친구',supporter_role:'친구',dynamics:[],strengths:[],boundaries:[]},unknowns:[]});
    }
    if(stage==='guide_write')return validate({guide,assessment:{safety:true}});
    if(stage.includes('review'))return validate({approved:true,issues:[],...(schema.properties.audits?{audits:(data.claims||[]).map(claim=>({
      id:claim.id,verdict:claim.claim_kind==='avoidance_guidance'?'sound_avoidance':claim.claim_kind==='guidance'?'sound_guidance':'supported',reason:'고정 안전 안내와 현재 원문을 대조했습니다.'}))}:{})});
    assert.fail('Unexpected stage '+stage);
  }};
  const result=await runRelationshipAgent(gateway,ctx,memory,null,{});
  assert.equal(result.payload.assessment.safety,true);
  assert.equal(result.payload.guide.script,actions.script);
  assert.equal(result.relationship_analysis.observations.patient.length,0);
  assert.ok(result.relationship_analysis.safety.evidence.some(ref=>ref.quote===text));
  assert.equal(stages.includes('safety_review_final'),!alreadyReviewed);
});
