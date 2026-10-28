import test from 'node:test';
import assert from 'node:assert/strict';
import { cases } from '../scripts/turn-comparison-cases.js';
import { canonicalPatientState, relationshipStateRequest, relationshipQuestionRequest,
  runRelationshipAgent } from '../src/relationship-agent.js';

// Reuse the fixed synthetic benchmark input without changing its source or expectations.
const sourceFixture=cases.find(item=>item.id==='long_late_correction');
const originalFixture=JSON.stringify(sourceFixture);
const denial='지금 자신이나 다른 사람을 해칠 생각이나 행동은 전혀 없다고 확인했어요.';

function retainedContext() {
  const context=structuredClone(sourceFixture.context),raw=context.patient.fields.risk.rawText;
  assert.ok(raw.includes('연극 대사였고 실제 사건이 아니에요.'));
  assert.ok(raw.includes(denial));
  const reference={subject:'patient',question_id:'risk',quote:denial};
  context.relationship_state={patient:[{certainty:'reported',evidence:[reference],
    interpretation:'이용자가 현재 위험을 부정하는 답변을 보고했어요.'}],supporter:[],relationship:[],unknowns:[]};
  context.agent_state=canonicalPatientState({summary:'합성 원문 보고',
    facts:[{...reference,quote:raw,certainty:'reported',interpretation:'합성 원문 보고'}],
    unknowns:[],user_goal:'확인되지 않음'},context);
  return {context,raw,reference};
}

function assertFullSource(data,retrieval,{context,raw,reference}) {
  const source=data.patient.find(row=>row.question_id==='risk');
  assert.equal(source.subject,'patient');
  assert.equal(source.status,'answered');
  assert.ok(source.answers.some(answer=>answer.origin==='answer_snapshot'&&answer.text===raw),
    'The complete answer, including the late fictional-event correction, must remain model input.');
  assert.ok(retrieval.documents.some(document=>document.subject==='patient'&&
    document.question_id==='risk'&&document.text===raw),
  'Retrieval must preserve the complete cited source, not only the short memory excerpt.');
  assert.deepEqual(data.prior_relationship_memory.patient[0].evidence,[reference]);
  assert.notEqual(reference.quote,raw);
  assert.equal(context.agent_state.facts[0].quote,raw);
}

for(const [label,request] of [
  ['next state',context=>relationshipStateRequest(context,context.agent_state)],
  ['next question',context=>relationshipQuestionRequest(context)],
]) test(label+' receives the full correction when relationship memory contains only the current denial',()=>{
  const fixture=retainedContext(),before=JSON.stringify(fixture.context);
  const result=request(fixture.context);
  assertFullSource(result.data,result.retrieval,fixture);
  assert.equal(JSON.stringify(fixture.context),before);
  assert.equal(JSON.stringify(sourceFixture),originalFixture);
});

test('final analysis and independent review receive the full correction alongside abbreviated memory',async()=>{
  const fixture=retainedContext(),{context,reference}=fixture,before=JSON.stringify(context);
  const captured=[],stop=new Error('source capture complete');
  const gateway={async agentComplete(stage,prompt,data,schema,operation,validate) {
    const answers=stage==='relationship_analysis'?data:data.answers;
    assertFullSource(answers,data.retrieval,fixture);
    captured.push(stage);
    // Capture the actual review input without running the unrelated guide pipeline.
    if(stage==='analysis_review') throw stop;
    assert.equal(stage,'relationship_analysis');
    return validate({observations:{patient:[reference],supporter:[]},
      relationship:{label:'확인되지 않음',supporter_role:'확인되지 않음',dynamics:[],strengths:[],boundaries:[]},
      unknowns:[],safety:{urgent:false,evidence_ids:[]}});
  }};
  await assert.rejects(runRelationshipAgent(gateway,context,context.agent_state,context.name_index,{}),
    error=>error===stop);
  assert.deepEqual(captured,['relationship_analysis','analysis_review']);
  assert.equal(JSON.stringify(context),before);
  assert.equal(JSON.stringify(sourceFixture),originalFixture);
});
