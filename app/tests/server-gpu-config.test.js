import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {configuredModelGateway, configuredReviewGateway, configuredServerGpuReferralGateway} from '../src/model-config.js';
import {configuredReferralProvider} from '../src/referral-runtime.js';

const GPU_MODEL = 'malssi-gemma4-31b-v11-epoch3';
const gpuEnv = overrides => ({MODEL_SERVER_GPU_ONLY:'true', MODEL_BASE_URL:'http://127.0.0.1:18080/v1',
  MODEL_NAME:GPU_MODEL, MODEL_API_KEY:'synthetic-gpu-key', MODEL_DISCOVER_TOKEN_LIMITS:'false',
  MODEL_REVIEW_DISCOVER_TOKEN_LIMITS:'false', ...overrides});
const schema = {type:'object',properties:{approved:{type:'boolean'}},required:['approved'],additionalProperties:false};
const neverFetch = () => assert.fail('configuration must not contact an endpoint');

test('server GPU mode builds a separate reviewer on the exact writer target without a local fallback', () => {
  const gateway = configuredModelGateway({env:gpuEnv(), fetchImpl:neverFetch});
  assert.equal(gateway.protocol, 'relationship_agent');
  assert.notEqual(gateway.reviewGateway, gateway);
  for (const selected of [gateway, gateway.reviewGateway]) {
    assert.equal(selected.baseUrl, 'http://127.0.0.1:18080/v1');
    assert.equal(selected.model, GPU_MODEL);
    assert.equal(selected.apiKey, 'synthetic-gpu-key');
    assert.equal(selected.apiProfile, 'trained_chat');
    assert.equal(selected.serverGpuOnly, true);
    assert.equal(selected.agentFormat, 'prompt');
    assert.equal(selected.reasoningEffort, 'omit');
    assert.equal(selected.streamJson, false);
    assert.equal(selected.streamCompleteJson, false);
    assert.equal(selected.timeoutMs, 0);
    assert.equal(selected.configured, true);
  }
  const direct = configuredReviewGateway({env:gpuEnv(), fetchImpl:neverFetch});
  assert.equal(direct.baseUrl, gateway.baseUrl);
  assert.equal(direct.model, gateway.model);
  assert.equal(direct.apiKey, gateway.apiKey);
});

test('GPU target equality uses effective normalized native/container endpoints', () => {
  for (const env of [
    gpuEnv({MODEL_REVIEW_BASE_URL:'http://127.0.0.1:18080/v1/chat/completions/',
      REFERRAL_MODEL_BASE_URL:'http://127.0.0.1:18080'}),
    gpuEnv({DEMO_CONTAINER:'true',MODEL_DOCKER_BASE_URL:'http://gpu-bridge:18080',
      MODEL_REVIEW_DOCKER_BASE_URL:'http://gpu-bridge:18080/v1',REFERRAL_MODEL_DOCKER_BASE_URL:'http://gpu-bridge:18080/v1'}),
  ]) {
    const gateway = configuredModelGateway({env, fetchImpl:neverFetch});
    assert.equal(gateway.reviewGateway.baseUrl, gateway.baseUrl);
    assert.equal(configuredServerGpuReferralGateway({gateway,env}), gateway);
  }
});

test('GPU mode rejects missing primary identity, credentials, incompatible protocols and nonboolean opt-ins', () => {
  const rejected = [
    {MODEL_BASE_URL:undefined}, {MODEL_NAME:undefined}, {MODEL_NAME:''}, {MODEL_API_KEY:undefined},
    {MODEL_API_KEY:''}, {MODEL_API_KEY:' '}, {MODEL_API_KEY:'PRIVATE_SECRET\n'},
    {MODEL_PROTOCOL:'json_schema'}, {MODEL_PROTOCOL:'json_prompt'}, {MODEL_API_PROFILE:'default'},
    ...['', 'TRUE', '1', true, null].map(MODEL_SERVER_GPU_ONLY=>({MODEL_SERVER_GPU_ONLY})),
  ];
  for (const override of rejected) assert.throws(() => configuredModelGateway({env:gpuEnv(override),fetchImpl:neverFetch}), error => {
    assert.match(error.message, /Invalid MODEL configuration/);
    assert.doesNotMatch(error.message, /PRIVATE_SECRET/);
    return true;
  });
});

