import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ModelGateway} from '../src/model.js';
import {createIntake,currentView,answerIntake,applyModelUpdate,buildContext,backIntake} from '../src/intake.js';
import {reviewedNameInput,REVIEWED_NAME_PROMPT} from '../src/turn-input-scope.js';
import {scopeProbe,scopeContext,scopeReview} from './helpers/turn-input-optimization-fixture.js';

const names=probe=>probe.calls.filter(call=>call.data.output_block==='name_index');
const withoutExecution=({state_agent,...output})=>output;
function probe(options={}) {
  const fixture=scopeProbe(ModelGateway,{enabled:true,blockScopedInputs:true,...options});
  fixture.gateway.reuseReviewedName=true;
  fixture.gateway.reviewedNameIdentity ||= randomUUID();
  return fixture;
}
function retain(fixture,result) {
  fixture.ctx.state_execution=structuredClone(result.state_agent);
  fixture.ctx.name_index=structuredClone(result.name_index);
  fixture.ctx.relationship_state=structuredClone(result.relationship_memory);
  fixture.ctx.agent_state=structuredClone(result.patient_state);
}
function skipNext(fixture) {
  fixture.ctx.patient.fields.support_requested={id:'support_requested',question:'원하는 도움이 있나요?',
    status:'skipped',text:'(건너뛰었어요)',rawText:'',custom:''};
  fixture.ctx.latest_answer={subject:'patient',question_id:'support_requested'};
  fixture.ctx.question_candidates=[];
  fixture.ctx.clarification_candidates=[{id:'next_detail',subject:'patient',question:'다른 중요한 내용이 있나요?'}];
  fixture.value.questions.skip=[];
  fixture.value.questions.clarify=['next_detail'];
}

test('an unchanged reviewed name saves one POST after a skip while output and every independent review remain equal',async()=>{
  const baseline=probe(),optimized=probe();baseline.gateway.reuseReviewedName=false;
  const firstBefore=await baseline.run(),firstAfter=await optimized.run();
  assert.deepEqual(withoutExecution(firstAfter),withoutExecution(firstBefore));
  assert.equal(firstAfter.state_agent.name_reuse.reused,false);
  assert.equal(firstBefore.state_agent.name_reuse,undefined);
  retain(baseline,firstBefore);retain(optimized,firstAfter);skipNext(baseline);skipNext(optimized);
  const contextBefore=structuredClone(optimized.ctx);
  const startBefore=baseline.requests.length,startAfter=optimized.requests.length;
  const before=await baseline.run(),after=await optimized.run();
  assert.deepEqual(withoutExecution(after),withoutExecution(before));
  assert.deepEqual(optimized.ctx,contextBefore,'cache access does not mutate saved intake/context');
  assert.equal(baseline.requests.length-startBefore,7);
  assert.equal(optimized.requests.length-startAfter,6);
  assert.equal(names(baseline).length,2);assert.equal(names(optimized).length,1);
  assert.equal(after.state_agent.name_reuse.reused,true);
  assert.deepEqual(after.name_index,firstAfter.name_index);
  for(const stage of ['turn_review','question_review','safety_review']) {
    const actual=optimized.calls.slice(startAfter).find(call=>call.stage===stage);
    const expected=baseline.calls.slice(startBefore).find(call=>call.stage===stage);
    assert.ok(actual,stage);assert.deepEqual(actual,expected,stage);
  }
  const firstName=names(optimized)[0];
  assert.equal(firstName.prompt,REVIEWED_NAME_PROMPT);
  assert.equal(Object.hasOwn(firstName.data,'generated_blocks'),false);
  assert.equal(Object.hasOwn(firstName.data,'question_input'),false);
  assert.deepEqual(firstName.data.source_input.patient.map(row=>row.question_id),['name','mood']);
});

test('name source projection keeps actual unknown answers, speakers and full later corrections',()=>{
  const context=scopeContext();
  context.patient.fields.note={id:'note',question:'추가 내용',status:'unknown',rawText:'누구의 이름인지는 모르겠어요.',text:'누구의 이름인지는 모르겠어요.'};
  context.supporter.fields.feeling.followUp={question:'누구를 말했나요?',answer:{rawText:'제가 아니라 다른 친구의 말이에요.',text:'제가 아니라 다른 친구의 말이에요.',custom:''}};
  const input=reviewedNameInput(context,{});
  assert.equal(input.source_input.patient.at(-1).status,'unknown');
  assert.equal(input.source_input.patient.at(-1).answers[0].text,'누구의 이름인지는 모르겠어요.');
  const correction=input.source_input.supporter[0].answers.find(answer=>answer.origin==='follow_up');
  assert.equal(correction.question,'누구를 말했나요?');
  assert.equal(correction.text,'제가 아니라 다른 친구의 말이에요.');
  assert.ok(input.retrieval.documents.every(row=>row.subject==='patient'&&row.question_id==='name'));
});

