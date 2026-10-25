import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {createIntake,answerIntake,prepareModelAnswer,buildContext} from '../src/intake.js';
import {reviewPrompt} from '../src/relationship-turn.js';
import {claimsOf} from '../src/grounding-audit.js';

const name='웹 흐름 검증 친구',want='부담 없이 이야기를 듣고 싶다고 전하고 싶어요.';
const context=()=>buildContext(prepareModelAnswer(answerIntake(createIntake(),{question_id:'name',text:name}),
  {question_id:'want',text:want},1));
const draft=()=>({state:{patient_state:{facts:[{subject:'patient',question_id:'name',quote:name,certainty:'reported'}],
  unknowns:[name+'와의 구체적인 관계','이용자가 현재 느끼는 심리적 부담']},
  name_index:{alias:name,source_question_id:'name',quote:name},
  relationship_memory:{patient:[],supporter:[],relationship:[],unknowns:[]}},
  questions:{skip:[{question_id:'goal',reason:'already_covered',explanation:'합성 질문 생략 제안',
    evidence:[{subject:'user_goal',question_id:'want',quote:want}]}],clarify:[],safety:{urgent:false,evidence_ids:[]}}});
const audits=claims=>claims.map(claim=>({id:claim.id,verdict:claim.kind==='unresolved_information'&&claim.certainty==='unknown'?'still_unknown':'supported',reason:'합성 원문의 정확한 범위를 대조했습니다.'}));

test('production review uses separate unknown labels without changing factual evidence or uncertainty checks',()=>{
  const prompt=reviewPrompt({typedUnknowns:true});
  assert.match(prompt,/verdict는 still_unknown, already_answered, not_needed, review_uncertain 중 하나만 사용/u);
  assert.match(prompt,/still_unknown은 같은 사람·시점·범위가 실제로 아직 확인되지 않았고 현재 판단에 필요한 한계/u);
  assert.match(prompt,/not_needed는 실제로 현재 판단과 관계없는 불필요한 미확인 범위/u);
  assert.match(prompt,/review_uncertain은 검토자가 그 범위가 실제 미확인인지 또는 현재 판단에 필요한지 판정하지 못했다는 뜻/u);
  assert.match(prompt,/명시적으로 모른다고 보고한 사실 자체는 review_uncertain의 이유가 아닙니다/u);
  assert.match(prompt,/이 유형에는 supported, plausible, unsupported를 사용하지 마세요/u);
  assert.match(prompt,/reported_excerpt와 tentative_hypothesis에는 기존 supported, plausible, unsupported를 사용/u);
  assert.match(prompt,/unknown 항목은 still_unknown일 때만 승인할 수 있습니다/u);
  assert.match(prompt,/already_answered, not_needed 또는 review_uncertain이 하나라도 있으면 state\.approved=false/u);
  assert.match(prompt,/판정 불확실성을 실제 불필요함인 not_needed로 바꾸지 마세요/u);
  assert.doesNotMatch(prompt,/unknown 항목은 supported|이 항목의 supported|미확인으로 남기는 것이 타당한지 판단하지 못하면 plausible/u);
  assert.match(prompt,/kind=reported_excerpt[\s\S]*현재 claim 전체를 직접 뒷받침하면 supported/u);
  assert.match(prompt,/최신 answered 원문·후속 답변의 의미를 바꾸는 명시적 정정·부정·시점 변경/u);
});

test('combined review prompt separates its input target, output result and unknown evidence rules',()=>{
  const prompt=reviewPrompt();
  assert.match(prompt,/입력 review_target은 검토 대상이고 출력 state는 검토 결과/u);
  assert.match(prompt,/입력 review_target에 approved\/issues\/audits가 없어도 정상/u);
  assert.match(prompt,/review_target\.claims의 kind와 certainty를 먼저 구분/u);
  assert.match(prompt,/kind=unresolved_information은 전체 원문에서 그 범위가 실제로 미확인/u);
  assert.match(prompt,/evidence가 없는 것은 이 유형의 정상 구조/u);
  assert.match(prompt,/kind=reported_excerpt는 선택한 원문 발췌의 보고/u);
  assert.match(prompt,/전체 답변을 빠짐없이 요약했다는 주장이 아닙니다/u);
  assert.match(prompt,/kind=tentative_hypothesis는 선택한 인용이 지지하는 가설/u);
  assert.match(prompt,/명시적으로 의도만 말한 가설에 실제 행동이나 대상자의 동의를 요구하지 마세요/u);
  assert.match(prompt,/실제 행동·동의·상태를 추가로 주장했다면 해당 부분의 근거를 계속 요구/u);
  assert.match(prompt,/unknown 항목 중 unsupported 또는 plausible이 하나라도 있으면 state\.approved=false/u);
  assert.doesNotMatch(prompt,/state\.(?:input|claims|reference_roles|state)\b/u);
  assert.doesNotMatch(prompt,/claims의 각 항목을 빠짐없이 독립적으로 검토하고 audits에 같은 id를 한 번씩 반환하세요/u);
});

