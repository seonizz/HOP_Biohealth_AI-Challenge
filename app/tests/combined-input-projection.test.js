import {safetyReviewFixture} from './helpers/safety-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runCombinedRelationshipState, TURN_PROMPT_VERSION } from '../src/relationship-turn.js';
import { relationshipStateRequest, relationshipQuestionRequest, canonicalRelationshipMemory } from '../src/relationship-agent.js';

const field=(id,text)=>({id,question:id,status:'answered',text,rawText:text,custom:''});
const ref=(ctx,id,subject='patient')=>({subject,question_id:id,quote:ctx[subject].fields[id].rawText});
function fixture(){
  const ctx={patient:{alias:'지민',fields:{name:field('name','지민'),rel:field('rel','친구'),contact:field('contact','주말에 연락해요.'),
    events:field('events','지난주에 이야기를 나눴어요.'),support:field('support','가족과 연락한다고 했어요.'),
    burden:field('burden','일과 집안일을 병행한다고 했어요.'),extra:field('extra','그 외에는 아직 모르겠어요.'),
    mood:field('mood','이전 말을 정정했어요. '+'현재 이야기를 기록한 합성 문장입니다. '.repeat(100)+'지금 해칠 생각은 없다고 말했어요.')}},
    supporter:{fields:{feeling:field('feeling','저도 제 생활을 챙기며 돕고 싶어요.')}},
    user_goal:{message:field('want','원한다면 이야기를 듣고 싶어요.')},answered_count:10,
    latest_answer:{subject:'patient',question_id:'mood'},adaptive_questions:true,
    question_candidates:[{id:'daily',subject:'patient',question:'생활 변화는 어떤가요?'},{id:'extra',subject:'patient',question:'더 할 이야기가 있나요?'}],
    clarification_candidates:[]};
  ctx.relationship_state={patient:[
    {interpretation:'이전 서버 표현',certainty:'reported',evidence:['rel','contact','events','support','burden','extra'].map(id=>ref(ctx,id))},
    {interpretation:'가능한 해석: 대화할 수 있는 범위를 함께 확인할 수 있어요.',certainty:'tentative',evidence:[ref(ctx,'contact')]},
  ],supporter:[{interpretation:'이전 서버 표현',certainty:'reported',evidence:[ref(ctx,'feeling','supporter')]}],
    relationship:[{interpretation:'가능한 해석: 도움의 시간을 함께 조율할 수 있어요.',certainty:'tentative',evidence:[ref(ctx,'contact'),ref(ctx,'feeling','supporter')]}],
    unknowns:['현재 원하는 대화 방식','이용자가 함께할 수 있는 시간']};
  ctx.relationship_state.patient[0].interpretation='이용자가 대상자에 관해 보고한 답변 원문:\n'+
    ctx.relationship_state.patient[0].evidence.map(source=>'“'+source.quote+'”').join('\n');
  ctx.relationship_state=canonicalRelationshipMemory(ctx.relationship_state,ctx);
  const prior={summary:'서버가 다시 구성할 이전 표현',facts:Object.keys(ctx.patient.fields).map(id=>({...ref(ctx,id),certainty:'reported',interpretation:'이전 서버 표현'})),
    unknowns:['현재 받고 있는 지원의 범위','이용자가 함께할 수 있는 시간'],user_goal:ctx.user_goal.message.rawText};
  return {ctx,prior};
}
const draft=ctx=>({state:{patient_state:{facts:[{...ref(ctx,'mood'),quote:'지금 해칠 생각은 없다고 말했어요.',certainty:'reported'}],unknowns:['현재 원하는 대화 방식']},name_index:null,
  relationship_memory:{patient:[{certainty:'reported',evidence:[{...ref(ctx,'mood'),quote:'지금 해칠 생각은 없다고 말했어요.'}]}],
    supporter:[],relationship:[],unknowns:['이용자가 함께할 수 있는 시간']}},questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}});
