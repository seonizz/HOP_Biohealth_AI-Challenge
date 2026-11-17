import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {scopeProbe,scopeContext,scopeDraft} from './helpers/turn-input-optimization-fixture.js';

function fixture(options={}) {
  const ctx=scopeContext(),value=scopeDraft(ctx);
  const ref={subject:'supporter',question_id:'feeling',quote:ctx.supporter.fields.feeling.rawText};
  value.state.patient_state.facts.push({...ref,certainty:'reported'});
  value.state.relationship_memory.supporter=[{certainty:'reported',evidence:[ref]}];
  return scopeProbe(ModelGateway,{ctx,value,...options});
}

test('state review receives correctly attributed facts from both people and the explicit shared-list contract',async()=>{
  const f=fixture(),result=await f.run();
  assert.equal(result.state_agent.reviewed,true);
  const review=f.calls.find(call=>call.stage==='turn_review');
  assert.match(review.prompt,/patient_state\.facts는 patient와 supporter 양쪽 원문을 subject로 구분/);
  assert.match(review.prompt,/다른 사람으로 귀속을 바꾸거나 원문·부정·정정·확실성을 왜곡한 내용은 계속 거절/);
  for(const subject of ['patient','supporter']){
    const fact=review.data.review_target.state.patient_state.facts.find(row=>row.subject===subject);
    assert.ok(fact);
    assert.equal(fact.quote,f.ctx[subject].fields[fact.question_id].rawText);
  }
});

test('allowing both fact subjects never accepts a quote attributed to the other person',async()=>{
  const ctx=scopeContext(),value=scopeDraft(ctx);
  value.state.patient_state.facts=[{subject:'patient',question_id:'feeling',quote:ctx.supporter.fields.feeling.rawText,certainty:'reported'}];
  const f=scopeProbe(ModelGateway,{ctx,value});
  await assert.rejects(f.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.equal(f.calls.some(call=>call.stage==='turn_review'),false);
});

test('the fact-subject contract cannot override an independent semantic rejection',async()=>{
  const f=fixture({rejectAlways:true});
  await assert.rejects(f.run(),{code:'MODEL_INVALID_RESPONSE'});
  assert.ok(f.calls.some(call=>call.stage==='turn_review'));
  assert.ok(f.calls.some(call=>call.stage==='turn_draft_block_patient_state_after_review'));
});

test('overlapping source ranges retain original evidence and independent review',async()=>{
  const ctx=scopeContext();
  ctx.patient.fields.mood.rawText=ctx.patient.fields.mood.text='밤에 계획표를 고쳐요. 지금 해칠 생각은 없다고 말했어요.';
  const value=scopeDraft(ctx);
  const first=value.state.relationship_memory.patient[0].evidence[0];
  value.state.relationship_memory.patient[0].evidence.push({...first,quote:'지금 해칠 생각은 없다고 말했어요.'});
  const f=scopeProbe(ModelGateway,{ctx,value});
  const result=await f.run();assert.equal(result.state_agent.reviewed,true);
  const review=f.calls.find(call=>call.stage==='turn_review');
  assert.match(review.prompt,/인용 범위가 겹친다는 형식만으로 상태를 거절하지 마세요/);
  assert.match(review.prompt,/근거 없는 주장·정정 누락은 계속 거절/);
  const evidence=review.data.review_target.claims.find(row=>row.id==='patient.0').evidence;
  assert.ok(evidence.some(ref=>ref.quote===first.quote));
  assert.ok(evidence.some(ref=>ref.quote==='지금 해칠 생각은 없다고 말했어요.'));
  const rejected=scopeProbe(ModelGateway,{ctx,value,rejectAlways:true});
  await assert.rejects(rejected.run(),{code:'MODEL_INVALID_RESPONSE'});
});
