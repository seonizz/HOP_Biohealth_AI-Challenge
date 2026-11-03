import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {HttpError} from '../src/errors.js';
import {runCombinedRelationshipState} from '../src/relationship-turn.js';
import {scopeContext,scopeDraft,scopeBlock,scopeReview,scopeProbe} from './helpers/turn-input-optimization-fixture.js';

const blocks=['patient_state','name_index','relationship_memory','questions'];
const stateBlocks=blocks.slice(0,3);
const blockStage=block=>'turn_draft_block_'+block;
const reviewStages=['turn_review','question_review','safety_review'];
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const inputOf=request=>JSON.parse(JSON.parse(request.body).messages.at(-1).content);
const waitForAbort=signal=>new Promise(resolve=>{
  signal.addEventListener('abort',resolve,{once:true});if(signal.aborted)resolve();
});

for(const options of [{stateMode:'combined_blocks',enabled:true,blockScopedInputs:true},{stateMode:'combined',fallback:true}])
test(options.stateMode+' runs question generation beside the sequential state chain without contaminating its inputs',async()=>{
  const baseline=scopeProbe(ModelGateway,options),expected=await baseline.run();
  const probe=scopeProbe(ModelGateway,options),transport=probe.gateway.fetchImpl;
  const first=deferred(),started=[],release=new Map(blocks.map(block=>[block,deferred()]));
  probe.gateway.fetchImpl=async(url,request)=>{
    const input=inputOf(request),block=input.data.output_block;
    const response=transport(url,request);
    if(!block)return response;
    started.push(block);first.resolve();await release.get(block).promise;return response;
  };
  const pending=probe.run();
  try {
    await first.promise;await tick();
    assert.deepEqual(started,['patient_state','questions']);
    release.get('questions').resolve();await tick();
    assert.deepEqual(started,['patient_state','questions'],'The name still waits for patient_state');
    assert.equal(probe.calls.some(call=>reviewStages.includes(call.stage)),false);
    release.get('patient_state').resolve();await tick();
    assert.deepEqual(started,['patient_state','questions','name_index']);
    release.get('name_index').resolve();await tick();
    assert.deepEqual(started,['patient_state','questions','name_index','relationship_memory']);
    release.get('relationship_memory').resolve();
    const result=await pending;
    assert.deepEqual(result,expected);
    assert.deepEqual(result.state_agent.stages,[...blocks.map(blockStage),...reviewStages]);
    for(const [index,block] of stateBlocks.entries()){
      const call=probe.calls.find(item=>item.data.output_block===block);
      assert.deepEqual(Object.keys(call.data.generated_blocks),stateBlocks.slice(0,index));
      assert.equal(Object.hasOwn(call.data.generated_blocks,'questions'),false);
    }
    assert.equal(Object.hasOwn(probe.calls.find(call=>call.data.output_block==='questions').data,'generated_blocks'),false);
    const byStage=value=>Object.fromEntries(value.requests.map(body=>[JSON.parse(body.messages.at(-1).content).stage,body]));
    assert.deepEqual(byStage(probe),byStage(baseline),'Completion order never changes prompts, sources or schemas');
    assert.deepEqual(probe.ctx,baseline.ctx);
  } finally {for(const gate of release.values())gate.resolve();await pending.catch(()=>{});}
});

for(const adaptive of [true,false])
test('parallel block generation preserves strict-null name omission and inactive questions, adaptive='+adaptive,async()=>{
  const ctx=scopeContext();delete ctx.patient.fields.name;
  const value=scopeDraft(ctx);value.state.name_index=null;value.questions=adaptive?value.questions:null;
  const probe=scopeProbe(ModelGateway,{ctx,value,adaptive});
  const result=await probe.run();
  assert.equal(result.name_index,null);
  assert.equal(probe.calls.some(call=>call.data.output_block==='name_index'),false);
  assert.equal(probe.calls.some(call=>call.data.output_block==='questions'),adaptive);
  assert.deepEqual(result.state_agent.stages,[blockStage('patient_state'),blockStage('relationship_memory'),
    ...(adaptive?[blockStage('questions'),...reviewStages]:['turn_review'])]);
  assert.equal(result.state_agent.reviewed,true);
  const relationship=probe.calls.find(call=>call.data.output_block==='relationship_memory');
  assert.deepEqual(Object.keys(relationship.data.generated_blocks),['patient_state','name_index']);
  assert.equal(relationship.data.generated_blocks.name_index,null);
});

