import {ModelGateway} from './model.js';
import {configuredModelGateway,resolveModelBaseUrl} from './model-config.js';
import {HttpError,object} from './errors.js';
import {DEFAULT_MODEL_EXECUTION,validateModelExecution,attachQuestionExecution,executionMetadata} from './model-execution.js';
const ids=['local12b','gpu31b'];
const invalid=()=>new HttpError(422,'INVALID_MODEL_CONNECTION','API 주소, 모델 이름과 인증 키를 확인해 주세요.');
const localHost=hostname=>hostname==='localhost'||hostname==='[::1]'||hostname==='host.docker.internal'||
 /^127(?:\.\d{1,3}){3}$/u.test(hostname)||/^10(?:\.\d{1,3}){3}$/u.test(hostname)||
 /^192\.168(?:\.\d{1,3}){2}$/u.test(hostname)||/^172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/u.test(hostname);
export function validateModelConnection(input,current){
 try{
  object(input,['base_url','model','api_key']);
  for(const [name,max]of [['base_url',2048],['model',200]])if(typeof input[name]!=='string'||!input[name].trim()||input[name].length>max||/[\u0000-\u001f\u007f]/u.test(input[name]))throw invalid();
  const baseUrl=resolveModelBaseUrl(input.base_url),url=new URL(baseUrl);
  if(url.protocol!=='https:'&&!localHost(url.hostname))throw invalid();
  if(input.api_key!==undefined&&(typeof input.api_key!=='string'||input.api_key.length>4096||/[^\x20-\x7e]/u.test(input.api_key)))throw invalid();
  const sameOrigin=current?.baseUrl && new URL(current.baseUrl).origin===url.origin;
  const apiKey=input.api_key?.trim()||(sameOrigin && current.apiKey)||(localHost(url.hostname)?'local-ollama':'');
  if(!apiKey)throw invalid();
  return {baseUrl,model:input.model.trim(),apiKey};
 }catch{throw invalid();}
}
// Persist only immutable serializable constructor options, never transport,
// callbacks, caches or per-request approval identities.
const options=gateway=>Object.fromEntries(Object.entries(gateway).filter(([key,value])=>key!=='reviewedNameIdentity'&&['string','number','boolean'].includes(typeof value)));
const snapshot=gateway=>({writer:options(gateway),review:gateway.reviewGateway?{...options(gateway.reviewGateway),singleCallTurns:false,singleCallQuestionOnly:false}:null,
 ...(gateway.executionSnapshot?{execution:structuredClone(gateway.executionSnapshot)}:{})});
const referralSettingKeys=new Set([
 'REFERRAL_MODEL_BASE_URL','REFERRAL_MODEL_DOCKER_BASE_URL','REFERRAL_MODEL_API_KEY','REFERRAL_MODEL_NAME',
 'REFERRAL_MODEL_API_PROFILE','REFERRAL_MODEL_AGENT_FORMAT','REFERRAL_MODEL_REASONING_EFFORT',
 'REFERRAL_MODEL_STREAM_JSON','REFERRAL_MODEL_STREAM_COMPLETE_JSON','REFERRAL_MODEL_DISCOVER_TOKEN_LIMITS',
 'DEMO_CONTAINER','MODEL_API_PROFILE','MODEL_AGENT_FORMAT','MODEL_REASONING_EFFORT',
 'MODEL_SCHEMA_STRING_LIMITS','MODEL_DISCOVER_TOKEN_LIMITS',
]);
// Logical IDs in older conversations refer to the first configured gateway.
// Save that baseline before accepting edits so environment changes at restart
// cannot redirect those conversations to a different endpoint or credential.
export function missingModelBaselines(base,rows=[]){
 return base.list().flatMap(({id})=>{
  if(rows.some(row=>row.profile_id===id&&row.config?.role==='baseline'))return [];
  let gateway;try{gateway=base.resolve(id);}catch(error){if(error.code==='MODEL_PROFILE_UNAVAILABLE')return [];throw error;}
  return gateway instanceof ModelGateway?[{profile_id:id,config:{...snapshot(gateway),role:'baseline'}}]:[];
 });
}
// Conversations created before profile selection have no model ID at all.
// Their original gateway may differ from the selectable local12b gateway.
export function missingLegacyModelBaseline(gateway,rows=[],{env=process.env}={}){
 if(rows.some(row=>row.config?.role==='legacy')||!(gateway instanceof ModelGateway))return null;
 const referralSettings=Object.fromEntries(Object.entries(env).filter(([key,value])=>referralSettingKeys.has(key)&&typeof value==='string'));
 return {profile_id:'local12b',config:{...snapshot(gateway),role:'legacy',referralSettings}};
}
export function connectionGateway(config){
 const review=config.review===null?null:new ModelGateway({...config.review,singleCallTurns:false,singleCallQuestionOnly:false,reviewGateway:null,diagnosticLogger:null});
 if(review)Object.assign(review,{apiProfile:config.review.apiProfile,serverGpuOnly:config.review.serverGpuOnly});
 const gateway=new ModelGateway({...config.writer,reviewGateway:review,diagnosticLogger:null});
 Object.assign(gateway,{apiProfile:config.writer.apiProfile,serverGpuOnly:config.writer.serverGpuOnly});
 if(!gateway.configured)throw invalid();
 if(config.execution)attachQuestionExecution(gateway,config.execution);
 return gateway;
}
export function prepareModelExecution(id,input,current){
 if(!ids.includes(id)||!(current instanceof ModelGateway))throw new HttpError(503,'MODEL_PROFILE_UNAVAILABLE','범용 모델 연결을 먼저 저장해 주세요.');
 object(input,[...Object.keys(DEFAULT_MODEL_EXECUTION),'question_connection','review_connection']);
 const settings=validateModelExecution(Object.fromEntries(Object.keys(DEFAULT_MODEL_EXECUTION).map(key=>[key,input[key]])));
 const previous=current.executionSnapshot,execution={settings,question:previous?.question??null,review:previous?.review??null};
 for(const role of ['question','review']){
  const supplied=input[role+'_connection'];
  if(supplied!==undefined){
   const target=validateModelConnection(supplied,execution[role]);
   const inherited=options(current);
   // Separate endpoints do not inherit endpoint-specific discovery/streaming.
   execution[role]={...inherited,...target,discoverTokenLimits:false,streamJson:false,streamCompleteJson:false};
  }
  if(settings[role+'_source']==='custom'&&!execution[role])
   throw new HttpError(422,'INVALID_MODEL_EXECUTION','선택한 역할의 별도 모델 연결을 입력해 주세요.');
 }
 const config={...snapshot(current),execution};
 return {config,gateway:connectionGateway(config)};
}

