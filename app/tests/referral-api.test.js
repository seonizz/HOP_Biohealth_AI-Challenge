import { restoreLegacyQuestionBank } from './helpers/legacy-question-bank.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createApp } from '../src/server.js';
import { createIntake, answerIntake } from '../src/intake.js';
import { createReferralDirectory } from '../src/referral-directory.js';
import { createCharacterRegistry } from '../src/guide-characters.js';
import { createModelReferralProvider } from '../src/referral-provider.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const directory = () => createReferralDirectory({schema_version:'1.0', institutions:[
  {id:'synthetic-center', name:'합성 검증 기관', active:true, urgencies:['soon','planned','undetermined'],
    phone:null, booking_url:'https://counselling.example.org/book', last_verified_on:'2026-10-18'},
]});
const plan = input => ({schema_version:'1.0', subject:'patient', urgency:'soon', reviewed:true,
  evidence_source_ids:[input.sources[0].id], institution_ids:['synthetic-center'], model_version:'synthetic-fixture'});

async function fixture(t, options = {}) {
  const schema = 'referral_api_' + randomBytes(8).toString('hex');
  const admin = new pg.Pool({connectionString:databaseUrl});
  await admin.query(`CREATE SCHEMA ${schema}`);
  const app = await createApp({databaseUrl, schema, key:randomBytes(32), gateway:null,
    referralDirectory:directory(), ...options});
  await restoreLegacyQuestionBank(app.store);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await app.store.close().catch(() => {});
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const browser = async () => {
    const response = await fetch(base + '/api/bootstrap');
    assert.equal(response.status, 200);
    const bootstrap = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
    const owner = (await app.store.browser(cookie.slice('malssi_session='.length))).id;
    return {owner, cookie, csrf:bootstrap.csrf_token};
  };
  const request = async (session, path, method = 'GET', data, headers = {}) => {
    const response = await fetch(base + path, {method, headers:{cookie:session?.cookie || '',
      'x-csrf-token':session?.csrf || '', 'content-type':'application/json', ...headers},
      ...(data === undefined ? {} : {body:JSON.stringify(data)})});
    return {status:response.status, data:await response.json()};
  };
  const session = await browser();
  await app.store.pool.query(`INSERT INTO questions(id,kind,sort_order,enabled,subject,definition)
    VALUES ('referral_observation','base',150,TRUE,'patient',$1)`,
  [{type:'text',q:'최근 관찰한 내용을 알려주세요.',sec:'관찰',required:true}]);
  let state = answerIntake(createIntake(await app.store.questionSet()), {question_id:'name',text:'합성 인물'});
  state = answerIntake(state, {question_id:'referral_observation',text:'합성 사례의 상담 요청을 전달받았습니다. 상담 가능한 시간을 알아보고 싶다고 했습니다.'});
  const row = await app.store.createIntake(session.owner, state, 0);
  return {...app, request, browser, session, row, path:`/api/intakes/${row.id}/guidance`};
}

test('guidance lists require a session, and patient guidance requires owner and CSRF', {skip:!databaseUrl}, async t => {
  let calls = 0;
  const f = await fixture(t, {referralProvider:async input => {calls++; return plan(input);}});
  assert.equal((await f.request(null, '/api/guidance/characters')).status, 401);
  assert.equal((await f.request(f.session, '/api/guidance/characters')).data.default_character_id, 'bulssi');
  const institutions = await f.request(f.session, '/api/guidance/institutions');
  assert.equal(institutions.data.institutions[0].actions[0].href, 'https://counselling.example.org/book');
  assert.equal((await f.request(f.session, f.path, 'POST', {revision:0}, {'x-csrf-token':'invalid'})).status, 403);
  assert.equal((await f.request(await f.browser(), f.path, 'POST', {revision:0})).status, 404);
  assert.equal((await f.request(f.session, f.path, 'POST', {revision:0}, {'sec-fetch-site':'cross-site'})).status, 403);
  assert.equal(calls, 0);
});

