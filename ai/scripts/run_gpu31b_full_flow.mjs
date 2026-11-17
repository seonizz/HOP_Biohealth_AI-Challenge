// Remote-manifest 31B evaluation of the real app via a supervised loopback SSH bridge.
// Source 12B evaluation/app files remain unchanged; prompt-only transport is explicit.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ModelGateway} from '../../app/src/model.js';
import {modelStageRole} from '../../app/src/model-operation-metrics.js';
import {sourceFingerprint} from '../../app/src/source-identity.js';
import {SPEECH_PARTS} from '../../app/src/relationship-prompts.js';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const REMOTE_ROOTS=['/home/slim/choieram/model_Training/gpu31b_controlled_20261112_v13',
  '/home/slim/choieram/model_Training/gpu31b_controlled_20261112_v13_r2'];
export const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const timestamp=()=>new Date().toISOString();
function write(file,value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.tmp',fd=fs.openSync(temp,'w');
  try {fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fs.renameSync(temp,file);
}
function append(file,value) {
  const fd=fs.openSync(file,'a');
  try {fs.writeFileSync(fd,JSON.stringify(value)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
export const PROFILE=Object.freeze({protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'none',
  timeoutMs:900000,stateMode:'combined',skipFinalExtras:false,reuseFinalDraft:true,
  bundleCombinedTurnReviews:true,bundleAnalysisPlan:true,bundleFinalReviews:true,
  compactReviewInputs:true,compactReviewOutput:false,stageScopedQuestionRules:true,
  retryFailures:false,streamJson:false,discoverTokenLimits:false});
export const WIRE=Object.freeze({temperature:0,seed:3407,max_tokens:8192,cache_prompt:false,stream:false});

export function buildFixtures() {
  const variants=[
    ['question','서우','서우는 같이 산책할 날짜는 이미 정했다고 했어요. 산책 중 무엇을 말할지는 아직 정하지 않았어요.'],
    ['attribution','가람','가람은 저녁에 피곤하다고 말했어요. 저는 아침에 피곤해요. 서로 다른 사람의 상태예요.'],
    ['correction','유담','처음에는 사흘 전 만났다고 썼지만 정정할게요. 어제 만났어요. 현재 기록은 어제가 맞아요.'],
    ['unknown','하온','하온이 쉬고 싶은 이유는 아직 듣지 못했어요. 이유는 모르는 상태로 남겨 두고 싶어요.'],
    ['review','리안','리안은 조용히 차를 마시는 건 괜찮지만 단체 모임은 원하지 않는다고 말했어요.'],
    ['consent','이솔','이솔은 자기 이야기를 다른 사람에게 전하지 말아 달라고 했어요. 연락처를 공유하거나 대신 연락할 허락은 없어요.'],
  ];
  return variants.map(([lineage,name,description],index)=>({case_id:hash('controlled-full-flow-v13:'+index).slice(0,16),
    root_lineage_id:'full-flow:'+lineage,template_family_id:lineage,synthetic:true,
    answers:{name,want:`${name}의 의사를 먼저 묻고 제 가능한 범위에서 대화를 시작하고 싶어요.`,
      goal:'차분하게 대화를 시작하고 싶어요.',rel:'성인 친구예요.',contact:'매주 한 번 안부를 나눠요.',
      mood:`${name}은 이번 주에 피곤하다고 말했어요.`,describe:description,
      support:`${name}이 누구에게 더 도움을 받고 싶은지는 아직 듣지 못했어요.`,
      need:'원하는 도움부터 물어보고 동의한 범위에서만 함께하고 싶어요.',
      feeling:'신경이 쓰이지만 제 저녁 휴식 시간도 지키고 싶어요.',
      cgchange:'제 생활 일정은 그대로 유지하고 있어요.',mysupport:{status:'unknown',text:'지금은 누구에게 이야기할지 정하지 못했어요.'}}}));
}

export function contextFromFixture(fixture,questions) {
  const context={schema_version:'1.0',patient:{alias:fixture.answers.name,fields:{}},supporter:{role:'informant',fields:{}},
    user_goal:{},answered_count:Object.keys(fixture.answers).length,question_candidates:[],name_index:null};
  const active=[];
  for(const row of questions) {
    const value=fixture.answers[row.id];if(value===undefined)continue;
    const text=typeof value==='string'?value:value.text;
    const entry={id:row.id,status:typeof value==='string'?'answered':value.status,
      question:row.definition.q,source:'app_user_report',text,rawText:text,custom:''};
    if(row.subject==='user_goal')context.user_goal[row.id==='want'?'message':'desired_outcomes']=entry;
    else context[row.subject].fields[row.id]=entry;
    active.push(row);
  }
  if(active.length!==Object.keys(fixture.answers).length)throw new Error('fixture_has_unknown_question');
  const latest=active.at(-1);context.latest_answer={subject:latest.subject,question_id:latest.id};
  return context;
}

export function prepare(root,{remoteRoot=REMOTE_ROOTS[1]}={}) {
  if(!REMOTE_ROOTS.includes(remoteRoot))throw new Error('unregistered_remote_task_root');
  if(fs.existsSync(path.join(root,'protocol.json')))throw new Error('frozen_panel_already_exists');
  fs.mkdirSync(root,{recursive:true});
  const questions=read(path.join(repository,'ai/local_api/agent_data/questions.json'));
  const fixtures=buildFixtures(),contexts=fixtures.map(f=>contextFromFixture(f,questions));
  const assignments=fixtures.flatMap((fixture,index)=>(index%2?['trained','baseline']:['baseline','trained']).map(arm=>({
    arm,case_id:fixture.case_id,root_lineage_id:fixture.root_lineage_id,context:contexts[index],context_sha256:hash(contexts[index]),
    logical_case_id:arm+':'+fixture.case_id,queued_at:null})));
  const source=sourceFingerprint(path.join(repository,'app'));
  const protocol={schema:'malssi-gpu31b-controlled-full-flow-v1',panel:'controlled_auto_pilot',contract_variant:'production_prompt_transport',
    model_parameter_class:'31B',transport_profile:'hf_worker_prompt_no_grammar_enforcement',
    expected_remote_root:remoteRoot,
    created_at:timestamp(),generator_comparison:true,fixed_reviewer:{arm:'baseline',lora_scale:0},profile:PROFILE,wire:WIRE,
    assigned_cases:12,root_lineage_count:6,first_request_panel_denominator:false,
    wire_output_budget_policy:'8192-token upper bound; application-requested lower budgets preserved',
    retry_policy:{http_max_attempts_per_generation:3,operation_restarts:false,
      semantic_repair_policy:'unchanged application source; bounded loops identified by source hash'},
    source,collector_sha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),
    questions_sha256:hash(fs.readFileSync(path.join(repository,'ai/local_api/agent_data/questions.json'))),
    fixtures_sha256:hash(fixtures),assignments_sha256:hash(assignments),
    required_completion:'ModelGateway.respond returns validated final guide with agent.reviewed and quality_reviewed, original mandatory review paths retained',
    auxiliary_scope:'partial automatic structural/source-reference checks only; not human M14-M18',
    gpu_server_access:'explicitly_reauthorized_by_user_supervised_worker_only'};
  write(path.join(root,'fixtures.json'),fixtures);write(path.join(root,'assignments.json'),assignments);
  write(path.join(root,'protocol.json'),protocol);
  return protocol;
}

function assertLocal(endpoint) {
  const url=new URL(endpoint);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=='/v1')
    throw new Error('dedicated_loopback_v1_endpoint_required');
  return url;
}

// The app may schedule reviews concurrently; one shared gate serializes their
// actual HTTP dispatch and records its queue separately from upstream time.
export function createTransport({output,endpoint,arm,fetchImpl=fetch,workerReadySha256=null,onFatal=()=>{}}) {
  const origin=assertLocal(endpoint).origin;
  fs.mkdirSync(path.join(output,'http'),{recursive:true});
  let serial=Promise.resolve(),counter=0,fatalCause=null,fatalError=null;
  const records=[];
  const infrastructure=(reason,phase,status=null)=>{
    if(!fatalCause) {
      fatalCause={time:timestamp(),reason,phase,http_status:status};
      fatalError=Object.assign(new Error('EVALUATION_INFRASTRUCTURE_INTERRUPTED'),{code:'EVALUATION_INFRASTRUCTURE_INTERRUPTED'});
      write(path.join(output,'infrastructure-error.json'),fatalCause);onFatal(fatalError);
    }
    return fatalError;
  };
  const makeFetch=role=>async(url,options={})=>{
    if(fatalCause)throw fatalError;
    if(url!==endpoint+'/chat/completions'||options.method!=='POST')throw new Error('unexpected_gateway_route');
    const payload=JSON.parse(options.body),stage=JSON.parse(payload.messages.at(-1).content).stage;
    if((modelStageRole(stage)==='reviewer')!==(role==='reviewer'))throw new Error('gateway_role_routing_mismatch');
    const wire={...payload,...WIRE,max_tokens:Math.min(payload.max_tokens??WIRE.max_tokens,WIRE.max_tokens),
      lora:[{id:0,scale:role==='reviewer'||arm==='baseline'?0:1}]};
    const queued=performance.now(),queued_at=timestamp(),id=String(++counter).padStart(6,'0');
    const directory=path.join(output,'http',id);fs.mkdirSync(directory);
    const body=JSON.stringify(wire);fs.writeFileSync(path.join(directory,'request.json'),body);
    const start={event:'queued',attempt_id:id,stage,role,arm,queued_at,request_sha256:hash(body),lora:wire.lora};
    append(path.join(output,'http-events.jsonl'),start);
    const dispatch=async()=>{
      const record={...start,event:'completed',dispatched_at:timestamp(),queue_wait_ms:performance.now()-queued,
        actual_post:false,http_status:null,raw_response_sha256:null,error:null};
      const began=performance.now();let raw=Buffer.alloc(0),response;
      try {
        if(fatalCause)throw fatalError;
        if(options.signal?.aborted)throw options.signal.reason||new Error('aborted_before_dispatch');
        let health;
        try {health=await fetchImpl(origin+'/health',{method:'GET',signal:options.signal,redirect:'error'});}
        catch(error){if(options.signal?.aborted)throw error;throw infrastructure(error.code||error.name,'pre_dispatch_health');}
        if(!health.ok)throw infrastructure('remote_worker_unavailable','pre_dispatch_health',health.status);
        let healthBody;
        try {healthBody=await health.json();}
        catch{throw infrastructure('remote_worker_health_metadata_invalid','pre_dispatch_health',health.status);}
        if(healthBody.status!=='ok'||workerReadySha256&&healthBody.worker_ready_sha256!==workerReadySha256)
          throw infrastructure('remote_worker_health_identity_changed','pre_dispatch_health',health.status);
        record.actual_post=true;
        response=await fetchImpl(origin+'/v1/chat/completions',{...options,body});
        record.http_status=response.status;record.response_headers=Object.fromEntries(response.headers);
        const chunks=[],reader=response.body?.getReader();
        if(reader) {
          try {for(;;){const item=await reader.read();if(item.done)break;chunks.push(Buffer.from(item.value));}}
          finally {raw=Buffer.concat(chunks);}
        }
        record.raw_response_sha256=hash(raw);
        fs.writeFileSync(path.join(directory,'response.bin'),raw);
        write(path.join(directory,'response-meta.json'),record);
        if(!response.headers.get('x-evaluation-worker-response-id')||!response.headers.get('x-evaluation-worker-reply-sha256'))
          throw infrastructure('remote_worker_reply_identity_missing','post_dispatch_transport',response.status);
        const headers=new Headers(response.headers);
        for(const field of ['content-length','content-encoding','transfer-encoding'])headers.delete(field);
        return new Response(raw,{status:response.status,statusText:response.statusText,headers});
      }catch(error){
        if(!fatalCause&&!options.signal?.aborted&&(error instanceof TypeError||['FetchError','SystemError'].includes(error.name)))
          error=infrastructure(error.code||error.name,'transport_io');
        record.error=error.code||error.name||'transport_error';
        fs.writeFileSync(path.join(directory,'response.bin'),raw);throw error;
      }finally{
        record.completed_at=timestamp();record.wall_ms=performance.now()-began;
        record.raw_response_sha256=hash(raw);write(path.join(directory,'response-meta.json'),record);
        append(path.join(output,'http-events.jsonl'),record);records.push(record);
      }
    };
    const promise=serial.then(dispatch);serial=promise.catch(()=>{});return promise;
  };
  return {generatorFetch:makeFetch('generator'),reviewerFetch:makeFetch('reviewer'),records,settled:()=>serial,
    get fatalCause(){return fatalCause;}};
}

function approvalFields(value,prefix='',found=[]) {
  if(!value||typeof value!=='object')return found;
  for(const [key,item]of Object.entries(value)) {
    const at=prefix?prefix+'.'+key:key;
    if(key==='approved'&&typeof item==='boolean')found.push({field:at,approved:item});
    else if(item&&typeof item==='object')approvalFields(item,at,found);
  }
  return found;
}
export function instrumentStages(gateway,role,output,stages) {
  const original=gateway.agentComplete.bind(gateway);
  gateway.agentComplete=async(...args)=>{
    const [stage,,payload,schema]=args;
    // The writer delegates review stages to the fixed reviewGateway. Only the
    // receiving gateway records that physical review, avoiding duplicate stages.
    if(role==='generator'&&modelStageRole(stage)==='reviewer')return original(...args);
    const id=String(stages.length+1).padStart(6,'0')+'-'+role+'-'+stage;
    const record={stage,role:modelStageRole(stage),gateway_origin:role,input_payload_sha256:hash(payload),schema_sha256:hash(schema),started_at:timestamp(),status:'started'};
    stages.push(record);write(path.join(output,'stages',id+'-input.json'),{stage,payload,schema});
    try {
      const value=await original(...args);
      record.status='validated_output';record.output_sha256=hash(value);record.approvals=approvalFields(value);
      record.output_path=path.join('stages',id+'-output.json');
      write(path.join(output,record.output_path),value);return value;
    }catch(error){record.status='failed';record.error=error.code||error.name;throw error;}
    finally{record.completed_at=timestamp();write(path.join(output,'stage-records.json'),stages);}
  };
}

export function finalContract(result) {
  const guide=result?.guide;
  if(!guide||result.agent?.reviewed!==true||result.agent?.quality_reviewed!==true||!Array.isArray(result.agent?.stages))return false;
  return typeof guide.script==='string'&&guide.script.trim().length>0&&Array.isArray(guide.doList)&&guide.doList.length>0&&
    Array.isArray(guide.avoid)&&guide.avoid.length>0&&typeof guide.next==='string'&&guide.next.trim().length>0&&Boolean(guide.care);
}

function inspectReferences(result,context) {
  const sources=new Map();
  for(const subject of ['patient','supporter'])for(const field of Object.values(context[subject].fields))sources.set(subject+':'+field.id,field.text);
  for(const field of Object.values(context.user_goal))sources.set('user_goal:'+field.id,field.text);
  const refs=[];
  function visit(value) {
    if(!value||typeof value!=='object')return;
    if(typeof value.subject==='string'&&typeof value.question_id==='string'&&typeof value.quote==='string') {
      const source=sources.get(value.subject+':'+value.question_id);
      refs.push({reference_sha256:hash(value),valid:typeof source==='string'&&source.includes(value.quote),
        attribution_violation:typeof source==='string'&&!source.includes(value.quote)&&[...sources.entries()].some(([key,text])=>!key.startsWith(value.subject+':')&&text.includes(value.quote))});
    }
    for(const item of Object.values(value))if(item&&typeof item==='object')visit(item);
  }
  visit(result);return refs;
}

export function auxiliaryChecks(result,context,partialOutputs=[]) {
  const partial=partialOutputs.map(item=>{
    const refs=inspectReferences(item.output,context);
    return {stage:item.stage,output_sha256:item.output_sha256,checked_reference_count:refs.length,
      invalid_reference_count:refs.filter(r=>!r.valid).length,
      known_attribution_violation_count:refs.filter(r=>r.attribution_violation).length,reference_checks:refs};
  });
  const partialDiscoveries={unit:'validated_stage_snapshot',snapshot_count:partial.length,
    known_attribution_violation_count:partial.reduce((n,r)=>n+r.known_attribution_violation_count,0),
    records:partial,scope:'Stage snapshots can overlap; counts are not unique claims or independent cases.'};
  if(!result)return {...Object.fromEntries(['A14','A15','A16','A18'].map(id=>[id,{value:null,status:'unobserved',reason:'final_output_not_available'}])),
    partial_discoveries:partialDiscoveries,
    A16:{value:null,status:'unobserved',reason:'final_output_not_available',
      any_observed_known_violation_count:partialDiscoveries.known_attribution_violation_count}};
  const refs=inspectReferences(result,context);
  const slots=finalContract(result),valid=refs.filter(r=>r.valid).length,violations=refs.filter(r=>r.attribution_violation).length;
  const detail=result.conversation_detail,parts=detail?Object.keys(SPEECH_PARTS).map(key=>detail[key]?.excerpt):[];
  const normalize=text=>text.replace(/\s+/gu,'');
  const detailMatch=parts.length===3&&parts.every(x=>typeof x==='string')?normalize(parts.join(''))===normalize(result.guide.script):null;
  return {
    A14:{metric_variant:'source_reference_and_required_slots',status:'partial_automatic_check',numerator:valid,denominator:refs.length,
      value:refs.length?valid/refs.length:null,required_slots_valid:slots,scope:'exact citation occurrence and required app fields only'},
    A15:{metric_variant:'structured_evidence_references_only',status:'partial_automatic_check',numerator:refs.length-valid,denominator:refs.length,
      value:refs.length?(refs.length-valid)/refs.length:null,scope:'unsupported reference incidence; no free-text assertion extraction or full hallucination rate'},
    A16:{metric_variant:'cross_subject_citation_pattern',status:'partial_automatic_check',found_count:violations,checked_count:refs.length,
      value:refs.length?violations/refs.length:null,
      any_observed_known_violation_count:violations+partialDiscoveries.known_attribution_violation_count,
      scope:'known literal attribution violations only; stage snapshots can overlap; zero does not establish absence of major errors'},
    A18:{metric_variant:'required_slots_and_script_detail_equality',status:'partial_automatic_check',required_slots_valid:slots,
      script_detail_equal:detailMatch,value:detailMatch===null?null:Number(slots&&detailMatch),scope:'field roles and exact excerpt equality only; no naturalness judgment'},
    reference_checks:refs,
    partial_discoveries:partialDiscoveries,
  };
}

const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
export async function serverIdentity(endpoint,workerReady,fetchImpl,expectedRemoteRoot=null) {
  const origin=assertLocal(endpoint).origin;
  const expected=read(workerReady);
  const metadata=async route=>{
    let response;
    try {response=await fetchImpl(origin+route);}
    catch(error){throw Object.assign(new Error('remote_worker_unavailable'),{code:'REMOTE_WORKER_UNAVAILABLE',phase:route,reason:error.code||error.name});}
    if(!response.ok)throw Object.assign(new Error('remote_worker_unavailable'),{code:'REMOTE_WORKER_UNAVAILABLE',http_status:response.status,phase:route});
    return response.json();
  };
  const props=await metadata('/props'),adapters=await metadata('/lora-adapters');
  if(expected.model!=='malssi-gemma4-31b-controlled'||!REMOTE_ROOTS.includes(expected.remote_root)||expectedRemoteRoot&&expected.remote_root!==expectedRemoteRoot||
    props.identity_kind!=='verified_remote_worker_manifest'||hash(sorted(props.worker_ready))!==hash(sorted(expected))||
    props.base_model_digest?.kind!=='remote_directory_manifest_sha256'||props.base_model_digest?.value!==expected.base_manifest_sha256||
    props.model_path!==expected.base_model_path||!Array.isArray(adapters)||adapters.length!==1||adapters[0].id!==0||
    adapters[0].path!==expected.adapter_path||adapters[0].adapter_file_sha256!==expected.adapter_file_sha256)
    throw new Error('verified_remote_worker_identity_mismatch');
  return {props,adapters,pinned_ready_file_sha256:hash(fs.readFileSync(workerReady)),
    remote_model_identity:{identity_kind:props.identity_kind,base_model_path:props.base_model_path,
      base_model_digest:props.base_model_digest,adapter_path:props.adapter_path,
      adapter_file_sha256:props.adapter_file_sha256,adapter_tensor_digest:props.adapter_tensor_digest,
      tokenizer_manifest_sha256:props.tokenizer_manifest_sha256,worker_ready_sha256:props.worker_ready_sha256}};
}

export async function run({root,output,endpoint='http://127.0.0.1:11440/v1',workerReady,fetchImpl=fetch,Gateway=ModelGateway}) {
  root=path.resolve(root);output=path.resolve(output);workerReady=fs.realpathSync(workerReady);
  if(fs.existsSync(output))throw new Error('fresh_output_directory_required');
  fs.mkdirSync(output,{recursive:true});
  const protocol=read(path.join(root,'protocol.json')),fixtures=read(path.join(root,'fixtures.json')),assignments=read(path.join(root,'assignments.json'));
  if(protocol.fixtures_sha256!==hash(fixtures)||protocol.assignments_sha256!==hash(assignments)||assignments.length!==12||hash(protocol.profile)!==hash(PROFILE)||hash(protocol.wire)!==hash(WIRE)||protocol.collector_sha256!==hash(fs.readFileSync(fileURLToPath(import.meta.url))))throw new Error('frozen_protocol_binding_mismatch');
  if(protocol.source.sha256!==sourceFingerprint(path.join(repository,'app')).sha256)throw new Error('application_source_changed_after_freeze');
  write(path.join(output,'assignments.json'),assignments);
  const metadata={schema:'malssi-gpu31b-controlled-full-flow-run-v1',started_at:timestamp(),endpoint,protocol_sha256:hash(protocol),
    model_parameter_class:'31B',identity_kind:'verified_remote_worker_manifest',
    pinned_worker_ready_file_sha256:hash(fs.readFileSync(workerReady)),
    transport_profile:'hf_worker_prompt_no_grammar_enforcement',
    collector_sha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),wire:WIRE,profile:PROFILE};
  write(path.join(output,'metadata.json'),metadata);
  const results=[];let infrastructureFailure=null;
  const summarize=()=>({status:infrastructureFailure?'infrastructure_interrupted':results.length===assignments.length?'completed':'running',
    ...(infrastructureFailure?{infrastructure_error:infrastructureFailure}:{}),assigned_count:assignments.length,
    completed_case_count:results.length,failed_count:results.filter(r=>r.status==='failed').length,not_run_count:assignments.length-results.length,
    M02:{numerator:results.filter(r=>r.m02_complete).length,denominator:assignments.length,
      value:results.length===assignments.length?results.filter(r=>r.m02_complete).length/assignments.length:null,
      aggregate_scope:'operational completion across assigned cases; use by_arm for model comparison',
      by_arm:Object.fromEntries(['baseline','trained'].map(arm=>{
        const assigned=assignments.filter(r=>r.arm===arm).length,observed=results.filter(r=>r.arm===arm),
          numerator=observed.filter(r=>r.m02_complete).length;
        return [arm,{numerator,denominator:assigned,failed_count:observed.filter(r=>r.status==='failed').length,
          not_run_count:assigned-observed.length,value:observed.length===assigned?numerator/assigned:null}];
      }))},
    actual_posts:results.reduce((n,r)=>n+r.actual_posts,0),results});
  write(path.join(output,'summary.json'),summarize());
  try {metadata.server_identity=await serverIdentity(endpoint,workerReady,fetchImpl,protocol.expected_remote_root||read(workerReady).remote_root);
    metadata.remote_model_identity=metadata.server_identity.remote_model_identity;write(path.join(output,'metadata.json'),metadata);}
  catch(error){
    const failure={error:error.message,code:error.code,http_status:error.http_status,phase:error.phase,time:timestamp()};
    write(path.join(output,'preflight-error.json'),failure);
    if(error.code==='REMOTE_WORKER_UNAVAILABLE')infrastructureFailure=failure;
    write(path.join(output,'summary.json'),{...summarize(),status:infrastructureFailure?'infrastructure_interrupted':'blocked_identity'});throw error;
  }
  for(const assignment of assignments) {
    const started=performance.now(),directory=path.join(output,assignment.logical_case_id.replace(':','-'));
    fs.mkdirSync(directory);const trace=[],stages=[];
    const record={...assignment,context:undefined,status:'running',started_at:timestamp(),m02_complete:false};
    write(path.join(directory,'assignment.json'),{...assignment,queued_at:record.started_at});
    const cancellation=new AbortController();
    const transport=createTransport({output:directory,endpoint,arm:assignment.arm,fetchImpl,
      workerReadySha256:metadata.remote_model_identity.worker_ready_sha256,onFatal:error=>cancellation.abort(error)});
    const diagnosticLogger=entry=>{trace.push(entry);append(path.join(directory,'diagnostics.jsonl'),entry);};
    const common={...PROFILE,baseUrl:endpoint,apiKey:'local-evaluation-only',model:metadata.server_identity.props.model_alias||'a-original-controlled',diagnosticLogger};
    const reviewer=new Gateway({...common,fetchImpl:transport.reviewerFetch});
    const writer=new Gateway({...common,fetchImpl:transport.generatorFetch,reviewGateway:reviewer});
    instrumentStages(reviewer,'reviewer',directory,stages);instrumentStages(writer,'generator',directory,stages);
    let result;
    try {
      result=await writer.respond(structuredClone(assignment.context),null,{signal:cancellation.signal});
      record.m02_complete=finalContract(result);
      if(!record.m02_complete)throw new Error('final_completion_contract_failed');
      record.status='output_received';record.final_output_sha256=hash(result);write(path.join(directory,'final-output.json'),result);
    }catch(error){record.status='failed';record.error=error.code||error.name;record.reason=error.modelReason||error.message;}
    await transport.settled();
    record.completed_at=timestamp();record.wall_ms=performance.now()-started;
    record.actual_posts=transport.records.filter(r=>r.actual_post).length;
    record.http_errors=transport.records.filter(r=>r.error||r.http_status>=400).length;
    record.queue_wait_ms=transport.records.reduce((n,r)=>n+r.queue_wait_ms,0);
    record.retries=trace.filter(r=>r.event==='model_attempt'&&r.attempt>1).length;
    record.logical_generations=new Set(trace.filter(r=>r.generation_id).map(r=>r.generation_id)).size;
    record.stages=stages;
    const partialOutputs=stages.filter(row=>row.status==='validated_output').map(row=>({
      stage:row.stage,output_sha256:row.output_sha256,output:read(path.join(directory,row.output_path))}));
    record.auxiliary=auxiliaryChecks(result,assignment.context,partialOutputs);
    if(transport.fatalCause){infrastructureFailure=transport.fatalCause;record.infrastructure_error=transport.fatalCause;}
    write(path.join(directory,'result.json'),record);append(path.join(output,'results.jsonl'),record);results.push(record);
    write(path.join(output,'summary.json'),summarize());
    console.log(JSON.stringify({case_id:record.case_id,arm:record.arm,status:record.status,actual_posts:record.actual_posts,finished_cases:results.length}));
    if(infrastructureFailure)break;
  }
  return summarize();
}

async function hashFile(file) {
  const digest=createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);return digest.digest('hex');
}

async function cli() {
  const args=process.argv.slice(2),mode=args.shift(),options={};
  while(args.length){const key=args.shift(),value=args.shift();if(!key?.startsWith('--')||!value)throw new Error('expected_named_arguments');options[key.slice(2)]=value;}
  const root=options.root||path.join(repository,'runtime/gpu31b-controlled-20261112-v13/full-flow');
  if(mode==='--prepare')console.log(JSON.stringify(prepare(root,{remoteRoot:options['remote-root']||REMOTE_ROOTS[1]}),null,2));
  else if(mode==='--run') {
    if(!options.output||!options['worker-ready'])throw new Error('run_requires_output_worker_ready');
    const result=await run({root,output:options.output,workerReady:options['worker-ready'],endpoint:options.endpoint});
    console.log(JSON.stringify(result,null,2));if(result.status!=='completed')process.exitCode=1;
  }else throw new Error('Use --prepare [--root DIR] or --run --root DIR --output FRESH_DIR --worker-ready PINNED_READY_JSON [--endpoint URL]');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await cli();
