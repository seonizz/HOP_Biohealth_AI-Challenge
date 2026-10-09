import { HttpError } from './errors.js';

const invalid = () => { throw new HttpError(502, 'MODEL_INVALID_RESPONSE', '모델의 답변을 확인하지 못했어요. 다시 시도해 주세요.'); };

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid();
  return value;
}

function text(value, max = 8000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid();
}

function texts(value, maxItems = 12) {
  if (!Array.isArray(value) || value.length > maxItems) invalid();
  value.forEach(item => text(item, 2000));
}

export function contextGoal(context) {
  const goal = context?.user_goal?.message;
  return goal && goal.status === 'answered' && typeof goal.text === 'string' && goal.text.trim()
    ? goal.text : '확인되지 않음';
}

function sourceTexts(field) {
  const values = [field.rawText, field.text, field.custom];
  if (field.followUp?.answer) values.push(field.followUp.answer.rawText, field.followUp.answer.text, field.followUp.answer.custom);
  return values.filter(value => typeof value === 'string' && value.trim());
}

// Evidence is validated against current persisted answers, never against prior model memory.
export function validatePatientState(value, context) {
  const state = exactObject(value, ['summary', 'facts', 'unknowns', 'user_goal']);
  text(state.summary, 4000); texts(state.unknowns, 30); text(state.user_goal, 10000);
  if (state.user_goal !== contextGoal(context) || !Array.isArray(state.facts) || state.facts.length > 40) invalid();
  const evidenceAvailable = ['patient', 'supporter'].some(subject => Object.values(context?.[subject]?.fields || {})
    .some(field => ['answered', 'unknown'].includes(field.status) && sourceTexts(field).length));
  if (evidenceAvailable && !state.facts.length) invalid();
  for (const fact of state.facts) {
    exactObject(fact, ['subject', 'question_id', 'quote', 'interpretation', 'certainty']);
    if (!['patient', 'supporter'].includes(fact.subject) || !['reported', 'unknown'].includes(fact.certainty)) invalid();
    text(fact.question_id, 80); text(fact.quote, 10000); text(fact.interpretation, 2000);
    const fields = context?.[fact.subject]?.fields;
    if (!fields || !Object.hasOwn(fields, fact.question_id)) invalid();
    const field = fields[fact.question_id];
    if (!field || field.id !== fact.question_id || !['answered', 'unknown'].includes(field.status) ||
        !sourceTexts(field).some(source => source.includes(fact.quote))) invalid();
    // An explicitly unknown answer cannot become a confirmed finding.
    if (field.status === 'unknown' && fact.certainty !== 'unknown') invalid();
  }
  return structuredClone(state);
}

export function validateStateResult(value, context) {
  exactObject(value, ['patient_state', 'name_index', 'question_plan']);
  validatePatientState(value.patient_state, context);
  validateNameIndex(value.name_index, context);
  validateQuestionPlan(value.question_plan, context);
  return structuredClone(value);
}

export function nameSourceTexts(field) {
  return [field?.rawText, field?.followUp?.answer?.rawText, field?.followUp?.answer?.custom]
    .filter(value => typeof value === 'string' && value.trim());
}

export function validateNameIndex(value, context) {
  if (value === null) return null;
  exactObject(value, ['alias', 'source_question_id', 'quote']);
  text(value.alias, 20); text(value.quote, 10000);
  const name = context?.patient?.fields?.name;
  if (value.source_question_id !== 'name' || value.alias.trim() !== value.alias || /[\u0000-\u001f\u007f-\u009f]/u.test(value.alias) ||
      !name || name.id !== 'name' || name.status !== 'answered' ||
      !nameSourceTexts(name).some(source => source.includes(value.quote)) || !value.quote.includes(value.alias)) invalid();
  return structuredClone(value);
}

function evidenceField(context, evidence) {
  if (evidence.subject === 'user_goal') {
    if (evidence.question_id === 'want') return context?.user_goal?.message;
    if (evidence.question_id === 'goal') return context?.user_goal?.desired_outcomes;
    return undefined;
  }
  return context?.[evidence.subject]?.fields?.[evidence.question_id];
}

export function validateQuestionPlan(value, context) {
  exactObject(value, ['skip']);
  if (!Array.isArray(value.skip) || value.skip.length > 8) invalid();
  const candidates = new Map((context?.question_candidates || []).map(candidate => [candidate.id, candidate]));
  const seen = new Set();
  for (const skip of value.skip) {
    exactObject(skip, ['question_id', 'reason', 'explanation', 'evidence']);
    text(skip.question_id, 80); text(skip.explanation, 1000);
    const candidate = candidates.get(skip.question_id);
    if (!candidate || ['name', 'want', 'cause'].includes(skip.question_id) || seen.has(skip.question_id) ||
        !['already_covered', 'not_needed'].includes(skip.reason)) invalid();
    seen.add(skip.question_id);
    const current = evidenceField(context, { subject: candidate.subject, question_id: candidate.id });
    if (current && current.status !== 'not_asked') invalid();
    if (skip.reason === 'not_needed' && (candidate.required || candidate.noSkip ||
        !Number.isInteger(context?.answered_count) || context.answered_count < 5)) invalid();
    if (!Array.isArray(skip.evidence) || !skip.evidence.length || skip.evidence.length > 8) invalid();
    for (const evidence of skip.evidence) {
      exactObject(evidence, ['subject', 'question_id', 'quote']);
      if (!['patient', 'supporter', 'user_goal'].includes(evidence.subject)) invalid();
      text(evidence.question_id, 80); text(evidence.quote, 10000);
      const allowed = candidate.subject === 'patient' ? ['patient', 'user_goal'] : [candidate.subject];
      const source = evidenceField(context, evidence);
      if (!allowed.includes(evidence.subject) || !source || source.id !== evidence.question_id ||
          !['answered', 'unknown'].includes(source.status) ||
          (skip.reason === 'already_covered' && source.status !== 'answered') ||
          !sourceTexts(source).some(answer => answer.includes(evidence.quote))) invalid();
    }
  }
  return structuredClone(value);
}

export function validateAgentResult(value, context) {
  exactObject(value, ['guide', 'patient_state', 'assessment', 'name_index']);
  const guide = exactObject(value.guide, ['top', 'script', 'doList', 'avoid', 'next', 'care']);
  if (!['우울', '불안', '중독', '통합'].includes(guide.top)) invalid();
  text(guide.script); text(guide.next); texts(guide.doList); texts(guide.avoid);
  exactObject(guide.care, ['feel', 'tips']); text(guide.care.feel); texts(guide.care.tips);
  if (!guide.doList.length || !guide.avoid.length || !guide.care.tips.length) invalid();
  validatePatientState(value.patient_state, context);
  validateNameIndex(value.name_index, context);
  exactObject(value.assessment, ['safety']);
  if (typeof value.assessment.safety !== 'boolean') invalid();
  return structuredClone(value);
}
