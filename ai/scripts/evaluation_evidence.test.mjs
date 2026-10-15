import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { modelConfig, evaluationIdentity, assertWebSessionIdentity, sha256, attemptMetrics, summarizeRuns } from './evaluation_evidence.mjs';

test('explicit 31B endpoint never inherits legacy 12B identity or credential', () => {
  const config = modelConfig({ MODEL_BASE_URL:'http://localhost:9999/v1', MODEL_NAME:'31b' }, { ollama_url:'http://localhost:11434', api_key:'legacy' });
  assert.equal(config.model, '31b');
  assert.equal(config.apiKey, undefined);
  assert.equal(modelConfig({MODEL_BASE_URL:'http://localhost:9999/v1'}).model, undefined);
  assert.throws(() => modelConfig({ MODEL_TIMEOUT_MS:'NaN' }), /invalid_model_timeout/);
  assert.throws(() => modelConfig({ MODEL_CHECKPOINT_SHA256:'not-a-hash' }), /invalid_checkpoint/);
  assert.equal(modelConfig({ MODEL_DEPLOYMENT_ID:'instance-one' }).deploymentId, 'instance-one');
  assert.throws(() => modelConfig({ MODEL_DEPLOYMENT_ID:' ' }), /invalid_deployment_id/);
});

const identity = { model_requested:'31b', source:{sha256:'a'}, evaluator:{sha256:'e1'}, prompt_version:'v1',
  endpoint_sha256_declared:sha256('https://example.test/v1'), deployment_id_sha256_declared:null,
  context_source:'synthetic_fixture', protocol:'relationship_agent', fixture_sha256:'one', questions_sha256:'q', timeout_ms:600000 };
const run = (id,status,duration,overrides={}) => ({ run_id:id, status, duration_ms:duration, mode:'state', identity, trace:[], ...overrides });
const attempt = (overrides={}) => ({event:'model_attempt',request_id:null,generation:'state',generation_id:'generation-one',
  attempt:1,attempt_id:'attempt-one',status:200,duration_ms:20,finish_reason:'stop',usage:null,reason:'success',...overrides});
const wait = (overrides={}) => ({event:'model_retry_wait',request_id:null,generation:'state',generation_id:'generation-one',
  attempt:1,after_attempt_id:'attempt-one',delay_ms:100,duration_ms:100,reason:'deadline',...overrides});
