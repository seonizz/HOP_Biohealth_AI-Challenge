import {safetyReviewFixture} from './helpers/safety-review.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {runCombinedRelationshipState} from '../src/relationship-turn.js';
import {relationshipQuestionRequest,validateRelationshipQuestions,questionReviewRequest} from '../src/relationship-agent.js';

const field=(id,text)=>({id,question:id,status:'answered',text,rawText:text,custom:''});
const context=()=>({patient:{alias:'합성 친구',fields:{name:field('name','합성 친구'),
  mood:field('mood','퇴근 후 잠깐 쉬고 싶다고 말했어요.')}},supporter:{fields:{}},
  user_goal:{message:field('want','원하면 이야기를 듣고 싶어요.')},latest_answer:{subject:'patient',question_id:'mood'},
  answered_count:3,adaptive_questions:true,question_candidates:[],clarification_candidates:[]});
const blocks=['patient_state','name_index','relationship_memory','questions'];
const groups=['patient_state','relationship_memory'];
const draft=ctx=>({state:{patient_state:{facts:[{subject:'patient',question_id:'mood',
  quote:ctx.patient.fields.mood.rawText,certainty:'reported'}],unknowns:['대상자의 현재 상태 전체','지원 필요성의 불명확한 범위','내일 가능한 대화 시간']},
  name_index:{alias:'합성 친구',source_question_id:'name',quote:'합성 친구'},relationship_memory:{
    patient:[{certainty:'reported',evidence:[{subject:'patient',question_id:'mood',quote:ctx.patient.fields.mood.rawText}]}],supporter:[],
    relationship:[{interpretation:'가능한 해석: 이용자는 상대가 원할 때 이야기를 듣고 싶다는 의도를 가지고 있어요.',certainty:'tentative',
      evidence:[{subject:'user_goal',question_id:'want',quote:ctx.user_goal.message.rawText}]}],
    unknowns:['대상자의 휴식 의향 전체','함께하는 역할의 불명확한 범위','이용자가 함께할 수 있는 시간']}},
  questions:{skip:[],clarify:[],safety:{urgent:false,evidence_ids:[]}}});
const unknown=claim=>claim.kind==='unresolved_information'&&claim.certainty==='unknown';
const blockValue=(value,block)=>structuredClone(block==='name_index'?{name_index:value.state.name_index}:block==='questions'?value.questions:value.state[block]);

