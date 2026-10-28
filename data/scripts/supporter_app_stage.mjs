#!/usr/bin/env node
/**
 * Build/verify unapproved synthetic pairs for two existing app model stages.
 * Usage: node data/scripts/supporter_app_stage.mjs build|verify --input FILE --output DIR
 * Output must be a new, git-ignored directory below data/outputs/private/.
 * This tool performs no inference, tokenization, safety assessment or human review.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, existsSync, realpathSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';
import { normalizeAnswerContext, answerComponents } from '../../app/src/answer-sources.js';
import { relationshipStateRequest, validateSchema, assertRetrievedEvidence, canonicalRelationshipState } from '../../app/src/relationship-agent.js';
import { validateStateResult } from '../../app/src/agent-state.js';
import { OBSERVE, MEMORY, PROMPT_VERSION } from '../../app/src/relationship-prompts.js';

export const INPUT_SCHEMA = 'malssi-supporter-app-stage-input-v1';
export const OUTPUT_SCHEMA = 'malssi-supporter-app-stage-candidate-v1';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PRIVATE = resolve(ROOT, 'data/outputs/private');
const STAGES = ['state_observations', 'relationship_memory'];
const STATUSES = new Set(['answered', 'unknown', 'refused', 'skipped', 'auto_skipped', 'not_asked']);
const EMPTY_MEMORY = { patient: [], supporter: [], relationship: [], unknowns: [] };
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const jsonHash = value => sha256(JSON.stringify(value));
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function requireThat(condition, code) { if (!condition) throw new Error(code); }
function exactKeys(value, keys, code) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort()), code);
}
function identifiers(values) {
  return Array.isArray(values) && values.length > 0 && new Set(values).size === values.length &&
    values.every(value => nonempty(value) && value.startsWith('synthetic:') && value.length > 10);
}
const normalized = text => text.normalize('NFKC').replace(/\s/gu, '');

/** JSON.parse validates syntax, then this lexical walk rejects duplicate keys.
 * Keys are decoded before comparison, including escaped Unicode spellings.
 * The walk does not reconstruct or canonicalize the source snapshot bytes.
 */
export function parseStrictJSON(text) {
  const parsed = JSON.parse(text);
  let offset = 0;
  const whitespace = () => { while (/[\x20\t\r\n]/u.test(text[offset] || '\0')) offset++; };
  const stringToken = () => {
    const start = offset++;
    while (text[offset] !== '"') {
      if (text[offset] === '\\') offset++;
      offset++;
    }
    offset++;
    return JSON.parse(text.slice(start, offset));
  };
  const value = () => {
    whitespace();
    if (text[offset] === '{') {
      offset++; whitespace(); const keys = new Set();
      if (text[offset] !== '}') while (true) {
        const key = stringToken();
        requireThat(!keys.has(key), 'duplicate_json_key'); keys.add(key);
        whitespace(); offset++; value(); whitespace();
        if (text[offset] === '}') break;
        offset++; whitespace();
      }
      offset++;
    } else if (text[offset] === '[') {
      offset++; whitespace();
      if (text[offset] !== ']') while (true) {
        value(); whitespace(); if (text[offset] === ']') break; offset++;
      }
      offset++;
    } else if (text[offset] === '"') stringToken();
    else while (offset < text.length && !/[\x20\t\r\n,}\]]/u.test(text[offset])) offset++;
  };
  value();
  return parsed;
}

/** Physical LF boundaries only: U+2028/U+2029 inside content remain characters. */
export function parseSnapshot(bytes) {
  requireThat(Buffer.isBuffer(bytes), 'snapshot_must_be_bytes');
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  requireThat(!bytes.includes(13), 'snapshot_requires_lf_not_crlf');
  const rows = [];
  for (let start = 0; start < bytes.length;) {
    const newline = bytes.indexOf(10, start);
    const end = newline < 0 ? bytes.length : newline + 1;
    const raw = bytes.subarray(start, end);
    requireThat(raw.toString('utf8').trim().length > 0, 'empty_jsonl_row');
    const value = parseStrictJSON(raw.toString('utf8'));
    rows.push({ value, raw_sha256: sha256(raw) });
    start = end;
  }
  requireThat(rows.length > 0, 'empty_snapshot');
  return rows;
}

