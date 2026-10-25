import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { safetySources } from '../src/relationship-agent.js';
import { TRIAGE_VERSION, triageSources } from '../src/risk-classification.js';
import { createReferralDirectory } from '../src/referral-directory.js';
import { createModelReferralProvider, referralEvidenceMap } from '../src/referral-provider.js';
import { routeInstitutions } from '../src/institution-routing.js';
import { HttpError } from '../src/errors.js';

const directory = createReferralDirectory();
const eligibilityById = JSON.parse(readFileSync(new URL('../seeds/referral-eligibility.json', import.meta.url)));
const context = () => ({patient:{fields:{describe:{id:'describe', status:'answered', text:'상담 도움을 요청했다는 합성 보고입니다.'}}}, supporter:{fields:{}}, user_goal:{}});
const input = () => {
  const ctx = context();
  return {schema_version:'1.0', subject:'patient', context:ctx, sources:safetySources(ctx), institutions:directory.list().institutions,
    intake_id:'11111111-2222-4333-8444-555555555555', revision:0, request_id:'synthetic', signal:new AbortController().signal,
    existing_safety:{urgent:false,evidence_source_ids:[]}};
};
const finding = (data, extra = {}) => ({signals:[{code:'mental_health_concern', person:'patient', assertion:'reported',
  timeframe:'current', report_type:'patient_words', statement:'합성 보고.', source_ids:[triageSources(data.context)[0].id], ...extra}], unknowns:[]});
const configured = (data, value, options = {}) => {
  const calls = [];
  const gateway = {async operation(_options, fn) {return fn({controller:new AbortController()});},
    async agentComplete(stage, _prompt, request, _schema, _op, validate) {
      calls.push({stage, data:request}); return validate(structuredClone(value));
    }};
  const provider = createModelReferralProvider({gateway, eligibilityById, modelVersion:'synthetic',
    resolveRoutingContext:() => ({country:'KR',region:null,age:null,requester:'supporter'}),
    now:() => new Date('2026-10-18T09:00:00Z'), ...options});
  return {provider, calls};
};

test('provider joins whole source bundles and returns registered general counseling IDs only', async () => {
  const data = input(), {provider,calls} = configured(data, finding(data));
  const result = await provider(data);
  assert.equal(result.urgency, 'planned'); assert.equal(result.reviewed, true);
  assert.deepEqual(result.institution_ids, ['kr-mental-health-15770199']);
  assert.deepEqual(result.evidence_source_ids, data.sources.map(source => source.id));
  assert.equal(result.safety_alert, undefined); assert.equal(calls.length, 2);
  assert.equal(JSON.stringify(calls).includes('1577-0199'), false);
  assert.equal(Object.hasOwn(result, 'findings'), false);
  assert.deepEqual(result.concerns, [{code:'mental_health_concern', subject:'patient',
    evidence_source_ids:data.sources.map(source => source.id)}]);
});

test('ordinary concerns require reported evidence but preserve actual person and omit name-only signals', async () => {
  const data = input();
  data.context.patient.fields.name = {id:'name', status:'answered', text:'합성 이름'};
  data.sources = safetySources(data.context);
  const sources = triageSources(data.context);
  const source = sources.find(row => row.question_id === 'describe').id;
  const name = sources.find(row => row.question_id === 'name').id;
  const value = finding(data, {person:'supporter', assertion:'uncertain', source_ids:[source]});
  value.signals.push({...value.signals[0], person:'other', assertion:'reported', code:'support_requested'},
    {...value.signals[0], assertion:'negated', code:'self_harm_action'},
    {...value.signals[0], assertion:'hypothetical', code:'immediate_violence'},
    {...value.signals[0], assertion:'reported', source_ids:[name]});
  const result = await configured(data, value).provider(data);
  const id = data.sources.find(row => row.question_id === 'describe').id;
  assert.deepEqual(result.concerns, [
    {code:'support_requested', subject:'other', evidence_source_ids:[id]},
  ]);
  assert.equal(JSON.stringify(result.concerns).includes('statement'), false);
});

