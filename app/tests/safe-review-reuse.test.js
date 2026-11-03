import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {ModelGateway} from '../src/model.js';
import {reviewedSafetyRequest} from '../src/turn-input-scope.js';
import {relationshipQuestionRequest,safetyReviewRequest,validateSafetyReview,safetySnapshotFingerprint} from '../src/relationship-agent.js';
import {scopeProbe,scopeContext,scopeReview,scopeDraft} from './helpers/turn-input-optimization-fixture.js';
import {safetyReviewFixture} from './helpers/safety-review.js';

const safetyCalls=fixture=>fixture.calls.filter(call=>call.stage.startsWith('safety_review'));
const withoutExecution=({state_agent,...output})=>output;
function probe(options={}) {
  const fixture=scopeProbe(ModelGateway,{enabled:true,blockScopedInputs:true,...options});
  fixture.gateway.reuseReviewedSafety=true;
  fixture.gateway.reviewedNameIdentity ||= randomUUID();
  return fixture;
}
function retain(fixture,result) {
  fixture.ctx.state_execution=structuredClone(result.state_agent);
  fixture.ctx.name_index=structuredClone(result.name_index);
  fixture.ctx.relationship_state=structuredClone(result.relationship_memory);
  fixture.ctx.agent_state=structuredClone(result.patient_state);
  fixture.ctx.safety_signal=structuredClone(result.safety_signal);
}
function skipNext(fixture) {
  fixture.ctx.patient.fields.support_requested={id:'support_requested',question:'원하는 도움이 있나요?',
    status:'skipped',text:'(건너뛰었어요)',rawText:'',custom:''};
  fixture.ctx.latest_answer={subject:'patient',question_id:'support_requested'};
  fixture.ctx.question_candidates=[];
  fixture.ctx.clarification_candidates=[{id:'next_detail',subject:'patient',question:'다른 중요한 내용이 있나요?'}];
  fixture.value.questions.skip=[];fixture.value.questions.clarify=['next_detail'];
}

for(const withName of [false,true])test('identical-input safety reuse preserves output and reduces skip POSTs '+(withName?'7 to 5 with name reuse':'7 to 6'),async()=>{
  const baseline=probe(),optimized=probe();baseline.gateway.reuseReviewedSafety=false;
  optimized.gateway.reuseReviewedName=withName;
  const firstBefore=await baseline.run(),firstAfter=await optimized.run();
  assert.deepEqual(withoutExecution(firstAfter),withoutExecution(firstBefore));
  assert.equal(firstAfter.state_agent.safety_reuse.reused,false);
  retain(baseline,firstBefore);retain(optimized,firstAfter);skipNext(baseline);skipNext(optimized);
  const snapshot=structuredClone(optimized.ctx),beforeCount=baseline.requests.length,afterCount=optimized.requests.length;
  const before=await baseline.run(),after=await optimized.run();
  assert.deepEqual(withoutExecution(after),withoutExecution(before));
  assert.deepEqual(optimized.ctx,snapshot);
  assert.equal(baseline.requests.length-beforeCount,7);
  assert.equal(optimized.requests.length-afterCount,withName?5:6);
  assert.equal(after.state_agent.safety_reuse.reused,true);
  assert.deepEqual(after.safety_signal,firstAfter.safety_signal);
  assert.equal(safetyCalls(optimized).length,1);
  for(const stage of ['turn_review','question_review'])assert.deepEqual(
    optimized.calls.slice(afterCount).find(call=>call.stage===stage),baseline.calls.slice(beforeCount).find(call=>call.stage===stage));
});

test('the safety projection keeps complete reports and unknown corrections while replacing only routing retrieval',()=>{
  const context=scopeContext();
  context.supporter.fields.note={id:'note',question:'더 알려 주세요.',status:'unknown',rawText:'현재 상황은 모르겠어요.',text:'현재 상황은 모르겠어요.'};
  context.patient.fields.mood.followUp={question:'현재 상황인가요?',answer:{rawText:'전해 들은 과거 이야기예요.',text:'전해 들은 과거 이야기예요.'}};
  const request=safetyReviewRequest(relationshipQuestionRequest(context),{safety_signal:{urgent:false,evidence:[]}});
  const normalized=reviewedSafetyRequest(context,request);
  assert.deepEqual(normalized.schema,request.schema);
  assert.deepEqual(normalized.data.safety_sources,request.data.safety_sources);
  assert.deepEqual(normalized.data.proposed_safety,request.data.proposed_safety);
  assert.deepEqual(normalized.data.retrieval.documents,request.data.safety_sources.flatMap(source=>source.components.map(component=>({subject:source.subject,question_id:source.question_id,...component}))));
  assert.equal(normalized.data.supporter.at(-1).status,'unknown');
  assert.equal(normalized.data.supporter.at(-1).answers[0].text,'현재 상황은 모르겠어요.');
  assert.ok(normalized.data.patient.find(row=>row.question_id==='mood').answers.some(answer=>answer.origin==='follow_up'));
  for(const key of ['question_candidates','clarification_candidates','prior_relationship_memory','answered_count'])assert.equal(Object.hasOwn(normalized.data,key),false);
  assert.ok(normalized.prompt.startsWith(request.prompt));
  assert.match(normalized.prompt,/전체 answered 원문/u);
  const output=safetyReviewFixture(normalized.data,'unclear');
  assert.deepEqual(validateSafetyReview(output,context,normalized),validateSafetyReview(output,context,request));
});

