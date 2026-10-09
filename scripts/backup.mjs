import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,link,rm} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const output=resolve(root,process.argv[2]||`.runtime/backups/malssi-${new Date().toISOString().replaceAll(/[:.]/g,'-')}.dump`);
await mkdir(dirname(output),{recursive:true});
const partial=output+'.partial';
const stream=createWriteStream(partial,{flags:'wx',mode:0o600});
const processDb=spawn('docker',['compose','exec','-T','postgres','pg_dump','-U','hop_admin','-d','hop','--format=custom','--exclude-table-data=public.temporary_content_keys'],{cwd:root,stdio:['ignore','pipe','pipe']});
const complete=new Promise((yes,no)=>{processDb.once('error',no);processDb.once('exit',code=>code===0?yes():no(new Error('pg_dump failed; inspect database availability.')));});
processDb.stderr.resume();
try{await Promise.all([pipeline(processDb.stdout,stream),complete]);await link(partial,output);await rm(partial);console.log('Backup created: '+output);console.log('Preserve the encryption key separately. Export the deletion ledger independently before restoration.');}catch(error){processDb.kill();await rm(partial,{force:true});throw error;}
