import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewSourceTransport,restoreReviewSources} from '../src/final-review-bundle.js';
import {compactReviewTransport} from '../src/compact-review-transport.js';
import {auditSchema,validateAudits} from '../src/grounding-audit.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const longText='검증용 원문은 요약하거나 다른 검토 범위에 추가하지 않습니다. '.repeat(100);
const task=(id,input,shared_input_keys={})=>({id,stage:'speech_review',instructions:[],input,shared_input_keys});
const rejects=fn=>assert.throws(fn,{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_review_sources'});
function fixture({documents=false}={}) {
  const answers={patient:{rawText:longText},supporter:{rawText:'보고된 답변입니다.'},
    prior_relationship_memory:{patient:['다른 검토에서만 사용하는 이전 기록']},empty:null};
  if(documents)answers.retrieval={documents:[{source_id:'source-1',subject:'patient',rawText:longText,retrieved_for:['state']}]};
  // Keep an intentionally different key order, as well as a null-valued field.
  const selected={empty:answers.empty,patient:answers.patient,supporter:answers.supporter,
    ...(documents?{retrieval:answers.retrieval}:{})};
  return {shared_instructions:{},shared_inputs:{full:answers},tasks:[
    task('state',{}, {answers:'full'}),task('guide',{answers:selected}),
  ]};
}

for(const documents of [false,true])test('exact partial inputs round-trip without widening task scope; documents='+documents,()=>{
  const payload=fixture({documents}),before=structuredClone(payload),transport=reviewSourceTransport(payload);
  assert.ok(transport);assert.deepEqual(payload,before);
  assert.ok(transport.payload.shared_input_projections);
  assert.equal(Object.hasOwn(transport.payload,'shared_sources'),documents);
  const ref=transport.payload.tasks[1].shared_input_keys.answers;
  assert.equal(typeof ref,'string');assert.equal(Object.hasOwn(transport.payload.tasks[1].input,'answers'),false);
  assert.deepEqual(transport.payload.shared_input_projections[ref].keys,Object.keys(payload.tasks[1].input.answers));
  assert.equal(transport.payload.shared_input_projections[ref].keys.includes('prior_relationship_memory'),false);
  const restored=restoreReviewSources(transport.payload);
  assert.deepEqual(restored,payload);
  assert.deepEqual(Object.keys(restored.tasks[1].input.answers),Object.keys(payload.tasks[1].input.answers));
  assert.equal(Object.hasOwn(restored.tasks[1].input.answers,'prior_relationship_memory'),false);
  assert.ok(Buffer.byteLength(JSON.stringify(transport.payload))+Buffer.byteLength(transport.instruction)<Buffer.byteLength(JSON.stringify(payload)));
});

test('different original values are never replaced by another task source',()=>{
  const payload=fixture();payload.tasks[1].input.answers.patient.rawText='다른 원문 '+longText;
  // The fixture shares nested objects; separate the full source explicitly.
  payload.shared_inputs.full.patient={rawText:longText};
  assert.equal(reviewSourceTransport(payload),null);
});

test('small projections remain literal when metadata and instructions cost more',()=>{
  const payload=fixture();payload.shared_inputs.full.patient={rawText:'짧음'};
  payload.tasks[1].input.answers.patient={rawText:'짧음'};
  assert.equal(reviewSourceTransport(payload),null);
});

test('identical projections share one entry and cannot mutate original sources',()=>{
  const payload=fixture();payload.tasks.push(task('other',{answers:structuredClone(payload.tasks[1].input.answers)}));
  const transport=reviewSourceTransport(payload);
  assert.equal(Object.keys(transport.payload.shared_input_projections).length,1);
  assert.equal(transport.payload.tasks[1].shared_input_keys.answers,transport.payload.tasks[2].shared_input_keys.answers);
  const restored=restoreReviewSources(transport.payload);
  assert.deepEqual(restored,payload);
  restored.tasks[1].input.answers.patient.rawText='변경';
  assert.equal(restored.tasks[2].input.answers.patient.rawText,longText);
  assert.equal(restored.shared_inputs.full.patient.rawText,longText);
});

test('projection IDs do not shadow an existing shared input',()=>{
  const payload=fixture();payload.shared_inputs.projection_1={existing:true};
  const transport=reviewSourceTransport(payload);
  assert.equal(transport.payload.tasks[1].shared_input_keys.answers,'projection_2');
  assert.deepEqual(restoreReviewSources(transport.payload),payload);
});

test('explicit shared retrieval aliases preserve each task retrieval scope',()=>{
  const document={source_id:'source-1',subject:'patient',rawText:longText};
  const payload={shared_inputs:{input_1:{documents:[{...document,retrieved_for:['questions']}]}},tasks:[
    task('questions',{}, {retrieval:'input_1'}),
    task('state',{review_target:{input:{retrieval:{documents:[{...document,retrieved_for:['state']}]}}}}),
  ]};
  const transport=reviewSourceTransport(payload);assert.ok(transport);
  assert.equal(Object.hasOwn(transport.payload.shared_inputs.input_1,'documents'),false);
  assert.equal(transport.payload.shared_sources.length,1);
  assert.deepEqual(transport.payload.shared_inputs.input_1.document_refs[0].retrieved_for,['questions']);
  assert.deepEqual(transport.payload.tasks[1].input.review_target.input.retrieval.document_refs[0].retrieved_for,['state']);
  assert.deepEqual(restoreReviewSources(transport.payload),payload);
  const bad=structuredClone(transport.payload);bad.shared_inputs.input_1.document_refs[0].id='missing';
  rejects(()=>restoreReviewSources(bad));
});

test('a documents field without an explicit retrieval role stays literal',()=>{
  const payload={shared_inputs:{unrelated:{documents:[{source_id:'source-1',rawText:longText}]}},
    tasks:[task('state',{}, {answers:'unrelated'})]};
  assert.equal(reviewSourceTransport(payload),null);
});

const corruptions={
  missing_source:(p,id)=>p.shared_input_projections[id].source='missing',
  cyclic_source:(p,id)=>p.shared_input_projections[id].source=id,
  array_source:p=>p.shared_inputs.full=[],
  missing_field:(p,id)=>p.shared_input_projections[id].keys.push('missing'),
  duplicate_field:(p,id)=>p.shared_input_projections[id].keys.push(p.shared_input_projections[id].keys[0]),
  nonstring_field:(p,id)=>p.shared_input_projections[id].keys.push(0),
  empty_fields:(p,id)=>p.shared_input_projections[id].keys=[],
  extra_metadata:(p,id)=>p.shared_input_projections[id].exclude=['patient'],
  shadowing:(p,id)=>p.shared_inputs[id]={other:true},
  conflicting_input:p=>p.tasks[1].input.answers={},
  unknown_reference:p=>p.tasks[1].shared_input_keys.answers='unknown',
  nonstring_reference:p=>p.tasks[1].shared_input_keys.answers={},
  unused_projection:p=>p.tasks.pop(),
  invalid_tasks:p=>p.tasks={},
  empty_table:p=>p.shared_input_projections={},
};
for(const [name,corrupt] of Object.entries(corruptions))test('malformed projection fails closed: '+name,()=>{
  const payload=reviewSourceTransport(fixture()).payload,id=payload.tasks[1].shared_input_keys.answers;
  corrupt(payload,id);const before=structuredClone(payload);
  rejects(()=>restoreReviewSources(payload));assert.deepEqual(payload,before);
});

test('already transformed input cannot be projected a second time',()=>{
  const payload=reviewSourceTransport(fixture()).payload;
  rejects(()=>reviewSourceTransport(payload));
});

test('compact reviewer reads exact projected claims but binds to the complete wire request',()=>{
  const claims=[{id:'script.0',field:'script',claim:'확인된 선택지를 물어봅니다.',certainty:'reported'}];
  const payload={shared_instructions:{},shared_inputs:{full:{claims,source:longText,prior_relationship_memory:['별도 기록']}},tasks:[
    task('first',{}, {review_target:'full'}),task('second',{review_target:{claims,source:longText}}),
  ]};
  const reviewSchema=object({audits:auditSchema(claims)}),schema=object({first:reviewSchema,second:reviewSchema});
  const transport=reviewSourceTransport(payload);assert.ok(transport);
  const codec=compactReviewTransport({stage:'final_review_bundle',schema,payload:transport.payload});
  const originalCodec=compactReviewTransport({stage:'final_review_bundle',schema,payload});
  assert.ok(codec);assert.ok(originalCodec);
  const audit={audits:[{id:'script.0',verdict:'supported',reason:'원문 범위와 조건을 대조했습니다.'}]};
  const logical={first:structuredClone(audit),second:structuredClone(audit)};
  const wire=codec.encode(logical),restored=codec.hydrate(wire);
  assert.deepEqual(restored,logical);
  validateAudits(restored.second.audits,claims,true);
  assert.notEqual(wire.b,originalCodec.encode(logical).b);
  assert.throws(()=>originalCodec.hydrate(wire),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  const broken=structuredClone(transport.payload);broken.shared_input_projections[broken.tasks[1].shared_input_keys.review_target].keys.push('missing');
  rejects(()=>compactReviewTransport({stage:'final_review_bundle',schema,payload:broken}));
});
