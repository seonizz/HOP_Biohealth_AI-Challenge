import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLE_ID, MAX_HTTP_REQUESTS, configuration, parseArgs, runVerification, syntheticAnswer, verifyContext } from '../scripts/verify-questionnaire-v3-live.mjs';
import { activeQuestionSet } from '../src/question-bank.js';
import { createIntake, answerIntake, currentView, buildContext } from '../src/intake.js';
import { createV3Clarification, issueV3 } from '../src/intake-v3.js';

const intakeId = 'ee190889-25ee-45b5-a617-0f310a180760';
const cookie = 'malssi_session=synthetic_secret_cookie';
const csrf = 'synthetic_secret_csrf';
const json = (value, status = 200, headers) => new Response(JSON.stringify(value), {status,headers});
async function output(t) {
  const path = await mkdtemp(join(tmpdir(), 'malssi-v3-runner-'));
  t.after(() => rm(path, {recursive:true,force:true}));
  return path;
}

function fixture({adaptive = false, clarify = false, skipAfterFirst = false, failure, mutateRecord, corruptContext, repeat = false, pending = false} = {}) {
  let state = createIntake(activeQuestionSet), revision = 0, record;
  const requests = [];
  const view = () => ({id:intakeId,revision,...currentView(state)});
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({path,method:options.method,body});
    assert.equal(options.redirect, 'error');
    if (path === '/api/bootstrap') {
      assert.equal(options.headers.cookie, undefined);
      return json({model_connected:true,csrf_token:csrf,conversation_epoch:0,questions:activeQuestionSet.questions},200,{'set-cookie':`${cookie}; Path=/; HttpOnly`});
    }
    assert.equal(options.headers.cookie, cookie);
    assert.equal(options.headers['x-csrf-token'], csrf);
    if (failure && path.endsWith(failure.path) && (!failure.questionId || body?.question_id === failure.questionId)) {
      return json({error:{code:failure.code,message:`do not log ${cookie} ${csrf}`}}, failure.status);
    }
    if (path === '/api/intakes') return json(view(),201);
    if (path.endsWith('/answers')) {
      assert.equal(body.revision, revision);
      if (!repeat) state = answerIntake(state, body);
      revision += 2;
      if (skipAfterFirst && body.question_id === 'q3_01') {
        state.modelSkipped.q3_02 = {reason:'already_covered'};
        state.i = 2;
        issueV3(state,activeQuestionSet.questions[state.i]);
      }
      if (clarify && body.question_id === 'q3_01') {
        const answer = state.ans.q3_01;
        const question = createV3Clarification(state, {source_question_id:'q3_01',source_revision:answer.source_revision,
          component:'custom',event_id:'offer',quote:answer.custom,quote_start:0,quote_end:Array.from(answer.custom).length,
          axis:'modality',role:null,agreement_item_id:null});
        state.pendingFollow = {kind:'v3_clarification',questionId:question.id};
      } else if (adaptive) {
        state.i = activeQuestionSet.questions.length;
        state.status = 'ready';
        for (const q of activeQuestionSet.questions) if (!state.ans[q.id]) state.modelSkipped[q.id] = {reason:'not_needed'};
      }
      return json({...view(), ...(pending ? {model_pending:true} : {})});
    }
    if (path.endsWith('/context')) {
      const context = buildContext(state);
      corruptContext?.(context);
      return json({id:intakeId,revision,context});
    }
    if (path.endsWith('/result')) {
      assert.equal(body.revision,revision);
      record = {id:'123456789', title:'그분', context:buildContext(state),
        provenance:{kind:'model',model:'synthetic-model'},
        guide:{top:'통합',script:'도입 부분에 대해 의견을 나누고 싶어.',doList:['가능한 범위를 이야기해요.'],
          avoid:['도움의 범위를 혼자 확정하지 않아요.'],next:'서로 원하는 시간을 확인해 보세요.',care:{feel:'자신의 일정도 살펴 주세요.',tips:['휴식 시간을 지켜 주세요.']}}};
      return json({record,revision:revision+1});
    }
    if (path === '/api/records/123456789') {
      const saved = structuredClone(record);
      mutateRecord?.(saved);
      return json({record:saved});
    }
    if (path === '/api/records') return json({records:[record],incomplete_intakes:[]});
    assert.fail(`Unexpected request ${path}`);
  };
  return {fetchImpl,requests};
}

