/** Build a private representative-case index from an explicitly reviewed selection.
 * The public repository contains no counseling excerpts, participant IDs or source
 * manifest. A private selection file supplies reviewed ranges and pinned hashes.
 * Does not download data, invoke models or alter the source CSV.
 */
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KnowledgeBase } from '../src/knowledge.ts';
import type { KnowledgeRecord } from '../src/knowledge.ts';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const sha256 = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
export type CaseSelection = {
  schema_version: 1;
  source_filename: string;
  source_file_sha256: string;
  source_url: string;
  label_method: string;
  data_permission_verified: true;
  selected_excerpts_reviewed: true;
  records: Array<{ id: string; title: string; source_row_index: number; label: string; label_id: number; start_character: number; end_character_exclusive: number; excerpt_sha256: string }>;
};
/** RFC4180-style CSV parser; handles commas, escaped quotes and quoted newlines. */
export function* parseCsv(text: string): Generator<string[]> {
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let afterQuote = false;
  const input = text.replace(/^\uFEFF/u, '');
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') { field += '"'; index++; }
        else { quoted = false; afterQuote = true; }
      } else field += character;
      continue;
    }
    if (character === ',' || character === '\n' || character === '\r') {
      row.push(field); field = ''; afterQuote = false;
      if (character !== ',') {
        if (character === '\r' && input[index + 1] === '\n') index++;
        yield row; row = [];
      }
    } else if (character === '"' && field === '' && !afterQuote) quoted = true;
    else {
      if (afterQuote || character === '"') throw new Error('Malformed CSV quoting');
      field += character;
    }
  }
  if (quoted) throw new Error('Unterminated quoted CSV field');
  if (field !== '' || row.length || afterQuote) { row.push(field); yield row; }
}

function readSourceBounded(path: string): Buffer {
  const descriptor = openSync(path, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= MAX_SOURCE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(1_048_576, MAX_SOURCE_BYTES + 1 - total));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_SOURCE_BYTES) throw new Error('Source exceeds 64 MiB bound');
      chunks.push(chunk.subarray(0, count));
    }
  } finally { closeSync(descriptor); }
  return Buffer.concat(chunks, total);
}


export function screenExcerpt(text: string): void {
  // Additional conservative screening, not a general de-identification guarantee.
  if (text.length < 35 || text.length > 500) throw new Error('Selected excerpt must contain 35 to 500 characters');
  if (/[@0-9A-Za-z]|https?:\/\/|www\./u.test(text)) throw new Error('Selected excerpt contains a numeric, Latin, contact or placeholder token');
  if (/[가-힣]{2,4}\s*(?:씨|군|양)(?:은|는|이|가|에게|한테)?(?:\s|[,\.])/u.test(text)) throw new Error('Selected excerpt may contain a personal-name form');
  for (const value of ['주민등록', '전화번호', '주소는', '학교명', '회사명', '서울', '부산', '인천', '대구', '제주', '강남']) {
    if (text.includes(value)) throw new Error('Selected excerpt contains a possible direct identifier or place');
  }
}
function selection(path: string): CaseSelection {
  const bytes = readFileSync(path);
  if (bytes.length > 1024 * 1024) throw new Error('Selection exceeds 1 MiB');
  let value: any;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('Selection must be valid UTF-8 JSON'); }
  if (!value || value.schema_version !== 1 || value.data_permission_verified !== true || value.selected_excerpts_reviewed !== true) throw new Error('Selection requires schema version, permission and excerpt review declarations');
  if (typeof value.source_filename !== 'string' || basename(value.source_filename) !== value.source_filename || !/^[A-Za-z0-9_.-]+\.csv$/u.test(value.source_filename)) throw new Error('Selection source_filename must be a CSV basename');
  if (!/^[a-f0-9]{64}$/u.test(value.source_file_sha256) || typeof value.label_method !== 'string' || !value.label_method.trim()) throw new Error('Selection source hash and label method are required');
  const url = new URL(value.source_url);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Selection source URL must use HTTP(S) without credentials');
  if (!Array.isArray(value.records) || value.records.length < 1 || value.records.length > 200) throw new Error('Selection requires 1 to 200 reviewed records');
  const ids = new Set(), rows = new Set();
  for (const row of value.records) {
    if (!row || typeof row.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/u.test(row.id) || ids.has(row.id)) throw new Error('Selection record IDs must be unique stable identifiers');
    if (typeof row.title !== 'string' || !row.title.trim() || row.title.length > 300) throw new Error('Selection titles are required');
    if (!Number.isInteger(row.source_row_index) || row.source_row_index < 1 || rows.has(row.source_row_index)) throw new Error('Selection source rows must be unique positive integers');
    if (!Number.isInteger(row.label_id) || row.label_id < 0 || row.label_id > 3 || !['우울', '중독', '불안', '기타'].includes(row.label)) throw new Error('Selection has an unsupported source category');
    if (['우울', '중독', '불안', '기타'][row.label_id] !== row.label) throw new Error('Selection category label differs from label_id');
    if (!Number.isInteger(row.start_character) || row.start_character < 0 || !Number.isInteger(row.end_character_exclusive) || row.end_character_exclusive <= row.start_character || !/^[a-f0-9]{64}$/u.test(row.excerpt_sha256)) throw new Error('Selection requires exact ranges and excerpt hashes');
    ids.add(row.id); rows.add(row.source_row_index);
  }
  return value;
}

