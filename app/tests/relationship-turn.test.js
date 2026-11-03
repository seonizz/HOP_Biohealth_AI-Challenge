import {safetyReviewFixture} from './helpers/safety-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { runCombinedRelationshipState, TURN_PROMPT_VERSION } from '../src/relationship-turn.js';
import { ModelGateway } from '../src/model.js';
import { relationshipStateRequest, relationshipQuestionRequest, validateRelationshipQuestions,
  questionReviewRequest, safetyReviewRequest, safetySources } from '../src/relationship-agent.js';

const field=(id,text,status='answered')=>({id,text,rawText:text,custom:'',status,question:id});
const context=()=>({patient:{alias:'지민',fields:{name:field('name','지민'),mood:field('mood','밤에 계획표를 고쳐요.')}},
  supporter:{fields:{feeling:field('feeling','저는 잠을 설칠 만큼 걱정돼요.')}},user_goal:{message:field('want','옆에서 이야기를 듣고 싶어요.')},
  latest_answer:{subject:'patient',question_id:'mood'},answered_count:4,adaptive_questions:true,
  question_candidates:[{id:'daily',subject:'patient',question:'생활에 어떤 변화가 있나요?'},{id:'extra',subject:'patient',question:'추가할 내용이 있나요?'}],
  clarification_candidates:[{id:'support_requested',subject:'patient',question:'직접 원한다고 말한 도움이 있나요?'}]});
const ref=(ctx=context(),subject='patient',id='mood')=>({subject,question_id:id,quote:ctx[subject].fields[id].rawText});
const draft=(ctx=context())=>({state:{patient_state:{facts:[{...ref(ctx),certainty:'reported'}],unknowns:[]},
  name_index:{alias:'지민',source_question_id:'name',quote:'지민'},
  relationship_memory:{patient:[{evidence:[ref(ctx)],certainty:'reported'}],supporter:[],relationship:[],unknowns:[]}},
  questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}});