for(const [label,change] of [
  ['another source',fixture=>{fixture.ctx.supporter.fields.feeling.rawText='앞선 이름은 다른 친구의 이름이에요.';}],
  ['unknown report',fixture=>{fixture.ctx.patient.fields.note={id:'note',question:'추가 내용',status:'unknown',rawText:'실제 호칭은 모르겠어요.',text:'실제 호칭은 모르겠어요.'};}],
  ['follow-up correction',fixture=>{fixture.ctx.patient.fields.name.followUp={question:'호칭을 확인해 주세요.',answer:{rawText:'친구의 별명은 다르게 써요.',text:'친구의 별명은 다르게 써요.',custom:''}};}],
  ['speaker',fixture=>{fixture.ctx.patient.fields.feeling=fixture.ctx.supporter.fields.feeling;delete fixture.ctx.supporter.fields.feeling;}],
  ['source question wording',fixture=>{fixture.ctx.patient.fields.name.question='대상자의 실제 호칭을 알려 주세요.';}],
  ['model',fixture=>{fixture.gateway.model='another-synthetic-model';}],
  ['endpoint',fixture=>{fixture.gateway.baseUrl='https://another.synthetic.invalid/v1';}],
  ['format',fixture=>{fixture.gateway.agentFormat='json_schema';}],
  ['reasoning',fixture=>{fixture.gateway.reasoningEffort='low';}],
  ['credential identity',fixture=>{fixture.gateway.apiKey='another-synthetic-credential';}],
  ['gateway instance identity',fixture=>{fixture.gateway.reviewedNameIdentity=randomUUID();}],
  ['prompt revision',fixture=>{fixture.ctx.state_execution.prompt_version='obsolete-prompt-version';}],
  ['fingerprint corruption',fixture=>{fixture.ctx.state_execution.name_reuse.fingerprint='different-fingerprint';}],
  ['unapproved metadata',fixture=>{fixture.ctx.state_execution.reviewed=false;}],
  ['invalid cached name',fixture=>{fixture.ctx.state_execution.name_reuse.name_index.alias='원문에 없는 이름';fixture.ctx.name_index=structuredClone(fixture.ctx.state_execution.name_reuse.name_index);}],
])test('reviewed-name cache misses after '+label,async()=>{
  const fixture=probe();retain(fixture,await fixture.run());change(fixture);
  await fixture.run();assert.equal(names(fixture).length,2);
});

test('an existing name without completed review metadata still requires extraction',async()=>{
  const fixture=probe();fixture.ctx.name_index=structuredClone(fixture.value.state.name_index);
  const output=await fixture.run();assert.equal(names(fixture).length,1);
  assert.equal(output.state_agent.name_reuse.reused,false);
});

test('a name repaired with format feedback is not cached under the first-attempt request',async()=>{
  let attempts=0;
  const fixture=probe({response:(call,output)=>call.data.output_block==='name_index'&&++attempts===1?{name_index:{alias:'지민'}}:output});
  const output=await fixture.run();
  assert.equal(names(fixture).length,2);
  assert.equal(output.state_agent.name_reuse,undefined);
  retain(fixture,output);
  await fixture.run();assert.equal(names(fixture).length,3);
});

test('a reused name is freshly extracted after state rejection and the repair does not mint a reusable approval',async()=>{
  let reject=false,rejected=false;
  const fixture=probe({response:(call,output)=>{
    if(reject&&!rejected&&call.stage==='turn_review') {rejected=true;return scopeReview(call.data,true);}
    return output;
  }});
  retain(fixture,await fixture.run());reject=true;
  const output=await fixture.run();
  assert.equal(names(fixture).length,2);
  assert.equal(names(fixture).at(-1).stage,'turn_draft_block_name_index_after_review');
  assert.equal(names(fixture).at(-1).data.review.state.approved,false);
  assert.equal(output.state_agent.name_reuse,undefined);
});

test('cancellation never commits newly generated name reuse metadata',async()=>{
  const controller=new AbortController();
  const fixture=probe({response:(call,output)=>{
    if(call.data.output_block==='relationship_memory')controller.abort();
    return output;
  }});
  await assert.rejects(fixture.run({signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.equal(fixture.ctx.state_execution,undefined);
});

test('saved intake owns the name metadata and back navigation clears it',async()=>{
  const fixture=probe(),output=await fixture.run();
  let state=createIntake();
  const question=currentView(state).question;
  state=answerIntake(state,{question_id:question.id,text:'지민'});
  state=applyModelUpdate(state,{name_index:output.name_index,patient_state:output.patient_state,
    question_plan:{skip:[]},state_agent:output.state_agent});
  assert.deepEqual(buildContext(state).state_execution,output.state_agent);
  assert.equal(buildContext(createIntake()).state_execution,undefined);
  const previous=backIntake(state);
  assert.equal(previous.agentStateExecution,undefined);
  assert.equal(buildContext(previous).state_execution,undefined);
});
