import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {createApp} from '../src/server.js';
import {createIntake, answerIntake, buildContext} from '../src/intake.js';
import {HttpError} from '../src/errors.js';

const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const tick = () => new Promise(resolve => setImmediate(resolve));
const notFound = () => new HttpError(404, 'NOT_FOUND', '없어요.');
const memory = {summary:'합성 상황',facts:[],unknowns:['직접 의향'],user_goal:'부담 없는 첫마디'};
const result = {patient_state:memory,name_index:null,assessment:{safety:false},guide:{top:'합성 안내',script:'이야기를 들어볼게요.',doList:[],avoid:[],next:'함께 살펴봐요.',care:{feel:'합성 공감',tips:[]}}};
const plan = input => ({schema_version:'1.0',subject:'patient',urgency:'planned',reviewed:true,
  evidence_source_ids:[input.sources[0].id],institution_ids:[],model_version:'synthetic-cancellation'});

async function fixture(t, action) {
  const rows = new Map(), records = new Map(), sessions = new Map(), entered = deferred(), aborted = deferred(), finish = deferred();
  const signals = []; let calls = 0;
  const store = {
    purgeExpired:async () => {}, close:async () => {},
    browser:async token => {store.onBrowser?.(); return sessions.get(token);},
    createBrowser:async () => {const browser = {id:randomUUID(),token:randomUUID(),csrf:randomUUID()}; sessions.set(browser.token,browser); return browser;},
    history:async () => ({records:[],intakes:[],conversation_epoch:0}), columnState:async () => ({read:[],saved:[]}),
    questionSet:async () => createIntake().questionSet,
    async intake(owner, id) {
      const row = rows.get(id); if (!row || row.owner !== owner) throw notFound();
      store.onIntake?.(row); return structuredClone(row);
    },
    async updateIntake(owner, id, revision, update) {
      const row = rows.get(id); if (!row || row.owner !== owner) throw notFound();
      if (row.revision !== revision) throw new HttpError(409, 'REVISION_CONFLICT', '바뀌었어요.');
      const next = {...row,revision:row.revision+1,state:update(structuredClone(row.state))}; rows.set(id,next); return structuredClone(next);
    },
    async context(owner, id) {return {context:buildContext((await store.intake(owner,id)).state)};},
    async deleteIntake(owner, id) {await store.intake(owner,id); rows.delete(id); return {record_ids:[]};},
    async deleteConversations(owner) {for (const [id,row] of rows) if (row.owner === owner) rows.delete(id); return {conversation_epoch:1};},
    nextRecordId:async () => 1,
    record:async (owner,id) => {const record=records.get(`${owner}:${id}`);if(!record)throw notFound();return structuredClone(record);},
    saveRecord:async (owner,record) => {records.set(`${owner}:${record.id}`,structuredClone(record));return record;},
  };
  t.mock.method(Store, 'connect', async () => store);
  const work = async signal => {
    calls++; signals.push(signal); entered.resolve();
    await Promise.race([finish.promise, new Promise((_, reject) => signal.addEventListener('abort', () => {
      aborted.resolve(); reject(new HttpError(499, 'MODEL_CANCELLED', '취소됐어요.'));
    }, {once:true}))]);
  };
  const gateway = action === 'guidance' ? null : {model:'synthetic',
    async updateState(_context, _memory, {signal}) {await work(signal); return {patient_state:memory,name_index:null,question_plan:{skip:[]}};},
    async respond(_context, _memory, options) {store.onRespond?.(options);await work(options.signal);if(store.responseError)throw store.responseError;return structuredClone(result);},
  };
  const referralProvider = action === 'guidance' ? async input => {await work(input.signal); return plan(input);} : null;
  const {server, shutdown} = await createApp({databaseUrl:'mocked',key:randomBytes(32),gateway,referralProvider});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {finish.resolve(); const closing = shutdown(); server.closeAllConnections(); await closing;});
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = async () => {
    const response = await fetch(base+'/api/bootstrap'), data = await response.json();
    const cookie = response.headers.get('set-cookie').split(';')[0], session = sessions.get(cookie.slice('malssi_session='.length));
    return {cookie,csrf:data.csrf_token,owner:session.id};
  };
  const request = async (session, path, method = 'GET', data, signal) => {
    const response = await fetch(base+path,{method,signal,headers:{cookie:session.cookie,'x-csrf-token':session.csrf,'content-type':'application/json',connection:'close'},
      ...(data === undefined ? {} : {body:JSON.stringify(data)})});
    return {status:response.status,data:await response.json()};
  };
  const seed = session => {
    let state = createIntake();
    if (action !== 'answer') state = answerIntake(state,{question_id:'name',text:'합성 인물'});
    if (action === 'result') state.status = 'ready';
    const row = {owner:session.owner,id:randomUUID(),revision:0,state}; rows.set(row.id,row); return row;
  };
  const session = await browser(), row = seed(session), path = `/api/intakes/${row.id}/${action === 'answer' ? 'answers' : action}`;
  const send = (signal, selectedSession = session, selectedRow = row) => request(selectedSession,
    `/api/intakes/${selectedRow.id}/${action === 'answer' ? 'answers' : action}`,'POST',
    action === 'answer' ? {revision:0,question_id:'name',text:'합성 인물'} : {revision:0},signal);
  return {store,rows,records,gateway,session,row,path,send,request,browser,seed,entered,aborted,finish,signals,shutdown,calls:() => calls};
}

