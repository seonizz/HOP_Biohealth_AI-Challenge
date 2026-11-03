import test from 'node:test';
import assert from 'node:assert/strict';
import {hasContinuationSources,focusedContextReviewRequest,validateContextPlanChange} from '../src/card-context-review.js';
import {validateSchema} from '../src/relationship-agent.js';
import {parseAvoidCardItem} from '../src/avoid-card-structure.js';

const source=(subject,text,question_id='continuation_0_0123456789abcdef')=>({subject,question_id,status:'answered',answers:[{text}]});
const answers=()=>({patient:[source('patient','민서가 내일 짧게 통화하자고 답했어요.')],
  supporter:[source('supporter','저는 내일 10분 정도 통화할 수 있어요.')],
  user_goal:[source('user_goal','부담 없이 안부를 묻고 싶어요.','want')],
  current_request:{kind:'request_not_evidence',text:'추가로 답할 말을 만들어 주세요.'},
  prior_relationship_memory:{summary:'파생 기억은 원문이 아닙니다.'}});
const guide=()=>({script:'민서야, 나는 내일 10분 정도 통화할 수 있어. 그 정도로 이야기하면 어떨까?',
  care:{feel:'상대를 챙기면서 자신의 여유도 살피고 있네요.',tips:['답을 기다리는 동안 잠깐 쉬어 보세요.']},
  doList:['내일 10분 정도 가능하다고 먼저 말해 보세요.'],
  avoid:['피할 말·행동: 무조건 다 들어줄게. 이유: 자신의 가능 시간을 넘어서는 약속은 부담이 될 수 있어요. 대신: 내일 10분 정도 통화할 수 있어.'],
  next:'내일 통화할 때는 “오늘 어땠어?”라고 가볍게 물어보세요.\n\n답이 없으면 다음에 이야기하자고 제안해 보세요.'});
function fixture() {
  const input={answers:answers(),guide:guide(),validateSchema};
  const request=focusedContextReviewRequest(input);
  const output=()=>({source_events:request.payload.sources.filter(s=>request.payload.required_source_ids.includes(s.id)).map(s=>({
    source_id:s.id,quote:s.text,actor:s.subject,action:'짧게 통화',action_time:'내일',status:s.subject==='patient'?'proposal':'availability'})),
    checks:request.payload.units.map(u=>({id:u.id,utterance_frame:['direct_speech','alternative'].includes(u.role)?'current_reply':'not_speech',
      candidate_quote:u.text,candidate_action_time:'내일',source_action_time:'내일',
      source_ids:[request.payload.sources[1].id],relation:'same',statement:'proposal',comparison:'보고된 가능 시간으로 앞으로 합의를 구하며 확정된 약속을 주장하지 않습니다.',verdict:'consistent',repair:null}))});
  return {input,request,output};
}
const reject=(output,id)=>{
  const check=output.checks.find(c=>c.id===id);
  Object.assign(check,{verdict:'unsupported',relation:'not_stated',statement:'reported_fact',
    comparison:'원문의 내일 가능 시간을 현재의 여유 또는 이미 합의한 약속으로 단정했습니다.',repair:null});
  return check;
};

test('only actual reviewed continuation rows activate the focused review',()=>{
  assert.equal(hasContinuationSources(answers()),true);
  for(const value of [null,{}, {patient:[{...source('patient','text'),question_id:'mood'}]},
    {patient:[{...source('patient','text'),subject:'supporter'}]},
    {patient:[{...source('patient','text'),status:'skipped'}]},
    {patient:[{...source('patient','text'),answers:[]}]},
    {patient:[source('patient','continuation_0_0123456789abcdef','name')]},
    {patient:[source('patient','text','continuation_safety_0')]}]) {
    assert.equal(hasContinuationSources(value),false);
    assert.equal(focusedContextReviewRequest({answers:value,guide:{}}),null);
  }
});