test('live runner performs one bounded conversation and verifies exact persisted cards without writing credentials', async t => {
  const path = await output(t), fake = fixture();
  let startup;
  const report = await runVerification({output:path,estimateMinSeconds:1800,estimateMaxSeconds:5400}, {...fake,onStart:value => {startup=value;}});
  assert.equal(report.status, 'passed');
  assert.equal(report.record_id, '123456789');
  assert.equal(report.intake_id, intakeId);
  assert.equal(report.answered_question_ids.length, 9);
  assert.deepEqual(report.skipped_question_ids,[]);
  assert.deepEqual(report.unasked_question_ids,[]);
  assert.deepEqual(report.question_progress,{status:'verified',source:'input_context'});
  assert.equal(report.request_count, 15);
  assert.equal(fake.requests.filter(request => request.path === '/api/intakes').length,1);
  assert.equal(fake.requests.some(request => request.path.includes('/progress')),false);
  assert.equal(startup.status,'running');
  assert.match(startup.estimated_finish.earliest,/KST$/);
  assert.equal(startup.estimated_finish.basis,'initial_local_model_measurement_heuristic');
  for (const filename of ['status.json','status.md','report.json','result.json']) {
    const text = await readFile(join(path,filename),'utf8');
    assert.equal(text.includes(cookie),false);
    assert.equal(text.includes(csrf),false);
    assert.equal((await stat(join(path,filename))).mode & 0o777,0o600);
  }
  const saved = JSON.parse(await readFile(join(path,'result.json'),'utf8'));
  assert.equal(saved.context.bundle_id,BUNDLE_ID);
  assert.ok(saved.guide.script);
  await assert.rejects(runVerification({output:path},fake),{code:'EEXIST'});
});

test('status and ETA exist before the first HTTP request; adaptive skips and bound Q10 unknown are supported', async t => {
  const path = await output(t), fake = fixture({adaptive:true,clarify:true});
  const fetchImpl = async (...args) => {
    if (!fake.requests.length) {
      const status = JSON.parse(await readFile(join(path,'status.json'),'utf8'));
      assert.equal(status.status,'running');
      assert.equal(status.stage,'bootstrap');
      assert.ok(status.estimated_finish.latest);
      assert.equal(status.pid,process.pid);
    }
    return fake.fetchImpl(...args);
  };
  const report = await runVerification({output:path},{fetchImpl});
  assert.equal(report.status,'passed');
  assert.deepEqual(report.answered_question_ids,['q3_01','q3_10']);
  assert.equal(report.skipped_question_ids.length,8);
  assert.deepEqual(report.unasked_question_ids,[]);
  const q10 = fake.requests.find(request => request.body?.question_id === 'q3_10').body;
  assert.equal(q10.response_event,'unknown');
  assert.equal(q10.follow_up,true);
});

test('a model HTTP failure stops once and records only safe error metadata', async t => {
  const path = await output(t), fake = fixture({failure:{path:'/answers',code:'MODEL_INVALID_RESPONSE',status:502}});
  const report = await runVerification({output:path},fake);
  assert.equal(report.status,'failed');
  assert.deepEqual(report.error,{code:'MODEL_INVALID_RESPONSE',http_status:502});
  assert.equal(report.failed_stage,'answer_question');
  assert.equal(fake.requests.length,4);
  assert.equal(fake.requests.filter(request => request.path.endsWith('/context')).length,1);
  assert.deepEqual(report.answered_question_ids,[]);
  assert.deepEqual(report.skipped_question_ids,[]);
  assert.equal(report.unasked_question_ids.length,9);
  assert.deepEqual(report.question_progress,{status:'verified',source:'failure_context'});
  assert.equal(fake.requests.some(request => request.path.endsWith('/result')),false);
  assert.equal((await readFile(join(path,'report.json'),'utf8')).includes('synthetic_secret'),false);
});

