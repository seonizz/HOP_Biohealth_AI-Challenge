import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {COMMON} from '../src/relationship-prompts.js';
import {createIntake,currentView,answerIntake,applyModelUpdate,buildContext,backIntake} from '../src/intake.js';
import {scopeContext,scopeDraft,scopeBlock,scopeReview} from './helpers/turn-input-optimization-fixture.js';
import {evidenceWireFixture} from './evidence-wire.fixture.js';

const withoutExecution=({state_agent,...output})=>output;
const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const normalizedPrompt=prompt=>prompt.split('\n').map(line=>line.trim()).filter(Boolean);
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const contextLimit=()=>new Response(JSON.stringify({error:{type:'invalid_request_error',message:'Prompt (20000) exceeds the 10000-token input budget; no text was truncated'}}),{status:400});

// Provider outputs are synthetic. Real HTTP parsing, validators, review
// routing, token policy, retries and intake persistence are exercised locally.
function fixture({bundle=true,ctx=scopeContext(),value=scopeDraft(ctx),response,http,options={}}={}) {
  const calls=[],logical=[],diagnostics=[];
  const gateway=new ModelGateway({baseUrl:'https://writer.synthetic.invalid/v1',apiKey:'synthetic-only',model:'synthetic-writer',
    protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',stateMode:'combined_blocks',
    stageScopedQuestionRules:true,blockScopedInputs:true,bundleTurnReviews:bundle,timeoutMs:0,retryFailures:false,
    diagnosticLogger:entry=>diagnostics.push(entry),...options,fetchImpl:async(url,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content);
      const call={...input,prompt:body.messages[0].content,body};calls.push(call);
      const intercepted=await http?.(call,request);if(intercepted!==undefined)return intercepted;
      const produce=async task=>{
        logical.push(task);
        const output=task.data.output_block?scopeBlock(value,task.data.output_block):scopeReview(task.data);
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
  return {gateway,ctx,value,calls,logical,diagnostics,run:options=>gateway.updateState(ctx,null,options)};
}

function retain(fixture,result) {
  Object.assign(fixture.ctx,{state_execution:structuredClone(result.state_agent),name_index:structuredClone(result.name_index),
    relationship_state:structuredClone(result.relationship_memory),agent_state:structuredClone(result.patient_state),
    safety_signal:structuredClone(result.safety_signal)});
}
function skipNext(fixture) {
  fixture.ctx.patient.fields.support_requested={id:'support_requested',question:'원하는 도움이 있나요?',status:'skipped',text:'(건너뛰었어요)',rawText:'',custom:''};
  fixture.ctx.latest_answer={subject:'patient',question_id:'support_requested'};
  fixture.ctx.question_candidates=[];
  fixture.ctx.clarification_candidates=[{id:'next_detail',subject:'patient',question:'다른 중요한 내용이 있나요?'}];
  fixture.value.questions.skip=[];fixture.value.questions.clarify=['next_detail'];
}

test('independent state, question and safety tasks retain exact contracts and reduce seven POSTs to five',async()=>{
  const before=fixture({bundle:false}),after=fixture();
  const expected=await before.run(),actual=await after.run();
  assert.equal(before.calls.length,7);assert.equal(after.calls.length,5);
  assert.deepEqual(withoutExecution(actual),withoutExecution(expected));
  assert.deepEqual(after.ctx,before.ctx);
  const bundle=after.calls.find(call=>call.stage==='turn_review_bundle');assert.equal(bundle.data.tasks.length,3);
  for(const stage of ['turn_review','question_review','safety_review']) {
    const original=before.logical.find(call=>call.stage===stage),current=after.logical.find(call=>call.stage===stage);
    assert.deepEqual(current.data,original.data,stage+' input');
    assert.deepEqual(current.output_schema,original.output_schema,stage+' schema');
    assert.deepEqual(normalizedPrompt(current.prompt),normalizedPrompt(original.prompt),stage+' instructions');
    assert.ok(actual.state_agent.stages.includes(stage));
  }
  assert.equal(actual.state_agent.reviewed,true);
  assert.equal(after.diagnostics.filter(row=>row.event==='model_attempt').length,5);
});

test('reviewed-name reuse plus a fresh safety task reduces cached skips from five POSTs to four',async()=>{
  const options={reuseReviewedName:true,reuseReviewedSafety:true};
  const before=fixture({bundle:false,options}),after=fixture({options});
  retain(before,await before.run());retain(after,await after.run());skipNext(before);skipNext(after);
  const firstBefore=before.calls.length,firstAfter=after.calls.length;
  const expected=await before.run(),actual=await after.run();
  assert.equal(before.calls.length-firstBefore,5);assert.equal(after.calls.length-firstAfter,4);
  assert.deepEqual(withoutExecution(actual),withoutExecution(expected));
  assert.equal(expected.state_agent.safety_reuse.reused,true);
  assert.equal(actual.state_agent.name_reuse.reused,true);
  assert.equal(actual.state_agent.safety_reuse,undefined,'a bundle never mints a standalone safety fingerprint');
  assert.equal(after.logical.filter(call=>call.stage==='safety_review').length,2,'safety is freshly checked in each bundle');
  assert.equal(actual.safety_signal.review.basis,'unclear','false remains an uncertain current classification');
});

test('enabling bundles neither consumes nor republishes a previous standalone safety cache',async()=>{
  const value=fixture({bundle:false,options:{reuseReviewedName:true,reuseReviewedSafety:true}});
  retain(value,await value.run());assert.ok(value.ctx.state_execution.safety_reuse);
  value.gateway.bundleTurnReviews=true;skipNext(value);
  const output=await value.run();
  assert.equal(value.logical.filter(call=>call.stage==='safety_review').length,2);
  assert.equal(output.state_agent.safety_reuse,undefined);
  assert.equal(output.state_agent.name_reuse.reused,true);
});

for(const adaptive of [true,false])test('absent question proposals add no review task, adaptive='+adaptive,async()=>{
  const ctx=scopeContext();ctx.adaptive_questions=adaptive;
  const value=scopeDraft(ctx);if(adaptive)value.questions={skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}};
  const probe=fixture({ctx,value}),output=await probe.run();
  const bundle=probe.calls.find(call=>call.stage==='turn_review_bundle');
  if(adaptive)assert.deepEqual(bundle.data.tasks.map(task=>task.id),['state','safety']);
  else {assert.equal(bundle,undefined);assert.equal(probe.calls.at(-1).stage,'turn_review');}
  assert.equal(output.state_agent.reviewed,true);
});

test('semantic state rejection repeats the original draft and all independent reviews without fallback',async()=>{
  const value=fixture({response:(call,output)=>call.stage==='turn_review'?scopeReview(call.data,true):output});
  const output=await value.run();
  assert.equal(value.calls.length,10);
  assert.equal(value.calls.at(-1).stage,'turn_review_bundle_after_review');
  assert.equal(value.diagnostics.some(row=>row.event==='model_review_bundle_fallback'),false);
  for(const stage of ['turn_review','question_review','safety_review'])assert.ok(value.logical.some(call=>call.stage===stage+'_after_review'));
  const repaired=value.calls.find(call=>call.stage==='turn_draft_block_patient_state_after_review');
  assert.equal(repaired.data.review.state.approved,false);
  assert.ok(repaired.data.review.questions.audits.length);
  assert.equal(output.state_agent.reviewed,true);
});

test('shared unknown audits expand back to every original claim before state repair',async()=>{
  const ctx=scopeContext(),draft=scopeDraft(ctx);
  draft.state.relationship_memory.unknowns=[...draft.state.patient_state.unknowns];
  const value=fixture({ctx,value:draft,response:(call,output)=>call.stage==='turn_review'?scopeReview(call.data,true):output});
  await value.run();
  const review=value.logical.find(call=>call.stage==='turn_review');
  const unknowns=review.data.review_target.claims.filter(claim=>claim.kind==='unresolved_information');
  assert.equal(unknowns.length,1,'identical cross-group unknowns keep the existing shared wire audit');
  const repaired=value.calls.find(call=>call.stage==='turn_draft_block_patient_state_after_review');
  const audited=new Set(repaired.data.review.state.audits.map(audit=>audit.id));
  assert.ok(audited.has('patient_state.unknowns.0'));assert.ok(audited.has('relationship_memory.unknowns.0'));
});

test('a confirmed danger cannot be withdrawn by a subsequent state repair',async()=>{
  const ctx=scopeContext();ctx.patient.fields.risk={id:'risk',question:'현재 위험',status:'answered',text:'지금 다치는 폭력이 계속되고 있어요.',rawText:'지금 다치는 폭력이 계속되고 있어요.',custom:''};
  const value=fixture({ctx,response:(call,output)=>{
    if(call.stage==='turn_review')return scopeReview(call.data,true);
    if(call.stage==='safety_review')return {basis:'current_physical_danger',reason:'현재 위험을 보고한 원문입니다.',evidence_ids:[call.data.safety_sources.find(row=>row.question_id==='risk').id]};
    if(call.stage==='safety_review_after_review')assert.equal(call.data.proposed_safety.urgent,true);
    return output;
  }});
  const output=await value.run();
  assert.equal(output.finish_early,true);assert.equal(output.safety_signal.urgent,true);
  assert.deepEqual(output.question_plan,{skip:[]});assert.equal(output.clarification,null);
});

test('question rejection still cancels unsupported skips and optional clarification',async()=>{
  const value=fixture({response:(call,output)=>call.stage==='question_review'?{audits:output.audits.map(audit=>({...audit,verdict:'unsupported'}))}:output});
  const output=await value.run();
  assert.deepEqual(output.question_plan,{skip:[]});assert.equal(output.clarification,null);
});

for(const kind of ['missing audit','state scope','claim coverage'])test('exhausted bundle '+kind+' falls back to every original request and its validator',async()=>{
  const value=fixture({response:(call,output)=>{
    if(call.stage!=='turn_review'||!call.bundle_stage)return output;
    if(kind==='missing audit')delete output.state.audits;
    else if(kind==='state scope') {output.state.approved=false;output.state.issues=[{reason:'audits 출력이 잘못되었습니다.',repair:'audits를 다시 작성하세요.'}];}
    else output.state.audits[1].id=output.state.audits[0].id;
    return output;
  }});
  const output=await value.run();
  assert.equal(value.calls.filter(call=>call.stage==='turn_review_bundle').length,3);
  assert.deepEqual(value.calls.slice(-3).map(call=>call.stage),['turn_review','question_review','safety_review']);
  assert.equal(value.calls.length,10);assert.equal(output.state_agent.reviewed,true);
  assert.equal(output.state_agent.stages.includes('turn_review_bundle'),false);
  assert.equal(value.diagnostics.filter(row=>row.event==='model_review_bundle_fallback').length,1);
});

test('malformed speculative safety approval is discarded and fallback can return a different reviewed decision',async()=>{
  const value=fixture({response:(call,output)=>{
    if(call.bundle_stage&&call.stage==='turn_review')delete output.state.audits;
    if(call.stage==='safety_review')return {...output,basis:call.bundle_stage?'distress_without_immediate_danger':'negated'};
    return output;
  }});
  const output=await value.run();assert.equal(output.safety_signal.review.basis,'negated');
  assert.equal(output.state_agent.safety_reuse,undefined);
});

test('fallback restores special state-review format repair before completing any state approval',async()=>{
  let individual=0;
  const value=fixture({response:(call,output)=>{
    if(call.stage==='turn_review'&&(call.bundle_stage||++individual===1)) {
      output.state.approved=false;output.state.issues=[{reason:'audits 출력이 잘못되었습니다.',repair:'audits를 다시 작성하세요.'}];
    }
    return output;
  }});
  assert.equal((await value.run()).state_agent.reviewed,true);
  const attempts=value.calls.filter(call=>call.stage==='turn_review');assert.equal(attempts.length,2);
  assert.ok(attempts[1].required_audit_ids.length);
  assert.equal(attempts[1].rejected_output,undefined);
  assert.match(attempts[1].repair_task,/검토기 자신의 이전 JSON/u);
});

test('a confirmed context limit falls back without truncating individual inputs',async()=>{
  const before=fixture({bundle:false}),value=fixture({http:call=>call.data.tasks?contextLimit():undefined});
  const expected=await before.run(),actual=await value.run();
  assert.equal(value.calls.length,8);assert.deepEqual(withoutExecution(actual),withoutExecution(expected));
  for(const stage of ['turn_review','question_review','safety_review']) {
    const original=before.logical.find(call=>call.stage===stage),current=value.logical.find(call=>call.stage===stage);
    assert.deepEqual(current.data,original.data);assert.deepEqual(current.output_schema,original.output_schema);
  }
});

test('exhausted malformed bundle JSON restores the original independent review requests',async()=>{
  const value=fixture({http:call=>call.data.tasks?new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'not-json'}}]})):undefined});
  assert.equal((await value.run()).state_agent.reviewed,true);
  assert.equal(value.calls.filter(call=>call.stage==='turn_review_bundle').length,3);
  assert.deepEqual(value.calls.slice(-3).map(call=>call.stage),['turn_review','question_review','safety_review']);
});

