import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {HttpError} from '../src/errors.js';
import {runCombinedRelationshipState} from '../src/relationship-turn.js';
import {scopeContext,scopeDraft,scopeReview,scopeProbe} from './helpers/turn-input-optimization-fixture.js';

const reviewStages=['turn_review','question_review','safety_review'];
const isReview=stage=>reviewStages.some(prefix=>stage===prefix||stage===prefix+'_after_review');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));

function holdReviews(probe,expected) {
  const first=deferred(),started=[],signals=[],releases=new Map(expected.map(stage=>[stage,deferred()]));
  const transport=probe.gateway.fetchImpl;
  probe.gateway.fetchImpl=async(url,request)=>{
    const input=JSON.parse(JSON.parse(request.body).messages.at(-1).content);
    if(!releases.has(input.stage))return transport(url,request);
    // Materialize the same synthetic provider response before withholding it.
    // The real gateway parser and validators still run after release.
    const response=transport(url,request);
    started.push(input.stage);signals.push(request.signal);first.resolve();
    await releases.get(input.stage).promise;
    return response;
  };
  return {first,started,signals,releases,releaseAll:()=>{for(const item of releases.values())item.resolve();}};
}

for(const stateMode of ['combined','combined_blocks'])
test(stateMode+' starts all independent reviews before any finishes and preserves results in logical order',async()=>{
  const baseline=scopeProbe(ModelGateway,{stateMode}),probe=scopeProbe(ModelGateway,{stateMode});
  const expected=await baseline.run(),held=holdReviews(probe,reviewStages);
  let finished=false;
  const pending=probe.run().finally(()=>{finished=true;});
  try {
    await held.first.promise;await tick();
    assert.deepEqual(held.started,reviewStages,'No review waits for an earlier review response');
    held.releases.get('safety_review').resolve();await tick();
    assert.equal(finished,false,'Safety approval alone cannot complete a turn');
    held.releases.get('question_review').resolve();await tick();
    assert.equal(finished,false,'State approval is still required');
    held.releases.get('turn_review').resolve();
    const result=await pending;
    assert.deepEqual(result,expected);
    assert.deepEqual(result.state_agent.stages.slice(-3),reviewStages);
    assert.deepEqual(probe.requests,baseline.requests,'Every original prompt, input and schema is preserved');
    assert.equal(result.state_agent.reviewed,true);
    assert.deepEqual(probe.ctx,baseline.ctx);
  } finally {held.releaseAll();await pending.catch(()=>{});}
});

for(const adaptive of [true,false])
test('absent review proposals create no extra requests, adaptive='+adaptive,async()=>{
  const ctx=scopeContext(),value=scopeDraft(ctx);
  value.questions=adaptive?{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}:null;
  const expected=adaptive?['turn_review','safety_review']:['turn_review'];
  const probe=scopeProbe(ModelGateway,{ctx,value,adaptive,stateMode:'combined'}),held=holdReviews(probe,expected);
  const pending=probe.run();
  try {
    await held.first.promise;await tick();assert.deepEqual(held.started,expected);
    held.releaseAll();const result=await pending;
    assert.deepEqual(probe.calls.filter(call=>isReview(call.stage)).map(call=>call.stage),expected);
    assert.deepEqual(result.state_agent.stages,['turn_draft',...expected]);
    assert.equal(result.state_agent.reviewed,true);
  } finally {held.releaseAll();await pending.catch(()=>{});}
});

function directProbe(onReview) {
  const ctx=scopeContext(),value=scopeDraft(ctx),calls=[];
  const operation={controller:new AbortController(),recovery:{},requestId:'synthetic-parallel-review'};
  const gateway={stateMode:'combined',async agentComplete(stage,prompt,data,schema,activeOperation,validate){
    calls.push({stage,data:structuredClone(data)});
    const output=stage.startsWith('turn_draft')?structuredClone(value):scopeReview(data);
    return validate(isReview(stage)?await onReview({stage,data,operation:activeOperation,output}):output);
  }};
  return {calls,operation,run:()=>runCombinedRelationshipState(gateway,ctx,null,operation)};
}

