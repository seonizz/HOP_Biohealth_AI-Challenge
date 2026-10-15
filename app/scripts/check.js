import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const files = directory => readdirSync(directory, { withFileTypes:true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
for (const file of [...files('src'), ...files('public/js'), ...files('tests'), ...files('scripts')].filter(file => file.endsWith('.js'))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio:'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
JSON.parse(readFileSync('package.json', 'utf8'));
JSON.parse(readFileSync('docs/openapi.json', 'utf8'));
console.log('JavaScript syntax and JSON checks passed');
