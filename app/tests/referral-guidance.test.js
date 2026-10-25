import test from 'node:test';
import assert from 'node:assert/strict';
import { createIntake, answerIntake, buildContext, prepareModelAnswer } from '../src/intake.js';
import { safetySources } from '../src/relationship-agent.js';
import { HttpError } from '../src/errors.js';
import { createReferralGuidance } from '../src/referral-guidance.js';
import { createReferralDirectory } from '../src/referral-directory.js';
import { createCharacterRegistry } from '../src/guide-characters.js';

const intake = (text = '검증을 위한 가상의 당사자') => answerIntake(createIntake(), {question_id:'name', text});
const directory = () => createReferralDirectory({schema_version:'1.0', institutions:[{
  id:'synthetic-center', name:'합성 검증 기관', active:true,
  urgencies:['immediate', 'soon', 'planned', 'undetermined'], phone:null,
  booking_url:'https://counseling.example.invalid/book', last_verified_on:'2026-10-18',
}]});
const plan = request => ({schema_version:'1.0', subject:'patient', urgency:'planned', reviewed:true,
  evidence_source_ids:[request.sources[0].id], institution_ids:['synthetic-center'], model_version:'synthetic-v1'});
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};
function fixture(options = {}) {
  let row = {id:'intake-a', revision:4, state:intake()};
  const store = {async intake(owner, id) {
    if (owner !== 'owner-a' || id !== 'intake-a' || !row) throw new HttpError(404, 'NOT_FOUND', '없어요.');
    return structuredClone(row);
  }};
  const service = createReferralGuidance({store, directory:directory(), ...options});
  return {service, assess:(input = {revision:4}) => service.assess('owner-a', 'intake-a', input, 'request-a'),
    row:() => structuredClone(row), replace:value => { row = value; }};
}
function markUrgent(f) {
  const row = f.row(), sources = safetySources(buildContext(row.state));
  row.state.status = 'ready';
  row.state.safetySignal = {urgent:true, review:{basis:'current_physical_danger'}, evidence:sources.flatMap(source =>
    [...new Set(source.components.map(c => c.text))].map(quote => ({subject:source.subject,question_id:source.question_id,quote})))};
  f.replace(row);
}
function saveConversation(f, text = '  제가 요즘 힘들어요.\n상담을 받고 싶어요.  ') {
  const row = f.row();
  row.state = prepareModelAnswer(row.state, {question_id:'want', text}, row.revision);
  f.replace(row);
  return text;
}

test('concerns quote complete current originals exactly and preserve actual person without storing them', async () => {
  const f = fixture({provider:request => {
    const source = request.sources.find(source => source.question_id === 'want');
    return {...plan(request), concerns:[{code:'support_requested', subject:'supporter', evidence_source_ids:[source.id]}]};
  }});
  const text = saveConversation(f), before = f.row();
  const result = await f.assess();
  assert.deepEqual(result.guidance.concerns, [{code:'support_requested', subject:'supporter',
    reason:'상담이나 지원을 원하는 내용이 있어 전문가와 상담할 곳을 함께 살펴보면 좋겠어요.',
    quotes:[{question_id:'want',text}]}]);
  assert.equal(result.guidance.concerns[0].reason.includes('위험'), false);
  assert.deepEqual(f.row(), before);
});

test('all source components remain complete without clipping long or multiline original answers', async () => {
  const f = fixture({provider:request => {
    const source = request.sources.find(source => source.question_id === 'want');
    return {...plan(request), concerns:[{code:'mental_health_concern', subject:'patient', evidence_source_ids:[source.id]}]};
  }});
  const original = saveConversation(f, '  원문 첫 줄.\n' + '합성 긴 대화입니다. '.repeat(100) + '\n마지막 줄.  ');
  const row = f.row();
  row.state.modelPending.prepared.ans.want.custom = '  원문을 보충하는 별도 답변입니다.\n다음 줄.  ';
  f.replace(row);
  const sources = safetySources(buildContext(row.state));
  const source = sources.find(source => source.question_id === 'want');
  const quotes = (await f.assess()).guidance.concerns[0].quotes;
  assert.deepEqual(quotes, source.components.map(component => ({question_id:'want',text:component.text})));
  assert.equal(quotes[0].text, original);
  assert.ok(quotes[0].text.length > 600);
  assert.equal(quotes.length, 2);
});