test('a later answer failure reports confirmed skips separately from unasked questions', async t => {
  const path = await output(t), fake = fixture({skipAfterFirst:true,
    failure:{path:'/answers',questionId:'q3_03',code:'MODEL_CONTEXT_TOO_LONG',status:502}});
  const report = await runVerification({output:path},fake);
  assert.equal(report.status,'failed');
  assert.deepEqual(report.error,{code:'MODEL_CONTEXT_TOO_LONG',http_status:502});
  assert.equal(report.failed_stage,'answer_question');
  assert.deepEqual(report.answered_question_ids,['q3_01']);
  assert.deepEqual(report.skipped_question_ids,['q3_02']);
  assert.deepEqual(report.unasked_question_ids,['q3_03','q3_04','q3_05','q3_06','q3_07','q3_08','q3_09']);
  assert.deepEqual(report.question_progress,{status:'verified',source:'failure_context'});
  assert.equal(fake.requests.filter(request => request.path.endsWith('/context')).length,1);
  assert.ok(report.request_count <= MAX_HTTP_REQUESTS);
  assert.equal(fake.requests.some(request => request.path.endsWith('/result')),false);
  assert.match(await readFile(join(path,'status.md'),'utf8'),/확인된 자동 생략: q3_02/);
});

test('failed or stalled progress lookup preserves the original failure and marks progress unavailable', async t => {
  for (const stalled of [false,true]) {
    const fake = fixture({failure:{path:'/answers',code:'MODEL_CONTEXT_TOO_LONG',status:502}});
    let progressCalls = 0, progressSignal;
    const fetchImpl = async (url, options) => {
      if (new URL(url).pathname.endsWith('/context')) {
        progressCalls++;progressSignal=options.signal;
        if (stalled) return new Promise(() => {});
        return json({error:{code:'CONTEXT_UNAVAILABLE'}},503);
      }
      return fake.fetchImpl(url,options);
    };
    const report = await runVerification({output:await output(t),requestTimeoutSeconds:0.01},{fetchImpl});
    assert.deepEqual(report.error,{code:'MODEL_CONTEXT_TOO_LONG',http_status:502});
    assert.equal(report.failed_stage,'answer_question');
    assert.equal(progressCalls,1);
    assert.deepEqual(report.question_progress,{status:'unavailable',code:stalled?'REQUEST_TIMEOUT':'CONTEXT_UNAVAILABLE'});
    assert.deepEqual(report.answered_question_ids,[]);
    if (stalled) assert.equal(progressSignal.aborted,true);
  }
});

test('an unacknowledged source in the failure context never inflates successful answer counts', async t => {
  const fake = fixture({failure:{path:'/answers',code:'MODEL_INVALID_RESPONSE',status:502},corruptContext:context => {
    context.supporter.fields.q3_01 = {...context.supporter.fields.q3_01,status:'answered',rawText:'Unacknowledged source'};
  }});
  const report = await runVerification({output:await output(t)},fake);
  assert.deepEqual(report.answered_question_ids,[]);
  assert.equal(report.unasked_question_ids.includes('q3_01'),false);
  assert.deepEqual(report.error,{code:'MODEL_INVALID_RESPONSE',http_status:502});
});

test('fabricated skipped content makes failure progress unavailable without masking the model error', async t => {
  const fake = fixture({failure:{path:'/answers',code:'MODEL_CONTEXT_TOO_LONG',status:502},corruptContext:context => {
    context.patient.fields.q3_02 = {...context.patient.fields.q3_02,status:'auto_skipped',rawText:'PRIVATE_FABRICATED_SOURCE'};
  }});
  const path = await output(t), report = await runVerification({output:path},fake);
  assert.deepEqual(report.error,{code:'MODEL_CONTEXT_TOO_LONG',http_status:502});
  assert.deepEqual(report.question_progress,{status:'unavailable',code:'FABRICATED_UNANSWERED_SOURCE'});
  assert.deepEqual(report.skipped_question_ids,[]);
  assert.equal((await readFile(join(path,'report.json'),'utf8')).includes('PRIVATE_FABRICATED_SOURCE'),false);
});

test('an answer network failure does not start a progress retry', async t => {
  const fake = fixture();let calls=0;
  const fetchImpl = async (url,options) => {
    calls++;
    if (new URL(url).pathname.endsWith('/answers')) throw new Error('synthetic network failure');
    return fake.fetchImpl(url,options);
  };
  const report = await runVerification({output:await output(t)},{fetchImpl});
  assert.deepEqual(report.error,{code:'NETWORK_ERROR'});
  assert.deepEqual(report.question_progress,{status:'unverified'});
  assert.equal(calls,3);
});

