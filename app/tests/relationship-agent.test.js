import {evidenceWireFixture} from './evidence-wire.fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model.js';
import { generationProgress } from '../src/generation-progress.js';
import { modelResponseFormat } from '../src/model-schema.js';
import { auditSchema } from '../src/grounding-audit.js';
import { validateRelationship, validateRelationshipDraft, canonicalRelationship, urgentGuideActions, validatePlan, validateReview, validateSchema, agentContext, validateRelationshipMemory, canonicalPatientState, canonicalRelationshipMemory, canonicalRelationshipState, relationshipStateRequest,groundedEvidenceSchema,relationshipSchema,relationshipDraftSchema,safetySources,speechPermissionQuestions,knownSpeechIssues,avoidCardDraftSchema,canonicalAvoidCard,validateClaimReview,reviewSchema } from '../src/relationship-agent.js';
import { createIntake,answerIntake,applyModelUpdate,buildContext,backIntake,prepareModelAnswer } from '../src/intake.js';
import { GUIDANCE_REVIEW_BOUNDARY, CARD_ROLE_CONTRACT, CARD_ROLES } from '../src/relationship-prompts.js';

const field=(id,text,status='answered')=>({id,text,rawText:text,custom:'',status,question:id});
const context=()=>({patient:{alias:'지민',fields:{name:field('name','지민'),rel:field('rel','자녀'),mood:field('mood','밤에 계획표를 고쳐요')}},
  supporter:{fields:{feeling:field('feeling','무력하고 걱정돼요')}},user_goal:{message:field('want','이해하고 싶어요')},
  relationship_state:relationshipMemory(),question_candidates:[],answered_count:4,name_index:{alias:'지민',source_question_id:'name',quote:'지민'}});
const ref=()=>({subject:'patient',question_id:'mood',quote:'밤에 계획표를 고쳐요'});
const finding=()=>({interpretation:'걱정에 응답하는 방식을 살펴볼 수 있어요.',evidence:[ref()],certainty:'tentative'});
const analysis=()=>({patient_summary:'밤에 계획표를 고친다고 보고했어요.',supporter_summary:'이용자가 무력하고 걱정된다고 보고했어요.',
  relationship:{label:'자녀',supporter_role:'부모',dynamics:[finding()],strengths:[],boundaries:[]},unknowns:['대상자의 도움 의향은 미확인입니다.'],safety:{urgent:false,evidence:[]}});
const relationshipMemory=()=>({patient:[{interpretation:'밤에 계획표를 고친다는 관찰입니다.',evidence:[ref()],certainty:'reported'}],supporter:[],relationship:[],unknowns:[]});
const memory=()=>({summary:'대상자와 이용자의 상황입니다.',facts:[{subject:'patient',question_id:'mood',quote:'밤에 계획표를 고쳐요',interpretation:'이용자가 관찰했습니다.',certainty:'reported'}],unknowns:[],user_goal:'이해하고 싶어요'});
const plan=()=>({voice:'부모가 자녀에게 건네는 말',opening_evidence:[ref()],user_intent:'이해하고 싶어요',patient_choice:'원할 때 이야기해 주세요.',supporter_care:['자신의 휴식도 살펴보세요.'],avoid_patterns:['재촉 대신 허락 구하기'],next_step:'다음 대화 시간을 함께 정하기'});
const avoidExample={avoid_phrase:'재촉하는 말.',reason:'대답할 여유를 남겨야 합니다.',alternative:'편한 시간을 물어보세요.'};
const avoidText='피할 말·행동: 재촉하는 말. 이유: 대답할 여유를 남겨야 합니다. 대신 편한 시간을 물어보세요.';
const causalAvoidExample={avoid_phrase:'“참으려는 마음 때문에 연락을 피하는구나”라고 단정하기.',reason:'속마음을 대신 단정하지 마세요.',alternative:'편한 시간을 물어보세요.'};
const causalAvoidText='피할 말·행동: “참으려는 마음 때문에 연락을 피하는구나”라고 단정하기. 이유: 속마음을 대신 단정하지 마세요. 대신 편한 시간을 물어보세요.';
const avoidFixtures=new Map([[avoidText,avoidExample],[causalAvoidText,causalAvoidExample]]);
// Adapt only explicitly declared valid legacy fixtures at the new wire boundary.
// Arbitrary strings and malformed responses are not inferred into valid roles.
const cardFixture=(value,key)=>key==='avoid'&&Array.isArray(value.avoid)&&value.avoid.every(text=>avoidFixtures.has(text))
  ?{avoid:value.avoid.map(text=>structuredClone(avoidFixtures.get(text)))}:value;
// Existing review scenarios declare canonical outcomes. Translate only their
// known guidance labels at the valid mock wire boundary; malformed-wire
// coverage exercises the production adapter directly in claim-review-roles.
const reviewFixture=(review,claims)=>({...review,audits:review.audits.map(audit=>{
  const claim=claims.find(claim=>claim.id===audit.id),labels=claim?.claim_kind==='avoidance_guidance'
    ?{supported:'sound_avoidance',unsupported:'problem_in_recommended_content',plausible:'unclear'}
    :claim?.claim_kind==='guidance'?{supported:'sound_guidance',unsupported:'problem_in_guidance',plausible:'unclear'}:null;
  return labels&&Object.hasOwn(labels,audit.verdict)?{...audit,verdict:labels[audit.verdict]}:audit;
})});
const guide=()=>({guide:{top:'통합',script:'지민아, 밤에 계획표를 고치는 모습을 봤어. 네 마음을 이해하고 싶어. 지금 이야기해도 괜찮을까?',doList:['편한 시간을 물어보세요.'],avoid:[avoidText],next:'다음 대화 시간을 함께 정하고 자신도 쉬어 보세요.',care:{feel:'무력하고 걱정된 마음을 들려주셨어요.',tips:['잠시 쉬어 보세요.']}},assessment:{safety:false}});
const avoidStoredSchema=()=>({type:'object',properties:{avoid:modelResponseFormat(context(),true).json_schema.schema.properties.guide.properties.avoid},required:['avoid'],additionalProperties:false});
const envelope=payload=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]}));
const draftAnalysis=(value=analysis())=>{
  const {patient_summary,supporter_summary,...draft}=structuredClone(value);
  return {observations:{patient:[ref()],supporter:[{subject:'supporter',question_id:'feeling',quote:'무력하고 걱정돼요'}]},...draft};
};
const canonicalAnalysis=(value,ctx=context())=>canonicalRelationship(draftAnalysis(value),ctx);
const draftState=payload=>{
  const draft=structuredClone(payload);
  delete draft.patient_state.summary;delete draft.patient_state.user_goal;
  for(const fact of draft.patient_state.facts)delete fact.interpretation;
  for(const subject of ['patient','supporter'])for(const item of draft.relationship_memory[subject]) {
    if(item.certainty==='reported')delete item.interpretation;
  }
  return draft;
};
// Existing stored-report fixtures are adapted only at the model response boundary.
const fixtureEnvelope=payload=>{
  const value=payload?.relationship&&Object.hasOwn(payload,'patient_summary')?draftAnalysis(payload)
    :payload?.patient_state&&payload?.relationship_memory?draftState(payload):structuredClone(payload);
  if(value?.relationship&&value?.safety?.evidence?.length===0)value.safety={urgent:value.safety.urgent,evidence_ids:[]};
  return envelope(value);
};
const stateDraft=(ctx=context())=>draftState({patient_state:memory(),name_index:ctx.name_index,relationship_memory:relationshipMemory()});
const riskContext=text=>{
  const ctx=context();ctx.patient.fields.risk=field('risk',text||'지금 자신을 해치겠다고 말하며 위험한 곳에 있어요.');return ctx;
};
const riskAnalysis=(ctx,urgent=true)=>{
  const draft=draftAnalysis();draft.safety={urgent,evidence_ids:[safetySources(ctx).find(row=>row.subject==='patient'&&row.question_id==='risk').id]};return draft;
};
const urgentGuide=name=>{
  const draft=guide(),actions=urgentGuideActions(name);
  return {guide:{...draft.guide,...actions,care:{...draft.guide.care,...actions.care}},assessment:{safety:true}};
};
const assertUrgentSchema=(body,name)=>{
  const properties=body.response_format.json_schema.schema.properties.guide.properties,actions=urgentGuideActions(name);
  for(const key of ['script','doList','avoid','next'])assert.deepEqual(properties[key].enum,[actions[key]]);
  assert.deepEqual(properties.care.properties.tips.enum,[actions.care.tips]);
  assert.equal(Object.hasOwn(properties.top,'enum'),true); // Existing topic enum remains unchanged.
  assert.equal(Object.hasOwn(properties.care.properties.feel,'enum'),false);
};
function gateway(handler,{speechReview,planReview,speechWrite,supportReview,cardWrite,cardReview,speechPart,detailWrite,detailReview,qualityCheck,raw=false}={}) {
  let storedDraft,storedGuide;
  const transportStages=[],transportInputs=[],transportPrompts=[];
  const model=new ModelGateway({baseUrl:'https://example.test/v1',apiKey:'test-only-secret',model:'gemma4:12b',protocol:'relationship_agent',stateMode:'staged',diagnosticLogger:null,fetchImpl:async(_url,request)=>{
    const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);
    transportStages.push(input.stage);transportInputs.push(structuredClone(input));transportPrompts.push(body.messages[0].content);
    if(/^guide_review(?:_|$)/u.test(input.stage))assert.equal(Object.hasOwn(input.data.answers,'prior_relationship_memory'),false,input.stage);
    if(raw)return handler(body);
    // Adapt historical combined-state fixtures at the transport boundary.
    // Dedicated staged-state tests exercise the actual role contracts separately.
    if(input.stage.startsWith('state_observations')) {
      input.stage='state';body.messages.at(-1).content=JSON.stringify(input);
      const response=await handler(body);if(!response.ok)return response;
      const json=await response.clone().json();
      storedDraft=JSON.parse(json.choices[0].message.content);
      return envelope({patient_state:storedDraft.patient_state,name_index:storedDraft.name_index});
    }
    if(input.stage.startsWith('relationship_memory'))return envelope({relationship_memory:storedDraft.relationship_memory});
    if(input.stage.startsWith('guide_quality_check'))return envelope(qualityCheck?qualityCheck(input):{improvements:[]});
    if(input.stage.startsWith('card_')){
      const key=Object.keys(input.output_schema.properties)[0];
      return envelope(cardFixture(cardWrite?await cardWrite(input,request):{[key]:storedGuide[key]},key));
    }
    if(/^speech_(opening|listening|offer)/u.test(input.stage))return envelope(speechPart?await speechPart(input,request):Object.fromEntries(Object.keys(input.output_schema.properties).map(key=>[key,'원문을 확인하고 이야기를 듣고 싶어.'])));
    if(input.stage.startsWith('speech_detail_review'))return envelope(detailReview?detailReview(input):{approved:true,issues:[],audits:input.data.claims.map(claim=>({id:claim.id,verdict:'supported',reason:'원문에 근거한 제안입니다.'}))});
    if(input.stage.startsWith('speech_detail')){
      return envelope(detailWrite?detailWrite(input):{
        opening_end:1,listening_end:input.data.script_units.length-1,
        ...Object.fromEntries(['opening','listening','offer'].map(key=>[key,{why:'보고한 행동을 되짚으며 듣고 싶다는 뜻을 전하는 제안이에요.',evidence:[ref()]}])),
      });
    }
    if(input.stage.startsWith('speech_write'))return envelope(speechWrite?speechWrite(input):{script:storedGuide?.script||guide().guide.script});
    if(input.stage.startsWith('plan_review'))return envelope(planReview?planReview(input):{approved:true,issues:[]});
    if(/^(?:speech|support)_review_card_/u.test(input.stage)){
      const review=cardReview?await cardReview(input,request):{approved:true,issues:[]};
      return envelope(reviewFixture({...review,audits:review.audits??input.data.claims.map(claim=>({id:claim.id,verdict:'supported',reason:'현재 원문과 선택 가능한 제안입니다.'}))},input.data.claims));
    }
    if(input.stage.startsWith('support_review')){
      const review=supportReview?supportReview(input):{approved:true,issues:[]};
      return envelope(reviewFixture({...review,audits:review.audits??input.data.claims.map(claim=>({id:claim.id,verdict:'supported',reason:'이용자의 보고와 일치'}))},input.data.claims));
    }
    if(input.stage.startsWith('speech_review')){
      const review=speechReview?speechReview(input,body):{approved:true,issues:[]};
      return envelope(reviewFixture({...review,audits:review.audits??input.data.claims.map(claim=>({id:claim.id,verdict:'supported',reason:'관찰과 열린 질문입니다.'}))},input.data.claims));
    }
    if(input.stage.startsWith('state_review'))return envelope({approved:true,issues:[],audits:input.data.claims.map(claim=>({id:claim.id,verdict:claim.certainty==='reported'?'supported':'plausible',reason:'합성 원문과 일치해요.'}))});
    const response=await handler(body);
    if(response.ok&&input.stage.startsWith('guide_repair')&&!input.output_schema.properties.guide){
      const reply=await response.clone().json(),value=JSON.parse(reply.choices[0].message.content);
      const key=Object.keys(input.output_schema.properties)[0];
      return envelope(cardFixture(value.guide?{[key]:value.guide[key]}:value,key));
    }
    if(response.ok&&/^guide_(write|refine|repair)/u.test(input.stage)){
      const json=await response.clone().json();storedGuide=JSON.parse(json.choices[0].message.content).guide;
    }
    if(input.stage.startsWith('analysis_review')&&response.ok){
      const json=await response.clone().json(),review=JSON.parse(json.choices[0].message.content);
      review.audits=input.data.claims.map(claim=>({id:claim.id,verdict:claim.certainty==='reported'?'supported':'plausible',reason:'합성 원문과 일치해요.'}));
      return envelope(review);
    }
    if(response.ok&&input.evidence_sources?.locations){
      const json=await response.clone().json();return envelope(evidenceWireFixture(input,JSON.parse(json.choices[0].message.content)));
    }
    return response;
  }});
  model.transportStages=transportStages;model.transportInputs=transportInputs;model.transportPrompts=transportPrompts;
  return model;
}

// State-boundary tests exercise the separate observation and memory wire contracts.
function stateGateway(handler) {
  return gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage.startsWith('state_review'))return envelope({approved:true,issues:[],audits:input.data.claims.map(claim=>({id:claim.id,verdict:'supported',reason:'합성 원문에 근거해요.'}))});
    return handler(body,input);
  },{raw:true});
}
const observationPayload=raw=>({patient_state:raw.patient_state,name_index:raw.name_index});

test('final analysis, quality and critical reviews use the same current evidence and preserve the existing guide contract',async()=>{
  const stages=[];
  const outputs={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}};
  const model=gateway(body=>{
    const input=JSON.parse(body.messages[1].content); stages.push(input.stage);
    assert.equal(input.data.retrieval.method,'conversation_lexical_v1');
    assert.ok(input.data.retrieval.documents.some(row=>row.question_id==='mood'));
    assert.equal(body.model,'gemma4:12b'); assert.equal(body.reasoning_effort,'none');
    assert.equal(requestContainsSecret(input),false);
    if(input.stage==='guide_quality')assert.deepEqual(body.response_format.json_schema.schema.properties.improvements.items.properties.field.enum,['script','doList','avoid','next','care']);
    if(input.stage==='guide_review')assert.deepEqual(body.response_format.json_schema.schema.properties.issues.items.properties.field.enum,['relationship_analysis','script','doList','avoid','next','care','top']);
    assert.equal(Object.hasOwn(input.data,'review_scope'),false);
    return fixtureEnvelope(outputs[input.stage]);
  });
  const result=await model.respond(context(),memory());
  assert.deepEqual(stages,['relationship_analysis','analysis_review','communication_plan','guide_write','guide_quality','guide_review']);
  assert.deepEqual(result.guide,guide().guide);assert.deepEqual(result.relationship_analysis,canonicalAnalysis(analysis()));
  assert.equal(result.agent.reviewed,true);assert.deepEqual(result.patient_state,canonicalPatientState(memory(),context()));
  assert.deepEqual(result.agent.retrieval.stages.map(row=>row.stage).sort(),[...model.transportStages].sort());
  assert.equal(JSON.stringify(result.agent.retrieval).includes('밤에 계획표'),false);
});
const requestContainsSecret=input=>JSON.stringify(input).includes('test-only-secret');

test('one repair is reviewed independently before returning',async()=>{
  const stages=[];
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;stages.push(stage);
    const data={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]},
      guide_review:{approved:false,issues:[{field:'script',reason:'관찰을 연결해 주세요.',repair:'실제 장면을 쓰세요.'}]},
      guide_repair:guide(),guide_review_after_repair:{approved:true,issues:[]}};
    return fixtureEnvelope(data[stage]);
  });
  const result=await model.respond(context(),memory());
  assert.equal(result.agent.reviewed,true);assert.equal(stages.length,8);
});

test('persistent review rejection cannot become a successful guide',async()=>{
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;
    if(stage==='analysis_review')return fixtureEnvelope({approved:true,issues:[]});
    if(stage==='guide_quality')return fixtureEnvelope({improvements:[]});
    if(stage.includes('review'))return fixtureEnvelope({approved:false,issues:[{field:'script',reason:'역할이 다릅니다.',repair:'역할을 바꾸세요.'}]});
    return fixtureEnvelope(['relationship_analysis','analysis_repair'].includes(stage)?analysis():stage==='communication_plan'?plan():guide());
  });
  await assert.rejects(model.respond(context(),memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_review_rejected'});
});

test('fabricated quote, wrong subject, unknown/refused answer and invented relation label fail',()=>{
  for(const mutate of [a=>a.relationship.dynamics[0].evidence[0].quote='없는 원문',
    a=>a.relationship.dynamics[0].evidence[0].subject='supporter',a=>a.relationship.label='배우자']) {
    const value=analysis();mutate(value);assert.throws(()=>validateRelationship(value,context()),{code:'MODEL_INVALID_RESPONSE'});
  }
  for(const status of ['unknown','refused','skipped']){
    const ctx=context();ctx.patient.fields.mood.status=status;
    assert.throws(()=>validateRelationship(analysis(),ctx),{code:'MODEL_INVALID_RESPONSE'});
  }
});

test('corrected current evidence replaces every older quote',()=>{
  const ctx=context();ctx.patient.fields.mood=field('mood','학교에서 연락을 받았어요');
  assert.throws(()=>validateRelationship(analysis(),ctx),{code:'MODEL_INVALID_RESPONSE'});
  assert.throws(()=>validatePlan(plan(),ctx),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(JSON.stringify(agentContext(ctx)).includes('밤에 계획표'),false);
});

test('urgent safety needs exact evidence and reviews cannot claim approval with issues',()=>{
  const value=analysis();value.safety.urgent=true;
  assert.throws(()=>validateRelationship(value,context()),{code:'MODEL_INVALID_RESPONSE'});
  assert.throws(()=>validateReview({approved:true,issues:[{field:'script',reason:'문제',repair:'수정'}]}),{code:'MODEL_INVALID_RESPONSE'});
});

test('unknown or missing relationship cannot silently assign a spouse or gendered role',()=>{
  for(const status of ['unknown','refused','skipped','missing']) {
    const ctx=context();if(status==='missing')delete ctx.patient.fields.rel;else ctx.patient.fields.rel.status=status;
    assert.throws(()=>validateRelationship(analysis(),ctx),{code:'MODEL_INVALID_RESPONSE'});
    const value=analysis();value.relationship.label='확인되지 않음';value.relationship.supporter_role='확인되지 않음';
    assert.deepEqual(validateRelationship(value,ctx),value);
    value.relationship.supporter_role='남편';assert.throws(()=>validateRelationship(value,ctx),{code:'MODEL_INVALID_RESPONSE'});
  }
});

test('safety evidence preserves negation and attribution instead of citing an isolated danger word',()=>{
  const ctx=context();ctx.patient.fields.mood=field('mood','자해 생각은 전혀 없다고 말했어요.');
  const value=analysis();value.relationship.dynamics=[];value.safety={urgent:true,evidence:[{subject:'patient',question_id:'mood',quote:'자해'}]};
  assert.throws(()=>validateRelationship(value,ctx),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_safety_context'});
});

test('analysis review problems fail closed before any guide-only repair',async()=>{
  const stages=[];
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;stages.push(stage);
    if(stage.startsWith('analysis_review'))return fixtureEnvelope({approved:false,issues:[{field:'relationship_analysis',reason:'없는 병력을 단정했습니다.',repair:'원문에 없는 진단을 삭제하세요.'}]});
    return fixtureEnvelope(['relationship_analysis','analysis_repair'].includes(stage)?analysis():stage==='communication_plan'?plan():guide());
  });
  await assert.rejects(model.respond(context(),memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_analysis_review_rejected'});
  assert.equal(stages.includes('analysis_repair'),true);assert.equal(stages.includes('guide_write'),false);
});

test('relationship protocol keeps the existing per-turn state and question-plan validation',async()=>{
  const ctx=context();let calls=0;
  const model=gateway(body=>{calls++;const input=JSON.parse(body.messages.at(-1).content).data;assert.ok(input.patient.some(row=>row.question_id==='rel'&&row.answers.some(answer=>answer.text==='자녀')));
    const state=memory();delete state.user_goal;return fixtureEnvelope({patient_state:state,name_index:ctx.name_index,relationship_memory:relationshipMemory()});});
  const result=await model.updateState(ctx,null);
  assert.equal(calls,1);assert.deepEqual(result.question_plan,{skip:[]});
});

test('a stale memory is regenerated from current answers before planning',async()=>{
  const ctx=context();const bad=memory();bad.facts[0].quote='정정 전 인용';const stages=[];
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage==='state'){stages.push('state');const state=memory();delete state.user_goal;return fixtureEnvelope({patient_state:state,name_index:ctx.name_index,relationship_memory:relationshipMemory()});}
    stages.push(input.stage);
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}}[input.stage]);
  });
  const result=await model.respond(ctx,bad);assert.equal(stages[0],'state');assert.deepEqual(result.patient_state,canonicalPatientState(memory(),ctx));
});

test('every state turn reads all current answers and the verified previous relationship memory',async()=>{
  const ctx=context();ctx.patient.fields.early=field('early','처음 보고한 상황이에요');
  let observed;
  const model=gateway(body=>{
    observed=JSON.parse(body.messages.at(-1).content).data;
    const state=memory();delete state.user_goal;
    return fixtureEnvelope({patient_state:state,name_index:ctx.name_index,relationship_memory:relationshipMemory()});
  });
  const result=await model.updateState(ctx,memory());
  assert.ok(observed.patient.some(row=>row.question_id==='early'));
  assert.equal(Object.hasOwn(observed,'prior_relationship_memory'),false);
  assert.deepEqual(model.transportInputs.find(input=>input.stage==='relationship_memory').data.prior_relationship_memory,canonicalRelationshipMemory(relationshipMemory(),ctx));
  assert.deepEqual(result.relationship_memory,canonicalRelationshipMemory(relationshipMemory(),ctx));
  ctx.patient.fields.mood.status='unknown';
  assert.equal(agentContext(ctx).prior_relationship_memory,null);
});

test('pending answers identify the newly supplied source without confusing the next question',()=>{
  const pending=prepareModelAnswer(createIntake(),{question_id:'name',text:'지민'},0);
  const ctx=buildContext(pending);
  assert.deepEqual(ctx.latest_answer,{question_id:'name',subject:'patient'});
  const request=relationshipStateRequest(ctx,null);
  assert.equal(request.data.latest_answer.question_id,'name');
  assert.deepEqual(request.data.latest_answer.answers.map(row=>row.text),['지민']);
  assert.equal(request.data.latest_answer.status,'answered');
});

test('new supporter evidence is provided alongside prior observations and unavailable source IDs stay empty',()=>{
  const ctx=context();ctx.latest_answer={question_id:'feeling',subject:'supporter'};
  const request=relationshipStateRequest(ctx,memory());
  assert.deepEqual(request.data.latest_answer.answers.map(row=>row.text),['무력하고 걱정돼요']);
  assert.equal(request.data.latest_answer.subject,'supporter');
  assert.deepEqual(request.data.prior_relationship_memory,canonicalRelationshipMemory(relationshipMemory(),ctx));
  ctx.latest_answer={question_id:'feeling',subject:'patient'};
  assert.equal(relationshipStateRequest(ctx,memory()).data.latest_answer,null);
});

test('runner evidence choices bind a whole actor, question and literal source, excluding unavailable answers',()=>{
  const ctx=context();ctx.supporter.fields.private=field('private','답하고 싶지 않아요','refused');
  ctx.patient.fields.mood=field('mood','밤에 “괜찮아?”라고 물어요.\n계획표에 \\ 표시를 해요.');
  const schema=groundedEvidenceSchema(relationshipSchema,ctx);
  const candidates=schema.properties.relationship.properties.dynamics.items.properties.evidence.items.enum;
  assert.ok(candidates.some(ref=>ref.quote===ctx.patient.fields.mood.rawText));
  for(const ref of candidates) {
    const source=ref.subject==='user_goal'?ctx.user_goal.message:ctx[ref.subject].fields[ref.question_id];
    assert.equal(source.status,'answered');assert.ok(source.rawText.includes(ref.quote));
  }
  assert.equal(candidates.some(ref=>ref.question_id==='private'),false);
  const state=relationshipStateRequest(ctx,null).schema;
  for(const variant of state.properties.relationship_memory.properties.supporter.items.anyOf) {
    assert.ok(variant.properties.evidence.items.enum.every(ref=>ref.subject==='supporter'));
  }
});

test('safety grammar keeps the complete denied-risk sentence and long source input stays intact',()=>{
  const ctx=context();ctx.patient.fields.mood=field('mood','자해 생각은 전혀 없다고 말했어요. 이번 주에는 잠을 못 잤어요.');
  ctx.patient.fields.long=field('long','가'.repeat(2200));
  const schema=groundedEvidenceSchema(relationshipSchema,ctx);
  const safety=schema.properties.safety.properties.evidence.items.enum.filter(ref=>ref.question_id==='mood');
  assert.ok(safety.length);assert.ok(safety.every(ref=>ref.quote.includes('전혀 없다고')));
  assert.equal(safety.some(ref=>ref.quote==='자해'),false);
  const candidates=schema.properties.relationship.properties.dynamics.items.properties.evidence.items.enum;
  assert.ok(candidates.some(ref=>ref.question_id==='long'&&ref.quote.length<=1000));
  assert.equal(agentContext(ctx).patient.find(row=>row.question_id==='long').answers[0].text.length,2200);
});

