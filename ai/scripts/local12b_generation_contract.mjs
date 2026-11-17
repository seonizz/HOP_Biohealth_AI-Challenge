// 12B-only offline contract curriculum. No network, model, training, or app writes.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {ModelGateway} from '../../app/src/model.js';
import {runRelationshipAgent,validateSchema} from '../../app/src/relationship-agent.js';
import {evidenceWireFixture} from '../../app/tests/evidence-wire.fixture.js';

const REPO=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const VERSION='12b-app-generation-contract-v1';
export const STAGES=['state_observations','relationship_memory','final_analysis_plan_draft'];
const canonical=v=>JSON.stringify(sort(v));
function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}
export const digest=v=>createHash('sha256').update(typeof v==='string'||Buffer.isBuffer(v)?v:canonical(v)).digest('hex');
const clone=structuredClone;
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const rows=p=>fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n');};
const writeRows=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,v.map(canonical).join('\n')+'\n');};
const field=(id,text)=>({id,text,rawText:text,custom:'',status:'answered',question:id});
const reference=(context,subject,id)=>({subject,question_id:id,quote:context[subject].fields[id].rawText});

export function sources(){
 const names=['도윤','나래','하람','윤슬','여울','해솔','온유','세림','다원','누리','시온','다솜','라온','미르','해나','유하'];
 const activities=['퍼즐 맞추기','사진 정리','책 읽기','화분 돌보기','악보 정리','뜨개질','일기 쓰기','지도 보기','그림 그리기','우표 정리','곡 고르기','종이 접기','책갈피 만들기','별자리 보기','편지 쓰기','앨범 보기'];
 return names.map((name,i)=>{
  const split=i<8?'train':i<12?'validation':'test',negated=i%2===0,uncertain=Math.floor(i/2)%2===0;
  const description=`${name}의 ${activities[i]} 이야기를 정정합니다. 처음에는 지난달에 함께했다고 썼지만, 정확히는 ${i+2}일 전입니다. 지금은 함께 ${activities[i]}를 ${negated?'하지 않겠다고':'하겠다고'} 말했습니다. 그 이유는 ${uncertain?'확인하지 못했습니다':'일정을 맞추기 위해서라고 직접 말했습니다'}.`;
  const feeling=`저는 ${activities[(i+5)%16]} 시간을 지키고 싶습니다. ${name}에게 말을 걸기 전에 제 가능한 시간을 정하려 합니다.`;
  const intent=`${name}의 현재 의사를 확인하고 제 시간 범위에서 이야기를 나누고 싶어요.`;
  const context={schema_version:'1.0',patient:{alias:name,fields:{name:field('name',name),rel:field('rel','성인 친구예요.'),describe:field('describe',description)}},
   supporter:{role:'informant',fields:{feeling:field('feeling',feeling)}},user_goal:{message:field('want',intent)},answered_count:5,adaptive_questions:false,question_candidates:[],latest_answer:{subject:'patient',question_id:'describe'}};
  const source={split,context:sort(context),negated,uncertain,template_family:'correction-current-intent',synthetic:true};
  source.source_root_id=VERSION+':'+digest(context).slice(0,24);return source;
 });
}
function targets(source){
 const c=source.context,p=reference(c,'patient','describe'),s=reference(c,'supporter','feeling');
 const unknowns=source.uncertain?['대상자가 현재 의사를 밝힌 이유는 확인하지 못했어요.']:[];
 return {
  state_observations:{patient_state:{facts:[{...p,certainty:'reported'},{...s,certainty:'reported'}],unknowns},name_index:{alias:c.patient.alias,source_question_id:'name',quote:c.patient.alias}},
  relationship_memory:{relationship_memory:{patient:[{evidence:[p],certainty:'reported'}],supporter:[{evidence:[s],certainty:'reported'}],relationship:[],unknowns}},
  final_analysis_plan_draft:{analysis:{observations:{patient:[p],supporter:[s]},relationship:{label:'성인 친구',supporter_role:'친구',dynamics:[],strengths:[],boundaries:[]},unknowns,safety:{urgent:false,evidence_ids:[]}},
   plan:{voice:'친구가 친구에게 건네는 말',opening_evidence:[p],user_intent:c.user_goal.message.text,patient_choice:'지금 대화할지 먼저 물어보고 선택을 기다리세요.',supporter_care:['자신이 가능한 시간을 먼저 살펴보세요.'],avoid_patterns:['이유를 추측해서 단정하지 않기'],next_step:'서로 가능한 때를 물어보고 정하세요.'}}
 };
}
function corrupt(stage,value){
 const bad=clone(value);
 if(stage==='state_observations')bad.patient_state.facts=Array.from({length:9},()=>clone(value.patient_state.facts[0]));
 else if(stage==='relationship_memory')bad.relationship_memory.patient[0].evidence=Array.from({length:4},()=>clone(value.relationship_memory.patient[0].evidence[0]));
 else return '{"analysis":';
 return JSON.stringify(bad);
}
const STOP=Symbol('captured-final-contract');

