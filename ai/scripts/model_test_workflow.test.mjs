import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuestionSet } from '../../app/src/question-bank.js';
import { prepareSuite, runSuite } from './test_model_question_sets.mjs';

const questionSet = (follow = false) => createQuestionSet([
  {id:'name', enabled:true, sort_order:0, kind:'base', subject:'patient', definition:{q:'이름?',type:'text',required:true}},
  {id:'want', enabled:true, sort_order:1, kind:'base', subject:'user_goal', definition:{q:'목적?',type:'text',required:true}},
  {id:'concern', enabled:true, sort_order:2, kind:'base', subject:'patient', definition:{q:'관찰?',type:'text',
    ...(follow ? {follow_up:{when:{rule:'thin_text',min:10},merge:'replace_text',question:{q:'더 자세히?',type:'text',required:true}}} : {})}},
]);
const input = () => ({cases:[{id:'workflow',answers:[
  {question_id:'concern',text:'합성 관찰입니다.'}, {question_id:'name',text:'합성별칭'}, {question_id:'want',text:'이야기를 듣고 싶어요.'},
]}]});
function output(context) {
  const fields = Object.values(context.patient.fields).filter(field => field.status === 'answered');
  return {patient_state:{summary:'합성 상태',facts:fields.map(field => ({subject:'patient',question_id:field.id,
    quote:field.rawText,interpretation:'입력된 합성 보고입니다.',certainty:'reported'})),unknowns:[],
    user_goal:context.user_goal.message?.status === 'answered' ? context.user_goal.message.text : '확인되지 않음'},
    name_index:context.patient.fields.name?.status === 'answered' ? {alias:'합성별칭',source_question_id:'name',quote:'합성별칭'} : null,
    question_plan:{skip:[]}};
}
function gateway({skip = false, extraCalls = 1, parallel = false} = {}) {
  const calls = [], contexts = [];
  return {protocol:'relationship_agent', contexts, calls,
    fetchImpl:async () => { await new Promise(resolve => setTimeout(resolve, 1)); return new Response('{}'); },
    async updateState(context, prior) {
      contexts.push(structuredClone(context)); calls.push('state');
      assert.equal(Boolean(prior), calls.length > 1);
      const work = () => this.fetchImpl('http://synthetic.invalid/v1/chat/completions', {method:'POST'});
      if (parallel) await Promise.all(Array.from({length:extraCalls}, work));
      else for (let index=0; index<extraCalls; index++) await work();
      const value = output(context);
      if (skip && context.latest_answer.question_id === 'want') value.question_plan.skip = [{question_id:'concern',
        reason:'already_covered',explanation:'합성 목적 문장에 포함되어 있습니다.',
        evidence:[{subject:'user_goal',question_id:'want',quote:context.user_goal.message.text}]}];
      return value;
    },
    async respond(context, prior, options) {
      calls.push('final'); assert.ok(prior); assert.deepEqual(prior,context.agent_state);
      assert.equal(context.question_candidates.length,0);
      const state=output(context); delete state.question_plan;
      options.onCard?.({type:'upsert',id:'script',value:'합성 대화문'});
      return {...state,guide:{script:'합성 대화문'},assessment:{safety:false}};
    },
  };
}

test('workflow follows actual questions and passes prior memory through pending/apply/final boundaries', async () => {
  const set=questionSet(), model=gateway();
  const [row]=await runSuite(prepareSuite(input(),set,'workflow'),{mode:'workflow',gatewayFactory:()=>model});
  assert.equal(row.status,'completed'); assert.equal(row.workflow.completed,true);
  assert.deepEqual(row.turns.map(turn=>turn.question.id),['name','want','concern']);
  assert.deepEqual(model.calls,['state','state','state','final']);
  assert.equal(model.contexts[0].latest_answer.question_id,'name');
  assert.ok(model.contexts[0].question_candidates.length>0);
  assert.equal(row.workflow.final_state_applied,true); assert.equal(row.cards.length,1);
});

test('model-driven skips leave supplied but unasked answers unused and never fabricate evidence', async () => {
  const model=gateway({skip:true}), set=questionSet();
  const [row]=await runSuite(prepareSuite(input(),set,'workflow'),{mode:'workflow',gatewayFactory:()=>model});
  assert.equal(row.status,'completed'); assert.equal(row.workflow.completed,true);
  assert.deepEqual(row.turns.map(turn=>turn.question.id),['name','want']);
  assert.equal(row.workflow.unused_answers[0].question_id,'concern');
  assert.equal(row.workflow.model_skipped.concern.reason,'already_covered');
  assert.equal(row.result.patient_state.facts.some(fact=>fact.question_id==='concern'),false);
});

test('missing actual next question pauses instead of forcing final generation or inventing an answer', async () => {
  const suite=input(); suite.cases[0].answers=suite.cases[0].answers.filter(answer=>answer.question_id!=='want');
  suite.cases[0].expectations=[{path:'guide.script',operator:'exists'}];
  const model=gateway(),set=questionSet();
  const [row]=await runSuite(prepareSuite(suite,set,'workflow'),{mode:'workflow',gatewayFactory:()=>model});
  assert.equal(row.status,'awaiting_input'); assert.equal(row.workflow.next_question.id,'want');
  assert.deepEqual(model.calls,['state']); assert.deepEqual(row.checks,[]);
});

test('follow-up answers require explicit matching inputs and preserve actual app follow-up handling', async () => {
  const set=questionSet(true),suite=input();
  suite.cases[0].answers.push({question_id:'concern',follow_up:true,text:'추가로 명시한 자세한 합성 관찰입니다.'});
  const [row]=await runSuite(prepareSuite(suite,set,'workflow'),{mode:'workflow',gatewayFactory:()=>gateway()});
  assert.equal(row.status,'completed');
  assert.deepEqual(row.turns.map(turn=>Boolean(turn.question.follow_up)),[false,false,false,true]);
});

test('workflow runner remains valid when app call counts and scheduling change', async () => {
  const set=questionSet(),cases=prepareSuite(input(),set,'workflow');
  const [sequential]=await runSuite(cases,{mode:'workflow',gatewayFactory:()=>gateway({extraCalls:1})});
  const [parallel]=await runSuite(cases,{mode:'workflow',gatewayFactory:()=>gateway({extraCalls:5,parallel:true})});
  assert.equal(sequential.status,'completed'); assert.equal(parallel.status,'completed');
  assert.deepEqual(parallel.result,sequential.result);
  assert.ok(parallel.http.summary.total>sequential.http.summary.total);
  assert.ok(parallel.http.summary.peak_outstanding_until_headers>sequential.http.summary.peak_outstanding_until_headers);
  assert.deepEqual(parallel.turns.map(t=>t.question.id),sequential.turns.map(t=>t.question.id));
});

test('final state application rejects a gateway result that fails the app name boundary', async () => {
  const suite={cases:[{id:'bad_name',answers:[{question_id:'concern',text:'합성 관찰'}]}]};
  const [row]=await runSuite(prepareSuite(suite),{gatewayFactory:()=>({respond:async()=>({
    patient_state:{},name_index:{alias:'없는이름',source_question_id:'name',quote:'없는이름'},guide:{script:'합성'},assessment:{safety:false},
  })})});
  assert.equal(row.status,'error'); assert.equal(row.error_code,'MODEL_INVALID_RESPONSE');
  assert.notEqual(row.app_state_applied,true);
});
