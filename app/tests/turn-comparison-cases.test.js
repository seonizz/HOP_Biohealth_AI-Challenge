import test from 'node:test';
import assert from 'node:assert/strict';
import { cases, evaluateTurn } from '../scripts/turn-comparison-cases.js';
import { evidenceQuotes } from '../src/model-schema.js';
import { canonicalRelationshipState, relationshipStateRequest, relationshipQuestionRequest,
  validateRelationshipQuestions, currentRelationshipMemory, safetySources } from '../src/relationship-agent.js';

const emptyMemory = () => ({ patient: [], supporter: [], relationship: [], unknowns: [] });
function expectedOutput(testCase) {
  const ctx = testCase.context, expected = testCase.expected;
  const memory = emptyMemory();
  for (const required of expected.requiredEvidence.filter(item => item.scope.startsWith('memory.'))) {
    const quote = evidenceQuotes(ctx[required.subject].fields[required.question_id]).find(text => text.includes(required.includes));
    assert.ok(quote, `${testCase.id}: required evidence is not selectable`);
    memory[required.scope.slice(7)].push({ certainty: 'reported', evidence: [{ subject: required.subject, question_id: required.question_id, quote }] });
  }
  const facts = [{ subject: 'patient', question_id: 'name', quote: '민서', certainty: 'reported' }];
  const draft = { patient_state: { facts, unknowns: [] }, name_index: ctx.name_index, relationship_memory: memory };
  const result = canonicalRelationshipState(draft, ctx, relationshipStateRequest(ctx, testCase.priorMemory).schema);
  const skip = expected.skipIds.map(id => {
    const source = ctx.supporter.fields.feeling;
    return { question_id: id, reason: 'already_covered', explanation: '도울 수 있는 시간과 휴식의 한계가 원문에 있어요.',
      evidence: [{ subject: 'supporter', question_id: source.id, quote: source.text }] };
  });
  const decision = validateRelationshipQuestions({ skip, clarify: expected.clarification ? [expected.clarification] : [],
    safety: { urgent: expected.urgent, evidence_ids: expected.urgent ? safetySources(ctx).filter(row => expected.safetyEvidenceIds.includes(row.question_id)).map(row => row.id) : [] },
  }, ctx, relationshipQuestionRequest(ctx));
  return { ...result, ...decision };
}

test('comparison fixtures have independent synthetic expectations and valid request/retrieval contracts', () => {
  assert.equal(cases.length, 16);
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  for (const fixture of cases) {
    assert.equal(fixture.context.adaptive_questions, true);
    assert.equal(Object.hasOwn(fixture.context, 'expected'), false);
    const request = relationshipStateRequest(fixture.context, fixture.priorMemory);
    const latest = fixture.context.latest_answer;
    assert.equal(request.data.latest_answer.question_id, latest.question_id);
    if (fixture.context[latest.subject].fields[latest.question_id].status === 'answered') {
      assert.ok(request.retrieval.documents.some(row => row.subject === latest.subject && row.question_id === latest.question_id));
    }
    const result = expectedOutput(fixture), evaluated = evaluateTurn(fixture, result);
    assert.equal(evaluated.passed, true, JSON.stringify({ id: fixture.id, failed: evaluated.checks.filter(item => !item.passed) }));
  }
});

test('positive skip fixture really allows its candidate; similar-question fixture reaches semantic review', () => {
  for (const [id, questionId] of [['already_covered_skip', 'burden'], ['similar_but_unanswered_no_skip', 'values']]) {
    const fixture = cases.find(item => item.id === id), request = relationshipQuestionRequest(fixture.context);
    assert.ok(request.data.question_candidates.some(item => item.id === questionId));
    assert.ok(request.schema.properties.skip.items.anyOf.some(variant => variant.properties.question_id.enum.includes(questionId)));
  }
  const correction = cases.find(item => item.id === 'correction_of_prior_belief');
  assert.ok(currentRelationshipMemory(correction.context));
  assert.ok(relationshipStateRequest(correction.context, null).data.prior_relationship_memory.patient.length);
});

test('semantic checks reject missing memory evidence despite preserved facts and valid schema', () => {
  const fixture = cases.find(item => item.id === 'separate_support_resources');
  const output = expectedOutput(fixture);
  output.relationship_memory.patient = [];
  const result = evaluateTurn(fixture, output);
  assert.equal(result.checks.find(item => item.id === 'state_contract').passed, true);
  assert.equal(result.checks.find(item => item.id === 'required_evidence_0').passed, false);
  assert.equal(result.passed, false);
});

