import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { initialQuestionSet, questionCatalogOf, conditionMatches } from './question-bank.js';
export { isThin } from './question-bank.js';

// Columns remain static UI assets; questions are seeded once, then read from PostgreSQL.
const coreUrl = new URL('../public/js/core/', import.meta.url);
function loadOriginal(files, expression) {
  const source = files.map(file => readFileSync(new URL(file, coreUrl), 'utf8')).join('\n');
  return vm.runInNewContext(`${source}\n;(${expression});`, Object.create(null), {
    filename: files.join(', '),
    timeout: 1000,
  });
}

const original = loadOriginal(['utils.js'], '({ josa })');
// Used by isolated tests and pre-migration intakes. New HTTP intakes require a DB snapshot.
export const questions = initialQuestionSet.questions;
export const optLabel = option => Array.isArray(option) ? option[0] : option;
export const optMeta = option => Array.isArray(option) ? option[1] || {} : {};

export function renderText(text, state) {
  return String(text).replace(/\{name(?::([^}]+))?\}/g, (_, particle) => {
    const name = state.name || '그분';
    return particle ? name + original.josa(name, particle) : name;
  });
}

export function renderQuestion(question, state = { tags: [], name: '' }) {
  const { when, rare, rare_when, follow_up, subject, ...definition } = question;
  const rendered = JSON.parse(JSON.stringify(definition));
  if (follow_up === true) rendered.follow_up = true;
  rendered.q = renderText(rare && conditionMatches(rare_when || { tag:'rare_contact' }, state) ? rare : question.q, state);
  for (const key of ['sec', 'intro', 'why', 'ph']) {
    if (rendered[key]) rendered[key] = renderText(rendered[key], state);
  }
  return rendered;
}

export const questionCatalog = questionCatalogOf(initialQuestionSet);

const columnSource = loadOriginal(['columns.js', 'columnBodies.js'],
  '({ COLUMNS, COLUMN_CATS, COLUMN_BODIES })');
export const columns = JSON.parse(JSON.stringify(columnSource.COLUMNS));
export const categories = JSON.parse(JSON.stringify(columnSource.COLUMN_CATS));
export const columnBodies = JSON.parse(JSON.stringify(columnSource.COLUMN_BODIES));
