// Synthetic, disposable-DB rehearsal. This does not certify a production backup.
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Store} from '../app/src/store.js';
import {createIntake} from '../app/src/intake.js';
import {finalRehearsalConnection} from './final_rehearsal_connection.mjs';
const require = createRequire(new URL('../app/package.json', import.meta.url));
const {Pool} = require('pg');

const container = process.env.FINALS_TEST_CONTAINER;
const connectionString = finalRehearsalConnection(process.env.FINALS_TEST_DATABASE_URL, container);
const url = new URL(connectionString);
const inspected = JSON.parse(execFileSync('docker', ['inspect', container], {encoding:'utf8'}))[0];
assert.equal(inspected.Config.Labels['codex.task'], 'finals-remediation-20261027');
const binding = inspected.NetworkSettings.Ports['5432/tcp'];
assert.ok(binding?.some(p => p.HostIp === '127.0.0.1' && p.HostPort === url.port));
assert.ok(inspected.HostConfig.Tmpfs['/var/lib/postgresql/data']);

const schema = `finals_restore_${randomUUID().replaceAll('-', '')}`;
const admin = new Pool({connectionString, connectionTimeoutMillis:5000});
const key = randomBytes(32);
const checks = [];
let store;
const verify = (name, actual, expected) => {
  assert.deepEqual(actual, expected, name);
  checks.push({name, passed:true});
};
const rowCounts = async owner => {
  const counts = {};
  for (const table of ['intakes', 'records', 'patient_states', 'patient_state_revisions']) {
    counts[table] = (await store.pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE owner=$1`, [owner])).rows[0].n;
  }
  return counts;
};
let cleaned = false;
try {
  await admin.query(`CREATE SCHEMA ${schema}`);
  store = await Store.connect(connectionString, key, 30, {schema, retentionDays:30});
  const first = await store.createBrowser();
  const second = await store.createBrowser();
  const expired = await store.createBrowser();
  for (const [i, owner] of [first, second, expired].entries()) {
    const intake = await store.createIntake(owner.id, createIntake());
    await store.saveRecord(owner.id, {id:`synthetic-${i}`, date:new Date().toISOString(), text:'Synthetic restore rehearsal only'}, intake.id);
  }
  const kept = await store.records(second.id);
  const erased = {intakes:0, records:0, patient_states:0, patient_state_revisions:0};
  const populated = {intakes:1, records:1, patient_states:1, patient_state_revisions:1};
  verify('initial owner isolation', (await store.records(first.id)).map(r => r.id), ['synthetic-0']);
  await assert.rejects(store.record(second.id, 'synthetic-0'), {status:404});
  checks.push({name:'cross-owner read rejected', passed:true});
  await store.pool.query("UPDATE browsers SET last_active_at=clock_timestamp()-INTERVAL '31 days' WHERE id=$1", [expired.id]);
  // All backup bytes and the synthetic deletion list stay in memory.
  const backup = execFileSync('docker', ['exec', container, 'pg_dump', '-U', 'finals_test', '-d', 'finals_test', '--schema', schema, '--no-owner', '--no-privileges'], {maxBuffer:16*1024*1024});
  const deletionReplay = [first.id];
  await store.deleteConversations(first.id);
  verify('live deletion removes linked rows', await rowCounts(first.id), erased);
  await store.close(); store = null;
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  execFileSync('docker', ['exec', '-i', container, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'finals_test', '-d', 'finals_test'], {input:backup, stdio:['pipe','pipe','pipe'], maxBuffer:16*1024*1024});
  store = await Store.connect(connectionString, key, 30, {schema, retentionDays:30});
  verify('pre-deletion backup restores old rows before replay', await rowCounts(first.id), populated);
  verify('expired access is blocked after restore', await store.browser(expired.token), null);
  for (const owner of deletionReplay) await store.deleteConversations(owner);
  verify('replayed deletion removes all linked rows', await rowCounts(first.id), erased);
  verify('replay preserves the other owner', await store.records(second.id), kept);
  for (const owner of deletionReplay) await store.deleteConversations(owner);
  verify('replayed deletion is repeatable', await rowCounts(first.id), erased);
  verify('retention cleanup removes expired owner', (await store.purgeExpired()).deleted_owners, 1);
  verify('retention cleanup removes linked rows', await rowCounts(expired.id), erased);
  verify('surviving encrypted record is readable', await store.records(second.id), kept);
} finally {
  try { await store?.close(); }
  finally {
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      cleaned = (await admin.query('SELECT COUNT(*)::int AS n FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].n === 0;
    } finally { await admin.end(); key.fill(0); }
  }
}
assert.ok(cleaned, 'Rehearsal schema cleanup failed');
const output = {
  schema:'malssi-synthetic-restore-rehearsal-v1', synthetic:true,
  performed_at:new Date().toISOString(), passed:true, checks,
  schema_removed:cleaned, human_participants:0, production_ready:false,
  physical_deletion_verified:false, production_backup_verified:false,
  limitations:[
    'Uses three synthetic owners in a new schema of a disposable, loopback-only PostgreSQL container.',
    'Deletion replay uses a synthetic in-memory list. Durable deletion-event capture and backup handling require an actual operational design and evidence.',
    'Confirms SQL restore, access controls and replay behaviour only; does not prove WAL, storage-medium or external-copy erasure.',
    'No production database, real user, model inference or institutional approval is involved.'
  ]
};
const directory = resolve('runtime/finals-remediation-20261027/operations');
await mkdir(directory, {recursive:true});
await writeFile(resolve(directory, 'restore-rehearsal.json'), JSON.stringify(output, null, 2)+'\n');
console.log(JSON.stringify({passed:true, checks:checks.length, schema_removed:cleaned, synthetic:true}));
