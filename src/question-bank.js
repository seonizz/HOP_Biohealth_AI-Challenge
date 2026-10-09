import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { HttpError } from './errors.js';

export const initialQuestionRows = JSON.parse(readFileSync(new URL('../seeds/questions.json', import.meta.url), 'utf8'));
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = () => { throw new HttpError(503, 'QUESTION_BANK_INVALID', '질문 설정을 확인해 주세요.'); };
const slug = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) && !['__proto__','constructor','prototype'].includes(value);
const string = (value, max = 10000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));

function validateCondition(value, depth = 0) {
  if (!plain(value) || depth > 8 || Object.keys(value).length !== 1) fail();
  const [key] = Object.keys(value), arg = value[key];
  if (['all','any'].includes(key)) {
    if (!Array.isArray(arg) || !arg.length || arg.length > 20) fail();
    arg.forEach(rule => validateCondition(rule, depth + 1));
  } else if (key === 'not') validateCondition(arg, depth + 1);
  else if (['tag','tag_prefix','custom'].includes(key)) { if (!slug(arg)) fail(); }
  else if (key === 'selected') {
    if (!exact(arg, ['question_id','option']) || !slug(arg.question_id) || !string(arg.option)) fail();
  } else fail();
}

function validateDefinition(q, follow = false) {
  const keys = ['sec','face','q','why','type','ph','ph_by_option','ownPh','fu','short','required','noOwn','noSkip','cue','intro','rare','rare_when','when','opts','follow_up'];
  if (!exact(q, keys) || !string(q.q) || !['text','one','multi'].includes(q.type)) fail();
  for (const key of ['sec','face','why','ph','ownPh','intro','rare']) if (q[key] !== undefined && !string(q[key])) fail();
  for (const key of ['fu','short','required','noOwn','noSkip','cue']) if (q[key] !== undefined && typeof q[key] !== 'boolean') fail();
  if (q.ph_by_option !== undefined) {
    const ph = q.ph_by_option;
    if (q.type !== 'text' || !string(q.ph) || !exact(ph, ['question_id','values']) ||
      !slug(ph.question_id) || !plain(ph.values) || !Object.keys(ph.values).length || Object.keys(ph.values).length > 100 ||
      Object.entries(ph.values).some(([key, value]) => !slug(key) || !string(value))) fail();
  }
  for (const key of ['when','rare_when']) if (q[key] !== undefined) validateCondition(q[key]);
  if (q.type === 'text') { if (q.opts !== undefined) fail(); }
  else {
    if (!Array.isArray(q.opts) || !q.opts.length || q.opts.length > 100) fail();
    for (const option of q.opts) {
      if (typeof option === 'string') { if (!string(option)) fail(); continue; }
      if (!Array.isArray(option) || option.length !== 2 || !string(option[0]) ||
        !exact(option[1], ['d','a','x','s','r','p','t','g','none','input','ph','ask'])) fail();
      for (const [key, value] of Object.entries(option[1])) {
        if (['d','a','x'].includes(key)) { if (!Number.isFinite(value)) fail(); }
        else if (['none','input'].includes(key)) { if (![true,false,0,1].includes(value)) fail(); }
        else if (key === 'g' && value === '') continue;
        else if (!string(value)) fail();
      }
    }
    if (new Set(q.opts.map(option => Array.isArray(option) ? option[0] : option)).size !== q.opts.length) fail();
  }
  if (q.follow_up !== undefined) {
    const f = q.follow_up;
    if (follow || !exact(f, ['when','merge','question']) || !exact(f.when, ['rule','min']) ||
      !['thin_text','thin_custom','empty_selection_thin_custom'].includes(f.when.rule) ||
      !Number.isInteger(f.when.min) || f.when.min < 1 || f.when.min > 10000 ||
      !['name','replace_text','replace_text_or_none','custom'].includes(f.merge)) fail();
    validateDefinition(f.question, true);
  }
}

