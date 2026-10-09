/** Synthetic lexical fixtures are test strings, not supplied care guidance. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeBase, KnowledgeValidationError, loadRecords, MAX_FILE_BYTES, MAX_TEXT_CHARS } from '../src/knowledge.ts';
import { parseCsv, screenExcerpt, buildCases, main } from '../scripts/build-cases.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'hop-knowledge-'));
  t.after(() => { for (const name of readdirSync(directory)) unlinkSync(join(directory, name)); rmdirSync(directory); });
  const path = join(directory, 'index.jsonl');
  return { directory, path, write: (rows: unknown[]) => writeFileSync(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n', 'utf8') };
}
const guidance = (id = 'one', title = '검색 검사', text = '한글 검색 검사용 문장입니다.', extra: Record<string, unknown> = {}) =>
  ({ id, title, text, kind: 'guidance', reviewed: true, ...extra });

test('absent configured index is empty; explicit load needs a source', t => {
  const { path } = fixture(t);
  assert.equal(new KnowledgeBase(path).count, 0);
  assert.deepEqual(new KnowledgeBase(path).search('불안'), []);
  assert.throws(() => loadRecords(path), KnowledgeValidationError);
});

test('Korean inflection retrieval and output contract', t => {
  const { path, write } = fixture(t);
  write([guidance('sleep', '수면 기록', '불면으로 잠들기 어렵다는 문장입니다.'), guidance('anxiety', '불안 기록', '불안감과 초조함이라는 단어를 포함한 검색 검사입니다.'), guidance('relationship', '관계 기록', '친구와 대화하고 연락했다는 문장입니다.')]);
  const knowledge = new KnowledgeBase(path);
  assert.equal(knowledge.search('불안하고 초조합니다', 1)[0].id, 'anxiety');
  assert.equal(knowledge.search('불면입니다', 1)[0].id, 'sleep');
  assert.equal(knowledge.search('친구에게 연락', 1)[0].id, 'relationship');
  assert.deepEqual(Object.keys(knowledge.search('불안')[0]).sort(), ['id', 'kind', 'source_url', 'text', 'title']);
});

test('no lexical overlap never returns arbitrary passages', t => {
  const { path, write } = fixture(t);
  write([guidance('one', '한글', '가나다라마바사')]);
  const knowledge = new KnowledgeBase(path);
  for (const query of ['', ' ', '???', 'xyzzyq', '우주망원경']) assert.deepEqual(knowledge.search(query), []);
  assert.deepEqual(knowledge.search('한글', 0), []);
});

test('Unicode normalization and deterministic ties', t => {
  const { path, write } = fixture(t);
  write([guidance('z', '검색', 'ＡＢＣ 사례'), guidance('a', '검색', 'ABC 사례')]);
  assert.deepEqual(new KnowledgeBase(path).search('abc').map(row => row.id), ['a', 'z']);
});

test('duplicates reject the entire index', t => {
  const { path, write } = fixture(t);
  write([guidance(), guidance()]);
  assert.throws(() => new KnowledgeBase(path), /line 2: duplicate id/);
});

test('malformed JSON, duplicate object keys, nested duplicate keys, and nonfinite numbers rejected', t => {
  const { path } = fixture(t);
  for (const text of ['{broken', '{"id":"a","id":"b"}', '{"x":NaN}', '[]', '"text"', '{"id":"one","title":"t","text":"t","kind":"guidance","reviewed":true,"provenance":{"x":1,"x":2}}', '{"id":"one","title":"t","text":"t","kind":"guidance","reviewed":true,"x":1e999}']) {
    writeFileSync(path, text);
    assert.throws(() => new KnowledgeBase(path), KnowledgeValidationError);
  }
});

test('guidance must have boolean review flag', t => {
  const { path, write } = fixture(t);
  for (const reviewed of [false, null, 'true', 1]) {
    write([guidance('one', '검색', '문장', { reviewed })]);
    assert.throws(() => new KnowledgeBase(path), KnowledgeValidationError);
  }
});

test('representative case accepts supplied deidentified provenance or reviewed consent', t => {
  const { path, write } = fixture(t);
  const base = { id: 'case', title: '검색용 사례', text: '가나다라마바사', kind: 'representative_case' };
  for (const extra of [{ reviewed: true, consent_cleared: true }, { deidentified: true, provenance: { dataset: 'test-only' } }]) {
    write([{ ...base, ...extra }]);
    assert.equal(new KnowledgeBase(path).count, 1);
  }
  for (const extra of [{}, { reviewed: true }, { consent_cleared: true }, { deidentified: true }, { deidentified: true, provenance: {} }, { deidentified: false, provenance: 'test' }]) {
    write([{ ...base, ...extra }]);
    assert.throws(() => new KnowledgeBase(path), KnowledgeValidationError);
  }
});

test('invalid fields and executable URLs rejected', t => {
  const { path, write } = fixture(t);
  for (const extra of [{ id: ' ' }, { id: ' a' }, { title: '' }, { text: 42 }, { text: 'x'.repeat(MAX_TEXT_CHARS + 1) }, { kind: 'diagnosis' }, { kind: [] }, { source_url: 'javascript:alert(1)' }, { source_url: 'https://example.org/ bad' }]) {
    write([guidance('one', '검색', '문장', extra)]);
    assert.throws(() => new KnowledgeBase(path), KnowledgeValidationError);
  }
});

test('file size and document-count limits', t => {
  const { path, write } = fixture(t);
  writeFileSync(path, Buffer.alloc(MAX_FILE_BYTES + 1, 32));
  assert.throws(() => new KnowledgeBase(path), /10 MiB/);
  write(Array.from({ length: 10_001 }, (_, index) => guidance(String(index))));
  assert.throws(() => new KnowledgeBase(path), /10000 records/);
});

test('UTF8 BOM and blank lines accepted; HTML stays text; metadata copy is isolated', t => {
  const { path } = fixture(t);
  const row = guidance('one', '검색', '<script>alert("검색");</script> 검색용 문자열', { provenance: { nested: 'original' } });
  writeFileSync(path, '\uFEFF\n' + JSON.stringify(row) + '\n\n');
  const knowledge = new KnowledgeBase(path);
  assert.equal(knowledge.search('검색용')[0].text, row.text);
  const copy = knowledge.records;
  copy[0].text = 'changed';
  (copy[0].provenance as { nested: string }).nested = 'changed';
  assert.equal(knowledge.search('검색용')[0].text, row.text);
  assert.equal((knowledge.records[0].provenance as { nested: string }).nested, 'original');
});

test('bad UTF8 and invalid search limits rejected', t => {
  const { path, write } = fixture(t);
  writeFileSync(path, Buffer.from([255]));
  assert.throws(() => new KnowledgeBase(path), KnowledgeValidationError);
  write([guidance()]);
  const knowledge = new KnowledgeBase(path);
  for (const limit of [-1, true, '2', Number.NaN, 1.5]) assert.throws(() => knowledge.search('검색', limit as number), RangeError);
  assert.throws(() => knowledge.search('x'.repeat(32_001)), RangeError);
});

test('CSV parser preserves quoted commas, escaped quotes, multiline text and empty fields', () => {
  assert.deepEqual([...parseCsv('\uFEFFa,b,c\r\n"first, item","say ""hello""",\r\n"line\none",two,three\r\n')], [
    ['a', 'b', 'c'], ['first, item', 'say "hello"', ''], ['line\none', 'two', 'three'],
  ]);
  assert.throws(() => [...parseCsv('"unfinished')], /Unterminated/);
  assert.throws(() => [...parseCsv('"quoted"junk,value')], /Malformed/);
});

test('fixed-selection screening rejects direct identifier patterns', () => {
  const padding = '일상에서 느낀 마음을 이야기하는 검색 검사용 문장입니다. ';
  for (const identifier of ['010-1234-5678', '@NAME', 'person@example.org', '홍길동 씨 ', '서울']) {
    assert.throws(() => screenExcerpt(padding + identifier));
  }
});


function privateSelectionFixture(t: { after: (fn: () => void) => void }) {
  const { directory } = fixture(t);
  const text = '이 문장은 실제 내담자 발화가 아닌 검색 검사를 위해 새로 작성한 가상의 문자열입니다. 원자료 내용은 포함하지 않습니다.';
  const csv = 'text,label,label_id,split,participant_id,label_method,quality_flags\n' + text + ',기타,3,train,synthetic-only,test-only,\n';
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  writeFileSync(join(directory, 'test.csv'), csv);
  const selection = {
    schema_version: 1, source_filename: 'test.csv', source_file_sha256: hash(csv), source_url: 'https://example.invalid/test-only', label_method: 'test-only',
    data_permission_verified: true, selected_excerpts_reviewed: true,
    records: [{ id: 'synthetic-case', title: '합성 검색 검사', source_row_index: 1, label: '기타', label_id: 3, start_character: 0, end_character_exclusive: text.length, excerpt_sha256: hash(text) }],
  };
  const path = join(directory, 'private-selection.json');
  const save = () => writeFileSync(path, JSON.stringify(selection)); save();
  return { directory, path, selection, save, text };
}
test('private selection builds exact synthetic ranges and provenance without bundled counseling data', t => {
  const f = privateSelectionFixture(t);
  const { records, manifest } = buildCases(f.directory, f.path);
  assert.equal(records.length, 1);
  assert.ok(records[0].text.includes(f.text));
  assert.match(records[0].text, /진단·심각도·치료효과 판정이 아닙니다/u);
  const provenance = records[0].provenance as Record<string, unknown>;
  assert.equal(provenance.split, 'train');
  assert.equal(provenance.excerpt_start_character, 0);
  assert.equal(provenance.excerpt_sha256, f.selection.records[0].excerpt_sha256);
  assert.equal(provenance.participant_id, undefined);
  assert.equal(manifest.validation_data_read, false);
  assert.equal(manifest.clinical_review, false);
  assert.equal(manifest.synthetic_counseling_passages_added, 0);
});
test('private selection fails closed for changed hashes, ranges, labels and missing review', t => {
  const f = privateSelectionFixture(t), original = structuredClone(f.selection);
  for (const mutate of [
    () => { f.selection.source_file_sha256 = '0'.repeat(64); },
    () => { f.selection.records[0].excerpt_sha256 = '0'.repeat(64); },
    () => { f.selection.records[0].end_character_exclusive += 10; },
    () => { f.selection.records[0].label_id = 1; },
    () => { f.selection.selected_excerpts_reviewed = false; },
    () => { f.selection.source_filename = '../test.csv'; },
    () => { f.selection.source_url = 'https://secret@example.invalid/'; },
  ]) {
    Object.assign(f.selection, structuredClone(original)); mutate(); f.save();
    assert.throws(() => buildCases(f.directory, f.path));
  }
});
test('builder never overwrites a different output; verify-only requires exact artifacts', t => {
  const f = privateSelectionFixture(t), out = fixture(t);
  const output = join(out.directory, 'knowledge.jsonl'), manifest = join(out.directory, 'manifest.json');
  const args = ['--dataset-dir', f.directory, '--selection', f.path, '--destination', output, '--manifest', manifest];
  assert.equal(main([...args, '--verify-only']), 2);
  assert.equal(main(args), 0);
  assert.equal(main([...args, '--verify-only']), 0);
  assert.equal(new KnowledgeBase(output).count, 1);
  writeFileSync(output, 'existing-file-must-stay');
  assert.equal(main(args), 2);
  assert.equal(readFileSync(output, 'utf8'), 'existing-file-must-stay');
});
test('retrieved source URLs cannot include authentication credentials', t => {
  const { path, write } = fixture(t);
  write([guidance('one', '검색', '문장', { source_url: 'https://private:password@example.invalid/article' })]);
  assert.throws(() => new KnowledgeBase(path), /without credentials/);
});
