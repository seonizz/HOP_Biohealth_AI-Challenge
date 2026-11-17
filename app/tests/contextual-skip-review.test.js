import test from 'node:test';
import assert from 'node:assert/strict';
import {activeQuestionSet} from '../src/question-bank.js';
import {createIntake,currentView,prepareModelAnswer,completeModelAnswer,buildContext} from '../src/intake.js';
import {relationshipQuestionRequest,questionReviewRequest,applyQuestionReview} from '../src/relationship-agent.js';
import {syntheticAnswer} from '../scripts/verify-questionnaire-v3-live.mjs';

const fixture=()=>{
 let state=createIntake(activeQuestionSet);
 for(let revision=0;revision<2;revision++){
  state=prepareModelAnswer(state,syntheticAnswer(currentView(state).question),revision);
  state=completeModelAnswer(state,{name_index:null,patient_state:{facts:[],unknowns:[]},question_plan:{skip:[]}});
 }
 const context=buildContext(state),request=relationshipQuestionRequest(context);
 const source=request.retrieval.documents.find(doc=>doc.question_id==='q3_02');
 const decision={question_plan:{skip:[{question_id:'q3_03',reason:'not_needed',explanation:'가상 인물이므로 상황 질문을 할 필요가 없습니다.',
  evidence:[{subject:source.subject,question_id:source.question_id,quote:source.text}]}]},clarification:null};
 return {state,context,request,decision};
};
test('fictional-only explanations are presented to the independent reviewer and a rejection preserves unanswered state',()=>{
 const {context,request,decision}=fixture(),before=structuredClone(context);
 const review=questionReviewRequest(decision,request);
 assert.match(review.prompt,/실제 인물이 아니라는 사실만으로 생략을 정당화한 설명은 unsupported/u);
 assert.equal(review.claims[0].proposal,decision.question_plan.skip[0].explanation);
 assert.ok(review.claims[0].claim.includes(decision.question_plan.skip[0].explanation));
 assert.match(review.claims[0].claim,/결론과 이 설명 둘 모두/u);
 assert.deepEqual(review.claims[0].evidence,decision.question_plan.skip[0].evidence);
 const result=applyQuestionReview({audits:[{id:'skip.q3_03',verdict:'unsupported',reason:'가상이라는 표시만으로는 질문이 필요 없는 맥락을 확인할 수 없습니다.'}]},decision,review);
 assert.deepEqual(result.question_plan.skip,[]);assert.deepEqual(context,before);
 const field=context.patient.fields.q3_03??context.supporter.fields.q3_03;
 assert.equal(field.status,'not_asked');assert.equal(field.rawText,undefined);
});
test('context-based skipping remains allowed for fictional cases without filling in an answer',()=>{
 const {context,request,decision}=fixture(),before=structuredClone(context);
 decision.question_plan.skip[0].explanation='현재 원문에 보고된 도움 목적과 사건 범위에서 이 질문을 더 물을 필요가 없습니다.';
 const review=questionReviewRequest(decision,request);
 const result=applyQuestionReview({audits:[{id:'skip.q3_03',verdict:'supported',reason:'현재 원문과 도움 목적에서 추가로 묻지 않아도 되는 맥락을 확인했습니다.'}]},decision,review);
 assert.deepEqual(result.question_plan.skip,decision.question_plan.skip);assert.deepEqual(context,before);
 assert.equal((context.patient.fields.q3_03??context.supporter.fields.q3_03).status,'not_asked');
});

