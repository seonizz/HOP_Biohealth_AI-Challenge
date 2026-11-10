import test from 'node:test';
import assert from 'node:assert/strict';
import {finalEvidenceTransport} from '../src/final-evidence-transport.js';
import {createFinalEvidenceReferenceCodec,createFinalStageEvidenceReferenceCodec} from '../src/final-evidence-references.js';
import {groundedEvidenceSchema,planSchema,relationshipSelectionSchema,validateSchema} from '../src/relationship-agent.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text=maxLength=>({type:'string',minLength:1,maxLength});
const reference=(subject,question_id,quote)=>({subject,question_id,quote});
const evidence=object({subject:{type:'string',enum:['patient','supporter','user_goal']},question_id:text(80),quote:text(1000)});
const field=ref=>({id:ref.question_id,question:ref.question_id,status:'answered',rawText:ref.quote,text:ref.quote,custom:''});
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;};
function fixture(kind) {
  const patient=reference('patient','describe','지난주라고 정정했어요. 지금은 그 일이 없다고 말했어요.');
  const supporter=reference('supporter','burden','밤에는 쉬고 싶고, 미리 약속하면 20분 이야기할 수 있어요.');
  const goal=reference('user_goal','want','대화가 괜찮은지 먼저 묻고 싶어요.');
  const context={patient:{fields:{describe:field(patient)}},supporter:{fields:{burden:field(supporter)}},user_goal:{message:field(goal)}};
  let schema,value;
  if(kind==='plan') {
    schema=groundedEvidenceSchema(planSchema,context);
    value={voice:'일상적인 말투',opening_evidence:[patient,supporter],user_intent:'대화가 괜찮은지 물어보고 싶어요.',
      patient_choice:'편하지 않으면 다음에 해도 괜찮아요.',supporter_care:['밤에는 쉬어요.'],avoid_patterns:['재촉하지 않아요.'],next_step:'편한 시간을 물어봐요.'};
  } else {
    const section=()=>object({why:text(1000),evidence:{type:'array',items:structuredClone(evidence),minItems:1,maxItems:3}});
    schema=groundedEvidenceSchema(object({opening_end:{type:'integer',enum:[1]},listening_end:{type:'integer',enum:[2]},
      opening:section(),listening:section(),offer:section()}),context);
    schema.properties.opening.properties.evidence.items.enum=[patient,supporter];
    schema.properties.listening.properties.evidence.items.enum=[supporter];
    schema.properties.offer.properties.evidence.items.enum=[goal];
    value={opening_end:1,listening_end:2,opening:{why:'정정된 상황을 구분해요.',evidence:[patient]},
      listening:{why:'가능한 시간의 경계를 존중해요.',evidence:[supporter]},offer:{why:'대화 의사를 먼저 물어요.',evidence:[goal]}};
  }
  return {schema,value,context,patient,supporter,goal};
}
const make=(kind,schema,registry)=>finalEvidenceTransport(kind==='plan'?'communication_plan':'speech_detail',schema,{extended:true,registry});
const wire=(transport,value)=>evidenceWireFixture({evidence_sources:transport.table,output_schema:transport.schema},value);