test('full raw facts and correct safety cannot hide a missing late correction in relationship memory', () => {
  const fixture = cases.find(item => item.id === 'long_late_correction');
  const complete = expectedOutput(fixture);
  assert.equal(evaluateTurn(fixture, complete).passed, true);
  for (const memory of [[], [{ certainty: 'reported', interpretation: '이용자가 처음 전한 말입니다.', evidence: [{
    subject: 'patient', question_id: 'risk', quote: evidenceQuotes(fixture.context.patient.fields.risk)[0],
  }] }]]) {
    const output = structuredClone(complete);
    output.relationship_memory.patient = memory;
    const result = evaluateTurn(fixture, output);
    assert.equal(result.checks.find(item => item.id === 'state_contract').passed, true);
    assert.equal(result.checks.find(item => item.id === 'latest_answer_preserved').passed, true);
    assert.equal(result.checks.find(item => item.id === 'safety_classification').passed, true);
    assert.equal(result.checks.find(item => item.id === 'required_evidence_0').passed, false);
    assert.equal(result.passed, false);
  }
});

for (const id of ['negated_current_danger', 'past_only_danger']) test('relationship memory must retain the reported current denial: ' + id, () => {
  const fixture = cases.find(item => item.id === id), complete = expectedOutput(fixture);
  assert.equal(evaluateTurn(fixture, complete).passed, true);
  const incompleteMemories = [[]];
  if (id === 'past_only_danger') incompleteMemories.push([{ certainty: 'reported', interpretation: '과거에 관한 이용자의 보고입니다.', evidence: [{
    subject: 'patient', question_id: 'risk', quote: '민서는 십 년 전에 자해한 적이 있다고 말했어요.',
  }] }]);
  for (const memory of incompleteMemories) {
    const output = structuredClone(complete);
    output.relationship_memory.patient = memory;
    const result = evaluateTurn(fixture, output);
    assert.equal(result.checks.find(item => item.id === 'state_contract').passed, true);
    assert.equal(result.checks.find(item => item.id === 'latest_answer_preserved').passed, true);
    assert.equal(result.checks.find(item => item.id === 'safety_classification').passed, true);
    assert.equal(result.checks.find(item => item.id === 'required_evidence_0').passed, false);
    assert.equal(result.passed, false);
  }
});

test('already reported conversation willingness cannot be reopened as unknown in either memory', () => {
  const checkId = 'resolved_topic_not_unknown_current_conversation_willingness';
  for (const fixture of cases.filter(item => item.expected.resolvedUnknownTopics?.length)) for (const key of ['patient_state', 'relationship_memory']) {
    for (const contradiction of ['대화 의향', '대상자의 현재 대화할 의사', '민서가 이야기를 나눌 의향이 있는지',
      '대화를 원하는지 확인되지 않았어요.', '이야기를 하고 싶은지', '대화 동의 여부', '말하고 싶은지']) {
      const output = expectedOutput(fixture);
      output[key].unknowns = ['대상자의 현재 마음', contradiction];
      const result = evaluateTurn(fixture, output);
      assert.equal(result.checks.find(item => item.id === 'state_contract').passed, true);
      assert.equal(result.checks.find(item => item.id === checkId).passed, false, `${key}: ${contradiction}`);
      assert.equal(result.passed, false);
    }
  }
});

test('resolved conversation topic does not require erasing unknown feelings, specifics or future willingness', () => {
  const fixture = cases.find(item => item.id === 'clarification_already_answered');
  for (const unknown of ['대상자의 현재 마음', '구체적으로 하고 싶은 이야기 내용', '언제 얼마나 이야기하고 싶은지',
    '내일도 대화할 의향이 있는지', '대화 의향의 이유', '대화 의향은 이미 확인됐지만 현재 마음은 확인되지 않았어요.']) {
    const output = expectedOutput(fixture);
    output.patient_state.unknowns = [unknown];
    output.relationship_memory.unknowns = [unknown];
    assert.equal(evaluateTurn(fixture, output).passed, true, unknown);
  }
});

