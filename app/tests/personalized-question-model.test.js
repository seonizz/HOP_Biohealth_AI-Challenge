import test from 'node:test';
import assert from 'node:assert/strict';
import {activeQuestionSet} from '../src/question-bank.js';
import {createIntake,currentView,prepareModelAnswer,buildContext} from '../src/intake.js';
import {personalizationSchema,personalizationSources,validatePersonalization} from '../src/personalized-questions.js';
import {relationshipQuestionRequest,validateRelationshipQuestions,validateSchema,questionReviewRequest,applyQuestionReview} from '../src/relationship-agent.js';
import {questionTurnEvidenceTransport} from '../src/combined-turn-evidence-transport.js';
import {ModelGateway} from '../src/model.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';

function context() {
  const state=createIntake(activeQuestionSet),q=currentView(state).question;
  const ctx=buildContext(prepareModelAnswer(state,{question_id:q.id,custom:'🙂 친구가 발표 준비가 부담된다고 말했어요. 부담을 주지 않고 도울 말을 정리하고 싶어요.'},0));
  ctx.personalization ||= {version:1,available:true,remaining_follow_ups:2,history:[]};
  ctx.personalization_candidates ||= structuredClone(ctx.question_candidates);
  return ctx;
}
function decision(ctx,kind='follow_up') {
  const source=personalizationSources(ctx)[0],candidate=ctx.personalization_candidates.find(row=>row.id==='q3_08');
  const quote='친구가 발표 준비가 부담된다고 말했어요.';
  return {kind,question_id:kind==='next'?candidate.id:null,subject:kind==='next'?candidate.subject:'patient',
    source_question_id:source.source_question_id,source_revision:source.source_revision,component:source.component,
    quote,quote_start:2,quote_end:2+Array.from(quote).length,
    question:kind==='next'?null:'발표 준비 중 어떤 부분이 부담된다고 말했나요?',focus:kind==='next'?null:'situation',
    reason:'부담이 되는 구체적인 준비 범위에 맞춰 도움을 제안하려고 해요.'};
}
const output=personalization=>({skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]},personalization});

for(const kind of ['next','follow_up'])test(`personalized ${kind} preserves source binding through fixed-slot codec and validator`,()=>{
  const ctx=context(),value=decision(ctx,kind),request=relationshipQuestionRequest(ctx);
  validateSchema(value,personalizationSchema(ctx));
  const logical=output(value),transport=questionTurnEvidenceTransport('question_plan',request.schema);
  assert.ok(transport);const decoded=transport.decode(transport.encode(logical));
  assert.deepEqual(decoded,logical);
  assert.deepEqual(validateRelationshipQuestions(decoded,ctx,request).personalization,value);
  assert.deepEqual(request.data.personalization_candidates,ctx.personalization_candidates);
  assert.match(request.prompt,/같은 이번 호출/);
  assert.match(request.prompt,/모델의 question|질문 문장/);
});

for(const [label,mutate] of [
  ['stale revision',v=>v.source_revision++],['UTF-16 offset',v=>v.quote_start++],
  ['fabricated quote',v=>v.quote='보고하지 않은 사실'],['wrong component',v=>v.component='selection'],
  ['outside range',v=>v.quote_end+=1000],['empty reason',v=>v.reason=' '],
  ['multiple-line question',v=>v.question+='\n또 하나 알려 주세요.'],['unknown focus',v=>v.focus='diagnosis'],
  ['invented identity',v=>v.question_id='q3_fake'],['extra fact field',v=>v.fact='추정한 사실'],
])test(`personalization refuses ${label} without changing context`,()=>{
  const ctx=context(),before=structuredClone(ctx),value=decision(ctx);mutate(value);
  assert.throws(()=>validatePersonalization(value,ctx),{code:'MODEL_INVALID_RESPONSE'});
  assert.deepEqual(ctx,before);
});

test('next choice cannot be skipped, already issued, answered, or assigned to another subject',()=>{
  const ctx=context(),value=decision(ctx,'next');
  assert.throws(()=>validatePersonalization(value,ctx,{skip:[{question_id:value.question_id}]}),{modelReason:'agent_personalization_candidate'});
  const shown=structuredClone(ctx);shown.issued_question_ids.push(value.question_id);
  assert.throws(()=>validatePersonalization(value,shown),{modelReason:'agent_personalization_candidate'});
  const answered=structuredClone(ctx);answered.personalization_candidates=answered.personalization_candidates.filter(q=>q.id!==value.question_id);
  assert.throws(()=>validatePersonalization(value,answered),{modelReason:'agent_personalization_candidate'});
  assert.throws(()=>validatePersonalization({...value,subject:value.subject==='patient'?'supporter':'patient'},ctx),{modelReason:'agent_personalization_candidate'});
});

