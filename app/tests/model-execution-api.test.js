import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import pg from 'pg';
import {createApp} from '../src/server.js';
import {configuredModelGateway} from '../src/model-config.js';
import {ModelGateway} from '../src/model.js';
import {contextGoal} from '../src/agent-state.js';
import {syntheticAnswer} from '../scripts/verify-questionnaire-v3-live.mjs';
import {evidenceWireFixture} from './evidence-wire.fixture.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const dbtest=(name,run)=>test(name,{skip:!databaseUrl&&'Requires isolated PostgreSQL test database'},run);
const defaults={question_mode:'single',scheduling:'individual',question_source:'general',review_source:'general'};
const defaultId='local12b_'+'2'.repeat(32);

// Real HTTP, gateway validation and encrypted PostgreSQL. Provider responses
// are deliberately synthetic: these checks do not measure model quality.
async function fixture(t){
  const admin=new pg.Pool({connectionString:databaseUrl,connectionTimeoutMillis:5000});
  const schema='execution_'+randomBytes(8).toString('hex'),key=randomBytes(32),seen=[];
  let app,base,headers,environmentModel='general-original';
  const provider=createServer(async(req,res)=>{
    try {
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw),input=JSON.parse(body.messages.at(-1).content);
      seen.push({path:req.url,key:req.headers.authorization,body,input});
      if(input.stage!=='question_plan'){
        res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic non-question stage unavailable'}}));return;
      }
      const logical={skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]},personalization:null};
      const output=evidenceWireFixture(input,logical);
      res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
    }catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'Synthetic provider failure'}}));}
  });
  t.after(async()=>{
    try {await app?.shutdown();}finally{
      if(provider.listening)await new Promise(resolve=>provider.close(resolve));
      try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await admin.end();}
    }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const base_url=`http://127.0.0.1:${provider.address().port}/v1`;
  const start=async()=>{
    const gateway=configuredModelGateway({env:{MODEL_BASE_URL:base_url,MODEL_NAME:environmentModel,MODEL_API_KEY:'general-private-key',
      MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined',MODEL_AGENT_FORMAT:'json_object',MODEL_REASONING_EFFORT:'omit',
      MODEL_DISCOVER_TOKEN_LIMITS:'false'},retryFailures:false,diagnosticLogger:null});
    app=await createApp({databaseUrl,schema,key,gateway,modelProfiles:{local12b:gateway,gpu31b:null},referralProvider:null});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${app.server.address().port}`;
    const response=await fetch(base+'/api/bootstrap'),bootstrap=await response.json();assert.equal(response.status,200);
    if(!headers)headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-csrf-token':bootstrap.csrf_token,'content-type':'application/json'};
  };
  await start();
  const request=async(path,method='GET',body,extra={})=>{
    const response=await fetch(base+path,{method,headers:{...headers,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const raw=await response.text();return {status:response.status,raw,data:JSON.parse(raw)};
  };
  const create=async()=>{const response=await request('/api/intakes','POST',{conversation_epoch:0});assert.equal(response.status,201,response.raw);return response.data;};
  const answer=async view=>{
    const before=seen.length,response=await request(`/api/intakes/${view.id}/answers`,'POST',{revision:view.revision,...syntheticAnswer(view.question)});
    assert.equal(response.status,200,response.raw);assert.equal(seen.length-before,1,'Single mode must dispatch exactly one question POST');
    return response.data;
  };
  return {request,create,answer,seen,base_url,get app(){return app;},
    save:body=>request('/api/admin/model-execution/local12b','PUT',body),
    async restart(model){await app.shutdown();if(model)environmentModel=model;await start();},
    async owner(){return (await app.store.browser(headers.cookie.slice('malssi_session='.length))).id;}};
}

dbtest('execution API exposes the immutable single-call default without credentials or model probes',async t=>{
  const f=await fixture(t),result=await f.request('/api/admin/model-execution');
  assert.equal(result.status,200);assert.equal(result.data.executions.length,2);
  assert.deepEqual(result.data.executions[0],{id:'local12b',...defaults,question_connection:null,review_connection:null,configured:true});
  assert.equal(result.data.executions[1].configured,false);assert.doesNotMatch(result.raw,/general-private-key/);
  const view=await f.create();assert.equal(view.model_profile_id,defaultId);
  const rows=await f.app.store.modelConnections();
  assert.equal(rows.filter(row=>row.config.role==='execution_default').length,1);
  assert.equal(rows.find(row=>row.config.role==='execution_default').id,defaultId);
  assert.deepEqual(rows.find(row=>row.id===defaultId).config.execution.settings,defaults);
  assert.equal(rows.find(row=>row.config.role==='baseline').config.writer.singleCallTurns,false);
  assert.equal(rows.find(row=>row.config.role==='legacy').config.execution,undefined);
  assert.equal(f.seen.length,0);
  await f.restart('changed-environment');
  assert.equal((await f.app.store.modelConnections()).length,rows.length,'Restart must not add another default version');
  assert.equal((await f.create()).model_profile_id,defaultId);
  const after=await f.request('/api/admin/model-execution');assert.deepEqual(after.data,result.data);
});

dbtest('execution writes enforce admin, origin, CSRF and complete valid settings before persistence',async t=>{
  const f=await fixture(t),before=(await f.app.store.modelConnections()).length;
  for(const headers of [{'x-csrf-token':''},{origin:'https://foreign.example'},{'x-forwarded-for':'127.0.0.1'}]){
    const response=await f.request('/api/admin/model-execution/local12b','PUT',defaults,headers);
    assert.equal(response.status,403,response.raw);
  }
  assert.equal((await f.request('/api/admin/model-execution','GET',undefined,{'x-forwarded-for':'127.0.0.1'})).status,403);
  for(const patch of [{question_mode:'three'},{question_mode:1},{scheduling:'automatic'},{question_source:'custom'},
    {review_source:'custom'},{question_source:'unknown'},{extra:true},{question_connection:{base_url:'https://user:secret@example.test/v1',model:'bad',api_key:'role-private-key'}}]){
    const response=await f.save({...defaults,...patch});assert.equal(response.status,422,response.raw);
    assert.doesNotMatch(response.raw,/role-private-key|user:secret/);
  }
  assert.equal((await f.save({question_mode:'single'})).status,422);
  assert.equal((await f.request('/api/admin/model-execution/gpu31b','PUT',defaults)).status,503);
  assert.equal((await f.app.store.modelConnections()).length,before);assert.equal(f.seen.length,0);
});

dbtest('question and reviewer can share a model while keys stay separately encrypted and blank preserves only their own key',async t=>{
  const f=await fixture(t),input={...defaults,question_mode:'two',scheduling:'parallel',question_source:'custom',review_source:'custom',
    question_connection:{base_url:f.base_url,model:'shared-generic',api_key:'question-private-key'},
    review_connection:{base_url:f.base_url,model:'shared-generic',api_key:'review-private-key'}};
  const saved=await f.save(input);assert.equal(saved.status,200,saved.raw);
  const actual=saved.data.executions[0];assert.equal(actual.question_mode,'two');assert.equal(actual.scheduling,'parallel');
  assert.equal(actual.question_connection.model,actual.review_connection.model);
  assert.equal(actual.question_connection.api_key_configured,true);assert.equal(actual.review_connection.api_key_configured,true);
  assert.doesNotMatch(saved.raw,/question-private-key|review-private-key|general-private-key/);
  const changed=await f.save({...input,question_connection:{...input.question_connection,model:'question-updated',api_key:''},
    review_connection:{...input.review_connection,model:'review-updated',api_key:''}});
  assert.equal(changed.status,200,changed.raw);
  const rows=await f.app.store.pool.query('SELECT id,content FROM model_connections ORDER BY sequence');
  assert.doesNotMatch(JSON.stringify(rows.rows),/question-private-key|review-private-key|general-private-key/);
  const last=rows.rows.at(-1),config=f.app.store.open(last.content,`model-connection:${last.id}`);
  assert.equal(config.execution.question.apiKey,'question-private-key');assert.equal(config.execution.review.apiKey,'review-private-key');
  assert.equal(config.writer.apiKey,'general-private-key');assert.equal(config.writer.model,'general-original');
  assert.throws(()=>f.app.store.open(last.content,'model-connection:wrong'));
  const selection=await f.request('/api/admin/models');assert.equal(selection.data.selected_model_profile,'local12b');
  await f.restart('irrelevant-new-environment');
  assert.deepEqual((await f.request('/api/admin/model-execution')).data,changed.data);
  assert.equal(f.seen.length,0,'Saving or restoring execution settings must not call the model');
});

dbtest('new execution versions never reroute existing conversations after editing or restart',async t=>{
  const f=await fixture(t),original=await f.create();
  const firstInput={...defaults,question_source:'custom',review_source:'custom',
    question_connection:{base_url:f.base_url,model:'question-first',api_key:'first-question-key'},
    review_connection:{base_url:f.base_url,model:'review-first',api_key:'first-review-key'}};
  assert.equal((await f.save(firstInput)).status,200);const first=await f.create();
  assert.notEqual(first.model_profile_id,original.model_profile_id);
  assert.equal((await f.save({...firstInput,question_connection:{...firstInput.question_connection,model:'question-second',api_key:'second-question-key'}})).status,200);
  const second=await f.create();assert.notEqual(first.model_profile_id,second.model_profile_id);
  await f.restart('changed-environment');
  for(const [view,model,key] of [[original,'general-original','general-private-key'],[first,'question-first','first-question-key'],[second,'question-second','second-question-key']]){
    const next=await f.answer(view);assert.equal(next.model_profile_id,view.model_profile_id);
    const call=f.seen.at(-1);assert.equal(call.body.model,model);assert.equal(call.key,'Bearer '+key);assert.equal(call.input.stage,'question_plan');
  }
  assert.equal((await f.create()).model_profile_id,second.model_profile_id);
});

dbtest('default one-call question flow reaches synthetic general-model cards and exact encrypted DB storage',async t=>{
  const f=await fixture(t),finalCalls=[];
  t.mock.method(ModelGateway.prototype,'respond',async function(context){
    finalCalls.push({model:this.model,context:structuredClone(context)});
    return {patient_state:{summary:'합성 결과 저장 검사',facts:[],unknowns:[],user_goal:contextGoal(context)},name_index:null,assessment:{safety:false},
      guide:{top:'통합',script:'편할 때 이야기를 들려줘.',doList:['원하는 도움을 물어보세요.'],avoid:['마음을 단정하지 마세요.'],
        next:'편한 시간을 확인하세요.',care:{feel:'나의 여건도 돌봐 주세요.',tips:['잠시 쉬어도 괜찮아요.']}}};
  });
  let view=await f.create(),answers=0;
  while(view.status==='active'){assert.ok(answers++<12);view=await f.answer(view);}
  assert.ok(answers>=9);assert.equal(f.seen.length,answers);
  assert.ok(f.seen.every(call=>call.input.stage==='question_plan'&&call.body.model==='general-original'));
  const result=await f.request(`/api/intakes/${view.id}/result`,'POST',{revision:view.revision});
  assert.equal(result.status,200,result.raw);assert.equal(finalCalls.length,1);assert.equal(finalCalls[0].model,'general-original');
  assert.equal(result.data.record.provenance.model_profile_id,defaultId);
  const read=await f.request(`/api/records/${result.data.record.id}`);assert.equal(read.status,200);assert.deepEqual(read.data.record,result.data.record);
  const owner=await f.owner(),rows=await f.app.store.pool.query('SELECT id,owner,content FROM records WHERE owner=$1',[owner]);
  assert.equal(rows.rowCount,1);assert.doesNotMatch(rows.rows[0].content,/합성 결과 저장 검사|편할 때 이야기를 들려줘/);
  assert.deepEqual(f.app.store.openRecord(rows.rows[0].content,rows.rows[0].owner,rows.rows[0].id),result.data.record);
  assert.equal(f.seen.length,answers,'The synthetic final stub must not mask an additional question call');
});