test('concerns reject forged, name-only, obsolete and unbounded model metadata', async () => {
  const mutations = [
    (c) => {c.code='invented';}, (c) => {c.subject='invented';},
    (c) => {c.reason='모델이 작성한 진단';}, (c) => {c.quotes=['조작한 인용'];},
    (c) => {c.evidence_source_ids=['obsolete'];}, (c) => {c.evidence_source_ids=[];},
    (c) => {c.evidence_source_ids=Array(1);},
    (c) => {c.evidence_source_ids.push(c.evidence_source_ids[0]);},
    (c, request) => {c.evidence_source_ids=[request.sources.find(source => source.question_id === 'name').id];},
  ];
  for (const mutate of mutations) {
    const f = fixture({provider:request => {
      const source = request.sources.find(source => source.question_id === 'want');
      const concern = {code:'mental_health_concern', subject:'patient', evidence_source_ids:[source.id]};
      mutate(concern, request);
      return {...plan(request), concerns:[concern]};
    }});
    saveConversation(f);
    await assert.rejects(f.assess(), {code:'REFERRAL_INVALID_RESPONSE'});
  }
  for (const invalid of [null, Array(1), Array(101).fill({}), 'unsupported']) {
    const f = fixture({provider:request => ({...plan(request),concerns:invalid})});
    await assert.rejects(f.assess(), {code:'REFERRAL_INVALID_RESPONSE'});
  }
});

test('duplicate concerns are rejected while absent concerns produce no invented quotation', async () => {
  const valid = fixture({provider:plan});
  assert.deepEqual((await valid.assess()).guidance.concerns, []);
  const f = fixture({provider:request => {
    const source = request.sources.find(source => source.question_id === 'want');
    const concern = {code:'mental_health_concern', subject:'patient', evidence_source_ids:[source.id]};
    return {...plan(request), concerns:[concern, structuredClone(concern)]};
  }});
  saveConversation(f);
  await assert.rejects(f.assess(), {code:'REFERRAL_INVALID_RESPONSE'});
});

test('provider failure preserves exact confirmed emergency quotation without inventing a signal code', async () => {
  const f = fixture({provider:() => {throw new Error('offline');}});
  const text = saveConversation(f, '친구가 지금 쓰러져 의식이 없어요.\n도움을 불러야 해요.');
  const row = f.row(), source = safetySources(buildContext(row.state)).find(source => source.question_id === 'want');
  row.state.status = 'ready';
  row.state.safetySignal = {urgent:true,review:{basis:'current_physical_danger'},evidence:[{
    subject:source.subject,question_id:source.question_id,quote:text}]};
  f.replace(row);
  const result = await f.assess();
  assert.equal(result.guidance.urgent, true);
  assert.deepEqual(result.guidance.concerns, [{code:null, subject:'unclear',
    reason:'지금 안전을 확인하고 전문적인 도움을 받을 필요가 있는 내용이 있어요.',
    quotes:[{question_id:'want',text}]}]);
});

test('malformed output preserves existing emergency while exposing only a bounded failure code', async () => {
  for (const value of [null, {}, {message:'SENSITIVE synthetic conversation'}]) {
    const f = fixture({provider:() => value}); markUrgent(f);
    const before = f.row(), result = await f.assess();
    assert.equal(result.status, 'model_unavailable');
    assert.equal(result.failure_code, 'REFERRAL_INVALID_RESPONSE');
    assert.equal(result.guidance.urgency, 'immediate');
    assert.equal(result.assessment.urgency, 'undetermined');
    assert.equal(JSON.stringify(result).includes('SENSITIVE'), false);
    assert.deepEqual(f.row(), before);
  }
});

test('provider mutation cannot erase server-owned prior safety evidence', async () => {
  const f = fixture({provider:request => {
    request.existing_safety.urgent = false;
    request.existing_safety.evidence_source_ids.length = 0;
    return plan(request);
  }}); markUrgent(f);
  const result = await f.assess();
  assert.equal(result.guidance.urgent, true);
  assert.deepEqual(result.safety_alert, {urgency:'immediate', subjects:['unclear']});
});