// The default receives its own version: old logical IDs and saved conversations
// continue resolving their original baseline instead of silently changing policy.
export function missingExecutionDefaults(profiles,rows=[]){
 return profiles.list().flatMap(({id})=>{
  const current=profiles.current(id);
  if(!(current instanceof ModelGateway)||current.protocol!=='relationship_agent'||current.executionSnapshot||
    rows.some(row=>row.profile_id===id&&row.config?.role==='execution_default'))return [];
  const prepared=prepareModelExecution(id,DEFAULT_MODEL_EXECUTION,current);
  return [{profile_id:id,config:{...prepared.config,role:'execution_default'}}];
 });
}
export function prepareModelConnection(id,input,current){
 if(!ids.includes(id))throw invalid();
 const target=validateModelConnection(input,current);
 const original=current instanceof ModelGateway?current:configuredModelGateway({env:{MODEL_BASE_URL:target.baseUrl,MODEL_API_KEY:target.apiKey,MODEL_NAME:target.model,
  MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined',MODEL_AGENT_FORMAT:'json_schema',MODEL_REASONING_EFFORT:'omit',MODEL_DISCOVER_TOKEN_LIMITS:'false'}});
 const changed=!current||['baseUrl','model','apiKey'].some(key=>current[key]!==target[key]);
 const writer={...options(original),...target},review={...options(original.reviewGateway||original),...target,singleCallTurns:false,singleCallQuestionOnly:false};
 // Capability discovery is endpoint-specific. Retain opted-in streaming on
 // local/LAN endpoints supported by the transport; external targets use JSON.
 if(current&&current.baseUrl!==target.baseUrl)for(const settings of [writer,review]){
  if(!localHost(new URL(target.baseUrl).hostname)){settings.streamJson=false;settings.streamCompleteJson=false;}
  settings.discoverTokenLimits=false;
 }
 if(id==='gpu31b'&&changed){writer.singleCallTurns=false;writer.singleCallQuestionOnly=false;writer.bundleCombinedTurnReviews=writer.protocol==='relationship_agent'&&writer.stateMode==='combined';}
 const config={writer,review,...(original.executionSnapshot?{execution:structuredClone(original.executionSnapshot)}:{})};
 return {config,gateway:connectionGateway(config)};
}

export function withModelConnections(base,rows=[],{legacyGateway=null}={}){
 const versions=new Map(),latest=new Map(),baselines=new Map();
 let legacyVersion,legacyReferralSettings;
 const add=(row,gateway)=>{
  if(!ids.includes(row.profile_id)||!new RegExp('^'+row.profile_id+'_[a-f0-9]{32}$','u').test(row.id)||versions.has(row.id))throw invalid();
  versions.set(row.id,gateway??connectionGateway(row.config));
  if(row.config?.role==='legacy'){
   if(row.profile_id!=='local12b'||legacyVersion!==undefined)throw invalid();legacyVersion=row.id;
   legacyReferralSettings=structuredClone(row.config.referralSettings??{});
  }
  else if(row.config?.role==='baseline'){if(baselines.has(row.profile_id))throw invalid();baselines.set(row.profile_id,row.id);}
  else latest.set(row.profile_id,row.id);
 };
 for(const row of rows)add(row);
 const legacy=id=>baselines.has(id)?versions.get(baselines.get(id)):base.resolve(id);
 const current=id=>{const version=latest.get(id);if(version)return versions.get(version);try{return legacy(id);}catch(error){if(error.code==='MODEL_PROFILE_UNAVAILABLE')return null;throw error;}};
 return {defaultId:base.defaultId,add,current,
  resolveLegacy:()=>legacyVersion===undefined?legacyGateway:versions.get(legacyVersion),
  legacyReferralSettings:()=>legacyVersion===undefined?undefined:structuredClone(legacyReferralSettings),
  bind:id=>{if(!ids.includes(id))throw new HttpError(422,'INVALID_MODEL_PROFILE','사용할 모델을 다시 선택해 주세요.');return latest.get(id)??id;},
  list:()=>base.list().map(row=>({...row,available:latest.has(row.id)||baselines.has(row.id)||row.available})),
  executions:()=>ids.map(id=>executionMetadata(id,current(id))),
  connections:()=>ids.map(id=>{const gateway=current(id);return {id,base_url:gateway?.baseUrl||'',model:gateway?.model||'',api_key_configured:Boolean(gateway?.apiKey),single_call_turns:(gateway?.questionGateway??gateway)?.singleCallTurns===true};}),
  resolve:id=>versions.has(id)?versions.get(id):legacy(id)};
}