// Run actual application stage builders, wire transforms, parsers, validators and retries.
export async function captureSource(source,repair=false){
 const gold=targets(source),captured=[],attempts=new Map();
 const gateway=new ModelGateway({baseUrl:'http://offline.invalid/v1',apiKey:'offline',model:'12b-contract-only',protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',stateMode:'separate',bundleAnalysisPlan:true,bundleFinalReviews:true,skipFinalExtras:false,retryFailures:false,streamJson:false,discoverTokenLimits:false,timeoutMs:0,diagnosticLogger:null,
  fetchImpl:async(url,options)=>{
   assert.equal(url,'http://offline.invalid/v1/chat/completions');
   const body=JSON.parse(options.body),payload=JSON.parse(body.messages.at(-1).content),stage=payload.stage;
   let target;
   if(stage==='state_review')target={approved:true,issues:[],audits:payload.data.claims.map(c=>({id:c.id,verdict:c.certainty==='tentative'?'plausible':'supported',reason:'합성 원문의 정확한 현재 보고를 보존했습니다.'}))};
   else {assert.ok(STAGES.includes(stage),stage);target=evidenceWireFixture(payload,gold[stage]);}
   const attempt=attempts.get(stage)||0;attempts.set(stage,attempt+1);
   const text=repair&&attempt===0&&STAGES.includes(stage)?corrupt(stage,target):JSON.stringify(target);
   if(STAGES.includes(stage)&&(!repair||attempt>0)){
    validateSchema(target,payload.output_schema,'output',true);
    captured.push({stage,messages:body.messages,target,variant:repair?'repair':'normal',wire_schema:payload.output_schema});
   }
   return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:text}}]}),{status:200,headers:{'content-type':'application/json'}});
  }});
 const original=gateway.agentComplete.bind(gateway);
 gateway.agentComplete=async(...args)=>{
  const value=await original(...args);
  if(args[0]==='final_analysis_plan_draft')throw STOP;
  return value;
 };
 const operation={controller:new AbortController(),requestId:'offline-curriculum'};
 const state=await gateway.relationshipState(source.context,null,operation,true);
 try{await runRelationshipAgent(gateway,{...source.context,relationship_state:state.relationship_memory},state.patient_state,state.name_index,operation);}
 catch(error){if(error!==STOP)throw error;}
 assert.deepEqual(captured.map(r=>r.stage),STAGES);
 for(const r of captured)assert.equal(attempts.get(r.stage),repair?2:1,'Unexpected retry count');
 return captured;
}

