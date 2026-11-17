import test from 'node:test';
import assert from 'node:assert/strict';
import {compactClarificationPromptSchema,expandClarificationPromptSchema} from '../src/clarification-schema-prompt.js';
import {validateSchema,relationshipQuestionRequest} from '../src/relationship-agent.js';
import {activeQuestionSet} from '../src/question-bank.js';
import {createIntake,currentView,prepareModelAnswer,completeModelAnswer,buildContext} from '../src/intake.js';
import {syntheticAnswer} from '../scripts/verify-questionnaire-v3-live.mjs';

const axes=['actor','execution','source','time','agreement','modality'];
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const string=maxLength=>({type:'string',minLength:1,maxLength});
const sources=[{id:'q3_01',revision:1,component:'rawText',length:3},
  {id:'q3_01',revision:2,component:'custom',length:7},
  {id:'q3_02',revision:3,component:'rawText',length:12}];
const branch=(source,axis,normalized)=>object({
  source_question_id:normalized?{const:source.id}:{type:'string',const:source.id},
  source_revision:normalized?{const:source.revision}:{type:'integer',const:source.revision},
  component:normalized?{const:source.component}:{type:'string',const:source.component},
  event_id:string(80),quote:string(10000),quote_start:{type:'integer',minimum:0,maximum:source.length-1},
  quote_end:{type:'integer',minimum:1,maximum:source.length},axis:normalized?{const:axis}:{type:'string',const:axis},
  role:axis==='actor'?{...(normalized?{}:{type:'string'}),enum:['speaker','actor','experiencer','capacity_holder','relayer']}:{type:'null'},
  agreement_item_id:axis==='agreement'?string(80):{type:'null'},
});
const schema=(normalized=false)=>object({skip:{type:'array',items:object({}),minItems:0,maxItems:0},
  clarify:{type:'array',items:{anyOf:sources.flatMap(source=>axes.map(axis=>branch(source,axis,normalized)))},minItems:0,maxItems:1},
  safety:object({urgent:{type:'boolean'}})});
const candidate=(source,axis)=>({source_question_id:source.id,source_revision:source.revision,component:source.component,
  event_id:'source-event',quote:'같은 문장',quote_start:0,quote_end:source.length,axis,
  role:axis==='actor'?'speaker':null,agreement_item_id:axis==='agreement'?'one-item':null});
const accepts=(value,schema)=>{try{validateSchema(value,schema);return true;}catch{return false;}};

// Evaluate the two factored conditions independently of the shipped expander.
// This test interpreter handles only this projection, not arbitrary allOf.
const acceptsProjection=(value,item)=>{
  const {allOf,...base}=item;
  if(!accepts(value,base))return false;
  return allOf.every(group=>group.anyOf.some(fragment=>{
    const selected=Object.fromEntries(Object.keys(fragment.properties).map(key=>[key,value[key]]));
    return accepts(selected,object(fragment.properties));
  }));
};
const unchanged=s=>{
  const before=structuredClone(s),result=compactClarificationPromptSchema(s);
  assert.equal(result.compacted,false);assert.equal(result.proof,null);assert.equal(result.instruction,'');
  assert.deepEqual(result.schema,before);assert.deepEqual(s,before);
};

for(const normalized of [false,true])test('source × axis prompt factorization is exact and immutable, normalized='+normalized,()=>{
  const original=schema(normalized),before=structuredClone(original),result=compactClarificationPromptSchema(original);
  assert.equal(result.compacted,true);assert.equal(result.proof.originalBranches,18);
  assert.equal(result.proof.sourceChoices,3);assert.equal(result.proof.axisChoices,6);assert.equal(result.proof.roundTripEqual,true);
  assert.ok(result.proof.afterCharacters<result.proof.beforeCharacters*.5);
  assert.match(result.instruction,/allOf/);assert.match(result.instruction,/두 조건을 모두/);
  assert.equal(JSON.stringify(expandClarificationPromptSchema(result.schema)),JSON.stringify(original));
  assert.deepEqual(original,before);
  result.schema.properties.clarify.items.allOf[0].anyOf[0].properties.source_revision.const=999;
  assert.deepEqual(original,before);
});