test('a failed review aborts and settles sibling requests before returning the original error',async()=>{
  const first=deferred(),fail=deferred(),finish=deferred(),started=[],aborted=[],settled=[];
  const failure=new HttpError(503,'MODEL_AUTH_FAILED','Synthetic authentication failure');
  const probe=directProbe(async({stage,operation,output})=>{
    started.push(stage);first.resolve();
    if(stage==='turn_review'){await fail.promise;throw failure;}
    await new Promise(resolve=>{
      const abort=()=>{aborted.push(stage);resolve();};
      operation.controller.signal.addEventListener('abort',abort,{once:true});
      if(operation.controller.signal.aborted)abort();
    });
    await finish.promise;settled.push(stage);return output;
  });
  let returned=false;
  const pending=probe.run().finally(()=>{returned=true;});
  const rejected=assert.rejects(pending,error=>error===failure);
  try {
    await first.promise;await tick();assert.deepEqual(started,reviewStages);
    fail.resolve();await tick();
    assert.deepEqual(aborted.sort(),['question_review','safety_review']);
    assert.equal(returned,false,'The owning turn waits for cancelled siblings to finish');
    finish.resolve();await rejected;
    assert.equal(probe.operation.controller.signal.aborted,false,'A child failure cannot cancel the owning retry boundary');
    assert.deepEqual(settled.sort(),['question_review','safety_review']);
    assert.deepEqual(probe.calls.map(call=>call.stage),['turn_draft',...reviewStages]);
    assert.deepEqual(probe.operation.recovery,{},'An incomplete review set is never retained as approval');
  } finally {fail.resolve();finish.resolve();await rejected;}
});

test('external cancellation settles all active reviews and discards their late successful replies',async()=>{
  const probe=scopeProbe(ModelGateway,{stateMode:'combined'}),controller=new AbortController(),transport=probe.gateway.fetchImpl;
  const first=deferred(),finish=deferred(),started=[],aborted=[],settled=[];
  probe.gateway.fetchImpl=async(url,request)=>{
    const stage=JSON.parse(JSON.parse(request.body).messages.at(-1).content).stage;
    if(!isReview(stage))return transport(url,request);
    const response=transport(url,request);
    started.push(stage);first.resolve();
    await new Promise(resolve=>{
      const abort=()=>{aborted.push(stage);resolve();};
      request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();
    });
    await finish.promise;settled.push(stage);return response;
  };
  let returned=false;
  const pending=probe.run({signal:controller.signal}).finally(()=>{returned=true;});
  const rejected=assert.rejects(pending,{code:'MODEL_CANCELLED'});
  try {
    await first.promise;await tick();assert.deepEqual(started,reviewStages);
    controller.abort();await tick();
    assert.deepEqual(aborted,reviewStages);assert.equal(returned,false);
    finish.resolve();await rejected;assert.deepEqual(settled,reviewStages);
    assert.equal(probe.calls.some(call=>call.stage.endsWith('_after_review')),false);
  } finally {controller.abort();finish.resolve();await rejected;}
});

test('a semantic state rejection waits for question and safety results and retains the complete rejected pair',async()=>{
  const ctx=scopeContext();
  ctx.patient.fields.risk={id:'risk',question:'위험 상황',status:'answered',text:'오늘 자신을 해치겠다는 말을 들었어요.',rawText:'오늘 자신을 해치겠다는 말을 들었어요.',custom:''};
  const value=scopeDraft(ctx),questionReady=deferred(),safetyReady=deferred(),stateReady=deferred();
  let repaired=false;
  const probe=scopeProbe(ModelGateway,{ctx,value,stateMode:'combined',rejectOnce:true,response:async(call,output)=>{
    if(call.stage==='turn_review') {stateReady.resolve();return output;}
    if(call.stage==='question_review') {await questionReady.promise;return output;}
    if(call.stage==='safety_review') {
      await safetyReady.promise;
      return {basis:'current_physical_danger',reason:'현재 위험을 보고한 원문입니다.',
        evidence_ids:[call.data.safety_sources.find(source=>source.question_id==='risk').id]};
    }
    if(call.stage==='turn_draft_after_review') {
      repaired=true;
      assert.equal(call.data.review.state.approved,false);
      assert.ok(call.data.review.questions.audits.length>0);
      assert.equal(call.data.review.safety.basis,'current_physical_danger');
      assert.ok(call.data.rejected_draft.state.patient_state);
    }
    if(call.stage==='safety_review_after_review') {
      assert.equal(call.data.proposed_safety.urgent,true,'A new draft cannot withdraw independently confirmed danger');
      assert.ok(call.data.proposed_safety.evidence.some(ref=>ref.question_id==='risk'));
    }
  }});
  const pending=probe.run();
  try {
    await stateReady.promise;await tick();assert.equal(repaired,false);
    safetyReady.resolve();await tick();assert.equal(repaired,false,'The complete review pair includes the question review');
    questionReady.resolve();const result=await pending;
    assert.equal(repaired,true);assert.equal(result.finish_early,true);assert.equal(result.safety_signal.urgent,true);
    assert.deepEqual(result.question_plan,{skip:[]});assert.equal(result.clarification,null);
    assert.deepEqual(result.state_agent.stages,['turn_draft',...reviewStages,'turn_draft_after_review',...reviewStages.map(stage=>stage+'_after_review')]);
  } finally {questionReady.resolve();safetyReady.resolve();await pending.catch(()=>{});}
});