test('evidence join rejects changed content, subject, ID and repeated entries', () => {
  const data = input();
  for (const alter of [rows => rows[0].components[0].text += '변경', rows => rows[0].subject = 'supporter',
    rows => rows[0].id = 'safety_forged', rows => rows.push(rows[0])]) {
    const rows = structuredClone(data.sources);
    alter(rows);
    assert.throws(() => referralEvidenceMap(data.context, rows), {code:'REFERRAL_SOURCE_MISMATCH'});
  }
  data.context.patient.fields.describe.custom = '별도 합성 입력입니다.';
  const rows = safetySources(data.context); rows[0].components.reverse();
  assert.throws(() => referralEvidenceMap(data.context, rows), {code:'REFERRAL_SOURCE_MISMATCH'});
});

test('uncertain, historical, unknown-time and unclear-person ordinary findings do not create a card', async () => {
  for (const code of ['mental_health_concern','substance_use_concern','support_requested']) {
    for (const extra of [{assertion:'uncertain'},{timeframe:'past'},{timeframe:'unknown'},{person:'unclear'}]) {
      const data=input();
      const result=await configured(data,finding(data,{code,...extra})).provider(data);
      assert.deepEqual(result.concerns,[]);
      assert.equal(result.safety_alert,undefined);
    }
  }
});

test('an ordinary concern selected by just one classifier does not create a card', async () => {
  const data=input();
  for (const second of [{signals:[],unknowns:[]},finding(data,{assertion:'uncertain'}),finding(data,{person:'supporter'})]) {
    const responses=[finding(data),second];
    const gateway={async operation(_options,run){return run({controller:new AbortController()});},
      async agentComplete(_stage,_prompt,_request,_schema,_operation,validate){return validate(responses.shift());}};
    const result=await configured(data,null,{gateway}).provider(data);
    assert.equal(result.reviewed,false);
    assert.deepEqual(result.concerns,[]);
  }
});

test('partial classifier failure suppresses ordinary concerns without dropping serious evidence', async () => {
  for (const [code,count] of [['mental_health_concern',0],['wish_to_die_or_self_harm_concern',1]]) {
    const data=input(); let calls=0;
    const gateway={async operation(_options,run){return run({controller:new AbortController()});},
      async agentComplete(_stage,_prompt,_request,_schema,_operation,validate){
        if(calls++)throw new HttpError(502,'MODEL_UPSTREAM_ERROR','synthetic failure');
        return validate(finding(data,{code}));
      }};
    const result=await configured(data,null,{gateway}).provider(data);
    assert.equal(result.concerns.length,count);
    assert.equal(result.reviewed,false);
    assert.equal(result.urgency,count?'soon':'undetermined');
  }
});

test('uncertain serious evidence keeps its original safety path', async () => {
  const data=input(), result=await configured(data,finding(data,{code:'self_harm_action',assertion:'uncertain'})).provider(data);
  assert.equal(result.urgency,'soon');
  assert.deepEqual(result.concerns,[{code:'self_harm_action',subject:'patient',evidence_source_ids:data.sources.map(row=>row.id)}]);
});

test('two classifiers with no relevant concern produce no counseling evidence', async () => {
  const data=input(),result=await configured(data,{signals:[],unknowns:[]}).provider(data);
  assert.equal(result.urgency,'undetermined');
  assert.deepEqual(result.concerns,[]);
  assert.deepEqual(result.evidence_source_ids,[]);
});

test('patient urgency and a supporter emergency remain separate at provider output', async () => {
  const data = input(), value = finding(data, {code:'physical_emergency', person:'supporter'});
  const {provider,calls} = configured(data,value), result = await provider(data);
  assert.equal(result.urgency, 'undetermined'); assert.equal(result.reviewed, false);
  assert.deepEqual(result.evidence_source_ids, []);
  assert.deepEqual(result.safety_alert, {urgency:'immediate', subjects:['supporter'], evidence_source_ids:data.sources.map(row => row.id)});
  assert.deepEqual(result.institution_ids, ['kr-emergency-medical-119']); assert.equal(calls.length, 1);
});