const audits=(claims,verdict)=>claims.map(claim=>({id:claim.id,verdict:verdict||(claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':claim.certainty==='tentative'?'plausible':'supported'),reason:'원문과 대조한 합성 검토입니다.'}));
const review=data=>data.proposed_safety?safetyReviewFixture(data):
  data.claims?{audits:audits(data.claims)}:({state:{approved:true,issues:[],audits:audits(data.review_target.claims)},
  questions:data.questions?{audits:audits(data.questions.claims)}:null,
  safety:data.safety?{basis:'current_physical_danger',reason:'현재 위험을 명시한 전체 원문과 일치합니다.'}:null});
const skip=ctx=>({question_id:'daily',reason:'already_covered',explanation:'이미 생활 변화에 답했습니다.',evidence:[ref(ctx)]});
const restoredInput=(data,input)=>input===null?null:{...data.shared_input,...input};
const currentInput=({prior_state,prior_relationship_memory,...input})=>input;

function gateway(handler) {
  const calls=[];
  return {calls,async agentComplete(stage,prompt,data,schema,operation,validate) {
    const call={stage,prompt,data:structuredClone(data),schema:structuredClone(schema),operation};
    calls.push(call);
    const result=validate(structuredClone(stage.startsWith('safety_review')&&!data.proposed_safety.urgent?safetyReviewFixture(data):await handler(call,calls.length)));
    call.validated=structuredClone(result);return result;
  }};
}
function fixtureGateway(value,editReview,branch='state') {
  return gateway(call=>{
    if(call.stage.startsWith('turn_draft'))return value;
    const current=call.stage.startsWith('turn_review')?'state':call.stage.startsWith('question_review')?'questions':'safety';
    return editReview&&current===branch?editReview(review(call.data),call):review(call.data);
  });
}

test('a normal turn independently validates state and safety and existing output fields',async()=>{
  const ctx=context(),operation={id:'test-only'},model=fixtureGateway(draft(ctx));
  const output=await runCombinedRelationshipState(model,ctx,null,operation);
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review','safety_review']);
  assert.equal(model.calls[0].operation,operation);
  assert.notEqual(model.calls[1].operation,model.calls[2].operation);
  assert.equal(model.calls[1].operation.controller,model.calls[2].operation.controller);
  assert.notEqual(model.calls[1].operation,operation);
  assert.equal(model.calls[1].operation.id,operation.id);
  assert.equal(model.calls[1].operation.controller.signal.aborted,false);
  assert.deepEqual(output.question_plan,{skip:[]});assert.equal(output.clarification,null);assert.equal(output.finish_early,false);
  assert.deepEqual(output.state_agent,{prompt_version:TURN_PROMPT_VERSION,stages:['turn_draft','turn_review','safety_review'],reviewed:true});
  assert.equal(output.patient_state.facts[0].quote,ctx.patient.fields.mood.rawText);
  assert.equal(output.name_index.alias,'지민');
  assert.equal(model.calls[0].prompt.includes('질문 결정은 다음 별도 단계에서 수행합니다'),false);
  assert.equal(model.calls[0].prompt.includes('1800토큰을 넘기지'),false);
  const draftData=model.calls[0].data,reviewData=model.calls[1].data;
  assert.equal(reviewData.review_target.claims.find(claim=>claim.id==='patient.0').claim,output.relationship_memory.patient[0].interpretation);
  assert.deepEqual(restoredInput(reviewData,reviewData.review_target.input).patient,restoredInput(draftData,draftData.state_input).patient);
  assert.deepEqual(currentInput(restoredInput(draftData,draftData.state_input)),currentInput(relationshipStateRequest(ctx,null).data));
  assert.deepEqual(currentInput(restoredInput(draftData,draftData.question_input)),currentInput(relationshipQuestionRequest(ctx).data));
  assert.equal(Object.hasOwn(restoredInput(draftData,draftData.state_input),'previous_reviewed_context'),false);
  assert.equal(Object.hasOwn(restoredInput(draftData,draftData.question_input),'previous_reviewed_context'),false);
});

for(const [label,text,quote] of [
  ['late correction','처음에는 지금 위험하다고 전했어요. '+'연극의 순서와 대사를 기록했어요. '.repeat(80)+'앞선 말은 연극 대사였어요. 지금 자신이나 다른 사람을 해칠 생각이나 행동은 전혀 없다고 확인했어요.',
    '지금 자신이나 다른 사람을 해칠 생각이나 행동은 전혀 없다고 확인했어요.'],
  ['current denial','지민이는 지금 자신이나 다른 사람을 해칠 생각은 전혀 없다고 말했어요.',
    '지민이는 지금 자신이나 다른 사람을 해칠 생각은 전혀 없다고 말했어요.'],
  ['past and present','십 년 전에 자해한 적이 있었지만 그 이후에는 없었고 현재는 위험한 행동이나 해칠 생각이 없다고 말했어요.',
    '십 년 전에 자해한 적이 있었지만 그 이후에는 없었고 현재는 위험한 행동이나 해칠 생각이 없다고 말했어요.'],
]) test('selected latest reported facts enter memory before independent review without another call: '+label,async()=>{
  const ctx=context();ctx.patient.fields.risk=field('risk',text);ctx.latest_answer={subject:'patient',question_id:'risk'};
  const value=draft(ctx),evidence={subject:'patient',question_id:'risk',quote};
  value.state.patient_state.facts=[{...evidence,certainty:'reported'}];value.state.relationship_memory.patient=[];
  const original=JSON.stringify(value),model=fixtureGateway(value,(result,call)=>{
    assert.deepEqual(call.data.review_target.claims.map(claim=>({id:claim.id,certainty:claim.certainty,evidence:claim.evidence})),
      [{id:'patient.0',certainty:'reported',evidence:[evidence]}]);
    assert.equal(call.data.review_target.state.patient_state.facts.find(fact=>fact.question_id==='risk').quote,text);
    return result;
  });
  const output=await runCombinedRelationshipState(model,ctx,null,{});
  assert.deepEqual(output.relationship_memory.patient[0].evidence,[evidence]);
  assert.ok(output.relationship_memory.patient[0].interpretation.includes(quote));
  assert.deepEqual(output.relationship_memory.unknowns,[]);
  assert.equal(output.finish_early,false);assert.equal(output.safety_signal.urgent,false);
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review','safety_review']);
  assert.equal(JSON.stringify(value),original);
});

test('latest supporter facts retain their attribution and leave patient findings intact',async()=>{
  const ctx=context();ctx.latest_answer={subject:'supporter',question_id:'feeling'};
  const value=draft(ctx);value.state.patient_state.facts=[{...ref(ctx,'supporter','feeling'),certainty:'reported'}];
  const output=await runCombinedRelationshipState(fixtureGateway(value),ctx,null,{});
  assert.deepEqual(output.relationship_memory.supporter[0].evidence,[ref(ctx,'supporter','feeling')]);
  assert.deepEqual(output.relationship_memory.patient[0].evidence,[ref(ctx)]);
  assert.match(output.relationship_memory.supporter[0].interpretation,/이용자가 자신의 상황에 관해 보고한 답변 원문/u);
});

test('repeated facts already represented by reported memory do not duplicate findings or evidence',async()=>{
  const ctx=context(),value=draft(ctx);
  value.state.patient_state.facts.push(structuredClone(value.state.patient_state.facts[0]));
  const output=await runCombinedRelationshipState(fixtureGateway(value),ctx,null,{});
  assert.equal(output.relationship_memory.patient.length,1);
  assert.deepEqual(output.relationship_memory.patient[0].evidence,[ref(ctx)]);
});

for(const id of ['name','rel','contact']) test('latest metadata does not automatically become a relationship finding: '+id,async()=>{
  const ctx=context();if(id!=='name')ctx.patient.fields[id]=field(id,id==='rel'?'친구':'주말마다 연락해요.');
  ctx.latest_answer={subject:'patient',question_id:id};
  const value=draft(ctx);value.state.patient_state.facts=[{...ref(ctx,'patient',id),certainty:'reported'}];value.state.relationship_memory.patient=[];
  const output=await runCombinedRelationshipState(fixtureGateway(value),ctx,null,{});
  assert.deepEqual(output.relationship_memory.patient,[]);
});

for(const status of ['unknown','refused','not_asked']) test('an unconfirmed latest answer cannot be copied into reported memory: '+status,async()=>{
  const ctx=context();ctx.patient.fields.mood=field('mood',status==='unknown'?'잘 모르겠어요.':status==='refused'?'말하고 싶지 않아요.':'',status);
  const value=draft(ctx);value.state.relationship_memory.patient=[];
  value.state.patient_state.facts=[{...ref(ctx,'supporter','feeling'),certainty:'reported'}];
  const output=await runCombinedRelationshipState(fixtureGateway(value),ctx,null,{});
  assert.deepEqual(output.relationship_memory.patient,[]);
});

test('a selected fact with unknown certainty cannot be promoted to a reported finding',async()=>{
  const ctx=context(),value=draft(ctx);value.state.patient_state.facts[0].certainty='unknown';value.state.relationship_memory.patient=[];
  const output=await runCombinedRelationshipState(fixtureGateway(value),ctx,null,{});
  assert.deepEqual(output.relationship_memory.patient,[]);
});

test('bounded merging retains old denial and time evidence and an existing tentative finding',async()=>{
  const ctx=context();ctx.patient.fields.past=field('past','예전에는 그랬지만 지금은 그렇지 않다고 말했어요.');
  const value=draft(ctx),past=ref(ctx,'patient','past');
  const hypothesis={interpretation:'가능한 해석: 현재 상황을 더 확인할 필요가 있을 수 있어요.',certainty:'tentative',evidence:[past]};
  value.state.relationship_memory.patient=[{certainty:'reported',evidence:[past]},hypothesis];
  const output=await runCombinedRelationshipState(fixtureGateway(value),ctx,null,{});
  assert.equal(output.relationship_memory.patient.length,2);
  assert.deepEqual(output.relationship_memory.patient[0].evidence,[ref(ctx),past]);
  assert.deepEqual(output.relationship_memory.patient[1],hypothesis);
});

test('a full generated report retains the latest fact in a larger server bundle without truncating citations',async()=>{
  const ctx=context();for(const id of ['old1','old2','old3'])ctx.patient.fields[id]=field(id,id+'의 보고예요.');
  const value=draft(ctx),old=['old1','old2','old3'].map(id=>ref(ctx,'patient',id));
  value.state.relationship_memory.patient=[{certainty:'reported',evidence:old}];
  const output=await runCombinedRelationshipState(fixtureGateway(value),ctx,null,{});
  assert.equal(output.relationship_memory.patient.length,1);
  assert.deepEqual(output.relationship_memory.patient[0].evidence,[ref(ctx),...old]);
});

for(const fullGroup of ['tentative','reported_evidence']) test('insufficient memory capacity requires explicit draft repair without dropping prior evidence: '+fullGroup,async()=>{
  const ctx=context();for(const id of ['old1','old2','old3'])ctx.patient.fields[id]=field(id,id+'에는 그랬지만 현재는 아니라고 말했어요.');
  const value=draft(ctx),old=['old1','old2','old3'].map(id=>ref(ctx,'patient',id));
  value.state.relationship_memory.patient=[
    fullGroup==='tentative'?{certainty:'tentative',interpretation:'가능한 해석: 현재 상황을 더 확인할 필요가 있을 수 있어요.',evidence:[old[0]]}:{certainty:'reported',evidence:old},
    {certainty:'tentative',interpretation:'가능한 해석: 도움의 범위를 더 확인할 필요가 있을 수 있어요.',evidence:[old[1]]},
  ];
  const original=JSON.stringify(value),model=fixtureGateway(value);
  if(fullGroup==='tentative') {
    await assert.rejects(runCombinedRelationshipState(model,ctx,null,{}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_latest_fact_capacity'});
    assert.equal(model.calls.length,1);
  } else {
    const output=await runCombinedRelationshipState(model,ctx,null,{});
    assert.deepEqual(output.relationship_memory.patient[0].evidence,[ref(ctx),...old]);
    assert.deepEqual(output.relationship_memory.patient[1],value.state.relationship_memory.patient[1]);
    assert.equal(model.calls.length,3);
  }
  assert.equal(JSON.stringify(value),original);
});

test('fact reuse does not expand the relationship evidence schema to admit unavailable citation excerpts',async()=>{
  const ctx=context();ctx.patient.fields.mood=field('mood','가'.repeat(200));
  const value=draft(ctx);value.state.patient_state.facts=[{...ref(ctx),quote:'가'.repeat(160),certainty:'reported'}];value.state.relationship_memory.patient=[];
  const model=fixtureGateway(value);
  await assert.rejects(runCombinedRelationshipState(model,ctx,null,{}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(model.calls.length,1);
});

for(const verdict of ['missing','plausible','unsupported']) test('a preserved latest reported finding still requires its own supported audit: '+verdict,async()=>{
  const ctx=context(),value=draft(ctx);value.state.relationship_memory.patient=[];
  const model=fixtureGateway(value,result=>{
    if(verdict==='missing')result.state.audits=[];
    else result.state.audits[0].verdict=verdict;
    return result;
  });
  await assert.rejects(runCombinedRelationshipState(model,ctx,null,{}),{code:'MODEL_INVALID_RESPONSE'});
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review','safety_review']);
});

test('shared draft input preserves both current inputs and historical source references without truncation or shared retrieval permissions',async()=>{
  const ctx=context(),original=JSON.stringify(ctx);
  ctx.patient.fields.mood.followUp={question:'최근에는 어떤가요?',answer:field('mood_more','지금은 그렇지 않다고 정정했어요. '.repeat(80))};
  ctx.patient.fields.support=field('support','아직 모르겠어요.','unknown');
  ctx.supporter.fields.help=field('help','말하고 싶지 않아요.','refused');
  const before=JSON.stringify(ctx),value=draft(ctx),model=fixtureGateway(value);
  const prior={summary:'기존 관찰',facts:[{...ref(ctx),certainty:'reported',interpretation:'이전 보고'}],unknowns:[],user_goal:ctx.user_goal.message.text};
  const expected={state_input:relationshipStateRequest(ctx,prior).data,question_input:relationshipQuestionRequest(ctx).data};
  await runCombinedRelationshipState(model,ctx,prior,{});
  const data=model.calls[0].data;
  const state=restoredInput(data,data.state_input),question=restoredInput(data,data.question_input);
  assert.deepEqual(state,currentInput(expected.state_input));
  assert.deepEqual(question,currentInput(expected.question_input));
  assert.equal(Object.hasOwn(state,'previous_reviewed_context'),false);
  assert.equal(Object.hasOwn(question,'previous_reviewed_context'),false);
  assert.deepEqual(data.shared_input.patient,expected.state_input.patient);
  assert.equal(Object.hasOwn(data.state_input,'patient'),false);assert.equal(Object.hasOwn(data.question_input,'patient'),false);
  assert.equal(Object.hasOwn(data.shared_input,'retrieval'),false);
  assert.equal(data.state_input.retrieval.stage,'state');assert.equal(data.question_input.retrieval.stage,'question_plan');
  assert.ok(JSON.stringify(data).length<JSON.stringify(expected).length);
  assert.equal(JSON.stringify(ctx),before);assert.notEqual(before,original);
});

for(const proposal of ['none','questions','safety']) test('compact reviewer preserves original '+proposal+' inputs and every model-authored claim',async()=>{
  const ctx=context(),value=draft(ctx);
  value.state.patient_state.unknowns=['내일 대화 가능한 시간'];value.state.relationship_memory.unknowns=['현재 다른 지원자의 도움'];
  value.state.relationship_memory.relationship=[{interpretation:'도움의 방식을 함께 확인할 필요가 있을 수 있어요.',evidence:[ref(ctx)],certainty:'tentative'}];
  if(proposal==='questions'){value.questions.skip=[skip(ctx)];value.questions.clarify=['support_requested'];}
  if(proposal==='safety') {
    ctx.patient.fields.risk=field('risk','현재 자신을 해치겠다고 말하며 위험한 곳에 있어요.');
    value.questions.safety={urgent:true,evidence_ids:[safetySources(ctx).find(row=>row.question_id==='risk').id]};
  }
  const model=fixtureGateway(value),output=await runCombinedRelationshipState(model,ctx,null,{});
  const data=model.calls[1].data,{prior_state,prior_relationship_memory,...raw}=relationshipStateRequest(ctx,null).data;
  const request=relationshipQuestionRequest(ctx),decision=validateRelationshipQuestions(value.questions,ctx,request);
  const questions=proposal==='questions'?questionReviewRequest(decision,request).data:null;
  const safety=safetyReviewRequest(request,decision).data;
  assert.deepEqual(restoredInput(data,data.review_target.input),raw);
  assert.equal(data.questions,null);assert.equal(data.safety,null);
  assert.deepEqual(model.calls.find(call=>call.stage==='question_review')?.data||null,questions);
  assert.deepEqual(model.calls.find(call=>call.stage==='safety_review')?.data||null,safety);
  assert.deepEqual(data.review_target.state,{patient_state:{facts:output.patient_state.facts.map(({interpretation,...fact})=>fact)},name_index:output.name_index});
  assert.deepEqual(data.review_target.claims.map(claim=>claim.id),['patient.0','relationship.0','patient_state.unknowns.0','relationship_memory.unknowns.0']);
  assert.equal(data.review_target.claims.find(claim=>claim.id==='relationship.0').claim,output.relationship_memory.relationship[0].interpretation);
  assert.deepEqual(data.review_target.claims.filter(claim=>claim.kind==='unresolved_information').map(claim=>claim.claim),
    [...output.patient_state.unknowns,...output.relationship_memory.unknowns]);
  const {state_agent,...result}=output;
  const duplicated={review_target:{input:raw,state:result,claims:data.review_target.claims},questions,safety};
  assert.ok(JSON.stringify(data).length<JSON.stringify(duplicated).length);
  assert.equal(model.calls.length,proposal==='questions'?4:3);
});

for(const [label,mutate] of [
  ['invented source quote',value=>{value.state.patient_state.facts[0].quote='원문에 없는 말입니다.';}],
  ['cross-person memory',value=>{value.state.relationship_memory.patient[0].evidence[0]={subject:'supporter',question_id:'feeling',quote:'저는 잠을 설칠 만큼 걱정돼요.'};}],
  ['user goal promoted to patient evidence',value=>{value.state.relationship_memory.patient[0].evidence[0]={subject:'user_goal',question_id:'want',quote:'옆에서 이야기를 듣고 싶어요.'};}],
  ['unreported diagnostic label',value=>{value.state.relationship_memory.patient[0]={interpretation:'강박 때문에 계획표를 고치는 듯합니다.',evidence:[ref()],certainty:'tentative'};}],
  ['invented alias',value=>{value.state.name_index.alias='민수';}],
  ['draft self-approval',value=>{value.state.approved=true;}],
  ['questions nested inside state',value=>{value.state.questions=value.questions;delete value.questions;}],
]) test(label+' fails before reviewer or state commit',async()=>{
  const value=draft();mutate(value);const model=fixtureGateway(value);
  await assert.rejects(runCombinedRelationshipState(model,context(),null,{}),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(model.calls.length,1);
});

test('a completed draft missing relationship_memory.unknowns fails before review despite valid safety correction',async()=>{
  const ctx=context();ctx.patient.fields.mood=field('mood','예전에는 위험한 생각을 말했지만 오늘은 그런 생각이 전혀 없다고 정정했어요.');
  const value=draft(ctx);value.state.relationship_memory={patient:[],supporter:[],relationship:[]};
  const model=fixtureGateway(value);
  await assert.rejects(runCombinedRelationshipState(model,ctx,null,{}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft']);
  assert.equal(value.questions.safety.urgent,false);
  assert.ok(model.calls[0].schema.properties.state.properties.relationship_memory.required.includes('unknowns'));
});

for(const [label,edit] of [
  ['missing claim audit',value=>{value.state.audits=[];}],
  ['reported claim approved as plausible',value=>{value.state.audits[0].verdict='plausible';}],
  ['unsupported claim self-approved',value=>{value.state.audits[0].verdict='unsupported';}],
  ['approval with unresolved issues',value=>{value.state.issues=[{reason:'근거 없음',repair:'삭제'}];}],
]) test(label+' cannot become reviewed state',async()=>{
  const model=fixtureGateway(draft(),value=>{edit(value);return value;});
  await assert.rejects(runCombinedRelationshipState(model,context(),null,{}),{code:'MODEL_INVALID_RESPONSE'});
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review','safety_review']);
});

test('a rejected state regenerates the draft once and requires a fresh independent review',async()=>{
  const value=draft();
  const model=gateway((call,count)=>{
    if(call.stage.startsWith('turn_draft')) {
      if(count===3)assert.equal(call.data.review.state.approved,false);
      return value;
    }
    const result=review(call.data);
    if(count===2) {result.state.approved=false;result.state.issues=[{reason:'정정 반영 여부를 확인하세요.',repair:'현재 원문을 다시 확인하세요.'}];}
    return result;
  });
  const output=await runCombinedRelationshipState(model,context(),null,{});
  assert.deepEqual(output.state_agent.stages,['turn_draft','turn_review','safety_review','turn_draft_after_review','turn_review_after_review','safety_review_after_review']);
  assert.equal(output.state_agent.reviewed,true);
});

test('meaning-changing correction omissions require memory repair despite complete facts and correct safety',async()=>{
  const ctx=context(),correction='지금은 자신이나 다른 사람을 해칠 생각이나 행동이 전혀 없다고 정정했어요.';
  ctx.patient.fields.mood=field('mood','앞서 전한 위험한 말은 연극 대사였어요. '+correction);
  const value=draft(ctx);value.state.relationship_memory.patient=[];
  value.state.patient_state.facts=[{...ref(ctx,'supporter','feeling'),certainty:'reported'}];
  const repaired=structuredClone(value);
  repaired.state.relationship_memory.patient=[{certainty:'reported',evidence:[{...ref(ctx),quote:correction}]}];
  const model=gateway(call=>{
    if(call.stage==='turn_draft') {
      assert.ok(call.prompt.includes('해당 사람의 relationship_memory finding에 정정된 보고를 우선 보존'));
      assert.ok(call.prompt.includes('patient_state.facts의 원문 보존이나 questions.safety의 판정만으로 이 finding을 대신하지'));
      return value;
    }
    if(call.stage==='turn_draft_after_review') {
      assert.equal(call.data.review.state.approved,false);
      assert.deepEqual(call.data.review.state.audits,[]);
      return repaired;
    }
    if(call.stage.startsWith('safety_review'))return review(call.data);
    const result=review(call.data),state=call.data.review_target;
    assert.ok(call.prompt.includes('claims가 비었거나 기존 claims가 모두 각 유형의 승인 기준을 충족해도 이 누락이 있으면 state.approved=false'));
    assert.equal(state.state.patient_state.facts.find(fact=>fact.question_id==='mood').quote,ctx.patient.fields.mood.rawText);
    assert.ok(restoredInput(call.data,state.input).patient.find(row=>row.question_id==='mood').answers.some(answer=>answer.text===ctx.patient.fields.mood.rawText));
    assert.equal(call.data.safety,null);
    if(call.stage==='turn_review') {
      assert.deepEqual(state.claims,[]);
      result.state.approved=false;
      result.state.issues=[{reason:'현재 상태를 바꾸는 정정이 관계 기록에 없습니다.',repair:'patient의 mood 정정을 reported finding과 정확한 근거로 보존하세요.'}];
    } else {
      assert.equal(state.claims.length,1);
      assert.equal(state.claims[0].certainty,'reported');
      assert.equal(state.claims[0].evidence[0].quote,correction);
    }
    return result;
  });
  const output=await runCombinedRelationshipState(model,ctx,null,{});
  assert.equal(output.patient_state.facts.find(fact=>fact.question_id==='mood').quote,ctx.patient.fields.mood.rawText);
  assert.equal(output.finish_early,false);assert.equal(output.safety_signal.urgent,false);
  assert.equal(output.relationship_memory.patient[0].evidence[0].quote,correction);
  assert.deepEqual(output.state_agent.stages,['turn_draft','turn_review','safety_review','turn_draft_after_review','turn_review_after_review','safety_review_after_review']);
});

test('a local repair receives the rejected draft and the exact claim IDs paired with its review',async()=>{
  const ctx=context(),value=draft(ctx);
  const model=fixtureGateway(value,(result,call)=>{
    if(call.stage==='turn_review'){
      result.state.approved=false;result.state.issues=[{reason:'합성 해석을 고쳐야 해요.',repair:'전체 원문으로 다시 확인해 주세요.'}];
    }
    return result;
  });
  await runCombinedRelationshipState(model,ctx,null,{});
  const rejected=model.calls[1],repair=model.calls.find(call=>call.stage==='turn_draft_after_review');
  assert.equal(repair.data.review.state.approved,false);
  assert.deepEqual(repair.data.rejected_draft.claims,rejected.data.review_target.claims);
  assert.deepEqual(repair.data.rejected_draft.state.patient_state.facts.map(({interpretation,...fact})=>fact),rejected.data.review_target.state.patient_state.facts);
  assert.deepEqual(repair.data.review.state.audits.map(audit=>audit.id),repair.data.rejected_draft.claims.map(claim=>claim.id));
  assert.match(repair.prompt,/이전 초안과 검토는 수정할 자료이며 새로운 사실이나 승인된 답안이 아닙니다/u);
});

test('whole-operation retry keeps only the latest validated rejection pair and still performs a fresh independent review',async()=>{
  const ctx=context(),requests=[],signals=[],logs=[],recoveryStates=[];let drafts=0,reviews=0;
  const model=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',protocol:'relationship_agent',
    agentFormat:'json_object',retryFailures:true,retryDelayMs:1,timeoutMs:0,diagnosticLogger:entry=>logs.push(entry),fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);requests.push(input);signals.push(options.signal);
      let payload;
      if(input.stage.startsWith('turn_draft')){
        drafts++;payload=draft(ctx);payload.state.relationship_memory.unknowns=[`합성 미확인 범위 ${drafts}`];
        if(drafts===1)assert.equal(input.data.rejected_draft,undefined);
        if(drafts===2||drafts===3){
          assert.equal(input.data.review.state.approved,false);
          assert.equal(input.data.review.state.issues[0].reason,`합성 검토 ${drafts-1}`);
          assert.equal(input.data.rejected_draft.claims.find(claim=>claim.id==='relationship_memory.unknowns.0').claim,`합성 미확인 범위 ${drafts-1}`);
          assert.deepEqual(input.data.review.state.audits.map(audit=>audit.id),input.data.rejected_draft.claims.map(claim=>claim.id));
          assert.equal(input.data.review_history,undefined);
        }
      }else if(input.stage.startsWith('safety_review'))payload=review(input.data);
      else{
        assert.ok(input.stage.startsWith('turn_review'));reviews++;payload=review(input.data);
        if(reviews<=2){payload.state.approved=false;payload.state.issues=[{reason:`합성 검토 ${reviews}`,repair:'현재 원문으로 수정해 주세요.'}];}
      }
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]}));
    }});
  const execute=model.operation.bind(model);
  model.operation=(options,generate)=>execute(options,operation=>{recoveryStates.push(operation.recovery);return generate(operation);});
  const output=await model.updateState(ctx);
  assert.equal(output.state_agent.reviewed,true);assert.equal(drafts,3);assert.equal(reviews,3);
  assert.deepEqual(requests.map(input=>input.stage),['turn_draft','turn_review','safety_review','turn_draft_after_review','turn_review_after_review','safety_review_after_review','turn_draft','turn_review','safety_review']);
  assert.equal(signals[0],signals[3]);assert.notEqual(signals[0],signals[6]);
  for(const start of [0,3,6]){
    assert.equal(signals[start+1],signals[start+2]);
    assert.notEqual(signals[start],signals[start+1]);
  }
  assert.notEqual(signals[1],signals[4]);assert.notEqual(signals[4],signals[7]);
  assert.equal(recoveryStates.length,2);assert.equal(recoveryStates[0],recoveryStates[1]);assert.deepEqual(recoveryStates[0],{});
  assert.equal(logs.filter(entry=>entry.event==='model_operation_retry').length,1);
  assert.ok(!JSON.stringify(logs).includes('합성 검토'));assert.ok(!JSON.stringify(logs).includes(ctx.patient.fields.mood.text));
  await model.updateState(ctx);
  assert.equal(requests[9].data.review,undefined);assert.equal(requests[9].data.rejected_draft,undefined);
  assert.notEqual(recoveryStates[1],recoveryStates[2]);assert.deepEqual(recoveryStates[2],{});
});

for(const basis of ['current_physical_danger','negated'])test('a whole retry independently rechecks previously confirmed danger: '+basis,async()=>{
  const ctx=context();ctx.patient.fields.risk=field('risk','지금 위험한 곳에 있다고 말했어요.');
  const source=safetySources(ctx).find(row=>row.question_id==='risk');let drafts=0,reviews=0;
  const model=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',protocol:'relationship_agent',
    agentFormat:'json_object',retryFailures:true,retryDelayMs:1,timeoutMs:0,diagnosticLogger:null,fetchImpl:async(_url,options)=>{
      const input=JSON.parse(JSON.parse(options.body).messages.at(-1).content);let payload;
      if(input.stage.startsWith('turn_draft')){
        drafts++;payload=draft(ctx);
        if(drafts===1)payload.questions.safety={urgent:true,evidence_ids:[source.id]};
      }else if(input.stage.startsWith('safety_review')){
        assert.ok(input.data.proposed_safety.evidence.some(ref=>ref.question_id==='risk'));
        payload=safetyReviewFixture(input.data,reviews<=2?'current_physical_danger':basis);
      }else{
        reviews++;payload=review(input.data);
        assert.equal(input.data.safety,null);
        if(reviews<=2){payload.state.approved=false;payload.state.issues=[{reason:'합성 상태 수정',repair:'상태를 다시 살펴보세요.'}];}
      }
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]}));
    }});
  const output=await model.updateState(ctx);
  assert.equal(drafts,3);assert.equal(reviews,3);assert.equal(output.state_agent.reviewed,true);
  assert.equal(output.finish_early,basis==='current_physical_danger');
  assert.equal(output.safety_signal.review.basis,basis);
  assert.equal(output.safety_signal.urgent,output.finish_early);
});

