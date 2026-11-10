import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {COMMON} from '../src/relationship-prompts.js';
import {scopeContext,scopeDraft,scopeBlock,scopeReview} from './helpers/turn-input-optimization-fixture.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';

const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const withoutExecution=({state_agent,...result})=>result;
const contextLimit=()=>new Response(JSON.stringify({error:{type:'invalid_request_error',
  message:'Prompt (20000) exceeds the 10000-token input budget; no text was truncated'}}),{status:400});

function fixture({bundle=true,ctx=scopeContext(),value=scopeDraft(ctx),response,http}={}) {
  const calls=[],logical=[],diagnostics=[];
  const gateway=new ModelGateway({baseUrl:'https://combined-writer.synthetic.invalid/v1',apiKey:'synthetic-only',model:'synthetic-writer',
    protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',stateMode:'combined',
    timeoutMs:0,retryFailures:false,diagnosticLogger:entry=>diagnostics.push(entry),fetchImpl:async(url,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);
      const call={...input,prompt:body.messages[0].content,body};calls.push(call);
      const intercepted=await http?.(call,request);if(intercepted!==undefined)return intercepted;
      const produce=async task=>{
        logical.push(task);
        const output=task.data.output_block?scopeBlock(value,task.data.output_block):
          task.stage.startsWith('turn_draft')?structuredClone(value):scopeReview(task.data);
        return (await response?.(task,output))??output;
      };
      let output;
      if(input.data.tasks) {
        output={};
        for(const task of input.data.tasks) {
          const data={...task.input,...Object.fromEntries(Object.entries(task.shared_input_keys).map(([key,id])=>[key,input.data.shared_inputs[id]]))};
          const instructions=task.instructions.map(rule=>rule.text??input.data.shared_instructions[rule.shared_instruction]).join('\n');
          output[task.id]=await produce({stage:task.stage,data,output_schema:input.output_schema.properties[task.id],
            prompt:COMMON+'\n'+instructions,bundle_stage:input.stage});
        }
      } else output=await produce(call);
      return envelope(evidenceWireFixture(input,output));
    }});
  // The orchestration flag is set directly here; config wiring has its own
  // tests and does not change this fixture's independent HTTP contract.
  gateway.bundleCombinedTurnReviews=bundle;
  return {gateway,ctx,value,calls,logical,diagnostics,run:options=>gateway.updateState(ctx,null,options)};
}

test('combined opt-in uses two POSTs and preserves every independent input/schema/validator',async()=>{
  const baseline=fixture({bundle:false}),candidate=fixture();
  const expected=await baseline.run(),actual=await candidate.run();
  assert.equal(baseline.calls.length,4);assert.equal(candidate.calls.length,2);
  assert.deepEqual(withoutExecution(actual),withoutExecution(expected));
  assert.deepEqual(candidate.calls.map(call=>call.stage),['turn_draft','turn_review_bundle']);
  const bundle=candidate.calls[1];assert.deepEqual(bundle.data.tasks.map(task=>task.id),['state','questions','safety']);
  for(const stage of ['turn_review','question_review','safety_review']) {
    const original=baseline.logical.find(task=>task.stage===stage),current=candidate.logical.find(task=>task.stage===stage);
    assert.deepEqual(current.data,original.data,stage+' retains scope');
    assert.deepEqual(current.output_schema,original.output_schema,stage+' retains schema');
    assert.deepEqual(current.prompt.split('\n').map(line=>line.trim()).filter(Boolean),original.prompt.split('\n').map(line=>line.trim()).filter(Boolean));
    assert.ok(actual.state_agent.stages.includes(stage));
  }
  assert.deepEqual(candidate.ctx,baseline.ctx);
  assert.equal(candidate.diagnostics.filter(row=>row.event==='model_attempt').length,2);
});

test('current scoped block profile uses five POSTs while joint drafting and reviews require two',async()=>{
  const current=fixture(),fast=fixture();
  Object.assign(current.gateway,{stateMode:'combined_blocks',bundleCombinedTurnReviews:false,bundleTurnReviews:true,
    stageScopedQuestionRules:true,blockScopedInputs:true,reuseReviewedName:true});
  const expected=await current.run(),actual=await fast.run();
  assert.equal(current.calls.length,5);assert.equal(fast.calls.length,2);
  assert.deepEqual(withoutExecution(actual),withoutExecution(expected));
});