function validateTranscript(transcript) {
  exactKeys(transcript, ['messages', 'cutoff_message_id'], 'transcript_keys');
  requireThat(Array.isArray(transcript.messages) && transcript.messages.length > 0, 'transcript_messages');
  const seen = new Set();
  for (const message of transcript.messages) {
    exactKeys(message, ['message_id', 'role', 'content'], 'transcript_message_keys');
    requireThat(nonempty(message.message_id) && !seen.has(message.message_id), 'transcript_message_identity');
    seen.add(message.message_id);
    requireThat(['user', 'assistant'].includes(message.role) && nonempty(message.content), 'transcript_message_content');
  }
  const last = transcript.messages.at(-1);
  requireThat(last.role === 'user' && last.message_id === transcript.cutoff_message_id, 'prefix_cutoff_or_future_message');
}

function fieldsOf(context) {
  const result = [];
  for (const subject of ['patient', 'supporter']) {
    requireThat(context[subject] && typeof context[subject].fields === 'object' && !Array.isArray(context[subject].fields), 'context_subject_fields');
    for (const [key, field] of Object.entries(context[subject].fields)) {
      requireThat(field?.id === key, 'field_key_identity');
      result.push({ subject, field });
    }
  }
  requireThat(context.user_goal && typeof context.user_goal === 'object' && !Array.isArray(context.user_goal), 'context_user_goal');
  for (const [key, field] of Object.entries(context.user_goal)) {
    requireThat(['message', 'desired_outcomes'].includes(key) && field?.id === (key === 'message' ? 'want' : 'goal'), 'context_goal_identity');
    result.push({ subject: 'user_goal', field });
  }
  return result;
}

/** All source components must already occur in visible user input, not gold targets. */
function contextProvenance(context, transcript) {
  requireThat(context && typeof context === 'object' && !Array.isArray(context), 'context_object');
  requireThat(nonempty(context.question_set_version), 'question_set_version_required');
  requireThat(isDeepStrictEqual(normalizeAnswerContext(context), context), 'context_must_already_be_normalized');
  for (const key of ['relationship_state', 'agent_state']) requireThat(context[key] == null, 'prior_generated_memory_not_supported');
  const fields = fieldsOf(context);
  const references = [];
  for (const { subject, field } of fields) {
    requireThat(STATUSES.has(field.status) && nonempty(field.question), 'field_status_or_question');
    if (field.subject !== undefined) requireThat(field.subject === subject, 'field_subject_conflict');
    for (const component of answerComponents(field)) {
      const occurrences = [];
      for (const [message_index, message] of transcript.messages.entries()) {
        if (message.role !== 'user') continue;
        let offset = 0;
        while (offset <= message.content.length) {
          const found = message.content.indexOf(component.text, offset);
          if (found < 0) break;
          const start_char = Array.from(message.content.slice(0, found)).length;
          occurrences.push({ message_index, start_char, end_char: start_char + Array.from(component.text).length });
          offset = found + Math.max(1, component.text.length);
        }
      }
      requireThat(occurrences.length > 0, 'context_component_outside_visible_user_prefix');
      references.push({ subject, question_id: field.id, origin: component.origin, fields: component.fields,
        text_sha256: sha256(component.text), occurrences, unique_source_occurrence: occurrences.length === 1 });
    }
  }
  if (context.latest_answer != null) {
    exactKeys(context.latest_answer, ['subject', 'question_id'], 'latest_answer_keys');
    requireThat(fields.some(({ subject, field }) => subject === context.latest_answer.subject && field.id === context.latest_answer.question_id), 'latest_answer_outside_context');
  }
  return references;
}

