import { Store } from '../src/storage.ts';
import { getSettings } from '../src/config.ts';
import { ContentCipher } from '../src/v2/crypto.ts';
import { V2Database } from '../src/v2/db.ts';
import { MalssiService } from '../src/v2/service.ts';
import { AgentWorker } from '../src/v2/worker.ts';
import { LocalAgentModel,DualRoleModel } from '../src/v2/model.ts';
import {ModelApiClient} from '../src/v2/model-api.ts';
import {dualModelSettings} from '../src/v2/dual-config.ts';
import { setTimeout as delay } from 'node:timers/promises';

const settings=getSettings();
if(!settings.v2Enabled || !settings.v2ModelEnabled)throw new Error('Explicit HOP_V2_ENABLED and HOP_V2_MODEL_ENABLED are required');
const store=await Store.connect(settings.databaseUrl,{schema:settings.databaseSchema,migrate:false});
const db=new V2Database(store.pool,new ContentCipher(settings.contentKey));await db.assertRuntimeRole();
const service=new MalssiService(db,{allowDraft:settings.v2AllowDraft,modelEnabled:true,dualEnabled:settings.dualEnabled});
const dual=dualModelSettings();
if(settings.dualEnabled&&(!dual.modelId||!/^([a-f0-9]{64})$/i.test(dual.checkpointSha256)))throw new Error('Model ID and verified HOP_DUAL_MODEL_SHA256 are required');
const transport=process.env.HOP_DUAL_TRANSPORT||'direct';
if(!['direct','api'].includes(transport))throw new Error('HOP_DUAL_TRANSPORT must be direct or api');
const model=settings.dualEnabled
  ?transport==='api'
    ?new ModelApiClient(process.env.HOP_MODEL_API_URL||'http://127.0.0.1:9010',process.env.HOP_MODEL_API_TOKEN||'',{model_id:dual.modelId,checkpoint_sha256:dual.checkpointSha256,prompt_profile:dual.profile,prompt_version:dual.version},process.env.HOP_MODEL_API_ALLOWED_ORIGIN||'')
    :new DualRoleModel(dual.evaluatorUrl,dual.responderUrl,dual.modelId,dual.apiKey,dual.profile,dual.version,{allowedOrigins:dual.allowedOrigins,protocol:dual.protocol,checkpointSha256:dual.checkpointSha256})
  :new LocalAgentModel(settings.llmBaseUrl,settings.llmModel,settings.llmApiKey,(process.env.HOP_MODEL_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean));
const worker=new AgentWorker(db,service,model,Number(process.env.HOP_MODEL_CONTEXT_SIZE||16384));
let stop=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stop=true;});
try{while(!stop){try{if(!await worker.tick())await delay(1000);}catch{console.error('malssi_worker_iteration_failed');await delay(2000);}}}finally{await store.close();}
