import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {ModelGateway} from '../src/model.js';
import {configuredModelGateway} from '../src/model-config.js';
import {createModelReferralProvider} from '../src/referral-provider.js';
import {TRIAGE_VERSION} from '../src/risk-classification.js';
import {configuredReferralProvider} from '../src/referral-runtime.js';

const moduleUrl=new URL('../src/referral-runtime.js',import.meta.url);
const source=readFileSync(moduleUrl,'utf8').replace(/^import .*\n/gm,'')
  .replace('export function configuredReferralProvider','function configuredReferralProvider')
  .replaceAll('import.meta.url',JSON.stringify(moduleUrl.href));
const gateway={baseUrl:'http://localhost:11434/v1',model:'synthetic-model',protocol:'relationship_agent',
  agentFormat:'json_object',reasoningEffort:'none',operation(){throw new Error('No inference allowed');},
  agentComplete(){throw new Error('No inference allowed');}};
const eligibility=()=>({'synthetic-center':{capabilities:['mental_health_counseling'],country:'KR',regions:[],nationwide:true,
  min_age:0,max_age:null,accepts_supporter:true,official_source_url:'https://example.org/support',
  valid_until:'2026-12-31',availability:'always'}});

// Replace only the local configuration read, without changing the shared seed
// file or contacting a model. The actual provider still validates the catalog.
function configuredWith(contents,{version=TRIAGE_VERSION,env={}}={}){
  let reads=0,configuredGateway;
  const context=vm.createContext({URL,process:{env:{}},createHash,ModelGateway,configuredModelGateway,TRIAGE_VERSION:version,
    createModelReferralProvider(options){configuredGateway=options.gateway;return createModelReferralProvider(options);},
    readFileSync(url,encoding){reads++;assert.equal(url.href,new URL('../seeds/referral-eligibility.json',moduleUrl).href);
      assert.equal(encoding,'utf8');return contents;}});
  vm.runInContext(source+'\nglobalThis.factory=configuredReferralProvider;',context);
  return {provider:context.factory({gateway,env}),reads,configuredGateway};
}

test('referral streaming uses its own explicit option and supports exact local aliases',()=>{
  for(const enabled of [false,true])for(const [baseUrl,numericLoopback] of [
    ['http://localhost:11434/v1',true],['http://host.docker.internal:11434/v1',true],['http://127.0.0.1:11434/v1',true],
    ['http://[::1]:11434/v1',true],['https://remote.example/v1',false],
  ]){
    const {configuredGateway}=configuredWith(JSON.stringify(eligibility()),{env:{
      REFERRAL_MODEL_BASE_URL:baseUrl,REFERRAL_MODEL_NAME:'synthetic-model',REFERRAL_MODEL_API_KEY:'synthetic-key',
      REFERRAL_MODEL_STREAM_JSON:String(enabled&&numericLoopback),
    }});
    assert.equal(configuredGateway.streamJson,enabled&&numericLoopback,baseUrl);
    assert.equal(configuredGateway.streamCompleteJson,false,baseUrl);
    assert.equal(configuredGateway.configured,true,baseUrl);
  }
});

test('referral model uses the same Docker address resolution and wire options as the primary',()=>{
  const {configuredGateway}=configuredWith(JSON.stringify(eligibility()),{env:{
    DEMO_CONTAINER:'true',REFERRAL_MODEL_BASE_URL:'http://localhost:11434',REFERRAL_MODEL_NAME:'synthetic-model',
    REFERRAL_MODEL_AGENT_FORMAT:'prompt',REFERRAL_MODEL_REASONING_EFFORT:'omit',
    REFERRAL_MODEL_DISCOVER_TOKEN_LIMITS:'false',MODEL_STREAM_JSON:'true',MODEL_STREAM_COMPLETE_JSON:'true',
  }});
  assert.equal(configuredGateway.baseUrl,'http://host.docker.internal:11434/v1');
  assert.equal(configuredGateway.apiKey,'local-ollama');assert.equal(configuredGateway.agentFormat,'prompt');
  assert.equal(configuredGateway.reasoningEffort,'omit');assert.equal(configuredGateway.discoverTokenLimits,false);
  assert.equal(configuredGateway.streamJson,false,'primary streaming must not enable a different referral endpoint');
  assert.equal(configuredGateway.streamCompleteJson,false,'primary completion policy must not enable a different referral endpoint');
});

