import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const backend = fileURLToPath(new URL('../', import.meta.url));
const file = resolve(backend, '../.runtime/vercel-secrets.json');
const ownerUrl = process.env.HOP_MIGRATION_DATABASE_URL;
if (!ownerUrl || !/^postgres(?:ql)?:\/\//.test(ownerUrl)) throw new Error('HOP_MIGRATION_DATABASE_URL must be the Neon owner connection URL');
const owner = new URL(ownerUrl);
if (!['localhost', '127.0.0.1', '::1'].includes(owner.hostname) && !['require', 'verify-ca', 'verify-full'].includes(owner.searchParams.get('sslmode'))) throw new Error('Remote PostgreSQL must require TLS');
let saved = {};
try { saved = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const runtime = new URL(ownerUrl);
runtime.username = 'hop_app';
runtime.password = saved.DATABASE_URL ? new URL(saved.DATABASE_URL).password : randomBytes(32).toString('base64url');
const secrets = {
  DATABASE_URL: runtime.toString(),
  HOP_CONTENT_KEY: saved.HOP_CONTENT_KEY || randomBytes(32).toString('base64'),
  CRON_SECRET: saved.CRON_SECRET || randomBytes(32).toString('base64url'),
};
const client = new pg.Client({ connectionString: ownerUrl, connectionTimeoutMillis: 10000 });
await client.connect();
try {
  const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname='hop_app'");
  // PostgreSQL role DDL does not support a bind parameter for PASSWORD.
  const quoted = await client.query('SELECT quote_literal($1) AS password', [runtime.password]);
  const command = role.rowCount ? 'ALTER ROLE hop_app WITH' : 'CREATE ROLE hop_app';
  await client.query(`${command} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT PASSWORD ${quoted.rows[0].password}`);
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
} finally { await client.end(); }

for (const script of ['migrate.ts', 'grant-runtime.ts']) {
  const result = spawnSync(process.execPath, [`scripts/${script}`], {
    cwd: backend,
    env: { ...process.env, HOP_MIGRATION_DATABASE_URL: ownerUrl, HOP_RUNTIME_ROLE: 'hop_app' },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`${script} failed`);
}
const check = new pg.Client({ connectionString: secrets.DATABASE_URL, connectionTimeoutMillis: 10000 });
await check.connect();
try {
  const status = await check.query("SELECT current_user, rolsuper, rolbypassrls, EXISTS(SELECT 1 FROM pg_class WHERE oid='v2_projects'::regclass AND pg_get_userbyid(relowner)=current_user) AS owns_table FROM pg_roles WHERE rolname=current_user");
  if (status.rows[0].current_user !== 'hop_app' || status.rows[0].rolsuper || status.rows[0].rolbypassrls || status.rows[0].owns_table) throw new Error('Runtime role is not RLS-safe');
} finally { await check.end(); }
await mkdir(resolve(backend, '../.runtime'), { recursive: true });
await writeFile(file, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600, flag: 'w' });
console.log('Neon migration and runtime role verified. Vercel secrets saved to .runtime/vercel-secrets.json (never commit this file).');