test('combined review distinguishes an explicitly unknown value from known information without exempting unnecessary gaps',()=>{
  const prompt=reviewPrompt();
  assert.match(prompt,/'모른다', '확인되지 않았다', '도움을 말한 적이 없다'는 미확인 상태에 관한 보고/u);
  assert.match(prompt,/원하는 도움·본인 가치관·실제 부담의 값이 확인됐다는 뜻이 아닙니다/u);
  assert.match(prompt,/같은 사람·시점·범위의 실제 공백이며 현재 판단에 필요할 때만/u);
  assert.match(prompt,/불필요하다는 판단은 별도로.*왜 필요하지 않은지 구체적으로 설명/u);
  assert.match(prompt,/이미 확인됐다고 거절할 때는 해당 값을 실제로 확인해 준 원문과 확인된 범위를 지목/u);
  assert.match(prompt,/명시적인 모름이나 원문에 언급이 없다는 사실을 이미 확인된 값으로 바꾸어 거절하지 마세요/u);
  assert.match(prompt,/unknown 항목 중 unsupported 또는 plausible이 하나라도 있으면 state\.approved=false/u);
  assert.match(prompt,/필요한 미확인 항목을 일괄 삭제하지 말고/u);
});

test('combined review issues identify current defects while concrete missing corrections still reject valid audited claims',()=>{
  const prompt=reviewPrompt();
  assert.match(prompt,/issues에는 현재 남은 구체적인 결함만 적고, 해당 claim id 또는 누락된 범위와 판단 근거인 원문·불일치를 지목/u);
  assert.match(prompt,/'누락이 있는지 다시 확인' 같은 가능성·검토 과제만으로 issues를 만들지 마세요/u);
  assert.match(prompt,/최신 정정이 현재 claims에 이미 보존됐다면 그 정정의 재확인을 오류로 반복하지 말고/u);
  assert.match(prompt,/두 unknowns 배열 사이에서 허용된 중복도 거절 사유로 다시 적지 마세요/u);
  assert.match(prompt,/모든 audit가 각 유형의 승인 기준을 충족하고 구체적인 현재 오류나 중요한 최신 정정 누락이 없다면 state\.approved=true와 issues=\[\]를 반환/u);
  assert.match(prompt,/모든 audit가 타당해도 실제로 누락된 중요한 최신 정정이 있다면 그 원문과 누락 범위를 지목해 계속 거절/u);
  assert.match(prompt,/unknown 항목 중 unsupported 또는 plausible이 하나라도 있으면 state\.approved=false/u);
});

function fixture(value,{review,retryFailures=false}={}) {
  const calls=[],logs=[],controller=new AbortController();
  const model=new ModelGateway({baseUrl:'http://model.test/v1',apiKey:'synthetic-key',model:'synthetic-model',
    protocol:'relationship_agent',agentFormat:'json_schema',timeoutMs:0,retryFailures,retryDelayMs:1,
    diagnosticLogger:entry=>{logs.push(entry);if(entry.event==='model_operation_retry')controller.abort();},
    fetchImpl:async(_url,options)=>{
      const body=JSON.parse(options.body),input=JSON.parse(body.messages.at(-1).content);
      const call={...input,prompt:body.messages[0].content};calls.push(call);
      let output;
      if(input.stage.startsWith('turn_draft'))output=structuredClone(typeof value==='function'?value(call):value);
      else if(input.stage.startsWith('turn_review'))output={state:{approved:true,issues:[],audits:audits(input.data.review_target.claims)},questions:null,safety:null};
      else if(input.stage.startsWith('question_review'))output={audits:input.data.claims.map(({id})=>({id,verdict:'unsupported',reason:'전달 의도는 이 질문 전체의 답변이 아닙니다.'}))};
      else assert.fail('Unexpected stage: '+input.stage);
      if(review&&!input.stage.startsWith('turn_draft'))output=review(output,call);
      return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));
    }});
  return {model,calls,logs,signal:controller.signal};
}

