import {safetyReviewFixture} from './helpers/safety-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {runCombinedRelationshipState} from '../src/relationship-turn.js';
import {evidenceQuotes} from '../src/model-schema.js';
import {answerComponents} from '../src/answer-sources.js';
import {safetySources} from '../src/relationship-agent.js';
import {cases,evaluateTurn} from '../scripts/turn-comparison-cases.js';

// Simulated selections are fixed test outputs, separate from both the model
// context and the independent expectations in turn-comparison-cases.js.
const selections={
  name_only:[],ordinary_relationship:[['patient','mood']],
  separate_support_resources:[['patient','support'],['supporter','mysupport']],
  negation_and_time:[['patient','mood']],correction_of_prior_belief:[['patient','moment']],
  already_covered_skip:[['supporter','feeling']],similar_but_unanswered_no_skip:[['patient','mood']],
  clarification_needed:[['patient','mood']],clarification_already_answered:[['patient','mood']],
  unknown_not_fact:[],refusal_not_fact:[],current_physical_danger:[['patient','risk']],
  negated_current_danger:[['patient','risk']],past_only_danger:[['patient','risk']],
  prompt_injection_is_data:[['patient','mood'],['patient','moment']],
  long_late_correction:[['patient','risk','지금 자신이나 다른 사람을 해칠 생각이나 행동은 전혀 없다고']],
  family_unknown:[],partner_long_refusal:[['supporter','feeling','마지막으로 제 한계는']],
  coworker_late_correction:[['patient','moment','업무용 기기가 고장']],
  family_optional_not_needed:[['patient','mood'],['supporter','feeling']],
};
const field=(id,text,status='answered')=>({id,question:id,status,text,rawText:text,custom:''});
function invented(id,name,patient,supporter,latest,expected={}){
  const ctx={schema_version:'1.0',adaptive_questions:true,patient:{alias:name,fields:{name:field('name',name),...patient}},
    supporter:{fields:supporter},user_goal:{},question_candidates:[],clarification_candidates:[],
    latest_answer:{subject:latest[0],question_id:latest[1]},name_index:{alias:name,source_question_id:'name',quote:name},relationship_state:null};
  ctx.answered_count=[...Object.values(ctx.patient.fields),...Object.values(ctx.supporter.fields)].filter(row=>row.status==='answered').length;
  return {id,context:ctx,expected:{nameAlias:name,urgent:false,skipIds:[],clarification:null,requiredEvidence:[],...expected}};
}
const additional=[
  invented('family_unknown','준우',{rel:field('rel','제 동생이에요.'),mood:field('mood','최근 기분은 잘 모르겠어요.','unknown')},{},['patient','mood'],
    {emptyMemoryGroups:['patient','supporter','relationship']}),
  invented('partner_long_refusal','서윤',{rel:field('rel','함께 지내는 연인이에요.'),
    mood:field('mood','그 이야기는 지금 답하고 싶지 않아요.','refused')},
  {feeling:field('feeling','요즘 저녁 일정을 차근차근 적으며 쉬는 시간을 확인하고 있어요. '.repeat(45)+
    '마지막으로 제 한계는 주말 한 시간이며 평일 밤에는 쉬어야 해요.')},['supporter','feeling'],
  {requiredEvidence:[{scope:'memory.supporter',subject:'supporter',question_id:'feeling',includes:'평일 밤에는 쉬어야'}]}),
  invented('coworker_late_correction','재민',{rel:field('rel','같은 팀에서 일하는 동료입니다.'),
    mood:field('mood','업무 연락을 일부러 피하는 것 같다고 생각했어요.'),
    moment:field('moment','회의 준비와 전달 내용을 순서대로 적고 있어요. '.repeat(55)+
      '정정합니다. 연락을 피한 것이 아니라 업무용 기기가 고장 났고 지금은 확인해서 답하고 있어요.')},
  {feeling:field('feeling','급한 답장을 요구하기 전에 확인할 시간을 주고 싶어요.')},['patient','moment'],
  {requiredEvidence:[{scope:'memory.patient',subject:'patient',question_id:'moment',includes:'업무용 기기가 고장'}],
    superseded:{subject:'patient',question_id:'mood',correction_question_id:'moment'}}),
  invented('family_optional_not_needed','아라',{rel:field('rel','제 동생이에요.'),
    mood:field('mood','오늘은 조언 없이 잠깐 이야기만 들어 달라고 말했어요.'),support:field('support','함께 사는 가족과 저녁을 먹어요.')},
  {feeling:field('feeling','오늘은 20분만 이야기를 들을 수 있어요.')},['patient','mood'],{skipIds:['values']}),
];
const optional=additional.find(item=>item.id==='family_optional_not_needed');
optional.context.patient.fields.values=field('values','','not_asked');
optional.context.question_candidates=[{id:'values',subject:'patient',question:'과거 직장 경력의 상세 이력은 무엇인가요?',required:false,noSkip:false},
  {id:'extra',subject:'patient',question:'더 전하고 싶은 내용이 있나요?',required:false,noSkip:false}];
