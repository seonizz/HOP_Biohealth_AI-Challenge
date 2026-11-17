import test from 'node:test';
import assert from 'node:assert/strict';
import {safetyReviewSelectionTransport,compactReviewTransport} from '../src/compact-review-transport.js';
import {relationshipQuestionRequest,safetyReviewRequest,validateSafetyReview,safetySources} from '../src/relationship-agent.js';
import {cases} from '../scripts/turn-comparison-cases.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const bases=['current_physical_danger','distress_without_immediate_danger','negated','past_only','unclear'];
const reject=fn=>assert.throws(fn,{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
function fixture(count=3) {
  const ids=Array.from({length:count},(_,index)=>'safety_source_'+index);
  return {stage:'safety_review',payload:{safety_sources:ids.map(id=>({id,subject:'patient',question_id:id,
    components:[{origin:'answer_snapshot',text:'합성 원문과 정정의 범위를 유지합니다.'}]})),proposed_safety:{urgent:false,evidence:[]}},
    schema:object({basis:{type:'string',enum:[...bases]},reason:{type:'string',minLength:1,maxLength:600},
      evidence_ids:{type:'array',items:{type:'string',enum:ids.length?ids:['none']},minItems:0,maxItems:Math.min(count,18)}}),ids};
}
const logical=(ids,basis='unclear')=>({basis,reason:'원문의 주체·부정·시점·정정을 그대로 판단한 이유입니다.',evidence_ids:ids});

test('every source subset retains its selection set and exact authored classification/reason',()=>{
  const f=fixture(4),codec=safetyReviewSelectionTransport(f),before=structuredClone(f);
  assert.ok(codec);
  for(let mask=0;mask<16;mask++)for(const basis of bases) {
    const selected=f.ids.filter((_,index)=>mask&(1<<index)),value=logical(selected,basis);
    const wire=codec.encode(value);
    assert.deepEqual(Object.keys(wire.o.evidence_selection),f.ids);
    assert.deepEqual(codec.hydrate(wire),value);
    assert.deepEqual(codec.schema.properties.o.properties.evidence_selection.required,f.ids);
    assert.equal(codec.schema.properties.o.properties.evidence_selection.additionalProperties,false);
  }
  assert.deepEqual(f,before);
});

test('selection order is explicitly canonical source order, never an array-order preservation claim',()=>{
  const f=fixture(),codec=safetyReviewSelectionTransport(f),value=logical([f.ids[2],f.ids[0]]),before=structuredClone(value);
  assert.deepEqual(codec.hydrate(codec.encode(value)),{...value,evidence_ids:[f.ids[0],f.ids[2]]});
  assert.deepEqual(value,before);
});

for(const bad of ['missing','extra','string_boolean','null_boolean','array','wrong_binding','missing_reason','changed_basis','extra_root'])
test('strict selection-map hydration rejects '+bad,()=>{
  const f=fixture(),codec=safetyReviewSelectionTransport(f),wire=codec.encode(logical([f.ids[0]]));
  if(bad==='missing')delete wire.o.evidence_selection[f.ids[1]];
  if(bad==='extra')wire.o.evidence_selection.safety_unknown=true;
  if(bad==='string_boolean')wire.o.evidence_selection[f.ids[0]]='false';
  if(bad==='null_boolean')wire.o.evidence_selection[f.ids[0]]=null;
  if(bad==='array')wire.o.evidence_selection=[f.ids[0]];
  if(bad==='wrong_binding')wire.b='0'.repeat(32);
  if(bad==='missing_reason')delete wire.o.reason;
  if(bad==='changed_basis')wire.o.basis='approved';
  if(bad==='extra_root')wire.approved=true;
  const before=structuredClone(wire);reject(()=>codec.hydrate(wire));assert.deepEqual(wire,before);
});

test('logical duplicate and unknown IDs are rejected, never deduplicated or discarded',()=>{
  const f=fixture(),codec=safetyReviewSelectionTransport(f);
  for(const ids of [[f.ids[0],f.ids[0]],['safety_unknown']]) {
    const value=logical(ids),before=structuredClone(value);reject(()=>codec.encode(value));assert.deepEqual(value,before);
  }
});

for(const count of [0,18,19])test('source count '+count+' preserves every candidate and the original selection bound',()=>{
  const f=fixture(count),codec=safetyReviewSelectionTransport(f);assert.ok(codec);
  const selectionSchema=codec.schema.properties.o.properties.evidence_selection;
  assert.deepEqual(Object.keys(selectionSchema.properties),f.ids);
  const selected=f.ids.slice(-18),value=logical(selected),wire=codec.encode(value);
  assert.deepEqual(codec.hydrate(wire),value);
  if(count===0){assert.deepEqual(wire.o.evidence_selection,{});reject(()=>codec.encode(logical(['none'])));}
  if(count===19) {
    reject(()=>codec.encode(logical(f.ids)));
    for(const id of f.ids)wire.o.evidence_selection[id]=true;
    reject(()=>codec.hydrate(wire));
  }
});

for(const bad of ['writer','bundle','unknown_stage','missing_sources','duplicate_sources','enum_mismatch','duplicate_enum',
  'unknown_schema_keyword','extra_logical_field','unsupported_reason','unknown_basis','open_object','zero_max_mismatch'])
test('unsupported contract '+bad+' returns null without changing existing transport paths',()=>{
  const f=fixture();
  if(bad==='writer')f.stage='turn_draft';
  if(bad==='bundle')f.stage='final_review_bundle';
  if(bad==='unknown_stage')f.stage='safety_reviewish';
  if(bad==='missing_sources')delete f.payload.safety_sources;
  if(bad==='duplicate_sources')f.payload.safety_sources[1]=structuredClone(f.payload.safety_sources[0]);
  if(bad==='enum_mismatch')f.schema.properties.evidence_ids.items.enum[0]='unknown';
  if(bad==='duplicate_enum')f.schema.properties.evidence_ids.items.enum[1]=f.ids[0];
  if(bad==='unknown_schema_keyword')f.schema.allOf=[];
  if(bad==='extra_logical_field'){f.schema.properties.approved={type:'boolean'};f.schema.required.push('approved');}
  if(bad==='unsupported_reason')f.schema.properties.reason.pattern='.*';
  if(bad==='unknown_basis')f.schema.properties.basis.enum=['approved'];
  if(bad==='open_object')f.schema.additionalProperties=true;
  if(bad==='zero_max_mismatch'){f.payload.safety_sources=[];f.schema.properties.evidence_ids.items.enum=['none'];}
  const before=structuredClone(f);assert.equal(safetyReviewSelectionTransport(f),null);assert.deepEqual(f,before);
});

test('standalone final safety is supported while existing compact audit transport remains unchanged',()=>{
  const f=fixture();assert.ok(safetyReviewSelectionTransport({...f,stage:'safety_review_final'}));
  assert.equal(compactReviewTransport(f),null);
});

test('request binding and private validation preserve source provenance and resist public mutation',()=>{
  const f=fixture(),codec=safetyReviewSelectionTransport(f),value=logical([f.ids[0]]),wire=codec.encode(value);
  for(const edit of [next=>{next.stage='safety_review_final';},next=>{next.payload.safety_sources[0].components[0].text='정정된 원문';},
    next=>{next.payload.safety_sources.reverse();},next=>{next.schema.properties.reason.maxLength=500;}]) {
    const changed=structuredClone(f);edit(changed);reject(()=>safetyReviewSelectionTransport(changed).hydrate(wire));
  }
  codec.schema.properties.o.properties.evidence_selection.properties.safety_unknown={type:'boolean'};
  f.payload.safety_sources.reverse();f.schema.properties.basis.enum.push('approved');
  assert.deepEqual(codec.hydrate(wire),value);
  wire.o.evidence_selection.safety_unknown=true;reject(()=>codec.hydrate(wire));
});

test('unsafe object values cannot enter safety selection hydration',()=>{
  const f=fixture(),codec=safetyReviewSelectionTransport(f);
  for(const edit of [wire=>{Object.setPrototypeOf(wire,{injected:true});},
    wire=>{Object.defineProperty(wire.o.evidence_selection,f.ids[0],{get(){throw new Error('must not execute');}});},
    wire=>{wire.o.cycle=wire;}]) {
    const wire=codec.encode(logical([]));edit(wire);reject(()=>codec.hydrate(wire));
  }
});

test('hydration never invents evidence or bypasses the canonical current-danger gate',()=>{
  const context=structuredClone(cases.find(item=>item.id==='current_physical_danger').context);
  const request=safetyReviewRequest(relationshipQuestionRequest(context),{safety_signal:{urgent:false,evidence:[]}});
  const codec=safetyReviewSelectionTransport({stage:'safety_review',schema:request.schema,payload:request.data});assert.ok(codec);
  const empty=codec.hydrate(codec.encode(logical([],'current_physical_danger')));
  assert.throws(()=>validateSafetyReview(empty,context,request),{code:'MODEL_INVALID_RESPONSE'});
  const source=safetySources(context).find(row=>row.question_id==='risk'),value=logical([source.id],'current_physical_danger');
  const result=validateSafetyReview(codec.hydrate(codec.encode(value)),context,request);
  assert.equal(result.urgent,true);assert.equal(result.review.reason,value.reason);
  assert.ok(result.evidence.some(ref=>ref.quote===context.patient.fields.risk.rawText));
});
