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
  exactObject(value, ['patient_state']);
  return validatePatientState(value.patient_state, context);
}

export function validateAgentResult(value, context) {
  exactObject(value, ['guide', 'patient_state', 'assessment']);
  const guide = exactObject(value.guide, ['top', 'script', 'doList', 'avoid', 'next', 'care']);
  if (!['우울', '불안', '중독', '통합'].includes(guide.top)) invalid();
  text(guide.script); text(guide.next); texts(guide.doList); texts(guide.avoid);
  exactObject(guide.care, ['feel', 'tips']); text(guide.care.feel); texts(guide.care.tips);
  if (!guide.doList.length || !guide.avoid.length || !guide.care.tips.length) invalid();
  validatePatientState(value.patient_state, context);
  exactObject(value.assessment, ['safety']);
  if (typeof value.assessment.safety !== 'boolean') invalid();
  return structuredClone(value);
}
