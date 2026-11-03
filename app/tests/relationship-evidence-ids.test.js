import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelGateway} from '../src/model.js';
import {scopeContext,scopeDraft,scopeProbe} from './helpers/turn-input-optimization-fixture.js';

function sharedSourceDraft() {
  const ctx=scopeContext(),value=scopeDraft(ctx),evidence=structuredClone(value.state.relationship_memory.patient[0].evidence);
  value.state.relationship_memory.patient.push({certainty:'tentative',
    interpretation:'가능한 해석: 대화할 수 있는 시간의 범위를 확인할 필요가 있을 수 있어요.',evidence});
  value.state.relationship_memory.relationship.push({certainty:'tentative',
    interpretation:'가능한 해석: 원하는 도움의 범위를 함께 확인할 필요가 있을 수 있어요.',evidence:structuredClone(evidence)});
  return {ctx,value,evidence};
}

function assertSharedIds(call,source) {
  const paths=['patient.items.anyOf[0]','patient.items.anyOf[1]','relationship.items'];
  const ids=paths.map(path=>{
    const table=call.evidence_sources.find(row=>row.schema_path===`output_schema.properties.${path}.properties.evidence.items`);
    assert.ok(table,'Missing original evidence pool '+path);
    const entry=table.sources.find(row=>row.evidence.subject===source.subject&&
      row.evidence.question_id===source.question_id&&row.evidence.quote===source.quote);
    assert.ok(entry,'Shared synthetic source must be eligible in '+path);return entry.id;
  });
  assert.match(ids[0],/^source_\d+$/u);assert.deepEqual(ids,[ids[0],ids[0],ids[0]]);
}

test('canonical IDs decode to exact original sources before independent state review and final state output',async()=>{
  const {ctx,value,evidence}=sharedSourceDraft(),before=structuredClone({ctx,value});
  const probe=scopeProbe(ModelGateway,{ctx,value});
  const result=await probe.run(),memory=probe.calls.find(call=>call.stage==='turn_draft_block_relationship_memory');
  assertSharedIds(memory,evidence[0]);
  const review=probe.calls.find(call=>call.stage==='turn_review');assert.ok(review);
  for(const id of ['patient.0','patient.1','relationship.0']){
    const claim=review.data.review_target.claims.find(row=>row.id===id);assert.ok(claim);
    assert.deepEqual(claim.evidence,evidence);
  }
  assert.equal(review.data.review_target.claims.find(row=>row.id==='patient.1').claim,value.state.relationship_memory.patient[1].interpretation);
  for(const row of [...result.relationship_memory.patient,...result.relationship_memory.relationship])assert.deepEqual(row.evidence,evidence);
  assert.ok(result.state_agent.reviewed);assert.deepEqual({ctx,value},before);
  assert.deepEqual({ctx:probe.ctx,value:probe.value},before);
});

test('valid shared IDs do not override independent rejection of an interpretation',async()=>{
  const {ctx,value,evidence}=sharedSourceDraft(),before=structuredClone({ctx,value});
  const probe=scopeProbe(ModelGateway,{ctx,value,response(call,output){
    if(!/^turn_review(?:_after_review)?$/u.test(call.stage))return;
    const claim=call.data.review_target.claims.find(row=>row.id==='patient.1');
    assert.deepEqual(claim.evidence,evidence);assert.equal(claim.claim,value.state.relationship_memory.patient[1].interpretation);
    output.state.approved=false;
    output.state.issues=[{reason:'합성 해석의 시간 범위가 원문 근거에 없습니다.',repair:'원문이 뒷받침하는 범위로 해석을 수정하세요.'}];
    output.state.audits.find(row=>row.id===claim.id).verdict='unsupported';
    return output;
  }});
  await assert.rejects(probe.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'state_review_rejected'});
  const reviews=probe.calls.filter(call=>/^turn_review(?:_after_review)?$/u.test(call.stage));
  assert.deepEqual(reviews.map(call=>call.stage),['turn_review','turn_review_after_review']);
  const memories=probe.calls.filter(call=>/^turn_draft_block_relationship_memory(?:_after_review)?$/u.test(call.stage));
  assert.equal(memories.length,2);for(const call of memories)assertSharedIds(call,evidence[0]);
  assert.deepEqual({ctx,value},before);assert.deepEqual({ctx:probe.ctx,value:probe.value},before);
});

test('valid shared IDs retain original label validation before any independent review',async()=>{
  const {ctx,value}=sharedSourceDraft();
  value.state.relationship_memory.patient[1].interpretation='가능한 해석: 수면장애가 있을 수 있어요.';
  const probe=scopeProbe(ModelGateway,{ctx,value});
  await assert.rejects(probe.run(),{code:'MODEL_INVALID_RESPONSE',modelReason:'agent_unreported_label'});
  const memory=probe.calls.find(call=>call.stage==='turn_draft_block_relationship_memory');
  assertSharedIds(memory,value.state.relationship_memory.patient[0].evidence[0]);
  assert.equal(probe.calls.some(call=>call.stage.includes('review')&&!call.stage.startsWith('turn_draft')),false);
});
