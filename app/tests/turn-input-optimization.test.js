import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {COMMON} from '../src/relationship-prompts.js';
import {relationshipStateRequest,relationshipQuestionRequest,safetySources} from '../src/relationship-agent.js';
import {runCombinedRelationshipState} from '../src/relationship-turn.js';
import {HttpError} from '../src/errors.js';
import {scopeProbe,scopeContext,scopeDraft,scopeBlock,scopeReview} from './helpers/turn-input-optimization-fixture.js';

const affected=stage=>/^turn_draft_block_(patient_state|name_index|relationship_memory)(?:_after_review)?$/u.test(stage);
const restored=(data,key)=>({...data.shared_input,...data[key]});
const sourceOnly=({prior_state,prior_relationship_memory,...input})=>input;
const withoutAgent=({state_agent,...result})=>result;
const stages=value=>value.calls.map(call=>call.stage);
const configured=options=>scopeProbe(ModelGateway,{enabled:true,blockScopedInputs:true,...options});

for(const scenario of [{},{rejectOnce:true},{malformedOnce:true}])
test('scoped writers preserve sources, question decisions, all review requests and stored output: '+JSON.stringify(scenario),async()=>{
  const original=scopeProbe(ModelGateway,scenario),optimized=configured(scenario);
  const before=structuredClone(optimized.ctx),expected=await original.run(),actual=await optimized.run();
  assert.deepEqual(actual,expected);
  assert.deepEqual(optimized.ctx,before);
  assert.deepEqual(stages(optimized),stages(original));
  const state=sourceOnly(relationshipStateRequest(optimized.ctx,null).data);
  for(let i=0;i<optimized.requests.length;i++){
    const prior=original.requests[i],current=optimized.requests[i],call=optimized.calls[i];
    if(!affected(call.stage)){assert.deepEqual(current,prior);continue;}
    const old=original.calls[i];
    assert.equal(Object.hasOwn(call.data,'question_input'),false);
    assert.deepEqual(call.data,((({question_input,...remaining})=>remaining)(old.data)));
    assert.deepEqual(restored(call.data,'state_input'),state);
    assert.deepEqual(call.output_schema,old.output_schema);
    assert.equal(call.prompt.split(COMMON).length-1,1);
    assert.doesNotMatch(call.prompt,/아래 질문 진행 규칙의 skip, clarify, safety/u);
    assert.match(call.prompt,/정정·부정·시점·화자|정정·부정·시점 변경/u);
    assert.ok(Buffer.byteLength(current.messages[0].content)<Buffer.byteLength(prior.messages[0].content));
    if(call.stage.includes('_after_review')){
      assert.equal(call.data.review.state.approved,false);
      assert.ok(call.data.rejected_draft.claims.length>0);
    }
  }
  assert.equal(actual.state_agent.reviewed,true);
  assert.equal(actual.question_plan.skip[0].reason,'already_covered');
  assert.equal(actual.clarification,'support_requested');
  for(const stage of ['turn_review','question_review','safety_review'])assert.ok(stages(optimized).includes(stage));
  if(!Object.keys(scenario).length)assert.equal(optimized.requests.length,7);
});

test('question-rule-only option removes just its exact prompt segment',async()=>{
  const original=scopeProbe(ModelGateway),optimized=scopeProbe(ModelGateway,{enabled:true});
  assert.deepEqual(await optimized.run(),await original.run());
  const raw=relationshipQuestionRequest(original.ctx).prompt;
  const rules=raw.startsWith(COMMON)?raw.slice(COMMON.length):raw;
  for(let i=0;i<optimized.requests.length;i++){
    const prior=original.requests[i],current=optimized.requests[i];
    if(!affected(optimized.calls[i].stage)){assert.deepEqual(current,prior);continue;}
    const text=prior.messages[0].content,start=text.indexOf('\n아래 질문 진행 규칙의 skip, clarify, safety는 출력 questions 내부입니다.');
    const end=text.indexOf(rules,start)+rules.length;
    assert.ok(start>0&&end>start);
    assert.equal(current.messages[0].content,text.slice(0,start)+text.slice(end));
    assert.deepEqual({...current,messages:[prior.messages[0],...current.messages.slice(1)]},prior);
  }
});

for(const options of [{stateMode:'combined'},{stateMode:'combined',fallback:true}])
test('scope options leave combined and its block fallback inputs unchanged: '+JSON.stringify(options),async()=>{
  const original=scopeProbe(ModelGateway,options),optimized=configured(options);
  assert.deepEqual(await optimized.run(),await original.run());
  assert.deepEqual(optimized.requests,original.requests);
});