test('prior emergency and newly attributed alert preserve their distinct subjects and urgency', async () => {
  for (const urgency of ['soon','immediate']) {
    const f = fixture({provider:request => ({...plan(request), safety_alert:{urgency,
      subjects:['supporter'], evidence_source_ids:[request.sources[0].id]}})}); markUrgent(f);
    const result = await f.assess();
    assert.equal(result.guidance.urgent, true);
    assert.equal(result.assessment.urgency, 'planned');
    assert.deepEqual(result.safety_alert, {urgency, subjects:['supporter']});
    assert.deepEqual(result.preserved_safety_alert, {urgency:'immediate', subjects:['unclear']});
  }
});

test('preserved emergency on malformed response still rejects concurrent correction and deletion', async () => {
  for (const deletion of [false,true]) {
    const started=deferred(), finish=deferred();
    const f=fixture({provider:async () => {started.resolve(); await finish.promise; return null;}}); markUrgent(f);
    const pending=f.assess(); await started.promise;
    f.replace(deletion ? null : {...f.row(), revision:5}); finish.resolve();
    await assert.rejects(pending, deletion ? {status:404,code:'NOT_FOUND'} : {status:409,code:'REVISION_CONFLICT'});
  }
});

test('missing, failing and timed-out providers remain undetermined without leaking failure details', async () => {
  for (const provider of [null, () => { throw new Error('SENSITIVE synthetic conversation'); }, () => new Promise(() => {})]) {
    const f = fixture({provider, timeoutMs:10});
    const result = await f.assess();
    assert.equal(result.status, 'model_unavailable');
    assert.deepEqual(result.assessment, {urgency:'undetermined', needs_review:true, clinically_validated:false});
    assert.deepEqual(result.guidance.institutions, []);
    assert.equal(result.guidance.conversation_shared, false);
    assert.equal(result.guidance.automatically_contacted, false);
    assert.equal(JSON.stringify(result).includes('SENSITIVE'), false);
  }
});

test('timeout aborts the provider signal and allows a subsequent request to retry', async () => {
  let calls = 0, signal;
  const f = fixture({timeoutMs:10, provider:request => {
    calls++; signal = request.signal;
    return calls === 1 ? new Promise(() => {}) : plan(request);
  }});
  assert.equal((await f.assess()).status, 'model_unavailable');
  assert.equal(signal.aborted, true);
  assert.equal((await f.assess()).status, 'ready');
  assert.equal(calls, 2);
});

test('provider-thrown HTTP errors cannot leak provider response text to the caller', async () => {
  const f = fixture({provider:() => { throw new HttpError(502, 'UPSTREAM_ERROR', 'SENSITIVE synthetic conversation'); }});
  const result = await f.assess();
  assert.equal(result.status, 'model_unavailable');
  assert.equal(result.assessment.urgency, 'undetermined');
  assert.equal(JSON.stringify(result).includes('SENSITIVE'), false);
});

test('provider receives current source evidence and results retain patient scope without storing or sharing conversation', async () => {
  let received;
  const f = fixture({provider:request => { received = request; return plan(request); }}), before = f.row();
  const result = await f.assess();
  assert.equal(received.subject, 'patient');
  assert.equal(received.revision, 4);
  assert.deepEqual(received.existing_safety, {urgent:false, evidence_source_ids:[]});
  assert.deepEqual(received.sources, safetySources(buildContext(before.state)));
  assert.equal(result.subject, 'patient');
  assert.equal(result.status, 'ready');
  assert.equal(result.guidance.connection_mode, 'contact_links');
  assert.equal(result.guidance.conversation_shared, false);
  assert.equal(result.guidance.automatically_contacted, false);
  assert.equal(result.guidance.institutions[0].actions[0].href, 'https://counseling.example.invalid/book');
  assert.equal(JSON.stringify(result).includes('검증을 위한 가상의 당사자'), false);
  assert.deepEqual(f.row(), before);
});

