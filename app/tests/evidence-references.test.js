import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceReferenceCodec } from '../src/evidence-references.js';
import { relationshipStateRequest, validateSchema } from '../src/relationship-agent.js';
import { runCombinedRelationshipState } from '../src/relationship-turn.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const field=(id,text)=>({id,question:id,text,rawText:text,custom:'',status:'answered'});
const ref=(subject,question_id,quote)=>({subject,question_id,quote});
const leaf=(schema,subject,certainty)=>{
  const items=schema.properties.state.properties.relationship_memory.properties[subject].items;
  return (items.anyOf?.find(branch=>branch.properties.certainty.enum.includes(certainty))||items).properties.evidence;
};
function fixture() {
  const p1=ref('patient','burden','아직 병원에 가고 싶다는 말은 듣지 못했어요.');
  const p2=ref('patient','mood','무시한 게 아니었어요. 휴대전화가 고장 났대요. 🌱');
  const s1=ref('supporter','cgchange','밤 열 시 이후에는 쉬고 싶어요.\n토요일에는 20분 이야기를 들을 수 있어요.');
  const goal=ref('user_goal','want','그 사람이 혼자 버티지 않아도 된다는 말을 해 주고 싶어요.');
  const context={patient:{alias:'지민',fields:{name:field('name','지민'),burden:field(p1.question_id,p1.quote),mood:field(p2.question_id,p2.quote)}},
    supporter:{fields:{cgchange:field(s1.question_id,s1.quote)}},user_goal:{message:field('want',goal.quote)},
    latest_answer:{subject:'patient',question_id:'burden'},adaptive_questions:false,answered_count:5};
  const schema=object({state:relationshipStateRequest(context,null).schema,questions:{type:'null'}});
  for(const [subject,certainty,references]of [
    ['patient','reported',[p1]],['patient','tentative',[p1,p2]],
    ['supporter','reported',[s1]],['supporter','tentative',[s1]],
    ['relationship','tentative',[p2,s1,goal]],
  ])leaf(schema,subject,certainty).items.enum=structuredClone(references);
  const draft={state:{patient_state:{facts:[{...p1,certainty:'reported'}],unknowns:['치료를 원하는지는 아직 확인하지 못했어요.']},name_index:null,
    relationship_memory:{patient:[{certainty:'reported',evidence:[p1]},
      {certainty:'tentative',interpretation:'가능한 해석: 답장 지연은 관계와 별개였을 수 있어요.',evidence:[p2]}],
    supporter:[{certainty:'reported',evidence:[s1]},{certainty:'tentative',interpretation:'가능한 해석: 휴식 시간의 경계를 정하려는 것일 수 있어요.',evidence:[s1]}],
    relationship:[{certainty:'tentative',interpretation:'가능한 해석: 도움의 뜻을 전하고 싶은 것일 수 있어요.',evidence:[goal]}],
    unknowns:['원하는 대화 방법은 직접 확인하지 못했어요.']}},questions:null};
  return {schema,draft,context,p1,p2,s1,goal};
}
const rejects=fn=>assert.throws(fn,error=>error.code==='MODEL_INVALID_RESPONSE'&&error.modelReason==='agent_evidence_reference');
const freeze=value=>{
  if(value&&typeof value==='object') { Object.freeze(value);for(const child of Object.values(value))freeze(child); }
  return value;
};

test('both inversions preserve all exact evidence and all non-target data without mutation',()=>{
  const {schema,draft}=fixture(),before=structuredClone({schema,draft});
  freeze(schema);freeze(draft);
  const codec=createEvidenceReferenceCodec(schema),encoded=codec.encode(draft),hydrated=codec.hydrate(encoded);
  assert.deepEqual(hydrated,draft);assert.deepEqual(codec.encode(hydrated),encoded);
  assert.deepEqual({schema,draft},before);assert.notEqual(hydrated.state.patient_state,draft.state.patient_state);
  assert.deepEqual(encoded.state.patient_state,draft.state.patient_state);assert.equal(encoded.state.name_index,draft.state.name_index);
  assert.deepEqual(encoded.state.relationship_memory.unknowns,draft.state.relationship_memory.unknowns);
  assert.deepEqual(encoded.questions,draft.questions);
  validateSchema(draft,schema);validateSchema(encoded,codec.schema);validateSchema(hydrated,schema);
});

test('only the five evidence-item leaves change and all structural bounds remain',()=>{
  const {schema}=fixture(),codec=createEvidenceReferenceCodec(schema),restored=structuredClone(codec.schema);
  for(const [subject,certainty]of [['patient','reported'],['patient','tentative'],['supporter','reported'],['supporter','tentative'],['relationship','tentative']]) {
    assert.equal(leaf(codec.schema,subject,certainty).items.type,'string');
    leaf(restored,subject,certainty).items=structuredClone(leaf(schema,subject,certainty).items);
  }
  assert.deepEqual(restored,schema);
});

