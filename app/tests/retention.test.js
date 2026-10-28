import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { createIntake } from '../src/intake.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const databaseTest = (name, run) => test(name, {skip:!databaseUrl}, run);

async function fixture(t, options = {}) {
  const schema = 'retention_test_' + randomBytes(8).toString('hex');
  const admin = new pg.Pool({connectionString:databaseUrl});
  const key = randomBytes(32);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const f = {admin,schema,key,app:null};
  f.stop = async () => { if(f.app)await f.app.shutdown(); };
  t.after(async () => {
    await f.stop();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  f.start = async () => {
    f.app = await createApp({databaseUrl,schema,key,gateway:null,...options});
    await new Promise(resolve => f.app.server.listen(0,'127.0.0.1',resolve));
    f.base = `http://127.0.0.1:${f.app.server.address().port}`;
    f.store = f.app.store;
  };
  await f.start();
  f.request = async (path, {session,method='GET',body,origin=f.base,headers={}} = {}) => {
    const response = await fetch(f.base+path, {method,signal:AbortSignal.any([t.signal,AbortSignal.timeout(5000)]),headers:{
      ...(origin ? {origin} : {}), ...(session ? {cookie:session.cookie,'x-csrf-token':session.csrf} : {}),
      ...(body !== undefined ? {'content-type':'application/json'} : {}), ...headers,
    }, ...(body !== undefined ? {body:JSON.stringify(body)} : {})});
    return {status:response.status,data:await response.json(),headers:response.headers};
  };
  f.browser = async () => {
    const result = await f.request('/api/bootstrap');
    return {cookie:result.headers.get('set-cookie').split(';')[0],csrf:result.data.csrf_token,bootstrap:result.data};
  };
  return f;
}

async function seed(store, owner, id='record') {
  const intake = await store.createIntake(owner, createIntake(), 0);
  await store.saveRecord(owner, {id,date:new Date().toISOString()}, intake.id);
  await store.createIntake(owner, createIntake(), 0);
  await store.saveRecord(owner, {id:id+'-legacy',date:new Date().toISOString()});
  await store.setColumnState(owner, 'food', {read:true,saved:true});
  return intake;
}

async function emptyConversations(store, owner) {
  for (const table of ['intakes','records','patient_states','patient_state_revisions']) {
    assert.equal((await store.pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${table} WHERE owner=$1`, [owner])).rows[0].count, 0, table);
  }
}

test('retention settings reject invalid values before opening any database', async () => {
  for (const retentionDays of [0,-1,91,1.5,NaN,Infinity,'30',null]) {
    assert.throws(() => new Store(null,randomBytes(32),30,retentionDays), /DATA_RETENTION_DAYS/);
    await assert.rejects(createApp({retentionDays}), /DATA_RETENTION_DAYS/);
  }
  for (const retentionCleanupMs of [0,9,3600001,1.5,Infinity]) {
    await assert.rejects(createApp({retentionCleanupMs}), /cleanup interval/);
  }
});

databaseTest('a deletion key removes only its owner after cookie expiry or cookie loss and never restores reads', async t => {
  const f = await fixture(t), old = await f.browser(), other = await f.browser();
  const owner = (await f.store.browser(old.cookie.slice(15))).id;
  const otherOwner = (await f.store.browser(other.cookie.slice(15))).id;
  const intake = await seed(f.store, owner), foreign = await seed(f.store, otherOwner, 'foreign');
  const issued = await f.request('/api/deletion-key',{session:old,method:'POST',body:{}});
  assert.equal(issued.status,201);assert.match(issued.data.deletion_key,/^[A-Za-z0-9_-]{43}$/);
  const stored = (await f.store.pool.query('SELECT deletion_key_hash FROM browsers WHERE id=$1',[owner])).rows[0];
  assert.notEqual(stored.deletion_key_hash,issued.data.deletion_key);assert.equal(stored.deletion_key_hash.length,64);
  await f.store.pool.query("UPDATE browsers SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE id=$1",[owner]);
  assert.equal((await f.request('/api/conversations',{session:old,method:'DELETE'})).status,401);
  assert.equal((await f.request(`/api/intakes/${intake.id}`,{session:other})).status,404);
  assert.equal((await f.request(`/api/intakes/${intake.id}`,{headers:{cookie:'malssi_session='+issued.data.deletion_key}})).status,401);
  const deleted = await f.request('/api/conversations/delete-with-key',{method:'POST',session:old,body:issued.data});
  assert.deepEqual(deleted.data,{deleted:true,current_session:true,conversation_epoch:1});
  await emptyConversations(f.store,owner);
  assert.deepEqual(await f.store.columnState(owner),{read:['food'],saved:['food']});
  assert.equal((await f.request(`/api/intakes/${foreign.id}`,{session:other})).status,200);
  assert.equal((await f.request(`/api/intakes/${intake.id}`,{session:old})).status,401);
  // Reusing a key after an uncertain response is safe, including without a cookie.
  const retried = await f.request('/api/conversations/delete-with-key',{method:'POST',body:issued.data});
  assert.deepEqual(retried.data,{deleted:true,current_session:false});
  assert.equal(JSON.stringify(retried.data).includes(owner),false);

  const stillActive = await f.browser(), activeOwner = (await f.store.browser(stillActive.cookie.slice(15))).id;
  await seed(f.store,activeOwner,'lost-cookie');
  const lostKey = (await f.request('/api/deletion-key',{session:stillActive,method:'POST',body:{}})).data;
  const afterLoss = await f.request('/api/conversations/delete-with-key',{session:other,method:'POST',body:lostKey});
  assert.deepEqual(afterLoss.data,{deleted:true,current_session:false});
  await emptyConversations(f.store,activeOwner);
  assert.equal((await f.request(`/api/intakes/${foreign.id}`,{session:other})).status,200);
});

databaseTest('key issuance requires session and CSRF; key deletion validates origin, shape, rotation, and owner scope', async t => {
  const f = await fixture(t), session = await f.browser(), other = await f.browser();
  const owner = (await f.store.browser(session.cookie.slice(15))).id;
  const intake = await seed(f.store,owner);
  assert.equal((await f.request('/api/deletion-key',{method:'POST',body:{}})).status,401);
  assert.equal((await f.request('/api/deletion-key',{session,method:'POST',body:{},headers:{'x-csrf-token':'wrong'}})).status,403);
  const first = (await f.request('/api/deletion-key',{session,method:'POST',body:{}})).data;
  const second = (await f.request('/api/deletion-key',{session,method:'POST',body:{}})).data;
  for (const deletion_key of [first.deletion_key,other.cookie.slice(15),'bad',null,{},[second.deletion_key]]) {
    const response = await f.request('/api/conversations/delete-with-key',{method:'POST',body:{deletion_key}});
    assert.equal(response.status,404);assert.equal(response.data.error.code,'DELETION_KEY_INVALID');
  }
  for (const origin of [null,'https://outside.example']) {
    assert.equal((await f.request('/api/conversations/delete-with-key',{method:'POST',body:second,origin})).status,403);
  }
  assert.equal((await f.request('/api/conversations/delete-with-key',{method:'POST',body:{...second,owner}})).status,422);
  assert.equal((await f.request('/api/conversations/delete-with-key',{method:'POST',body:second,headers:{'content-type':'text/plain'}})).status,415);
  assert.equal((await f.request('/api/conversations/delete-with-key',{method:'POST',body:{deletion_key:'x'.repeat(262145)}})).status,413);
  assert.equal((await f.store.intake(owner,intake.id)).id,intake.id);
  const bootstrap = await f.request('/api/bootstrap',{session});
  assert.equal(JSON.stringify(bootstrap.data).includes(second.deletion_key),false);
  assert.equal((await f.request('/api/conversations/delete-with-key',{method:'POST',body:second})).status,200);
});

databaseTest('key deletion retains rate limiting before credentials are checked', async t => {
  const f = await fixture(t,{rateLimit:1});
  assert.equal((await f.request('/api/conversations/delete-with-key',{method:'POST',body:{deletion_key:'bad'}})).status,404);
  const blocked = await f.request('/api/conversations/delete-with-key',{method:'POST',body:{deletion_key:'bad'}});
  assert.equal(blocked.status,429);assert.equal(blocked.headers.get('retry-after'),'60');
});

databaseTest('retention boundary blocks revival and late writes, then cascades every owner row without touching active owners', async t => {
  const f = await fixture(t,{retentionDays:7}), expired = await f.store.createBrowser(), active = await f.store.createBrowser();
  const intake = await seed(f.store,expired.id), foreign = await seed(f.store,active.id,'active');
  await f.store.pool.query("UPDATE browsers SET last_active_at=clock_timestamp()-INTERVAL '7 days' WHERE id=$1",[expired.id]);
  assert.equal(await f.store.browser(expired.token),null);
  for (const write of [
    () => f.store.createIntake(expired.id,createIntake(),0),
    () => f.store.updateIntake(expired.id,intake.id,0,state=>state),
    () => f.store.saveRecord(expired.id,{id:'late',date:new Date().toISOString()},intake.id),
    () => f.store.setColumnState(expired.id,'late',{saved:true}),
    () => f.store.createDeletionKey(expired.id),
  ]) await assert.rejects(write(),{status:404});
  await f.store.pool.query("UPDATE browsers SET last_active_at=clock_timestamp()-INTERVAL '6 days 23 hours' WHERE id=$1",[active.id]);
  assert.deepEqual(await f.store.purgeExpired(),{deleted_owners:1});
  await emptyConversations(f.store,expired.id);
  assert.equal((await f.store.pool.query('SELECT id FROM browsers WHERE id=$1',[expired.id])).rowCount,0);
  assert.deepEqual(await f.store.columnState(expired.id),{read:[],saved:[]});
  assert.equal((await f.store.intake(active.id,foreign.id)).id,foreign.id);
  assert.ok(await f.store.browser(active.token));
  const activity = (await f.store.pool.query('SELECT last_active_at>clock_timestamp()-INTERVAL \'1 minute\' AS recent FROM browsers WHERE id=$1',[active.id])).rows[0];
  assert.equal(activity.recent,true);
  assert.deepEqual(await f.store.purgeExpired(),{deleted_owners:0});
});

databaseTest('key deletion invalidates queued creation and cannot be undone by a late record save', async t => {
  const f = await fixture(t), session = await f.browser(), owner = (await f.store.browser(session.cookie.slice(15))).id;
  const intake = await seed(f.store,owner);
  const key = await f.store.createDeletionKey(owner);
  let release, entered;
  const gate = new Promise(resolve=>release=resolve), started = new Promise(resolve=>entered=resolve);
  const original = f.store.createIntake.bind(f.store);
  f.store.createIntake = async (...args) => {entered();await gate;return original(...args);};
  const pending = f.request('/api/intakes',{session,method:'POST',body:{conversation_epoch:0}});
  await started;
  try {
    assert.equal((await f.request('/api/conversations/delete-with-key',{method:'POST',body:{deletion_key:key}})).status,200);
  } finally {release();}
  assert.equal((await pending).data.error.code,'CONVERSATIONS_CHANGED');
  await assert.rejects(f.store.saveRecord(owner,{id:'late',date:new Date().toISOString()},intake.id),{status:404});
  await emptyConversations(f.store,owner);
  assert.equal((await f.request('/api/intakes',{session,method:'POST',body:{conversation_epoch:1}})).status,201);
});

databaseTest('expired-owner cleanup racing creation, answer and result saves leaves no resurrected data', async t => {
  const f = await fixture(t), owner = await f.store.createBrowser();
  const intake = await seed(f.store,owner.id);
  await f.store.pool.query("UPDATE browsers SET last_active_at=clock_timestamp()-INTERVAL '30 days' WHERE id=$1",[owner.id]);
  const outcomes = await Promise.allSettled([
    f.store.purgeExpired(),
    f.store.createIntake(owner.id,createIntake(),0),
    f.store.updateIntake(owner.id,intake.id,0,state=>state),
    f.store.saveRecord(owner.id,{id:'raced',date:new Date().toISOString()},intake.id),
    f.store.browser(owner.token),
  ]);
  assert.equal(outcomes[0].status,'fulfilled');
  for (const outcome of outcomes.slice(1,4)) {
    assert.equal(outcome.status,'rejected');assert.equal(outcome.reason.code,'NOT_FOUND');
  }
  assert.equal(outcomes[4].value,null);
  await emptyConversations(f.store,owner.id);
  assert.equal((await f.store.pool.query('SELECT id FROM browsers WHERE id=$1',[owner.id])).rowCount,0);
});

databaseTest('startup and periodic cleanup actually remove expired content; cleanup failures are visible and retried', async t => {
  const f = await fixture(t), old = await f.store.createBrowser();
  await seed(f.store,old.id);
  await f.store.pool.query("UPDATE browsers SET last_active_at=clock_timestamp()-INTERVAL '31 days' WHERE id=$1",[old.id]);
  await f.stop();
  await f.start();
  await emptyConversations(f.store,old.id);
  assert.equal((await f.store.pool.query('SELECT id FROM browsers WHERE id=$1',[old.id])).rowCount,0);

  const timed = await fixture(t,{retentionCleanupMs:20}), owner = await timed.store.createBrowser();
  await seed(timed.store,owner.id);
  const purge = timed.store.purgeExpired.bind(timed.store), previous = console.error;
  const errors=[];
  try {
    console.error = value=>errors.push(value);
    timed.store.purgeExpired = async () => {throw new Error('synthetic failure');};
    await delay(60);
    assert.equal((await timed.request('/health')).status,503);
    assert.ok(errors.some(value=>JSON.parse(value).event==='retention_cleanup_failed'));
    timed.store.purgeExpired = purge;
    await timed.store.pool.query("UPDATE browsers SET last_active_at=clock_timestamp()-INTERVAL '31 days' WHERE id=$1",[owner.id]);
    for (let i=0;i<100;i++) {
      if (!(await timed.store.pool.query('SELECT id FROM browsers WHERE id=$1',[owner.id])).rowCount) break;
      await delay(10);
    }
    await emptyConversations(timed.store,owner.id);
    assert.equal((await timed.store.pool.query('SELECT id FROM browsers WHERE id=$1',[owner.id])).rowCount,0);
    assert.equal((await timed.request('/health')).status,200);
  } finally {console.error=previous;timed.store.purgeExpired=purge;}
});

databaseTest('retention migration gives existing owners a bounded grace period and preserves encrypted content', async t => {
  const f = await fixture(t), owner = await f.store.createBrowser();
  const intake = await seed(f.store,owner.id);
  const ciphertext = (await f.store.pool.query('SELECT content FROM intakes WHERE id=$1',[intake.id])).rows[0].content;
  await f.store.pool.query('ALTER TABLE browsers DROP COLUMN last_active_at, DROP COLUMN deletion_key_hash');
  await f.store.pool.query("DELETE FROM schema_migrations WHERE version='006_data_retention.sql'");
  await f.stop();
  await f.start();
  const row = (await f.store.pool.query("SELECT last_active_at>clock_timestamp()-INTERVAL '1 minute' AS recent,deletion_key_hash FROM browsers WHERE id=$1",[owner.id])).rows[0];
  assert.deepEqual(row,{recent:true,deletion_key_hash:null});
  assert.equal((await f.store.pool.query('SELECT content FROM intakes WHERE id=$1',[intake.id])).rows[0].content,ciphertext);
  assert.ok(await f.store.browser(owner.token));
});
