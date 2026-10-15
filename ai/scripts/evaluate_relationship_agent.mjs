import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { request } from 'node:http';

const root=resolve(import.meta.dirname,'..');
const backend=process.env.MALSSI_BACKEND_PATH || resolve(root,'../app');
const { ModelGateway }=await import(pathToFileURL(resolve(backend,'src/model.js')));
const source=JSON.parse(readFileSync(resolve(root,'local_api/runtime/config.json'),'utf8'));
const questionRows=JSON.parse(readFileSync(resolve(root,'local_api/agent_data/questions.json'),'utf8'));
const args=process.argv.slice(2),stateOnly=args.includes('--state-only'),incremental=args.includes('--incremental'),webContext=args.includes('--web-context');
if(args.some(arg=>arg.startsWith('--')&&!['--state-only','--incremental','--web-context'].includes(arg)))throw new Error('unknown_option');
if(incremental&&!stateOnly)throw new Error('incremental_requires_state_only');
const fixture=JSON.parse(readFileSync(args.find(arg=>!arg.startsWith('--'))||resolve(root,'local_api/agent_data/mother_child.json'),'utf8'));
if(!/^[a-z0-9_]{1,80}$/.test(fixture.case_id))throw new Error('invalid_case_id');
if(source.ollama_url!=='http://127.0.0.1:11434')throw new Error('expected_verified_local_model');
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
const reportId=fixture.case_id+(webContext?'-web':'')+(incremental?'-incremental-state':stateOnly?'-state':'');
const trace=[];const stageOutputs=[];
const gateway=new ModelGateway({baseUrl:source.ollama_url+'/v1',apiKey:source.api_key,
  model:'gemma4:12b',protocol:'relationship_agent',timeoutMs:600000,diagnosticLogger:entry=>{
    trace.push(entry); console.log(JSON.stringify({stage:entry.generation,attempt:entry.attempt,duration_ms:entry.duration_ms,reason:entry.reason}));
  }});
const outputDir=resolve(root,'outputs/relationship_agent');mkdirSync(outputDir,{recursive:true});
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
  const report={case_id:fixture.case_id,mode:stateOnly?'state':'final',synthetic:fixture.synthetic,model:'gemma4:12b',
    measured_at:new Date().toISOString(),duration_ms:Math.round(performance.now()-started),
    ...(initialState?{initial_state:initialState}:{}),result,trace,stage_outputs:stageOutputs};
  const target=resolve(outputDir,reportId+'.json');writeFileSync(target,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:'passed',output:target,duration_ms:report.duration_ms,stages:result.agent?.stages||['state'],script:result.guide?.script},null,2));
} catch(error) {
  writeFileSync(resolve(outputDir,reportId+'-failure.json'),JSON.stringify({case_id:fixture.case_id,code:error.code||error.message,reason:error.modelReason,trace,stage_outputs:stageOutputs},null,2)+'\n',{mode:0o600});
  console.error(JSON.stringify({status:'failed',code:error.code||error.message,reason:error.modelReason}));process.exitCode=1;
}
