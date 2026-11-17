import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {COMMON} from '../src/relationship-prompts.js';
import {relationshipQuestionRequest} from '../src/relationship-agent.js';
import {runCombinedRelationshipState} from '../src/relationship-turn.js';
import {scopedBlockPrompt} from '../src/turn-input-scope.js';
import {activeQuestionSet} from '../src/question-bank.js';
import {createIntake,currentView,prepareModelAnswer,completeModelAnswer,buildContext} from '../src/intake.js';
import {syntheticAnswer} from '../scripts/verify-questionnaire-v3-live.mjs';
import {scopeProbe,scopeBlock,scopeReview} from './helpers/turn-input-optimization-fixture.js';

const sourceOnly=({prior_state,prior_relationship_memory,...input})=>input;
const questionCall=call=>call.data.output_block==='questions';
const reviewCall=call=>/^(turn_review|question_review|safety_review)(?:_after_review)?$/u.test(call.stage);
const v3Contexts=()=>{
  let intake=createIntake(activeQuestionSet),count=0;
  const contexts=[];
  while(currentView(intake).question){
    intake=prepareModelAnswer(intake,syntheticAnswer(currentView(intake).question),++count);
    contexts.push(buildContext(intake));
    intake=completeModelAnswer(intake,{name_index:null,patient_state:{},question_plan:{skip:[]}});
  }
  return contexts;
};
const v3Draft=ctx=>{
  const {subject,question_id}=ctx.latest_answer,field=ctx[subject].fields[question_id];
  const evidence={subject,question_id,quote:field.rawText};
  return {state:{patient_state:{facts:[{...evidence,certainty:'reported'}],unknowns:[]},name_index:null,
    relationship_memory:{patient:[],supporter:[],relationship:[],unknowns:[],
      [subject]:[{certainty:'reported',evidence:[evidence]}]}},questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]},personalization:null}};
};
const makeProbe=(ctx,value,enabled,options={})=>scopeProbe(ModelGateway,{ctx,value,enabled,blockScopedInputs:enabled,...options});
const assertQuestionScope=(original,optimized,request)=>{
  assert.equal(optimized.prompt,scopedBlockPrompt('questions',original.prompt));
  assert.deepEqual({...optimized,prompt:original.prompt},original);
  assert.deepEqual(optimized.data,original.data);
  // The wire omits undefined metadata exactly as the original JSON request did.
  assert.deepEqual({...optimized.data.shared_input,...optimized.data.question_input},JSON.parse(JSON.stringify(sourceOnly(request.data))));
  assert.deepEqual(optimized.output_schema,original.output_schema);
  assert.equal(optimized.prompt.split(COMMON).length-1,1);
  assert.ok(optimized.prompt.includes(request.prompt.slice(COMMON.length)));
  assert.match(optimized.prompt,/새로운 사실이나 승인된 답안이 아닙니다/u);
  assert.match(optimized.prompt,/새 독립 질문·안전 검토/u);
  assert.match(optimized.prompt,/JSON 형식이 실패했다는 이유만으로 근거 있는 생략·추가 확인 선택을 빈 배열로 바꾸지 마세요/u);
  assert.doesNotMatch(optimized.prompt,/아래 상태 규칙의 patient_state|최신 reported fact를 선택했다면|이번 STATE 재시도/u);
  assert.ok(optimized.prompt.length<original.prompt.length-6000);
  const suffix='\n질문 생략 최종 제약:';
  assert.ok(original.prompt.includes(suffix));
  assert.equal(optimized.prompt.slice(optimized.prompt.indexOf(suffix)),original.prompt.slice(original.prompt.indexOf(suffix)));
};

test('all nine real v3 question requests preserve every source, candidate, revision and original schema',async()=>{
  const contexts=v3Contexts();assert.equal(contexts.length,9);
  for(const ctx of contexts){
    const before=structuredClone(ctx),value=v3Draft(ctx),request=relationshipQuestionRequest(ctx);
    const original=makeProbe(ctx,value,false),optimized=makeProbe(ctx,value,true);
    assert.deepEqual(await optimized.run(),await original.run());
    assert.deepEqual(ctx,before);
    const old=original.calls.find(questionCall),current=optimized.calls.find(questionCall);
    assertQuestionScope(old,current,request);
    assert.deepEqual(original.calls.filter(reviewCall),optimized.calls.filter(reviewCall));
    assert.equal(current.data.review,undefined);
  }
});

test('v3 rejected draft, independent reviews and bound clarification survive question repair unchanged',async()=>{
  const ctx=v3Contexts()[7],value=v3Draft(ctx),request=relationshipQuestionRequest(ctx);
  const source=request.data.clarification_sources.find(row=>row.source_question_id==='q3_03'&&row.component==='rawText');
  const quote='자료의 도입 부분에 대한 의견을 제게 부탁했어요.';
  const quote_start=Array.from(source.text.slice(0,source.text.indexOf(quote))).length;
  value.questions.clarify=[{source_question_id:source.source_question_id,source_revision:source.source_revision,component:source.component,
    event_id:'synthetic_request_event',quote,quote_start,quote_end:quote_start+Array.from(quote).length,axis:'time',role:null,agreement_item_id:null}];
  const original=makeProbe(ctx,value,false,{rejectOnce:true}),optimized=makeProbe(ctx,value,true,{rejectOnce:true});
  const result=await optimized.run();assert.deepEqual(result,await original.run());
  assert.deepEqual(result.clarification,value.questions.clarify[0]);
  const old=original.calls.filter(questionCall),current=optimized.calls.filter(questionCall);
  assert.equal(current.length,2);
  for(let index=0;index<current.length;index++)assertQuestionScope(old[index],current[index],request);
  assert.equal(current[1].data.review.state.approved,false);
  assert.ok(current[1].data.rejected_draft.claims.length>0);
  assert.deepEqual(current[1].data.review,old[1].data.review);
  assert.deepEqual(current[1].data.rejected_draft,old[1].data.rejected_draft);
  for(const stage of ['turn_review','question_review','safety_review']){
    assert.ok(optimized.calls.some(call=>call.stage===stage));
    assert.ok(optimized.calls.some(call=>call.stage===stage+'_after_review'));
  }
  assert.deepEqual(original.calls.filter(reviewCall),optimized.calls.filter(reviewCall));
});

