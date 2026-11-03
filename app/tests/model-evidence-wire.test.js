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
const sourceTable=(input,group='patient',branch=0)=>{
  const shape=input.output_schema||input.schema,items=shape.properties[group].items;
  const path=`output_schema.properties.${group}.items`+(items.anyOf?`.anyOf[${branch}]`:'')+'.properties.evidence.items';
  const table=(input.evidence_sources||input.table).find(row=>row.schema_path===path);
  assert.ok(table,'Missing evidence table '+path);return table;
};
const sourceId=(input,group='patient',branch=0,index=0)=>sourceTable(input,group,branch).sources[index].id;
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
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE_'),false);assert.doesNotMatch(JSON.stringify(h.logs),/source_(?:\d|patient)/u);
});
for(const mutation of ['unknown','wrong_branch','wrong_group','legacy_branch_id','object','altered_object','wrong_certainty','extra_key'])test('wire rejects '+mutation+' before original caller validation',async()=>{
  const h=harness(input=>{
    const value=evidenceWireFixture(input,output()),row=value.patient[0];
    if(mutation==='unknown')row.evidence[0]='PRIVATE_unknown';
    if(mutation==='wrong_branch')row.evidence[0]=sourceId(input,'patient',1);
    if(mutation==='wrong_group')row.evidence[0]=sourceId(input,'supporter');
    if(mutation==='legacy_branch_id')row.evidence[0]='source_patient_0_0';
    if(mutation==='object')row.evidence[0]=ref();
    if(mutation==='altered_object')row.evidence[0]=ref('patient','PRIVATE_short');
    if(mutation==='wrong_certainty')row.certainty='tentative';
    if(mutation==='extra_key')row.extra='PRIVATE_extra';
    return value;
  });
  await assert.rejects(h.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});assert.equal(h.calls.length,3);assert.equal(h.validations,0);
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE_'),false);assert.doesNotMatch(JSON.stringify(h.logs),/source_(?:\d|patient)/u);
});
test('repair retains pristine wire candidate even when downstream validation mutates its decoded value',async()=>{
  const h=harness(input=>evidenceWireFixture(input,output()));let count=0;
  await h.run(schema(),stage,value=>{if(++count===1){value.patient[0].evidence[0].quote='PRIVATE_mutated';const error=new HttpError(502,'MODEL_INVALID_RESPONSE','synthetic');error.modelReason='agent_evidence';throw error;}return value;});
  assert.deepEqual(h.calls[1].rejected_output.patient[0].evidence,[sourceId(h.calls[0])]);assert.equal(JSON.stringify(h.calls[1].rejected_output).includes('PRIVATE_mutated'),false);
});
test('complete pools are transmitted without truncating or choosing candidates',()=>{
  const shape=schema(),pool=Array.from({length:300},(_,i)=>ref('patient','PRIVATE_'+i));shape.properties.patient.items.anyOf[0].properties.evidence.items.enum=pool;
  const transport=relationshipEvidenceTransport(stage,shape),table=transport.table[0];assert.equal(table.sources.length,300);assert.deepEqual(table.sources.map(row=>row.evidence),pool);
  const value=output();value.patient[0].evidence=[sourceId(transport,'patient',0,299)];assert.deepEqual(transport.decode(value).patient[0].evidence,[pool[299]]);
});
for(const keyword of ['oneOf','allOf','$ref','not'])test('unsupported '+keyword+' leaves legacy schema unchanged',()=>{
  const shape=schema(),snapshot=structuredClone(shape);shape.properties.patient.items[keyword]=keyword==='$ref'?'#/$defs/memory':[];
  const before=structuredClone(shape);assert.equal(relationshipEvidenceTransport(stage,shape),null);assert.deepEqual(shape,before);assert.notDeepEqual(shape,snapshot);
});
test('nodes without enum retain their original object representation and validations',()=>{
  const shape=schema();delete shape.properties.supporter.items.properties.evidence.items.enum;
  const transport=relationshipEvidenceTransport(stage,shape);assert.deepEqual(transport.schema.properties.supporter,shape.properties.supporter);
  const value=output();value.patient[0].evidence=[sourceId(transport)];value.supporter=[{certainty:'reported',evidence:[ref('supporter')]}];
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
  assert.throws(()=>validateSchema({ ...evidenceWireFixture(h.calls[1],output()),relationship:[{certainty:'tentative',interpretation:'claim',evidence:[sourceId(h.calls[1],'relationship')]}]},repaired),{code:'MODEL_INVALID_RESPONSE'});
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
  assert.equal(JSON.stringify(h.logs).includes('PRIVATE_'),false);assert.doesNotMatch(JSON.stringify(h.logs),/source_(?:\d|patient)/u);
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
test('identical sources share one ID across certainty branches and decode within each original pool',async()=>{
  const shape=schema();shape.properties.patient.items.anyOf[1].properties.evidence.items.enum=[ref()];
  const good=output();good.patient.push({certainty:'tentative',interpretation:'가능한 해석: 합성 해석',evidence:[ref()]});
  const h=harness(input=>{
    assert.equal(sourceId(input,'patient',0),sourceId(input,'patient',1));
    assert.deepEqual(sourceTable(input,'patient',0).sources.map(row=>row.evidence),[ref()]);
    assert.deepEqual(sourceTable(input,'patient',1).sources.map(row=>row.evidence),[ref()]);
    return evidenceWireFixture(input,good);
  });
  assert.deepEqual(await h.run(shape),good);assert.equal(h.calls.length,1);assert.equal(h.validations,1);
});

test('source identity ignores object key order without mutating input schemas, sources or wire responses',()=>{
  const shape=schema(),original=ref(),reordered={quote:original.quote,question_id:original.question_id,subject:original.subject};
  shape.properties.patient.items.anyOf[1].properties.evidence.items.enum=[reordered];
  shape.properties.relationship.items.properties.evidence.items.enum=[reordered];
  const before=structuredClone(shape),sourceBefore=structuredClone(reordered);
  const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
  const transport=relationshipEvidenceTransport(stage,freeze(shape)),shared=sourceId(transport);
  assert.equal(sourceId(transport,'patient',1),shared);assert.equal(sourceId(transport,'relationship'),shared);
  const wire={patient:[{certainty:'reported',evidence:[shared]},
    {certainty:'tentative',interpretation:'가능한 해석: 합성 해석',evidence:[shared]}],supporter:[],
    relationship:[{certainty:'tentative',interpretation:'가능한 해석: 합성 관계 해석',evidence:[shared]}],unknowns:[]};
  const wireBefore=structuredClone(wire),tableBefore=structuredClone(transport.table),decoded=transport.decode(freeze(wire));
  for(const row of [...decoded.patient,...decoded.relationship])assert.deepEqual(row.evidence,[original]);
  decoded.patient[0].evidence[0].quote='PRIVATE_mutated';
  assert.deepEqual(decoded.patient[1].evidence,[original]);assert.deepEqual(decoded.relationship[0].evidence,[original]);
  assert.deepEqual(shape,before);assert.deepEqual(reordered,sourceBefore);assert.deepEqual(wire,wireBefore);assert.deepEqual(transport.table,tableBefore);
  assert.deepEqual(transport.decode(wire).patient[0].evidence,[original]);
});

test('canonical IDs follow first encounter and distinguish subject, question and exact quote',()=>{
  const shape=schema(),first=ref(),otherQuestion={...first,question_id:'daily'},otherQuote={...first,quote:first.quote+' '},otherSubject=ref('supporter');
  shape.properties.patient.items.anyOf[0].properties.evidence.items.enum=[first,otherQuestion,{...first},otherQuote];
  shape.properties.patient.items.anyOf[1].properties.evidence.items.enum=[otherQuestion,first];
  shape.properties.supporter.items.properties.evidence.items.enum=[otherSubject];
  shape.properties.relationship.items.properties.evidence.items.enum=[otherSubject,otherQuote,first];
  const before=structuredClone(shape),transport=relationshipEvidenceTransport(stage,shape);
  assert.deepEqual(sourceTable(transport,'patient',0).sources.map(row=>row.id),['source_0','source_1','source_2']);
  assert.deepEqual(sourceTable(transport,'patient',1).sources.map(row=>row.id),['source_1','source_0']);
  assert.deepEqual(sourceTable(transport,'supporter').sources.map(row=>row.id),['source_3']);
  assert.deepEqual(sourceTable(transport,'relationship').sources.map(row=>row.id),['source_3','source_2','source_0']);
  const unique=new Map(transport.table.flatMap(row=>row.sources.map(source=>[source.id,source.evidence])));
  assert.deepEqual([...unique.values()],[first,otherQuestion,otherQuote,otherSubject]);
  assert.deepEqual(relationshipEvidenceTransport(stage+'_after_review',shape).table,transport.table);assert.deepEqual(shape,before);
});

for(const certainty of ['reported','tentative'])test('partly overlapping pools reject another branch-only source and retain the exact repair pool: '+certainty,async()=>{
  const shape=schema(),shared=ref(),reportedOnly=ref('patient','PRIVATE_reported only'),tentativeOnly=ref('patient','PRIVATE_tentative only');
  shape.properties.patient.items.anyOf[0].properties.evidence.items.enum=[shared,reportedOnly];
  shape.properties.patient.items.anyOf[1].properties.evidence.items.enum=[shared,tentativeOnly];
  const branch=certainty==='reported'?0:1,opposite=1-branch;
  const h=harness(input=>{
    assert.equal(sourceId(input,'patient',0),sourceId(input,'patient',1));
    return {patient:[{certainty,evidence:[sourceId(input,'patient',opposite,1)],
      ...(certainty==='tentative'?{interpretation:'가능한 해석: 합성 해석'}:{})}],supporter:[],relationship:[],unknowns:[]};
  });
  await assert.rejects(h.run(shape),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});assert.equal(h.calls.length,3);assert.equal(h.validations,0);
  for(const call of h.calls){
    assert.deepEqual(sourceTable(call,'patient',0).sources.map(row=>row.evidence),[shared,reportedOnly]);
    assert.deepEqual(sourceTable(call,'patient',1).sources.map(row=>row.evidence),[shared,tentativeOnly]);
  }
  for(const call of h.calls.slice(1)){
    assert.deepEqual(call.wire_evidence_selection_repair.allowed_source_ids,sourceTable(call,'patient',branch).sources.map(row=>row.id));
    assert.ok(!call.wire_evidence_selection_repair.allowed_source_ids.includes(sourceId(call,'patient',opposite,1)));
    assert.deepEqual(call.rejected_output.patient[0].evidence,[sourceId(call,'patient',opposite,1)]);
  }
});

test('cross-group source sharing preserves each group pool instead of merging all canonical IDs',()=>{
  const shape=schema(),shared=ref(),patientOnly=ref('patient','PRIVATE_patient only'),supporterOnly=ref('supporter');
  shape.properties.patient.items.anyOf[0].properties.evidence.items.enum=[shared,patientOnly];
  shape.properties.relationship.items.properties.evidence.items.enum=[shared,supporterOnly];
  const transport=relationshipEvidenceTransport(stage,shape),patientId=sourceId(transport),supporterId=sourceId(transport,'supporter');
  assert.equal(sourceId(transport,'relationship'),patientId);assert.equal(sourceId(transport,'relationship',0,1),supporterId);
  const valid={patient:[{certainty:'reported',evidence:[patientId]}],supporter:[{certainty:'reported',evidence:[supporterId]}],
    relationship:[{certainty:'tentative',interpretation:'가능한 해석: 합성 관계 해석',evidence:[patientId,supporterId]}],unknowns:[]};
  const decoded=transport.decode(valid);
  assert.deepEqual(decoded.patient[0].evidence,[shared]);assert.deepEqual(decoded.supporter[0].evidence,[supporterOnly]);
  assert.deepEqual(decoded.relationship[0].evidence,[shared,supporterOnly]);
  for(const [group,id]of [['patient',supporterId],['supporter',patientId],['relationship',sourceId(transport,'patient',0,1)]]){
    const bad=structuredClone(valid);bad[group][0].evidence=[id];
    assert.throws(()=>transport.decode(bad),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  }
});

for(const mutation of ['certainty','reported_interpretation','missing_interpretation'])test('shared IDs cannot bypass certainty branch constraints: '+mutation,async()=>{
  const shape=schema();shape.properties.patient.items.anyOf[1].properties.evidence.items.enum=[ref()];
  const h=harness(input=>{
    const value=evidenceWireFixture(input,output()),row=value.patient[0];
    if(mutation==='certainty')row.certainty='PRIVATE_invalid';
    if(mutation==='reported_interpretation')row.interpretation='PRIVATE_extra interpretation';
    if(mutation==='missing_interpretation')row.certainty='tentative';
    return value;
  });
  await assert.rejects(h.run(shape),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(h.calls.length,3);assert.equal(h.validations,0);
});

function literalRetryFixture() {
  const shape=schema(),shared=ref(),reportedOnly=ref('patient','PRIVATE_reported only'),removed=ref('patient','PRIVATE_removed tentative only');
  shape.properties.patient.items.anyOf[0].properties.evidence.items.enum=[shared,reportedOnly];
  shape.properties.patient.items.anyOf[1].properties.evidence.items.enum=[shared,removed];
  const initial=output();initial.patient.push({certainty:'tentative',interpretation:'PRIVATE_unsupported interpretation',evidence:[removed]});
  initial.supporter=[{certainty:'reported',evidence:[ref('supporter')]}];
  const corrected=structuredClone(initial);corrected.patient.pop();
  return {shape,initial,corrected};
}
const rejectUnreportedLabel=()=>{const error=new HttpError(502,'MODEL_INVALID_RESPONSE','synthetic');error.modelReason='agent_unreported_label';throw error;};

test('literal retry preserves retained source IDs and never reassigns a removed branch ID',async()=>{
  const {shape,initial,corrected}=literalRetryFixture(),before=structuredClone({shape,initial,corrected});
  const h=harness((input,count)=>evidenceWireFixture(input,count===1?initial:corrected));let checked=0;
  assert.deepEqual(await h.run(shape,stage,value=>{if(++checked===1)rejectUnreportedLabel();return value;}),corrected);
  assert.equal(h.calls.length,2);assert.equal(h.validations,2);
  const first=h.calls[0],retry=h.calls[1],sourceKey=value=>JSON.stringify([value.subject,value.question_id,value.quote]);
  const originalIds=new Map(first.evidence_sources.flatMap(table=>table.sources.map(({id,evidence})=>[sourceKey(evidence),id])));
  for(const table of retry.evidence_sources)for(const {id,evidence}of table.sources)assert.equal(id,originalIds.get(sourceKey(evidence)));
  const removedId=sourceId(first,'patient',1,1);
  assert.ok(retry.evidence_sources.every(table=>table.sources.every(source=>source.id!==removedId)));
  assert.equal(sourceId(retry,'supporter'),sourceId(first,'supporter'));
  assert.deepEqual(sourceTable(retry,'patient').sources.map(row=>row.evidence),shape.properties.patient.items.anyOf[0].properties.evidence.items.enum);
  assert.deepEqual(retry.rejected_output,evidenceWireFixture(first,initial));
  assert.deepEqual({shape,initial,corrected},before);
});

test('literal retry rejects a copied removed ID before accepting a newly generated eligible ID',async()=>{
  const {shape,initial,corrected}=literalRetryFixture(),before=structuredClone(shape);let removedId;
  const h=harness((input,count)=>{
    const value=evidenceWireFixture(input,count===1?initial:corrected);
    if(count===1)removedId=value.patient[1].evidence[0];
    if(count===2){assert.equal(input.rejected_output.patient[1].evidence[0],removedId);value.supporter[0].evidence=[removedId];}
    return value;
  });
  const validated=[];
  assert.deepEqual(await h.run(shape,stage,value=>{validated.push(structuredClone(value));if(validated.length===1)rejectUnreportedLabel();return value;}),corrected);
  assert.equal(h.calls.length,3);assert.equal(h.validations,2);assert.deepEqual(validated,[initial,corrected]);
  const retry=h.calls[2];assert.deepEqual(retry.rejected_output.supporter[0].evidence,[removedId]);
  assert.deepEqual(retry.wire_evidence_selection_repair.allowed_source_ids,sourceTable(retry,'supporter').sources.map(row=>row.id));
  assert.ok(!retry.wire_evidence_selection_repair.allowed_source_ids.includes(removedId));
  assert.equal(sourceId(retry,'supporter'),sourceId(h.calls[0],'supporter'));assert.deepEqual(shape,before);
});

test('literal retry exhausts invalid copied IDs without sending them to the original caller validator',async()=>{
  const {shape,initial,corrected}=literalRetryFixture(),before=structuredClone(shape);let removedId;
  const h=harness((input,count)=>{
    const value=evidenceWireFixture(input,count===1?initial:corrected);
    if(count===1)removedId=value.patient[1].evidence[0];
    else value.supporter[0].evidence=[removedId];
    return value;
  });
  await assert.rejects(h.run(shape,stage,rejectUnreportedLabel),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(h.calls.length,3);assert.equal(h.validations,1);
  for(const retry of h.calls.slice(1))assert.ok(retry.evidence_sources.every(table=>table.sources.every(source=>source.id!==removedId)));
  assert.deepEqual(shape,before);
});
