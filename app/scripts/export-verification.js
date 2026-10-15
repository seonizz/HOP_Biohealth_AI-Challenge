import pg from 'pg';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { Store, loadContentKey } from '../src/store.js';

// Administrator-only local export. It is never served by the HTTP app.
if (!process.env.DATABASE_URL) throw new Error('Run with the local .env database configuration');
const pool = new pg.Pool({ connectionString:process.env.DATABASE_URL, connectionTimeoutMillis:5000 });
const store = new Store(pool, loadContentKey('./runtime/content.key'));
const client = await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const questions = (await client.query('SELECT id,kind,sort_order,enabled,subject,definition,updated_at FROM questions ORDER BY sort_order,id')).rows;
  const intakes = (await client.query('SELECT id,owner,revision,content,updated_at FROM intakes ORDER BY updated_at')).rows
    .map(({ content, ...row }) => ({ ...row, state:store.open(content, `${row.owner}:intake:${row.id}`) }));
  const states = (await client.query('SELECT intake_id,owner,revision,content,updated_at FROM patient_states ORDER BY updated_at')).rows
    .map(({ content, ...row }) => ({ ...row, context:store.open(content, `${row.owner}:patient:${row.intake_id}:${row.revision}`) }));
  const revisions = (await client.query('SELECT intake_id,owner,revision,reason,content,created_at FROM patient_state_revisions ORDER BY intake_id,revision')).rows
    .map(({ content, ...row }) => ({ ...row, context:store.open(content, `${row.owner}:patient-history:${row.intake_id}:${row.revision}`) }));
  const records = (await client.query('SELECT id,owner,intake_id,content,created_at FROM records ORDER BY created_at')).rows
    .map(({ content, ...row }) => ({ ...row, record:store.open(content, `${row.owner}:record:${row.id}`) }));
  await client.query('COMMIT');
  mkdirSync('runtime', { recursive:true, mode:0o700 });
  const output='runtime/server-verification.json';
  writeFileSync(output, JSON.stringify({ schema_version:'1.0', exported_at:new Date().toISOString(), questions, intakes, states, revisions, records }, null, 2), { mode:0o600 });
  chmodSync(output, 0o600);
  console.log(JSON.stringify({ file:output, questions:questions.length, intakes:intakes.length, states:states.length, revisions:revisions.length, records:records.length }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  client.release(); await pool.end();
}