test('a question request failure cancels the state branch and waits for it to settle before returning',async()=>{
  const probe=scopeProbe(ModelGateway),transport=probe.gateway.fetchImpl;
  const first=deferred(),fail=deferred(),drain=deferred(),started=[],aborted=[];
  probe.gateway.fetchImpl=async(url,request)=>{
    const block=inputOf(request).data.output_block;
    if(!block)return transport(url,request);
    started.push(block);first.resolve();
    if(block==='questions'){await fail.promise;return new Response('{}',{status:401});}
    assert.equal(block,'patient_state');const response=transport(url,request);
    await waitForAbort(request.signal);aborted.push(block);await drain.promise;return response;
  };
  let finished=false;
  const pending=probe.run().finally(()=>{finished=true;});
  const rejected=assert.rejects(pending,{code:'MODEL_AUTH_FAILED'});
  try {
    await first.promise;await tick();assert.deepEqual(started,['patient_state','questions']);
    fail.resolve();await tick();assert.deepEqual(aborted,['patient_state']);assert.equal(finished,false);
    drain.resolve();await rejected;
    assert.deepEqual(started,['patient_state','questions']);
    assert.equal(probe.calls.some(call=>reviewStages.includes(call.stage)),false);
  } finally {fail.resolve();drain.resolve();await rejected;}
});

test('external cancellation drains both draft branches and never reviews their late successful values',async()=>{
  const probe=scopeProbe(ModelGateway),transport=probe.gateway.fetchImpl,controller=new AbortController();
  const first=deferred(),drain=deferred(),started=[],aborted=[],settled=[];
  probe.gateway.fetchImpl=async(url,request)=>{
    const block=inputOf(request).data.output_block;
    if(!block)return transport(url,request);
    const response=transport(url,request);started.push(block);first.resolve();
    await waitForAbort(request.signal);aborted.push(block);await drain.promise;settled.push(block);return response;
  };
  let finished=false;
  const pending=probe.run({signal:controller.signal}).finally(()=>{finished=true;});
  const rejected=assert.rejects(pending,{code:'MODEL_CANCELLED'});
  try {
    await first.promise;await tick();assert.deepEqual(started,['patient_state','questions']);
    controller.abort();await tick();assert.deepEqual(aborted,started);assert.equal(finished,false);
    drain.resolve();await rejected;assert.deepEqual(settled,started);
    assert.equal(probe.calls.some(call=>reviewStages.includes(call.stage)),false);
    assert.equal(probe.calls.some(call=>call.data.output_block==='name_index'),false);
  } finally {controller.abort();drain.resolve();await rejected;}
});

function directProbe(ctx,operation,hook=()=>undefined) {
  const value=scopeDraft(ctx),calls=[];
  const gateway={stateMode:'combined_blocks',async agentComplete(stage,prompt,data,schema,activeOperation,validate){
    calls.push({stage,prompt,data:structuredClone(data),schema:structuredClone(schema)});
    const changed=await hook({stage,data,operation:activeOperation});
    const output=changed===undefined?(data.output_block?scopeBlock(value,data.output_block):scopeReview(data)):changed;
    return validate(output);
  }};
  return {calls,run:()=>runCombinedRelationshipState(gateway,ctx,null,operation)};
}
const operation=()=>({controller:new AbortController(),recovery:{},requestId:'synthetic-parallel-draft'});
const structuralFailure=()=>{
  const error=new HttpError(502,'MODEL_INVALID_RESPONSE','Synthetic block shape failure');
  error.modelReason='agent_schema';error.modelFeedback=JSON.stringify({path:'output',keyword:'objectKeys'});return error;
};

