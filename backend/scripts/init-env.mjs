import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--origin') throw new Error('Usage: node scripts/init-env.mjs --origin https://api.example.com');
const origin = new URL(args[1]);
if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== args[1] || origin.username || origin.password) throw new Error('Use an exact HTTP(S) origin without path or credentials');
const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
if (!local && origin.protocol !== 'https:') throw new Error('A public origin requires HTTPS');
const dest = resolve(root, '.env');
if (existsSync(dest)) throw new Error('.env already exists; it was not changed');
const state = resolve(dirname(dirname(root)), 'hop-runtime');
const admin = randomBytes(32).toString('hex'), migrator = randomBytes(32).toString('hex'), app = randomBytes(32).toString('hex');
const values = {
  HOP_STATE_DIR: state, HOP_DB_ADMIN_PASSWORD: admin, HOP_DB_MIGRATOR_PASSWORD: migrator, HOP_DB_APP_PASSWORD: app,
  DATABASE_URL: 'postgresql://hop_app:' + app + '@127.0.0.1:5433/hop',
  HOP_MIGRATION_DATABASE_URL: 'postgresql://hop_migrator:' + migrator + '@127.0.0.1:5433/hop',
  HOP_DATABASE_SCHEMA: 'public', HOP_RUNTIME_ROLE: 'hop_app', HOP_MIGRATE_ON_START: 'false',
  HOP_HOST: '127.0.0.1', HOP_PORT: '9000', HOP_PUBLIC_ORIGIN: origin.origin,
  HOP_COOKIE_SECURE: String(origin.protocol === 'https:'), HOP_COOKIE_SAME_SITE: 'strict',
  HOP_CORS_ORIGINS: '', HOP_TRUST_PROXY: 'true', HOP_ALLOW_REGISTRATION: 'false',
  HOP_INVITE_CODE: randomBytes(24).toString('hex'), HOP_MODEL_MODE: 'local', HOP_LLM_BACKEND: 'openai',
  HOP_LLM_BASE_URL: 'http://127.0.0.1:8001/v1', HOP_LLM_MODEL: 'qwen3.8-27b', HOP_LLM_API_KEY: '',
  HOP_LLM_TIMEOUT_MS: '180000', HOP_TITLE_BASE_URL: '', HOP_TITLE_MODEL: '',
  HOP_KNOWLEDGE: resolve(state, 'knowledge/knowledge.jsonl'), HOP_REQUIRE_KNOWLEDGE: 'true',
  HOP_DOMAIN: origin.host,
};
writeFileSync(dest, Object.entries(values).map(([key,value]) => key + '=' + JSON.stringify(value)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
console.log('Created .env with private permissions. Configure PostgreSQL, model access and the knowledge file before starting.');
