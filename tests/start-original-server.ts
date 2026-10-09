import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createApp} from '../backend/src/server.ts';
import {getSettings} from '../backend/src/config.ts';
import {fixture,databaseUrl} from '../backend/tests/v2-fixture.ts';
if(!databaseUrl)throw new Error('Use the isolated HOP_TEST_DATABASE_URL');
const cleanup:Array<()=>Promise<void>>=[];
const f=await fixture({after:(fn:()=>Promise<void>)=>cleanup.push(fn)});
const app=await createApp(getSettings({databaseUrl:f.runtimeUrl,databaseSchema:f.schema,migrateOnStart:false,port:18091,publicOrigin:'http://127.0.0.1:18090',contentKey:f.key,v2Enabled:true,v2AllowDraft:true,v2ModelEnabled:false,demoEnabled:true,allowRegistration:false,originalFrontendModelMode:'prototype'}));
await new Promise<void>(resolve=>app.server.listen(18091,'127.0.0.1',resolve));
const web=spawn(process.execPath,['scripts/serve-original-ui.mjs'],{stdio:'inherit',env:{...process.env,HOP_WEB_PORT:'18090',HOP_API_PORT:'18091'}});
let stopping=false;
async function stop(){
  if(stopping)return;stopping=true;web.kill();
  await new Promise<void>(resolve=>app.server.close(()=>resolve()));await app.store.close();
  for(const close of cleanup)await close();
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>stop().then(()=>process.exit(0)));
console.log('Original UI test API ready; isolated PostgreSQL schema; prototype mode; no live inference.');
