import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway,relationshipEvidenceTransport,inferenceSchema} from '../src/model.js';
import {validateSchema} from '../src/relationship-agent.js';
import {HttpError} from '../src/errors.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';
const stage='turn_draft_block_relationship_memory';
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array=(items,maxItems=3)=>({type:'array',items,minItems:0,maxItems});
const ref=(subject='patient',quote='PRIVATE_exact source. Whole second sentence.')=>({subject,question_id:'mood',quote});
const finding=(pool,certainty)=>object({certainty:{type:'string',enum:[certainty]},evidence:array({...object({subject:{type:'string'},question_id:{type:'string'},quote:{type:'string',maxLength:1000}}),enum:pool}),...(certainty==='tentative'?{interpretation:{type:'string',maxLength:500}}:{})});
const schema=()=>object({patient:array({anyOf:[finding([ref()],'reported'),finding([ref('patient','PRIVATE_tentative source')],'tentative')]}),
  supporter:array(finding([ref('supporter')],'reported')),relationship:array(finding([ref(),ref('supporter')],'tentative')),unknowns:array({type:'string',maxLength:400})});
const output=()=>({patient:[{certainty:'reported',evidence:[ref()]}],supporter:[],relationship:[],unknowns:[]});
function harness(handler,options={}){
  const calls=[],logs=[];let validations=0;
  const model=new ModelGateway({baseUrl:'http://127.0.0.1:11434/v1',apiKey:'PRIVATE_KEY',model:'synthetic',protocol:'relationship_agent',agentFormat:'json_schema',timeoutMs:0,retryFailures:false,
    ...options,diagnosticLogger:entry=>logs.push(entry),fetchImpl:async(_url,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);calls.push({body,...input});
      const result=handler(input,calls.length);
      if(options.streamJson)return new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:JSON.stringify(result)},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]}));
    }});
  return {calls,logs,get validations(){return validations;},run:(shape=schema(),selectedStage=stage,validate=value=>value)=>model.operation({},operation=>model.agentComplete(selectedStage,'Original evidence objects and complete source context.',{answers:['PRIVATE_full context']},shape,operation,value=>{validations++;validateSchema(value,shape,'output',true);return validate(value);} ))};
}
for(const suffix of ['','_after_review'])test('wire IDs round-trip exact sources and leave context/schema untouched '+suffix,async()=>{
  const original=schema(),snapshot=structuredClone(original),good=output();
  const h=harness(input=>evidenceWireFixture(input,good));
  assert.deepEqual(await h.run(original,stage+suffix),good);assert.deepEqual(original,snapshot);assert.equal(h.validations,1);
  const call=h.calls[0];assert.deepEqual(call.data.answers,['PRIVATE_full context']);assert.match(call.body.messages[0].content,/ID 문자열 배열/u);assert.match(call.body.messages[0].content,/대응표가 있는 위치의 evidence만/u);assert.match(call.body.messages[0].content,/대응표가 없는 위치는 output_schema의 기존 객체 형식/u);
  assert.equal(call.evidence_selection_repair,undefined);assert.deepEqual(call.body.response_format.json_schema.schema,inferenceSchema(call.output_schema));
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE_'),false);assert.equal(JSON.stringify(h.logs).includes('source_patient'),false);
});
for(const mutation of ['unknown','wrong_branch','wrong_group','object','altered_object','wrong_certainty','extra_key'])test('wire rejects '+mutation+' before original caller validation',async()=>{
  const h=harness(input=>{
    const value=evidenceWireFixture(input,output()),row=value.patient[0];
    if(mutation==='unknown')row.evidence[0]='PRIVATE_unknown';
    if(mutation==='wrong_branch')row.evidence[0]='source_patient_1_0';
    if(mutation==='wrong_group')row.evidence[0]='source_supporter_0_0';
    if(mutation==='object')row.evidence[0]=ref();
    if(mutation==='altered_object')row.evidence[0]=ref('patient','PRIVATE_short');
    if(mutation==='wrong_certainty')row.certainty='tentative';
    if(mutation==='extra_key')row.extra='PRIVATE_extra';
    return value;
  });
  await assert.rejects(h.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});assert.equal(h.calls.length,3);assert.equal(h.validations,0);
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE_'),false);assert.equal(JSON.stringify(h.logs).includes('source_patient'),false);
});
test('repair retains pristine wire candidate even when downstream validation mutates its decoded value',async()=>{
  const h=harness(input=>evidenceWireFixture(input,output()));let count=0;
  await h.run(schema(),stage,value=>{if(++count===1){value.patient[0].evidence[0].quote='PRIVATE_mutated';const error=new HttpError(502,'MODEL_INVALID_RESPONSE','synthetic');error.modelReason='agent_evidence';throw error;}return value;});
  assert.deepEqual(h.calls[1].rejected_output.patient[0].evidence,['source_patient_0_0']);assert.equal(JSON.stringify(h.calls[1].rejected_output).includes('PRIVATE_mutated'),false);
});
test('complete pools are transmitted without truncating or choosing candidates',()=>{
  const shape=schema(),pool=Array.from({length:300},(_,i)=>ref('patient','PRIVATE_'+i));shape.properties.patient.items.anyOf[0].properties.evidence.items.enum=pool;
  const transport=relationshipEvidenceTransport(stage,shape),table=transport.table[0];assert.equal(table.sources.length,300);assert.deepEqual(table.sources.map(row=>row.evidence),pool);
  const value=output();value.patient[0].evidence=['source_patient_0_299'];assert.deepEqual(transport.decode(value).patient[0].evidence,[pool[299]]);
});
for(const keyword of ['oneOf','allOf','$ref','not'])test('unsupported '+keyword+' leaves legacy schema unchanged',()=>{
  const shape=schema(),snapshot=structuredClone(shape);shape.properties.patient.items[keyword]=keyword==='$ref'?'#/$defs/memory':[];
  const before=structuredClone(shape);assert.equal(relationshipEvidenceTransport(stage,shape),null);assert.deepEqual(shape,before);assert.notDeepEqual(shape,snapshot);
});
test('nodes without enum retain their original object representation and validations',()=>{
  const shape=schema();delete shape.properties.supporter.items.properties.evidence.items.enum;
  const transport=relationshipEvidenceTransport(stage,shape);assert.deepEqual(transport.schema.properties.supporter,shape.properties.supporter);
  const value=output();value.patient[0].evidence=['source_patient_0_0'];value.supporter=[{certainty:'reported',evidence:[ref('supporter')]}];
  assert.deepEqual(transport.decode(value).supporter,value.supporter);assert.equal(transport.table.some(row=>row.schema_path.includes('supporter')),false);
});
test('no-enum schemas and unrelated stages never invent a transport',()=>{
  const shape=schema();for(const group of ['patient','supporter','relationship'])for(const branch of shape.properties[group].items.anyOf||[shape.properties[group].items])delete branch.properties.evidence.items.enum;
  assert.equal(relationshipEvidenceTransport(stage,shape),null);
  for(const other of ['relationship_memory','turn_draft','turn_review','turn_draft_block_questions'])assert.equal(relationshipEvidenceTransport(other,schema()),null);
});
test('literal block repair keeps only reported branches and disables relationship claims',async()=>{
  const h=harness(input=>evidenceWireFixture(input,output()));let count=0;
  await h.run(schema(),stage,value=>{if(++count===1){const error=new HttpError(502,'MODEL_INVALID_RESPONSE','synthetic');error.modelReason='agent_unreported_label';throw error;}return value;});
  assert.match(h.calls[1].body.messages[0].content,/relationship는 \[\]/u);
  const repaired=h.calls[1].output_schema;assert.deepEqual(repaired.properties.patient.items.properties.certainty.enum,['reported']);assert.equal(repaired.properties.relationship.maxItems,0);
  assert.equal(h.calls[1].evidence_sources.some(row=>row.schema_path.includes('patient.items.anyOf')),false);
  assert.throws(()=>validateSchema({ ...evidenceWireFixture(h.calls[1],output()),relationship:[{certainty:'tentative',interpretation:'claim',evidence:['source_relationship_0_0']}]},repaired),{code:'MODEL_INVALID_RESPONSE'});
});
test('streaming uses the wire schema and still validates and decodes IDs',async()=>{
  const h=harness(input=>evidenceWireFixture(input,output()),{streamJson:true,streamCompleteJson:true});assert.deepEqual(await h.run(),output());assert.equal(h.validations,1);
});