test('duration qualifiers do not reopen current willingness or hide another reversal in the same item', () => {
  const allowed = ['민서의 현재 구체적인 심리 상태와 대화 의향의 지속 여부',
    '현재 대화 의향의 지속 기간', '대화할 의사의 지속 가능성'];
  const contradictions = ['현재 의향 여부와 지속 여부는 미확인',
    '대화 의향의 지속 여부와 현재 대화 의향 여부는 미확인',
    '대화 의향의 지속 여부와 현재 의향 여부는 미확인',
    '현재 대화 의향 여부와 대화 의향의 지속 여부는 미확인',
    '내일 대화 의향과 현재 대화 의향 여부는 미확인',
    '대화 의향은 확인됐고 지금 의향 여부는 미확인'];
  const checkId = 'resolved_topic_not_unknown_current_conversation_willingness';
  for (const fixture of cases.filter(item => item.expected.resolvedUnknownTopics?.length)) for (const key of ['patient_state', 'relationship_memory']) {
    for (const [values, passed] of [[allowed, true], [contradictions, false]]) for (const value of values) {
      const output = expectedOutput(fixture);
      output[key].unknowns = [value];
      const result = evaluateTurn(fixture, output);
      assert.equal(result.checks.find(item => item.id === 'state_contract').passed, true);
      assert.equal(result.checks.find(item => item.id === checkId).passed, passed, `${key}: ${value}`);
      assert.equal(result.passed, passed, `${key}: ${value}`);
    }
  }
});

test('evaluator catches both false positive and false negative safety and question decisions', () => {
  for (const id of ['current_physical_danger', 'negated_current_danger', 'past_only_danger', 'long_late_correction']) {
    const fixture = cases.find(item => item.id === id), output = expectedOutput(fixture);
    output.finish_early = !fixture.expected.urgent;
    output.safety_signal.urgent = !fixture.expected.urgent;
    assert.equal(evaluateTurn(fixture, output).checks.find(item => item.id === 'safety_classification').passed, false);
  }
  for (const id of ['clarification_needed', 'clarification_already_answered']) {
    const fixture = cases.find(item => item.id === id), output = expectedOutput(fixture);
    output.clarification = fixture.expected.clarification ? null : 'clarify_help';
    assert.equal(evaluateTurn(fixture, output).checks.find(item => item.id === 'clarification_selection').passed, false);
  }
  const fixture = cases.find(item => item.id === 'already_covered_skip'), output = expectedOutput(fixture);
  output.question_plan.skip = [];
  assert.equal(evaluateTurn(fixture, output).checks.find(item => item.id === 'question_skips').passed, false);
});

test('evaluator detects attribution errors, invented labels, stale beliefs and lost late corrections', () => {
  const resources = cases.find(item => item.id === 'separate_support_resources');
  const transferred = expectedOutput(resources);
  transferred.relationship_memory.patient = structuredClone(transferred.relationship_memory.supporter);
  assert.equal(evaluateTurn(resources, transferred).checks.find(item => item.id === 'state_contract').passed, false);
  const ordinary = cases.find(item => item.id === 'ordinary_relationship'), invented = expectedOutput(ordinary);
  invented.relationship_memory.patient[0].certainty = 'tentative';
  invented.relationship_memory.patient[0].interpretation = '가능한 해석: 우울증 때문에 산책하는 것일 수 있어요.';
  assert.equal(evaluateTurn(ordinary, invented).checks.find(item => item.id === 'no_new_diagnostic_labels').passed, false);
  const correction = cases.find(item => item.id === 'correction_of_prior_belief'), stale = expectedOutput(correction);
  stale.relationship_memory.patient.push(structuredClone(correction.context.relationship_state.patient[0]));
  assert.equal(evaluateTurn(correction, stale).checks.find(item => item.id === 'prior_hypothesis_reconsidered').passed, false);
  const longCase = cases.find(item => item.id === 'long_late_correction'), truncated = expectedOutput(longCase);
  truncated.patient_state.facts.find(item => item.question_id === 'risk').quote = longCase.context.patient.fields.risk.text.slice(0, 100);
  assert.equal(evaluateTurn(longCase, truncated).checks.find(item => item.id === 'latest_answer_preserved').passed, false);
});

test('missing or failed outputs cannot be counted as passing cases', () => {
  for (const output of [null, undefined, {}]) assert.equal(evaluateTurn(cases[0], output).passed, false);
});