test('IDs are deterministic, unique per exact triple, and shared only where allowed',()=>{
  const {schema,draft}=fixture(),codec=createEvidenceReferenceCodec(schema);
  assert.deepEqual(codec.references,createEvidenceReferenceCodec(schema).references);
  assert.deepEqual(Object.keys(codec.references),['e0','e1','e2','e3']);
  const encoded=codec.encode(draft);
  assert.equal(encoded.state.relationship_memory.supporter[0].evidence[0],encoded.state.relationship_memory.supporter[1].evidence[0]);
  const reordered=structuredClone(schema);
  reordered.properties.state.properties.relationship_memory.properties.patient.items.anyOf.reverse();
  assert.deepEqual(createEvidenceReferenceCodec(reordered).references,codec.references);
  const reorderedRef=structuredClone(draft),p=reorderedRef.state.relationship_memory.patient[0].evidence[0];
  reorderedRef.state.relationship_memory.patient[0].evidence[0]={quote:p.quote,question_id:p.question_id,subject:p.subject};
  assert.deepEqual(codec.encode(reorderedRef),encoded);
});

test('public schema/table changes cannot poison the private ID mapping or allowlists',()=>{
  const {schema,draft}=fixture(),codec=createEvidenceReferenceCodec(schema),encoded=codec.encode(draft);
  codec.references.e0.quote='forged';codec.references.constructor={subject:'patient',question_id:'mood',quote:'forged'};
  leaf(codec.schema,'patient','reported').items.enum.push('constructor');
  schema.properties.state.properties.relationship_memory.properties.patient.items.anyOf[0].properties.evidence.items.enum.length=0;
  assert.deepEqual(codec.hydrate(encoded),draft);
  encoded.state.relationship_memory.patient[0].evidence=['constructor'];rejects(()=>codec.hydrate(encoded));
});

for(const [name,edit]of [
  ['another actor',draft=>{draft.state.relationship_memory.patient[0].evidence=draft.state.relationship_memory.supporter[0].evidence;}],
  ['another question/branch',draft=>{draft.state.relationship_memory.patient[0].evidence=draft.state.relationship_memory.patient[1].evidence;}],
  ['relationship-only source',draft=>{draft.state.relationship_memory.patient[1].evidence=draft.state.relationship_memory.relationship[0].evidence;}],
  ['unknown ID',draft=>{draft.state.relationship_memory.patient[0].evidence=['ezz'];}],
  ['prototype key',draft=>{draft.state.relationship_memory.patient[0].evidence=['__proto__'];}],
  ['constructor key',draft=>{draft.state.relationship_memory.patient[0].evidence=['constructor'];}],
  ['non-string ID',draft=>{draft.state.relationship_memory.patient[0].evidence=[0];}],
  ['missing ID',draft=>{draft.state.relationship_memory.patient[0].evidence=[null];}],
  ['sparse ID',draft=>{draft.state.relationship_memory.patient[0].evidence=Array(1);}],
  ['unknown certainty',draft=>{draft.state.relationship_memory.patient[0].certainty='unknown';}],
  ['missing certainty',draft=>{delete draft.state.relationship_memory.patient[0].certainty;}],
  ['missing evidence',draft=>{delete draft.state.relationship_memory.patient[0].evidence;}],
  ['missing group',draft=>{delete draft.state.relationship_memory.patient;}],
  ['missing memory',draft=>{delete draft.state.relationship_memory;}],
  ['missing state',draft=>{delete draft.state;}],
  ['non-array group',draft=>{draft.state.relationship_memory.patient={};}],
  ['non-array evidence',draft=>{draft.state.relationship_memory.patient[0].evidence={};}],
  ['legacy evidence object',draft=>{draft.state.relationship_memory.patient[0].evidence=[ref('patient','burden','아직 병원에 가고 싶다는 말은 듣지 못했어요.')];}],
])test('hydration rejects '+name+' rather than bypassing reference resolution',()=>{
  const {schema,draft}=fixture(),codec=createEvidenceReferenceCodec(schema),encoded=codec.encode(draft);
  edit(encoded);const before=structuredClone(encoded);rejects(()=>codec.hydrate(encoded));assert.deepEqual(encoded,before);
});

