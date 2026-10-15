import { contextGoal, nameSourceTexts } from './agent-state.js';

const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const literal = value => ({ type: 'string', const: value });
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = (items, maxItems, minItems = 0) => ({ type: 'array', items, minItems, maxItems });
const nullable = value => ({ anyOf: [{ type: 'null' }, value] });

function sourceTexts(field) {
  return [field?.rawText, field?.text, field?.custom, field?.followUp?.answer?.rawText,
    field?.followUp?.answer?.text, field?.followUp?.answer?.custom]
    .filter(value => typeof value === 'string' && value.trim());
}

function aroundRisk(source, index, length) {
  const boundary = /[\r\n.!?。！？]/u;
  let start = index;
  let end = index + length;
  while (start > 0 && !boundary.test(source[start - 1])) start--;
  while (end < source.length && !boundary.test(source[end])) end++;
  if (end < source.length) end++;
  if (end - start > 160) {
    // Keep the original words on both sides, including nearby negation and attribution.
    start = Math.max(start, index - 56);
    end = Math.min(end, start + 160);
    if (end < index + length) end = index + length;
  }
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(source[start])) start--;
  if (end - start > 160) end = start + 160;
  if (end < source.length && /[\uD800-\uDBFF]/u.test(source[end - 1])) end--;
  return source.slice(start, end).trim();
}

// These are exact reported words to preserve, not a new clinical assessment.
export function riskEvidenceQuotes(field) {
  const sources = sourceTexts(field);
  const labels = (field?.selected || []).filter(option => option.meta?.s === 'suicidal')
    .map(option => option.label).filter(label => typeof label === 'string' && label.trim() &&
      label.length <= 160 && sources.some(source => source.includes(label)));
  const quoted = sources.flatMap(source => [...source.matchAll(/죽고\s?싶|사라지고\s?싶|없어지고\s?싶|자살|자해/gu)]
    .map(match => aroundRisk(source, match.index, match[0].length)));
  return [...new Set([...labels, ...quoted])].filter(Boolean).slice(0, 8);
}

function sourceExcerpts(source) {
  const value = source.trim();
  if (value.length <= 160) return [value];
  const excerpts = [];
  for (const sentence of value.match(/[^\n.!?。！？]+[.!?。！？]*/gu) || [value]) {
    for (let start = 0; start < sentence.length;) {
      let end = Math.min(start + 160, sentence.length);
      // Keep a surrogate pair together when a long passage contains emoji.
      if (end < sentence.length && /[\uD800-\uDBFF]/u.test(sentence[end - 1])) end--;
      const excerpt = sentence.slice(start, end).trim();
      if (excerpt) excerpts.push(excerpt);
      start = end;
    }
  }
  return excerpts;
}

export function evidenceQuotes(field) {
  const sources = sourceTexts(field);
  const excerpts = sources.map(sourceExcerpts);
  const labels = (field?.selected || []).map(option => option.label)
    .filter(label => typeof label === 'string' && label.trim() && label.length <= 160 && sources.some(source => source.includes(label)));
  // Preserve reported danger words before filling remaining slots with other answer excerpts.
  return [...new Set([...riskEvidenceQuotes(field), ...excerpts.map(parts => parts[0]), ...labels, ...excerpts.flat()])]
    .filter(quote => typeof quote === 'string' && sources.some(source => source.includes(quote))).slice(0, 8);
}

function sourceFields(context, subject) {
  if (subject === 'user_goal') return [context?.user_goal?.message, context?.user_goal?.desired_outcomes];
  return Object.values(context?.[subject]?.fields || {});
}