test('question scoping requires both opt-ins and preserves unsupported envelopes and provider suffixes',async()=>{
  const ctx=v3Contexts()[7],value=v3Draft(ctx),original=makeProbe(ctx,value,false);await original.run();
  const call=original.calls.find(questionCall),prompt=call.prompt;
  const invalid=scopeProbe(ModelGateway,{ctx,value,enabled:false,blockScopedInputs:true});
  await assert.rejects(invalid.run(),{code:'MODEL_NOT_CONFIGURED'});assert.equal(invalid.calls.length,0);
  const unchanged=scopeProbe(ModelGateway,{ctx,value,enabled:true,blockScopedInputs:false});await unchanged.run();
  assert.deepEqual(unchanged.calls.find(questionCall),call);
  const combined=scopeProbe(ModelGateway,{ctx,value,stateMode:'combined',enabled:true,blockScopedInputs:true});await combined.run();
  assert.equal(scopedBlockPrompt('questions',combined.calls[0].prompt),combined.calls[0].prompt);
  for(const changed of [prompt.replace('아래 질문 진행 규칙의','새 질문 규칙의'),
    prompt.replace('들여쓰기·코드블록 없는 한 줄 JSON만 출력하세요. 자유 문구는 짧게,','변경된 출력 지시'),
    prompt+'\n형식을 재작성하더라도 question_input의 각 후보 질문과 원문을 다시 대조하세요.'])
    assert.equal(scopedBlockPrompt('questions',changed),changed);
  const suffix='\n추가 제공자 계약은 그대로 보존합니다.';
  const projected=scopedBlockPrompt('questions',prompt+suffix);
  assert.ok(projected.endsWith(suffix));
  assert.equal(scopedBlockPrompt('questions',projected),projected);
});

test('combined capacity fallback uses the same opted-in block scopes without changing its original draft',async()=>{
  const ctx=v3Contexts()[7],value=v3Draft(ctx);
  const probe=enabled=>makeProbe(ctx,value,enabled,{stateMode:'combined',response:call=>{
    if(call.stage==='turn_draft')return new Response(JSON.stringify({error:{type:'request_error',
      code:'context_length_exceeded',message:'Full prompt exceeds context; no input was truncated'}}),{status:400});
  }});
  const baseline=probe(false),optimized=probe(true);
  assert.deepEqual(await optimized.run(),await baseline.run());
  assert.deepEqual(optimized.calls[0],baseline.calls[0]);
  assertQuestionScope(baseline.calls.find(questionCall),optimized.calls.find(questionCall),relationshipQuestionRequest(ctx));
  const state=optimized.calls.find(call=>call.data.output_block==='patient_state');
  assert.equal(Object.hasOwn(state.data,'question_input'),false);
  assert.deepEqual(optimized.calls.filter(reviewCall),baseline.calls.filter(reviewCall));
});

test('question structural retries preserve the rejected response and exact validation feedback',async()=>{
  const ctx=v3Contexts()[7],value=v3Draft(ctx),request=relationshipQuestionRequest(ctx);
  const probe=enabled=>{
    let attempts=0;
    return makeProbe(ctx,value,enabled,{response:(call,output)=>{
      if(questionCall(call)&&++attempts===1){delete output.safety;return output;}
    }});
  };
  const original=probe(false),optimized=probe(true);
  assert.deepEqual(await optimized.run(),await original.run());
  const old=original.calls.filter(questionCall),current=optimized.calls.filter(questionCall);
  assert.equal(current.length,2);
  for(let index=0;index<current.length;index++)assertQuestionScope(old[index],current[index],request);
  assert.ok(current[1].validation_feedback);
  assert.ok(current[1].rejected_output);
});

test('literal state recovery keeps its state restrictions out of the scoped question prompt',async()=>{
  const ctx=v3Contexts()[7],value=v3Draft(ctx),operation={requestId:'v3-literal-scope',recovery:{},controller:new AbortController()};
  const gateway={stateMode:'combined_blocks',stageScopedQuestionRules:true,blockScopedInputs:true,calls:[],reject:true,
    async agentComplete(stage,prompt,data,schema,active,validate){
      this.calls.push({stage,prompt,data,schema});
      return validate(data.output_block?scopeBlock(value,data.output_block):scopeReview(data,this.reject&&stage.startsWith('turn_review')));
    }};
  await assert.rejects(runCombinedRelationshipState(gateway,ctx,null,operation),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(operation.recovery.combinedTurn.literalState,true);
  gateway.reject=false;gateway.calls=[];
  const result=await runCombinedRelationshipState(gateway,ctx,null,operation);
  assert.equal(result.state_agent.reviewed,true);
  assert.doesNotMatch(gateway.calls.find(questionCall).prompt,/이번 STATE 재시도/u);
  assert.match(gateway.calls.find(call=>call.data.output_block==='relationship_memory').prompt,/이번 STATE 재시도/u);
  assert.equal(gateway.calls.find(questionCall).data.review.state.approved,false);
});