test('fallback stays disabled through semantic repair and restarts but resets for a new operation',async()=>{
  let failStandalone=true;
  const value=fixture({options:{retryFailures:true,retryDelayMs:1},http:call=>{
    if(call.data.tasks)return contextLimit();
    if(call.stage==='turn_review'&&failStandalone){failStandalone=false;return new Response('',{status:503});}
  }});
  const output=await value.run();assert.equal(output.state_agent.reviewed,true);
  assert.equal(value.calls.filter(call=>call.stage==='turn_review_bundle').length,1);
  // Three transient replies exhaust the inner request and force one root retry.
  let failures=0;
  const restart=fixture({options:{retryFailures:true,retryDelayMs:1},http:call=>{
    if(call.data.tasks)return contextLimit();
    if(call.stage==='turn_review'&&failures++<3)return new Response('',{status:503,headers:{'Retry-After':'0'}});
  }});
  await restart.run();assert.equal(restart.calls.filter(call=>call.stage==='turn_review_bundle').length,1);
  assert.equal(restart.diagnostics.filter(row=>row.event==='model_operation_retry').length,1);
  await restart.run();assert.equal(restart.calls.filter(call=>call.stage==='turn_review_bundle').length,2);
});

test('failure fallback cannot approve a state rejected by its original individual gate',async()=>{
  const value=fixture({http:call=>call.data.tasks?contextLimit():undefined,response:(call,output)=>call.stage.startsWith('turn_review')?scopeReview(call.data,true):output});
  await assert.rejects(value.run(),{modelReason:'state_review_rejected'});
  assert.equal(value.calls.filter(call=>call.stage==='turn_review_bundle').length,1);
  assert.ok(value.calls.some(call=>call.stage==='turn_review_after_review'));
  assert.equal(value.ctx.state_execution,undefined);
});

