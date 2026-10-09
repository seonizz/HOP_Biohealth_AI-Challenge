import {spawn,spawnSync} from 'node:child_process';
import {realpathSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
if(process.platform!=='linux')throw new Error('Run this launcher on the designated Linux GPU server');
const boundary='/home/slim/choieram/ys';
function checked(value){if(!value)throw new Error('Configure model paths explicitly');const path=realpathSync(resolve(value));if(!path.startsWith(boundary+'/'))throw new Error('Model path leaves the backend workspace');return path;}
const binary=checked(process.env.HOP_MODEL_BINARY),weights=checked(process.env.HOP_MODEL_WEIGHTS),keyFile=checked(process.env.HOP_MODEL_KEY_FILE),state=checked(process.env.HOP_STATE_DIR);
const libraries=(process.env.HOP_MODEL_LIBRARY_PATH||'').split(':').filter(Boolean).map(checked).join(':');
const result=spawnSync('nvidia-smi',['--query-gpu=index,uuid','--format=csv,noheader'],{encoding:'utf8'});
if(result.status!==0)throw new Error('Cannot inspect GPU inventory');
const uuid=result.stdout.split('\n').map(line=>line.split(',').map(x=>x.trim())).find(([index])=>index==='1')?.[1];
if(!uuid?.startsWith('GPU-'))throw new Error('Physical GPU 1 is required; CPU/GPU 0 fallback is disabled');
const port=Number(process.env.HOP_MODEL_PORT||18011);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid model port');
const temp=state+'/model-tmp';mkdirSync(temp,{recursive:true,mode:0o700});checked(temp);
const child=spawn(binary,['--model',weights,'--alias',process.env.HOP_LLM_MODEL||'malssi-local','--host','127.0.0.1','--port',String(port),'--ctx-size',process.env.HOP_MODEL_CONTEXT_SIZE||'16384','--parallel','1','--gpu-layers','999','--flash-attn','on','--cache-type-k','q8_0','--cache-type-v','q8_0','--api-key-file',keyFile,'--log-disable'],{cwd:state,env:{...process.env,CUDA_DEVICE_ORDER:'PCI_BUS_ID',CUDA_VISIBLE_DEVICES:uuid,LD_LIBRARY_PATH:libraries,TMPDIR:temp,CUDA_CACHE_PATH:temp+'/cuda-cache',XDG_CACHE_HOME:temp},stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
child.on('exit',code=>process.exit(code??1));child.on('error',()=>{console.error('model_launch_failed');process.exit(1);});