for(const adaptive of [true,false])test('combined task set handles absent question proposals and null decisions: '+adaptive,async()=>{
  const ctx=scopeContext();ctx.adaptive_questions=adaptive;
  const value=scopeDraft(ctx);if(adaptive)value.questions={skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}};
  const probe=fixture({ctx,value}),output=await probe.run();
  assert.equal(probe.calls.length,2);assert.equal(output.state_agent.reviewed,true);
  if(adaptive)assert.deepEqual(probe.calls[1].data.tasks.map(task=>task.id),['state','safety']);
  else {assert.equal(probe.calls[1].stage,'turn_review');assert.equal(output.safety_signal,undefined);}
});

test('contextual not-needed skip survives independent review without inventing a skipped answer',async()=>{
  const ctx=scopeContext();ctx.answered_count=5;
  const value=scopeDraft(ctx);value.questions.skip[0].reason='not_needed';
  value.questions.skip[0].explanation='현재 보고한 장면과 대화 목적에서 추가 생활 질문은 필요하지 않습니다.';
  const before=structuredClone(ctx),probe=fixture({ctx,value}),output=await probe.run();
  assert.deepEqual(output.question_plan.skip,value.questions.skip);assert.deepEqual(ctx,before);
  assert.equal(ctx.patient.fields.daily,undefined);
  assert.equal(output.patient_state.facts.some(fact=>fact.question_id==='daily'),false);
});

test('unsupported question proposals are cancelled while valid state remains independently approved',async()=>{
  const probe=fixture({response:(task,value)=>task.stage==='question_review'?{audits:value.audits.map(audit=>({...audit,verdict:'unsupported'}))}:value});
  const output=await probe.run();assert.equal(probe.calls.length,2);
  assert.deepEqual(output.question_plan,{skip:[]});assert.equal(output.clarification,null);
});

test('name corrections and identical repeat requests receive new independent reviews',async()=>{
  const probe=fixture();await probe.run();await probe.run();
  assert.equal(probe.calls.length,4,'separate invocations never reuse an approval');
  Object.assign(probe.ctx.patient.fields.name,{text:'하늘',rawText:'하늘'});probe.ctx.patient.alias='하늘';
  probe.value.state.name_index={alias:'하늘',source_question_id:'name',quote:'하늘'};
  const output=await probe.run();
  assert.equal(probe.calls.length,6);assert.deepEqual(output.name_index,probe.value.state.name_index);
  assert.equal(probe.logical.filter(task=>task.stage==='turn_review').length,3);
});

test('a null name is validated in the same two-call contract',async()=>{
  const ctx=scopeContext();delete ctx.patient.fields.name;
  const value=scopeDraft(ctx);value.state.name_index=null;
  const probe=fixture({ctx,value}),output=await probe.run();
  assert.equal(probe.calls.length,2);assert.equal(output.name_index,null);
});

test('state rejection rewrites once and renews all bundled reviews',async()=>{
  const probe=fixture({response:(task,value)=>task.stage==='turn_review'?scopeReview(task.data,true):value});
  const output=await probe.run();assert.equal(probe.calls.length,4);assert.equal(output.state_agent.reviewed,true);
  assert.deepEqual(probe.calls.map(call=>call.stage),['turn_draft','turn_review_bundle','turn_draft_after_review','turn_review_bundle_after_review']);
  for(const stage of ['turn_review','question_review','safety_review'])assert.ok(probe.logical.some(task=>task.stage===stage+'_after_review'));
  assert.equal(probe.diagnostics.some(row=>row.event==='model_review_bundle_fallback'),false);
});

test('persistent state rejection cannot produce approved state',async()=>{
  const probe=fixture({response:(task,value)=>task.stage.startsWith('turn_review')?scopeReview(task.data,true):value});
  await assert.rejects(probe.run(),{modelReason:'state_review_rejected'});assert.equal(probe.calls.length,4);
});

test('confirmed danger stays in the independent safety proposal after a state rewrite',async()=>{
  const ctx=scopeContext();ctx.patient.fields.risk={id:'risk',question:'현재 위험',status:'answered',text:'지금 다치는 폭력이 계속되고 있어요.',rawText:'지금 다치는 폭력이 계속되고 있어요.',custom:''};
  const probe=fixture({ctx,response:(task,value)=>{
    if(task.stage==='turn_review')return scopeReview(task.data,true);
    if(task.stage==='safety_review')return {basis:'current_physical_danger',reason:'현재 위험을 보고한 원문입니다.',evidence_ids:[task.data.safety_sources.find(row=>row.question_id==='risk').id]};
    if(task.stage==='safety_review_after_review')assert.equal(task.data.proposed_safety.urgent,true);
    return value;
  }});
  const output=await probe.run();assert.equal(probe.calls.length,4);
  assert.equal(output.finish_early,true);assert.equal(output.safety_signal.urgent,true);
  assert.deepEqual(output.question_plan,{skip:[]});assert.equal(output.clarification,null);
});

