import test from 'node:test';
import assert from 'node:assert/strict';
import {assertAliasContract,aliasContractScenario,verifyAliasContract,ALIAS_REPORT} from '../scripts/verify-alias-contract.mjs';
import {evidenceWireFixture} from './evidence-wire.fixture.js';
import {scopeReview} from './helpers/turn-input-optimization-fixture.js';

const good=()=>({name_index:null,patient_state:{facts:[{subject:'patient',question_id:'q3_02',certainty:'reported',quote:ALIAS_REPORT}]}});
test('current v3 schema permits only null while a relationship-answer alias remains a reported fact',()=>{
  const {pending,context,nameSchema}=aliasContractScenario();
  assert.deepEqual(nameSchema,{type:'null'});assert.equal(context.patient.fields.q3_02.rawText,ALIAS_REPORT);
  assert.equal(context.patient.fields.name,undefined);assert.equal(pending.modelPending.input.question_id,'q3_02');
  assert.doesNotThrow(()=>assertAliasContract(good(),nameSchema));
});

test('alias contract rejects lost, paraphrased, reassigned or uncertain evidence and fabricated name indices',()=>{
  for(const patch of [{quote:'지민'},{quote:'친구 이름은 지민이에요.'},{subject:'supporter'},{question_id:'name'},{certainty:'tentative'}]){
    const value=good();Object.assign(value.patient_state.facts[0],patch);
    assert.throws(()=>assertAliasContract(value,{type:'null'}));
  }
  const lost=good();lost.patient_state.facts=[];assert.throws(()=>assertAliasContract(lost,{type:'null'}));
  const fabricated=good();fabricated.name_index={alias:'지민',source_question_id:'name',quote:ALIAS_REPORT};
  assert.throws(()=>assertAliasContract(fabricated,{type:'null'}));
  assert.throws(()=>assertAliasContract(good(),{type:'object'}));
});

const draft=()=>({state:{...good(),patient_state:{facts:good().patient_state.facts,unknowns:[]},
  relationship_memory:{patient:[],supporter:[],relationship:[],unknowns:[]}},questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}});
function fixture({stream=false,reject=false}={}){
  const stages=[];let draftRequests=0,cancels=0;
  const env={MODEL_BASE_URL:'http://127.0.0.1:11434/v1',MODEL_API_KEY:'synthetic',MODEL_NAME:'synthetic',MODEL_PROTOCOL:'relationship_agent',
    MODEL_AGENT_FORMAT:'json_object',MODEL_DISCOVER_TOKEN_LIMITS:'false',MODEL_STREAM_JSON:String(stream),MODEL_STREAM_COMPLETE_JSON:String(stream)};
  const fetchImpl=async(_url,init)=>{
    const input=JSON.parse(JSON.parse(init.body).messages.at(-1).content);stages.push(input.stage);
    const value=input.stage==='turn_draft'?(draftRequests++,draft()):scopeReview(input.data,reject);
    const content=JSON.stringify(evidenceWireFixture(input,value));
    if(!stream)return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}),{headers:{'content-type':'application/json'}});
    const wire=[...content].map(part=>'data: '+JSON.stringify({choices:[{index:0,delta:{content:part},finish_reason:null}]})+'\n\n').join('');
    return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(wire));},cancel(){cancels++;}}),{headers:{'content-type':'text/event-stream'}});
  };
  return {env,fetchImpl,stages,draftRequests:()=>draftRequests,cancels:()=>cancels};
}

test('combined alias qualification refuses question-only mode before any model request',async()=>{
  const f=fixture(),env={...f.env,MODEL_SINGLE_CALL_QUESTION_ONLY:'true'},before=structuredClone(env);
  const result=await verifyAliasContract({env,fetchImpl:f.fetchImpl});
  assert.equal(result.status,'failed');assert.equal(result.error.code,'UNSUPPORTED_QUALIFICATION_MODE');
  assert.equal(result.answer_model_calls,0);assert.equal(result.offline_audit_calls,0);
  assert.deepEqual(f.stages,[]);assert.deepEqual(env,before);
});

for(const stream of [false,true])test(`alias verification audits the original ${stream?'SSE':'JSON'} draft with one writer request`,async()=>{
  const f=fixture({stream}),receipt=await verifyAliasContract(f);
  assert.equal(receipt.status,'passed',JSON.stringify(receipt));assert.equal(receipt.answer_model_calls,1);
  assert.ok(receipt.offline_audit_calls>0);assert.equal(f.draftRequests(),1);
  assert.equal(receipt.value.state_agent.reviewed,false);assert.equal(receipt.reviewed.state_agent.reviewed,true);
  assertAliasContract(receipt.reviewed,receipt.name_schema);
  if(stream)assert.ok(f.cancels()>0,'JSON completion must release the original open SSE body');
});

test('a rejected independent audit cannot qualify the draft by regenerating it',async()=>{
  const f=fixture({reject:true}),receipt=await verifyAliasContract(f);
  assert.equal(receipt.status,'failed');assert.equal(receipt.answer_model_calls,1);assert.equal(f.draftRequests(),1);
  assert.ok(receipt.offline_audit_calls>0);assert.equal(receipt.reviewed,undefined);
});
