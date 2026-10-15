#!/usr/bin/env python3
"""Check the saved XLSX against all 94 source records, independently of its writer."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import openpyxl


def load(path):
    return json.loads(path.read_text())


def records(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    parser.add_argument('presentation', type=Path)
    args = parser.parse_args()
    run, presentation = args.run.resolve(), args.presentation.resolve()
    baseline = run / 'source_baseline'
    xlsx = presentation / 'FT31_STEP100_데이터시트.xlsx'
    wb = openpyxl.load_workbook(xlsx, data_only=True)
    assert wb.sheetnames == ['요약', '사례별결과']
    detail = wb['사례별결과']
    key = lambda row: (row['task'], row['case_id'])
    base = {key(row): row for row in records(baseline / 'generations.jsonl')}
    ft = {key(row): row for row in records(run / 'generations.jsonl')}
    pre = {key(row): row for row in load(run / 'preflight.json')['cases']}
    compatibility = {key(row): row for row in load(run / 'evidence/api_format_check.initial.json')['cases']}
    cases = records(baseline / 'case_manifest.jsonl')
    assert len(cases) == len(ft) == len(base) == 94 and detail.max_row == 95
    for index, case in enumerate(cases, start=2):
        item = key(case)
        b, f = base[item], ft[item]
        expected = [case['task'], case['case_id'], case['split'], case['source_group_id'],
                    b['status'], b['input_tokens'], b['generated_tokens'], b['predicted_label'],
                    '가능' if pre[item]['eligible'] else '제외', f['status'],
                    f['input_tokens'], f['generated_tokens'], f['predicted_label'], f['finish_reason'],
                    '지원' if compatibility[item]['accepted'] else '형식 거부', case['input_sha256'],
                    (baseline / b['private_response_file']).read_bytes().decode('utf-8'),
                    (run / f['private_response_file']).read_bytes().decode('utf-8') if f['private_response_file'] else None,
                    f['raw_response_file'], f['checkpoint_sha256'], 1]
        observed = [detail.cell(index, column).value for column in range(1, 22)]
        assert observed == expected, f'Saved Excel row {index} differs from source {item}'
    metrics = load(run / 'metrics.json')
    overall = metrics['overall']
    summary = wb['요약']
    checks = {'B8': 94, 'B11': 93, 'B13': 73540, 'B14': 9496,
              'C8': 94, 'C9': overall['eligible'], 'C10': overall['recorded_first_attempts'],
              'C11': overall['valid'], 'C12': overall['length_limit'], 'C13': overall['input_tokens']['sum'],
              'C14': overall['generated_tokens']['sum'], 'C15': overall['input_tokens']['observed'],
              'C16': overall['status_counts']['unknown_completion']}
    for cell, expected in checks.items():
        assert summary[cell].value == expected, f'Saved Excel summary mismatch: {cell}'
    for task, cell, difference in [('response', 'C22', 'D22'), ('action', 'C27', 'D27')]:
        pair = metrics['paired_BASE12'][task]
        assert abs(summary[cell].value * 100 - pair['FT31_STEP100_percent']) < 1e-9
        assert abs(summary[difference].value - pair['difference_percentage_points']) < 1e-9
    errors = [(sheet.title, cell.coordinate) for sheet in wb for row in sheet for cell in row if cell.data_type == 'e']
    assert not errors, f'Saved Excel formula errors: {errors}'
    result = {'verified': True, 'checked_at': datetime.now(timezone.utc).isoformat(),
              'xlsx_sha256': hashlib.sha256(xlsx.read_bytes()).hexdigest(), 'records': 94,
              'exact_source_cells_checked': 94 * 21,
              'exact_answers_checked': 94 + sum(bool(row['private_response_file']) for row in ft.values()),
              'cached_summary_values_verified': True, 'formula_errors': 0, 'reader': 'openpyxl ' + openpyxl.__version__}
    (presentation / 'workbook_roundtrip_verification.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