test('internal findings reject cross-person, invented, unknown, refused and skipped evidence',()=>{
  const wrong=relationshipMemory();wrong.supporter=wrong.patient;wrong.patient=[];
  assert.throws(()=>validateRelationshipMemory(wrong,context()),{modelReason:'agent_memory_subject'});
  const invented=relationshipMemory();invented.patient[0].evidence[0].quote='없는 말';
  assert.throws(()=>validateRelationshipMemory(invented,context()),{modelReason:'agent_evidence'});
  for(const status of ['unknown','refused','skipped','auto_skipped']) {
    const ctx=context();ctx.patient.fields.mood.status=status;
    assert.throws(()=>validateRelationshipMemory(relationshipMemory(),ctx),{modelReason:'agent_evidence'});
  }
});

test('internal memory is stored separately, passed onward and invalidated by both back paths',()=>{
  const first=answerIntake(createIntake(),{question_id:'name',text:'지민'});
  const internal={patient:[],supporter:[],relationship:[],unknowns:['상태와 관계는 아직 확인되지 않았어요.']};
  const stored=applyModelUpdate(first,{patient_state:{summary:'호칭입니다.'},name_index:{alias:'지민',source_question_id:'name',quote:'지민'},
    question_plan:{skip:[]},relationship_memory:internal});
  assert.deepEqual(stored.agentRelationshipMemory,internal);
  assert.deepEqual(buildContext(stored).relationship_state,internal);
  assert.equal(backIntake(stored).agentRelationshipMemory,undefined);
  const pending=prepareModelAnswer(createIntake(),{question_id:'name',text:'지민'},0);
  pending.agentRelationshipMemory=internal;
  assert.equal(backIntake(pending).agentRelationshipMemory,undefined);
  const skipped=context();skipped.user_goal.message.status='skipped';
  assert.equal(agentContext(skipped).user_goal[0].status,'skipped');
  assert.equal(agentContext(skipped).user_goal[0].answers.length,0);
});

test('a name alone cannot become an internal state or relationship finding',()=>{
  const ctx=context();ctx.patient.fields={name:field('name','지민')};ctx.supporter.fields={};
  for(const subject of ['patient','relationship']) {
    const value={patient:[],supporter:[],relationship:[],unknowns:[]};
    value[subject]=[{interpretation:'부모의 압박으로 대화를 피합니다.',certainty:'tentative',evidence:[{subject:'patient',question_id:'name',quote:'지민'}]}];
    const original=structuredClone(value);
    assert.throws(()=>validateRelationshipMemory(value,ctx),error=>{
      assert.equal(error.modelReason,'agent_memory_name_only');
      const feedback=JSON.parse(error.modelFeedback);
      assert.equal(feedback.path,`relationship_memory.${subject}[0].evidence`);
      assert.equal(feedback.rule,'non_name_evidence_required');
      assert.match(feedback.repair,/현재 전체 원문과 허용된 retrieval/u);
      assert.match(feedback.repair,/기존 전체 검증과 독립 검토/u);
      assert.doesNotMatch(error.modelFeedback,/지민|부모의 압박/u);
      return true;
    });
    assert.deepEqual(value,original);
  }
  const value=relationshipMemory();value.relationship=value.patient;value.patient=[];
  assert.throws(()=>validateRelationshipMemory(value,context()),{modelReason:'agent_schema'});
});

test('early goals cannot be copied into another actor in the state output schema',()=>{
  const ctx=context();ctx.patient.fields={name:field('name','지민')};ctx.supporter.fields={};
  const request=relationshipStateRequest(ctx,null);
  assert.equal(request.schema.properties.relationship_memory.properties.patient.maxItems,0);
  assert.equal(request.schema.properties.relationship_memory.properties.supporter.maxItems,0);
  for(const variant of request.schema.properties.relationship_memory.properties.supporter.items.anyOf) {
    assert.deepEqual(variant.properties.evidence.items.properties.subject.enum,['supporter']);
    assert.equal(Object.hasOwn(variant.properties.evidence.items,'enum'),false);
  }
});

test('MLX context overflow rejects once without dropping or shortening current source answers',async()=>{
  let calls=0;
  const model=gateway(()=>{calls++;return new Response(JSON.stringify({error:{type:'invalid_request_error',
    message:"input length (140000 tokens) exceeds the model's maximum context length (131072 tokens)"}}),{status:400});});
  await assert.rejects(model.updateState(context(),memory()),{code:'MODEL_CONTEXT_TOO_LONG'});
  assert.equal(calls,1);
});

test('quality refinement is checked again before an approved result is returned',async()=>{
  const stages=[],refined=guide();refined.guide.script+=' 원할 때 이야기해 줘.';
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);stages.push(input.stage);
    if(input.stage==='guide_quality')return fixtureEnvelope({improvements:[{field:'script',reason:'전하고 싶은 마음을 더 직접 표현하기',repair:'이해하고 싶다는 원래 마음을 유지하세요.'}]});
    if(input.stage==='guide_refine'){assert.equal(input.data.quality.improvements.length,1);return fixtureEnvelope(refined);}
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_review:{approved:true,issues:[]}}[input.stage]);
  });
  const result=await model.respond(context(),memory());
  assert.ok(stages.indexOf('guide_refine')<stages.indexOf('guide_review'));
  assert.equal(result.agent.quality_reviewed,true);
});

test('quality refinement preserves unmentioned cards, classification and assessment',async()=>{
  for(const changed of ['care','top','assessment']) {
    let checks=0;
    const model=gateway(body=>{
      const input=JSON.parse(body.messages.at(-1).content);
      if(input.stage==='guide_quality')return envelope({improvements:[{field:'script',reason:'발화의 선택권을 명확히 하세요.',repair:'원할 때 이야기할 수 있음을 전하세요.'}]});
      if(input.stage==='guide_refine'){
        const schema=input.output_schema;
        for(const field of ['care','top','doList','avoid','next'])assert.deepEqual(schema.properties.guide.properties[field].enum,[input.data.draft[field]]);
        assert.deepEqual(schema.properties.assessment.enum,[guide().assessment]);
        const candidate=guide();candidate.guide.script+=' 원할 때 이야기해 줘.';
        if(changed==='care')candidate.guide.care.feel='다른 돌봄 문구예요.';
        else if(changed==='top')candidate.guide.top='불안';
        else candidate.assessment.safety=true;
        return envelope(candidate);
      }
      return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide()}[input.stage]);
    },{qualityCheck:()=>{checks++;return {improvements:[]};}});
    await assert.rejects(model.respond(context(),memory()),{modelReason:changed==='assessment'?'agent_safety_mismatch':'agent_schema'});
    assert.equal(checks,0);
    assert.equal(model.transportStages.includes('guide_review'),false);
  }
});

test('quality refinement rejects a no-op before any approving quality check',async()=>{
  let checks=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage==='guide_quality')return envelope({improvements:[{field:'script',reason:'선택권이 불분명해요.',repair:'원할 때 이야기할 수 있음을 전하세요.'}]});
    if(input.stage==='guide_refine')return envelope({guide:Object.fromEntries(Object.entries(input.data.draft).reverse()),assessment:guide().assessment});
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide()}[input.stage]);
  },{qualityCheck:()=>{checks++;return {improvements:[]};}});
  await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_review_noop'});
  assert.equal(checks,0);assert.equal(model.transportStages.includes('guide_review'),false);
});

test('quality refinement uses the latest remaining issue and exact current history for one bounded retry',async()=>{
  const firstQuality={improvements:[{field:'script',reason:'선택권을 명확히 하세요.',repair:'원할 때 이야기할 수 있음을 전하세요.'}]};
  const remaining={improvements:[{field:'next',reason:'거절했을 때 할 행동이 빠졌어요.',repair:'거절하면 대화를 멈추고 편할 때 알려 달라고 전하세요.'}]};
  const first=guide();first.guide.script+=' 원할 때 이야기해 줘.';
  const second=structuredClone(first);second.guide.next='지금 이야기하기 어렵다면 대화를 멈추고, 편할 때 알려 달라고 전해 보세요.';
  let checks=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage==='guide_refine')assert.deepEqual(input.data.quality,firstQuality);
    if(input.stage==='guide_refine_2'){
      assert.deepEqual(input.data.quality,remaining);assert.deepEqual(input.data.draft,first.guide);
      assert.deepEqual(input.output_schema.properties.guide.properties.script.enum,[first.guide.script]);
      assert.equal(Object.hasOwn(input.output_schema.properties.guide.properties.next,'enum'),false);
    }
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),
      guide_quality:firstQuality,guide_refine:first,guide_refine_2:second,guide_review:{approved:true,issues:[]}}[input.stage]);
  },{qualityCheck:input=>{
    const expected=++checks===1?{previous_quality:firstQuality,before:guide().guide,after:first.guide}
      :{previous_quality:remaining,before:first.guide,after:second.guide};
    assert.deepEqual(input.data.revision,expected);
    assert.deepEqual(input.data.guide,expected.after);
    return checks===1?remaining:{improvements:[]};
  }});
  const result=await model.respond(context(),memory());
  assert.equal(checks,2);assert.deepEqual(result.guide,second.guide);
  assert.ok(model.transportStages.indexOf('guide_quality_check_2')<model.transportStages.indexOf('speech_review'));
  assert.equal(result.agent.reviewed,true);assert.equal(result.agent.quality_reviewed,true);
});

test('quality reviews the final speech and preserves the exact refinement history through mandatory reviews',async()=>{
  const provisional=guide();provisional.guide.script='아직 통합하지 않은 임시 발화입니다.';
  const spoken='지민아, 밤에 계획표를 고치는 모습을 봤어. 네가 걱정되지만 네 마음을 이해하고 싶어. 지금 이야기해도 괜찮을까?';
  const refined=guide();refined.guide.script=spoken.replace(' 네가 걱정되지만','\n\n네가 걱정되지만');
  const quality={improvements:[{field:'script',reason:'전할 마음과 관찰을 읽기 쉽게 나누세요.',repair:'원래 걱정과 이해하고 싶은 마음을 유지하며 두 문단으로 다듬으세요.'}]};
  const speechReviews=[],events=[],phases=[],progress=generationProgress();
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
      guide_write:provisional,guide_quality:quality,guide_refine:refined,guide_review:{approved:true,issues:[]}}[input.stage]);
  },{speechWrite:()=>({script:spoken}),speechReview:input=>{speechReviews.push(input.data.script);return {approved:true,issues:[]};}});
  const result=await model.respond(context(),memory(),{onProgress:event=>{
    events.push(event);progress.event(event);
    if(event.status==='completed')phases.push([event.stage,progress.state.progress]);
  }});
  const inputFor=stage=>model.transportInputs.find(input=>input.stage===stage).data;
  const before={...guide().guide,script:spoken};
  assert.equal(inputFor('guide_quality').guide.script,spoken);
  assert.deepEqual(inputFor('guide_refine').draft,before);
  assert.deepEqual(inputFor('guide_quality_check').revision,{previous_quality:quality,before,after:refined.guide});
  assert.deepEqual(inputFor('guide_quality_check').answers,agentContext(context()));
  const qualityCheckPrompt=model.transportPrompts[model.transportStages.indexOf('guide_quality_check')];
  assert.ok(!qualityCheckPrompt.includes(GUIDANCE_REVIEW_BOUNDARY));
  assert.ok(qualityCheckPrompt.includes('선택적인 개선을 새 필수 조건으로 만들지 마세요'));
  assert.ok(qualityCheckPrompt.includes('행동 방법이나 대안이 실제로 없거나 역할·안전·원문 근거의 오류가 남은 경우는 계속 지적하세요'));
  assert.deepEqual(speechReviews,[refined.guide.script]);
  assert.deepEqual(inputFor('guide_review').guide,refined.guide);
  assert.deepEqual(result.guide,refined.guide);
  const ordered=['speech_opening','speech_listening','speech_offer','speech_write','guide_quality','guide_refine','guide_quality_check',
    'speech_review','support_review','guide_review','speech_detail','speech_detail_review'];
  assert.deepEqual(model.transportStages.filter(stage=>ordered.includes(stage)),ordered);
  assert.deepEqual(events.filter(event=>event.status==='completed').map(event=>event.stage),result.agent.stages);
  assert.deepEqual(phases.filter(([stage])=>['speech_write','guide_quality','guide_refine','guide_quality_check','speech_review'].includes(stage)),
    [['speech_write',40],['guide_quality',40],['guide_refine',40],['guide_quality_check',40],['speech_review',60]]);
  assert.equal(progress.state.progress,60);
  assert.equal(progress.state.steps.at(-1).status,'pending');
});

test('quality refinement cannot replace validated speech with an unsupported claim or unlimited support promise',async()=>{
  for(const [script,reason] of [
    ['완벽하게 하고 싶은 마음 때문에 힘든 거야.','agent_script_inference'],
    ['네 곁에 항상 있을게.','agent_speech_specific'],
  ]){
    let refinements=0,checks=0;
    const refined=guide();refined.guide.script=script;
    const model=gateway(body=>{
      const stage=JSON.parse(body.messages.at(-1).content).stage;
      if(stage==='guide_refine'){refinements++;return fixtureEnvelope(refined);}
      return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
        guide_write:guide(),guide_quality:{improvements:[{field:'script',reason:'의미를 명확하게 표현하세요.',repair:'원문에 있는 뜻을 유지하세요.'}]},
        guide_review:{approved:true,issues:[]}}[stage]);
    },{speechWrite:()=>({script:guide().guide.script}),qualityCheck:()=>{checks++;return {improvements:[]};}});
    await assert.rejects(model.respond(context(),memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:reason});
    assert.equal(refinements,3);assert.equal(checks,0);
    assert.equal(model.transportStages.filter(stage=>stage==='speech_write').length,1);
    assert.equal(model.transportStages.includes('speech_review'),false);
  }
});

test('analysis repair is rechecked before the plan is created',async()=>{
  const stages=[];
  const ctx=context();ctx.relationship_state.relationship=[finding()];
  const corrected=analysis();corrected.relationship.dynamics=[];
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages.at(-1).content).stage;stages.push(stage);
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:false,issues:[{field:'relationship_analysis',reason:'역할 해석 수정',repair:'관찰 범위만 쓰세요.'}]},
      analysis_repair:corrected,analysis_review_after_repair:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}}[stage]);
  });
  const result=await model.respond(ctx,memory());
  assert.ok(stages.indexOf('analysis_review_after_repair')<stages.indexOf('communication_plan'));
  assert.deepEqual(result.relationship_memory.relationship,[]);
  assert.deepEqual(result.relationship_memory.unknowns,corrected.unknowns);
});

test('a late analysis problem rebuilds the plan, guide and reviewed memory from the repaired analysis',async()=>{
  const stages=[],ctx=context();ctx.relationship_state.relationship=[finding()];
  ctx.supporter.fields.mysupport=field('mysupport','여동생에게 힘든 점을 이야기해요');
  const corrected=analysis();corrected.relationship.dynamics=[];
  corrected.observations={patient:[ref()],supporter:[{subject:'supporter',question_id:'mysupport',quote:'여동생에게 힘든 점을 이야기해요'}]};
  corrected.relationship.strengths=[{interpretation:'이용자가 자신의 걱정을 표현했어요.',certainty:'reported',
    evidence:[{subject:'supporter',question_id:'feeling',quote:'무력하고 걱정돼요'}]}];
  corrected.unknowns=['대상자가 편한 대화 시간은 확인되지 않았어요.'];
  const revisedPlan=plan();revisedPlan.next_step='편한 대화 시간을 먼저 물어보기';
  const revisedGuide=guide();revisedGuide.guide.script='지민아, 지금 이야기해도 괜찮을까? 밤에 계획표를 고치는 모습을 봤어. 네 마음을 이해하고 싶어.';
  const outputs={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
    guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:false,issues:[
      {field:'relationship_analysis',reason:'관계 패턴을 지나치게 단정했어요.',repair:'확인된 관찰과 이용자 감정만 남기세요.'},
      {field:'script',reason:'첫 질문을 구체적으로 다듬으세요.',repair:'지금 말하기 편한지 물어보세요.'}]},
    analysis_repair_after_guide_review:corrected,analysis_review_after_guide_review_repair:{approved:true,issues:[]},
    communication_plan_after_analysis_repair:revisedPlan,guide_write_after_analysis_repair:guide(),
    guide_quality_after_analysis_repair:{improvements:[{field:'script',reason:'대화 허락을 앞에 두기',repair:'지금 말해도 괜찮은지 먼저 물어보세요.'}]},
    guide_refine_after_analysis_repair:revisedGuide,guide_review_after_analysis_repair:{approved:true,issues:[]}};
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);stages.push(input.stage);
    assert.ok(body.response_format.json_schema.name.length<=64);
    if(input.stage==='analysis_repair_after_guide_review') {
      assert.deepEqual(input.data.draft,canonicalAnalysis(analysis()));
      assert.equal(input.data.review.issues.length,1);
      assert.equal(input.data.review.issues[0].field,'relationship_analysis');
    }
    if(['analysis_review_after_guide_review_repair','communication_plan_after_analysis_repair',
      'guide_write_after_analysis_repair','guide_quality_after_analysis_repair','guide_refine_after_analysis_repair',
      'guide_review_after_analysis_repair'].includes(input.stage)) assert.deepEqual(input.data.analysis,canonicalAnalysis(corrected,ctx));
    if(input.stage==='guide_write_after_analysis_repair') assert.deepEqual(input.data.plan,revisedPlan);
    return fixtureEnvelope(outputs[input.stage]);
  });
  model.timeoutMs=600000;
  const operations=[],complete=model.agentComplete.bind(model);
  model.agentComplete=(...args)=>{operations.push(args[4]);return complete(...args);};
  const result=await model.respond(ctx,memory());
  assert.equal(operations.length,model.transportStages.length);
  assert.ok(operations.every(operation=>operation.deadline===operations[0].deadline&&operation.recovery===operations[0].recovery));
  assert.ok(operations.some(operation=>operation.controller!==operations[0].controller));
  assert.deepEqual(stages,Object.keys(outputs));
  assert.deepEqual(result.guide,revisedGuide.guide);
  assert.deepEqual(result.relationship_analysis,canonicalAnalysis(corrected,ctx));
  assert.equal(result.relationship_analysis.supporter_summary,'이용자 자신의 상황에 관한 답변 원문:\n“여동생에게 힘든 점을 이야기해요”');
  assert.deepEqual(result.relationship_memory.relationship,[]);
  assert.deepEqual(result.relationship_memory.supporter,canonicalRelationshipMemory({patient:[],supporter:corrected.relationship.strengths,
    relationship:[],unknowns:[]},ctx).supporter);
  assert.deepEqual(result.relationship_memory.unknowns,corrected.unknowns);
  assert.equal(result.agent.reviewed,true);assert.equal(result.agent.quality_reviewed,true);
});

