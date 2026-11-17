import test from 'node:test';
import assert from 'node:assert/strict';
import {activeQuestionSet} from '../src/question-bank.js';
import {createIntake,currentView,prepareModelAnswer,buildContext,completeModelAnswer} from '../src/intake.js';
import {ModelGateway} from '../src/model.js';
import {relationshipQuestionRequest,validateRelationshipQuestions,questionReviewRequest,applyQuestionReview} from '../src/relationship-agent.js';
import {personalizationSources} from '../src/personalized-questions.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';

const quiet={skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]},personalization:null};
function preparedCore(){
 let state=createIntake(activeQuestionSet);
 state=completeModelAnswer(prepareModelAnswer(state,{question_id:'q3_01',custom:'동료의 주말 업무 부탁을 거절할 문장을 쓰고 싶어요.'},0),
  {name_index:null,patient_state:{},question_plan:{skip:[]}});
 assert.equal(currentView(state).question.id,'q3_03');
 return prepareModelAnswer(state,{question_id:'q3_03',text:'동료가 토요일 업무를 대신 부탁했지만 저는 쉬고 싶어서 거절하려고 해요.'},1);
}
function next(ctx){
 const source=personalizationSources(ctx).find(row=>row.source_question_id==='q3_01');
 return {kind:'next',question_id:'q3_08',subject:'supporter',source_question_id:source.source_question_id,
  source_revision:source.source_revision,component:source.component,quote:source.text,quote_start:0,quote_end:Array.from(source.text).length,
  question:null,focus:null,reason:'도울 수 있는 시간을 더 알아보고 싶어요.'};
}

test('compact completion uses one provider call and preserves only the actual two answers',async()=>{
 const prepared=preparedCore(),context=buildContext(prepared),calls=[];
 const gateway=new ModelGateway({baseUrl:'http://127.0.0.1:11434/v1',apiKey:'synthetic-only',model:'test-12b',protocol:'relationship_agent',stateMode:'combined',
  agentFormat:'json_object',singleCallTurns:true,singleCallQuestionOnly:true,combinedTurnEvidenceIds:true,retryFailures:true,timeoutMs:0,diagnosticLogger:null,
  fetchImpl:async(_url,init)=>{
   const body=JSON.parse(init.body),input=JSON.parse(body.messages.at(-1).content);calls.push({body,input});
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(evidenceWireFixture(input,quiet))}}]});
  }});
 const output=await gateway.updateState(context,null),state=completeModelAnswer(prepared,output);
 assert.equal(calls.length,1);assert.equal(calls[0].input.stage,'question_plan');
 assert.equal(calls[0].input.data.question_policy.compact_flow.target_questions,4);
 assert.equal(calls[0].input.data.question_policy.compact_flow.issued_questions,2);
 assert.match(calls[0].body.messages[0].content,/기본 동작은 종료/);
 assert.match(output.state_agent.prompt_version,/-compact-v1/);
 assert.equal(state.status,'ready');assert.equal(currentView(state).question,null);
 assert.deepEqual(Object.keys(state.ans),['q3_01','q3_03']);assert.deepEqual(state.modelSkipped,{});
 assert.equal(output.patient_state,null);assert.equal(output.state_agent.reviewed,false);
});

test('compact reviewer rejects a merely related question and cancellation leaves intake complete',()=>{
 const prepared=preparedCore(),ctx=buildContext(prepared),request=relationshipQuestionRequest(ctx);
 const decision=validateRelationshipQuestions({...quiet,personalization:next(ctx)},ctx,request),review=questionReviewRequest(decision,request);
 assert.match(review.claims[0].claim,/꼭 필요한 기존 문항/);
 assert.match(review.prompt,/단순한 관련성/);
 const reviewed=applyQuestionReview({audits:[{id:'personalization',verdict:'unsupported',reason:'거절 범위와 의사가 이미 있어 가능한 도움 시간을 더 묻지 않아도 요청한 문장을 만들 수 있습니다.'}]},decision,review);
 assert.equal(reviewed.personalization,null);
 const result=completeModelAnswer(prepared,{...reviewed,name_index:null,patient_state:{}});
 assert.equal(result.status,'ready');assert.equal(result.v3.issued.q3_08,undefined);
 assert.equal(result.ans.q3_08,undefined);
});

test('compact policy changes instructions without changing source schemas or historical planner rules',()=>{
 const ctx=buildContext(preparedCore()),old=structuredClone(ctx);delete old.question_policy.compact_flow;
 const current=relationshipQuestionRequest(ctx),historical=relationshipQuestionRequest(old);
 assert.deepEqual(current.schema,historical.schema);
 assert.match(current.prompt,/보통 총 2~4개/);assert.match(current.prompt,/target_questions\(4\)/);
 assert.doesNotMatch(historical.prompt,/짧은 질문 흐름 v1/);
 assert.deepEqual(current.data.personalization_sources,historical.data.personalization_sources);
 assert.deepEqual(current.data.retrieval,historical.data.retrieval);
 assert.deepEqual(validateRelationshipQuestions(quiet,ctx,current).question_plan,{skip:[]});
});
