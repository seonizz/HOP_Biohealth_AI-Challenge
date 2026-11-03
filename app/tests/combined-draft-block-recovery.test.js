import {evidenceWireFixture} from './evidence-wire.fixture.js';
import {safetyReviewFixture} from './helpers/safety-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway, relationshipEvidenceTransport } from '../src/model.js';
import { runCombinedRelationshipState } from '../src/relationship-turn.js';
import { HttpError } from '../src/errors.js';
import { safetySources } from '../src/relationship-agent.js';

const field=(id,text)=>({id,question:id,status:'answered',text,rawText:text,custom:''});
const context=()=>({patient:{alias:'지민',fields:{name:field('name','지민'),mood:field('mood','밤에 계획표를 고치지만 지금 해칠 생각은 없다고 말했어요.')}},
  supporter:{fields:{feeling:field('feeling','제 생활도 돌보며 이야기를 듣고 싶어요.')}},
  user_goal:{message:field('want','원할 때 이야기를 듣고 싶어요.')},latest_answer:{subject:'patient',question_id:'mood'},answered_count:4,
  adaptive_questions:true,question_candidates:[{id:'daily',subject:'patient',question:'생활은 어떤가요?'}],
  clarification_candidates:[{id:'support_requested',subject:'patient',question:'원하는 도움이 있나요?'}]});
const ref=(ctx,subject='patient',id='mood')=>({subject,question_id:id,quote:ctx[subject].fields[id].rawText});
const draft=ctx=>({state:{patient_state:{facts:[{...ref(ctx),certainty:'reported'}],unknowns:['이용자가 함께할 수 있는 시간']},
  name_index:{alias:'지민',source_question_id:'name',quote:'지민'},relationship_memory:{patient:[{certainty:'reported',evidence:[ref(ctx)]}],
    supporter:[],relationship:[],unknowns:['현재 원하는 도움의 범위']}},questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}});
