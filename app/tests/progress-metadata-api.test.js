import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {createApp} from '../src/server.js';
import {createIntake} from '../src/intake.js';
import {HttpError} from '../src/errors.js';
import {withCardProgress} from '../src/generation-progress.js';

const deferred=()=>{let resolve;return {promise:new Promise(done=>resolve=done),resolve};};
const absent=()=>new HttpError(404,'NOT_FOUND','합성 기록 없음');
const guide={top:'통합',script:'편할 때 말해 줘.',doList:['듣기'],avoid:['재촉하기'],next:'원하는 도움을 물어보세요.',care:{feel:'쉬어도 괜찮아요.',tips:[]}};

// Real HTTP routing with a deterministic in-memory persistence boundary. SQL,
// AAD and PostgreSQL lock behavior have separate store/DB tests.
async function fixture(t,{holdSave=false}={}) {
  const id=randomUUID(),owner=randomUUID(),foreign=randomUUID(),entered=deferred(),release=deferred(),saving=deferred(),saved=deferred();
  const counters={activity:0,metadata:0,intake:0,record:0},state={...createIntake(),status:'ready'};
  let row={id,revision:0,state},record,expired=false;
  const owned=(candidate,requested)=>{if(!row||candidate!==owner||requested!==id)throw absent();return row;};
  const store={
    async close(){},async purgeExpired(){return {deleted_owners:0};},
    async browser(token){counters.activity++;return expired?null:{id:token==='other'?foreign:owner,csrf:'test-csrf'};},
    async intakeMetadata(candidate,requested){counters.metadata++;const current=owned(candidate,requested);return {id,revision:current.revision};},
    async intake(candidate,requested){counters.intake++;return structuredClone(owned(candidate,requested));},
    async updateIntake(candidate,requested,revision,mutate){
      const current=owned(candidate,requested);
      if(current.revision!==revision)throw new HttpError(409,'REVISION_CONFLICT','합성 revision 충돌');
      row={id,revision:revision+1,state:mutate(structuredClone(current.state))};return structuredClone(row);
    },
    async nextRecordId(){return 1;},
    async saveRecord(candidate,value,requested){owned(candidate,requested);record=structuredClone(value);saving.resolve();if(holdSave)await saved.promise;return record;},
    async record(candidate,requested){counters.record++;if(candidate!==owner||!record||String(record.id)!==String(requested))throw absent();return record;},
    async deleteIntake(candidate,requested){owned(candidate,requested);row=null;return {deleted_records:0};},
  };
  t.mock.method(Store,'connect',async()=>store);
  const gateway={model:'synthetic',respond:async(_context,_memory,options)=>{
    options.onProgress({stage:'guide_write',status:'started'});
    await withCardProgress(options,'card_care',undefined,()=>{entered.resolve();return release.promise;});
    return {guide,assessment:{safety:false},patient_state:{summary:'합성 요약',facts:[],unknowns:[],user_goal:'말 걸기'},name_index:null};
  }};
  const app=await createApp({databaseUrl:'synthetic-memory',key:randomBytes(32),gateway,referralProvider:null});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{release.resolve();saved.resolve();await app.shutdown();});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(action,method='GET',input,token='owner')=>{
    const response=await fetch(`${base}/api/intakes/${id}${action?'/'+action:''}`,{
      method,headers:{cookie:`malssi_session=${token}`,'x-csrf-token':'test-csrf','content-type':'application/json'},
      ...(input?{body:JSON.stringify(input)}:{}),
    });
    return {status:response.status,data:await response.json()};
  };
  return {app,request,counters,entered,release,saving,saved,
    expire(){expired=true;},advance(){row.revision++;},removeRecord(){record=null;}};
}

test('active and saved-revision progress avoid intake reads while auth and inactive record checks remain',async t=>{
  const f=await fixture(t,{holdSave:true});
  const pending=f.request('result','POST',{revision:0});await f.entered.promise;
  const baseline=f.counters.intake,activity=f.counters.activity;
  for(let index=0;index<4;index++) {
    const progress=await f.request('progress');
    assert.equal(progress.status,200);assert.equal(progress.data.revision,0);
    assert.equal(progress.data.progress.status,'running');
    assert.deepEqual(progress.data.progress.card_stages,{care:'당신의 마음을 돌보는 방법을 적고 있어요'});
  }
  assert.equal(f.counters.intake,baseline);
  assert.equal(f.counters.activity,activity+4);
  assert.equal((await f.request('progress','GET',undefined,'other')).status,404);
  f.release.resolve();await f.saving.promise;
  const beforeSaved=f.counters.intake,linked=await f.request('progress');
  assert.equal(linked.data.revision,0,'saved revision still binds to the original run');
  assert.equal(linked.data.progress.status,'saving');
  assert.equal(f.counters.intake,beforeSaved);
  f.saved.resolve();assert.equal((await pending).status,200);
  const beforeInactive=f.counters.intake;
  assert.equal((await f.request('progress')).data.progress.status,'complete');
  assert.equal(f.counters.intake,beforeInactive+1);
  assert.equal(f.counters.record,1);
  f.removeRecord();assert.equal((await f.request('progress')).data.progress.status,'failed');
  const beforeExpired=f.counters.metadata;f.expire();
  assert.equal((await f.request('progress')).status,401);
  assert.equal(f.counters.metadata,beforeExpired,'expired auth cannot consult run metadata');
});

test('older run revisions cannot imply active progress or commit after a newer revision',async t=>{
  const f=await fixture(t),pending=f.request('result','POST',{revision:0});await f.entered.promise;
  f.advance();const before=f.counters.intake;
  const progress=await f.request('progress');
  assert.equal(progress.status,200);assert.equal(progress.data.revision,1);
  assert.equal(progress.data.progress.status,'idle');
  assert.equal(f.counters.intake,before+1);
  f.release.resolve();assert.equal((await pending).status,409);
});

test('deleting an active intake blocks progress despite the live in-memory run',async t=>{
  const f=await fixture(t),pending=f.request('result','POST',{revision:0});await f.entered.promise;
  assert.equal((await f.request('','DELETE')).status,200);
  assert.equal((await f.request('progress')).status,404);
  f.release.resolve();assert.notEqual((await pending).status,200);
});