test('a rejected late analysis repair stops before generating a replacement guide',async()=>{
  const stages=[],issue={field:'relationship_analysis',reason:'원문에 없는 관계 원인을 단정했어요.',repair:'확인된 범위만 쓰세요.'};
  const outputs={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
    guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:false,issues:[issue]},
    analysis_repair_after_guide_review:analysis(),analysis_review_after_guide_review_repair:{approved:false,issues:[issue]}};
  const model=gateway(body=>{const stage=JSON.parse(body.messages.at(-1).content).stage;stages.push(stage);return fixtureEnvelope(outputs[stage]);});
  await assert.rejects(model.respond(context(),memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_analysis_review_rejected'});
  assert.deepEqual(stages,Object.keys(outputs));
  assert.equal(stages.includes('communication_plan_after_analysis_repair'),false);
});

test('another late critical analysis rejection cannot start a second analysis repair',async()=>{
  const stages=[],issue={field:'relationship_analysis',reason:'관계 해석이 아직 원문을 벗어났어요.',repair:'추정 범위를 줄이세요.'};
  const outputs={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
    guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:false,issues:[issue]},
    analysis_repair_after_guide_review:analysis(),analysis_review_after_guide_review_repair:{approved:true,issues:[]},
    communication_plan_after_analysis_repair:plan(),guide_write_after_analysis_repair:guide(),
    guide_quality_after_analysis_repair:{improvements:[]},guide_review_after_analysis_repair:{approved:false,issues:[issue]}};
  const model=gateway(body=>{const stage=JSON.parse(body.messages.at(-1).content).stage;stages.push(stage);return fixtureEnvelope(outputs[stage]);});
  await assert.rejects(model.respond(context(),memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_analysis_review_rejected'});
  assert.deepEqual(stages,Object.keys(outputs));
  assert.equal(stages.filter(stage=>stage==='analysis_repair_after_guide_review').length,1);
  assert.equal(stages.some(stage=>stage.startsWith('guide_repair')),false);
});

test('an initial analysis repair consumes the same one-repair budget as a late problem',async()=>{
  const stages=[],issue={field:'relationship_analysis',reason:'관계 해석의 근거가 부족해요.',repair:'원문 관찰만 쓰세요.'};
  const outputs={relationship_analysis:analysis(),analysis_review:{approved:false,issues:[issue]},analysis_repair:analysis(),
    analysis_review_after_repair:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),
    guide_quality:{improvements:[]},guide_review:{approved:false,issues:[issue]}};
  const model=gateway(body=>{const stage=JSON.parse(body.messages.at(-1).content).stage;stages.push(stage);return fixtureEnvelope(outputs[stage]);});
  await assert.rejects(model.respond(context(),memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_analysis_review_rejected'});
  assert.deepEqual(stages,Object.keys(outputs));
  assert.equal(stages.includes('analysis_repair_after_guide_review'),false);
});

test('guide repairs keep their total budget when a late analysis repair rewrites the guide',async()=>{
  const stages=[],guideIssue={field:'script',reason:'이용자의 목적과 반대인 말이에요.',repair:'이해하고 싶은 마음을 유지하세요.'},
    analysisIssue={field:'relationship_analysis',reason:'관계 패턴을 단정했어요.',repair:'관찰 범위만 쓰세요.'};
  const outputs={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
    guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:false,issues:[guideIssue]},
    guide_repair:guide(),guide_review_after_repair:{approved:false,issues:[analysisIssue]},
    analysis_repair_after_guide_review:analysis(),analysis_review_after_guide_review_repair:{approved:true,issues:[]},
    communication_plan_after_analysis_repair:plan(),guide_write_after_analysis_repair:guide(),
    guide_quality_after_analysis_repair:{improvements:[]},guide_review_after_analysis_repair:{approved:false,issues:[guideIssue]},
    guide_repair_2_after_analysis_repair:guide(),guide_review_after_repair_2_after_analysis_repair:{approved:false,issues:[guideIssue]}};
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages.at(-1).content).stage;stages.push(stage);
    assert.ok(body.response_format.json_schema.name.length<=64);
    return fixtureEnvelope(outputs[stage]);
  });
  await assert.rejects(model.respond(context(),memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_review_rejected'});
  assert.deepEqual(stages,Object.keys(outputs));
  assert.equal(stages.filter(stage=>stage.startsWith('guide_repair')).length,2);
});

test('reported certainty cannot make a relationship dynamics hypothesis a confirmed fact',()=>{
  const value=analysis();value.relationship.dynamics[0].certainty='reported';
  assert.deepEqual(relationshipSchema.properties.relationship.properties.dynamics.items.properties.certainty.enum,['tentative']);
  assert.throws(()=>validateRelationship(value,context()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
});


test('a valid original quote outside the retrieved set is rejected before the next stage',async()=>{
  const ctx=context();
  for(let i=0;i<40;i++)ctx.patient.fields['noise'+i]=field('noise'+i,'zz'+i+'qq');
  for (const field of ['dynamics','observations']) {
    const model=gateway(body=>{
      const input=JSON.parse(body.messages[1].content);
      assert.equal(input.stage,'relationship_analysis');
      const retrieved=new Set(input.data.retrieval.documents.map(row=>row.question_id));
      const omitted=Object.values(ctx.patient.fields).find(row=>row.id.startsWith('noise')&&!retrieved.has(row.id));
      assert.ok(omitted);
      const result=draftAnalysis(),reference={subject:'patient',question_id:omitted.id,quote:omitted.text};
      if(field==='dynamics')result.relationship.dynamics[0].evidence=[reference];
      else result.observations.patient=[reference];
      return envelope(result);
    });
    // The grounded schema now reports this rejection before the generic retrieval check.
    await assert.rejects(model.respond(ctx,memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  }
});


test('state facts and their previous valid sources stay inside the retrieval schema',()=>{
  const ctx=context();
  for(let i=0;i<40;i++)ctx.patient.fields['noise'+i]=field('noise'+i,'zz'+i+'qq');
  const prior=memory();prior.facts=[{subject:'patient',question_id:'noise37',quote:'zz37qq',interpretation:'이용자가 보고했습니다.',certainty:'reported'}];
  const request=relationshipStateRequest(ctx,prior);
  const ids=new Set(request.retrieval.documents.map(row=>row.question_id));
  assert.ok(ids.has('noise37'));
  for(const variant of request.schema.properties.patient_state.properties.facts.items.anyOf) {
    assert.ok(ids.has(variant.properties.question_id.const));
  }
});

test('state generation accepts only raw facts and reported evidence while the server derives attributed text',async()=>{
  const ctx=context();ctx.patient.fields.mood=field('mood','계획표를 반복해서 확인해요');
  const raw=stateDraft(ctx),quote=ctx.patient.fields.mood.rawText;
  raw.patient_state.facts[0].quote=quote;raw.relationship_memory.patient[0].evidence[0].quote=quote;
  const tentative={...finding(),evidence:[{subject:'patient',question_id:'mood',quote}]};
  raw.relationship_memory.patient.push(tentative);raw.relationship_memory.relationship=[tentative];
  let calls=0;
  const model=stateGateway((body,input)=>{
    calls++;const schema=input.output_schema;
    if(input.stage==='state_observations'){
      assert.deepEqual(schema.properties.patient_state.required,['facts','unknowns']);
      for(const variant of schema.properties.patient_state.properties.facts.items.anyOf)assert.equal(Object.hasOwn(variant.properties,'interpretation'),false);
      return envelope(validateSchema(observationPayload(raw),schema));
    }
    assert.equal(input.stage,'relationship_memory');
    const variants=schema.properties.relationship_memory.properties.patient.items.anyOf;
    assert.deepEqual(variants[0].required,['evidence','certainty']);
    assert.deepEqual(variants[1].required,['interpretation','evidence','certainty']);
    return envelope(validateSchema({relationship_memory:raw.relationship_memory},schema));
  });
  const result=await model.updateState(ctx,null);
  assert.equal(calls,2);
  assert.deepEqual(result.state_agent.stages,['state_observations','relationship_memory','state_review']);
  const literal='이용자가 대상자에 관해 보고한 답변 원문:\n“'+quote+'”';
  assert.equal(result.patient_state.summary,literal);
  assert.equal(result.patient_state.facts[0].interpretation,literal);
  assert.equal(result.relationship_memory.patient[0].interpretation,literal);
  assert.deepEqual(result.relationship_memory.patient[0].evidence,raw.relationship_memory.patient[0].evidence);
  assert.deepEqual(result.relationship_memory.patient[1],tentative);
  assert.deepEqual(result.relationship_memory.relationship,[tentative]);
  assert.equal(JSON.stringify(result).includes('불안 증세'),false);
});

test('generated free summaries, fact interpretations and expanded reported findings cannot bypass the draft boundary',async()=>{
  for(const [target,mutate] of [
    ['state_observations',raw=>{raw.patient_state.summary='불안 증세와 반복 확인이 관찰됐어요.';}],
    ['state_observations',raw=>{raw.patient_state.facts[0].interpretation='불안 증세와 반복 확인이 관찰됐어요.';}],
    ['relationship_memory',raw=>{raw.relationship_memory.patient[0].interpretation='불안 증세와 반복 확인이 관찰됐어요.';}],
  ]) {
    const raw=stateDraft();mutate(raw);let attempts=0;
    const model=stateGateway((body,input)=>{
      const value=input.stage==='state_observations'?observationPayload(raw):{relationship_memory:raw.relationship_memory};
      if(input.stage===target){attempts++;assert.throws(()=>validateSchema(value,input.output_schema),{modelReason:'agent_schema'});}
      return envelope(value);
    });
    await assert.rejects(model.updateState(context(),memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
    assert.equal(attempts,3);
  }
});

test('a stale model selection retains the complete latest answer without retrying',async()=>{
  const ctx=context();ctx.latest_answer={subject:'supporter',question_id:'feeling'};
  let calls=0;
  const model=gateway(()=>{calls++;return envelope(stateDraft(ctx));});
  const result=await model.updateState(ctx,memory());
  assert.equal(calls,1);
  assert.equal(result.patient_state.facts.at(-1).interpretation,'이용자가 자신의 상황에 관해 보고한 답변 원문:\n“무력하고 걱정돼요”');
  assert.ok(result.patient_state.summary.includes('무력하고 걱정돼요'));
});

test('latest source retention preserves full denial, attribution and follow-up while leaving unknown and refused answers unconfirmed',()=>{
  const ctx=context();ctx.latest_answer={subject:'supporter',question_id:'feeling'};
  const full='다른 사람이 위험하다고 말했지만 제 생각은 아니고 지금은 그런 생각이 전혀 없어요.';
  ctx.supporter.fields.feeling=field('feeling',full);
  ctx.supporter.fields.feeling.followUp={answer:{text:'아까 말은 작년 일을 인용한 거예요. 지금 이야기로 바꾸지 말아 주세요.'}};
  const result=canonicalRelationshipState(stateDraft(ctx),ctx);
  const facts=result.patient_state.facts.filter(fact=>fact.subject==='supporter');
  assert.deepEqual(facts.map(fact=>fact.quote),[full,ctx.supporter.fields.feeling.followUp.answer.text]);
  for(const status of ['unknown','refused','skipped']) {
    ctx.supporter.fields.feeling.status=status;
    const uncertain=canonicalRelationshipState(stateDraft(ctx),ctx);
    assert.equal(uncertain.patient_state.facts.some(fact=>fact.subject==='supporter'),false);
  }
});

test('latest selected labels plus maximum custom text retain source without splitting Unicode',()=>{
  const ctx=context();ctx.latest_answer={subject:'supporter',question_id:'feeling'};
  const original='걱정됨 '+ '가'.repeat(9995)+'🌱'+' 지금은 그런 생각이 전혀 없어요.';
  ctx.supporter.fields.feeling=field('feeling',original);
  const result=canonicalRelationshipState(stateDraft(ctx),ctx);
  const quotes=result.patient_state.facts.filter(fact=>fact.subject==='supporter').map(fact=>fact.quote);
  assert.ok(quotes.length>1);
  assert.equal(quotes.join(''),original);
  for(const quote of quotes) {
    assert.ok(quote.length<=10000);
    assert.ok(quote.isWellFormed());
  }
});

test('corrected current risk denial is retained literally and old affirmative state cannot survive source validation',async()=>{
  const ctx=context();ctx.latest_answer={subject:'patient',question_id:'mood'};
  const old=stateDraft(ctx),denial='과거에 자해 이야기를 했지만 지금은 그런 생각이 전혀 없다고 말했어요.';
  ctx.patient.fields.mood=field('mood',denial);ctx.relationship_state=null;
  const fresh=stateDraft(ctx);fresh.patient_state.facts[0].quote=denial;fresh.relationship_memory.patient[0].evidence[0].quote=denial;
  let calls=0;
  const model=stateGateway((body,input)=>{
    assert.equal(Object.hasOwn(input.data,'prior_state'),false);
    assert.deepEqual(input.data.latest_answer.answers.map(row=>row.text),[denial]);
    if(input.stage==='relationship_memory'){
      assert.equal(input.data.prior_relationship_memory,null);
      return envelope({relationship_memory:fresh.relationship_memory});
    }
    calls++;return envelope(observationPayload(calls===1?old:fresh));
  });
  const result=await model.updateState(ctx,memory());
  assert.equal(calls,2);
  assert.equal(result.patient_state.facts[0].quote,denial);
  assert.ok(result.patient_state.summary.includes(denial));
  assert.ok(result.relationship_memory.patient[0].interpretation.includes(denial));
});

test('state draft union references are actor-bound, current, answered and restricted to retrieved sources',()=>{
  const ctx=context();ctx.patient.fields.private=field('private','답하고 싶지 않아요','refused');
  ctx.patient.fields.old=field('old','이전 답변은 아니에요','unknown');
  for(let i=0;i<45;i++)ctx.patient.fields['noise'+i]=field('noise'+i,'zz'+i+'qq');
  const request=relationshipStateRequest(ctx,memory()),ids=new Set(request.retrieval.documents.map(row=>row.question_id));
  for(const subject of ['patient','supporter']) {
    for(const variant of request.schema.properties.relationship_memory.properties[subject].items.anyOf) {
      for(const reference of variant.properties.evidence.items.enum) {
        assert.equal(reference.subject,subject);assert.equal(ctx[subject].fields[reference.question_id].status,'answered');
        assert.ok(ids.has(reference.question_id));
      }
    }
  }
  const missing=Object.values(ctx.patient.fields).find(row=>row.id.startsWith('noise')&&!ids.has(row.id));
  assert.ok(missing);
  for(const badRef of [
    {subject:'supporter',question_id:'mood',quote:ref().quote},
    {...ref(),quote:'확인하지 않은 원문'},
    {subject:'patient',question_id:'private',quote:ctx.patient.fields.private.text},
    {subject:'patient',question_id:'old',quote:ctx.patient.fields.old.text},
    {subject:'patient',question_id:missing.id,quote:missing.text},
  ]) {
    const raw=stateDraft(ctx);raw.relationship_memory.patient[0].evidence=[badRef];
    assert.throws(()=>canonicalRelationshipState(raw,ctx,request.schema),{modelReason:'agent_schema'});
  }
  const stale=stateDraft(ctx);ctx.patient.fields.mood=field('mood','학교에서 연락을 받았어요');
  assert.throws(()=>canonicalRelationshipState(stale,ctx),{modelReason:'agent_schema'});
});

test('valid legacy prior summaries and reported interpretations are normalized before model input',()=>{
  const ctx=context(),prior=memory();
  prior.summary='걱정 때문에 불안 증세가 생겼어요.';prior.facts[0].interpretation='불안 증세와 반복 확인이 관찰됐어요.';
  ctx.relationship_state.patient[0].interpretation='불안 증세와 반복 확인이 관찰됐어요.';
  ctx.relationship_state.patient.push(finding());ctx.relationship_state.relationship=[finding()];
  assert.deepEqual(validateRelationshipMemory(ctx.relationship_state,ctx),ctx.relationship_state);
  const request=relationshipStateRequest(ctx,prior);
  assert.equal(JSON.stringify(request.data).includes('불안 증세'),false);
  assert.equal(request.data.prior_state.summary,'이용자가 대상자에 관해 보고한 답변 원문:\n“밤에 계획표를 고쳐요”');
  assert.equal(request.data.prior_state.facts[0].interpretation,request.data.prior_state.summary);
  assert.equal(request.data.prior_relationship_memory.patient[0].interpretation,request.data.prior_state.summary);
  assert.deepEqual(request.data.prior_relationship_memory.patient[1],finding());
  assert.deepEqual(request.data.prior_relationship_memory.relationship,[finding()]);
  const stale=structuredClone(prior);stale.facts[0].quote='예전 답변';
  assert.equal(relationshipStateRequest(ctx,stale).data.prior_state,null);
  ctx.patient.fields.mood.status='refused';
  assert.equal(agentContext(ctx).prior_relationship_memory,null);
});

test('long reported quotes remain complete in evidence and receive a short attributed interpretation',()=>{
  const ctx=context(),quote='상황을 확인한 원문입니다. '.repeat(45);
  ctx.patient.fields.long=field('long',quote);
  const raw=stateDraft(ctx);raw.relationship_memory.patient[0].evidence=[{subject:'patient',question_id:'long',quote}];
  const result=canonicalRelationshipState(raw,ctx);
  assert.equal(result.relationship_memory.patient[0].interpretation,'이용자가 대상자에 관해 보고한 답변 원문은 근거에 보존했어요.');
  assert.equal(result.relationship_memory.patient[0].evidence[0].quote,quote);
  assert.ok(result.relationship_memory.patient[0].interpretation.length<=500);
  const veryLong='긴 답변 원문입니다. '.repeat(220),prior=memory();
  ctx.patient.fields.veryLong=field('veryLong',veryLong);
  prior.facts=[{subject:'patient',question_id:'veryLong',quote:veryLong,interpretation:'예전 해석',certainty:'reported'}];
  const normalized=canonicalPatientState(prior,ctx);
  assert.equal(normalized.facts[0].quote,veryLong);
  assert.equal(normalized.facts[0].interpretation,'이용자가 대상자에 관해 보고한 답변 원문은 근거에 보존했어요.');
});

test('unknown fact certainty stays unconfirmed and draft object references accept equivalent key order',()=>{
  const ctx=context(),raw=stateDraft(ctx);raw.patient_state.facts[0].certainty='unknown';
  const result=canonicalRelationshipState(raw,ctx);
  assert.equal(result.patient_state.facts[0].certainty,'unknown');
  assert.equal(result.patient_state.facts[0].interpretation,'이용자가 대상자에 관해 미확인으로 남긴 답변 원문:\n“밤에 계획표를 고쳐요”');
  assert.equal(result.patient_state.summary,result.patient_state.facts[0].interpretation);
  raw.relationship_memory.patient[0].evidence=[{quote:ref().quote,question_id:'mood',subject:'patient'}];
  assert.doesNotThrow(()=>canonicalRelationshipState(raw,ctx));
  const prior=memory();ctx.patient.fields.mood.status='unknown';prior.facts[0].certainty='unknown';
  assert.ok(canonicalPatientState(prior,ctx).summary.includes('미확인으로 남긴'));
  prior.facts[0].certainty='reported';assert.throws(()=>canonicalPatientState(prior,ctx),{code:'MODEL_INVALID_RESPONSE'});
});

test('reported final resources are normalized before they become the next state memory',async()=>{
  const value=analysis();value.relationship.strengths=[{interpretation:'불안 증세와 반복 확인이 관찰됐어요.',certainty:'reported',evidence:[ref()]}];
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages.at(-1).content).stage;
    return fixtureEnvelope({relationship_analysis:value,analysis_review:{approved:true,issues:[]},communication_plan:plan(),
      guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}}[stage]);
  });
  const result=await model.respond(context(),memory());
  assert.equal(result.relationship_memory.patient[0].interpretation,'이용자가 대상자에 관해 보고한 답변 원문:\n“밤에 계획표를 고쳐요”');
  assert.deepEqual(result.relationship_memory.patient[0].evidence,[ref()]);
  const ctx=context();ctx.relationship_state=result.relationship_memory;
  assert.equal(JSON.stringify(relationshipStateRequest(ctx,result.patient_state).data).includes('불안 증세'),false);
});


test('identical interpretations cannot be copied between dynamics, strengths and boundaries',()=>{
  const value=analysis();value.relationship.strengths=[finding()];
  assert.throws(()=>validateRelationship(value,context()),{modelReason:'agent_duplicate_findings'});
});

test('an explicitly selected consultation goal cannot disappear from the spoken script',async()=>{
  const ctx=context();ctx.user_goal.desired_outcomes={...field('goal','상담이나 진료를 권하고 싶어요'),selected:[{meta:{t:'goal_treat'}}]};
  const model=gateway(body=>{
    const input=JSON.parse(body.messages[1].content);
    if(input.stage==='relationship_analysis')return fixtureEnvelope(analysis());
    if(input.stage==='analysis_review')return fixtureEnvelope({approved:true,issues:[]});
    if(input.stage==='communication_plan')return fixtureEnvelope(plan());
    if(input.stage==='guide_quality')return envelope({improvements:[]});
    assert.equal(input.stage,'guide_write');return fixtureEnvelope(guide());
  });
  await assert.rejects(model.respond(ctx,memory()),{modelReason:'agent_goal_missing'});
});


test('an unreported clinical or personality label cannot replace a cited observation',()=>{
  for(const label of ['완벽주의적 성향','강박적인 행동','수면 장애']) {
    const value=analysis();value.relationship.dynamics[0].interpretation=label+'이 있어 보입니다.';
    assert.throws(()=>validateRelationship(value,context()),{modelReason:'agent_unreported_label'});
    const mem=relationshipMemory();mem.patient[0].interpretation=label+'이 있어 보입니다.';
    assert.throws(()=>validateRelationshipMemory(mem,context()),{modelReason:'agent_unreported_label'});
  }
  const ctx=context();ctx.patient.fields.mood=field('mood','본인이 강박 진단을 받았다고 말했어요');
  const value=analysis();value.relationship.dynamics[0]={interpretation:'본인이 강박 진단을 받았다고 전해졌습니다.',evidence:[{subject:'patient',question_id:'mood',quote:ctx.patient.fields.mood.text}],certainty:'tentative'};
  assert.doesNotThrow(()=>validateRelationship(value,ctx));
});

test('STATE retries unsupported labels with literal reports and keeps the failed attempt without narrowing later calls',async()=>{
  const ctx=context();ctx.latest_answer={subject:'supporter',question_id:'feeling'};
  let calls=0;const trace=[];
  const model=stateGateway((body,input)=>{
    const raw=stateDraft(ctx),schema=input.output_schema;
    if(input.stage==='state_observations')return envelope(observationPayload(raw));
    assert.equal(input.stage,'relationship_memory');calls++;
    if(calls===1)raw.relationship_memory.patient=[{...finding(),interpretation:'완벽주의 성향이 있어요.'}];
    else if(calls===2){
      const memorySchema=schema.properties.relationship_memory.properties;
      assert.equal(memorySchema.relationship.maxItems,0);
      assert.deepEqual(memorySchema.patient.items.properties.certainty.enum,['reported']);
      assert.equal(Object.hasOwn(memorySchema.patient.items.properties,'interpretation'),false);
      assert.ok(body.messages[0].content.includes('이전 가설을 사실로 바꾸지'));
    }else{
      assert.equal(schema.properties.relationship_memory.properties.relationship.maxItems,2);
      raw.relationship_memory.relationship=[finding()];
    }
    return envelope({relationship_memory:raw.relationship_memory});
  });
  model.diagnosticLogger=entry=>trace.push(entry);
  const recovered=await model.updateState(ctx);
  assert.equal(calls,2);
  assert.deepEqual(trace.filter(row=>row.generation==='relationship_memory').map(row=>row.reason),['agent_unreported_label','success']);
  assert.equal(recovered.relationship_memory.relationship.length,0);
  assert.ok(recovered.patient_state.facts.some(fact=>fact.subject==='supporter'&&fact.quote==='무력하고 걱정돼요'));
  assert.equal(JSON.stringify(recovered).includes('완벽주의'),false);
  const next=await model.updateState(ctx);
  assert.deepEqual(next.relationship_memory.relationship,[finding()]);
});

test('literal STATE recovery still rejects ignored schema constraints and fabricated source quotes',async()=>{
  for(const invalidRetry of ['hypothesis','quote']){
    let calls=0;
    const model=stateGateway((body,input)=>{
      const raw=stateDraft();
      if(input.stage==='state_observations')return envelope(observationPayload(raw));
      calls++;
      if(calls===1)raw.relationship_memory.patient=[{...finding(),interpretation:'강박적인 행동이에요.'}];
      else if(invalidRetry==='hypothesis')raw.relationship_memory.relationship=[finding()];
      else raw.relationship_memory.patient[0].evidence[0].quote='원문에 없는 답변';
      return envelope({relationship_memory:raw.relationship_memory});
    });
    await assert.rejects(model.updateState(context()),{modelReason:'agent_schema'});
    assert.equal(calls,3);
  }
});

test('a JSON failure during literal STATE recovery retains the reduced schema and empty evidence groups',async()=>{
  const ctx=context();ctx.supporter.fields={};
  let calls=0;const trace=[];
  const model=stateGateway((body,input)=>{
    const raw=stateDraft(ctx);
    if(input.stage==='state_observations')return envelope(observationPayload(raw));
    calls++;
    if(calls===1)raw.relationship_memory.patient=[{...finding(),interpretation:'강박적인 행동이에요.'}];
    else{
      const memorySchema=input.output_schema.properties.relationship_memory.properties;
      assert.equal(memorySchema.supporter.maxItems,0);
      assert.equal(memorySchema.relationship.maxItems,0);
      assert.deepEqual(memorySchema.patient.items.properties.certainty.enum,['reported']);
      if(calls===2)return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{invalid'}}]}));
    }
    return envelope({relationship_memory:raw.relationship_memory});
  });
  model.diagnosticLogger=entry=>trace.push(entry);
  const result=await model.updateState(ctx);
  assert.equal(calls,3);
  assert.deepEqual(trace.filter(row=>row.generation==='relationship_memory').map(row=>row.reason),['agent_unreported_label','content_json','success']);
  assert.deepEqual(result.relationship_memory.supporter,[]);
  assert.deepEqual(result.relationship_memory.relationship,[]);
});


for(const marker of ['(줄바꿈)','(빈 줄)'])test('a generated '+marker+' marker becomes an actual paragraph before review and storage',async()=>{
  const draft=guide();draft.guide.script+=' '+marker+' 편한 때 말해 줘.';
  draft.guide.next+=' '+marker+' 편한 시간을 함께 정해 보세요.';
  const expected=Object.fromEntries(['script','next'].map(field=>[field,draft.guide[field].replace(' '+marker+' ','\n\n')]));
  const model=gateway(body=>{
    const input=JSON.parse(body.messages[1].content);
    if(input.stage==='relationship_analysis')return fixtureEnvelope(analysis());
    if(input.stage==='analysis_review')return fixtureEnvelope({approved:true,issues:[]});
    if(input.stage==='communication_plan')return fixtureEnvelope(plan());
    if(input.stage==='guide_write')return fixtureEnvelope(draft);
    for(const field of ['script','next'])assert.equal(input.data.guide[field],expected[field]);
    return fixtureEnvelope(input.stage==='guide_quality'?{improvements:[]}:{approved:true,issues:[]});
  });
  const result=await model.respond(context(),memory());
  for(const field of ['script','next'])assert.equal(result.guide[field],expected[field]);
  for(const input of model.transportInputs.filter(input=>/^(?:speech|support)_review/u.test(input.stage))) {
    for(const field of ['script','next'])if(input.data.guide?.[field]!==undefined)assert.equal(input.data.guide[field],expected[field]);
  }
});

test('canonical summaries contain only actor-labelled literal observations and retain their source references',()=>{
  const ctx=context(),draft=draftAnalysis();
  ctx.patient.fields.long=field('long','가'.repeat(1000));
  ctx.patient.fields.other=field('other','나'.repeat(1000));
  draft.observations.patient=[{subject:'patient',question_id:'long',quote:ctx.patient.fields.long.text},
    {subject:'patient',question_id:'other',quote:ctx.patient.fields.other.text}];
  const result=canonicalRelationship(draft,ctx);
  assert.equal(result.patient_summary,'대상자에 관한 이용자 답변 원문:\n“'+'가'.repeat(1000)+'”\n“'+'나'.repeat(1000)+'”');
  assert.equal(result.supporter_summary,'이용자 자신의 상황에 관한 답변 원문:\n“무력하고 걱정돼요”');
  assert.deepEqual(result.observations,draft.observations);
  assert.deepEqual(result.relationship,draft.relationship);
  assert.deepEqual(validateRelationship(result,ctx),result);
  assert.ok(result.patient_summary.length>2000&&result.patient_summary.length<=relationshipSchema.properties.patient_summary.maxLength);
  ctx.patient.fields.mood=field('mood','본인이 강박 진단을 받았다고 말했어요');
  const reported=draftAnalysis();reported.relationship.dynamics=[];
  reported.observations.patient=[{subject:'patient',question_id:'mood',quote:ctx.patient.fields.mood.text}];
  assert.doesNotThrow(()=>canonicalRelationship(reported,ctx));
});

test('draft observations reject fabricated, cross-actor, nonanswered and stale source references',()=>{
  const fabricated=draftAnalysis();fabricated.observations.patient[0].quote='생각 때문에 잠을 못 잔다고 해요';
  assert.throws(()=>validateRelationshipDraft(fabricated,context()),{modelReason:'agent_evidence'});
  const crossActor=draftAnalysis();crossActor.observations.supporter=[ref()];
  assert.throws(()=>validateRelationshipDraft(crossActor,context()),{modelReason:'agent_schema'});
  for (const status of ['unknown','refused','skipped','auto_skipped']) {
    const ctx=context();ctx.supporter.fields.feeling.status=status;
    assert.throws(()=>validateRelationshipDraft(draftAnalysis(),ctx),{modelReason:'agent_evidence'});
  }
  const corrected=context();corrected.supporter.fields.feeling=field('feeling','전보다 편안해졌어요');
  assert.throws(()=>validateRelationshipDraft(draftAnalysis(),corrected),{modelReason:'agent_evidence'});
});

test('name-only observations are rejected and generation choices keep observation actors separate',()=>{
  const draft=draftAnalysis();draft.observations.patient=[{subject:'patient',question_id:'name',quote:'지민'}];
  assert.throws(()=>validateRelationshipDraft(draft,context()),{modelReason:'agent_observation_name_only'});
  const schema=groundedEvidenceSchema(relationshipDraftSchema,context());
  for (const subject of ['patient','supporter']) {
    const choices=schema.properties.observations.properties[subject].items.enum;
    assert.ok(choices.length);
    assert.ok(choices.every(ref=>ref.subject===subject&&ref.question_id!=='name'));
  }
});

test('legacy and derived canonical reports are strict and altered summaries cannot bypass observation evidence',()=>{
  assert.deepEqual(validateRelationship(analysis(),context()),analysis());
  const result=canonicalRelationship(draftAnalysis(),context());
  const inventedSummary=structuredClone(result);inventedSummary.patient_summary='걱정 때문에 밤에 계획표를 고쳐요';
  assert.throws(()=>validateRelationship(inventedSummary,context()),{modelReason:'agent_observation_summary'});
  const alteredReference=structuredClone(result);alteredReference.observations.supporter[0].quote='걱정돼요';
  assert.throws(()=>validateRelationship(alteredReference,context()),{modelReason:'agent_observation_summary'});
  const fabricatedReference=structuredClone(result);fabricatedReference.observations.supporter[0].quote='조금도 걱정되지 않아요';
  assert.throws(()=>validateRelationship(fabricatedReference,context()),{modelReason:'agent_evidence'});
  for (const value of [analysis(),result]) {
    value.extra_summary='새 원인';
    assert.throws(()=>validateRelationship(value,context()),{modelReason:'agent_schema'});
  }
});

test('analysis generation accepts only the observation draft and rejects free-summary outputs',async()=>{
  for (const value of [analysis(),canonicalRelationship(draftAnalysis(),context())]) {
    assert.throws(()=>validateRelationshipDraft(value,context()),{modelReason:'agent_schema'});
  }
  const extraSummary=draftAnalysis();extraSummary.patient_summary='이용자가 걱정해서 상대가 피합니다';
  assert.throws(()=>validateRelationshipDraft(extraSummary,context()),{modelReason:'agent_schema'});
  let calls=0;
  const model=gateway(body=>{
    calls++;
    const input=JSON.parse(body.messages[1].content);
    assert.equal(input.stage,'relationship_analysis');
    assert.equal(Object.hasOwn(body.response_format.json_schema.schema.properties,'patient_summary'),false);
    assert.equal(Object.hasOwn(body.response_format.json_schema.schema.properties,'supporter_summary'),false);
    assert.ok(body.response_format.json_schema.schema.properties.observations);
    return envelope(analysis());
  });
  await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_schema'});
  assert.equal(calls,3);
});

test('actors without substantive answered evidence get empty observations and explicit unconfirmed summaries',()=>{
  const ctx=context();ctx.patient.fields={name:field('name','지민')};ctx.supporter.fields={};
  const draft=draftAnalysis();draft.observations={patient:[],supporter:[]};
  draft.relationship={label:'확인되지 않음',supporter_role:'확인되지 않음',dynamics:[],strengths:[],boundaries:[]};
  const result=canonicalRelationship(draft,ctx);
  assert.equal(result.patient_summary,'대상자의 상태에 관한 답변 근거는 아직 확인되지 않았어요.');
  assert.equal(result.supporter_summary,'이용자 자신의 상황에 관한 답변 근거는 아직 확인되지 않았어요.');
  assert.deepEqual(result.observations,{patient:[],supporter:[]});
  const schema=groundedEvidenceSchema(relationshipDraftSchema,ctx);
  assert.equal(schema.properties.observations.properties.patient.maxItems,0);
  assert.equal(schema.properties.observations.properties.supporter.maxItems,0);
});

test('urgent guide writing rejects delayed-help actions instead of overwriting them',async()=>{
  const ctx=riskContext();
  const mutations=[draft=>draft.guide.script='민수야, 동의하면 나중에 도움을 요청할게.',
    draft=>draft.guide.doList=['상대가 답할 때까지 기다렸다가 도움을 요청하세요.'],
    draft=>draft.guide.avoid=['비밀을 지키지 않는 말은 피하세요.'],
    draft=>draft.guide.next='내일 다시 대화한 뒤 도움을 요청하세요.',
    draft=>draft.guide.care.tips=['혼자 책임지고 지켜 주세요.']];
  for(const mutate of mutations) {
    const candidate=urgentGuide(ctx.name_index);mutate(candidate);
    const model=gateway(body=>{
      const stage=JSON.parse(body.messages[1].content).stage;
      if(stage==='relationship_analysis')return envelope(riskAnalysis(ctx));
      if(stage==='analysis_review')return envelope({approved:true,issues:[]});
      if(stage==='communication_plan')return envelope(plan());
      assert.equal(stage,'guide_write');assertUrgentSchema(body,ctx.name_index);return envelope(candidate);
    });
    await assert.rejects(model.respond(ctx,memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_urgent_action'});
  }
});

test('a generated exact urgent contract is still quality-reviewed and critically approved',async()=>{
  const ctx=riskContext(),stages=[],candidate=urgentGuide(ctx.name_index);
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;stages.push(stage);
    if(stage==='relationship_analysis')return envelope(riskAnalysis(ctx));
    if(stage==='analysis_review'||stage==='guide_review')return envelope({approved:true,issues:[]});
    if(stage==='communication_plan')return envelope(plan());
    if(stage==='guide_quality')return envelope({improvements:[]});
    assert.equal(stage,'guide_write');assertUrgentSchema(body,ctx.name_index);return envelope(candidate);
  });
  const result=await model.respond(ctx,memory());
  assert.deepEqual(result.guide,candidate.guide);
  assert.equal(result.agent.safety_guidance_version,'immediate-help-v1');
  assert.equal(result.agent.reviewed,true);assert.equal(result.agent.quality_reviewed,true);
  assert.deepEqual(stages,['relationship_analysis','analysis_review','communication_plan','guide_write','guide_quality','guide_review']);
  assert.equal(result.guide.care.feel,guide().guide.care.feel);
});

test('urgent refinement and repair receive fresh fixed-action schemas and preserve the generated contract',async()=>{
  const ctx=riskContext(),stages=[],candidate=urgentGuide(ctx.name_index);
  const revised=urgentGuide(ctx.name_index);revised.guide.care.feel='무력하고 걱정된다는 마음을 들려주셨어요.';
  const outputs={relationship_analysis:riskAnalysis(ctx),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
    guide_write:candidate,guide_quality:{improvements:[{field:'care',reason:'이용자 감정을 더 직접 표현하기',repair:'보고한 걱정과 무력감을 담으세요.'}]},
    guide_refine:revised,guide_review:{approved:false,issues:[{field:'care',reason:'이용자 감정을 분명히 쓰세요.',repair:'보고한 감정만 쓰세요.'}]},
    guide_repair:revised,guide_review_after_repair:{approved:true,issues:[]}};
  const model=gateway(body=>{
    const input=JSON.parse(body.messages[1].content),stage=input.stage;stages.push(stage);
    if(['guide_write','guide_refine','guide_repair'].includes(stage))assertUrgentSchema(body,ctx.name_index);
    if(stage==='guide_refine')assert.deepEqual(body.response_format.json_schema.schema.properties.guide.properties.top.enum,[candidate.guide.top]);
    if(stage==='guide_quality') {
      assert.deepEqual(body.response_format.json_schema.schema.properties.improvements.items.properties.field.enum,['care']);
      assert.deepEqual(input.data.review_scope.guide_fields,['care.feel']);
      assert.equal(input.data.review_scope.include_analysis,false);
    }
    if(stage==='guide_review'||stage==='guide_review_after_repair') {
      assert.deepEqual(body.response_format.json_schema.schema.properties.issues.items.properties.field.enum,['relationship_analysis','care','top']);
      assert.deepEqual(input.data.review_scope.guide_fields,['care.feel','top']);
      assert.equal(input.data.review_scope.include_analysis,true);
    }
    return envelope(outputs[stage]);
  });
  const result=await model.respond(ctx,memory());
  assert.deepEqual(stages,Object.keys(outputs));assert.deepEqual(result.guide,revised.guide);
  assert.deepEqual(result.guide.care.tips,candidate.guide.care.tips);
});

test('unsafe urgent refined or repaired outputs cannot reach an approved result',async()=>{
  const ctx=riskContext();
  for(const target of ['guide_refine','guide_repair']) {
    const candidate=urgentGuide(ctx.name_index),unsafe=urgentGuide(ctx.name_index);
    unsafe.guide.next='상대가 동의하면 나중에 지역 응급기관에 연락하세요.';
    const model=gateway(body=>{
      const stage=JSON.parse(body.messages[1].content).stage;
      if(stage==='relationship_analysis')return envelope(riskAnalysis(ctx));
      if(stage==='analysis_review')return envelope({approved:true,issues:[]});
      if(stage==='communication_plan')return envelope(plan());
      if(stage==='guide_write'){assertUrgentSchema(body,ctx.name_index);return envelope(candidate);}
      if(stage==='guide_quality')return envelope({improvements:target==='guide_refine'
        ?[{field:'care',reason:'보고한 감정을 표현하기',repair:'걱정과 무력감을 담으세요.'}]:[]});
      if(stage==='guide_review')return envelope({approved:false,issues:[{field:'care',reason:'보고한 감정을 표현하기',repair:'원래 걱정을 담으세요.'}]});
      assert.equal(stage,target);assertUrgentSchema(body,ctx.name_index);return envelope(unsafe);
    });
    await assert.rejects(model.respond(ctx,memory()),{modelReason:'agent_urgent_action'});
  }
});

test('denied risk keeps ordinary generated guidance and omits urgent-action metadata',async()=>{
  const ctx=riskContext('자해할 생각은 전혀 없다고 말했어요.');
  const outputs={relationship_analysis:riskAnalysis(ctx,false),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
    guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}};
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;
    if(stage==='guide_write')for(const key of ['script','doList','avoid','next'])assert.equal(Object.hasOwn(body.response_format.json_schema.schema.properties.guide.properties[key],'enum'),false);
    return envelope(outputs[stage]);
  });
  const result=await model.respond(ctx,memory());
  assert.deepEqual(result.guide,guide().guide);assert.equal(Object.hasOwn(result.agent,'safety_guidance_version'),false);
});

test('urgent actions omit placeholder and unverified names',async()=>{
  for(const name of [null,undefined,{alias:''}])assert.equal(urgentGuideActions(name).script.startsWith('지금 안전이'),true);
  const ctx=riskContext();ctx.patient.alias='그분';ctx.name_index={alias:'모르는 이름',source_question_id:'name',quote:'지민'};
  const candidate=urgentGuide(null);
  const outputs={relationship_analysis:riskAnalysis(ctx),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
    guide_write:candidate,guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}};
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;
    if(stage==='guide_write')assertUrgentSchema(body,null);
    return envelope(outputs[stage]);
  });
  const result=await model.respond(ctx,memory());
  assert.equal(result.guide.script.startsWith('지금 안전이'),true);
  assert.equal(result.name_index,null);
});