test('raw sources exclude derived memory, requests and unanswered rows without mutating inputs',()=>{
  const input={answers:answers(),guide:guide(),validateSchema};
  input.answers.patient.push({...source('patient','생략된 내용','skipped'),status:'skipped'});
  const before=structuredClone({answers:input.answers,guide:input.guide});
  const request=focusedContextReviewRequest(input);
  assert.deepEqual(request.payload.sources.map(s=>s.text),[
    '민서가 내일 짧게 통화하자고 답했어요.','저는 내일 10분 정도 통화할 수 있어요.','부담 없이 안부를 묻고 싶어요.']);
  assert.deepEqual(Object.keys(request.payload).sort(),['required_source_ids','sources','units']);
  assert.equal(request.payload.sources.some(s=>s.subject==='current_request'),false);
  assert.equal('prior_relationship_memory' in request.payload,false);
  assert.equal('current_request' in request.payload,false);
  assert.equal('guide' in request.payload,false);
  request.payload.units[0].text='별도 복사본';request.payload.sources[0].text='별도 복사본';
  assert.deepEqual({answers:input.answers,guide:input.guide},before);
});

test('units preserve every card part and keep forbidden examples outside audit targets',()=>{
  const {input,request}=fixture(),units=request.payload.units;
  assert.deepEqual(units.map(u=>u.id),['script.0','care.feel','care.tips.0','doList.0','avoid.0.reason','avoid.0.alternative','next.0','next.1']);
  const avoid=units.filter(u=>u.field==='avoid');
  assert.deepEqual(avoid.map(u=>u.role),['reason','alternative']);
  assert.ok(avoid.every(u=>u.bad_example==='무조건 다 들어줄게.'));
  assert.equal(avoid[1].text,'내일 10분 정도 통화할 수 있어.');
  assert.equal(units.filter(u=>u.field==='next').map(u=>u.text).join('\n\n'),input.guide.next);
  const long='확인된 범위에서 다음 대화를 제안하세요. '.repeat(80);
  input.guide.next=long;
  const next=focusedContextReviewRequest(input).payload.units.filter(u=>u.field==='next');
  assert.equal(next.length,1);assert.equal(next[0].text,long);
});

test('avoid parsing is non-destructive and malformed or duplicated bundles cannot bypass structural validation',()=>{
  const text='피할 말·행동:  그만 얘기해. 이유: 상대가 부담스러울 수 있어요. 대신  괜찮을 때 말해 줘.';
  assert.deepEqual(parseAvoidCardItem(text),{avoid_phrase:'그만 얘기해.',reason:'상대가 부담스러울 수 있어요.',alternative:'괜찮을 때 말해 줘.'});
  for(const items of [['라벨이 없는 미완성 대안'],['피할 말·행동: 중복 이유: 중복 대신: 다른 말'],[guide().avoid[0],guide().avoid[0]]]) {
    const input={answers:answers(),guide:{...guide(),avoid:items},validateSchema};
    assert.throws(()=>focusedContextReviewRequest(input),{modelReason:'agent_avoid_structure'});
  }
});

test('positive review produces a transient approval and preserves wire output',()=>{
  const {request,output}=fixture(),wire=output(),before=structuredClone(wire);
  assert.deepEqual(request.validate(wire),{approved:true,issues:[],context_feedback:[]});
  assert.deepEqual(wire,before);
});

test('utterance frame is required before timing and never grants an automatic guidance exemption',()=>{
  const {request,output}=fixture(),schema=request.schema.properties.checks.items;
  assert.deepEqual(Object.keys(schema.properties).slice(0,3),['id','utterance_frame','candidate_quote']);
  assert.ok(schema.required.includes('utterance_frame'));
  for(const mutate of [v=>delete v.checks[0].utterance_frame,v=>v.checks[0].utterance_frame='assumed_future']) {
    const wire=output();mutate(wire);
    assert.throws(()=>request.validate(wire),error=>{
      assert.equal(error.modelReason,'agent_context_audit');
      return true;
    });
  }
  const wire=output(),check=reject(wire,'care.tips.0');
  check.utterance_frame='not_speech';
  const result=request.validate(wire);
  assert.equal(result.approved,false);assert.equal(result.context_feedback[0].utterance_frame,'not_speech');
  assert.equal(result.issues[0].field,'care');
  assert.match(request.prompt,/각 unit은 독립된 문맥/u);
  assert.match(request.prompt,/안내 문장 안에 인용된 실제 권고 대사/u);
  assert.doesNotMatch(request.prompt,/current_request|전체 guide/u);
});

