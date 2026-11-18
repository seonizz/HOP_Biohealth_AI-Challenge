import { HttpError } from './errors.js';
import { renderQuestion } from './catalog.js';
import { issueV3, v3FieldStatus } from './intake-v3.js';

export const hasPersonalization = state => state.v3?.personalization?.version === 1;
export const personalQuestions = state => Object.values(state.v3?.personalization?.questions || {});
export const maximumQuestions = state => hasPersonalization(state) ? 12 : 10;

export function renderIntakeQuestion(question, state) {
  const rendered = renderQuestion(question, state);
  const presentation = state.v3?.personalization?.presentations?.[question.id];
  // Model/user text is literal data, never a catalog substitution template.
  if (question.personalized) rendered.q = question.q;
  else if (presentation && presentation.status !== 'obsolete') rendered.q = presentation.text;
  return rendered;
}

export function personalizationContext(state) {
  if (!hasPersonalization(state)) return {};
  const personal = state.v3.personalization;
  return { personalization:{ version:1,
    available:!state.v3.stopped && !state.v3.helpReplay && !state.pendingFollow && !state.safetySignal?.urgent && !state.safetyReviewPending?.urgent,
    remaining_follow_ups:Math.max(0, 2 - personalQuestions(state).length),
    history:[...Object.entries(personal.presentations).map(([id, item]) => ({ id, ...item.decision, status:item.status })),
      ...personalQuestions(state).map(item => ({ id:item.question.id, ...item.decision, status:item.status }))],
  } };
}

export function createPersonalQuestion(state, decision, {includeQuote = true} = {}) {
  const personal = state.v3.personalization;
  if (decision.kind === 'next') {
    const question = state.questionSet.questions.find(item => item.id === decision.question_id);
    const text = renderQuestion(question, state).q;
    personal.presentations[question.id] = { decision:structuredClone(decision), status:'issued',
      text:includeQuote ? `“${decision.quote}”라고 말씀하신 내용과 관련해 여쭤볼게요.\n${text}` : text };
    state.i = state.questionSet.questions.indexOf(question);
    return question;
  }
  const id = `q3_personal_0${personalQuestions(state).length + 1}`;
  const question = { id, subject:decision.subject, type:'text', sec:'조금 더 들려주세요', face:'ponder',
    q:decision.question, help:'기억나는 말이나 행동을 아는 범위에서 들려주세요. 모르거나 답하기 어려우면 건너뛰어도 괜찮아요.',
    ph:'아는 범위에서 편하게 적어 주세요.', response_controls:true, follow_up:true, personalized:true };
  question.instance_id = issueV3(state, question).instance_id;
  personal.questions[id] = { question, decision:structuredClone(decision), status:'issued', goal_epoch:state.v3.goal_epoch };
  return question;
}

function currentSource(state, decision) {
  const answer = state.ans[decision.source_question_id] || state.clarificationAnswers?.[decision.source_question_id];
  if (!answer || v3FieldStatus(answer) !== 'answered' || answer.response_event === 'unknown' ||
      answer.ordinary_usable === false || answer.source_revision !== decision.source_revision) return false;
  const points = Array.from(answer[decision.component] || '');
  return points.slice(decision.quote_start, decision.quote_end).join('') === decision.quote;
}

export function answerPersonalQuestion(state, question, answer) {
  const entry = state.v3.personalization.questions[question.id];
  if (!entry || !['issued','answered','unknown','skipped','refused','not_understood'].includes(entry.status) ||
      entry.goal_epoch !== state.v3.goal_epoch || !currentSource(state, entry.decision)) {
    throw new HttpError(409, 'STALE_PERSONALIZED_QUESTION', '원문이 바뀌었어요. 현재 질문을 다시 확인해 주세요.');
  }
  entry.status = answer.response_event;
  return { ...answer, personalization:structuredClone(entry.decision) };
}

export function invalidatePersonalization(state, questionId, all = false) {
  if (!hasPersonalization(state)) return;
  const removed = new Set([questionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of personalQuestions(state)) {
      if (all || removed.has(entry.decision.source_question_id)) {
        if (entry.status !== 'obsolete' || !removed.has(entry.question.id)) changed = true;
        entry.status = 'obsolete';
        delete state.clarificationAnswers?.[entry.question.id];
        removed.add(entry.question.id);
      }
    }
    const clarification = state.v3.clarification;
    if (clarification && removed.has(clarification.binding.source_question_id)) {
      if (clarification.status !== 'obsolete' || !removed.has('q3_10')) changed = true;
      clarification.status = 'obsolete';
      delete clarification.assignment;
      delete state.clarificationAnswers?.q3_10;
      removed.add('q3_10');
    }
  }
  for (const entry of Object.values(state.v3.personalization.presentations)) {
    if (all || removed.has(entry.decision.source_question_id)) entry.status = 'obsolete';
  }
}

export function previousPersonalQuestion(state) {
  const order = state.v3.personalization.answer_order || [];
  const current = state.v3.editingQuestion;
  const boundary = current ? order.indexOf(current) : order.length;
  return order.slice(0, boundary < 0 ? order.length : boundary).findLast(id =>
    state.ans[id] || state.clarificationAnswers?.[id]);
}
