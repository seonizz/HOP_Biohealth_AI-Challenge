import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { configuredModelGateway, resolveModelBaseUrl } from '../src/model-config.js';
const localModelDefaults = {
  MODEL_BASE_URL:'http://127.0.0.1:11434/v1',
  MODEL_API_KEY:'local-ollama',
  MODEL_NAME:'gemma4:12b',
  MODEL_PROTOCOL:'relationship_agent',
  MODEL_STATE_MODE:'combined_blocks',
  MODEL_AGENT_FORMAT:'json_schema',
  MODEL_REASONING_EFFORT:'none',
  MODEL_STREAM_JSON:'true',
  MODEL_STREAM_COMPLETE_JSON:'true',
  MODEL_SCHEMA_STRING_LIMITS:'false',
  MODEL_TIMEOUT_MS:'0',
  MODEL_DISCOVER_TOKEN_LIMITS:'true',
  MODEL_SELECTION_ENABLED:'true',
};
const options = Object.create(null);
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const flag = args[i], value = args[i + 1];
  if (!['--model-env', '--trained-model-key', '--trained-model-profile'].includes(flag)) throw new Error('Unknown setup option');
  if (Object.hasOwn(options, flag)) throw new Error('Duplicate setup option');
  if (!value?.trim() || value.startsWith('--')) throw new Error('Missing setup option value');
  options[flag] = value;
}
if (options['--model-env'] && options['--trained-model-key']) throw new Error('Select one model configuration source');
if (options['--trained-model-profile'] && !options['--trained-model-key']) throw new Error('--trained-model-profile requires --trained-model-key');
const profile = options['--trained-model-profile'] || 'legacy';
if (!['legacy', 'v11'].includes(profile)) throw new Error('Unknown trained model profile (expected legacy or v11)');

function modelLines(selected) {
  return Object.entries(selected).map(([key,value])=>{
    // Single quotes keep Compose from interpolating dollar signs. Double
    // quotes are portable only without interpolation or escape sequences.
    // A trailing backslash can escape Compose's closing single quote.
    const candidates=[];
    if(!value.includes("'")&&!value.endsWith('\\'))candidates.push("'"+value+"'");
    if(!/["\\$]/u.test(value))candidates.push('"'+value+'"');
    const encoded=candidates.find(candidate=>parseEnv(key+'='+candidate)[key]===value);
    if(encoded===undefined)throw new Error('Invalid model configuration');
    return key+'='+encoded;
  }).join('\n');
}

function writeModel(selected,lines) {
  let current = readFileSync('.env', 'utf8');
  const replaced = new Set([...Object.keys(localModelDefaults), ...Object.keys(selected)]);
  current = current.split(/\r?\n/).filter(line => ![...replaced].some(key => line.startsWith(key + '='))).join('\n').trimEnd();
  writeFileSync('.env', current + '\n' + lines + '\n', { mode:0o600 });
  chmodSync('.env', 0o600);
  console.log('모델 설정을 서버용 .env에 반영했습니다. 인증 키는 출력하지 않습니다.');
}
let selected,selectedLines;
if (options['--model-env']) {
  const source = readFileSync(options['--model-env'], 'utf8');
  const variables = parseEnv(source);
  let baseUrl, dockerBaseUrl;
  try {
    baseUrl=resolveModelBaseUrl(variables.OPENAI_BASE_URL);
    dockerBaseUrl=resolveModelBaseUrl(variables.OPENAI_BASE_URL, {container:true});
  } catch { throw new Error('Invalid model configuration'); }
  selected = {
    MODEL_BASE_URL: baseUrl,
    MODEL_API_KEY: variables.OPENAI_API_KEY,
    MODEL_NAME: variables.OLLAMA_MODEL || 'gemma4:12b',
    MODEL_TIMEOUT_MS: '0',
    MODEL_PROTOCOL:'json_schema',
    MODEL_DOCKER_BASE_URL: dockerBaseUrl,
  };
}
if (options['--trained-model-key']) {
  const apiKey = readFileSync(options['--trained-model-key'], 'utf8').trim();
  selected = {
    MODEL_BASE_URL:'http://127.0.0.1:18080/v1',
    MODEL_DOCKER_BASE_URL:'http://host.docker.internal:18080/v1',
    MODEL_API_KEY:apiKey,
    MODEL_NAME:'malssi-gemma4-31b-step100',
    MODEL_PROTOCOL:'json_prompt',
    MODEL_TIMEOUT_MS:'0',
    ...(profile === 'v11' ? {
      MODEL_NAME:'malssi-gemma4-31b-v11-epoch3',
      MODEL_PROTOCOL:'relationship_agent',
      MODEL_AGENT_FORMAT:'prompt',
      MODEL_REASONING_EFFORT:'omit',
      MODEL_STATE_MODE:'combined',
      MODEL_TIMEOUT_MS:'0',
    } : {}),
  };
}
if (selected) {
  if (Object.values(selected).some(value => typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value))) throw new Error('Invalid model configuration');
  // Share runtime validation without making a model request or touching .env.
  try { configuredModelGateway({env:selected}); }
  catch { throw new Error('Invalid model configuration'); }
  selectedLines=modelLines(selected);
}

// Validate options and model input before creating or changing the destination.
const password = randomBytes(24).toString('hex');
const key = randomBytes(32).toString('base64');
const env = `HOST=127.0.0.1\nPORT=9000\nPUBLIC_ORIGIN=http://127.0.0.1:9000\nPOSTGRES_PORT=5433\nPOSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://malssi:${password}@127.0.0.1:5433/malssi\nCONTENT_KEY=${key}\nSESSION_TTL_DAYS=30\nDATA_RETENTION_DAYS=30\n`+
  (selected ? '' : Object.entries(localModelDefaults).map(([name,value])=>`${name}=${value}\n`).join(''));
try {
  writeFileSync('.env', env, { flag:'wx', mode:0o600 });
  console.log('.env 생성 완료. docker compose up -d --build로 시작하세요.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('기존 .env를 유지합니다.');
}
if (selected) writeModel(selected,selectedLines);