test('each semantic rejection becomes a normal field issue with full feedback and default repair',()=>{
  const {request,output}=fixture(),wire=output();
  const rejected=reject(wire,'avoid.0.alternative');
  reject(wire,'avoid.0.reason').verdict='conflict';
  const before=structuredClone(wire),result=request.validate(wire);
  assert.equal(result.approved,false);assert.equal(result.issues.length,2);
  assert.ok(result.issues.every(i=>i.field==='avoid'));
  assert.equal(result.context_feedback[1].candidate_quote,rejected.candidate_quote);
  assert.equal(result.context_feedback[1].verdict,'unsupported');
  assert.match(result.context_feedback[1].repair,/실제 원문과 다시 대조/u);
  assert.deepEqual(wire,before);
});

test('all unit ids must appear exactly once and quotes must come from that unit',()=>{
  const {request,output}=fixture();
  for(const mutate of [v=>v.checks.pop(),v=>v.checks[1]=structuredClone(v.checks[0]),
    v=>v.checks[0].id='unknown',v=>v.checks[0].candidate_quote='원문에 없는 문장',
    v=>v.checks[0].candidate_quote=v.checks[1].candidate_quote,
    v=>v.checks[0].candidate_quote=' ',v=>v.checks[0].verdict='approved']) {
    const wire=output();mutate(wire);assert.throws(()=>request.validate(wire),{code:'MODEL_INVALID_RESPONSE'});
  }
});

test('source events must cover every continuation component using actual source quotes and references',()=>{
  const {request,output}=fixture();
  for(const mutate of [v=>v.source_events.pop(),v=>v.source_events[1]=structuredClone(v.source_events[0]),
    v=>v.source_events[0].source_id='unknown',v=>v.source_events[0].quote='원문에 없는 인용',
    v=>v.source_events[0].quote=v.source_events[1].quote,v=>v.checks[0].source_ids=['unknown'],
    v=>v.checks[0].source_ids=[v.source_events[0].source_id,v.source_events[0].source_id]]) {
    const wire=output();mutate(wire);assert.throws(()=>request.validate(wire),{code:'MODEL_INVALID_RESPONSE'});
  }
  const input={answers:answers(),guide:guide(),validateSchema};
  input.answers.supporter[0].answers.push({text:'아직 통화 시간을 함께 정하지는 않았어요.'});
  assert.equal(focusedContextReviewRequest(input).payload.required_source_ids.length,3);
});

test('exact partial quotes are accepted and absent evidence may support an unsupported rejection',()=>{
  const {request,output}=fixture(),wire=output();
  wire.source_events[0].quote='내일 짧게 통화하자고';
  wire.checks[0].candidate_quote='나는 내일 10분 정도 통화할 수 있어.';
  const check=reject(wire,'script.0');check.source_ids=[];
  assert.equal(request.validate(wire).approved,false);
});

test('context validation failures identify the exact repair path without exposing source or candidate text',()=>{
  const {request,output}=fixture();
  const cases=[
    [v=>v.source_events[0].quote='비공개 인용 불일치', 'output.source_events[0].quote','source_quote_mismatch'],
    [v=>v.source_events[1]=structuredClone(v.source_events[0]), 'output.source_events','missing_required_sources'],
    [v=>v.checks[0].candidate_quote='비공개 후보 불일치','output.checks[0].candidate_quote','unit_quote_mismatch'],
    [v=>v.checks[1]=structuredClone(v.checks[0]),'output.checks[1].id','duplicate_unit_id'],
    [v=>v.checks[0].source_ids.push(v.checks[0].source_ids[0]),'output.checks[0].source_ids','duplicate_source_reference'],
  ];
  for(const [mutate,path,reason] of cases) {
    const wire=output();mutate(wire);
    assert.throws(()=>request.validate(wire),error=>{
      assert.equal(error.modelReason,'agent_context_audit');
      const feedback=JSON.parse(error.modelFeedback);
      assert.equal(feedback.path,path);assert.equal(feedback.reason,reason);
      assert.ok(feedback.repair.length>10);
      if(reason==='missing_required_sources')assert.deepEqual(feedback.missing_required_source_indices,[1]);
      assert.ok(!error.modelFeedback.includes('비공개'));
      for(const source of request.payload.sources)assert.ok(!error.modelFeedback.includes(source.text));
      for(const unit of request.payload.units)assert.ok(!error.modelFeedback.includes(unit.text));
      return true;
    });
  }
});