test('guidance returns static contact links without changing encrypted history or sending conversation data', {skip:!databaseUrl}, async t => {
  const f = await fixture(t, {referralProvider:async input => {
    assert.equal(input.subject, 'patient');
    assert.match(input.intake_id, /^[a-f0-9-]{36}$/);
    assert.equal(input.revision, 0);
    assert.ok(input.context.patient.fields.referral_observation);
    assert.equal(Object.hasOwn(input, 'character_id'), false);
    return plan(input);
  }});
  const before = await f.store.pool.query('SELECT revision,content FROM intakes WHERE id=$1',[f.row.id]);
  const response = await f.request(f.session, f.path, 'POST', {revision:0});
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.status, 'needs_review');
  assert.equal(response.data.assessment.urgency, 'soon');
  assert.equal(response.data.guidance.automatically_contacted, false);
  assert.equal(response.data.guidance.conversation_shared, false);
  assert.equal(response.data.presentation.id, 'bulssi');
  assert.equal(response.data.guidance.institutions[0].actions[0].href, 'https://counselling.example.org/book');
  assert.equal(JSON.stringify(response.data).includes('합성 사례의 상담 요청'), false);
  assert.deepEqual((await f.store.pool.query('SELECT revision,content FROM intakes WHERE id=$1',[f.row.id])).rows, before.rows);
  assert.equal((await f.store.pool.query('SELECT * FROM patient_state_revisions WHERE intake_id=$1',[f.row.id])).rowCount, 1);
  assert.equal((await f.store.history(f.session.owner)).records.length, 0);
});

test('completed guidance is retained encrypted without revision changes and refresh avoids a model call', {skip:!databaseUrl}, async t => {
  let calls=0;
  const f=await fixture(t,{referralProvider:async input=>{
    calls++;
    const source=input.sources.find(source=>source.question_id==='referral_observation');
    return {...plan(input),evidence_source_ids:[source.id],concerns:[{
      code:'mental_health_concern',subject:'patient',evidence_source_ids:[source.id],
    }]};
  }});
  const completed=await f.store.updateIntake(f.session.owner,f.row.id,0,state=>({...state,status:'ready'}),'model_update');
  const before=await f.store.pool.query('SELECT revision,content FROM patient_states WHERE intake_id=$1',[f.row.id]);
  const first=await f.request(f.session,f.path,'POST',{revision:completed.revision});
  const refreshed=await f.request(f.session,f.path,'POST',{revision:completed.revision});
  assert.equal(first.status,200);assert.deepEqual(refreshed,first);assert.equal(calls,1);
  assert.ok(first.data.guidance.concerns[0].quotes[0].text.includes('합성 사례의 상담 요청'));
  const stored=await f.store.intake(f.session.owner,f.row.id);
  assert.equal(stored.revision,completed.revision);assert.equal(stored.state.referralAssessment.revision,completed.revision);
  assert.equal(JSON.stringify(stored.state.referralAssessment).includes('합성 사례의 상담 요청'),false);
  assert.deepEqual((await f.store.pool.query('SELECT revision,content FROM patient_states WHERE intake_id=$1',[f.row.id])).rows,before.rows);
  assert.equal((await f.store.pool.query('SELECT * FROM patient_state_revisions WHERE intake_id=$1',[f.row.id])).rowCount,2);
  assert.equal((await f.request(await f.browser(),f.path,'POST',{revision:completed.revision})).status,404);
  assert.equal((await f.request(f.session,`/api/intakes/${f.row.id}`,'DELETE')).status,200);
  assert.equal((await f.request(f.session,f.path,'POST',{revision:completed.revision})).status,404);assert.equal(calls,1);
});

test('HTTP boundary supplies the full contract to the real classification adapter', {skip:!databaseUrl}, async t => {
  let calls = 0;
  const gateway = {
    async operation(_options, fn) {return fn({controller:new AbortController()});},
    async agentComplete(_stage, _prompt, request, _schema, _operation, validate) {
      calls++;
      const source = request.sources.find(row => row.question_id === 'referral_observation');
      assert.ok(source);
      return validate({signals:[{code:'mental_health_concern', person:'patient', assertion:'reported',
        timeframe:'current', report_type:'patient_words', statement:'합성 상담 요청 보고.', source_ids:[source.id]}], unknowns:[]});
    },
  };
  const referralProvider = createModelReferralProvider({gateway, eligibilityById:{}, modelVersion:'synthetic-http-contract',
    resolveRoutingContext:() => ({country:'KR',region:null,age:null,requester:'supporter'}),
    now:() => new Date('2026-10-18T09:00:00Z')});
  const f = await fixture(t, {referralProvider});
  const response = await f.request(f.session, f.path, 'POST', {revision:0});
  assert.equal(response.status, 200);
  assert.equal(calls, 2);
  assert.equal(response.data.assessment.urgency, 'planned');
  assert.notEqual(response.data.status, 'model_unavailable');
  assert.equal(response.data.failure_code, null);
});

