/** Local Unicode character n-gram retrieval, not embeddings or clinical scoring.
 * Only explicitly supplied JSONL is read. Retrieved text is untrusted reference
 * material; this module never executes HTML, contacts a network, or trains.
 * Guidance requires reviewed=true. Dataset cases require deidentified=true and
 * provenance, or reviewed=true plus consent_cleared=true. Preparation flags are
 * source declarations, not an independent privacy or clinical certification.
 */
import { openSync, readSync, closeSync } from 'node:fs';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 8_000;
const MAX_DOCUMENTS = 10_000;
const MAX_RESULTS = 20;
const MAX_QUERY_CHARS = 32_000;

export type KnowledgeRecord = {
  id: string; title: string; text: string; kind: 'guidance' | 'representative_case';
  source_url?: string; reviewed?: boolean; consent_cleared?: boolean;
  deidentified?: boolean; provenance?: unknown; [key: string]: unknown;
};
export type SearchResult = Pick<KnowledgeRecord, 'id' | 'title' | 'text' | 'kind'> & { source_url: string };

export class KnowledgeValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'KnowledgeValidationError'; }
}

function readBounded(path: string, missingOk: boolean): Buffer | null {
  let descriptor: number;
  try { descriptor = openSync(path, 'r'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (missingOk) return null;
      throw new KnowledgeValidationError('Knowledge JSONL source does not exist');
    }
    throw error;
  }
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= MAX_FILE_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(65_536, MAX_FILE_BYTES + 1 - total));
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_FILE_BYTES) throw new KnowledgeValidationError('Knowledge JSONL exceeds the 10 MiB file limit');
      chunks.push(buffer.subarray(0, count));
    }
  } finally { closeSync(descriptor); }
  return Buffer.concat(chunks, total);
}

/** JSON.parse validates grammar; this additional scan rejects duplicate keys. */
function rejectDuplicateKeys(line: string): void {
  const stack: { object: boolean; keyExpected: boolean; keys: Set<string> }[] = [];
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === '"') {
      const start = index++;
      while (index < line.length) {
        if (line[index] === '\\') index += 2;
        else if (line[index] === '"') break;
        else index++;
      }
      const frame = stack.at(-1);
      if (frame?.object && frame.keyExpected) {
        const key = JSON.parse(line.slice(start, index + 1));
        if (frame.keys.has(key)) throw new Error('duplicate key');
        frame.keys.add(key);
        frame.keyExpected = false;
      }
    } else if (character === '{' || character === '[') {
      stack.push({ object: character === '{', keyExpected: true, keys: new Set() });
      if (stack.length > 64) throw new Error('JSON nesting exceeds 64 levels');
    } else if (character === '}' || character === ']') stack.pop();
    else if (character === ',' && stack.at(-1)?.object) stack.at(-1)!.keyExpected = true;
  }
}

function validateRecord(value: unknown, lineNumber: number, seen: Set<string>): KnowledgeRecord {
  const fail = (reason: string): never => { throw new KnowledgeValidationError(`Knowledge JSONL line ${lineNumber}: ${reason}`); };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('expected a JSON object');
  const row = value as Record<string, unknown>;
  for (const [field, maximum] of [['id', 128], ['title', 300], ['text', MAX_TEXT_CHARS]] as const) {
    const fieldValue = row[field];
    if (typeof fieldValue !== 'string' || !fieldValue.trim()) fail(`${field} must be a nonempty string`);
    if ((fieldValue as string).length > maximum) fail(`${field} exceeds ${maximum} characters`);
    if ((fieldValue as string).includes('\0')) fail(`${field} contains a null character`);
  }
  const id = row.id as string;
  if (id !== id.trim()) fail('id must not have surrounding whitespace');
  if (seen.has(id)) fail('duplicate id');
  if (row.kind !== 'guidance' && row.kind !== 'representative_case') fail('kind must be guidance or representative_case');
  for (const flag of ['reviewed', 'consent_cleared', 'deidentified']) {
    if (flag in row && typeof row[flag] !== 'boolean') fail(`${flag} must be a JSON boolean`);
  }
  if (row.kind === 'guidance' && row.reviewed !== true) fail('guidance requires reviewed=true');
  if (row.kind === 'representative_case') {
    const provenance = row.provenance;
    const hasProvenance = (typeof provenance === 'string' && Boolean(provenance.trim())) ||
      (provenance !== null && typeof provenance === 'object' && !Array.isArray(provenance) && Object.keys(provenance).length > 0);
    if (!((row.reviewed === true && row.consent_cleared === true) || (row.deidentified === true && hasProvenance))) {
      fail('case requires reviewed/consent_cleared=true, or deidentified=true with provenance');
    }
  }
  const url = 'source_url' in row ? row.source_url : '';
  if (typeof url !== 'string' || url.length > 2_048) fail('source_url must be a string of at most 2048 characters');
  if (url) {
    let parsed: URL;
    try { parsed = new URL(url as string); } catch { fail('source_url is invalid'); }
    if (!['http:', 'https:'].includes(parsed!.protocol) || !parsed!.hostname || parsed!.username || parsed!.password || /\s/u.test(url as string)) {
      fail('source_url must be an absolute HTTP(S) URL without credentials or whitespace');
    }
  }
  // All metadata must remain serializable without silently converting Infinity.
  const pending: unknown[] = [row];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'number' && !Number.isFinite(item)) fail('JSON contains a non-finite number');
    if (item !== null && typeof item === 'object') {
      for (const nested of Object.values(item)) pending.push(nested);
    }
  }
  seen.add(id);
  return row as KnowledgeRecord;
}