test('parallel reviews keep reviewer routing and share only its guarded token policy',async()=>{
  const probe=scopeProbe(ModelGateway,{stateMode:'combined'}),transport=probe.gateway.fetchImpl;
  const first=deferred(),release=deferred(),started=[];let gets=0;
  const reviewer=new ModelGateway({baseUrl:'https://synthetic-reviewer.invalid/v1',apiKey:'synthetic-review-key',model:'synthetic-reviewer',
    protocol:'relationship_agent',agentFormat:'json_object',timeoutMs:0,retryFailures:false,diagnosticLogger:null,
    discoverTokenLimits:true,reuseTokenPolicy:true,fetchImpl:async(url,request)=>{
      if(request.method==='GET') {
        gets++;await tick();return new Response(JSON.stringify({model:'synthetic-reviewer',max_output_tokens:4096,max_context_tokens:32768,token_policy_revision:'a'.repeat(64)}));
      }
      const body=JSON.parse(request.body),stage=JSON.parse(body.messages.at(-1).content).stage;
      assert.equal(body.model,'synthetic-reviewer');assert.equal(body.max_tokens,4096);
      assert.equal(request.headers.Authorization,'Bearer synthetic-review-key');
      assert.equal(request.headers['X-Malssi-Token-Policy-Revision'],'a'.repeat(64));
      started.push(stage);first.resolve();const response=transport(url,request);await release.promise;return response;
    }});
  probe.gateway.reviewGateway=reviewer;
  probe.gateway.fetchImpl=(url,request)=>{
    const stage=JSON.parse(JSON.parse(request.body).messages.at(-1).content).stage;
    assert.equal(isReview(stage),false,'Review calls never fall back to the writer');return transport(url,request);
  };
  const pending=probe.run();
  try {
    await first.promise;await tick();assert.deepEqual(started,reviewStages);assert.equal(gets,1);
    release.resolve();const result=await pending;assert.equal(result.state_agent.reviewed,true);
  } finally {release.resolve();await pending.catch(()=>{});}
});

test('one reviewer refreshing server limits cannot mix its revision with a sibling format retry budget',async()=>{
  const baseline=scopeProbe(ModelGateway,{stateMode:'combined'}),expected=await baseline.run();
  const probe=scopeProbe(ModelGateway,{stateMode:'combined'}),transport=probe.gateway.fetchImpl;
  const oldRevision='a'.repeat(64),newRevision='b'.repeat(64),stateRefreshed=deferred();
  let revision=oldRevision,gets=0,stateCalls=0,questionCalls=0;
  const questionBudgets=[];
  Object.assign(probe.gateway,{discoverTokenLimits:true,reuseTokenPolicy:true});
  probe.gateway.fetchImpl=async(url,request)=>{
    if(request.method==='GET'){
      gets++;return new Response(JSON.stringify({model:'synthetic-model',max_context_tokens:32768,
        max_output_tokens:revision===oldRevision?8192:4096,token_policy_revision:revision}));
    }
    const body=JSON.parse(request.body),stage=JSON.parse(body.messages.at(-1).content).stage;
    const sentRevision=request.headers['X-Malssi-Token-Policy-Revision'];
    const stale=()=>new Response(JSON.stringify({error:{code:'token_policy_changed'}}),{status:409});
    if(stage==='turn_review'){
      if(++stateCalls===1){revision=newRevision;return stale();}
      assert.equal(sentRevision,newRevision);assert.equal(body.max_tokens,4096);
      stateRefreshed.resolve();return transport(url,request);
    }
    if(stage==='question_review'){
      questionCalls++;questionBudgets.push([sentRevision,body.max_tokens]);
      if(questionCalls===1){
        // An old server response arrives after the sibling has refreshed.
        await stateRefreshed.promise;
        return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{}'}}]}));
      }
      if(sentRevision!==revision)return stale();
      if(body.max_tokens>4096)return new Response('{}',{status:400});
    }
    return transport(url,request);
  };
  try {
    assert.deepEqual(await probe.run(),expected);
    assert.equal(stateCalls,2);assert.equal(questionCalls,3);assert.equal(gets,3);
    assert.deepEqual(questionBudgets,[[oldRevision,8192],[oldRevision,8192],[newRevision,4096]]);
  } finally {stateRefreshed.resolve();}
});