// Couple each quote to its actual question so a valid ID cannot carry another answer's words.
function sourceVariants(context, subjects, statuses, fact = false) {
  return subjects.flatMap(subject => statuses.flatMap(status => {
    return sourceFields(context, subject).filter(field => field?.status === status).flatMap(field => {
      const quotes = evidenceQuotes(field);
      if (!quotes.length) return [];
      return [object({
        subject: literal(subject), question_id: literal(field.id), quote: { type: 'string', enum: quotes, maxLength: 160 },
        ...(fact ? { interpretation: string(2000), certainty: status === 'unknown' ? literal('unknown') : { type: 'string', enum: ['reported', 'unknown'] } } : {}),
      })];
    });
  }));
}

function patientStateSchema(context, final) {
  const facts = sourceVariants(context, ['patient', 'supporter'], ['answered', 'unknown'], true);
  return object({
    summary: string(4000),
    facts: array(facts.length ? { anyOf: facts } : object({}), facts.length ? (final ? 12 : 8) : 0, facts.length ? 1 : 0),
    unknowns: array(string(2000), 30),
    user_goal: literal(contextGoal(context)),
  });
}

function nameIndexSchema(context) {
  const name = context?.patient?.fields?.name;
  if (name?.status !== 'answered' || !nameSourceTexts(name).length) return { type: 'null' };
  const supplied = (name.rawText || '').trim();
  // Only a bare short label is fixed to the supplied text; a sentence remains an extraction task.
  const hasFollowUp = nameSourceTexts({ followUp: name.followUp }).length > 0;
  const bareAlias = !hasFollowUp && supplied === name.text && /^[\p{L}\p{N}._·-]{1,10}$/u.test(supplied) && !/(이름|별명|라고|예요|이에요|입니다|이요|요$)/u.test(supplied);
  return nullable(object({
    alias: bareAlias ? { type: 'string', enum: [supplied] } : string(20),
    source_question_id: literal('name'), quote: string(10000),
  }));
}

function currentField(context, candidate) {
  if (candidate.subject === 'user_goal') return candidate.id === 'goal' ? context?.user_goal?.desired_outcomes : context?.user_goal?.message;
  return context?.[candidate.subject]?.fields?.[candidate.id];
}

function questionPlanSchema(context) {
  const candidates = (context?.question_candidates || []).filter(candidate =>
    !['name', 'want', 'cause'].includes(candidate.id) && (!currentField(context, candidate) || currentField(context, candidate).status === 'not_asked'));
  const variants = ['patient', 'supporter', 'user_goal'].flatMap(subject => ['already_covered', 'not_needed'].flatMap(reason => {
    const ids = candidates.filter(candidate => candidate.subject === subject &&
      (reason === 'already_covered' || (Number.isInteger(context?.answered_count) && context.answered_count >= 5 && !candidate.required && !candidate.noSkip)))
      .map(candidate => candidate.id);
    const evidence = sourceVariants(context, subject === 'patient' ? ['patient', 'user_goal'] : [subject],
      reason === 'already_covered' ? ['answered'] : ['answered', 'unknown']);
    if (!ids.length || !evidence.length) return [];
    return [object({
      question_id: { type: 'string', enum: ids }, reason: literal(reason), explanation: string(1000),
      evidence: array({ anyOf: evidence }, 8, 1),
    })];
  }));
  return object({ skip: array(variants.length ? { anyOf: variants } : object({}), variants.length ? 8 : 0) });
}

export function modelResponseFormat(context, final = false) {
  const patient_state = patientStateSchema(context, final);
  const name_index = nameIndexSchema(context);
  const properties = final ? {
    guide: object({
      top: { type: 'string', enum: ['우울', '불안', '중독', '통합'] }, script: string(8000),
      doList: array(string(2000), 4, 1), avoid: array(string(2000), 4, 1), next: string(8000),
      care: object({ feel: string(8000), tips: array(string(2000), 4, 1) }),
    }),
    patient_state, assessment: object({ safety: { type: 'boolean' } }), name_index,
  } : { patient_state, name_index, question_plan: questionPlanSchema(context) };
  return { type: 'json_schema', json_schema: { name: final ? 'malssi_guide' : 'malssi_state', strict: true, schema: object(properties) } };
}