test('non-patient serious concern retains soon alert without becoming patient evidence', async () => {
  for (const person of ['supporter','other','unclear']) {
    const data = input(), {provider} = configured(data, finding(data, {code:'wish_to_die_or_self_harm_concern',person}));
    const result = await provider(data);
    assert.equal(result.urgency, 'undetermined'); assert.equal(result.safety_alert.urgency, 'soon');
    assert.deepEqual(result.safety_alert.subjects, [person]); assert.deepEqual(result.evidence_source_ids, []);
    assert.deepEqual(result.institution_ids, ['kr-suicide-prevention-109']);
  }
});

test('prompt patient concern remains soon and requires review', async () => {
  const data = input(), {provider} = configured(data, finding(data, {code:'wish_to_die_or_self_harm_concern'}));
  const result = await provider(data);
  assert.equal(result.urgency, 'soon'); assert.equal(result.reviewed, false);
  assert.equal(result.safety_alert, undefined); assert.deepEqual(result.institution_ids, ['kr-suicide-prevention-109']);
});

test('physical and violence emergencies select different verified services', async () => {
  for (const [code,id] of [['physical_emergency','kr-emergency-medical-119'],['immediate_violence','kr-police-112']]) {
    const data = input(), {provider} = configured(data, finding(data, {code}));
    const result = await provider(data);
    assert.equal(result.urgency, 'immediate'); assert.deepEqual(result.institution_ids, [id]);
  }
});

test('past violence does not divert a current medical emergency to police', async () => {
  const data = input(), value = finding(data, {code:'physical_emergency'});
  value.signals.push({...value.signals[0],code:'immediate_violence',timeframe:'past'});
  const {provider} = configured(data, value);
  assert.deepEqual((await provider(data)).institution_ids, ['kr-emergency-medical-119']);
});

test('unknown country and expired validation yield no institution without lowering urgency', async () => {
  const data = input(), value = finding(data, {code:'physical_emergency'});
  for (const options of [
    {resolveRoutingContext:() => ({country:null,region:null,age:null,requester:'supporter'})},
    {now:() => new Date('2027-01-17T00:00:00Z')},
  ]) {
    const result = await configured(data, value, options).provider(data);
    assert.equal(result.urgency, 'immediate'); assert.deepEqual(result.institution_ids, []);
  }
});

test('trusted existing urgent evidence bypasses the model and retains uncertain actor alert', async () => {
  const data = input(); data.existing_safety = {urgent:true, evidence_source_ids:data.sources.map(row => row.id)};
  const {provider,calls} = configured(data, finding(data)), result = await provider(data);
  assert.equal(calls.length, 0); assert.equal(result.urgency, 'undetermined');
  assert.equal(result.safety_alert.urgency, 'immediate'); assert.deepEqual(result.safety_alert.subjects, ['unclear']);
  assert.deepEqual(result.institution_ids, ['kr-emergency-medical-119','kr-police-112']);
});

test('existing urgent flags without current evidence are rejected', async () => {
  for (const ids of [[],['safety_forged']]) {
    const data = input(); data.existing_safety = {urgent:true,evidence_source_ids:ids};
    await assert.rejects(configured(data, finding(data)).provider(data), {code:'REFERRAL_SOURCE_MISMATCH'});
  }
});

test('an incomplete HTTP contract cannot silently assume no existing urgent state', async () => {
  const data = input(); delete data.existing_safety;
  const {provider,calls} = configured(data, finding(data));
  await assert.rejects(provider(data), {code:'REFERRAL_SOURCE_MISMATCH'}); assert.equal(calls.length,0);
});

test('complete model failure reaches the HTTP unavailable path instead of becoming a reviewed plan', async () => {
  const data = input();
  const {provider} = configured(data, finding(data), {gateway:{
    async operation(_opts, fn) {return fn({controller:new AbortController()});},
    async agentComplete() {throw new HttpError(502, 'MODEL_UPSTREAM_ERROR', 'private diagnostic');},
  }});
  await assert.rejects(provider(data), {code:'REFERRAL_MODEL_UNAVAILABLE'});
});

