import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {ModelGateway} from '../src/model.js';
import {configuredReviewGateway} from '../src/model-review.js';
import {createApp} from '../src/server.js';
import {Store} from '../src/store.js';

const base='http://192.0.2.20:11434/v1';

test('review configuration is opt-in and applies the required separate-model defaults',()=>{
  for(const env of [{},{MODEL_REVIEW_BASE_URL:''}])assert.equal(configuredReviewGateway({env}),null);
  const gateway=configuredReviewGateway({env:{MODEL_REVIEW_BASE_URL:base},defaultModel:'gemma4:12b'});
  assert.ok(gateway instanceof ModelGateway);assert.equal(gateway.configured,true);
  assert.equal(gateway.baseUrl,base);assert.equal(gateway.model,'gemma4:12b');assert.equal(gateway.apiKey,'local-ollama');
  assert.equal(gateway.protocol,'relationship_agent');assert.equal(gateway.agentFormat,'json_schema');
  assert.equal(gateway.timeoutMs,0);assert.equal(gateway.retryFailures,true);assert.equal(gateway.streamJson,false);
  assert.equal(gateway.streamCompleteJson,false);
  assert.equal(gateway.discoverTokenLimits,true);assert.equal(gateway.preserveStringLimits,false);
});

test('review configuration respects explicit model, key, schema and injected diagnostics without contacting a server',()=>{
  const diagnosticLogger=()=>{},fetchImpl=()=>assert.fail('configuration must not make requests');
  const gateway=configuredReviewGateway({env:{MODEL_REVIEW_BASE_URL:base+'/',MODEL_REVIEW_NAME:'synthetic-reviewer',
    MODEL_REVIEW_API_KEY:'synthetic-review-key',MODEL_REVIEW_SCHEMA_STRING_LIMITS:'true',MODEL_STREAM_JSON:'true'},
    defaultModel:'synthetic-generator',diagnosticLogger,fetchImpl});
  assert.equal(gateway.baseUrl,base);assert.equal(gateway.model,'synthetic-reviewer');assert.equal(gateway.apiKey,'synthetic-review-key');
  assert.equal(gateway.preserveStringLimits,true);assert.equal(gateway.streamJson,false);
  assert.equal(gateway.diagnosticLogger,diagnosticLogger);assert.equal(gateway.fetchImpl,fetchImpl);
  assert.equal(gateway.configured,true);
});

test('review reasoning is independently configurable without changing writer settings',()=>{
  for(const reasoningEffort of ['omit','none','low','medium','high']){
    const review=configuredReviewGateway({env:{MODEL_REVIEW_BASE_URL:base,MODEL_REVIEW_REASONING_EFFORT:reasoningEffort},defaultModel:'gemma4:12b'});
    assert.equal(review.reasoningEffort,reasoningEffort);assert.equal(review.configured,true);
  }
  for(const value of ['', 'invalid-private-value', 'LOW'])assert.throws(()=>configuredReviewGateway({
    env:{MODEL_REVIEW_BASE_URL:base,MODEL_REVIEW_REASONING_EFFORT:value},defaultModel:'gemma4:12b'}),error=>{
    assert.match(error.message,/Invalid MODEL_REVIEW configuration/);assert.ok(!error.message.includes(value)||value==='');return true;
  });
});

test('review streaming is opt-in and restricted to local aliases, numeric loopback or RFC1918 IPv4 endpoints',()=>{
  for(const origin of ['http://localhost:11434','http://host.docker.internal:11434','http://127.0.0.1:11434','http://127.8.0.1:11434','http://[::1]:11434',
    'http://10.0.0.1:11434','http://172.16.0.1:11434','http://172.31.255.254:11434','http://192.168.123.175:11434']){
    const gateway=configuredReviewGateway({env:{MODEL_REVIEW_BASE_URL:origin+'/v1',MODEL_REVIEW_STREAM_JSON:'true'},defaultModel:'gemma4:12b'});
    assert.equal(gateway.streamJson,true);assert.equal(gateway.configured,true);
  }
  for(const endpoint of [base,'http://172.15.255.255/v1','http://172.32.0.0/v1',
    'http://192.168.123.175.remote.example/v1','http://165.194.161.61:20522/v1','http://[::ffff:192.168.123.175]/v1']){
    assert.throws(()=>configuredReviewGateway({env:{MODEL_REVIEW_BASE_URL:endpoint,MODEL_REVIEW_STREAM_JSON:'true'},defaultModel:'gemma4:12b'}),/Invalid MODEL_REVIEW configuration/);
  }
  for(const value of ['false','TRUE','1'])assert.equal(configuredReviewGateway({env:{MODEL_REVIEW_BASE_URL:base,MODEL_REVIEW_STREAM_JSON:value},defaultModel:'gemma4:12b'}).streamJson,false);
});

