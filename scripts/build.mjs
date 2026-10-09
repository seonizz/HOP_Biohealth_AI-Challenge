import { cp, mkdir, mkdtemp, rename, realpath, access, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = await realpath(resolve(root, 'frontend'));
const target = resolve(frontend, 'dist');
const staged = await mkdtemp(resolve(frontend, '.build-'));
for (const name of ['index.html', 'js', 'assets', ...['base', 'start', 'chat', 'result', 'about', 'columns', 'records'].map(x => `css/${x}.css`)]) {
  await mkdir(resolve(staged, name, '..'), { recursive: true });
  await cp(resolve(frontend, name), resolve(staged, name), { recursive: true });
}
const html = await readFile(resolve(staged, 'index.html'), 'utf8');
if (!html.includes('js/backend/model.js') || !html.includes('js/backend/bridge.js') || !html.includes('js/app.js') || html.includes('/src/app.js') || html.includes('restore-bridge.css') || /src=["']js\/core\/mockModel\.js/.test(html)) throw new Error('Deploy the original screen components with the backend adapter');
let exists = false;
try { await access(target); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (exists) {
  if (await realpath(target) !== target) throw new Error('Build output must not be a symlink');
  await rename(target, resolve(frontend, `dist.previous-${Date.now()}`));
}
await rename(staged, target);
console.log('Frontend built: ea9c607 original screens and copy with the backend adapter');