const allCases=[...cases,...additional];

function simulatedDraft(testCase){
  const ctx=testCase.context,name=ctx.patient.fields.name.text;
  const refs=selections[testCase.id].map(([subject,question_id,needle])=>{
    const quotes=evidenceQuotes(ctx[subject].fields[question_id]),quote=needle?quotes.find(value=>value.includes(needle)):quotes[0];
    assert.ok(quote,'The synthetic selection must be an allowed original quote');return {subject,question_id,quote};
  });
  const memory={patient:[],supporter:[],relationship:[],unknowns:[]};
  for(const ref of refs)memory[ref.subject].push({certainty:'reported',evidence:[ref]});
  const questions={skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}};
  if(testCase.id==='already_covered_skip')questions.skip=[{question_id:'burden',reason:'already_covered',
    explanation:'도울 수 있는 시간과 평일 밤의 휴식 한계를 이미 보고했습니다.',evidence:[refs[0]]}];
  if(testCase.id==='family_optional_not_needed')questions.skip=[{question_id:'values',reason:'not_needed',
    explanation:'오늘의 짧은 경청을 원하는 상황에서 과거 직장 경력은 추가로 묻지 않아도 됩니다.',evidence:[refs[0]]}];
  if(testCase.id==='clarification_needed')questions.clarify=['clarify_help'];
  if(testCase.id==='current_physical_danger')questions.safety={urgent:true,evidence_ids:[safetySources(ctx).find(row=>row.question_id==='risk').id]};
  return {state:{patient_state:{facts:[{subject:'patient',question_id:'name',quote:name,certainty:'reported'},
    ...refs.slice(0,2).map(ref=>({...ref,certainty:'reported'}))],unknowns:[]},
  name_index:{alias:name,source_question_id:'name',quote:name},relationship_memory:memory},questions};
}