test('late repaired urgency changes recalculate action constraints and final metadata in either direction',async()=>{
  for(const initialUrgent of [false,true]) {
    const ctx=riskContext(initialUrgent?'자해할 생각은 전혀 없다고 말했어요.':undefined),repairedUrgent=!initialUrgent;
    const original=initialUrgent?urgentGuide(ctx.name_index):guide(),repaired=repairedUrgent?urgentGuide(ctx.name_index):guide();
    const stages=[];
    const outputs={relationship_analysis:riskAnalysis(ctx,initialUrgent),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
      guide_write:original,guide_quality:{improvements:[]},guide_review:{approved:false,issues:[{field:'relationship_analysis',reason:'현재 위험의 판단을 원문으로 수정하세요.',repair:'위험의 부정과 현재 시점을 반영하세요.'}]},
      analysis_repair_after_guide_review:riskAnalysis(ctx,repairedUrgent),analysis_review_after_guide_review_repair:{approved:true,issues:[]},
      communication_plan_after_analysis_repair:plan(),guide_write_after_analysis_repair:repaired,
      guide_quality_after_analysis_repair:{improvements:[]},guide_review_after_analysis_repair:{approved:true,issues:[]}};
    const model=gateway(body=>{
      const stage=JSON.parse(body.messages[1].content).stage;stages.push(stage);
      if(stage==='guide_write'||stage==='guide_write_after_analysis_repair') {
        const urgent=stage==='guide_write'?initialUrgent:repairedUrgent;
        if(urgent)assertUrgentSchema(body,ctx.name_index);
        else assert.equal(Object.hasOwn(body.response_format.json_schema.schema.properties.guide.properties.script,'enum'),false);
      }
      if(stage.startsWith('guide_quality')||stage.startsWith('guide_review')) {
        const urgent=stage.endsWith('_after_analysis_repair')?repairedUrgent:initialUrgent,quality=stage.startsWith('guide_quality');
        const fields=body.response_format.json_schema.schema.properties[quality?'improvements':'issues'].items.properties.field.enum;
        const data=JSON.parse(body.messages[1].content).data;
        if(urgent) {
          assert.deepEqual(fields,quality?['care']:['relationship_analysis','care','top']);
          assert.deepEqual(data.review_scope.guide_fields,quality?['care.feel']:['care.feel','top']);
        } else {
          assert.ok(fields.includes('script')&&fields.includes('next'));
          assert.equal(Object.hasOwn(data,'review_scope'),false);
        }
      }
      return envelope(outputs[stage]);
    });
    const result=await model.respond(ctx,memory());
    assert.deepEqual(stages,Object.keys(outputs));assert.deepEqual(result.guide,repaired.guide);
    assert.equal(Object.hasOwn(result.agent,'safety_guidance_version'),repairedUrgent);
    assert.equal(result.relationship_analysis.safety.urgent,repairedUrgent);
  }
});

test('urgent quality suggestions cannot request changes to fixed actions',async()=>{
  const ctx=riskContext(),candidate=urgentGuide(ctx.name_index);
  for(const field of ['script','doList','avoid','next']) {
    const model=gateway(body=>{
      const input=JSON.parse(body.messages[1].content),stage=input.stage;
      if(stage==='relationship_analysis')return envelope(riskAnalysis(ctx));
      if(stage==='analysis_review')return envelope({approved:true,issues:[]});
      if(stage==='communication_plan')return envelope(plan());
      if(stage==='guide_write')return envelope(candidate);
      assert.equal(stage,'guide_quality');
      assert.deepEqual(body.response_format.json_schema.schema.properties.improvements.items.properties.field.enum,['care']);
      assert.deepEqual(input.data.review_scope.fixed_action_fields,['script','doList','avoid','next','care.tips']);
      assert.equal(input.data.review_scope.fixed_action_version,'immediate-help-v1');
      return envelope({improvements:[{field,reason:'고정 행동 문장을 바꾸고 싶어요.',repair:'상대 동의를 먼저 기다리도록 바꾸세요.'}]});
    });
    await assert.rejects(model.respond(ctx,memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  }
});

test('urgent critical reviews cannot reinterpret fixed actions as guide errors before or after repair',async()=>{
  const ctx=riskContext(),candidate=urgentGuide(ctx.name_index);
  for(const target of ['guide_review','guide_review_after_repair']) for(const field of ['script','doList','avoid','next']) {
    const model=gateway(body=>{
      const input=JSON.parse(body.messages[1].content),stage=input.stage;
      if(stage==='relationship_analysis')return envelope(riskAnalysis(ctx));
      if(stage==='analysis_review')return envelope({approved:true,issues:[]});
      if(stage==='communication_plan')return envelope(plan());
      if(stage==='guide_write'||stage==='guide_repair')return envelope(candidate);
      if(stage==='guide_quality')return envelope({improvements:[]});
      assert.deepEqual(body.response_format.json_schema.schema.properties.issues.items.properties.field.enum,['relationship_analysis','care','top']);
      assert.equal(input.data.review_scope.include_analysis,true);
      if(stage!==target) {
        assert.equal(stage,'guide_review');
        return envelope({approved:false,issues:[{field:'care',reason:'이용자의 감정을 명확히 쓰세요.',repair:'보고한 감정만 담으세요.'}]});
      }
      return envelope({approved:false,issues:[{field,reason:'고정 도움 요청 문장을 사건으로 읽었어요.',repair:'도움 요청을 다음 대화로 미루세요.'}]});
    });
    await assert.rejects(model.respond(ctx,memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  }
});

test('urgent quality refinement can change care feelings but cannot change the topic classification',async()=>{
  const ctx=riskContext(),candidate=urgentGuide(ctx.name_index),changed=urgentGuide(ctx.name_index);
  changed.guide.top='불안';
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;
    if(stage==='relationship_analysis')return envelope(riskAnalysis(ctx));
    if(stage==='analysis_review')return envelope({approved:true,issues:[]});
    if(stage==='communication_plan')return envelope(plan());
    if(stage==='guide_write')return envelope(candidate);
    if(stage==='guide_quality')return envelope({improvements:[{field:'care',reason:'원문 감정 표현을 다듬기',repair:'보고한 걱정을 담으세요.'}]});
    assert.equal(stage,'guide_refine');
    assert.deepEqual(body.response_format.json_schema.schema.properties.guide.properties.top.enum,['통합']);
    return envelope(changed);
  });
  await assert.rejects(model.respond(ctx,memory()),{modelReason:'agent_schema'});
});


test('an unsupported label retry receives the exact rejected claim and source rather than a generic schema error',async()=>{
  let attempts=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages[1].content),stage=input.stage;
    if(stage==='relationship_analysis'){
      attempts++;
      if(attempts===1){const bad=analysis();bad.relationship.dynamics[0].interpretation='가능한 해석: 완벽주의일 수 있어요.';return fixtureEnvelope(bad);}
      assert.match(input.validation_feedback,/완벽주의/);assert.match(input.validation_feedback,/밤에 계획표를 고쳐요/);
      return fixtureEnvelope(analysis());
    }
    if(stage==='communication_plan')return envelope(plan());
    if(stage==='guide_quality')return envelope({improvements:[]});
    return fixtureEnvelope(stage.includes('review')?{approved:true,issues:[]}:guide());
  });
  await model.respond(context(),memory());assert.equal(attempts,2);
});

test('speech is reviewed separately and rejected wording is repaired before the final review',async()=>{
  const stages=[];
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;stages.push(stage);
    if(stage==='relationship_analysis')return fixtureEnvelope(analysis());
    if(stage==='communication_plan')return envelope(plan());
    if(stage==='guide_quality')return envelope({improvements:[]});
    if(stage.includes('review'))return envelope({approved:true,issues:[]});
    return envelope(guide());
  },{speechReview:input=>{
    stages.push(input.stage);
    assert.equal(input.data.script,guide().guide.script);
    return input.stage==='speech_review'
      ?{approved:false,issues:[{field:'script',reason:'발화문을 더 자연스럽게 해주세요.',repair:'직접 건넬 말을 쓰세요.'}]}
      :{approved:true,issues:[]};
  }});
  await model.respond(context(),memory());
  assert.deepEqual(stages.slice(-4),['speech_review','guide_repair','speech_review_after_repair','guide_review_after_repair']);
});

test('claim review covers action cards as well as the script and repairs preserve other validated cards',async()=>{
  const model=gateway(body=>{
    const input=JSON.parse(body.messages[1].content),stage=input.stage;
    if(stage==='relationship_analysis')return fixtureEnvelope(analysis());
    if(stage==='communication_plan')return envelope(plan());
    if(stage==='guide_quality')return envelope({improvements:[]});
    if(stage==='guide_repair'){
      assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties),['doList']);
      const repaired=guide();repaired.guide.doList=['어떤 도움이 필요한지 먼저 물어보세요.'];return envelope(repaired);
    }
    return fixtureEnvelope(stage.includes('review')?{approved:true,issues:[]}:guide());
  },{speechReview:input=>{
    assert.deepEqual(new Set(input.data.claims.map(claim=>claim.field)),new Set(['script','doList','avoid','next','care']));
    return input.stage==='speech_review'?{approved:false,issues:[{field:'doList',reason:'마음을 아는 것처럼 말하지 마세요.',repair:'어떤 도움이 필요한지 물어보세요.'}]}:{approved:true,issues:[]};
  }});
  const result=await model.respond(context(),memory());
  assert.equal(result.guide.script,guide().guide.script);
  assert.deepEqual(result.guide.doList,['어떤 도움이 필요한지 먼저 물어보세요.']);
});

test('card role and agreement rejections repair the affected cards and keep the shared contract through quality and final reviews',async()=>{
  const ctx=context();
  ctx.patient.fields.proposal=field('proposal','상대가 금요일에 잠깐 통화하자고 했어요.');
  ctx.supporter.fields.availability=field('availability','저는 금요일에 15분 정도 시간이 나요.');
  const initial=guide(),badScript='상황을 들려주셨네요. 상대에게 어떻게 말할지 같이 정리해 볼까요?';
  initial.guide.script=badScript;
  initial.guide.care.tips=['서로 약속한 15분의 통화를 지키세요.'];
  const fixed=guide();fixed.guide.care.tips=['가능한 시간을 알리고 상대에게도 괜찮은지 확인해 보세요.'];
  const edited=structuredClone(fixed);edited.guide.script+=' 원하면 편한 때 말해 줘.';
  const repairs=[],rechecks=[];
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content),stage=input.stage;
    if(stage==='guide_repair_card_script_1'||stage==='guide_repair_card_care_1') {
      const field=stage==='guide_repair_card_script_1'?'script':'care';repairs.push(field);
      return envelope({[field]:fixed.guide[field]});
    }
    if(stage==='guide_quality') {
      return envelope({improvements:[{field:'script',reason:'거절해도 된다는 선택을 명확히 하세요.',repair:'마지막에 편한 때 답할 수 있다는 선택을 남기세요.'}]});
    }
    if(stage==='guide_refine') {
      return envelope(edited);
    }
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
      guide_write:initial,guide_review:{approved:true,issues:[]}}[stage]);
  },{speechWrite:()=>({script:badScript}),cardWrite:input=>{
    const key=Object.keys(input.output_schema.properties)[0];return {[key]:initial.guide[key]};
  },cardReview:input=>{
    const field=input.data.review_scope.guide_fields[0],bad=field==='script'?badScript:field==='care'?initial.guide.care.tips[0]:null;
    const rejected=input.data.claims.filter(c=>field==='script'?input.data.guide.script===bad:c.claim===bad);
    if(!rejected.length){if(['script','care'].includes(field))rechecks.push(field);return {approved:true,issues:[]};}
    const reason=field==='script'?'앱에서 이용자로 향하는 상담 발화이며 supporter에서 patient로 향하지 않습니다.':
      '통화 제안과 이용자의 가능 시간만으로 상호 합의를 확정했습니다.';
    return {approved:false,issues:[{field,reason,repair:field==='script'?'이용자가 상대에게 직접 건넬 발화로 수정하세요.':'가능한 시간을 먼저 알리고 상대의 선택을 확인하는 안내로 수정하세요.'}],
      audits:input.data.claims.map(c=>({id:c.id,verdict:rejected.includes(c)?'unsupported':'supported',reason:rejected.includes(c)?reason:'원문과 역할이 일치합니다.'}))};
  },qualityCheck:()=>({improvements:[]}),speechReview:()=>({approved:true,issues:[]})});
  const result=await model.respond(ctx,memory());
  assert.deepEqual(result.guide,edited.guide);
  assert.deepEqual(new Set(repairs),new Set(['script','care']));
  assert.ok(rechecks.includes('script')&&rechecks.includes('care'));
  const inputFor=stage=>model.transportInputs.find(input=>input.stage===stage);
  for(const field of ['script','care']) {
    const input=inputFor('guide_repair_card_'+field+'_1');
    assert.equal(input.data.issues[0].field,field);
    assert.deepEqual(input.data.current,initial.guide[field]);
    assert.deepEqual(input.data.answers,agentContext(ctx));
    assert.ok(input.data.review.audits.some(a=>a.verdict==='unsupported'));
  }
  assert.deepEqual(inputFor('guide_quality').data.guide,fixed.guide);
  assert.deepEqual(inputFor('guide_refine').data.draft,fixed.guide);
  assert.deepEqual(inputFor('guide_refine').output_schema.properties.guide.properties.care.enum,[fixed.guide.care]);
  assert.deepEqual(inputFor('guide_quality_check').data.guide,edited.guide);
  assert.deepEqual(inputFor('speech_review').data.guide,edited.guide);
  const required=['guide_write','speech_opening','speech_listening','speech_offer','speech_write','card_care',
    'speech_review_card_script','speech_review_card_care','support_review_card_care_after_repair_1',
    'guide_repair_card_script_1','guide_repair_card_care_1','guide_quality','guide_refine','guide_quality_check',
    'speech_review','support_review','guide_review'];
  for(const stage of required) {
    const index=model.transportStages.indexOf(stage);assert.notEqual(index,-1,stage);
    assert.ok(model.transportPrompts[index].includes(CARD_ROLE_CONTRACT),stage);
  }
});

test('rejected claim audits must identify the matching repair field and retain their exact feedback',async()=>{
  for(const reviewStage of ['speech_review','support_review']){
    const target=reviewStage==='speech_review'?'doList':'care',wrong=reviewStage==='speech_review'?'script':'next';
    const auditReason='특정 원문 근거를 수정 단계에서도 대조해야 합니다.';
    const base={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]}};
    let attempts=0,repairs=0;
    const review=input=>{
      if(input.stage===reviewStage){
        attempts++;
        if(attempts===2)assert.match(input.validation_feedback,/agent_review_targets|missing_issue_fields/u);
        return {approved:false,issues:[{field:attempts===1?wrong:target,reason:'선택권을 확인해야 합니다.',repair:'먼저 원하는지 물어보세요.'}],
          audits:input.data.claims.map(claim=>({id:claim.id,verdict:claim.id===target+'.0'?'unsupported':'supported',reason:claim.id===target+'.0'?auditReason:'현재 원문과 맞습니다.'}))};
      }
      assert.equal(input.data.revision.previous_review.audits[0].reason,auditReason);
      assert.deepEqual(input.data.revision.changes.map(change=>change.field),[target]);
      return {approved:true,issues:[]};
    };
    const model=gateway(body=>{
      const input=JSON.parse(body.messages.at(-1).content);
      if(input.stage.startsWith('guide_repair')){
        repairs++;assert.equal(input.data.field,target);
        assert.ok(input.data.review.claims.every(claim=>claim.field===target));
        assert.equal(input.data.review.audits.find(audit=>audit.id===target+'.0').reason,auditReason);
        return envelope({[target]:guide().guide[target]});
      }
      return fixtureEnvelope(input.stage.startsWith('guide_review')?{approved:true,issues:[]}:base[input.stage]);
    },{[reviewStage==='speech_review'?'speechReview':'supportReview']:review});
    const result=await model.respond(context(),memory());
    assert.equal(attempts,2);assert.equal(repairs,1);assert.equal(result.agent.reviewed,true);
  }
});

test('all five rejected guide fields can be repaired without exceeding the review schema',async()=>{
  const fields=['script','doList','avoid','next','care'],repaired=[];
  const base={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]}};
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage.startsWith('guide_repair')){repaired.push(input.data.field);return envelope({[input.data.field]:guide().guide[input.data.field]});}
    return fixtureEnvelope(input.stage.startsWith('guide_review')?{approved:true,issues:[]}:base[input.stage]);
  },{speechReview:input=>{
    if(input.stage==='speech_review')return {approved:false,issues:fields.map(field=>({field,reason:'선택권이 빠졌습니다.',repair:'원하는지 먼저 확인하세요.'})),
      audits:input.data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason:'원문에 맞춰 선택권을 확인하세요.'}))};
    assert.deepEqual(input.data.revision.changes.map(change=>change.field),fields);
    return {approved:true,issues:[]};
  }});
  assert.equal((await model.respond(context(),memory())).agent.reviewed,true);
  assert.deepEqual(repaired,fields);
});

test('retained repair context cannot approve a still unsupported claim',async()=>{
  const base={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]}};
  let rechecks=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage.startsWith('guide_repair'))return envelope({doList:['원하는 도움이 무엇인지 먼저 물어보세요.']});
    return fixtureEnvelope(input.stage.startsWith('guide_review')?{approved:true,issues:[]}:base[input.stage]);
  },{speechReview:input=>{
    const initial=input.stage==='speech_review';
    if(!initial){
      rechecks++;
      assert.notDeepEqual(input.data.revision.changes[0].before,input.data.revision.changes[0].after);
      assert.equal(input.data.claims.find(claim=>claim.id==='doList.0').claim,'원하는 도움이 무엇인지 먼저 물어보세요.');
    }
    return {approved:!initial,issues:initial?[{field:'doList',reason:'선택권이 빠졌습니다.',repair:'먼저 원하는 도움을 물어보세요.'}]:[],
      audits:input.data.claims.map(claim=>({id:claim.id,verdict:claim.id==='doList.0'?'unsupported':'supported',reason:'현재 원문을 독립적으로 대조한 결과입니다.'}))};
  }});
  await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_claim_audit'});
  assert.equal(rechecks,3);
  assert.equal(model.transportStages.some(stage=>stage.startsWith('guide_review')),false);
});

test('guide repairs retain care sources and retrieve current-card and issue-specific evidence',async()=>{
  for(const target of ['care','doList','avoid']){
    const ctx=context();
    ctx.supporter.fields.resource=field('resource','트럼펫 연주.');
    ctx.patient.fields.current_scene=field('current_scene','첼로 연주.');
    ctx.patient.fields.issue_scene=field('issue_scene','오보에 연주.');
    for(let index=0;index<16;index++)ctx.supporter.fields['extra'+index]=field('extra'+index,'감정 마음 부담 무력 걱정 잠 갈등 변화 한계 방법 도움 대처 나누거나 기댈 지원 '+index);
    const candidate=guide();candidate.guide.doList=['첼로 연주 이야기를 해도 괜찮을지 먼저 물어보세요.'];
    const avoidDraft={...avoidExample,reason:'첼로 연주에 관한 대답도 재촉하지 마세요.'};
    candidate.guide.avoid=canonicalAvoidCard({avoid:[avoidDraft]},avoidStoredSchema()).avoid;
    candidate.guide.care.tips=['트럼펫을 불며 쉬어 보세요.'];
    const base={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:candidate,guide_quality:{improvements:[]}};
    let repairs=0;
    const model=gateway(body=>{
      const input=JSON.parse(body.messages.at(-1).content);
      if(input.stage.startsWith('guide_repair')){
        repairs++;
        const ids=new Set(input.data.retrieval.documents.map(row=>row.question_id));
        if(target==='care')assert.ok(ids.has('resource'));
        else {assert.ok(ids.has('current_scene'));assert.ok(ids.has('issue_scene'));}
        if(target==='avoid'){
          assert.equal(Object.hasOwn(input.data,'current'),false);assert.equal(Object.hasOwn(input.data,'review'),false);
          return envelope({avoid:[structuredClone(avoidExample)]});
        }
        return envelope({[target]:candidate.guide[target]});
      }
      return fixtureEnvelope(input.stage.startsWith('guide_review')?{approved:true,issues:[]}:base[input.stage]);
    },{cardWrite:input=>{
      const key=Object.keys(input.output_schema.properties)[0];
      return key==='avoid'?{avoid:[structuredClone(avoidDraft)]}:{[key]:candidate.guide[key]};
    },speechReview:input=>input.stage==='speech_review'?{approved:false,issues:[{field:target,reason:'오보에 연주 원문도 대조하세요.',repair:'현재 관찰을 조건부 제안으로 유지하세요.'}]}:{approved:true,issues:[]}});
    await model.respond(ctx,memory());assert.equal(repairs,1);
  }
});

