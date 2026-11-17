import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';

const script = fileURLToPath(new URL('../scripts/setup.js', import.meta.url));
const syntheticKey = 'synthetic-setup-key-not-a-real-credential';
const local = {
  MODEL_BASE_URL:'http://127.0.0.1:11434/v1', MODEL_API_KEY:'local-ollama', MODEL_NAME:'gemma4:12b',
  MODEL_PROTOCOL:'relationship_agent', MODEL_STATE_MODE:'combined_blocks', MODEL_AGENT_FORMAT:'json_schema',
  MODEL_REASONING_EFFORT:'none', MODEL_STREAM_JSON:'true', MODEL_STREAM_COMPLETE_JSON:'true', MODEL_SCHEMA_STRING_LIMITS:'false',
  MODEL_TIMEOUT_MS:'0', MODEL_DISCOVER_TOKEN_LIMITS:'true', MODEL_SELECTION_ENABLED:'true',
};
const legacy = {
  MODEL_BASE_URL:'http://127.0.0.1:18080/v1',
  MODEL_DOCKER_BASE_URL:'http://host.docker.internal:18080/v1',
  MODEL_API_KEY:syntheticKey,
  MODEL_NAME:'malssi-gemma4-31b-step100',
  MODEL_PROTOCOL:'json_prompt',
  MODEL_TIMEOUT_MS:'0',
};
const v11 = { ...legacy, MODEL_NAME:'malssi-gemma4-31b-v11-epoch3', MODEL_PROTOCOL:'relationship_agent',
  MODEL_AGENT_FORMAT:'prompt', MODEL_REASONING_EFFORT:'omit', MODEL_STATE_MODE:'combined', MODEL_TIMEOUT_MS:'0' };
const modelSettings = env => Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith('MODEL_')));

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'malssi-setup-test-'));
  t.after(() => rmSync(cwd, { recursive:true, force:true }));
  writeFileSync(join(cwd, 'model.key'), syntheticKey + '\n', { mode:0o600 });
  writeFileSync(join(cwd, 'source.env'), 'OPENAI_BASE_URL="http://example.test/v1"\nOPENAI_API_KEY=\'' + syntheticKey + '\'\nOLLAMA_MODEL="synthetic-model"\n', { mode:0o600 });
  return {
    cwd,
    envPath:join(cwd, '.env'),
    read:() => readFileSync(join(cwd, '.env'), 'utf8'),
    run:(args = []) => {
      // No inherited model credentials, NODE_OPTIONS, server, or real .env.
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd, env:{ PATH:dirname(process.execPath) }, encoding:'utf8', timeout:10000,
      });
      assert.equal(result.error, undefined);
      assert.equal((result.stdout + result.stderr).includes(syntheticKey), false);
      return result;
    },
  };
}

test('plain setup creates private defaults and preserves an existing environment byte for byte', t => {
  const f = fixture(t);
  assert.equal(f.run().status, 0);
  const raw = f.read(), env = parseEnv(raw);
  assert.equal(env.PORT, '9000');
  assert.equal(env.SESSION_TTL_DAYS, '30');
  assert.equal(env.DATA_RETENTION_DAYS, '30');
  assert.match(env.POSTGRES_PASSWORD, /^[a-f0-9]{48}$/u);
  assert.equal(Buffer.from(env.CONTENT_KEY, 'base64').length, 32);
  assert.deepEqual(modelSettings(env), local);
  assert.equal(Object.hasOwn(env,'MODEL_DOCKER_BASE_URL'),false);
  assert.equal(statSync(f.envPath).mode & 0o777, 0o600);
  assert.equal(f.run().status, 0);
  assert.equal(f.read(), raw);
});

test('the example and fresh setup agree on usable local model defaults', t=>{
  const f=fixture(t);assert.equal(f.run().status,0);
  const example=parseEnv(readFileSync(new URL('../.env.example',import.meta.url),'utf8'));
  assert.deepEqual(modelSettings(example),local);
});

for (const profileArgs of [[], ['--trained-model-profile', 'legacy']]) {
  test(`trained key keeps legacy settings ${profileArgs.length ? 'with explicit profile' : 'by default'}`, t => {
    const f = fixture(t);
    assert.equal(f.run(['--trained-model-key', 'model.key', ...profileArgs]).status, 0);
    assert.deepEqual(modelSettings(parseEnv(f.read())), legacy);
    assert.equal(readFileSync(join(f.cwd, 'model.key'), 'utf8'), syntheticKey + '\n');
  });
}

test('v11 explicitly selects the live agent configuration and is repeatable', t => {
  const f = fixture(t), args = ['--trained-model-profile', 'v11', '--trained-model-key', 'model.key'];
  assert.equal(f.run(args).status, 0);
  const raw = f.read();
  assert.deepEqual(modelSettings(parseEnv(raw)), v11);
  assert.equal(f.run(args).status, 0);
  assert.equal(f.read(), raw);
  assert.equal(statSync(f.envPath).mode & 0o777, 0o600);
});

