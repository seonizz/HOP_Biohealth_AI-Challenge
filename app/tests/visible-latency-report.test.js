import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile),script=fileURLToPath(new URL('../scripts/summarize-visible-latency.mjs',import.meta.url));
const at=n=>new Date(Date.UTC(2026,0,1,0,0,n)).toISOString();
const answer=(question_id='q1',request_id='one',extra={})=>({kind:'answer',question_id,request_id,status:'completed',seconds:10,started_at:at(0),ended_at:at(10),...extra});
const request=(request_id='one',extra={})=>({stage:'turn_draft',request_id,dispatched:true,queued_at:at(1),started_at:at(1),ended_at:at(9),http_status:200,...extra});
const base=()=>({
 'STATUS.json':{status:'passed'},'case-1/report.json':{status:'passed',answered_question_ids:['q1'],question_progress:{status:'verified'}},
 'requests.json':[request()], 'operation-timings.jsonl':[answer(),{kind:'result_generation_and_save',started_at:at(10),seconds:100}],
 'preview-events.jsonl':[{id:'script',type:'upsert',elapsed_seconds:60}],
 'preview-http.jsonl':[{id:'script',elapsed_seconds:62}],
});
async function report(t,candidate=base(),baseline){
 const root=await mkdtemp(join(tmpdir(),'visible-report-'));t.after(()=>rm(root,{recursive:true,force:true}));
 async function fixture(name,data){const dir=join(root,name);await mkdir(dir);for(const [path,value] of Object.entries(data)){
  const destination=join(dir,path);await mkdir(join(destination,'..'),{recursive:true});await writeFile(destination,path.endsWith('.jsonl')?value.map(v=>JSON.stringify(v)).join('\n')+'\n':JSON.stringify(value));
 }return dir;}
 const current=await fixture('candidate',candidate),previous=baseline?await fixture('baseline',baseline):null;
 await exec(process.execPath,[script,current,...(previous?[previous]:[])]);
 return JSON.parse(await readFile(join(current,'visible-latency-report.json'),'utf8'));
}
test('compares paired HTTP observations before callbacks or historical bundles',async t=>{
 const previous=base();previous['preview-http.jsonl'][0].elapsed_seconds=100;previous['preview-events.jsonl'][0].elapsed_seconds=90;
 previous['requests.json'].push(request('old-final',{stage:'final_review_bundle_initial',ended_at:at(110)}));
 const result=await report(t,base(),previous);
 assert.equal(result.comparison.metric,'authenticated_http');assert.equal(result.comparison.saved_seconds,38);assert.equal(result.comparison.reduction_percent,38);
 assert.equal(result.comparison.baseline_review_bundle_completed_seconds,100);
 assert.match(result.comparison.basis,/not browser paint/);
});
test('falls back to paired callbacks, then labeled historical reconstruction, then unavailable',async t=>{
 const previous=base();delete previous['preview-http.jsonl'];previous['preview-events.jsonl'][0].elapsed_seconds=80;
 assert.equal((await report(t,base(),previous)).comparison.metric,'approved_card_callback');
 delete previous['preview-events.jsonl'];previous['requests.json'].push(request('final',{stage:'final_review_bundle_initial',ended_at:at(110)}));
 const historical=await report(t,base(),previous);assert.equal(historical.comparison.metric,'historical_bundle_to_callback');assert.equal(historical.comparison.saved_seconds,40);
 previous['requests.json']=[];const missing=await report(t,base(),previous);assert.equal(missing.comparison.metric,'unavailable');assert.equal(missing.comparison.saved_seconds,null);
});
test('counts dispatched retries by exact request_id and compares with interval-associated baseline',async t=>{
 const previous=base();delete previous['operation-timings.jsonl'][0].request_id;previous['operation-timings.jsonl'][0].seconds=20;
 previous['requests.json'].push(request('one',{stage:'turn_review'}));
 const current=base();current['requests.json'].push(request('one',{dispatched:false,stage:'turn_draft',error_code:'cancelled'}));
 const result=await report(t,current,previous);
 assert.equal(result.answer_http[0].model_calls,1);assert.equal(result.single_call_turns.status,'passed');
 assert.equal(result.answer_comparison.turns[0].baseline_calls,2);assert.equal(result.answer_comparison.turns[0].calls_saved,1);
 assert.equal(result.answer_comparison.turns[0].saved_seconds,10);
 current['requests.json'].push(request('one',{error_code:'invalid_json',http_status:502}));
 const retried=await report(t,current);assert.equal(retried.answer_http[0].model_calls,2);assert.equal(retried.single_call_turns.status,'failed');
});
test('missing turns, failed cases, missing call metadata and missing traces cannot pass',async t=>{
 for(const mutate of [
  x=>x['case-1/report.json'].answered_question_ids.push('q2'),
  x=>x['STATUS.json'].status='failed',
  x=>x['case-1/report.json'].status='failed',
  x=>delete x['requests.json'][0].dispatched,
  x=>x['requests.json']=[],
  x=>x['operation-timings.jsonl'][0].status='failed',
 ]){const current=base();mutate(current);assert.equal((await report(t,current)).single_call_turns.status,'failed');}
});
test('ambiguous and partial interval associations never count as a successful turn',async t=>{
 const current=base();delete current['operation-timings.jsonl'][0].request_id;
 current['requests.json'].push(request('one',{stage:'turn_review',ended_at:at(11)}));
 const partial=await report(t,current);assert.equal(partial.answer_http[0].model_calls,null);assert.equal(partial.single_call_turns.call_coverage_complete,false);
 current['requests.json']=[request()];current['operation-timings.jsonl'].push({...answer('q2'),request_id:undefined});
 const ambiguous=await report(t,current);assert.ok(ambiguous.answer_http.every(r=>r.model_calls===null));
});
test('unassigned draft requests invalidate call coverage even outside measured intervals',async t=>{
 const current=base();current['requests.json'].push(request('unmatched',{queued_at:at(15),started_at:at(15),ended_at:at(20)}));
 const result=await report(t,current);assert.equal(result.single_call_turns.unassigned_turn_requests,1);assert.equal(result.single_call_turns.status,'failed');
});
test('failed comparisons retain null elapsed speedup rather than claiming an improvement',async t=>{
 const current=base();current['operation-timings.jsonl'][0].status='failed';
 const result=await report(t,current,base());assert.equal(result.answer_comparison.turns[0].saved_seconds,null);assert.equal(result.answer_comparison.turns[0].reduction_percent,null);
});