for(const [name,edit]of [
  ['forged quote',reference=>{reference.quote+=' 아니에요.';}],
  ['changed whitespace',reference=>{reference.quote=reference.quote.replace(' ','  ');}],
  ['wrong subject',reference=>{reference.subject='supporter';}],
  ['wrong question',reference=>{reference.question_id='mood';}],
  ['additional key',reference=>{reference.extra='forged';}],
  ['prototype property',reference=>{Object.defineProperty(reference,'__proto__',{value:{polluted:true},enumerable:true});}],
  ['hidden key',reference=>{Object.defineProperty(reference,'hidden',{value:'forged'});}],
  ['symbol key',reference=>{reference[Symbol('forged')]=true;}],
  ['non-plain prototype',reference=>{Object.setPrototypeOf(reference,{inherited:'forged'});}],
  ['missing quote',reference=>{delete reference.quote;}],
])test('encoding rejects '+name+' without manufacturing a reference',()=>{
  const {schema,draft}=fixture(),codec=createEvidenceReferenceCodec(schema);
  edit(draft.state.relationship_memory.patient[0].evidence[0]);rejects(()=>codec.encode(draft));
});

test('equal text with another person or question receives a distinct ID',()=>{
  const {schema,draft,p1}=fixture(),sameText=ref('supporter','cgchange',p1.quote),anotherQuestion=ref('patient','mood',p1.quote);
  leaf(schema,'supporter','reported').items.enum=[sameText];
  leaf(schema,'patient','tentative').items.enum=[anotherQuestion];
  draft.state.relationship_memory.supporter[0].evidence=[sameText];draft.state.relationship_memory.patient[1].evidence=[anotherQuestion];
  const codec=createEvidenceReferenceCodec(schema),encoded=codec.encode(draft);
  assert.equal(new Set([encoded.state.relationship_memory.patient[0].evidence[0],encoded.state.relationship_memory.patient[1].evidence[0],
    encoded.state.relationship_memory.supporter[0].evidence[0]]).size,3);
  assert.deepEqual(codec.hydrate(encoded),draft);
});

test('Unicode, line endings, negations, corrections, and long citations survive verbatim',()=>{
  const {schema,draft,p1}=fixture(),long={...p1,quote:'이전 판단을 정정해요. 그렇지 않아요.\r\n🌱 가 '+ '긴 내용 '.repeat(150)};
  leaf(schema,'patient','reported').items.enum=[long];draft.state.relationship_memory.patient[0].evidence=[long];
  const codec=createEvidenceReferenceCodec(schema),hydrated=codec.hydrate(codec.encode(draft));
  assert.deepEqual(hydrated,draft);assert.equal(hydrated.state.relationship_memory.patient[0].evidence[0].quote,long.quote);
});

test('unrelated malformed fields and cardinalities stay intact for the existing validator',()=>{
  const {schema,draft}=fixture(),codec=createEvidenceReferenceCodec(schema);
  draft.state.patient_state.facts[0].quote='original validator must reject';
  draft.state.relationship_memory.patient[1].interpretation=42;
  draft.state.relationship_memory.patient[0].evidence=Array(4).fill(draft.state.relationship_memory.patient[0].evidence[0]);
  draft.state.relationship_memory.patient[0].extra='reject later';draft.questions={urgent:'invalid'};
  assert.deepEqual(codec.hydrate(codec.encode(draft)),draft);
  assert.throws(()=>validateSchema(codec.hydrate(codec.encode(draft)),schema),{code:'MODEL_INVALID_RESPONSE'});
});

for(const emptyEnum of [false,true])test('empty and missing enums allow empty arrays but no invented ID: '+emptyEnum,()=>{
  const {schema,draft}=fixture();
  for(const subject of ['patient','supporter','relationship']) {
    const group=schema.properties.state.properties.relationship_memory.properties[subject];group.maxItems=0;
    for(const certainty of subject==='relationship'?['tentative']:['reported','tentative']) {
      const evidence=leaf(schema,subject,certainty);
      if(emptyEnum)evidence.items.enum=[];else delete evidence.items.enum;
    }
    draft.state.relationship_memory[subject]=[];
  }
  const codec=createEvidenceReferenceCodec(schema);
  assert.deepEqual(codec.references,{});assert.deepEqual(codec.hydrate(codec.encode(draft)),draft);
  assert.ok(!Object.hasOwn(leaf(codec.schema,'patient','reported').items,'enum'));
  const bad=structuredClone(draft);bad.state.relationship_memory.patient=[{certainty:'reported',evidence:['e0']}];
  rejects(()=>codec.hydrate(bad));
});