export function validateInput(value) {
  exactKeys(value, ['schema_version', 'context_id', 'origin_type', 'author_id', 'authored_at', 'source_root_ids',
    'source_group_ids', 'split', 'safety_scope', 'risk_tags', 'resource_dependencies', 'transcript', 'context', 'targets'], 'input_keys');
  requireThat(value.schema_version === INPUT_SCHEMA && nonempty(value.context_id), 'input_schema_or_identity');
  requireThat(value.origin_type === 'synthetic_scenario' && nonempty(value.author_id), 'synthetic_authorship_required');
  requireThat(nonempty(value.authored_at) && Number.isFinite(Date.parse(value.authored_at)), 'authorship_timestamp');
  requireThat(identifiers(value.source_root_ids) && identifiers(value.source_group_ids), 'synthetic_roots_groups_required');
  requireThat(['train', 'validation'].includes(value.split), 'invalid_split');
  requireThat(value.safety_scope === 'non_acute_communication' && isDeepStrictEqual(value.risk_tags, []) &&
    isDeepStrictEqual(value.resource_dependencies, []), 'nonacute_no_resources_scope_only');
  validateTranscript(value.transcript);
  exactKeys(value.targets, STAGES, 'target_stage_keys');
  const source_references = contextProvenance(value.context, value.transcript);
  const request = relationshipStateRequest(value.context, null, false);
  const observationSchema = structuredClone(request.schema);
  delete observationSchema.properties.relationship_memory;
  observationSchema.required = observationSchema.required.filter(key => key !== 'relationship_memory');
  const memorySchema = { type: 'object', properties: { relationship_memory: request.schema.properties.relationship_memory },
    required: ['relationship_memory'], additionalProperties: false };
  const observations = value.targets.state_observations;
  const memory = value.targets.relationship_memory;
  validateSchema(observations, observationSchema);
  assertRetrievedEvidence(observations, request.retrieval);
  canonicalRelationshipState({ ...observations, relationship_memory: EMPTY_MEMORY }, value.context, request.schema);
  validateSchema(memory, memorySchema);
  requireThat(memory.relationship_memory.relationship.length === 0, 'reported_only_no_relationship_hypotheses');
  for (const subject of ['patient', 'supporter']) for (const finding of memory.relationship_memory[subject]) {
    requireThat(finding.certainty === 'reported' && !Object.hasOwn(finding, 'interpretation'), 'reported_only_memory');
  }
  assertRetrievedEvidence(memory, request.retrieval);
  const canonical = canonicalRelationshipState({ ...observations, ...memory }, value.context, request.schema);
  validateStateResult({ patient_state: canonical.patient_state, name_index: canonical.name_index, question_plan: { skip: [] } }, value.context);
  const { prior_state, prior_relationship_memory, ...raw } = request.data;
  return { source_references, stages: [
    { stage: STAGES[0], prompt: OBSERVE, data: raw, schema: observationSchema, target: observations },
    { stage: STAGES[1], prompt: MEMORY, data: { ...raw, observations, prior_relationship_memory }, schema: memorySchema, target: memory },
  ] };
}

export function dependencyHashes() {
  const found = new Map();
  const visit = path => {
    path = resolve(path);
    if (found.has(path)) return;
    const bytes = readFileSync(path);
    found.set(path, sha256(bytes));
    if (!/\.[cm]?js$/.test(path)) return;
    for (const match of bytes.toString('utf8').matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/gu)) visit(resolve(dirname(path), match[1]));
  };
  visit(fileURLToPath(import.meta.url));
  // This source defines the actual wire and per-stage cap; no gateway is run.
  visit(resolve(ROOT, 'app/src/model.js'));
  return Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)).map(([path, hash]) => [relative(ROOT, path), hash]));
}