test('typed finding claims preserve every original field, source actor and role alongside unchanged unknowns',async()=>{
  const ctx=context(),value=draft();value.questions.skip=[];
  const mood='최근에는 학업 때문에 피곤하다고 말했어요.',feeling='저는 저녁에는 쉬고 싶어요.';
  const field=(id,text)=>({id,question:id,text,rawText:text,custom:'',status:'answered'});
  ctx.patient.fields.mood=field('mood',mood);ctx.supporter.fields.feeling=field('feeling',feeling);
  const patient={subject:'patient',question_id:'mood',quote:mood},supporter={subject:'supporter',question_id:'feeling',quote:feeling},
    intent={subject:'user_goal',question_id:'want',quote:want};
  value.state.relationship_memory={
    patient:[{certainty:'reported',evidence:[patient]},
      {interpretation:'가능한 해석: 학업의 부담을 함께 살펴볼 필요가 있을 수 있다.',certainty:'tentative',evidence:[patient]}],
    supporter:[{certainty:'reported',evidence:[supporter]}],
    relationship:[{interpretation:'가능한 해석: 이용자는 상대의 이야기를 듣고 싶다는 의도를 전하려 한다.',certainty:'tentative',evidence:[intent]}],
    unknowns:['지금 이야기할 수 있는 시간'],
  };
  value.state.patient_state.unknowns=['현재 원하는 도움의 방식'];
  const before=structuredClone(value),source=structuredClone(ctx),f=fixture(value,{review:(output,call)=>{
    for(const claim of call.data.review_target.claims)
      if(claim.certainty==='tentative')output.state.audits.find(audit=>audit.id===claim.id).verdict='plausible';
    return output;
  }});
  const result=await f.model.updateState(ctx),review=f.calls.find(call=>call.stage==='turn_review'),target=review.data.review_target;
  const expected=claimsOf(Object.fromEntries(['patient','supporter','relationship'].map(group=>[group,result.relationship_memory[group]])));
  assert.deepEqual(target.claims.slice(0,expected.length).map(({kind,group,...original})=>original),expected);
  assert.deepEqual(target.claims.slice(0,expected.length).map(({id,kind,group})=>({id,kind,group})),[
    {id:'patient.0',kind:'reported_excerpt',group:'patient'},
    {id:'patient.1',kind:'tentative_hypothesis',group:'patient'},
    {id:'supporter.0',kind:'reported_excerpt',group:'supporter'},
    {id:'relationship.0',kind:'tentative_hypothesis',group:'relationship'},
  ]);
  assert.deepEqual(target.claims.slice(expected.length),[
    {id:'patient_state.unknowns.0',kind:'unresolved_information',claim:'현재 원하는 도움의 방식',certainty:'unknown',evidence:[]},
    {id:'relationship_memory.unknowns.0',kind:'unresolved_information',claim:'지금 이야기할 수 있는 시간',certainty:'unknown',evidence:[]},
  ]);
  assert.deepEqual(target.claims.find(claim=>claim.id==='patient.0').evidence,[patient]);
  assert.deepEqual(target.claims.find(claim=>claim.id==='supporter.0').evidence,[supporter]);
  assert.deepEqual(target.claims.find(claim=>claim.id==='relationship.0').evidence,[intent]);
  assert.equal(target.claims.find(claim=>claim.id==='relationship.0').claim,value.state.relationship_memory.relationship[0].interpretation);
  assert.equal(target.input.patient.find(row=>row.question_id==='mood').answers[0].text,mood);
  assert.equal(target.input.supporter.find(row=>row.question_id==='feeling').answers[0].text,feeling);
  assert.equal(target.input.user_goal.find(row=>row.question_id==='want').answers[0].text,want);
  assert.deepEqual(target.reference_roles.known_name,value.state.name_index);
  assert.deepEqual(target.reference_roles.supporter_report_fields,[{question_id:'feeling',status:'answered'}]);
  assert.equal(target.reference_roles.user_goal_fields.find(row=>row.question_id==='want').role,'intended_message');
  assert.deepEqual(review.output_schema.properties.state.required,['audits','issues','approved']);
  for(const branch of review.output_schema.properties.state.properties.audits.items.anyOf)
    assert.deepEqual(branch.required,['id','reason','verdict']);
  assert.equal(result.state_agent.reviewed,true);assert.deepEqual(value,before);assert.deepEqual(ctx,source);
  assert.deepEqual(f.calls.map(call=>call.stage),['turn_draft','turn_review']);
});

