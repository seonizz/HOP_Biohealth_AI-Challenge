import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createApp} from '../src/server.js';
import {HttpError} from '../src/errors.js';
import {splitQuestionRequest,validateSplitQuestion} from '../src/split-question-router.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const dbtest = (name,run) => test(name,{skip:!databaseUrl && 'Requires isolated PostgreSQL',timeout:15000},run);
const goal = '친구의 발표 도입에 의견을 주면서 내 일정도 지킬 말을 만들고 싶어요.';
const guide = {
  top:'통합',script:'발표 도입만 같이 살펴보고 나머지는 내 일정을 챙겨도 될까?',
  doList:['살펴볼 부분을 먼저 정하기'],avoid:['일정 전체를 비우겠다고 약속하기'],
  next:'친구에게 도입부를 보내 달라고 해 보세요.',care:{feel:'내 일정을 지키는 것도 중요해요.',tips:['가능한 범위를 먼저 말해 보세요.']},
};
const result = {
  patient_state:{summary:'발표의 도입에 의견을 주려는 상황',facts:[],unknowns:[],user_goal:goal},
  name_index:null,assessment:{safety:false},guide,conversation_detail:{stages:[]},
};
const responseFor = (view,text) => ({
  revision:view.revision,question_id:view.question.id,instance_id:view.question.instance_id,
  follow_up:Boolean(view.question.follow_up),text,
  ...(view.question.type==='one'?{custom:text}:{})
});

async function eventually(read, accept) {
  for (let i=0; i<100; i++) {
    const value=await read();
    if (accept(value)) return value;
    await delay(20);
  }
  assert.fail('Expected job state was not reached');
}