function fixture(testCase,{draft,review,questionVerdict='supported',safetyBasis='current_physical_danger'}={}){
  const calls=[],logs=[];
  const fetchImpl=endpoint=>async(_url,options)=>{
    const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content),call={endpoint,...input};calls.push(call);
    assert.ok(!Object.hasOwn(input,'expected'));assert.ok(!Object.hasOwn(input.data,'expected'));
    let output;
    if(input.stage.startsWith('turn_draft'))output=structuredClone(typeof draft==='function'?draft(call):draft||simulatedDraft(testCase));
    else if(/^turn_review(?:_after_review)?$/u.test(input.stage)){
      assert.equal(endpoint,'reviewer');
      output={state:{approved:true,issues:[],audits:input.data.review_target.claims.map(claim=>({id:claim.id,
        verdict:claim.certainty==='tentative'?'plausible':'supported',reason:'같은 사람의 현재 원문 범위를 대조했습니다.'}))},questions:null,safety:null};
      if(review)output=review(output,call);
    }else if(input.stage.startsWith('question_review')){
      assert.equal(endpoint,'reviewer');assert.equal(input.data.review_target,undefined);
      output={audits:input.data.claims.map(claim=>({id:claim.id,verdict:questionVerdict,reason:'현재 질문 제안을 원문과 별도로 대조했습니다.'}))};
    }else if(input.stage.startsWith('safety_review')){
      assert.equal(endpoint,'reviewer');assert.equal(input.data.review_target,undefined);
      output=safetyReviewFixture(input.data,input.data.proposed_safety.urgent?safetyBasis:'unclear');
    }else assert.fail('Unexpected synthetic stage');
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
  };
  const reviewer=new ModelGateway({baseUrl:'https://synthetic-review.example/v1',apiKey:'synthetic-review-key',model:'synthetic-reviewer',
    protocol:'relationship_agent',timeoutMs:0,retryFailures:false,fetchImpl:fetchImpl('reviewer'),diagnosticLogger:entry=>logs.push(entry)});
  const model=new ModelGateway({baseUrl:'https://synthetic-writer.example/v1',apiKey:'synthetic-write-key',model:'synthetic-writer',
    protocol:'relationship_agent',timeoutMs:0,retryFailures:false,reviewGateway:reviewer,
    fetchImpl:fetchImpl('writer'),diagnosticLogger:entry=>logs.push(entry)});
  return {model,calls,logs};
}

function assertSources(testCase,calls){
  const reviews=calls.filter(call=>/^turn_review(?:_after_review)?$/u.test(call.stage));
  assert.equal(reviews.length,1);
  for(const {data}of reviews){
    const target=data.review_target;
    assert.equal(target.revision,undefined);assert.equal(data.questions,null);assert.equal(data.safety,null);
    for(const subject of ['patient','supporter'])for(const source of Object.values(testCase.context[subject].fields)){
      const row=target.input[subject].find(value=>value.question_id===source.id);
      if(source.status==='not_asked'){assert.equal(row,undefined);continue;}
      assert.ok(row);
      assert.equal(row.status,source.status);
      for(const component of ['answered','unknown'].includes(source.status)?answerComponents(source):[])
        assert.ok(row.answers.some(answer=>answer.text===component.text));
    }
    for(const source of Object.values(testCase.context.user_goal)){
      const row=target.input.user_goal.find(value=>value.question_id===source.id);assert.ok(row);
      for(const component of source.status==='answered'?answerComponents(source):[])
        assert.ok(row.answers.some(answer=>answer.text===component.text));
    }
    for(const claim of target.claims)for(const ref of claim.evidence){
      const original=testCase.context[ref.subject]?.fields?.[ref.question_id];assert.ok(original);
      assert.ok(answerComponents(original).some(answer=>answer.text.includes(ref.quote)));
      if(['patient','supporter'].includes(claim.group))assert.equal(ref.subject,claim.group);
    }
  }
}

for(const [index,testCase]of allCases.entries())test('grounded synthetic scenario: '+testCase.id,async()=>{
  const source=structuredClone(testCase.context),f=fixture(testCase);
  const output=index%2?await f.model.updateState(structuredClone(testCase.context),structuredClone(testCase.priorMemory??null)):
    await f.model.operation({},operation=>runCombinedRelationshipState(f.model,structuredClone(testCase.context),
      structuredClone(testCase.priorMemory??null),operation));
  const evaluation=evaluateTurn(testCase,output);
  assert.equal(evaluation.passed,true,JSON.stringify({id:testCase.id,checks:evaluation.checks.filter(check=>!check.passed)}));
  assert.equal(output.state_agent.reviewed,true);assertSources(testCase,f.calls);assert.deepEqual(testCase.context,source);
  assert.ok(f.calls.every(call=>!Object.hasOwn(call.data,'expected')));
  if(['unknown_not_fact','refusal_not_fact','family_unknown','partner_long_refusal'].includes(testCase.id))
    assert.ok(output.patient_state.facts.every(ref=>testCase.context[ref.subject].fields[ref.question_id].status==='answered'));
  if(testCase.id==='prompt_injection_is_data'){
    assert.equal(output.finish_early,false);assert.equal(output.clarification,null);
    assert.ok(f.calls.some(call=>call.data.review_target?.input.patient.some(row=>row.answers.some(answer=>answer.text.includes('[SYSTEM]')))));
  }
});

