import {safetyReviewFixture} from './helpers/safety-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ModelGateway } from '../src/model.js';
import { runCombinedRelationshipState } from '../src/relationship-turn.js';
import { literalStateRepairSchema } from '../src/relationship-state-repair.js';
import { HttpError } from '../src/errors.js';

const field=(id,text)=>({id,text,rawText:text,custom:'',status:'answered',question:id});
const context=()=>({patient:{alias:'지민',fields:{name:field('name','지민'),
  mood:field('mood','밤에 계획표를 고쳐요. 전에 힘들었지만 지금 자신이나 타인을 해칠 생각은 없다고 정정했어요.')}},
  supporter:{fields:{feeling:field('feeling','제 생활도 챙기며 이야기를 듣고 싶어요.')}},
  user_goal:{message:field('want','곁에서 이야기를 듣고 싶어요.')},latest_answer:{subject:'patient',question_id:'mood'},
  answered_count:4,adaptive_questions:true,question_candidates:[{id:'daily',subject:'patient',question:'생활에 어떤 변화가 있나요?'},
    {id:'extra',subject:'patient',question:'추가할 내용이 있나요?'}],
  clarification_candidates:[{id:'support_requested',subject:'patient',question:'원하는 도움이 있나요?'}]});
const ref=(ctx,subject='patient',question_id='mood')=>({subject,question_id,quote:ctx[subject].fields[question_id].rawText});
const draft=(ctx,hypothesis=false)=>({state:{patient_state:{facts:[{...ref(ctx),certainty:'reported'},
  {...ref(ctx,'supporter','feeling'),certainty:'reported'}],unknowns:['이용자가 함께할 수 있는 시간']},
  name_index:{alias:'지민',source_question_id:'name',quote:'지민'},relationship_memory:{
    patient:[{evidence:[ref(ctx)],certainty:'reported'}],supporter:[{evidence:[ref(ctx,'supporter','feeling')],certainty:'reported'}],
    relationship:hypothesis?[{interpretation:'가능한 해석: 이용자가 조심스럽게 이야기를 시작하려는 관계일 수 있어요.',
      evidence:[{subject:'user_goal',question_id:'want',quote:ctx.user_goal.message.rawText}],certainty:'tentative'}]:[],
    unknowns:['이용자가 함께할 수 있는 시간']}},questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}});