function fixture({repair=true,aliases=false,rejectedClaim=null,forceRejection=false,badRepair=false,questionVerdict=null,unknownRepair=null}={}) {
  const ctx=context();
  if(unknownRepair)ctx.patient.fields.mood={...field('mood','이번 주 정기 모임에는 참석하지 않았다고 말했어요.'),question:'이번 주 정기 모임에 참석했나요?'};
  if(unknownRepair==='partial')ctx.supporter.fields.availability={...field('availability','다음 주 함께할 수 있는 시간은 아직 모르겠어요.'),status:'unknown'};
  const initial=draft(ctx),fixed=structuredClone(initial),calls=[];
  fixed.state.patient_state.unknowns=['휴식 이후 원하는 지원의 구체적인 범위','지원 요청을 확인할 수 있는 상황',initial.state.patient_state.unknowns[2]];
  fixed.state.relationship_memory.unknowns=['휴식 이후 함께할 수 있는 활동의 범위','도움을 나눌 수 있는 구체적인 역할',initial.state.relationship_memory.unknowns[2]];
  if(unknownRepair)for(const group of groups){
    initial.state[group].unknowns=['이번 주 정기 모임 참석 여부',...(unknownRepair==='partial'?['다음 주에 함께할 수 있는 시간']:[])];
    fixed.state[group].unknowns=unknownRepair==='all'?[]:unknownRepair==='partial'?['다음 주에 함께할 수 있는 시간']:
      [unknownRepair==='explanation'?'모임에 불참했다고 답했으므로 참석 여부는 확인되지 않음':'이번 주 정기 모임 참석 여부(미확인)'];
  }
  if(aliases){
    initial.state.relationship_memory.unknowns[0]=initial.state.patient_state.unknowns[0];
    fixed.state.relationship_memory.unknowns[0]=fixed.state.patient_state.unknowns[0];
  }
  if(questionVerdict){
    ctx.question_candidates=[{id:'rest',subject:'patient',question:'대상자가 퇴근 후 무엇을 하고 싶다고 말했나요?'},
      {id:'extra',subject:'patient',question:'더 할 이야기가 있나요?'}];
    const {certainty,...evidence}=initial.state.patient_state.facts[0];
    const skip={question_id:'rest',reason:'already_covered',explanation:'퇴근 후 하고 싶은 일을 직접 전한 답변이 있습니다.',evidence:[evidence]};
    initial.questions.skip=[structuredClone(skip)];fixed.questions.skip=[structuredClone(skip)];
  }
  const rejectedStrings=new Set(groups.flatMap(group=>initial.state[group].unknowns.slice(0,unknownRepair?1:2)));
  if(['explanation','suffix'].includes(unknownRepair))for(const group of groups)
    fixed.state[group].unknowns.forEach(value=>rejectedStrings.add(value));
  const model={stateMode:'combined_blocks',async agentComplete(stage,prompt,data,schema,operation,validate){
    const call={stage,prompt,data:structuredClone(data),schema:structuredClone(schema)};calls.push(call);
    let output;
    if(data.output_block){
      output=blockValue(stage.endsWith('_after_review')&&repair?fixed:initial,data.output_block);
      if(badRepair&&stage==='turn_draft_block_patient_state_after_review')output.unknowns[0]=17;
    }else if(stage.startsWith('question_review')){
      output={audits:data.claims.map(claim=>({id:claim.id,verdict:questionVerdict,reason:'원문의 전체 질문 범위를 독립적으로 대조했습니다.'}))};
    }else if(stage.startsWith('safety_review'))output=safetyReviewFixture(data);
    else{
      assert.ok(stage.startsWith('turn_review'));
      const claims=data.review_target.claims,hasOriginal=claims.some(claim=>unknown(claim)&&rejectedStrings.has(claim.claim));
      const reject=Boolean(rejectedClaim)||hasOriginal||forceRejection;
      output={state:{approved:!reject,issues:reject?[{reason:'현재 미확인 범위가 원문과 맞지 않거나 중요한 정정이 누락됐습니다.',
        repair:'현재 원문에서 각 반려 범위를 다시 검토하고 정정을 보존하세요.'}]:[],audits:claims.map(claim=>{
        let verdict=unknown(claim)?'still_unknown':claim.certainty==='tentative'?'plausible':'supported';
        if(rejectedClaim){if(claim.id===rejectedClaim)verdict='unsupported';}
        else if(unknown(claim)&&rejectedStrings.has(claim.claim))verdict=claim.id.endsWith('.0')?'already_answered':'review_uncertain';
        return {id:claim.id,verdict,reason:'현재 원문과 대조한 판정: '+claim.id};
      })},questions:null,safety:null};
    }
    call.output=structuredClone(output);const result=validate(output);call.validated=structuredClone(result);return result;
  }};
  return {ctx,initial,fixed,calls,run:()=>runCombinedRelationshipState(model,ctx,null,{recovery:{}})};
}