test('eligibility, clock and catalog errors do not erase an emergency already classified', async () => {
  for (const options of [
    {resolveRoutingContext:() => {throw Error('private resolver error');}},
    {resolveRoutingContext:() => ({country:'unsupported'})},
    {resolveRoutingContext:() => new Promise(() => {})},
    {now:() => new Date('invalid')},
  ]) {
    const data = input(), result = await configured(data, finding(data, {code:'physical_emergency'}),options).provider(data);
    assert.equal(result.urgency,'immediate'); assert.deepEqual(result.institution_ids,[]);
    assert.equal(JSON.stringify(result).includes('private'),false);
  }
  const data = input(); data.institutions = [{}];
  const result = await configured(data,finding(data,{code:'physical_emergency'})).provider(data);
  assert.equal(result.urgency,'immediate'); assert.deepEqual(result.institution_ids,[]);
});

test('ordinary substance concern is not claimed to match a verified addiction specialist', async () => {
  const data=input(), result=await configured(data,finding(data,{code:'substance_use_concern'})).provider(data);
  assert.equal(result.urgency,'planned'); assert.deepEqual(result.institution_ids,[]);
});

test('routing failure has a sanitized diagnostic distinct from a legitimate no-match', async () => {
  const diagnostics=[], data=input();
  const options={onDiagnostic:event => diagnostics.push(event),resolveRoutingContext:() => {throw Error('private conversation');}};
  const result=await configured(data,finding(data,{code:'physical_emergency'}),options).provider(data);
  assert.equal(result.urgency,'immediate');
  assert.deepEqual(diagnostics,[{event:'referral_routing_failed',code:'REFERRAL_ROUTING_UNAVAILABLE'}]);
  diagnostics.length=0;
  await configured(data,finding(data,{code:'substance_use_concern'}),{onDiagnostic:event => diagnostics.push(event)}).provider(data);
  assert.deepEqual(diagnostics,[]);
  const urgent=await configured(data,finding(data,{code:'physical_emergency'}),{...options,onDiagnostic:() => {throw Error('sink failure');}}).provider(data);
  assert.equal(urgent.urgency,'immediate');
});

test('async diagnostic rejection is handled without waiting or losing an urgent result', async () => {
  const data=input(), result=await configured(data,finding(data,{code:'physical_emergency'}),{
    resolveRoutingContext:() => {throw Error('routing failure');},
    onDiagnostic:async () => {throw Error('synthetic async sink failure');},
  }).provider(data);
  assert.equal(result.urgency,'immediate'); assert.deepEqual(result.institution_ids,[]);
  await new Promise(resolve => setImmediate(resolve));
});

test('cancelled request does not invoke a model', async () => {
  const data = input(), controller = new AbortController(); data.signal = controller.signal; controller.abort();
  const {provider,calls} = configured(data, finding(data));
  await assert.rejects(provider(data), {code:'TRIAGE_CANCELLED'}); assert.equal(calls.length,0);
});

test('context mutation while resolving eligibility invalidates the result', async () => {
  const data = input();
  const {provider} = configured(data, finding(data), {resolveRoutingContext:() => {
    data.context.patient.fields.describe.text += '변경';
    return {country:'KR',region:null,age:null,requester:'supporter'};
  }});
  await assert.rejects(provider(data), {code:'TRIAGE_STALE'});
});

test('a scope mismatch cannot fall back to an unrelated specialty contact', () => {
  const base = {version:TRIAGE_VERSION,intake_id:input().intake_id,revision:0,snapshot_id:'a'.repeat(64),
    action:'prompt_assessment',status:'needs_review',service_needs:[],professional_review_required:true};
  const catalog = {institutions:directory.list().institutions,eligibilityById};
  const ctx = {country:'KR',region:null,age:null,requester:'supporter',asOf:'2026-10-18'};
  assert.deepEqual(routeInstitutions({...base,routing_signals:['abuse_or_neglect']},catalog,ctx).institution_ids, []);
  assert.deepEqual(routeInstitutions({...base,routing_signals:[]},catalog,ctx).institution_ids, ['kr-mental-health-15770199']);
});