for(const [label,change] of [
  ['new danger report',fixture=>{fixture.ctx.supporter.fields.feeling.rawText='지금 다른 사람이 다쳐서 도움을 요청하고 있어요.';}],
  ['meaningful unknown',fixture=>{fixture.ctx.patient.fields.note={id:'note',question:'현재 상황은 어떤가요?',status:'unknown',rawText:'지금 어디 있는지 모르겠어요.',text:'지금 어디 있는지 모르겠어요.'};}],
  ['refusal report',fixture=>{fixture.ctx.patient.fields.note={id:'note',question:'현재 상황은 어떤가요?',status:'refused',rawText:'그 상황에 관해서는 말하지 않을게요.',text:'그 상황에 관해서는 말하지 않을게요.'};}],
  ['later correction',fixture=>{fixture.ctx.patient.fields.mood.followUp={question:'누구의 말인가요?',answer:{rawText:'대상자가 아니라 다른 사람의 말이에요.',text:'대상자가 아니라 다른 사람의 말이에요.'}};}],
  ['speaker',fixture=>{fixture.ctx.patient.fields.feeling=fixture.ctx.supporter.fields.feeling;delete fixture.ctx.supporter.fields.feeling;}],
  ['question meaning',fixture=>{fixture.ctx.patient.fields.mood.question='과거에 들은 이야기인가요?';}],
  ['model',fixture=>{fixture.gateway.model='another-synthetic-model';}],
  ['endpoint',fixture=>{fixture.gateway.baseUrl='https://another.synthetic.invalid/v1';}],
  ['reasoning',fixture=>{fixture.gateway.reasoningEffort='low';}],
  ['format',fixture=>{fixture.gateway.agentFormat='json_schema';}],
  ['gateway identity',fixture=>{fixture.gateway.reviewedNameIdentity=randomUUID();}],
  ['prompt revision',fixture=>{fixture.ctx.state_execution.prompt_version='old-prompt';}],
  ['validator revision',fixture=>{fixture.ctx.state_execution.safety_reuse.version='old-validator';}],
  ['unapproved metadata',fixture=>{fixture.ctx.state_execution.reviewed=false;}],
  ['invalid cached basis',fixture=>{fixture.ctx.state_execution.safety_reuse.output.basis='safe';}],
  ['invalid cached evidence',fixture=>{fixture.ctx.state_execution.safety_reuse.output.evidence_ids=['unknown-source'];}],
  ['missing current safety envelope',fixture=>{delete fixture.ctx.safety_signal;}],
])test('safety reuse misses after '+label,async()=>{
  const fixture=probe();retain(fixture,await fixture.run());change(fixture);
  // buildContext omits an envelope when actual answered sources have changed.
  if(fixture.ctx.safety_signal?.source_snapshot!==safetySnapshotFingerprint(fixture.ctx))delete fixture.ctx.safety_signal;
  await fixture.run();assert.equal(safetyCalls(fixture).length,2);
});

test('a changed urgent proposal requires independent review despite unchanged source text',async()=>{
  const fixture=probe({response:(call,output)=>call.stage==='safety_review'?safetyReviewFixture(call.data,'negated'):output});
  retain(fixture,await fixture.run());
  fixture.value.questions.skip=[];fixture.value.questions.clarify=[];
  fixture.value.questions.safety={urgent:true,evidence_ids:[safetyCalls(fixture)[0].data.safety_sources.find(source=>source.question_id==='mood').id]};
  const output=await fixture.run();
  assert.equal(safetyCalls(fixture).length,2);
  assert.equal(output.safety_signal.urgent,false,'the independent reviewer can reject the new urgent proposal');
  assert.equal(output.state_agent.safety_reuse.reused,false);
});

test('a new current danger report gets a fresh review and can replace a cached nonurgent verdict',async()=>{
  let current=false;
  const fixture=probe({response:(call,output)=>{
    if(call.stage!=='safety_review')return output;
    return {basis:current?'current_physical_danger':'negated',reason:'전체 현재 원문에서 시점과 위험의 부정을 대조했습니다.',
      evidence_ids:[call.data.safety_sources.find(source=>source.question_id==='mood').id]};
  }});
  retain(fixture,await fixture.run());current=true;
  const danger='지금 다른 사람을 때리는 행동이 계속되고 있어요.';
  Object.assign(fixture.ctx.patient.fields.mood,{rawText:danger,text:danger});
  delete fixture.ctx.safety_signal;
  Object.assign(fixture.value,scopeDraft(fixture.ctx));
  const output=await fixture.run();
  assert.equal(safetyCalls(fixture).length,2);
  assert.equal(output.safety_signal.urgent,true);
  assert.equal(output.safety_signal.review.basis,'current_physical_danger');
  assert.ok(output.safety_signal.evidence.some(ref=>ref.quote===danger));
  assert.equal(output.state_agent.safety_reuse.reused,false);
});