test('state drafting narrows mixed known and unknown information before independent review',async()=>{
  const ctx=context(),value=draft();value.questions.skip=[];
  const mood='최근 연락이 줄어든 것만 알고 본인의 기분은 아직 듣지 못했어요.';
  ctx.patient.fields.mood={id:'mood',question:'관찰한 모습',text:mood,rawText:mood,custom:'',status:'answered'};
  value.state.patient_state.unknowns=['대상자가 직접 느끼는 현재 기분'];
  value.state.relationship_memory.unknowns=['대상자가 원하는 도움의 방식'];
  const f=fixture(value),result=await f.model.updateState(ctx),writer=f.calls.find(call=>call.stage==='turn_draft');
  assert.match(writer.prompt,/각 unknown은 확인되지 않은 범위 하나만 구체적으로 적으세요/u);
  assert.match(writer.prompt,/관찰된 부분은 제외하고 아직 모르는 마음·의향 등만 한정/u);
  assert.match(writer.prompt,/기간·빈도·도움·장벽을 하나로 합치지 마세요/u);
  assert.match(writer.prompt,/비임상적 관찰만 담고 있으면 이를 증상으로 바꾸어/u);
  assert.match(writer.prompt,/필요한 미확인을 일괄 삭제하지 말고/u);
  const review=f.calls.find(call=>call.stage==='turn_review');
  assert.equal(review.data.review_target.input.patient.find(row=>row.question_id==='mood').answers[0].text,mood);
  assert.deepEqual(result.patient_state.unknowns,value.state.patient_state.unknowns);
  assert.deepEqual(result.relationship_memory.unknowns,value.state.relationship_memory.unknowns);
});

test('a rejected question proposal has no path into state review input or whole-operation recovery',async()=>{
  const value=draft(),original=structuredClone(value);
  const f=fixture(value,{retryFailures:true,review:(output,call)=>{
    if(call.stage.startsWith('turn_review')){
      // This reproduces the observed combined-input failure if foreign proposals return.
      if(call.data.questions){output.state.approved=false;output.state.issues=[{reason:'skip.goal이 supported가 아님',repair:'질문 생략을 취소하세요.'}];}
      assert.equal(call.data.questions,null);assert.equal(call.data.safety,null);
      assert.equal(call.data.review_target.input.question_candidates,undefined);
      assert.ok(call.data.review_target.claims.every(claim=>!claim.id.startsWith('skip.')&&!claim.id.startsWith('clarify.')));
      assert.deepEqual(call.output_schema.properties.questions,{type:'null'});
      assert.deepEqual(call.output_schema.properties.safety,{type:'null'});
    }else{
      assert.equal(call.data.review_target,undefined);assert.equal(call.data.safety,undefined);
      assert.deepEqual(call.data.claims.map(claim=>claim.id),['skip.goal']);
      assert.deepEqual(Object.keys(call.output_schema.properties),['audits']);
    }
    return output;
  }});
  const result=await f.model.updateState(context(),null,{signal:f.signal});
  assert.equal(result.state_agent.reviewed,true);assert.deepEqual(result.question_plan.skip,[]);
  assert.deepEqual(result.patient_state.unknowns,value.state.patient_state.unknowns);
  assert.deepEqual(f.calls.map(call=>call.stage),['turn_draft','turn_review','question_review']);
  assert.equal(f.logs.some(entry=>entry.event==='model_operation_retry'),false);
  assert.deepEqual(value,original);
});