test('rejected block unknowns receive only their own exact repair targets and keep all source/schema/review contracts',async()=>{
  const f=fixture(),before=structuredClone({ctx:f.ctx,initial:f.initial,fixed:f.fixed}),result=await f.run();
  const firstReview=f.calls.find(call=>call.stage==='turn_review');
  const repaired=f.calls.filter(call=>call.stage.startsWith('turn_draft_block_')&&call.stage.endsWith('_after_review'));
  assert.equal(repaired.length,4);
  for(const suffix of ['', '_after_review'])for(const [index,block]of blocks.entries()){
    const call=f.calls.find(call=>call.stage==='turn_draft_block_'+block+suffix);
    if(block==='questions')assert.equal(Object.hasOwn(call.data,'generated_blocks'),false);
    else {
      assert.deepEqual(Object.keys(call.data.generated_blocks),blocks.slice(0,index));
      for(const previous of blocks.slice(0,index))assert.deepEqual(call.data.generated_blocks[previous],
        f.calls.find(entry=>entry.stage==='turn_draft_block_'+previous+suffix).validated);
    }
  }
  assert.equal(f.calls.find(call=>call.stage==='turn_draft_block_questions').prompt,
    f.calls.find(call=>call.stage==='turn_draft_block_questions_after_review').prompt);
  for(const call of f.calls.filter(call=>call.data.output_block&&!call.stage.endsWith('_after_review')))
    assert.equal(Object.hasOwn(call.data,'revision_targets'),false);
  for(const call of repaired){
    const block=call.data.output_block,original=f.calls.find(entry=>entry.stage==='turn_draft_block_'+block);
    assert.deepEqual(call.schema,original.schema);
    for(const key of ['shared_input','state_input','question_input'])assert.deepEqual(call.data[key],original.data[key]);
    assert.deepEqual(call.data.review,{...firstReview.validated,safety:safetyReviewFixture(f.calls.find(entry=>entry.stage==='safety_review').data)});
    assert.deepEqual(call.data.rejected_draft,repaired[0].data.rejected_draft);
    assert.deepEqual(call.data.rejected_draft.claims,firstReview.data.review_target.claims);
    for(const group of groups)assert.deepEqual(call.data.rejected_draft.state[group].unknowns,f.initial.state[group].unknowns);
    if(!groups.includes(block)){
      assert.equal(Object.hasOwn(call.data,'revision_targets'),false);
      assert.doesNotMatch(call.prompt,/이번 블록의 revision_targets/u);continue;
    }
    const expected=[0,1].map(index=>{
      const id=block+'.unknowns.'+index,claim=call.data.rejected_draft.claims.find(claim=>claim.id===id);
      const audit=call.data.review.state.audits.find(audit=>audit.id===id);
      return {id,claim:claim.claim,verdict:audit.verdict,reason:audit.reason};
    });
    assert.deepEqual(call.data.revision_targets,expected);
    assert.deepEqual(expected.map(target=>target.verdict),['unsupported','plausible']);
    assert.match(call.prompt,/검토자 판정도 틀릴 수 있는 수정 자료이며 새로운 사실이나 승인된 답안이 아닙니다/u);
    assert.match(call.prompt,/검토자의 reason을 원문 대신 근거로 쓰거나 내용을 새 사실로 저장하지 마세요/u);
    assert.match(call.prompt,/필요한 미확인 한계와 원문의 모름·거절·상충은 계속 보존/u);
    assert.match(call.prompt,/새로운 독립 검토를 받아야 합니다/u);
  }
  const fresh=f.calls.find(call=>call.stage==='turn_review_after_review');
  assert.ok(fresh);assert.equal(fresh.data.review,undefined);assert.equal(fresh.data.rejected_draft,undefined);
  assert.deepEqual(fresh.data.review_target.input,firstReview.data.review_target.input);
  for(const group of groups){
    assert.deepEqual(result[group].unknowns,f.fixed.state[group].unknowns);
    assert.equal(result[group].unknowns[2],f.initial.state[group].unknowns[2]);
    assert.deepEqual(fresh.data.review_target.claims.filter(claim=>claim.id.startsWith(group+'.unknowns.')).map(claim=>claim.claim),f.fixed.state[group].unknowns);
    assert.equal(Object.hasOwn(result[group],'revision_targets'),false);
  }
  assert.deepEqual(result.state_agent.stages,[...blocks.map(block=>'turn_draft_block_'+block),'turn_review','safety_review',
    ...blocks.map(block=>'turn_draft_block_'+block+'_after_review'),'turn_review_after_review','safety_review_after_review']);
  assert.equal(result.state_agent.reviewed,true);assert.deepEqual({ctx:f.ctx,initial:f.initial,fixed:f.fixed},before);
});

