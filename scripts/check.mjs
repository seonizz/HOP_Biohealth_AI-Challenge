import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
async function check(dir){for(const entry of await readdir(new URL('../'+dir+'/',import.meta.url),{withFileTypes:true})) {
  const path=dir+'/'+entry.name;
  if(entry.isDirectory()){await check(path);continue;}
  if(!/\.(mjs|js)$/.test(entry.name))continue;
  const result=spawnSync(process.execPath,['--check',path],{cwd:root,stdio:'inherit'});
  if(result.status!==0)process.exit(1);
}}
for(const dir of ['frontend/js','frontend/src','scripts','tests'])await check(dir);
console.log('JavaScript syntax checks passed');