const assertUnverified = metrics => {
  assert.equal(metrics.attempt_count_verified, false);
  for (const key of ['attempts','failed_attempts','retries','attempt_wait_ms','attempt_p50_ms','attempt_p95_ms','prompt_tokens','completion_tokens',
    'retry_wait_events','retry_wait_deadlines','retry_wait_ms','preflight_failures']) assert.equal(metrics[key], null, key);
};
test('failed runs remain in denominator and timing distribution', () => {
  const [summary] = summarizeRuns([run('1','passed',10),run('2','failed',100)]);
  assert.equal(summary.automatic_pass_rate,.5);
  assert.equal(summary.failed,1);
  assert.equal(summary.elapsed_p95_ms,100);
  assert.equal(summary.elapsed_total_ms,110);
  assert.equal(summary.unique_cases,1);
  assert.equal(summary.human_review,'pending');
  assert.equal(summary.independent_test,false);
});
test('different models, source, mode and checkpoint are never merged', () => {
  assert.equal(summarizeRuns([run('1','passed',1),run('2','passed',1,{identity:{...identity,model_requested:'12b'}}),
    run('3','passed',1,{identity:{...identity,source:{sha256:'b'}}}),run('4','passed',1,{mode:'final'}),
    run('5','passed',1,{identity:{...identity,checkpoint_sha256_declared:'new'}})]).length,5);
});
test('different evaluator implementations and protocols do not share a result group, including legacy reports',()=>{
  const legacy={...identity};delete legacy.evaluator;
  assert.equal(summarizeRuns([run('1','passed',1),
    run('2','passed',1,{identity:{...identity,evaluator:{sha256:'e2'}}}),
    run('3','passed',1,{identity:{...identity,protocol:'json_schema'}}),
    run('4','passed',1,{identity:legacy})]).length,4);
});
test('endpoint and declared deployment differences split groups while unidentified legacy runs stay separate', () => {
  const legacy = {...identity}; delete legacy.endpoint_sha256_declared;
  const reports = [run('1','passed',1), run('2','passed',1),
    run('3','passed',1,{identity:{...identity,endpoint_sha256_declared:sha256('https://other.test/v1')}}),
    run('4','passed',1,{identity:{...identity,deployment_id_sha256_declared:sha256('instance-one')}}),
    run('5','passed',1,{identity:{...identity,deployment_id_sha256_declared:sha256('instance-two')}}),
    run('6','passed',1,{identity:legacy}), run('7','failed',1,{identity:legacy})];
  const groups = summarizeRuns(reports);
  assert.equal(groups.length, 6);
  assert.equal(groups[0].runs, 2);
  assert.ok(groups.slice(-2).every(group => group.runs === 1 && group.endpoint_identity_complete === false));
  assert.ok(groups.every(group => group.environment_identity_verified === false));
});
test('saved web input hashes determine case counts and missing legacy web identity remains unknown',()=>{
  const make=(id,context)=>run(id,'passed',1,{web_context:true,identity:{...identity,context_source:'saved_web_context',context_sha256:context}});
  const [summary]=summarizeRuns([make('1','context-one'),make('2','context-two'),make('3','context-one')]);
  assert.equal(summary.unique_cases,2);
  assert.equal(summary.context_identity_complete,true);
  assert.deepEqual(summary.context_sha256,['context-one','context-two']);
  assert.equal(Object.hasOwn(summary.identity,'context_sha256'),false);
  assert.equal(summarizeRuns([make('1',undefined)])[0].unique_cases,null);
});
test('evaluation identity hashes actual context and evaluator files without including original answers or credentials',()=>{
  const args={backend:fileURLToPath(new URL('../../app/',import.meta.url)),fixtureBytes:Buffer.from('fixture'),
    questionsBytes:Buffer.from('questions'),promptVersion:'v-test',config:{model:'test-model',protocol:'relationship_agent',timeoutMs:100,apiKey:'private-key'},
    contextSource:'saved_web_context',context:{answer:'private synthetic input'}};
  const first=evaluationIdentity(args),second=evaluationIdentity({...args,context:{answer:'different input'}});
  assert.equal(first.context_sha256,sha256(JSON.stringify(args.context)));
  assert.notEqual(first.context_sha256,second.context_sha256);
  assert.equal(first.fixture_sha256,second.fixture_sha256);
  assert.equal(first.evaluator.sha256,second.evaluator.sha256);
  for(const file of first.evaluator.files)assert.equal(file.sha256,sha256(readFileSync(new URL(file.path,import.meta.url))));
  assert.equal(JSON.stringify(first).includes('private'),false);
  assert.equal(evaluationIdentity({...args,context:null}).context_sha256,null);
});
test('endpoint fingerprints exclude credentials, query and fragment and emit no path or deployment secret', () => {
  const args = {backend:fileURLToPath(new URL('../../app/',import.meta.url)),fixtureBytes:'fixture',questionsBytes:'questions',
    promptVersion:'v-test',config:{model:'same-alias',protocol:'relationship_agent',timeoutMs:100,
      baseUrl:'https://private-user:private-pass@server-a.invalid/private-path/v1?api_key=private-key#private-fragment',
      deploymentId:'private-instance'},checkpointSha256:'a'.repeat(64)};
  const first = evaluationIdentity(args);
  const identify = baseUrl => evaluationIdentity({...args,config:{...args.config,baseUrl}});
  const sanitized = identify('https://server-a.invalid/private-path/v1/');
  assert.equal(first.endpoint_sha256_declared, sanitized.endpoint_sha256_declared);
  assert.notEqual(first.endpoint_sha256_declared, identify('https://server-b.invalid/private-path/v1').endpoint_sha256_declared);
  assert.notEqual(first.endpoint_sha256_declared, identify('https://server-a.invalid/other-path/v1').endpoint_sha256_declared);
  assert.equal(first.deployment_id_sha256_declared, sha256('private-instance'));
  assert.equal(first.checkpoint_sha256_declared, 'a'.repeat(64));
  assert.equal(first.runtime_model_identity_verified, false);
  assert.equal(first.deployment_verified, false);
  assert.equal(JSON.stringify(first).includes('private'), false);
  assert.equal(JSON.stringify(first).includes('server-a'), false);
  assert.throws(() => identify('not a URL private-secret'), /^Error: invalid_model_endpoint$/);
});
test('web resume requires the same requested model, protocol, source and prompt, and rejects unidentified legacy sessions',()=>{
  const current={model_requested:'12b',model_protocol:'relationship_agent',source_sha256:'source',prompt_version:'v-new'};
  assert.doesNotThrow(()=>assertWebSessionIdentity({...current},current));
  assert.throws(()=>assertWebSessionIdentity(undefined,current),/test_session_identity_mismatch/);
  for(const key of Object.keys(current)) {
    assert.throws(()=>assertWebSessionIdentity({...current,[key]:'old'},current),/test_session_identity_mismatch/);
    const missing={...current};delete missing[key];
    assert.throws(()=>assertWebSessionIdentity(missing,current),/test_session_identity_mismatch/);
  }
});
test('duplicated runs and malformed failure records are rejected', () => {
  assert.throws(() => summarizeRuns([run('1','passed',1),run('1','passed',1)]), /duplicate/);
  assert.throws(() => summarizeRuns([run('1','failed',undefined)]), /invalid/);
});
test('missing usage is unknown and retries include failed attempts', () => {
  const metrics = attemptMetrics([attempt({reason:'content_json'}),
    attempt({attempt_id:'two',attempt:2,duration_ms:10,usage:{prompt_tokens:4,completion_tokens:3}})]);
  assert.equal(metrics.prompt_tokens,null);
  assert.equal(metrics.completion_tokens,null);
  assert.equal(metrics.retries,1);
  assert.equal(metrics.failed_attempts,1);
  assert.equal(metrics.attempt_wait_ms,30);
});
test('wait events never add requests or usage and identical request records count once', () => {
  const request = attempt({status:503,reason:'http_transient',usage:{prompt_tokens:4,completion_tokens:3}});
  const metrics = attemptMetrics([request, {...request}, wait(), wait()]);
  assert.equal(metrics.attempt_count_verified, true);
  assert.equal(metrics.attempts, 1);
  assert.equal(metrics.failed_attempts, 1);
  assert.equal(metrics.prompt_tokens, 4);
  assert.equal(metrics.completion_tokens, 3);
  assert.equal(metrics.attempt_wait_ms, 20);
  assert.equal(metrics.retry_wait_ms, 100);
  assert.equal(metrics.retry_wait_events, 1);
  assert.equal(metrics.retry_wait_deadlines, 1);
});
test('legacy, mixed and conflicting traces do not claim exact requests, retries or tokens', () => {
  const legacy = [{event:'model_attempt',generation:'state',attempt:1,reason:'http_transient',duration_ms:1},
    {event:'model_attempt',generation:'state',attempt:1,reason:'deadline',duration_ms:100}];
  const current = attempt({duration_ms:10,usage:{prompt_tokens:4,completion_tokens:3}});
  for (const trace of [legacy, [...legacy,current], [current,{...current,reason:'deadline'}]]) {
    const metrics = attemptMetrics(trace);
    assertUnverified(metrics);
  }
  assert.equal(attemptMetrics(legacy).legacy_attempt_events, 2);
  assert.equal(attemptMetrics([current,{...current,reason:'deadline'}]).conflicting_attempt_ids, 1);
  assert.equal(attemptMetrics([{event:'unknown'}]).attempt_count_verified, false);
});

