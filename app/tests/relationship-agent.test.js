import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model.js';
import { validateRelationship, validateRelationshipDraft, canonicalRelationship, urgentGuideActions, validatePlan, validateReview, agentContext, validateRelationshipMemory,relationshipStateRequest,groundedEvidenceSchema,relationshipSchema,relationshipDraftSchema } from '../src/relationship-agent.js';
import { createIntake,answerIntake,applyModelUpdate,buildContext,backIntake,prepareModelAnswer } from '../src/intake.js';

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
const guide=()=>({guide:{top:'통합',script:'지민아, 밤에 계획표를 고치는 모습을 봤어. 네 마음을 이해하고 싶어. 지금 이야기해도 괜찮을까?',doList:['편한 시간을 물어보세요.'],avoid:['재촉하기. 대신 편한 시간을 물어보세요.'],next:'다음 대화 시간을 함께 정하고 자신도 쉬어 보세요.',care:{feel:'무력하고 걱정된 마음을 들려주셨어요.',tips:['잠시 쉬어 보세요.']}},assessment:{safety:false}});
const envelope=payload=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]}));
const draftAnalysis=(value=analysis())=>{
  const {patient_summary,supporter_summary,...draft}=structuredClone(value);
  return {observations:{patient:[ref()],supporter:[{subject:'supporter',question_id:'feeling',quote:'무력하고 걱정돼요'}]},...draft};
};
const canonicalAnalysis=(value,ctx=context())=>canonicalRelationship(draftAnalysis(value),ctx);
// Existing stored-report fixtures are adapted only at the model response boundary.
const fixtureEnvelope=payload=>envelope(payload?.relationship&&Object.hasOwn(payload,'patient_summary')?draftAnalysis(payload):payload);
const riskContext=text=>{
  const ctx=context();ctx.patient.fields.risk=field('risk',text||'지금 자신을 해치겠다고 말하며 위험한 곳에 있어요.');return ctx;
};
const riskAnalysis=(ctx,urgent=true)=>{
  const draft=draftAnalysis();draft.safety={urgent,evidence:[{subject:'patient',question_id:'risk',quote:ctx.patient.fields.risk.text}]};return draft;
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
function gateway(handler) {
  return new ModelGateway({baseUrl:'https://example.test/v1',apiKey:'test-only-secret',model:'gemma4:12b',protocol:'relationship_agent',diagnosticLogger:null,fetchImpl:async(_url,request)=>handler(JSON.parse(request.body))});
}

test('final analysis, quality and critical reviews use the same current evidence and preserve the existing guide contract',async()=>{
  const stages=[];
  const outputs={relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_quality:{improvements:[]},guide_review:{approved:true,issues:[]}};
  const model=gateway(body=>{
    const input=JSON.parse(body.messages[1].content); stages.push(input.stage);
    assert.equal(input.data.retrieval.method,'conversation_lexical_v1');
    assert.ok(input.data.retrieval.documents.some(row=>row.question_id==='mood'));
    assert.equal(body.model,'gemma4:12b'); assert.equal(body.reasoning_effort,'none');
    assert.equal(requestContainsSecret(input),false);
    return fixtureEnvelope(outputs[input.stage]);
  });
  const result=await model.respond(context(),memory());
  assert.deepEqual(stages,['relationship_analysis','analysis_review','communication_plan','guide_write','guide_quality','guide_review']);
  assert.deepEqual(result.guide,guide().guide);assert.deepEqual(result.relationship_analysis,canonicalAnalysis(analysis()));
  assert.equal(result.agent.reviewed,true);assert.deepEqual(result.patient_state,memory());
  assert.deepEqual(result.agent.retrieval.stages.map(row=>row.stage),stages);
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
  const model=gateway(body=>{calls++;const input=JSON.parse(body.messages.at(-1).content).data;assert.ok(input.patient.some(row=>row.question_id==='rel'&&row.answers.includes('자녀')));
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
  const result=await model.respond(ctx,bad);assert.equal(stages[0],'state');assert.deepEqual(result.patient_state,memory());
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
  assert.deepEqual(observed.prior_relationship_memory,relationshipMemory());
  assert.deepEqual(result.relationship_memory,relationshipMemory());
  ctx.patient.fields.mood.status='unknown';
  assert.equal(agentContext(ctx).prior_relationship_memory,null);
});

test('pending answers identify the newly supplied source without confusing the next question',()=>{
  const pending=prepareModelAnswer(createIntake(),{question_id:'name',text:'지민'},0);
  const ctx=buildContext(pending);
  assert.deepEqual(ctx.latest_answer,{question_id:'name',subject:'patient'});
  const request=relationshipStateRequest(ctx,null);
  assert.equal(request.data.latest_answer.question_id,'name');
  assert.deepEqual(request.data.latest_answer.answers,['지민']);
  assert.equal(request.data.latest_answer.status,'answered');
});

test('new supporter evidence is provided alongside prior observations and unavailable source IDs stay empty',()=>{
  const ctx=context();ctx.latest_answer={question_id:'feeling',subject:'supporter'};
  const request=relationshipStateRequest(ctx,memory());
  assert.deepEqual(request.data.latest_answer.answers,['무력하고 걱정돼요']);
  assert.equal(request.data.latest_answer.subject,'supporter');
  assert.deepEqual(request.data.prior_relationship_memory,relationshipMemory());
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
  assert.ok(state.properties.relationship_memory.properties.supporter.items.properties.evidence.items.enum.every(ref=>ref.subject==='supporter'));
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
  assert.equal(agentContext(ctx).patient.find(row=>row.question_id==='long').answers[0].length,2200);
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
    assert.throws(()=>validateRelationshipMemory(value,ctx),{modelReason:'agent_memory_name_only'});
  }
  const value=relationshipMemory();value.relationship=value.patient;value.patient=[];
  assert.throws(()=>validateRelationshipMemory(value,context()),{modelReason:'agent_schema'});
});

test('early goals cannot be copied into another actor in the state output schema',()=>{
  const ctx=context();ctx.patient.fields={name:field('name','지민')};ctx.supporter.fields={};
  const request=relationshipStateRequest(ctx,null);
  assert.equal(request.schema.properties.relationship_memory.properties.patient.maxItems,0);
  assert.equal(request.schema.properties.relationship_memory.properties.supporter.maxItems,0);
  assert.deepEqual(request.schema.properties.relationship_memory.properties.supporter.items.properties.evidence.items.properties.subject.enum,['supporter']);
});

test('MLX context overflow rejects once without dropping or shortening current source answers',async()=>{
  let calls=0;
  const model=gateway(()=>{calls++;return new Response(JSON.stringify({error:{type:'invalid_request_error',
    message:"input length (140000 tokens) exceeds the model's maximum context length (131072 tokens)"}}),{status:400});});
  await assert.rejects(model.updateState(context(),memory()),{code:'MODEL_CONTEXT_TOO_LONG'});
  assert.equal(calls,1);
});

test('quality refinement is checked again before an approved result is returned',async()=>{
  const stages=[];
  const model=gateway(body=>{
    const input=JSON.parse(body.messages.at(-1).content);stages.push(input.stage);
    if(input.stage==='guide_quality')return fixtureEnvelope({improvements:[{field:'script',reason:'전하고 싶은 마음을 더 직접 표현하기',repair:'이해하고 싶다는 원래 마음을 유지하세요.'}]});
    if(input.stage==='guide_refine'){assert.equal(input.data.quality.improvements.length,1);return fixtureEnvelope(guide());}
    return fixtureEnvelope({relationship_analysis:analysis(),analysis_review:{approved:true,issues:[]},communication_plan:plan(),guide_write:guide(),guide_review:{approved:true,issues:[]}}[input.stage]);
  });
  const result=await model.respond(context(),memory());
  assert.ok(stages.indexOf('guide_refine')<stages.indexOf('guide_review'));
  assert.equal(result.agent.quality_reviewed,true);
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
  model.agentComplete=(...args)=>{operations.push(args[5]);return complete(...args);};
  const result=await model.respond(ctx,memory());
  assert.equal(operations.length,stages.length);
  assert.ok(operations.every(operation=>operation===operations[0]));
  assert.deepEqual(stages,Object.keys(outputs));
  assert.deepEqual(result.guide,revisedGuide.guide);
  assert.deepEqual(result.relationship_analysis,canonicalAnalysis(corrected,ctx));
  assert.equal(result.relationship_analysis.supporter_summary,'이용자 자신의 상황에 관한 답변 원문:\n“여동생에게 힘든 점을 이야기해요”');
  assert.deepEqual(result.relationship_memory.relationship,[]);
  assert.deepEqual(result.relationship_memory.supporter,corrected.relationship.strengths);
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
    await assert.rejects(model.respond(ctx,memory()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_retrieval_evidence'});
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


test('a generated line-break marker becomes an actual paragraph before review and storage',async()=>{
  const model=gateway(body=>{
    const input=JSON.parse(body.messages[1].content),draft=guide();draft.guide.script+=' (줄바꿈) 편한 때 말해 줘.';
    if(input.stage==='relationship_analysis')return fixtureEnvelope(analysis());
    if(input.stage==='analysis_review')return fixtureEnvelope({approved:true,issues:[]});
    if(input.stage==='communication_plan')return fixtureEnvelope(plan());
    if(input.stage==='guide_write')return fixtureEnvelope(draft);
    assert.ok(input.data.guide.script.includes('\n\n'));
    assert.equal(input.data.guide.script.includes('(줄바꿈)'),false);
    return fixtureEnvelope(input.stage==='guide_quality'?{improvements:[]}:{approved:true,issues:[]});
  });
  const result=await model.respond(context(),memory());
  assert.ok(result.guide.script.includes('\n\n'));
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
  const outputs={relationship_analysis:riskAnalysis(ctx),analysis_review:{approved:true,issues:[]},communication_plan:plan(),
    guide_write:candidate,guide_quality:{improvements:[{field:'care',reason:'이용자 감정을 더 직접 표현하기',repair:'보고한 걱정과 무력감을 담으세요.'}]},
    guide_refine:candidate,guide_review:{approved:false,issues:[{field:'care',reason:'이용자 감정을 분명히 쓰세요.',repair:'보고한 감정만 쓰세요.'}]},
    guide_repair:candidate,guide_review_after_repair:{approved:true,issues:[]}};
  const model=gateway(body=>{
    const stage=JSON.parse(body.messages[1].content).stage;stages.push(stage);
    if(['guide_write','guide_refine','guide_repair'].includes(stage))assertUrgentSchema(body,ctx.name_index);
    return envelope(outputs[stage]);
  });
  const result=await model.respond(ctx,memory());
  assert.deepEqual(stages,Object.keys(outputs));assert.deepEqual(result.guide,candidate.guide);
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
      return envelope(outputs[stage]);
    });
    const result=await model.respond(ctx,memory());
    assert.deepEqual(stages,Object.keys(outputs));assert.deepEqual(result.guide,repaired.guide);
    assert.equal(Object.hasOwn(result.agent,'safety_guidance_version'),repairedUrgent);
    assert.equal(result.relationship_analysis.safety.urgent,repairedUrgent);
  }
});
