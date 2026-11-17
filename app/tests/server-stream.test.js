import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {createApp} from '../src/server.js';
import {createIntake} from '../src/intake.js';
import {HttpError} from '../src/errors.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail;});return {promise,resolve,reject};};
const update={patient_state:{summary:'합성 상태',facts:[],unknowns:[],user_goal:'이야기 듣기'},name_index:null,question_plan:{skip:[]}};
const generated={...update,assessment:{safety:false},guide:{script:'검토된 합성 문장',top:'안내',doList:['듣기'],avoid:['재촉'],next:'다음에 듣기',care:{feel:'쉬어도 좋아요.',tips:[]}}};
const waitFor=(gate,signal)=>{
  if(signal.aborted)return Promise.reject(signal.reason);
  let abort;
  return Promise.race([gate.promise,new Promise((_,reject)=>{
    abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
  })]).finally(()=>signal.removeEventListener('abort',abort));
};

async function fixture(t,{ready=false,work,saveGate}={}){
  const owner=randomUUID(),id=randomUUID(),csrf='synthetic-csrf';
  let row={id,owner,revision:0,state:createIntake()},modelSaves=0,recordSaves=0;
  if(ready)row.state.status='ready';
  const saveEntered=deferred(),controllers=[];
  const store={
    close:async()=>{},purgeExpired:async()=>{},
    browser:async token=>token==='synthetic'?{id:owner,csrf}:null,
    intake:async(candidate,requested)=>{assert.equal(candidate,owner);assert.equal(requested,id);return structuredClone(row);},
    updateIntake:async(candidate,requested,revision,mutate,kind)=>{
      assert.equal(candidate,owner);assert.equal(requested,id);
      if(revision!==row.revision)throw new HttpError(409,'REVISION_CONFLICT','합성 충돌');
      row={...row,revision:revision+1,state:mutate(structuredClone(row.state))};
      if(kind==='model_update')modelSaves++;
      return structuredClone(row);
    },
    nextRecordId:async()=>1,
    saveRecord:async(candidate,record,requested)=>{
      assert.equal(candidate,owner);assert.equal(requested,id);recordSaves++;saveEntered.resolve();
      if(saveGate)await saveGate.promise;
      return structuredClone(record);
    },
  };
  t.mock.method(Store,'connect',async()=>store);
  const gateway={model:'synthetic',protocol:'relationship_agent',updateState:work,respond:work};
  const app=await createApp({databaseUrl:'synthetic-memory',key:randomBytes(32),gateway,modelProfiles:null,referralProvider:null});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{controllers.forEach(controller=>controller.abort());saveGate?.resolve();await app.shutdown();});
  const send=async(action,input={revision:0},{headers={},accept='text/event-stream'}={})=>{
    const controller=new AbortController();controllers.push(controller);
    const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/intakes/${id}/${action}`,{
      method:'POST',signal:controller.signal,headers:{cookie:'malssi_session=synthetic','x-csrf-token':csrf,'content-type':'application/json',accept,connection:'close',...headers},
      body:JSON.stringify(input),
    });
    return {response,controller};
  };
  return {send,saveEntered,row:()=>structuredClone(row),modelSaves:()=>modelSaves,recordSaves:()=>recordSaves};
}

function observe({response,controller}){
  assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'),'no');
  const reader=response.body.getReader(),decoder=new TextDecoder(),events=[],waiters=new Set();let wire='',finished=false,readError;
  const check=()=>{for(const waiter of waiters){const value=events.find(waiter.predicate);if(value){clearTimeout(waiter.timer);waiters.delete(waiter);waiter.resolve(value);}else if(finished){clearTimeout(waiter.timer);waiters.delete(waiter);waiter.reject(readError||new Error('Stream ended before expected event'));}}};
  const done=(async()=>{
    try{
      for(;;){const chunk=await reader.read();if(chunk.done)break;wire+=decoder.decode(chunk.value,{stream:true});let end;
        while((end=wire.indexOf('\n\n'))!==-1){const frame=wire.slice(0,end);wire=wire.slice(end+2);if(frame.startsWith(':'))continue;
          const type=frame.match(/^event: (.+)$/m)?.[1],data=frame.match(/^data: (.+)$/m)?.[1];
          if(type&&data){events.push({type,data:JSON.parse(data)});check();}
        }
      }
    }catch(error){readError=error;}
    finally{finished=true;reader.releaseLock();check();}
  })();
  const until=predicate=>{
    const found=events.find(predicate);if(found)return Promise.resolve(found);
    if(finished)return Promise.reject(readError||new Error('Stream already ended'));
    return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{waiters.delete(waiter);reject(new Error('Expected stream event did not arrive'));},2000)};waiters.add(waiter);});
  };
  return {events,done,until,cancel:async()=>{controller.abort();await done;}};
}
const terminal=event=>event.type==='result'||event.type==='error';
const answer={revision:0,question_id:'name',text:'합성 친구'};

test('HTTP stream pushes initial progress and reviewed cards, and confirms completion only after record save',{timeout:5000},async t=>{
  const entered=deferred(),modelGate=deferred(),saveGate=deferred();let options;
  const f=await fixture(t,{ready:true,saveGate,work:async(_context,_memory,input)=>{
    options=input;entered.resolve();input.onProgress({stage:'guide_write',status:'started',raw:'PRIVATE_MODEL_DELTA'});
    await waitFor(modelGate,input.signal);return generated;
  }});
  const stream=observe(await f.send('result'));await entered.promise;
  const initial=await stream.until(event=>event.type==='progress');assert.equal(initial.data.revision,0);assert.equal(f.recordSaves(),0);
  assert.equal(stream.events.some(terminal),false);
  options.onCard({type:'upsert',id:'script',value:generated.guide.script});
  const card=await stream.until(event=>event.data.cards?.some(card=>card.id==='script'));
  assert.equal(card.data.cards[0].value,generated.guide.script);assert.equal(stream.events.some(terminal),false);
  modelGate.resolve();await f.saveEntered.promise;
  await stream.until(event=>event.data.progress?.status==='saving');
  assert.equal(stream.events.some(event=>event.data.progress?.status==='complete'||terminal(event)),false);
  saveGate.resolve();const result=await stream.until(event=>event.type==='result');await stream.done;
  assert.equal(result.data.record.guide.script,generated.guide.script);assert.equal(result.data.revision,1);
  assert.equal(stream.events.filter(event=>event.data.progress?.status==='complete').length,1);
  assert.equal(f.recordSaves(),1);assert.doesNotMatch(JSON.stringify(stream.events),/PRIVATE_MODEL_DELTA/);
});

test('session and CSRF rejections remain JSON before any stream or model work',{timeout:5000},async t=>{
  let calls=0;const f=await fixture(t,{work:async()=>{calls++;return update;}});
  for(const [headers,status,code] of [[{cookie:''},401,'SESSION_REQUIRED'],[{'x-csrf-token':'wrong'},403,'CSRF_REJECTED']]){
    const {response}=await f.send('answers',answer,{headers});assert.equal(response.status,status);
    assert.match(response.headers.get('content-type'),/^application\/json/);assert.equal((await response.json()).error.code,code);
  }
  assert.equal(calls,0);assert.equal(f.row().revision,0);
});

test('terminal model failure is framed as an error and keeps the pending answer',{timeout:5000},async t=>{
  const gate=deferred();const f=await fixture(t,{work:async(_context,_memory,{signal})=>{
    await waitFor(gate,signal);throw new HttpError(502,'MODEL_INVALID_RESPONSE','합성 검증 실패');
  }});
  const stream=observe(await f.send('answers',answer));await stream.until(event=>event.type==='progress');gate.resolve();
  const failure=await stream.until(event=>event.type==='error');await stream.done;
  assert.equal(failure.data.status,502);assert.equal(failure.data.error.code,'MODEL_INVALID_RESPONSE');
  assert.equal(stream.events.some(event=>event.type==='result'),false);
  assert.equal(f.row().state.modelPending.input.text,answer.text);assert.equal(f.row().revision,1);assert.equal(f.modelSaves(),0);
});

test('identical answer subscribers share one call and cancelling one preserves the other',{timeout:5000},async t=>{
  const gate=deferred(),entered=deferred();let calls=0,signal;
  const f=await fixture(t,{work:async(_context,_memory,options)=>{
    calls++;signal=options.signal;entered.resolve();await waitFor(gate,signal);return update;
  }});
  const first=observe(await f.send('answers',answer));await entered.promise;
  const second=observe(await f.send('answers',answer));await second.until(event=>event.type==='progress');
  assert.equal(calls,1);await first.cancel();assert.equal(signal.aborted,false);
  gate.resolve();const result=await second.until(event=>event.type==='result');await second.done;
  assert.equal(result.data.revision,2);assert.equal(f.modelSaves(),1);assert.equal(calls,1);assert.equal(signal.aborted,false);
  assert.equal(f.row().state.modelPending,undefined);
});

for(const action of ['answers','result'])test(`cancelling the last ${action} stream aborts model work and prevents its save`,{timeout:5000},async t=>{
  const gate=deferred(),aborted=deferred();let signal;
  const f=await fixture(t,{ready:action==='result',work:async(_context,_memory,options)=>{
    signal=options.signal;signal.addEventListener('abort',()=>aborted.resolve(),{once:true});
    await waitFor(gate,signal);return action==='result'?generated:update;
  }});
  const stream=observe(await f.send(action,action==='answers'?answer:{revision:0}));await stream.until(event=>event.type==='progress');
  await stream.cancel();await aborted.promise;assert.equal(signal.aborted,true);
  assert.equal(f.modelSaves(),0);assert.equal(f.recordSaves(),0);
  if(action==='answers')assert.equal(f.row().state.modelPending.input.text,answer.text);
});

test('a late result subscriber receives the active shared card snapshot and same saved record',{timeout:5000},async t=>{
  const gate=deferred(),entered=deferred();let calls=0,options;
  const f=await fixture(t,{ready:true,work:async(_context,_memory,input)=>{
    calls++;options=input;entered.resolve();await waitFor(gate,input.signal);return generated;
  }});
  const first=observe(await f.send('result'));await entered.promise;
  options.onCard({type:'upsert',id:'script',value:generated.guide.script});
  await first.until(event=>event.data.cards?.length===1);
  const second=observe(await f.send('result'));
  const snapshot=await second.until(event=>event.type==='progress');
  assert.equal(snapshot.data.revision,0);assert.deepEqual(snapshot.data.cards,[{id:'script',value:generated.guide.script}]);assert.equal(calls,1);
  gate.resolve();const [a,b]=await Promise.all([first.until(event=>event.type==='result'),second.until(event=>event.type==='result')]);
  await Promise.all([first.done,second.done]);assert.deepEqual(a.data,b.data);assert.equal(f.recordSaves(),1);assert.equal(calls,1);
});
