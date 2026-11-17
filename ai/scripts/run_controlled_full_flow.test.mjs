import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildFixtures,contextFromFixture,prepare,createResumeBinding,createTransport,instrumentStages,finalContract,auxiliaryChecks,run,hash} from './run_controlled_full_flow.mjs';

const temporary=()=>fs.mkdtempSync(path.join(os.tmpdir(),'malssi-full-flow-'));
const endpoint='http://127.0.0.1:11439/v1';
const request=stage=>({method:'POST',headers:{Authorization:'Bearer test-only'},body:JSON.stringify({
  messages:[{role:'user',content:JSON.stringify({stage,data:{}})}],temperature:.2,max_tokens:3})});
const final=()=>({guide:{script:'안녕. 이야기할까요? 지금 괜찮나요?',doList:['의사를 물어요.'],avoid:['강요하지 않아요.'],next:'답을 기다려요.',care:{feel:'쉬어도 괜찮아요.',tips:['휴식해요.']}},
  agent:{reviewed:true,quality_reviewed:true,stages:['state','state_review','guide','guide_review']}});

test('six synthetic opaque cases make paired, identical production contexts',()=>{
  const root=temporary();
  try {
    const protocol=prepare(root),assignments=JSON.parse(fs.readFileSync(path.join(root,'assignments.json')));
    assert.equal(protocol.assigned_cases,12);assert.equal(protocol.root_lineage_count,6);
    assert.equal(new Set(assignments.map(row=>row.case_id)).size,6);
    for(const row of assignments) {
      assert.match(row.case_id,/^[a-f0-9]{16}$/);
      assert.equal(row.context_sha256,hash(row.context));
      const paired=assignments.find(other=>other.case_id===row.case_id&&other.arm!==row.arm);
      assert.deepEqual(row.context,paired.context);
    }
    assert.throws(()=>prepare(root),/already_exists/);
  }finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('unknown source remains unknown and unknown fixture question rejected',()=>{
  const questions=[{id:'name',subject:'patient',definition:{q:'호칭'}},{id:'want',subject:'user_goal',definition:{q:'목적'}}];
  const fixture={answers:{name:'테스트',want:{status:'unknown',text:'아직 모름'}}};
  const context=contextFromFixture(fixture,questions);
  assert.equal(context.user_goal.message.status,'unknown');
  assert.throws(()=>contextFromFixture({answers:{...fixture.answers,extra:'x'}},questions),/unknown_question/);
});

test('generator scale varies, reviewer remains baseline, raw evidence retained',async()=>{
  const root=temporary(),sent=[];
  try {
    const transport=createTransport({output:root,endpoint,arm:'trained',fetchImpl:async(url,options)=>{
      sent.push(JSON.parse(options.body));return new Response('{"choices":[]}',{status:200,headers:{'content-type':'application/json'}});
    }});
    await transport.generatorFetch(endpoint+'/chat/completions',request('state_observations'));
    await transport.reviewerFetch(endpoint+'/chat/completions',request('state_review'));
    assert.deepEqual(sent.map(row=>row.lora),[[{id:0,scale:1}],[{id:0,scale:0}]]);
    assert.ok(sent.every(row=>row.temperature===0&&row.seed===3407&&row.max_tokens===3&&row.cache_prompt===false));
    assert.equal(transport.records.length,2);
    assert.equal(fs.readFileSync(path.join(root,'http/000001/response.bin'),'utf8'),'{"choices":[]}');
    assert.ok(!fs.readFileSync(path.join(root,'http-events.jsonl'),'utf8').includes('Bearer'));
    await assert.rejects(()=>transport.generatorFetch(endpoint+'/chat/completions',request('state_review')),/routing_mismatch/);
    assert.equal(sent.length,2);
  }finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('shared gate serializes generator and reviewer and records failed HTTP bodies',async()=>{
  const root=temporary();let active=0,maxActive=0;
  try {
    const transport=createTransport({output:root,endpoint,arm:'baseline',fetchImpl:async()=>{
      active++;maxActive=Math.max(maxActive,active);await new Promise(resolve=>setTimeout(resolve,5));active--;
      return new Response('{"error":"synthetic rejection"}',{status:503});
    }});
    const responses=await Promise.all([
      transport.generatorFetch(endpoint+'/chat/completions',request('state')),
      transport.reviewerFetch(endpoint+'/chat/completions',request('state_review'))]);
    assert.equal(maxActive,1);assert.equal(responses[0].status,503);
    assert.equal(transport.records.length,2);
    assert.ok(transport.records.every(row=>row.actual_post&&row.http_status===503&&row.raw_response_sha256));
    assert.ok(transport.records[1].queue_wait_ms>0);
  }finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('aborted queued attempt is evidence without an invented POST',async()=>{
  const root=temporary();let sent=0;
  try {
    const transport=createTransport({output:root,endpoint,arm:'baseline',fetchImpl:async()=>{sent++;return new Response('{}');}});
    const controller=new AbortController();controller.abort();
    await assert.rejects(()=>transport.generatorFetch(endpoint+'/chat/completions',{...request('state'),signal:controller.signal}));
    assert.equal(sent,0);assert.equal(transport.records.length,1);assert.equal(transport.records[0].actual_post,false);
  }finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('completion requires actual reviewed final result and auxiliaries preserve missing data',()=>{
  assert.equal(finalContract(final()),true);
  const value=final();value.agent.quality_reviewed=false;assert.equal(finalContract(value),false);
  assert.equal(auxiliaryChecks(null,{}).A18.value,null);
  const context={patient:{fields:{mood:{id:'mood',text:'상대가 피곤함'}}},supporter:{fields:{feeling:{id:'feeling',text:'저는 편안함'}}},user_goal:{}};
  const result={...final(),patient_state:{facts:[{subject:'supporter',question_id:'feeling',quote:'상대가 피곤함'}]}};
  const checks=auxiliaryChecks(result,context);
  assert.equal(checks.A14.value,0);assert.equal(checks.A16.found_count,1);
  assert.equal(checks.A18.value,null);
  const partial=auxiliaryChecks(null,context,[{stage:'state',output:result,output_sha256:hash(result)}]);
  assert.equal(partial.A16.value,null);
  assert.equal(partial.A16.any_observed_known_violation_count,1);
  assert.equal(partial.partial_discoveries.snapshot_count,1);
});

test('delegated reviews have one stage record with actual reviewer role',async()=>{
  const root=temporary(),stages=[];
  try {
    const reviewer={agentComplete:async()=>({approved:true,issues:[]})};
    const writer={agentComplete:async(...args)=>reviewer.agentComplete(...args)};
    instrumentStages(reviewer,'reviewer',root,stages);instrumentStages(writer,'generator',root,stages);
    await writer.agentComplete('state_review','prompt',{draft:{x:1}},{type:'object'});
    assert.equal(stages.length,1);assert.equal(stages[0].role,'reviewer');assert.equal(stages[0].gateway_origin,'reviewer');
    assert.equal(stages[0].approvals[0].approved,true);
    assert.ok(stages[0].input_payload_sha256&&stages[0].output_sha256);
  }finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('all twelve early failures are terminal cases, not omitted successes or not_run',async()=>{
  const root=temporary(),panel=path.join(root,'panel'),output=path.join(root,'run');
  try {
    prepare(panel);const base=path.join(root,'base.gguf'),adapter=path.join(root,'adapter.gguf');
    fs.writeFileSync(base,'fake-base');fs.writeFileSync(adapter,'fake-adapter');
    const fetchImpl=async url=>new Response(JSON.stringify(url.endsWith('/props')?{model_path:base,model_alias:'mock'}:[{id:0,path:adapter,scale:1}]));
    class FailGateway {
      constructor(options){this.options=options;}
      async agentComplete(){throw new Error('synthetic early rejection');}
      async respond(){return this.agentComplete('state_observations','prompt',{input:'synthetic'},{type:'object'});}
    }
    const summary=await run({root:panel,output,endpoint,baseModel:base,adapter,fetchImpl,Gateway:FailGateway});
    assert.equal(summary.status,'completed');assert.equal(summary.assigned_count,12);
    assert.equal(summary.failed_count,12);assert.equal(summary.not_run_count,0);
    assert.equal(summary.M02.numerator,0);assert.equal(summary.M02.denominator,12);assert.equal(summary.M02.value,0);
    assert.equal(summary.actual_posts,0);
    assert.equal(summary.results[0].auxiliary.A14.value,null);
    assert.ok(fs.existsSync(path.join(output,summary.results[0].logical_case_id.replace(':','-'),'stages')));
  }finally {fs.rmSync(root,{recursive:true,force:true});}
});

async function interruptedFixture(root) {
  const original=path.join(root,'original'),panel=path.join(original,'full-flow'),output=path.join(original,'full-flow-run');
  const protocol=prepare(panel),base=path.join(root,'base.gguf'),adapter=path.join(root,'adapter.gguf');
  fs.writeFileSync(base,'fake-base');fs.writeFileSync(adapter,'fake-adapter');
  for(const file of protocol.source.files) {
    const target=path.join(original,'frozen-source/app',file.path);fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(new URL('../../app/'+file.path,import.meta.url),target);
  }
  const snapshot=path.join(original,'frozen-source/ai/scripts/run_controlled_full_flow.mjs');fs.mkdirSync(path.dirname(snapshot),{recursive:true});
  fs.copyFileSync(new URL('./run_controlled_full_flow.mjs',import.meta.url),snapshot);
  const fetchImpl=async url=>new Response(JSON.stringify(url.endsWith('/props')?{model_path:base,model_alias:'mock'}:[{id:0,path:adapter,scale:1}]));
  let constructed=0;
  class Interrupted {
    constructor(){if(++constructed===19)throw new Error('synthetic_process_interruption');}
    async agentComplete(){throw new Error('synthetic_deadline');}
    async respond(){return this.agentComplete('state_observations','prompt',{synthetic:true},{type:'object'});}
  }
  await assert.rejects(()=>run({root:panel,output,endpoint,baseModel:base,adapter,fetchImpl,Gateway:Interrupted}),/synthetic_process_interruption/);
  const assignments=JSON.parse(fs.readFileSync(path.join(output,'assignments.json')));
  const orphan=path.join(output,assignments[9].logical_case_id.replace(':','-'),'orphan-marker.json');fs.writeFileSync(orphan,'{"preserved":true}\n');
  return {original,panel,output,base,adapter,fetchImpl,orphan};
}

test('explicit resume preserves nine terminal failures byte-for-byte and executes only remaining three',async()=>{
  const root=temporary();
  try {
    const old=await interruptedFixture(root),binding=createResumeBinding(old.output);
    assert.equal(binding.terminal_count,9);
    const raw=fs.readFileSync(path.join(old.output,'results.jsonl'));
    const panel=path.join(root,'resumed/full-flow'),output=path.join(root,'resumed/full-flow-run');
    prepare(panel,{resumeFrom:old.output});let calls=0;
    class Gateway {
      async agentComplete(){throw new Error('synthetic_deadline');}
      async respond(){calls++;return this.agentComplete('state_observations','prompt',{synthetic:true},{type:'object'});}
    }
    const summary=await run({root:panel,output,endpoint,baseModel:old.base,adapter:old.adapter,resumeFrom:old.output,fetchImpl:old.fetchImpl,Gateway});
    assert.equal(calls,3);assert.equal(summary.status,'completed');assert.equal(summary.completed_case_count,12);assert.equal(summary.failed_count,12);
    assert.equal(summary.M02.by_arm.baseline.denominator,6);assert.equal(summary.M02.by_arm.trained.denominator,6);
    assert.equal(summary.not_run_count,0);assert.equal(summary.M02.value,0);
    assert.deepEqual(fs.readFileSync(path.join(output,'results.jsonl')).subarray(0,raw.length),raw);
    assert.deepEqual(createResumeBinding(old.output),binding);
    for(const [file,digest]of Object.entries(binding.terminal_file_manifest))assert.equal(hash(fs.readFileSync(path.join(output,file))),digest);
    assert.equal(fs.readFileSync(old.orphan,'utf8'),'{"preserved":true}\n');
    assert.equal(fs.existsSync(path.join(output,path.relative(old.output,old.orphan))),false);
    const receipt=JSON.parse(fs.readFileSync(path.join(output,'resume-reconciliation.json')));
    assert.equal(receipt.pending_logical_ids.length,3);assert.equal(receipt.prior_nonterminal_records.length,1);
    assert.equal(receipt.prior_nonterminal_records_counted_in_m02,false);
  }finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('resume rejects changed binding and changed model before any model invocation',async()=>{
  const root=temporary();
  try {
    const old=await interruptedFixture(root),panel=path.join(root,'resumed/full-flow');prepare(panel,{resumeFrom:old.output});
    let calls=0;class Gateway {constructor(){calls++;}}
    const file=path.join(panel,'protocol.json'),protocol=JSON.parse(fs.readFileSync(file));
    protocol.resume_from.results_file_sha256='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(protocol));
    await assert.rejects(()=>run({root:panel,output:path.join(root,'mismatch'),endpoint,baseModel:old.base,adapter:old.adapter,resumeFrom:old.output,fetchImpl:old.fetchImpl,Gateway}),/resume_binding/);
    assert.equal(calls,0);
    protocol.resume_from=createResumeBinding(old.output);fs.writeFileSync(file,JSON.stringify(protocol));
    fs.writeFileSync(old.base,'changed-base');
    await assert.rejects(()=>run({root:panel,output:path.join(root,'wrong-model'),endpoint,baseModel:old.base,adapter:old.adapter,resumeFrom:old.output,fetchImpl:old.fetchImpl,Gateway}),/resume_model_hash/);
    assert.equal(calls,0);
  }finally {fs.rmSync(root,{recursive:true,force:true});}
});