export function assembleBundle(snapshot, dependencies = dependencyHashes()) {
  const rows = parseSnapshot(snapshot), records = { train: [], validation: [] }, maps = [];
  const ids = new Set(), groups = new Map(), roots = new Map(), prefixes = new Map(), wires = new Map();
  const claimSplit = (map, key, split, error) => {
    requireThat(!map.has(key) || map.get(key) === split, error); map.set(key, split);
  };
  for (const [row_index, { value, raw_sha256 }] of rows.entries()) {
    requireThat(!ids.has(value.context_id), 'duplicate_context_id'); ids.add(value.context_id);
    const checked = validateInput(value);
    for (const root of value.source_root_ids) claimSplit(roots, root, value.split, 'cross_split_source_root');
    for (const group of value.source_group_ids) claimSplit(groups, group, value.split, 'cross_split_source_group');
    const dialogue = value.transcript.messages.map(({ role, content }) => [role, normalized(content)]);
    for (let index = 0; index < dialogue.length; index++) if (dialogue[index][0] === 'user') {
      const key = jsonHash(dialogue.slice(0, index + 1));
      requireThat(!prefixes.has(key), 'duplicate_or_extended_transcript_prefix');
      prefixes.set(key, value.split);
    }
    const contextHash = jsonHash(value.context), transcriptHash = jsonHash(value.transcript);
    maps.push({ source_row_index: row_index, source_row_sha256: raw_sha256, context_sha256: contextHash,
      transcript_sha256: transcriptHash, source_references: checked.source_references });
    for (const stage of checked.stages) {
      const input = [ { role: 'system', content: stage.prompt },
        { role: 'user', content: JSON.stringify({ stage: stage.stage, data: stage.data, output_schema: stage.schema }) } ];
      claimSplit(wires, jsonHash(input.map(({ role, content }) => [role, normalized(content)])), value.split, 'cross_split_normalized_stage_input');
      const messages = [...input, { role: 'assistant', content: JSON.stringify(stage.target) }];
      records[value.split].push({ schema_version: OUTPUT_SCHEMA,
        candidate_id: sha256(JSON.stringify([value.context_id, stage.stage])), task: stage.stage, split: value.split,
        origin_type: value.origin_type, source_root_ids: value.source_root_ids, source_group_ids: value.source_group_ids,
        authorship: { author_id: value.author_id, authored_at: value.authored_at },
        quality_status: 'authored_ai_draft_requires_external_review', semantic_review_embedded: false,
        human_approved: false, expert_reviewed: false, training_allowed: false,
        messages, loss_mask: { unit: 'message', values: [0, 0, 1], token_mask_materialized: false },
        provenance: { source_row_index: row_index, source_row_sha256: raw_sha256, context_sha256: contextHash,
          transcript_sha256: transcriptHash, prompt_version: PROMPT_VERSION, prompt_sha256: sha256(stage.prompt),
          output_schema_sha256: jsonHash(stage.schema), upstream_observations: stage.stage === 'relationship_memory' ? 'authored_gold_teacher_forcing' : 'none',
          derived_from_same_context: true, independent_observation: false, transcript_sent_as_chat_messages: false,
          runtime_wire_includes_current_answers_retrieval_and_schema: true },
        evaluation_budget: { input_ceiling: 65536, output_reservation: 8192, total_ceiling: 69632, effective_input_ceiling: 61440,
          actual_app_stage_max_tokens: 1800, tokenizer_verified: false, token_lengths: null, budget_admitted: false },
      });
    }
  }
  const encodeRows = values => Buffer.from(values.map(value => JSON.stringify(value) + '\n').join(''));
  const files = new Map([['input_snapshot.jsonl', snapshot], ['train.jsonl', encodeRows(records.train)],
    ['validation.jsonl', encodeRows(records.validation)], ['source_provenance.jsonl', encodeRows(maps)]]);
  const manifest = { schema_version: 'malssi-supporter-app-stage-export-v1', input_sha256: sha256(snapshot),
    source_contexts: rows.length, stage_candidates: records.train.length + records.validation.length,
    stage_candidates_by_split: { train: records.train.length, validation: records.validation.length },
    tasks: STAGES, independent_units: 'source synthetic scenario families; stage pairs are dependent views',
    status: 'experimental_ai_draft', human_approved: false, training_allowed: false, tokenizer_verified: false,
    model_or_api_called: false, semantic_review_embedded: false, external_content_bound_ai_review_required: true,
    clinical_or_safety_validation: false,
    source_snapshot_exact_bytes: true, transcript_and_context_values_unchanged: true,
    message_level_target_only_mask: true, actual_token_mask_verified: false,
    exact_normalized_cross_split_prefix_check: true, all_user_cutoff_prefixes_checked: true,
    duplicate_json_keys_rejected: true, semantic_or_partial_exposure_check: false,
    procedural_validation_only: true, prompt_version: PROMPT_VERSION, dependencies_sha256: dependencies,
    files_sha256: Object.fromEntries([...files].map(([name, bytes]) => [name, sha256(bytes)])),
  };
  files.set('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n'));
  return { files, manifest };
}