test('invalid review endpoints, credentials and names fail without exposing their values',()=>{
  const invalid=[
    {MODEL_REVIEW_BASE_URL:'not-a-url'}, {MODEL_REVIEW_BASE_URL:'ftp://private.example/v1'},
    {MODEL_REVIEW_BASE_URL:'http://user:synthetic-secret@127.0.0.1:11434/v1'},
    {MODEL_REVIEW_BASE_URL:base+'?key=synthetic-secret'}, {MODEL_REVIEW_BASE_URL:base+'#private'},
    ...['','   ','synthetic-secret\nkey','한글키'].map(value=>({MODEL_REVIEW_API_KEY:value})),
    ...['','   ',42].map(value=>({MODEL_REVIEW_NAME:value})),
  ];
  for(const override of invalid)assert.throws(()=>configuredReviewGateway({env:{MODEL_REVIEW_BASE_URL:base,...override},defaultModel:'gemma4:12b'}),error=>{
    assert.match(error.message,/Invalid MODEL_REVIEW configuration/);assert.doesNotMatch(error.message,/synthetic-secret|private\.example|한글키/);return true;
  });
});

test('compose forwards model format and opt-in review settings with matching defaults',()=>{
  const source=readFileSync(new URL('../compose.yaml',import.meta.url),'utf8');
  const settings=Object.fromEntries([...source.matchAll(/^      (MODEL_[A-Z_]+): (.+)$/gm)].map(([,key,value])=>[key,value]));
  assert.equal(settings.MODEL_STREAM_JSON,'${MODEL_STREAM_JSON:-false}');
  assert.equal(settings.MODEL_STREAM_COMPLETE_JSON,'${MODEL_STREAM_COMPLETE_JSON:-false}');
  assert.equal(settings.MODEL_SCHEMA_STRING_LIMITS,'${MODEL_SCHEMA_STRING_LIMITS:-false}');
  assert.equal(settings.MODEL_REVIEW_BASE_URL,'${MODEL_REVIEW_BASE_URL:-}');
  assert.equal(settings.MODEL_REVIEW_NAME,'${MODEL_REVIEW_NAME-${MODEL_NAME:-gemma4:12b}}');
  assert.equal(settings.MODEL_REVIEW_REASONING_EFFORT,'${MODEL_REVIEW_REASONING_EFFORT:-none}');
  assert.equal(settings.MODEL_REVIEW_API_KEY,'${MODEL_REVIEW_API_KEY-local-ollama}');
  assert.equal(settings.MODEL_REVIEW_STREAM_JSON,'${MODEL_REVIEW_STREAM_JSON:-false}');
  assert.equal(settings.MODEL_REVIEW_STREAM_COMPLETE_JSON,'${MODEL_REVIEW_STREAM_COMPLETE_JSON:-false}');
  assert.equal(settings.MODEL_REVIEW_SCHEMA_STRING_LIMITS,'${MODEL_REVIEW_SCHEMA_STRING_LIMITS:-false}');
  assert.match(source,/^      REFERRAL_MODEL_STREAM_COMPLETE_JSON: \$\{REFERRAL_MODEL_STREAM_COMPLETE_JSON:-false\}$/m);
  assert.match(source,/^      MODEL_DISCOVER_TOKEN_LIMITS: \$\{MODEL_DISCOVER_TOKEN_LIMITS-true\}$/m);
  assert.match(source,/^      MODEL_REVIEW_DISCOVER_TOKEN_LIMITS: \$\{MODEL_REVIEW_DISCOVER_TOKEN_LIMITS-true\}$/m);
  assert.match(source,/^      REFERRAL_MODEL_DISCOVER_TOKEN_LIMITS: \$\{REFERRAL_MODEL_DISCOVER_TOKEN_LIMITS-\$\{MODEL_DISCOVER_TOKEN_LIMITS-true\}\}$/m);
  const exampleSource=readFileSync(new URL('../.env.example',import.meta.url),'utf8'),example=parseEnv(exampleSource);
  assert.equal(configuredReviewGateway({env:example,defaultModel:example.MODEL_NAME}),null);
});

function modelEnv(t,values){
  for(const [key,value] of Object.entries(values)){
    const previous=process.env[key];process.env[key]=value;
    t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});
  }
}

test('invalid default reviewer configuration fails before connecting the store',async t=>{
  modelEnv(t,{MODEL_BASE_URL:'http://127.0.0.1:11434/v1',MODEL_API_KEY:'synthetic-primary',MODEL_NAME:'gemma4:12b',MODEL_REVIEW_BASE_URL:'invalid-review-url'});
  const connect=t.mock.method(Store,'connect',()=>assert.fail('invalid review configuration must not open a pool'));
  await assert.rejects(createApp({databaseUrl:'unused',key:randomBytes(32),referralProvider:null}),/Invalid MODEL_REVIEW configuration/);
  assert.equal(connect.mock.callCount(),0);
});

for(const gateway of [null,{model:'synthetic-injected'}])test(`an injected ${gateway?'gateway':'null gateway'} ignores review environment settings`,async t=>{
  modelEnv(t,{MODEL_BASE_URL:'http://127.0.0.1:11434/v1',MODEL_API_KEY:'synthetic-primary',MODEL_REVIEW_BASE_URL:'invalid-review-url'});
  let closed=0;
  const store={async purgeExpired(){},async close(){closed++;}};
  t.mock.method(Store,'connect',async()=>store);
  const app=await createApp({databaseUrl:'unused',key:randomBytes(32),gateway,referralProvider:null});
  await app.shutdown();assert.equal(closed,1);
});
