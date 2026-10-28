import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUT_SCHEMA, parseStrictJSON, parseSnapshot, validateInput, assembleBundle, run } from '../scripts/supporter_app_stage.mjs';

// Synthetic unit-test strings only; these are not training/export examples.
const field = (id, text, status = 'answered') => ({ id, question: `Question ${id}`, status, rawText: text, text, custom: '' });
function fixture() {
  const p = 'Fixture target report.';
  const s = 'Fixture supporter limit.';
  const g = 'Fixture user goal.';
  return { schema_version: INPUT_SCHEMA, context_id: 'fixture', origin_type: 'synthetic_scenario',
    author_id: 'unit-test-author', authored_at: '2026-10-16T00:00:00Z', source_root_ids: ['synthetic:fixture-root'],
    source_group_ids: ['synthetic:fixture-group'], split: 'train', safety_scope: 'non_acute_communication', risk_tags: [], resource_dependencies: [],
    transcript: { messages: [{ message_id: 't1', role: 'user', content: p }, { message_id: 't2', role: 'user', content: s },
      { message_id: 't3', role: 'user', content: g }], cutoff_message_id: 't3' },
    context: { schema_version: '1.0', question_set_version: 'synthetic-fixture-v1',
      patient: { fields: { mood: field('mood', p) } }, supporter: { fields: { feeling: field('feeling', s) } },
      user_goal: { message: field('want', g) }, latest_answer: { subject: 'supporter', question_id: 'feeling' } },
    targets: {
      state_observations: { patient_state: { facts: [{ subject: 'patient', question_id: 'mood', quote: p, certainty: 'reported' }], unknowns: [] }, name_index: null },
      relationship_memory: { relationship_memory: { patient: [{ evidence: [{ subject: 'patient', question_id: 'mood', quote: p }], certainty: 'reported' }],
        supporter: [{ evidence: [{ subject: 'supporter', question_id: 'feeling', quote: s }], certainty: 'reported' }], relationship: [], unknowns: [] } },
    } };
}
const snapshot = values => Buffer.from(values.map(value => JSON.stringify(value) + '\n').join(''));
const assemble = values => assembleBundle(snapshot(values), { fixture_dependency: '0'.repeat(64) });
const exportRows = bundle => bundle.files.get('train.jsonl').toString('utf8').trim().split('\n').map(JSON.parse);

test('actual two-stage wire, target-only message masks, and approval/budget limits remain explicit', () => {
  const item = fixture(), before = structuredClone(item), bundle = assemble([item]), rows = exportRows(bundle);
  assert.deepEqual(item, before);
  assert.equal(bundle.manifest.stage_candidates, 2);
  assert.deepEqual(rows.map(row => row.task), ['state_observations', 'relationship_memory']);
  for (const row of rows) {
    assert.deepEqual(row.messages.map(message => message.role), ['system', 'user', 'assistant']);
    assert.deepEqual(row.loss_mask, { unit: 'message', values: [0, 0, 1], token_mask_materialized: false });
    assert.equal(row.training_allowed, false); assert.equal(row.human_approved, false);
    assert.equal(row.evaluation_budget.output_reservation, 8192);
    assert.equal(row.evaluation_budget.effective_input_ceiling, 61440);
    assert.equal(row.evaluation_budget.actual_app_stage_max_tokens, 1800);
    assert.equal(row.evaluation_budget.budget_admitted, false);
    const wire = JSON.parse(row.messages[1].content);
    assert.deepEqual(Object.keys(wire), ['stage', 'data', 'output_schema']);
    assert.equal(row.messages[1].content.includes(item.author_id), false);
    assert.equal(Object.hasOwn(wire.data, 'prior_state'), false);
  }
  const first = JSON.parse(rows[0].messages[1].content), second = JSON.parse(rows[1].messages[1].content);
  assert.equal(Object.hasOwn(first.data, 'prior_relationship_memory'), false);
  assert.deepEqual(second.data.observations, item.targets.state_observations);
  assert.equal(second.data.prior_relationship_memory, null);
  assert.equal(rows[1].provenance.upstream_observations, 'authored_gold_teacher_forcing');
  assert.equal(Object.hasOwn(JSON.parse(rows[0].messages[2].content).patient_state, 'summary'), false);
});

