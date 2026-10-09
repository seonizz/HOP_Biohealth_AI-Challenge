// Prepare an isolated development profile on the documented server.
// This does not migrate a database, start a service, or print secret values.
import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';

const [stateArgument, schema] = process.argv.slice(2);
const boundary = '/home/slim/choieram/ys';
if (process.platform !== 'linux' || !stateArgument || !/^malssi_handoff_[a-z0-9_]{1,40}$/.test(schema || '')) {
  throw new Error('Usage on the designated server: node scripts/prepare-handoff-env.mjs NEW_STATE_DIRECTORY malssi_handoff_UNIQUE_NAME');
}
const state = resolve(stateArgument);
const parent = realpathSync(dirname(state));
if (parent !== boundary || !/^[a-zA-Z0-9_-]+$/.test(basename(state)) || existsSync(state)) {
  throw new Error('Use a new direct child directory of /home/slim/choieram/ys; existing state is never overwritten');
}
const runtime = parseEnv(readFileSync(boundary + '/hop_node_20261009/app/.env', 'utf8'));
const migration = parseEnv(readFileSync(boundary + '/hop_node_20261009/secrets/migration.env', 'utf8'));
const runtimeUrl = runtime.DATABASE_URL || runtime.HOP_DATABASE_URL;
const migrationUrl = migration.HOP_MIGRATION_DATABASE_URL || migration.DATABASE_URL;
if (!runtimeUrl || !migrationUrl) throw new Error('Existing database connection configuration is missing');
const app = new URL(runtimeUrl), admin = new URL(migrationUrl);
if (![app, admin].every(url => ['postgres:', 'postgresql:'].includes(url.protocol) && ['127.0.0.1', 'localhost'].includes(url.hostname)) || app.host !== admin.host || app.pathname !== admin.pathname) {
  throw new Error('Expected matching local database connections');
}
const role = decodeURIComponent(app.username);
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(role)) throw new Error('Unsupported runtime role identifier');
const serving = boundary + '/hop-serving';
const modelKeyFile = serving + '/secrets/model-api-key';
const modelKey = existsSync(modelKeyFile) ? readFileSync(modelKeyFile, 'utf8').trim() : '';
const common = { HOP_DATABASE_SCHEMA: schema, HOP_STATE_DIR: state };
const profiles = {
  'runtime.env': {
    ...common,
    DATABASE_URL: runtimeUrl,
    HOP_MIGRATE_ON_START: 'false', HOP_RESTORE_PENDING: 'false',
    HOP_HOST: '127.0.0.1', HOP_PORT: '19010', HOP_PUBLIC_ORIGIN: 'http://127.0.0.1:19010',
    HOP_COOKIE_SECURE: 'false', HOP_COOKIE_SAME_SITE: 'strict', HOP_TRUST_PROXY: 'false', HOP_CORS_ORIGINS: '',
    HOP_ALLOW_REGISTRATION: 'true', HOP_INVITE_CODE: randomBytes(24).toString('hex'),
    HOP_CONTENT_KEY: randomBytes(32).toString('base64'),
    HOP_V2_ENABLED: 'true', HOP_V2_ALLOW_DRAFT: 'true', HOP_V2_MODEL_ENABLED: 'false',
    HOP_REQUIRE_KNOWLEDGE: 'false', HOP_KNOWLEDGE: state + '/approved-knowledge.jsonl',
    HOP_MODEL_MODE: 'local', HOP_LLM_BACKEND: 'openai', HOP_LLM_BASE_URL: 'http://127.0.0.1:18011/v1',
    HOP_LLM_MODEL: 'malssi-local', HOP_LLM_API_KEY: modelKey, HOP_MODEL_CONTEXT_SIZE: '16384',
  },
  'migration.env': { ...common, HOP_MIGRATION_DATABASE_URL: migrationUrl, HOP_RUNTIME_ROLE: role },
  'model.env': {
    HOP_STATE_DIR: state,
    HOP_MODEL_BINARY: serving + '/runtime/llama-b11429-sm89-nocompress/bin/llama-server',
    HOP_MODEL_WEIGHTS: serving + '/weights/Qwen3.8-27B-Q4_K_M.gguf',
    HOP_MODEL_KEY_FILE: modelKeyFile,
    HOP_MODEL_LIBRARY_PATH: serving + '/runtime/llama-b11429-sm89-nocompress/bin:' + serving + '/runtime/cuda-12.8.1-compatible/lib',
    HOP_MODEL_PORT: '18011', HOP_LLM_MODEL: 'malssi-local', HOP_MODEL_CONTEXT_SIZE: '16384',
  },
};
// Single-quoted dotenv values preserve $, # and quotes in URL-encoded credentials.
function envLine(key, value) {
  if (/[\r\n']/.test(value)) throw new Error('Configuration contains an unsupported dotenv character');
  return key + "='" + value + "'";
}
const serialized = Object.fromEntries(Object.entries(profiles).map(([name, values]) => [name, Object.entries(values).map(([key, value]) => envLine(key, value)).join('\n') + '\n']));
mkdirSync(state, { mode: 0o700 });
if (realpathSync(state) !== state) throw new Error('State directory resolved unexpectedly');
for (const [name, content] of Object.entries(serialized)) writeFileSync(state + '/' + name, content, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ prepared: true, state_directory: state, database_schema: schema, profiles: Object.keys(profiles), services_started: false, database_changed: false }));