for(const unknownRepair of ['all','partial'])
test('model-authored unknown repair '+(unknownRepair==='all'?'may remove every resolved item':'preserves the actual remaining gap')+' before fresh review',async()=>{
  const f=fixture({unknownRepair}),before=structuredClone(f.ctx),result=await f.run();
  const expected=unknownRepair==='all'?[]:['다음 주에 함께할 수 있는 시간'];
  const first=f.calls.find(call=>call.stage==='turn_review'),fresh=f.calls.find(call=>call.stage==='turn_review_after_review');
  assert.equal(first.validated.state.approved,false);assert.equal(fresh.validated.state.approved,true);
  assert.deepEqual(fresh.data.review_target.input,first.data.review_target.input);
  assert.equal(fresh.data.review,undefined);
  if(unknownRepair==='partial'){
    const remaining=fresh.data.review_target.input.supporter.find(row=>row.question_id==='availability');
    assert.equal(remaining.status,'unknown');assert.equal(remaining.answers[0].text,f.ctx.supporter.fields.availability.rawText);
  }
  for(const group of groups){
    const writer=f.calls.find(call=>call.stage==='turn_draft_block_'+group+'_after_review');
    assert.deepEqual(writer.data.revision_targets.map(target=>target.claim),['이번 주 정기 모임 참석 여부']);
    assert.equal(writer.schema.properties.unknowns.minItems,0);
    assert.match(writer.prompt,/항목 전체에 답했다면 그 항목을 재서술하지 말고 제거/u);
    assert.match(writer.prompt,/모든 항목이 해결됐으면 unknowns=\[\]가 올바릅니다/u);
    assert.match(writer.prompt,/행동·사건이 없었다는 명시적 부정 답변과 그 여부를 모른다는 답변을 구분/u);
    assert.match(writer.prompt,/실제로 남은 중요한 미확인.*삭제하지 말고, 일부만 확인된 항목은 남은 범위로 좁히세요/u);
    assert.match(writer.prompt,/새로운 독립 검토를 받아야 합니다/u);
    assert.deepEqual(writer.output.unknowns,expected);
    assert.deepEqual(writer.validated.unknowns,expected,'the server preserves the writer output');
    assert.deepEqual(result[group].unknowns,expected);
  }
  assert.deepEqual(fresh.data.review_target.claims.filter(unknown).map(claim=>claim.claim),expected,'identical unknowns share one audit, without losing their original slots');
  assert.equal(result.patient_state.facts[0].quote,f.ctx.patient.fields.mood.rawText);
  assert.equal(result.state_agent.reviewed,true);assert.deepEqual(f.ctx,before);
});