const review=(data,reject=false)=>data.proposed_safety?safetyReviewFixture(data):
  data.claims?{audits:data.claims.map(({id})=>({id,verdict:'supported',reason:'합성 원문 대조'}))}:({state:{approved:!reject,issues:reject?[{reason:'현재 범위를 다시 검토해야 합니다.',repair:'원문의 범위를 다시 선택하세요.'}]:[],
  audits:data.review_target.claims.map(claim=>({id:claim.id,verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문 대조'}))},
  questions:data.questions?{audits:data.questions.claims.map(claim=>({id:claim.id,verdict:'supported',reason:'합성 원문 대조'}))}:null,
  safety:data.safety?{basis:'current_physical_danger',reason:'현재 위험을 원문으로 확인했습니다.'}:null});
const blocks=['patient_state','name_index','relationship_memory','questions'];
const dispatchedBlocks=['patient_state','questions','name_index','relationship_memory'];
const blockPart=(value,block)=>structuredClone(block==='questions'?value.questions:value.state[block]);
const blockValue=(value,block)=>block==='name_index'?{name_index:blockPart(value,block)}:blockPart(value,block);
const missing=ctx=>{const value=draft(ctx);delete value.state.relationship_memory.unknowns;return value;};
const envelope=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
const stream=value=>new Response('data: '+JSON.stringify({choices:[{index:0,delta:{content:typeof value==='string'?value:JSON.stringify(value)},finish_reason:null}]})+
  '\n\ndata: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}});
function model(handler,options={}){
  const calls=[];
  const gateway=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',protocol:'relationship_agent',
    agentFormat:'json_object',timeoutMs:0,retryFailures:false,diagnosticLogger:null,...options,fetchImpl:async(_url,request)=>{
      const body=JSON.parse(request.body),input=JSON.parse(body.messages.at(-1).content),call={...input,prompt:body.messages[0].content,request};
      calls.push(call);const value=await handler(call,calls.length);return value instanceof Response?value:envelope(evidenceWireFixture(call,value));
    }});
  return {gateway,calls};
}
const fake=handler=>({calls:[],async agentComplete(stage,prompt,data,schema,operation,validate){
  const call={stage,prompt,data,schema,operation,validate};this.calls.push(call);return validate(await handler(call));
}});
const failure=(reason,attempts=3,code='MODEL_INVALID_RESPONSE',structural=attempts)=>{
  const error=new HttpError(502,code,'합성 오류');error.modelReason=reason;
  if(attempts!==undefined)Object.defineProperties(error,{modelAttempts:{value:attempts},modelStructuralFailures:{value:structural}});return error;
};
const trigger=call=>{try{call.validate(missing(call.ctx));}catch(error){Object.defineProperties(error,{modelAttempts:{value:3},modelStructuralFailures:{value:3}});throw error;}};

test('only three exhausted combined format failures generate four exact-schema blocks before independent review',async t=>{
  const ctx=context(),value=draft(ctx),bad=missing(ctx),source=structuredClone(ctx),logs=[];
  value.questions.clarify=['support_requested'];
  const {gateway,calls}=model(call=>call.stage==='turn_draft'?bad:
    call.stage.startsWith('turn_draft_block_')?blockValue(value,call.data.output_block):review(call.data),{diagnosticLogger:entry=>logs.push(entry)});
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  assert.deepEqual(calls.map(call=>call.stage),['turn_draft','turn_draft','turn_draft',...dispatchedBlocks.map(block=>'turn_draft_block_'+block),'turn_review','question_review','safety_review']);
  const original=calls[0],partCalls=calls.slice(3,7);
  for(const call of partCalls){
    const block=call.data.output_block,index=blocks.indexOf(block),expected=block==='questions'?original.output_schema.properties.questions:original.output_schema.properties.state.properties[block];
    assert.deepEqual(block==='name_index'?call.output_schema.properties.name_index:call.output_schema,block==='relationship_memory'?relationshipEvidenceTransport(call.stage,expected).schema:expected);
    assert.equal(call.output_schema.type,'object');assert.equal(call.output_schema.additionalProperties,false);
    assert.equal(Object.hasOwn(call.data,'combined_output_schema'),false);assert.equal(Object.hasOwn(call.data,'failed_combined_candidate'),false);
    for(const name of ['shared_input','state_input','question_input'])assert.deepEqual(call.data[name],original.data[name]);
    if(block==='questions')assert.equal(Object.hasOwn(call.data,'generated_blocks'),false);
    else {
      assert.deepEqual(Object.keys(call.data.generated_blocks),blocks.slice(0,index));
      for(const previous of blocks.slice(0,index))assert.deepEqual(call.data.generated_blocks[previous],blockPart(value,previous));
    }
    assert.match(call.prompt,/승인되지 않은 모델 출력/u);assert.match(call.prompt,/최상위 키/u);
    assert.equal(JSON.parse(call.data.combined_validation_feedback).keyword,'objectKeys');
  }
  assert.equal(result.state_agent.reviewed,true);assert.deepEqual(result.state_agent.stages,[...blocks.map(block=>'turn_draft_block_'+block),'turn_review','question_review','safety_review']);
  assert.equal(result.name_index.alias,'지민');assert.equal(result.patient_state.facts[0].quote,ref(ctx).quote);
  assert.deepEqual(result.patient_state.unknowns,value.state.patient_state.unknowns);
  assert.deepEqual(result.relationship_memory.unknowns,value.state.relationship_memory.unknowns);
  assert.equal(result.question_plan.skip.length,0);assert.equal(result.clarification,'support_requested');
  assert.ok(calls.find(call=>call.stage==='question_review').data.claims);assert.equal(calls.find(call=>call.stage==='turn_review').data.review_target.claims.filter(claim=>claim.certainty==='unknown').length,2);
  assert.deepEqual(ctx,source);assert.deepEqual(bad,missing(ctx));assert.ok(!JSON.stringify(logs).includes(ref(ctx).quote));
});

for(const badCount of [0,1,2])test('a combined draft repaired within its existing attempts never enters block mode: '+badCount,async t=>{
  const ctx=context();let drafts=0;
  const {gateway,calls}=model(call=>call.stage==='turn_draft'?(++drafts<=badCount?missing(ctx):draft(ctx)):review(call.data));
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  assert.equal(result.state_agent.reviewed,true);assert.equal(calls.length,badCount+3);assert.ok(!calls.some(call=>call.data.output_block));
});

test('a reported finding repairs without reintroducing the failed full draft as its template',async t=>{
  const ctx=context(),value=draft(ctx),bad=structuredClone(value);let memories=0;
  bad.state.relationship_memory.patient[0].interpretation='PRIVATE_REJECTED_SUMMARY';
  const {gateway,calls}=model(call=>{
    if(call.stage==='turn_draft')return bad;
    if(!call.data.output_block)return review(call.data);
    assert.equal(Object.hasOwn(call.data,'failed_combined_candidate'),false);
    const result=blockValue(value,call.data.output_block);
    if(call.data.output_block==='relationship_memory'&&++memories===1)
      result.patient[0].interpretation='PRIVATE_REJECTED_SUMMARY';
    return result;
  },{agentFormat:'prompt'});
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  const parts=calls.filter(call=>call.data.output_block==='relationship_memory');
  assert.equal(parts.length,2);assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(parts[0].data.generated_blocks.patient_state,value.state.patient_state);
  const feedback=JSON.parse(parts[1].validation_feedback);
  assert.equal(feedback.keyword,'objectKeys');assert.deepEqual(feedback.expected.keys,['evidence','certainty']);
  assert.equal(parts[1].rejected_output.patient[0].interpretation,'PRIVATE_REJECTED_SUMMARY');
  assert.ok(calls.some(call=>call.stage==='turn_review'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE_REJECTED_SUMMARY'));
});

test('exhausted malformed JSON can use blocks without inventing a parsed rejected candidate',async t=>{
  const ctx=context(),value=draft(ctx);
  const {gateway,calls}=model(call=>call.stage==='turn_draft'
    ?new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'not JSON'}}]}))
    :call.data.output_block?blockValue(value,call.data.output_block):review(call.data));
  assert.equal((await gateway.updateState(ctx,null,{signal:t.signal})).state_agent.reviewed,true);
  assert.equal(calls.length,9);assert.ok(calls.slice(3,7).every(call=>!Object.hasOwn(call.data,'failed_combined_candidate')));
});

