import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {createApp} from '../src/server.js';
import {createIntake,answerIntake,buildContext} from '../src/intake.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const dbtest=(name,fn)=>test(name,{skip:!databaseUrl},fn);
const guide={top:'통합',script:'편할 때 이야기해 줘.',doList:['천천히 듣기'],avoid:['재촉하기'],next:'원하는 도움을 확인해 보세요.',care:{feel:'내 마음도 돌봐 주세요.',tips:['쉬어도 괜찮아요.']}};
const modelDraft=({messages})=>({answer:'편한 때 이야기할 수 있다고 전해 보세요.',clarification:null,
  facts:messages.filter(m=>m.role==='user'&&!m.skipped&&m.text.startsWith('상황:')).map(m=>({message_id:m.id,subject:'supporter',quote:m.text})),
  superseded:[],safety:{urgent:false}});
async function fixture(t,overrides={}) {
  const admin=new pg.Pool({connectionString:databaseUrl}),schema='continuation_api_'+randomBytes(8).toString('hex');
  await admin.query(`CREATE SCHEMA ${schema}`);
  const calls={messages:0,cards:0,contexts:[]};
  const gateway={model:'synthetic',protocol:'relationship_agent',continueConversation:async input=>{calls.messages++;return modelDraft(input);},
    respond:async context=>{calls.cards++;calls.contexts.push(context);return {guide,assessment:{safety:false}};},...overrides};
  const app=await createApp({databaseUrl,schema,key:randomBytes(32),gateway,referralProvider:null});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await app.shutdown();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  async function browser(){const r=await fetch(base+'/api/bootstrap');const data=await r.json();return {cookie:r.headers.get('set-cookie').split(';')[0],csrf:data.csrf_token,epoch:data.conversation_epoch};}
  async function request(session,path,method='GET',body,extra={}) {
    const r=await fetch(base+path,{method,headers:{cookie:session.cookie,'x-csrf-token':session.csrf,'content-type':'application/json',...extra},...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,data:await r.json()};
  }
  const session=await browser(),owner=(await app.store.browser(session.cookie.slice(15))).id;
  const state=answerIntake(createIntake(),{question_id:'name',text:'합성 친구'});state.status='ready';
  const intake=await app.store.createIntake(owner,state,0);
  const id=await app.store.nextRecordId();
  const record={id,date:new Date().toISOString(),profile:{name:'합성 친구'},guide,log:state.log,context:buildContext(state),relationship_analysis:{original:true}};
  await app.store.saveRecord(owner,record,intake.id);
  const start=async()=>{
    const result=await request(session,`/api/records/${id}/continuations`,'POST',{request_id:randomUUID(),conversation_epoch:0});
    assert.equal(result.status,201,JSON.stringify(result));return result.data.continuation;
  };
  const send=async(row,text,extras={})=>request(session,`/api/continuations/${row.id}/messages`,'POST',{revision:row.revision,request_id:randomUUID(),text,...extras});
  return {...app,calls,request,session,owner,id,record,intake,start,send,browser,base};
}

dbtest('free followup, snapshot cards and retry preserve the original relationship and cards',async t=>{
  const f=await fixture(t);let row=await f.start();
  let r=await f.send(row,'어떻게 말을 꺼낼까요?');assert.equal(r.status,200);row=r.data.continuation;
  assert.equal(row.messages.at(-1).role,'assistant');assert.equal(row.cards.length,0);
  r=await f.send(row,'상황: 저는 오늘 대화를 나눴고 잠시 쉬고 싶어요.');assert.equal(r.status,200);row=r.data.continuation;
  const input={revision:row.revision,request_id:randomUUID()};
  r=await f.request(f.session,`/api/continuations/${row.id}/cards`,'POST',input);assert.equal(r.status,200,JSON.stringify(r));
  assert.equal(r.data.continuation.cards.length,1);assert.deepEqual(r.data.card.guide,guide);
  const again=await f.request(f.session,`/api/continuations/${row.id}/cards`,'POST',input);
  assert.equal(again.status,200);assert.equal(again.data.card.id,r.data.card.id);assert.equal(f.calls.cards,1);
  const sources=Object.values(f.calls.contexts[0].supporter.fields).filter(x=>x.id.startsWith('continuation_'));
  assert.equal(sources.length,1);assert.equal(sources[0].text,'상황: 저는 오늘 대화를 나눴고 잠시 쉬고 싶어요.');
  assert.equal(sources.some(s=>s.text.includes('어떻게')),false);
  assert.deepEqual(await f.store.record(f.owner,f.id),f.record);
  assert.deepEqual((await f.store.intake(f.owner,f.intake.id)).state, f.intake.state);
  const reopened=await f.request(f.session,`/api/continuations/${row.id}`);assert.equal(reopened.data.continuation.cards.length,1);
});

dbtest('only hypothetical questions cannot create card facts and pending state clears for next message',async t=>{
  const f=await fixture(t);let row=await f.start();row=(await f.send(row,'만약 답장이 없다면요?')).data.continuation;
  const r=await f.request(f.session,`/api/continuations/${row.id}/cards`,'POST',{revision:row.revision,request_id:randomUUID()});
  assert.equal(r.status,409);assert.equal(r.data.error.code,'NO_NEW_FACTS');assert.equal(f.calls.cards,0);
  row=(await f.request(f.session,`/api/continuations/${row.id}`)).data.continuation;
  assert.equal(row.pending,null);assert.equal(row.status,'active');assert.equal((await f.send(row,'상황: 저는 이제 쉬려고 해요.')).status,200);
});

dbtest('same request is idempotent, changed payload or stale revision is rejected',async t=>{
  const f=await fixture(t);const row=await f.start(),path=`/api/continuations/${row.id}/messages`;
  const input={revision:row.revision,request_id:randomUUID(),text:'상황: 저는 피곤해요.'};
  const results=await Promise.all([f.request(f.session,path,'POST',input),f.request(f.session,path,'POST',input)]);
  assert.ok(results.every(r=>r.status===200),JSON.stringify(results));
  assert.equal(results[0].data.continuation.messages.length,2);assert.equal(f.calls.messages,1);
  assert.equal((await f.request(f.session,path,'POST',{...input,text:'다른 내용'})).status,409);
  assert.equal((await f.request(f.session,path,'POST',{...input,request_id:randomUUID()})).status,409);
});

dbtest('failed generation preserves pending input and retry does not duplicate user message',async t=>{
  let fail=true;
  const f=await fixture(t,{continueConversation:async input=>{if(fail)throw new Error('synthetic outage');return modelDraft(input);}});
  const row=await f.start(),input={revision:0,request_id:randomUUID(),text:'상황: 저는 쉬고 싶어요.'};
  const first=await f.request(f.session,`/api/continuations/${row.id}/messages`,'POST',input);assert.equal(first.status,500);
  const saved=(await f.request(f.session,`/api/continuations/${row.id}`)).data.continuation;
  assert.equal(saved.messages.length,1);assert.equal(saved.pending.input.text,input.text);
  fail=false;
  const retry=await f.request(f.session,`/api/continuations/${row.id}/messages`,'POST',{...input,revision:saved.revision});
  assert.equal(retry.status,200);assert.equal(retry.data.continuation.messages.length,2);assert.equal(retry.data.continuation.pending,null);
});

dbtest('corrections discard stale generated answers/cards and invalidate later sessions',async t=>{
  const f=await fixture(t);let row=await f.start();row=(await f.send(row,'상황: 저는 오늘 대화했어요.')).data.continuation;
  row=(await f.request(f.session,`/api/continuations/${row.id}/cards`,'POST',{revision:row.revision,request_id:randomUUID()})).data.continuation;
  row=(await f.request(f.session,`/api/continuations/${row.id}/complete`,'POST',{revision:row.revision,request_id:randomUUID()})).data.continuation;
  const later=await f.start();assert.notEqual(later.id,row.id);
  const correction=await f.request(f.session,`/api/continuations/${row.id}/corrections`,'POST',{revision:row.revision,request_id:randomUUID(),answer_ref:row.messages[0].id,replacement:'상황: 정정할게요. 저는 아직 대화하지 않았어요.'});
  assert.equal(correction.status,200);assert.equal(correction.data.continuation.cards.length,0);
  assert.equal(correction.data.continuation.messages.length,1);
  const stale=await f.send(later,'더 이야기할게요.');assert.equal(stale.status,409);
  const current=(await f.request(f.session,`/api/continuations/${later.id}`)).data.continuation;
  assert.equal((await f.send(current,'어떻게 할까요?')).status,200);
});

dbtest('ownership, CSRF, direct route, and cascading deletion cover continuations and cards',async t=>{
  const f=await fixture(t);const row=await f.start(),other=await f.browser();
  assert.equal((await fetch(f.base+`/continuations/${row.id}`)).status,200);
  for(const [path,method,body] of [[`/api/records/${f.id}/continuations`,'GET'],[`/api/continuations/${row.id}`,'GET'],
    [`/api/continuations/${row.id}`,'DELETE'],[`/api/continuations/${row.id}/messages`,'POST',{revision:0,request_id:randomUUID(),text:'다른 소유자'}]]) {
    assert.equal((await f.request(other,path,method,body)).status,404);
  }
  assert.equal((await f.request(f.session,`/api/continuations/${row.id}/messages`,'POST',{revision:0,request_id:randomUUID(),text:'질문'},{'x-csrf-token':'wrong'})).status,403);
  assert.equal((await f.request(f.session,`/api/records/${f.id}`,'DELETE')).status,200);
  assert.equal((await f.request(f.session,`/api/continuations/${row.id}`)).status,404);
});

dbtest('delete while generating cancels work and cannot resurrect the session',async t=>{
  let entered;const ready=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{continueConversation:(_input,{signal})=>new Promise((_resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  const row=await f.start(),pending=f.send(row,'상황: 저는 기다리는 중이에요.');await ready;
  assert.equal((await f.request(f.session,`/api/continuations/${row.id}`,'DELETE')).status,200);
  assert.equal((await pending).status,404);
  assert.equal((await f.request(f.session,`/api/continuations/${row.id}`)).status,404);
  assert.deepEqual(await f.store.record(f.owner,f.id),f.record);
});

dbtest('explicit finish during pending generation cancels and preserves saved user input',async t=>{
  let entered;const ready=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{continueConversation:(_input,{signal})=>new Promise((_resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  const row=await f.start(),pending=f.send(row,'상황: 저는 기다리는 중이에요.');await ready;
  const current=(await f.request(f.session,`/api/continuations/${row.id}`)).data.continuation;
  const done=await f.request(f.session,`/api/continuations/${row.id}/complete`,'POST',{revision:current.revision,request_id:randomUUID()});
  assert.equal(done.status,200);assert.equal(done.data.continuation.status,'completed');assert.equal(done.data.continuation.messages.length,1);
  assert.equal((await pending).status,409);
});

dbtest('skip requires an actual clarification, and urgent reply ends input',async t=>{
  let danger=false;
  const f=await fixture(t,{continueConversation:async input=>({...modelDraft(input),clarification:'어떤 장면이었나요?',safety:{urgent:danger}})});
  let row=await f.start();assert.equal((await f.send(row,'',{skipped:true})).status,422);
  row=(await f.send(row,'좀 더 설명해주세요.')).data.continuation;
  row=(await f.send(row,'',{skipped:true,reply_to:row.messages.at(-1).id})).data.continuation;
  assert.equal(row.messages.at(-2).kind,'skipped');
  danger=true;row=(await f.send(row,'상황: 지금 위급한 상황이에요.')).data.continuation;
  assert.equal(row.status,'completed');assert.equal(row.safety_urgent,true);assert.equal(row.messages.at(-1).clarification,undefined);
  assert.equal((await f.send(row,'질문')).status,409);
});

dbtest('completed round can generate cards while a newer round remains active',async t=>{
  const f=await fixture(t);let row=await f.start();row=(await f.send(row,'상황: 저는 쉬고 싶어요.')).data.continuation;
  row=(await f.request(f.session,`/api/continuations/${row.id}/complete`,'POST',{revision:row.revision,request_id:randomUUID()})).data.continuation;
  const active=await f.start();
  const cards=await f.request(f.session,`/api/continuations/${row.id}/cards`,'POST',{revision:row.revision,request_id:randomUUID()});
  assert.equal(cards.status,200,JSON.stringify(cards));assert.equal(cards.data.continuation.status,'completed');
  assert.equal((await f.start()).id,active.id);
});

dbtest('finishing an unreviewed correction does not summarize superseded earlier facts',async t=>{
  let entered;const ready=new Promise(resolve=>{entered=resolve;});let wait=false;
  const f=await fixture(t,{continueConversation:async(input,{signal})=>{
    if(!wait)return modelDraft(input);
    return new Promise((_resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }});
  let row=await f.start();row=(await f.send(row,'상황: 저는 오늘 친구를 만났어요.')).data.continuation;wait=true;
  const pending=f.send(row,'상황: 정정할게요. 오늘은 만나지 않았어요.');await ready;
  row=(await f.request(f.session,`/api/continuations/${row.id}`)).data.continuation;
  const done=await f.request(f.session,`/api/continuations/${row.id}/complete`,'POST',{revision:row.revision,request_id:randomUUID()});
  assert.equal(done.status,200);assert.equal(done.data.continuation.summary.includes('오늘 친구를 만났어요'),false);
  assert.equal((await pending).status,409);
});