test('structural question failure retains only state blocks validated before cancellation, excluding a late name',async()=>{
  const ctx=scopeContext(),op=operation(),nameStarted=deferred(),nameSettled=deferred(),error=structuralFailure();
  const first=directProbe(ctx,op,async({data,operation:branch})=>{
    if(data.output_block==='questions'){await nameStarted.promise;throw error;}
    if(data.output_block==='name_index'){
      nameStarted.resolve();await waitForAbort(branch.controller.signal);nameSettled.resolve();
    }
  });
  await assert.rejects(first.run(),candidate=>candidate===error);
  await nameSettled.promise;
  assert.equal(op.controller.signal.aborted,false,'The parent remains available for its existing retry policy');
  assert.deepEqual(Object.keys(op.recovery.combinedBlocks.blocks),['patient_state']);
  assert.equal(op.recovery.combinedBlocks.blocks.questions,undefined);
  assert.equal(op.recovery.combinedBlocks.blocks.name_index,undefined);
  const retry=directProbe(ctx,op),result=await retry.run();
  assert.equal(retry.calls.some(call=>call.data.output_block==='patient_state'),false);
  for(const block of ['name_index','relationship_memory','questions'])
    assert.equal(retry.calls.filter(call=>call.data.output_block===block).length,1);
  assert.deepEqual(result.state_agent.stages,[...blocks.map(blockStage),...reviewStages]);
  assert.deepEqual(op.recovery,{});
});

test('a completed question block can be reused after a later state structural failure without mixing it into state inputs',async()=>{
  const ctx=scopeContext(),op=operation(),questionReturned=deferred(),error=structuralFailure();
  const first=directProbe(ctx,op,async({data})=>{
    if(data.output_block==='questions')questionReturned.resolve();
    if(data.output_block==='relationship_memory'){await questionReturned.promise;await tick();throw error;}
  });
  await assert.rejects(first.run(),candidate=>candidate===error);
  assert.deepEqual(Object.keys(op.recovery.combinedBlocks.blocks).sort(),['name_index','patient_state','questions']);
  const retry=directProbe(ctx,op),result=await retry.run();
  assert.deepEqual(retry.calls.filter(call=>call.data.output_block).map(call=>call.data.output_block),['relationship_memory']);
  assert.deepEqual(Object.keys(retry.calls[0].data.generated_blocks),['patient_state','name_index']);
  assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(result.state_agent.stages,[...blocks.map(blockStage),...reviewStages]);
  assert.deepEqual(op.recovery,{});
});

test('changed original input invalidates the completed question cache along with state blocks',async()=>{
  const ctx=scopeContext(),op=operation();
  const first=directProbe(ctx,op,async({data})=>{
    if(data.output_block==='relationship_memory'){await tick();throw structuralFailure();}
  });
  await assert.rejects(first.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.ok(op.recovery.combinedBlocks.blocks.questions);
  const changed=structuredClone(ctx);changed.supporter.fields.feeling.text=changed.supporter.fields.feeling.rawText='오늘은 쉬고 내일 이야기를 듣고 싶어요.';
  const retry=directProbe(changed,op);await retry.run();
  assert.deepEqual(retry.calls.filter(call=>call.data.output_block).map(call=>call.data.output_block).sort(),[...blocks].sort());
  assert.deepEqual(op.recovery,{});
});

test('full assembled-state validation still blocks all reviews despite a successful question branch',async()=>{
  const ctx=scopeContext(),value=scopeDraft(ctx);
  value.state.relationship_memory.patient[0].evidence=[{subject:'patient',question_id:'name',quote:'지민'}];
  const probe=scopeProbe(ModelGateway,{ctx,value});
  await assert.rejects(probe.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.ok(probe.calls.some(call=>call.data.output_block==='questions'));
  assert.equal(probe.calls.some(call=>reviewStages.includes(call.stage)),false);
});
