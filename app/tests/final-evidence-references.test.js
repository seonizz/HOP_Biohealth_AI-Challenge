import test from 'node:test';
import assert from 'node:assert/strict';
import { createFinalEvidenceReferenceCodec } from '../src/final-evidence-references.js';
import { groundedEvidenceSchema, relationshipSelectionSchema, validateSchema } from '../src/relationship-agent.js';

const ref=(subject,question_id,quote)=>({subject,question_id,quote});
const field=reference=>({id:reference.question_id,question:reference.question_id,status:'answered',
  text:reference.quote,rawText:reference.quote,custom:''});
const targets=[['observations','patient'],['observations','supporter'],
  ['relationship','dynamics'],['relationship','strengths'],['relationship','boundaries']];
const citations=(schema,group,key)=>group==='observations'?schema.properties.observations.properties[key]
  :schema.properties.relationship.properties[key].items.properties.evidence;
const freeze=value=>{
  if(value&&typeof value==='object') { Object.freeze(value);for(const child of Object.values(value))freeze(child); }
  return value;
};
const rejects=fn=>assert.throws(fn,error=>error.code==='MODEL_INVALID_RESPONSE'&&error.modelReason==='agent_evidence_reference');

function fixture() {
  const p1=ref('patient','describe','전에 연락이 늦었지만 지금은 휴대전화가 고장 났었다고 정정했어요.');
  const p2=ref('patient','support','토요일에 이웃과 산책하면 잠깐 편하지만 다음날도 그런지는 모르겠어요.');
  const s1=ref('supporter','cgchange','밤 열 시 이후에는 쉬고 싶어요.\r\n미리 약속하면 토요일에는 20분 들을 수 있어요. 🌱');
  const goal=ref('user_goal','want','대화가 괜찮은지 먼저 묻고 싶어요.');
  const context={patient:{fields:{describe:field(p1),support:field(p2)}},supporter:{fields:{cgchange:field(s1)}},
    user_goal:{message:field(goal)}};
  const schema=groundedEvidenceSchema(relationshipSelectionSchema,context);
  for(const [group,key,references]of [
    ['observations','patient',[p1]],['observations','supporter',[s1]],
    ['relationship','dynamics',[p1,goal]],['relationship','strengths',[p2]],['relationship','boundaries',[s1]],
  ])citations(schema,group,key).items.enum=structuredClone(references);
  const finding=(interpretation,evidence,certainty='tentative')=>({interpretation,evidence,certainty});
  const selection={observations:{patient:[p1],supporter:[s1]},relationship:{label:'친구',supporter_role:'친구',
    dynamics:[finding('가능한 해석: 대화 의사를 먼저 확인하고 싶은 상황일 수 있어요.',[p1,goal])],
    strengths:[finding('토요일에 산책하면 잠깐 편하다고 보고했어요.',[p2],'reported')],
    boundaries:[finding('가능한 해석: 약속 시간과 휴식의 경계가 필요할 수 있어요.',[s1])]},
    unknowns:['다음날에도 도움이 유지되는지는 확인되지 않았어요.'],
    safety:{urgent:false,evidence_ids:[schema.properties.safety.properties.evidence_ids.items.enum[0]]}};
  return {schema,selection,p1,p2,s1,goal};
}

test('both inversions preserve all exact citations and every non-citation field without mutation',()=>{
  const {schema,selection}=fixture(),before=structuredClone({schema,selection});
  freeze(schema);freeze(selection);
  const codec=createFinalEvidenceReferenceCodec(schema),encoded=codec.encode(selection),restored=codec.hydrate(encoded);
  assert.deepEqual(restored,selection);assert.deepEqual(codec.encode(restored),encoded);
  assert.deepEqual({schema,selection},before);
  assert.deepEqual(encoded.safety,selection.safety);assert.deepEqual(encoded.unknowns,selection.unknowns);
  for(const key of ['label','supporter_role'])assert.equal(encoded.relationship[key],selection.relationship[key]);
  for(const key of ['dynamics','strengths','boundaries'])for(const field of ['interpretation','certainty'])
    assert.equal(encoded.relationship[key][0][field],selection.relationship[key][0][field]);
  validateSchema(selection,schema);validateSchema(encoded,codec.schema);validateSchema(restored,schema);
});

test('only the five citation-item schemas change, retaining array limits and safety selection exactly',()=>{
  const {schema}=fixture(),codec=createFinalEvidenceReferenceCodec(schema),restored=structuredClone(codec.schema);
  for(const [group,key]of targets) {
    assert.equal(citations(codec.schema,group,key).items.type,'string');
    citations(restored,group,key).items=structuredClone(citations(schema,group,key).items);
  }
  assert.deepEqual(restored,schema);
});