function sourceManifest(){
 const files=[];
 for(const name of fs.readdirSync(path.join(REPO,'app/src')).filter(n=>n.endsWith('.js')).sort())files.push('app/src/'+name);
 files.push('app/tests/evidence-wire.fixture.js','ai/scripts/local12b_generation_contract.mjs');
 return Object.fromEntries(files.map(name=>[name,digest(fs.readFileSync(path.join(REPO,name)))]));
}
export function makeCoverage(inputs,refs){
 assert.equal(inputs.length,refs.length);assert.equal(new Set(inputs.map(r=>r.request_id)).size,inputs.length);
 assert.deepEqual(inputs.map(r=>r.request_id).sort(),refs.map(r=>r.request_id).sort());
 for(const input of inputs){
  const ref=refs.find(r=>r.request_id===input.request_id);
  for(const key of ['task','stage','variant','split','source_root_ids'])assert.deepEqual(input[key],ref[key],'Input/reference identity mismatch');
  assert.equal(input.task,'app_generation');assert.ok(STAGES.includes(input.stage)&&['normal','repair'].includes(input.variant));
  assert.equal(input.source_root_ids.length,1);
  assert.ok(input.messages.every(m=>!m.content.includes(input.source_root_ids[0])&&!m.content.includes(input.request_id)),'Private identity leaked');
 }
 return {schema:VERSION,split:inputs[0]?.split,request_ids:inputs.map(r=>r.request_id).sort(),source_roots:[...new Set(inputs.flatMap(r=>r.source_root_ids))].sort(),
  input_sha256:digest(inputs),reference_sha256:digest(refs),buckets:Object.fromEntries(STAGES.flatMap(stage=>['normal','repair'].map(v=>[stage+'/'+v,inputs.filter(r=>r.stage===stage&&r.variant===v).length])))};
}
export async function build(output){
 output=path.resolve(output);assert.equal(path.dirname(output),path.join(REPO,'training_data'));assert.ok(!fs.existsSync(output),'Fresh output required');
 execFileSync('git',['check-ignore','-q',path.join(output,'data.jsonl')],{cwd:REPO});
 const frozen=sourceManifest(),allSources=sources(),seen=new Set();fs.mkdirSync(output,{mode:0o700});
 writeRows(path.join(output,'sources.jsonl'),allSources);
 const counts={};
 for(const split of ['train','validation','test']){
  const inputs=[],refs=[],training=[];
  for(const source of allSources.filter(s=>s.split===split))for(const repair of [false,true]){
   for(const captured of await captureSource(source,repair)){
    const {messages,target,stage,variant}=captured,request_id=digest([VERSION,source.source_root_id,stage,variant]).slice(0,24);
    assert.ok(!seen.has(digest(messages)),'Cross-split or variant duplicate prompt');seen.add(digest(messages));
    const common={request_id,task:'app_generation',stage,variant,source_root_ids:[source.source_root_id],split};
    inputs.push({...common,messages});refs.push({...common,target,target_sha256:digest(target)});
    training.push({...common,row_id:request_id,source_group_ids:[source.source_root_id],target,weight:{numerator:1,denominator:1},messages:[...messages,{role:'assistant',content:canonical(target)}],loss_message_mask:[...messages.map(()=>0),1],target_sha256:digest(target)});
   }
  }
  writeRows(path.join(output,`evaluation/app_generation/${split}/inputs.jsonl`),inputs);writeRows(path.join(output,`evaluation/app_generation/${split}/references.jsonl`),refs);
  write(path.join(output,`evaluation/app_generation/${split}/COVERAGE.json`),makeCoverage(inputs,refs));
  if(split!=='test')writeRows(path.join(output,`data/app_generation/${split}.jsonl`),training);
  counts[split]={sources:allSources.filter(s=>s.split===split).length,rows:inputs.length};
 }
 assert.deepEqual(sourceManifest(),frozen,'App source changed during build');
 write(path.join(output,'SOURCE_BINDING.json'),{schema:VERSION,files:frozen,profile:'actual ModelGateway prompt wire; separate final state, bundled analysis-plan, no network',legacy_six_project_fixtures_reused:false});
 write(path.join(output,'CONTRACT.json'),{schema:VERSION,counts,task:'app_generation',stages:STAGES,training_started:false,trainer_hook_connected:false,training_ready:false,
  limitations:['Synthetic source-disjoint splits share templates; no real-world generalization claim.','Final plan reference exactness is a conservative fixture score, not a general semantic judge.','CPU app contract pass is not model quality evidence; test cannot select checkpoints.']});
 return verify(output);
}

