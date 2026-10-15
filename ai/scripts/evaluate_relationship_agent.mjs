import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { modelConfig, evaluationIdentity, attemptMetrics } from './evaluation_evidence.mjs';

const root=resolve(import.meta.dirname,'..');
const backend=process.env.MALSSI_BACKEND_PATH || resolve(root,'../app');
const { ModelGateway }=await import(pathToFileURL(resolve(backend,'src/model.js')));
const { PROMPT_VERSION }=await import(pathToFileURL(resolve(backend,'src/relationship-prompts.js')));
const legacyPath=resolve(root,'local_api/runtime/config.json');
const source=!process.env.MODEL_BASE_URL&&existsSync(legacyPath)?JSON.parse(readFileSync(legacyPath,'utf8')):{};
const questionsBytes=readFileSync(resolve(root,'local_api/agent_data/questions.json'));
const questionRows=JSON.parse(questionsBytes);
const args=process.argv.slice(2),stateOnly=args.includes('--state-only'),incremental=args.includes('--incremental'),webContext=args.includes('--web-context'),checkOnly=args.includes('--check-only');
if(args.some(arg=>arg.startsWith('--')&&!['--state-only','--incremental','--web-context','--check-only'].includes(arg)))throw new Error('unknown_option');
if(args.filter(arg=>!arg.startsWith('--')).length>1)throw new Error('one_fixture_required');
if(incremental&&!stateOnly)throw new Error('incremental_requires_state_only');
const fixtureBytes=readFileSync(args.find(arg=>!arg.startsWith('--'))||resolve(root,'local_api/agent_data/mother_child.json'));
const fixture=JSON.parse(fixtureBytes);
if(!/^[a-z0-9_]{1,80}$/.test(fixture.case_id))throw new Error('invalid_case_id');
if(fixture.synthetic!==true)throw new Error('only_synthetic_fixtures_allowed');
const config=modelConfig(process.env,source);
const identify=context=>evaluationIdentity({backend,fixtureBytes,questionsBytes,promptVersion:PROMPT_VERSION,config,context,
  contextSource:webContext?'saved_web_context':'synthetic_fixture',
  checkpointSha256:process.env.MODEL_CHECKPOINT_SHA256||null});
const field=(id,text,question,status='answered')=>({id,status,question,source:'app_user_report',text,rawText:text,custom:''});
const context={schema_version:'1.0',patient:{alias:fixture.answers.name||'그분',fields:{}},supporter:{role:'informant',fields:{}},
  user_goal:{},answered_count:Object.keys(fixture.answers).length,question_candidates:[],name_index:null};
for(const row of questionRows) {
  const value=fixture.answers[row.id];
  if(value===undefined)continue;
  const entry=field(row.id,typeof value==='string'?value:value.text,row.definition.q,typeof value==='object'?value.status:'answered');
  if(row.id==='goal'&&fixture.selected_goal_tags) {
    if(!Array.isArray(fixture.selected_goal_tags))throw new Error('invalid_fixture_goal_tags');
    entry.selected=fixture.selected_goal_tags.map(tag=>{
      const option=row.definition.opts.find(option=>option[1]?.t===tag);
      if(!option||!entry.rawText.includes(option[0]))throw new Error('fixture_goal_not_in_source');
      return {label:option[0],meta:option[1]};
    });
  }
  if(row.subject==='user_goal') context.user_goal[row.id==='want'?'message':'desired_outcomes']=entry;
  else context[row.subject].fields[row.id]=entry;
}
const activeRows=questionRows.filter(row=>fixture.answers[row.id]!==undefined);
const latest=activeRows.at(-1);
context.latest_answer=latest?{subject:latest.subject,question_id:latest.id}:null;
if(checkOnly) {
  const identity=identify(webContext?null:context);
  console.log(JSON.stringify({status:'configuration_checked',case_id:fixture.case_id,mode:stateOnly?'state':'final',
    identity,model_configured:Boolean(config.baseUrl&&config.model&&config.apiKey),model_called:false},null,2));
  process.exit(0);
}
if(!config.baseUrl||!config.model||!config.apiKey)throw new Error('set_MODEL_BASE_URL_MODEL_NAME_MODEL_API_KEY');
if(webContext) {
  const session=JSON.parse(readFileSync(resolve(root,'local_api/runtime/relationship-smoke-session.json'),'utf8'));
  if(session.kind!=='synthetic_relationship_web_smoke'||!/^[a-f0-9-]{36}$/.test(session.intake_id)||!fixture.synthetic)throw new Error('invalid_test_session');
  const saved=await new Promise((resolve,reject)=>{
    const req=request({host:'127.0.0.1',port:9000,path:`/api/intakes/${session.intake_id}/context`,
      headers:{Host:new URL(session.origin).host,Origin:session.origin,Cookie:session.cookie}},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{
        try{const value=JSON.parse(body);if(res.statusCode!==200||!value.context)reject(new Error('test_context_unavailable'));else resolve(value.context);}catch{reject(new Error('invalid_response'));}
      });
    });req.on('error',()=>reject(new Error('connection_error')));req.setTimeout(10000,()=>req.destroy());req.end();
  });
  Object.assign(context,saved);
}
const identity=identify(context);
const reportId=fixture.case_id+(webContext?'-web':'')+(incremental?'-incremental-state':stateOnly?'-state':'');
const trace=[];const stageOutputs=[];
const gateway=new ModelGateway({...config,diagnosticLogger:entry=>{
    trace.push(entry); console.log(JSON.stringify({stage:entry.generation,attempt:entry.attempt,duration_ms:entry.duration_ms,reason:entry.reason}));
  }});