test('referral discovery inherits the primary setting and retains independent overrides in native and container configurations',()=>{
  for(const container of [false,true])for(const [primary,referral,expected] of [
    [undefined,undefined,true],['false',undefined,false],['true',undefined,true],
    ['false','true',true],['true','false',false],
  ]){
    const {configuredGateway}=configuredWith(JSON.stringify(eligibility()),{env:{
      DEMO_CONTAINER:String(container),REFERRAL_MODEL_BASE_URL:'http://localhost:11434',REFERRAL_MODEL_NAME:'synthetic-model',
      ...(primary===undefined?{}:{MODEL_DISCOVER_TOKEN_LIMITS:primary}),
      ...(referral===undefined?{}:{REFERRAL_MODEL_DISCOVER_TOKEN_LIMITS:referral}),
    }});
    assert.equal(configuredGateway.discoverTokenLimits,expected);
  }
  assert.throws(()=>configuredWith(JSON.stringify(eligibility()),{env:{REFERRAL_MODEL_BASE_URL:'http://localhost:11434',
    REFERRAL_MODEL_NAME:'synthetic-model',MODEL_DISCOVER_TOKEN_LIMITS:'false',REFERRAL_MODEL_DISCOVER_TOKEN_LIMITS:''}}),/Invalid MODEL configuration/);
});

test('referral complete-JSON transport is explicit and part of the cache identity',()=>{
  const env={REFERRAL_MODEL_BASE_URL:'http://localhost:11434',REFERRAL_MODEL_NAME:'synthetic-model',REFERRAL_MODEL_STREAM_JSON:'true'};
  const contents=JSON.stringify(eligibility());
  const initial=configuredWith(contents,{env});
  for(const value of [undefined,'false','TRUE','1',true]){
    const configured=configuredWith(contents,{env:{...env,REFERRAL_MODEL_STREAM_COMPLETE_JSON:value}});
    assert.equal(configured.configuredGateway.streamCompleteJson,false);
    assert.equal(configured.provider.cacheKey,initial.provider.cacheKey);
  }
  const enabled=configuredWith(contents,{env:{...env,REFERRAL_MODEL_STREAM_COMPLETE_JSON:'true'}});
  assert.equal(enabled.configuredGateway.streamCompleteJson,true);
  assert.notEqual(enabled.provider.cacheKey,initial.provider.cacheKey);
  assert.throws(()=>configuredWith(contents,{env:{...env,REFERRAL_MODEL_STREAM_JSON:'false',
    REFERRAL_MODEL_STREAM_COMPLETE_JSON:'true'}}),/Invalid MODEL configuration/);
});

test('configured cache identity includes the exact loaded eligibility bytes and classification policy version',()=>{
  const contents=readFileSync(new URL('../seeds/referral-eligibility.json',moduleUrl),'utf8');
  const real=configuredReferralProvider({gateway,env:{}}),loaded=configuredWith(contents);
  assert.equal(loaded.reads,1);assert.equal(loaded.provider.cacheKey,real.cacheKey);
  const parts=JSON.parse(real.cacheKey);
  assert.ok(parts.includes(TRIAGE_VERSION));assert.ok(parts.includes(createHash('sha256').update(contents).digest('hex')));
});

test('eligibility-only changes invalidate an otherwise identical configured provider cache',()=>{
  const original=JSON.stringify(eligibility()),initial=configuredWith(original).provider.cacheKey;
  assert.equal(configuredWith(original).provider.cacheKey,initial);
  for(const change of [row=>{row.accepts_supporter=false;},row=>{row.min_age=18;},
    row=>{row.valid_until='2026-11-01';},row=>{row.capabilities=['crisis_assessment'];}]){
    const config=eligibility();change(config['synthetic-center']);
    assert.notEqual(configuredWith(JSON.stringify(config)).provider.cacheKey,initial);
  }
});

test('policy version changes invalidate cache even with the same loaded eligibility and model',()=>{
  const contents=JSON.stringify(eligibility());
  assert.notEqual(configuredWith(contents).provider.cacheKey,configuredWith(contents,{version:'referral-triage-next'}).provider.cacheKey);
});

test('cache identity does not bypass invalid eligibility validation or expose API credentials',()=>{
  const invalid=eligibility();invalid['synthetic-center'].accepts_supporter='yes';
  assert.throws(()=>configuredWith(JSON.stringify(invalid)),TypeError);
  const {provider}=configuredWith(JSON.stringify(eligibility()),{env:{REFERRAL_MODEL_API_KEY:'synthetic-secret-key'}});
  assert.equal(provider.cacheKey.includes('synthetic-secret-key'),false);
});
