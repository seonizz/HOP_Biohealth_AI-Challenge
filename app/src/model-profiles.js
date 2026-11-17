import {configuredModelGateway} from './model-config.js';
import {HttpError} from './errors.js';

const labels=Object.freeze({local12b:'12B',gpu31b:'31B'});
const unknown=()=>new HttpError(422,'INVALID_MODEL_PROFILE','사용할 모델을 다시 선택해 주세요.');
const unavailable=()=>new HttpError(503,'MODEL_PROFILE_UNAVAILABLE','선택한 모델의 연결을 준비한 뒤 다시 시도해 주세요.');

// Only server-owned IDs are selectable. Endpoints and credentials never leave
// this registry; an unavailable selection never falls back to another model.
export function createModelProfiles(gateways) {
  if(!gateways||typeof gateways!=='object'||Array.isArray(gateways)||Object.keys(gateways).some(id=>!Object.hasOwn(labels,id)))
    throw new TypeError('Invalid model profiles');
  const entries=new Map(Object.keys(labels).map(id=>[id,gateways[id]??null]));
  for(const gateway of entries.values())if(gateway!==null&&
    (typeof gateway!=='object'||typeof gateway.updateState!=='function'||typeof gateway.respond!=='function'))
    throw new TypeError('Invalid model profile gateway');
  return Object.freeze({
    defaultId:'local12b',
    list:()=>[...entries].map(([id,gateway])=>({id,label:labels[id],available:gateway!==null})),
    resolve(id){
      if(typeof id!=='string'||!entries.has(id))throw unknown();
      const gateway=entries.get(id);if(!gateway)throw unavailable();return gateway;
    },
  });
}

export function configuredModelProfiles({env=process.env,gateway,diagnosticLogger,fetchImpl,retryFailures=true}={}) {
  const enabled=env.MODEL_SELECTION_ENABLED;
  if(enabled===undefined||enabled==='false')return null;
  if(enabled!=='true')throw new TypeError('Invalid MODEL_SELECTION_ENABLED');
  const local=gateway===undefined?configuredModelGateway({env,diagnosticLogger,fetchImpl,retryFailures}):gateway;
  // Do not spread the local configuration into the GPU profile: this would
  // silently route its independent reviewer or referral calls to the 12B model.
  const gpuEnv=Object.fromEntries(Object.entries(env).filter(([key])=>key.startsWith('GPU31B_MODEL_')).map(([key,value])=>[key.slice(7),value]));
  const gpu=configuredModelGateway({env:gpuEnv,diagnosticLogger,fetchImpl,retryFailures});
  return createModelProfiles({local12b:local,gpu31b:gpu});
}
