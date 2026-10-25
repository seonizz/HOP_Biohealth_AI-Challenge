import test from 'node:test';
import assert from 'node:assert/strict';
import {checkModelConnections} from '../scripts/check-model.js';

const env={MODEL_BASE_URL:'http://localhost:11434',MODEL_API_KEY:'PRIVATE_WRITER_KEY',
  MODEL_AGENT_FORMAT:'prompt',MODEL_REASONING_EFFORT:'omit',MODEL_STREAM_JSON:'true',MODEL_DISCOVER_TOKEN_LIMITS:'false',
  MODEL_REVIEW_BASE_URL:'http://127.0.0.1:11435/v1',MODEL_REVIEW_API_KEY:'PRIVATE_REVIEW_KEY',
  MODEL_REVIEW_AGENT_FORMAT:'json_object',MODEL_REVIEW_DISCOVER_TOKEN_LIMITS:'false'};
const answer=(stream=false)=>stream?new Response(
  'data: '+JSON.stringify({choices:[{index:0,delta:{content:'{"ok":true}'},finish_reason:null}]})+'\n\n'+
  'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',
  {headers:{'content-type':'text/event-stream'}}):
  new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]}));

test('configuration check uses real writer/reviewer settings without network or secrets',async()=>{
  const report=await checkModelConnections({env,fetchImpl:()=>assert.fail('configuration check must not connect')});
  assert.equal(report.ok,true);
  assert.deepEqual(report.checks.map(({role,format,stream,discovery})=>({role,format,stream,discovery})),[
    {role:'writer',format:'prompt',stream:true,discovery:false},
    {role:'reviewer',format:'json_object',stream:false,discovery:false},
  ]);
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_|localhost|127\.0\.0\.1/);
});

test('synthetic check verifies both independent endpoints with their own wire formats and validators',async()=>{
  const calls=[];
  const report=await checkModelConnections({env,generate:true,fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);calls.push({url,body});
    assert.equal(JSON.parse(body.messages.at(-1).content).data.synthetic,true);
    return answer(body.stream);
  }});
  assert.equal(report.ok,true);assert.equal(calls.length,2);
  assert.equal(calls[0].url,'http://localhost:11434/v1/chat/completions');
  assert.equal(calls[0].body.response_format,undefined);assert.equal(calls[0].body.reasoning_effort,undefined);
  assert.equal(calls[1].body.response_format.type,'json_object');
  assert.equal(report.checks.every(row=>row.mode==='synthetic_generation'),true);
});

test('reviewer failure is identified separately and never exposes upstream bodies or credentials',async()=>{
  const report=await checkModelConnections({env,generate:true,fetchImpl:async(url,options)=>
    url.includes(':11435/')?new Response('{"error":"PRIVATE_UPSTREAM_DETAIL"}',{status:401}):answer(JSON.parse(options.body).stream)});
  assert.equal(report.ok,false);assert.equal(report.checks[0].ok,true);
  assert.equal(report.checks[1].code,'MODEL_AUTH_FAILED');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_/);
});

test('invalid settings fail before a request and diagnostics never replace application configuration',async()=>{
  const before=structuredClone(env);
  assert.deepEqual(await checkModelConnections({env:{}}),{ok:false,checks:[{role:'configuration',ok:false,code:'MODEL_NOT_CONFIGURED'}]});
  const report=await checkModelConnections({env:{...env,MODEL_BASE_URL:'http://user:PRIVATE_PASSWORD@localhost/v1'},
    fetchImpl:()=>assert.fail('invalid configuration must not connect')});
  assert.equal(report.checks[0].code,'MODEL_CONFIGURATION_INVALID');assert.doesNotMatch(JSON.stringify(report),/PRIVATE_/);
  assert.deepEqual(env,before);
});

const legacyEnv=protocol=>({MODEL_BASE_URL:'https://synthetic-api.example/v1',MODEL_API_KEY:'PRIVATE_LEGACY_KEY',
  MODEL_NAME:'synthetic-model',MODEL_PROTOCOL:protocol,MODEL_AGENT_FORMAT:protocol==='json_schema'?'prompt':'json_schema',
  MODEL_REASONING_EFFORT:'omit',MODEL_DISCOVER_TOKEN_LIMITS:'false'});
const legacyAnswer=(protocol,stream=false)=>{
  const patient_state={summary:'연결 확인용 합성 상태입니다.',facts:[],unknowns:[],user_goal:'확인되지 않음'};
  if(protocol==='json_prompt')delete patient_state.user_goal;
  const content=JSON.stringify({patient_state,name_index:null,question_plan:{skip:[]}});
  return stream?new Response(
    'data: '+JSON.stringify({choices:[{index:0,delta:{content},finish_reason:null}]})+'\n\n'+
    'data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',
    {headers:{'content-type':'text/event-stream'}}):
    new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}));
};