test('unsupported anyOf sibling shape falls back instead of ignoring original constraints',()=>{
  const shape=schema();shape.properties.patient.items.anyOf[0].properties.evidence.items.anyOf=[{type:'object'}];
  assert.equal(relationshipEvidenceTransport(stage,shape),null);
});

for(const certainty of ['reported','tentative'])test('wire enum retry lists exact declared '+certainty+' branch IDs without changing sources',async()=>{
  const good=output();if(certainty==='tentative')good.patient=[{certainty,interpretation:'가능한 해석: 합성 해석',evidence:[ref('patient','PRIVATE_tentative source')]}];
  const h=harness((input,count)=>{const value=evidenceWireFixture(input,good);if(count===1)value.patient[0].evidence[0]='PRIVATE_invalid_id';return value;});
  assert.deepEqual(await h.run(),good);assert.equal(h.calls[0].wire_evidence_selection_repair,undefined);
  const hint=h.calls[1].wire_evidence_selection_repair,index=certainty==='reported'?0:1;
  assert.equal(hint.output_path,'output.patient[0].evidence[0]');assert.equal(hint.certainty,certainty);
  assert.deepEqual(hint.allowed_source_ids,h.calls[1].output_schema.properties.patient.items.anyOf[index].properties.evidence.items.enum);
  assert.deepEqual(h.calls[1].evidence_sources,h.calls[0].evidence_sources);assert.deepEqual(h.calls[1].rejected_output.patient[0].evidence,['PRIVATE_invalid_id']);
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE_'),false);assert.equal(JSON.stringify(h.logs).includes('source_patient'),false);
});
test('wire enum repair never truncates the complete allowed pool',async()=>{
  const shape=schema(),pool=Array.from({length:300},(_,i)=>ref('patient','PRIVATE_'+i));shape.properties.patient.items.anyOf[0].properties.evidence.items.enum=pool;
  const good=output();good.patient[0].evidence=[pool.at(-1)];
  const h=harness((input,count)=>{const value=evidenceWireFixture(input,good);if(count===1)value.patient[0].evidence[0]='PRIVATE_invalid';return value;});
  await h.run(shape);assert.deepEqual(h.calls[1].wire_evidence_selection_repair.allowed_source_ids,h.calls[1].output_schema.properties.patient.items.anyOf[0].properties.evidence.items.enum);
  assert.equal(h.calls[1].wire_evidence_selection_repair.allowed_source_ids.length,300);
});
test('wire hint is cleared by a different error and does not cross calls or stages',async()=>{
  const h=harness((input,count)=>{const value=evidenceWireFixture(input,output());if(count===1)value.patient[0].evidence[0]='PRIVATE_invalid';if(count===2)value.extra='PRIVATE_extra';return value;});
  await h.run();await h.run();await h.run(schema(),'turn_review');
  assert.ok(h.calls[1].wire_evidence_selection_repair);for(const call of h.calls.slice(2))assert.equal(call.wire_evidence_selection_repair,undefined);
});
test('wire hint does not invent certainty for an invalid or ambiguous branch',async()=>{
  for(const ambiguous of [false,true]){
    const shape=schema();if(ambiguous)shape.properties.patient.items.anyOf[1].properties.certainty.enum=['reported'];
    const h=harness(input=>{const value=evidenceWireFixture(input,output());value.patient[0].evidence[0]='PRIVATE_invalid';if(!ambiguous)value.patient[0].certainty='PRIVATE_invalid_certainty';return value;});
    await assert.rejects(h.run(shape),{code:'MODEL_INVALID_RESPONSE'});assert.ok(h.calls.every(call=>call.wire_evidence_selection_repair===undefined));
  }
});
test('wire hint is not generated for object/type or array-bound errors',async()=>{
  for(const mutation of ['object','overflow']){
    const h=harness(input=>{const value=evidenceWireFixture(input,output());if(mutation==='object')value.patient[0].evidence[0]=ref();else value.patient=Array.from({length:4},()=>structuredClone(value.patient[0]));return value;});
    await assert.rejects(h.run(),{code:'MODEL_INVALID_RESPONSE'});assert.ok(h.calls.every(call=>call.wire_evidence_selection_repair===undefined));
  }
});
test('identical source text across branches does not make another branch ID eligible',async()=>{
  const shape=schema();shape.properties.patient.items.anyOf[1].properties.evidence.items.enum=[ref()];
  const h=harness(input=>{const value=evidenceWireFixture(input,output());value.patient[0].evidence[0]='source_patient_1_0';return value;});
  await assert.rejects(h.run(shape),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});assert.equal(h.validations,0);
  for(const call of h.calls.slice(1))assert.deepEqual(call.wire_evidence_selection_repair.allowed_source_ids,['source_patient_0_0']);
});
