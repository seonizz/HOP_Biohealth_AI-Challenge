// Read-only evidence preflight. It does not approve people, deploy, or delete data.
import {constants,openSync,closeSync,fstatSync,readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,extname,isAbsolute,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceFingerprint} from '../src/source-identity.js';

export const STORAGE_AREAS=['database','wal','replicas','backups','exports','external_copies'];
const DEFAULT_MANIFEST=fileURLToPath(new URL('../docs/operations-evidence.template.json',import.meta.url));
const APP_ROOT=fileURLToPath(new URL('../',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const placeholder=/\b(?:todo|tbd|pending|placeholder|unknown|unassigned|example|sample)\b|미정|미확정|미완료|작성\s*예정|입력\s*필요|확인\s*필요|<[^>]*>/i;
const useful=value=>typeof value==='string'&&value.trim().length>=2&&value.length<=500&&!placeholder.test(value)&&!/[\u0000-\u001f]/.test(value);
const validHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)&&!/^0+$/.test(value);
const sensitiveName=value=>/^\.env(?:\.|$)/i.test(value)||/^(?:content\.key|id_rsa|id_ed25519|credentials)$/i.test(value)||/\.(?:pem|key)$/i.test(value);

function readOrdinaryFile(path,maximum){
  const stat=lstatSync(path);
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o444)===0)throw new Error('unreadable');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const opened=fstatSync(fd);
    if(!opened.isFile()||opened.size===0||opened.size>maximum)throw new Error('invalid_size');
    return readFileSync(fd);
  }finally{closeSync(fd);}
}

function parseUniqueJson(text){
  const value=JSON.parse(text);
  // JSON.parse discards duplicate keys. Inspect the valid token stream before
  // using its result, including decoded Unicode keys in nested objects.
  const stack=[];
  for(const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,"]+/g)){
    const token=match[0],current=stack.at(-1);
    if(token==='{')stack.push({keys:new Set(),key:true});
    else if(token==='[')stack.push({});
    else if(token==='}'||token===']')stack.pop();
    else if(token===','&&current?.keys)current.key=true;
    else if(token.startsWith('"')&&current?.keys&&current.key){
      const key=JSON.parse(token);
      if(current.keys.has(key))throw Object.assign(new Error('duplicate'),{code:'INPUT_DUPLICATE_KEYS'});
      current.keys.add(key);current.key=false;
    }
  }
  return value;
}

function inspectJsonEvidence(value){
  if(!object(value)&&!Array.isArray(value))return {hasContent:false,synthetic:false};
  const pending=[value];let hasContent=false,synthetic=false;
  while(pending.length){
    const item=pending.pop();
    if(Array.isArray(item)){for(const child of item)pending.push(child);}
    else if(object(item)){
      if(item.synthetic===true)synthetic=true;
      for(const child of Object.values(item))pending.push(child);
    }else if(typeof item==='string'){
      if(item.trim()&&!/^(?:todo|tbd|pending|placeholder|미정|미확정|미완료)$/i.test(item.trim()))hasContent=true;
    }else if(typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))hasContent=true;
  }
  return {hasContent,synthetic};
}