test('IDs are deterministic exact triples, shared only across paths that allow the same candidate',()=>{
  const {schema,selection}=fixture(),codec=createFinalEvidenceReferenceCodec(schema),encoded=codec.encode(selection);
  assert.deepEqual(codec.references,createFinalEvidenceReferenceCodec(schema).references);
  assert.deepEqual(Object.keys(codec.references),['e0','e1','e2','e3']);
  assert.equal(encoded.observations.patient[0],encoded.relationship.dynamics[0].evidence[0]);
  assert.equal(encoded.observations.supporter[0],encoded.relationship.boundaries[0].evidence[0]);
  const reordered=structuredClone(selection),reference=reordered.observations.patient[0];
  reordered.observations.patient[0]={quote:reference.quote,question_id:reference.question_id,subject:reference.subject};
  assert.deepEqual(codec.encode(reordered),encoded);
});

for(const [name,edit]of [
  ['another actor',value=>{value.observations.patient=value.observations.supporter;}],
  ['another question at the same actor path',value=>{value.observations.patient=value.relationship.strengths[0].evidence;}],
  ['a relationship-only goal',value=>{value.observations.patient=[value.relationship.dynamics[0].evidence[1]];}],
  ['another relationship path',value=>{value.relationship.strengths[0].evidence=value.relationship.boundaries[0].evidence;}],
  ['unknown ID',value=>{value.observations.patient=['ezz'];}],
  ['prototype ID',value=>{value.observations.patient=['__proto__'];}],
  ['constructor ID',value=>{value.observations.patient=['constructor'];}],
  ['non-string ID',value=>{value.observations.patient=[0];}],
  ['missing ID',value=>{value.observations.patient=[null];}],
  ['sparse ID',value=>{value.observations.patient=Array(1);}],
  ['legacy full object',value=>{value.observations.patient=[fixture().p1];}],
  ['partial object',value=>{value.observations.patient=[{quote:'a'}];}],
  ['missing group',value=>{delete value.observations;}],
  ['non-object group',value=>{value.relationship=[];}],
  ['missing observation path',value=>{delete value.observations.patient;}],
  ['non-array observations',value=>{value.observations.patient={};}],
  ['non-array findings',value=>{value.relationship.dynamics={};}],
  ['sparse finding',value=>{value.relationship.dynamics=Array(1);}],
  ['missing evidence',value=>{delete value.relationship.dynamics[0].evidence;}],
  ['non-array evidence',value=>{value.relationship.dynamics[0].evidence={};}],
])test('hydration rejects '+name+' without changing the rejected response',()=>{
  const {schema,selection}=fixture(),codec=createFinalEvidenceReferenceCodec(schema),encoded=codec.encode(selection);
  edit(encoded);const before=structuredClone(encoded);rejects(()=>codec.hydrate(encoded));assert.deepEqual(encoded,before);
});

for(const [name,edit]of [
  ['partial quote',reference=>{reference.quote=reference.quote.slice(0,-12);}],
  ['normalized whitespace',reference=>{reference.quote=reference.quote.replace(' ','  ');}],
  ['wrong actor',reference=>{reference.subject='supporter';}],
  ['wrong question',reference=>{reference.question_id='support';}],
  ['missing field',reference=>{delete reference.subject;}],
  ['extra field',reference=>{reference.extra='private';}],
  ['hidden field',reference=>{Object.defineProperty(reference,'private',{value:true});}],
  ['symbol field',reference=>{reference[Symbol('private')]=true;}],
  ['non-plain prototype',reference=>{Object.setPrototypeOf(reference,{private:true});}],
  ['accessor field',reference=>{Object.defineProperty(reference,'quote',{get(){throw new Error('must not execute getter');}});}],
])test('encoding rejects '+name+' without fuzzy matching or quote repair',()=>{
  const {schema,selection}=fixture(),codec=createFinalEvidenceReferenceCodec(schema);
  edit(selection.observations.patient[0]);rejects(()=>codec.encode(selection));
});

test('public schema, table, input schema and earlier hydration cannot poison the private mappings',()=>{
  const {schema,selection}=fixture(),codec=createFinalEvidenceReferenceCodec(schema),encoded=codec.encode(selection);
  codec.references.e0.quote='forged';codec.references.constructor=fixture().p1;
  citations(codec.schema,'observations','patient').items.enum.push('constructor');
  citations(schema,'observations','patient').items.enum.length=0;
  const first=codec.hydrate(encoded);first.observations.patient[0].quote='changed';
  assert.deepEqual(codec.hydrate(encoded),selection);
  encoded.observations.patient=['constructor'];rejects(()=>codec.hydrate(encoded));
});

test('same quote at different source triples keeps different IDs',()=>{
  const {schema,selection,p1}=fixture();
  const anotherActor={...p1,subject:'supporter'},anotherQuestion={...p1,question_id:'support'};
  citations(schema,'observations','supporter').items.enum=[anotherActor];selection.observations.supporter=[anotherActor];
  citations(schema,'relationship','strengths').items.enum=[anotherQuestion];selection.relationship.strengths[0].evidence=[anotherQuestion];
  const codec=createFinalEvidenceReferenceCodec(schema),encoded=codec.encode(selection);
  assert.equal(new Set([encoded.observations.patient[0],encoded.observations.supporter[0],encoded.relationship.strengths[0].evidence[0]]).size,3);
  assert.deepEqual(codec.hydrate(encoded),selection);
});