test('changed source context discards an earlier operation recovery pair before creating a new draft',async()=>{
  const operation={recovery:{}},ctx=context();
  ctx.patient.fields.risk=field('risk','지금 위험한 곳에 있다고 말했어요.');
  const initial=draft(ctx);initial.questions.safety={urgent:true,evidence_ids:[safetySources(ctx).find(row=>row.question_id==='risk').id]};
  const rejected=fixtureGateway(initial,result=>{result.state.approved=false;result.state.issues=[{reason:'합성 거절',repair:'원문 확인'}];return result;});
  await assert.rejects(runCombinedRelationshipState(rejected,ctx,null,operation),{modelReason:'state_review_rejected'});
  assert.equal(operation.recovery.combinedTurn.danger.urgent,true);
  const changed=context();changed.patient.fields.mood=field('mood','이전 보고를 정정한 새로운 합성 답변입니다.');
  const next=fixtureGateway(draft(changed));
  const output=await runCombinedRelationshipState(next,changed,null,operation);
  assert.equal(next.calls[0].data.review,undefined);assert.equal(next.calls[0].data.rejected_draft,undefined);
  assert.equal(next.calls[1].data.safety,null);assert.equal(output.finish_early,false);
  assert.equal(output.state_agent.reviewed,true);assert.deepEqual(operation.recovery,{});
});