for(const unknownRepair of ['explanation','suffix'])
test('an answered unknown rewritten as '+unknownRepair+' remains subject to rejection',async()=>{
  const f=fixture({unknownRepair}),before=structuredClone(f.ctx);
  await assert.rejects(f.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
  const fresh=f.calls.find(call=>call.stage==='turn_review_after_review');
  assert.equal(f.calls.filter(call=>call.stage.startsWith('turn_review')).length,2);
  assert.equal(fresh.validated.state.approved,false);
  assert.ok(fresh.validated.state.audits.filter(audit=>audit.id.includes('.unknowns.')).every(audit=>audit.verdict==='unsupported'));
  for(const group of groups){
    const writer=f.calls.find(call=>call.stage==='turn_draft_block_'+group+'_after_review');
    assert.match(writer.prompt,/검토 이유·삭제 지시·수정 경과를 설명하는 문장을 넣지 마세요/u);
    assert.deepEqual(writer.validated.unknowns,f.fixed.state[group].unknowns,'schema validation does not silently delete semantic errors');
  }
  assert.deepEqual(fresh.data.review_target.claims.filter(unknown).map(claim=>claim.claim),f.fixed.state.patient_state.unknowns);
  assert.deepEqual(f.ctx,before);assert.equal(f.ctx.state_agent,undefined);
});

test('a shared rejected unknown audit expands into each original block target without mixing their other claims',async()=>{
  const f=fixture({aliases:true}),result=await f.run();
  assert.equal(f.calls.find(call=>call.stage==='turn_review').data.review_target.claims.some(claim=>claim.id==='relationship_memory.unknowns.0'),false);
  for(const group of groups){
    const call=f.calls.find(call=>call.stage==='turn_draft_block_'+group+'_after_review');
    assert.equal(call.data.revision_targets[0].id,group+'.unknowns.0');
    assert.equal(call.data.revision_targets[0].claim,f.initial.state[group].unknowns[0]);
    assert.ok(call.data.revision_targets.every(target=>target.id.startsWith(group+'.unknowns.')));
    assert.deepEqual(result[group].unknowns,f.fixed.state[group].unknowns);
  }
});

for(const rejectedClaim of ['patient.0','relationship.0','missing_correction'])
test('ordinary claim rejection or a missing correction cannot create unrelated unknown targets: '+rejectedClaim,async()=>{
  const f=fixture({rejectedClaim,repair:false});
  await assert.rejects(f.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
  for(const call of f.calls.filter(call=>call.data.output_block)){
    assert.equal(Object.hasOwn(call.data,'revision_targets'),false);
    assert.doesNotMatch(call.prompt,/이번 블록의 revision_targets/u);
  }
  assert.equal(f.calls.filter(call=>call.stage.startsWith('turn_review')).length,2);
});

for(const repair of [false,true])test('revision targets never override a fresh rejection of '+(repair?'changed wording':'an unchanged draft'),async()=>{
  const f=fixture({repair,forceRejection:true});
  await assert.rejects(f.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
  const fresh=f.calls.find(call=>call.stage==='turn_review_after_review');assert.ok(fresh);
  for(const group of groups){
    const expected=(repair?f.fixed:f.initial).state[group].unknowns;
    assert.deepEqual(fresh.data.review_target.claims.filter(claim=>claim.id.startsWith(group+'.unknowns.')).map(claim=>claim.claim),expected);
    assert.ok(f.calls.find(call=>call.stage==='turn_draft_block_'+group+'_after_review').data.revision_targets.length);
  }
  assert.equal(fresh.validated.state.approved,false);
});

test('a targeted rewrite still fails its original block schema before another independent review',async()=>{
  const f=fixture({badRepair:true});
  await assert.rejects(f.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  const rejected=f.calls.find(call=>call.stage==='turn_draft_block_patient_state_after_review');
  assert.ok(rejected.data.revision_targets.length);
  assert.equal(rejected.validated,undefined);
  assert.equal(f.calls.some(call=>call.stage==='turn_draft_block_name_index_after_review'),false);
  assert.equal(f.calls.filter(call=>call.stage.startsWith('turn_review')).length,1);
});

for(const verdict of ['supported','unsupported','plausible'])
test('source-only questions preserve the full original review contract before and after state repair: '+verdict,async()=>{
  const f=fixture({questionVerdict:verdict}),before=structuredClone(f.ctx),result=await f.run();
  const request=relationshipQuestionRequest(f.ctx),decision=validateRelationshipQuestions(f.initial.questions,f.ctx,request);
  const expected=questionReviewRequest(decision,request),reviews=f.calls.filter(call=>call.stage.startsWith('question_review'));
  assert.equal(reviews.length,2);
  for(const suffix of ['', '_after_review']){
    const draft=f.calls.find(call=>call.stage==='turn_draft_block_questions'+suffix);
    assert.equal(Object.hasOwn(draft.data,'generated_blocks'),false);
    assert.deepEqual(draft.schema,request.schema);
    const {prior_state,prior_relationship_memory,...raw}=request.data;
    assert.deepEqual({...draft.data.shared_input,...draft.data.question_input},raw);
  }
  for(const review of reviews){
    assert.deepEqual(review.data,expected.data);assert.deepEqual(review.schema,expected.schema);assert.equal(review.prompt,expected.prompt);
    assert.equal(Object.hasOwn(review.data,'generated_blocks'),false);
    assert.equal(review.data.claims[0].evidence[0].quote,f.ctx.patient.fields.mood.rawText);
    assert.equal(review.validated.audits[0].verdict,verdict);
  }
  assert.deepEqual(result.question_plan.skip.map(item=>item.question_id),verdict==='supported'?['rest']:[]);
  assert.equal(result.state_agent.reviewed,true);assert.equal(result.state_agent.stages.at(-1),'safety_review_after_review');
  assert.ok(result.state_agent.stages.includes('question_review_after_review'));
  assert.deepEqual(f.ctx,before);
});
