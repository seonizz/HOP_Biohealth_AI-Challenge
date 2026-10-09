import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Keep the checked-in UI question wording and rules as the single source of truth.
const coreUrl = new URL('../public/js/core/', import.meta.url);
function loadOriginal(files, expression) {
  const source = files.map(file => readFileSync(new URL(file, coreUrl), 'utf8')).join('\n');
  return vm.runInNewContext(`${source}\n;(${expression});`, Object.create(null), {
    filename: files.join(', '),
    timeout: 1000,
  });
}

const original = loadOriginal(['utils.js', 'questions.js'],
  '({ Q, FOLLOW, RARE, isThin, optLabel, optMeta, josa })');
export const questions = Array.from(original.Q);
export const follows = original.FOLLOW;
export const isThin = original.isThin;
export const optLabel = original.optLabel;
export const optMeta = original.optMeta;

export function ruleState(state) {
  return { ...state, tags: new Set(state.tags) };
}

export function renderText(text, state) {
  return String(text).replace(/\{name(?::([^}]+))?\}/g, (_, particle) => {
    const name = state.name || '그분';
    return particle ? name + original.josa(name, particle) : name;
  });
}

export function renderQuestion(question, state = { tags: [], name: '' }) {
  const { when, rare, ...definition } = question;
  const rendered = JSON.parse(JSON.stringify(definition));
  rendered.q = renderText(rare && original.RARE(ruleState(state)) ? rare : question.q, state);
  for (const key of ['sec', 'intro', 'why', 'ph']) {
    if (rendered[key]) rendered[key] = renderText(rendered[key], state);
  }
  return rendered;
}

export const questionCatalog = questions.map(({ when, ...question }) => ({
  ...JSON.parse(JSON.stringify(question)),
  conditional: Boolean(when),
}));

const columnSource = loadOriginal(['columns.js', 'columnBodies.js'],
  '({ COLUMNS, COLUMN_CATS, COLUMN_BODIES })');
export const columns = JSON.parse(JSON.stringify(columnSource.COLUMNS));
export const categories = JSON.parse(JSON.stringify(columnSource.COLUMN_CATS));
export const columnBodies = JSON.parse(JSON.stringify(columnSource.COLUMN_BODIES));
