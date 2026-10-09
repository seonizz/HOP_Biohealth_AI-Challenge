import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const target=resolve(root,'frontend/dist');
if(!target.startsWith(resolve(root,'frontend')+'/') && !target.startsWith(resolve(root,'frontend')+'\\'))throw new Error('Invalid build directory');
await rm(target,{recursive:true,force:true});
await mkdir(target,{recursive:true});
for(const name of ['index.html','src','assets','css/base.css','css/start.css','css/app.css']) {
  await mkdir(resolve(target,name,'..'),{recursive:true});
  await cp(resolve(root,'frontend',name),resolve(target,name),{recursive:true});
}
const html=await readFile(resolve(target,'index.html'),'utf8');
if(html.includes('mockModel')||html.includes('js/core/store'))throw new Error('Prototype must not ship');
console.log('Frontend built: frontend/dist (same-origin /api/v2)');
