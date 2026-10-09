import pg from 'pg';
const url = process.env.HOP_MIGRATION_DATABASE_URL;
const role = process.env.HOP_RUNTIME_ROLE;
const schema = process.env.HOP_DATABASE_SCHEMA || 'public';
if (!url || !role) throw new Error('HOP_MIGRATION_DATABASE_URL and HOP_RUNTIME_ROLE are required');
for (const identifier of [role, schema]) if (!/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) throw new Error('Invalid PostgreSQL identifier');
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10000, statement_timeout: 15000 });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('GRANT USAGE ON SCHEMA "' + schema + '" TO "' + role + '"');
  for (const table of ['users','sessions','projects','messages','requests','profile_versions','consent_records','v2_projects','temporary_content_keys','conversations','requests_v2','agent_runs','agent_queue','model_slots','outbox_events','v2_rate_limits','question_instances','v2_messages','answer_revisions','memory_items','conversation_summaries','safety_episodes','guidance_versions','action_plans','plan_feedback','memory_derivations','memory_suppressions','deletion_requests','audit_events','agent_run_steps']) {
    await client.query('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "' + schema + '"."' + table + '" TO "' + role + '"');
  }
  await client.query('GRANT SELECT ON TABLE "' + schema + '"."schema_migrations" TO "' + role + '"');
  await client.query('GRANT SELECT, INSERT, DELETE ON TABLE "' + schema + '"."deletion_index" TO "' + role + '"');
  await client.query('REVOKE INSERT, UPDATE, DELETE ON TABLE "' + schema + '"."schema_migrations" FROM "' + role + '"');
  await client.query('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "' + schema + '" TO "' + role + '"');
  await client.query('COMMIT');
  console.log('Runtime database privileges applied.');
} catch(error) { await client.query('ROLLBACK'); throw error; }
finally { await client.end(); }
