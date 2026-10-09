import { cp, mkdir, mkdtemp, rename, realpath, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const frontend=await realpath(resolve(root,'frontend'));
const target=resolve(frontend,'dist');
// Build into a fresh directory, retaining the previous output for rollback.
const staged=await mkdtemp(resolve(frontend,'.build-'));
for(const name of ['index.html','js','assets',...['base','start','chat','result','about','columns','records'].map(x=>'css/'+x+'.css')]) {
  await mkdir(resolve(staged,name,'..'),{recursive:true});
  await cp(resolve(frontend,name),resolve(staged,name),{recursive:true});
}
let exists=false;try{await access(target);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
if(exists){
  if(await realpath(target)!==target)throw new Error('Build output must not be a symlink');
  await rename(target,resolve(frontend,'dist.previous-'+Date.now()));
}
await rename(staged,target);
console.log('Frontend built: original 30 questions, localStorage, mockModel, and columns');
