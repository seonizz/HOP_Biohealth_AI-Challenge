import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createModelApi} from '../src/model-api/server.ts';
import {PATHS} from '../src/model-api/contract.ts';
import {ModelApiClient} from '../src/v2/model-api.ts';
import {DualRoleModel} from '../src/v2/model.ts';
import {dualModelSettings} from '../src/v2/dual-config.ts';
import {V2Error} from '../src/v2/errors.ts';
import {unknownAssessment,validateAssessment,comparison,RUBRIC_VERSION} from '../src/v2/assessment.ts';

const identity={model_id:'test-only-checkpoint',checkpoint_sha256:'a'.repeat(64),prompt_profile:'test',prompt_version:'v1'};
const token='synthetic-test-token-not-for-production-1234';
const text='엄마가 요즘 불안해서 잠을 잘 못 주무세요.';
const bInput=()=>({current_message:text,target:{patient_id:'project-1',project_id:'project-1',conversation_id:'conversation-1',speaker:'supporter'},messages:[{message_index:0,content:text,speaker:'supporter'}],rubric_version:RUBRIC_VERSION});
const bOutput=()=>({schema_version:1,...unknownAssessment(),anxiety:{score:2,source:2,timeframe:1,evidence:[{message_index:0,start_cp:0,end_cp:[...text].length}]}});
function aInput(){const current=validateAssessment(bOutput(),[{id:'turn-1',content:text,speaker:'supporter'}]);return {current_message:text,target:{patient_id:'project-1',speaker:'supporter'},recent_messages:[],patient_cue_context:{evaluation_status:2,current,...comparison(current,[],identity.checkpoint_sha256,'v1'),response_policy:'reflect_and_clarify',assessment_available:true,rubric_version:RUBRIC_VERSION,model_sha256:identity.checkpoint_sha256,prompt_version:'v1',do_not_diagnose:true}};}
const envelope=(input:any,request_id='request-1')=>({api_version:'1',request_id,expected_model:identity,input});
const model=(call:any)=>({call,countTokens:async()=>123});
async function fixture(t:any,engine:any,overrides:any={}){
  const app=createModelApi({token,identity,model:engine,inferenceEnabled:true,...overrides});
  await new Promise<void>(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());
  const address=app.server.address() as any,base=`http://127.0.0.1:${address.port}`;
  return {base,client:new ModelApiClient(base,token,identity),post:async(operation:keyof typeof PATHS,body:any,headers:any={})=>{
    const response=await fetch(base+PATHS[operation],{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as any};
  }};
}
test('B and A use authenticated HTTP contracts with bounded versioned inputs and verified outputs',async t=>{
  const calls:any[]=[];
  const f=await fixture(t,model(async(kind:string,input:any)=>{calls.push({kind,input});return kind==='assess'?bOutput():{message:'천천히 마음을 확인해 보세요.'};}));
  assert.deepEqual(await f.client.call('assess',{...bInput(),_model_request_id:'turn.B.1'},new AbortController().signal),bOutput());
  assert.deepEqual(await f.client.call('respond',{...aInput(),_model_request_id:'turn.A.1'},new AbortController().signal),{message:'천천히 마음을 확인해 보세요.'});
  assert.deepEqual(calls.map(item=>item.kind),['assess','respond']);
  assert.equal(calls[1].input.patient_cue_context.current.anxiety.score,2);
  assert.equal(Object.hasOwn(calls[0].input,'_model_request_id'),false);
  assert.equal(await f.client.countTokens('synthetic input',new AbortController().signal),123);
});
test('invalid auth, browser callers, version mismatch and malformed B/A input cannot invoke inference',async t=>{
  let calls=0;const f=await fixture(t,model(async()=>{calls++;return bOutput();}));
  assert.equal((await f.post('assess',envelope(bInput()),{Authorization:'Bearer wrong'})).status,401);
  assert.equal((await f.post('assess',envelope(bInput()),{Origin:'https://malssi-demo.vercel.app'})).status,403);
  assert.equal((await f.post('assess',{...envelope(bInput()),expected_model:{...identity,checkpoint_sha256:'b'.repeat(64)}})).status,409);
  assert.equal((await f.post('assess',envelope({...bInput(),system_prompt:'override'}))).status,422);
  assert.equal((await f.post('assess',envelope({...bInput(),current_message:'다른 내용'}))).status,422);
  const a=aInput();a.patient_cue_context.response_policy='ordinary';
  assert.equal((await f.post('respond',envelope(a))).status,422);
  assert.equal(calls,0);
});
test('concurrent replay coalesces inference and mismatched payload conflicts instead of duplicating calls',async t=>{
  let calls=0,release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  const f=await fixture(t,model(async()=>{calls++;entered();await gate;return bOutput();}));
  const first=f.post('assess',envelope(bInput()));await started;
  const second=f.post('assess',envelope(bInput()));
  assert.equal((await f.post('assess',envelope(bInput(),'different-request'))).status,429);
  const changed=bInput();changed.target.conversation_id='different-conversation';
  assert.equal((await f.post('assess',envelope(changed))).status,409);
  release();const [one,two]=await Promise.all([first,second]);assert.equal(one.status,200);assert.deepEqual(one,two);assert.equal(calls,1);
  assert.deepEqual(await f.post('assess',envelope(bInput())),one);assert.equal(calls,1);
});
test('invalid numeric evaluation and unverified A text are rejected without echoing drafts',async t=>{
  const secret='SYNTHETIC_PRIVATE_DRAFT';
  const f=await fixture(t,model(async(kind:string)=>kind==='assess'?{...bOutput(),explanation:secret}:{message:secret,score:3}));
  for(const [operation,input] of [['assess',bInput()],['respond',aInput()]] as const){const result=await f.post(operation,envelope(input,operation));assert.equal(result.status,502);assert.equal(result.body.error.code,'INVALID_MODEL_OUTPUT');assert.equal(JSON.stringify(result).includes(secret),false);}
});
test('model-off API exposes configuration status and returns explicit unavailable without a checkpoint or GPU',async t=>{
  const f=await fixture(t,null,{identity:null,inferenceEnabled:false});
  const status=await (await fetch(f.base+'/v1/status',{headers:{Authorization:'Bearer '+token}})).json() as any;
  assert.equal(status.inference_enabled,false);assert.equal(status.configured,false);assert.equal(status.inference_readiness,'not_probed');
  const result=await f.post('assess',envelope(bInput()));assert.equal(result.status,503);assert.equal(result.body.error.code,'MODEL_DISABLED');
});

test('upstream contention stays retryable and invalid legacy output is reported as an output error',async t=>{
  const f=await fixture(t,model(async(kind:string)=>{if(kind==='assess')throw new V2Error(429,'MODEL_BUSY');return null;}));
  const busy=await f.post('assess',envelope(bInput()));assert.equal(busy.status,429);assert.equal(busy.body.error.retryable,true);
  const invalid=await f.post('extract',envelope({current_message:text},'extract-invalid'));
  assert.equal(invalid.status,502);assert.equal(invalid.body.error.code,'INVALID_MODEL_OUTPUT');
});
test('model API enforces its deadline and never returns a late draft',async t=>{
  let aborted=false;
  const f=await fixture(t,model(async(_kind:string,_input:any,signal:AbortSignal)=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('synthetic inference aborted'));},{once:true}))),{evaluationTimeoutMs:30});
  const result=await f.post('assess',envelope(bInput()));assert.equal(result.status,504);assert.equal(result.body.error.code,'MODEL_TIMEOUT');assert.equal(aborted,true);
});
test('caller cancellation aborts the upstream HTTP operation',async t=>{
  let started!:()=>void,aborted!:()=>void;const entered=new Promise<void>(resolve=>{started=resolve;}),stopped=new Promise<void>(resolve=>{aborted=resolve;});
  const f=await fixture(t,model(async(_kind:string,_input:any,signal:AbortSignal)=>{started();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted();reject(new Error('cancelled'));},{once:true}));}));
  const controller=new AbortController(),call=f.client.call('assess',bInput(),controller.signal);
  await entered;controller.abort();await assert.rejects(call);
  await Promise.race([stopped,new Promise((_resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('upstream was not cancelled')),1000);timer.unref();})]);
});
test('API client rejects unintended destinations and role/model mismatches',async t=>{
  assert.throws(()=>new ModelApiClient('http://remote.invalid',token,identity));
  assert.throws(()=>new ModelApiClient('https://remote.invalid',token,identity));
  assert.throws(()=>new ModelApiClient('http://127.0.0.1/?token=secret',token,identity));
  assert.throws(()=>new ModelApiClient('http://127.0.0.1', 'short',identity));
  const f=await fixture(t,model(async()=>bOutput()));
  await assert.rejects(()=>f.client.call('unknown',bInput(),new AbortController().signal));
});
test('Gemma environment aliases select the operator endpoint and remote HTTPS remains opt-in',()=>{
  const configured=dualModelSettings({OPENAI_BASE_URL:'https://model.example.invalid/v1',OPENAI_API_KEY:'synthetic-provider-key',OLLAMA_MODEL:'gemma4:12b',HOP_MODEL_ALLOWED_ORIGINS:'https://model.example.invalid'});
  assert.equal(configured.modelId,'gemma4:12b');assert.equal(configured.protocol,'ollama');assert.equal(configured.apiKey,'synthetic-provider-key');
  assert.equal(configured.evaluatorUrl,configured.responderUrl);
  assert.throws(()=>new DualRoleModel(configured.baseUrl,configured.baseUrl,configured.modelId,configured.apiKey,'test','v1'));
  assert.doesNotThrow(()=>new DualRoleModel(configured.baseUrl,configured.baseUrl,configured.modelId,configured.apiKey,'test','v1',{allowedOrigins:configured.allowedOrigins,protocol:configured.protocol}));
  assert.throws(()=>new DualRoleModel('http://model.example.invalid/v1','http://model.example.invalid/v1',configured.modelId,configured.apiKey,'test','v1',{allowedOrigins:['http://model.example.invalid']}));
  assert.equal(dualModelSettings({GEMMA_API_URL:'https://model.example.invalid/'}).baseUrl,'https://model.example.invalid/v1');
});
test('gateway invokes one checkpoint with distinct role prompts and JSON Schema constraints over real HTTP',async t=>{
  const requests:any[]=[];
  const upstream=createServer(async(req,res)=>{const chunks=[];for await(const part of req)chunks.push(part);const body=JSON.parse(Buffer.concat(chunks).toString());requests.push(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(body.response_format.json_schema.name==='patient_cues_v1'?bOutput():{message:'그분의 이야기를 차분히 들어 보세요.'})}}]}));});
  await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>{upstream.closeAllConnections();return new Promise<void>(resolve=>upstream.close(()=>resolve()));});
  const url=`http://127.0.0.1:${(upstream.address() as any).port}/v1`,dual=new DualRoleModel(url,url,identity.model_id,'','test','v1',{protocol:'ollama'}),f=await fixture(t,dual);
  await f.client.call('assess',bInput(),new AbortController().signal);await f.client.call('respond',aInput(),new AbortController().signal);
  assert.equal(requests[0].model,requests[1].model);assert.notEqual(requests[0].messages[0].content,requests[1].messages[0].content);
  assert.equal(requests[0].response_format.type,'json_schema');assert.equal(requests[1].response_format.type,'json_schema');
  assert.deepEqual(requests[1].response_format.json_schema.schema.required,['message']);
  assert.equal(requests[0].reasoning_effort,'none');assert.equal(requests[1].stream,false);assert.equal(requests[0].chat_template_kwargs,undefined);
  assert.equal(await dual.countTokens('가',new AbortController().signal),515);assert.equal(requests.length,2);
});