for(const [label,change] of [
  ['absent',ctx=>{delete ctx.patient.fields.name;}],
  ['not asked',ctx=>{ctx.patient.fields.name.status='not_asked';}],
  ['unknown',ctx=>{ctx.patient.fields.name.status='unknown';}],
  ['empty',ctx=>{ctx.patient.fields.name.text='';ctx.patient.fields.name.rawText='';}],
])test('a schema-fixed null name skips only that provider request: '+label,async()=>{
  const ctx=scopeContext();change(ctx);
  const value=scopeDraft(ctx);value.state.name_index=null;
  assert.deepEqual(relationshipStateRequest(ctx,null).schema.properties.name_index,{type:'null'});
  const optimized=configured({ctx,value}),combined=scopeProbe(ModelGateway,{ctx,value,stateMode:'combined'});
  const actual=await optimized.run(),expected=await combined.run();
  assert.deepEqual(withoutAgent(actual),withoutAgent(expected));
  assert.equal(actual.name_index,null);
  assert.equal(optimized.requests.length,6);
  assert.equal(stages(optimized).some(stage=>stage.includes('name_index')),false);
  assert.equal(actual.state_agent.stages.some(stage=>stage.includes('name_index')),false);
  for(const stage of ['turn_review','question_review','safety_review'])assert.ok(stages(optimized).includes(stage));
  const relation=optimized.calls.find(call=>call.data.output_block==='relationship_memory');
  assert.equal(relation.data.generated_blocks.name_index,null);
});

test('fixed null name is independent of scope opt-in and conditional question review',async()=>{
  const ctx=scopeContext();delete ctx.patient.fields.name;
  const value=scopeDraft(ctx);value.state.name_index=null;value.questions.skip=[];value.questions.clarify=[];
  const original=scopeProbe(ModelGateway,{ctx,value}),optimized=configured({ctx,value});
  assert.deepEqual(await optimized.run(),await original.run());
  assert.equal(original.requests.length,5);
  assert.deepEqual(stages(original),['turn_draft_block_patient_state','turn_draft_block_questions','turn_draft_block_relationship_memory','turn_review','safety_review']);
});

test('combined structural fallback also resolves only schema-fixed null without applying block scoping',async()=>{
  const ctx=scopeContext();delete ctx.patient.fields.name;
  const value=scopeDraft(ctx);value.state.name_index=null;
  const options={ctx,value,stateMode:'combined',fallback:true};
  const original=scopeProbe(ModelGateway,options),optimized=configured(options);
  assert.deepEqual(await optimized.run(),await original.run());
  assert.deepEqual(optimized.requests,original.requests);
  assert.equal(optimized.requests.length,9);
  assert.equal(stages(optimized).some(stage=>stage.includes('name_index')),false);
  for(const call of optimized.calls.filter(call=>call.data.output_block))
    assert.ok(Object.hasOwn(call.data,'question_input'));
});

test('non-adaptive fixed-null state still receives its full independent state review',async()=>{
  const ctx=scopeContext();delete ctx.patient.fields.name;
  const value=scopeDraft(ctx);value.state.name_index=null;value.questions=null;
  const original=scopeProbe(ModelGateway,{ctx,value,adaptive:false}),optimized=configured({ctx,value,adaptive:false});
  assert.deepEqual(await optimized.run(),await original.run());
  assert.deepEqual(stages(optimized),['turn_draft_block_patient_state','turn_draft_block_relationship_memory','turn_review']);
  assert.deepEqual(optimized.requests.at(-1),original.requests.at(-1));
});

test('scoped writers retain independent urgent review and its contextual question decisions',async()=>{
  const ctx=scopeContext();
  ctx.patient.fields.risk={id:'risk',question:'위험 상황이 있나요?',status:'answered',text:'오늘 자신을 해치겠다는 말을 들었어요.',rawText:'오늘 자신을 해치겠다는 말을 들었어요.',custom:''};
  const value=scopeDraft(ctx);
  value.questions.safety={urgent:true,evidence_ids:[safetySources(ctx).find(row=>row.question_id==='risk').id]};
  value.questions.skip=[];value.questions.clarify=[];
  const original=scopeProbe(ModelGateway,{ctx,value}),optimized=configured({ctx,value});
  const actual=await optimized.run();
  assert.deepEqual(actual,await original.run());
  assert.equal(actual.finish_early,true);
  assert.equal(actual.safety_signal.urgent,true);
  assert.deepEqual(actual.question_plan,{skip:[]});
  assert.equal(actual.clarification,null);
  assert.equal(optimized.requests.length,6);
  for(let index=0;index<optimized.calls.length;index++)
    if(optimized.calls[index].stage.includes('review'))assert.deepEqual(optimized.requests[index],original.requests[index]);
});