function privatePath(path) {
  const absolute = resolve(path);
  requireThat(absolute.startsWith(PRIVATE + sep), 'output_must_be_private');
  // This repository intentionally maps outputs/private to its ignored dataset
  // store. Trust that fixed root, then reject any nested symlink redirection.
  const privateReal = realpathSync(PRIVATE);
  const physical = resolve(privateReal, relative(PRIVATE, absolute));
  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  requireThat(realpathSync(ancestor) === resolve(privateReal, relative(PRIVATE, ancestor)), 'output_symlink_ancestor');
  execFileSync('git', ['check-ignore', '--quiet', '--', physical], { cwd: ROOT, stdio: 'ignore' });
  return physical;
}

export function run(command, inputPath, outputPath) {
  requireThat(['build', 'verify'].includes(command), 'command_must_be_build_or_verify');
  const output = privatePath(outputPath);
  requireThat(command === 'verify' ? existsSync(output) : !existsSync(output), 'output_existence_contract');
  const before = dependencyHashes(), snapshot = readFileSync(inputPath), assembled = assembleBundle(snapshot, before);
  requireThat(sha256(readFileSync(inputPath)) === sha256(snapshot), 'input_changed_during_build');
  requireThat(isDeepStrictEqual(before, dependencyHashes()), 'dependencies_changed_during_build');
  const verifyFiles = directory => {
    requireThat(isDeepStrictEqual(readdirSync(directory).sort(), [...assembled.files.keys()].sort()), 'artifact_set_changed');
    for (const [name, bytes] of assembled.files) {
      const path = resolve(directory, name);
      requireThat(statSync(path).isFile() && realpathSync(path) === path, 'artifact_not_regular_file');
      requireThat(readFileSync(path).equals(bytes), 'artifact_bytes_or_metadata_changed');
    }
  };
  if (command === 'build') {
    mkdirSync(dirname(output), { recursive: true });
    const temporary = mkdtempSync(resolve(dirname(output), '.supporter-app-stage-'));
    try {
      for (const [name, bytes] of assembled.files) writeFileSync(resolve(temporary, name), bytes, { flag: 'wx' });
      verifyFiles(temporary);
      requireThat(sha256(readFileSync(inputPath)) === sha256(snapshot), 'input_changed_before_publish');
      requireThat(isDeepStrictEqual(before, dependencyHashes()), 'dependencies_changed_before_publish');
      requireThat(!existsSync(output), 'output_appeared_before_publish');
      renameSync(temporary, output);
    } finally { if (existsSync(temporary)) rmSync(temporary, { recursive: true, force: true }); }
  } else verifyFiles(output);
  return { status: 'passed', command, source_contexts: assembled.manifest.source_contexts,
    stage_candidates: assembled.manifest.stage_candidates, stage_candidates_by_split: assembled.manifest.stage_candidates_by_split,
    input_sha256: assembled.manifest.input_sha256, manifest_sha256: sha256(assembled.files.get('manifest.json')),
    dependency_files: Object.keys(before).length, tokenizer_verified: false, human_approved: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, ...args] = process.argv.slice(2);
    requireThat(args.length === 4 && args[0] === '--input' && args[2] === '--output', 'usage_build_or_verify_input_output');
    process.stdout.write(JSON.stringify(run(command, args[1], args[3])) + '\n');
  } catch (error) {
    // Never print a stack, raw input, failed quote, author, context or source ID.
    const known = /^[a-z][a-z0-9_]+$/.test(error.message || '') ? error.message : 'validation_or_io_failed';
    process.stderr.write(JSON.stringify({ status: 'failed', reason: error.modelReason || known }) + '\n');
    process.exitCode = 1;
  }
}