test('a malformed review never enters retry recovery as a validated rejection pair',async()=>{
  const operation={recovery:{}},model=fixtureGateway(draft(),value=>{delete value.state.audits;return value;});
  await assert.rejects(runCombinedRelationshipState(model,context(),null,operation),{modelReason:'agent_schema'});
  assert.deepEqual(operation.recovery,{});
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review','safety_review']);
});

test('disabled whole-operation retries still reject after two reviews and release the request recovery pair',async()=>{
  const ctx=context();let calls=0,recovery;
  const model=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',protocol:'relationship_agent',
    agentFormat:'json_object',retryFailures:false,diagnosticLogger:null,fetchImpl:async(_url,options)=>{
      calls++;const input=JSON.parse(JSON.parse(options.body).messages.at(-1).content);
      const payload=input.stage.startsWith('turn_draft')?draft(ctx):review(input.data);
      if(input.stage.startsWith('turn_review')){payload.state.approved=false;payload.state.issues=[{reason:'합성 거절',repair:'원문 확인'}];}
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]}));
    }});
  const execute=model.operation.bind(model);
  model.operation=(options,generate)=>execute(options,operation=>{recovery=operation.recovery;return generate(operation);});
  await assert.rejects(model.updateState(ctx),{modelReason:'state_review_rejected'});
  assert.equal(calls,6);assert.deepEqual(recovery,{});
});

