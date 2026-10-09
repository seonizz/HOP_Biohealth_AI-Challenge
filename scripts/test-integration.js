import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('Set TEST_DATABASE_URL or run with the generated local .env');
const files = readdirSync('tests').filter(name => name.endsWith('.test.js')).map(name => 'tests/' + name);
const result = spawnSync(process.execPath, ['--test', ...files], { stdio:'inherit', env:{ ...process.env, TEST_DATABASE_URL:databaseUrl } });
process.exit(result.status || 0);