for (const action of ['answer','result','guidance']) {
  test(`${action}: one disconnected subscriber does not cancel a shared same-revision operation`, {timeout:5000}, async t => {
    const f = await fixture(t,action), a = new AbortController();
    const first = f.send(a.signal); first.catch(() => {}); await f.entered.promise;
    const read = deferred(); f.store.onBrowser = () => read.resolve();
    const second = f.send(); await read.promise; await tick(); a.abort();
    await assert.rejects(first, {name:'AbortError'}); await tick();
    assert.equal(f.signals[0].aborted,false); f.finish.resolve();
    assert.equal((await second).status,200); assert.equal(f.calls(),1);
  });

  test(`${action}: disconnecting the last subscriber stops model work and a new request can retry`, {timeout:5000}, async t => {
    const f = await fixture(t,action), controller = new AbortController();
    const first = f.send(controller.signal); first.catch(() => {}); await f.entered.promise; controller.abort();
    await assert.rejects(first,{name:'AbortError'}); await f.aborted.promise;
    assert.equal(f.signals[0].aborted,true);
    f.finish.resolve(); assert.equal((await f.send()).status,200); assert.equal(f.calls(),2);
  });

  test(`${action}: accepted corrections stop obsolete work while rejected corrections preserve it`, {timeout:5000}, async t => {
    const f = await fixture(t,action), pending = f.send(); await f.entered.promise;
    const revision = (await f.store.intake(f.session.owner,f.row.id)).revision;
    const corrected = await f.request(f.session,`/api/intakes/${f.row.id}/back`,'POST',{revision});
    if (action === 'result') {
      // Completed conversations cannot be edited. A rejected mutation must not
      // interrupt an otherwise valid generation for this revision.
      assert.equal(corrected.status,409); assert.equal(f.signals[0].aborted,false);
      f.finish.resolve(); assert.equal((await pending).status,200); return;
    }
    assert.equal(corrected.status,200); assert.equal(f.signals[0].aborted,true);
    const response = await pending; assert.equal(response.status,409); assert.equal(response.data.error.code,'REVISION_CONFLICT');
    assert.equal((await f.store.intake(f.session.owner,f.row.id)).revision,corrected.data.revision);
  });

  test(`${action}: deletion aborts matching work without cancelling another owner's request`, {timeout:5000}, async t => {
    const f = await fixture(t,action), pending = f.send(); await f.entered.promise;
    const other = await f.browser(), otherRow = f.seed(other), read = deferred();
    f.store.onIntake = row => {if (row.id === otherRow.id) read.resolve();};
    const otherPending = f.send(undefined,other,otherRow); await read.promise; await tick();
    const deleted = await f.request(f.session,`/api/intakes/${f.row.id}`,'DELETE'); assert.equal(deleted.status,200);
    assert.equal((await pending).status,404); assert.equal(f.signals[0].aborted,true); assert.equal(f.signals[1].aborted,false);
    f.finish.resolve(); assert.equal((await otherPending).status,200); assert.equal(f.rows.has(f.row.id),false);
  });

  test(`${action}: shutdown aborts outstanding work before waiting for HTTP close`, {timeout:5000}, async t => {
    const f = await fixture(t,action), pending = f.send(); await f.entered.promise;
    await f.shutdown(); assert.equal(f.signals[0].aborted,true);
    assert.equal((await pending).status,499);
  });
}

for (const action of ['answer','result']) test(`${action}: cancellation during a database lock wait prevents the model commit`, {timeout:5000}, async t => {
  const f = await fixture(t,action), controller = new AbortController();
  const waiting = deferred(), release = deferred(), ended = deferred(), original = f.store.updateIntake;
  t.mock.method(f.store,'updateIntake',async (...args) => {
    if (args[4] !== 'model_update') return original(...args);
    waiting.resolve(); await release.promise;
    try {return await original(...args);} finally {ended.resolve();}
  });
  const pending = f.send(controller.signal); pending.catch(() => {}); await f.entered.promise;
  const before = structuredClone(f.rows.get(f.row.id));
  f.finish.resolve(); await waiting.promise; controller.abort();
  await assert.rejects(pending,{name:'AbortError'}); await f.aborted.promise;
  release.resolve(); await ended.promise;
  assert.deepEqual(f.rows.get(f.row.id),before);
});