test('unknown/refused/stopped sources never ground personalized prompts',()=>{
  for(const state of ['unknown','refused','stopped','skipped','not_asked']) {
    const ctx=context(),value=decision(ctx);ctx.supporter.fields.q3_01.status=state;
    assert.throws(()=>validatePersonalization(value,ctx),{modelReason:'agent_personalization_source'});
  }
  const ctx=context(),value=decision(ctx);ctx.supporter.fields.q3_01.response_event='unknown';
  assert.throws(()=>validatePersonalization(value,ctx),{modelReason:'agent_personalization_source'});
});

test('urgent/stop/help/repeated questions and exhausted budget cannot extend the interview',()=>{
  for(const change of [ctx=>ctx.user_stopped=true,ctx=>ctx.personalization.available=false,ctx=>ctx.safety_review_pending=true]) {
    const ctx=context(),value=decision(ctx);change(ctx);
    assert.throws(()=>validatePersonalization(value,ctx),{modelReason:'agent_personalization_unavailable'});
  }
  const ctx=context(),value=decision(ctx);
  for(const options of [{urgent:true},{clarification:{axis:'time'}}])assert.throws(()=>validatePersonalization(value,ctx,options),{modelReason:'agent_personalization_unavailable'});
  ctx.personalization.remaining_follow_ups=0;
  assert.throws(()=>validatePersonalization(value,ctx),{modelReason:'agent_personalization_question'});
  ctx.personalization.remaining_follow_ups=1;
  for(const status of ['answered','refused','unknown','skipped','obsolete']) {
    ctx.personalization.history=[{...value,status}];
    assert.throws(()=>validatePersonalization({...value,question:'그 발표 준비의 부담을 더 말해 주실 수 있나요?'},ctx),{modelReason:'agent_personalization_duplicate'});
  }
});

test('independent question reviewer can reject a personalized prompt even with an exact source',()=>{
  const ctx=context(),value=decision(ctx),request=relationshipQuestionRequest(ctx);
  const parsed=validateRelationshipQuestions(output(value),ctx,request),review=questionReviewRequest(parsed,request);
  assert.deepEqual(review.claims.map(row=>row.id),['personalization']);
  assert.equal(review.claims[0].evidence[0].question_id,value.source_question_id);
  assert.match(review.prompt,/원문 밖 사건/);
  for(const verdict of ['supported','unsupported','plausible']) {
    const result=applyQuestionReview({audits:[{id:'personalization',verdict,reason:'추가 질문의 필요성과 중립성을 대조했습니다.'}]},parsed,review);
    assert.deepEqual(result.personalization,verdict==='supported'?value:null);
  }
});

test('answered, refused, unknown and skipped canonical questions cannot reappear with a new follow-up ID',()=>{
  for(const status of ['answered','refused','unknown','skipped','not_asked']) {
    for(const property of ['question','canonical_question','asked_question']) {
      const ctx=context(),value=decision(ctx);
      ctx.patient.fields.q3_02={id:'q3_02',status,[property]:'이야기하시는 분과는 어떤 관계인가요?'};
      ctx.personalization_candidates=ctx.personalization_candidates.filter(row=>row.id!=='q3_02');
      value.question='이야기하시는 분과는 어떤 관계인가요 ?';value.focus='relationship';
      assert.throws(()=>validatePersonalization(value,ctx),{modelReason:'agent_personalization_duplicate'});
    }
  }
});

for(const kind of ['next','follow_up'])test(`31B routing creates ${kind} in exactly one provider call`,async()=>{
  const ctx=context(),value=decision(ctx,kind),calls=[];
  const gateway=new ModelGateway({baseUrl:'http://127.0.0.1:11434/v1',apiKey:'synthetic-only',model:'test-31b',protocol:'relationship_agent',stateMode:'combined',
    agentFormat:'json_object',singleCallTurns:true,singleCallQuestionOnly:true,combinedTurnEvidenceIds:true,
    retryFailures:true,timeoutMs:0,diagnosticLogger:null,fetchImpl:async(_url,init)=>{
      const body=JSON.parse(init.body),input=JSON.parse(body.messages.at(-1).content);calls.push(input);
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(evidenceWireFixture(input,output(value)))}}]}));
    }});
  const result=await gateway.updateState(ctx,null);
  assert.equal(calls.length,1);assert.equal(calls[0].stage,'question_plan');
  assert.deepEqual(result.personalization,value);assert.equal(result.patient_state,null);
  assert.equal(result.state_agent.reviewed,false);assert.match(result.state_agent.prompt_version,/personalized-v1$/);
});

test('new planner requires explicit nullable personalization; historical snapshots retain legacy contract',()=>{
  const ctx=context(),request=relationshipQuestionRequest(ctx),missing=output(null);delete missing.personalization;
  assert.throws(()=>validateRelationshipQuestions(missing,ctx,request),{code:'MODEL_INVALID_RESPONSE'});
  delete ctx.personalization;delete ctx.personalization_candidates;
  const old=relationshipQuestionRequest(ctx);assert.equal(old.schema.properties.personalization,undefined);
  assert.equal(validateRelationshipQuestions(missing,ctx,old).personalization,undefined);
});