test('missing, malformed and empty traces never certify zero upstream requests', () => {
  for (const trace of [undefined, null, {}, 'truncated', [], [null], [42]]) assertUnverified(attemptMetrics(trace));
  for (const trace of [undefined, null, {}, []]) {
    const [summary] = summarizeRuns([run('1','passed',1,{trace})]);
    assertUnverified(summary);
    assert.equal(summary.passed, 1);
  }
});

test('retry waits require an earlier matching failed request and complete connection fields', () => {
  const failed = attempt({status:503,reason:'http_transient'});
  for (const trace of [[wait()], [wait(),failed], [failed,wait({after_attempt_id:'missing'})],
    [failed,wait({generation_id:'another'})], [failed,wait({generation:'guide'})],
    [failed,wait({request_id:'another'})], [failed,wait({attempt:2})],
    [attempt(),wait()], [failed,wait({delay_ms:undefined})], [failed,wait({after_attempt_id:undefined})],
    [failed,wait(),wait({duration_ms:101})]]) assertUnverified(attemptMetrics(trace));
  assert.ok(attemptMetrics([wait()]).trace_integrity_errors.includes('orphan_retry_wait'));
});

test('generation attempts start at one, stay ordered and cannot continue after termination', () => {
  const repair = attempt({reason:'content_json'});
  const second = attempt({attempt_id:'attempt-two',attempt:2});
  const transient = attempt({reason:'connection_transient',status:null,finish_reason:null});
  for (const trace of [[second], [repair,{...second,attempt:3}], [second,repair],
    [repair,{...second,attempt:1}], [repair,{...second,generation:'guide'}], [repair,{...second,request_id:'another'}],
    [attempt(),second], [attempt({reason:'deadline'}),second], [transient,wait(),second],
    [transient], [transient,second], [attempt({reason:'http_transient'}),second],
    [transient,wait({reason:'retry_ready'})]]) assertUnverified(attemptMetrics(trace));
  for (const key of ['generation_id','generation','attempt','attempt_id','request_id','reason','duration_ms','status','finish_reason','usage']) {
    const incomplete = attempt(); delete incomplete[key];
    assertUnverified(attemptMetrics([incomplete]));
  }
});

