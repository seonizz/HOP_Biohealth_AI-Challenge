import {readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
const root=resolve(process.argv[2]),baseline=process.argv[3]?resolve(process.argv[3]):null;
const readAt=async(directory,name,fallback=null)=>{try{return JSON.parse(await readFile(join(directory,name),'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
const linesAt=async(directory,name)=>{try{return (await readFile(join(directory,name),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
const read=(name,fallback)=>readAt(root,name,fallback),lines=name=>linesAt(root,name);
const seconds=value=>Number.isFinite(value)&&value>=0?value:null;
const percent=(before,after)=>before>0&&after!==null?100*(1-after/before):null;
const scriptTime=(rows,http=false)=>seconds(rows.find(e=>e.id==='script'&&(http||e.type==='upsert'))?.elapsed_seconds);

// Historical HTTP timings lack request_id. Associate a whole model request_id
// group with one enclosing HTTP interval, never count a partial group as a turn.
function answerMetrics(operations,requests){
 const answers=operations.filter(r=>r.kind==='answer'),groups=new Map();
 for(const row of requests){if(!row.request_id)continue;const group=groups.get(row.request_id)||[];group.push(row);groups.set(row.request_id,group);}
 const owners=new Map();
 for(const [id,group] of groups){
  const matches=answers.filter(op=>op.request_id?id===op.request_id:group.every(r=>{
   const at=Date.parse(r.queued_at??r.started_at),end=Date.parse(r.ended_at??r.started_at);
   return at>=Date.parse(op.started_at)&&end<=Date.parse(op.ended_at);
  }));
  if(matches.length===1)owners.set(id,matches[0]);
 }
 return answers.map(op=>{
  const ids=[...owners].filter(([,owner])=>owner===op).map(([id])=>id),rows=ids.flatMap(id=>groups.get(id));
  const orphanInInterval=requests.some(r=>!owners.has(r.request_id)&&Date.parse(r.queued_at??r.started_at)>=Date.parse(op.started_at)&&Date.parse(r.queued_at??r.started_at)<=Date.parse(op.ended_at));
  const known=ids.length>0&&!orphanInInterval&&rows.every(r=>typeof r.dispatched==='boolean');
  const calls=known?rows.filter(r=>r.dispatched===true).length:null;
  return {question_id:op.question_id,status:op.status,seconds:seconds(op.seconds),request_ids:ids,
   call_association:op.request_id?'request_id':'whole_request_id_group_within_http_interval',
   model_calls:calls,failed_model_calls:rows.filter(r=>r.dispatched===true&&(r.error_code||r.http_status>=400)).length,
   within_120:op.status==='completed'&&seconds(op.seconds)!==null&&op.seconds<=120};
 });
}
const requests=await read('requests.json',[]),ops=await lines('operation-timings.jsonl'),events=await lines('preview-events.jsonl');
const httpCards=await lines('preview-http.jsonl');
const delivery=events.filter(e=>e.type==='upsert').filter((e,i,all)=>all.findIndex(x=>x.id===e.id)===i).map(e=>{const h=httpCards.find(x=>x.id===e.id);return {id:e.id,approved_seconds:e.elapsed_seconds,http_observed_seconds:h?.elapsed_seconds??null,approval_to_http_ms:h?Date.parse(h.at)-Date.parse(e.at):null};});
const probe=await read('progress-probe.json'),db=await read('case-1/database-confirmation.json'),status=await read('STATUS.json',{}),caseReport=await read('case-1/report.json',{});
const result=ops.find(e=>e.kind==='result_generation_and_save'),elapsed=scriptTime(events),httpElapsed=scriptTime(httpCards,true);
const stages=Object.values(requests.reduce((out,r)=>{const x=out[r.stage]??={stage:r.stage,calls:0,seconds:0,input_tokens:0,output_tokens:0,queue_seconds:0};if(r.dispatched===true)x.calls++;x.seconds+=(r.transport_wall_ms??0)/1000;x.input_tokens+=r.usage?.prompt_tokens??0;x.output_tokens+=r.usage?.completion_tokens??0;x.queue_seconds+=(r.queue_wait_ms??0)/1000;return out;},{})).sort((a,b)=>b.seconds-a.seconds);
const answers=answerMetrics(ops,requests),expected=caseReport.answered_question_ids;
const coverage=caseReport.status==='passed'&&caseReport.question_progress?.status==='verified'&&Array.isArray(expected)&&expected.length>0&&
 JSON.stringify(answers.map(r=>r.question_id))===JSON.stringify(expected)&&answers.every(r=>r.status==='completed'&&r.seconds!==null);
const answerRequestIds=new Set(answers.flatMap(row=>row.request_ids));
const unassignedTurnRequests=requests.filter(r=>/^turn_draft(?:_|$)/u.test(r.stage)&&!answerRequestIds.has(r.request_id)).length;
const callCoverage=coverage&&unassignedTurnRequests===0&&answers.every(r=>r.model_calls!==null);
const singleCallPassed=status.status==='passed'&&callCoverage&&answers.every(r=>r.model_calls===1&&r.failed_model_calls===0);
let comparison=null,answerComparison=null;
if(baseline){
 const priorRequests=await readAt(baseline,'requests.json',[]),priorOps=await linesAt(baseline,'operation-timings.jsonl');
 const priorEvents=await linesAt(baseline,'preview-events.jsonl'),priorHttp=await linesAt(baseline,'preview-http.jsonl');
 const priorCallback=scriptTime(priorEvents),priorHttpTime=scriptTime(priorHttp,true);
 const start=priorOps.find(r=>r.kind==='result_generation_and_save'),end=priorRequests.find(r=>r.stage==='final_review_bundle_initial');
 const historical=seconds((Date.parse(end?.ended_at)-Date.parse(start?.started_at))/1000);
 let before=null,after=null,metric='unavailable',basis='Insufficient paired observations; no speedup claimed.';
 if(priorHttpTime!==null&&httpElapsed!==null){before=priorHttpTime;after=httpElapsed;metric='authenticated_http';basis='Paired authenticated HTTP first-script observations; not browser paint.';}
 else if(priorCallback!==null&&elapsed!==null){before=priorCallback;after=elapsed;metric='approved_card_callback';basis='Paired approved-card callbacks; not HTTP delivery or browser paint.';}
 else if(historical!==null&&elapsed!==null){before=historical;after=elapsed;metric='historical_bundle_to_callback';basis='Historical baseline reconstructed from review bundle completion; candidate card callback. Neither is a browser paint measurement.';}
 comparison={baseline_review_bundle_completed_seconds:historical,candidate_approved_script_seconds:elapsed,
  baseline_script_seconds:before,candidate_script_seconds:after,metric,saved_seconds:before!==null&&after!==null?before-after:null,reduction_percent:percent(before,after),basis};
 const previous=answerMetrics(priorOps,priorRequests),used=new Set();
 answerComparison={baseline:baseline.split('/').at(-1),same_question_path:JSON.stringify(previous.map(r=>r.question_id))===JSON.stringify(answers.map(r=>r.question_id)),
  turns:answers.map(row=>{const index=previous.findIndex((old,i)=>!used.has(i)&&old.question_id===row.question_id),old=previous[index];if(index>=0)used.add(index);
   const before=old?.status==='completed'?old.seconds:null,after=row.status==='completed'?row.seconds:null;
   return {question_id:row.question_id,baseline_calls:old?.model_calls??null,candidate_calls:row.model_calls,
    calls_saved:old?.model_calls!==null&&old?.model_calls!==undefined&&row.model_calls!==null?old.model_calls-row.model_calls:null,
    baseline_seconds:before,candidate_seconds:after,saved_seconds:before!==null&&after!==null?before-after:null,reduction_percent:percent(before,after),candidate_status:row.status};}),
  limitation:'One synthetic conversation per run. Changed question paths, omitted independent turn reviews and repairs affect comparability; call counts include all dispatched attempts in each request_id group.'};
}
const report={run:root.split('/').at(-1),application_status:status.status??'unknown',database_status:db?.status??'unverified',database_exact_match:db?.check==='encrypted_database_exact_result_payload'&&db.status==='passed',measurement_status:probe?.status??'missing',first_reviewed_script_seconds:elapsed,first_http_script_seconds:httpElapsed,result_and_save_seconds:result?.seconds??null,preview_to_final_seconds:elapsed!==null&&result?result.seconds-elapsed:null,progress_probe:probe,card_delivery:delivery,preview_removals:events.filter(e=>e.type==='remove').length,preview_resets:events.filter(e=>e.type==='reset').length,comparison,stages,
 answer_http:answers,answer_comparison:answerComparison,
 single_call_turns:{target_calls:1,status:singleCallPassed?'passed':'failed',coverage_complete:coverage,call_coverage_complete:callCoverage,unassigned_turn_requests:unassignedTurnRequests,answer_count:answers.length,all_within_120:coverage&&answers.every(r=>r.within_120),basis:'Actual dispatched POST attempts grouped by request_id; missing dispatch or complete conversation evidence cannot pass.'},
 improvements:[{id:'progress_observation',implemented:true,metric:'Explicit GET, authenticated first-card observation, HTTP latency/error/revision coverage',gate:'Do not count missing observations as successful visibility verification'},{id:'per_card_delivery',implemented:true,metric:'First approval vs HTTP delivery, rollback/reset counts and final-save gap',gate:'No unreviewed card exposure'},{id:'stage_bottlenecks',implemented:true,metric:'Rank stage time, model calls, input/output tokens and queue wait',gate:'Report before changing model budgets or review gates'},{id:'browser_paint',implemented:false,metric:'Actual DOM paint and perceived wait',gate:'HTTP delivery is not browser paint; separate browser measurement required'}]};
await writeFile(join(root,'visible-latency-report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({run:report.run,application_status:report.application_status,database_status:report.database_status,measurement_status:report.measurement_status,first_reviewed_script_seconds:elapsed,comparison,single_call_turns:report.single_call_turns}));