test('reviewed cards stream in completion order, stay owner-scoped, and do not count as saved', {timeout:5000},async t=>{
  const f=await fixture(t,'result');let events;
  f.store.onRespond=options=>{events=options;};
  const pending=f.send();await f.entered.promise;
  const progressPath=`/api/intakes/${f.row.id}/progress`;
  events.onCard({type:'upsert',id:'next',value:result.guide.next});
  let snapshot=await f.request(f.session,progressPath);
  assert.deepEqual(snapshot.data.cards,[{id:'next',value:result.guide.next}]);
  assert.equal(snapshot.data.progress.status,'running');assert.equal(f.records.size,0);
  assert.equal(f.rows.get(f.row.id).state.agentRecord,undefined);
  events.onCard({type:'upsert',id:'care',value:result.guide.care});
  snapshot=await f.request(f.session,progressPath);
  assert.deepEqual(snapshot.data.cards.map(card=>card.id),['next','care']);
  assert.doesNotMatch(JSON.stringify(snapshot.data.progress),/합성 공감|함께 살펴봐요/);
  const other=await f.browser();assert.equal((await f.request(other,progressPath)).status,404);
  events.onCard({type:'remove',id:'next'});
  assert.deepEqual((await f.request(f.session,progressPath)).data.cards.map(card=>card.id),['care']);
  events.onProgress({stage:'retry',status:'started'});
  assert.deepEqual((await f.request(f.session,progressPath)).data.cards,[]);
  events.onCard({type:'upsert',id:'next',value:result.guide.next});
  f.finish.resolve();const final=await pending;assert.equal(final.status,200);
  assert.equal(f.records.size,1);assert.deepEqual(final.data.record.guide,result.guide);
  assert.deepEqual((await f.request(f.session,`/api/records/${final.data.record.id}`)).data.record,final.data.record);
  const restored=await f.request(f.session,progressPath);assert.equal(restored.data.progress.status,'complete');assert.deepEqual(restored.data.cards,[]);
  assert.equal((await f.send()).status,200);assert.equal(f.calls(),1);assert.equal(f.records.size,1);
});

test('progress remains saving at the generation revision until the record transaction finishes', {timeout:5000},async t=>{
  const f=await fixture(t,'result'),saving=deferred(),release=deferred();
  const save=f.store.saveRecord;
  t.mock.method(f.store,'saveRecord',async (...args)=>{saving.resolve();await release.promise;return save(...args);});
  const pending=f.send();await f.entered.promise;f.finish.resolve();await saving.promise;
  const snapshot=await f.request(f.session,`/api/intakes/${f.row.id}/progress`);
  assert.equal(snapshot.data.revision,0);assert.equal(snapshot.data.progress.status,'saving');
  assert.equal(snapshot.data.progress.progress,80);assert.equal(f.records.size,0);
  release.resolve();assert.equal((await pending).status,200);assert.equal(f.records.size,1);
});

test('a failed final save is never complete and retry stores the same result without regenerating', {timeout:5000},async t=>{
  const f=await fixture(t,'result'),save=f.store.saveRecord;let failed=true;
  t.mock.method(f.store,'saveRecord',async (...args)=>{if(failed){failed=false;throw new HttpError(503,'TEMPORARY_SAVE_FAILURE','retry');}return save(...args);});
  const pending=f.send();await f.entered.promise;f.finish.resolve();assert.equal((await pending).status,503);
  const snapshot=await f.request(f.session,`/api/intakes/${f.row.id}/progress`);
  assert.equal(snapshot.data.progress.status,'failed');assert.equal(f.records.size,0);
  assert.equal((await f.send()).status,200);assert.equal(f.calls(),1);assert.equal(f.records.size,1);
});

test('generation failure discards partial cards and cannot save a partial guide', {timeout:5000},async t=>{
  const f=await fixture(t,'result');
  f.store.onRespond=({onCard})=>onCard({type:'upsert',id:'next',value:result.guide.next});
  f.store.responseError=new HttpError(502,'MODEL_INVALID_RESPONSE','retry');
  const pending=f.send();await f.entered.promise;
  assert.equal((await f.request(f.session,`/api/intakes/${f.row.id}/progress`)).data.cards.length,1);
  f.finish.resolve();assert.equal((await pending).status,502);
  assert.equal(f.records.size,0);assert.equal(f.rows.get(f.row.id).state.agentRecord,undefined);
  assert.deepEqual((await f.request(f.session,`/api/intakes/${f.row.id}/progress`)).data.cards,[]);
});


test('a cancelled generation cannot expose cards while its upstream is still unwinding', {timeout:5000},async t=>{
  const f=await fixture(t,'result'),unwind=deferred(),cancelled=deferred();
  t.after(()=>unwind.resolve());
  t.mock.method(f.gateway,'respond',async (_context,_memory,{signal,onCard})=>{
    onCard({type:'upsert',id:'next',value:result.guide.next});
    signal.addEventListener('abort',()=>cancelled.resolve(),{once:true});f.entered.resolve();
    await unwind.promise;return structuredClone(result);
  });
  const controller=new AbortController(),pending=f.send(controller.signal);pending.catch(()=>{});await f.entered.promise;
  controller.abort();await assert.rejects(pending,{name:'AbortError'});await cancelled.promise;
  const snapshot=await f.request(f.session,`/api/intakes/${f.row.id}/progress`);
  assert.equal(snapshot.data.progress.status,'idle');assert.deepEqual(snapshot.data.cards,[]);
  unwind.resolve();
});
