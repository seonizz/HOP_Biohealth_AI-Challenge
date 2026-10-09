import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fail, keys, record, text } from './errors.ts';

const source = readFileSync(new URL('../../docs/MALSSI_QUESTIONNAIRE_V1.json', import.meta.url), 'utf8');
export const catalog = JSON.parse(source);
export const catalogHash = createHash('sha256').update(source).digest('hex');
export const questions: any[] = catalog.questions;
export const question = (id: string) => questions.find(q => q.id === id) ?? fail('INVALID_OPTION');
export type Answer = { id: string; question_id: string; disposition: string; value: any; message_id?: string; derived_from_answer_id?: string; revision?: number };
export type Answers = Record<string, Answer>;

export function assertCatalogPublishable(c = catalog) {
  if (c.publication_status !== 'published' || c.rights_status !== 'approved' || c.clinical_review_status !== 'approved' || !c.review_refs?.length || c.questions.some((q: any) => q.rights_status && q.rights_status !== 'approved')) fail('QUESTION_RETIRED', 410);
}
export function alias(value: unknown) {
  const result = text(value, 30).trim();
  if (/[\r\n\t<>\u2028\u2029]/u.test(result) || /\{.*\}/u.test(result)) fail();
  return result;
}
export function ending(name: string): number | null {
  const clean = name.normalize('NFC').replace(/[\s\p{P}\p{S}\uFE0F\u200D]+$/gu, '');
  const cp = [...clean].at(-1)?.codePointAt(0);
  return cp !== undefined && cp >= 0xac00 && cp <= 0xd7a3 ? (cp - 0xac00) % 28 : null;
}
export function render(template: string, neutral: string, name: string) {
  const last = ending(name);
  if (last === null && /\{subject:/u.test(template)) return neutral;
  const particles: Record<string, string> = { 은는:last ? '은':'는', 이가:last ? '이':'가', 을를:last ? '을':'를', 와과:last ? '과':'와', 으로로:last && last !== 8 ? '으로':'로', 의:'의', 에게:'에게' };
  return template.replace(/\{subject:([^}]+)\}/gu, (_m, particle) => name + (particles[particle] ?? fail()));
}
export function eligibility(id: string, answers: Answers): 'eligible' | 'deferred' | 'not_applicable' {
  if (id === 'T10' || id === 'T11') {
    const parent = answers.T09;
    if (!parent || parent.disposition !== 'answered') return 'deferred';
    return parent.value?.option_ids?.includes('none') ? 'not_applicable' : 'eligible';
  }
  if (id === 'C01A' && answers.C01?.disposition !== 'answered') return 'deferred';
  return 'eligible';
}
function detail(value: any, required = false) { return value === undefined && !required ? undefined : text(value, 500); }
function choice(field: any, value: any): Record<string, any> {
  const v = record(value);
  if ('text' in v) { keys(v,['text'],['text']); if (!field.allow_direct_text) fail(); return { text:text(v.text,field.direct_text_max_codepoints || 2000) }; }
  keys(v,['option_ids','detail'],['option_ids']);
  if (!Array.isArray(v.option_ids) || new Set(v.option_ids).size !== v.option_ids.length || v.option_ids.length < field.min_selected || v.option_ids.length > field.max_selected || v.option_ids.some((id: any) => !field.options.some((o: any) => o.id === id))) fail('INVALID_OPTION');
  if (v.option_ids.length > 1 && v.option_ids.some((id: string) => field.mutually_exclusive_option_ids?.includes(id))) fail('INVALID_OPTION');
  const extra = detail(v.detail, v.option_ids.includes('other'));
  return { option_ids:[...v.option_ids].sort(), ...(extra === undefined ? {} : {detail:extra}) };
}
export function validateAnswer(id: string, disposition: string, raw: unknown, answers: Answers = {}) {
  const q = question(id);
  if (disposition === 'not_applicable') {
    if (raw !== null || eligibility(id, answers) !== 'not_applicable') fail('INVALID_DEPENDENCY');
    return null;
  }
  if (!q.disposition_options.includes(disposition)) fail();
  if (disposition !== 'answered') { if (raw !== null) fail(); return null; }
  if (eligibility(id,answers) !== 'eligible') fail('INVALID_DEPENDENCY');
  const value = record(raw), fields = q.answer_schema.fields;
  if (q.answer_schema.kind === 'text') {
    keys(value,['text'],['text']);
    return {text:id === 'N00' ? alias(value.text) : text(value.text, fields[0].max_codepoints)};
  }
  if (q.answer_schema.kind === 'composite') {
    keys(value,[...fields.map((f: any) => f.id),'detail'],fields.map((f: any) => f.id));
    let answered = 0; const result: Record<string, any> = {};
    for (const f of fields) {
      const part = record(value[f.id]); keys(part,['status','option_id','detail','text'],['status']);
      if (part.status === 'answered') {
        if ('text' in part) { keys(part,['status','text'],['status','text']); result[f.id] = {status:'answered',...choice(f,{text:part.text})}; }
        else { const c = choice(f,{option_ids:[part.option_id],...(part.detail === undefined ? {} : {detail:part.detail})}); result[f.id] = {status:'answered',option_id:c.option_ids![0],...(c.detail ? {detail:c.detail} : {})}; }
        answered++;
      } else { keys(part,['status']); if (!['unknown','skipped'].includes(part.status)) fail(); result[f.id] = part; }
    }
    if (!answered) fail();
    if (value.detail !== undefined) result.detail = text(value.detail,2000);
    return result;
  }
  if (q.answer_schema.kind === 'coping_entries') {
    if ('text' in value) { keys(value,['text'],['text']); return {text:text(value.text)}; }
    keys(value,['entries'],['entries']); const schema = fields[0].entry_schema;
    if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > fields[0].max_items) fail();
    return { entries:value.entries.map((entry: unknown) => {
      const e = record(entry); keys(e,['method_option_id','effect_option_id','detail'],['method_option_id','effect_option_id']);
      if (!schema.method_options.some((o: any) => o.id === e.method_option_id) || !schema.effect_options.some((o: any) => o.id === e.effect_option_id)) fail('INVALID_OPTION');
      const d = detail(e.detail,e.method_option_id === 'other');
      return {method_option_id:e.method_option_id,effect_option_id:e.effect_option_id,...(d === undefined ? {} : {detail:d})};
    }) };
  }
  return choice(fields[0],value);
}
export function nextQuestion(answers: Answers, goal = 'unsure', explicit?: string, topic?: string) {
  if (explicit) { question(explicit); if (eligibility(explicit,answers) !== 'eligible') fail('INVALID_DEPENDENCY'); return explicit; }
  const candidates = questions.filter(q => !answers[q.id] && eligibility(q.id,answers) === 'eligible');
  const priority = ['N00','T01',...(catalog.goal_priorities[goal] || [])];
  candidates.sort((a,b) => {
    if (topic) { const difference = Number(b.section === topic) - Number(a.section === topic); if (difference) return difference; }
    const ai = priority.includes(a.id) ? priority.indexOf(a.id) : 1000+a.priority;
    const bi = priority.includes(b.id) ? priority.indexOf(b.id) : 1000+b.priority;
    return ai-bi || a.id.localeCompare(b.id);
  });
  return candidates[0]?.id ?? null;
}
export function questionSnapshot(id: string, name: string, answers: Answers) {
  const q = question(id); let template = q.text_template, variant = 'default';
  if (id === 'C02' && answers.C01?.disposition !== 'answered') { template = q.variants[0].text; variant = q.variants[0].id; }
  if (id === 'T17' && !answers.T13?.value?.option_ids?.some((v: string) => ['medical','counseling'].includes(v))) { template = q.variants[0].text; variant = q.variants[0].id; }
  return { question_id:id,question_version:catalog.questionnaire_version,text:render(template,q.neutral_text,name),answer_schema:q.answer_schema,disposition_options:q.disposition_options,variant,scored_scale:false };
}
export function coverage(answers: Answers) {
  const counts: Record<string, number> = {answered:0,unknown:0,skipped:0,not_applicable:0,deferred:0,total:24};
  for (const q of questions) {
    const state = eligibility(q.id,answers);
    if (state !== 'eligible') counts[state]++;
    else if (answers[q.id]) counts[answers[q.id].disposition]++;
  }
  return counts;
}
export function readiness(answers: Answers, goal: string, country?: string) {
  const has = (id: string) => answers[id]?.disposition === 'answered';
  const relation = has('T01') && answers.T01.value.relation?.status === 'answered';
  return {understand:relation && (has('T02') || has('C01')) && has('T04'), what_to_say:relation && has('C01') && goal !== 'unsure', what_to_do:(has('T02') || has('C01')) && (has('T15') || goal === 'what_to_do') && ['T08','T14','C03'].some(has), support_me:(has('C02') || has('C03')) && goal === 'support_me', find_help:goal === 'find_help' && Boolean(country)};
}