// Database content is data only: rules are interpreted, never evaluated as JavaScript.
export function createQuestionSet(rows) {
  if (!Array.isArray(rows) || rows.length > 201) fail();
  if (rows.some(row => !plain(row) || typeof row.enabled !== 'boolean' || !slug(row.id) || !Number.isSafeInteger(row.sort_order))) fail();
  const seen = new Set();
  const enabled = rows.filter(row => row.enabled === true).sort((a,b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  for (const row of enabled) {
    if (!slug(row.id) || seen.has(row.id) || !['base','gap'].includes(row.kind) ||
      !Number.isSafeInteger(row.sort_order) || !['patient','supporter','user_goal'].includes(row.subject)) fail();
    seen.add(row.id);
    // The user-goal adapter has two explicit slots. New patient/supporter IDs are unrestricted.
    if ((row.subject === 'user_goal') !== ['want','goal'].includes(row.id) ||
      (row.kind === 'gap') !== (row.id === 'gap_obs') ||
      (['name','gap_obs'].includes(row.id) && row.subject !== 'patient')) fail();
    validateDefinition(row.definition);
    if (row.kind === 'gap' && (row.definition.type !== 'text' || row.definition.when || row.definition.follow_up)) fail();
  }
  const questions = enabled.filter(row => row.kind === 'base').map(row => ({ id:row.id, subject:row.subject, ...structuredClone(row.definition) }));
  if (!questions.length) fail();
  for (const [index, question] of questions.entries()) {
    for (const condition of [question.when, question.rare_when].filter(Boolean)) {
      for (const dependency of conditionDependencies(condition, questions)) {
        if (questions.findIndex(q => q.id === dependency) >= index) fail();
      }
    }
  }
  const gap = enabled.find(row => row.kind === 'gap');
  const content = { questions, gapQuestion:gap ? { id:gap.id, subject:gap.subject, ...structuredClone(gap.definition) } : null };
  return { version:createHash('sha256').update(JSON.stringify(content)).digest('hex'), ...content };
}

export const initialQuestionSet = createQuestionSet(initialQuestionRows);

function conditionDependencies(condition, questions) {
  if (condition.any || condition.all) return (condition.any || condition.all).flatMap(rule => conditionDependencies(rule, questions));
  if (condition.not) return conditionDependencies(condition.not, questions);
  if (condition.custom || condition.selected) {
    const id = condition.custom || condition.selected.question_id;
    const source = questions.find(q => q.id === id);
    if (!source || (condition.selected && !source.opts?.some(option =>
      (Array.isArray(option) ? option[0] : option) === condition.selected.option))) fail();
    return [id];
  }
  const sources = questions.filter(q => q.opts?.some(option => {
    const tag = Array.isArray(option) && option[1]?.t;
    return tag && (condition.tag ? tag === condition.tag : tag.startsWith(condition.tag_prefix));
  }));
  if (!sources.length) fail();
  return sources.map(q => q.id);
}

export function branchGateIds(set) {
  return new Set(set.questions.flatMap(question => [question.when, question.rare_when].filter(Boolean)
    .flatMap(condition => conditionDependencies(condition, set.questions))));
}

export function conditionMatches(condition, state) {
  if (!condition) return true;
  if (condition.all) return condition.all.every(rule => conditionMatches(rule, state));
  if (condition.any) return condition.any.some(rule => conditionMatches(rule, state));
  if (condition.not) return !conditionMatches(condition.not, state);
  if (condition.tag) return state.tags.includes(condition.tag);
  if (condition.tag_prefix) return state.tags.some(tag => tag.startsWith(condition.tag_prefix));
  if (condition.custom) return Boolean(state.ans[condition.custom]?.custom);
  if (condition.selected) {
    const source = (state.questionSet || initialQuestionSet).questions.find(q => q.id === condition.selected.question_id);
    return Boolean(state.ans[condition.selected.question_id]?.sel.some(index => {
      const option = source?.opts?.[index];
      return (Array.isArray(option) ? option[0] : option) === condition.selected.option;
    }));
  }
  return false;
}

export function questionCatalogOf(set) {
  return set.questions.map(({ when, rare_when, follow_up, subject, ...q }) => ({ ...structuredClone(q), conditional:Boolean(when) }));
}

const VAGUE = /^(몰라|모르겠|글쎄|그냥|별로|없어|없음|음+|\.+|ㅇ+|-)$|모르겠|잘 모르/;
export function isThin(text, min = 10) {
  const value = (text || '').trim();
  return !value || value.startsWith('(') || value.length < min || VAGUE.test(value);
}

export function followMatches(follow, answer) {
  const { rule, min } = follow.when;
  if (rule === 'thin_text') return isThin(answer.text, min);
  if (rule === 'thin_custom') return Boolean(answer.custom) && isThin(answer.custom, min);
  return !answer.sel.length && isThin(answer.custom, min);
}

export function mergeFollow(follow, answer, reply) {
  if (follow.merge === 'name') return { text:isThin(reply.text, 1) ? '그분' : reply.text, sel:[] };
  if (isThin(reply.text, 1) || (follow.merge === 'replace_text_or_none' && reply.text === '해당 없음')) return answer;
  return follow.merge === 'custom' ? { ...answer, custom:reply.text } : { text:reply.text, sel:[] };
}
