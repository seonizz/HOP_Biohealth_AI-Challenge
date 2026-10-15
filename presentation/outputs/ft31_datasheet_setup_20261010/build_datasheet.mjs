import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';

const here = path.dirname(fileURLToPath(import.meta.url));
const ppt = path.resolve(here, '../..');
const base = path.resolve(ppt, '../HOP_agent/outputs/base12_local_20261009');
const args = process.argv.slice(2);
const opt = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const ftRoot = opt('--ft31', null);
const output = path.resolve(opt('--output', path.join(here, '31B_데이터시트_수집양식.xlsx')));
const checkpoint = '56244f8a6736e648dd8f4cd13d0889d7499a6bf776b9e55491a4ed59c446effd';
const labels = ['ASK_CFI', 'CLARIFY', 'SUPPORT', 'SUPPORT_LIMITED', 'SAFETY_SUPPORT', 'END'];
const read = async p => JSON.parse(await fs.readFile(p, 'utf8'));
const jsonl = async p => (await fs.readFile(p, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const hash = data => createHash('sha256').update(data).digest('hex');
const key = r => `${r.task}/${r.case_id}`;
const require = (condition, message) => { if (!condition) throw new Error(message); };
const safeFile = (root, name) => {
  require(typeof name === 'string', 'Missing evidence file path');
  const p = path.resolve(root, name);
  require(p.startsWith(path.resolve(root) + path.sep), 'Evidence path escapes run');
  return p;
};
const cases = await jsonl(path.join(base, 'case_manifest.jsonl'));
const baseRecords = await jsonl(path.join(base, 'generations.jsonl'));
require(cases.length === 94 && baseRecords.length === 94, 'Expected 94 BASE12 cases and records');
const casesByKey = new Map(cases.map(r => [key(r), r]));
const baseByKey = new Map(baseRecords.map(r => [key(r), r]));
require(casesByKey.size === 94 && baseByKey.size === 94, 'Duplicate BASE12 key');
const compatibility = await read(path.join(ppt, '평가양식/31B_수집전_API형식검사.json'));
const compatibilityByKey = new Map(compatibility.cases.map(r => [key(r), r]));
let ftByKey = new Map(), preflightByKey = new Map(), ftRun = null;
if (ftRoot) {
  const manifest = await read(path.join(ftRoot, 'run_manifest.json'));
  require(manifest.condition === 'FT31_STEP100' && manifest.checkpoint_sha256 === checkpoint, 'Unexpected FT31 run identity');
  ftRun = manifest.run_id;
  const preflight = await read(path.join(ftRoot, 'preflight.json'));
  require(preflight.cases?.length === 94, 'preflight.cases must cover all 94 original cases');
  preflightByKey = new Map(preflight.cases.map(r => [key(r), r]));
  require(preflightByKey.size === 94, 'Duplicate preflight key');
  for (const r of preflight.cases) {
    require(casesByKey.has(key(r)) && typeof r.eligible === 'boolean', 'Invalid preflight assignment');
    require(Number.isInteger(r.input_tokens_preflight) && r.input_tokens_preflight >= 0, 'Missing actual tokenizer count');
    if (r.eligible) require(r.input_tokens_preflight + (r.task === 'action' ? 32 : 512) <= 4096, 'Context budget exceeded');
  }
  const records = await jsonl(path.join(ftRoot, 'generations.jsonl'));
  for (const r of records) {
    const c = casesByKey.get(key(r));
    require(c && !ftByKey.has(key(r)) && r.attempt_index === 1, 'Unknown/duplicate FT31 case or later attempt');
    require(r.condition === 'FT31_STEP100' && r.checkpoint_sha256 === checkpoint && r.model_id === 'malssi-gemma4-31b-step100', 'FT31 record identity mismatch');
    require(r.input_sha256 === c.input_sha256 && typeof r.status === 'string' && r.status.length > 0, 'FT31 input or status mismatch');
    require(preflightByKey.get(key(r)).eligible, 'Generation exists for excluded case');
    const rawData = await fs.readFile(safeFile(ftRoot, r.raw_response_file));
    require(hash(rawData) === r.raw_response_sha256, 'FT31 raw response hash mismatch');
    const raw = JSON.parse(rawData);
    let answer = null;
    if (r.http_status === 200) {
      const responseData = await fs.readFile(safeFile(ftRoot, r.private_response_file));
      answer = responseData.toString('utf8');
      require(hash(responseData) === r.response_sha256 && answer === raw.choices?.[0]?.message?.content, 'FT31 answer mismatch');
      require(raw.model === r.model_id && raw.system_fingerprint === 'step-100-56244f8a6736' && r.system_fingerprint === raw.system_fingerprint, 'FT31 response identity mismatch');
      require(raw.usage?.prompt_tokens === r.input_tokens && raw.usage?.completion_tokens === r.generated_tokens && raw.choices[0].finish_reason === r.finish_reason, 'FT31 raw metrics mismatch');
      require(Number.isInteger(r.input_tokens) && Number.isInteger(r.generated_tokens) && r.input_tokens >= 0 && r.generated_tokens >= 0, 'Invalid FT31 token count');
      require(r.generated_tokens <= (r.task === 'action' ? 32 : 512), 'Output budget exceeded');
      const status = r.input_tokens !== preflightByKey.get(key(r)).input_tokens_preflight ? 'input_token_mismatch'
        : r.finish_reason === 'length' ? 'length_limit'
        : r.finish_reason !== 'stop' ? 'unverified_termination'
        : !answer.trim() ? 'empty_output'
        : r.task === 'action' && !labels.includes(answer.trim()) ? 'format_error' : 'valid';
      require(r.status === status, 'FT31 derived status mismatch');
      require((r.predicted_label ?? null) === (r.task === 'action' && status === 'valid' ? answer.trim() : null), 'FT31 label mismatch');
    } else {
      require(r.status !== 'valid' && r.input_tokens == null && r.generated_tokens == null, 'Error response cannot have successful measurements');
    }
    ftByKey.set(key(r), { ...r, answer });
  }
}

const headers = ['과제', '사례 ID', '자료 구분', '원천 그룹', '12B 상태', '12B 입력 토큰', '12B 생성 토큰', '12B 행동 코드',
  '31B 사전 실행 가능', '31B 상태', '31B 입력 토큰', '31B 생성 토큰', '31B 행동 코드', '31B 종료 사유',
  '현재 API 형식 지원', '입력 SHA-256', '12B 답변 원문', '31B 답변 원문', '31B 원시 응답 파일', '31B 체크포인트 SHA-256', '31B 시도 기록 여부'];
const rows = [];
for (const c of cases) {
  const b = baseByKey.get(key(c));
  const f = ftByKey.get(key(c));
  const pre = preflightByKey.get(key(c));
  const baseAnswerBytes = await fs.readFile(path.join(base, b.private_response_file));
  require(hash(baseAnswerBytes) === b.response_sha256, 'BASE12 answer hash mismatch');
  const baseAnswer = baseAnswerBytes.toString('utf8');
  const row = [c.task, c.case_id, c.split, c.source_group_id, b.status, b.input_tokens, b.generated_tokens, b.predicted_label,
    pre ? (pre.eligible ? '가능' : '제외') : null, f?.status ?? null, f?.input_tokens ?? null, f?.generated_tokens ?? null,
    f?.predicted_label ?? null, f?.finish_reason ?? null, compatibilityByKey.get(key(c))?.accepted ? '지원' : '형식 거부',
    c.input_sha256, baseAnswer, f?.answer ?? null, f?.raw_response_file ?? null, f?.checkpoint_sha256 ?? null, f ? 1 : 0];
  require(row.every(v => typeof v !== 'string' || v.length <= 32767), 'Cell text exceeds Excel limit');
  rows.push(row.map(v => typeof v === 'string' && v.startsWith('=') ? "'" + v : v));
}
const wb = Workbook.create();
const summary = wb.worksheets.add('요약');
const detail = wb.worksheets.add('사례별결과');
for (const sheet of [summary, detail]) sheet.showGridLines = false;
summary.tabColor = '#243B53';
detail.getRange('A1:U95').values = [headers, ...rows];
detail.getRange('A1:U95').format.font = { name: 'Arial', size: 10, color: '#243B53' };
detail.getRange('A1:U1').format = { fill: '#243B53', font: { color: '#FFFFFF', bold: true }, rowHeight: 46, wrapText: true, horizontalAlignment: 'center', verticalAlignment: 'center' };
detail.getRange('A2:U95').format.rowHeight = 25;
detail.getRange('A:U').format.columnWidth = 18;
detail.getRange('C:D').format.columnWidth = 30;
detail.getRange('D:D').format.columnWidth = 78;
detail.getRange('P:P').format.columnWidth = 68;
detail.getRange('Q:R').format.columnWidth = 60;
detail.getRange('S:T').format.columnWidth = 32;
detail.getRange('T:T').format.columnWidth = 68;
detail.getRange('F2:G95').setNumberFormat('#,##0');
detail.getRange('K2:L95').setNumberFormat('#,##0');
detail.getRange('I2:N95').format.fill = '#FFF7D6';
detail.getRange('A1:U95').format.verticalAlignment = 'center';
detail.freezePanes.freezeRows(1);
detail.freezePanes.freezeColumns(2);
detail.tables.add('A1:U95', true, 'CaseResults');
detail.getRange('O2:O95').conditionalFormats.add('containsText', { text: '형식 거부', format: { fill: '#FDE9E7', font: { color: '#9D2424' } } });
detail.getRange('J2:J95').conditionalFormats.add('containsText', { text: 'length_limit', format: { fill: '#FFF0C2' } });
detail.getRange('Q2:R95').format.wrapText = false;
// Exact answer text is preserved in each cell; select a cell to read it in the formula bar.
detail.getRange('V1').values = [['12B 원자료']];
detail.getRange('V2').values = [[path.join(base, 'generations.jsonl')]];
detail.getRange('V4').values = [['31B 원자료']];
detail.getRange('V5').values = [[ftRoot ? path.resolve(ftRoot) : '미수집']];
detail.getRange('V7').values = [['답변 원문은 셀을 선택해 수식 입력줄에서 확인합니다.']];
detail.getRange('V1:V7').format.columnWidth = 90;

summary.getRange('A1:F42').format.font = { name: 'Arial', size: 10, color: '#243B53' };
summary.getRange('A2').values = [['Gemma 12B와 31B 학습 체크포인트 데이터 시트']];
summary.getRange('A2').format.font = { size: 16, bold: true };
summary.getRange('A4').values = [['31B는 step100 중간 체크포인트. 형식 유효율은 분류 정확도가 아닙니다.']];
summary.getRange('A5').values = [[ftRun ? `31B 수집 run: ${ftRun}` : '31B 미수집. 노란 칸과 31B 비율은 실제 수집 전까지 비워 둡니다.']];
summary.getRange('A7:C7').values = [['전체 기록', '12B', '31B step100']];
summary.getRange('A8:A15').values = [['원래 배정 건수'], ['사전 실행 가능 건수'], ['시도 기록 건수'], ['정상 종료·형식 유효 건수'], ['출력 한도 도달 건수'], ['입력 토큰 합계'], ['생성 토큰 합계'], ['토큰 관측 건수']];
const d = col => `'사례별결과'!$${col}$2:$${col}$95`;
summary.getRange('B8:C15').formulas = [
  ['=COUNTA(\'사례별결과\'!B2:B95)', '=B8'],
  ['=B8', `=IF(COUNTBLANK(${d('I')})>0,"",COUNTIFS(${d('I')},"가능"))`],
  [`=COUNTA(${d('E')})`, `=SUM(${d('U')})`],
  [`=COUNTIFS(${d('E')},"valid")`, '=IF(C10=0,"",COUNTIFS(\'사례별결과\'!J2:J95,"valid"))'],
  [`=COUNTIFS(${d('E')},"length_limit")`, '=IF(C10=0,"",COUNTIFS(\'사례별결과\'!J2:J95,"length_limit"))'],
  [`=SUM(${d('F')})`, `=IF(COUNT(${d('K')})=0,"",SUM(${d('K')}))`],
  [`=SUM(${d('G')})`, `=IF(COUNT(${d('L')})=0,"",SUM(${d('L')}))`],
  [`=COUNT(${d('F')})`, `=COUNT(${d('K')})`],
];
summary.getRange('A18:D18').values = [['동일 사례 비교', '12B 교집합', '31B 교집합', '차이 (%p)']];
const tableRows = [19, 24];
for (let t = 0; t < 2; t++) {
  const task = t === 0 ? 'response' : 'action';
  const row = tableRows[t];
  const title = t === 0 ? '상담' : '행동 분류';
  summary.getRange(`A${row}:A${row+3}`).values = [[`${title} 사전 분모`], [`${title} 시도 건수`], [`${title} 유효 건수`], [`${title} 유효율`]];
  const eligible = `COUNTIFS(${d('A')},"${task}",${d('I')},"가능")`;
  summary.getRange(`B${row}:C${row+3}`).formulas = [
    [`=IF(COUNTBLANK(${d('I')})>0,"",${eligible})`, `=IF(B${row}="","",B${row})`],
    [`=IF(B${row}="","",B${row})`, `=IF(C${row}="","",SUMIFS(${d('U')},${d('A')},"${task}",${d('I')},"가능"))`],
    [`=IF(B${row}="","",COUNTIFS(${d('A')},"${task}",${d('I')},"가능",${d('E')},"valid"))`, `=IF(OR(C${row}="",C${row+1}=0),"",COUNTIFS(${d('A')},"${task}",${d('I')},"가능",${d('J')},"valid"))`],
    [`=IF(OR(B${row}="",B${row}=0),"",B${row+2}/B${row})`, `=IF(OR(C${row}="",C${row}=0,C${row+1}<>C${row}),"",C${row+2}/C${row})`],
  ];
  summary.getRange(`D${row+3}`).formulas = [[`=IF(OR(B${row+3}="",C${row+3}=""),"",100*(C${row+3}-B${row+3}))`]];
  summary.getRange(`B${row+3}:C${row+3}`).setNumberFormat('0.00%');
  summary.getRange(`D${row+3}`).setNumberFormat('0.00');
}
summary.getRange('A30:C30').values = [['행동 코드 관측 건수', '12B 전체', '31B 관측']];
summary.getRange('A31:A36').values = labels.map(x => [x]);
summary.getRange('B31:C36').formulas = labels.map((label, i) => [`=COUNTIFS(${d('H')},A${31+i})`, `=IF(SUMIFS(${d('U')},${d('A')},"action")=0,"",COUNTIFS(${d('M')},A${31+i}))`]);
summary.getRange('A39').values = [['API 형식 검사: 60건 허용·34건 거부. 실행 가능 여부는 사전 확인 후 확정합니다.']];
summary.getRange('A40').values = [['토큰 합계는 관측값만 합산합니다. 오류의 토큰값은 빈칸으로 남깁니다.']];
summary.getRange('A41').values = [['31B 비율과 차이는 사전 분모 확정과 해당 과제의 전체 첫 시도 기록이 필요합니다.']];
summary.getRange('A:A').format.columnWidth = 34;
summary.getRange('B:D').format.columnWidth = 21;
summary.getRange('E:F').format.columnWidth = 24;
summary.getRange('A7:D36').format.rowHeight = 25;
summary.getRange('B8:C21').setNumberFormat('#,##0');
summary.getRange('B24:C26').setNumberFormat('#,##0');
for (const r of ['A7:C7', 'A18:D18', 'A30:C30']) summary.getRange(r).format = { fill: '#243B53', font: { bold: true, color: '#FFFFFF' }, horizontalAlignment: 'center' };
if (!ftRoot) {
  detail.getRange('I2:I95').values = [['가능']];
  detail.getRange('J2').values = [['valid']];
  detail.getRange('U2').values = [[1]];
  detail.getRange('K2:L2').values = [[0, 0]];
  require(summary.getRange('C10').values[0][0] === 1, 'One record was counted incorrectly');
  require(summary.getRange('C13').values[0][0] === 0, 'Measured zero became missing');
  require(summary.getRange('C22').values[0][0] === '', 'Incomplete FT31 collection produced a rate');
  detail.getRange('I3:I95').values = [['제외']];
  require(summary.getRange('C22').values[0][0] === 1, 'Complete eligible subset did not recalculate');
  require(summary.getRange('D22').values[0][0] === 0, 'Paired comparison mismatch');
  detail.getRange('I2:N95').values = rows.map(r => r.slice(8, 14));
  detail.getRange('U2:U95').values = rows.map(r => [r[20]]);
}
wb.recalculate();
require(summary.getRange('B8').values[0][0] === 94 && summary.getRange('B11').values[0][0] === 93, 'BASE12 summary count mismatch');
require(summary.getRange('B13').values[0][0] === 73540 && summary.getRange('B14').values[0][0] === 9496, 'BASE12 token totals mismatch');
if (!ftRoot) require(summary.getRange('C10').values[0][0] === 0 && summary.getRange('C11').values[0][0] === '' && summary.getRange('C22').values[0][0] === '' && summary.getRange('D22').values[0][0] === '', 'Missing FT31 data became a rate');
const inspection = await wb.inspect({ kind: 'table', range: '요약!A7:D15', include: 'values,formulas', tableMaxRows: 9, tableMaxCols: 4 });
console.log(inspection.ndjson);
const errors = await wb.inspect({ kind: 'match', searchTerm: '#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!', options: { useRegex: true, maxResults: 30 } });
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(path.join(path.dirname(output), 'datasheet_formula_scan.json'), errors.ndjson);
for (const [name, sheetName, range] of [['summary', '요약', 'A1:F41'], ['cases', '사례별결과', 'A1:H9'], ['ft31', '사례별결과', 'I1:O9']]) {
  const png = await wb.render({ sheetName, range, scale: 1.5, format: 'png' });
  await fs.writeFile(path.join(path.dirname(output), `${name}_preview.png`), new Uint8Array(await png.arrayBuffer()));
}
await (await SpreadsheetFile.exportXlsx(wb)).save(output);
await fs.writeFile(path.join(path.dirname(output), 'datasheet_verification.json'), JSON.stringify({
  generated_at_utc: new Date().toISOString(), output, ft31_run_id: ftRun,
  cases: rows.length, ft31_records: ftByKey.size, base12_tokens: { input: 73540, output: 9496 },
  base12_normal_or_format_valid: 93, ft31_missing_rates_remain_blank: !ftRoot,
  blank_zero_and_partial_collection_formula_checks: !ftRoot,
  case_manifest_sha256: hash(await fs.readFile(path.join(base, 'case_manifest.jsonl'))),
  writer_sha256: hash(await fs.readFile(fileURLToPath(import.meta.url))),
}, null, 2) + '\n');
console.log(JSON.stringify({ output, cases: rows.length, ft31_records: ftByKey.size }));