test('v11 replaces every stale model setting while retaining unrelated configuration', t => {
  const f = fixture(t);
  const existing = '# invented configuration\nPORT=4321\nCONTENT_KEY=synthetic-content-key\nDATA_RETENTION_DAYS=14\n';
  writeFileSync(f.envPath, existing + Object.keys(v11).map(key => `${key}=stale`).join('\n') + '\nMODEL_NAME=duplicate\n', { mode:0o644 });
  assert.equal(f.run(['--trained-model-key', 'model.key', '--trained-model-profile', 'v11']).status, 0);
  const raw = f.read();
  assert.equal(raw.startsWith(existing), true);
  assert.deepEqual(modelSettings(parseEnv(raw)), v11);
  for (const key of Object.keys(v11)) assert.equal(raw.split('\n').filter(line => line.startsWith(key + '=')).length, 1);
  assert.equal(statSync(f.envPath).mode & 0o777, 0o600);
});

for(const profileArgs of [[],['--trained-model-profile','v11']])
test('explicit trained profiles replace local defaults without leaking streaming flags: '+(profileArgs.length?'v11':'legacy'),t=>{
  const f=fixture(t);assert.equal(f.run().status,0);
  const unrelated='MODEL_REVIEW_BASE_URL=http://review.example/v1\nMODEL_REVIEW_STREAM_COMPLETE_JSON=false\nREFERRAL_GUIDANCE_ENABLED=false\n';
  writeFileSync(f.envPath,f.read()+unrelated);
  assert.equal(f.run(['--trained-model-key','model.key',...profileArgs]).status,0);
  const env=parseEnv(f.read()),{MODEL_REVIEW_BASE_URL,MODEL_REVIEW_STREAM_COMPLETE_JSON,...primary}=modelSettings(env);
  assert.deepEqual(primary,profileArgs.length?v11:legacy);
  assert.equal(MODEL_REVIEW_BASE_URL,'http://review.example/v1');
  assert.equal(MODEL_REVIEW_STREAM_COMPLETE_JSON,'false');
  assert.equal(env.REFERRAL_GUIDANCE_ENABLED,'false');
});

test('model-env import retains quoted-value and default-model compatibility', t => {
  const f = fixture(t), sourcePath = join(f.cwd, 'source.env');
  assert.equal(f.run().status, 0);
  const source = readFileSync(sourcePath, 'utf8');
  assert.equal(f.run(['--model-env', 'source.env']).status, 0);
  const expected = { MODEL_BASE_URL:'http://example.test/v1', MODEL_DOCKER_BASE_URL:'http://example.test/v1',
    MODEL_API_KEY:syntheticKey, MODEL_NAME:'synthetic-model', MODEL_TIMEOUT_MS:'0', MODEL_PROTOCOL:'json_schema' };
  assert.deepEqual(modelSettings(parseEnv(f.read())), expected);
  assert.equal(readFileSync(sourcePath, 'utf8'), source);
  writeFileSync(sourcePath, source.split('\n').filter(line => !line.startsWith('OLLAMA_MODEL=')).join('\n'));
  assert.equal(f.run(['--model-env', 'source.env']).status, 0);
  assert.deepEqual(modelSettings(parseEnv(f.read())), { ...expected, MODEL_NAME:'gemma4:12b' });
});