test('source-free repair feedback never copies forged IDs, keys, or quotations',()=>{
  const {schema,draft}=fixture(),codec=createEvidenceReferenceCodec(schema),encoded=codec.encode(draft);
  encoded.state.relationship_memory.patient[0].evidence=['secret forged identifier'];
  try { codec.hydrate(encoded);assert.fail('expected failure'); }
  catch(error) {
    assert.equal(error.modelReason,'agent_evidence_reference');
    const feedback=JSON.parse(error.modelFeedback);
    assert.equal(feedback.path,'output.state.relationship_memory.patient[0].evidence[0]');
    assert.equal(feedback.expected.allowed_reference_count,1);
    assert.ok(!error.modelFeedback.includes('secret'));assert.ok(!error.modelFeedback.includes('아직 병원'));
  }
});

test('unsupported or ambiguous branches fail closed at codec construction',()=>{
  for(const edit of [
    schema=>{schema.properties.state.properties.relationship_memory.properties.patient.items.anyOf[1].properties.certainty.enum=['reported'];},
    schema=>{schema.properties.state.properties.relationship_memory.properties.patient.items.anyOf.push({type:'object'});},
    schema=>{leaf(schema,'patient','reported').items.enum=[{subject:'patient',question_id:'burden',quote:'a',extra:true}];},
    schema=>{delete leaf(schema,'patient','reported').items.properties.quote;},
    schema=>{leaf(schema,'patient','reported').items.enum=[ref('supporter','burden','a')];},
    schema=>{schema.properties.state.properties.relationship_memory.properties.patient.items=
      schema.properties.state.properties.relationship_memory.properties.patient.items.anyOf[1];},
  ]) {
    const {schema}=fixture();edit(schema);assert.throws(()=>createEvidenceReferenceCodec(schema),TypeError);
  }
});

test('the existing reported-only retry remains restricted to its explicit single branch',()=>{
  const {schema,draft}=fixture();
  for(const subject of ['patient','supporter']) {
    const group=schema.properties.state.properties.relationship_memory.properties[subject];
    group.items=group.items.anyOf.find(branch=>branch.properties.certainty.enum[0]==='reported');
    draft.state.relationship_memory[subject]=draft.state.relationship_memory[subject].filter(row=>row.certainty==='reported');
  }
  schema.properties.state.properties.relationship_memory.properties.relationship.maxItems=0;
  draft.state.relationship_memory.relationship=[];
  const codec=createEvidenceReferenceCodec(schema),encoded=codec.encode(draft);
  validateSchema(encoded,codec.schema);assert.deepEqual(codec.hydrate(encoded),draft);
  encoded.state.relationship_memory.patient[0].certainty='tentative';rejects(()=>codec.hydrate(encoded));
});

test('hydration permits the original three-row reported merge before independent review',async()=>{
  const text='주말에는 이야기를 들을 수 있어요. 밤 열 시 이후에는 쉬어야 해요.';
  const context={patient:{alias:'지민',fields:{name:field('name','지민'),rel:field('rel','친구')}},
    supporter:{fields:{cgchange:field('cgchange',text)}},user_goal:{message:field('want','이야기를 듣고 싶어요.')},
    answered_count:4,latest_answer:{subject:'supporter',question_id:'cgchange'},adaptive_questions:false};
  const full=ref('supporter','cgchange',text),second=ref('supporter','cgchange','밤 열 시 이후에는 쉬어야 해요.');
  const draft={state:{patient_state:{facts:[{...full,certainty:'reported'}],unknowns:[]},name_index:null,
    relationship_memory:{patient:[],supporter:[{certainty:'reported',evidence:[full]},{certainty:'reported',evidence:[second]},
      {certainty:'tentative',interpretation:'가능한 해석: 휴식 시간의 경계가 필요할 수 있어요.',evidence:[second]}],relationship:[],unknowns:[]}},questions:null};
  const before=structuredClone(draft),calls=[];
  const gateway={async agentComplete(stage,prompt,data,schema,operation,validate) {
    calls.push(stage);
    if(stage.startsWith('turn_draft')) {
      const codec=createEvidenceReferenceCodec(schema),restored=codec.hydrate(codec.encode(draft));
      assert.deepEqual(restored,draft);assert.equal(restored.state.relationship_memory.supporter.length,3);
      assert.throws(()=>validateSchema(restored,schema),{modelReason:'agent_schema'});
      return validate(restored);
    }
    assert.equal(data.review_target.claims.filter(claim=>claim.id.startsWith('supporter.')).length,2);
    return validate({state:{approved:true,issues:[],audits:data.review_target.claims.map(claim=>({id:claim.id,
      verdict:claim.certainty==='tentative'?'plausible':'supported',reason:'합성 검토 결과'}))},questions:null,safety:null});
  }};
  const result=await runCombinedRelationshipState(gateway,context,null,{});
  assert.deepEqual(calls,['turn_draft','turn_review']);assert.deepEqual(draft,before);
  assert.equal(result.relationship_memory.supporter.length,2);assert.equal(result.state_agent.reviewed,true);
});
