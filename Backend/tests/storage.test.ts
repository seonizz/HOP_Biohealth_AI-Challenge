/** Real PostgreSQL behavior, never an in-memory SQL substitute.
 * Requires HOP_TEST_DATABASE_URL or DATABASE_URL with schema-creation permission.
 * Cleanup is confined to the exact random schema each test creates.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store, Conflict, hash, timestamp } from '../src/storage.ts';
import type { Project, Message } from '../src/storage.ts';

const url = process.env.HOP_TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const integration = url ? test : test.skip;
const encodedPasswordFixture = 'scrypt$test-fixture-not-a-login-password-hash';

async function fixture(t: { after: (callback: () => Promise<void>) => void }) {
  const schema = 'hop_test_' + randomUUID().replaceAll('-', '');
  const store = await Store.connect(url, { schema });
  const additional: Store[] = [];
  t.after(async () => {
    for (const connection of additional) await connection.close();
    assert.match(schema, /^hop_test_[a-f0-9]{32}$/u);
    try { await store.pool.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await store.close(); }
  });
  async function connect(migrate = false) {
    const connection = await Store.connect(url, { schema, migrate });
    additional.push(connection); return connection;
  }
  return { store, schema, connect };
}

function turn(project: Project, requestId = randomUUID(), value = '친구 관계') {
  const next = structuredClone(project), at = timestamp();
  const messages: Message[] = [
    { id: randomUUID(), role: 'user', content: value, created_at: at },
    { id: randomUUID(), role: 'assistant', content: '다음 상황을 알려주세요.', created_at: at },
  ];
  next.revision++;
  next.updated_at = at;
  next.profile['1'] = { status: 'answered', value, source: 'observation', evidence: value, message_id: messages[0].id, updated_at: at };
  return { project: next, messages, requestId, digest: hash(value), response: { request_id: requestId, project: next, reply: messages[1].content } };
}

integration('migration is repeatable and runtime validation performs no schema changes', async t => {
  const { store, connect } = await fixture(t);
  const before = (await store.pool.query('SELECT version,checksum,applied_at FROM schema_migrations')).rows;
  await Promise.all([connect(true), connect(true), connect(false)]);
  const after = (await store.pool.query('SELECT version,checksum,applied_at FROM schema_migrations')).rows;
  assert.deepEqual(after, before);
  assert.equal(after.length, 1);
  assert.equal(after[0].version, 1);
});

integration('runtime startup rejects a migration checksum mismatch', async t => {
  const { store, schema } = await fixture(t);
  await store.pool.query('UPDATE schema_migrations SET checksum=$1 WHERE version=1', ['0'.repeat(64)]);
  await assert.rejects(Store.connect(url, { schema, migrate: false }), /migration/u);
});

integration('email normalization and uniqueness preserve password-hash boundary', async t => {
  const { store } = await fixture(t);
  const created = await store.createUser(' PERSON@Example.Invalid ', encodedPasswordFixture);
  assert.equal(created.email, 'person@example.invalid');
  assert.deepEqual(Object.keys(created).sort(), ['email', 'id']);
  assert.deepEqual(await store.getUser(created.id), created);
  assert.equal((await store.findUserByEmail('Person@Example.Invalid'))?.password_hash, encodedPasswordFixture);
  await assert.rejects(store.createUser('person@example.invalid', encodedPasswordFixture), Conflict);
  assert.equal(await store.findUserByEmail('absent@example.invalid'), null);
});

integration('session tokens are hashed, expire in seven days, and can be revoked', async t => {
  const { store } = await fixture(t);
  const user = await store.createUser('session@example.invalid', encodedPasswordFixture);
  const token = await store.newSession(user.id);
  assert.equal(await store.authenticate(token), user.id);
  const row = (await store.pool.query('SELECT token_hash,created_at,expires_at FROM sessions')).rows[0];
  assert.equal(row.token_hash, hash(token));
  assert.notEqual(row.token_hash, token);
  assert.equal(row.expires_at.getTime() - row.created_at.getTime(), 7 * 24 * 60 * 60 * 1000);
  await store.pool.query("UPDATE sessions SET created_at=now()-interval '8 days',expires_at=now()-interval '1 second' WHERE token_hash=$1", [hash(token)]);
  assert.equal(await store.authenticate(token), null);
  const active = await store.newSession(user.id);
  await store.revokeSession(active);
  assert.equal(await store.authenticate(active), null);
});

integration('turn commits profile, ordered messages, version and replay response together', async t => {
  const { store } = await fixture(t);
  const owner = await store.createUser('turn@example.invalid', encodedPasswordFixture);
  const project = await store.create(owner.id, '도움 기록');
  const input = turn(project);
  await store.saveTurn(owner.id, 0, input.project, input.messages, input.requestId, input.digest, input.response);
  assert.deepEqual((await store.messages(project.id)).map(item => item.role), ['user', 'assistant']);
  assert.equal((await store.get(owner.id, project.id))?.revision, 1);
  assert.deepEqual(await store.cached(project.id, input.requestId, input.digest), input.response);
  await assert.rejects(store.cached(project.id, input.requestId, hash('changed')), Conflict);
  assert.equal((await store.pool.query('SELECT count(*)::integer AS n FROM profile_versions')).rows[0].n, 1);
});

integration('two simultaneous revisions cannot both commit', async t => {
  const { store, connect } = await fixture(t);
  const owner = await store.createUser('race@example.invalid', encodedPasswordFixture);
  const project = await store.create(owner.id, '경합 기록');
  const secondStore = await connect();
  const first = turn(project, randomUUID(), '첫 번째 답변'), second = turn(project, randomUUID(), '두 번째 답변');
  const outcomes = await Promise.allSettled([
    store.saveTurn(owner.id, 0, first.project, first.messages, first.requestId, first.digest, first.response),
    secondStore.saveTurn(owner.id, 0, second.project, second.messages, second.requestId, second.digest, second.response),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof Conflict);
  assert.equal((await store.get(owner.id, project.id))?.revision, 1);
  assert.equal((await store.messages(project.id)).length, 2);
  assert.equal((await store.pool.query('SELECT count(*)::integer AS n FROM requests')).rows[0].n, 1);
});

integration('failure after project update rolls back every turn write', async t => {
  const { store } = await fixture(t);
  const owner = await store.createUser('rollback@example.invalid', encodedPasswordFixture);
  const project = await store.create(owner.id, '원자성 기록');
  const input = turn(project);
  input.messages[1].id = input.messages[0].id;
  await assert.rejects(store.saveTurn(owner.id, 0, input.project, input.messages, input.requestId, input.digest, input.response), Conflict);
  assert.equal((await store.get(owner.id, project.id))?.revision, 0);
  assert.deepEqual(await store.messages(project.id), []);
  assert.equal(await store.cached(project.id, input.requestId, input.digest), null);
  assert.equal((await store.pool.query('SELECT count(*)::integer AS n FROM profile_versions')).rows[0].n, 0);
});

integration('owner isolation and project deletion cascade preserve other records', async t => {
  const { store } = await fixture(t);
  const owner = await store.createUser('owner@example.invalid', encodedPasswordFixture);
  const other = await store.createUser('other@example.invalid', encodedPasswordFixture);
  const project = await store.create(owner.id, '삭제 기록'), survivor = await store.create(owner.id, '남길 기록');
  const input = turn(project);
  await store.saveTurn(owner.id, 0, input.project, input.messages, input.requestId, input.digest, input.response);
  assert.equal(await store.get(other.id, project.id), null);
  assert.deepEqual(await store.list(other.id), []);
  assert.equal(await store.delete(other.id, project.id), false);
  assert.equal(await store.delete(owner.id, project.id), true);
  for (const table of ['messages', 'requests', 'profile_versions']) assert.equal((await store.pool.query(`SELECT count(*)::integer AS n FROM ${table} WHERE project_id=$1`, [project.id])).rows[0].n, 0);
  assert.equal((await store.get(owner.id, survivor.id))?.id, survivor.id);
});

integration('password rotation cannot leave a concurrently issued old-password session active', async t => {
  const {store}=await fixture(t);
  const user=await store.createUser('rotation@example.invalid',encodedPasswordFixture);
  const old=await store.newSession(user.id,encodedPasswordFixture);
  const outcomes=await Promise.allSettled([
    store.changePassword(user.id,encodedPasswordFixture,'next-password-fixture'),
    store.newSession(user.id,encodedPasswordFixture),
  ]);
  assert.equal(outcomes[0].status,'fulfilled');
  if(outcomes[0].status==='fulfilled') assert.equal(await store.authenticate(outcomes[0].value),user.id);
  if(outcomes[1].status==='fulfilled') assert.equal(await store.authenticate(outcomes[1].value),null);
  else assert.ok(outcomes[1].reason instanceof Conflict);
  assert.equal(await store.authenticate(old),null);
  await assert.rejects(store.newSession(user.id,encodedPasswordFixture),Conflict);
  await assert.rejects(store.changePassword(user.id,encodedPasswordFixture,'wrong-change'),Conflict);
  assert.equal((await store.findUserByEmail(user.email))?.password_hash,'next-password-fixture');
});
