import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import pg from 'pg';
import {Store} from '../src/store.js';
import {createIntake} from '../src/intake.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseTest = (name, run) => test(name, {skip:!databaseUrl && 'Set TEST_DATABASE_URL to an isolated PostgreSQL test database'}, run);

async function fixture(t) {
  const schema = `test_continuation_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({connectionString:databaseUrl, connectionTimeoutMillis:5000});
  let store;
  t.after(async () => {
    try { await store?.close(); }
    finally {
      try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await admin.end(); }
    }
  });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  store = await Store.connect(databaseUrl, randomBytes(32), 30, {schema});
  const owner = (await store.createBrowser()).id;
  const source = async (id, status = 'ready') => {
    id ??= String(await store.nextRecordId());
    const intake = await store.createIntake(owner, {...createIntake(), status}, 0);
    const record = {id, date:new Date().toISOString(), profile:{name:'합성 사례'}, guide:{script:'기존 카드'}};
    await store.saveRecord(owner, record, intake.id);
    return {intake, record};
  };
  return {store, owner, source};
}

const initial = {status:'active', messages:[], requests:{}, pending:null, summary:null, cards:[]};
const complete = state => ({...state, status:'completed'});

databaseTest('continuation storage seals messages and cards without changing the original record or intake', async t => {
  const {store, owner, source} = await fixture(t);
  const {record, intake} = await source();
  const before = (await store.pool.query(`SELECT content FROM records WHERE owner=$1 AND id=$2
    UNION ALL SELECT content FROM intakes WHERE owner=$1 AND id=$3`, [owner, record.id, intake.id])).rows;
  const session = await store.createContinuation(owner, Number(record.id), 0, randomUUID());
  assert.deepEqual(session.state, initial);
  assert.equal(session.source_record_id, record.id);
  assert.equal(session.source_intake_id, intake.id);
  const updated = await store.updateContinuation(owner, session.id, 0, state => ({...state,
    messages:[{id:'synthetic-user', role:'user', text:'추가로 이야기하고 싶은 합성 내용'}],
    cards:[{id:'synthetic-card', guide:{script:'새로운 합성 안내'}}],
  }));
  assert.equal(updated.revision, 1);
  assert.deepEqual((await store.getContinuation(owner, session.id)).state, updated.state);
  const cipher = (await store.pool.query('SELECT content FROM continuation_sessions WHERE id=$1', [session.id])).rows[0].content;
  assert.equal(cipher.includes('합성'), false);
  assert.throws(() => store.open(cipher, `someone-else:continuation:${session.id}`));
  const listed = await store.listContinuations(owner, record.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].state, undefined);
  assert.equal(JSON.stringify(listed).includes('합성'), false);
  assert.deepEqual((await store.pool.query(`SELECT content FROM records WHERE owner=$1 AND id=$2
    UNION ALL SELECT content FROM intakes WHERE owner=$1 AND id=$3`, [owner, record.id, intake.id])).rows, before);
});

databaseTest('concurrent starts reuse one active round and every start token remains idempotent after completion', async t => {
  const {store, owner, source} = await fixture(t);
  const {record} = await source();
  const tokens = [randomUUID(), randomUUID(), randomUUID()];
  const rows = await Promise.all(tokens.map(token => store.createContinuation(owner, record.id, 0, token)));
  assert.equal(new Set(rows.map(row => row.id)).size, 1);
  await store.updateContinuation(owner, rows[0].id, 0, complete);
  for (const token of tokens) {
    const retry = await store.createContinuation(owner, record.id, 0, token);
    assert.equal(retry.id, rows[0].id);
    assert.equal(retry.state.status, 'completed');
  }
  const next = await store.createContinuation(owner, record.id, 0, randomUUID());
  assert.notEqual(next.id, rows[0].id);
  assert.equal((await store.listContinuations(owner, record.id)).length, 2);
  const otherSource = await source();
  await assert.rejects(store.createContinuation(owner, otherSource.record.id, 0, tokens[0]), {code:'REQUEST_CONFLICT'});
});

databaseTest('continuation source ownership, completion, epoch and request token are checked before creation', async t => {
  const {store, owner, source} = await fixture(t);
  const {record} = await source();
  const other = (await store.createBrowser()).id;
  await assert.rejects(store.createContinuation(other, record.id, 0, randomUUID()), {status:404});
  await assert.rejects(store.createContinuation(owner, record.id, 1, randomUUID()), {code:'CONVERSATIONS_CHANGED'});
  await assert.rejects(store.createContinuation(owner, record.id, undefined, randomUUID()), {code:'INVALID_REVISION'});
  await assert.rejects(store.createContinuation(owner, record.id, 0, ''), {code:'INVALID_REQUEST_ID'});
  const unfinished = await source('not-finished', 'active');
  await assert.rejects(store.createContinuation(owner, unfinished.record.id, 0, randomUUID()), {code:'INTAKE_NOT_COMPLETE'});
  await store.saveRecord(owner, {id:'legacy-no-intake', date:new Date().toISOString()});
  await assert.rejects(store.createContinuation(owner, 'legacy-no-intake', 0, randomUUID()), {status:404});
  assert.deepEqual(await store.listContinuations(owner, record.id), []);
});

databaseTest('concurrent mutation keeps exactly one revision, rejects invalid states and rolls back failures', async t => {
  const {store, owner, source} = await fixture(t);
  const {record} = await source();
  const row = await store.createContinuation(owner, record.id, 0, randomUUID());
  const mutate = text => state => ({...state, messages:[{role:'user', text}]});
  const outcomes = await Promise.allSettled([
    store.updateContinuation(owner, row.id, 0, mutate('첫 번째 합성 입력')),
    store.updateContinuation(owner, row.id, 0, mutate('두 번째 합성 입력')),
  ]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(value => value.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const current = await store.getContinuation(owner, row.id);
  assert.equal(current.revision, 1);
  await assert.rejects(store.updateContinuation(owner, row.id, 1, () => {throw new Error('synthetic failure');}), /synthetic failure/);
  await assert.rejects(store.updateContinuation(owner, row.id, 1, state => ({...state, status:'unknown-state'})), /Invalid continuation state/);
  await assert.rejects(store.updateContinuation(owner, row.id, 1, async state => state), /must be synchronous/);
  assert.deepEqual(await store.getContinuation(owner, row.id), current);
});

databaseTest('another owner cannot list, read, update or delete a continuation', async t => {
  const {store, owner, source} = await fixture(t);
  const {record} = await source();
  const row = await store.createContinuation(owner, record.id, 0, randomUUID());
  const other = (await store.createBrowser()).id;
  await assert.rejects(store.listContinuations(other, record.id), {status:404});
  await assert.rejects(store.getContinuation(other, row.id), {status:404});
  await assert.rejects(store.continuationSources(other, row.id, row.revision), {status:404});
  await assert.rejects(store.updateContinuation(other, row.id, 0, state => state), {status:404});
  await assert.rejects(store.deleteContinuation(other, row.id), {status:404});
  assert.equal((await store.getContinuation(owner, row.id)).revision, 0);
});

databaseTest('deleting a round removes derived later content, preserves later user messages and fences late workers', async t => {
  const {store, owner, source} = await fixture(t);
  const {record} = await source();
  const token = randomUUID();
  const first = await store.createContinuation(owner, record.id, 0, token);
  await store.updateContinuation(owner, first.id, 0, complete);
  const second = await store.createContinuation(owner, record.id, 0, randomUUID());
  const user = {id:'user', role:'user', text:'새로 입력한 합성 내용'};
  await store.updateContinuation(owner, second.id, 0, state => ({...state, status:'pending',
    messages:[user, {role:'assistant', text:'삭제한 회차를 참조한 합성 답변'}],
    requests:{waiting:{action:'messages', hash:'synthetic-message-hash', status:'pending', text:'삭제할 과거 내용'},
      card:{action:'cards', hash:'synthetic-card-hash', status:'done', card_id:'old-card', content:'삭제할 카드 원문'}},
    pending:{request_id:'waiting'}, summary:'이전 인용', cards:[{guide:{script:'이전 카드'}}], memory:{quote:'이전 인용'},
  }));
  const deleted = await store.deleteContinuation(owner, first.id);
  assert.deepEqual(deleted.invalidated_ids, [second.id]);
  const later = await store.getContinuation(owner, second.id);
  assert.equal(later.revision, 2);
  assert.equal(later.state.status, 'active');
  assert.deepEqual(later.state.messages, [user]);
  assert.deepEqual(later.state.cards, []);
  assert.equal(later.state.pending, null);
  assert.equal(later.state.summary, null);
  assert.equal(later.state.memory, undefined);
  assert.deepEqual(later.state.requests, {
    waiting:{action:'messages', hash:'synthetic-message-hash', status:'invalidated'},
    card:{action:'cards', hash:'synthetic-card-hash', status:'invalidated'},
  });
  await assert.rejects(store.updateContinuation(owner, second.id, 1, state => state), {code:'REVISION_CONFLICT'});
  await assert.rejects(store.getContinuation(owner, first.id), {status:404});
  await assert.rejects(store.createContinuation(owner, record.id, 0, token), {status:404});
  assert.deepEqual(await store.record(owner, record.id), record);
});

databaseTest('correction invalidates later completed rounds atomically and rollback leaves them untouched', async t => {
  const {store, owner, source} = await fixture(t);
  const {record} = await source();
  const first = await store.createContinuation(owner, record.id, 0, randomUUID());
  await store.updateContinuation(owner, first.id, 0, complete);
  const second = await store.createContinuation(owner, record.id, 0, randomUUID());
  const old = await store.updateContinuation(owner, second.id, 0, state => ({...state, status:'completed',
    cards:[{guide:{script:'obsolete'}}], messages:[{role:'assistant', text:'obsolete'}], summary:'obsolete',
    requests:{old:{action:'messages', hash:'synthetic-hash', status:'done', content:'obsolete'}},
  }));
  await assert.rejects(store.updateContinuation(owner, first.id, 0, state => state, {invalidateLater:true}), {code:'REVISION_CONFLICT'});
  assert.deepEqual((await store.getContinuation(owner, second.id)).state, old.state);
  const corrected = await store.updateContinuation(owner, first.id, 1, state => ({...state,
    messages:[{role:'user', text:'정정한 합성 입력'}],
  }), {invalidateLater:true});
  assert.deepEqual(corrected.invalidated_ids, [second.id]);
  const latest = await store.getContinuation(owner, second.id);
  assert.equal(latest.state.status, 'completed');
  assert.deepEqual(latest.state.messages, []);
  assert.deepEqual(latest.state.cards, []);
  assert.equal(latest.state.summary, null);
  assert.deepEqual(latest.state.requests, {old:{action:'messages', hash:'synthetic-hash', status:'invalidated'}});
  assert.equal(latest.revision, 2);
});

databaseTest('original record/intake/all-conversations deletion cascade to sessions and start tokens', async t => {
  const {store, owner, source} = await fixture(t);
  for (const kind of ['record', 'intake', 'all']) {
    const {record, intake} = await source();
    const epoch = (await store.history(owner)).conversation_epoch;
    const row = await store.createContinuation(owner, record.id, epoch, randomUUID());
    if (kind === 'record') await store.deleteRecord(owner, record.id);
    if (kind === 'intake') await store.deleteIntake(owner, intake.id);
    if (kind === 'all') await store.deleteConversations(owner);
    await assert.rejects(store.getContinuation(owner, row.id), {status:404});
    await assert.rejects(store.continuationSources(owner, row.id, row.revision), {status:404});
    await assert.rejects(store.updateContinuation(owner, row.id, 0, state => state), {status:404});
    const count = await store.pool.query('SELECT count(*)::integer AS count FROM continuation_creation_requests WHERE owner=$1', [owner]);
    assert.equal(count.rows[0].count, 0);
  }
});

databaseTest('retention blocks all continuation access before cleanup and removes all encrypted rows on cleanup', async t => {
  const {store, owner, source} = await fixture(t);
  const {record} = await source();
  const row = await store.createContinuation(owner, record.id, 0, randomUUID());
  await store.pool.query("UPDATE browsers SET last_active_at=clock_timestamp()-INTERVAL '31 days' WHERE id=$1", [owner]);
  await assert.rejects(store.getContinuation(owner, row.id), {status:404});
  await assert.rejects(store.continuationSources(owner, row.id, row.revision), {status:404});
  await assert.rejects(store.listContinuations(owner, record.id), {status:404});
  await assert.rejects(store.createContinuation(owner, record.id, 0, randomUUID()), {status:404});
  await assert.rejects(store.updateContinuation(owner, row.id, 0, state => state), {status:404});
  await assert.rejects(store.deleteContinuation(owner, row.id), {status:404});
  assert.equal((await store.purgeExpired()).deleted_owners, 1);
  for (const table of ['continuation_sessions', 'continuation_creation_requests']) {
    assert.equal((await store.pool.query(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0].count, 0);
  }
});

databaseTest('source snapshots preserve sequence, owner and record scope in one fixed-cost read',async t=>{
  const {store,owner,source}=await fixture(t),{record}=await source();
  const foreign=await source(),other=(await store.createBrowser()).id;
  let current=await store.createContinuation(owner,record.id,0,randomUUID());
  const expected=[];
  const queryCounts=[];
  const transaction=store.transaction.bind(store);
  let measured=null;
  t.mock.method(store,'transaction',operation=>transaction(client=>operation({query:(sql,...values)=>{
    if(measured)measured.push(sql);return client.query(sql,...values);
  }})));
  for(let index=0;index<4;index++) {
    const message={id:`round-${index}`,role:'user',text:`합성 회차 ${index}`};
    current=await store.updateContinuation(owner,current.id,current.revision,state=>({...state,messages:[message]}));
    expected.push(message);
    measured=[];
    const snapshot=await store.continuationSources(owner,current.id,current.revision);
    queryCounts.push(measured.length);measured=null;
    assert.deepEqual(snapshot.record,record);
    assert.deepEqual(snapshot.messages,expected);
    await assert.rejects(store.continuationSources(other,current.id,current.revision),{status:404});
    await assert.rejects(store.continuationSources(owner,current.id,current.revision-1),{code:'REVISION_CONFLICT'});
    if(index<3){
      await store.updateContinuation(owner,current.id,current.revision,complete);
      current=await store.createContinuation(owner,record.id,0,randomUUID());
    }
  }
  assert.deepEqual(queryCounts,[3,3,3,3]); // owner, current+record, all prior rounds
  const older=(await store.listContinuations(owner,record.id))[1];
  const old=await store.getContinuation(owner,older.id);
  assert.deepEqual((await store.continuationSources(owner,old.id,old.revision)).messages,expected.slice(0,2));
  const unrelated=await store.createContinuation(owner,foreign.record.id,0,randomUUID());
  await store.updateContinuation(owner,unrelated.id,0,state=>({...state,messages:[{role:'user',text:'다른 기준 기록'}]}));
  assert.deepEqual((await store.continuationSources(owner,current.id,current.revision)).messages,expected);
});

databaseTest('snapshot owner lock holds a consistent history and later correction fences its completion',async t=>{
  const {store,owner,source}=await fixture(t),{record}=await source();
  let first=await store.createContinuation(owner,record.id,0,randomUUID());
  first=await store.updateContinuation(owner,first.id,0,state=>({...state,status:'completed',messages:[{role:'user',text:'정정 전 합성 보고'}]}));
  const current=await store.createContinuation(owner,record.id,0,randomUUID());
  let release,entered;
  const gate=new Promise(resolve=>release=resolve),locked=new Promise(resolve=>entered=resolve);
  const lockOwner=store.lockOwner.bind(store);
  t.mock.method(store,'lockOwner',async(client,id,mode)=>{
    const result=await lockOwner(client,id,mode);
    if(mode==='SHARE'){entered();await gate;}
    return result;
  });
  const pending=store.continuationSources(owner,current.id,current.revision);
  await locked;
  let changed=false;
  const correction=store.updateContinuation(owner,first.id,first.revision,state=>({...state,messages:[{role:'user',text:'정정 후 합성 보고'}]}),{invalidateLater:true}).then(row=>{changed=true;return row;});
  try{
    await new Promise(resolve=>setTimeout(resolve,15));assert.equal(changed,false);
  }finally{release();}
  assert.deepEqual((await pending).messages,[{role:'user',text:'정정 전 합성 보고'}]);
  await correction;
  await assert.rejects(store.updateContinuation(owner,current.id,current.revision,state=>state),{code:'REVISION_CONFLICT'});
  await assert.rejects(store.continuationSources(owner,current.id,current.revision),{code:'REVISION_CONFLICT'});
  const latest=await store.getContinuation(owner,current.id);
  assert.deepEqual((await store.continuationSources(owner,current.id,latest.revision)).messages,[{role:'user',text:'정정 후 합성 보고'}]);
  await store.deleteContinuation(owner,first.id);
  await assert.rejects(store.continuationSources(owner,current.id,latest.revision),{code:'REVISION_CONFLICT'});
});