export function buildCases(datasetDir: string, selectionPath: string): { records: KnowledgeRecord[]; manifest: Record<string, unknown> } {
  const selected = selection(selectionPath);
  const sourceRoot = realpathSync(datasetDir), sourcePath = resolve(sourceRoot, selected.source_filename);
  if (lstatSync(sourcePath).isSymbolicLink() || !within(sourceRoot, realpathSync(sourcePath))) throw new Error('Source CSV must be a regular file in the supplied dataset directory');
  const source = readSourceBounded(sourcePath);
  if (sha256(source) !== selected.source_file_sha256) throw new Error('Source hash differs from the reviewed selection');
  const selectedRows = new Set(selected.records.map(row => row.source_row_index));
  const rows = new Map<number, Record<string, string>>();
  const csv = parseCsv(new TextDecoder('utf-8', { fatal: true }).decode(source));
  const header = csv.next().value as string[] | undefined;
  const required = ['text', 'label', 'label_id', 'split', 'participant_id', 'label_method', 'quality_flags'];
  if (!header || !required.every(column => header.includes(column)) || new Set(header).size !== header.length) throw new Error('Required source columns missing or repeated');
  let rowCount = 0;
  for (const values of csv) {
    if (values.length === 1 && values[0] === '') continue;
    rowCount++;
    if (values.length !== header.length) throw new Error('CSV column count differs');
    if (selectedRows.has(rowCount)) rows.set(rowCount, Object.fromEntries(header.map((column, index) => [column, values[index]])));
  }
  if (rows.size !== selectedRows.size) throw new Error('A selected source row is missing');
  const counts: Record<string, number> = {}, participants = new Set<string>();
  const records: KnowledgeRecord[] = [];
  for (const chosen of selected.records) {
    const row = rows.get(chosen.source_row_index)!;
    if (row.split !== 'train' || row.label !== chosen.label || row.label_id !== String(chosen.label_id) || row.label_method !== selected.label_method || row.quality_flags) throw new Error('Selected source category, split, quality or label method differs');
    if (!row.participant_id || participants.has(row.participant_id)) throw new Error('Selection needs distinct, nonempty source participant IDs');
    participants.add(row.participant_id);
    if (chosen.end_character_exclusive > row.text.length) throw new Error('Selected range exceeds source text');
    const excerpt = row.text.slice(chosen.start_character, chosen.end_character_exclusive);
    if (sha256(excerpt) !== chosen.excerpt_sha256) throw new Error('Selected excerpt hash differs');
    screenExcerpt(excerpt);
    counts[chosen.label] = (counts[chosen.label] ?? 0) + 1;
    records.push({
      id: chosen.id, title: chosen.title,
      text: '참고 사례: 원자료 내담자 발화의 일부입니다. 데이터 분류: ' + chosen.label + '. 이 분류는 상담 회기에서 상속한 분류이며 발화 자체의 진단·심각도·치료효과 판정이 아닙니다.\n원문 발췌: ' + excerpt + '\n용도: 주변인의 의사소통 맥락 이해를 위한 참고입니다. 현재 대상자에 관한 사실이나 권장 치료를 뜻하지 않습니다.',
      source_url: selected.source_url, kind: 'representative_case', deidentified: true,
      provenance: {
        source_file_sha256: selected.source_file_sha256, source_row_index: chosen.source_row_index,
        source_row_index_base: '1-based CSV data record, excluding header', source_text_sha256: sha256(row.text),
        excerpt_sha256: sha256(excerpt), excerpt_start_character: chosen.start_character,
        excerpt_end_character_exclusive: chosen.end_character_exclusive, character_index_unit: 'UTF-16 code units',
        split: 'train', label: chosen.label, label_id: chosen.label_id, label_method: selected.label_method,
        purpose: 'communication example not diagnosis', deidentification_scope: 'selected excerpt only; source-declared review, not an independent audit',
      },
    });
  }
  return { records, manifest: {
    selection_revision: 'private-selection-v1', record_count: records.length, records_by_source_label: counts,
    selected_source_participant_count: participants.size, source_sha256: selected.source_file_sha256,
    source_data_record_count: rowCount, source_url: selected.source_url, source_split: 'train',
    validation_data_read: false, word_data_read: false, source_modified: false, synthetic_counseling_passages_added: 0,
    source_label_meaning: 'Session-level weak labels, not clinical severity',
    license: 'Original data terms apply; this derived index grants no redistribution rights',
    clinical_review: false, records: records.map(record => ({ id: record.id, ...(record.provenance as object) })),
  } };
}
function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}
function assertOutputPath(path: string, sourceRoot: string): void {
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (realpathSync(ancestor) !== ancestor) throw new Error('Output path contains a symlink');
  if (within(sourceRoot, path)) throw new Error('Outputs must be outside the source dataset directory');
}
export function main(args = process.argv.slice(2)): number {
  try {
    const options: Record<string, string | boolean> = {};
    for (let index = 0; index < args.length; index++) {
      const option = args[index];
      if (Object.hasOwn(options, option)) throw new Error('Repeated argument');
      if (option === '--verify-only') options[option] = true;
      else if (['--dataset-dir', '--selection', '--destination', '--manifest'].includes(option) && args[index + 1] && !args[index + 1].startsWith('--')) options[option] = args[++index];
      else throw new Error('Unknown or incomplete argument');
    }
    for (const key of ['--dataset-dir', '--selection', '--destination', '--manifest']) if (!options[key]) throw new Error(key + ' is required');
    const sourceRoot = realpathSync(resolve(options['--dataset-dir'] as string));
    const selectionPath = resolve(options['--selection'] as string), destination = resolve(options['--destination'] as string), manifestPath = resolve(options['--manifest'] as string);
    if (new Set([destination, manifestPath, selectionPath]).size !== 3) throw new Error('Output and selection files must be separate');
    assertOutputPath(destination, sourceRoot); assertOutputPath(manifestPath, sourceRoot);
    const { records, manifest } = buildCases(sourceRoot, selectionPath);
    const indexBytes = Buffer.from(records.map(record => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    manifest.knowledge_file_sha256 = sha256(indexBytes);
    const outputs: [string, Buffer][] = [[destination, indexBytes], [manifestPath, Buffer.from(JSON.stringify(manifest, null, 2) + '\n')]];
    for (const [path, expected] of outputs) {
      if (existsSync(path) && !readFileSync(path).equals(expected)) throw new Error('Existing artifact differs; it was not replaced');
      if (!existsSync(path) && options['--verify-only']) throw new Error('Artifact is missing');
    }
    for (const [path, expected] of outputs) {
      if (!existsSync(path)) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, expected, { flag: 'wx', mode: 0o600 }); }
    }
    if (new KnowledgeBase(destination).count !== records.length) throw new Error('Index count mismatch');
    console.log(JSON.stringify({ record_count: records.length, by_label: manifest.records_by_source_label, knowledge_sha256: manifest.knowledge_file_sha256, verify_only: Boolean(options['--verify-only']) }));
    return 0;
  } catch (error) {
    // Messages are bounded validation descriptions; source data is never printed.
    console.error('Representative-case build failed: ' + (error as Error).message);
    return 2;
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = main();
