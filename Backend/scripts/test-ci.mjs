import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
if (!process.env.HOP_TEST_DATABASE_URL) {
  console.error('HOP_TEST_DATABASE_URL is required; refusing to skip PostgreSQL integration tests.');
  process.exit(1);
}
const tests = readdirSync(new URL('../tests/', import.meta.url)).filter(name=>name.endsWith('.test.ts')).map(name=>'tests/'+name).sort();
const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit', cwd: new URL('../', import.meta.url), env: process.env });
process.exit(result.status ?? 1);
