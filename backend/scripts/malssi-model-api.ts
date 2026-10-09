import {createModelApi} from '../src/model-api/server.ts';
import {DualRoleModel} from '../src/v2/model.ts';
import {validateIdentity} from '../src/model-api/contract.ts';
import {dualModelSettings} from '../src/v2/dual-config.ts';

// Starting this process never starts a model server, worker, training task, or GPU process.
const enabled=process.env.HOP_MODEL_API_INFERENCE_ENABLED==='true';
const dual=dualModelSettings(),hasIdentity=Boolean(dual.modelId&&dual.checkpointSha256);
const identity=hasIdentity?validateIdentity({model_id:dual.modelId,checkpoint_sha256:dual.checkpointSha256,prompt_profile:dual.profile,prompt_version:dual.version}):null;
if(enabled&&!identity)throw new Error('Explicit HOP_DUAL_MODEL_ID and HOP_DUAL_MODEL_SHA256 are required to enable inference');
const model=enabled&&identity?new DualRoleModel(dual.evaluatorUrl,dual.responderUrl,identity.model_id,dual.apiKey,identity.prompt_profile,identity.prompt_version,{allowedOrigins:dual.allowedOrigins,protocol:dual.protocol,checkpointSha256:dual.checkpointSha256}):null;
const app=createModelApi({token:process.env.HOP_MODEL_API_TOKEN||'',identity,model,inferenceEnabled:enabled,timeoutMs:Number(process.env.HOP_MODEL_API_TIMEOUT_MS||30000),evaluationTimeoutMs:Number(process.env.HOP_DUAL_EVALUATION_TIMEOUT_MS||10000)});
const port=Number(process.env.HOP_MODEL_API_PORT||9010);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid HOP_MODEL_API_PORT');
// HTTPS termination belongs to a reverse proxy on this host; do not expose raw HTTP externally.
app.server.listen(port,'127.0.0.1',()=>console.log(JSON.stringify({service:'malssi-model-api',host:'127.0.0.1',port,inference_enabled:enabled,configured:hasIdentity})));
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{if(stopping)return;stopping=true;void app.close();});