export function checkOperationsEvidence(manifestPath=DEFAULT_MANIFEST,{now=new Date()}={}){
  const issues=[],checkedEvidence=[];
  const add=(field,code)=>issues.push({field,code});
  let manifest,kind='unknown',currentSource;
  const result=()=>({schema:'malssi-operations-evidence-v1',status:issues.length?'pending':kind==='synthetic'?'synthetic_checks_passed':'evidence_complete',
    evidence_kind:kind,passed:issues.length===0,operational_evidence_complete:issues.length===0&&kind==='actual',
    production_ready:false,human_approval_authenticated:false,physical_deletion_verified:false,
    current_app_source_sha256:currentSource||null,evidence_files_checked:checkedEvidence.length,issues,
    limitations:['Checks supplied declarations, supported evidence formats and local file hashes only; does not authenticate approvers or the truth of evidence.',
      'Accepts UTF-8 JSON, JSONL, NDJSON, TXT and Markdown. Plain text is checked for readability, not factual meaning; opaque formats are rejected.',
      'Does not read .env, connect to a database or network, deploy, restore, or delete anything.',
      'Does not prove physical deletion from storage, WAL, replicas, backups, or external copies.',
      'A synthetic pass is not operational evidence. Production approval remains an external decision.']});
  const path=resolve(manifestPath),base=dirname(path);
  try{
    if(!path.endsWith('.json')||sensitiveName(path.split(sep).at(-1)))throw new Error('invalid_manifest');
    manifest=parseUniqueJson(new TextDecoder('utf-8',{fatal:true}).decode(readOrdinaryFile(path,1024*1024)));
  }catch(error){add('$',error.code==='INPUT_DUPLICATE_KEYS'?error.code:error instanceof SyntaxError?'INPUT_JSON_INVALID':'INPUT_NOT_READABLE');return result();}
  const shape=(value,keys,field)=>{
    if(!object(value)){add(field,'OBJECT_REQUIRED');return {};}
    if(Object.keys(value).some(key=>!keys.includes(key)))add(field,'UNKNOWN_FIELDS');
    return value;
  };
  const text=(value,field)=>{if(!useful(value))add(field,'MEANINGFUL_VALUE_REQUIRED');};
  const exact=(value,wanted,field)=>{if(value!==wanted)add(field,'NOT_COMPLETE');};
  const days=(value,field)=>{if(!Number.isInteger(value)||value<1||value>90)add(field,'RETENTION_DAYS_INVALID');};
  const date=(value,field)=>{
    const parsed=typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)?new Date(value):null;
    if(!parsed||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,19)!==value.slice(0,19)||parsed>now){add(field,'COMPLETED_TIMESTAMP_REQUIRED');return null;}
    return parsed.getTime();
  };
  const evidence=(value,field)=>{
    const item=shape(value,['path','sha256'],field);
    const parts=typeof item.path==='string'?item.path.split(/[\\/]/):[];
    const safe=useful(item.path)&&!isAbsolute(item.path)&&!item.path.includes('\\')&&!/^[a-z][a-z0-9+.-]*:/i.test(item.path)&&parts.every(part=>part&&part!=='.'&&part!=='..'&&!sensitiveName(part));
    if(!safe)add(field+'.path','LOCAL_RELATIVE_EVIDENCE_PATH_REQUIRED');
    if(!validHash(item.sha256))add(field+'.sha256','SHA256_REQUIRED');
    if(!safe||!validHash(item.sha256))return;
    try{
      let target=base;
      for(const part of parts){target=join(target,part);if(lstatSync(target).isSymbolicLink())throw new Error('link');}
      const content=readOrdinaryFile(target,10*1024*1024);
      if(hash(content)!==item.sha256){add(field,'EVIDENCE_HASH_MISMATCH');return;}
      const extension=extname(item.path).toLowerCase();
      if(!['.json','.jsonl','.ndjson','.txt','.md'].includes(extension)){add(field,'EVIDENCE_FORMAT_UNSUPPORTED');return;}
      const jsonLines=extension==='.jsonl'||extension==='.ndjson',declaredJson=jsonLines||extension==='.json';
      let text;
      try{text=new TextDecoder('utf-8',{fatal:true}).decode(content);}
      catch{add(field,declaredJson?'EVIDENCE_JSON_INVALID':'EVIDENCE_TEXT_INVALID');return;}
      if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)){
        add(field,declaredJson?'EVIDENCE_JSON_INVALID':'EVIDENCE_TEXT_INVALID');return;
      }
      const trimmed=text.trim();
      if(!trimmed||/^(?:todo|tbd|pending|placeholder|미정|미확정|미완료)$/i.test(trimmed)){add(field,'EVIDENCE_PLACEHOLDER');return;}
      // JSON-shaped text keeps the structured contract even if renamed to TXT/MD.
      // Ordinary prose has its own readability checks; parser errors never select it.
      const jsonShaped=/^[{[\"]|^(?:null|true|false)$|^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed);
      if(declaredJson||jsonShaped){
        let json;
        try{
          json=jsonLines?text.split(/\r?\n/).filter(line=>line.trim()).map(parseUniqueJson):parseUniqueJson(text);
        }catch(error){
          add(field,error.code==='INPUT_DUPLICATE_KEYS'?'EVIDENCE_DUPLICATE_KEYS':'EVIDENCE_JSON_INVALID');return;
        }
        if(jsonLines&&json.some(row=>!object(row)&&!Array.isArray(row))){add(field,'EVIDENCE_JSON_EMPTY');return;}
        const inspection=inspectJsonEvidence(json);
        if(!inspection.hasContent){add(field,'EVIDENCE_JSON_EMPTY');return;}
        if(kind==='actual'&&inspection.synthetic){add(field,'EVIDENCE_SYNTHETIC_CONFLICT');return;}
      }
      checkedEvidence.push(field);
    }catch{add(field,'EVIDENCE_NOT_READABLE');}
  };
  manifest=shape(manifest,['schema_version','evidence_kind','service_id','reviewed_at','policy','deployment','storage_areas','restore_verification','failure_response'],'$');
  exact(manifest.schema_version,1,'schema_version');
  if(!['actual','synthetic'].includes(manifest.evidence_kind))add('evidence_kind','ACTUAL_OR_SYNTHETIC_REQUIRED');else kind=manifest.evidence_kind;
  text(manifest.service_id,'service_id');const reviewed=date(manifest.reviewed_at,'reviewed_at');
  const policy=shape(manifest.policy,['status','inactivity_days','basis','approved_by','approved_at','evidence'],'policy');
  exact(policy.status,'approved','policy.status');days(policy.inactivity_days,'policy.inactivity_days',90);
  exact(policy.basis,'last_valid_api_access','policy.basis');text(policy.approved_by,'policy.approved_by');
  const approved=date(policy.approved_at,'policy.approved_at');evidence(policy.evidence,'policy.evidence');
  const deployment=shape(manifest.deployment,['status','environment','deployment_id','verified_by','verified_at','inactivity_days','source_sha256','migration','cleanup_healthy','evidence'],'deployment');
  exact(deployment.status,'verified','deployment.status');exact(deployment.environment,kind==='synthetic'?'synthetic':'production','deployment.environment');
  text(deployment.deployment_id,'deployment.deployment_id');text(deployment.verified_by,'deployment.verified_by');
  const deployed=date(deployment.verified_at,'deployment.verified_at');days(deployment.inactivity_days,'deployment.inactivity_days',90);
  if(deployment.inactivity_days!==policy.inactivity_days)add('deployment.inactivity_days','POLICY_MISMATCH');
  try{currentSource=sourceFingerprint(APP_ROOT).sha256;}catch{add('deployment.source_sha256','CURRENT_SOURCE_UNAVAILABLE');}
  if(!validHash(deployment.source_sha256)||deployment.source_sha256!==currentSource)add('deployment.source_sha256','CURRENT_SOURCE_MISMATCH');
  exact(deployment.migration,'006_data_retention.sql','deployment.migration');exact(deployment.cleanup_healthy,true,'deployment.cleanup_healthy');evidence(deployment.evidence,'deployment.evidence');
  if(approved!==null&&deployed!==null&&approved>deployed)add('deployment.verified_at','PRECEDES_POLICY_APPROVAL');
  const areas=Array.isArray(manifest.storage_areas)?manifest.storage_areas:[];
  if(!Array.isArray(manifest.storage_areas))add('storage_areas','ARRAY_REQUIRED');
  const seen=new Set();
  for(let index=0;index<areas.length;index++){
    const field=`storage_areas[${index}]`,area=shape(areas[index],['area','status','owner','inventory_evidence','absence_reason','locations'],field);
    if(!STORAGE_AREAS.includes(area.area)){add(field+'.area','UNKNOWN_STORAGE_AREA');continue;}
    if(seen.has(area.area))add(field+'.area','DUPLICATE_STORAGE_AREA');seen.add(area.area);
    if(!['present','not_used'].includes(area.status))add(field+'.status','STORAGE_INVENTORY_INCOMPLETE');
    if(area.area==='database'&&area.status!=='present')add(field+'.status','DATABASE_REQUIRED');
    text(area.owner,field+'.owner');evidence(area.inventory_evidence,field+'.inventory_evidence');
    const locations=Array.isArray(area.locations)?area.locations:[];
    if(!Array.isArray(area.locations))add(field+'.locations','ARRAY_REQUIRED');
    if(area.status==='not_used'){
      text(area.absence_reason,field+'.absence_reason');if(locations.length)add(field+'.locations','ABSENT_AREA_HAS_LOCATIONS');
    }else if(!locations.length)add(field+'.locations','STORAGE_LOCATIONS_REQUIRED');
    const ids=new Set();
    for(let n=0;n<locations.length;n++){
      const prefix=`${field}.locations[${n}]`,location=shape(locations[n],['id','retention_days','expiry_rule','expiration_verified','expiration_evidence'],prefix);
      text(location.id,prefix+'.id');if(ids.has(location.id))add(prefix+'.id','DUPLICATE_LOCATION');ids.add(location.id);
      if(area.area==='database')days(location.retention_days,prefix+'.retention_days');
      else if(typeof location.retention_days!=='number'||!Number.isFinite(location.retention_days)||location.retention_days<0||location.retention_days>Number.MAX_SAFE_INTEGER)add(prefix+'.retention_days','RETENTION_DAYS_INVALID');
      text(location.expiry_rule,prefix+'.expiry_rule');
      exact(location.expiration_verified,true,prefix+'.expiration_verified');evidence(location.expiration_evidence,prefix+'.expiration_evidence');
      if(area.area==='database'&&location.retention_days!==policy.inactivity_days)add(prefix+'.retention_days','POLICY_MISMATCH');
    }
  }
  for(const area of STORAGE_AREAS)if(!seen.has(area))add(`storage_areas.${area}`,'STORAGE_AREA_MISSING');
  const restore=shape(manifest.restore_verification,['status','verified_by','verified_at','deletions_reapplied','expired_access_blocked','evidence'],'restore_verification');
  exact(restore.status,'verified','restore_verification.status');text(restore.verified_by,'restore_verification.verified_by');
  const restored=date(restore.verified_at,'restore_verification.verified_at');
  exact(restore.deletions_reapplied,true,'restore_verification.deletions_reapplied');exact(restore.expired_access_blocked,true,'restore_verification.expired_access_blocked');evidence(restore.evidence,'restore_verification.evidence');
  if(deployed!==null&&restored!==null&&restored<deployed)add('restore_verification.verified_at','PRECEDES_DEPLOYMENT_VERIFICATION');
  if(reviewed!==null&&[approved,deployed,restored].some(value=>value!==null&&value>reviewed))add('reviewed_at','PRECEDES_COMPLETED_EVIDENCE');
  const failure=shape(manifest.failure_response,['status','owner','evidence'],'failure_response');
  exact(failure.status,'documented','failure_response.status');text(failure.owner,'failure_response.owner');evidence(failure.evidence,'failure_response.evidence');
  return result();
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=process.argv.length>3?{passed:false,production_ready:false,issues:[{field:'arguments',code:'ONE_MANIFEST_PATH_REQUIRED'}]}:checkOperationsEvidence(process.argv[2]);
  console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
}