test('a model approval cannot override an observed mind-reading failure in an action card',async()=>{
  for(const fixes of [true,false]){
    const model=gateway(body=>{
      const stage=JSON.parse(body.messages[1].content).stage;
      if(stage==='relationship_analysis')return fixtureEnvelope(analysis());
      if(stage==='communication_plan')return envelope(plan());
      if(stage==='guide_quality')return envelope({improvements:[]});
      if(stage.includes('review'))return envelope({approved:true,issues:[]});
      const draft=guide();
      if(!fixes||stage==='guide_write')draft.guide.doList=['“완벽하게 해내고 싶어서 애쓰고 있구나”라고 말해주세요.'];
      return envelope(draft);
    });
    if(fixes)assert.ok((await model.respond(context(),memory())).agent.stages.includes('guide_repair_card_doList_1'));
    else await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_speech_specific'});
  }
});

test('next narrator-promise detection preserves attributed supporter quotes and their original text',()=>{
  for(const next of [
    '원한다면 “제가 도와드릴 수 있는 일이 있을까요?”라고 물어보세요.',
    '"제가 자료 정리를 도와드릴 수 있어요."라고 제안하세요.',
    '‘저는 도와드릴 수 있는 부분을 함께 정하고 싶어요.’라고 말해보세요.',
    '「제가 도와드릴 수 있을까요?」라고 질문하세요.',
    '“제가 준비를 도와드릴 수 있을까요?” 또는 “제가 정리를 도와드릴 수 있을까요?”라고 물으며 필요한 일을 확인하세요.',
    '“제가 도와드릴 수 있는 일이 있을까요?” 혹은 “도움이 필요한 부분을 말씀해 주실래요?”라고 물으며 답을 들어보세요.',
  ]){
    const value=guide().guide;value.next=next;const before=structuredClone(value);
    const issues=knownSpeechIssues(value,context());
    assert.equal(issues.some(issue=>issue.reason==='안내자가 직접 도움을 수행하겠다는 약속이 섞였습니다.'),false,next);
    assert.deepEqual(value,before);
  }
});

test('next narrator promises remain visible outside attributed quotes or when the quoted speaker is the app',()=>{
  for(const next of [
    '제가 대신 예약을 도와드릴 수 있습니다.',
    '“제가 도와드릴 수 있을까요?”',
    '“제가 도와드릴 수 있을까요?”라고 물어보세요. 앱이 예약을 도와드릴 수 있습니다.',
    '“제가 도와드릴 수 있을까요?”라고 물어보세요. “제가 예약을 도와드릴 수 있습니다.”',
    '“말씨 앱이 예약을 도와드릴 수 있습니다.”라고 말해보세요.',
    '“제가 안내한 서비스가 예약을 도와드릴 수 있습니다.”라고 말해보세요.',
    '앱이 “제가 예약을 도와드릴 수 있습니다.”라고 말하며 절차를 안내합니다.',
    '“제가 도와드릴 수 있을까요?” 또는 “앱이 예약을 도와드릴 수 있습니다.”라고 물어보세요.',
    '“도와드릴 수 있습니다.”라고 전했습니다.',
    '“문제가 생기면 도와드릴 수 있습니다.”라고 말해보세요.',
  ]){
    const value=guide().guide;value.next=next;
    assert.ok(knownSpeechIssues(value,context()).some(issue=>issue.reason==='안내자가 직접 도움을 수행하겠다는 약속이 섞였습니다.'),next);
  }
});

test('attributed supporter speech remains subject to every other known content check',()=>{
  const value=guide().guide;
  value.next='“제가 도와드릴 수 있어요. 네 마음은 다 알고 있어요.”라고 말해보세요.';
  const issues=knownSpeechIssues(value,context());
  assert.equal(issues.some(issue=>issue.reason==='안내자가 직접 도움을 수행하겠다는 약속이 섞였습니다.'),false);
  assert.ok(issues.some(issue=>issue.field==='next'&&issue.reason==='대상자의 마음이나 행동 원인을 아는 것처럼 말합니다.'));
});

test('next repair can retain an attributed supporter question only after new independent reviews',async()=>{
  const next='상대가 원하면 “제가 도와드릴 수 있는 일이 있을까요?” 혹은 “필요한 준비를 함께 정해 볼까요?”라고 물어보세요.';
  const initial=guide();initial.guide.next='제가 대신 필요한 준비를 도와드릴 수 있습니다.';
  let repairs=0;const reviews=[],repairInputs=[];
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage.startsWith('guide_repair_card_next')){repairs++;repairInputs.push(input.data);return envelope({next});}
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
      guide_write:initial,guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}}[input.stage]);
  },{cardReview:input=>{
    if(Object.hasOwn(input.data.guide,'next'))reviews.push(structuredClone(input));
    return {approved:true,issues:[]};
  }});
  const result=await model.respond(context(),memory());
  assert.equal(result.guide.next,next);assert.equal(repairs,1);
  const after=reviews.filter(input=>input.stage.endsWith('_after_repair_1'));
  assert.deepEqual(after.map(input=>input.stage),['speech_review_card_next_after_repair_1','support_review_card_next_after_repair_1']);
  assert.ok(after.every(input=>input.data.guide.next===next&&input.data.claims.some(claim=>claim.claim===next)));
  assert.deepEqual(after[0].data.answers,repairInputs[0].answers);
});

for(const verdict of ['unsupported','plausible'])test('attributed next speech cannot bypass an independent source rejection: '+verdict,async()=>{
  const next='원한다면 “제가 도와드릴 수 있는 일이 있을까요?”라고 물어보세요.';
  const initial=guide();initial.guide.next=next;let reviews=0,repairs=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage.startsWith('guide_repair_card_next')){repairs++;return envelope({next});}
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
      guide_write:initial,guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}}[input.stage]);
  },{cardReview:input=>{
    if(!input.stage.startsWith('speech_review_card_next'))return {approved:true,issues:[]};
    reviews++;assert.equal(input.data.guide.next,next);
    return {approved:false,issues:[{field:'next',reason:'합성 독립 검토가 지원 범위의 근거를 승인하지 않았습니다.',repair:'원문으로 지원 범위를 다시 확인하여 고치세요.'}],
      audits:input.data.claims.map(claim=>({id:claim.id,verdict,reason:'지원 범위를 현재 원문과 대조했습니다.'}))};
  }});
  await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_review_rejected'});
  assert.equal(reviews,3);assert.equal(repairs,2);assert.equal(model.transportStages.includes('guide_quality'),false);
});

test('avoid wire roles preserve original bounds and deterministically join all model-authored components',()=>{
  const stored=avoidStoredSchema(),before=structuredClone(stored),wire=avoidCardDraftSchema(stored);
  assert.deepEqual(wire.properties.avoid.items.required,['avoid_phrase','reason','alternative']);
  assert.equal(wire.properties.avoid.items.additionalProperties,false);
  for(const key of ['minItems','maxItems'])assert.equal(wire.properties.avoid[key],stored.properties.avoid[key]);
  for(const value of Object.values(wire.properties.avoid.items.properties))assert.deepEqual(value,stored.properties.avoid.items);
  const draft={avoid:[structuredClone(avoidExample)]},original=structuredClone(draft);
  assert.deepEqual(canonicalAvoidCard(draft,stored),{avoid:[avoidText]});
  assert.deepEqual(draft,original);assert.deepEqual(stored,before);
});

test('malformed avoid roles and flat wire arrays are rejected rather than inferred or silently repaired',()=>{
  for(const draft of [{avoid:[avoidText]},{avoid:[]},{avoid:Array(5).fill(avoidExample)},
    {avoid:[{avoid_phrase:'재촉하는 말.',alternative:'편한 시간을 물어보세요.'}]},
    {avoid:[{...avoidExample,reason:' '}]},{avoid:[{...avoidExample,alternative:false}]},
    {avoid:[{...avoidExample,approved:true}]},
  ])assert.throws(()=>canonicalAvoidCard(draft,avoidStoredSchema()),{modelReason:'agent_schema'});
});

test('joined avoid items still obey the original whole-string maximum after valid wire roles',()=>{
  const stored=avoidStoredSchema(),wire=avoidCardDraftSchema(stored);
  const draft={avoid:[{avoid_phrase:'가'.repeat(1000),reason:'나'.repeat(1000),alternative:'다'.repeat(1000)}]};
  validateSchema(draft,wire);
  assert.throws(()=>canonicalAvoidCard(draft,stored),error=>error.modelReason==='agent_schema'&&
    JSON.parse(error.modelFeedback).keyword==='maxLength'&&JSON.parse(error.modelFeedback).expected.max_length===2000);
  assert.equal(draft.avoid[0].reason.length,1000);
});

test('the actual gateway rejects legacy flat avoid wire output on all three attempts',async()=>{
  const stored=avoidStoredSchema(),requests=[];
  const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'test-only',model:'synthetic-model',
    protocol:'relationship_agent',diagnosticLogger:null,fetchImpl:async(_url,request)=>{
      requests.push(JSON.parse(request.body));return envelope({avoid:[avoidText]});
    }});
  await assert.rejects(model.operation({},operation=>model.agentComplete('card_avoid','역할별 초안을 작성하세요.',
    {answers:{source:'SYNTHETIC_COMPLETE_SOURCE'}},avoidCardDraftSchema(stored),operation,value=>canonicalAvoidCard(value,stored))),{modelReason:'agent_schema'});
  assert.equal(requests.length,3);
  assert.ok(requests.every(request=>JSON.parse(request.messages.at(-1).content).data.answers.source==='SYNTHETIC_COMPLETE_SOURCE'));
});

const qualityLengthSchema=()=>({type:'object',properties:{improvements:{type:'array',items:{type:'object',
  properties:{field:{type:'string'},reason:{type:'string'},repair:{type:'string',maxLength:180}},
  required:['field','reason','repair'],additionalProperties:false}}},required:['improvements'],additionalProperties:false});

test('quality repair length feedback requests concise editing instructions without changing the candidate or schema',async()=>{
  for(const stage of ['guide_quality','guide_quality_check','guide_quality_check_2',
    'guide_quality_after_analysis_repair','guide_quality_check_after_analysis_repair','guide_quality_check_2_after_analysis_repair']) {
    const schema=qualityLengthSchema(),payload={source:'SYNTHETIC_COMPLETE_SOURCE',guide:{script:'합성 카드의 발화 전체를 보존합니다.'}};
    const rejected={improvements:[{field:'script',reason:'마지막 문장이 강요합니다.',repair:'가'.repeat(181)},
      {field:'next',reason:'가능한 시간을 보존해야 합니다.',repair:'나'.repeat(190)}]};
    const repaired={improvements:[{...rejected.improvements[0],repair:'마지막 문장의 강요를 허락 질문으로 바꾸세요.'},
      {...rejected.improvements[1],repair:'이용자의 가능 시간을 보존하세요.'}]};
    const requests=[];
    const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'test-only',model:'synthetic-model',
      protocol:'relationship_agent',diagnosticLogger:null,fetchImpl:async(_url,request)=>{
        const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);requests.push(body);
        assert.deepEqual(input.data,payload);assert.deepEqual(input.output_schema,schema);
        if(requests.length===1) {
          assert.doesNotMatch(body.messages[0].content,/길이를 넘긴 것은 검토 JSON/u);
          assert.equal(input.review_format_repair,undefined);
        }
        else {
          assert.equal(input.rejected_output,undefined);
          for(const item of rejected.improvements)assert.equal(request.body.includes(item.repair),false);
          const feedback=JSON.parse(input.validation_feedback);
          assert.equal(feedback.path,'output.improvements[0].repair');assert.equal(feedback.keyword,'maxLength');
          assert.equal(feedback.expected.max_length,180);
          assert.deepEqual(input.review_format_repair,{error:feedback,improvements:rejected.improvements.map((item,index)=>
            ({index,field:item.field,reason:item.reason,repair_length:item.repair.length}))});
          assert.match(input.repair_task,/독립적으로 다시 대조/u);
          assert.match(input.repair_task,/빈 improvements로 자동 승인하지 마세요/u);
          assert.match(body.messages[0].content,/길이를 넘긴 것은 검토 JSON/u);
          assert.match(body.messages[0].content,/문제 위치·바꿀 동작·보존할 의미/u);
          assert.match(body.messages[0].content,/빈 improvements로 바꾸지 말고/u);
        }
        return envelope(requests.length===1?rejected:repaired);
      }});
    const result=await model.operation({},operation=>model.agentComplete(stage,'품질을 검토하세요.',payload,schema,operation,
      value=>{validateSchema(value,schema);return value;}));
    assert.deepEqual(result,repaired);assert.equal(requests.length,2);
  }
});

test('repeated oversized quality repair stops after three attempts even with operation recovery enabled',async()=>{
  const schema=qualityLengthSchema(),rejected={improvements:[{field:'script',reason:'합성 문제를 수정하세요.',repair:'나'.repeat(181)}]},requests=[];
  const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'test-only',model:'synthetic-model',
    protocol:'relationship_agent',diagnosticLogger:null,retryFailures:true,retryDelayMs:1,fetchImpl:async(_url,request)=>{
      requests.push(JSON.parse(request.body));return envelope(rejected);
    }});
  await assert.rejects(model.operation({signal:AbortSignal.timeout(1000)},operation=>model.agentComplete('guide_quality_check_2','품질을 검토하세요.',
    {source:'SYNTHETIC_COMPLETE_SOURCE'},schema,operation,value=>validateSchema(value,schema))),error=>{
      assert.equal(error.modelReason,'agent_quality_review_rejected');assert.equal(error.modelAttempts,3);
      assert.equal(JSON.parse(error.modelFeedback).keyword,'maxLength');return true;
    });
  assert.equal(requests.length,3);
  for(const request of requests.slice(1)) {
    assert.match(request.messages[0].content,/길이를 넘긴 것은 검토 JSON/u);
    const input=JSON.parse(request.messages.at(-1).content);
    assert.equal(input.rejected_output,undefined);assert.deepEqual(input.output_schema,schema);
    assert.equal(JSON.stringify(request).includes(rejected.improvements[0].repair),false);
    assert.deepEqual(input.review_format_repair.improvements,[{index:0,field:'script',reason:'합성 문제를 수정하세요.',repair_length:181}]);
    for(const feedback of input.validation_feedback.split('\n'))assert.equal(JSON.parse(feedback).expected.max_length,180);
  }
});

test('quality length instructions do not affect unrelated stages, paths or schema keywords',async()=>{
  for(const [stage,key,valueSchema,bad,good] of [
    ['support_review','repair',{type:'string',maxLength:180},'다'.repeat(181),'짧은 지시'],
    ['guide_quality','reason',{type:'string',maxLength:180},'라'.repeat(181),'짧은 이유'],
    ['guide_quality','repair',{type:'string',enum:['짧은 지시']},'잘못된 값','짧은 지시'],
  ]) {
    const schema=qualityLengthSchema();schema.properties.improvements.items.properties={[key]:valueSchema};
    schema.properties.improvements.items.required=[key];
    let attempts=0;
    const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'test-only',model:'synthetic-model',
      protocol:'relationship_agent',diagnosticLogger:null,fetchImpl:async(_url,request)=>{
        const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);attempts++;
        assert.doesNotMatch(body.messages[0].content,/길이를 넘긴 것은 검토 JSON/u);
        assert.equal(input.review_format_repair,undefined);
        if(attempts===2)assert.deepEqual(input.rejected_output,{improvements:[{[key]:bad}]});
        return envelope({improvements:[{[key]:attempts===1?bad:good}]});
      }});
    await model.operation({},operation=>model.agentComplete(stage,'독립 검토하세요.',{},schema,operation,value=>validateSchema(value,schema)));
    assert.equal(attempts,2);
  }
});

test('quality format diagnostics follow the latest failure and leave other schema repairs unchanged',async()=>{
  const schema=qualityLengthSchema(),long={field:'script',reason:'합성 문제를 수정하세요.',repair:'다'.repeat(181)};
  const outputs=[{improvements:[long,null]},{improvements:[{field:'next',reason:'수정 지시가 누락됐어요.'}]},
    {improvements:[{field:'next',reason:'선택을 보존하세요.',repair:'마지막 제안을 선택할 수 있도록 바꾸세요.'}]}];
  let attempts=0;
  const model=new ModelGateway({baseUrl:'https://synthetic.invalid/v1',apiKey:'test-only',model:'synthetic-model',
    protocol:'relationship_agent',diagnosticLogger:null,fetchImpl:async(_url,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);attempts++;
      if(attempts===2) {
        assert.equal(input.rejected_output,undefined);
        assert.deepEqual(input.review_format_repair.improvements,[{index:0,field:long.field,reason:long.reason,repair_length:181},
          {index:1,repair_length:null}]);
        assert.equal(request.body.includes(long.repair),false);
      }
      if(attempts===3) {
        assert.equal(input.review_format_repair,undefined);
        assert.deepEqual(input.rejected_output,outputs[1]);
        assert.doesNotMatch(body.messages[0].content,/길이를 넘긴 것은 검토 JSON/u);
      }
      return envelope(outputs[attempts-1]);
    }});
  const result=await model.operation({},operation=>model.agentComplete('guide_quality','품질을 검토하세요.',
    {source:'SYNTHETIC_COMPLETE_SOURCE'},schema,operation,value=>validateSchema(value,schema)));
  assert.deepEqual(result,outputs[2]);assert.equal(attempts,3);
});

test('avoid repair wire omits rejected cards and old audits while preserving sources and fresh review history',async()=>{
  const bad={avoid_phrase:'편한 시간을 먼저 물어보기.',reason:'대안을 별도 항목으로 작성했습니다.',alternative:'원할 때 답하도록 기다리세요.'};
  const badText='피할 말·행동: 편한 시간을 먼저 물어보기. 이유: 대안을 별도 항목으로 작성했습니다. 대신 원할 때 답하도록 기다리세요.';
  const reviews=[],writes=[];let repairs=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage.startsWith('guide_repair_card_avoid')){
      repairs++;writes.push(input);
      assert.deepEqual(Object.keys(input.data),['answers','plan','field','task','issues','retrieval']);
      assert.equal(input.data.task,input.data.issues.map(issue=>issue.repair).join('\n'));
      assert.deepEqual(input.output_schema.properties.avoid.items.required,['avoid_phrase','reason','alternative']);
      assert.match(body.messages[0].content,/역할 이름은 내용의 승인이나 사실 근거가 아닙니다/u);
      return envelope({avoid:[structuredClone(avoidExample)]});
    }
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
      guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}}[input.stage]);
  },{cardWrite:input=>{
    const key=Object.keys(input.output_schema.properties)[0];
    if(key==='avoid'){writes.push(structuredClone(input));return {avoid:[bad]};}
    return {[key]:guide().guide[key]};
  },cardReview:input=>{
    if(!input.stage.startsWith('speech_review_card_avoid'))return {approved:true,issues:[]};
    reviews.push(structuredClone(input));assert.ok(input.data.guide.avoid.every(value=>typeof value==='string'));
    assert.ok(input.data.claims.every(claim=>claim.claim_kind==='avoidance_guidance'));
    assert.deepEqual(input.output_schema.properties.audits.items.properties.verdict.enum,['sound_avoidance','problem_in_recommended_content','unclear']);
    return input.stage==='speech_review_card_avoid'?{approved:false,issues:[{field:'avoid',reason:'좋은 제안이 피할 행동 역할에 들어갔습니다.',repair:'실제로 피할 행동과 이유, 대안을 한 항목에 맞게 다시 작성하세요.'}],
      audits:input.data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason:'피할 행동의 역할이 맞지 않습니다.'}))}:{approved:true,issues:[]};
  }});
  const result=await model.respond(context(),memory());
  assert.equal(repairs,1);assert.equal(reviews.length,2);assert.deepEqual(result.guide.avoid,[avoidText]);
  assert.deepEqual(reviews[1].data.claims.map(claim=>claim.claim),[avoidText]);
  assert.deepEqual(writes[0].data.answers,writes[1].data.answers);assert.deepEqual(writes[1].data.answers,reviews[1].data.answers);
  assert.deepEqual(writes[1].data.plan,writes[0].data.plan);
  assert.deepEqual(reviews[1].data.revision.changes,[{field:'avoid',before:[badText],after:[avoidText]}]);
  assert.equal(reviews[1].data.revision.previous_review.audits[0].verdict,'unsupported');
  assert.ok(result.guide.avoid.every(value=>typeof value==='string'));assert.deepEqual(JSON.parse(JSON.stringify(result)).guide.avoid,[avoidText]);
});

for(const verdict of ['unsupported','plausible'])test('structured avoid roles do not override a rejecting independent audit: '+verdict,async()=>{
  let reviews=0,repairs=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage.startsWith('guide_repair_card_avoid')){repairs++;return envelope({avoid:[structuredClone(avoidExample)]});}
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide()}[input.stage]);
  },{cardReview:input=>{
    if(!input.stage.startsWith('speech_review_card_avoid'))return {approved:true,issues:[]};
    reviews++;assert.deepEqual(input.data.guide.avoid,[avoidText]);
    return {approved:false,issues:[{field:'avoid',reason:'역할은 구분됐지만 대안의 원문 근거가 부족합니다.',repair:'원문 근거를 다시 확인해 대안을 수정하세요.'}],
      audits:input.data.claims.map(claim=>({id:claim.id,verdict,reason:'내용의 원문 근거를 승인하지 않았습니다.'}))};
  }});
  await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_review_rejected'});
  assert.equal(repairs,2);assert.equal(reviews,3);
});

test('an approving typed avoid audit cannot publish an unbounded alternative caught by existing content checks',async()=>{
  const bad={...avoidExample,alternative:'“나는 항상 네 곁에 있을게.”라고 말하세요.'};
  const badText=canonicalAvoidCard({avoid:[bad]},avoidStoredSchema()).avoid[0];
  let repairs=0,reviews=0;const events=[];
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage.startsWith('guide_repair_card_avoid')){
      repairs++;assert.equal(Object.hasOwn(input.data,'current'),false);assert.equal(Object.hasOwn(input.data,'review'),false);
      assert.ok(input.data.issues.some(issue=>issue.reason==='이용자가 밝히지 않은 상시 지원을 약속합니다.'));
      return envelope({avoid:[structuredClone(avoidExample)]});
    }
    return fixtureEnvelope(approvedCardOutputs()[input.stage]);
  },{cardWrite:input=>{
    const field=Object.keys(input.output_schema.properties)[0];return field==='avoid'?{avoid:[bad]}:{[field]:guide().guide[field]};
  },cardReview:input=>{
    if(input.stage.startsWith('speech_review_card_avoid')){
      reviews++;assert.equal(input.data.claims[0].claim_kind,'avoidance_guidance');
      if(reviews===2){
        assert.deepEqual(input.data.revision.changes[0].before,[badText]);
        assert.ok(input.data.revision.previous_review.audits.every(audit=>audit.verdict==='supported'),'the historical reviewer miss remains recorded');
      }
    }
    return {approved:true,issues:[]};
  }});
  const result=await model.respond(context(),memory(),{onCard:event=>events.push(event)});
  assert.equal(repairs,1);assert.equal(reviews,2);assert.deepEqual(result.guide.avoid,[avoidText]);
  assert.ok(events.filter(event=>event.id==='avoid'&&event.type==='upsert').every(event=>!JSON.stringify(event.value).includes(bad.alternative)));
});

test('source-based avoid repair still rejects repeated unsupported premises before another independent review',async()=>{
  const bad={...avoidExample,alternative:'책임감이 강하신 것 같은데, 요즘 어떤 도움이 필요하세요?'};
  const requests=[],events=[];let reviews=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage.startsWith('guide_repair_card_avoid')){
      requests.push(input);
      assert.equal(Object.hasOwn(input.data,'current'),false);assert.equal(Object.hasOwn(input.data,'review'),false);
      assert.deepEqual(input.data.answers,requests[0].data.answers);
      assert.deepEqual(input.data.retrieval,requests[0].data.retrieval);
      if(requests.length>1)assert.match(input.validation_feedback,/확인되지 않은 대상자의 성품/u);
      return envelope({avoid:[structuredClone(bad)]});
    }
    return fixtureEnvelope(approvedCardOutputs()[input.stage]);
  },{cardWrite:input=>{
    const key=Object.keys(input.output_schema.properties)[0];return key==='avoid'?{avoid:[structuredClone(bad)]}:{[key]:guide().guide[key]};
  },cardReview:input=>{
    if(input.stage.startsWith('speech_review_card_avoid'))reviews++;
    return {approved:true,issues:[]};
  }});
  await assert.rejects(model.respond(context(),memory(),{onCard:event=>events.push(event)}),{modelReason:'agent_speech_specific'});
  assert.equal(requests.length,3);assert.equal(reviews,1);
  assert.equal(events.some(event=>event.id==='avoid'&&event.type==='upsert'),false);
});