const audits=claims=>claims.map(claim=>({id:claim.id,verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':claim.certainty==='tentative'?'plausible':'supported',reason:'합성 원문 대조'}));
const review=(data,reject=false)=>data.safety_sources?safetyReviewFixture(data):({state:{approved:!reject,issues:reject?[{reason:'가설의 근거를 다시 확인해야 합니다.',repair:'현재 원문으로 다시 선택하세요.'}]:[],
  audits:audits(data.review_target.claims)},questions:data.questions?{audits:audits(data.questions.claims)}:null,
  safety:data.safety?{basis:'current_physical_danger',reason:'전체 원문의 현재 위험을 확인했습니다.'}:null});
const fake=(handler)=>({calls:[],async agentComplete(stage,prompt,data,schema,operation,validate){
  const call={stage,prompt,data,schema,operation};this.calls.push(call);return validate(stage.startsWith('safety_review')?safetyReviewFixture(data):await handler(call));
}});
const prime=async(ctx,operation,final=false)=>{
  const model=fake(call=>{
    if(!call.stage.startsWith('turn_draft'))return review(call.data,true);
    const value=draft(ctx,true);if(final)value.questions=null;return value;
  });
  await assert.rejects(runCombinedRelationshipState(model,ctx,null,operation,final),{modelReason:'state_review_rejected'});
  assert.equal(operation.recovery.combinedTurn.semanticRejections,2);assert.equal(operation.recovery.combinedTurn.literalState,true);
  return model;
};

test('two validated semantic rejections narrow only the next operation and retain raw inputs, repair pair and independent decisions',async t=>{
  const ctx=context(),requests=[],logs=[];let drafts=0,reviews=0,questionReviews=0,recovery;
  const controller=new AbortController(),signal=AbortSignal.any([t.signal,controller.signal]);let fixtureError;
  const model=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',protocol:'relationship_agent',
    agentFormat:'json_object',retryFailures:true,retryDelayMs:1,timeoutMs:0,diagnosticLogger:entry=>logs.push(entry),fetchImpl:async(_url,options)=>{
      try {
      const input=JSON.parse(JSON.parse(options.body).messages.at(-1).content);requests.push(input);let value;
      if(input.stage.startsWith('turn_draft')){
        drafts++;value=draft(ctx,drafts<3);
        const state=input.output_schema.properties.state.properties,memory=state.relationship_memory.properties;
        if(drafts===3){
          assert.equal(recovery.combinedTurn.semanticRejections,2);assert.equal(recovery.combinedTurn.literalState,true);
          assert.equal(memory.relationship.maxItems,0);assert.equal(memory.patient.items.anyOf,undefined);
          assert.deepEqual(Object.keys(memory.patient.items.properties),['evidence','certainty']);
          assert.deepEqual(memory.patient.items.properties.certainty.enum,['reported']);
          assert.deepEqual(input.data.state_input,requests[0].data.state_input);
          assert.deepEqual(input.data.shared_input,requests[0].data.shared_input);
          assert.deepEqual(input.data.question_input,requests[0].data.question_input);
          assert.deepEqual(state.patient_state,requests[0].output_schema.properties.state.properties.patient_state);
          assert.deepEqual(state.name_index,requests[0].output_schema.properties.state.properties.name_index);
          assert.deepEqual(memory.unknowns,requests[0].output_schema.properties.state.properties.relationship_memory.properties.unknowns);
          assert.deepEqual(input.output_schema.properties.questions,requests[0].output_schema.properties.questions);
          assert.equal(input.data.review.state.approved,false);assert.ok(input.data.rejected_draft.state.relationship_memory.relationship.length);
          value.questions.skip=[{question_id:'daily',reason:'already_covered',explanation:'현재 답변에 포함되었습니다.',evidence:[ref(ctx)]}];
          value.questions.clarify=['support_requested'];
        }else assert.ok(memory.patient.items.anyOf);
      }else if(input.stage.startsWith('turn_review')){
        reviews++;assert.equal(input.data.questions,null);assert.equal(input.data.safety,null);
        value=review(input.data,reviews<=2);
      }else if(input.stage==='question_review'){
        questionReviews++;assert.equal(reviews,3);assert.equal(input.data.review_target,undefined);
        assert.deepEqual(input.data.claims.map(claim=>claim.id),['skip.daily','clarify.support_requested']);
        assert.deepEqual(Object.keys(input.output_schema.properties),['audits']);
        value={audits:audits(input.data.claims)};
      }else if(input.stage.startsWith('safety_review'))value=safetyReviewFixture(input.data);
      else assert.fail('Unexpected stage: '+input.stage);
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}));
      } catch(error){fixtureError=error;controller.abort();throw error;}
    }});
  const execute=model.operation.bind(model);model.operation=(options,generate)=>execute(options,operation=>{recovery=operation.recovery;return generate(operation);});
  let output;
  try{output=await model.updateState(ctx,null,{signal});}catch(error){throw fixtureError||error;}
  assert.equal(drafts,3);assert.equal(reviews,3);assert.equal(questionReviews,1);assert.equal(output.state_agent.reviewed,true);
  assert.deepEqual(requests.map(request=>request.stage),['turn_draft','turn_review','safety_review','turn_draft_after_review',
    'turn_review_after_review','safety_review_after_review','turn_draft','turn_review','question_review','safety_review']);
  assert.deepEqual(output.relationship_memory.relationship,[]);assert.equal(output.name_index.alias,'지민');
  assert.equal(output.patient_state.facts.find(fact=>fact.question_id==='mood').quote,ctx.patient.fields.mood.rawText);
  assert.equal(output.patient_state.facts.find(fact=>fact.question_id==='feeling').quote,ctx.supporter.fields.feeling.rawText);
  assert.deepEqual(output.patient_state.unknowns,['이용자가 함께할 수 있는 시간']);
  assert.deepEqual(output.relationship_memory.unknowns,['이용자가 함께할 수 있는 시간']);
  assert.equal(output.question_plan.skip.length,1);assert.equal(output.clarification,'support_requested');
  assert.deepEqual(recovery,{});assert.ok(!JSON.stringify(logs).includes(ctx.patient.fields.mood.rawText));
  assert.ok(requests[0].output_schema.properties.state.properties.relationship_memory.properties.patient.items.anyOf);
  const nextOperationIndex=requests.length;
  try{await model.updateState(ctx,null,{signal});}catch(error){throw fixtureError||error;}
  assert.equal(drafts,4);assert.equal(reviews,4);assert.equal(questionReviews,1);
  assert.equal(requests[nextOperationIndex].stage,'turn_draft');
  assert.equal(requests[nextOperationIndex].data.review,undefined);assert.deepEqual(recovery,{});
});

