import { closeSync, existsSync, mkdirSync, openSync, realpathSync, renameSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
const connection = process.env.HOP_BACKUP_DATABASE_URL || process.env.HOP_MIGRATION_DATABASE_URL;
const state = process.env.HOP_STATE_DIR;
if (!connection || !state) throw new Error('HOP_BACKUP_DATABASE_URL (or HOP_MIGRATION_DATABASE_URL) and HOP_STATE_DIR are required');
const statePath = resolve(state);
if (!existsSync(statePath) || realpathSync(statePath) !== statePath) throw new Error('Use an existing, canonical state directory');
const dir = resolve(statePath, 'backups');
mkdirSync(dir, { recursive: true, mode: 0o700 });
if (realpathSync(dir) !== dir || !dir.startsWith(statePath + sep)) throw new Error('Backup path escapes state directory');
const url = new URL(connection);
if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected PostgreSQL URL');
const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGCONNECT_TIMEOUT: '10', PGOPTIONS: '-c statement_timeout=120000 -c lock_timeout=5000' };
if (url.searchParams.has('sslmode')) env.PGSSLMODE = url.searchParams.get('sslmode');
const name = 'hop-' + new Date().toISOString().replaceAll(':','-').replaceAll('.','-') + '.dump';
const partial = resolve(dir, name + '.partial'), target = resolve(dir,name);
const fd = openSync(partial, 'wx', 0o600);
let result;
try { result = spawnSync(process.env.HOP_PG_DUMP || 'pg_dump', ['--format=custom','--no-owner','--no-acl'], { env, stdio:['ignore', fd, 'pipe'], timeout:150000 }); }
finally { closeSync(fd); }
if (result.status !== 0 || !statSync(partial).size) throw new Error('Backup failed; the incomplete .partial file is retained for inspection');
const check = spawnSync(process.env.HOP_PG_RESTORE || 'pg_restore', ['--list',partial], { env, stdio:['ignore','ignore','pipe'], timeout:30000 });
if (check.status !== 0) throw new Error('Backup archive validation failed; .partial file retained');
renameSync(partial,target);
console.log(JSON.stringify({backup:target,bytes:statSync(target).size,archiveVerified:true,restoreTested:false}));