for(const [label,error]of [
  ['unexhausted schema',failure('agent_schema',2)],['unmarked schema',failure('agent_schema',null)],
  ['mixed structural failures',failure('agent_schema',3,'MODEL_INVALID_RESPONSE',2)],
  ['source evidence',failure('agent_evidence')],['review rejection',failure('state_review_rejected')],
  ['authentication',failure('agent_schema',3,'MODEL_AUTH_FAILED')],['network',failure('agent_schema',3,'MODEL_UNAVAILABLE')],
  ['cancellation',failure('agent_schema',3,'MODEL_CANCELLED')],
])test('other failures cannot trigger structural fallback: '+label,async()=>{
  const ctx=context(),operation={recovery:{}},gateway=fake(()=>{throw error;});
  await assert.rejects(runCombinedRelationshipState(gateway,ctx,null,operation),candidate=>candidate===error);
  assert.equal(gateway.calls.length,1);assert.deepEqual(operation.recovery,{});
});

for(const fault of ['missing_unknowns','four_facts','extra_root'])test('block validation cannot fill, truncate or discard invalid model output: '+fault,async t=>{
  const ctx=context(),value=draft(ctx);let reviews=0;
  const {gateway,calls}=model(call=>{
    if(call.stage==='turn_draft')return missing(ctx);
    if(!call.data.output_block){reviews++;return review(call.data);}
    const result=blockValue(value,call.data.output_block);
    if(fault==='missing_unknowns'&&call.data.output_block==='relationship_memory')delete result.unknowns;
    if(fault==='four_facts'&&call.data.output_block==='patient_state')result.facts=Array.from({length:4},()=>structuredClone(value.state.patient_state.facts[0]));
    if(fault==='extra_root')result.unrequested=[];
    return result;
  });
  await assert.rejects(gateway.updateState(ctx,null,{signal:t.signal}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.equal(reviews,0);const failedBlock=fault==='missing_unknowns'?'relationship_memory':'patient_state';
  assert.equal(calls.filter(call=>call.data.output_block===failedBlock).length,3);
});

test('all individually valid blocks still undergo the full source validator before review',async t=>{
  const ctx=context(),value=draft(ctx);value.state.patient_state.facts[0].quote='원문에 존재하지 않는 합성 인용';
  const {gateway,calls}=model(call=>call.stage==='turn_draft'?missing(ctx):call.data.output_block?blockValue(value,call.data.output_block):review(call.data));
  await assert.rejects(gateway.updateState(ctx,null,{signal:t.signal}),{code:'MODEL_INVALID_RESPONSE'});
  assert.ok(!calls.some(call=>call.stage.startsWith('turn_review')));
});

test('inactive question work keeps its fixed null contract without calling a model or inventing a completed stage',async t=>{
  for(const stateMode of ['combined','combined_blocks']){
    const ctx=context(),value=draft(ctx);ctx.adaptive_questions=false;value.questions=null;
    const {gateway,calls}=model(call=>call.stage==='turn_draft'?{state:value.state}:
      call.data.output_block?blockValue(value,call.data.output_block):review(call.data),{stateMode});
    const result=await gateway.updateState(ctx,null,{signal:t.signal});assert.equal(result.state_agent.reviewed,true);
    assert.equal(calls.some(call=>call.data.output_block==='questions'),false);
    assert.deepEqual(result.state_agent.stages,[...blocks.slice(0,3).map(block=>'turn_draft_block_'+block),'turn_review']);
    assert.ok(calls.filter(call=>call.data.output_block).every(call=>call.output_schema.type==='object'&&call.data.question_input===null));
    assert.equal(calls.at(-1).data.questions,null);
  }
});

test('a semantic rejection re-generates all four blocks with its exact draft-review pair and a fresh independent review',async t=>{
  const ctx=context(),value=draft(ctx);let reviews=0;
  const {gateway,calls}=model(call=>call.stage==='turn_draft'?missing(ctx):call.data.output_block?blockValue(value,call.data.output_block):review(call.data,call.stage.startsWith('turn_review')&&++reviews===1));
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  assert.equal(reviews,2);assert.equal(result.state_agent.reviewed,true);
  const repaired=calls.filter(call=>call.stage.startsWith('turn_draft_block_')&&call.stage.endsWith('_after_review'));
  assert.equal(repaired.length,4);assert.ok(repaired.every(call=>call.data.review.state.approved===false));
  assert.ok(repaired.every(call=>call.data.rejected_draft.claims.length>0));
  assert.deepEqual(result.state_agent.stages,[...blocks.map(block=>'turn_draft_block_'+block),'turn_review','safety_review',
    ...blocks.map(block=>'turn_draft_block_'+block+'_after_review'),'turn_review_after_review','safety_review_after_review']);
});

test('block mode survives same-context operation restart, clears on success and does not leak to new contexts',async()=>{
  const ctx=context(),operation={recovery:{}};
  const first=fake(call=>{
    if(call.stage==='turn_draft')return trigger({...call,ctx});
    throw failure('http_transient',3,'MODEL_UNAVAILABLE');
  });
  await assert.rejects(runCombinedRelationshipState(first,ctx,null,operation),{code:'MODEL_UNAVAILABLE'});
  assert.ok(operation.recovery.combinedDraft);assert.deepEqual(operation.recovery.combinedDraft.candidate,missing(ctx));
  const saved=structuredClone(operation.recovery),resumed=fake(call=>call.data.output_block?blockValue(draft(ctx),call.data.output_block):review(call.data));
  assert.equal((await runCombinedRelationshipState(resumed,ctx,null,operation)).state_agent.reviewed,true);
  assert.equal(resumed.calls[0].stage,'turn_draft_block_patient_state');assert.deepEqual(operation.recovery,{});
  const changed=context();changed.user_goal.message=field('want','새로운 합성 대화 목표입니다.');
  const next=fake(call=>call.stage==='turn_draft'?draft(changed):review(call.data));operation.recovery=saved;
  assert.equal((await runCombinedRelationshipState(next,changed,null,operation)).state_agent.reviewed,true);
  assert.deepEqual(next.calls.map(call=>call.stage),['turn_draft','turn_review','safety_review']);assert.deepEqual(operation.recovery,{});
});

test('cancellation during a block call cannot continue generation or reach review',async t=>{
  const ctx=context(),controller=new AbortController(),signal=AbortSignal.any([t.signal,controller.signal]);
  const {gateway,calls}=model(call=>{
    if(call.stage==='turn_draft')return missing(ctx);
    controller.abort();return blockValue(draft(ctx),call.data.output_block);
  });
  await assert.rejects(gateway.updateState(ctx,null,{signal}),{code:'MODEL_CANCELLED'});
  assert.equal(calls.length,4);assert.equal(calls.at(-1).stage,'turn_draft_block_patient_state');
});

test('transient transport attempts followed by one schema failure never qualify as three structural failures',async t=>{
  const ctx=context();
  const {gateway,calls}=model((call,count)=>count<=2?new Response('',{status:503}):missing(ctx));
  await assert.rejects(gateway.updateState(ctx,null,{signal:t.signal}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema',modelAttempts:3,modelStructuralFailures:1});
  assert.equal(calls.length,3);assert.ok(calls.every(call=>call.stage==='turn_draft'));
});

test('three outside-string whitespace stalls use the same block recovery without a fabricated candidate',async t=>{
  const ctx=context(),value=draft(ctx);
  const {gateway,calls}=model(call=>stream(call.stage==='turn_draft'?' '.repeat(4097):call.data.output_block?evidenceWireFixture(call,blockValue(value,call.data.output_block)):review(call.data)),
    {baseUrl:'http://127.0.0.1:11434/v1',streamJson:true,agentFormat:'json_schema'});
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  assert.equal(result.state_agent.reviewed,true);assert.equal(calls.length,9);
  assert.ok(calls.slice(3,7).every(call=>!Object.hasOwn(call.data,'failed_combined_candidate')));
  assert.deepEqual(calls.slice(0,3).map(call=>JSON.parse(call.request.body).response_format.type),['json_schema','json_object','json_object']);
});

test('literal block recovery retains the last validated review pair and independently rechecks earlier confirmed danger',async()=>{
  const ctx=context(),operation={recovery:{}};ctx.patient.fields.risk=field('risk','지금 위험한 곳에 있다고 말했어요.');
  const initial=draft(ctx);initial.questions.safety={urgent:true,evidence_ids:[safetySources(ctx).find(source=>source.question_id==='risk').id]};
  const rejected=fake(call=>call.stage.startsWith('turn_draft')?initial:review(call.data,true));
  await assert.rejects(runCombinedRelationshipState(rejected,ctx,null,operation),{modelReason:'state_review_rejected'});
  assert.equal(operation.recovery.combinedTurn.semanticRejections,2);const retained=structuredClone(operation.recovery.combinedTurn);
  const next=fake(call=>{
    if(call.stage==='turn_draft')return trigger({...call,ctx});
    if(call.data.output_block){
      assert.deepEqual(call.data.review,retained.review);assert.deepEqual(call.data.rejected_draft,retained.draft);
      if(call.data.output_block==='relationship_memory'){
        assert.equal(call.schema.properties.relationship.maxItems,0);
        assert.deepEqual(call.schema.properties.patient.items.properties.certainty.enum,['reported']);
      }
      return blockValue(draft(ctx),call.data.output_block);
    }
    if(call.stage.startsWith('safety_review'))assert.ok(call.data.proposed_safety.evidence.some(source=>source.question_id==='risk'));
    else assert.equal(call.data.safety,null);
    return review(call.data);
  });
  const output=await runCombinedRelationshipState(next,ctx,null,operation);
  assert.equal(output.state_agent.reviewed,true);assert.equal(output.finish_early,true);assert.equal(output.safety_signal.urgent,true);
  assert.deepEqual(output.relationship_memory.relationship,[]);assert.equal(output.name_index.alias,'지민');assert.deepEqual(operation.recovery,{});
});

for(const reason of ['already_covered','not_needed'])test('explicit combined_blocks mode starts with exact-schema blocks and independently reviews '+reason,async t=>{
  const ctx=context();ctx.question_candidates.push({id:'extra',subject:'patient',question:'더할 내용이 있나요?'});
  ctx.patient.fields.contact=field('contact','일주일에 몇 번 연락해요.');ctx.answered_count=5;
  Object.assign(ctx.question_candidates[0],{required:false,noSkip:false});
  const source=structuredClone(ctx),value=draft(ctx);
  value.questions.skip=[{question_id:'daily',reason,explanation:reason==='already_covered'?'앞서 생활 장면을 설명했습니다.':'현재 대화에서는 이미 보고한 장면을 먼저 듣습니다.',evidence:[ref(ctx)]}];
  value.questions.clarify=['support_requested'];
  const {gateway,calls}=model(call=>call.data.output_block?blockValue(value,call.data.output_block):review(call.data),{stateMode:'combined_blocks'});
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  assert.equal(gateway.configured,true);
  assert.deepEqual(calls.map(call=>call.stage),[...dispatchedBlocks.map(block=>'turn_draft_block_'+block),'turn_review','question_review','safety_review']);
  assert.deepEqual(result.state_agent.stages,[...blocks.map(block=>'turn_draft_block_'+block),'turn_review','question_review','safety_review']);assert.equal(result.state_agent.reviewed,true);
  for(const call of calls.filter(call=>call.data.output_block)){
    const block=call.data.output_block,index=blocks.indexOf(block);
    assert.deepEqual(Object.keys(call.output_schema.properties),Object.keys(blockValue(value,block)));
    assert.deepEqual(call.output_schema.required,Object.keys(blockValue(value,block)));assert.equal(call.output_schema.additionalProperties,false);
    if(block==='questions')assert.equal(Object.hasOwn(call.data,'generated_blocks'),false);
    else assert.deepEqual(Object.keys(call.data.generated_blocks),blocks.slice(0,index));
    for(const key of ['shared_input','state_input','question_input'])assert.deepEqual(call.data[key],calls[0].data[key]);
    assert.equal(call.data.combined_validation_feedback,undefined);assert.equal(call.data.failed_combined_candidate,undefined);
  }
  assert.equal(result.question_plan.skip.length,1);assert.equal(result.question_plan.skip[0].question_id,'daily');
  assert.equal(result.question_plan.skip[0].reason,reason);assert.equal(result.clarification,'support_requested');
  assert.ok(calls.find(call=>call.stage==='question_review').data.claims.length>=2);assert.deepEqual(ctx,source);
  assert.ok(result.patient_state.facts.every(fact=>fact.question_id!=='daily'));
  assert.ok(result.relationship_memory.patient.every(finding=>finding.evidence.every(item=>item.question_id!=='daily')));
});

for(const verdict of ['plausible','unsupported'])test('block-first question decisions cannot bypass a rejected independent review: '+verdict,async t=>{
  const ctx=context();ctx.question_candidates.push({id:'extra',subject:'patient',question:'더할 내용이 있나요?'});
  ctx.patient.fields.contact=field('contact','일주일에 몇 번 연락해요.');ctx.answered_count=5;
  Object.assign(ctx.question_candidates[0],{required:false,noSkip:false});
  const value=draft(ctx);
  value.questions.skip=[{question_id:'daily',reason:'not_needed',explanation:'현재 상황에서 필요하지 않다고 판단했습니다.',evidence:[ref(ctx)]}];
  value.questions.clarify=['support_requested'];
  const {gateway,calls}=model(call=>call.data.output_block?blockValue(value,call.data.output_block):call.stage==='question_review'
    ?{audits:call.data.claims.map(({id})=>({id,verdict,reason:'원문으로 이 질문 결정을 뒷받침하지 못했습니다.'}))}:review(call.data),{stateMode:'combined_blocks'});
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  assert.deepEqual(result.question_plan,{skip:[]});assert.equal(result.clarification,null);
  assert.equal(result.state_agent.reviewed,true);assert.equal(calls.at(-1).stage,'safety_review');assert.ok(calls.some(call=>call.stage==='question_review'));
});

test('block-first output still requires full source validation before any review',async t=>{
  const ctx=context(),value=draft(ctx);value.state.patient_state.facts[0].quote='원문에 존재하지 않는 합성 인용';
  const {gateway,calls}=model(call=>blockValue(value,call.data.output_block),{stateMode:'combined_blocks'});
  await assert.rejects(gateway.updateState(ctx,null,{signal:t.signal}),{code:'MODEL_INVALID_RESPONSE'});
  assert.ok(calls.every(call=>call.stage.startsWith('turn_draft_block_')));
});

test('block-first danger proposals still require independent review of full source corrections',async t=>{
  const ctx=context();ctx.patient.fields.risk=field('risk','지금 위험한 곳에서 자신을 해치겠다고 말했어요.');
  ctx.patient.fields.risk.followUp={question:'현재 상황인가요?',answer:field('risk_more','과거 이야기였고 지금은 안전하다고 정정했어요.')};
  const value=draft(ctx);value.questions.safety={urgent:true,evidence_ids:[safetySources(ctx).find(source=>source.question_id==='risk').id]};
  const {gateway,calls}=model(call=>{
    if(call.data.output_block)return blockValue(value,call.data.output_block);
    if(call.stage==='safety_review'){
      assert.ok(call.data.proposed_safety.evidence.some(source=>source.quote.includes('정정')));
      return safetyReviewFixture(call.data,'negated');
    }
    return review(call.data);
  },{stateMode:'combined_blocks'});
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  assert.equal(result.finish_early,false);assert.equal(result.safety_signal.urgent,false);
  assert.equal(result.safety_signal.review.basis,'negated');assert.equal(calls.at(-1).stage,'safety_review');
});

test('block-first semantic rejection regenerates the same four blocks and cannot approve an exhausted review',async t=>{
  const ctx=context(),value=draft(ctx);
  const {gateway,calls}=model(call=>call.data.output_block?blockValue(value,call.data.output_block):review(call.data,true),{stateMode:'combined_blocks'});
  await assert.rejects(gateway.updateState(ctx,null,{signal:t.signal}),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
  assert.deepEqual(calls.map(call=>call.stage),[...dispatchedBlocks.map(block=>'turn_draft_block_'+block),'turn_review','safety_review',
    ...dispatchedBlocks.map(block=>'turn_draft_block_'+block+'_after_review'),'turn_review_after_review','safety_review_after_review']);
  assert.ok(calls.slice(6,10).every(call=>call.data.review.state.approved===false&&call.data.rejected_draft.claims.length>0));
});

test('cancellation in the first explicit block stops before later blocks and review',async t=>{
  const ctx=context(),controller=new AbortController(),signal=AbortSignal.any([t.signal,controller.signal]);
  const {gateway,calls}=model(call=>{controller.abort();return blockValue(draft(ctx),call.data.output_block);},{stateMode:'combined_blocks'});
  await assert.rejects(gateway.updateState(ctx,null,{signal}),{code:'MODEL_CANCELLED'});
  assert.deepEqual(calls.map(call=>call.stage),['turn_draft_block_patient_state']);
});

test('a transient operation restart preserves explicit block mode and full source inputs',async t=>{
  const ctx=context(),value=draft(ctx),logs=[];let patients=0;
  const {gateway,calls}=model(call=>call.data.output_block==='patient_state'&&++patients<=3?new Response('',{status:503}):call.data.output_block?blockValue(value,call.data.output_block):review(call.data),
    {stateMode:'combined_blocks',retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>logs.push(entry)});
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  assert.equal(result.state_agent.reviewed,true);
  const patientCalls=calls.filter(call=>call.data.output_block==='patient_state');
  assert.equal(patientCalls.length,4);
  assert.deepEqual(calls.map(call=>call.stage),['turn_draft_block_patient_state','turn_draft_block_questions',
    ...Array(2).fill('turn_draft_block_patient_state'),...dispatchedBlocks.map(block=>'turn_draft_block_'+block),'turn_review','safety_review']);
  for(const key of ['shared_input','state_input','question_input'])assert.deepEqual(patientCalls[3].data[key],patientCalls[0].data[key]);
  assert.equal(logs.filter(entry=>entry.event==='model_operation_retry').length,1);
});

test('an evidence enum repair still requires full validation and a fresh independent review',async t=>{
  const ctx=context(),value=draft(ctx);let memories=0;
  const {gateway,calls}=model(call=>{
    if(!call.data.output_block)return review(call.data);
    const output=blockValue(value,call.data.output_block);
    if(call.data.output_block==='relationship_memory'&&++memories===1)
      output.patient[0].evidence[0].quote='밤에 계획표';
    return output;
  },{stateMode:'combined_blocks',agentFormat:'prompt'});
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  const memoryCalls=calls.filter(call=>call.data.output_block==='relationship_memory');
  assert.equal(memoryCalls.length,2);
  assert.equal(memoryCalls[1].evidence_selection_repair,undefined);
  assert.ok(memoryCalls[1].evidence_sources.length);
  assert.equal(JSON.parse(memoryCalls[1].validation_feedback).path,'output.patient[0].evidence[0]');
  assert.deepEqual(result.relationship_memory.patient[0].evidence,[ref(ctx)]);
  assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(calls.slice(-2).map(call=>call.stage),['turn_review','safety_review']);
  assert.ok(calls.filter(call=>!call.data.output_block).every(call=>call.evidence_selection_repair===undefined));
});

test('an exhausted block-local schema failure reaches only its originating block on operation recovery',async t=>{
  const ctx=context(),value=draft(ctx),logs=[];let memories=0;
  const {gateway,calls}=model(call=>{
    if(!call.data.output_block)return review(call.data);
    const output=blockValue(value,call.data.output_block);
    if(call.data.output_block==='relationship_memory'&&++memories<=3)delete output.unknowns;
    return output;
  },{stateMode:'combined_blocks',retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>logs.push(entry)});
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(calls.map(call=>call.stage),[
    'turn_draft_block_patient_state','turn_draft_block_questions','turn_draft_block_name_index',...Array(4).fill('turn_draft_block_relationship_memory'),
    'turn_review','safety_review']);
  const recovered=calls.filter(call=>call.data.output_block==='relationship_memory').at(-1);
  for(const call of [recovered,calls.find(call=>call.data.output_block==='questions')]){
    if(call.data.output_block==='relationship_memory'){
      const feedback=JSON.parse(call.data.combined_validation_feedback);
      assert.equal(feedback.path,'output');assert.equal(feedback.keyword,'objectKeys');
    }else assert.equal(Object.hasOwn(call.data,'combined_validation_feedback'),false);
    for(const key of ['shared_input','state_input','question_input'])assert.deepEqual(call.data[key],calls[0].data[key]);
  }
  assert.equal(logs.filter(entry=>entry.event==='model_operation_retry').length,1);
  assert.equal(memories,4);
});

test('name-only memory rejection informs the next block cycle before original-source validation and independent review',async t=>{
  const ctx=context(),source=structuredClone(ctx),value=draft(ctx),bad=structuredClone(value),logs=[];
  bad.state.relationship_memory.patient[0].evidence=[ref(ctx,'patient','name')];
  let reviews=0;
  const {gateway,calls}=model(call=>{
    if(call.data.output_block){
      const feedback=call.data.combined_validation_feedback;
      if(feedback){
        const parsed=JSON.parse(feedback);
        assert.equal(parsed.path,'relationship_memory.patient[0].evidence');
        assert.equal(parsed.rule,'non_name_evidence_required');
        assert.match(parsed.repair,/name 이외/u);
      }
      return blockValue(feedback?value:bad,call.data.output_block);
    }
    if(call.stage.startsWith('safety_review'))return review(call.data);
    reviews++;
    assert.equal(call.stage,'turn_review');
    assert.ok(call.data.review_target.claims.some(claim=>claim.evidence?.some(item=>item.question_id==='mood'&&item.quote===ref(ctx).quote)));
    return review(call.data);
  },{stateMode:'combined_blocks',retryFailures:true,retryDelayMs:1,diagnosticLogger:entry=>logs.push(entry)});
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  assert.deepEqual(calls.map(call=>call.stage),[...dispatchedBlocks.map(block=>'turn_draft_block_'+block),
    ...dispatchedBlocks.map(block=>'turn_draft_block_'+block),'turn_review','safety_review']);
  assert.equal(calls[0].data.combined_validation_feedback,undefined);
  assert.notEqual(calls[0].request.body,calls[4].request.body);
  for(const call of calls.slice(4,8)){
    assert.equal(call.data.combined_validation_feedback,calls[4].data.combined_validation_feedback);
    for(const key of ['shared_input','state_input','question_input'])assert.deepEqual(call.data[key],calls[0].data[key]);
  }
  assert.deepEqual(logs.filter(entry=>entry.event==='model_operation_retry').map(entry=>entry.reason),['agent_memory_name_only']);
  assert.equal(reviews,1);assert.equal(result.state_agent.reviewed,true);assert.equal(result.name_index.alias,'지민');
  assert.ok(result.relationship_memory.patient.every(item=>item.evidence.some(item=>item.question_id!=='name')));
  assert.deepEqual(ctx,source);assert.deepEqual(bad.state.relationship_memory.patient[0].evidence,[ref(ctx,'patient','name')]);
});

for(const block of ['patient_state','relationship_memory','questions'])test('flat block schema rejects a repeated outer '+block+' wrapper without locally repairing it',async t=>{
  const ctx=context(),value=draft(ctx);let reviews=0;
  const {gateway,calls}=model(call=>{
    if(!call.data.output_block){reviews++;return review(call.data);}
    const selected=call.data.output_block;
    return selected===block?{[block]:blockPart(value,block)}:blockValue(value,selected);
  },{stateMode:'combined_blocks'});
  await assert.rejects(gateway.updateState(ctx,null,{signal:t.signal}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  const rejected=calls.filter(call=>call.data.output_block===block);
  assert.equal(rejected.length,3);assert.equal(reviews,0);
  assert.equal(rejected[0].output_schema.type,'object');
  assert.equal(Object.hasOwn(rejected[0].output_schema.properties,block),false);
  assert.equal(JSON.parse(rejected[1].validation_feedback).keyword,'objectKeys');
});

test('active questions cannot use the inactive null shortcut or skip independent review',async t=>{
  const ctx=context(),value=draft(ctx);
  const {gateway,calls}=model(call=>call.data.output_block==='questions'?null:blockValue(value,call.data.output_block),{stateMode:'combined_blocks'});
  await assert.rejects(gateway.updateState(ctx,null,{signal:t.signal}),{modelReason:'agent_schema'});
  assert.equal(calls.filter(call=>call.data.output_block==='questions').length,3);
  assert.ok(!calls.some(call=>call.stage.startsWith('turn_review')));
});

test('nullable name extraction keeps its object-root wire contract while other blocks are flat',async t=>{
  const ctx=context(),value=draft(ctx);value.state.name_index=null;
  const {gateway,calls}=model(call=>{
    assert.equal(call.output_schema.type,'object');
    return call.data.output_block?blockValue(value,call.data.output_block):review(call.data);
  },{stateMode:'combined_blocks',agentFormat:'json_schema'});
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  assert.equal(result.name_index,null);assert.equal(result.state_agent.reviewed,true);
  const name=calls.find(call=>call.data.output_block==='name_index');
  assert.deepEqual(Object.keys(name.output_schema.properties),['name_index']);
  assert.ok(name.output_schema.properties.name_index.anyOf.some(branch=>branch.type==='null'));
  for(const call of calls.filter(call=>call.data.output_block)){
    if(call.data.output_block==='name_index')assert.match(call.prompt,/최상위 키는 name_index 하나/u);
    else assert.match(call.prompt,new RegExp(call.data.output_block+' 바깥 키는 쓰지 않습니다','u'));
  }
  const questions=calls.find(call=>call.data.output_block==='questions');
  assert.match(questions.prompt,/JSON 형식이 실패했다는 이유만으로/u);
  assert.match(questions.prompt,/원문이 뒷받침하지 않는 선택은 유지하거나 새로 만들지/u);
});


for(const repaired of [true,false])test('duplicate question choices are repaired locally without removing grounded skipping: repaired='+repaired,async t=>{
  const ctx=context();ctx.question_candidates.push({id:'extra',subject:'patient',question:'더할 내용이 있나요?'});
  const value=draft(ctx),choice={question_id:'daily',reason:'already_covered',explanation:'원문의 생활 장면을 이미 전했습니다.',evidence:[ref(ctx)]};
  value.questions.skip=[choice];const duplicate={...structuredClone(value.questions),skip:[structuredClone(choice),structuredClone(choice)]};
  let questionAttempts=0;
  const {gateway,calls}=model(call=>{
    if(call.data.output_block==='questions'){
      questionAttempts++;
      if(questionAttempts>1){
        const feedback=JSON.parse(call.validation_feedback.split('\n').at(-1));
        assert.equal(feedback.path,'output.skip');assert.equal(feedback.keyword,'uniqueQuestionId');
        assert.match(feedback.repair,/근거 있는 생략을 빈 배열로 바꾸거나 답변을 만들어 내지 마세요/u);
        assert.deepEqual(call.rejected_output,duplicate);
      }
      return repaired&&questionAttempts>1?value.questions:duplicate;
    }
    return call.data.output_block?blockValue(value,call.data.output_block):review(call.data);
  },{stateMode:'combined_blocks'});
  if(repaired){
    const result=await gateway.updateState(ctx,null,{signal:t.signal});
    assert.deepEqual(result.question_plan.skip,[choice]);assert.equal(questionAttempts,2);
    assert.ok(calls.some(call=>call.stage==='question_review'));
    assert.equal(result.patient_state.facts.some(fact=>fact.question_id==='daily'),false);
    assert.equal(result.relationship_memory.patient.some(finding=>finding.evidence.some(item=>item.question_id==='daily')),false);
  }else{
    await assert.rejects(gateway.updateState(ctx,null,{signal:t.signal}),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_question_duplicate'});
    assert.equal(questionAttempts,3);assert.equal(calls.some(call=>call.stage==='turn_review'),false);
  }
  for(const block of blocks.slice(0,3))assert.equal(calls.filter(call=>call.stage==='turn_draft_block_'+block).length,1);
});

for(const verdict of ['supported','unsupported'])test('question ID selection repair preserves independent question review: '+verdict,async t=>{
  const ctx=context();ctx.question_candidates.push({id:'extra',subject:'patient',question:'더할 내용이 있나요?'});
  ctx.patient.fields.contact=field('contact','일주일에 몇 번 연락해요.');ctx.answered_count=5;
  Object.assign(ctx.question_candidates[0],{required:false,noSkip:false});
  const value=draft(ctx);value.questions.skip=[{question_id:'daily',reason:'not_needed',explanation:'현재 상황에서는 보고한 장면을 먼저 듣습니다.',evidence:[ref(ctx)]}];
  let questionAttempts=0;
  const {gateway,calls}=model(call=>{
    if(call.data.output_block){
      const output=blockValue(value,call.data.output_block);
      if(call.data.output_block==='questions'&&++questionAttempts===1)output.skip[0].question_id='invalid_question';
      return output;
    }
    if(call.stage==='question_review')return {audits:call.data.claims.map(({id})=>({id,verdict,reason:'질문 판단의 원문 근거를 검토했습니다.'}))};
    return review(call.data);
  },{stateMode:'combined_blocks'});
  const result=await gateway.updateState(ctx,null,{signal:t.signal});
  const attempts=calls.filter(call=>call.stage==='turn_draft_block_questions');
  assert.equal(attempts.length,2);assert.equal(attempts[0].question_selection_repair,undefined);
  assert.equal(attempts[1].question_selection_repair.output_path,'output.skip[0].question_id');
  assert.ok(attempts[1].question_selection_repair.eligible_choices.some(choice=>choice.question_ids.includes('daily')));
  assert.ok(calls.some(call=>call.stage==='question_review'));assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(result.question_plan.skip.map(item=>item.question_id),verdict==='supported'?['daily']:[]);
});

test('decoded wire evidence is independently reviewed and cannot bypass semantic rejection',async t=>{
  const ctx=context(),value=draft(ctx);
  const {gateway,calls}=model(call=>call.data.output_block?blockValue(value,call.data.output_block):review(call.data,true),{stateMode:'combined_blocks'});
  await assert.rejects(gateway.updateState(ctx,null,{signal:t.signal}),{modelReason:'state_review_rejected'});
  const memory=calls.filter(call=>call.data.output_block==='relationship_memory');assert.ok(memory.length>0);assert.ok(memory.every(call=>call.evidence_sources.length>0));
  const reviews=calls.filter(call=>call.stage.startsWith('turn_review'));assert.ok(reviews.length>0);
  for(const call of reviews){assert.ok(JSON.stringify(call.data).includes(ref(ctx).quote));assert.equal(JSON.stringify(call.data).includes('source_patient_'),false);}
});