test('only complete current independently reviewed urgent sources cross the provider boundary', async () => {
  let received;
  const f = fixture({provider:request => {received=request; return plan(request);}});
  const row = f.row();
  const sources = safetySources(buildContext(row.state));
  row.state.status = 'ready';
  row.state.safetySignal = {urgent:true,review:{basis:'current_physical_danger'},evidence:sources.flatMap(source =>
    [...new Set(source.components.map(c => c.text))].map(quote => ({subject:source.subject,question_id:source.question_id,quote})))};
  f.replace(row);
  assert.equal((await f.assess()).guidance.urgent, true);
  assert.deepEqual(received.existing_safety, {urgent:true, evidence_source_ids:sources.map(s => s.id)});
  for (const mutate of [r => {r.state.status='active';},r => {r.state.safetySignal.review.basis='past_only';},
    r => {r.state.safetySignal.evidence[0].quote='outdated';},r => {r.state.safetySignal.evidence=[];}]) {
    const bad=structuredClone(row);mutate(bad);f.replace(bad);
    await assert.rejects(f.assess(), {code:'REFERRAL_SAFETY_STALE'});
  }
});

test('model failure never erases a server-confirmed urgent signal', async () => {
  for (const provider of [null, () => {throw new Error('offline');}]) {
    const f=fixture({provider}), row=f.row();
    const source=safetySources(buildContext(row.state))[0];
    row.state.status='ready';
    row.state.safetySignal={urgent:true,review:{basis:'current_physical_danger'},evidence:[
      {subject:source.subject,question_id:source.question_id,quote:source.components[0].text}]};
    f.replace(row);
    const result=await f.assess();
    assert.equal(result.status,'model_unavailable');
    assert.equal(result.assessment.urgency,'undetermined');
    assert.equal(result.guidance.urgent,true);
    assert.deepEqual(result.safety_alert,{urgency:'immediate',subjects:['unclear']});
  }
});

test('invalid model scope, missing/duplicate/obsolete evidence and fabricated institution IDs are rejected', async () => {
  const oldId = safetySources(buildContext(intake('이전 버전의 가상 답변')))[0].id;
  const mutations = [
    value => { value.subject = 'supporter'; },
    value => { value.evidence_source_ids = []; },
    value => { value.evidence_source_ids.push(value.evidence_source_ids[0]); },
    value => { value.evidence_source_ids = [oldId]; },
    value => { value.evidence_source_ids = ['nonexistent']; },
    value => { value.institution_ids = ['fabricated']; },
    value => { value.institution_ids.push(value.institution_ids[0]); },
    value => { value.urgency = 'low'; },
    value => { value.reviewed = 'true'; },
    value => { value.contact_url = 'https://untrusted.example.invalid'; },
  ];
  for (const mutate of mutations) {
    const f = fixture({provider:request => { const value = plan(request); mutate(value); return value; }});
    await assert.rejects(f.assess(), {status:502, code:'REFERRAL_INVALID_RESPONSE'});
  }
});

test('unreviewed planned output is deferred while prompt and immediate priorities are preserved', async () => {
  for (const urgency of ['planned', 'soon', 'immediate']) {
    const f = fixture({provider:request => ({...plan(request), urgency, reviewed:false})});
    const result = await f.assess();
    assert.equal(result.status, 'needs_review');
    assert.equal(result.assessment.needs_review, true);
    assert.equal(result.assessment.urgency, urgency === 'planned' ? 'undetermined' : urgency);
    assert.equal(result.guidance.urgent, urgency === 'immediate');
    if (urgency === 'immediate') assert.match(result.guidance.message, /기다리지/);
  }
});

test('other-person alerts preserve help priority without becoming a patient classification', async () => {
  for (const subject of ['supporter', 'other', 'unclear']) {
    const f = fixture({provider:request => ({...plan(request), safety_alert:{
      urgency:'immediate', subjects:[subject], evidence_source_ids:[request.sources[0].id],
    }})});
    const result = await f.assess();
    assert.equal(result.assessment.urgency, 'planned');
    assert.equal(result.assessment.needs_review, true);
    assert.deepEqual(result.safety_alert, {urgency:'immediate', subjects:[subject]});
    assert.equal(result.guidance.urgency, 'immediate');
    assert.equal(result.guidance.urgent, true);
    assert.equal(result.presentation.state, 'attention');
    assert.deepEqual(result.guidance.institutions, []); // Booking-only institution.
  }
});