test('valid repair, transient retry and independent generation sequences remain measurable', () => {
  const trace = [attempt({reason:'connection_transient',status:null,finish_reason:null}),wait({reason:'retry_ready'}),
    attempt({attempt:2,attempt_id:'attempt-two',reason:'content_json'}),attempt({attempt:3,attempt_id:'attempt-three'}),
    attempt({generation:'guide',generation_id:'generation-two',attempt_id:'attempt-four'})];
  const metrics = attemptMetrics(trace);
  assert.equal(metrics.attempt_count_verified, true);
  assert.equal(metrics.attempts, 4);
  assert.equal(metrics.failed_attempts, 2);
  assert.equal(metrics.retries, 2);
  assert.equal(metrics.retry_wait_events, 1);
  assert.deepEqual(metrics.trace_integrity_errors, []);
  assert.equal(metrics.trace_completeness_verified, false);
  assert.equal(metrics.attempt_count_scope, 'validated_trace_events');
  const exhausted = [attempt({reason:'http_transient'}),wait({reason:'retry_ready'}),
    attempt({attempt:2,attempt_id:'attempt-two',reason:'http_transient'}),wait({attempt:2,after_attempt_id:'attempt-two',reason:'retry_ready'}),
    attempt({attempt:3,attempt_id:'attempt-three',reason:'http_transient'})];
  assert.equal(attemptMetrics(exhausted).attempt_count_verified, true);
  assert.equal(attemptMetrics(exhausted).failed_attempts, 3);
});

test('run aggregation cannot fill missing events from a different run or reuse request IDs', () => {
  const failed = attempt({status:503,reason:'http_transient'});
  for (const traces of [[undefined,[attempt()]], [[failed],[wait()]], [[attempt()],[attempt()]]]) {
    const [summary] = summarizeRuns(traces.map((trace,index) => run(String(index),'passed',1,{trace})));
    assertUnverified(summary);
  }
  const [summary] = summarizeRuns([run('1','passed',1,{trace:[attempt()]}),
    run('2','passed',1,{trace:[attempt({generation_id:'generation-two',attempt_id:'attempt-two'})]})]);
  assert.equal(summary.attempt_count_verified, true);
  assert.equal(summary.attempts, 2);
});