test('cancelling after repeated review rejection releases retained source data without another draft',async()=>{
  const ctx=context(),controller=new AbortController();let calls=0,recovery;
  const model=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',protocol:'relationship_agent',
    agentFormat:'json_object',retryFailures:true,retryDelayMs:1000,timeoutMs:0,diagnosticLogger:entry=>{
      if(entry.event==='model_operation_retry')controller.abort();
    },fetchImpl:async(_url,options)=>{
      calls++;const input=JSON.parse(JSON.parse(options.body).messages.at(-1).content);
      const payload=input.stage.startsWith('turn_draft')?draft(ctx):review(input.data);
      if(input.stage.startsWith('turn_review')){payload.state.approved=false;payload.state.issues=[{reason:'합성 거절',repair:'원문 확인'}];}
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(payload)}}]}));
    }});
  const execute=model.operation.bind(model);
  model.operation=(options,generate)=>execute(options,operation=>{recovery=operation.recovery;return generate(operation);});
  await assert.rejects(model.updateState(ctx,null,{signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.equal(calls,6);assert.deepEqual(recovery,{});
});

test('a second rejected state fails closed',async()=>{
  const model=fixtureGateway(draft(),value=>({...value,state:{...value.state,approved:false,issues:[{reason:'정정 누락',repair:'정정 반영'}]}}));
  await assert.rejects(runCombinedRelationshipState(model,context(),null,{}),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
  assert.equal(model.calls.length,6);
});

test('identical cross-array unknowns share a model audit and retain distinct complete validated audits',async()=>{
  const ctx=context(),value=draft(ctx);
  value.state.patient_state.unknowns=['내일 대화가 가능한 시간','현재 받고 있는 지원'];
  value.state.relationship_memory.unknowns=['내일 대화가 가능한 시간'];
  const model=fixtureGateway(value),output=await runCombinedRelationshipState(model,ctx,null,{});
  const claims=model.calls[1].data.review_target.claims.filter(claim=>claim.kind==='unresolved_information');
  assert.deepEqual(claims.map(claim=>claim.id),['patient_state.unknowns.0','patient_state.unknowns.1']);
  assert.deepEqual(claims.map(claim=>claim.claim),value.state.patient_state.unknowns);
  assert.ok(claims.every(claim=>claim.certainty==='unknown'&&claim.evidence.length===0));
  const expanded=model.calls[1].validated.state.audits;
  assert.deepEqual(expanded.map(audit=>audit.id),['patient.0','patient_state.unknowns.0','patient_state.unknowns.1','relationship_memory.unknowns.0']);
  assert.deepEqual(expanded.at(-1),{...expanded[1],id:'relationship_memory.unknowns.0'});
  const prompt=model.calls[1].prompt;
  assert.match(prompt,/unknowns의 명사구는 해당 범위가 미확인이라는 뜻이며 그 내용을 사실로 주장하는 문장이 아닙니다/u);
  assert.match(prompt,/원문에 해당 내용이 언급되지 않았다는 사실 자체를 근거 부족이나 거절의 이유로 삼지 마세요/u);
  assert.match(prompt,/이미 알려진 이름·호칭을 주어로 사용한 것과 그 이름·관계 자체를 미확인이라고 주장한 것을 구분하세요/u);
  assert.match(prompt,/실제로 미확인인지와 현재 해석·도움 판단에 필요한 한계인지는 구분해서 검토하세요/u);
  assert.match(prompt,/현재 판단과 관계없는 일반적인 미응답 목록이면 그 불필요성이나 필요한 범위를 reason\/repair에 구체적으로 적으세요/u);
  assert.match(prompt,/이미 답한 정보와 섞였다는 거절에는 실제로 확인된 범위를/u);
  assert.match(prompt,/두 배열 사이에 같은 미확인 범위나 문구가 있다는 사실 자체는 근거 오류나 거절 또는 state\.approved=false의 사유가 아닙니다/u);
  assert.match(prompt,/동일 문구도 각 id의 실제 미확인 여부·현재 판단에 필요한 한계를 각각 독립적으로 검토/u);
  assert.deepEqual(output.patient_state.unknowns,value.state.patient_state.unknowns);
  assert.deepEqual(output.relationship_memory.unknowns,value.state.relationship_memory.unknowns);
  assert.equal(model.calls.length,3);
  assert.match(prompt,/review_target\.claims에 나열된 각 id만/u);
  assert.match(prompt,/보이지 않는 다른 배열의 항목·id를 재구성하거나 추가하지 마세요/u);
  assert.match(output.state_agent.prompt_version,/-combined-turn-v56$/);
});

test('rejected review history keeps all original unknown IDs and arrays after shared-audit expansion',async()=>{
  const ctx=context(),value=draft(ctx),operation={recovery:{}};
  value.state.patient_state.unknowns=['현재 원하는 도움의 범위'];value.state.relationship_memory.unknowns=['현재 원하는 도움의 범위'];
  const before=structuredClone(value);
  const model=fixtureGateway(value,output=>{
    output.state.approved=false;output.state.issues=[{reason:'원문에서 이미 확인된 범위를 미확인으로 제안했습니다.',repair:'실제 미확인 범위로 수정하세요.'}];
    output.state.audits.find(audit=>audit.id==='patient_state.unknowns.0').verdict='already_answered';return output;
  });
  await assert.rejects(runCombinedRelationshipState(model,ctx,null,operation),{modelReason:'state_review_rejected'});
  const next=model.calls.find(call=>call.stage==='turn_draft_after_review');
  const expected=['patient.0','patient_state.unknowns.0','relationship_memory.unknowns.0'];
  assert.deepEqual(next.data.rejected_draft.claims.map(claim=>claim.id),expected);
  assert.deepEqual(next.data.review.state.audits.map(audit=>audit.id),expected);
  assert.ok(next.data.review.state.audits.slice(1).every(audit=>audit.verdict==='unsupported'));
  assert.deepEqual(next.data.rejected_draft.state.patient_state.unknowns,value.state.patient_state.unknowns);
  assert.deepEqual(next.data.rejected_draft.state.relationship_memory.unknowns,value.state.relationship_memory.unknowns);
  assert.deepEqual(operation.recovery.combinedTurn.review.state.audits.map(audit=>audit.id),expected);
  assert.deepEqual(value,before);
});

for(const [label,mutate] of [
  ['missing',value=>{value.state.audits.pop();}],
  ['duplicate',value=>{value.state.audits[1]=value.state.audits[0];}],
  ['unknown ID',value=>{value.state.audits.at(-1).id='relationship_memory.unknowns.7';}],
]) test('unknown audit '+label+' cannot pass state approval',async()=>{
  const value=draft();value.state.patient_state.unknowns=['내일 일정'];value.state.relationship_memory.unknowns=['내일 일정'];
  const model=fixtureGateway(value,result=>{mutate(result);return result;});
  await assert.rejects(runCombinedRelationshipState(model,context(),null,{}),{code:'MODEL_INVALID_RESPONSE'});
});

for(const verdict of ['review_uncertain','already_answered','not_needed']) test('a reviewer cannot approve an unknown judged '+verdict,async()=>{
  const value=draft();value.state.patient_state.unknowns=['대화 의향'];value.state.relationship_memory.unknowns=['대화 의향'];
  const model=fixtureGateway(value,result=>{result.state.audits.find(audit=>audit.id==='patient_state.unknowns.0').verdict=verdict;return result;});
  await assert.rejects(runCombinedRelationshipState(model,context(),null,{}),{
    code:'MODEL_INVALID_RESPONSE',modelReason:verdict==='review_uncertain'?'agent_unknown_audit':'agent_claim_audit',
  });
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review','safety_review']);
});

test('a reported request already answers willingness; rejected broad unknowns are repaired while real gaps remain',async()=>{
  const ctx=context();
  ctx.patient.fields.mood=field('mood','민서는 조언은 원하지 않고 오늘은 자기 이야기를 들어 달라고 직접 말했어요.');
  const value=draft(ctx);value.state.patient_state.unknowns=['대화 의향','내일 대화가 가능한 시간'];
  value.state.relationship_memory.unknowns=['대상자가 원하는 도움'];
  const repaired=structuredClone(value);repaired.state.patient_state.unknowns=['내일 대화가 가능한 시간'];repaired.state.relationship_memory.unknowns=[];
  const model=gateway(call=>{
    if(call.stage==='turn_draft')return value;
    if(call.stage==='turn_draft_after_review') {
      assert.equal(call.data.review.state.approved,false);
      assert.equal(call.data.review.state.audits.filter(audit=>audit.verdict==='unsupported').length,2);
      return repaired;
    }
    const result=review(call.data);
    assert.ok(restoredInput(call.data,call.data.review_target.input).patient.find(row=>row.question_id==='mood').answers.some(answer=>answer.text===ctx.patient.fields.mood.rawText));
    if(call.stage==='turn_review') {
      for(const audit of result.state.audits)if(['patient_state.unknowns.0','relationship_memory.unknowns.0'].includes(audit.id)) {
        audit.verdict='already_answered';audit.reason='오늘은 이야기를 들어 달라는 직접 요청이 이미 전해졌습니다.';
      }
      result.state.approved=false;result.state.issues=[{reason:'대화 의향과 원하는 도움을 이미 답했습니다.',repair:'전해진 오늘의 요청을 보존하고 내일 일정의 미확인만 남기세요.'}];
    } else assert.deepEqual(call.data.review_target.claims.filter(claim=>claim.kind==='unresolved_information').map(claim=>claim.claim),['내일 대화가 가능한 시간']);
    return result;
  });
  const output=await runCombinedRelationshipState(model,ctx,null,{});
  assert.deepEqual(output.patient_state.unknowns,['내일 대화가 가능한 시간']);
  assert.deepEqual(output.relationship_memory.unknowns,[]);
  assert.equal(output.patient_state.facts[0].quote,ctx.patient.fields.mood.rawText);
  assert.equal(output.clarification,null);assert.equal(output.state_agent.reviewed,true);
  assert.deepEqual(output.state_agent.stages,['turn_draft','turn_review','safety_review','turn_draft_after_review','turn_review_after_review','safety_review_after_review']);
});

test('a mixed unknown must be rejected and explicitly narrowed in a fresh draft before approval',async()=>{
  const ctx=context();ctx.patient.fields.mood=field('mood','대상자가 오늘 이야기를 나누고 싶다고 직접 말했어요.');
  const value=draft(ctx);value.state.patient_state.unknowns=['오늘 대화 의향 및 대화 가능한 시간'];
  const repaired=structuredClone(value);repaired.state.patient_state.unknowns=['오늘 대화 가능한 시간'];
  const model=gateway(call=>{
    if(call.stage==='turn_draft')return value;
    if(call.stage==='turn_draft_after_review') {
      assert.equal(call.data.review.state.approved,false);
      assert.equal(call.data.review.state.audits.find(audit=>audit.id==='patient_state.unknowns.0').verdict,'unsupported');
      return repaired;
    }
    const result=review(call.data),claim=call.data.review_target.claims.find(claim=>claim.id==='patient_state.unknowns.0');
    const audit=result.state.audits.find(audit=>audit.id===claim.id);
    if(call.stage==='turn_review') {
      assert.equal(claim.claim,'오늘 대화 의향 및 대화 가능한 시간');
      audit.verdict='already_answered';audit.reason='시간은 미확인이지만 대화 의향은 이미 보고되어 전체 문구를 승인할 수 없습니다.';
      result.state.approved=false;result.state.issues=[{reason:'이미 확인한 의향과 아직 모르는 시간을 묶었습니다.',repair:'항목 문구를 오늘 대화 가능한 시간으로 한정하세요.'}];
    } else {
      assert.equal(claim.claim,'오늘 대화 가능한 시간');
      assert.deepEqual(call.data.review_target.claims.filter(claim=>claim.id.startsWith('patient_state.unknowns.')).map(claim=>claim.claim),repaired.state.patient_state.unknowns);
      audit.reason='고친 초안은 아직 보고되지 않은 시간만 미확인으로 남겼습니다.';
    }
    return result;
  });
  const output=await runCombinedRelationshipState(model,ctx,null,{});
  assert.deepEqual(output.patient_state.unknowns,['오늘 대화 가능한 시간']);
  assert.deepEqual(value.state.patient_state.unknowns,['오늘 대화 의향 및 대화 가능한 시간']);
  assert.deepEqual(output.state_agent.stages,['turn_draft','turn_review','safety_review','turn_draft_after_review','turn_review_after_review','safety_review_after_review']);
  assert.equal(output.patient_state.facts[0].quote,ctx.patient.fields.mood.rawText);
});

test('persistent rejection of an already answered unknown fails closed',async()=>{
  const value=draft();value.state.patient_state.unknowns=['대화 의향'];
  const model=fixtureGateway(value,result=>{
    result.state.audits.find(audit=>audit.id==='patient_state.unknowns.0').verdict='already_answered';
    result.state.approved=false;result.state.issues=[{reason:'이미 확인된 범위를 미확인으로 남겼습니다.',repair:'미확인 범위를 정정하세요.'}];
    return result;
  });
  await assert.rejects(runCombinedRelationshipState(model,context(),null,{}),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
  assert.equal(model.calls.length,6);
});

test('explicitly unknown or refused answers can preserve an important gap after review',async()=>{
  for(const status of ['unknown','refused']) {
    const ctx=context();ctx.patient.fields.support=field('support',status==='unknown'?'모르겠어요.':'말하고 싶지 않아요.',status);
    const value=draft(ctx);value.state.patient_state.unknowns=['대상자가 현재 받고 있는 지원'];
    const model=fixtureGateway(value,(result,call)=>{
      assert.equal(restoredInput(call.data,call.data.review_target.input).patient.find(row=>row.question_id==='support').status,status);
      assert.deepEqual(call.data.review_target.claims.filter(claim=>claim.kind==='unresolved_information').map(claim=>claim.claim),value.state.patient_state.unknowns);
      return result;
    });
    const output=await runCombinedRelationshipState(model,ctx,null,{});
    assert.deepEqual(output.patient_state.unknowns,value.state.patient_state.unknowns);assert.equal(model.calls.length,3);
  }
});

test('conflicting reported availability remains a reviewed limitation with both statements intact',async()=>{
  const ctx=context(),conflict='월요일에 만날 수 있다고 말했어요. 같은 날 수요일만 가능하다고도 말했어요.';
  ctx.supporter.fields.availability=field('availability',conflict);
  ctx.latest_answer={subject:'supporter',question_id:'availability'};
  const value=draft(ctx);value.state.relationship_memory.unknowns=['이용자가 실제로 만날 수 있는 요일'];
  const model=fixtureGateway(value,(result,call)=>{
    const input=restoredInput(call.data,call.data.review_target.input);
    assert.ok(input.supporter.find(row=>row.question_id==='availability').answers.some(answer=>answer.text===conflict));
    assert.equal(call.data.review_target.claims.find(claim=>claim.id==='relationship_memory.unknowns.0').claim,value.state.relationship_memory.unknowns[0]);
    return result;
  });
  const output=await runCombinedRelationshipState(model,ctx,null,{});
  assert.deepEqual(output.relationship_memory.unknowns,value.state.relationship_memory.unknowns);
  assert.equal(output.patient_state.facts.find(fact=>fact.question_id==='availability').quote,conflict);
  assert.equal(model.calls.length,3);
});

test('unasked consent, time and burden limitations relevant to current help remain individually reviewed',async()=>{
  const ctx=context();ctx.user_goal.message=field('want','내일 직접 찾아가서 돕고 싶어요.');
  for(const [subject,id] of [['patient','consent'],['supporter','available_time'],['supporter','capacity']])ctx[subject].fields[id]=field(id,'','not_asked');
  const value=draft(ctx);value.state.patient_state.unknowns=['대상자가 내일 방문을 원하는지'];
  value.state.relationship_memory.unknowns=['이용자가 방문에 쓸 수 있는 시간','이용자가 감당할 수 있는 도움의 범위'];
  const model=fixtureGateway(value,(result,call)=>{
    const input=restoredInput(call.data,call.data.review_target.input);
    assert.equal(input.patient.some(row=>row.question_id==='consent'),false);
    assert.ok(input.user_goal.some(row=>row.answers.some(answer=>answer.text===ctx.user_goal.message.text)));
    assert.equal(call.data.review_target.claims.filter(claim=>claim.kind==='unresolved_information').length,3);
    return result;
  });
  const output=await runCombinedRelationshipState(model,ctx,null,{});
  assert.deepEqual(output.patient_state.unknowns,value.state.patient_state.unknowns);
  assert.deepEqual(output.relationship_memory.unknowns,value.state.relationship_memory.unknowns);
  assert.equal(model.calls.length,3);
});

for(const verdict of ['supported','plausible','unsupported']) test('question skip and clarification require supported review: '+verdict,async()=>{
  const ctx=context(),value=draft(ctx);value.questions.skip=[skip(ctx)];value.questions.clarify=['support_requested'];
  const model=fixtureGateway(value,(_result,call)=>({audits:audits(call.data.claims,verdict)}),'questions');
  const output=await runCombinedRelationshipState(model,ctx,null,{});
  assert.equal(output.question_plan.skip.length,verdict==='supported'?1:0);
  assert.equal(output.clarification,verdict==='supported'?'support_requested':null);
  assert.equal(model.calls.length,4);
});

test('a question review must cover each proposed decision exactly once',async()=>{
  const ctx=context(),value=draft(ctx);value.questions.skip=[skip(ctx)];value.questions.clarify=['support_requested'];
  const model=fixtureGateway(value,result=>{result.audits[1]=result.audits[0];return result;},'questions');
  await assert.rejects(runCombinedRelationshipState(model,ctx,null,{}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_claim_audit'});
});

for(const basis of ['current_physical_danger','negated','past_only','distress_without_immediate_danger','unclear']) test('urgent proposal requires independent safety basis: '+basis,async()=>{
  const ctx=context();ctx.patient.fields.risk=field('risk','지금 위험한 곳에서 자신을 해치겠다고 말했어요.');
  ctx.patient.fields.risk.followUp={question:'현재 상황인가요?',answer:field('risk_more','그 말은 과거 이야기였고 지금은 안전하다고 정정했어요.')};
  const value=draft(ctx);value.questions.safety={urgent:true,evidence_ids:[safetySources(ctx).find(row=>row.question_id==='risk').id]};
  const model=fixtureGateway(value,(result,call)=>{
    assert.ok(call.data.proposed_safety.evidence.some(item=>item.quote.includes('정정')));
    return safetyReviewFixture(call.data,basis);
  },'safety');
  const output=await runCombinedRelationshipState(model,ctx,null,{});
  assert.equal(output.finish_early,basis==='current_physical_danger');
  assert.equal(output.safety_signal.urgent,output.finish_early);
  assert.equal(output.safety_signal.review.basis,basis);
  assert.equal(output.safety_signal.evidence.length,2);
  assert.equal(model.calls.length,3);
});

test('urgent proposal cannot also skip or add a question',async()=>{
  const ctx=context(),value=draft(ctx);value.questions.skip=[skip(ctx)];value.questions.safety={urgent:true,evidence_ids:[safetySources(ctx).find(row=>row.question_id==='mood').id]};
  await assert.rejects(runCombinedRelationshipState(fixtureGateway(value),ctx,null,{}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_urgent_questions'});
});

for(const basis of ['current_physical_danger','negated','past_only','unclear']) test('state repair cannot silently withdraw reviewed danger: '+basis,async()=>{
  const ctx=context();ctx.patient.fields.risk=field('risk','지금 자신을 해치겠다고 말하며 위험한 곳에 있어요.');
  const initial=draft(ctx);initial.questions.safety={urgent:true,evidence_ids:[safetySources(ctx).find(row=>row.question_id==='risk').id]};
  const repaired=draft(ctx);repaired.questions.skip=[skip(ctx)];repaired.questions.clarify=['support_requested'];
  const model=gateway(call=>{
    if(call.stage==='turn_draft')return initial;
    if(call.stage==='turn_draft_after_review')return repaired;
    const result=review(call.data);
    if(call.stage==='turn_review') {
      result.state.approved=false;result.state.issues=[{reason:'관계 해석 수정',repair:'현재 근거에 맞추세요.'}];
    } else if(call.stage==='safety_review_after_review') {
      assert.ok(call.data.proposed_safety.evidence.some(item=>item.question_id==='risk'));
      assert.equal(call.data.proposed_safety.urgent,true);
      return safetyReviewFixture(call.data,basis);
    }
    return result;
  });
  const output=await runCombinedRelationshipState(model,ctx,null,{});
  assert.equal(model.calls.length,7);
  assert.equal(output.finish_early,basis==='current_physical_danger');
  assert.equal(output.safety_signal.urgent,output.finish_early);
  assert.equal(output.safety_signal.review.basis,basis);
  assert.deepEqual(output.safety_signal.evidence,model.calls.find(call=>call.stage==='safety_review_after_review').data.proposed_safety.evidence);
  assert.equal(output.question_plan.skip.length,output.finish_early?0:1);
  assert.equal(output.clarification,output.finish_early?null:'support_requested');
});

test('repaired danger proposal includes previous approved and newly selected evidence in one independent safety review',async()=>{
  const ctx=context();ctx.patient.fields.risk=field('risk','지금 위험한 곳에 있다고 말했어요.');
  ctx.supporter.fields.risk=field('risk','저도 현재 폭력 위협을 받으며 다쳤어요.');
  const initial=draft(ctx),repaired=draft(ctx),sources=safetySources(ctx);
  initial.questions.safety={urgent:true,evidence_ids:[sources.find(row=>row.question_id==='risk'&&row.subject==='patient').id]};
  repaired.questions.safety={urgent:true,evidence_ids:[sources.find(row=>row.question_id==='risk'&&row.subject==='supporter').id]};
  const model=gateway(call=>{
    if(call.stage==='turn_draft')return initial;
    if(call.stage==='turn_draft_after_review')return repaired;
    const result=review(call.data);
    if(call.stage==='turn_review') {result.state.approved=false;result.state.issues=[{reason:'관계 해석 수정',repair:'근거 재확인'}];}
    else if(call.stage==='safety_review_after_review')assert.deepEqual(call.data.proposed_safety.evidence.map(item=>item.subject),['patient','supporter']);
    return result;
  });
  const output=await runCombinedRelationshipState(model,ctx,null,{});
  assert.equal(output.finish_early,true);
  assert.deepEqual(output.safety_signal.evidence,model.calls.find(call=>call.stage==='safety_review_after_review').data.proposed_safety.evidence);
});

for(const final of [false,true]) test('state-only request omits question work and still independently reviews: final='+final,async()=>{
  const ctx=context();if(!final)ctx.adaptive_questions=false;
  const value=draft(ctx);value.questions=null;const model=fixtureGateway(value);
  const output=await runCombinedRelationshipState(model,ctx,null,{},final);
  assert.deepEqual(output.question_plan,{skip:[]});assert.equal(Object.hasOwn(output,'finish_early'),false);
  assert.equal(model.calls[0].data.question_input,null);assert.equal(model.calls[0].data.state_input.final,final);
  assert.equal(model.calls[1].data.questions,null);assert.equal(model.calls[1].data.safety,null);
  assert.equal(model.calls.length,2);
});

test('full newest answer, its later denial, and historical raw source remain available without truncation',async()=>{
  const ctx=context(),text='학교에서 있었던 일을 이야기했어요. '.repeat(220)+'하지만 자해 생각은 전혀 없다고 정정했어요.';
  ctx.patient.fields.mood=field('mood',text);
  const value=draft(ctx);value.state.patient_state.facts=[{...ref(ctx,'supporter','feeling'),certainty:'reported'}];value.state.relationship_memory.patient=[];
  const previous={summary:'이전 보고',facts:[{...ref(ctx,'supporter','feeling'),certainty:'reported',interpretation:'기존 보고'}],unknowns:[],user_goal:ctx.user_goal.message.text};
  const model=fixtureGateway(value);const output=await runCombinedRelationshipState(model,ctx,previous,{});
  assert.equal(output.patient_state.facts.filter(item=>item.question_id==='mood').map(item=>item.quote).join(''),text);
  assert.deepEqual(output.relationship_memory.patient,[]);
  assert.ok(restoredInput(model.calls[0].data,model.calls[0].data.state_input).supporter
    .find(item=>item.question_id==='feeling').answers.some(answer=>answer.text===previous.facts[0].quote));
  for(const call of model.calls) {
    const source=call.stage.startsWith('safety_review')?call.data:restoredInput(call.data,call.stage==='turn_draft'?call.data.state_input:call.data.review_target.input);
    assert.ok(source.patient.find(item=>item.question_id==='mood').answers.some(answer=>answer.text===text));
  }
  const data=model.calls[0].data;
  assert.ok(restoredInput(data,data.question_input).patient.find(item=>item.question_id==='mood').answers.some(answer=>answer.text===text));
});

test('question citations cannot borrow the broader state-memory retrieval scope',async()=>{
  const ctx=context();
  for(let index=0;index<18;index++)ctx.patient.fields['z'+index]=field('z'+index,'ΞΩΨΧ'+index);
  const priorRef=ref(ctx,'patient','z17');
  ctx.relationship_state={patient:[{interpretation:'이전 원문 보고',evidence:[priorRef],certainty:'reported'}],supporter:[],relationship:[],unknowns:[]};
  const stateRequest=relationshipStateRequest(ctx,null),questions=relationshipQuestionRequest(ctx);
  assert.ok(stateRequest.retrieval.documents.some(row=>row.question_id==='z17'));
  assert.equal(questions.retrieval.documents.some(row=>row.question_id==='z17'),false);
  const value=draft(ctx);value.questions.skip=[{...skip(ctx),evidence:[priorRef]}];
  await assert.rejects(runCombinedRelationshipState(fixtureGateway(value),ctx,null,{}),{code:'MODEL_INVALID_RESPONSE'});
});

function transportGateway(mode,value,{questionVerdict='supported',safetyBasis='current_physical_danger',rejectState=false,agentFormat='json_schema'}={}) {
  const stages=[],requests=[];
  const stateReview=claims=>({approved:!rejectState,issues:rejectState?[{reason:'근거 없는 해석',repair:'원문만 사용'}]:[],audits:audits(claims)});
  const model=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-same-model',protocol:'relationship_agent',stateMode:mode,agentFormat,
    diagnosticLogger:null,fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body),input=JSON.parse(body.messages[1].content),stage=input.stage,data=input.data;stages.push(stage);requests.push(body);
      assert.equal(body.model,'synthetic-same-model');let output;
      if(agentFormat==='prompt')assert.equal(Object.hasOwn(body,'response_format'),false);
      else assert.equal(body.response_format.type,agentFormat);
      if(stage.startsWith('turn_draft'))output=value;
      else if(stage.startsWith('turn_review'))output={state:stateReview(data.review_target.claims),
        questions:data.questions?{audits:audits(data.questions.claims,questionVerdict)}:null,
        safety:data.safety?{basis:safetyBasis,reason:'동일 원문의 위험 검토'}:null};
      else if(stage.startsWith('state_observations'))output={patient_state:value.state.patient_state,name_index:value.state.name_index};
      else if(stage.startsWith('relationship_memory'))output={relationship_memory:value.state.relationship_memory};
      else if(stage.startsWith('state_review'))output=stateReview(data.claims);
      else if(stage==='question_plan')output=value.questions;
      else if(stage.startsWith('question_review'))output={audits:audits(data.claims,questionVerdict)};
      else if(stage.startsWith('safety_review'))output=safetyReviewFixture(data,data.proposed_safety.urgent?safetyBasis:'unclear');
      else assert.fail('Unexpected stage: '+stage);
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
    }});
  return {model,stages,requests};
}

test('combined transport replaces general missing-information instructions without changing the shared prompt or sibling schema',async()=>{
  const ctx=context(),basePrompt=relationshipStateRequest(ctx,null).prompt;
  const inherited='원문에 없는 정보는 unknowns로 남깁니다.';
  assert.ok(basePrompt.includes(inherited));
  const {model,requests}=transportGateway('combined',draft(ctx),{agentFormat:'prompt'});
  await model.updateState(ctx);
  const prompt=requests[0].messages[0].content,input=JSON.parse(requests[0].messages[1].content);
  assert.equal(prompt.includes(inherited),false);
  assert.ok(prompt.includes('unknowns는 미응답 문항 목록이 아닙니다.'));
  assert.ok(prompt.includes('실제 모름·거절·상충'));
  assert.ok(prompt.includes('동의·시간·부담의 한계는 미질문이어도 보존'));
  assert.ok(prompt.includes('questions는 state 밖의 형제 키'));
  assert.deepEqual(Object.keys(input.output_schema.properties),['state','questions']);
  assert.deepEqual(Object.keys(input.output_schema.properties.state.properties),['patient_state','name_index','relationship_memory']);
  assert.equal(relationshipStateRequest(ctx,null).prompt,basePrompt);
});

test('combined JSON-object transport explains empty clarification candidates without accepting the none placeholder',async()=>{
  const ctx=context();ctx.clarification_candidates=[];
  const value=draft(ctx),{model,requests}=transportGateway('combined',value,{agentFormat:'json_object'});
  const output=await model.updateState(ctx);
  const input=JSON.parse(requests[0].messages[1].content),clarify=input.output_schema.properties.questions.properties.clarify;
  assert.match(requests[0].messages[0].content,/clarification_candidates가 비었으면 반드시 \[\]로 반환하세요/u);
  assert.match(requests[0].messages[0].content,/실제 선택지가 아니므로 \["none"\]을 출력하지 마세요/u);
  assert.deepEqual(clarify,{type:'array',items:{type:'string',enum:['none']},minItems:0,maxItems:0});
  assert.equal(output.clarification,null);assert.equal(output.state_agent.reviewed,true);
  const invalid=structuredClone(value);invalid.questions.clarify=['none'];
  const rejected=fixtureGateway(invalid);
  await assert.rejects(runCombinedRelationshipState(rejected,ctx,null,{}),{code:'MODEL_INVALID_RESPONSE'});
  assert.deepEqual(rejected.calls.map(call=>call.stage),['turn_draft']);
});

test('combined reviewer explicitly receives every required state key and preserves null sibling contracts',async()=>{
  const ctx=context(),{model,requests}=transportGateway('combined',draft(ctx),{agentFormat:'json_object'});
  const output=await model.updateState(ctx),request=requests[1],input=JSON.parse(request.messages[1].content);
  assert.equal(input.data.review_target.claims.length,1);
  assert.match(request.messages[0].content,/approved\(boolean\), issues\(array\), audits\(array\) 세 키를 모두 포함/u);
  assert.match(request.messages[0].content,/claims가 비었을 때만 audits=\[\]/u);
  assert.match(request.messages[0].content,/approved=true여도 audits를 생략하거나 빈 배열로 바꾸지 마세요/u);
  assert.match(request.messages[0].content,/null이며 해당 최상위 키를 생략하지 마세요/u);
  assert.deepEqual(input.output_schema.properties.state.required,['audits','issues','approved']);
  assert.deepEqual(input.output_schema.properties.questions,{type:'null'});
  assert.deepEqual(input.output_schema.properties.safety,{type:'null'});
  assert.equal(output.state_agent.reviewed,true);
});

for(const key of ['approved','issues','audits'])test('combined state review still rejects a missing '+key+' key',async()=>{
  const model=fixtureGateway(draft(),value=>{delete value.state[key];return value;});
  await assert.rejects(runCombinedRelationshipState(model,context(),null,{}),error=>{
    assert.equal(error.modelReason,'agent_schema');
    const feedback=JSON.parse(error.modelFeedback);
    assert.equal(feedback.path,'output.state');assert.equal(feedback.keyword,'objectKeys');
    assert.equal(feedback.expected.key_count,3);assert.equal(feedback.actual.missing_key_count,1);
    return true;
  });
  assert.deepEqual(model.calls.map(call=>call.stage),['turn_draft','turn_review','safety_review']);
});

for(const scenario of ['ordinary','skip-supported','skip-rejected','clarification-rejected','urgent-accepted','urgent-rejected','state-only']) {
  test('real gateway contracts match staged baseline with identical fixture outputs: '+scenario,async()=>{
    const ctx=context(),value=draft(ctx),options={};
    if(scenario.startsWith('skip'))value.questions.skip=[skip(ctx)];
    if(scenario==='skip-rejected')options.questionVerdict='unsupported';
    if(scenario==='clarification-rejected') {value.questions.clarify=['support_requested'];options.questionVerdict='plausible';}
    if(scenario.startsWith('urgent')) {
      ctx.patient.fields.risk=field('risk','지금 자신을 해치겠다고 말하며 위험한 곳에 있어요.');
      value.questions.safety={urgent:true,evidence_ids:[safetySources(ctx).find(row=>row.question_id==='risk').id]};
      if(scenario==='urgent-rejected')options.safetyBasis='negated';
    }
    if(scenario==='state-only'){ctx.adaptive_questions=false;value.questions=null;}
    const combined=transportGateway('combined',value,options),staged=transportGateway('staged',value,options);
    const {state_agent:combinedAgent,...combinedOutput}=await combined.model.updateState(ctx);
    const {state_agent:stagedAgent,...stagedOutput}=await staged.model.updateState(ctx);
    assert.deepEqual(combinedOutput,stagedOutput);
    assert.equal(combinedAgent.reviewed,true);assert.equal(stagedAgent.reviewed,true);
    assert.deepEqual(combined.stages,['turn_draft','turn_review',...(['ordinary','state-only'].includes(scenario)||scenario.startsWith('urgent')?[]:['question_review']),...(scenario==='state-only'?[]:['safety_review'])]);
    assert.equal(staged.stages.length,scenario==='state-only'?3:scenario.startsWith('skip')||scenario==='clarification-rejected'?6:5);
  });
}

test('combined and staged gateways both fail closed after persistent state review rejection',async()=>{
  for(const mode of ['combined','staged']) {
    const {model}=transportGateway(mode,draft(),{rejectState:true});
    await assert.rejects(model.updateState(context()),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
  }
});

test('relationship state mode defaults to combined and rejects unknown modes before transport',async()=>{
  const {model,stages}=transportGateway(undefined,draft());
  assert.equal(model.stateMode,'combined');await model.updateState(context());
  assert.deepEqual(stages,['turn_draft','turn_review','safety_review']);
  for(const mode of ['legacy','two',null,'']) {
    const fixture=transportGateway(mode,draft());
    assert.equal(fixture.model.configured,false);
    await assert.rejects(fixture.model.updateState(context()),{code:'MODEL_NOT_CONFIGURED'});
    assert.deepEqual(fixture.stages,[]);
  }
});

for(const agentFormat of ['json_schema','json_object','prompt']) test('combined transport preserves staged results in wire format '+agentFormat,async()=>{
  const ctx=context(),value=draft(ctx),combined=transportGateway('combined',value,{agentFormat}),staged=transportGateway('staged',value,{agentFormat});
  const {state_agent:combinedAgent,...combinedOutput}=await combined.model.updateState(ctx);
  const {state_agent:stagedAgent,...stagedOutput}=await staged.model.updateState(ctx);
  assert.deepEqual(combinedOutput,stagedOutput);assert.equal(combinedAgent.reviewed,stagedAgent.reviewed);
  assert.equal(combined.stages.length,3);assert.equal(staged.stages.length,5);
});
