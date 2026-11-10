import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {compactReviewTransport} from '../src/compact-review-transport.js';
import {auditSchema,validateAudits} from '../src/grounding-audit.js';
import {validateSchema,claimReviewRequest,validateClaimReview} from '../src/relationship-agent.js';
import {finalReviewBundle,PARTIAL_REVIEW} from '../src/final-review-bundle.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text=maxLength=>({type:'string',minLength:1,maxLength});
const issue=object({field:{type:'string',enum:['script','avoid']},reason:text(500),repair:text(600)});
const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}return value;};
const reject=fn=>assert.throws(fn,{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
function fixture(count=3) {
  const claims=Array.from({length:count},(_,index)=>({id:'script.'+index,field:'script',claim:'편한 시간을 먼저 물어볼까요? '+index,certainty:'reported'}));
  const schema=object({audits:auditSchema(claims),issues:{type:'array',maxItems:4,items:issue},approved:{type:'boolean'}});
  const payload={answers:{patient:[],supporter:[],user_goal:[]},claims,guide:{script:'편할 때 이야기해 볼까?'}};
  const logical={audits:claims.map(claim=>({id:claim.id,verdict:'supported',reason:claim.id+'의 제안은 현재 원문에 없는 동의를 확정하지 않아요.'})),issues:[],approved:true};
  return {claims,schema,payload,logical};
}
const make=(f,options={})=>compactReviewTransport({stage:'speech_review',schema:f.schema,payload:f.payload,...options});

test('short field names and positioned verdicts restore every exact model reason and approval',()=>{
  const f=fixture(),before=structuredClone(f);freeze(f);
  const codec=make(f);assert.ok(codec);
  const encoded=codec.encode(f.logical),restored=codec.hydrate(encoded);
  assert.deepEqual(restored,f.logical);assert.deepEqual(f,before);
  validateSchema(restored,f.schema);validateAudits(restored.audits,f.claims,restored.approved);
  assert.equal(encoded.o.p,true);assert.deepEqual(encoded.o.i,[]);assert.deepEqual(Object.keys(encoded.o.a),['a0','a1','a2']);
  assert.deepEqual(Object.keys(codec.schema.properties.o.properties),['a','i','p'],'retain review-before-approval decoder order');
  assert.ok(Object.values(encoded.o.a).every(row=>Object.keys(row).sort().join(',')==='r,v'));
  assert.equal(encoded.o.a.a0.r,f.logical.audits[0].reason);
  assert.match(codec.instruction,/구체적 이유를 직접 작성/);
});

for(const verdict of ['supported','plausible','unsupported'])test('all verdicts retain their complete original authored reason: '+verdict,()=>{
  const f=fixture(1);f.logical.audits[0].verdict=verdict;
  f.logical.audits[0].reason='모델이 직접 구분한 조건·부정·시점입니다. '.repeat(9);
  if(verdict!=='supported'){f.logical.approved=false;f.logical.issues=[{field:'script',reason:'현재 동의를 보고하지 않았어요.',repair:'동의를 단정한 부분을 질문으로 바꾸세요.'}];}
  const codec=make(f),encoded=codec.encode(f.logical),result=codec.hydrate(encoded);
  assert.deepEqual(result,f.logical);assert.equal(result.audits[0].reason.length,f.logical.audits[0].reason.length);
  if(verdict!=='supported')assert.deepEqual(encoded.o.i,[{f:'script',r:f.logical.issues[0].reason,x:f.logical.issues[0].repair}]);
});

for(const bad of ['missing_approval','missing_issues','missing_audit','extra_audit','unknown_code','wrong_position','whole_order_swap','null_reason','empty_reason','long_reason','legacy_array','extra_root','extra_body','wrong_binding'])
  test('strict hydration rejects '+bad+' without normalizing the rejected output',()=>{
    const f=fixture(),codec=make(f),wire=codec.encode(f.logical);
    if(bad==='missing_approval')delete wire.o.p;
    if(bad==='missing_issues')delete wire.o.i;
    if(bad==='missing_audit')delete wire.o.a.a2;
    if(bad==='extra_audit')wire.o.a.a3=structuredClone(wire.o.a.a0);
    if(bad==='unknown_code')wire.o.a.a0.v='unknown';
    if(bad==='wrong_position')wire.o.a.a0.v=wire.o.a.a1.v;
    if(bad==='whole_order_swap')[wire.o.a.a0,wire.o.a.a1]=[wire.o.a.a1,wire.o.a.a0];
    if(bad==='null_reason')wire.o.a.a0.r=null;
    if(bad==='empty_reason')wire.o.a.a0.r='';
    if(bad==='long_reason')wire.o.a.a0.r='x'.repeat(501);
    if(bad==='legacy_array')wire.o.a=f.logical.audits;
    if(bad==='extra_root')wire.other=true;
    if(bad==='extra_body')wire.o.approved=true;
    if(bad==='wrong_binding')wire.b='0'.repeat(32);
    const before=structuredClone(wire);reject(()=>codec.hydrate(wire));assert.deepEqual(wire,before);
  });

test('original semantic gates still reject an explicitly inconsistent compact approval',()=>{
  const f=fixture(1);f.logical.audits[0].verdict='unsupported';
  const codec=make(f),result=codec.hydrate(codec.encode(f.logical));
  assert.equal(result.approved,true);assert.equal(result.audits[0].verdict,'unsupported');
  assert.throws(()=>validateClaimReview(result,f.schema,f.claims),{modelReason:'agent_claim_audit'});
  // The codec represents the actual model judgment; it does not repair it.
});

test('per-slot grammar and private validation both reject duplicate or swapped codes',()=>{
  const f=fixture(),codec=make(f);
  for(const edit of [wire=>{wire.o.a.a1.v=wire.o.a.a0.v;},wire=>{wire.o.a.a1.v='0.1';},
    wire=>{[wire.o.a.a0,wire.o.a.a1]=[wire.o.a.a1,wire.o.a.a0];}]) {
    const wire=codec.encode(f.logical);edit(wire);
    assert.throws(()=>validateSchema(wire,codec.schema),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
    reject(()=>codec.hydrate(wire));
  }
});

test('missing, duplicate and reordered logical claim IDs cannot be silently encoded',()=>{
  const f=fixture(),codec=make(f);
  for(const edit of [value=>value.audits.pop(),value=>{value.audits[1].id=value.audits[0].id;},value=>{value.audits.reverse();}]) {
    const value=structuredClone(f.logical);edit(value);reject(()=>codec.encode(value));
  }
});

test('binding follows stage, complete source payload, candidate, schema and actual request member order',()=>{
  const f=fixture(),codec=make(f),wire=codec.encode(f.logical);
  for(const changed of [
    {stage:'speech_review_after_repair'},
    {payload:{...f.payload,answers:{...f.payload.answers,patient:[{text:'명시적인 새 정정'}]}}},
    {payload:{...f.payload,guide:{script:'현재 후보가 바뀌었어요.'}}},
    {schema:{...f.schema,description:'new review policy'}},
  ])reject(()=>make(f,changed).hydrate(wire));
  const reordered={...f,payload:Object.fromEntries(Object.entries(f.payload).reverse())};
  reject(()=>make(reordered).hydrate(wire));
});

test('public schema and later request mutation cannot poison a codec already bound to its private contract',()=>{
  const f=fixture(),codec=make(f),wire=codec.encode(f.logical),before=structuredClone(f.logical);
  codec.schema.properties.o.properties.a.properties.a0.properties.v.enum.push('forged');
  codec.schema.properties.o.properties.a.properties.a0.properties.r.maxLength=10000;
  f.schema.properties.audits.items.properties.reason.maxLength=10000;f.payload.guide.script='changed';
  const first=codec.hydrate(wire);first.audits[0].reason='changed';assert.deepEqual(codec.hydrate(wire),before);
  wire.o.a.a0.v='forged';reject(()=>codec.hydrate(wire));
});

test('guidance and avoidance branches retain their own original verdict semantics and claim ordering',()=>{
  const f=fixture(2);f.claims[1].field='avoid';f.claims[1].id='avoid.0';
  f.schema.properties.audits=auditSchema(f.claims);f.payload.claims=f.claims;
  const request=claimReviewRequest(f.payload,f.schema),codec=compactReviewTransport({stage:'speech_review',schema:request.schema,payload:request.payload});
  assert.ok(codec);
  const logical={audits:[{id:'script.0',verdict:'sound_guidance',reason:'먼저 의사를 묻는 제안이에요.'},
    {id:'avoid.0',verdict:'sound_avoidance',reason:'재촉하는 발화를 피하도록 구분해요.'}],issues:[],approved:true};
  const wire=codec.encode(logical);assert.deepEqual(codec.hydrate(wire),logical);
  assert.equal(request.validate(codec.hydrate(wire)).audits[1].verdict,'supported');
  wire.o.a.a0.v=wire.o.a.a1.v;assert.throws(()=>validateSchema(wire,codec.schema),{modelReason:'agent_schema'});reject(()=>codec.hydrate(wire));
});

test('different reason constraints across a group retain the original uncompressed contract',()=>{
  const f=fixture(2),base=f.schema.properties.audits.items;
  f.schema.properties.audits.items={anyOf:f.claims.map((claim,index)=>({...base,properties:{...base.properties,
    id:{type:'string',enum:[claim.id]},reason:{...base.properties.reason,maxLength:index?400:500}}}))};
  assert.equal(make(f),null);
});

test('typed unknown-state audits keep their model reason and verdict distinct from ordinary claims',()=>{
  const f=fixture(2),unknown='patient_state.unknowns.0';
  f.claims[1]={id:unknown,certainty:'unknown',claim:'연락할 수 있는 시간은 아직 모른다고 했어요.'};
  const base=f.schema.properties.audits.items;
  const schema=object({state:object({...f.schema.properties,audits:{...f.schema.properties.audits,items:{anyOf:[
    {...base,properties:{...base.properties,id:{type:'string',enum:[unknown]},verdict:{type:'string',enum:['still_unknown','already_answered','not_needed','review_uncertain']}}},
    {...base,properties:{...base.properties,id:{type:'string',enum:['script.0']}}},
  ]}}}),questions:{type:'null'},safety:{type:'null'}});
  const payload={review_target:{claims:f.claims},questions:null,safety:null};
  const codec=compactReviewTransport({stage:'turn_review',schema,payload});assert.ok(codec);
  const logical={state:{audits:[f.logical.audits[0],{id:unknown,verdict:'still_unknown',reason:'원문이 가능한 시간을 아직 모른다고 명시해요.'}],issues:[],approved:true},questions:null,safety:null};
  assert.deepEqual(codec.hydrate(codec.encode(logical)),logical);
});

test('a provider derives every mixed-branch and later-task verdict from public metadata only',()=>{
  const first=fixture(2),unknown='patient_state.unknowns.0';
  first.claims[1]={id:unknown,certainty:'unknown',claim:'대화 가능한 시간은 아직 확인되지 않았어요.'};
  const base=first.schema.properties.audits.items;
  const stateSchema=object({state:object({audits:{...first.schema.properties.audits,items:{anyOf:[
    {...base,properties:{...base.properties,id:{type:'string',enum:[unknown]},verdict:{type:'string',enum:['still_unknown','already_answered','not_needed','review_uncertain']}}},
    {...base,properties:{...base.properties,id:{type:'string',enum:[first.claims[0].id]}}},
  ]}},issues:{type:'array',maxItems:3,items:object({reason:text(500),repair:text(600)})},approved:{type:'boolean'}}),questions:{type:'null'},safety:{type:'null'}});
  const statePayload={review_target:{claims:first.claims},questions:null,safety:null};
  const stateLogical={state:{audits:[first.logical.audits[0],{id:unknown,verdict:'review_uncertain',reason:'현재 원문만으로 가능한 시간을 판정하기 어려워요.'}],
    issues:[{reason:'가능한 시간의 범위가 모호해요.',repair:'현재 확인된 시간과 아직 확인되지 않은 범위를 나누세요.'}],approved:false},questions:null,safety:null};
  const second=fixture(1);second.claims[0].id='care.0';second.schema.properties.audits=auditSchema(second.claims);
  const careLogical={audits:[{id:'care.0',verdict:'unsupported',reason:'아직 보고되지 않은 동의를 확정했어요.'}],
    issues:[{field:'script',reason:'동의 보고가 없어요.',repair:'현재 동의한 것처럼 단정하지 말고 가능 여부를 물으세요.'}],approved:false};
  const requests=[{key:'state',stage:'turn_review',prompt:'독립 상태 검토',payload:statePayload,schema:stateSchema,validate:value=>value},
    {key:'care',stage:'speech_review_card_care',prompt:'독립 카드 검토',payload:second.payload,schema:second.schema,validate:value=>value}];
  const bundle=finalReviewBundle(requests,validateSchema),codec=compactReviewTransport({stage:'final_review_bundle_initial',schema:bundle.schema,payload:bundle.payload});
  assert.ok(codec);
  // This provider uses only the requested schema, public instruction table and
  // its own semantic decisions. It never calls encode or reads private rows.
  const table=JSON.parse(codec.instruction.split('대응표: ').at(-1));
  const decisions=new Map([...stateLogical.state.audits,...careLogical.audits].map(row=>[row.id,row]));
  const wire={b:codec.schema.properties.b.enum[0],o:{state:{state:{a:{},i:stateLogical.state.issues.map(({reason,repair})=>({r:reason,x:repair})),p:false},questions:null,safety:null},
    care:{a:{},i:careLogical.issues.map(({field,reason,repair})=>({f:field,r:reason,x:repair})),p:false}}};
  for(const mapping of table.a) {
    assert.equal(mapping.length,4);
    const [path,id,tableIndex,prefix]=mapping,decision=decisions.get(id),index=table.v[tableIndex].indexOf(decision.verdict);
    assert.ok(index>=0);assert.equal(typeof prefix,'string');
    const value={v:prefix+'.'+index,r:decision.reason},parts=path.replace(/\[(\d+)\]/gu,'.$1').split('.');
    let container=wire,node=codec.schema;
    for(const [position,key]of parts.entries()) {
      node=/^\d+$/u.test(key)?node.items:node.properties[key];
      if(position===parts.length-1)container[key]=value;else container=container[key];
    }
    assert.ok(node.properties.v.enum.includes(value.v));
  }
  assert.equal(table.a.find(row=>row[1]==='care.0')[3],'2','second task local index zero has a nonzero global prefix');
  assert.deepEqual(bundle.validate(codec.hydrate(wire)),{state:stateLogical,care:careLogical});
});

test('v4 request binding rejects otherwise valid responses carrying earlier bindings',()=>{
  const f=fixture(),codec=make(f),wire=codec.encode(f.logical);
  for(const version of ['compact-review-output-v2','compact-review-output-v3']){
    wire.b=createHash('sha256').update(JSON.stringify([version,'speech_review',f.schema,f.payload])).digest('hex').slice(0,32);
    reject(()=>codec.hydrate(wire));
  }
});

function bundleFixture(partial=false) {
  const first=fixture(2),second=fixture(1);second.claims[0].id='care.0';second.schema.properties.audits=auditSchema(second.claims);
  second.logical.audits[0].id='care.0';second.payload.claims=second.claims;
  const quality={key:'quality',stage:'guide_quality',prompt:'독립 품질 검토',payload:{guide:first.payload.guide},
    schema:object({improvements:{type:'array',maxItems:2,items:issue}}),validate:value=>value};
  const requests=[{key:'card_script',stage:'speech_review_card_script',prompt:'독립 script 검토',payload:first.payload,schema:first.schema,validate:value=>value},
    {key:'card_care',stage:'speech_review_card_care',prompt:'독립 care 검토',payload:second.payload,schema:second.schema,validate:value=>value},quality];
  const bundle=finalReviewBundle(requests,validateSchema,{partial}),logical={card_script:first.logical,card_care:second.logical,quality:{improvements:[]}};
  const codec=compactReviewTransport({stage:'final_review_bundle_initial',schema:bundle.schema,payload:bundle.payload,partial});
  return {bundle,logical,codec};
}

test('a real final bundle resolves shared inputs and retains every audit and quality decision',()=>{
  const {bundle,logical,codec}=bundleFixture();assert.ok(codec);
  const wire=codec.encode(logical),restored=codec.hydrate(wire);
  assert.deepEqual(restored,logical);assert.deepEqual(bundle.validate(restored),logical);
  assert.deepEqual(wire.o.quality,{m:[]});
  [wire.o.card_script.a.a0,wire.o.card_care.a.a0]=[wire.o.card_care.a.a0,wire.o.card_script.a.a0];
  reject(()=>codec.hydrate(wire));
});

test('a zero-audit sibling stays exactly empty without sending an unsupported empty enum',()=>{
  const full=fixture(1),empty=fixture(0),requests=[{key:'full',stage:'analysis_review',prompt:'검토',payload:full.payload,schema:full.schema,validate:value=>value},
    {key:'empty',stage:'analysis_review',prompt:'검토',payload:empty.payload,schema:empty.schema,validate:value=>value}];
  const bundle=finalReviewBundle(requests,validateSchema),codec=compactReviewTransport({stage:'final_review_bundle',schema:bundle.schema,payload:bundle.payload});
  assert.ok(codec);
  const logical={full:full.logical,empty:empty.logical},wire=codec.encode(logical);
  assert.deepEqual(wire.o.empty.a,{});assert.deepEqual(codec.hydrate(wire),logical);
  assert.deepEqual(codec.schema.properties.o.properties.empty.properties.a,object({}));
  wire.o.empty.a.a0={v:wire.o.full.a.a0.v,r:'새 검토를 추가하면 안 돼요.'};reject(()=>codec.hydrate(wire));
});

for(const bad of ['missing','invalid_audit','invalid_quality'])test('partial recovery marks a whole unresolved task without inventing approval: '+bad,()=>{
  const {bundle,logical,codec}=bundleFixture(true),wire=codec.encode(logical);
  if(bad==='missing')delete wire.o.card_care;
  if(bad==='invalid_audit')delete wire.o.card_care.a.a0;
  if(bad==='invalid_quality')wire.o.quality.m=null;
  const result=codec.hydrate(wire),validated=bundle.validate(result);
  assert.equal(validated[PARTIAL_REVIEW],true);assert.deepEqual(result.card_script,logical.card_script);
  const key=bad==='invalid_quality'?'quality':'card_care';
  assert.equal(result[key],undefined);assert.equal(Object.hasOwn(validated,key),false);
  const strict=bundleFixture().codec;reject(()=>strict.hydrate(wire));
});

for(const bad of ['binding','extra_task','extra_root','missing_body'])test('partial recovery still rejects ambiguous envelope '+bad,()=>{
  const {logical,codec}=bundleFixture(true),wire=codec.encode(logical);
  if(bad==='binding')wire.b='stale';
  if(bad==='extra_task')wire.o.unrequested={};
  if(bad==='extra_root')wire.extra={};
  if(bad==='missing_body')delete wire.o;
  reject(()=>codec.hydrate(wire));
});

test('partial recovery preserves an earlier real rejection while a later quality output is unresolved',()=>{
  const {bundle,logical,codec}=bundleFixture(true);
  logical.card_script.approved=false;logical.card_script.audits[0].verdict='unsupported';
  logical.card_script.issues=[{field:'script',reason:'현재 동의가 확인되지 않았어요.',repair:'동의를 이미 받은 전제를 제거하세요.'}];
  const wire=codec.encode(logical);wire.o.quality.m=null;
  const restored=codec.hydrate(wire),reviewed=bundle.validate(restored);
  assert.deepEqual(reviewed.card_script,logical.card_script);assert.equal(reviewed.card_script.approved,false);
  assert.equal(reviewed.quality,undefined);assert.equal(reviewed[PARTIAL_REVIEW],true);
});

test('quality improvements are retained even when every sibling audit and approval passes',()=>{
  const {logical,codec}=bundleFixture();
  logical.quality.improvements=[{field:'script',reason:'관찰 장면이 일반적인 위로로 바뀌었어요.',repair:'원문의 구체적인 관찰 장면을 질문에 남기세요.'}];
  assert.deepEqual(codec.hydrate(codec.encode(logical)),logical);
});

test('partial mode uses private task schemas after the public wire schema is mutated',()=>{
  const {logical,codec}=bundleFixture(true),wire=codec.encode(logical);
  const exposed=codec.schema.properties.o.properties.card_script;
  exposed.properties.injected={type:'string'};exposed.required.push('injected');
  wire.o.card_script.injected='must not be silently discarded';
  const result=codec.hydrate(wire);
  assert.equal(result.card_script,undefined);assert.deepEqual(result.card_care,logical.card_care);
});

for(const bad of ['duplicate_ids','unknown_verdict','missing_claim','wrong_count','unknown_field','unsupported_keyword','writer'])
  test('unsupported '+bad+' keeps the original transport',()=>{
    const f=fixture();let options={};
    if(bad==='duplicate_ids')f.schema.properties.audits.items.properties.id.enum.push('script.0');
    if(bad==='unknown_verdict')f.schema.properties.audits.items.properties.verdict.enum=['approved','rejected'];
    if(bad==='missing_claim')f.payload.claims.pop();
    if(bad==='wrong_count')f.schema.properties.audits.minItems=0;
    if(bad==='unknown_field'){f.schema.properties.new_required={type:'boolean'};f.schema.required.push('new_required');}
    if(bad==='unsupported_keyword')f.schema.allOf=[];
    if(bad==='writer')options={stage:'guide_write'};
    const before=structuredClone(f);assert.equal(make(f,options),null);assert.deepEqual(f,before);
  });

test('no-audit and unknown safety/continuation shapes fall back without creating new decisions',()=>{
  assert.equal(compactReviewTransport({stage:'plan_review',schema:object({approved:{type:'boolean'},issues:{type:'array',maxItems:1,items:issue}}),payload:{}}),null);
  const f=fixture(0);assert.equal(make(f),null);
  assert.equal(compactReviewTransport({stage:'continuation_context_review',schema:f.schema,payload:f.payload}),null);
});

test('non-JSON accessors, prototypes, hidden properties and cyclic candidates cannot enter hydration',()=>{
  const f=fixture(),codec=make(f);
  for(const change of [wire=>{Object.setPrototypeOf(wire,{injected:true});},wire=>{Object.defineProperty(wire,'hidden',{value:true});},
    wire=>{Object.defineProperty(wire.o.a.a0,'r',{get(){throw new Error('must not execute');}});},wire=>{wire.o.cycle=wire;}]) {
    const wire=codec.encode(f.logical);change(wire);reject(()=>codec.hydrate(wire));
  }
});

test('synthetic compact output reduces bytes while retaining all reasons and failure repairs',t=>{
  const f=fixture(24);f.logical.approved=false;
  f.logical.audits.at(-1).verdict='unsupported';
  f.logical.issues=[{field:'script',reason:'상대가 동의했다는 보고가 없어요. '.repeat(10),repair:'동의를 단정한 표현을 제거하고 가능 여부를 먼저 물어보세요. '.repeat(8)}];
  const codec=make(f),wire=codec.encode(f.logical),bytes=value=>Buffer.byteLength(JSON.stringify(value));
  assert.deepEqual(codec.hydrate(wire),f.logical);assert.ok(bytes(wire)<bytes(f.logical));
  t.diagnostic(JSON.stringify({synthetic_only:true,audits:f.claims.length,logical_output_bytes:bytes(f.logical),compact_output_bytes:bytes(wire),
    logical_schema_bytes:bytes(f.schema),compact_schema_and_instruction_bytes:bytes({schema:codec.schema,instruction:codec.instruction}),
    reasons_preserved:true,repair_characters:f.logical.issues[0].repair.length,model_calls:0,tokens_measured:false,time_measured:false}));
});