test('GPU mode rejects stale reviewer and referral overrides even before any inference', () => {
  for (const prefix of ['MODEL_REVIEW', 'REFERRAL_MODEL']) for (const change of [
    {[prefix+'_BASE_URL']:'http://127.0.0.1:11434/v1'},
    {[prefix+'_NAME']:'gemma4:12b'}, {[prefix+'_API_KEY']:'PRIVATE_SECRET'},
    {[prefix+'_NAME']:''}, {[prefix+'_API_KEY']:''}, {[prefix+'_API_PROFILE']:'default'},
    {[prefix+'_AGENT_FORMAT']:'json_schema'}, {[prefix+'_REASONING_EFFORT']:'none'},
    {[prefix+'_STREAM_JSON']:'TRUE'}, {[prefix+'_STREAM_COMPLETE_JSON']:'true'},
  ]) assert.throws(() => configuredModelGateway({env:gpuEnv(change),fetchImpl:neverFetch}), error => {
    assert.match(error.message, new RegExp('Invalid '+prefix+' configuration'));
    assert.doesNotMatch(error.message, /PRIVATE_SECRET/);
    return true;
  });
});

test('trained_chat profile is strict and independent without enabling GPU-only routing', () => {
  const base = {MODEL_BASE_URL:'http://127.0.0.1:18080/v1',MODEL_NAME:GPU_MODEL,MODEL_API_KEY:'synthetic-key',MODEL_API_PROFILE:'trained_chat'};
  const writer = configuredModelGateway({env:base,fetchImpl:neverFetch});
  assert.equal(writer.serverGpuOnly, false);
  assert.equal(writer.reviewGateway, null);
  assert.equal(writer.agentFormat, 'prompt');
  assert.equal(writer.reasoningEffort, 'omit');
  assert.equal(configuredModelGateway({env:{...base,MODEL_PROTOCOL:'json_prompt'}}).protocol, 'json_prompt');
  for (const override of [
    {MODEL_PROTOCOL:'json_schema'}, {MODEL_AGENT_FORMAT:'json_schema'}, {MODEL_AGENT_FORMAT:'json_object'},
    {MODEL_REASONING_EFFORT:'none'}, {MODEL_STREAM_COMPLETE_JSON:'true'},
    {MODEL_API_PROFILE:'unknown'}, {MODEL_API_PROFILE:null}, {MODEL_AGENT_FORMAT:null}, {MODEL_REASONING_EFFORT:null},
    {MODEL_STREAM_JSON:'TRUE'}, {MODEL_STREAM_COMPLETE_JSON:true},
  ]) assert.throws(() => configuredModelGateway({env:{...base,...override},fetchImpl:neverFetch}), /Invalid MODEL configuration/);
  const review = configuredReviewGateway({env:{MODEL_REVIEW_BASE_URL:base.MODEL_BASE_URL,MODEL_REVIEW_API_PROFILE:'trained_chat'}});
  assert.equal(review.agentFormat, 'prompt');
  assert.equal(review.reasoningEffort, 'omit');
  assert.equal(review.serverGpuOnly, false);
});