test('joint analysis/plan shares exact IDs but cannot import another child position scope',()=>{
  const f=fixture('plan'),analysis=groundedEvidenceSchema(relationshipSelectionSchema,f.context);
  f.schema.properties.opening_evidence.items.enum=[f.patient];f.value.opening_evidence=[f.patient];
  const schema=object({analysis,plan:f.schema}),value={analysis:{observations:{patient:[f.patient],supporter:[f.supporter]},
    relationship:{label:'확인되지 않음',supporter_role:'확인되지 않음',dynamics:[],strengths:[],boundaries:[]},unknowns:[],safety:{urgent:false,evidence_ids:[]}},plan:f.value};
  assert.equal(finalEvidenceTransport('final_analysis_plan_draft',schema),null);
  const transport=finalEvidenceTransport('final_analysis_plan_draft',schema,{extended:true,registry:new Map()}),encoded=wire(transport,value);
  assert.deepEqual(transport.decode(encoded),value);
  assert.equal(encoded.plan.opening_evidence[0],encoded.analysis.observations.patient[0]);
  encoded.plan.opening_evidence=[encoded.analysis.observations.supporter[0]];
  assert.throws(()=>transport.decode(encoded),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
});

test('joint evidence metadata mutations cannot widen private schemas or change restored sources',()=>{
  const f=fixture('plan'),analysis=groundedEvidenceSchema(relationshipSelectionSchema,f.context);
  const schema=object({analysis,plan:f.schema}),value={analysis:{observations:{patient:[f.patient],supporter:[f.supporter]},
    relationship:{label:'확인되지 않음',supporter_role:'확인되지 않음',dynamics:[],strengths:[],boundaries:[]},unknowns:[],safety:{urgent:false,evidence_ids:[]}},plan:f.value};
  const transport=finalEvidenceTransport('final_analysis_plan_draft',schema,{extended:true}),encoded=wire(transport,value),expected=structuredClone(value);
  transport.table.sources[0].evidence.quote='forged';transport.schema.properties.plan.properties.opening_evidence.items.enum.push('forged');
  schema.properties.plan.properties.opening_evidence.items.enum=[];
  assert.deepEqual(transport.decode(encoded),expected);
  encoded.extra='must fail';assert.throws(()=>transport.decode(encoded),{modelReason:'agent_schema'});
});

for(const [stage,kind]of [
  ['communication_plan','plan'],['communication_plan_repair','plan'],
  ['communication_plan_after_analysis_repair','plan'],['communication_plan_repair_after_analysis_repair','plan'],
  ['speech_detail','detail'],['speech_detail_repair','detail'],
])test('extended transport exact roundtrip leaves logical values unchanged: '+stage,()=>{
  const {schema,value}=fixture(kind),before=structuredClone({schema,value});freeze(schema);freeze(value);
  assert.equal(finalEvidenceTransport(stage,schema),null);
  const transport=finalEvidenceTransport(stage,schema,{extended:true}),codec=createFinalStageEvidenceReferenceCodec(schema,{kind});
  assert.ok(transport);
  const encoded=wire(transport,value);
  assert.deepEqual(encoded,codec.encode(value));assert.deepEqual(transport.decode(encoded),value);
  validateSchema(encoded,transport.schema);validateSchema(transport.decode(encoded),schema);
  assert.deepEqual({schema,value},before);
  const reconstructed=structuredClone(transport.schema);
  if(kind==='plan')reconstructed.properties.opening_evidence.items=structuredClone(schema.properties.opening_evidence.items);
  else for(const key of ['opening','listening','offer'])reconstructed.properties[key].properties.evidence.items=structuredClone(schema.properties[key].properties.evidence.items);
  assert.deepEqual(reconstructed,schema);
});

test('extended transport scopes every position and preserves the existing evidence fixture table format',()=>{
  const {schema,value}=fixture('detail'),transport=make('detail',schema),encoded=wire(transport,value);
  assert.deepEqual(transport.table.locations.map(row=>row.schema_path),['opening','listening','offer']
    .map(key=>`output_schema.properties.${key}.properties.evidence.items`));
  assert.equal(transport.table.sources.length,3);
  const locations=transport.table.locations;
  assert.equal(locations[0].allowed_source_ids.length,2);assert.equal(locations[1].allowed_source_ids.length,1);
  assert.equal(locations[2].allowed_source_ids.length,1);
  encoded.offer.evidence=[encoded.opening.evidence[0]];
  assert.throws(()=>transport.decode(encoded),{modelReason:'agent_schema'});
});

for(const kind of ['plan','detail'])for(const bad of ['unknown','legacy','extra','non_array','overflow','missing','unrelated'])
  test(`extended ${kind} rejects ${bad} without modifying the rejected output`,()=>{
    const {schema,value}=fixture(kind),transport=make(kind,schema),encoded=wire(transport,value);
    const holder=kind==='plan'?encoded:encoded.opening,key=kind==='plan'?'opening_evidence':'evidence';
    if(bad==='unknown')holder[key]=['not_a_source'];
    if(bad==='legacy')holder[key]=[fixture(kind).patient];
    if(bad==='extra')encoded.injected='must be rejected';
    if(bad==='non_array')holder[key]='e0';
    if(bad==='overflow')holder[key]=Array(10).fill(holder[key][0]);
    if(bad==='missing')delete holder[key];
    if(bad==='unrelated') { if(kind==='plan')encoded.voice=123;else encoded.listening_end=99; }
    const before=structuredClone(encoded);
    assert.throws(()=>transport.decode(encoded),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
    assert.deepEqual(encoded,before);
  });

test('new transport schemas and tables cannot weaken its private validators or source pools',()=>{
  const {schema,value}=fixture('detail'),transport=make('detail',schema),encoded=wire(transport,value),before=structuredClone(value);
  transport.table.sources[0].evidence.quote='forged';transport.table.locations[0].allowed_source_ids.push('forged');
  transport.schema.properties.opening.properties.evidence.items.enum.push('forged');
  schema.properties.opening.properties.evidence.items.enum=[];
  const first=transport.decode(encoded);first.opening.evidence[0].quote='mutated';
  assert.deepEqual(transport.decode(encoded),before);
  encoded.opening.evidence=['forged'];assert.throws(()=>transport.decode(encoded),{modelReason:'agent_schema'});
});

for(const kind of ['plan','detail'])test(`operation registry never reassigns removed ${kind} citations during a repair`,()=>{
  const {schema,value,patient}=fixture(kind),registry=new Map(),transport=make(kind,schema,registry),encoded=wire(transport,value);
  const leaf=kind==='plan'?schema.properties.opening_evidence.items:schema.properties.opening.properties.evidence.items;
  const newRef={...patient,quote:'새로 정정된 별개의 원문이며 이전 인용과 같지 않아요.'};
  const oldId=kind==='plan'?encoded.opening_evidence[0]:encoded.opening.evidence[0];
  leaf.enum=[newRef];
  const repaired=make(kind,schema,registry),newRow=repaired.table.sources.find(row=>row.evidence.quote===newRef.quote);
  assert.notEqual(newRow.id,oldId);
  const invalid=structuredClone(encoded);
  if(kind==='plan')invalid.opening_evidence=[oldId];else invalid.opening.evidence=[oldId];
  assert.throws(()=>repaired.decode(invalid),{modelReason:'agent_schema'});
  assert.deepEqual(transport.decode(encoded),value);
  leaf.enum=[patient];
  const restored=make(kind,schema,registry);
  assert.equal(restored.table.sources.find(row=>row.evidence.quote===patient.quote).id,oldId);
});

test('analysis defaults remain identical while an explicit operation registry shares exact sources across stages',()=>{
  const {schema:plan,value,context,patient}=fixture('plan'),registry=new Map();
  const selection=groundedEvidenceSchema(relationshipSelectionSchema,context);
  const legacy=finalEvidenceTransport('relationship_analysis',selection),explicit=finalEvidenceTransport('relationship_analysis',selection,{registry});
  assert.deepEqual(explicit.schema,legacy.schema);assert.deepEqual(explicit.table,legacy.table);
  const planTransport=make('plan',plan,registry),encoded=wire(planTransport,value);
  const source=legacy.table.sources.find(row=>row.evidence.subject===patient.subject&&row.evidence.question_id===patient.question_id&&row.evidence.quote===patient.quote);
  assert.equal(encoded.opening_evidence[0],source.id);
  const codec=createFinalEvidenceReferenceCodec(selection);
  assert.deepEqual(codec.schema,legacy.schema);
});

for(const kind of ['plan','detail'])for(const bad of ['empty','absent','unknown_keyword','unsupported_shape','malformed_reference'])
  test(`${kind} unsupported ${bad} falls back without changing the schema or registry`,()=>{
    const {schema}=fixture(kind),registry=new Map();
    const leaf=kind==='plan'?schema.properties.opening_evidence.items:schema.properties.offer.properties.evidence.items;
    if(bad==='empty')leaf.enum=[];
    if(bad==='absent')delete leaf.enum;
    if(bad==='unknown_keyword')schema.allOf=[];
    if(bad==='unsupported_shape')schema.required=schema.required.slice(1);
    if(bad==='malformed_reference')leaf.enum=[{subject:'patient',question_id:'describe',quote:'text',extra:'must not disappear'}];
    const before=structuredClone(schema);
    assert.equal(make(kind,schema,registry),null);assert.equal(registry.size,0);assert.deepEqual(schema,before);
  });

test('registry identity collisions and malformed registry values use legacy transport',()=>{
  const {schema,patient,supporter}=fixture('plan');
  const key=ref=>JSON.stringify([ref.subject,ref.question_id,ref.quote]);
  for(const registry of [null,{},new Map([[key(patient),'e0'],[key(supporter),'e0']]),new Map([['invalid','e0']]),new Map([[key(patient),'__proto__']])])
    assert.equal(make('plan',schema,registry),null);
});

test('extended opt-in cannot adapt review stages, stored details or arbitrary similarly named stages',()=>{
  const {schema}=fixture('detail');
  for(const stage of ['speech_detail_review','speech_detail_review_after_repair','speech_detail_after_review','communication_plan_review','communication_plan_injected','turn_review'])
    assert.equal(finalEvidenceTransport(stage,schema,{extended:true}),null);
  const stored=structuredClone(schema);delete stored.properties.opening_end;delete stored.properties.listening_end;
  stored.required=['opening','listening','offer'];
  for(const key of ['opening','listening','offer']){stored.properties[key].properties.excerpt=text(8000);stored.properties[key].required.push('excerpt');}
  assert.equal(make('detail',stored),null);
});

test('long exact citations shrink only wire output and retain complete evidence and authored explanations',t=>{
  const {schema,value,patient}=fixture('detail');
  const full={...patient,quote:'이전 내용을 정정해요. 가 🌱\r\n'+'조건과 시점을 보존해요. '.repeat(45)+'지금은 해당하지 않는다고 했어요.'};
  assert.ok(full.quote.length<=1000);
  for(const key of ['opening','listening','offer']){
    schema.properties[key].properties.evidence.items.enum=[full];value[key].evidence=[full];
  }
  const transport=make('detail',schema),encoded=wire(transport,value),restored=transport.decode(encoded);
  assert.equal(transport.table.sources.length,1);assert.deepEqual(restored,value);
  assert.ok(Buffer.byteLength(JSON.stringify(encoded))<Buffer.byteLength(JSON.stringify(value))/2);
  for(const key of ['opening','listening','offer'])assert.equal(restored[key].evidence[0].quote,full.quote);
  const bytes=value=>Buffer.byteLength(JSON.stringify(value));
  t.diagnostic(JSON.stringify({synthetic:true,stage:'speech_detail',legacy_output_bytes:bytes(value),wire_output_bytes:bytes(encoded),
    legacy_schema_bytes:bytes(schema),wire_schema_table_instruction_bytes:bytes({schema:transport.schema,table:transport.table,instruction:transport.instruction}),
    source_count:transport.table.sources.length,post_count_change:0,tokens_measured:false,model_time_measured:false}));
});

test('private codec hydration and feedback reject wrong-position IDs without exposing source or ID text',()=>{
  const {schema,value}=fixture('detail'),codec=createFinalStageEvidenceReferenceCodec(schema,{kind:'detail'}),encoded=codec.encode(value);
  encoded.offer.evidence=['PRIVATE_FORGED_SOURCE'];
  assert.throws(()=>codec.hydrate(encoded),error=>{
    assert.equal(error.modelReason,'agent_evidence_reference');
    assert.equal(JSON.parse(error.modelFeedback).path,'output.offer.evidence[0]');
    assert.doesNotMatch(error.modelFeedback,/PRIVATE_FORGED_SOURCE|정정했어요/);
    return true;
  });
});
