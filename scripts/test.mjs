import {readdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const files=(await readdir(new URL('../tests/',import.meta.url))).filter(x=>x.endsWith('.test.mjs')).map(x=>'tests/'+x);
const result=spawnSync(process.execPath,['--test',...files],{cwd:root,stdio:'inherit'});
process.exit(result.status??1);