for(const status of [401,503])test('transport failure does not change review mode or approve partial results: '+status,async()=>{
  const value=fixture({http:call=>call.data.tasks?new Response('',{status,headers:{'Retry-After':'0'}}):undefined});
  await assert.rejects(value.run());
  assert.equal(value.calls.some(call=>call.stage==='turn_review'),false);
  assert.equal(value.diagnostics.some(row=>row.event==='model_review_bundle_fallback'),false);
  assert.equal(value.ctx.state_execution,undefined);
});

test('external cancellation discards a late successful bundle and never enters fallback',async()=>{
  const controller=new AbortController(),ready=deferred(),release=deferred();
  const value=fixture({http:async call=>{if(call.data.tasks){ready.resolve();await release.promise;}}});
  const pending=value.run({signal:controller.signal}),rejected=assert.rejects(pending,{code:'MODEL_CANCELLED'});
  await ready.promise;controller.abort();release.resolve();await rejected;
  assert.equal(value.calls.some(call=>call.stage==='turn_review'),false);
  assert.equal(value.ctx.state_execution,undefined);
});

test('bundle and fallback use the independent reviewer policy and count actual POSTs',async()=>{
  for(const fallback of [false,true]) {
    const value=fixture({http:call=>fallback&&call.data.tasks?contextLimit():undefined}),transport=value.gateway.fetchImpl;
    let gets=0;
    const reviewer=new ModelGateway({baseUrl:'https://reviewer.synthetic.invalid/v1',apiKey:'synthetic-review-key',model:'synthetic-reviewer',
      protocol:'relationship_agent',agentFormat:'prompt',reasoningEffort:'omit',timeoutMs:0,retryFailures:false,discoverTokenLimits:true,reuseTokenPolicy:true,
      diagnosticLogger:entry=>value.diagnostics.push(entry),fetchImpl:async(url,request)=>{
        if(request.method==='GET'){gets++;return new Response(JSON.stringify({model:'synthetic-reviewer',max_output_tokens:4096,max_context_tokens:32768,token_policy_revision:'a'.repeat(64)}));}
        const body=JSON.parse(request.body);assert.equal(body.model,'synthetic-reviewer');assert.equal(body.max_tokens,4096);
        assert.equal(request.headers.Authorization,'Bearer synthetic-review-key');return transport(url,request);
      }});
    value.gateway.reviewGateway=reviewer;
    value.gateway.fetchImpl=(url,request)=>{
      const call=JSON.parse(JSON.parse(request.body).messages.at(-1).content);
      assert.ok(call.stage.startsWith('turn_draft'),'reviews never use the writer');return transport(url,request);
    };
    assert.equal((await value.run()).state_agent.reviewed,true);
    assert.equal(gets,fallback?2:1,'a confirmed context failure invalidates the reviewer policy before fallback');
    const attempts=value.diagnostics.filter(row=>row.event==='model_attempt');assert.equal(attempts.length,fallback?8:5);
    assert.deepEqual(attempts.at(-1).http_attempt_index,attempts.length);
    const bundleAttempt=attempts.find(row=>row.generation==='turn_review_bundle');assert.equal(bundleAttempt.model_role,'reviewer');
    assert.deepEqual(bundleAttempt.family_http_attempts,{turn_review_bundle:1});
  }
});

test('saved turn retains reviewed-name metadata and back clears execution provenance',async()=>{
  const value=fixture({options:{reuseReviewedName:true,reuseReviewedSafety:true}}),output=await value.run();
  let state=createIntake();state=answerIntake(state,{question_id:currentView(state).question.id,text:'지민'});
  state=applyModelUpdate(state,{name_index:output.name_index,patient_state:output.patient_state,question_plan:{skip:[]},state_agent:output.state_agent});
  assert.deepEqual(state.agentStateExecution,output.state_agent);
  assert.deepEqual(buildContext(state).state_execution,output.state_agent);
  assert.equal(state.agentStateExecution.safety_reuse,undefined);
  assert.equal(backIntake(state).agentStateExecution,undefined);
});