function strictJSON(text){
 assert.equal(typeof text,'string');const value=JSON.parse(text),stack=[];
 for(const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)){
  const token=match[0];if(token==='{')stack.push(new Set());else if(token==='[')stack.push(null);else if(token==='}'||token===']')stack.pop();
  else if(token.startsWith('"')&&/^\s*:/.test(text.slice(match.index+token.length))){const keys=stack.at(-1),key=JSON.parse(token);assert.ok(keys instanceof Set&&!keys.has(key),'duplicate_json_key');keys.add(key);}
 }
 return value;
}
function duplicateFacts(value){
 const facts=value.patient_state?.facts;
 return facts&&new Set(facts.map(f=>canonical(f.s?{s:f.s}:{subject:f.subject,question_id:f.question_id}))).size!==facts.length;
}
export function score(inputs,refs,outputs,coverage,{baseline=null,split='validation'}={}){
 assert.deepEqual(coverage,makeCoverage(inputs,refs),'Frozen coverage mismatch');
 assert.ok(inputs.length&&inputs.every(r=>r.split===split));
 const expected=new Set(inputs.map(r=>r.request_id)),received=new Map();
 for(const o of outputs){assert.ok(expected.has(o.request_id)&&!received.has(o.request_id),'Unexpected or duplicate output');received.set(o.request_id,o);}
 const records=[];
 for(const input of inputs){
  const ref=refs.find(r=>r.request_id===input.request_id),output=received.get(input.request_id);let reason=null,schema_valid=false,reference_exact=false;
  try{
   assert.ok(output,'missing_output');assert.equal(output.status,'ok','unsuccessful_output');assert.equal(output.finish_reason,'stop','incomplete_output');
   const value=strictJSON(output.text),payload=JSON.parse(input.messages.at(-1).content);
   validateSchema(value,payload.output_schema,'output',true);schema_valid=true;
   assert.ok(!duplicateFacts(value),'duplicate_current_state');
   if(value.relationship_memory)for(const group of ['patient','supporter','relationship'])for(const item of value.relationship_memory[group])assert.equal(new Set(item.evidence.map(canonical)).size,item.evidence.length,'duplicate_evidence');
   reference_exact=canonical(value)===canonical(ref.target);
   assert.ok(reference_exact,'reference_target_mismatch');
  }catch(e){reason=e.modelReason||e.message||'invalid';}
  records.push({request_id:input.request_id,stage:input.stage,variant:input.variant,source_root_id:input.source_root_ids[0],schema_valid,reference_exact,passed:!reason,reason});
 }
 const groups={};
 for(const stage of STAGES)for(const variant of ['normal','repair']){
  const r=records.filter(r=>r.stage===stage&&r.variant===variant);groups[stage+'/'+variant]={assigned:r.length,passed:r.filter(r=>r.passed).length};
 }
 assert.ok(Object.values(groups).every(g=>g.assigned>0),'Missing stage/variant');
 const cohort=digest(coverage),failures=records.filter(r=>!r.passed).length,regressions=[];
 if(baseline){assert.equal(baseline.schema,VERSION);assert.equal(baseline.cohort_sha256,cohort);assert.equal(baseline.received,inputs.length);assert.equal(baseline.records.length,inputs.length);
  assert.deepEqual(baseline.records.map(r=>r.request_id).sort(),[...expected].sort());
  for(const key of Object.keys(groups)){assert.equal(baseline.groups[key].assigned,groups[key].assigned);if(groups[key].passed<baseline.groups[key].passed)regressions.push(key);}
 }
 return {schema:VERSION,split,cohort_sha256:cohort,assigned:inputs.length,received:received.size,failures,groups,records,
  gate:{passed:failures===0&&!regressions.length,regressions},baseline_verified:!!baseline,
  checkpoint_selection_allowed:false,model_selection_ready:false,ready_for_deployment:false,
  integration_gate_eligible:split==='validation'&&!!baseline&&received.size===inputs.length&&failures===0&&!regressions.length,
  score_scope:'Strict schema and conservative exact-reference task diagnostics. Actual app callbacks verified on all golds during build; candidate free-form semantic correctness not independently established.',training_started:false};
}