for(const kind of ['bare alias','follow-up correction'])
test('answered nullable name still requires generation and validation: '+kind,async()=>{
  const ctx=scopeContext(),value=scopeDraft(ctx);
  if(kind==='follow-up correction'){
    ctx.patient.fields.name.followUp={question:'다시 확인할까요?',answer:{rawText:'지민이 아니라 수민이라고 불러 주세요.'}};
    value.state.name_index={alias:'수민',source_question_id:'name',quote:ctx.patient.fields.name.followUp.answer.rawText};
  }
  const optimized=configured({ctx,value});
  const actual=await optimized.run();
  assert.equal(optimized.calls.filter(call=>call.data.output_block==='name_index').length,1);
  assert.equal(actual.name_index.alias,value.state.name_index.alias);
  assert.equal(optimized.requests.length,7);
  const invalid=configured({ctx,value,response:call=>call.data.output_block==='name_index'?{name_index:{alias:'다른이름',source_question_id:'name',quote:'다른이름'}}:undefined});
  await assert.rejects(invalid.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(stages(invalid).some(stage=>stage==='turn_review'),false);
});

test('fixed null names stay skipped through semantic repair while every review is renewed',async()=>{
  const ctx=scopeContext();delete ctx.patient.fields.name;
  const value=scopeDraft(ctx);value.state.name_index=null;
  const optimized=configured({ctx,value,rejectOnce:true});
  const result=await optimized.run();
  assert.equal(result.state_agent.reviewed,true);
  assert.equal(optimized.requests.length,12);
  assert.equal(stages(optimized).some(stage=>stage.includes('name_index')),false);
  for(const stage of ['turn_review','question_review','safety_review']){
    assert.ok(stages(optimized).includes(stage));assert.ok(stages(optimized).includes(stage+'_after_review'));
  }
});

function directGateway(ctx,{enabled=true,fail=false}={}){
  const value=scopeDraft(ctx);if(!ctx.patient.fields.name)value.state.name_index=null;
  return {stateMode:'combined_blocks',stageScopedQuestionRules:enabled,blockScopedInputs:enabled,calls:[],
    async agentComplete(stage,prompt,data,schema,operation,validate){
      this.calls.push({stage,prompt,data,schema});
      if(fail&&data.output_block==='questions'){
        // Let the immediate state chain finish so this fixture exercises full
        // prefix reuse independently of parallel failure timing.
        await new Promise(setImmediate);
        const error=new HttpError(502,'MODEL_INVALID_RESPONSE','synthetic');error.modelReason='agent_schema';
        error.modelFeedback=JSON.stringify({path:'output',keyword:'objectKeys'});throw error;
      }
      return validate(data.output_block?scopeBlock(value,data.output_block):scopeReview(data));
    }};
}

test('structural prefix recovery revalidates a constant name and cannot reuse scoped inputs after option changes',async()=>{
  const ctx=scopeContext();delete ctx.patient.fields.name;
  const operation={requestId:'scope-recovery',recovery:{},controller:new AbortController()};
  await assert.rejects(runCombinedRelationshipState(directGateway(ctx,{fail:true}),ctx,null,operation),{code:'MODEL_INVALID_RESPONSE'});
  assert.deepEqual(Object.keys(operation.recovery.combinedBlocks.blocks),['patient_state','relationship_memory']);
  const resumed=directGateway(ctx);await runCombinedRelationshipState(resumed,ctx,null,operation);
  assert.deepEqual(stages(resumed),['turn_draft_block_questions','turn_review','question_review','safety_review']);
  assert.deepEqual(operation.recovery,{});
  await assert.rejects(runCombinedRelationshipState(directGateway(ctx,{fail:true}),ctx,null,operation),{code:'MODEL_INVALID_RESPONSE'});
  const changed=directGateway(ctx,{enabled:false});await runCombinedRelationshipState(changed,ctx,null,operation);
  assert.deepEqual(stages(changed),['turn_draft_block_patient_state','turn_draft_block_questions','turn_draft_block_relationship_memory','turn_review','question_review','safety_review']);
});

test('a later answered name invalidates retained input and must be extracted by the model',async()=>{
  const ctx=scopeContext();delete ctx.patient.fields.name;
  const operation={requestId:'new-name',recovery:{},controller:new AbortController()};
  await assert.rejects(runCombinedRelationshipState(directGateway(ctx,{fail:true}),ctx,null,operation),{code:'MODEL_INVALID_RESPONSE'});
  const answered=scopeContext(),next=directGateway(answered);
  const result=await runCombinedRelationshipState(next,answered,null,operation);
  assert.equal(result.name_index.alias,'지민');
  assert.deepEqual(stages(next),['turn_draft_block_patient_state','turn_draft_block_questions','turn_draft_block_name_index','turn_draft_block_relationship_memory','turn_review','question_review','safety_review']);
  assert.deepEqual(operation.recovery,{});
});

test('cancellation before the constant name cannot progress to more generation or reviews',async()=>{
  const ctx=scopeContext();delete ctx.patient.fields.name;
  const value=scopeDraft(ctx);value.state.name_index=null;
  const controller=new AbortController();
  const optimized=configured({ctx,value,response:call=>{if(call.data.output_block==='patient_state')controller.abort();}});
  await assert.rejects(optimized.run({signal:controller.signal}),{code:'MODEL_CANCELLED'});
  assert.deepEqual(stages(optimized),['turn_draft_block_patient_state']);
});
