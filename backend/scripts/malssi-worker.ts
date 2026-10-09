import { Store } from '../src/storage.ts';
import { getSettings } from '../src/config.ts';
import { ContentCipher } from '../src/v2/crypto.ts';
import { V2Database } from '../src/v2/db.ts';
import { MalssiService } from '../src/v2/service.ts';
import { AgentWorker } from '../src/v2/worker.ts';
import { LocalAgentModel,DualRoleModel } from '../src/v2/model.ts';
import { setTimeout as delay } from 'node:timers/promises';

const settings=getSettings();
if(!settings.v2Enabled || !settings.v2ModelEnabled)throw new Error('Explicit HOP_V2_ENABLED and HOP_V2_MODEL_ENABLED are required');
const store=await Store.connect(settings.databaseUrl,{schema:settings.databaseSchema,migrate:false});
const db=new V2Database(store.pool,new ContentCipher(settings.contentKey));await db.assertRuntimeRole();
const service=new MalssiService(db,{allowDraft:settings.v2AllowDraft,modelEnabled:true,dualEnabled:settings.dualEnabled});
if(settings.dualEnabled&&(!process.env.HOP_DUAL_MODEL_ID||!/^([a-f0-9]{64})$/i.test(process.env.HOP_DUAL_MODEL_SHA256||'')))throw new Error('HOP_DUAL_MODEL_ID and verified HOP_DUAL_MODEL_SHA256 are required');
const dualUrl=process.env.HOP_DUAL_MODEL_URL||'http://127.0.0.1:18021/v1';
const model=settings.dualEnabled
  ?new DualRoleModel(process.env.HOP_DUAL_EVALUATOR_URL||dualUrl,process.env.HOP_DUAL_RESPONDER_URL||dualUrl,process.env.HOP_DUAL_MODEL_ID!,process.env.HOP_DUAL_API_KEY||'',process.env.HOP_DUAL_PROMPT_PROFILE||'test',process.env.HOP_DUAL_PROMPT_VERSION||'v1')
  :new LocalAgentModel(settings.llmBaseUrl,settings.llmModel,settings.llmApiKey,(process.env.HOP_MODEL_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean));
const worker=new AgentWorker(db,service,model,Number(process.env.HOP_MODEL_CONTEXT_SIZE||16384));
let stop=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stop=true;});
try{while(!stop){try{if(!await worker.tick())await delay(1000);}catch{console.error('malssi_worker_iteration_failed');await delay(2000);}}}finally{await store.close();}
