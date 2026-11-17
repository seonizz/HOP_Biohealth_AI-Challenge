import test from 'node:test';
import assert from 'node:assert/strict';
import {combinedTurnEvidenceTransport,combinedTurnStreamSchema} from '../src/combined-turn-evidence-transport.js';
import {relationshipStateRequest,relationshipQuestionRequest,validateSchema} from '../src/relationship-agent.js';
import {literalStateRepairSchema} from '../src/relationship-state-repair.js';
import {ModelGateway} from '../src/model.js';
import {HttpError} from '../src/errors.js';
import {scopeContext,scopeDraft} from './helpers/turn-input-optimization-fixture.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const fixture=()=>{
  const context=scopeContext(),value=scopeDraft(context);
  return {context,value,schema:object({state:relationshipStateRequest(context,null).schema,questions:relationshipQuestionRequest(context).schema})};
};
const key=ref=>JSON.stringify([ref.subject,ref.question_id,ref.quote]);
const source=(transport,ref)=>transport.table.sources.find(row=>key(row.evidence)===key(ref)).id;
const invalid={code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'};

test('constrained combined turn keeps state first and selects question, reason and evidence before explanation',()=>{
  const {schema}=fixture();
  const transport=combinedTurnEvidenceTransport('turn_draft',schema);
  assert.ok(transport);
  for(const candidate of [schema,transport.schema,combinedTurnStreamSchema(transport.schema)]){
    assert.deepEqual(Object.keys(candidate.properties),['state','questions']);
    const branches=candidate.properties.questions.properties.skip.items.anyOf;
    assert.ok(branches.length);
    for(const branch of branches){
      assert.deepEqual(Object.keys(branch.properties),['question_id','reason','evidence','explanation']);
      assert.deepEqual(branch.required,['question_id','reason','evidence','explanation']);
    }
  }
});

for(const stage of ['turn_draft','turn_draft_after_review'])test('combined evidence round-trip retains exact text, certainty and all non-source fields: '+stage,()=>{
  const {schema,value}=fixture(),before=structuredClone({schema,value}),transport=combinedTurnEvidenceTransport(stage,schema);
  const encoded=transport.encode(value);assert.deepEqual(transport.decode(encoded),value);
  assert.deepEqual({schema,value},before);assert.equal(encoded.state.patient_state.facts[0].certainty,'reported');
  assert.deepEqual(Object.keys(encoded.state.patient_state.facts[0]),['s','certainty']);
  const id=encoded.state.patient_state.facts[0].s;
  assert.equal(encoded.state.relationship_memory.patient[0].evidence[0],id);
  assert.equal(encoded.questions.skip[0].evidence[0],id);
  assert.equal(transport.table.sources.filter(row=>row.id===id).length,1);
  assert.deepEqual(transport.schema.properties.questions.properties.clarify,schema.properties.questions.properties.clarify);
  assert.deepEqual(transport.schema.properties.questions.properties.safety,schema.properties.questions.properties.safety);
  assert.deepEqual(transport.schema.properties.state.properties.name_index,schema.properties.state.properties.name_index);
  assert.deepEqual(encoded.questions.clarify,value.questions.clarify);assert.deepEqual(encoded.questions.safety,value.questions.safety);
  assert.ok(JSON.stringify(encoded).length<JSON.stringify(value).length);
  const unknown=structuredClone(value);unknown.state.patient_state.facts[0].certainty='unknown';
  assert.deepEqual(transport.decode(transport.encode(unknown)),unknown,'source IDs never choose reported/unknown on the model’s behalf');
});

for(const kind of ['unknown-id','other-subject','other-certainty-branch','literal-ref','extra-fact-key','missing-certainty','changed-quote'])test('combined transport rejects '+kind+' before logical validation',()=>{
  const {schema,value,context}=fixture();
  const branches=schema.properties.state.properties.relationship_memory.properties.patient.items.anyOf;
  const unique={subject:'patient',question_id:'mood',quote:'합성 가설 분기 전용 원문'};
  branches[1].properties.evidence.items.enum=[unique];
  const transport=combinedTurnEvidenceTransport('turn_draft',schema),wire=transport.encode(value);
  if(kind==='unknown-id')wire.state.patient_state.facts[0].s='eunknown';
  if(kind==='other-subject')wire.state.relationship_memory.patient[0].evidence=[source(transport,{subject:'supporter',question_id:'feeling',quote:context.supporter.fields.feeling.rawText})];
  if(kind==='other-certainty-branch')wire.state.relationship_memory.patient[0].evidence=[source(transport,unique)];
  if(kind==='literal-ref')wire.state.relationship_memory.patient[0].evidence=value.state.relationship_memory.patient[0].evidence;
  if(kind==='extra-fact-key')wire.state.patient_state.facts[0].quote='fabricated';
  if(kind==='missing-certainty')delete wire.state.patient_state.facts[0].certainty;
  if(kind==='changed-quote'){
    value.state.patient_state.facts[0].quote+=' changed';assert.throws(()=>transport.encode(value),invalid);return;
  }
  assert.throws(()=>transport.decode(wire),invalid);
});

test('skip branch source pools stay separate and never inherit a source from another reason',()=>{
  const {schema,value}=fixture(),branches=schema.properties.questions.properties.skip.items.anyOf;
  const allowed=branches[0].properties.evidence.items.anyOf[0],different=structuredClone(allowed);
  different.properties.question_id.const='synthetic-other';different.properties.quote.enum=['별도 합성 원문'];
  different.enum=[{subject:different.properties.subject.const,question_id:'synthetic-other',quote:'별도 합성 원문'}];
  branches.push({...structuredClone(branches[0]),properties:{...structuredClone(branches[0].properties),reason:{type:'string',const:'not_needed'},evidence:{...structuredClone(branches[0].properties.evidence),items:different}}});
  const transport=combinedTurnEvidenceTransport('turn_draft',schema),wire=transport.encode(value);
  wire.questions.skip[0].evidence=[source(transport,different.enum[0])];
  assert.throws(()=>transport.decode(wire),invalid);
});

test('strict unknown fact certainty cannot be upgraded using a source ID',()=>{
  const {schema,value}=fixture(),facts=schema.properties.state.properties.patient_state.properties.facts;
  const branch=facts.items.anyOf.find(row=>row.properties.question_id.const==='mood');branch.properties.certainty={type:'string',const:'unknown'};
  value.state.patient_state.facts[0].certainty='unknown';
  const transport=combinedTurnEvidenceTransport('turn_draft',schema),wire=transport.encode(value);wire.state.patient_state.facts[0].certainty='reported';
  assert.throws(()=>transport.decode(wire),invalid);
});

test('private schemas and exact source tables cannot be widened through returned metadata',()=>{
  const {schema,value}=fixture(),transport=combinedTurnEvidenceTransport('turn_draft',schema),wire=transport.encode(value);
  const id=wire.state.patient_state.facts[0].s,original=structuredClone(value);
  transport.table.sources.find(row=>row.id===id).evidence.quote='tampered';
  transport.schema.properties.state.properties.patient_state.properties.facts.items.anyOf[0].properties.s.enum.push('eunknown');
  assert.deepEqual(transport.decode(wire),original);
  wire.state.patient_state.facts[0].s='eunknown';assert.throws(()=>transport.decode(wire),invalid);
});

test('literal retries retain source identities after a branch is removed and new sources are added',()=>{
  const {schema}=fixture(),unique={subject:'patient',question_id:'mood',quote:'가설 전용 합성 근거'};
  schema.properties.state.properties.relationship_memory.properties.patient.items.anyOf[1].properties.evidence.items.enum=[unique];
  const registry=new Map(),first=combinedTurnEvidenceTransport('turn_draft',schema,registry),removed=source(first,unique);
  const repaired=literalStateRepairSchema(schema,{combined:true});
  const extra={subject:'patient',question_id:'mood',quote:'재시도의 별도 합성 근거'};
  repaired.properties.state.properties.relationship_memory.properties.patient.items.properties.evidence.items.enum.push(extra);
  const second=combinedTurnEvidenceTransport('turn_draft',repaired,registry);
  assert.equal(second.table.sources.some(row=>row.id===removed),false);
  for(const row of second.table.sources.filter(row=>key(row.evidence)!==key(extra)))assert.equal(row.id,source(first,row.evidence));
  assert.notEqual(source(second,extra),removed);
});

test('empty/unbounded source nodes retain the original object representation',()=>{
  const {schema,value}=fixture();
  for(const branch of schema.properties.state.properties.relationship_memory.properties.patient.items.anyOf)delete branch.properties.evidence.items.enum;
  const transport=combinedTurnEvidenceTransport('turn_draft',schema),wire=transport.encode(value);
  assert.deepEqual(wire.state.relationship_memory.patient,value.state.relationship_memory.patient);
  assert.deepEqual(transport.decode(wire),value);
});

for(const mutation of ['unknown-keyword','anyof-sibling','parent-enum','bad-enum','bad-registry'])test('unsupported '+mutation+' falls back without changing the source registry',()=>{
  const {schema}=fixture(),registry=new Map();
  const patient=schema.properties.state.properties.patient_state;
  if(mutation==='unknown-keyword')patient.properties.facts.pattern='unsupported';
  if(mutation==='anyof-sibling')patient.properties.facts.items.maxItems=3;
  if(mutation==='parent-enum')schema.enum=[];
  if(mutation==='bad-enum')schema.properties.questions.properties.skip.items.anyOf[0].properties.evidence.items.anyOf[0].enum=[{subject:'other',question_id:'missing',quote:'bad'}];
  if(mutation==='bad-registry')registry.set('[]','e0');
  const before=structuredClone(schema),entries=[...registry];
  assert.equal(combinedTurnEvidenceTransport('turn_draft',schema,registry),null);assert.deepEqual(schema,before);assert.deepEqual([...registry],entries);
});

test('unrelated stages preserve the existing block and review transports',()=>{
  for(const stage of ['state','turn_review','turn_review_bundle','turn_draft_block_patient_state','turn_draft_block_relationship_memory','turn_draft_block_questions'])
    assert.equal(combinedTurnEvidenceTransport(stage,fixture().schema),null);
});

function gatewayFixture(handler,{stream=false}={}) {
  const calls=[],logs=[];
  const gateway=new ModelGateway({baseUrl:'http://127.0.0.1:9999/v1',apiKey:'synthetic',model:'synthetic',protocol:'relationship_agent',combinedTurnEvidenceIds:true,
    agentFormat:'json_object',timeoutMs:0,retryFailures:false,streamJson:stream,streamCompleteJson:stream,diagnosticLogger:row=>logs.push(row),fetchImpl:async(_url,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);calls.push(input);
      const value=await handler(input,calls.length),content=JSON.stringify(value);
      return stream?new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason:null}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}}):
        new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
    }});
  return {calls,logs,run:(schema,validate)=>gateway.operation({},operation=>gateway.agentComplete('turn_draft','Synthetic unchanged model task.',{source:'complete source'},schema,operation,validate))};
}

