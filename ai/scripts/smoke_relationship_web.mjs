// A synthetic intake through the deployed Docker API, including every model turn.
import { readFileSync,writeFileSync,mkdirSync,existsSync } from 'node:fs';
import { request } from 'node:http';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const root=resolve(import.meta.dirname,'..');
const args=process.argv.slice(2);
const runIndex=args.indexOf('--run-id');
const runId=runIndex<0?'':args[runIndex+1];
if(runIndex>=0&&(!runId||!/^[a-z0-9_-]{1,40}$/.test(runId)))throw new Error('invalid_run_id');
const options=args.filter((_,index)=>runIndex<0||(index!==runIndex&&index!==runIndex+1));
if(options.some(arg=>arg!=='--resume'))throw new Error('unknown_option');
const suffix=runId?'-'+runId:'';
const {PROMPT_VERSION}=await import('../local_api/backend_patch/src/relationship-prompts.js');
const env=Object.fromEntries(readFileSync(resolve(root,'../app/.env'),'utf8').split(/\r?\n/).filter(l=>l.includes('=')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1)];}));
const fixture=JSON.parse(readFileSync(resolve(root,'local_api/agent_data/mother_child.json'),'utf8'));
const outputs=resolve(root,'outputs/relationship_agent');mkdirSync(outputs,{recursive:true});
const sessionPath=resolve(root,'local_api/runtime/relationship-smoke-session'+suffix+'.json');
if(runId&&existsSync(sessionPath)&&!options.includes('--resume'))throw new Error('test_run_exists_use_resume');
let cookie='',csrf='';
const timings=[];
function saveSession(view) {
  writeFileSync(sessionPath,JSON.stringify({kind:'synthetic_relationship_web_smoke',origin:env.PUBLIC_ORIGIN,
    cookie,csrf,intake_id:view.id,turns:timings})+'\n',{mode:0o600});
}
function send(path,method='GET',data) {
  return new Promise((resolve,reject)=>{
    const body=data===undefined?null:JSON.stringify(data);
    const req=request({host:'127.0.0.1',port:Number(env.PORT||9000),path,method,
      headers:{Host:new URL(env.PUBLIC_ORIGIN).host,Origin:env.PUBLIC_ORIGIN,
        ...(cookie?{Cookie:cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),
        ...(body?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}:{})}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        let value;try{value=JSON.parse(Buffer.concat(chunks).toString());}catch{reject(new Error('invalid_response'));return;}
        if(res.statusCode>=400){reject(Object.assign(new Error(value.error?.code||'http_error'),{code:value.error?.code,status:res.statusCode}));return;}
        if(res.headers['set-cookie'])cookie=res.headers['set-cookie'][0].split(';')[0];resolve(value);
      });
    });req.on('error',()=>reject(new Error('connection_error')));req.setTimeout(650000,()=>req.destroy());if(body)req.write(body);req.end();
  });
}
const choices={goal:[0,1,3],rel:[1],contact:[0],mood:[2,6,9,10,11,12,14,15],dur:[3],freq:[3],cause:[0],events:[6,7],support:[0],burden:[0],help:[4,6],barrier:[0,2,4],moment_freq:[1],cgchange:[0,2,5],mysupport:[0,1]};
const customs={mood:'같은 질문을 하루에도 여러 번 해요. “엄마, 이거 진짜 괜찮은 거지?” 하고 계속 확인해요.'};
customs.events='작년 겨울 수학 학원 반 배정 시험에서 떨어진 뒤로 더 심해졌어요.';
customs.help='담임 선생님과 한 번 이야기한 적이 있어요. 그 밖에는 계획표를 여러 번 고치거나 저한테 계속 확인받는 걸로 버티는 것 같아요.';
customs.mysupport='가족 중에서는 여동생에게 기댈 수 있어요.';
let view;
try {
  if(options.includes('--resume')) {
    const previous=JSON.parse(readFileSync(sessionPath,'utf8'));
    if(previous.kind!=='synthetic_relationship_web_smoke'||previous.origin!==env.PUBLIC_ORIGIN||
      !/^[a-f0-9-]{36}$/.test(previous.intake_id))throw new Error('invalid_test_session');
    cookie=previous.cookie;csrf=previous.csrf;timings.push(...previous.turns);
    view=await send(`/api/intakes/${previous.intake_id}`);
  } else {
    const bootstrap=await send('/api/bootstrap');csrf=bootstrap.csrf_token;
    view=await send('/api/intakes','POST',{});saveSession(view);
  }
  while(view.status==='active') {
    const q=view.question;
    const answer={revision:view.revision,question_id:q.id,follow_up:Boolean(q.follow_up)};
    if(q.type==='text') {
      const text=q.id==='name'?'지민':fixture.answers[q.id];
      if(typeof text!=='string'||!text.trim())throw new Error('missing_synthetic_answer');
      answer.text=text;
    }
    else {
      if(!choices[q.id])throw new Error('missing_synthetic_choice');
      answer.selected=choices[q.id];
      if(!q.noOwn&&customs[q.id]&&q.type==='multi')answer.custom=customs[q.id];
      if(['support','burden'].includes(q.id))answer.text=fixture.answers[q.id];
    }
    const started=performance.now();view=await send(`/api/intakes/${view.id}/answers`,'POST',answer);
    const context=(await send(`/api/intakes/${view.id}/context`)).context;
    if(!context.relationship_state)throw new Error('missing_internal_analysis');
    const item={question_id:q.id,duration_ms:Math.round(performance.now()-started),next_question:view.question?.id||null,
      internal_findings:{patient:context.relationship_state.patient.length,supporter:context.relationship_state.supporter.length,
        relationship:context.relationship_state.relationship.length},
      internal_analysis:context.relationship_state};
    timings.push(item);saveSession(view);console.log(JSON.stringify({...item,internal_analysis:undefined}));
    if(timings.length>40)throw new Error('question_loop');
  }
  const started=performance.now();const value=await send(`/api/intakes/${view.id}/result`,'POST',{revision:view.revision});
  const record=value.record;
  if(record.provenance.model!=='gemma4:12b'||!record.provenance.agent?.reviewed||
    !record.provenance.agent?.quality_reviewed||record.provenance.agent?.retrieval?.method!=='conversation_lexical_v1'||!record.relationship_analysis||!record.context.relationship_state)throw new Error('missing_agent_result');
  if(record.provenance.agent.prompt_version!==PROMPT_VERSION)throw new Error('unexpected_prompt_version');
  if(!record.relationship_analysis.observations)throw new Error('missing_original_observations');
  const replay=await send(`/api/records/${record.id}`);
  if(!isDeepStrictEqual(replay.record.relationship_analysis,record.relationship_analysis))throw new Error('record_mismatch');
  const expected=fixture.expectations||{};
  if(expected.safety!==undefined && record.profile.safety!==expected.safety)throw new Error('unexpected_safety');
  if(expected.relationship_label && record.relationship_analysis.relationship.label!==expected.relationship_label)throw new Error('unexpected_relationship');
  if((expected.script_forbidden||[]).some(word=>record.guide.script.includes(word)))throw new Error('invented_script_role');
  for(const alternatives of expected.script_contains_any||[]) {
    if(!alternatives.some(word=>record.guide.script.includes(word)))throw new Error('missing_required_script_intent');
  }
  const finalDuration=Math.round(performance.now()-started);
  writeFileSync(resolve(outputs,'docker_web_smoke'+suffix+'.json'),JSON.stringify({synthetic:true,measured_at:new Date().toISOString(),
    intake_id:view.id,record_id:record.id,turns:timings,final_duration_ms:finalDuration,record},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:'passed',model:record.provenance.model,turns:timings.length,
    final_duration_ms:finalDuration,stages:record.provenance.agent.stages,record_id:record.id}));
} catch(error) {
  writeFileSync(resolve(outputs,'docker_web_smoke'+suffix+'-failure.json'),JSON.stringify({synthetic:true,intake_id:view?.id,code:error.code||error.message,turns:timings},null,2)+'\n',{mode:0o600});
  console.error(JSON.stringify({status:'failed',code:error.code||error.message,question:view?.question?.id}));process.exitCode=1;
}
