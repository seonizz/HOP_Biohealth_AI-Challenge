// Frozen application flow over a local/SSH filesystem queue. No HTTP is sent.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const PROFILE=Object.freeze({protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'none',
  timeoutMs:900000,stateMode:'combined',skipFinalExtras:false,reuseFinalDraft:true,
  bundleCombinedTurnReviews:true,bundleAnalysisPlan:true,bundleFinalReviews:true,
  compactReviewInputs:true,compactReviewOutput:false,stageScopedQuestionRules:true,
  retryFailures:false,streamJson:false,discoverTokenLimits:false});
export const WIRE=Object.freeze({temperature:0,seed:3407,max_tokens:8192,cache_prompt:false,stream:false});
export const REGIMES=Object.freeze([
  {id:'baseline',writer:'baseline',reviewer:'baseline',comparison_scope:'serving_base_reference'},
  {id:'B_reviewer',writer:'baseline',reviewer:'B_original',comparison_scope:'reviewer_effect_writer_fixed_baseline'},
  {id:'C_combined',writer:'C_user_provided',reviewer:'C_user_provided',comparison_scope:'combined_configuration_effect_not_isolated_generator_effect'},
]);
const REMOTE_ROOT='/home/chihun/Documents/HOP/evaluations/role_eval_20261112';
const RESUME_REMOTE_ROOT=REMOTE_ROOT+'_resume1';
const stamp=()=>new Date().toISOString();
export const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
const stableHash=value=>hash(sorted(value));
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

