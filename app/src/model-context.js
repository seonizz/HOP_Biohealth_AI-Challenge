import { contextGoal, nameSourceTexts } from './agent-state.js';
import { answerComponents } from './answer-sources.js';

const available = field => ['answered', 'unknown'].includes(field?.status);
const sources = field => [...new Set(field.id === 'name'
  ? nameSourceTexts(field)
  : answerComponents(field).map(component => component.text))];
const row = field => [field.id, field.question, field.status, sources(field)];

// Keep the trained prompt's tuple format, but preserve every available answer.
// The model server owns the context budget; never shorten sources to fit it.
export function trainedContext(context, memory, { final = false } = {}) {
  const fields = subject => Object.values(context?.[subject]?.fields || {}).filter(available).map(row);
  return {
    partial: false,
    answered_count: context.answered_count || 0,
    // Tuples are [question ID, question, status, complete answer components].
    patient: fields('patient'),
    supporter: fields('supporter'),
    goal: contextGoal(context),
    user_goal: [context.user_goal?.message, context.user_goal?.desired_outcomes].filter(available).map(row),
    ...(context.user_goal?.desired_outcomes?.status === 'answered'
      ? { desired: sources(context.user_goal.desired_outcomes) } : {}),
    memory: memory ? {
      summary: memory.summary,
      facts: (memory.facts || []).map(fact => [fact.subject, fact.question_id, fact.quote, fact.certainty]),
      unknowns: [...(memory.unknowns || [])],
    } : null,
    ...(!final ? { candidates: (context.question_candidates || []).map(candidate => [
      candidate.id, candidate.question, candidate.subject,
      candidate.required || candidate.noSkip ? 'covered_only' : context.answered_count >= 5 ? 'optional' : 'covered_only',
    ]) } : {}),
  };
}