test('unset or explicitly false GPU mode preserves legacy destinations, defaults and optional reviewer', () => {
  for (const flag of [undefined,'false']) {
    const env = {MODEL_BASE_URL:'http://127.0.0.1:11434',...(flag===undefined?{}:{MODEL_SERVER_GPU_ONLY:flag})};
    const gateway = configuredModelGateway({env,fetchImpl:neverFetch});
    assert.equal(gateway.apiProfile, 'default');
    assert.equal(gateway.apiKey, 'local-ollama');
    assert.equal(gateway.model, 'gemma4:12b');
    assert.equal(gateway.agentFormat, 'json_schema');
    assert.equal(gateway.reasoningEffort, 'none');
    assert.equal(gateway.reviewGateway, null);
    assert.equal(gateway.timeoutMs, 0);
    const separate = configuredModelGateway({env:{...env,MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435',MODEL_REVIEW_NAME:'other'}});
    assert.equal(separate.reviewGateway.baseUrl, 'http://127.0.0.1:11435/v1');
    assert.equal(separate.reviewGateway.model, 'other');
  }
});

test('referral provider in GPU mode reuses the shared gateway and rejects an injected alternate target', () => {
  const env = gpuEnv();
  const gateway = configuredModelGateway({env,fetchImpl:neverFetch});
  const provider = configuredReferralProvider({gateway,env});
  assert.ok(JSON.parse(provider.cacheKey).includes(gateway.baseUrl));
  assert.ok(JSON.parse(provider.cacheKey).includes(GPU_MODEL));
  assert.equal(provider.cacheKey.includes('synthetic-gpu-key'), false);
  assert.equal(configuredServerGpuReferralGateway({gateway,env:{}}), gateway);
  for (const override of [
    {REFERRAL_MODEL_BASE_URL:'http://127.0.0.1:11434'}, {REFERRAL_MODEL_NAME:'gemma4:12b'},
    {REFERRAL_MODEL_API_KEY:'another'}, {REFERRAL_MODEL_API_PROFILE:'default'}, {REFERRAL_MODEL_STREAM_COMPLETE_JSON:'true'},
  ]) assert.throws(() => configuredReferralProvider({gateway,env:{...env,...override}}), /Invalid REFERRAL_MODEL configuration/);
  const alternate = configuredModelGateway({env:gpuEnv({MODEL_BASE_URL:'http://127.0.0.1:18091'})});
  assert.throws(() => configuredReferralProvider({gateway:alternate,env}), /Invalid REFERRAL_MODEL configuration/);
  assert.throws(() => configuredReferralProvider({gateway:null,env}), /Invalid REFERRAL_MODEL configuration/);
});

test('actual writer, reviewer and referral request bodies satisfy the existing GPU API without network calls', async () => {
  const calls = [];
  const env = gpuEnv();
  const gateway = configuredModelGateway({env,diagnosticLogger:null,retryFailures:false,fetchImpl:async (url,options) => {
    assert.equal(options.method, 'POST');
    assert.equal(url, env.MODEL_BASE_URL+'/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer synthetic-gpu-key');
    calls.push(JSON.parse(options.body));
    return new Response(JSON.stringify({choices:[{message:{content:'{"approved":true}'},finish_reason:'stop'}]}),
      {headers:{'content-type':'application/json'}});
  }});
  for (const stage of ['turn_draft_block_name_index','guide_review','referral_triage','referral_triage_independent']) {
    const target = stage.startsWith('referral') ? configuredServerGpuReferralGateway({gateway,env}) : gateway;
    const result = await target.operation({}, operation => target.agentComplete(stage,'Synthetic contract test.',{},schema,operation,value => {
      assert.deepEqual(value,{approved:true});return value;
    }));
    assert.deepEqual(result,{approved:true});
  }
  assert.equal(calls.length, 4);
  for (const body of calls) {
    assert.equal(body.stream, false);
    assert.equal(body.model, GPU_MODEL);
    assert.equal(body.response_format, undefined);
    assert.equal(body.reasoning_effort, undefined);
    assert.equal(body.stream_options, undefined);
    assert.deepEqual(JSON.parse(body.messages.at(-1).content).output_schema,schema);
  }
  const python = `import json,sys\nsys.path.insert(0,sys.argv[1])\nfrom server import validate_request\nconfig={'model_id':sys.argv[2],'default_output_tokens':8192,'max_output_tokens':8192}\nfor body in json.load(sys.stdin): validate_request(body,config)\nprint('accepted')\n`;
  const output = execFileSync('python3',['-B','-c',python,fileURLToPath(new URL('../../ai/trained_model_api',import.meta.url)),GPU_MODEL],
    {input:JSON.stringify(calls),encoding:'utf8'});
  assert.equal(output.trim(),'accepted');
});


test('GPU writer, independent reviewer and shared referral stream without accepting early JSON completion',()=>{
 const env=gpuEnv({MODEL_STREAM_JSON:'true',MODEL_REVIEW_STREAM_JSON:'true',REFERRAL_MODEL_STREAM_JSON:'true',MODEL_STREAM_COMPLETE_JSON:'false',MODEL_REVIEW_STREAM_COMPLETE_JSON:'false',REFERRAL_MODEL_STREAM_COMPLETE_JSON:'false'});
 const gateway=configuredModelGateway({env,fetchImpl:neverFetch});
 for(const value of [gateway,gateway.reviewGateway,configuredServerGpuReferralGateway({gateway,env})]){assert.ok(value);assert.equal(value.streamJson,true);assert.equal(value.streamCompleteJson,false);assert.equal(value.apiProfile,'trained_chat');}
 assert.ok(configuredReferralProvider({gateway,env}));
 for(const prefix of ['MODEL','MODEL_REVIEW','REFERRAL_MODEL'])assert.throws(()=>configuredModelGateway({env:{...env,[prefix+'_STREAM_COMPLETE_JSON']:'true'},fetchImpl:neverFetch}),/Invalid (?:MODEL|MODEL_REVIEW|REFERRAL_MODEL) configuration/);
});