export class InfrastructureError extends Error {
  constructor(code,message=code){super(message);this.name='InfrastructureError';this.code=code;}
}
function ensure(condition,code){if(!condition)throw new InfrastructureError(code);}
function canonicalDirectory(directory) {
  directory=path.resolve(directory);let ancestor=directory;
  while(!fs.existsSync(ancestor))ancestor=path.dirname(ancestor);
  ensure(fs.realpathSync(ancestor)===ancestor,'linked_work_directory');
  fs.mkdirSync(directory,{recursive:true});ensure(fs.realpathSync(directory)===directory,'linked_work_directory');return directory;
}
function write(file,value) {
  canonicalDirectory(path.dirname(file));ensure(!fs.existsSync(file)||!fs.lstatSync(file).isSymbolicLink(),'linked_artifact');
  const temporary=file+'.tmp',fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temporary,file);
}
function append(file,value) {
  const fd=fs.openSync(file,'a',0o600);try{fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}

export function pinIdentity(root) {
  const protocolFile=path.join(root,'protocol.json'),runtimeFile=path.join(root,'work/RUNTIME.json');
  const protocol=read(protocolFile),runtime=read(runtimeFile);
  const protocol_sha256=hash(fs.readFileSync(protocolFile)),runtime_sha256=hash(fs.readFileSync(runtimeFile));
  ensure(runtime.protocol_sha256===protocol_sha256,'runtime_protocol_binding_mismatch');
  ensure(hex(runtime.base_model_digest),'runtime_base_digest_missing');
  const declared=Object.fromEntries((protocol.base_files||[]).map(row=>[row.name,row.sha256]));
  ensure(Object.keys(declared).length>0&&Object.values(declared).every(hex)&&stableHash(declared)===runtime.base_model_digest,'runtime_base_manifest_mismatch');
  const models=new Map((protocol.models||[]).map(row=>[row.id,row]));
  for(const id of ['baseline','B_original','C_user_provided']) {
    ensure(models.has(id),'required_model_missing');
    ensure(id==='baseline'?models.get(id).adapter===null:hex(models.get(id).adapter_sha256),'model_adapter_identity_missing');
  }
  ensure(runtime.base_revision===protocol.base_revision&&runtime.base_snapshot===protocol.base_snapshot,'runtime_base_revision_mismatch');
  return {protocol,runtime,models,protocol_sha256,runtime_sha256,base_model_digest:runtime.base_model_digest,
    source_manifest_sha256:hash(fs.readFileSync(path.join(root,'SOURCE_SHA256.json')))};
}

export function verifyReply(reply,request,identity) {
  ensure(reply&&reply.request_id===request.request_id,'queue_reply_identifier_mismatch');
  ensure(Number.isInteger(reply.status)&&[200,400,504].includes(reply.status),reply?.status===503?'resident_worker_unavailable':'unsupported_queue_response_status');
  const proof=reply.proof,model=identity.models.get(request.model);
  ensure(proof&&proof.model===request.model&&model,'queue_model_proof_mismatch');
  ensure(proof.protocol_sha256===identity.protocol_sha256&&proof.runtime_sha256===identity.runtime_sha256
    &&proof.base_model_digest===identity.base_model_digest,'queue_runtime_identity_mismatch');
  const expected=model.adapter?model.adapter_sha256:null;
  ensure(proof.adapter_sha256===expected&&proof.adapter_source_sha256===expected,'queue_adapter_digest_mismatch');
  if(reply.status===200) {
    ensure(proof.actual_adapter_enabled===Boolean(model.adapter)&&proof.all_lora_flags_verified===true
      &&Number.isInteger(proof.lora_layer_count)&&proof.lora_layer_count>0,'queue_actual_adapter_state_unverified');
    ensure(proof.fresh_kv_cache===true&&proof.input_truncated===false,'queue_cache_or_truncation_contract_mismatch');
    ensure(!model.adapter||proof.activation?.all_named_lora_tensors_equal===true,'queue_lora_tensor_identity_unverified');
    ensure(model.adapter||proof.activation?.mode==='PEFT.disable_adapter','queue_baseline_disable_unverified');
    ensure(Array.isArray(reply.response?.choices)&&reply.response.choices.length===1
      &&typeof reply.response.choices[0]?.message?.content==='string','queue_response_contract_invalid');
    ensure(reply.response.model===request.model,'queue_openai_model_identity_mismatch');
  } else ensure(reply.response?.error&&typeof reply.response.error==='object','queue_error_contract_invalid');
  return proof;
}

export const REMOTE_FS_SCRIPT=`from pathlib import Path
import os,sys,json,stat
root=Path('/home/chihun/Documents/HOP/evaluations/role_eval_20261112')
message=json.load(sys.stdin)
assert root.resolve(strict=True)==root and root.stat().st_uid==os.getuid()
queue=root/'work/fs-requests'
assert queue.resolve()==queue and queue.is_dir() and queue.stat().st_uid==os.getuid()
identifier=message['request_id']
assert isinstance(identifier,str) and identifier and len(identifier)<200 and all(c.isascii() and (c.isalnum() or c in '_.:-') for c in identifier) and identifier not in ('.','..')
directory=queue/identifier
operation=message['operation']
def checked(p):
 assert p.resolve()==p and p.is_file() and p.stat().st_uid==os.getuid() and p.stat().st_nlink==1
 return p
def atomic(name,value):
 target=directory/name
 assert not target.exists()
 temporary=directory/(name+'.tmp')
 fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 with os.fdopen(fd,'w') as f:
  json.dump(value,f,ensure_ascii=False,allow_nan=False);f.write('\\n');f.flush();os.fsync(f.fileno())
 os.rename(temporary,target)
if operation=='write':
 request=message['request']
 assert request['request_id']==identifier
 reused=directory.exists()
 if reused:
  assert directory.resolve()==directory and directory.is_dir()
  existing=directory/'request.json'
  if existing.exists():assert json.loads(checked(existing).read_text())==request
  else:atomic('request.json',request)
 else:
  directory.mkdir(mode=0o700)
  atomic('request.json',request)
 print(json.dumps({'written':True,'reused':reused}))
elif operation=='read':
 assert directory.resolve()==directory and directory.is_dir()
 fatal=queue/'FATAL.json'
 if fatal.exists():print(json.dumps({'fatal':json.loads(checked(fatal).read_text())}))
 else:
  p=directory/'response.json'
  if p.exists():
   assert checked(p).stat().st_size<=16777216
   print(json.dumps({'reply':json.loads(p.read_text())},ensure_ascii=False,allow_nan=False))
  else:print(json.dumps({'pending':True}))
elif operation=='cancel':
 assert directory.resolve()==directory and directory.is_dir()
 p=directory/'cancel.json'
 if not p.exists():atomic('cancel.json',{'request_id':identifier,'cancelled':True})
 print(json.dumps({'cancelled':True}))
else:raise ValueError('Unsupported queue operation')
`;
const shellQuote=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function remoteQueueBackend({host,remoteRoot,execFileImpl=execFile,retryMs=2000,maxRetryMs=900000,onRetry=()=>{}}) {
  ensure(host==='chihun@chihun-ubuntu'&&[REMOTE_ROOT,RESUME_REMOTE_ROOT].includes(remoteRoot),'unapproved_remote_queue');
  const script=REMOTE_FS_SCRIPT.replace("root=Path('"+REMOTE_ROOT+"')", "root=Path('"+remoteRoot+"')");
  const command='cd -- /home/chihun/Documents/HOP && /usr/bin/python3 -I -S -B -c '+shellQuote(script);
  const once=message=>new Promise((resolve,reject)=>{
    const args=['-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ConnectTimeout=10',
      '-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2',host,command];
    const child=execFileImpl('ssh',args,{timeout:30000,maxBuffer:20*1024*1024,encoding:'utf8'},(error,stdout)=>{
      if(error)return reject(new InfrastructureError(error.code===255||error.killed||error.signal?'remote_queue_transport_failure':'remote_queue_operation_failed',error.message));
      try{resolve(JSON.parse(stdout));}catch{return reject(new InfrastructureError('invalid_remote_queue_receipt'));}
    });
    child.stdin.on?.('error',()=>{});child.stdin.end(JSON.stringify(message));
  });
  const call=async message=>{
    const deadline=performance.now()+maxRetryMs;
    for(;;)try{return await once(message);}catch(error){
      if(error.code!=='remote_queue_transport_failure'||performance.now()>=deadline)throw error;
      onRetry({operation:message.operation,request_id:message.request_id,error:error.message});await pause(retryMs);
    }
  };
  return {
    write:async request=>{const result=await call({operation:'write',request_id:request.request_id,request});ensure(result.written===true,'queue_write_not_acknowledged');return result;},
    read:async id=>{const result=await call({operation:'read',request_id:id});if(result.fatal)throw new InfrastructureError('resident_queue_fatal');return result.reply||null;},
    cancel:async id=>call({operation:'cancel',request_id:id}),
    pollMs:2000,description:{kind:'ssh_filesystem_queue',host,remote_root:remoteRoot,actual_http_posts:0,idempotent_reconnect:true},
  };
}
export function localQueueBackend(queue) {
  queue=canonicalDirectory(queue);
  return {
    write:async request=>{const directory=path.join(queue,request.request_id);ensure(!fs.existsSync(directory),'queue_request_replay');fs.mkdirSync(directory);write(path.join(directory,'request.json'),request);},
    read:async id=>{if(fs.existsSync(path.join(queue,'FATAL.json')))throw new InfrastructureError('resident_queue_fatal');const file=path.join(queue,id,'response.json');return fs.existsSync(file)?read(file):null;},
    cancel:async id=>{const file=path.join(queue,id,'cancel.json');if(!fs.existsSync(file))write(file,{request_id:id,cancelled:true});},
    pollMs:25,description:{kind:'local_filesystem_queue',queue,actual_http_posts:0},
  };
}

export function createTransport({output,assignment,backend,identity,modelStageRole,timeoutMs=900000,cancelSignal=null}) {
  canonicalDirectory(path.join(output,'requests'));
  const regime=REGIMES.find(row=>row.id===assignment.regime);ensure(regime,'unknown_regime');
  const records=[];let serial=Promise.resolve(),sequence=0,fatal=null;
  const makeFetch=role=>async(url,options={})=>{
    try {
    ensure(url==='http://127.0.0.1/v1/chat/completions'&&options.method==='POST','unexpected_gateway_route');
    const original=JSON.parse(options.body),stage=JSON.parse(original.messages.at(-1).content).stage;
    ensure((modelStageRole(stage)==='reviewer')===(role==='reviewer'),'gateway_role_routing_mismatch');
    ensure(original.response_format===undefined&&original.grammar===undefined,'unregistered_grammar_constraint');
    const model=role==='reviewer'?regime.reviewer:regime.writer;
    const payload={...original,...WIRE,model,max_tokens:Math.min(original.max_tokens??8192,8192)};
    ensure(Number.isInteger(payload.max_tokens)&&payload.max_tokens>0,'invalid_output_budget');
    const attempt_id=String(++sequence).padStart(6,'0');
    const request_id='flow-'+assignment.regime+'-'+assignment.case_id+'-'+attempt_id;
    const request={request_id,model,payload},directory=path.join(output,'requests',attempt_id);
    fs.mkdirSync(directory);write(path.join(directory,'request.json'),request);
    const queued=performance.now(),start={event:'queued',attempt_id,request_id,stage,role,regime:assignment.regime,model,
      queued_at:stamp(),payload_sha256:stableHash(payload),request_sha256:hash(request)};
    append(path.join(output,'queue-events.jsonl'),start);
    const dispatch=async()=>{
      const record={...start,event:'completed',dispatched_at:stamp(),queue_wait_ms:performance.now()-queued,
        actual_http_post:false,filesystem_dispatch:false,response_status:null,error:null};
      const began=performance.now();let submitted=false;
      try {
        if(fatal)throw fatal;
        if(options.signal?.aborted||cancelSignal?.aborted)throw new InfrastructureError('request_cancelled_before_dispatch');
        const replay=backend.replay?.(request);
        if(replay) {
          write(path.join(directory,'response.json'),replay.reply);
          const raw=Buffer.from(JSON.stringify(replay.reply.response));fs.writeFileSync(path.join(directory,'response.bin'),raw);
          record.response_status=replay.reply.status;record.raw_response_sha256=hash(raw);
          record.model_proof=verifyReply(replay.reply,request,replay.identity);record.reply_sha256=hash(replay.reply);
          record.reused_prior_response=true;record.prior_response_sha256=replay.source_sha256;
          return new Response(raw,{status:replay.reply.status,headers:{'content-type':'application/json'}});
        }
        const receipt=await backend.write(request);submitted=true;record.filesystem_dispatch=true;record.queue_request_reused=receipt?.reused===true;
        const deadline=performance.now()+timeoutMs;
        for(;;) {
          if(options.signal?.aborted||cancelSignal?.aborted)throw new InfrastructureError('queue_request_cancelled');
          if(performance.now()>=deadline)throw new InfrastructureError('queue_response_missing_before_deadline');
          const reply=await backend.read(request_id);
          if(reply) {
            write(path.join(directory,'response.json'),reply);
            const raw=Buffer.from(JSON.stringify(reply.response));fs.writeFileSync(path.join(directory,'response.bin'),raw);
            record.response_status=reply.status;record.raw_response_sha256=hash(raw);
            const proof=verifyReply(reply,request,identity);
            record.model_proof=proof;record.reply_sha256=hash(reply);
            return new Response(raw,{status:reply.status,headers:{'content-type':'application/json','X-Evaluation-FS-Request-ID':request_id}});
          }
          await pause(backend.pollMs??25);
        }
      } catch(error) {
        fatal=error instanceof InfrastructureError?error:new InfrastructureError('queue_transport_failed',error.message);
        record.error=fatal.code;
        if(submitted&&cancelSignal?.aborted)try{await backend.cancel(request_id);record.cancel_requested=true;}catch(cancel){record.cancel_error=cancel.code||cancel.name;}
        throw fatal;
      } finally {
        record.completed_at=stamp();record.wall_ms=performance.now()-began;
        write(path.join(directory,'response-meta.json'),record);append(path.join(output,'queue-events.jsonl'),record);records.push(record);
      }
    };
    const result=serial.then(dispatch);serial=result.catch(()=>{});return result;
    } catch(error) {
      fatal=error instanceof InfrastructureError?error:new InfrastructureError('invalid_gateway_request',error.message);
      throw fatal;
    }
  };
  return {generatorFetch:makeFetch('generator'),reviewerFetch:makeFetch('reviewer'),records,
    settled:()=>serial,failure:()=>fatal,actual_http_posts:0};
}

export function summarize(assignments,results,interrupted=[]) {
  const by_regime=Object.fromEntries(REGIMES.map(regime=>{
    const assigned=assignments.filter(row=>row.regime===regime.id),observed=results.filter(row=>row.regime===regime.id),
      partial=interrupted.filter(row=>row.regime===regime.id),numerator=observed.filter(row=>row.m02_complete).length;
    return [regime.id,{assigned_count:assigned.length,numerator,denominator:assigned.length,completed_case_count:observed.length,
      failed_count:observed.filter(row=>row.status==='failed').length,not_run_count:assigned.length-observed.length-partial.length,
      infrastructure_interrupted_case_count:partial.length,value:observed.length===assigned.length?numerator/assigned.length:null}];
  }));
  const compare=(id,scope)=>({baseline_value:by_regime.baseline.value,candidate_value:by_regime[id].value,
    difference:by_regime.baseline.value!==null&&by_regime[id].value!==null?by_regime[id].value-by_regime.baseline.value:null,
    denominator_per_regime:6,paired_source_groups:6,comparison_scope:scope,ci95:null});
  return {schema:'ubuntu-controlled-full-flow-summary-v1',status:interrupted.length?'infrastructure_interrupted':results.length===18?'completed':'running',
    assigned:18,completed:results.length,assigned_count:18,completed_case_count:results.length,
    failed_count:results.filter(row=>row.status==='failed').length,not_run_count:18-results.length-interrupted.length,
    infrastructure_interrupted_case_count:interrupted.length,actual_http_posts:0,
    filesystem_dispatch_count:[...results,...interrupted].reduce((n,row)=>n+row.filesystem_dispatch_count,0),
    filesystem_dispatch_unit:'request file atomically submitted to resident queue; not an HTTP POST',
    results,interrupted_cases:interrupted,M02:{by_regime,comparisons:{
      B_reviewer_vs_baseline:compare('B_reviewer','reviewer_effect_writer_fixed_baseline'),
      C_combined_vs_baseline:compare('C_combined','combined_configuration_effect_not_isolated_generator_effect')}}};
}

async function dependencies(root) {
  const frozen=path.join(root,'frozen-source');
  const [helpers,{ModelGateway},{modelStageRole},{sourceFingerprint}]=await Promise.all([
    import(pathToFileURL(path.join(frozen,'ai/scripts/run_controlled_full_flow.mjs'))),
    import(pathToFileURL(path.join(frozen,'app/src/model.js'))),
    import(pathToFileURL(path.join(frozen,'app/src/model-operation-metrics.js'))),
    import(pathToFileURL(path.join(frozen,'app/src/source-identity.js'))),
  ]);
  return {helpers,Gateway:ModelGateway,modelStageRole,sourceFingerprint,
    questions:read(path.join(frozen,'ai/local_api/agent_data/questions.json'))};
}
export async function run({root,work,queue,remoteHost=null,remoteRoot=null,backend=null,deps=null,signal=null,resumeFrom=null}) {
  root=fs.realpathSync(root);const workRoot=fs.realpathSync(path.join(root,'work'));
  work=path.resolve(work);ensure(work.startsWith(workRoot+path.sep)&&!fs.existsSync(work),'fresh_confined_flow_output_required');
  canonicalDirectory(work);
  const identity=pinIdentity(root);deps=deps||await dependencies(root);
  const {helpers,Gateway,questions,modelStageRole}=deps;
  ensure(stableHash({...helpers.PROFILE,agentFormat:'prompt'})===stableHash(PROFILE),'frozen_application_profile_changed');
  const fixtures=helpers.buildFixtures();ensure(fixtures.length===6,'six_frozen_fixtures_required');
  const contexts=fixtures.map(fixture=>helpers.contextFromFixture(fixture,questions));
  const assignments=fixtures.flatMap((fixture,index)=>REGIMES.map((_,offset)=>REGIMES[(index+offset)%3]).map(regime=>({
    regime:regime.id,case_id:fixture.case_id,root_lineage_id:fixture.root_lineage_id,context:contexts[index],
    context_sha256:hash(contexts[index]),logical_case_id:regime.id+':'+fixture.case_id,writer_model:regime.writer,reviewer_model:regime.reviewer})));
  backend=backend||(remoteHost?remoteQueueBackend({host:remoteHost,remoteRoot}):localQueueBackend(queue));
  if(remoteHost)ensure(queue===remoteRoot+'/work/fs-requests','remote_queue_path_changed');
  else if(!backend.description||backend.description.kind==='local_filesystem_queue')ensure(path.resolve(queue).startsWith(workRoot+path.sep),'queue_outside_work');
  const source=deps.sourceFingerprint(path.join(root,'frozen-source/app'));
  const metadata={schema:'ubuntu-controlled-full-flow-run-v1',created_at:stamp(),protocol_sha256:identity.protocol_sha256,
    runtime_sha256:identity.runtime_sha256,source_manifest_sha256:identity.source_manifest_sha256,
    application_source:source,fixtures_sha256:hash(fixtures),assignments_sha256:hash(assignments),
    collector_sha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),profile:PROFILE,wire:WIRE,regimes:REGIMES,
    transport:backend.description,actual_http_posts:0,formal_human_metrics_measured:false};
  write(path.join(work,'metadata.json'),metadata);write(path.join(work,'fixtures.json'),fixtures);write(path.join(work,'assignments.json'),assignments);
  const results=[],interrupted=[];
  const resumeSpec=fs.existsSync(path.join(root,'RESUME.json'))?read(path.join(root,'RESUME.json')):null;
  if(resumeSpec) {
    const priorRoot=path.join(root,'prior');
    for(const [relative,expected] of Object.entries(resumeSpec.prior_file_sha256)) {
      ensure(!path.isAbsolute(relative)&&!relative.split(path.sep).includes('..'),'unsafe_prior_binding');
      const file=path.join(priorRoot,relative);ensure(fs.realpathSync(file)===file&&hash(fs.readFileSync(file))===expected,'prior_evidence_bytes_changed');
    }
    const oldIdentity=pinIdentity(priorRoot);
    ensure(oldIdentity.base_model_digest===identity.base_model_digest,'resume_base_identity_changed');
    for(const id of ['baseline','B_original','C_user_provided'])ensure(oldIdentity.models.get(id).adapter_sha256===identity.models.get(id).adapter_sha256,'resume_adapter_changed');
    const priorQueue=path.join(priorRoot,'queue');
    backend.replay=request=>{
      const requestPath=path.join(priorQueue,request.request_id,'request.json'),replyPath=path.join(priorQueue,request.request_id,'response.json');
      if(!fs.existsSync(replyPath))return null;
      ensure(stableHash(read(requestPath))===stableHash(request),'prior_request_payload_changed');
      ensure(resumeSpec.prior_file_sha256[path.relative(priorRoot,replyPath)]===hash(fs.readFileSync(replyPath)),'prior_response_bytes_changed');
      return {reply:read(replyPath),identity:oldIdentity,source_sha256:hash(fs.readFileSync(replyPath))};
    };
    resumeFrom=resumeFrom||path.join(priorRoot,'full-flow');
  }
  if(resumeFrom) {
    resumeFrom=fs.realpathSync(resumeFrom);const old=read(path.join(resumeFrom,'summary.json'));
    ensure(old.assigned_count===18,'resume_assignment_count_changed');
    for(const result of old.results) {
      const assignment=assignments.find(row=>row.logical_case_id===result.logical_case_id);
      ensure(assignment&&assignment.context_sha256===result.context_sha256&&['failed','output_received'].includes(result.status),'invalid_prior_terminal_case');
      const name=result.logical_case_id.replace(':','-');
      fs.cpSync(path.join(resumeFrom,name),path.join(work,name),{recursive:true,errorOnExist:true,force:false});
      results.push(result);append(path.join(work,'results.jsonl'),result);
    }
    write(path.join(work,'resume-provenance.json'),{source:resumeFrom,summary_sha256:hash(fs.readFileSync(path.join(resumeFrom,'summary.json'))),terminal_cases_reused:results.length,prior_interrupted_cases:old.interrupted_cases?.length||0,prior_terminal_cases_rerun:false});
  }
  const saveSummary=()=>{const value=summarize(assignments,results,interrupted);write(path.join(work,'summary.json'),value);return value;};
  saveSummary();
  for(const assignment of assignments) {
    if(results.some(result=>result.logical_case_id===assignment.logical_case_id))continue;
    const directory=path.join(work,assignment.logical_case_id.replace(':','-'));fs.mkdirSync(directory);
    write(path.join(directory,'assignment.json'),assignment);
    const stages=[],trace=[],transport=createTransport({output:directory,assignment,backend,identity,modelStageRole,cancelSignal:signal});
    const diagnosticLogger=entry=>{trace.push(entry);append(path.join(directory,'diagnostics.jsonl'),entry);};
    const common={...PROFILE,baseUrl:'http://127.0.0.1/v1',apiKey:'filesystem-evaluation-only',diagnosticLogger};
    const reviewer=new Gateway({...common,model:assignment.reviewer_model,fetchImpl:transport.reviewerFetch});
    const writer=new Gateway({...common,model:assignment.writer_model,fetchImpl:transport.generatorFetch,reviewGateway:reviewer});
    helpers.instrumentStages(reviewer,'reviewer',directory,stages);helpers.instrumentStages(writer,'generator',directory,stages);
    const record={...assignment,context:undefined,started_at:stamp(),status:'running',m02_complete:false};let result;
    try {
      result=await writer.respond(structuredClone(assignment.context));record.m02_complete=helpers.finalContract(result);
      if(!record.m02_complete)throw new Error('final_completion_contract_failed');
      record.status='output_received';record.final_output_sha256=hash(result);write(path.join(directory,'final-output.json'),result);
    }catch(error){record.status='failed';record.error=error.code||error.name;record.reason=error.modelReason||error.message;}
    await transport.settled();
    record.completed_at=stamp();record.actual_http_posts=0;
    record.filesystem_dispatch_count=transport.records.filter(row=>row.filesystem_dispatch).length;
    record.model_request_failures=transport.records.filter(row=>row.response_status>=400).length;
    record.stages=stages;record.retry_attempt_count=trace.filter(row=>row.event==='model_attempt'&&row.attempt>1).length;
    const partial=stages.filter(row=>row.status==='validated_output').map(row=>({stage:row.stage,output_sha256:row.output_sha256,output:read(path.join(directory,row.output_path))}));
    record.auxiliary=helpers.auxiliaryChecks(result,assignment.context,partial);
    if(transport.failure()) {
      record.status='infrastructure_interrupted';record.error=transport.failure().code;
      write(path.join(directory,'interrupted-result.json'),record);interrupted.push(record);saveSummary();break;
    }
    write(path.join(directory,'result.json'),record);append(path.join(work,'results.jsonl'),record);results.push(record);saveSummary();
  }
  return saveSummary();
}

async function cli() {
  const args=process.argv.slice(2),options={};while(args.length){const key=args.shift(),value=args.shift();ensure(key?.startsWith('--')&&value,'expected_named_arguments');options[key.slice(2)]=value;}
  ensure(options.root&&options.work&&options.queue,'root_work_queue_required');
  const controller=new AbortController();
  process.once('SIGTERM',()=>controller.abort());process.once('SIGINT',()=>controller.abort());
  const result=await run({root:options.root,work:options.work,queue:options.queue,remoteHost:options['remote-host'],remoteRoot:options['remote-root'],signal:controller.signal,resumeFrom:options['resume-from']});
  console.log(JSON.stringify(result));if(result.status!=='completed')process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await cli();