test('conditional clauses, uncertainty, corrections, Unicode and line endings remain verbatim',()=>{
  const {schema,selection,p1}=fixture();
  const full={...p1,quote:'이전 말을 정정해요. 가 🌱\r\n'+'상황 설명 '.repeat(110)+'미리 약속할 때만 가능하고 다음날은 모른다고 했어요.'};
  citations(schema,'observations','patient').items.enum=[full];selection.observations.patient=[full];
  const codec=createFinalEvidenceReferenceCodec(schema),restored=codec.hydrate(codec.encode(selection));
  validateSchema(restored,schema);assert.deepEqual(restored,selection);assert.equal(restored.observations.patient[0].quote,full.quote);
});

test('original validator still rejects cardinality, certainty, safety and unrelated-field errors after hydration',()=>{
  const {schema,selection}=fixture(),codec=createFinalEvidenceReferenceCodec(schema);
  for(const edit of [
    value=>{value.observations.patient=Array(3).fill(value.observations.patient[0]);},
    value=>{value.relationship.dynamics=Array(4).fill(value.relationship.dynamics[0]);},
    value=>{value.relationship.dynamics[0].evidence=[];},
    value=>{value.relationship.dynamics[0].evidence=Array(4).fill(value.relationship.dynamics[0].evidence[0]);},
    value=>{value.relationship.dynamics[0].certainty='reported';},
    value=>{value.relationship.strengths[0].interpretation=42;},
    value=>{value.safety.evidence_ids=['invented-safety-source'];},
    value=>{value.safety.urgent='true';},
    value=>{value.unknowns=42;},
    value=>{value.extra='must remain invalid';},
  ]) {
    const value=structuredClone(selection);edit(value);const before=structuredClone(value);
    const restored=codec.hydrate(codec.encode(value));assert.deepEqual(restored,before);assert.deepEqual(value,before);
    assert.throws(()=>validateSchema(restored,schema),{modelReason:'agent_schema'});
  }
});

for(const missing of [false,true])test('empty or missing candidate enums fail closed for nonempty citations: '+missing,()=>{
  const {schema,selection}=fixture();
  for(const [group,key]of targets) {
    if(missing)delete citations(schema,group,key).items.enum;else citations(schema,group,key).items.enum=[];
    selection[group][key]=[];
  }
  const codec=createFinalEvidenceReferenceCodec(schema);
  assert.deepEqual(codec.references,{});assert.deepEqual(codec.hydrate(codec.encode(selection)),selection);
  assert.ok(!Object.hasOwn(citations(codec.schema,'observations','patient').items,'enum'));
  const invented=codec.encode(selection);invented.observations.patient=['e0'];rejects(()=>codec.hydrate(invented));
});

test('unsupported schema structure and malformed source candidates fail during construction',()=>{
  for(const edit of [
    schema=>{delete schema.properties.observations;},
    schema=>{schema.properties.observations.additionalProperties=true;},
    schema=>{schema.properties.safety.properties.evidence={type:'array'};},
    schema=>{schema.properties.relationship.properties.dynamics.type='object';},
    schema=>{schema.properties.relationship.properties.dynamics.items.properties.certainty.enum=['reported'];},
    schema=>{citations(schema,'observations','patient').items.anyOf=[{}];},
    schema=>{citations(schema,'observations','patient').items.properties.quote.type='number';},
    schema=>{citations(schema,'observations','patient').items.required=['subject','quote'];},
    schema=>{citations(schema,'observations','patient').items.properties.subject.enum=['supporter'];},
    schema=>{citations(schema,'observations','patient').items.enum={};},
    schema=>{citations(schema,'observations','patient').items.enum=[{...fixture().p1,extra:true}];},
    schema=>{citations(schema,'observations','patient').items.enum=[{...fixture().p1,subject:'supporter'}];},
    schema=>{citations(schema,'observations','patient').items.enum=[{...fixture().p1,quote:''}];},
    schema=>{citations(schema,'observations','patient').items.enum=[{...fixture().p1,quote:'a'.repeat(1001)}];},
  ]) {
    const {schema}=fixture();edit(schema);assert.throws(()=>createFinalEvidenceReferenceCodec(schema),TypeError);
  }
});

test('repair feedback contains only fixed paths, counts and types, never model text or candidates',()=>{
  const {schema,selection,p1}=fixture(),codec=createFinalEvidenceReferenceCodec(schema),encoded=codec.encode(selection);
  encoded.relationship.strengths[0].evidence=['PRIVATE_FORGED_ID'];
  try { codec.hydrate(encoded);assert.fail('expected rejection'); }
  catch(error) {
    assert.equal(error.modelReason,'agent_evidence_reference');
    assert.deepEqual(JSON.parse(error.modelFeedback),{path:'output.relationship.strengths[0].evidence[0]',
      keyword:'evidenceReference',expected:{type:'string',allowed_reference_count:1},actual:{type:'string'}});
    for(const text of ['PRIVATE_FORGED_ID',p1.quote])assert.equal(error.modelFeedback.includes(text),false);
  }
});
