import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {runCombinedRelationshipState} from '../src/relationship-turn.js';
import {scopeProbe,scopeContext,scopeDraft} from './helpers/turn-input-optimization-fixture.js';

const raw=content=>Response.json({choices:[{finish_reason:'stop',message:{content}}]});
const corruptQuote=value=>{
  const result=structuredClone(value);
  result.state.relationship_memory.patient[0].evidence[0].quote='PRIVATE_FABRICATED_QUOTE';
  return result;
};
function probe(sequence,{blockFault,reviewFault}={}) {
  let drafts=0;
  const logs=[];
  const f=scopeProbe(ModelGateway,{stateMode:'combined',response(call,value){
    if(call.stage==='turn_draft'){
      const kind=sequence[drafts++];
      if(kind==='evidence')return corruptQuote(value);
      if(kind==='json')return raw('{"state":{}},"questions":{}}');
      if(kind==='network')return Response.json({error:{code:'temporary'}},{status:503,headers:{'retry-after':'0'}});
      assert.fail('Unexpected additional combined draft');
    }
    if(blockFault&&call.data.output_block==='patient_state')delete value.unknowns;
    if(reviewFault&&call.stage==='turn_review')delete value.state.audits;
    return value;
  }});
  f.gateway.agentFormat='prompt';f.gateway.diagnosticLogger=entry=>logs.push(entry);
  const fetch=f.gateway.fetchImpl;
  f.gateway.discoverTokenLimits=true;
  f.gateway.fetchImpl=(url,options)=>options.method==='GET'
    ?Response.json({model:'synthetic-model',max_output_tokens:8192,max_context_tokens:32768}):fetch(url,options);
  return {...f,logs};
}

for(const sequence of [['evidence','json','json'],['json','evidence','json'],['json','json','evidence']])
test('mixed invalid citations and JSON get fresh validated blocks and independent review: '+sequence.join(','),async()=>{
  const f=probe(sequence),before=structuredClone(f.ctx),result=await f.run();
  assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(f.logs.filter(entry=>entry.generation==='turn_draft').map(entry=>entry.reason),
    sequence.map(kind=>kind==='evidence'?'agent_evidence':'content_json'));
  const combined=f.calls.filter(call=>call.stage==='turn_draft'),blocks=f.calls.filter(call=>call.data.output_block);
  assert.equal(combined.length,3);assert.equal(blocks.length,4);
  for(const block of blocks){
    for(const key of ['shared_input','state_input','question_input'])assert.deepEqual(block.data[key],combined[0].data[key]);
    assert.equal(block.data.failed_combined_candidate,undefined);
    assert.ok(!JSON.stringify(block.data.generated_blocks??null).includes('PRIVATE_FABRICATED_QUOTE'));
  }
  for(const stage of ['turn_review','question_review','safety_review'])assert.ok(f.calls.some(call=>call.stage===stage),stage);
  assert.ok(f.requests.every(request=>request.max_tokens===8192));
  assert.deepEqual(f.ctx,before);assert.ok(!JSON.stringify(result).includes('PRIVATE_FABRICATED_QUOTE'));
  const reviewed=f.calls.find(call=>call.stage==='turn_review').data;
  assert.ok(JSON.stringify(reviewed).includes(f.ctx.patient.fields.mood.rawText));
});

test('mixed recovery cannot synthesize a missing block field or reach independent approval',async()=>{
  const f=probe(['evidence','json','json'],{blockFault:true});
  await assert.rejects(f.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(f.calls.filter(call=>call.stage==='turn_draft').length,3);
  assert.equal(f.calls.filter(call=>call.stage==='turn_draft_block_patient_state').length,3);
  assert.equal(f.calls.some(call=>call.stage==='turn_review'),false);
});

test('fresh blocks remain unapproved when the independent reviewer omits audits',async()=>{
  const f=probe(['evidence','json','json'],{reviewFault:true});
  await assert.rejects(f.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(f.calls.filter(call=>call.stage==='turn_draft').length,3);
  assert.equal(f.calls.filter(call=>call.stage==='turn_review').length,3);
  assert.equal(f.calls.some(call=>call.stage==='turn_draft_after_review'),false);
});

for(const sequence of [['evidence','evidence','evidence'],['evidence','network','json']])
test('pure evidence failures and transport gaps do not qualify as mixed draft recovery: '+sequence.join(','),async()=>{
  const f=probe(sequence);
  await assert.rejects(f.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(f.calls.length,3);assert.equal(f.calls.some(call=>call.data.output_block),false);
});

test('misplaced full-turn root fields are reported before invalid nested evidence',async()=>{
  const ctx=scopeContext(),candidate=corruptQuote(scopeDraft(ctx));
  candidate.clarify=[];candidate.safety={urgent:false,evidence_ids:[]};
  let calls=0;
  const gateway={async agentComplete(stage,_prompt,_data,_schema,_operation,validate){
    calls++;assert.equal(stage,'turn_draft');return validate(candidate);
  }};
  await assert.rejects(runCombinedRelationshipState(gateway,ctx,null,{}),error=>{
    assert.equal(error.modelReason,'agent_schema');
    const feedback=JSON.parse(error.modelFeedback);
    assert.equal(feedback.path,'output');assert.equal(feedback.keyword,'objectKeys');
    assert.deepEqual(feedback.expected.keys,['state','questions']);
    return true;
  });
  assert.equal(calls,1);
});