test('whole-guide refinement retains its flat contract and rejected avoid content uses typed repair',async()=>{
  const refined=guide();refined.guide.avoid=['재촉하는 말은 피하세요.','편한 시간을 물어보세요.'];let repairs=0,reviews=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(['guide_write','guide_refine'].includes(input.stage))assert.equal(input.output_schema.properties.guide.properties.avoid.items.type,'string');
    if(input.stage==='guide_repair'){
      repairs++;assert.equal(Object.hasOwn(input.data,'current'),false);assert.equal(Object.hasOwn(input.data,'review'),false);
      assert.deepEqual(input.output_schema.properties.avoid.items.required,['avoid_phrase','reason','alternative']);
      return envelope({avoid:[structuredClone(avoidExample)]});
    }
    if(input.stage.startsWith('guide_review'))return envelope({approved:true,issues:[]});
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),
      guide_quality:{improvements:[{field:'avoid',reason:'항목의 연결을 다시 보세요.',repair:'피할 내용과 대안을 함께 작성하세요.'}]},guide_refine:refined}[input.stage]);
  },{speechReview:input=>{
    reviews++;const rejected=input.stage==='speech_review';
    assert.ok(input.data.claims.filter(claim=>claim.field==='avoid').every(claim=>claim.claim_kind==='avoidance_guidance'));
    assert.ok(input.data.claims.filter(claim=>claim.field!=='avoid').every(claim=>claim.claim_kind==='guidance'));
    assert.ok(input.data.claims.every(claim=>!Object.hasOwn(claim,'certainty')));
    assert.deepEqual(input.output_schema.properties.audits.items.anyOf[0].properties.id.enum,input.data.claims.filter(claim=>claim.field==='avoid').map(claim=>claim.id));
    return {approved:!rejected,issues:rejected?[{field:'avoid',reason:'대안이 별도 피할 항목으로 떨어졌습니다.',repair:'역할을 구분해 한 항목으로 묶으세요.'}]:[],
      audits:input.data.claims.map(claim=>({id:claim.id,verdict:rejected&&claim.field==='avoid'?'unsupported':'supported',reason:'현재 카드 전체의 내용과 역할을 검토했습니다.'}))};
  }});
  const result=await model.respond(context(),memory());
  assert.equal(repairs,1);assert.equal(reviews,2);assert.deepEqual(result.guide.avoid,[avoidText]);
});

test('a verified name is optional but spoken text cannot refer to the listener as an unknown third person',async()=>{
  for(const genericName of [null,'그분']){
  const ctx=context();ctx.name_index=null;
  if(genericName){ctx.patient.alias=genericName;ctx.patient.fields.name=field('name',genericName);ctx.name_index={alias:genericName,source_question_id:'name',quote:genericName};}
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;
    if(stage==='relationship_analysis')return fixtureEnvelope(analysis());
    if(stage==='communication_plan')return envelope(plan());
    if(stage==='guide_quality')return envelope({improvements:[]});
    return fixtureEnvelope(stage.includes('review')?{approved:true,issues:[]}:guide());
  },{speechWrite:input=>{assert.equal(input.data.alias,null);return {script:'저는 그분이 어떤지 알고 싶어서 연락했어요.'};}});
  await assert.rejects(model.respond(ctx,memory()),{modelReason:'agent_speech_address'});
  }
});

test('the first permission question belongs to the reviewed speech without bypassing its audit',async()=>{
  const opening='지민아, 지금 잠깐 이야기할 수 있는 상황이야?';
  const script=opening+' 밤에 계획표를 고치는 모습을 봤어. 네 마음을 이해하고 싶어.';
  for(const verdict of ['supported','plausible']){
    const reviews=[];
    const model=gateway(body=>{
      const stage=JSON.parse(body.messages.at(-1).content).stage;
      return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
        guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}}[stage]);
    },{speechWrite:()=>({script}),speechReview:(input,body)=>{
      reviews.push({claims:input.data.claims,prompt:body.messages[0].content});
      return {approved:true,issues:[],audits:input.data.claims.map(claim=>({id:claim.id,
        verdict:claim.id==='script.0'?verdict:'supported',reason:'현재 발화 전체를 독립적으로 검토했습니다.'}))};
    }});
    if(verdict==='supported'){
      assert.equal((await model.respond(context(),memory())).guide.script,script);
      assert.equal(reviews.length,1);assert.equal(model.transportStages.includes('guide_repair'),false);
    }else{
      await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_claim_audit'});
      assert.equal(reviews.length,3);assert.equal(model.transportStages.includes('guide_review'),false);
    }
    assert.ok(reviews.every(review=>review.claims.find(claim=>claim.id==='script.0').claim===opening));
    assert.match(reviews[0].prompt,/허락 질문[^\n]*script의 정식 일부/u);
    assert.match(reviews[0].prompt,/대화 가능 여부를 먼저 확인한다는 이유만으로[^\n]*거절/u);
  }
});

test('repeated conversation permission stops after three speech attempts even with operation recovery enabled',async()=>{
  const questions=['지금 잠시 이야기 나눌 수 있을까요?','혹시 지금 대화 나누기 괜찮으신가요?'];
  const script=questions.join(' 요즘 어떤지 듣고 싶어요. ');
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;
    if(stage==='relationship_analysis')return fixtureEnvelope(analysis());
    if(stage==='communication_plan')return envelope(plan());
    if(stage==='guide_quality')return envelope({improvements:[]});
    return fixtureEnvelope(stage.includes('review')?{approved:true,issues:[]}:guide());
  },{speechWrite:()=>({script})});
  model.retryFailures=true;model.retryDelayMs=1;
  await assert.rejects(model.respond(context(),memory(),{signal:AbortSignal.timeout(1000)}),error=>{
    assert.equal(error.code,'MODEL_INVALID_RESPONSE');assert.equal(error.modelReason,'agent_speech_repeat');
    assert.equal(error.modelAttempts,3);
    const feedback=JSON.parse(error.modelFeedback);
    assert.deepEqual(feedback.permission_questions,questions);assert.equal(feedback.permission_question_count,2);
    assert.equal(feedback.max_permission_questions,1);assert.equal(feedback.rejected_text,script);return true;
  });
  assert.equal(model.transportStages.filter(stage=>stage==='speech_write').length,3);
  assert.equal(model.transportStages.filter(stage=>stage==='relationship_analysis').length,1);
  assert.equal(model.transportStages.includes('guide_quality'),false);
  assert.equal(model.transportStages.includes('speech_review'),false);
});

test('speech retry uses exact duplicate questions to rewrite parts while preserving facts and independent review',async()=>{
  const questions=['지민아, 지금 잠시 이야기해도 괜찮을까?','지금 대화 나눌 수 있을까?','잠깐 이야기해도 괜찮을까?'];
  const observed='밤에 계획표를 고치는 모습을 봤어.',intent='네 마음을 이해하고 싶어.';
  const parts={opening:{permission:questions[0],observed_scene:observed},
    listening:{user_intent:intent,open_question:questions[1],wait_for_answer:'원할 때 답해 줘.'},
    offer:{small_invitation:questions[2],help_choice:'편한 시간을 함께 정해 볼까?',decline_choice:'부담되면 다음에 해도 괜찮아.'}};
  const rejected=[questions[0],observed,intent,questions[1],questions[2]].join(' ');
  const repaired=[questions[0],observed,intent,'어떤 이야기를 하고 싶어?',parts.offer.help_choice,parts.offer.decline_choice].join(' ');
  let attempts=0,firstInput;
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages.at(-1).content).stage;
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
      guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}}[stage]);
  },{speechPart:input=>structuredClone(parts[input.stage.slice('speech_'.length)]),speechWrite:input=>{
    if(++attempts===1){firstInput=structuredClone(input.data);return {script:rejected};}
    assert.deepEqual(input.data,firstInput);assert.deepEqual(input.data.parts,parts);
    assert.deepEqual(input.rejected_output,{script:rejected});
    const feedback=JSON.parse(input.validation_feedback);
    assert.equal(feedback.field,'script');assert.equal(feedback.permission_question_count,3);
    assert.deepEqual(feedback.permission_questions,questions);assert.equal(feedback.rejected_text,rejected);
    assert.match(feedback.repair,/parts.listening과 parts.offer/u);
    return {script:repaired};
  },speechReview:input=>{
    assert.equal(input.data.guide.script,repaired);return {approved:true,issues:[]};
  }});
  model.retryFailures=true;model.retryDelayMs=1;
  const result=await model.respond(context(),memory(),{signal:AbortSignal.timeout(1000)});
  assert.equal(result.guide.script,repaired);assert.equal(attempts,2);
  assert.deepEqual(speechPermissionQuestions(result.guide.script),[questions[0]]);
  const writePrompts=model.transportPrompts.filter((_prompt,index)=>model.transportStages[index]==='speech_write');
  assert.match(writePrompts[1],/최초의 허락 질문만 남기세요/u);
  assert.match(writePrompts[1],/parts.listening과 parts.offer/u);
  assert.match(writePrompts[1],/문장 표현만 바꾼 대화 허락 질문도 반복/u);
  assert.equal(model.transportStages.includes('speech_review'),true);
  assert.equal(model.transportStages.includes('guide_review'),true);
});

test('permission counting distinguishes explicit decline choices without exempting real questions',()=>{
  const opening='잠깐 이야기해도 괜찮을까?';
  for(const choice of [
    '지금 대화가 부담되면 다른 때 말해도 괜찮아.',
    '지금 이야기하기 힘드시면 다음에 말씀하셔도 괜찮습니다.',
    '지금은 이야기하지 않아도 괜찮아요.',
    '지금은 대화를 안 해도 괜찮아요.',
    '지금 대화를 미뤄도 괜찮습니다.',
  ])assert.deepEqual(speechPermissionQuestions(opening+' '+choice),[opening]);
  for(const question of [
    '지금 이야기 나눌 수 있을까요?',
    '지금 대화해도 괜찮으신가요.',
    '지금 잠시 이야기해도 괜찮을까',
    '나중에 대화하기 어려우면 지금 잠깐 이야기해도 괜찮을까요.',
    '지금 대화가 어렵다면 다음에 잠깐 이야기해도 괜찮을까요?',
    '지금 잠깐 대화해도 괜찮을까요, 힘들면 다음에 해도 괜찮아요.',
    '지금 잠깐 이야기할 수 있을까, 어려우면 나중에 해도 괜찮아.',
    '지금 이야기해도 괜찮아요.',
  ])assert.equal(speechPermissionQuestions(opening+' '+question).length,2,question);
  assert.equal(speechPermissionQuestions(opening+' 지금은 대화를 안 해도 괜찮아요. 지금 대화 나눌 수 있을까요.').length,2);
});

for(const choice of ['지금 대화가 부담되면 다른 때 말해도 괜찮아.','지금은 이야기하지 않아도 괜찮아.'])
test('one permission plus an explicit choice reaches independent review with its original wording: '+choice,async()=>{
  const opening='지민아, 잠깐 이야기해도 괜찮을까?';
  const script=opening+' 밤에 계획표를 고치는 모습을 봤어. 네 마음을 이해하고 싶어. '+choice;
  const reviews=[];
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages.at(-1).content).stage;
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
      guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}}[stage]);
  },{speechWrite:()=>({script}),speechReview:input=>{
    reviews.push(structuredClone(input.data));return {approved:true,issues:[]};
  }});
  assert.equal((await model.respond(context(),memory())).guide.script,script);
  assert.equal(model.transportStages.filter(stage=>stage==='speech_write').length,1);
  assert.equal(reviews.length,1);
  for(const text of [opening,choice])assert.ok(reviews[0].claims.some(claim=>claim.claim===text));
  assert.equal(reviews[0].guide.script,script);
  assert.deepEqual(reviews[0].answers,model.transportInputs.find(input=>input.stage==='speech_write').data.answers);
});

for(const verdict of ['unsupported','plausible'])test('an explicit decline choice still fails a rejecting independent review: '+verdict,async()=>{
  const choice='지금 대화가 부담되면 다른 때 말해도 괜찮아.';
  const script='지민아, 잠깐 이야기해도 괜찮을까? 밤에 계획표를 고치는 모습을 봤어. 네 마음을 이해하고 싶어. '+choice;
  const reviews=[];
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages.at(-1).content).stage;
    if(stage.startsWith('guide_repair_card_script'))return envelope({script});
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
      guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}}[stage]);
  },{speechWrite:()=>({script}),cardReview:input=>{
    if(!Object.hasOwn(input.data.guide,'script'))return {approved:true,issues:[]};
    reviews.push(structuredClone(input.data));
    return {approved:false,issues:[{field:'script',reason:'합성 검토가 해당 문장의 근거를 승인하지 않았습니다.',repair:'원문 근거를 다시 확인해 해당 문장을 수정하세요.'}],
      audits:input.data.claims.map(claim=>({id:claim.id,verdict:claim.claim===choice?verdict:'supported',reason:'각 문장을 원문과 독립적으로 대조했습니다.'}))};
  }});
  await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_review_rejected'});
  assert.equal(reviews.length,3);assert.ok(reviews.every(input=>input.guide.script===script));
  assert.equal(model.transportStages.includes('guide_quality'),false);
});

for(const script of [
  '지금 잠깐 이야기할 수 있을까요. 지금 이야기하기 힘드시면 다음에 말씀하셔도 괜찮습니다. 잠시 대화해도 괜찮으신가요.',
  '잠시 대화해도 괜찮으신가요. 지금 잠깐 이야기할 수 있을까, 어려우면 나중에 해도 괜찮아.',
])test('a later-time choice does not hide two genuine permission questions before review: '+script,async()=>{
  let speechReviews=0;
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages.at(-1).content).stage;
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide()}[stage]);
  },{speechWrite:()=>({script}),speechReview:()=>{speechReviews++;return {approved:true,issues:[]};}});
  await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_speech_repeat'});
  assert.equal(model.transportStages.filter(stage=>stage==='speech_write').length,3);assert.equal(speechReviews,0);
});

test('known mind-reading wording cannot pass even when model reviewers would approve it',async()=>{
  let attempts=0;
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;
    if(stage==='relationship_analysis')return fixtureEnvelope(analysis());
    if(stage==='analysis_review')return envelope({approved:true,issues:[]});
    if(stage==='communication_plan')return envelope(plan());
    if(stage==='guide_quality')return envelope({improvements:[]});
    assert.equal(stage,'guide_write');return envelope(guide());
  },{speechWrite:()=>{attempts++;return {script:'완벽하게 하고 싶은 마음 때문에 힘든 거야.'};}});
  await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_script_inference'});
  assert.equal(attempts,3);
});

test('a flawed communication strategy is repaired and independently reviewed before writing',async()=>{
  for(const acceptsRepair of [true,false]){
    const stages=[];
    const model=gateway(body=>{
      const stage=JSON.parse(body.messages[1].content).stage;stages.push(stage);
      if(stage==='relationship_analysis')return fixtureEnvelope(analysis());
      if(stage.startsWith('communication_plan'))return envelope(plan());
      if(stage==='guide_quality')return envelope({improvements:[]});
      if(stage.includes('review'))return envelope({approved:true,issues:[]});
      return envelope(guide());
    },{planReview:input=>{
      stages.push(input.stage);
      return acceptsRepair&&input.stage==='plan_review_after_repair'?{approved:true,issues:[]}:
        {approved:false,issues:[{field:'patient_choice',reason:'상대의 반응을 예측했어요.',repair:'선택 가능한 제안으로 쓰세요.'}]};
    }});
    if(acceptsRepair){
      await model.respond(context(),memory());
      assert.ok(stages.indexOf('plan_review_after_repair')<stages.indexOf('guide_write'));
    }else{
      await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_plan_review_rejected'});
      assert.equal(stages.includes('guide_write'),false);
    }
    assert.equal(stages.filter(stage=>stage==='communication_plan_repair').length,1);
  }
});

test('plan rechecks retain the rejected strategy and review without treating its repair example as approval',async()=>{
  for(const repairedCorrectly of [true,false]){
    const original=plan();original.patient_choice='조금 쉬고 나면 이야기하고 싶어질 거예요.';
    const suggested='조용히 있고 싶어 하는 것 같아. 혼자 쉬면 좋겠어.';
    const review={approved:false,issues:[{field:'patient_choice',reason:'상대가 원하는 반응을 예측했습니다.',repair:suggested}]};
    const repaired=plan();repaired.patient_choice=repairedCorrectly?'지금 이야기해도 괜찮을까, 아니면 다른 때가 편할까?':suggested;
    let repairs=0;
    const model=gateway(body=>{
      const input=JSON.parse(body.messages.at(-1).content);
      if(input.stage==='communication_plan_repair'){repairs++;return envelope(repaired);}
      return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:original,
        guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}}[input.stage]);
    },{planReview:input=>input.stage==='plan_review'?review:repairedCorrectly?{approved:true,issues:[]}:
      {approved:false,issues:[{field:'patient_choice',reason:'제안된 수정에도 상대의 마음을 추정하는 부분이 남았습니다.',repair:'마음을 예측하지 말고 지금 대화할지 선택을 물으세요.'}]}});
    if(repairedCorrectly)assert.equal((await model.respond(context(),memory())).agent.reviewed,true);
    else await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_plan_review_rejected'});
    const inputFor=stage=>model.transportInputs.find(input=>input.stage===stage).data;
    assert.deepEqual(inputFor('communication_plan_repair').draft,original);
    assert.deepEqual(inputFor('communication_plan_repair').review,review);
    assert.deepEqual(inputFor('plan_review_after_repair').revision,{previous_review:review,before:original,after:repaired});
    assert.deepEqual(inputFor('plan_review_after_repair').plan,repaired);
    assert.deepEqual(inputFor('plan_review_after_repair').answers,agentContext(context()));
    assert.equal(repairs,1);
    assert.equal(model.transportStages.includes('guide_write'),repairedCorrectly);
  }
});

test('an overlong repetitive plan repair is corrected before it can reach the plan writer',async()=>{
  const repeated='거절된 예문을 그대로 되풀이합니다. '.repeat(15);
  const concise='상대의 예상 대사를 삭제하고 지금 대화할지 선택할 수 있는 질문을 제안하세요.';
  let reviews=0;
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages.at(-1).content).stage;
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
      communication_plan_repair:plan(),guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}}[stage]);
  },{planReview:input=>{
    if(input.stage==='plan_review')return {approved:false,issues:[{field:'patient_choice',reason:'선택권을 명확히 하세요.',repair:++reviews===1?repeated:concise}]};
    return {approved:true,issues:[]};
  }});
  assert.equal((await model.respond(context(),memory())).agent.reviewed,true);
  assert.equal(reviews,2);
  const attempts=model.transportInputs.filter(input=>input.stage==='plan_review');
  assert.equal(attempts[1].rejected_output.issues[0].repair,repeated);
  const repair=model.transportInputs.find(input=>input.stage==='communication_plan_repair');
  assert.equal(repair.data.review.issues[0].repair,concise);
  assert.equal(JSON.stringify(repair.data).includes(repeated),false);
});

test('quality refinement is checked again and unresolved errors cannot become a saved guide',async()=>{
  const stages=[];let refinements=0;
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;stages.push(stage);
    if(stage==='relationship_analysis')return fixtureEnvelope(analysis());
    if(stage==='analysis_review')return envelope({approved:true,issues:[]});
    if(stage==='communication_plan')return envelope(plan());
    if(stage==='guide_quality'||stage==='guide_quality_check')return envelope({improvements:[{field:'doList',reason:'실행할 방법이 없어요.',repair:'구체적인 방법을 제시하세요.'}]});
    if(stage.startsWith('guide_refine')){
      const revised=guide();revised.guide.doList=[++refinements===1?'천천히 대화해 보세요.':'상대를 존중하며 대화해 보세요.'];return envelope(revised);
    }
    return envelope(guide());
  },{qualityCheck:input=>{stages.push(input.stage);return {improvements:[{field:'doList',reason:'실행할 방법이 없어요.',repair:'구체적인 방법을 제시하세요.'}]};}});
  await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_quality_review_rejected'});
  assert.equal(refinements,2);
  assert.deepEqual(stages.slice(-4),['guide_refine','guide_quality_check','guide_refine_2','guide_quality_check_2']);
  assert.equal(stages.includes('guide_review'),false);
});

test('dedicated support review catches caregiver facts missed by the full review and rechecks repaired cards',async()=>{
  let reviews=0;
  const draft=guide();draft.guide.care.feel='혼자 모두 돌보고 계시네요.';
  const model=gateway(body=>{
    const input=JSON.parse(body.messages[1].content),stage=input.stage;
    if(stage==='relationship_analysis')return fixtureEnvelope(analysis());
    if(stage==='communication_plan')return envelope(plan());
    if(stage==='guide_quality')return envelope({improvements:[]});
    if(stage==='guide_repair'){
      assert.deepEqual(Object.keys(body.response_format.json_schema.schema.properties),['care']);
      return envelope(guide());
    }
    return fixtureEnvelope(stage.includes('review')?{approved:true,issues:[]}:draft);
  },{supportReview:input=>{
    reviews++;
    assert.deepEqual(new Set(input.data.claims.map(c=>c.field)),new Set(['next','care']));
    assert.ok(input.data.answers.supporter.length>0);
    return reviews===1?{approved:false,issues:[{field:'care',reason:'혼자 돌본다는 원문이 없습니다.',repair:'표현한 감정에만 공감하세요.'}]}:{approved:true,issues:[]};
  }});
  const result=await model.respond(context(),memory());
  assert.equal(reviews,2);assert.equal(result.guide.care.feel,guide().guide.care.feel);
  assert.ok(result.agent.stages.includes('support_review_after_repair'));
});

test('speech retry receives the rejected sentence and keeps the explicit speaker contract',async()=>{
  let writes=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages[1].content),stage=input.stage;
    if(stage==='relationship_analysis')return fixtureEnvelope(analysis());
    if(stage==='communication_plan')return envelope(plan());
    if(stage==='guide_quality')return envelope({improvements:[]});
    return fixtureEnvelope(stage.includes('review')?{approved:true,issues:[]}:guide());
  },{speechWrite:input=>{
    writes++;
    assert.equal(input.data.speech_contract.speaker.startsWith('supporter'),true);
    if(writes===1)return {script:'네 곁에 항상 있을게.'};
    assert.ok(input.validation_feedback.includes('네 곁에 항상 있을게.'));
    assert.ok(input.validation_feedback.includes('상시 지원'));
    return {script:guide().guide.script};
  }});
  const result=await model.respond(context(),memory());
  assert.equal(writes,2);assert.equal(result.guide.script,guide().guide.script);
});

test('unsupported speech parts are repaired at their own stage before later writers receive them',async()=>{
  const rejected='네가 얼마나 최선을 다하고 있는지 내가 다 알고 있어.';
  for(const [part,field] of [['listening','open_question'],['offer','small_invitation']]){
    let attempts=0;
    const outputs=approvedCardOutputs(),model=gateway(body=>fixtureEnvelope(outputs[JSON.parse(body.messages.at(-1).content).stage]),{
      speechPart:input=>{
        const result=Object.fromEntries(Object.keys(input.output_schema.properties).map(key=>[key,'요즘 어떤지 듣고 싶어.']));
        if(input.stage!=='speech_'+part){assert.equal(JSON.stringify(input.data.earlier_parts).includes(rejected),false);return result;}
        attempts++;
        if(attempts===1)return {...result,[field]:rejected};
        assert.equal(input.rejected_output[field],rejected);
        assert.ok(input.validation_feedback.includes('speech_'+part+'.'+field));
        assert.ok(input.validation_feedback.includes(rejected));
        assert.ok(input.validation_feedback.includes('네가 얼마나 최선을 다하고 있는지 내가 다 알'));
        return result;
      },
      speechWrite:input=>{assert.equal(JSON.stringify(input.data.parts).includes(rejected),false);return {script:guide().guide.script};},
    });
    const result=await model.respond(context(),memory());
    assert.equal(attempts,2);assert.deepEqual(result.guide,guide().guide);
  }
});

test('final inference retries identify the exact rejected script and offending expression',async()=>{
  const rejected='네가 얼마나 최선을 다하고 있는지 내가 다 알고 있어.';
  let attempts=0;
  const outputs=approvedCardOutputs(),model=gateway(body=>fixtureEnvelope(outputs[JSON.parse(body.messages.at(-1).content).stage]),{
    speechWrite:input=>{
      if(++attempts===1)return {script:rejected};
      assert.equal(input.rejected_output.script,rejected);
      assert.ok(input.validation_feedback.includes('script'));
      assert.ok(input.validation_feedback.includes(rejected));
      return {script:guide().guide.script};
    },
  });
  const result=await model.respond(context(),memory());
  assert.equal(attempts,2);assert.equal(result.guide.script,guide().guide.script);
});

test('unrepaired unsafe speech parts exhaust the existing stage attempts before final speech can start',async()=>{
  let attempts=0;
  const outputs=approvedCardOutputs(),model=gateway(body=>fixtureEnvelope(outputs[JSON.parse(body.messages.at(-1).content).stage]),{
    speechPart:input=>{
      const result=Object.fromEntries(Object.keys(input.output_schema.properties).map(key=>[key,'요즘 어떤지 듣고 싶어.']));
      if(input.stage==='speech_offer'){attempts++;result.help_choice='네 곁에 항상 있을게.';}
      return result;
    },
  });
  await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_speech_specific'});
  assert.equal(attempts,3);assert.equal(model.transportStages.includes('speech_write'),false);
});

test('dedicated card writers and speech parts reach integration before final grounded explanation',async()=>{
  const seen=[],events=[];
  const base={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}};
  const model=gateway(body=>fixtureEnvelope(base[JSON.parse(body.messages.at(-1).content).stage]),{
    cardWrite:input=>{const key=Object.keys(input.output_schema.properties)[0];seen.push(key);return {[key]:guide().guide[key]};},
    speechPart:input=>{seen.push(input.stage);assert.ok(input.data.answers.patient.length);return Object.fromEntries(Object.keys(input.output_schema.properties).map(key=>[key,key+' 발화']));},
    speechWrite:input=>{assert.deepEqual(Object.keys(input.data.parts),['opening','listening','offer']);assert.ok(input.data.answers.supporter.length);return {script:guide().guide.script};},
  });
  const result=await model.respond(context(),memory(),{onProgress:event=>events.push(event)});
  assert.deepEqual([...seen].sort(),['care','doList','avoid','next','speech_opening','speech_listening','speech_offer'].sort());
  assert.deepEqual(seen.filter(stage=>stage.startsWith('speech_')),['speech_opening','speech_listening','speech_offer']);
  assert.equal(Object.values(result.conversation_detail).map(item=>item.excerpt).join(''),result.guide.script);
  assert.ok(result.agent.stages.indexOf('speech_detail')>result.agent.stages.indexOf('guide_review'));
  assert.equal(events.filter(event=>event.status==='completed').length,result.agent.stages.length);
  assert.equal(events.at(-1).stage,'speech_detail_review');
  assert.ok(events.every(event=>Object.keys(event).sort().join(',')==='attempt,stage,status'));
});

