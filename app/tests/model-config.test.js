import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {ModelGateway} from '../src/model.js';
import {configuredModelGateway, configuredReviewGateway, resolveModelBaseUrl} from '../src/model-config.js';
import {createApp} from '../src/server.js';
import {Store} from '../src/store.js';

test('two-request turns, joint analysis/plan and compact output are explicit valid opt-ins',()=>{
  const env={MODEL_BASE_URL:'http://127.0.0.1:11434',MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined',MODEL_BUNDLE_FINAL_REVIEWS:'true'};
  const keys={MODEL_BUNDLE_COMBINED_TURN_REVIEWS:'bundleCombinedTurnReviews',MODEL_BUNDLE_ANALYSIS_PLAN:'bundleAnalysisPlan',MODEL_COMPACT_REVIEW_OUTPUT:'compactReviewOutput',MODEL_COMPACT_TURN_REVIEW_OUTPUT:'compactTurnReviewOutput',MODEL_COMBINED_TURN_EVIDENCE_IDS:'combinedTurnEvidenceIds',MODEL_SAFETY_REVIEW_SELECTION_MAP:'safetyReviewSelectionMap',MODEL_DETAILED_CARD_ANALYSIS:'detailedCardAnalysis'};
  for(const [key,option]of Object.entries(keys)){
    assert.equal(configuredModelGateway({env})[option],false);
    assert.equal(configuredModelGateway({env:{...env,[key]:'true'}})[option],true);
    for(const value of ['yes','TRUE','1',true,null])assert.throws(()=>configuredModelGateway({env:{...env,[key]:value}}),/Invalid MODEL configuration/);
    assert.throws(()=>configuredModelGateway({env:{...env,[key]:'true',MODEL_PROTOCOL:'json_schema'}}),/Invalid MODEL configuration/);
  }
  assert.throws(()=>configuredModelGateway({env:{...env,MODEL_BUNDLE_COMBINED_TURN_REVIEWS:'true',MODEL_STATE_MODE:'combined_blocks'}}),/Invalid MODEL configuration/);
  assert.throws(()=>configuredModelGateway({env:{...env,MODEL_BUNDLE_ANALYSIS_PLAN:'true',MODEL_BUNDLE_FINAL_REVIEWS:'false'}}),/Invalid MODEL configuration/);
  const writer=configuredModelGateway({env:{...env,MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435',MODEL_COMPACT_REVIEW_OUTPUT:'true'}});
  assert.equal(writer.reviewGateway.compactReviewOutput,false);
  const reviewer=configuredReviewGateway({env:{...env,MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435',MODEL_REVIEW_COMPACT_REVIEW_OUTPUT:'true'}});
  assert.equal(reviewer.compactReviewOutput,true);
});

test('review batching and reviewed-name reuse retain independent reviewer configuration and reject incompatible modes',()=>{
  const env={MODEL_BASE_URL:'http://127.0.0.1:11434',MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined_blocks',
    MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435'};
  const plain=configuredModelGateway({env});
  assert.equal(plain.bundleTurnReviews,false);assert.equal(plain.bundleFinalReviews,false);assert.equal(plain.reuseReviewedName,false);assert.equal(plain.reuseReviewedSafety,false);
  const enabled=configuredModelGateway({env:{...env,MODEL_BUNDLE_TURN_REVIEWS:'true',MODEL_BUNDLE_FINAL_REVIEWS:'true',MODEL_REUSE_REVIEWED_NAME:'true',MODEL_REUSE_REVIEWED_SAFETY:'true'}});
  assert.equal(enabled.bundleTurnReviews,true);assert.equal(enabled.reviewGateway.bundleTurnReviews,false);assert.equal(enabled.bundleFinalReviews,true);assert.equal(enabled.reuseReviewedName,true);
  assert.equal(enabled.skipFinalExtras,false);
  assert.equal(enabled.reviewGateway.bundleFinalReviews,false);assert.equal(enabled.reviewGateway.reuseReviewedName,false);
  assert.equal(enabled.reuseReviewedSafety,true);assert.equal(enabled.reviewGateway.reuseReviewedSafety,false);
  assert.notEqual(enabled.reviewedNameIdentity,plain.reviewedNameIdentity);
  for(const key of ['MODEL_BUNDLE_TURN_REVIEWS','MODEL_BUNDLE_FINAL_REVIEWS','MODEL_REUSE_REVIEWED_NAME','MODEL_REUSE_REVIEWED_SAFETY']){
    for(const value of ['yes','TRUE','1',true,null])assert.throws(()=>configuredModelGateway({env:{...env,[key]:value}}),/Invalid MODEL configuration/);
    assert.throws(()=>configuredModelGateway({env:{...env,[key]:'true',MODEL_PROTOCOL:'json_schema'}}),/Invalid MODEL configuration/);
  }
  assert.throws(()=>configuredModelGateway({env:{...env,MODEL_BUNDLE_FINAL_REVIEWS:'true',MODEL_SKIP_FINAL_EXTRAS:'true'}}),/Invalid MODEL configuration/);
  assert.throws(()=>configuredModelGateway({env:{...env,MODEL_BUNDLE_TURN_REVIEWS:'true',MODEL_STATE_MODE:'combined'}}),/Invalid MODEL configuration/);
  assert.throws(()=>configuredModelGateway({env:{...env,MODEL_REUSE_REVIEWED_NAME:'true',MODEL_STATE_MODE:'combined'}}),/Invalid MODEL configuration/);
  assert.throws(()=>configuredModelGateway({env:{...env,MODEL_REUSE_REVIEWED_SAFETY:'true',MODEL_STATE_MODE:'combined'}}),/Invalid MODEL configuration/);
});

test('review source sharing, task repair and extended final evidence are strict isolated opt-ins',()=>{
  const env={MODEL_BASE_URL:'http://127.0.0.1:11434',MODEL_PROTOCOL:'relationship_agent',MODEL_BUNDLE_FINAL_REVIEWS:'true',MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435'};
  const keys={MODEL_SHARE_REVIEW_SOURCES:'shareReviewSources',MODEL_REPAIR_REVIEW_BUNDLE_TASKS:'repairReviewBundleTasks',MODEL_EXTENDED_FINAL_EVIDENCE_IDS:'extendedFinalEvidenceIds'};
  for(const [key,option] of Object.entries(keys)) {
    assert.equal(configuredModelGateway({env})[option],false);
    const gateway=configuredModelGateway({env:{...env,[key]:'true'}});
    assert.equal(gateway[option],true);assert.equal(gateway.reviewGateway[option],false);
    for(const value of ['1','TRUE',true,null])assert.throws(()=>configuredModelGateway({env:{...env,[key]:value}}),/Invalid MODEL configuration/);
    assert.throws(()=>configuredModelGateway({env:{...env,[key]:'true',MODEL_PROTOCOL:'json_schema'}}),/Invalid MODEL configuration/);
    if(key!=='MODEL_EXTENDED_FINAL_EVIDENCE_IDS')assert.throws(()=>configuredModelGateway({env:{...env,[key]:'true',MODEL_BUNDLE_FINAL_REVIEWS:'false'}}),/Invalid MODEL configuration/);
  }
});

test('native model roots, compatible completion URLs and custom prefixes resolve without a network request',()=>{
  for(const [source,expected] of [
    ['http://localhost:11434','http://localhost:11434/v1'],
    ['http://127.0.0.1:11434/','http://127.0.0.1:11434/v1'],
    ['http://[::1]:11434/v1/','http://[::1]:11434/v1'],
    ['http://localhost:11434/v1/chat/completions','http://localhost:11434/v1'],
    ['https://api.example.test/proxy/v1/chat/completions/','https://api.example.test/proxy/v1'],
    ['http://192.168.1.50:8080/custom-api/','http://192.168.1.50:8080/custom-api'],
  ])assert.equal(resolveModelBaseUrl(source),expected);
  assert.equal(resolveModelBaseUrl(undefined),'');
  assert.equal(resolveModelBaseUrl('',{dockerBaseUrl:'http://model-container:11434/v1'}),'');
});

test('Docker maps host loopback only and respects an explicit per-model destination',()=>{
  for(const source of ['http://localhost:11434','http://127.0.0.1:11434','http://127.8.0.1:11434','http://[::1]:11434'])
    assert.equal(resolveModelBaseUrl(source,{container:true}),'http://host.docker.internal:11434/v1');
  for(const source of ['http://192.168.123.175:11434/v1','http://model-container:11434/v1','https://api.example.test/proxy/v1',
    'http://127.0.0.1.remote.example/v1'])
    assert.equal(resolveModelBaseUrl(source,{container:true}),source);
  assert.equal(resolveModelBaseUrl('http://localhost:11434/v1',{
    container:true,dockerBaseUrl:'http://ollama:11434/v1/chat/completions',
  }),'http://ollama:11434/v1');
  assert.equal(resolveModelBaseUrl(undefined,{container:true,dockerBaseUrl:'http://ollama:11434'}),'http://ollama:11434/v1');
  assert.equal(resolveModelBaseUrl('http://127.0.0.1:11434/v1',{container:true,dockerBaseUrl:''}),'http://host.docker.internal:11434/v1');
});

test('invalid endpoint forms are rejected without including destination credentials or query data',()=>{
  for(const source of [42,'  ','not-a-url','file:///private/model','http://user:PRIVATE_SECRET@localhost:11434/v1',
    'http://localhost:11434/v1?key=PRIVATE_SECRET','http://localhost:11434/v1#PRIVATE_SECRET']){
    assert.throws(()=>resolveModelBaseUrl(source),error=>{
      assert.match(error.message,/Invalid MODEL configuration/);assert.doesNotMatch(error.message,/PRIVATE_SECRET|private\/model/);return true;
    });
  }
  assert.throws(()=>resolveModelBaseUrl('http://localhost:11434',{container:true,dockerBaseUrl:'invalid-private-override'}),/Invalid MODEL configuration/);
});

test('a configured local API works without a real API credential and uses the same default model everywhere',()=>{
  const neverFetch=()=>assert.fail('constructing model settings must not make a request');
  assert.equal(configuredModelGateway({env:{MODEL_API_KEY:'unused'},fetchImpl:neverFetch}),null);
  for(const base of ['http://localhost:11434','http://127.8.0.1:11434/v1','http://[::1]:11434/v1',
    'http://host.docker.internal:11434/v1','http://10.1.2.3:11434/v1','http://172.16.0.1:11434/v1','http://192.168.123.175:11434/v1']){
    for(const key of [undefined,'','   ']){
      const gateway=configuredModelGateway({env:{MODEL_BASE_URL:base,MODEL_API_KEY:key},fetchImpl:neverFetch});
      assert.ok(gateway instanceof ModelGateway);assert.equal(gateway.configured,true);assert.equal(gateway.apiKey,'local-ollama');
      assert.equal(gateway.model,'gemma4:12b');assert.equal(gateway.protocol,'relationship_agent');
      assert.equal(gateway.timeoutMs,0);assert.equal(gateway.retryFailures,true);assert.equal(gateway.discoverTokenLimits,true);
    }
  }
});

test('public addresses and lookalike DNS names do not silently receive a dummy writer credential',()=>{
  for(const base of ['https://api.example.test/v1','http://192.0.2.20:11434/v1','http://172.15.0.1:11434/v1',
    'http://127.0.0.1.remote.example/v1','http://host.docker.internal.remote.example/v1']){
    assert.throws(()=>configuredModelGateway({env:{MODEL_BASE_URL:base}}),/Invalid MODEL configuration/);
    const gateway=configuredModelGateway({env:{MODEL_BASE_URL:base,MODEL_API_KEY:'synthetic-api-key'}});
    assert.equal(gateway.apiKey,'synthetic-api-key');assert.equal(gateway.configured,true);
  }
});

test('writer and reviewer use matching Docker resolution and retain independent formats and reasoning',()=>{
  const diagnosticLogger=()=>{},fetchImpl=()=>assert.fail('configuration must not make requests');
  const gateway=configuredModelGateway({env:{DEMO_CONTAINER:'true',MODEL_BASE_URL:'http://localhost:11434',
    MODEL_NAME:'synthetic-writer',MODEL_AGENT_FORMAT:'prompt',MODEL_REASONING_EFFORT:'omit',
    MODEL_REVIEW_BASE_URL:'http://[::1]:18080/v1',MODEL_REVIEW_DOCKER_BASE_URL:'http://reviewer:18080/v1',
    MODEL_REVIEW_NAME:'synthetic-reviewer',MODEL_REVIEW_AGENT_FORMAT:'json_object',MODEL_REVIEW_REASONING_EFFORT:'low',
    MODEL_REVIEW_API_KEY:'synthetic-review-key',MODEL_REVIEW_SCHEMA_STRING_LIMITS:'true'},
    diagnosticLogger,fetchImpl,retryFailures:false});
  assert.equal(gateway.baseUrl,'http://host.docker.internal:11434/v1');
  assert.equal(gateway.agentFormat,'prompt');assert.equal(gateway.reasoningEffort,'omit');assert.equal(gateway.retryFailures,false);
  const reviewer=gateway.reviewGateway;
  assert.equal(reviewer.baseUrl,'http://reviewer:18080/v1');assert.equal(reviewer.model,'synthetic-reviewer');
  assert.equal(reviewer.agentFormat,'json_object');assert.equal(reviewer.reasoningEffort,'low');assert.equal(reviewer.preserveStringLimits,true);
  assert.equal(reviewer.diagnosticLogger,diagnosticLogger);assert.equal(reviewer.fetchImpl,fetchImpl);assert.equal(reviewer.retryFailures,false);
  assert.equal(gateway.configured,true);
});

test('capability discovery can be explicitly disabled independently for compatible local APIs',()=>{
  const base={MODEL_BASE_URL:'http://localhost:11434',MODEL_REVIEW_BASE_URL:'http://localhost:18080',
    MODEL_DISCOVER_TOKEN_LIMITS:'false',MODEL_REVIEW_DISCOVER_TOKEN_LIMITS:'true'};
  const first=configuredModelGateway({env:base});
  assert.equal(first.discoverTokenLimits,false);assert.equal(first.reviewGateway.discoverTokenLimits,true);
  const second=configuredModelGateway({env:{...base,MODEL_DISCOVER_TOKEN_LIMITS:'true',MODEL_REVIEW_DISCOVER_TOKEN_LIMITS:'false'}});
  assert.equal(second.discoverTokenLimits,true);assert.equal(second.reviewGateway.discoverTokenLimits,false);
  for(const bad of ['','FALSE','0',false]){
    assert.throws(()=>configuredModelGateway({env:{...base,MODEL_DISCOVER_TOKEN_LIMITS:bad}}),/Invalid MODEL configuration/);
    assert.throws(()=>configuredReviewGateway({env:{MODEL_REVIEW_BASE_URL:base.MODEL_REVIEW_BASE_URL,MODEL_REVIEW_DISCOVER_TOKEN_LIMITS:bad}}),/Invalid MODEL_REVIEW configuration/);
  }
});

test('complete-JSON transport requires each local gateway to opt in explicitly',()=>{
  const env={MODEL_BASE_URL:'http://localhost:11434',MODEL_STREAM_JSON:'true',
    MODEL_REVIEW_BASE_URL:'http://192.168.123.175:11434',MODEL_REVIEW_STREAM_JSON:'true'};
  for(const value of [undefined,'false','TRUE','1',true]){
    const gateway=configuredModelGateway({env:{...env,MODEL_STREAM_COMPLETE_JSON:value,MODEL_REVIEW_STREAM_COMPLETE_JSON:value}});
    assert.equal(gateway.streamCompleteJson,false);assert.equal(gateway.reviewGateway.streamCompleteJson,false);
  }
  const writer=configuredModelGateway({env:{...env,MODEL_STREAM_COMPLETE_JSON:'true'}});
  assert.equal(writer.streamCompleteJson,true);assert.equal(writer.reviewGateway.streamCompleteJson,false);
  const reviewer=configuredModelGateway({env:{...env,MODEL_REVIEW_STREAM_COMPLETE_JSON:'true'}});
  assert.equal(reviewer.streamCompleteJson,false);assert.equal(reviewer.reviewGateway.streamCompleteJson,true);
});

test('complete-JSON transport cannot enable a nonstreaming or public API configuration',()=>{
  for(const env of [
    {MODEL_BASE_URL:'http://localhost:11434'},
    {MODEL_BASE_URL:'https://api.example.test/v1',MODEL_API_KEY:'synthetic-key'},
  ])assert.throws(()=>configuredModelGateway({env:{...env,MODEL_STREAM_COMPLETE_JSON:'true'}}),/Invalid MODEL configuration/);
  assert.throws(()=>configuredReviewGateway({env:{MODEL_REVIEW_BASE_URL:'http://localhost:11434',
    MODEL_REVIEW_STREAM_COMPLETE_JSON:'true'}}),/Invalid MODEL_REVIEW configuration/);
});

test('explicit block-first state configuration is accepted without changing existing mode defaults',()=>{
  const env={MODEL_BASE_URL:'http://localhost:11434'};
  assert.equal(configuredModelGateway({env}).stateMode,'combined');
  for(const mode of ['combined','staged','combined_blocks']){
    const gateway=configuredModelGateway({env:{...env,MODEL_STATE_MODE:mode}});
    assert.equal(gateway.configured,true);assert.equal(gateway.stateMode,mode);
  }
  assert.throws(()=>configuredModelGateway({env:{...env,MODEL_STATE_MODE:'blocks'}}),/Invalid MODEL configuration/);
});

function modelEnv(t,values){
  const keys=Object.keys(process.env).filter(key=>key.startsWith('MODEL_')||key==='DEMO_CONTAINER');
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for(const key of keys)delete process.env[key];
  Object.assign(process.env,values);
  t.after(()=>{
    for(const key of Object.keys(process.env).filter(key=>key.startsWith('MODEL_')||key==='DEMO_CONTAINER'))delete process.env[key];
    Object.assign(process.env,previous);
  });
}

for(const values of [
  {MODEL_BASE_URL:'invalid-PRIVATE_SECRET'},
  {MODEL_BASE_URL:'http://localhost:11434',MODEL_PROTOCOL:'invalid-PRIVATE_SECRET'},
  {MODEL_BASE_URL:'http://localhost:11434',MODEL_AGENT_FORMAT:'invalid-PRIVATE_SECRET'},
  {MODEL_BASE_URL:'http://localhost:11434',MODEL_TIMEOUT_MS:'invalid-PRIVATE_SECRET'},
])test('invalid primary configuration fails before opening the database',async t=>{
  modelEnv(t,values);
  const connect=t.mock.method(Store,'connect',()=>assert.fail('invalid model settings must not open a pool'));
  await assert.rejects(createApp({databaseUrl:'unused',key:randomBytes(32),referralProvider:null}),error=>{
    assert.match(error.message,/Invalid MODEL configuration/);assert.doesNotMatch(error.message,/PRIVATE_SECRET/);return true;
  });
  assert.equal(connect.mock.callCount(),0);
});

for(const gateway of [null,{model:'synthetic-injected'}])test('injected model configuration ignores invalid unused environment settings',async t=>{
  modelEnv(t,{MODEL_BASE_URL:'invalid-primary',MODEL_REVIEW_BASE_URL:'invalid-reviewer'});
  let closed=0;
  t.mock.method(Store,'connect',async()=>({async purgeExpired(){},async close(){closed++;}}));
  const app=await createApp({databaseUrl:'unused',key:randomBytes(32),gateway,referralProvider:null});
  await app.shutdown();assert.equal(closed,1);
});

test('optional final extras skip is strict opt-in on the writer only',()=>{
  const env={MODEL_BASE_URL:'http://127.0.0.1:11434',MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435'};
  assert.equal(configuredModelGateway({env}).skipFinalExtras,false);
  assert.equal(configuredModelGateway({env:{...env,MODEL_SKIP_FINAL_EXTRAS:'false'}}).skipFinalExtras,false);
  const enabled=configuredModelGateway({env:{...env,MODEL_SKIP_FINAL_EXTRAS:'true'}});
  assert.equal(enabled.skipFinalExtras,true);assert.equal(enabled.reviewGateway.skipFinalExtras,false);
  for(const flag of ['', 'yes', 'TRUE', '1', true, null])assert.throws(()=>configuredModelGateway({env:{...env,MODEL_SKIP_FINAL_EXTRAS:flag}}),/Invalid MODEL configuration/);
  const direct=new ModelGateway({baseUrl:'http://127.0.0.1:11434/v1',apiKey:'synthetic',skipFinalExtras:'true'});assert.equal(direct.configured,false);
});

test('O4 draft reuse is opt-in and cannot disable full reviews or stored detail',()=>{
  const env={MODEL_BASE_URL:'http://127.0.0.1:11434',MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435'};
  assert.equal(configuredModelGateway({env}).reuseFinalDraft,false);
  assert.equal(configuredModelGateway({env:{...env,MODEL_REUSE_FINAL_DRAFT:'false'}}).reuseFinalDraft,false);
  const gateway=configuredModelGateway({env:{...env,MODEL_REUSE_FINAL_DRAFT:'true'}});
  assert.equal(gateway.reuseFinalDraft,true);
  assert.equal(gateway.skipFinalExtras,false);
  assert.equal(gateway.reviewGateway.reuseFinalDraft,false);
  assert.equal(gateway.timeoutMs,0);
  for(const value of ['', 'yes', 'TRUE', '1', true, null])
    assert.throws(()=>configuredModelGateway({env:{...env,MODEL_REUSE_FINAL_DRAFT:value}}),/Invalid MODEL configuration/);
  for(const overrides of [{MODEL_SKIP_FINAL_EXTRAS:'true'},{MODEL_PROTOCOL:'json_prompt'},{MODEL_PROTOCOL:'json_schema'}])
    assert.throws(()=>configuredModelGateway({env:{...env,MODEL_REUSE_FINAL_DRAFT:'true',...overrides}}),/Invalid MODEL configuration/);
  const direct=new ModelGateway({baseUrl:'http://127.0.0.1:11434/v1',apiKey:'synthetic',reuseFinalDraft:'true'});
  assert.equal(direct.configured,false);
});

test('turn input slimming is strict writer-only opt-in without changing state mode or review settings',()=>{
  const env={MODEL_BASE_URL:'http://127.0.0.1:11434',MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435'};
  const flags=['MODEL_STAGE_SCOPED_QUESTION_RULES','MODEL_BLOCK_SCOPED_INPUTS'];
  for(const value of [undefined,'false']) {
    const gateway=configuredModelGateway({env:{...env,...Object.fromEntries(flags.map(key=>[key,value]))}});
    assert.equal(gateway.stageScopedQuestionRules,false);assert.equal(gateway.blockScopedInputs,false);
  }
  for(const stateMode of ['combined','combined_blocks','staged']) {
    const gateway=configuredModelGateway({env:{...env,MODEL_STATE_MODE:stateMode,MODEL_REUSE_FINAL_DRAFT:'true',
      MODEL_STAGE_SCOPED_QUESTION_RULES:'true',MODEL_BLOCK_SCOPED_INPUTS:'true'}});
    assert.equal(gateway.stateMode,stateMode);
    assert.equal(gateway.stageScopedQuestionRules,true);assert.equal(gateway.blockScopedInputs,true);
    assert.equal(gateway.reviewGateway.stageScopedQuestionRules,false);assert.equal(gateway.reviewGateway.blockScopedInputs,false);
    assert.equal(gateway.reuseFinalDraft,true);assert.equal(gateway.skipFinalExtras,false);assert.equal(gateway.timeoutMs,0);
  }
  for(const key of flags)for(const value of ['', 'TRUE', '1', 'yes', true, null])
    assert.throws(()=>configuredModelGateway({env:{...env,MODEL_STAGE_SCOPED_QUESTION_RULES:'true',[key]:value}}),/Invalid MODEL configuration/);
  assert.throws(()=>configuredModelGateway({env:{...env,MODEL_BLOCK_SCOPED_INPUTS:'true'}}),/Invalid MODEL configuration/);
  for(const protocol of ['json_prompt','json_schema'])
    assert.throws(()=>configuredModelGateway({env:{...env,MODEL_PROTOCOL:protocol,MODEL_STAGE_SCOPED_QUESTION_RULES:'true'}}),/Invalid MODEL configuration/);
  for(const options of [{stageScopedQuestionRules:'true'},{blockScopedInputs:1},{blockScopedInputs:true}])
    assert.equal(new ModelGateway({baseUrl:env.MODEL_BASE_URL,apiKey:'synthetic',protocol:'relationship_agent',...options}).configured,false);
});

test('remaining optimizations are strict opt-in and policy reuse keeps independent reviewer capacity',()=>{
  const env={MODEL_BASE_URL:'http://127.0.0.1:11434',MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435'};
  const options={MODEL_COMPACT_REVIEW_INPUTS:'compactReviewInputs',MODEL_SCOPED_QUALITY_REFINEMENT:'scopedQualityRefinement',MODEL_REUSE_TOKEN_POLICY:'reuseTokenPolicy'};
  const defaults=configuredModelGateway({env});
  for(const option of Object.values(options))assert.equal(defaults[option],false);
  const gateway=configuredModelGateway({env:{...env,...Object.fromEntries(Object.keys(options).map(key=>[key,'true']))}});
  for(const option of Object.values(options))assert.equal(gateway[option],true);
  assert.equal(gateway.reviewGateway.compactReviewInputs,false);
  assert.equal(gateway.reviewGateway.scopedQualityRefinement,false);
  assert.equal(gateway.reviewGateway.reuseTokenPolicy,true);
  assert.equal(gateway.skipFinalExtras,false);assert.equal(gateway.timeoutMs,0);
  for(const [key,option] of Object.entries(options)){
    for(const value of ['', 'TRUE', '1', 'yes', true, null])
      assert.throws(()=>configuredModelGateway({env:{...env,[key]:value}}),/Invalid MODEL configuration/);
    assert.equal(new ModelGateway({baseUrl:env.MODEL_BASE_URL,apiKey:'synthetic',protocol:'relationship_agent',[option]:'true'}).configured,false);
  }
  for(const MODEL_PROTOCOL of ['json_prompt','json_schema'])for(const key of ['MODEL_COMPACT_REVIEW_INPUTS','MODEL_SCOPED_QUALITY_REFINEMENT'])
    assert.throws(()=>configuredModelGateway({env:{...env,MODEL_PROTOCOL,[key]:'true'}}),/Invalid MODEL configuration/);
});

test('trained-chat writer and independent reviewer can stream while terminal proof remains required',()=>{
 const env={MODEL_SERVER_GPU_ONLY:'true',MODEL_BASE_URL:'http://127.0.0.1:18731/v1',MODEL_NAME:'malssi-gemma4-31b-step5128',MODEL_API_KEY:'synthetic-stream-key',
  MODEL_API_PROFILE:'trained_chat',MODEL_AGENT_FORMAT:'prompt',MODEL_REASONING_EFFORT:'omit',MODEL_STREAM_JSON:'true',MODEL_STREAM_COMPLETE_JSON:'false',
  MODEL_REVIEW_BASE_URL:'http://127.0.0.1:18731/v1',MODEL_REVIEW_API_KEY:'synthetic-stream-key',MODEL_REVIEW_NAME:'malssi-gemma4-31b-step5128',MODEL_REVIEW_API_PROFILE:'trained_chat',MODEL_REVIEW_AGENT_FORMAT:'prompt',MODEL_REVIEW_REASONING_EFFORT:'omit',MODEL_REVIEW_STREAM_JSON:'true',MODEL_REVIEW_STREAM_COMPLETE_JSON:'false'};
 const gateway=configuredModelGateway({env,retryFailures:false});
 for(const value of [gateway,gateway.reviewGateway]){assert.equal(value.configured,true);assert.equal(value.streamJson,true);assert.equal(value.streamCompleteJson,false);assert.equal(value.singleCallTurns,false);assert.equal(value.serverGpuOnly,true);}
 for(const prefix of ['MODEL','MODEL_REVIEW']){
  for(const value of ['true','TRUE',true])assert.throws(()=>configuredModelGateway({env:{...env,[prefix+'_STREAM_COMPLETE_JSON']:value}}),/Invalid MODEL(?:_REVIEW)? configuration/);
  for(const value of ['TRUE','yes',true])assert.throws(()=>configuredModelGateway({env:{...env,[prefix+'_STREAM_JSON']:value}}),/Invalid MODEL(?:_REVIEW)? configuration/);
 }
 assert.throws(()=>configuredModelGateway({env:{...env,MODEL_BASE_URL:'https://api.example.test/v1',MODEL_REVIEW_BASE_URL:'https://api.example.test/v1'}}),/Invalid MODEL configuration/);
});