test('a cached unclear verdict remains unclear and cannot manufacture an assurance of safety',async()=>{
  const fixture=probe({response:(call,output)=>call.stage==='safety_review'?safetyReviewFixture(call.data,'unclear'):output});
  const first=await fixture.run();retain(fixture,first);skipNext(fixture);
  const result=await fixture.run();
  assert.deepEqual(result.safety_signal,first.safety_signal);
  assert.equal(result.safety_signal.urgent,false);assert.equal(result.safety_signal.review.basis,'unclear');
  assert.equal(result.state_agent.safety_reuse.reused,true);
});

test('separate reviewer identity and policy are checked without confusing the writer policy',async()=>{
  const fixture=probe(),transport=fixture.gateway.fetchImpl;
  let writerRevision='a'.repeat(64),reviewRevision='b'.repeat(64),reviewGets=0;
  const policy=(model,revision,output)=>new Response(JSON.stringify({model,token_policy_revision:revision,max_output_tokens:output,max_context_tokens:32768}));
  fixture.gateway.discoverTokenLimits=true;fixture.gateway.reuseTokenPolicy=true;
  fixture.gateway.fetchImpl=async(url,options)=>options.method==='GET'?policy(fixture.gateway.model,writerRevision,8192):transport(url,options);
  const reviewer=new ModelGateway({baseUrl:'https://reviewer.synthetic.invalid/v1',apiKey:'synthetic-review-only',model:'synthetic-reviewer',protocol:'relationship_agent',
    timeoutMs:0,agentFormat:'json_object',discoverTokenLimits:true,reuseTokenPolicy:true,diagnosticLogger:null,
    fetchImpl:async(url,options)=>{
      if(options.method==='GET'){reviewGets++;return policy(reviewer.model,reviewRevision,4096);}
      return transport(url,options);
    }});
  fixture.gateway.reviewGateway=reviewer;
  const first=await fixture.run();retain(fixture,first);
  writerRevision='c'.repeat(64);
  const second=await fixture.run();assert.equal(second.state_agent.safety_reuse.reused,true);
  assert.equal(safetyCalls(fixture).length,1);
  retain(fixture,second);reviewRevision='d'.repeat(64);
  const third=await fixture.run();assert.equal(third.state_agent.safety_reuse.reused,false);
  assert.equal(safetyCalls(fixture).length,2);
  assert.equal(reviewGets,3,'one existing shared reviewer metadata lookup per root operation');
  retain(fixture,third);reviewer.model='changed-synthetic-reviewer';
  await fixture.run();assert.equal(safetyCalls(fixture).length,3);
});

test('format-repaired safety output is not registered under the original request',async()=>{
  let attempts=0;
  const fixture=probe({response:(call,output)=>call.stage==='safety_review'&&++attempts===1?{basis:'unclear'}:output});
  const result=await fixture.run();assert.equal(safetyCalls(fixture).length,2);
  assert.equal(result.state_agent.safety_reuse,undefined);
});

test('state rejection renews the safety review and does not mint reusable repair metadata',async()=>{
  let reject=false,rejected=false;
  const fixture=probe({response:(call,output)=>{
    if(reject&&!rejected&&call.stage==='turn_review'){rejected=true;return scopeReview(call.data,true);}
    return output;
  }});
  retain(fixture,await fixture.run());reject=true;
  const result=await fixture.run();
  assert.equal(safetyCalls(fixture).length,2);
  assert.equal(safetyCalls(fixture).at(-1).stage,'safety_review_after_review');
  assert.equal(result.state_agent.safety_reuse,undefined);
});

test('cancellation and a failed parallel reviewer cannot commit safety metadata',async()=>{
  for(const cancelled of [true,false]) {
    const controller=new AbortController();
    const fixture=probe({response:async(call,output)=>{
      if(call.stage==='safety_review'&&cancelled)controller.abort();
      if(call.stage==='turn_review'&&!cancelled){await new Promise(setImmediate);return new Response('',{status:503});}
      return output;
    }});
    await assert.rejects(fixture.run({signal:controller.signal}));
    assert.equal(fixture.ctx.state_execution,undefined);
  }
});

test('a second intake without its own metadata cannot reuse another intake safety result',async()=>{
  const fixture=probe();retain(fixture,await fixture.run());
  delete fixture.ctx.state_execution;delete fixture.ctx.safety_signal;
  const result=await fixture.run();assert.equal(safetyCalls(fixture).length,2);
  assert.equal(result.state_agent.safety_reuse.reused,false);
});