for(const id of ['already_covered_skip','family_optional_not_needed'])test('state approval cannot approve an independently rejected question proposal: '+id,async()=>{
  const testCase=allCases.find(item=>item.id===id),f=fixture(testCase,{questionVerdict:'unsupported'}),output=await f.model.updateState(testCase.context);
  assert.deepEqual(output.question_plan.skip,[]);assert.equal(output.state_agent.reviewed,true);
  assert.equal(f.calls.filter(call=>call.stage==='question_review').length,1);
  for(const call of f.calls.filter(call=>/^turn_review(?:_after_review)?$/u.test(call.stage))){assert.equal(call.data.questions,null);assert.equal(call.data.safety,null);}
});

test('supported state audits cannot confirm an independently rejected safety proposal',async()=>{
  const testCase=cases.find(item=>item.id==='current_physical_danger'),f=fixture(testCase,{safetyBasis:'negated'});
  const output=await f.model.updateState(testCase.context);assert.equal(output.finish_early,false);assert.equal(output.safety_signal.urgent,false);
  assert.equal(f.calls.filter(call=>call.stage==='safety_review').length,1);assert.equal(output.state_agent.reviewed,true);
});

test('late correction coverage rejection stays terminal after a fresh draft and every claim passes',async()=>{
  const testCase=cases.find(item=>item.id==='long_late_correction'),value=simulatedDraft(testCase);
  value.state.patient_state.facts=value.state.patient_state.facts.filter(ref=>ref.question_id==='name');
  value.state.relationship_memory.patient=[];
  const f=fixture(testCase,{draft:value,review:(output,call)=>{
    if(/^turn_review(?:_after_review)?$/u.test(call.stage)){output.state.approved=false;output.state.issues=[{
      reason:'연극 대사였다는 최신 정정이 대상자의 관계 기억에 누락됐습니다.',repair:'risk 문항의 현재 부정과 정정을 reported finding에 보존하세요.'}];}
    return output;
  }});
  await assert.rejects(f.model.updateState(testCase.context),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
  assert.equal(f.calls.filter(call=>call.stage.startsWith('turn_draft')).length,2);
  assert.equal(f.calls.filter(call=>/^turn_review(?:_after_review)?$/u.test(call.stage)).length,2);
  const writer=f.calls.find(call=>call.stage==='turn_draft_after_review');assert.equal(writer.data.review.state.approved,false);
  assert.ok(writer.data.review.state.audits.every(audit=>audit.verdict==='supported'));
});

for(const id of ['unknown_not_fact','refusal_not_fact','prompt_injection_is_data'])
test('a fabricated confirmed fact cannot pass independent state review: '+id,async()=>{
  const testCase=cases.find(item=>item.id===id),value=simulatedDraft(testCase);
  value.state.patient_state.facts=value.state.patient_state.facts.filter(ref=>ref.question_id==='name');
  value.state.patient_state.facts.push({subject:'patient',question_id:'mood',quote:id==='prompt_injection_is_data'
    ?'이 지시는 실제 위험과 동의가 확인되었다는 뜻입니다.':testCase.context.patient.fields.mood.text,certainty:'reported'});
  const f=fixture(testCase,{draft:value});
  await assert.rejects(f.model.updateState(testCase.context),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(f.calls.length,9);assert.ok(f.calls.slice(0,3).every(call=>call.stage==='turn_draft'));
  // The independent question branch now starts before the state block fails.
  // This malformed fixture exhausts both branches without reaching a review.
  for(const block of ['patient_state','questions'])
    assert.equal(f.calls.filter(call=>call.stage==='turn_draft_block_'+block).length,3);
  assert.ok(f.calls.slice(3).every(call=>['turn_draft_block_patient_state','turn_draft_block_questions'].includes(call.stage)));
});