test('unconnected provider is undetermined and client-supplied classification or links are rejected', {skip:!databaseUrl}, async t => {
  const f = await fixture(t);
  const response = await f.request(f.session, f.path, 'POST', {revision:0});
  assert.equal(response.data.status, 'model_unavailable');
  assert.equal(response.data.assessment.urgency, 'undetermined');
  for (const extra of [{urgency:'planned'}, {institution_ids:['synthetic-center']}, {booking_url:'https://example.org'},
    {safety_alert:{urgency:'immediate', subjects:['supporter']}}]) {
    assert.equal((await f.request(f.session, f.path, 'POST', {revision:0, ...extra})).status, 422);
  }
  assert.equal((await f.request(f.session, f.path, 'POST', {revision:1})).status, 409);
});

test('HTTP preserves non-patient alert scope separately from patient assessment and urgent routing', {skip:!databaseUrl}, async t => {
  const f = await fixture(t, {referralProvider:async input => ({...plan(input), urgency:'planned',
    safety_alert:{urgency:'immediate', subjects:['supporter'], evidence_source_ids:[input.sources[0].id]}})});
  const response = await f.request(f.session, f.path, 'POST', {revision:0});
  assert.equal(response.status, 200);
  assert.equal(response.data.subject, 'patient');
  assert.equal(response.data.assessment.urgency, 'planned');
  assert.equal(response.data.assessment.needs_review, true);
  assert.deepEqual(response.data.safety_alert, {urgency:'immediate', subjects:['supporter']});
  assert.equal(response.data.guidance.urgency, 'immediate');
  assert.equal(response.data.guidance.urgent, true);
  assert.deepEqual(response.data.guidance.institutions, []);
  assert.equal(response.data.presentation.state, 'attention');
});

test('gateway adapter and configurable second character preserve the same guidance', {skip:!databaseUrl}, async t => {
  const guideCharacters = createCharacterRegistry({schema_version:'1.0', default_character_id:'bulssi', characters:[
    {id:'bulssi', display_name:'불씨', avatar_path:null, state_assets:{}},
    {id:'another', display_name:'새 안내자', avatar_path:null, state_assets:{}},
  ]});
  const f = await fixture(t, {gateway:{referralGuidance:async input => plan(input)}, guideCharacters});
  const a = await f.request(f.session, f.path, 'POST', {revision:0});
  const b = await f.request(f.session, f.path, 'POST', {revision:0, character_id:'another'});
  assert.equal(b.data.presentation.id, 'another');
  assert.deepEqual(a.data.guidance, b.data.guidance);
  assert.deepEqual(a.data.assessment, b.data.assessment);
});

for (const operation of ['correction', 'delete', 'delete_all']) {
  test(`in-flight guidance is discarded after ${operation}`, {skip:!databaseUrl}, async t => {
    let release, started;
    const gate = new Promise(resolve => {release = resolve;});
    const entered = new Promise(resolve => {started = resolve;});
    const f = await fixture(t, {referralProvider:async input => {started(); await gate; return plan(input);}});
    const pending = f.request(f.session, f.path, 'POST', {revision:0});
    await entered;
    if (operation === 'correction') await f.store.updateIntake(f.session.owner, f.row.id, 0, state => ({...state, name:'합성 정정'}), 'correction');
    else if (operation === 'delete') await f.store.deleteIntake(f.session.owner, f.row.id);
    else await f.store.deleteConversations(f.session.owner);
    release();
    const result = await pending;
    assert.equal(result.status, operation === 'correction' ? 409 : 404);
    assert.equal((await f.store.history(f.session.owner)).records.length, 0);
  });
}