test('snapshot bytes preserve indentation, trailing LF and literal Unicode line separator', () => {
  const item = fixture();
  item.transcript.messages[0].content += '\u2028continued';
  item.context.patient.fields.mood.text = item.context.patient.fields.mood.rawText = item.transcript.messages[0].content;
  item.targets.state_observations.patient_state.facts[0].quote = item.transcript.messages[0].content;
  item.targets.relationship_memory.relationship_memory.patient[0].evidence[0].quote = item.transcript.messages[0].content;
  const bytes = Buffer.from('  ' + JSON.stringify(item) + '  \n');
  assert.equal(parseSnapshot(bytes).length, 1);
  assert.ok(assembleBundle(bytes, {}).files.get('input_snapshot.jsonl').equals(bytes));
});

test('follow-up correction remains a separate complete input component', () => {
  const item = fixture(), correction = 'Fixture correction supersedes the earlier report.';
  item.context.patient.fields.mood.followUp = { question: 'Correction question', answer: { rawText: correction, text: correction, custom: '' } };
  item.transcript.messages.push({ message_id: 't4', role: 'user', content: correction });
  item.transcript.cutoff_message_id = 't4';
  item.context.latest_answer = { subject: 'patient', question_id: 'mood' };
  const checked = validateInput(item);
  const answers = checked.stages[0].data.patient[0].answers;
  assert.deepEqual(answers.map(answer => answer.origin), ['answer_snapshot', 'follow_up']);
  assert.equal(answers[0].text, item.transcript.messages[0].content);
  assert.equal(answers[1].text, correction);
  assert.ok(checked.source_references.some(ref => ref.origin === 'follow_up'));
});

for (const status of ['unknown', 'refused', 'skipped', 'auto_skipped']) test(`${status} remains status, not retrieved evidence`, () => {
  const item = fixture();
  item.context.supporter.fields.feeling.status = status;
  item.targets.relationship_memory.relationship_memory.supporter = [];
  const checked = validateInput(item), data = checked.stages[0].data;
  assert.equal(data.supporter[0].status, status);
  assert.ok(data.retrieval.unanswered.some(row => row.status === status));
  assert.equal(data.retrieval.documents.some(row => row.subject === 'supporter'), false);
  if (status !== 'unknown') assert.deepEqual(data.supporter[0].answers, []);
});

test('unknown plus custom requires the same normalized state as the app', () => {
  const item = fixture();
  Object.assign(item.context.supporter.fields.feeling, { status: 'unknown', custom: item.transcript.messages[1].content,
    selected: [{ label: '잘 모르겠어요' }] });
  assert.throws(() => validateInput(item), /context_must_already_be_normalized/);
  Object.assign(item.context.supporter.fields.feeling, { status: 'answered', selection_status: 'unknown' });
  assert.doesNotThrow(() => validateInput(item));
});

const invalidCases = [
  ['future transcript after cutoff', x => { x.transcript.messages.push({ message_id: 'future', role: 'assistant', content: 'Fixture future.' }); }],
  ['context text not in user prefix', x => { x.context.patient.fields.mood.rawText = x.context.patient.fields.mood.text = 'Unseen fixture content.'; }],
  ['quote from another subject', x => { x.targets.relationship_memory.relationship_memory.patient[0].evidence[0].subject = 'supporter'; }],
  ['fabricated quote', x => { x.targets.state_observations.patient_state.facts[0].quote = 'Not in source.'; }],
  ['server summary in wire target', x => { x.targets.state_observations.patient_state.summary = 'Server owned.'; }],
  ['reported memory interpretation', x => { x.targets.relationship_memory.relationship_memory.patient[0].interpretation = 'Forbidden summary.'; }],
  ['tentative memory outside pilot', x => { const f = x.targets.relationship_memory.relationship_memory.patient[0]; f.certainty = 'tentative'; f.interpretation = '가능한 해석: a fixture possibility.'; }],
  ['prior generated memory', x => { x.context.relationship_state = { patient: [], supporter: [], relationship: [], unknowns: [] }; }],
  ['review decision injection', x => { x.review = { approved: true }; }],
  ['adapted input mislabeled synthetic route', x => { x.origin_type = 'adapted_from_source'; }],
  ['external question bank dependency', x => { x.resource_dependencies = [{ resource_id: 'question_bank' }]; }],
  ['risk tagged case', x => { x.risk_tags = ['risk']; }],
  ['source group without synthetic identity', x => { x.source_group_ids = ['observed-group']; }],
  ['field identity mismatch', x => { x.context.patient.fields.mood.id = 'another'; }],
];
for (const [name, mutate] of invalidCases) test(`rejects ${name}`, () => {
  const item = fixture(); mutate(item); assert.throws(() => validateInput(item));
});

