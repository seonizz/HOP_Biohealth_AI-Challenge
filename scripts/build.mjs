import { cp, mkdir, mkdtemp, rename, realpath, access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = await realpath(resolve(root, 'frontend'));
const target = resolve(frontend, 'dist');
const staged = await mkdtemp(resolve(frontend, '.build-'));
for (const name of ['index.html', 'src', 'assets', ...['base', 'start', 'chat', 'result', 'about', 'columns', 'records', 'app', 'restore-bridge'].map(x => `css/${x}.css`)]) {
  await mkdir(resolve(staged, name, '..'), { recursive: true });
  await cp(resolve(frontend, name), resolve(staged, name), { recursive: true });
}
await cp(resolve(root, 'backend/openapi-model.json'), resolve(staged, 'openapi-model.json'));
const html = await readFile(resolve(staged, 'index.html'), 'utf8');
if (!html.includes('/src/app.js') || html.includes('mockModel.js') || html.includes('js/core/store.js')) throw new Error('The deployed HTML must use the backend API client');
let exists = false;
try { await access(target); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (exists) {
  if (await realpath(target) !== target) throw new Error('Build output must not be a symlink');
  await rename(target, resolve(frontend, `dist.previous-${Date.now()}`));
}
await rename(staged, target);
console.log('Frontend built: original Malssi visual system with same-origin backend API');
