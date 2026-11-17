import test from 'node:test';
import assert from 'node:assert/strict';
import {questionTurnEvidenceTransport} from '../src/combined-turn-evidence-transport.js';
import {relationshipQuestionRequest,validateSchema} from '../src/relationship-agent.js';
import {scopeContext,scopeDraft} from './helpers/turn-input-optimization-fixture.js';
const fixture=()=>{const context=scopeContext();return {schema:relationshipQuestionRequest(context).schema,value:scopeDraft(context).questions};};

test('question-only fixed slots keep question identity unique and restore source-grounded decisions',()=>{
 const {schema,value}=fixture(),original=structuredClone({schema,value}),transport=questionTurnEvidenceTransport('question_plan',schema);
 assert.ok(transport);const wire=transport.encode(value);assert.deepEqual(transport.decode(wire),value);
 assert.deepEqual({schema,value},original);assert.deepEqual(wire.clarify,value.clarify);assert.deepEqual(wire.safety,value.safety);
 assert.deepEqual(transport.schema.properties.clarify,schema.properties.clarify);assert.deepEqual(transport.schema.properties.safety,schema.properties.safety);
 assert.ok(transport.table.locations.every(row=>row.schema_path.startsWith('output_schema.properties.skip.')));
 const id=value.skip[0].question_id,row=wire.skip[id];
 assert.ok(row.evidence.every(id=>typeof id==='string'));
 assert.deepEqual(Object.keys(transport.schema.properties.skip.properties[id].anyOf[1].properties),['reason','evidence','explanation']);
 for(const key of ['reason','explanation'])assert.equal(row[key],value.skip[0][key]);
 assert.equal(row.reason,'already_covered');assert.equal(wire.skip.extra,undefined,'ineligible questions do not acquire slots');
 assert.ok(JSON.stringify(wire).length<JSON.stringify(value).length);
});
for(const kind of ['unknown-id','fabricated-quote','missing-reason','literal-reference','unknown-reason','missing-explanation','abbreviated-keys','extra-key'])test('question-only codec rejects '+kind,()=>{
 const {schema,value}=fixture(),transport=questionTurnEvidenceTransport('question_plan',schema),wire=transport.encode(value),id=value.skip[0].question_id,row=wire.skip[id];
 if(kind==='unknown-id')row.evidence=['eunknown'];
 if(kind==='missing-reason')delete row.reason;
 if(kind==='literal-reference')row.evidence=value.skip[0].evidence;
 if(kind==='unknown-reason')row.reason='approved';
 if(kind==='missing-explanation')delete row.explanation;
 if(kind==='abbreviated-keys')wire.skip[id]={q:id,r:'a',e:row.evidence,x:row.explanation};
 if(kind==='extra-key')row.approved=true;
 if(kind==='fabricated-quote'){value.skip[0].evidence[0].quote='원문에 없는 합성 문구';assert.throws(()=>transport.encode(value),{code:'MODEL_INVALID_RESPONSE'});return;}
 assert.throws(()=>transport.decode(wire),{code:'MODEL_INVALID_RESPONSE'});
});
test('question-only codec does not handle unrelated stages or silently assign IDs for unsupported schemas',()=>{
 const {schema}=fixture(),registry=new Map();assert.equal(questionTurnEvidenceTransport('turn_draft',schema,registry),null);
 const invalid=structuredClone(schema);invalid.unknownKeyword=true;
 assert.equal(questionTurnEvidenceTransport('question_plan',invalid,registry),null);assert.equal(registry.size,0);
});

test('descriptive question reasons preserve each branch source pool and round-trip not_needed',()=>{
 const {schema,value}=fixture(),branches=schema.properties.skip.items.anyOf;
 const different=structuredClone(branches[0].properties.evidence.items.anyOf[0]);
 different.properties.question_id.const='synthetic-other';different.properties.quote.enum=['별도 합성 원문'];
 different.enum=[{subject:different.properties.subject.const,question_id:'synthetic-other',quote:'별도 합성 원문'}];
 branches.push({...structuredClone(branches[0]),properties:{...structuredClone(branches[0].properties),reason:{type:'string',const:'not_needed'},
  evidence:{...structuredClone(branches[0].properties.evidence),items:different}}});
 const transport=questionTurnEvidenceTransport('question_plan',schema),wire=transport.encode(value);
 const other=transport.table.sources.find(row=>row.evidence.question_id==='synthetic-other').id;
 wire.skip[value.skip[0].question_id].evidence=[other];
 assert.throws(()=>transport.decode(wire),{code:'MODEL_INVALID_RESPONSE'});
 wire.skip[value.skip[0].question_id].reason='not_needed';
 const decoded=transport.decode(wire);assert.equal(decoded.skip[0].reason,'not_needed');
 assert.deepEqual(decoded.skip[0].evidence,different.enum);assert.deepEqual(transport.encode(decoded),wire);
});