test('speech explanation accepts equivalent sections in a different JSON property order',async()=>{
  const base={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}};
  let writes=0;
  const model=gateway(body=>fixtureEnvelope(base[JSON.parse(body.messages.at(-1).content).stage]),{detailWrite:input=>{
    writes++;
    const sections=Object.fromEntries(['opening','listening','offer'].map(key=>[key,{
      why:'보고한 행동을 되짚으며 듣고 싶다는 뜻을 전하는 제안이에요.',evidence:[ref()],
    }]));
    return {listening_end:input.data.script_units.length-1,offer:sections.offer,listening:sections.listening,opening_end:1,opening:sections.opening};
  }});
  const result=await model.respond(context(),memory());
  assert.equal(writes,1);
  assert.equal(['opening','listening','offer'].map(key=>result.conversation_detail[key].excerpt).join(''),result.guide.script);
  assert.equal(result.agent.stages.at(-1),'speech_detail_review');
});

test('explanation cannot publish an invented excerpt or survive two rejected reviews',async()=>{
  const base={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}};
  const handler=body=>fixtureEnvelope(base[JSON.parse(body.messages.at(-1).content).stage]);
  const bad=gateway(handler,{detailWrite:()=>Object.fromEntries(['opening','listening','offer'].map(key=>[key,{excerpt:'원문에 없는 발화',why:'설명',evidence:[ref()]}]))});
  await assert.rejects(bad.respond(context(),memory()),{modelReason:'agent_schema'});
  let reviews=0;
  const rejected=gateway(handler,{detailReview:input=>{reviews++;return {approved:false,issues:['설명에 확인되지 않은 감정이 추가됐어요.'],audits:input.data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason:'근거 밖 해석입니다.'}))};}});
  await assert.rejects(rejected.respond(context(),memory()),{modelReason:'agent_detail_review_rejected'});
  assert.equal(reviews,2);
});

for(const script of [
  '지민아, 밤에 계획표를 고치는 모습을 봤어. 네 마음을 이해하고 싶어. 지금 이야기해도 괜찮을까?',
  '지민아 😊, 밤에 계획표를 고치는 모습을 봤어.\r\n\r\n네 마음을 이해하고 싶어.\n지금 이야기해도 괜찮을까?  ',
  '지민아, 밤에 계획표를 고치는 모습을 봤는데 네 마음을 이해하고 싶어서 지금 이야기해도 괜찮을까?',
  '지민아밤에계획표를고치는모습을봤어네마음을이해하고싶어지금이야기해도괜찮을까?',
])test('speech detail selects boundaries while every final source character is preserved: '+script.length,async()=>{
  const base={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}};
  let detailInput,reviewedDetail;
  const model=gateway(body=>fixtureEnvelope(base[JSON.parse(body.messages.at(-1).content).stage]),{
    speechWrite:()=>({script}),
    detailWrite:input=>{
      detailInput=input;
      assert.equal(input.data.script_units.map(unit=>unit.text).join(''),script);
      assert.deepEqual(input.data.script_units.map(unit=>unit.id),input.data.script_units.map((_,index)=>index+1));
      assert.ok(input.data.script_units.length>=3);
      assert.ok(input.data.script_units.every(unit=>unit.text.trim()));
      for(const key of ['opening','listening','offer'])assert.equal(Object.hasOwn(input.output_schema.properties[key].properties,'excerpt'),false);
      return {opening_end:1,listening_end:input.data.script_units.length-1,
        ...Object.fromEntries(['opening','listening','offer'].map(key=>[key,{why:'보고한 행동을 되짚으며 듣고 싶다는 뜻을 전하는 제안이에요.',evidence:[ref()]}]))};
    },
    detailReview:input=>{
      reviewedDetail=structuredClone(input.data.detail);
      return {approved:true,issues:[],audits:input.data.claims.map(claim=>({id:claim.id,verdict:'supported',reason:'원문에 근거한 제안입니다.'}))};
    },
  });
  const result=await model.respond(context(),memory());
  assert.equal(detailInput.data.script,script);
  assert.equal(['opening','listening','offer'].map(key=>result.conversation_detail[key].excerpt).join(''),script);
  assert.deepEqual(Object.keys(result.conversation_detail),['opening','listening','offer']);
  assert.deepEqual(result.conversation_detail,reviewedDetail);
  assert.equal(result.conversation_detail.opening.excerpt,detailInput.data.script_units[0].text);
  assert.equal(Object.hasOwn(result.conversation_detail,'opening_end'),false);
});

test('speech detail repairs crossed section boundaries without changing the final script or accepting copied excerpts',async()=>{
  const script=guide().guide.script+' 원하면 천천히 이야기해 줘.';
  const base={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}};
  const sources=[];let writes=0;
  const model=gateway(body=>fixtureEnvelope(base[JSON.parse(body.messages.at(-1).content).stage]),{
    speechWrite:()=>({script}),detailWrite:input=>{
      sources.push(structuredClone(input.data));writes++;
      if(writes===2){
        assert.match(input.validation_feedback,/opening_end/u);
        assert.equal(input.rejected_output.opening_end,input.rejected_output.listening_end);
      }
      return {opening_end:writes===1?2:1,listening_end:2,
        ...Object.fromEntries(['opening','listening','offer'].map(key=>[key,{why:'보고한 행동을 되짚으며 듣고 싶다는 뜻을 전하는 제안이에요.',evidence:[ref()]}]))};
    },
  });
  const result=await model.respond(context(),memory());
  assert.equal(writes,2);assert.deepEqual(sources[1],sources[0]);
  assert.equal(['opening','listening','offer'].map(key=>result.conversation_detail[key].excerpt).join(''),script);
  assert.equal(result.agent.stages.at(-1),'speech_detail_review');
});

test('speech detail rejects copied full-script excerpts even alongside valid section boundaries',async()=>{
  const base={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}};
  let writes=0,reviews=0;
  const model=gateway(body=>fixtureEnvelope(base[JSON.parse(body.messages.at(-1).content).stage]),{
    detailWrite:input=>{
      writes++;
      return {opening_end:1,listening_end:input.data.script_units.length-1,
        ...Object.fromEntries(['opening','listening','offer'].map(key=>[key,{
          excerpt:input.data.script,why:'보고한 행동을 되짚는 제안이에요.',evidence:[ref()],
        }]))};
    },detailReview:()=>{reviews++;assert.fail('Invalid model excerpts must not reach independent review.');},
  });
  await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_schema'});
  assert.equal(writes,3);assert.equal(reviews,0);
});

test('speech detail partitions the final refined script rather than the previous assembled speech',async()=>{
  const refined=guide();refined.guide.script+=' 네가 원할 때 천천히 이야기해 줘.';
  const base={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),
    guide_quality:{improvements:[{field:'script',reason:'의미를 명확하게 표현하세요.',repair:'원문에 있는 뜻을 유지하세요.'}]},guide_refine:refined,guide_review:{approved:true,issues:[]}};
  const model=gateway(body=>fixtureEnvelope(base[JSON.parse(body.messages.at(-1).content).stage]));
  const result=await model.respond(context(),memory());
  const input=model.transportInputs.find(row=>row.stage==='speech_detail');
  assert.equal(input.data.script,refined.guide.script);
  assert.equal(input.data.script_units.map(unit=>unit.text).join(''),refined.guide.script);
  assert.equal(['opening','listening','offer'].map(key=>result.conversation_detail[key].excerpt).join(''),refined.guide.script);
});

test('a vague help offer retries with the exact rejected speech and the selected treatment intent',async()=>{
  const c=context();c.user_goal.desired_outcomes={...field('goal','상담이나 진료를 권하고 싶어요'),selected:[{label:'상담이나 진료를 권하고 싶어요',meta:{t:'goal_treat'}}]};
  let attempts=0;
  const base={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}};
  const model=gateway(body=>fixtureEnvelope(base[JSON.parse(body.messages.at(-1).content).stage]),{speechWrite:input=>{
    attempts++;
    assert.match(input.data.task,/상담 또는 진료/);
    if(attempts===1)return {script:'원하면 도움을 받을 곳을 같이 알아볼까?'};
    assert.ok(input.validation_feedback.includes('원하면 도움을 받을 곳을 같이 알아볼까?'));
    return {script:'요즘 어떤 점이 걱정되는지 듣고 싶어. 원하면 상담을 함께 알아볼까?'};
  }});
  const result=await model.respond(c,memory());assert.equal(attempts,2);assert.match(result.guide.script,/상담/);
});


test('analysis audits cannot omit claims or approve unsupported interpretations before planning',async()=>{
  for(const [kind,reason] of [['missing','agent_schema'],['unsupported','agent_claim_audit']]){
    const stages=[];
    const model=gateway(body=>{
      const input=JSON.parse(body.messages.at(-1).content);stages.push(input.stage);
      if(input.stage==='relationship_analysis')return envelope(evidenceWireFixture(input,{...draftAnalysis(),safety:{urgent:false,evidence_ids:[]}}));
      assert.equal(input.stage,'analysis_review');
      const review={approved:true,issues:[]};
      if(kind==='unsupported')review.audits=input.data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason:'인용이 해석을 뒷받침하지 않아요.'}));
      return envelope(review);
    },{raw:true});
    await assert.rejects(model.respond(context(),memory()),{modelReason:reason});
    assert.equal(stages.filter(stage=>stage==='analysis_review').length,3);
    assert.equal(stages.includes('communication_plan'),false);
  }
});

// Synthetic source/guide pairs exercise routing and required review behavior.
// A mocked reviewer passing these is not a model semantic-accuracy measurement.
function causalReviewGateway(candidate,{speechReview,repair}={}) {
  return gateway(body=>{
    const input=JSON.parse(body.messages[1].content),stage=input.stage;
    if(stage==='relationship_analysis')return fixtureEnvelope(analysis());
    if(stage==='communication_plan')return envelope(plan());
    if(stage==='guide_quality')return envelope({improvements:[]});
    if(stage.startsWith('guide_repair'))return envelope(repair?.(input)??candidate);
    return fixtureEnvelope(stage.includes('review')?{approved:true,issues:[]}:candidate);
  },{speechReview});
}

test('causal selfcare wording receives complete claim review without a lexical rejection or extra stage',async()=>{
  for(const sentence of [
    '걱정되는 마음 때문에 약속을 더 늘릴 필요는 없어요. 지금 가능한 범위를 정해 보세요.',
    '무력한 마음 때문에 모든 일을 맡으려 하지 말고 본인의 휴식 시간도 지켜 보세요.',
  ]) {
    const candidate=guide();candidate.guide.doList=[sentence];let reviewed=0;
    const model=causalReviewGateway(candidate,{speechReview:input=>{
      reviewed++;
      assert.deepEqual(input.data.semantic_review_focus,['doList.0']);
      assert.equal(input.data.claims.find(row=>row.id==='doList.0').claim,sentence);
      assert.ok(input.data.answers.supporter.some(row=>row.question_id==='feeling'&&row.status==='answered'));
      const audit=input.output_schema.properties.audits.items;
      assert.deepEqual((audit.anyOf??[audit]).flatMap(branch=>branch.properties.id.enum).sort(),input.data.claims.map(row=>row.id).sort());
      return {approved:true,issues:[]};
    }});
    const result=await model.respond(context(),memory());
    assert.deepEqual(result.guide,candidate.guide);
    assert.equal(reviewed,1);
    assert.equal(model.transportStages.some(stage=>stage.startsWith('guide_repair')),false);
    for(const stage of ['support_review','guide_review','speech_detail_review'])assert.ok(model.transportStages.includes(stage));
  }
});

test('a causal focus is not an exemption for patient inference, mixed subjects or invented selfcare history',async()=>{
  for(const sentence of [
    '상대방은 무거운 마음 때문에 연락을 피하는 겁니다.',
    '이용자는 걱정되는 마음 때문에 무리하지 말되 상대도 같은 마음 때문에 연락을 피한다고 이해하세요.',
    '이용자님은 무력한 마음 때문에 이미 여러 약속을 취소하셨습니다.',
  ]) {
    const candidate=guide();candidate.guide.doList=[sentence];const reviews=[];
    const model=causalReviewGateway(candidate,{speechReview:input=>{
      reviews.push(input.stage);
      const bad=input.data.claims.find(row=>row.claim===sentence);
      return {approved:!bad,issues:bad?[{field:'doList',reason:'원문에 없는 주체나 인과·과거 행동을 덧붙였습니다.',repair:'원문에 없는 사실을 제거하고 가능한 시간을 먼저 물어보세요.'}]:[],
        audits:input.data.claims.map(row=>({id:row.id,verdict:row===bad?'unsupported':'supported',reason:row===bad?'주장 전체를 뒷받침하는 원문이 없습니다.':'원문과 제안 범위를 유지했습니다.'}))};
    },repair:()=>({doList:['편한 시간을 물어보세요.']})});
    const result=await model.respond(context(),memory());
    assert.deepEqual(result.guide,guide().guide);
    assert.deepEqual(reviews,['speech_review','speech_review_after_repair']);
    assert.ok(model.transportStages.includes('guide_repair'));
  }
});

test('focused claims cannot be approved with unsupported, plausible, missing or duplicate audits',async()=>{
  for(const corrupt of ['unsupported','plausible','missing','duplicate']) {
    const candidate=guide();candidate.guide.doList=['걱정되는 마음 때문에 무리하지 말고 가능한 범위를 정해 보세요.'];
    const model=causalReviewGateway(candidate,{speechReview:input=>{
      const audits=input.data.claims.map(row=>({id:row.id,verdict:'supported',reason:'합성 감사 결과입니다.'}));
      const index=audits.findIndex(row=>row.id==='doList.0');
      if(corrupt==='missing')audits.splice(index,1);
      else if(corrupt==='duplicate')audits[index]={...audits[0]};
      else audits[index].verdict=corrupt;
      return {approved:true,issues:[],audits};
    }});
    await assert.rejects(model.respond(context(),memory()),error=>error.code==='MODEL_INVALID_RESPONSE'&&
      error.modelReason===(corrupt==='missing'?'agent_schema':'agent_claim_audit'));
    assert.equal(model.transportStages.includes('guide_review'),false);
  }
});

test('focus covers script, care, next and avoided quotes without dropping any other claim',async()=>{
  const candidate=guide();
  candidate.guide.script='나는 걱정되는 마음 때문에 연락했어. 지금 이야기해도 괜찮을까?';
  candidate.guide.next='걱정되는 마음 때문에 약속을 늘리기 전에 가능한 범위를 먼저 정해 보세요.';
  candidate.guide.care.tips=['무력한 마음 때문에 모든 일을 맡지는 마세요.'];
  candidate.guide.avoid=[causalAvoidText];
  const model=causalReviewGateway(candidate,{speechReview:input=>{
    assert.deepEqual(input.data.semantic_review_focus,['script.0','avoid.0','next.0','care.1']);
    assert.equal(input.data.claims.find(row=>row.id==='avoid.0').claim,candidate.guide.avoid[0]);
    assert.ok(input.data.claims.some(row=>row.id==='doList.0'));
    return {approved:true,issues:[]};
  }});
  const result=await model.respond(context(),memory());assert.deepEqual(result.guide,candidate.guide);
});

test('ordinary guides do not gain causal review metadata or extra full-guide reviews',async()=>{
  const model=causalReviewGateway(guide(),{speechReview:input=>{
    assert.equal(Object.hasOwn(input.data,'semantic_review_focus'),false);return {approved:true,issues:[]};
  }});
  const result=await model.respond(context(),memory());assert.deepEqual(result.guide,guide().guide);
  assert.equal(model.transportStages.filter(stage=>stage==='speech_review').length,1);
});

const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const approvedCardOutputs=()=>({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
  guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}});
const applyCardEvent=(cards,event)=>{
  if(event.type==='reset')cards.clear();
  else if(event.type==='remove')cards.delete(event.id);
  else {const {type,...card}=event;cards.set(card.id,card);}
};

test('actual card and complete-guide reviews share the final guidance boundary without changing sources or saved cards',async()=>{
  const outputs=approvedCardOutputs(),model=gateway(body=>fixtureEnvelope(outputs[JSON.parse(body.messages.at(-1).content).stage]));
  const result=await model.respond(context(),memory());
  const expectedStages=['speech_review_card_script','speech_review_card_care','speech_review_card_doList',
    'speech_review_card_avoid','speech_review_card_next','support_review_card_care','support_review_card_next',
    'speech_review','support_review','guide_review'];
  for(const stage of expectedStages){
    const index=model.transportStages.indexOf(stage);assert.ok(index>=0,stage);
    const prompt=model.transportPrompts[index],input=model.transportInputs[index];
    assert.ok(prompt.endsWith(GUIDANCE_REVIEW_BOUNDARY),stage);
    assert.equal(prompt.split(GUIDANCE_REVIEW_BOUNDARY).length-1,1,stage);
    const expectedAnswers=agentContext(context());if(stage==='guide_review')delete expectedAnswers.prior_relationship_memory;
    assert.deepEqual(input.data.answers,expectedAnswers,stage);
    if(input.data.claims){
      assert.ok(input.data.claims.every(claim=>!Object.hasOwn(claim,'certainty')),stage);
      assert.ok(input.data.claims.every(claim=>claim.claim_kind===(claim.field==='avoid'?'avoidance_guidance':'guidance')),stage);
      assert.deepEqual(Object.keys(input.output_schema.properties),['audits','issues','approved'],stage);
      const audit=input.output_schema.properties.audits.items;
      for(const branch of audit.anyOf||[audit]){
        assert.deepEqual(Object.keys(branch.properties),['id','reason','verdict'],stage);
        const avoidance=branch.properties.id.enum.every(id=>id.startsWith('avoid.'));
        assert.deepEqual(branch.properties.verdict.enum,avoidance?['sound_avoidance','problem_in_recommended_content','unclear']:['sound_guidance','problem_in_guidance','unclear'],stage);
      }
    }
    const field=input.data.review_scope?.guide_fields?.[0];
    if(stage.includes('_card_'))assert.equal(prompt.split('이번 호출에서는 guide의 '+field+' 카드 하나만').length-1,1,stage);
    else assert.ok(!prompt.includes('이번 호출에서는 guide의'),stage);
  }
  for(const stage of ['relationship_analysis','analysis_review','communication_plan','plan_review','guide_quality']){
    const index=model.transportStages.indexOf(stage);assert.ok(index>=0,stage);
    assert.ok(!model.transportPrompts[index].includes(GUIDANCE_REVIEW_BOUNDARY),stage);
  }
  const writer=model.transportStages.indexOf('card_care');assert.ok(writer>=0);
  assert.ok(model.transportPrompts[writer].includes(CARD_ROLES.care));
  assert.deepEqual(result.guide,guide().guide);
  for(const stage of ['analysis_review','speech_detail_review']){
    const input=model.transportInputs.find(input=>input.stage===stage);assert.ok(input,stage);
    assert.ok(input.data.claims.length>0,stage);
    assert.ok(input.data.claims.every(claim=>Object.hasOwn(claim,'certainty')&&!Object.hasOwn(claim,'claim_kind')),stage);
  }
});

test('three independent branches overlap and only individually approved cards appear before all writers finish',async t=>{
  const gates={script:deferred(),care:deferred(),doList:deferred()},allStarted=deferred(),careReviewStarted=deferred(),careReview=deferred();
  const approvedDoList=deferred(),approvedCare=deferred(),started=new Set(),cards=new Map(),events=[];
  const hold=async field=>{started.add(field);if(started.size===3)allStarted.resolve();await gates[field].promise;};
  t.after(()=>{Object.values(gates).forEach(gate=>gate.resolve());careReview.resolve();});
  const outputs=approvedCardOutputs(),model=gateway(body=>fixtureEnvelope(outputs[JSON.parse(body.messages.at(-1).content).stage]),{
    cardWrite:async input=>{const field=Object.keys(input.output_schema.properties)[0];if(gates[field])await hold(field);return {[field]:guide().guide[field]};},
    speechPart:async input=>{if(input.stage==='speech_opening')await hold('script');return Object.fromEntries(Object.keys(input.output_schema.properties).map(key=>[key,'원문을 확인하고 이야기를 듣고 싶어.']));},
    cardReview:async input=>{if(input.stage==='support_review_card_care'){careReviewStarted.resolve();await careReview.promise;}return {approved:true,issues:[]};},
  });
  let inFlight=0,maximum=0;const transport=model.fetchImpl;
  model.fetchImpl=async(...args)=>{inFlight++;maximum=Math.max(maximum,inFlight);try{return await transport(...args);}finally{inFlight--;}};
  const pending=model.respond(context(),memory(),{onCard:event=>{
    events.push(event);applyCardEvent(cards,event);
    if(event.type==='upsert'&&event.id==='doList')approvedDoList.resolve();
    if(event.type==='upsert'&&event.id==='care')approvedCare.resolve();
  }});
  await allStarted.promise;
  assert.deepEqual([...started].sort(),['care','doList','script']);assert.equal(maximum,3);
  assert.deepEqual([...cards.keys()],['relationship']);
  assert.deepEqual(cards.get('relationship').value,canonicalAnalysis(analysis()));
  gates.doList.resolve();await approvedDoList.promise;
  assert.equal(cards.has('script'),false);assert.equal(cards.has('care'),false);
  assert.equal(model.transportStages.includes('guide_quality'),false);
  gates.care.resolve();await careReviewStarted.promise;
  assert.equal(cards.has('care'),false); // Speech audit alone is insufficient for this card.
  careReview.resolve();await approvedCare.promise;gates.script.resolve();
  const result=await pending;
  assert.equal(maximum,3);assert.equal(inFlight,0);
  for(const field of ['care','doList','avoid','next','script'])assert.deepEqual(cards.get(field).value,result.guide[field]);
  assert.deepEqual(cards.get('script').detail,result.conversation_detail);
  assert.deepEqual(cards.get('relationship').value,result.relationship_analysis);
  assert.equal(events.filter(event=>event.type==='upsert'&&event.id==='script').length,2);
  assert.equal(result.agent.reviewed,true);assert.equal(result.agent.quality_reviewed,true);
});

for(const skipFinalExtras of [false,true])test('a rejected individual card retains its exact audits through repair and is never published before reapproval: fast='+skipFinalExtras,async()=>{
  const outputs=approvedCardOutputs(),events=[],repaired='어떤 도움이 필요한지 먼저 물어보세요.';
  let repairs=0,reviews=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage==='guide_repair_card_doList_1'){
      repairs++;assert.equal(events.some(event=>event.type==='upsert'&&event.id==='doList'),false);
      assert.equal(input.data.review.audits[0].reason,'상대의 현재 선택을 확인해야 합니다.');
      assert.deepEqual(input.data.current,guide().guide.doList);
      return envelope({doList:[repaired]});
    }
    return fixtureEnvelope(outputs[input.stage]);
  },{cardReview:input=>{
    if(!input.stage.startsWith('speech_review_card_doList'))return {approved:true,issues:[]};
    reviews++;
    if(reviews===1)return {approved:false,issues:[{field:'doList',reason:'현재 선택을 확인하세요.',repair:'원하는 도움이 무엇인지 먼저 물으세요.'}],
      audits:input.data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason:'상대의 현재 선택을 확인해야 합니다.'}))};
    assert.equal(input.data.revision.previous_review.audits[0].verdict,'unsupported');
    assert.deepEqual(input.data.revision.changes,[{field:'doList',before:guide().guide.doList,after:[repaired]}]);
    return {approved:true,issues:[]};
  }});
  model.skipFinalExtras=skipFinalExtras;
  const result=await model.respond(context(),memory(),{onCard:event=>events.push(event)});
  assert.equal(repairs,1);assert.equal(reviews,2);assert.deepEqual(result.guide.doList,[repaired]);
  assert.deepEqual(events.filter(event=>event.type==='upsert'&&event.id==='doList').map(event=>event.value),[[repaired]]);
});

