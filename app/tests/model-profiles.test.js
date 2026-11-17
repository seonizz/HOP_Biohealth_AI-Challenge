import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredModelProfiles,createModelProfiles} from '../src/model-profiles.js';
const gateway=model=>({model,updateState(){},respond(){}});

test('model profile selection is explicit and metadata excludes server credentials',()=>{
 const local=gateway('local-secret-name');
 assert.equal(configuredModelProfiles({env:{},gateway:local}),null);
 for(const value of ['yes','TRUE','1',true,null])assert.throws(()=>configuredModelProfiles({env:{MODEL_SELECTION_ENABLED:value},gateway:local}));
 const profiles=configuredModelProfiles({env:{MODEL_SELECTION_ENABLED:'true'},gateway:local});
 assert.deepEqual(profiles.list(),[{id:'local12b',label:'12B',available:true},{id:'gpu31b',label:'31B',available:false}]);
 assert.equal(profiles.resolve('local12b'),local);
 assert.throws(()=>profiles.resolve('gpu31b'),{status:503,code:'MODEL_PROFILE_UNAVAILABLE'});
 for(const id of ['unknown','__proto__',null,12])assert.throws(()=>profiles.resolve(id),{status:422,code:'INVALID_MODEL_PROFILE'});
});

test('GPU profile never inherits the local endpoint, reviewer, model or credential',()=>{
 const profiles=configuredModelProfiles({env:{MODEL_SELECTION_ENABLED:'true',
  MODEL_BASE_URL:'http://127.0.0.1:11434',MODEL_NAME:'gemma4:12b',MODEL_API_KEY:'LOCAL_SECRET',MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435',MODEL_REVIEW_NAME:'local-reviewer',
  GPU31B_MODEL_BASE_URL:'http://127.0.0.1:18343/v1',GPU31B_MODEL_NAME:'qualified-31b',GPU31B_MODEL_API_KEY:'GPU_SECRET',
  GPU31B_MODEL_SERVER_GPU_ONLY:'true',GPU31B_MODEL_STATE_MODE:'combined'}});
 const gpu=profiles.resolve('gpu31b'),local=profiles.resolve('local12b');
 assert.equal(gpu.model,'qualified-31b');assert.equal(gpu.baseUrl,'http://127.0.0.1:18343/v1');assert.equal(gpu.apiKey,'GPU_SECRET');
 assert.equal(gpu.reviewGateway.baseUrl,gpu.baseUrl);assert.equal(gpu.reviewGateway.model,gpu.model);assert.equal(gpu.reviewGateway.apiKey,gpu.apiKey);
 assert.equal(local.model,'gemma4:12b');assert.equal(local.reviewGateway.model,'local-reviewer');
 assert.doesNotMatch(JSON.stringify(profiles.list()),/SECRET|localhost|127\.0|qualified/);
});

test('malformed registries are rejected and changing callers objects cannot replace a bound gateway',()=>{
 for(const value of [null,[],{other:gateway('other')},{local12b:{}}])assert.throws(()=>createModelProfiles(value),TypeError);
 const original=gateway('one'),input={local12b:original,gpu31b:null},registry=createModelProfiles(input);
 input.local12b=gateway('two');assert.equal(registry.resolve('local12b'),original);
});