for(const kind of ['missing_audit','scope','coverage'])test('invalid combined bundle falls back to all original gates: '+kind,async()=>{
  const probe=fixture({response:(task,value)=>{
    if(!task.bundle_stage||task.stage!=='turn_review')return value;
    if(kind==='missing_audit')delete value.state.audits;
    if(kind==='scope'){value.state.approved=false;value.state.issues=[{reason:'audits 출력이 잘못되었습니다.',repair:'audits를 다시 작성하세요.'}];}
    if(kind==='coverage')value.state.audits[1].id=value.state.audits[0].id;
    return value;
  }});
  const output=await probe.run();assert.equal(output.state_agent.reviewed,true);
  assert.equal(probe.calls.filter(call=>call.stage==='turn_review_bundle').length,3);
  assert.deepEqual(probe.calls.slice(-3).map(call=>call.stage),['turn_review','question_review','safety_review']);
  assert.equal(probe.calls.length,7);
});

test('context budget fallback preserves whole original inputs',async()=>{
  const probe=fixture({http:call=>call.data.tasks?contextLimit():undefined});
  const output=await probe.run();assert.equal(output.state_agent.reviewed,true);
  assert.equal(probe.calls.length,5);assert.equal(probe.calls.filter(call=>call.stage==='turn_draft').length,1);
  for(const stage of ['turn_review','question_review','safety_review'])assert.ok(probe.calls.some(call=>call.stage===stage));
});

test('cancelled combined bundle cannot return state or enter fallback',async()=>{
  const controller=new AbortController();
  const probe=fixture({http:call=>{if(call.data.tasks)controller.abort();}});
  await assert.rejects(probe.run({signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.equal(probe.calls.length,2);assert.equal(probe.diagnostics.some(row=>row.event==='model_review_bundle_fallback'),false);
});

test('structurally exhausted combined draft retains the existing bounded block fallback and review gates',async()=>{
  const probe=fixture({http:call=>call.stage==='turn_draft'?envelope({}):undefined});
  const output=await probe.run();assert.equal(output.state_agent.reviewed,true);
  assert.equal(probe.calls.filter(call=>call.stage==='turn_draft').length,3);
  assert.equal(probe.calls.filter(call=>call.stage.startsWith('turn_draft_block_')).length,4);
  assert.equal(probe.calls.filter(call=>call.stage==='turn_review_bundle').length,1);
  assert.equal(probe.calls.length,8);
});

test('a combined bundle authentication failure cannot become individual fallback approval',async()=>{
  const probe=fixture({http:call=>call.data.tasks?new Response('{}',{status:401}):undefined});
  await assert.rejects(probe.run(),{code:'MODEL_AUTH_FAILED'});
  assert.deepEqual(probe.calls.map(call=>call.stage),['turn_draft','turn_review_bundle']);
  assert.equal(probe.diagnostics.some(row=>row.event==='model_review_bundle_fallback'),false);
});

test('the combined bundle uses the independent reviewer and its token policy',async()=>{
  const probe=fixture(),transport=probe.gateway.fetchImpl;let gets=0;
  probe.gateway.reviewGateway=new ModelGateway({baseUrl:'https://combined-reviewer.synthetic.invalid/v1',apiKey:'synthetic-review-key',model:'synthetic-reviewer',
    protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',timeoutMs:0,retryFailures:false,discoverTokenLimits:true,reuseTokenPolicy:true,
    diagnosticLogger:entry=>probe.diagnostics.push(entry),fetchImpl:async(url,request)=>{
      if(request.method==='GET'){gets++;return new Response(JSON.stringify({model:'synthetic-reviewer',max_output_tokens:4096,max_context_tokens:32768,token_policy_revision:'a'.repeat(64)}));}
      const body=JSON.parse(request.body);assert.equal(body.model,'synthetic-reviewer');assert.equal(body.max_tokens,4096);
      assert.equal(request.headers.Authorization,'Bearer synthetic-review-key');return transport(url,request);
    }});
  probe.gateway.fetchImpl=(url,request)=>{const input=JSON.parse(JSON.parse(request.body).messages.at(-1).content);assert.equal(input.stage,'turn_draft');return transport(url,request);};
  assert.equal((await probe.run()).state_agent.reviewed,true);assert.equal(probe.calls.length,2);assert.equal(gets,1);
  const attempts=probe.diagnostics.filter(row=>row.event==='model_attempt');
  assert.deepEqual(attempts.map(row=>row.model_role),['writer','reviewer']);
  assert.equal(new Set(attempts.map(row=>row.operation_id)).size,1);
});
