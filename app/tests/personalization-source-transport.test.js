import test from 'node:test';
import assert from 'node:assert/strict';
import {personalizationSchema,personalizationSources,validatePersonalization} from '../src/personalized-questions.js';
import {personalizationSourceSpans,personalizationSourceTransport} from '../src/personalization-source-transport.js';
import {validateSchema} from '../src/relationship-agent.js';
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const context=()=>({patient:{fields:{q3_04:{id:'q3_04',status:'answered',source_revision:4,rawText:'🙂 친구가 제게 도입 부분을 봐 달라고 했어요.\n아직 답하지 않았어요.'}}},supporter:{fields:{}},
  personalization:{version:1,available:true,remaining_follow_ups:2,history:[]},personalization_candidates:[{id:'q3_08',subject:'supporter',question:'어느 범위까지 도울 수 있나요?'}]});
function setup({nested=false}={}){
 const ctx=context(),inner=object({personalization:personalizationSchema(ctx)}),schema=nested?object({questions:inner}):inner;
 const sources=personalizationSources(ctx),data={personalization_sources:sources};
 const transport=personalizationSourceTransport(nested?'turn_draft':'question_plan',schema,nested?{question_input:data}:data);
 const source=transport.table.personalization_sources.find(row=>row.binding.quote==='친구가 제게 도입 부분을 봐 달라고 했어요.');
 const decision={kind:'next',question_id:'q3_08',subject:'supporter',...source.binding,question:null,focus:null,reason:'부탁받은 범위에 맞는 도움을 먼저 정하려고 해요.'};
 return {ctx,schema,transport,decision,logical:nested?{questions:{personalization:decision}}:{personalization:decision}};
}
for(const nested of [false,true])test(`source span ID restores Unicode quote and source revision; nested=${nested}`,()=>{
 const p=setup({nested}),wire=p.transport.encode(p.logical),decision=nested?wire.questions.personalization:wire.personalization;
 assert.deepEqual(Object.keys(decision).sort(),['kind','question_id','subject','question','focus','reason','source_ref'].sort());
 assert.equal(p.decision.quote_start,2);
 const restored=p.transport.decode(wire);assert.deepEqual(restored,p.logical);
 assert.deepEqual(validatePersonalization(p.decision,p.ctx),p.decision);
 assert.ok(p.transport.table.personalization_sources.some(row=>row.binding.quote==='아직 답하지 않았어요.'));
});
test('recorded mismatch cannot be encoded or accepted by the original validator',()=>{
 const p=setup(),invalid={...p.decision,quote_start:p.decision.quote_start+1,quote_end:p.decision.quote_end+1};
 assert.throws(()=>validatePersonalization(invalid,p.ctx),{modelReason:'agent_personalization_source'});
 assert.throws(()=>p.transport.encode({personalization:invalid}),{modelReason:'agent_personalization_source'});
});
test('unknown IDs and extra quote fields fail before hydration',()=>{
 const p=setup(),wire=p.transport.encode(p.logical);
 assert.throws(()=>p.transport.decode({personalization:{...wire.personalization,source_ref:'ps999'}}),{code:'MODEL_INVALID_RESPONSE'});
 assert.throws(()=>p.transport.decode({personalization:{...wire.personalization,quote:'지어낸 내용'}}),{code:'MODEL_INVALID_RESPONSE'});
});
test('returned schema and source table cannot alter a decoder binding',()=>{
 const p=setup(),wire=p.transport.encode(p.logical);
 const entry=p.transport.table.personalization_sources.find(row=>row.id===wire.personalization.source_ref);entry.binding.quote='변조한 원문';entry.binding.source_revision=99;
 p.transport.schema.properties.personalization.anyOf[1].properties.source_ref.enum.push('forged');
 assert.deepEqual(p.transport.decode(wire),p.logical);
 assert.throws(()=>p.transport.decode({personalization:{...wire.personalization,source_ref:'forged'}}),{code:'MODEL_INVALID_RESPONSE'});
});
test('spans never include unasked, unknown, or superseded source values',()=>{
 const ctx=context();ctx.patient.fields.future={id:'future',status:'not_asked',source_revision:5,rawText:'미응답'};
 ctx.patient.fields.unknown={id:'unknown',status:'answered',response_event:'unknown',source_revision:6,rawText:'모름'};
 ctx.patient.fields.obsolete={id:'obsolete',status:'answered',ordinary_usable:false,source_revision:7,rawText:'폐기'};
 assert.deepEqual([...new Set(personalizationSourceSpans(personalizationSources(ctx)).map(row=>row.binding.source_question_id))],['q3_04']);
});
test('bounded long and newline spans are exact slices with no Unicode normalization',()=>{
 const sources=[{subject:'patient',source_question_id:'q3_04',source_revision:4,component:'rawText',text:'가'.repeat(170)+'🙂\n나'.repeat(20)}];
 const spans=personalizationSourceSpans(sources);assert.ok(spans.length>1);
 for(const {binding} of spans){assert.ok(Array.from(binding.quote).length<=160);assert.equal(Array.from(sources[0].text).slice(binding.quote_start,binding.quote_end).join(''),binding.quote);}
});
test('composes with a preexisting codec without changing its source table',()=>{
 const p=setup();let encodes=0,decodes=0;
 const base={schema:p.schema,table:{sources:[{id:'e0',evidence:{quote:'unchanged'}}],locations:[]},instruction:'existing',encode:v=>{encodes++;return structuredClone(v);},decode:v=>{decodes++;return structuredClone(v);}};
 const transport=personalizationSourceTransport('question_plan',p.schema,{personalization_sources:personalizationSources(p.ctx)},base);
 assert.deepEqual(transport.decode(transport.encode(p.logical)),p.logical);assert.equal(encodes,1);assert.equal(decodes,1);
 assert.deepEqual(transport.table.sources,base.table.sources);assert.equal(base.table.personalization_sources,undefined);
 assert.equal(transport.instruction.startsWith('existing'),true);
 validateSchema(transport.encode(p.logical),transport.schema);
});