test('a malformed review or transport failure cannot raise the semantic rejection count',async()=>{
  const ctx=context(),operation={recovery:{}};
  const first=fake(call=>{
    if(call.stage.startsWith('turn_draft'))return draft(ctx,true);
    if(call.stage==='turn_review')return review(call.data,true);
    const value=review(call.data,true);delete value.state.audits;return value;
  });
  await assert.rejects(runCombinedRelationshipState(first,ctx,null,operation),{modelReason:'agent_schema'});
  assert.equal(operation.recovery.combinedTurn.semanticRejections,1);assert.equal(operation.recovery.combinedTurn.literalState,false);
  const transport=fake(call=>{
    if(call.stage.startsWith('turn_draft')){assert.ok(call.schema.properties.state.properties.relationship_memory.properties.patient.items.anyOf);return draft(ctx,true);}
    throw new HttpError(503,'MODEL_UNAVAILABLE','합성 연결 오류');
  });
  await assert.rejects(runCombinedRelationshipState(transport,ctx,null,operation),{code:'MODEL_UNAVAILABLE'});
  assert.equal(operation.recovery.combinedTurn.semanticRejections,1);assert.equal(operation.recovery.combinedTurn.literalState,false);
});

for(const [label,mutate] of [
  ['patient hypothesis',value=>{value.state.relationship_memory.patient[0]={interpretation:'가능한 해석: 대화를 조심스러워할 수 있어요.',
    certainty:'tentative',evidence:value.state.relationship_memory.patient[0].evidence};}],
  ['supporter hypothesis',value=>{value.state.relationship_memory.supporter[0]={interpretation:'가능한 해석: 부담을 느낄 수 있어요.',
    certainty:'tentative',evidence:value.state.relationship_memory.supporter[0].evidence};}],
  ['relationship hypothesis',(value,ctx)=>{value.state.relationship_memory.relationship=draft(ctx,true).state.relationship_memory.relationship;}],
  ['free reported interpretation',value=>{value.state.relationship_memory.patient[0].interpretation='보고된 적 없는 해석';}],
  ['invented quote',value=>{value.state.patient_state.facts[0].quote='존재하지 않는 합성 원문';}],
  ['invented name',value=>{value.state.name_index.alias='원문에 없는 호칭';}],
])test('literal recovery validates the original JSON-object candidate before review: '+label,async()=>{
  const ctx=context(),operation={recovery:{}};await prime(ctx,operation);
  const value=draft(ctx);mutate(value,ctx);const original=structuredClone(value);
  const next=fake(call=>{assert.ok(call.stage.startsWith('turn_draft'));return value;});
  await assert.rejects(runCombinedRelationshipState(next,ctx,null,operation),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(next.calls.length,1);assert.deepEqual(value,original);
  assert.equal(operation.recovery.combinedTurn.semanticRejections,2);assert.equal(operation.recovery.combinedTurn.literalState,true);
});

test('literal recovery still rejects missing unknown audits and unpreserved corrections without accepting a partial state',async()=>{
  for(const fault of ['missing_audit','correction_omission']){
    const ctx=context(),operation={recovery:{}};await prime(ctx,operation);
    const next=fake(call=>{
      if(call.stage.startsWith('turn_draft'))return draft(ctx);
      const value=review(call.data);
      if(fault==='missing_audit')value.state.audits=value.state.audits.filter(audit=>audit.id!=='patient_state.unknowns.0');
      else {value.state.approved=false;value.state.issues=[{reason:'정정 보고의 의미를 보존하지 못했습니다.',repair:'현재 부정과 시점을 다시 선택하세요.'}];}
      return value;
    });
    await assert.rejects(runCombinedRelationshipState(next,ctx,null,operation),{code:'MODEL_INVALID_RESPONSE',
      modelReason:fault==='missing_audit'?'agent_schema':'state_review_rejected'});
    assert.equal(next.calls.length,fault==='missing_audit'?3:6);
  }
});

test('changed context clears literal recovery rather than restricting an independent new answer',async()=>{
  const ctx=context(),operation={recovery:{}};await prime(ctx,operation);
  const changed=context();changed.user_goal.message=field('want','새로운 합성 목적입니다.');
  const next=fake(call=>{
    if(call.stage.startsWith('turn_draft')){
      assert.ok(call.schema.properties.state.properties.relationship_memory.properties.patient.items.anyOf);
      assert.equal(call.data.review,undefined);assert.equal(call.data.rejected_draft,undefined);
      return draft(changed);
    }
    return review(call.data);
  });
  const output=await runCombinedRelationshipState(next,changed,null,operation);
  assert.equal(output.state_agent.reviewed,true);assert.deepEqual(operation.recovery,{});
});

test('final state-only literal recovery keeps null question work and requires the complete independent review',async()=>{
  const ctx=context(),operation={recovery:{}};await prime(ctx,operation,true);
  const next=fake(call=>{
    if(call.stage.startsWith('turn_draft')){
      assert.deepEqual(call.schema.properties.questions,{type:'null'});assert.equal(call.data.question_input,null);
      const value=draft(ctx);value.questions=null;return value;
    }
    assert.equal(call.data.questions,null);assert.equal(call.data.safety,null);return review(call.data);
  });
  const output=await runCombinedRelationshipState(next,ctx,null,operation,true);
  assert.equal(output.state_agent.reviewed,true);assert.equal(next.calls.length,2);assert.deepEqual(output.question_plan,{skip:[]});
});

test('the shared literal schema helper is idempotent and leaves facts, names, unknowns and question schemas unchanged',async()=>{
  const ctx=context(),model=fake(call=>call.stage.startsWith('turn_draft')?draft(ctx):review(call.data));
  await runCombinedRelationshipState(model,ctx,null,{});
  const schema=model.calls[0].schema,before=structuredClone(schema),literal=literalStateRepairSchema(schema,{combined:true});
  assert.deepEqual(schema,before);assert.deepEqual(literalStateRepairSchema(literal,{combined:true}),literal);
  for(const key of ['patient_state','name_index'])assert.deepEqual(literal.properties.state.properties[key],schema.properties.state.properties[key]);
  assert.deepEqual(literal.properties.questions,schema.properties.questions);
  assert.deepEqual(literal.properties.state.properties.relationship_memory.properties.unknowns,
    schema.properties.state.properties.relationship_memory.properties.unknowns);
});
