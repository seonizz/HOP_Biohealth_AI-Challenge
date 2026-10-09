import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const dir of ['frontend/src','scripts','tests'])for(const f of await readdir(new URL('../'+dir+'/',import.meta.url))) {
  if(!/\.(mjs|js)$/.test(f))continue;
  const result=spawnSync(process.execPath,['--check',dir+'/'+f],{cwd:root,stdio:'inherit'});
  if(result.status!==0)process.exit(1);
}
console.log('JavaScript syntax checks passed');