for (const key of ['source_root_ids', 'source_group_ids']) test(`same ${key} cannot cross train and validation`, () => {
  const first = fixture(), second = fixture(); second.context_id = 'second'; second.split = 'validation';
  second.source_root_ids = ['synthetic:second-root']; second.source_group_ids = ['synthetic:second-group'];
  second[key] = first[key];
  assert.throws(() => assemble([first, second]), /cross_split_source_/);
});

test('different identities cannot conceal a whitespace/Unicode-equivalent cross-split prefix', () => {
  const first = fixture(), second = fixture(); second.context_id = 'second'; second.split = 'validation';
  second.source_root_ids = ['synthetic:second-root']; second.source_group_ids = ['synthetic:second-group'];
  for (const message of second.transcript.messages) message.content = ' \t' + message.content + '\u3000';
  assert.throws(() => assemble([first, second]), /duplicate_or_extended_transcript_prefix/);
});

test('a renamed extended conversation cannot cross a user cutoff already present in another context', () => {
  const first = fixture(), second = fixture(); second.context_id = 'second'; second.split = 'validation';
  second.source_root_ids = ['synthetic:second-root']; second.source_group_ids = ['synthetic:second-group'];
  second.transcript.messages.push({ message_id: 't4', role: 'user', content: 'Fixture subsequent input.' });
  second.transcript.cutoff_message_id = 't4';
  assert.throws(() => assemble([first, second]), /duplicate_or_extended_transcript_prefix/);
});

test('duplicate JSON keys, including escaped aliases and nested objects, cannot silently replace values', () => {
  for (const text of ['{"split":"train","split":"validation"}', '{"a":{"x":1,"\\u0078":2}}', '[{"x":[],"x":{}}]']) {
    assert.throws(() => parseStrictJSON(text), /duplicate_json_key/);
  }
  assert.deepEqual(parseStrictJSON('{"a":[null,true,false,1e2,"escaped \\\" quote"],"x":{"x":1}}'),
    { a: [null, true, false, 100, 'escaped " quote'], x: { x: 1 } });
});

test('malformed UTF-8, CRLF and blank physical rows are rejected', () => {
  assert.throws(() => parseSnapshot(Buffer.from([255])));
  assert.throws(() => parseSnapshot(Buffer.from('{}\r\n')), /snapshot_requires_lf/);
  assert.throws(() => parseSnapshot(Buffer.from('\n')), /empty_jsonl_row/);
});

test('fresh private build verifies byte-for-byte; metadata and mask tampering are rejected', () => {
  const base = resolve(fileURLToPath(new URL('../outputs/private/', import.meta.url)));
  mkdirSync(base, { recursive: true });
  const folder = mkdtempSync(resolve(base, '.app-stage-test-'));
  try {
    const input = resolve(folder, 'contexts.jsonl'), output = resolve(folder, 'export');
    writeFileSync(input, snapshot([fixture()]));
    assert.equal(run('build', input, output).stage_candidates, 2);
    assert.equal(run('verify', input, output).status, 'passed');
    assert.throws(() => run('build', input, output), /output_existence_contract/);
    const path = resolve(output, 'train.jsonl'), rows = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
    rows[0].loss_mask.values = [1, 1, 1]; rows[0].human_approved = true;
    writeFileSync(path, rows.map(row => JSON.stringify(row) + '\n').join(''));
    assert.throws(() => run('verify', input, output), /artifact_bytes_or_metadata_changed/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('mid-write failure publishes no directory and removes only its temporary staging directory', () => {
  const base = resolve(fileURLToPath(new URL('../outputs/private/', import.meta.url)));
  const folder = mkdtempSync(resolve(base, '.app-stage-failure-test-'));
  const input = resolve(folder, 'contexts.jsonl'), output = resolve(folder, 'export');
  writeFileSync(input, snapshot([fixture()]));
  const original = fs.writeFileSync;
  try {
    fs.writeFileSync = (path, ...args) => {
      if (String(path).endsWith('/train.jsonl')) throw new Error('synthetic_write_failure');
      return original(path, ...args);
    };
    syncBuiltinESMExports();
    assert.throws(() => run('build', input, output), /synthetic_write_failure/);
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(fs.readdirSync(folder), ['contexts.jsonl']);
  } finally {
    fs.writeFileSync = original; syncBuiltinESMExports(); rmSync(folder, { recursive: true, force: true });
  }
});