test('a lower-priority alert cannot downgrade patient urgency', async () => {
  const f = fixture({provider:request => ({...plan(request), urgency:'immediate', safety_alert:{
    urgency:'soon', subjects:['unclear'], evidence_source_ids:[request.sources[0].id],
  }})});
  assert.equal((await f.assess()).guidance.urgency, 'immediate');
});

test('alerts require current evidence and an explicit bounded subject set', async () => {
  for (const corrupt of [a => {a.subjects=[];}, a => {a.subjects=['supporter','supporter'];},
    a => {a.subjects=['invented'];}, a => {a.evidence_source_ids=[];}, a => {a.evidence_source_ids=['obsolete'];},
    a => {a.urgency='planned';}, a => {a.message='untrusted';}]) {
    const f = fixture({provider:request => {
      const safety_alert = {urgency:'immediate', subjects:['supporter'], evidence_source_ids:[request.sources[0].id]};
      corrupt(safety_alert); return {...plan(request), safety_alert};
    }});
    await assert.rejects(f.assess(), {code:'REFERRAL_INVALID_RESPONSE'});
  }
});

test('an explicitly undetermined model result does not require invented evidence', async () => {
  const f = fixture({provider:request => ({...plan(request), urgency:'undetermined', evidence_source_ids:[]})});
  const result = await f.assess();
  assert.equal(result.assessment.urgency, 'undetermined');
  assert.equal(result.assessment.needs_review, true);
});

test('missing configured institutions or urgency matches never produces invented contact links', async () => {
  const empty = createReferralDirectory({schema_version:'1.0', institutions:[]});
  const unconfigured = fixture({directory:empty, provider:request => ({...plan(request), institution_ids:[]})});
  const absent = await unconfigured.assess();
  assert.equal(absent.status, 'institutions_unconfigured');
  assert.deepEqual(absent.guidance.institutions, []);
  const noSelection = fixture({provider:request => ({...plan(request), urgency:'immediate', institution_ids:[]})});
  const unmatched = await noSelection.assess();
  assert.equal(unmatched.status, 'no_matching_institution');
  assert.equal(unmatched.guidance.urgent, true);
  assert.deepEqual(unmatched.guidance.institutions, []);
});

test('immediate plan selecting a booking-only institution retains urgent help without suggesting an appointment', async () => {
  const f = fixture({provider:request => ({...plan(request), urgency:'immediate'})});
  const result = await f.assess();
  assert.equal(result.status, 'no_matching_institution');
  assert.equal(result.guidance.urgent, true);
  assert.match(result.guidance.message, /기다리지/);
  assert.deepEqual(result.guidance.institutions, []);
});

test('wrong revision and pending answers reject before invoking the provider', async () => {
  let calls = 0;
  const f = fixture({provider:request => { calls++; return plan(request); }});
  await assert.rejects(f.assess({revision:3}), {status:409, code:'REVISION_CONFLICT'});
  const row = f.row(); row.state.modelPending = {input:{question_id:'name'}}; f.replace(row);
  await assert.rejects(f.assess(), {status:409, code:'REFERRAL_INPUT_PENDING'});
  assert.equal(calls, 0);
});

test('concurrent correction or deletion rejects the completed stale result without recreating data', async () => {
  for (const deletion of [false, true]) {
    const started = deferred(), finish = deferred();
    const f = fixture({provider:async request => { started.resolve(); await finish.promise; return plan(request); }});
    const pending = f.assess(); await started.promise;
    f.replace(deletion ? null : {...f.row(), revision:5}); finish.resolve();
    await assert.rejects(pending, deletion ? {status:404, code:'NOT_FOUND'} : {status:409, code:'REVISION_CONFLICT'});
    assert.equal(f.row()?.revision ?? null, deletion ? null : 5);
  }
});

