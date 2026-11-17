import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredModelGateway} from '../src/model-config.js';
import {createModelProfiles} from '../src/model-profiles.js';
import {validateModelConnection,prepareModelConnection,withModelConnections,missingModelBaselines,missingLegacyModelBaseline,connectionGateway} from '../src/model-connections.js';
const input={base_url:'https://models.example/v1',model:'synthetic',api_key:'synthetic-key'};
test('connection validation canonicalizes URLs, preserves blank keys and rejects unsafe endpoints',()=>{
 assert.equal(validateModelConnection({...input,base_url:'https://models.example/v1/chat/completions/'}).baseUrl,input.base_url);
 assert.equal(validateModelConnection({...input,api_key:''},{apiKey:'existing-key'}).apiKey,'existing-key');
 assert.equal(validateModelConnection({...input,base_url:'http://127.0.0.1:8080',api_key:''}).apiKey,'local-ollama');
 for(const patch of [{base_url:'http://external.example'},{base_url:'file:///tmp/key'},{base_url:'https://user:secret@external.example'},
  {base_url:'https://models.example/v1?key=secret'},{base_url:'https://models.example/v1#secret'},{model:''},{model:'x'.repeat(201)},{api_key:'x'.repeat(4097)},{api_key:'bad\nkey'},{api_key:''},{extra:true}])
  assert.throws(()=>validateModelConnection({...input,...patch}),{status:422,code:'INVALID_MODEL_CONNECTION'});
});
test('31B connection changes revoke one-call approval and preserve its own wire options and old versions',()=>{
 const original=configuredModelGateway({env:{MODEL_BASE_URL:'http://127.0.0.1:18731/v1',MODEL_NAME:'original31',MODEL_API_KEY:'old-key',MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined',
  MODEL_SINGLE_CALL_TURNS:'true',MODEL_AGENT_FORMAT:'prompt',MODEL_REASONING_EFFORT:'omit',MODEL_DISCOVER_TOKEN_LIMITS:'false'}});
 for(const patch of [{base_url:'https://changed.example/v1'},{model:'changed'},{api_key:'changed-key'}]){
  const updated=prepareModelConnection('gpu31b',{base_url:original.baseUrl,model:original.model,api_key:'',...patch},original);
  assert.equal(updated.gateway.singleCallTurns,false);assert.equal(updated.gateway.bundleCombinedTurnReviews,true);
  assert.equal(updated.gateway.agentFormat,'prompt');assert.equal(updated.gateway.reasoningEffort,'omit');
  assert.equal(updated.gateway.reviewGateway.baseUrl,updated.gateway.baseUrl);assert.equal(updated.gateway.reviewGateway.apiKey,updated.gateway.apiKey);
  assert.equal(updated.gateway.reviewGateway.model,updated.gateway.model);
 }
 assert.equal(original.singleCallTurns,true);
 const same=prepareModelConnection('gpu31b',{base_url:original.baseUrl,model:original.model,api_key:''},original);assert.equal(same.gateway.singleCallTurns,true);
 const id='gpu31b_'+'a'.repeat(32),updated=prepareModelConnection('gpu31b',input,original);
 const registry=withModelConnections(createModelProfiles({local12b:null,gpu31b:original}),[{id,profile_id:'gpu31b',config:updated.config}]);
 assert.equal(registry.list().length,2);assert.equal(registry.bind('gpu31b'),id);assert.equal(registry.resolve('gpu31b'),original);
 assert.equal(registry.resolve(id).singleCallTurns,false);assert.doesNotMatch(JSON.stringify(registry.connections()),/synthetic-key|old-key/);
});
test('moving a local streaming profile to external HTTPS removes endpoint-specific transport assumptions',()=>{
 const local=configuredModelGateway({env:{MODEL_BASE_URL:'http://127.0.0.1:11434/v1',MODEL_API_KEY:'local-key',MODEL_NAME:'local',MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined_blocks',MODEL_STREAM_JSON:'true',MODEL_STREAM_COMPLETE_JSON:'true',MODEL_DISCOVER_TOKEN_LIMITS:'true'}});
 const {gateway}=prepareModelConnection('local12b',input,local);
 assert.equal(gateway.protocol,local.protocol);assert.equal(gateway.stateMode,local.stateMode);assert.equal(gateway.agentFormat,local.agentFormat);
 assert.equal(gateway.streamJson,false);assert.equal(gateway.streamCompleteJson,false);assert.equal(gateway.discoverTokenLimits,false);
 assert.equal(gateway.reviewGateway.discoverTokenLimits,false);assert.equal(gateway.configured,true);
});

test('local/LAN connection changes retain opted-in streaming and revoke endpoint capability discovery',()=>{
 const local=configuredModelGateway({env:{MODEL_BASE_URL:'http://127.0.0.1:11434/v1',MODEL_API_KEY:'local-key',MODEL_NAME:'local',MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined',MODEL_STREAM_JSON:'true',MODEL_STREAM_COMPLETE_JSON:'true',MODEL_DISCOVER_TOKEN_LIMITS:'true'}});
 const {gateway}=prepareModelConnection('local12b',{...input,base_url:'http://192.168.1.42:11434/v1'},local);
 assert.equal(gateway.streamJson,true);assert.equal(gateway.streamCompleteJson,true);assert.equal(gateway.discoverTokenLimits,false);
 assert.equal(gateway.reviewGateway.streamJson,true);assert.equal(gateway.reviewGateway.configured,true);
 const unchanged=prepareModelConnection('local12b',{base_url:local.baseUrl,model:local.model,api_key:''},local).gateway;
 assert.equal(unchanged.streamJson,true);assert.equal(unchanged.streamCompleteJson,true);assert.equal(unchanged.discoverTokenLimits,true);
});

test('persisted baselines pin logical conversation IDs across environment changes and new edits',()=>{
 const gateway=model=>configuredModelGateway({env:{MODEL_BASE_URL:'http://127.0.0.1:11434/v1',MODEL_NAME:model,MODEL_DISCOVER_TOKEN_LIMITS:'false'}});
 const original=gateway('original'),base=createModelProfiles({local12b:original,gpu31b:null});
 const missing=missingModelBaselines(base);assert.equal(missing.length,1);assert.equal(missing[0].config.role,'baseline');
 const baseline={...missing[0],id:'local12b_'+'0'.repeat(32)};
 const changed=createModelProfiles({local12b:gateway('changed-environment'),gpu31b:null});
 const pinned=withModelConnections(changed,[baseline]);
 assert.equal(pinned.bind('local12b'),'local12b');assert.equal(pinned.resolve('local12b').model,'original');assert.equal(pinned.current('local12b').model,'original');
 assert.deepEqual(missingModelBaselines(changed,[baseline]),[]);
 const update=prepareModelConnection('local12b',{...input,model:'edited'},pinned.current('local12b'));
 const version={id:'local12b_'+'a'.repeat(32),profile_id:'local12b',config:update.config};pinned.add(version,update.gateway);
 assert.equal(pinned.bind('local12b'),version.id);assert.equal(pinned.resolve(version.id).model,'edited');
 assert.equal(pinned.resolve('local12b').model,'original');
 const restored=withModelConnections(changed,[baseline,version]);
 assert.equal(restored.resolve('local12b').model,'original');assert.equal(restored.current('local12b').model,'edited');
});

test('legacy snapshots preserve a distinct original gateway and null reviewer across restart and edits',()=>{
 const make=model=>configuredModelGateway({env:{MODEL_BASE_URL:'http://127.0.0.1:11434/v1',MODEL_NAME:model,MODEL_DISCOVER_TOKEN_LIMITS:'false'}});
 const original=make('original-legacy'),local=make('selectable-local');
 assert.equal(original.reviewGateway,null);
 const missing=missingLegacyModelBaseline(original);assert.equal(missing.config.role,'legacy');assert.equal(missing.config.review,null);
 const row={...missing,id:'local12b_'+'1'.repeat(32)};
 assert.equal(connectionGateway(row.config).reviewGateway,null);
 const registry=withModelConnections(createModelProfiles({local12b:local,gpu31b:null}),[row],{legacyGateway:make('changed-environment')});
 assert.equal(registry.resolveLegacy().model,'original-legacy');assert.equal(registry.resolveLegacy().reviewGateway,null);
 assert.equal(registry.bind('local12b'),'local12b');assert.equal(registry.current('local12b'),local);
 assert.equal(registry.list()[1].available,false);assert.deepEqual(missingLegacyModelBaseline(make('changed'),[row]),null);
 const edited=prepareModelConnection('local12b',input,local);
 registry.add({id:'local12b_'+'a'.repeat(32),profile_id:'local12b',config:edited.config},edited.gateway);
 assert.equal(registry.current('local12b'),edited.gateway);assert.equal(registry.resolveLegacy().model,'original-legacy');
 assert.equal(withModelConnections(createModelProfiles({local12b:local,gpu31b:null}),[],{legacyGateway:original}).resolveLegacy(),original);
 assert.equal(missingLegacyModelBaseline(null),null);
});

test('snapshot restoration retains an explicitly configured independent reviewer',()=>{
 const original=configuredModelGateway({env:{MODEL_BASE_URL:'http://127.0.0.1:11434/v1',MODEL_NAME:'writer',MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435/v1',MODEL_REVIEW_NAME:'reviewer',MODEL_DISCOVER_TOKEN_LIMITS:'false',MODEL_REVIEW_DISCOVER_TOKEN_LIMITS:'false'}});
 const row=missingLegacyModelBaseline(original),restored=connectionGateway(row.config);
 assert.equal(restored.model,'writer');assert.equal(restored.reviewGateway.model,'reviewer');
 assert.equal(restored.reviewGateway.baseUrl,'http://127.0.0.1:11435/v1');
});

test('question-only connection preserves an unchanged writer but cannot enter a reviewer or changed 31B target',()=>{
 const original=configuredModelGateway({env:{MODEL_BASE_URL:'http://127.0.0.1:18731/v1',MODEL_NAME:'original31',MODEL_API_KEY:'old-key',
  MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined',MODEL_SINGLE_CALL_TURNS:'true',MODEL_SINGLE_CALL_QUESTION_ONLY:'true',MODEL_DISCOVER_TOKEN_LIMITS:'false'}});
 const input={base_url:original.baseUrl,model:original.model,api_key:''};
 const same=prepareModelConnection('gpu31b',input,original);
 assert.equal(same.gateway.singleCallTurns,true);assert.equal(same.gateway.singleCallQuestionOnly,true);
 assert.equal(same.gateway.reviewGateway.singleCallTurns,false);assert.equal(same.gateway.reviewGateway.singleCallQuestionOnly,false);
 assert.equal(same.gateway.configured,true);
 for(const patch of [{base_url:'https://changed.example/v1'},{model:'changed'},{api_key:'changed-key'}]){
  const changed=prepareModelConnection('gpu31b',{...input,...patch},original);
  assert.equal(changed.gateway.singleCallTurns,false);assert.equal(changed.gateway.singleCallQuestionOnly,false);
  assert.equal(changed.gateway.bundleCombinedTurnReviews,true);
  assert.equal(changed.gateway.reviewGateway.singleCallTurns,false);assert.equal(changed.gateway.reviewGateway.singleCallQuestionOnly,false);
  assert.equal(changed.gateway.configured,true);
 }
 assert.equal(original.singleCallTurns,true);assert.equal(original.singleCallQuestionOnly,true);assert.equal(original.reviewGateway,null);
});

test('question-only snapshots preserve writer policy while restoring independent reviewers without writer flags',()=>{
 const original=configuredModelGateway({env:{MODEL_BASE_URL:'http://127.0.0.1:18731/v1',MODEL_NAME:'writer',MODEL_API_KEY:'writer-key',
  MODEL_PROTOCOL:'relationship_agent',MODEL_SINGLE_CALL_TURNS:'true',MODEL_SINGLE_CALL_QUESTION_ONLY:'true',MODEL_REVIEW_BASE_URL:'http://127.0.0.1:18732/v1',MODEL_REVIEW_NAME:'reviewer'}});
 const baseline=missingModelBaselines(createModelProfiles({local12b:null,gpu31b:original}))[0];
 assert.equal(baseline.config.writer.singleCallQuestionOnly,true);assert.equal(baseline.config.review.singleCallQuestionOnly,false);
 const restored=connectionGateway(baseline.config);
 assert.equal(restored.singleCallQuestionOnly,true);assert.equal(restored.reviewGateway.singleCallQuestionOnly,false);
 // A reviewer snapshot must never gain a writer-only policy on restoration.
 const stored=structuredClone(baseline.config);stored.review.singleCallTurns=true;stored.review.singleCallQuestionOnly=true;
 const before=structuredClone(stored),independent=connectionGateway(stored);
 assert.equal(independent.reviewGateway.singleCallTurns,false);assert.equal(independent.reviewGateway.singleCallQuestionOnly,false);
 assert.equal(independent.reviewGateway.model,'reviewer');assert.deepEqual(stored,before);
 original.reviewGateway.singleCallQuestionOnly=true;
 const legacy=missingLegacyModelBaseline(original);
 assert.equal(legacy.config.review.singleCallTurns,false);assert.equal(legacy.config.review.singleCallQuestionOnly,false);
 assert.equal(legacy.config.writer.singleCallQuestionOnly,true);
});

test('legacy referral routing settings survive changed environment and stay out of public metadata',()=>{
 const make=model=>configuredModelGateway({env:{MODEL_BASE_URL:'http://127.0.0.1:11434/v1',MODEL_NAME:model,MODEL_DISCOVER_TOKEN_LIMITS:'false'}});
 const original=make('original'),env={REFERRAL_MODEL_BASE_URL:'https://original-referral.example/v1',REFERRAL_MODEL_NAME:'original-referral',
  REFERRAL_MODEL_API_KEY:'private-referral-key',REFERRAL_MODEL_AGENT_FORMAT:'json_schema',MODEL_REASONING_EFFORT:'none',
  REFERRAL_GUIDANCE_ENABLED:'true',REFERRAL_COUNTRY:'KR',DATABASE_URL:'private-database',UNRELATED_SECRET:'private-unrelated'};
 const row={...missingLegacyModelBaseline(original,[],{env}),id:'local12b_'+'1'.repeat(32)};
 assert.deepEqual(row.config.referralSettings,{REFERRAL_MODEL_BASE_URL:env.REFERRAL_MODEL_BASE_URL,REFERRAL_MODEL_NAME:env.REFERRAL_MODEL_NAME,
  REFERRAL_MODEL_API_KEY:env.REFERRAL_MODEL_API_KEY,REFERRAL_MODEL_AGENT_FORMAT:env.REFERRAL_MODEL_AGENT_FORMAT,MODEL_REASONING_EFFORT:env.MODEL_REASONING_EFFORT});
 env.REFERRAL_MODEL_NAME='changed-environment';
 assert.equal(missingLegacyModelBaseline(make('changed'),[row],{env}),null);
 const registry=withModelConnections(createModelProfiles({local12b:make('current'),gpu31b:null}),[row],{legacyGateway:make('changed')});
 const restored=registry.legacyReferralSettings();assert.equal(restored.REFERRAL_MODEL_NAME,'original-referral');
 assert.equal(restored.REFERRAL_MODEL_API_KEY,'private-referral-key');
 restored.REFERRAL_MODEL_NAME='caller-mutation';row.config.referralSettings.REFERRAL_MODEL_NAME='row-mutation';
 assert.equal(registry.legacyReferralSettings().REFERRAL_MODEL_NAME,'original-referral');
 assert.doesNotMatch(JSON.stringify(registry.connections()),/original-referral|private-referral-key|private-database|private-unrelated/);
 assert.equal(withModelConnections(createModelProfiles({local12b:original,gpu31b:null})).legacyReferralSettings(),undefined);
});
