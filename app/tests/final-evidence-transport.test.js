import test from 'node:test';
import assert from 'node:assert/strict';
import {finalEvidenceTransport} from '../src/final-evidence-transport.js';
import {createFinalEvidenceReferenceCodec} from '../src/final-evidence-references.js';
import {ModelGateway} from '../src/model.js';
import {HttpError} from '../src/errors.js';
import {groundedEvidenceSchema,relationshipSelectionSchema,validateSchema} from '../src/relationship-agent.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';
import {cardCaseFormulationSchema} from '../src/card-case-formulation.js';
const stage='relationship_analysis';
const ref=(subject='patient',question_id='mood',quote='PRIVATE_원문 그대로. 조건과 정정도 보존.')=>({subject,question_id,quote});
const field=ref=>({id:ref.question_id,question:ref.question_id,status:'answered',rawText:ref.quote,text:ref.quote,custom:''});
function fixture(){
  const patient=ref(),other=ref('patient','support','PRIVATE_다른 근거'),supporter=ref('supporter','feeling','PRIVATE_이용자 원문');
  const context={patient:{fields:{mood:field(patient),support:field(other)}},supporter:{fields:{feeling:field(supporter)}},user_goal:{}};
  const schema=groundedEvidenceSchema(relationshipSelectionSchema,context);
  schema.properties.relationship.properties.strengths.items.properties.evidence.items.enum=[other];
  const value={observations:{patient:[patient],supporter:[supporter]},relationship:{label:'친구',supporter_role:'친구',
    dynamics:[{interpretation:'가능한 해석: 상황을 살펴볼 수 있어요.',evidence:[patient],certainty:'tentative'}],
    strengths:[{interpretation:'가능한 해석: 다른 근거를 살펴볼 수 있어요.',evidence:[other],certainty:'tentative'}],boundaries:[]},unknowns:[],safety:{urgent:false,evidence_ids:[]}};
  return {schema,value,context,patient,other,supporter};
}
for(const detailed of [false,true])test('reviewed safety omission retains lossless final evidence transport, detailed='+detailed,()=>{
 const {schema,value,context,patient}=fixture();
 delete schema.properties.safety;schema.required=schema.required.filter(key=>key!=='safety');delete value.safety;
 if(detailed){
  schema.properties.case_formulation=groundedEvidenceSchema(cardCaseFormulationSchema,context);schema.required.push('case_formulation');
  value.case_formulation={findings:[{dimension:'behavior',actor:'unclear',source_kind:'reported_observation',
   interpretation:'보고한 행동 원문입니다.',time_scope:'unclear',certainty:'reported',evidence:[patient]}]};
 }
 const before=structuredClone({schema,value}),transport=finalEvidenceTransport(stage,schema);
 assert.ok(transport,'independently reviewed safety must not disable citation encoding');
 const wire=evidenceWireFixture({output_schema:transport.schema,evidence_sources:transport.table},value);
 assert.equal(typeof wire.observations.patient[0],'string');assert.equal('safety' in wire,false);
 if(detailed){
  assert.equal(wire.case_formulation.findings[0].evidence[0],wire.observations.patient[0]);
  assert.equal(wire.case_formulation.findings[0].interpretation,value.case_formulation.findings[0].interpretation);
  assert.ok(transport.table.locations.some(row=>row.schema_path.includes('case_formulation')));
 }
 assert.deepEqual(transport.decode(wire),value);assert.deepEqual({schema,value},before);
 const invalid=structuredClone(wire);invalid.safety={urgent:false,evidence_ids:[]};
 assert.throws(()=>transport.decode(invalid),{code:'MODEL_INVALID_RESPONSE'});
 if(detailed){invalid.case_formulation.findings[0].evidence=['missing'];delete invalid.safety;
  assert.throws(()=>transport.decode(invalid),{code:'MODEL_INVALID_RESPONSE'});}
});