test('known referring names and intended messages are separated from actual supporter reports without rewriting unknowns',async()=>{
  const value=draft();value.questions.skip=[];
  const f=fixture(value,{review:(output,call)=>{
    const {input,claims,reference_roles:roles}=call.data.review_target;
    assert.deepEqual(roles.known_name,value.state.name_index);
    assert.deepEqual(roles.user_goal_fields,[{question_id:'want',status:'answered',role:'intended_message'},
      {question_id:'goal',status:'not_asked',role:'desired_outcome'}]);
    assert.deepEqual(roles.supporter_report_fields,[]);assert.deepEqual(input.supporter,[]);
    assert.equal(input.user_goal[0].answers[0].text,want);
    assert.equal(input.patient.find(row=>row.question_id==='name').answers[0].text,name);
    assert.deepEqual(claims.map(claim=>claim.claim),value.state.patient_state.unknowns);
    assert.ok(claims.every(claim=>claim.certainty==='unknown'&&claim.evidence.length===0));
    return output;
  }});
  const result=await f.model.updateState(context());
  assert.deepEqual(result.patient_state.unknowns,value.state.patient_state.unknowns);
  assert.deepEqual(f.calls.map(call=>call.stage),['turn_draft','turn_review']);
});

for(const [subject,id,text,index] of [['patient','rel','직장 동료라고 알려 줬어요.',0],
  ['supporter','feeling','저는 지금 심리적 부담을 느껴요.',1]]) {
  test('reference roles never override an independently rejected already-answered unknown: '+id,async()=>{
    const ctx=context(),value=draft();value.questions.skip=[];
    ctx[subject].fields[id]={id,question:id,text,rawText:text,custom:'',status:'answered'};
    const f=fixture(value,{review:(output,call)=>{
      assert.ok(call.data.review_target.input[subject].find(row=>row.question_id===id).answers.some(answer=>answer.text===text));
      if(subject==='supporter')assert.ok(call.data.review_target.reference_roles.supporter_report_fields.some(row=>row.question_id===id));
      output.state.approved=false;output.state.issues=[{reason:'원문에서 이미 답한 범위를 미확인으로 제안했습니다.',repair:'실제 미확인 범위로 수정하세요.'}];
      output.state.audits.find(audit=>audit.id==='patient_state.unknowns.'+index).verdict='already_answered';
      return output;
    }});
    await assert.rejects(f.model.updateState(ctx),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
    assert.deepEqual(f.calls.map(call=>call.stage),['turn_draft','turn_review','turn_draft_after_review','turn_review_after_review']);
    assert.deepEqual(value.state.patient_state.unknowns,draft().state.patient_state.unknowns);
  });
}

test('out-of-scope review output is rejected rather than stripped or treated as approval',async()=>{
  const value=draft();value.questions.skip=[];
  const f=fixture(value,{review:output=>({...output,questions:{audits:[]}})});
  await assert.rejects(f.model.updateState(context()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_schema'});
  assert.deepEqual(f.calls.map(call=>call.stage),['turn_draft','turn_review','turn_review','turn_review']);
  assert.equal(f.calls.some(call=>call.stage==='question_review'),false);
});

test('state re-review receives only current claims and sources while the repair writer keeps its exact rejected pair',async()=>{
  const initial=draft(),repaired=structuredClone(initial);
  const evidence=[{subject:'user_goal',question_id:'want',quote:want}];
  initial.state.relationship_memory.relationship=[{interpretation:'가능한 해석: 이용자는 상대의 이야기를 이미 듣는 지지 행동을 했다.',
    evidence,certainty:'tentative'}];
  initial.state.patient_state.unknowns=['상대의 현재 상태'];
  repaired.questions.skip=[];
  repaired.state.relationship_memory.relationship=[{interpretation:'가능한 해석: 이용자는 상대의 이야기를 듣고 싶다는 마음을 전하려 한다.',
    evidence,certainty:'tentative'}];
  repaired.state.patient_state.unknowns=['상대가 지금 이야기하기를 원하는지'];
  const ctx=context();ctx.patient.fields.mood={id:'mood',question:'요즘 보이는 모습',text:'잠을 잘 못 잔다고 말했어요.',
    rawText:'잠을 잘 못 잔다고 말했어요.',custom:'',status:'answered'};
  let firstState,firstDraft,firstReview;
  const f=fixture(call=>call.stage==='turn_draft'?initial:repaired,{review:(output,call)=>{
    if(call.stage==='question_review')return output;
    const current=call.data.review_target;
    if(call.stage==='turn_review') {
      firstState=structuredClone(current);
      output.state.approved=false;
      output.state.issues=[{reason:'의도를 실제 행동으로 바꿨습니다.',repair:'전하고 싶은 의도로만 기록하세요.'},
        {reason:'현재 상태에는 이미 보고된 수면 정보가 포함됩니다.',repair:'상대의 현재 상태(미확인)'}];
      for(const audit of output.state.audits)audit.verdict=call.data.review_target.claims.find(claim=>claim.id===audit.id).kind==='unresolved_information'?'already_answered':'unsupported';
    } else {
      output.state.audits.find(audit=>audit.id==='relationship.0').verdict='plausible';
    }
    return output;
  }});
  const complete=f.model.agentComplete.bind(f.model);
  f.model.agentComplete=async(...args)=>{
    const output=await complete(...args);
    if(args[0]==='turn_draft')firstDraft=structuredClone(output);
    if(args[0]==='turn_review')firstReview=output;
    return output;
  };
  const result=await f.model.updateState(ctx);
  assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(result.patient_state.unknowns,repaired.state.patient_state.unknowns);
  assert.deepEqual(result.relationship_memory.relationship,repaired.state.relationship_memory.relationship);
  assert.deepEqual(f.calls.map(call=>call.stage),['turn_draft','turn_review','question_review','turn_draft_after_review','turn_review_after_review']);
  for(const call of f.calls.filter(call=>call.stage.startsWith('turn_draft'))) {
    assert.match(call.prompt,/의도만 기록한 문장에 실제 행동이나 대상자의 동의를 덧붙이지 마세요/u);
    assert.match(call.prompt,/미확인.*꼬리표만 붙여.*수정으로 보지 마세요/u);
  }
  for(const call of f.calls.filter(call=>call.stage.startsWith('turn_review'))) {
    assert.match(call.prompt,/의도만을 서술한 주장에 실제 실행이나 대상자의 동의가 없다는 이유만으로 거절하지 마세요/u);
    assert.match(call.prompt,/실제 행동·대상자의 동의·현재 상태를 주장했다면 그 부분의 원문 근거가 필요/u);
    assert.match(call.prompt,/현재 review_target\.state와 review_target\.claims를 전체 최신 원문으로 독립적으로 검증/u);
    assert.match(call.prompt,/현재 남은 오류와 새로 생긴 실제 오류는 계속 거절/u);
    assert.doesNotMatch(call.prompt,/state\.revision|previous_review|before\/after/u);
    assert.deepEqual(Object.keys(call.data.review_target).sort(),['claims','input','reference_roles','state']);
  }
  assert.equal(firstState.revision,undefined);
  const current=f.calls.find(call=>call.stage==='turn_review_after_review').data.review_target;
  assert.equal(current.revision,undefined);
  assert.ok(!JSON.stringify(current).includes(initial.state.relationship_memory.relationship[0].interpretation));
  assert.ok(!JSON.stringify(current).includes('상대의 현재 상태(미확인)'));
  assert.deepEqual(current.input,firstState.input);
  assert.deepEqual(current.reference_roles,firstState.reference_roles);
  const writer=f.calls.find(call=>call.stage==='turn_draft_after_review');
  assert.deepEqual(writer.data.review,firstReview);
  assert.deepEqual(writer.data.rejected_draft,{...firstDraft,claims:firstState.claims});
  assert.equal(writer.data.review.state.approved,false);
  assert.equal(current.claims.find(claim=>claim.id==='relationship.0').claim,repaired.state.relationship_memory.relationship[0].interpretation);
  assert.equal(current.claims.find(claim=>claim.id==='patient_state.unknowns.0').claim,repaired.state.patient_state.unknowns[0]);
});

for(const kind of ['unsupported consent','already answered unknown'])test('current-only state review never approves a remaining '+kind,async()=>{
  const value=draft();value.questions.skip=[];
  value.state.patient_state.unknowns=[];
  const ctx=context();
  if(kind==='unsupported consent')value.state.relationship_memory.relationship=[{
    interpretation:'가능한 해석: 상대는 이야기를 듣는 데 이미 동의했다.',
    evidence:[{subject:'user_goal',question_id:'want',quote:want}],certainty:'tentative'}];
  else {
    ctx.patient.fields.mood={id:'mood',question:'요즘 보이는 모습',text:'잠을 잘 못 잔다고 말했어요.',
      rawText:'잠을 잘 못 잔다고 말했어요.',custom:'',status:'answered'};
    value.state.patient_state.unknowns=['상대의 현재 상태(미확인)'];
  }
  const f=fixture(value,{review:(output,call)=>{
    output.state.approved=false;
    output.state.issues=[{reason:'현재 주장에 원문과 다른 범위가 남았습니다.',repair:'원문에 맞는 범위로 수정하세요.'}];
    output.state.audits.forEach(audit=>{audit.verdict=call.data.review_target.claims.find(claim=>claim.id===audit.id).kind==='unresolved_information'?'already_answered':'unsupported';});
    return output;
  }});
  await assert.rejects(f.model.updateState(ctx),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
  assert.deepEqual(f.calls.map(call=>call.stage),['turn_draft','turn_review','turn_draft_after_review','turn_review_after_review']);
  const reviews=f.calls.filter(call=>call.stage.startsWith('turn_review'));
  assert.deepEqual(reviews[0].data.review_target,reviews[1].data.review_target);
  for(const {data}of reviews)assert.deepEqual(Object.keys(data.review_target).sort(),['claims','input','reference_roles','state']);
  const writer=f.calls.find(call=>call.stage==='turn_draft_after_review');
  assert.equal(writer.data.review.state.approved,false);
  assert.deepEqual(writer.data.rejected_draft.claims,reviews[0].data.review_target.claims);
});

test('tentative plausible claims and uncertain unknowns receive distinct review rules',async()=>{
  const value=draft();value.questions.skip=[];
  value.state.patient_state.unknowns=['상대가 지금 이야기하기를 원하는지'];
  value.state.relationship_memory.relationship=[{interpretation:'가능한 해석: 이용자는 상대의 이야기를 듣고 싶다는 마음을 전하려 한다.',
    evidence:[{subject:'user_goal',question_id:'want',quote:want}],certainty:'tentative'}];
  const accepted=fixture(value,{review:output=>{
    output.state.audits.find(audit=>audit.id==='relationship.0').verdict='plausible';return output;
  }});
  const result=await accepted.model.updateState(context());
  assert.equal(result.state_agent.reviewed,true);
  assert.deepEqual(result.relationship_memory.relationship,value.state.relationship_memory.relationship);
  const prompt=accepted.calls.at(-1).prompt;
  assert.match(prompt,/unknown 항목 중 already_answered, not_needed 또는 review_uncertain이 하나라도 있으면 state\.approved=false/u);
  assert.doesNotMatch(prompt,/(?<!unknown 항목 중 )unsupported 또는 plausible이 하나라도 있으면 state\.approved=false/u);
  assert.match(prompt,/tentative인 가설의 plausible 판정 자체는 오류나 거절 사유가 아닙니다/u);
  assert.match(prompt,/현재 주장에 실제 근거 오류나 중요한 정정 누락이 있으면 계속 거절/u);

  const rejected=fixture(value,{review:(output,call)=>{
    output.state.audits.forEach(audit=>{audit.verdict=call.data.review_target.claims.find(claim=>claim.id===audit.id).kind==='unresolved_information'?'review_uncertain':'plausible';});return output;
  }});
  await assert.rejects(rejected.model.updateState(context()),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_unknown_audit'});
  assert.deepEqual(rejected.calls.map(call=>call.stage),['turn_draft','turn_review','turn_review','turn_review']);
});

test('a reported claim keeps its selected excerpt scope while review still receives the other answers and correction rules',async()=>{
  const ctx=context(),value=draft();value.questions.skip=[];value.state.patient_state.unknowns=[];
  const relation='직장 동료라고 알려 줬어요.',mood='최근에 잠을 잘 못 잔다고 말했어요.';
  for(const [id,text] of [['rel',relation],['mood',mood]])
    ctx.patient.fields[id]={id,question:id,text,rawText:text,custom:'',status:'answered'};
  const evidence=[{subject:'patient',question_id:'rel',quote:relation}];
  value.state.relationship_memory.patient=[{evidence,certainty:'reported'}];
  const f=fixture(value),result=await f.model.updateState(ctx);
  assert.deepEqual(f.calls.map(call=>call.stage),['turn_draft','turn_review']);
  const review=f.calls[1],claim=review.data.review_target.claims.find(row=>row.id==='patient.0');
  assert.deepEqual(claim.evidence,evidence);assert.ok(claim.claim.includes(relation));
  assert.ok(!claim.claim.includes(mood));
  assert.ok(review.data.review_target.input.patient.find(row=>row.question_id==='mood').answers.some(answer=>answer.text===mood));
  assert.match(review.prompt,/각 audit는 현재 claim이 실제로 말하는 범위와 그 evidence를 판정/u);
  assert.match(review.prompt,/다른 답변이나 인용하지 않은 내용이 빠졌다는 이유만으로 해당 claim을 unsupported로 판정하지 마세요/u);
  assert.match(review.prompt,/발췌가 부정·조건·시점·화자·정정을 잘라 의미를 바꿨다면 계속 거절/u);
  assert.match(review.prompt,/claims가 비었거나 기존 claims가 모두 각 유형의 승인 기준을 충족해도 이 누락이 있으면 state\.approved=false/u);
  assert.deepEqual(result.relationship_memory.patient[0].evidence,evidence);
  assert.equal(result.state_agent.reviewed,true);
});

for(const repaired of [true,false])test('every part of an intention claim needs its own selected support: '+(repaired?'repaired citation':'persistent omission'),async()=>{
  const ctx=context(),initial=draft();initial.questions.skip=[];initial.state.patient_state.unknowns=[];
  const first='네가 편히 쉬면 좋겠다고 전하고 싶어요.',second='원한다면 상담을 함께 알아보자고 말하고 싶어요.';
  const source=first+' '+second;
  ctx.user_goal.message={id:'want',question:'전하고 싶은 말',text:source,rawText:source,custom:'',status:'answered'};
  const claim='가능한 해석: 이용자는 상대의 휴식을 바라며 상담을 함께 알아보자고 제안하려 한다.';
  initial.state.relationship_memory.relationship=[{interpretation:claim,certainty:'tentative',
    evidence:[{subject:'user_goal',question_id:'want',quote:first}]}];
  const updated=structuredClone(initial);
  if(repaired)updated.state.relationship_memory.relationship[0].evidence[0].quote=source;
  const f=fixture(call=>call.stage==='turn_draft'?initial:updated,{review:(output,call)=>{
    const current=call.data.review_target.claims.find(row=>row.id==='relationship.0');
    const complete=current.evidence.some(ref=>ref.quote.includes(second));
    output.state.audits.find(audit=>audit.id===current.id).verdict=complete?'plausible':'unsupported';
    if(!complete){output.state.approved=false;output.state.issues=[{
      reason:'선택한 evidence에는 상담을 제안하려는 의도가 없습니다.',repair:'상담 제안 의도를 뒷받침하는 원문 구절도 선택하세요.'}];}
    return output;
  }});
  if(repaired){
    const result=await f.model.updateState(ctx);
    assert.equal(result.state_agent.reviewed,true);
    assert.deepEqual(result.relationship_memory.relationship,updated.state.relationship_memory.relationship);
  }else await assert.rejects(f.model.updateState(ctx),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
  assert.deepEqual(f.calls.map(call=>call.stage),['turn_draft','turn_review','turn_draft_after_review','turn_review_after_review']);
  for(const call of f.calls.filter(call=>call.stage.startsWith('turn_draft'))){
    assert.match(call.prompt,/의도에 관한 가설도 문장에 쓴 모든 부분을 선택한 evidence가 뒷받침해야/u);
    assert.match(call.prompt,/전체 입력의 다른 곳에 그 내용이 있다는 사실만으로 선택한 인용의 부족을 대신할 수 없습니다/u);
    assert.match(call.prompt,/허용된 인용 후보에서 해당 구절도 선택하거나 주장 자체를 근거 범위로 좁히세요/u);
  }
  const reviews=f.calls.filter(call=>call.stage.startsWith('turn_review'));
  assert.deepEqual(reviews[0].data.review_target.input,reviews[1].data.review_target.input);
  for(const review of reviews){
    const current=review.data.review_target.claims.find(row=>row.id==='relationship.0');
    assert.equal(current.claim,claim);assert.equal(current.certainty,'tentative');
    assert.equal(review.data.review_target.input.user_goal[0].answers[0].text,source);
  }
  assert.deepEqual(reviews[0].data.review_target.claims.find(row=>row.id==='relationship.0').evidence,initial.state.relationship_memory.relationship[0].evidence);
  assert.deepEqual(reviews[1].data.review_target.claims.find(row=>row.id==='relationship.0').evidence,updated.state.relationship_memory.relationship[0].evidence);
  assert.equal(reviews[1].data.review_target.revision,undefined);
  const writer=f.calls.find(call=>call.stage==='turn_draft_after_review');
  assert.equal(writer.data.review.state.approved,false);
  assert.deepEqual(writer.data.rejected_draft.claims,reviews[0].data.review_target.claims);
});