for(const protocol of ['json_schema','json_prompt'])
test('synthetic check exercises the actual '+protocol+' state request and its original validator',async()=>{
  const calls=[];
  const report=await checkModelConnections({env:legacyEnv(protocol),generate:true,fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);calls.push(body);
    assert.equal(Object.hasOwn(body,'reasoning_effort'),false);
    assert.equal(input.stage,undefined);assert.equal(input.data,undefined);
    if(protocol==='json_schema'){
      assert.equal(body.response_format.type,'json_schema');assert.equal(body.response_format.json_schema.name,'malssi_state');
      assert.deepEqual(input.current_context.patient.fields,{});assert.equal(input.prior_memory,null);
    }else{
      assert.equal(body.response_format,undefined);assert.equal(body.n,1);
      assert.deepEqual(input.patient,[]);assert.deepEqual(input.supporter,[]);assert.equal(input.memory,null);
    }
    return legacyAnswer(protocol);
  }});
  assert.equal(report.ok,true);assert.equal(calls.length,1);
  assert.equal(report.checks[0].protocol,protocol);
  assert.equal(report.checks[0].format,protocol==='json_schema'?'json_schema':'prompt');
  assert.doesNotMatch(JSON.stringify(report),/PRIVATE_|synthetic-api|연결 확인용/);
  let invalidCalls=0;
  const invalid=await checkModelConnections({env:legacyEnv(protocol),generate:true,fetchImpl:async()=>{invalidCalls++;return answer();}});
  assert.equal(invalid.ok,false);assert.equal(invalid.checks[0].code,'MODEL_INVALID_RESPONSE');assert.equal(invalidCalls,3);
});

test('a legacy schema rejection cannot be hidden by an unrelated agent prompt format',async()=>{
  let calls=0;
  const report=await checkModelConnections({env:legacyEnv('json_schema'),generate:true,fetchImpl:async(_url,options)=>{
    calls++;const body=JSON.parse(options.body);
    assert.equal(body.response_format.type,'json_schema');assert.equal(Object.hasOwn(body,'reasoning_effort'),false);
    return new Response('{"error":"PRIVATE_UNSUPPORTED_SCHEMA_DETAIL"}',{status:400});
  }});
  assert.equal(report.ok,false);assert.equal(calls,1);
  assert.equal(report.checks[0].code,'MODEL_UPSTREAM_ERROR');assert.equal(report.checks[0].reason,'http_rejected');
  assert.equal(report.checks[0].format,'json_schema');assert.doesNotMatch(JSON.stringify(report),/PRIVATE_/);
});

for(const protocol of ['json_schema','json_prompt'])
test('legacy '+protocol+' diagnostic reports the shared transport streaming option actually sent',async()=>{
  let calls=0;
  const report=await checkModelConnections({env:{...legacyEnv(protocol),MODEL_BASE_URL:'http://localhost:11434',
    MODEL_STREAM_JSON:'true'},generate:true,fetchImpl:async(_url,options)=>{
      calls++;const body=JSON.parse(options.body);
      assert.equal(body.stream,true);assert.deepEqual(body.stream_options,{include_usage:true});
      return legacyAnswer(protocol,true);
    }});
  assert.equal(report.ok,true);assert.equal(calls,1);assert.equal(report.checks[0].stream,true);
});

test('a legacy writer and its independent reviewer retain their own actual protocol and format',async()=>{
  const roles=[];
  const report=await checkModelConnections({env:{...legacyEnv('json_prompt'),MODEL_REVIEW_BASE_URL:'https://review.example/v1',
    MODEL_REVIEW_API_KEY:'PRIVATE_REVIEW_KEY',MODEL_REVIEW_AGENT_FORMAT:'json_object',MODEL_REVIEW_REASONING_EFFORT:'low',
    MODEL_REVIEW_DISCOVER_TOKEN_LIMITS:'false'},generate:true,fetchImpl:async(url,options)=>{
      const body=JSON.parse(options.body);
      if(url.includes('review.example')){
        roles.push('reviewer');assert.equal(body.response_format.type,'json_object');assert.equal(body.reasoning_effort,'low');return answer();
      }
      roles.push('writer');assert.equal(body.response_format,undefined);assert.equal(Object.hasOwn(body,'reasoning_effort'),false);
      return legacyAnswer('json_prompt');
    }});
  assert.equal(report.ok,true);assert.deepEqual(roles,['writer','reviewer']);
  assert.deepEqual(report.checks.map(({role,protocol,format})=>({role,protocol,format})),[
    {role:'writer',protocol:'json_prompt',format:'prompt'},
    {role:'reviewer',protocol:'relationship_agent',format:'json_object'},
  ]);
});