export function loadRecords(path: string, missingOk = false): KnowledgeRecord[] {
  const raw = readBounded(path, missingOk);
  if (raw === null) return [];
  let contents: string;
  try { contents = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/^\uFEFF/u, ''); }
  catch { throw new KnowledgeValidationError('Knowledge JSONL must be UTF-8'); }
  const records: KnowledgeRecord[] = [];
  const seen = new Set<string>();
  for (const [index, line] of contents.split('\n').entries()) {
    if (!line.trim()) continue;
    if (records.length >= MAX_DOCUMENTS) throw new KnowledgeValidationError(`Knowledge JSONL exceeds ${MAX_DOCUMENTS} records`);
    let row: unknown;
    try { row = JSON.parse(line); rejectDuplicateKeys(line); }
    catch { throw new KnowledgeValidationError(`Knowledge JSONL line ${index + 1}: malformed JSON`); }
    records.push(validateRecord(row, index + 1, seen));
  }
  return records;
}

function terms(text: string): Map<string, number> {
  const result = new Map<string, number>();
  const add = (term: string) => result.set(term, (result.get(term) ?? 0) + 1);
  for (const match of text.normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    add(`word:${word}`);
    for (const width of [2, 3]) {
      for (let index = 0; index <= word.length - width; index++) add(`gram:${word.slice(index, index + width)}`);
    }
  }
  return result;
}

export class KnowledgeBase {
  readonly path: string;
  private readonly documents: KnowledgeRecord[];
  private readonly postings = new Map<string, Map<number, number>>();
  private readonly idf = new Map<string, number>();
  private readonly norms: number[];

  constructor(path: string) {
    this.path = path;
    this.documents = loadRecords(path, true);
    for (const [index, row] of this.documents.entries()) {
      const features = terms(row.text);
      for (const [term, frequency] of terms(row.title)) features.set(term, (features.get(term) ?? 0) + frequency * 2);
      for (const [term, frequency] of features) {
        if (!this.postings.has(term)) this.postings.set(term, new Map());
        this.postings.get(term)!.set(index, 1 + Math.log(frequency));
      }
    }
    const normSquared = this.documents.map(() => 0);
    for (const [term, posting] of this.postings) {
      const inverseFrequency = Math.log((this.count + 1) / (posting.size + 1)) + 1;
      this.idf.set(term, inverseFrequency);
      for (const [index, frequency] of posting) normSquared[index] += (frequency * inverseFrequency) ** 2;
    }
    this.norms = normSquared.map(Math.sqrt);
  }

  get count(): number { return this.documents.length; }
  get records(): KnowledgeRecord[] { return structuredClone(this.documents); }

  /** TF-IDF cosine ranking; zero overlap is empty. Scores are not exposed as probabilities. */
  search(query: string, limit = 3): SearchResult[] {
    if (typeof query !== 'string') throw new TypeError('query must be a string');
    if (query.length > MAX_QUERY_CHARS) throw new RangeError(`query exceeds ${MAX_QUERY_CHARS} characters`);
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError('limit must be a nonnegative integer');
    if (!query.trim() || limit === 0 || this.count === 0) return [];
    const scores = new Map<number, number>();
    let queryNormSquared = 0;
    for (const [term, frequency] of terms(query)) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const inverseFrequency = this.idf.get(term)!;
      const queryWeight = (1 + Math.log(frequency)) * inverseFrequency;
      queryNormSquared += queryWeight ** 2;
      for (const [index, documentFrequency] of posting) {
        scores.set(index, (scores.get(index) ?? 0) + queryWeight * documentFrequency * inverseFrequency);
      }
    }
    if (scores.size === 0) return [];
    const queryNorm = Math.sqrt(queryNormSquared);
    const ranked = [...scores.keys()].sort((left, right) => {
      const difference = scores.get(right)! / (this.norms[right] * queryNorm) - scores.get(left)! / (this.norms[left] * queryNorm);
      return difference || (this.documents[left].id < this.documents[right].id ? -1 : this.documents[left].id > this.documents[right].id ? 1 : 0);
    });
    return ranked.slice(0, Math.min(limit, MAX_RESULTS)).map(index => {
      const { id, title, text, kind, source_url = '' } = this.documents[index];
      return { id, title, text, source_url, kind };
    });
  }
}