const outputDir=resolve(process.env.MALSSI_EVALUATION_DIR||resolve(root,'local_api/runtime/evaluations'));
mkdirSync(outputDir,{recursive:true,mode:0o700});
const runId=new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID();
const target=resolve(outputDir,reportId+'-'+runId+'.json');
const baseReport={run_id:runId,case_id:fixture.case_id,mode:stateOnly?'state':'final',incremental,web_context:webContext,
  synthetic:true,model:config.model,identity,measured_at:new Date().toISOString(),human_review:'pending'};
const complete=gateway.agentComplete.bind(gateway);
gateway.agentComplete=async(...args)=>{
  const retrieval=args[2]?.retrieval;
  if(retrieval?.method!=='conversation_lexical_v1'||!Array.isArray(retrieval.documents))throw new Error('missing_retrieval');
  const value=await complete(...args);
  if(fixture.synthetic)stageOutputs.push({stage:args[0],retrieval:{indexed_sources:retrieval.indexed_sources,
    retrieved_sources:retrieval.documents.length,questions:[...new Set(retrieval.documents.map(row=>row.subject+':'+row.question_id))]},output:value});
  return value;
};
const started=performance.now();
let generatedResult;
try {
  let initialState;
  if(incremental) {
    const index=activeRows.findIndex(row=>row.subject==='supporter');
    if(index<0||index===activeRows.length-1)throw new Error('missing_incremental_fixture');
    const initialRows=activeRows.slice(0,index+1),ids=new Set(initialRows.map(row=>row.id));
    const initial=structuredClone(context);
    for(const subject of ['patient','supporter'])initial[subject].fields=Object.fromEntries(
      Object.entries(initial[subject].fields).filter(([id])=>ids.has(id)));
    initial.user_goal=Object.fromEntries(Object.entries(initial.user_goal).filter(([,field])=>ids.has(field.id)));
    initial.answered_count=initialRows.length;
    const last=initialRows.at(-1);initial.latest_answer={subject:last.subject,question_id:last.id};
    initialState=await gateway.updateState(initial);
    context.agent_state=initialState.patient_state;context.relationship_state=initialState.relationship_memory;
  }
  const result=stateOnly?await gateway.updateState(context,initialState?.patient_state):await gateway.respond(context);
  generatedResult=result;
  const expected=fixture.expectations||{};
  if(stateOnly) {
    for(const subject of ['patient','supporter']) {
      const ids=expected['memory_'+subject+'_questions_any'];
      if(ids&&!result.relationship_memory[subject].some(item=>item.evidence.some(ref=>ids.includes(ref.question_id))))throw new Error('missing_current_'+subject+'_memory');
    }
  } else {
    if(expected.safety!==undefined && result.assessment.safety!==expected.safety)throw new Error('unexpected_safety');
    if(expected.relationship_label && result.relationship_analysis.relationship.label!==expected.relationship_label)throw new Error('unexpected_relationship');
    if((expected.script_forbidden||[]).some(word=>result.guide.script.includes(word)))throw new Error('invented_script_role');
    for(const alternatives of expected.script_contains_any||[]) {
      if(!alternatives.some(word=>result.guide.script.includes(word)))throw new Error('missing_required_script_intent');
    }
  }
  const report={...baseReport,status:'passed',duration_ms:Math.round(performance.now()-started),metrics:attemptMetrics(trace),
    ...(initialState?{initial_state:initialState}:{}),result,trace,stage_outputs:stageOutputs};
  writeFileSync(target,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({status:'automatic_checks_passed',human_review:'pending',output:target,duration_ms:report.duration_ms,stages:result.agent?.stages||['state']},null,2));
} catch(error) {
  const code=error.code||(/^[a-z0-9_]+$/.test(error.message)?error.message:'evaluation_error');
  writeFileSync(target,JSON.stringify({...baseReport,status:'failed',duration_ms:Math.round(performance.now()-started),
    code,reason:error.modelReason,metrics:attemptMetrics(trace),result:generatedResult,trace,stage_outputs:stageOutputs},null,2)+'\n',{mode:0o600,flag:'wx'});
  console.error(JSON.stringify({status:'failed',code,reason:error.modelReason,output:target}));process.exitCode=1;
}