for(const failure of ['uncited_fact','narrowed_scope'])
test(`review preserves the original ${failure} proposal and isolates rejection from a valid contextual skip`,()=>{
 const {context}=fixture();
 const field=(id,text,status='answered')=>({id,question:id,text,rawText:text,custom:'',status,source_revision:1});
 const goal=field('q3_01','독서 모임 준비에 관한 답장 선택지를 비교하고 싶어요. 어떤 활동을 맡을지는 아직 정하지 않을게요.');
 const report=field('q3_04','동료가 저에게 모임 공지의 장소 표기를 확인해 달라고 직접 부탁했어요.');
 context.patient.fields={q3_03:field('q3_03','','not_asked'),q3_04:report};
 context.supporter.fields={q3_01:goal,q3_08:field('q3_08','','not_asked'),q3_09:field('q3_09','','not_asked')};
 context.user_goal={message:goal,desired_outcomes:context.supporter.fields.q3_09};
 context.question_candidates=[
  {id:'q3_03',subject:'patient',question:'다루려는 상황은 무엇인가요?',required:false,noSkip:false},
  {id:'q3_08',subject:'supporter',question:'맡을 수 있는 활동과 그 활동의 제한 조건은 무엇인가요?',required:false,noSkip:false},
  {id:'q3_09',subject:'supporter',question:'어떤 활동을 맡겠다고 결정했나요?',required:false,noSkip:false},
 ];
 const ref={subject:'supporter',question_id:'q3_01',quote:goal.rawText};
 const invalid=failure==='uncited_fact'
  ?{question_id:'q3_03',reason:'already_covered',explanation:'독서 모임 준비 중 동료가 장소 표기 확인을 직접 부탁한 상황입니다.',evidence:[ref]}
  :{question_id:'q3_08',reason:'not_needed',explanation:'비용이 얼마인지 따로 확인할 필요가 없습니다.',evidence:[ref]};
 const allowed={question_id:'q3_09',reason:'not_needed',
  explanation:'활동을 아직 결정하지 않고 답장 선택지만 비교하겠다는 요청이므로 실행 의향은 미확인으로 두고 조건부 선택지를 제시할 수 있습니다.',evidence:[ref]};
 const decision={question_plan:{skip:[invalid,allowed]},clarification:null},before=structuredClone({context,decision});
 const request=relationshipQuestionRequest(context),review=questionReviewRequest(decision,request);
 assert.match(request.prompt,/후보 질문 전체가 묻는 정보 범위/u);
 assert.match(request.prompt,/그 항목의 evidence에 선택한 인용/u);
 assert.match(request.prompt,/미응답이라는 이유로 모두 질문하지 마세요/u);
 assert.match(review.prompt,/인용 범위 부족을 구분/u);
 assert.match(review.prompt,/일부 하위 항목의 불필요성만 설명/u);
 assert.equal(review.claims[0].proposal,invalid.explanation);
 assert.deepEqual(review.claims[0].evidence,[ref]);
 assert.ok(review.data.patient.find(row=>row.question_id==='q3_04').answers.some(component=>component.text===report.rawText));
 assert.equal(review.claims[0].evidence.some(row=>row.question_id==='q3_04'),false,'available context is not silently substituted into the original evidence');
 const result=applyQuestionReview({audits:[
  {id:'skip.'+invalid.question_id,verdict:'unsupported',reason:failure==='uncited_fact'
   ?'장소 표기 확인 요청은 다른 원문에 있지만 원래 선택한 인용에는 없어 설명의 인용 범위가 부족합니다.'
   :'비용의 불필요성만 설명해 활동과 제한 조건이라는 질문 전체의 불필요성을 설명하지 못했습니다.'},
  {id:'skip.q3_09',verdict:'supported',reason:'활동 결정 없이 선택지 비교만 요청한 범위이므로 미확인 의향을 조건부로 유지할 수 있습니다.'},
 ]},decision,review);
 assert.deepEqual(result.question_plan.skip,[allowed]);
 assert.deepEqual({context,decision},before);
 assert.equal(context.supporter.fields.q3_09.status,'not_asked');
 assert.equal(context.supporter.fields.q3_09.rawText,'');
 assert.equal(context[invalid.question_id==='q3_03'?'patient':'supporter'].fields[invalid.question_id].status,'not_asked');
});
