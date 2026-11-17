import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {createApp} from '../src/server.js';
import {createIntake} from '../src/intake.js';
import {HttpError} from '../src/errors.js';

const deferred=()=>{
  let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});
  return {promise,resolve,reject};
};

for(const [action,pauseAt] of [['result','browser'],['answers','browser'],['answers','intake']])
test(`shutdown prevents a ${action} request waiting in ${pauseAt} from starting new model work`,{timeout:5000},async t=>{
  const entered=deferred(),resume=deferred(),modelEntered=deferred(),modelRelease=deferred();
  // The model promise is rejected during cleanup even if admission is correctly blocked.
  modelRelease.promise.catch(()=>{});
  const owner=randomUUID(),id=randomUUID(),csrf=randomUUID(),token='s'.repeat(43);
  let row={id,revision:0,state:createIntake()},calls=0,closed=false,paused=false;
  if(action==='result')row.state.status='ready';
  const pause=async location=>{
    if(location===pauseAt&&!paused){paused=true;entered.resolve();await resume.promise;}
  };
  const store={
    purgeExpired:async()=>{},close:async()=>{closed=true;},
    browser:async()=>{await pause('browser');return {id:owner,csrf};},
    intake:async()=>{await pause('intake');return structuredClone(row);},
    updateIntake:async(_owner,_id,revision,mutate)=>{
      assert.equal(revision,row.revision);
      row={...row,revision:revision+1,state:mutate(structuredClone(row.state))};return structuredClone(row);
    },
  };
  t.mock.method(Store,'connect',async()=>store);
  const work=async(_context,_memory,{signal})=>{
    calls++;modelEntered.resolve({status:'MODEL_STARTED',aborted:signal.aborted});
    return modelRelease.promise;
  };
  const app=await createApp({databaseUrl:'mocked',key:randomBytes(32),gateway:{model:'synthetic',respond:work,updateState:work},referralProvider:null});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  let shutdown;
  t.after(async()=>{
    resume.resolve();modelRelease.reject(new HttpError(499,'MODEL_CANCELLED','합성 모델 정리'));
    await (shutdown??app.shutdown());
  });
  const body=action==='answers'?{revision:0,question_id:'name',text:'합성 인물'}:{revision:0};
  const pending=fetch(`http://127.0.0.1:${app.server.address().port}/api/intakes/${id}/${action}`,{
    method:'POST',headers:{cookie:`malssi_session=${token}`,'x-csrf-token':csrf,'content-type':'application/json',connection:'close'},body:JSON.stringify(body),
  }).then(async response=>({status:response.status,body:await response.json()}));
  await entered.promise;shutdown=app.shutdown();resume.resolve();
  const outcome=await Promise.race([pending,modelEntered.promise]);
  assert.equal(outcome.status,499,'shutdown must reject admission instead of starting unowned model work');
  assert.equal(outcome.body.error.code,'MODEL_CANCELLED');assert.equal(calls,0);
  await shutdown;assert.equal(closed,true);
});