for(const stream of [false,true])test('gateway validates wire then passes the complete logical output to its existing validator; stream='+stream,async()=>{
  const {schema,value}=fixture();let validations=0;
  const h=gatewayFixture(input=>evidenceWireFixture(input,value),{stream});
  assert.deepEqual(await h.run(schema,result=>{validations++;validateSchema(result,schema,'output',true);return result;}),value);
  assert.equal(validations,1);assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].data,{source:'complete source'});
  assert.ok(h.calls[0].evidence_sources.locations.some(row=>row.kind==='fact'));
  assert.equal(JSON.stringify(h.logs).includes(value.state.patient_state.facts[0].quote),false);
});

test('combined retry uses the narrowed wire schema and keeps rejected output and IDs stable',async()=>{
  const {schema,value}=fixture();let validations=0;
  const h=gatewayFixture(input=>evidenceWireFixture(input,value),{stream:true});
  const result=await h.run(schema,logical=>{
    if(++validations===1){const error=new HttpError(502,'MODEL_INVALID_RESPONSE','synthetic');error.modelReason='agent_unreported_label';throw error;}
    return logical;
  });
  assert.deepEqual(result,value);assert.equal(h.calls.length,2);
  assert.deepEqual(h.calls[1].rejected_output,evidenceWireFixture(h.calls[0],value));
  for(const row of h.calls[1].evidence_sources.sources)assert.equal(row.id,h.calls[0].evidence_sources.sources.find(other=>key(other.evidence)===key(row.evidence)).id);
  assert.equal(h.calls[1].output_schema.properties.state.properties.relationship_memory.properties.relationship.maxItems,0);
});

test('stream parsing allowance keeps source-ID schema and original request limits',()=>{
  const {schema}=fixture(),transport=combinedTurnEvidenceTransport('turn_draft',schema),stream=combinedTurnStreamSchema(transport.schema);
  assert.equal(transport.schema.properties.state.properties.relationship_memory.properties.patient.maxItems,2);
  assert.equal(stream.properties.state.properties.relationship_memory.properties.patient.maxItems,3);
  assert.deepEqual(stream.properties.state.properties.patient_state,transport.schema.properties.state.properties.patient_state);
  assert.equal(stream.properties.state.properties.relationship_memory.properties.patient.items.anyOf[0].properties.evidence.items.type,'string');
});
