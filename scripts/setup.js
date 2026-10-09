import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, chmodSync } from 'node:fs';
const password = randomBytes(24).toString('hex');
const key = randomBytes(32).toString('base64');
const env = `HOST=127.0.0.1\nPORT=9000\nPUBLIC_ORIGIN=http://127.0.0.1:9000\nPOSTGRES_PORT=5433\nPOSTGRES_PASSWORD=${password}\nDATABASE_URL=postgresql://malssi:${password}@127.0.0.1:5433/malssi\nCONTENT_KEY=${key}\nSESSION_TTL_DAYS=30\n`;
try {
  writeFileSync('.env', env, { flag:'wx', mode:0o600 });
  console.log('.env 생성 완료. docker compose up -d --build로 시작하세요.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('기존 .env를 유지합니다.');
}
const modelFlag = process.argv.indexOf('--model-env');
if (modelFlag !== -1) {
  const source = readFileSync(process.argv[modelFlag + 1], 'utf8');
  const variables = Object.fromEntries(source.split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const i = line.indexOf('=');
    const raw = line.slice(i + 1).trim();
    return [line.slice(0, i), /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw];
  }));
  const selected = {
    MODEL_BASE_URL: variables.OPENAI_BASE_URL,
    MODEL_API_KEY: variables.OPENAI_API_KEY,
    MODEL_NAME: variables.OLLAMA_MODEL || 'gemma4:12b',
    MODEL_TIMEOUT_MS: '180000'
  };
  if (!selected.MODEL_BASE_URL || !selected.MODEL_API_KEY || Object.values(selected).some(v => /[\r\n]/.test(v))) throw new Error('Invalid model environment file');
  let env = readFileSync('.env', 'utf8');
  env = env.split(/\r?\n/).filter(line => !Object.keys(selected).some(key => line.startsWith(key + '='))).join('\n').trimEnd();
  writeFileSync('.env', env + '\n' + Object.entries(selected).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode:0o600 });
  chmodSync('.env', 0o600);
  console.log('모델 설정을 서버용 .env에 반영했습니다. 인증 키는 출력하지 않습니다.');
}