test('per-request and whole-run deadlines abort stalled HTTP and persist failure', async t => {
  for (const [timeoutSeconds,requestTimeoutSeconds,expected] of [[1,0.01,'REQUEST_TIMEOUT'],[0.01,0.01,'OVERALL_TIMEOUT']]) {
    const path = await output(t);
    let signal;
    const report = await runVerification({output:path,timeoutSeconds,requestTimeoutSeconds},{fetchImpl:async (_url,options) => {
      signal=options.signal;
      return await new Promise(() => {});
    }});
    assert.equal(report.status,'failed');
    assert.equal(report.error.code,expected);
    assert.ok(!signal || signal.aborted);
    assert.equal(JSON.parse(await readFile(join(path,'report.json'),'utf8')).status,'failed');
  }
});

test('record mismatch cannot be reported as a passed persistence check', async t => {
  const path = await output(t);
  const report = await runVerification({output:path},fixture({adaptive:true,mutateRecord:record => {record.guide.script='다른 저장 내용';}}));
  assert.equal(report.status,'failed');
  assert.equal(report.error.code,'RECORD_MISMATCH');
  assert.equal(report.failed_stage,'verify_saved_record');
  assert.equal(report.record_id,'123456789');
});

test('fabricated unanswered sources and repeated or pending questions fail without unbounded calls', async t => {
  const variants = [
    [{adaptive:true,corruptContext:context => {context.patient.fields.q3_03={id:'q3_03',status:'answered',rawText:'만들어낸 답'};}},'FABRICATED_UNANSWERED_SOURCE'],
    [{repeat:true},'REPEATED_QUESTION'],
    [{pending:true},'UNEXPECTED_PENDING_STATE'],
  ];
  for (const [options,code] of variants) {
    const fake = fixture(options), report = await runVerification({output:await output(t)},fake);
    assert.equal(report.status,'failed');
    assert.equal(report.error.code,code);
    assert.ok(fake.requests.length <= MAX_HTTP_REQUESTS);
    assert.equal(fake.requests.filter(request => request.path === '/api/intakes').length,1);
  }
});

test('configuration limits destinations, arguments, time bounds and clarification binding', () => {
  for (const baseUrl of ['https://example.com','http://user:secret@localhost:9000','http://127.0.0.1:9000/path']) {
    assert.throws(() => configuration({baseUrl}),{code:'LOOPBACK_URL_REQUIRED'});
  }
  assert.throws(() => parseArgs(['--timeout-seconds','0']),{code:'INVALID_TIME_LIMIT'});
  assert.throws(() => parseArgs(['--output','a','--output','b']),{code:'INVALID_ARGUMENTS'});
  assert.throws(() => configuration({estimateMinSeconds:10,estimateMaxSeconds:5}),{code:'INVALID_ESTIMATE'});
  assert.throws(() => syntheticAnswer({id:'q3_10',instance_id:'one',follow_up:true}),{code:'UNBOUND_CLARIFICATION'});
  assert.throws(() => syntheticAnswer({id:'legacy_name',instance_id:'one'}),{code:'UNREGISTERED_QUESTION'});
  const parsed = parseArgs(['--base-url','http://127.0.0.1:9000','--output','/tmp/one-run','--estimate-min-seconds','1800','--estimate-max-seconds','5400','--timeout-seconds','7200']);
  assert.equal(parsed.timeoutSeconds,7200);
  assert.equal(parsed.requestTimeoutSeconds,1800);
});


test('live runner accepts only bounded personalized IDs and never fabricates answers to generated questions', () => {
  const question={id:'q3_personal_01',instance_id:'one',follow_up:true,personalized:true,type:'text',q:'어떤 도움이 필요하다고 말했나요?'};
  const answer=syntheticAnswer(question);
  assert.equal(answer.response_event,'unknown');
  assert.equal(answer.text,'');
  assert.equal(answer.follow_up,true);
  assert.throws(()=>syntheticAnswer({...question,id:'q3_personal_03'}),{code:'UNREGISTERED_QUESTION'});
  assert.throws(()=>syntheticAnswer({...question,personalized:false}),{code:'INVALID_PERSONALIZED_QUESTION'});
  assert.throws(()=>syntheticAnswer({...question,type:'one'}),{code:'INVALID_PERSONALIZED_QUESTION'});
});