async function fixture(t,{route=()=>({action:'finish'}),respond=()=>result}={}) {
  const schema='split_result_'+randomBytes(8).toString('hex');
  const key=randomBytes(32), pool=new pg.Pool({connectionString:databaseUrl});
  await pool.query(`CREATE SCHEMA ${schema}`);
  let app,base,headers;
  const seen={route:[],result:[]};
  const unused=async()=>assert.fail('Legacy model path called in split mode');
  const profiles={
    local12b:{protocol:'relationship_agent',model:'12B-synthetic',updateState:unused,respond:unused,
      routeQuestion(context){seen.route.push(context);return route(context);}},
    gpu31b:{protocol:'relationship_agent',model:'31B-synthetic',updateState:unused,
      respond(context,memory,options){seen.result.push({context,memory});return respond(context,options);}},
  };
  t.after(async()=>{
    try{await app?.shutdown();}
    finally{await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();}
  });
  async function start() {
    app=await createApp({databaseUrl,key,schema,gateway:null,modelProfiles:profiles,referralProvider:null});
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    base=`http://127.0.0.1:${app.server.address().port}`;
    if(!headers){
      const response=await fetch(base+'/api/bootstrap'),body=await response.json();
      headers={cookie:response.headers.get('set-cookie').split(';')[0],'x-csrf-token':body.csrf_token,
        'content-type':'application/json'};
    }
  }
  const request=async(path,method='GET',body,options={})=>{
    const res=await fetch(base+path,{method,headers,...options,...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await res.json();
    return {status:res.status,data};
  };
  const intake=(id,operation='',method='GET',body,options)=>request(`/api/intakes/${id}${operation?'/'+operation:''}`,method,body,options);
  const create=async()=>{
    const created=await request('/api/intakes','POST',{conversation_epoch:0});
    assert.equal(created.status,201,JSON.stringify(created.data));return created.data;
  };
  const answer=async(view,text)=>{
    const sent=await intake(view.id,'answers','POST',responseFor(view,text));
    assert.equal(sent.status,200,JSON.stringify(sent.data));return sent.data;
  };
  await start();
  const saved=await request('/api/admin/models','PUT',{model_profile_id:'local12b',result_model_profile_id:'gpu31b'});
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal(saved.data.result_model_profile,'gpu31b');
  const status=async id=>(await app.store.pool.query('SELECT status,revision FROM split_result_jobs WHERE intake_id=$1',[id])).rows[0];
  function streamResult(view) {
    return fetch(`${base}/api/intakes/${view.id}/result`,{method:'POST',
      headers:{...headers,accept:'text/event-stream'},body:JSON.stringify({revision:view.revision})});
  }
  return {request,create,answer,intake,streamResult,status,seen,get app(){return app;},
    async restart(){await app.shutdown();await start();}};

}

dbtest('starts from the app and runs one route per answer even while other 31B jobs are blocked',async t=>{
  const wasStarted=Promise.withResolvers(), unblock=Promise.withResolvers();
  t.after(()=>unblock.resolve());
  const f=await fixture(t,{
    route:context=>{
      const wire=splitQuestionRequest(context);
      assert.ok(!wire.candidates.some(q=>q.id==='q3_02'),'The disclosed relationship must be excluded');
      if(wire.data.latest.id!=='q3_01')return {action:'finish'};
      return validateSplitQuestion({action:'custom',subject:'supporter',focus:'support',
        question:'발표 도입을 살펴보는 데 어느 정도 시간을 쓸 수 있나요?',source_id:wire.sources[0].id,
        quote:'내 일정도 지킬 말',why:'도움을 줄 수 있는 시간에 따라 약속의 범위가 달라져요.'},context,wire);
    },
    respond:async(context,{signal,onCard})=>{
      onCard({type:'upsert',id:'care',value:guide.care});
      wasStarted.resolve();
      await Promise.race([unblock.promise,delay(5000,null,{signal})]);
      return result;
    },
  });
  const start=await f.create();
  assert.equal(start.question.id,'q3_01');
  assert.equal(f.seen.route.length+f.seen.result.length,0);
  const next=await f.answer(start,goal);
  assert.equal(next.status,'active');
  assert.match(next.question.q,/어느 정도 시간을/);
  assert.equal(f.seen.route.length,1);
  assert.equal(f.seen.result.length,0);
  const ready=await f.answer(next,'10분까지는 괜찮아요.');
  assert.equal(ready.status,'ready');
  await wasStarted.promise;
  assert.equal((await f.status(ready.id)).status,'running');
  const other=await f.answer(await f.create(),goal);
  assert.equal(other.status,'active');
  assert.equal(f.seen.route.length,3);
  assert.equal(f.seen.result.length,1);
  assert.equal(f.seen.result[0].memory,null);
  const source=JSON.stringify(f.seen.result[0].context.payload.answers);
  assert.match(source,/친구의 발표 도입/);assert.match(source,/10분까지는 괜찮아요/);

  const attached=await f.streamResult(ready);
  assert.match(attached.headers.get('content-type'),/^text\/event-stream/);
  const reader=attached.body.getReader();
  const {value}=await reader.read();
  const progress=Buffer.from(value).toString();
  assert.match(progress,/event: progress/);
  assert.match(progress,/내 일정을 지키는 것도 중요해요/);
  await reader.cancel();
  assert.equal((await f.status(ready.id)).status,'running');
  const attachedAgain=f.intake(ready.id,'result','POST',{revision:ready.revision});
  unblock.resolve();
  const saved=await attachedAgain;
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  const {record}=saved.data;
  assert.equal(record.provenance.model,'31B-synthetic');
  assert.deepEqual(record.guide,guide);
  assert.deepEqual((await f.request(`/api/records/${record.id}`)).data.record,record);
  assert.equal(f.seen.result.length,1);
  assert.equal(await f.status(ready.id),undefined);
  const raw=(await f.app.store.pool.query('SELECT content FROM records WHERE intake_id=$1',[ready.id])).rows[0].content;
  assert.doesNotMatch(raw,/발표 도입/);
});

dbtest('correction invalidates an in-flight result and result retry uses the latest saved answers only',async t=>{
  const obsoleteStarted=Promise.withResolvers(),unblockObsolete=Promise.withResolvers();
  t.after(()=>unblockObsolete.resolve());
  let attempts=0;
  const revised='발표 도입은 한 문장만 봐줄 수 있어요.';
  const f=await fixture(t,{
    respond:async()=>{
      attempts++;
      if(attempts===1){obsoleteStarted.resolve();await unblockObsolete.promise;}
      if(attempts===2)throw new HttpError(503,'MODEL_UNAVAILABLE','Synthetic outage');
      return result;
    },
  });
  const ready=await f.answer(await f.create(),goal);
  await obsoleteStarted.promise;
  assert.equal(ready.canGoBack,true);
  const back=await f.intake(ready.id,'back','POST',{revision:ready.revision});
  assert.equal(back.status,200,JSON.stringify(back.data));
  const latest=await f.answer(back.data,revised);
  assert.equal((await f.status(ready.id)).revision,latest.revision);
  unblockObsolete.resolve();
  await eventually(()=>f.status(latest.id),row=>row?.status==='failed');
  assert.equal((await f.request('/api/records')).data.records.length,0);
  const routes=f.seen.route.length;
  const saved=await f.intake(latest.id,'result','POST',{revision:latest.revision});
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal(f.seen.route.length,routes);
  assert.equal(attempts,3);
  for(const {context} of f.seen.result.slice(1)){
    const inputs=JSON.stringify(context.payload.answers);
    assert.ok(inputs.includes(revised));
    assert.ok(!inputs.includes(goal));
  }
});

dbtest('graceful restart resumes a claimed job with its original model roles',async t=>{
  const started=Promise.withResolvers();
  let attempts=0;
  const f=await fixture(t,{respond:async(context,{signal})=>{
    if(++attempts===1){started.resolve();await delay(10000,undefined,{signal});}
    return result;
  }});
  const ready=await f.answer(await f.create(),goal);
  await started.promise;
  const disabled=await f.request('/api/admin/models','PUT',{model_profile_id:'local12b',result_model_profile_id:null});
  assert.equal(disabled.status,200);
  await f.restart();
  const saved=await f.intake(ready.id,'result','POST',{revision:ready.revision});
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  assert.equal(saved.data.record.provenance.model,'31B-synthetic');
  assert.equal(attempts,2);
  assert.equal(f.seen.route.length,1);
});