test('model-env import preserves a quoted hash in credentials and standard dotenv syntax',t=>{
  const f=fixture(t),key='synthetic#quoted-key';
  writeFileSync(join(f.cwd,'source.env'),`export OPENAI_BASE_URL="http://localhost:11434/v1" # local API\nOPENAI_API_KEY='${key}'\nOLLAMA_MODEL=synthetic-model\n`);
  const result=f.run(['--model-env','source.env']);assert.equal(result.status,0);
  assert.equal(parseEnv(f.read()).MODEL_API_KEY,key);
  assert.doesNotMatch(result.stdout+result.stderr,/synthetic#quoted-key/);
  assert.equal(f.run(['--model-env','source.env']).status,0);
  assert.equal(parseEnv(f.read()).MODEL_API_KEY,key);
});

for(const [label,key,quote]of [
  ['literal dollar variable','synthetic-$MODEL_NAME',"'"],
  ['apostrophe and hash',"synthetic'apostrophe#key",'"'],
  ['literal backtick','synthetic`key',"'"],
])test('selected model credentials use portable dotenv quoting: '+label,t=>{
  const f=fixture(t);writeFileSync(join(f.cwd,'model.key'),key+'\n',{mode:0o600});
  const result=f.run(['--trained-model-key','model.key']);assert.equal(result.status,0);
  assert.equal(parseEnv(f.read()).MODEL_API_KEY,key);
  assert.equal(f.read().split('\n').find(line=>line.startsWith('MODEL_API_KEY='))[14],quote);
  assert.ok(!(result.stdout+result.stderr).includes(key));
});

for(const [source,native,docker]of [
  ['http://localhost:11434/','http://localhost:11434/v1','http://host.docker.internal:11434/v1'],
  ['http://127.8.0.1:18080/v1','http://127.8.0.1:18080/v1','http://host.docker.internal:18080/v1'],
  ['http://[::1]:11434/v1/chat/completions','http://[::1]:11434/v1','http://host.docker.internal:11434/v1'],
  ['http://192.168.1.20:11434/v1','http://192.168.1.20:11434/v1','http://192.168.1.20:11434/v1'],
])test('model-env import selects matching native and Docker addresses: '+source,t=>{
  const f=fixture(t);assert.equal(f.run().status,0);
  writeFileSync(join(f.cwd,'source.env'),`OPENAI_BASE_URL=${source}\nOPENAI_API_KEY=${syntheticKey}\nOLLAMA_MODEL=synthetic-model\n`);
  assert.equal(f.run(['--model-env','source.env']).status,0);
  assert.deepEqual(modelSettings(parseEnv(f.read())),{
    MODEL_BASE_URL:native,MODEL_DOCKER_BASE_URL:docker,MODEL_API_KEY:syntheticKey,
    MODEL_NAME:'synthetic-model',MODEL_TIMEOUT_MS:'0',MODEL_PROTOCOL:'json_schema',
  });
});

const malformed = [
  ['unknown option', ['--unknown', 'value']],
  ['positional argument', ['v11']],
  ['missing key path', ['--trained-model-key']],
  ['missing source path', ['--model-env']],
  ['missing profile', ['--trained-model-profile']],
  ['flag instead of value', ['--trained-model-key', '--trained-model-profile', 'v11']],
  ['empty value', ['--trained-model-key', '']],
  ['duplicate key', ['--trained-model-key', 'model.key', '--trained-model-key', 'model.key']],
  ['duplicate source', ['--model-env', 'source.env', '--model-env', 'source.env']],
  ['duplicate profile', ['--trained-model-key', 'model.key', '--trained-model-profile', 'v11', '--trained-model-profile', 'legacy']],
  ['conflicting sources', ['--model-env', 'source.env', '--trained-model-key', 'model.key']],
  ['profile without key', ['--trained-model-profile', 'v11']],
  ['profile with imported env', ['--model-env', 'source.env', '--trained-model-profile', 'v11']],
  ['unknown profile', ['--trained-model-key', 'model.key', '--trained-model-profile', 'v12']],
];
for (const [label, args] of malformed) {
  test(`invalid setup arguments leave the destination untouched: ${label}`, t => {
    const f = fixture(t);
    assert.notEqual(f.run(args).status, 0);
    assert.equal(existsSync(f.envPath), false);
    const existing = '# preserved\nPORT=1234\nCONTENT_KEY=synthetic-existing-key\n';
    writeFileSync(f.envPath, existing, { mode:0o640 });
    assert.notEqual(f.run(args).status, 0);
    assert.equal(f.read(), existing);
    assert.equal(statSync(f.envPath).mode & 0o777, 0o640);
  });
}

for (const [label, args, file, contents] of [
  ['empty key', ['--trained-model-key', 'model.key'], 'model.key', ' \n'],
  ['multiline key', ['--trained-model-key', 'model.key'], 'model.key', syntheticKey + '\nUNEXPECTED=value'],
  ['unrepresentable env key', ['--trained-model-key','model.key'], 'model.key', 'synthetic\'"`#key\n'],
  ['interpolated quoted key', ['--trained-model-key','model.key'], 'model.key', "synthetic'$MODEL_NAME#key\n"],
  ['escaped closing quote key', ['--trained-model-key','model.key'], 'model.key', 'synthetic\\\n'],
  ['missing imported key', ['--model-env', 'source.env'], 'source.env', 'OPENAI_BASE_URL=http://example.test/v1\n'],
  ['missing imported URL', ['--model-env', 'source.env'], 'source.env', 'OPENAI_API_KEY=' + syntheticKey + '\n'],
  ...['file:///private/model','http://user:synthetic-url-secret@localhost:11434/v1','http://localhost:11434/v1?key=synthetic-url-secret',
    'http://localhost:11434/v1#synthetic-url-secret'].map(url=>['invalid imported URL '+url,['--model-env','source.env'],'source.env',
      `OPENAI_BASE_URL="${url}"\nOPENAI_API_KEY=${syntheticKey}\n`]),
  ['missing file', ['--trained-model-key', 'absent.key'], null, null],
]) {
  test(`invalid model input leaves the destination untouched: ${label}`, t => {
    const f = fixture(t);
    if (file) writeFileSync(join(f.cwd, file), contents);
    const first=f.run(args);assert.notEqual(first.status, 0);
    assert.doesNotMatch(first.stdout+first.stderr,/synthetic-url-secret/);
    assert.equal(existsSync(f.envPath), false);
    const existing = 'PORT=1234\nMODEL_NAME=synthetic-existing-model\n';
    writeFileSync(f.envPath, existing, { mode:0o600 });
    assert.notEqual(f.run(args).status, 0);
    assert.equal(f.read(), existing);
  });
}