test('schema failures retain their precise paths and gain a bounded format-only repair instruction',()=>{
  const {request,output}=fixture();
  for(const [mutate,path] of [
    [v=>v.checks.pop(),'output.checks'],
    [v=>v.checks[0].source_ids=['비공개 없는 식별자'],'output.checks[0].source_ids[0]'],
    [v=>v.source_events[0].source_id='비공개 없는 식별자','output.source_events[0].source_id'],
  ]) {
    const wire=output();mutate(wire);
    assert.throws(()=>request.validate(wire),error=>{
      assert.equal(error.modelReason,'agent_context_audit');
      const feedback=JSON.parse(error.modelFeedback);
      assert.equal(feedback.path,path);assert.ok(feedback.keyword);
      assert.match(feedback.repair,/기존의 의미 판정/u);
      assert.ok(!error.modelFeedback.includes('비공개'));
      return true;
    });
  }
});

test('explicit agreement, topic time and conditional-future approvals are preserved without server keyword verdicts',()=>{
  const {request,output}=fixture(),wire=output();
  const next=wire.checks.find(c=>c.id==='next.0');
  Object.assign(next,{utterance_frame:'future_scene',statement:'conditional_future',comparison:'내일 통화 장면에서 오늘 하루를 주제로 물으므로 행동 시점을 바꾸지 않습니다.'});
  const later=wire.checks.find(c=>c.id==='next.1');
  Object.assign(later,{statement:'conditional_future',relation:'not_applicable',source_ids:[],comparison:'답이 없을 경우의 미래 대응이며 실제 합의를 주장하지 않습니다.'});
  assert.equal(request.validate(wire).approved,true);
  const input={answers:answers(),guide:guide(),validateSchema};
  input.answers.supporter[0].answers[0].text='둘이 내일 10분 동안 통화하기로 합의했어요.';
  const explicit=focusedContextReviewRequest(input);
  wire.source_events[1].quote=input.answers.supporter[0].answers[0].text;
  wire.source_events[1].actor='both';wire.source_events[1].status='agreement';
  assert.equal(explicit.validate(wire).approved,true);
  assert.match(request.prompt,/전체적으로 적절한지/u);
  assert.match(request.prompt,/명시적인 상호 합의 보고/u);
  assert.match(request.prompt,/대화 주제의 시점/u);
});

test('a rejected plan must actually change each named field, not merely unrelated fields or key order',()=>{
  const before={voice:'친구',patient_choice:'지금 통화할까?',next_step:'지금 전화하기',opening_evidence:[{quote:'내일 가능',subject:'supporter'}]};
  const review={issues:[{field:'patient_choice'},{field:'next_step'}]};
  for(const plan of [structuredClone(before),{...before,voice:'친근한 말투'}, {...before,patient_choice:'내일 통화할까?'}]) {
    assert.throws(()=>validateContextPlanChange(plan,before,review),{modelReason:'agent_plan_review_rejected'});
  }
  const fixed={...before,patient_choice:'내일 통화할까?',next_step:'내일 시간을 제안하기'};
  assert.equal(validateContextPlanChange(fixed,before,review),fixed);
  assert.throws(()=>validateContextPlanChange({...before,opening_evidence:[{subject:'supporter',quote:'내일 가능'}]},before,
    {issues:[{field:'opening_evidence'}]}),{modelReason:'agent_plan_review_rejected'});
});