test('card reviews distinguish action-purpose guidance from spoken script without exempting unsupported claims',async()=>{
  const candidate=guide();candidate.guide.doList=['원하면 어떤 도움이 필요한지 먼저 물어보세요. 함께 알아볼 방법을 고를 수 있도록 돕는 것이 목적입니다.'];
  for(const unsupported of [false,true]){
    const outputs={...approvedCardOutputs(),guide_write:candidate};let reviews=0;
    const model=gateway(body=>fixtureEnvelope(outputs[JSON.parse(body.messages.at(-1).content).stage]),{
      cardReview:(input,request)=>{
        if(input.stage!=='speech_review_card_doList')return {approved:true,issues:[]};
        reviews++;
        const prompt=JSON.parse(request.body).messages[0].content;
        assert.ok(prompt.includes('script만 대상자에게 그대로 건넬 직접 발화입니다'));
        assert.ok(prompt.includes('doList는 행동 방법·예문·제안 목적'));
        assert.ok(prompt.includes('목적 설명 자체를 발화가 아니라는 이유로 거절하지 마세요'));
        assert.ok(prompt.includes('효과 보장이나 원문에 없는 마음·사건·인과를 추가하면 계속 거절'));
        assert.equal(input.data.claims[0].claim,candidate.guide.doList[0]);
        return {approved:true,issues:[],audits:input.data.claims.map(claim=>({id:claim.id,verdict:unsupported?'unsupported':'supported',reason:'합성 근거 판정입니다.'}))};
      },
    });
    if(unsupported){await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_claim_audit'});assert.equal(reviews,3);}
    else {const result=await model.respond(context(),memory());assert.deepEqual(result.guide.doList,candidate.guide.doList);assert.equal(reviews,1);}
  }
});

test('care speech reviews retain the same complete supporter sources as care writing and support review',async()=>{
  const ctx=context();ctx.supporter.fields.quiet_report=field('quiet_report','별빛과 밤하늘을 기록해요.');
  for(let index=0;index<16;index++)ctx.supporter.fields['extra'+index]=field('extra'+index,'감정 마음 부담 무력 걱정 잠 갈등 변화 한계 방법 도움 대처 나누거나 기댈 지원 '+index);
  const required=Object.keys(ctx.supporter.fields),seen=[];
  const assertSources=input=>{
    const sources=input.data.retrieval.documents.filter(row=>row.subject==='supporter').map(row=>row.question_id);
    for(const id of required)assert.ok(sources.includes(id),input.stage+' omitted '+id);
    seen.push(input.stage);
  };
  const outputs=approvedCardOutputs(),model=gateway(body=>fixtureEnvelope(outputs[JSON.parse(body.messages.at(-1).content).stage]),{
    cardWrite:input=>{const field=Object.keys(input.output_schema.properties)[0];if(field==='care')assertSources(input);return {[field]:guide().guide[field]};},
    cardReview:(input,request)=>{
      if(input.stage.endsWith('_care')){
        assertSources(input);
        if(input.stage.startsWith('speech_review')){
          const prompt=JSON.parse(request.body).messages[0].content;
          assert.ok(prompt.includes('감정 보고가 없다'));
          assert.ok(prompt.includes('새 감정·강도·원인을 덧붙인 부분'));
        }
      }
      return {approved:true,issues:[]};
    },
    speechReview:input=>{assertSources(input);return {approved:true,issues:[]};},
    supportReview:input=>{assertSources(input);return {approved:true,issues:[]};},
  });
  await model.respond(ctx,memory());
  for(const stage of ['card_care','speech_review_card_care','support_review_card_care','speech_review','support_review'])assert.ok(seen.includes(stage));
});

test('current-presence attribution cannot exempt stale quotes by mentioning source evidence',()=>{
  const removed='항상 마음이 편안할 것이라고 확신해요';
  const linked='원하는 때에 말을 걸어도 돼요. 오래 고민할 필요는 없어요? 결정은 자유예요!';
  const current='원할 때 필요한 도움을 물어보세요.';
  const claims=[{id:'avoid.0',field:'avoid',claim:`${linked} ${current}`,certainty:'reported'}];
  const schema=structuredClone(reviewSchema);schema.properties.audits=auditSchema(claims);schema.required.push('audits');
  const revision={before:{avoid:[linked,removed,'무력하고 걱정돼요']}},answers=agentContext(context());
  const review=reason=>({approved:false,issues:[{field:'avoid',reason,repair:'현재 문안의 선택 조건을 원문과 대조하세요.'}],
    audits:[{id:'avoid.0',verdict:'unsupported',reason:'현재 선택 조건을 확인해야 합니다.'}]});
  for(const reason of [
    `현재 문안에 포함된 “${removed}”는 원문 근거가 없는 단정입니다.`,
    `현재 카드에 남아 있는 ‘${removed}’는 자기보고와 다릅니다.`,
    `현재 문안에 포함된 “${linked}”와 “${removed}”는 원문 근거가 없습니다.`,
  ])assert.throws(()=>validateClaimReview(review(reason),schema,claims,revision,answers),error=>{
    assert.equal(error.modelReason,'agent_review_stale');
    assert.deepEqual(JSON.parse(error.modelFeedback).stale_quotes,[{field:'avoid',quote:removed}]);return true;
  });
  for(const reason of [
    `원문에서 “${removed}”라고 했다는 해석과 현재의 제안은 다릅니다.`,
    `“${removed}”라는 원문 표현과 현재 제안을 대조해야 합니다.`,
    `현재 문안에 포함된 표현과 비교하면, 원문에서 “${removed}”라는 뜻은 확인되지 않습니다.`,
    `이전 “${removed}” 표현은 삭제되었지만 현재 선택 조건은 확인해야 합니다.`,
    `현재 문안에 포함된 “${removed}”는 제거되었지만 현재 선택 조건은 확인해야 합니다.`,
    `현재 문안에 포함된 “무력하고 걱정돼요”는 원문 자기보고를 가리킵니다.`,
    `현재 문안에 포함된 “${current}”는 원문 근거가 부족합니다.`,
  ]){
    const value=review(reason),before=structuredClone(value);
    const result=validateClaimReview(value,schema,claims,revision,answers);
    assert.equal(result.approved,false);assert.deepEqual(result.issues,before.issues);assert.deepEqual(result.audits,before.audits);
  }
});

test('review retries stale historical quotations against current claims without spending another card repair',async()=>{
  for(const staleIn of ['audit','issue','source_wording']){
    const old=staleIn==='audit'?'네가 얼마나 노력하고 있는지 내가 잘 알아':'네가 용기 내줘서 고마워';
    const current='원하면 어떤 도움이 필요한지 먼저 물어보세요.';
    const candidate=guide();candidate.guide.next=old;
    const outputs={...approvedCardOutputs(),guide_write:candidate};let repairs=0,rechecks=0;
    const model=gateway(body=>{
      const input=JSON.parse(body.messages.at(-1).content);
      if(input.stage.startsWith('guide_repair_card_next')){
        repairs++;assert.equal(input.stage,'guide_repair_card_next_1');return envelope({next:current});
      }
      return fixtureEnvelope(outputs[input.stage]);
    },{cardReview:input=>{
      if(!input.stage.startsWith('speech_review_card_next'))return {approved:true,issues:[]};
      const stale=staleIn==='source_wording'?'현재 문안에 포함된 “'+old+'”는 원문 근거가 없는 단정입니다.':'“'+old+'”는 현재 카드에서 반응을 미리 단정하는 표현입니다.';
      if(input.stage==='speech_review_card_next')return {approved:false,issues:[{field:'next',reason:stale,repair:'현재 의사를 묻는 제안으로 바꾸세요.'}],
        audits:input.data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason:stale}))};
      rechecks++;assert.equal(input.stage,'speech_review_card_next_after_repair_1');
      assert.equal(input.data.claims[0].claim,current);
      if(rechecks===1)return {approved:false,issues:[{field:'next',reason:staleIn!=='audit'?stale:'현재 제안의 근거를 확인하세요.',repair:'현재 의사를 확인하세요.'}],
        audits:input.data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason:staleIn==='audit'?stale:'현재 제안의 근거를 확인하세요.'}))};
      assert.ok(input.validation_feedback.includes('agent_review_stale'));
      assert.equal(input.data.revision,undefined);assert.equal(input.rejected_output,undefined);
      assert.ok(!JSON.stringify(input).includes(old));
      return {approved:true,issues:[]};
    }});
    const result=await model.respond(context(),memory());
    assert.equal(repairs,1);assert.equal(rechecks,2);assert.equal(result.guide.next,current);
  }
});

test('review explanations may quote current source answers or explicitly resolved historical wording',async()=>{
  for(const sourceQuote of [true,false]){
    const old=sourceQuote?'무력하고 걱정돼요':'네가 용기 내줘서 고마워';
    const candidate=guide();candidate.guide.next=old;
    const outputs={...approvedCardOutputs(),guide_write:candidate};let repairs=0,rechecks=0;
    const model=gateway(body=>{
      const input=JSON.parse(body.messages.at(-1).content);
      if(input.stage.startsWith('guide_repair_card_next')){repairs++;return envelope({next:repairs===1?'어떤 도움이 필요한지 물어보세요.':'원하면 어떤 도움이 필요한지 물어보세요.'});}
      return fixtureEnvelope(outputs[input.stage]);
    },{cardReview:input=>{
      if(!input.stage.startsWith('speech_review_card_next'))return {approved:true,issues:[]};
      if(input.stage.endsWith('_2'))return {approved:true,issues:[]};
      if(input.stage.includes('after_repair')){rechecks++;assert.equal(input.validation_feedback,undefined);}
      const reason=sourceQuote?'원문에서 “'+old+'”라고 보고했지만 현재 제안에는 선택권을 표시해야 합니다.':
        '이전 “'+old+'” 표현은 삭제되었지만 현재 제안에는 선택권을 표시해야 합니다.';
      return {approved:false,issues:[{field:'next',reason,repair:'원하면이라는 조건을 붙이세요.'}],
        audits:input.data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason}))};
    }});
    const result=await model.respond(context(),memory());
    assert.equal(repairs,2);assert.equal(rechecks,1);assert.equal(result.guide.next,'원하면 어떤 도움이 필요한지 물어보세요.');
  }
});

test('persistent stale review feedback exhausts three review requests without restarting generation',async()=>{
  const old='네가 용기 내줘서 고마워',candidate=guide();candidate.guide.next=old;
  const outputs={...approvedCardOutputs(),guide_write:candidate},controller=new AbortController();
  let analyses=0,repairs=0,rechecks=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage==='relationship_analysis'&&++analyses===3)controller.abort();
    if(input.stage.startsWith('guide_repair_card_next')){repairs++;return envelope({next:'원하면 필요한 도움이 있는지 물어보세요.'});}
    return fixtureEnvelope(outputs[input.stage]);
  },{cardReview:input=>{
    if(!input.stage.startsWith('speech_review_card_next'))return {approved:true,issues:[]};
    if(input.stage.includes('after_repair'))rechecks++;
    const reason='“'+old+'”는 현재 카드에서 반응을 미리 단정하는 표현입니다.';
    return {approved:false,issues:[{field:'next',reason,repair:'현재 선택을 물으세요.'}],
      audits:input.data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason}))};
  }});
  model.retryFailures=true;model.retryDelayMs=1;
  await assert.rejects(model.respond(context(),memory(),{signal:controller.signal}),{modelReason:'agent_review_stale'});
  assert.equal(analyses,1);assert.equal(repairs,1);assert.equal(rechecks,3);
});

test('quality refinement removes published cards before editing and republishes only the final approved values',async()=>{
  const outputs=approvedCardOutputs(),cards=new Map(),events=[],refined=guide();
  refined.guide.script='지민아, 지금 이야기해도 괜찮을까? 밤에 계획표를 고치는 모습을 봤어. 네 마음을 이해하고 싶어.';
  outputs.guide_quality={improvements:[{field:'script',reason:'허락 질문을 앞에 두세요.',repair:'첫 문장으로 옮기세요.'}]};
  outputs.guide_refine=refined;
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages.at(-1).content).stage;
    if(stage==='guide_quality')assert.equal(cards.size,6);
    if(['guide_refine','guide_review'].includes(stage))assert.deepEqual([...cards.keys()],['relationship']);
    return fixtureEnvelope(outputs[stage]);
  });
  const result=await model.respond(context(),memory(),{onCard:event=>{events.push(event);applyCardEvent(cards,event);}});
  assert.deepEqual(events.filter(event=>event.type==='remove').map(event=>event.id).sort(),['avoid','care','doList','next','script']);
  assert.equal(cards.get('script').value,refined.guide.script);
  assert.deepEqual(cards.get('script').detail,result.conversation_detail);
  assert.deepEqual(result.guide,refined.guide);
});

test('a failed parallel branch aborts and settles siblings, resets approved previews, and ignores late results',async()=>{
  const outputs=approvedCardOutputs(),events=[],started=deferred(),releaseFailure=deferred(),signals=[],settled=[];
  let branches=0;
  const waitForAbort=async(field,signal)=>{
    signals.push(signal);if(++branches===2)started.resolve();
    await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve();});
    settled.push(field);
  };
  const model=gateway(body=>fixtureEnvelope(outputs[JSON.parse(body.messages.at(-1).content).stage]),{
    cardWrite:async(input,{signal})=>{
      const field=Object.keys(input.output_schema.properties)[0];
      if(field==='care')await waitForAbort(field,signal);
      if(field==='doList'){await releaseFailure.promise;return {doList:[]};} // Violates the existing nonempty card schema.
      return {[field]:guide().guide[field]};
    },
    speechPart:async(input,{signal})=>{await waitForAbort('script',signal);return Object.fromEntries(Object.keys(input.output_schema.properties).map(key=>[key,'늦게 도착한 문장']));},
  });
  const pending=model.respond(context(),memory(),{onCard:event=>events.push(event)});
  const rejected=assert.rejects(pending,{code:'MODEL_INVALID_RESPONSE'});
  await started.promise;assert.deepEqual(events.map(event=>event.id),['relationship']);
  releaseFailure.resolve();await rejected;
  assert.deepEqual(settled.sort(),['care','script']);assert.ok(signals.every(signal=>signal.aborted));
  assert.deepEqual(events,[{type:'upsert',id:'relationship',value:canonicalAnalysis(analysis())},{type:'reset'}]);
  assert.equal(model.transportStages.some(stage=>stage.includes('_review_card_')),false);
  assert.equal(model.transportStages.includes('guide_quality'),false);
});

test('external cancellation settles all active card branches before returning and clears their previews',async()=>{
  const outputs=approvedCardOutputs(),controller=new AbortController(),started=deferred(),signals=[],settled=[],events=[];
  const hold=async(field,signal)=>{
    signals.push(signal);if(signals.length===3)started.resolve();
    await new Promise(resolve=>{signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve();});
    settled.push(field);
  };
  const model=gateway(body=>fixtureEnvelope(outputs[JSON.parse(body.messages.at(-1).content).stage]),{
    cardWrite:async(input,{signal})=>{const field=Object.keys(input.output_schema.properties)[0];await hold(field,signal);return {[field]:guide().guide[field]};},
    speechPart:async(input,{signal})=>{await hold('script',signal);return Object.fromEntries(Object.keys(input.output_schema.properties).map(key=>[key,'늦게 도착한 문장']));},
  });
  const pending=model.respond(context(),memory(),{signal:controller.signal,onCard:event=>events.push(event)});
  const rejected=assert.rejects(pending,{code:'MODEL_CANCELLED'});
  await started.promise;controller.abort();await rejected;
  assert.deepEqual(settled.sort(),['care','doList','script']);assert.ok(signals.every(signal=>signal.aborted));
  assert.deepEqual(events.map(event=>event.type),['upsert','reset']);
  assert.equal(model.transportStages.some(stage=>stage.includes('_review_card_')),false);
});

test('exhausted card review repairs stay terminal and cannot restart the entire generation',async()=>{
  const outputs=approvedCardOutputs(),events=[];let analyses=0,repairs=0,reviews=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage==='relationship_analysis')analyses++;
    if(input.stage.startsWith('guide_repair_card_doList')){repairs++;return envelope({doList:guide().guide.doList});}
    return fixtureEnvelope(outputs[input.stage]);
  },{cardReview:input=>{
    if(!input.stage.startsWith('speech_review_card_doList'))return {approved:true,issues:[]};
    reviews++;return {approved:false,issues:[{field:'doList',reason:'선택권을 확인하세요.',repair:'먼저 원하는지 물어보세요.'}],
      audits:input.data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason:'합성 거절 근거입니다.'}))};
  }});
  model.retryFailures=true;model.retryDelayMs=1;
  await assert.rejects(model.respond(context(),memory(),{onCard:event=>events.push(event)}),{modelReason:'agent_review_rejected'});
  assert.equal(analyses,1);assert.equal(repairs,2);assert.equal(reviews,3);
  assert.equal(events.some(event=>event.type==='upsert'&&event.id==='doList'),false);
  assert.equal(events.at(-1).type,'reset');
});

test('urgent fixed cards are published only after the complete urgent review approves them',async()=>{
  const ctx=riskContext(),events=[],cards=new Map(),draft=urgentGuide(ctx.name_index);
  const outputs={relationship_analysis:riskAnalysis(ctx),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
    guide_write:draft,guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}};
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages.at(-1).content).stage;
    if(['guide_write','guide_quality','guide_review'].includes(stage))assert.deepEqual([...cards.keys()],['relationship']);
    return fixtureEnvelope(outputs[stage]);
  });
  const result=await model.respond(ctx,memory(),{onCard:event=>{events.push(event);applyCardEvent(cards,event);}});
  assert.equal(model.transportStages.some(stage=>stage.startsWith('card_')||stage.includes('_review_card_')),false);
  for(const field of ['care','doList','avoid','next','script'])assert.deepEqual(cards.get(field).value,result.guide[field]);
  assert.equal(events.length,6);assert.equal(cards.get('script').detail,undefined);
});

test('a reviewer must replace a rejected claim with an actionable repair before consuming a card repair',async()=>{
  for(const stagePrefix of ['speech','support']){
    const current='어떤 도움이 필요한지 물어보세요.',fixed='원하면 어떤 도움이 필요한지 물어보세요.';
    const candidate=guide();candidate.guide.next=current;
    const outputs={...approvedCardOutputs(),guide_write:candidate};let checks=0,repairs=0;
    const model=gateway(body=>{
      const input=JSON.parse(body.messages.at(-1).content);
      if(input.stage.startsWith('guide_repair_card_next')){
        repairs++;assert.equal(input.stage,'guide_repair_card_next_1');
        assert.equal(input.data.task,'원하면이라는 조건을 붙이세요.');
        return envelope({next:fixed});
      }
      return fixtureEnvelope(outputs[input.stage]);
    },{cardReview:input=>{
      if(!input.stage.startsWith(stagePrefix+'_review_card_next'))return {approved:true,issues:[]};
      if(input.stage.includes('after_repair')){
        assert.equal(input.data.claims[0].claim,fixed);
        return {approved:true,issues:[]};
      }
      checks++;
      if(checks===2){
        assert.ok(input.validation_feedback.includes('unchanged_repair_claims'));
        assert.equal(repairs,0);
      }
      return {approved:false,issues:[{field:'next',reason:'선택권을 명시해야 합니다.',
        repair:checks===1?'  '+current+'  ':'원하면이라는 조건을 붙이세요.'}],
        audits:input.data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason:'현재 제안에 선택 조건이 필요합니다.'}))};
    }});
    const result=await model.respond(context(),memory());
    assert.equal(checks,2);assert.equal(repairs,1);assert.equal(result.guide.next,fixed);
  }
});

test('persistent unchanged reviewer repairs stop after bounded review attempts without approving or rewriting the guide',async()=>{
  const candidate=guide(),outputs=approvedCardOutputs();let checks=0,repairs=0,analyses=0;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage==='relationship_analysis')assert.equal(++analyses,1);
    if(input.stage.startsWith('guide_repair_card_next'))repairs++;
    return fixtureEnvelope(outputs[input.stage]);
  },{cardReview:input=>{
    if(input.stage!=='speech_review_card_next')return {approved:true,issues:[]};
    checks++;
    return {approved:false,issues:[{field:'next',reason:'현재 제안을 다시 확인해야 합니다.',repair:candidate.guide.next}],
      audits:input.data.claims.map(claim=>({id:claim.id,verdict:'unsupported',reason:'원문 대조가 필요합니다.'}))};
  }});
  model.retryFailures=true;model.retryDelayMs=1;
  await assert.rejects(model.respond(context(),memory()),{modelReason:'agent_review_noop'});
  assert.equal(checks,3);assert.equal(repairs,0);assert.equal(analyses,1);
});


// Synthetic continuation reports exercise the focused review's real wire shape
// and bounded repair integration, not the model's semantic accuracy.
const focusedContinuationContext=()=>{
  const ctx=context(),id='continuation_1_0123456789abcdef';
  ctx.supporter.fields[id]=field(id,'저는 내일 저녁에 통화할 여유가 있어요.');
  return ctx;
};
const focusedContinuationReply=(input,{rejectNext=false}={})=>{
  const {sources,required_source_ids,units}=input.data;
  const response={source_events:required_source_ids.map(id=>{
    const source=sources.find(source=>source.id===id);
    return {source_id:id,quote:source.text,actor:'supporter',action:'통화할 여유가 있음',action_time:'내일 저녁',status:'availability'};
  }),checks:units.map(unit=>{
    const availability=unit.field==='next',failed=rejectNext&&availability;
    return {id:unit.id,utterance_frame:unit.role==='direct_speech'||unit.role==='alternative'?'current_reply':'not_speech',candidate_quote:unit.text,candidate_action_time:availability?(failed?'오늘 저녁':'내일 저녁'):'명시 없음',
      source_action_time:availability?'내일 저녁':'명시 없음',source_ids:availability?required_source_ids:[],
      relation:availability?(failed?'different':'same'):'not_applicable',statement:availability?'reported_fact':'other',
      comparison:failed?'원문은 내일 저녁의 여유만 보고했지만 안내는 오늘 저녁의 여유를 단정합니다.':'보고되지 않은 시점이나 합의를 단정하지 않습니다.',
      verdict:failed?'conflict':'consistent',repair:failed?'통화할 여유의 시점을 원문의 내일 저녁으로 고치세요.':null};
  })};
  validateSchema(response,input.output_schema);
  return response;
};

test('focused continuation rejection repairs only its card before fresh context and all existing final reviews',async()=>{
  const ctx=focusedContinuationContext(),before=structuredClone(ctx),candidate=guide();
  candidate.guide.next='오늘 저녁 통화할 여유가 있다고 전하고 상대에게 가능한지 물어보세요.';
  const fixed='내일 저녁 통화할 여유가 있다고 전하고 상대에게 가능한지 물어보세요.';
  const outputs={...approvedCardOutputs(),guide_write:candidate,guide_review_after_repair:{approved:true,issues:[]}};
  let focusedChecks=0;const repairs=[],focusedInputs=[];let rejectedCheck;
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage.startsWith('continuation_context_review')){
      focusedInputs.push(input);
      const reply=focusedContinuationReply(input,{rejectNext:++focusedChecks===1});
      if(focusedChecks===1)rejectedCheck={...reply.checks.find(check=>check.id==='next.0'),field:'next'};
      return envelope(reply);
    }
    if(input.stage.startsWith('guide_repair')){
      repairs.push(input);assert.equal(input.stage,'guide_repair');assert.equal(input.data.field,'next');
      assert.deepEqual(Object.keys(input.output_schema.properties),['next']);
      assert.equal(input.data.current,candidate.guide.next);
      assert.deepEqual(input.data.context_feedback,[rejectedCheck]);
      assert.deepEqual(input.data.answers,agentContext(ctx));
      return envelope({next:fixed});
    }
    return fixtureEnvelope(outputs[input.stage]);
  });
  const result=await model.respond(ctx,memory());
  assert.equal(focusedChecks,2);assert.equal(repairs.length,1);assert.equal(result.agent.reviewed,true);
  const expected={...candidate.guide,next:fixed};
  assert.deepEqual(result.guide,expected);assert.deepEqual(ctx,before);
  assert.equal(Object.hasOwn(focusedInputs[0].data,'guide'),false);
  assert.equal(focusedInputs[0].data.units.find(unit=>unit.id==='next.0').text,candidate.guide.next);
  assert.equal(focusedInputs[1].data.units.find(unit=>unit.id==='next.0').text,expected.next);
  assert.deepEqual(focusedInputs[1].data.units.filter(unit=>unit.field!=='next'),focusedInputs[0].data.units.filter(unit=>unit.field!=='next'));
  assert.deepEqual(focusedInputs[1].data.sources,focusedInputs[0].data.sources);
  assert.equal(focusedInputs[0].data.required_source_ids.length,1);
  const stages=model.transportStages,ordered=['continuation_context_review','guide_repair',
    'continuation_context_review_after_repair','speech_review_after_repair','support_review_after_repair','guide_review_after_repair'];
  for(let i=1;i<ordered.length;i++)assert.ok(stages.indexOf(ordered[i])>stages.indexOf(ordered[i-1]),ordered[i]);
  for(const stage of ['speech_review','support_review','guide_review'])assert.equal(stages.includes(stage),false);
  assert.deepEqual(model.transportInputs.find(input=>input.stage==='speech_review_after_repair').data.guide,expected);
  assert.deepEqual(model.transportInputs.find(input=>input.stage==='guide_review_after_repair').data.guide,expected);
});

test('persistent focused continuation rejection stops after two card repairs without final approval or generation restart',async()=>{
  const ctx=focusedContinuationContext(),before=structuredClone(ctx),candidate=guide(),events=[];
  candidate.guide.next='오늘 저녁 통화할 여유가 있다고 전하고 상대에게 가능한지 물어보세요.';
  const outputs={...approvedCardOutputs(),guide_write:candidate};let analyses=0,checks=0;const repairs=[];
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);
    if(input.stage==='relationship_analysis')analyses++;
    if(input.stage.startsWith('continuation_context_review')){
      checks++;assert.equal(input.data.units.find(unit=>unit.id==='next.0').text,candidate.guide.next);
      return envelope(focusedContinuationReply(input,{rejectNext:true}));
    }
    if(input.stage.startsWith('guide_repair')){
      repairs.push(input.stage);assert.equal(input.data.field,'next');
      assert.equal(input.data.context_feedback.length,1);assert.equal(input.data.context_feedback[0].field,'next');
      return envelope({next:candidate.guide.next});
    }
    return fixtureEnvelope(outputs[input.stage]);
  });
  model.retryFailures=true;model.retryDelayMs=1;
  await assert.rejects(model.respond(ctx,memory(),{onCard:event=>events.push(event)}),{modelReason:'agent_review_rejected'});
  assert.equal(analyses,1);assert.equal(checks,3);assert.deepEqual(repairs,['guide_repair','guide_repair_2']);
  assert.deepEqual(ctx,before);assert.equal(events.at(-1).type,'reset');
  assert.equal(model.transportStages.some(stage=>/^(?:speech_review|support_review|guide_review)(?:_after_repair.*)?$/u.test(stage)),false);
  assert.equal(model.transportStages.includes('speech_detail'),false);
});


test('malformed avoid quality edits reach focused card repair while preserving sources and every other card',async()=>{
  for(const malformed of ['답변을 재촉하지 마세요.',`피할 말·행동: ${avoidText} 이유: ${avoidExample.reason} 대신 ${avoidExample.alternative}`]) {
    const ctx=focusedContinuationContext(),before=structuredClone(ctx),refined=guide();
    refined.guide.avoid=[malformed];
    const outputs={...approvedCardOutputs(),guide_refine:refined,guide_review_after_repair:{approved:true,issues:[]},
      guide_quality:{improvements:[{field:'avoid',reason:'피할 말과 대안의 구분을 명확히 하세요.',repair:'피할 말과 실제 대안을 구분해 작성하세요.'}]}};
    let repairs=0,focusedChecks=0;
    const model=gateway(body=>{
      const input=JSON.parse(body.messages.at(-1).content);
      if(input.stage.startsWith('guide_repair')) {
        repairs++;assert.equal(input.stage,'guide_repair');assert.equal(input.data.field,'avoid');
        assert.deepEqual(Object.keys(input.output_schema.properties),['avoid']);
        assert.equal(input.data.issues.length,1);assert.equal(input.data.issues[0].field,'avoid');
        assert.deepEqual(input.data.answers,agentContext(ctx));
        // Rewrite from original reports and issues; do not copy the bad bundle.
        assert.equal(Object.hasOwn(input.data,'current'),false);
        return envelope({avoid:[structuredClone(avoidExample)]});
      }
      if(input.stage.startsWith('continuation_context_review')) {
        focusedChecks++;assert.equal(input.stage,'continuation_context_review_after_repair');
        assert.equal(Object.hasOwn(input.data,'guide'),false);
        assert.equal(input.data.units.find(unit=>unit.id==='avoid.0.reason').text,avoidExample.reason);
        assert.equal(input.data.units.find(unit=>unit.id==='avoid.0.alternative').text,avoidExample.alternative);
        return envelope(focusedContinuationReply(input));
      }
      return fixtureEnvelope(outputs[input.stage]);
    });
    const result=await model.respond(ctx,memory());
    assert.equal(repairs,1);assert.equal(focusedChecks,1);assert.equal(result.agent.reviewed,true);
    assert.deepEqual(result.guide,guide().guide);assert.deepEqual(ctx,before);
    assert.deepEqual(refined.guide.avoid,[malformed]);
    const stages=model.transportStages;
    for(const stage of ['speech_review_after_repair','support_review_after_repair','guide_review_after_repair'])
      assert.ok(stages.indexOf(stage)>stages.indexOf('continuation_context_review_after_repair'));
    assert.ok(stages.indexOf('guide_repair')>stages.indexOf('guide_quality_check'));
    assert.equal(stages.includes('continuation_context_review'),false);
  }
});