for(const selectedStage of [stage,'analysis_repair','analysis_repair_after_guide_review'])test('final codec exact roundtrip and global dedup with node allowlists: '+selectedStage,()=>{
  const {schema,value}=fixture(),before=structuredClone({schema,value}),transport=finalEvidenceTransport(selectedStage,schema),codec=createFinalEvidenceReferenceCodec(schema);
  assert.ok(transport);const wire=codec.encode(value);assert.deepEqual(transport.decode(wire),value);
  assert.equal(wire.observations.patient[0],wire.relationship.dynamics[0].evidence[0]);
  assert.deepEqual(wire.safety,value.safety);assert.deepEqual({schema,value},before);
  assert.ok(transport.table.locations.find(row=>row.schema_path.includes('strengths')).allowed_source_ids.every(id=>id!==wire.observations.patient[0]));
});
for(const bad of ['unknown_id','wrong_node','legacy_object','altered_object','extra_key','array_overflow'])test('final codec rejects '+bad+' without repairing the candidate',()=>{
  const {schema,value}=fixture(),transport=finalEvidenceTransport(stage,schema),wire=createFinalEvidenceReferenceCodec(schema).encode(value);
  if(bad==='unknown_id')wire.observations.patient[0]='PRIVATE_UNKNOWN';
  if(bad==='wrong_node')wire.relationship.strengths[0].evidence[0]=wire.observations.patient[0];
  if(bad==='legacy_object')wire.observations.patient[0]=value.observations.patient[0];
  if(bad==='altered_object')wire.observations.patient[0]={...value.observations.patient[0],quote:'PRIVATE_SHORT'};
  if(bad==='extra_key')wire.PRIVATE_EXTRA='PRIVATE_VALUE';
  if(bad==='array_overflow')wire.observations.patient=Array(20).fill(wire.observations.patient[0]);
  const before=structuredClone(wire);assert.throws(()=>transport.decode(wire),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});assert.deepEqual(wire,before);
});
test('full source pools are preserved without truncation and shared references appear once in table',()=>{
  const {schema}=fixture(),pool=Array.from({length:300},(_,i)=>ref('patient','mood','PRIVATE_'+i));
  for(const key of ['dynamics','strengths','boundaries'])schema.properties.relationship.properties[key].items.properties.evidence.items.enum=pool;
  const transport=finalEvidenceTransport(stage,schema),locations=transport.table.locations.filter(row=>row.schema_path.includes('relationship'));
  for(const location of locations)assert.equal(location.allowed_source_ids.length,300);
  assert.equal(new Set(locations.flatMap(row=>row.allowed_source_ids)).size,300);
  const recovered=new Map(transport.table.sources.map(row=>[row.id,row.evidence]));assert.deepEqual(locations[0].allowed_source_ids.map(id=>recovered.get(id)),pool);
});
for(const keyword of ['anyOf','oneOf','allOf','$ref','not'])test('unsupported '+keyword+' preserves legacy representation',()=>{
  const {schema}=fixture();schema.properties.relationship[keyword]=keyword==='$ref'?'#/$defs/relationship':[];
  const before=structuredClone(schema);assert.equal(finalEvidenceTransport(stage,schema),null);assert.deepEqual(schema,before);
});
test('absent or empty reference enum falls back without inventing a source or rejecting legacy objects',()=>{
  for(const empty of [false,true]){const {schema}=fixture(),node=schema.properties.observations.properties.supporter.items;
    if(empty)node.enum=[];else delete node.enum;
    assert.equal(finalEvidenceTransport(stage,schema),null);
  }
  for(const otherStage of ['turn_review','relationship_memory','turn_draft_block_relationship_memory','analysis_review','communication_plan'])assert.equal(finalEvidenceTransport(otherStage,fixture().schema),null);
});
function harness(handler,{streamJson=false}={}){
  const calls=[],logs=[];let validated=0;
  const model=new ModelGateway({baseUrl:'http://127.0.0.1:11434/v1',apiKey:'PRIVATE_KEY',model:'synthetic',protocol:'relationship_agent',agentFormat:'prompt',streamJson,streamCompleteJson:streamJson,timeoutMs:0,retryFailures:false,diagnosticLogger:row=>logs.push(row),fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);calls.push({body,...input});const result=handler(input,calls.length);
    if(streamJson)return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(result)},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
  }});
  return {calls,logs,run:(schema,check=value=>value)=>model.operation({},operation=>model.agentComplete(stage,'기존 원문 객체 출력 지침',{answers:'PRIVATE_FULL_CONTEXT'},schema,operation,value=>{validated++;validateSchema(value,schema,'output',true);return check(value);})),get validated(){return validated;}};
}
for(const streamJson of [false,true])test('model final transport validates wire, restores exact references and preserves full context: stream='+streamJson,async()=>{
  const {schema,value}=fixture(),h=harness(input=>evidenceWireFixture(input,value),{streamJson});assert.deepEqual(await h.run(schema),value);assert.equal(h.validated,1);
  assert.equal(h.calls[0].data.answers,'PRIVATE_FULL_CONTEXT');assert.match(h.calls[0].body.messages[0].content,/최종 분석 출력 형식/u);
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE_'),false);assert.equal(JSON.stringify(h.logs).includes('evidence_sources'),false);
});
test('final transport retains pristine ID candidate across semantic retries',async()=>{
  const {schema,value}=fixture(),h=harness(input=>evidenceWireFixture(input,value));let count=0;
  await h.run(schema,result=>{if(++count===1){result.observations.patient[0].quote='PRIVATE_MUTATED';throw Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','synthetic'),{modelReason:'agent_evidence'});}return result;});
  assert.equal(typeof h.calls[1].rejected_output.observations.patient[0],'string');assert.equal(JSON.stringify(h.calls[1].rejected_output).includes('PRIVATE_MUTATED'),false);
});
test('final transport cannot bypass a caller semantic rejection after decoding',async()=>{
  const {schema,value}=fixture(),h=harness(input=>evidenceWireFixture(input,value));
  await assert.rejects(h.run(schema,result=>{assert.deepEqual(result,value);throw Object.assign(new HttpError(502,'MODEL_INVALID_RESPONSE','synthetic'),{modelReason:'agent_evidence'});}),{modelReason:'agent_evidence'});
  assert.equal(h.validated,3);
});