const review=(data,reject=false)=>data.safety_sources?safetyReviewFixture(data):({state:{approved:!reject,issues:reject?[{reason:'현재 원문으로 수정이 필요합니다.',repair:'정정과 범위를 다시 검토하세요.'}]:[],
  audits:data.review_target.claims.map(claim=>({id:claim.id,verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문 대조'}))},questions:null,safety:null});
const gateway=handler=>({calls:[],async agentComplete(stage,prompt,data,schema,operation,validate){
  const call={stage,prompt,data,schema,operation};this.calls.push(call);return validate(stage.startsWith('safety_review')?safetyReviewFixture(data):await handler(call));
}});
const restored=(data,input)=>input===null?null:{...data.shared_input,...input};
const withoutPrior=({prior_state,prior_relationship_memory,...input})=>input;

test('combined draft projection preserves all canonical sources while omitting prior model judgments and keeping retrieval untouched',async()=>{
  const {ctx,prior}=fixture(),before=structuredClone({ctx,prior}),stateRequest=relationshipStateRequest(ctx,prior),questions=relationshipQuestionRequest(ctx);
  const canonicalBefore=structuredClone(stateRequest),model=gateway(call=>call.stage.startsWith('turn_draft')?draft(ctx):review(call.data));
  await runCombinedRelationshipState(model,ctx,prior,{});
  const call=model.calls[0],state=restored(call.data,call.data.state_input),question=restored(call.data,call.data.question_input);
  for(const [input,canonical] of [[state,stateRequest.data],[question,questions.data]]){
    assert.equal(Object.hasOwn(input,'prior_state'),false);assert.equal(Object.hasOwn(input,'prior_relationship_memory'),false);
    assert.equal(Object.hasOwn(input,'previous_reviewed_context'),false);
    assert.deepEqual(input,withoutPrior(canonical));
    assert.deepEqual(input.retrieval,canonical.retrieval);
  }
  assert.ok(prior.facts.length>call.schema.properties.state.properties.patient_state.properties.facts.maxItems);
  for(const input of [state,question]) {
    for(const subject of ['patient','supporter'])for(const [id,source] of Object.entries(ctx[subject].fields))
      assert.ok(input[subject].find(row=>row.question_id===id).answers.some(answer=>answer.text===source.rawText));
    assert.ok(input.user_goal.some(row=>row.answers.some(answer=>answer.text===ctx.user_goal.message.rawText)));
    assert.equal(input.patient.find(row=>row.question_id==='mood').answers[0].text,ctx.patient.fields.mood.rawText);
  }
  assert.deepEqual(call.schema.properties.state,stateRequest.schema);assert.deepEqual(call.schema.properties.questions,questions.schema);
  assert.match(call.prompt,/이전 모델의 요약·선택 목록·가설·미확인 문구는 초안의 입력 예시로 제공하지 않습니다/u);
  assert.deepEqual({ctx,prior},before);assert.deepEqual(stateRequest,canonicalBefore);
  const reviewInput=restored(model.calls[1].data,model.calls[1].data.review_target.input);
  assert.deepEqual(reviewInput,withoutPrior(stateRequest.data));assert.equal(reviewInput.previous_reviewed_context,undefined);
});

test('projection does not change the canonical context fingerprint or the latest rejected draft-review pair',async()=>{
  const {ctx,prior}=fixture(),operation={recovery:{}},stateRequest=relationshipStateRequest(ctx,prior),questions=relationshipQuestionRequest(ctx);
  const expectedKey=createHash('sha256').update(JSON.stringify({version:TURN_PROMPT_VERSION,final:false,state:stateRequest,questions})).digest('hex');
  const rejected=gateway(call=>call.stage.startsWith('turn_draft')?draft(ctx):review(call.data,true));
  await assert.rejects(runCombinedRelationshipState(rejected,ctx,prior,operation),{modelReason:'state_review_rejected'});
  assert.equal(operation.recovery.combinedTurn.contextKey,expectedKey);
  const retained=structuredClone(operation.recovery.combinedTurn);
  const next=gateway(call=>{
    if(call.stage.startsWith('turn_draft')){
      assert.deepEqual(call.data.review,retained.review);assert.deepEqual(call.data.rejected_draft,retained.draft);
      assert.ok(Object.hasOwn(call.data.rejected_draft.state.patient_state,'summary'));
      assert.ok(call.data.rejected_draft.state.patient_state.facts.every(fact=>Object.hasOwn(fact,'interpretation')));
      assert.deepEqual(restored(call.data,call.data.state_input),withoutPrior(stateRequest.data));
      assert.deepEqual(restored(call.data,call.data.state_input),restored(rejected.calls[0].data,rejected.calls[0].data.state_input));
      assert.equal(Object.hasOwn(restored(call.data,call.data.state_input),'previous_reviewed_context'),false);
      return draft(ctx);
    }
    return review(call.data);
  });
  const result=await runCombinedRelationshipState(next,ctx,prior,operation);
  assert.equal(result.state_agent.reviewed,true);assert.equal(next.calls.length,3);assert.deepEqual(operation.recovery,{});
});

test('null history and inactive question work remain null without manufacturing missing information',async()=>{
  for(const final of [false,true]){
    const {ctx}=fixture();delete ctx.relationship_state;ctx.adaptive_questions=false;
    const model=gateway(call=>{
      if(call.stage.startsWith('turn_draft')){
        const state=restored(call.data,call.data.state_input);
        assert.equal(Object.hasOwn(state,'previous_reviewed_context'),false);assert.equal(call.data.question_input,null);
        const value=draft(ctx);value.questions=null;return value;
      }
      return review(call.data);
    });
    const result=await runCombinedRelationshipState(model,ctx,null,{},final);
    assert.equal(result.state_agent.reviewed,true);assert.equal(model.calls.length,2);
  }
});

for(const [name,mutate] of [
  ['four generated facts',(value,ctx)=>{value.state.patient_state.facts=['name','rel','contact','mood'].map(id=>({...ref(ctx,id),certainty:'reported'}));}],
  ['missing relationship unknowns',value=>{delete value.state.relationship_memory.unknowns;}],
  ['missing questions',value=>{delete value.questions;}],
  ['history copied into output',value=>{value.state.previous_reviewed_context={};}],
])test('read-only projection cannot repair or approve an invalid generated candidate: '+name,async()=>{
  const {ctx,prior}=fixture(),value=draft(ctx);mutate(value,ctx);const before=structuredClone(value);
  const model=gateway(call=>{assert.ok(call.stage.startsWith('turn_draft'));return value;});
  await assert.rejects(runCombinedRelationshipState(model,ctx,prior,{}),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(model.calls.length,1);assert.deepEqual(value,before);
});