test('every source and axis combination preserves admission, bounds and correlation',()=>{
  const original=schema(),compact=compactClarificationPromptSchema(original).schema.properties.clarify.items;
  const item=original.properties.clarify.items,expanded=expandClarificationPromptSchema(compactClarificationPromptSchema(original).schema).properties.clarify.items;
  let checked=0;
  for(const source of sources)for(const axis of axes){
    const value=candidate(source,axis);
    assert.equal(accepts(value,item),true);assert.equal(acceptsProjection(value,compact),true);checked++;
    const mutations=[{source_revision:999},{component:'other'},{quote_start:-1},{quote_start:source.length},
      {quote_end:source.length+1},{quote_end:0},{axis:'unregistered'},{extra:'field'},
      {role:axis==='actor'?null:'speaker'},
      {agreement_item_id:axis==='agreement'?null:'one-item'}];
    for(const change of mutations){
      const invalid={...value,...change};assert.equal(accepts(invalid,item),false);
      assert.equal(acceptsProjection(invalid,compact),false);assert.equal(accepts(invalid,expanded),false);checked++;
    }
    const missing={...value};delete missing.quote;
    assert.equal(acceptsProjection(missing,compact),false);assert.equal(accepts(missing,item),false);checked++;
  }
  assert.equal(checked,216);
  // Same ID with another revision/component is not interchangeable; neither
  // are the offset limits of a longer source that happens to look similar.
  const crossed={...candidate(sources[0],'execution'),source_revision:2};
  assert.equal(accepts(crossed,item),false);assert.equal(acceptsProjection(crossed,compact),false);
});

test('full-turn and question-block projections round-trip while other paths are untouched',()=>{
  const original=object({state:object({facts:{type:'array',items:string(80),minItems:0,maxItems:2}}),questions:schema()});
  const result=compactClarificationPromptSchema(original);
  assert.equal(result.compacted,true);assert.deepEqual(result.proof.path,['properties','questions','properties','clarify','items']);
  assert.equal(JSON.stringify(expandClarificationPromptSchema(result.schema)),JSON.stringify(original));
  assert.deepEqual(result.schema.properties.state,original.properties.state);
  unchanged(object({elsewhere:schema()}));
  unchanged({...schema(),properties:{...schema().properties,questions:schema()}});
});

test('missing, duplicated, reordered or non-Cartesian source/axis pairs are refused',()=>{
  const mutations=[
    items=>items.anyOf.pop(),
    items=>{items.anyOf[1]=structuredClone(items.anyOf[0]);},
    items=>{[items.anyOf[0],items.anyOf[1]]=[items.anyOf[1],items.anyOf[0]];},
    items=>{items.anyOf[0].properties.quote_start.maximum=1;},
    items=>{items.anyOf[0].properties.role.enum=['different-role'];},
    items=>{items.anyOf[0].properties.quote.maxLength=9000;},
  ];
  for(const mutate of mutations){const value=schema();mutate(value.properties.clarify.items);unchanged(value);}
});

test('unsupported schema metadata and unsupported leaf forms are preserved without compaction',()=>{
  const mutations=[
    items=>{items.description='Preserve this union instruction';},
    items=>{items.anyOf[0].description='Preserve this branch instruction';},
    items=>{items.anyOf[0].properties.source_question_id={type:'string',enum:['q3_01']};},
    items=>{items.anyOf[0].properties.quote_start.exclusiveMaximum=3;},
    items=>{items.anyOf[0].additionalProperties=true;},
    items=>{items.anyOf[0].required.pop();},
    items=>{items.anyOf[0].properties.event_id.description='Preserve exact source event scope';},
  ];
  for(const mutate of mutations){const value=schema();mutate(value.properties.clarify.items);unchanged(value);}
  const noClarification=schema();noClarification.properties.clarify.maxItems=0;unchanged(noClarification);
});

test('expansion rejects malformed factor groups and closed-object changes',()=>{
  for(const mutate of [
    item=>{item.allOf[0].anyOf[0].properties.component={enum:['rawText','custom']};},
    item=>{item.allOf[1].anyOf.pop();},
    item=>{item.properties.source_revision={const:0};},
    item=>{item.additionalProperties=true;},
    item=>{item.allOf[0].anyOf[0].required=['source_revision'];},
  ]){
    const compact=compactClarificationPromptSchema(schema()).schema;mutate(compact.properties.clarify.items);
    assert.throws(()=>expandClarificationPromptSchema(compact),TypeError);
  }
});

test('all nine actual synthetic intake schemas retain exact complete clarification choices',()=>{
  let intake=createIntake(activeQuestionSet),count=0;
  // Retain coverage of every original bank schema through a historical saved
  // intake; compact new conversations deliberately ask only the needed subset.
  delete intake.v3.compact_flow;
  while(currentView(intake).question){
    const question=currentView(intake).question;
    intake=prepareModelAnswer(intake,syntheticAnswer(question),++count);
    const original=relationshipQuestionRequest(buildContext(intake)).schema;
    const result=compactClarificationPromptSchema(original);
    assert.equal(result.compacted,true,question.id);
    assert.equal(JSON.stringify(expandClarificationPromptSchema(result.schema)),JSON.stringify(original),question.id);
    assert.equal(result.proof.originalBranches,result.proof.sourceChoices*6);
    intake=completeModelAnswer(intake,{name_index:null,patient_state:{},question_plan:{skip:[]}});
  }
  assert.equal(count,9);
});
