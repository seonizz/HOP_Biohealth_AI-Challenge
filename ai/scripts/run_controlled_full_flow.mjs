// Dedicated local evaluation of the real application pipeline. No app settings change.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ModelGateway} from '../../app/src/model.js';
import {modelStageRole} from '../../app/src/model-operation-metrics.js';
import {sourceFingerprint} from '../../app/src/source-identity.js';
import {SPEECH_PARTS} from '../../app/src/relationship-prompts.js';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
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
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
const same=(a,b)=>hash(sorted(a))===hash(sorted(b));
export const PROFILE=Object.freeze({protocol:'relationship_agent',agentFormat:'json_schema',reasoningEffort:'none',
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

function treeManifest(directory,prefix,manifest={}) {
  for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
    const file=path.join(directory,entry.name),relative=path.join(prefix,entry.name);
    if(entry.isSymbolicLink())throw new Error('resume_symlink_not_allowed');
    if(entry.isDirectory())treeManifest(file,relative,manifest);
    else if(entry.isFile())manifest[relative]=hash(fs.readFileSync(file));
  }
  return manifest;
}

function loadResume(sourceRun) {
  const run=fs.realpathSync(sourceRun),parent=path.dirname(run);
  const protocol=read(path.join(parent,'full-flow/protocol.json')),metadata=read(path.join(run,'metadata.json'));
  const assignments=read(path.join(run,'assignments.json')),configured=read(path.join(parent,'full-flow/assignments.json'));
  if(!same(assignments,configured)||assignments.length!==12||hash(assignments)!==protocol.assignments_sha256)
    throw new Error('resume_original_assignment_mismatch');
  if(metadata.protocol_sha256!==hash(protocol)||metadata.collector_sha256!==protocol.collector_sha256||
    !same(metadata.profile,protocol.profile)||!same(metadata.wire,protocol.wire))throw new Error('resume_original_protocol_mismatch');
  const snapshot=path.join(parent,'frozen-source/ai/scripts/run_controlled_full_flow.mjs');
  if(hash(fs.readFileSync(snapshot))!==protocol.collector_sha256)throw new Error('resume_original_collector_mismatch');
  if(hash(protocol.source.files)!==protocol.source.sha256)throw new Error('resume_original_source_manifest_mismatch');
  for(const file of protocol.source.files) {
    const target=path.resolve(parent,'frozen-source/app',file.path),scope=path.resolve(parent,'frozen-source/app');
    if(!target.startsWith(scope+path.sep)||hash(fs.readFileSync(target))!==file.sha256)throw new Error('resume_original_application_source_mismatch');
  }
  const raw=fs.readFileSync(path.join(run,'results.jsonl'));
  if(raw.length&&!raw.toString().endsWith('\n'))throw new Error('resume_incomplete_result_line');
  const results=raw.toString().split('\n').filter(Boolean).map(line=>JSON.parse(line)),seen=new Set(),manifest={};
  for(const record of results) {
    const assignment=assignments.find(row=>row.logical_case_id===record.logical_case_id);
    if(!assignment||seen.has(record.logical_case_id)||!['failed','output_received'].includes(record.status)||
      record.m02_complete!==(record.status==='output_received')||record.arm!==assignment.arm||record.context_sha256!==assignment.context_sha256)
      throw new Error('resume_invalid_terminal_outcome');
    seen.add(record.logical_case_id);
    const name=record.logical_case_id.replace(':','-'),directory=path.join(run,name);
    if(!same(read(path.join(directory,'result.json')),record))throw new Error('resume_terminal_result_mismatch');
    treeManifest(directory,name,manifest);
  }
  if(!results.length||results.length>=12)throw new Error('resume_requires_partial_terminal_inventory');
  const binding={run_directory:run,protocol_sha256:metadata.protocol_sha256,collector_sha256:metadata.collector_sha256,
    results_file_sha256:hash(raw),terminal_count:results.length,terminal_logical_ids:results.map(row=>row.logical_case_id),
    source_sha256:protocol.source.sha256,terminal_file_manifest:manifest};
  return {run,protocol,metadata,assignments,results,raw,binding};
}

export function createResumeBinding(sourceRun) {return loadResume(sourceRun).binding;}

export function prepare(root,{resumeFrom=null}={}) {
  if(fs.existsSync(path.join(root,'protocol.json')))throw new Error('frozen_panel_already_exists');
  fs.mkdirSync(root,{recursive:true});
  const questions=read(path.join(repository,'ai/local_api/agent_data/questions.json'));
  const fixtures=buildFixtures(),contexts=fixtures.map(f=>contextFromFixture(f,questions));
  const assignments=fixtures.flatMap((fixture,index)=>(index%2?['trained','baseline']:['baseline','trained']).map(arm=>({
    arm,case_id:fixture.case_id,root_lineage_id:fixture.root_lineage_id,context:contexts[index],context_sha256:hash(contexts[index]),
    logical_case_id:arm+':'+fixture.case_id,queued_at:null})));
  const source=sourceFingerprint(path.join(repository,'app'));
  const protocol={schema:'malssi-controlled-full-flow-v1',panel:'controlled_auto_pilot',contract_variant:'production',
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
    gpu_server_access:false};
  if(resumeFrom)protocol.resume_from=createResumeBinding(resumeFrom);
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
export function createTransport({output,endpoint,arm,fetchImpl=fetch}) {
  const origin=assertLocal(endpoint).origin;
  fs.mkdirSync(path.join(output,'http'),{recursive:true});
  let serial=Promise.resolve(),counter=0;
  const records=[];
  const makeFetch=role=>async(url,options={})=>{
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
        if(options.signal?.aborted)throw options.signal.reason||new Error('aborted_before_dispatch');
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
        const headers=new Headers(response.headers);
        for(const field of ['content-length','content-encoding','transfer-encoding'])headers.delete(field);
        return new Response(raw,{status:response.status,statusText:response.statusText,headers});
      }catch(error){
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
  return {generatorFetch:makeFetch('generator'),reviewerFetch:makeFetch('reviewer'),records,settled:()=>serial};
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

async function serverIdentity(endpoint,base,adapter,fetchImpl) {
  const origin=assertLocal(endpoint).origin;
  const props=await(await fetchImpl(origin+'/props')).json(),adapters=await(await fetchImpl(origin+'/lora-adapters')).json();
  if(fs.realpathSync(props.model_path||'')!==base||!Array.isArray(adapters)||adapters.length!==1||adapters[0].id!==0||fs.realpathSync(adapters[0].path||'')!==adapter)
    throw new Error('server_model_adapter_identity_mismatch');
  return {props,adapters};
}

export async function run({root,output,endpoint='http://127.0.0.1:11439/v1',baseModel,adapter,resumeFrom=null,fetchImpl=fetch,Gateway=ModelGateway}) {
  root=path.resolve(root);output=path.resolve(output);baseModel=fs.realpathSync(baseModel);adapter=fs.realpathSync(adapter);
  if(fs.existsSync(output))throw new Error('fresh_output_directory_required');
  fs.mkdirSync(output,{recursive:true});
  const protocol=read(path.join(root,'protocol.json')),fixtures=read(path.join(root,'fixtures.json')),assignments=read(path.join(root,'assignments.json'));
  if(protocol.fixtures_sha256!==hash(fixtures)||protocol.assignments_sha256!==hash(assignments)||assignments.length!==12||hash(protocol.profile)!==hash(PROFILE)||hash(protocol.wire)!==hash(WIRE)||protocol.collector_sha256!==hash(fs.readFileSync(fileURLToPath(import.meta.url))))throw new Error('frozen_protocol_binding_mismatch');
  if(protocol.source.sha256!==sourceFingerprint(path.join(repository,'app')).sha256)throw new Error('application_source_changed_after_freeze');
  if(Boolean(resumeFrom)!==Boolean(protocol.resume_from))throw new Error('explicit_registered_resume_required');
  const resumed=resumeFrom?loadResume(resumeFrom):null;
  if(resumed&&(!same(resumed.binding,protocol.resume_from)||!same(resumed.assignments,assignments)||
    !same(resumed.protocol.profile,PROFILE)||!same(resumed.protocol.wire,WIRE)||resumed.protocol.source.sha256!==protocol.source.sha256))
    throw new Error('resume_binding_or_execution_contract_mismatch');
  if(resumed&&(output===resumed.run||output.startsWith(resumed.run+path.sep)))throw new Error('resume_output_must_not_modify_original_run');
  write(path.join(output,'assignments.json'),assignments);
  const metadata={schema:'malssi-controlled-full-flow-run-v1',started_at:timestamp(),endpoint,protocol_sha256:hash(protocol),
    base_model_path:baseModel,adapter_path:adapter,base_sha256:await hashFile(baseModel),adapter_sha256:await hashFile(adapter),
    collector_sha256:hash(fs.readFileSync(fileURLToPath(import.meta.url))),wire:WIRE,profile:PROFILE};
  if(resumed) {
    if(resumed.metadata.base_sha256!==metadata.base_sha256||resumed.metadata.adapter_sha256!==metadata.adapter_sha256)
      throw new Error('resume_model_hash_mismatch');
    metadata.resume_from=protocol.resume_from;
  }
  write(path.join(output,'metadata.json'),metadata);
  const results=resumed?[...resumed.results]:[],preserved=new Set(results.map(row=>row.logical_case_id));
  if(resumed) {
    fs.writeFileSync(path.join(output,'results.jsonl'),resumed.raw);
    for(const record of resumed.results) {
      const name=record.logical_case_id.replace(':','-');
      fs.cpSync(path.join(resumed.run,name),path.join(output,name),{recursive:true,errorOnExist:true,force:false});
    }
    const orphan=[];
    for(const assignment of assignments.filter(row=>!preserved.has(row.logical_case_id))) {
      const directory=path.join(resumed.run,assignment.logical_case_id.replace(':','-'));
      if(!fs.existsSync(directory))continue;
      const file=path.join(directory,'http-events.jsonl'),events=fs.existsSync(file)?fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse):[];
      const queued=events.filter(row=>row.event==='queued'),completed=events.filter(row=>row.event==='completed');
      orphan.push({logical_case_id:assignment.logical_case_id,source_directory:directory,
        queued_count:queued.length,completed_actual_posts:completed.filter(row=>row.actual_post).length,
        unresolved_attempt_ids:queued.filter(row=>!completed.some(done=>done.attempt_id===row.attempt_id)).map(row=>row.attempt_id)});
    }
    write(path.join(output,'resume-reconciliation.json'),{source_run_directory:resumed.run,
      preserved_terminal_logical_ids:[...preserved],pending_logical_ids:assignments.filter(row=>!preserved.has(row.logical_case_id)).map(row=>row.logical_case_id),
      prior_nonterminal_records:orphan,prior_nonterminal_records_counted_in_m02:false,
      scope:'Explicit continuation of uncompleted logical cases; prior partial attempts stay in the original run and are not hidden or scored as new independent cases.'});
  }
  const summarize=()=>({status:results.length===assignments.length?'completed':'running',assigned_count:assignments.length,
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
  try {metadata.server_identity=await serverIdentity(endpoint,baseModel,adapter,fetchImpl);write(path.join(output,'metadata.json'),metadata);}
  catch(error){write(path.join(output,'preflight-error.json'),{error:error.message,time:timestamp()});throw error;}
  for(const assignment of assignments) {
    if(preserved.has(assignment.logical_case_id))continue;
    const started=performance.now(),directory=path.join(output,assignment.logical_case_id.replace(':','-'));
    fs.mkdirSync(directory);const trace=[],stages=[];
    const record={...assignment,context:undefined,status:'running',started_at:timestamp(),m02_complete:false};
    write(path.join(directory,'assignment.json'),{...assignment,queued_at:record.started_at});
    const transport=createTransport({output:directory,endpoint,arm:assignment.arm,fetchImpl});
    const diagnosticLogger=entry=>{trace.push(entry);append(path.join(directory,'diagnostics.jsonl'),entry);};
    const common={...PROFILE,baseUrl:endpoint,apiKey:'local-evaluation-only',model:metadata.server_identity.props.model_alias||'a-original-controlled',diagnosticLogger};
    const reviewer=new Gateway({...common,fetchImpl:transport.reviewerFetch});
    const writer=new Gateway({...common,fetchImpl:transport.generatorFetch,reviewGateway:reviewer});
    instrumentStages(reviewer,'reviewer',directory,stages);instrumentStages(writer,'generator',directory,stages);
    let result;
    try {
      result=await writer.respond(structuredClone(assignment.context));
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
    write(path.join(directory,'result.json'),record);append(path.join(output,'results.jsonl'),record);results.push(record);
    write(path.join(output,'summary.json'),summarize());
    console.log(JSON.stringify({case_id:record.case_id,arm:record.arm,status:record.status,actual_posts:record.actual_posts,finished_cases:results.length}));
  }
  return summarize();
}

async function hashFile(file) {
  const digest=createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);return digest.digest('hex');
}

async function cli() {
  const args=process.argv.slice(2),mode=args.shift(),options={};
  while(args.length){const key=args.shift(),value=args.shift();if(!key?.startsWith('--')||!value)throw new Error('expected_named_arguments');options[key.slice(2)]=value;}
  const root=options.root||path.join(repository,'runtime/a-original-controlled-20261111-v13/full-flow');
  if(mode==='--prepare')console.log(JSON.stringify(prepare(root,{resumeFrom:options['resume-from']||null}),null,2));
  else if(mode==='--run') {
    if(!options.output||!options['base-model']||!options.adapter)throw new Error('run_requires_output_base_model_adapter');
    console.log(JSON.stringify(await run({root,output:options.output,baseModel:options['base-model'],adapter:options.adapter,resumeFrom:options['resume-from']||null,endpoint:options.endpoint}),null,2));
  }else throw new Error('Use --prepare [--root DIR] or --run --root DIR --output FRESH_DIR --base-model FILE --adapter FILE [--endpoint URL]');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await cli();