export async function verify(output){
 const binding=read(path.join(output,'SOURCE_BINDING.json'));assert.equal(binding.schema,VERSION);assert.deepEqual(binding.files,sourceManifest(),'Application or generator drift');
 const allSources=rows(path.join(output,'sources.jsonl'));assert.deepEqual(allSources,sources());
 const seen=new Set(),sourceSets={},counts={},controls=[];
 for(const split of ['train','validation','test']){
  const base=path.join(output,'evaluation/app_generation',split),inputs=rows(path.join(base,'inputs.jsonl')),refs=rows(path.join(base,'references.jsonl')),coverage=read(path.join(base,'COVERAGE.json'));
  assert.deepEqual(coverage,makeCoverage(inputs,refs));sourceSets[split]=new Set(inputs.flatMap(r=>r.source_root_ids));
  const regenerated=[];
  for(const source of allSources.filter(s=>s.split===split))for(const repair of [false,true])for(const item of await captureSource(source,repair))regenerated.push(item);
  assert.equal(regenerated.length,inputs.length);
  inputs.forEach((input,i)=>{assert.deepEqual(input.messages,regenerated[i].messages);assert.deepEqual(refs[i].target,regenerated[i].target);assert.ok(!seen.has(digest(input.messages)));seen.add(digest(input.messages));});
  const good=refs.map(r=>({request_id:r.request_id,text:JSON.stringify(r.target),finish_reason:'stop',status:'ok'}));
  const report=score(inputs,refs,good,coverage,{split});assert.equal(report.failures,0);
  for(const mode of ['extra_key','missing_key','invalid_json','length','missing','duplicate_key','too_many_facts','too_many_evidence','certainty_flip','unsupported_reference','duplicate_state','negation_flip','unknown_erasure','status_error','missing_status']){
   const bad=clone(good);let index=0;
   if(mode==='missing')bad.pop();
   else {
    if(['too_many_facts','duplicate_state','negation_flip','unknown_erasure','status_error'].includes(mode))index=inputs.findIndex(r=>r.stage==='state_observations');
    if(['too_many_evidence','certainty_flip','unsupported_reference'].includes(mode))index=inputs.findIndex(r=>r.stage==='relationship_memory');
    const v=JSON.parse(bad[index].text);
    if(mode==='extra_key')v.extra=true;
    if(mode==='missing_key')delete v[Object.keys(v)[0]];
    if(mode==='invalid_json')bad[index].text='{';
    if(mode==='length')bad[index].finish_reason='length';
    if(mode==='status_error')bad[index].status='error';
    if(mode==='missing_status')delete bad[index].status;
    if(mode==='duplicate_key'){const k=Object.keys(v)[0];bad[index].text='{'+JSON.stringify(k)+':null,'+bad[index].text.slice(1);}
    if(mode==='too_many_facts')v.patient_state.facts=Array.from({length:9},()=>clone(v.patient_state.facts[0]));
    if(mode==='negation_flip')v.patient_state.facts[0].quote=v.patient_state.facts[0].quote.replace('하지 않겠다고','하겠다고');
    if(mode==='unknown_erasure')v.patient_state.unknowns=[];
    if(mode==='duplicate_state')v.patient_state.facts=[v.patient_state.facts[0],clone(v.patient_state.facts[0])];
    if(mode==='too_many_evidence')v.relationship_memory.patient[0].evidence=Array.from({length:4},()=>clone(v.relationship_memory.patient[0].evidence[0]));
    if(mode==='certainty_flip')v.relationship_memory.patient[0].certainty='tentative';
    if(mode==='unsupported_reference')v.relationship_memory.patient[0].evidence[0]=typeof v.relationship_memory.patient[0].evidence[0]==='string'?'unseen_reference':{subject:'patient',question_id:'missing',quote:'unreported'};
    if(!['invalid_json','duplicate_key'].includes(mode))bad[index].text=JSON.stringify(v);
   }
   const rejected=score(inputs,refs,bad,coverage,{split,baseline:report});assert.ok(!rejected.gate.passed&&!rejected.integration_gate_eligible);controls.push(split+'/'+mode);
  }
  if(split!=='test'){
   const train=rows(path.join(output,'data/app_generation',split+'.jsonl'));assert.equal(train.length,inputs.length);
   train.forEach((r,i)=>{assert.deepEqual(r.messages.slice(0,-1),inputs[i].messages);assert.deepEqual(JSON.parse(r.messages.at(-1).content),refs[i].target);assert.deepEqual(r.loss_message_mask,[...inputs[i].messages.map(()=>0),1]);});
  }else assert.ok(!fs.existsSync(path.join(output,'data/app_generation/test.jsonl')));
  counts[split]={sources:sourceSets[split].size,rows:inputs.length};
 }
 for(const a of ['train','validation','test'])for(const b of ['train','validation','test'])if(a!==b)assert.ok(![...sourceSets[a]].some(s=>sourceSets[b].has(s)));
 const report={schema:VERSION,status:'passed',counts,actual_app_gold_callback_passes:seen.size,negative_controls:controls.length,controls,source_overlap:0,prompt_overlap:0,test_in_training:false,training_started:false,trainer_hook_connected:false,model_improvement_measured:false,model_selection_ready:false};
 write(path.join(output,'VERIFICATION.json'),report);return report;
}

async function main(){
 const [command,...args]=process.argv.slice(2),opt={};for(let i=0;i<args.length;i+=2)opt[args[i].replace(/^--/,'')]=args[i+1];
 let result;
 if(command==='build')result=await build(opt.output);
 else if(command==='verify')result=await verify(path.resolve(opt.output));
 else if(command==='score'){
  assert.ok(!fs.existsSync(opt.report));result=score(rows(opt.inputs),rows(opt.references),rows(opt.outputs),read(opt.coverage),{split:opt.split||'validation',baseline:opt.baseline?read(opt.baseline):null});write(opt.report,result);
 }else throw new Error('Use build --output, verify --output, or score --inputs --references --outputs --coverage --report');
 console.log(JSON.stringify(command==='score'?{gate:result.gate,assigned:result.assigned,received:result.received}:result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.stack);process.exitCode=1;});
