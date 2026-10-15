import { contextGoal, nameSourceTexts } from './agent-state.js';
import { evidenceQuotes, riskEvidenceQuotes } from './model-schema.js';

const FINAL_FIELDS = ['name', 'mood', 'dur', 'freq', 'describe', 'concern', 'events', 'need',
  'feeling', 'cgchange', 'mycoping', 'moment', 'help', 'coping', 'support', 'burden', 'others_why', 'others_help', 'values', 'mysupport'];

function clip(value, max) {
  if (typeof value !== 'string') return '';
  let end = Math.min(max, value.length);
  if (end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1])) end--;
  return value.slice(0, end);
}

function names(field, knownName) {
  const sources = nameSourceTexts(field);
  const quotes = evidenceQuotes({ rawText: sources[0], custom: sources[1], followUp: { answer: { rawText: sources[2] } } });
  if (knownName?.alias && sources.some(source => source.includes(knownName.alias))) quotes.unshift(knownName.alias);
  return [...new Set(quotes)];
}

// This is a bounded inference projection. The complete answers remain in PostgreSQL.
export function trainedContext(context, memory, { final = false, tighter = false } = {}) {
  const fields = ['patient', 'supporter'].flatMap(subject => Object.values(context?.[subject]?.fields || {})
    .filter(field => ['answered', 'unknown'].includes(field.status))
    .map(field => ({ subject, field })));
  const byId = new Map(fields.map(value => [value.field.id, value]));
  const critical = new Map(fields.map(({ field }) => [field.id, riskEvidenceQuotes(field)]).filter(([, quotes]) => quotes.length));
  const ordered = (context.payload?.answers || fields.map(value => value.field)).map(field => field.id).filter(id => byId.has(id));
  const ids = final ? [...FINAL_FIELDS, ...ordered.slice(-3)] : [
    ...ordered.slice(tighter ? -2 : -3).reverse(),
    ...(memory?.facts || []).slice(tighter ? -1 : -2).map(fact => fact.question_id), 'name',
  ];
  const chosen = [...new Set([...critical.keys(), ...ids])].filter(id => byId.has(id));
  const quotes = field => {
    if (critical.has(field.id)) return critical.get(field.id);
    const available = field.id === 'name' ? names(field, context.name_index) : evidenceQuotes(field);
    return available.slice(0, tighter ? 1 : 2).map(quote => clip(quote, tighter ? 55 : final ? 90 : 100)).filter(Boolean);
  };
  const selected = chosen.map(id => {
    const { subject, field } = byId.get(id);
    return { subject, id, question: clip(field.question, tighter ? 25 : 45), status: field.status, quotes: quotes(field) };
  });
  const projected = {
    partial: true,
    answered_count: context.answered_count || 0,
    // Tuples are [question ID, question, status, exact answer excerpts].
    patient: selected.filter(field => field.subject === 'patient').map(field => [field.id, field.question, field.status, field.quotes]),
    supporter: selected.filter(field => field.subject === 'supporter').map(field => [field.id, field.question, field.status, field.quotes]),
    goal: clip(contextGoal(context), tighter ? 80 : 160),
    ...([context.user_goal?.message, context.user_goal?.desired_outcomes].some(field =>
      ['answered', 'unknown'].includes(field?.status) && riskEvidenceQuotes(field).length) ? {
        user_goal: [context.user_goal?.message, context.user_goal?.desired_outcomes]
          .filter(field => ['answered', 'unknown'].includes(field?.status) && riskEvidenceQuotes(field).length)
          .map(field => [field.id, clip(field.question, tighter ? 25 : 45), field.status, riskEvidenceQuotes(field)]),
      } : {}),
    ...(context.user_goal?.desired_outcomes?.status === 'answered' ? { desired: evidenceQuotes(context.user_goal.desired_outcomes).slice(0, 1).map(quote => clip(quote, tighter ? 55 : 90)) } : {}),
    memory: memory ? {
      summary: clip(memory.summary, tighter ? 90 : 160),
      facts: (memory.facts || []).slice(tighter ? -1 : -3).map(fact => [fact.subject, fact.question_id, clip(fact.quote, tighter ? 55 : 90), fact.certainty]),
      unknowns: (memory.unknowns || []).slice(0, 3).map(value => clip(value, tighter ? 40 : 70)),
    } : null,
    ...(!final ? { candidates: (context.question_candidates || []).slice(0, tighter ? 1 : 3)
      .map(candidate => [candidate.id, clip(candidate.question, tighter ? 40 : 70), candidate.subject, candidate.required || candidate.noSkip ? 'covered_only' : context.answered_count >= 5 ? 'optional' : 'covered_only']) } : {}),
  };
  const cap = tighter ? (final ? 1900 : 1300) : (final ? 3000 : 2200);
  const size = () => JSON.stringify(projected).length;
  // First shorten excerpts, then omit repeated questions before removing lower-priority fields.
  if (size() > cap) for (const subject of ['patient', 'supporter']) for (const row of projected[subject]) {
    if (!critical.has(row[0])) row[3] = row[3].slice(0, 1).map(quote => clip(quote, tighter ? 35 : 60));
  }
  if (size() > cap) for (const subject of ['patient', 'supporter']) for (const row of projected[subject]) row[1] = '';
  if (size() > cap) projected.memory = memory ? {
    summary: clip(memory.summary, 70),
    facts: (memory.facts || []).slice(tighter ? -1 : -3).map(fact => [fact.subject, fact.question_id, clip(fact.quote, 30), fact.certainty]),
    unknowns: (memory.unknowns || []).slice(0, 2).map(value => clip(value, 30)),
  } : null;
  if (size() > cap) {
    // Preserve patient and supporter evidence rather than filling the budget with a single person.
    for (const id of [...chosen].reverse()) {
      const subject = byId.get(id).subject;
      if (critical.has(id) || projected[subject].length <= 1 || ['name', 'mood', 'concern', 'need', 'feeling', 'cgchange'].includes(id)) continue;
      projected[subject] = projected[subject].filter(row => row[0] !== id);
      if (size() <= cap) break;
    }
  }
  return projected;
}
