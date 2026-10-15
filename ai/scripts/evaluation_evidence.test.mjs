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
});

const identity = { model_requested:'31b', source:{sha256:'a'}, evaluator:{sha256:'e1'}, prompt_version:'v1',
  context_source:'synthetic_fixture', protocol:'relationship_agent', fixture_sha256:'one', questions_sha256:'q', timeout_ms:600000 };
const run = (id,status,duration,overrides={}) => ({ run_id:id, status, duration_ms:duration, mode:'state', identity, trace:[], ...overrides });
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
  const metrics = attemptMetrics([{attempt:1,reason:'timeout',duration_ms:20},
    {attempt:2,reason:'success',duration_ms:10,usage:{prompt_tokens:4,completion_tokens:3}}]);
  assert.equal(metrics.prompt_tokens,null);
  assert.equal(metrics.completion_tokens,null);
  assert.equal(metrics.retries,1);
  assert.equal(metrics.failed_attempts,1);
  assert.equal(metrics.attempt_wait_ms,30);
});