test('citation compression never rewrites schema-defined reason values',()=>{
 const {schema,value}=fixture();schema.properties.skip.items.anyOf[0].properties.reason.const='future_reason';
 value.skip[0].reason='future_reason';const transport=questionTurnEvidenceTransport('question_plan',schema);
 const wire=transport.encode(value);assert.equal(wire.skip[value.skip[0].question_id].reason,'future_reason');assert.deepEqual(transport.decode(wire),value);
});

for(const evidenceIds of [false,true])test('fixed identity also applies without citation compression; enabled='+evidenceIds,()=>{
 const {schema,value}=fixture(),transport=questionTurnEvidenceTransport('question_plan',schema,new Map(),{evidenceIds});
 assert.equal(transport.schema.properties.skip.type,'object');assert.deepEqual(transport.decode(transport.encode(value)),value);
 const empty={...value,skip:[]};assert.deepEqual(transport.decode(transport.encode(empty)),empty);
 const urgent={...empty,clarify:[],safety:{urgent:true,evidence_ids:[]}};
 assert.deepEqual(transport.decode(transport.encode(urgent)),urgent);
});

test('no eligible question uses an empty closed object even with no evidence table',()=>{
 const {schema,value}=fixture();schema.properties.skip={type:'array',items:{type:'object',properties:{},required:[],additionalProperties:false},minItems:0,maxItems:0};
 value.skip=[];const transport=questionTurnEvidenceTransport('question_plan',schema);
 assert.deepEqual(transport.encode(value).skip,{});assert.deepEqual(transport.decode(transport.encode(value)),value);
 assert.deepEqual(transport.table.locations,[]);assert.deepEqual(transport.schema.properties.skip.required,[]);
});

for(const kind of ['missing-slot','extra-slot','nested-id','array','duplicate-logical'])test('fixed-slot codec refuses '+kind,()=>{
 const {schema,value}=fixture(),transport=questionTurnEvidenceTransport('question_plan',schema),wire=transport.encode(value);
 if(kind==='missing-slot')delete wire.skip.daily;
 if(kind==='extra-slot')wire.skip.unknown=null;
 if(kind==='nested-id')wire.skip.daily.question_id='extra';
 if(kind==='array')wire.skip=value.skip;
 if(kind==='duplicate-logical'){
  value.skip.push({...structuredClone(value.skip[0]),explanation:'A different explanation must not make the same ID unique.'});
  assert.throws(()=>transport.encode(value),{code:'MODEL_INVALID_RESPONSE'});return;
 }
 assert.throws(()=>transport.decode(wire),{code:'MODEL_INVALID_RESPONSE'});
});

test('every citation schema path resolves to the exact branch-specific allowed IDs',()=>{
 const {schema,value}=fixture(),transport=questionTurnEvidenceTransport('question_plan',schema);
 for(const location of transport.table.locations){
  const parts=location.schema_path.replace(/^output_schema\./,'').replace(/\[(\d+)\]/g,'.$1').split('.');
  const node=parts.reduce((current,key)=>current[key],transport.schema);
  assert.deepEqual(node.enum,location.allowed_source_ids);assert.ok(location.schema_path.includes('.skip.properties.'));
 }
 const encoded=transport.encode(value);transport.schema.properties.skip.properties.daily={type:'null'};
 transport.table.sources[0].evidence.quote='mutated metadata';assert.deepEqual(transport.decode(encoded),value);
});

for(const mutation of ['too-many-slots','minimum-count','unsafe-id','branch-constraint'])test('unsupported slot contract fails without consuming source IDs: '+mutation,()=>{
 const {schema}=fixture(),registry=new Map(),skip=schema.properties.skip;
 if(mutation==='too-many-slots'){skip.items.anyOf[0].properties.question_id.enum.push('extra');skip.maxItems=1;}
 if(mutation==='minimum-count')skip.minItems=1;
 if(mutation==='unsafe-id')skip.items.anyOf[0].properties.question_id.enum=['__proto__'];
 if(mutation==='branch-constraint')skip.items.anyOf[0].const={};
 assert.equal(questionTurnEvidenceTransport('question_plan',schema,registry),null);assert.equal(registry.size,0);
});

test('multiple selected slots preserve each decision and normalize only array order',()=>{
 const {schema,value}=fixture();schema.properties.skip.items.anyOf[0].properties.question_id.enum.push('extra');
 const other={...structuredClone(value.skip[0]),question_id:'extra',explanation:'별도 문항의 합성 설명'};
 value.skip=[other,value.skip[0]];const transport=questionTurnEvidenceTransport('question_plan',schema),wire=transport.encode(value);
 const restored=transport.decode(wire);assert.deepEqual(restored.skip,[value.skip[1],other]);
 validateSchema(restored,schema);assert.deepEqual(transport.encode(restored),wire);
});