test('owner access is checked before provider invocation', async () => {
  let calls = 0;
  const f = fixture({provider:request => { calls++; return plan(request); }});
  await assert.rejects(f.service.assess('other-owner', 'intake-a', {revision:4}, 'other-request'), {status:404});
  assert.equal(calls, 0);
});

test('same-revision concurrent requests deduplicate and character changes affect presentation only', async () => {
  const started = deferred(), finish = deferred(); let calls = 0;
  const characters = createCharacterRegistry({schema_version:'1.0', default_character_id:'bulssi', characters:[
    {id:'bulssi', display_name:'불씨', avatar_path:null, state_assets:{}},
    {id:'alternative', display_name:'대체 안내자', avatar_path:'/characters/alternative/avatar.webp', state_assets:{}},
  ]});
  const f = fixture({characters, provider:async request => { calls++; started.resolve(); await finish.promise; return plan(request); }});
  const first = f.assess({revision:4, character_id:'bulssi'});
  await started.promise;
  const second = f.assess({revision:4, character_id:'alternative'});
  await new Promise(resolve => setImmediate(resolve)); finish.resolve();
  const [a,b] = await Promise.all([first,second]);
  assert.equal(calls, 1);
  assert.equal(a.presentation.id, 'bulssi'); assert.equal(b.presentation.id, 'alternative');
  const {presentation:ignoredA, ...coreA} = a, {presentation:ignoredB, ...coreB} = b;
  assert.deepEqual(coreA, coreB);
  const fallback = await f.assess({revision:4, character_id:'removed'});
  assert.equal(fallback.presentation.id, 'bulssi');
  assert.equal(fallback.presentation.fallback, 'text');
});

test('invalid request shapes cannot inject assessment or routing fields', async () => {
  const f = fixture();
  for (const input of [null, {}, {revision:-1}, {revision:4.5}, {revision:'4'},
    {revision:4, character_id:'../script'}, {revision:4, urgency:'immediate'}, {revision:4, institution_ids:['synthetic-center']}]) {
    await assert.rejects(f.assess(input), {status:422, code:'INVALID_INPUT'});
  }
});

test('guidance returns the exact developer-selected sentence without model text or character rewriting', async () => {
  const sentence = '개발자가 등록한 문장입니다.\n기관 안내를 확인해 주세요.';
  const f = fixture({messages:{get:urgency=>({id:'developer_'+urgency,text:sentence})},
    provider:request=>({...plan(request),urgency:'immediate'})});
  const result = await f.assess();
  assert.equal(result.guidance.message, sentence);
  assert.equal(result.guidance.message_id, 'developer_immediate');
});


test('a saved pending answer is independently classified without accepting the dialogue model output', async () => {
  let received;
  const f=fixture({provider:request=>{received=request;return {...plan(request),urgency:'immediate'};}});
  const row=f.row();
  row.state=prepareModelAnswer(row.state,{question_id:'want',text:'도움을 부르고 싶어요. 친구가 지금 쓰러져 의식이 없어요.'},row.revision);
  row.revision++; f.replace(row);
  const before=f.row();
  assert.equal(f.service.available(row.state),false);
  const result=await f.assess({revision:row.revision});
  assert.equal(result.guidance.urgent,true);
  assert.ok(received.sources.some(s=>s.components.some(c=>c.text.includes('친구가 지금 쓰러져'))));
  assert.deepEqual(f.row(),before);
  assert.ok(f.row().state.modelPending);
});

test('the app offers Bulssi only after the conversation is ready with saved evidence', () => {
  const f=fixture({provider:plan});
  const row=f.row();
  assert.equal(f.service.available(row.state),false);
  row.state=answerIntake(row.state,{question_id:'want',text:'전문가에게 상담을 받고 싶어요.'});
  assert.equal(f.service.available(row.state),false);
  row.state.status='ready';
  assert.equal(f.service.available(row.state),true);
  row.state.modelPending={prepared:{}};
  assert.equal(f.service.available(row.state),false);
  const nameOnly=intake(); nameOnly.status='ready';
  assert.equal(f.service.available(nameOnly),false);
});
