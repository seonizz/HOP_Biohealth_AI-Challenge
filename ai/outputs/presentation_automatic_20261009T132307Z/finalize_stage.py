"""Consolidate verified mechanical records and prepare a guarded publication."""
import csv
import hashlib
import json
from pathlib import Path
import re

STAGE = Path(__file__).resolve().parent
AFTER = STAGE / 'after'
ART = STAGE / 'artifacts'
DEST = Path('/Users/chihun/Documents/ChatGPT/HOP_pptdata')
SOURCE = Path('/Users/chihun/Documents/ChatGPT/HOP_agent/outputs/base12_local_20261009')


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


metrics = read(ART / 'metrics.json')
proof = read(ART / 'mechanical_measurements.json')
verification = read(ART / 'verification.json')
assert verification['verified'] and all(c['passed'] for c in verification['checks'])
assert sha(ART / 'verify_measurements.py') == verification['verifier_sha256']
assert sha(ART / 'mechanical_measurements.json') == verification['metrics_file_sha256']
mapping = {
    'all_requests': 'all_requests94',
    'response_all': 'response_all63',
    'response_legacy_dev': 'response_legacy_dev32',
    'response_public_regression': 'response_public_regression31',
    'action_public_regression': 'action_public_regression31',
}
assert set(metrics['scopes']) == set(mapping), list(metrics['scopes'])
for name, group in mapping.items():
    current, verified = metrics['scopes'][name], proof['groups'][group]
    for field in ('assigned', 'attempted'):
        assert current[field] == verified[field], (name, field)
    for field in ('valid', 'length_limit', 'format_error'):
        assert current[field] == verified['status_counts'][field], (name, field)
    assert current['error'] == verified['status_counts']['generation_error'] == 0
    assert current['missing'] == current['assigned'] - current['attempted'] == 0
    for field, verified_field in [('input_tokens', 'input_tokens'), ('output_tokens', 'generated_tokens')]:
        for stat in ('n', 'total', 'min', 'max', 'mean'):
            assert current[field][stat] == verified[verified_field][stat], (name, field, stat)
    assert current['rates_assigned']['valid'] == verified['normal_stop_rate']

metrics['action_label_counts'] = proof['groups']['action_public_regression31']['label_counts']
metrics['mechanical_verification'] = {
    'verified': True,
    'metrics_file': 'mechanical_measurements.json',
    'metrics_file_sha256': verification['metrics_file_sha256'],
    'metrics_canonical_sha256': verification['metrics_canonical_sha256'],
    'verifier_sha256': verification['verifier_sha256'],
    'model_integrity': proof['model_integrity'],
    'source_validation': proof['source_validation'],
    'assigned_request_uniqueness': proof['assigned_request_uniqueness'],
    'input_token_count_matches': proof['groups']['all_requests94']['input_token_count_matches'],
    'abnormal_cases': proof['abnormal_cases'],
    'validation_checks_passed': len(verification['checks']),
}
write(ART / 'metrics.json', metrics)
snapshot_path = AFTER / '발표데이터_최신확인_20261009.json'
snapshot = read(snapshot_path)
snapshot['base12_mechanical_collection']['metrics'] = metrics
snapshot['dual_gpu_probe'].pop('peak_reserved_gib_by_device', None)
snapshot['single_gpu_canary'].pop('peak_reserved_gib', None)
write(snapshot_path, snapshot)

# The CSV is a pure tabular projection of the verified JSON, including zeros.
with (ART / 'local_measurements.csv').open('w', newline='') as stream:
    writer = csv.writer(stream)
    writer.writerow(['scope', 'metric', 'value', 'unit', 'numerator', 'denominator', 'evidence'])
    for name, current in metrics['scopes'].items():
        evidence = 'mechanical_measurements.json#groups.' + mapping[name]
        for field in ('assigned', 'attempted', 'valid', 'length_limit', 'format_error', 'error', 'missing'):
            writer.writerow([name, field, current[field], 'count', '', '', evidence])
        for field, rate in current['rates_assigned'].items():
            writer.writerow([name, field + '_rate', rate['percent'], 'percent', rate['numerator'], rate['denominator'], evidence])
        for field in ('input_tokens', 'output_tokens'):
            for stat in ('total', 'min', 'max', 'mean'):
                writer.writerow([name, field + '_' + stat, current[field][stat], 'tokens', '', '', evidence])
    for label, count in metrics['action_label_counts'].items():
        writer.writerow(['action_public_regression', 'label_count_' + label, count, 'count', '', '', 'mechanical_measurements.json#groups.action_public_regression31.label_counts'])
    for name, count, total in [('model_hash_size_match', 740, 740), ('request_evidence_match', 94, 94), ('input_token_count_match', 94, 94), ('source_target_removal_match', 32, 32)]:
        writer.writerow(['verification', name, count, 'count', count, total, 'mechanical_measurements.json'])

main_path = AFTER / '발표용_데이터_추출_활용안.md'
text = main_path.read_text()
anchor = '**후속 자동 수집**'
command = '''같은 원자료의 재계산 및 저장 수치 대조:

```sh
python3 /Users/chihun/Documents/ChatGPT/HOP_pptdata/outputs/presentation_automatic_20261009T132307Z/verify_measurements.py --expected /Users/chihun/Documents/ChatGPT/HOP_pptdata/outputs/presentation_automatic_20261009T132307Z/mechanical_measurements.json
```

재계산 일치와 입력·요청·응답 변조 거부를 포함한 10개 검증을 통과했다. 원시기록과 모델 파일은 현재 Mac의 기존 경로를 사용한다.

'''
if command not in text:
    main_path.write_text(text.replace(anchor, command + anchor))

config = read(AFTER / '평가양식/평가설정.json')
assert config['protocol_sha256'] == sha(AFTER / 'LLM_학습전후_분류평가.md')
for task in config['tasks'].values():
    assert task['prompt_sha256'] == sha(DEST / '평가양식' / task['prompt_file'])
for path in list(AFTER.rglob('*.json')) + list(ART.glob('*.json')):
    read(path)

for path in AFTER.rglob('*'):
    if path.is_file():
        assert not re.search(r'AI 보조|AI 판정|AI 검토|사람 검토|사람 정답|요청 해결률|구체성 통과율|불필요 질문률|54\.84|70\.97|67\.74|review_queue|ai_review|human_review|gold_label|macro_f1', path.read_text(), re.I), path

manifest = {
    'schema_version': 1,
    'run_id': metrics['run_id'],
    'scope': 'Frozen-record mechanical counts, hashes, termination, format and tokens only.',
    'source_evidence_root': str(SOURCE),
    'source_files': [{'path': str(SOURCE / name), 'sha256': value} for name, value in proof['evidence_sha256'].items()],
    'source_archive': {'path': read(SOURCE / 'dataset_audit.json')['archive'], 'sha256': proof['source_validation']['archive_sha256']},
    'private_records': 'Inputs, requests, raw responses and decoded responses remain under source_evidence_root/private. Hashes and links are independently checked for all 94 requests; private counseling text is not copied into this package.',
    'outputs': [{'file': path.name, 'sha256': sha(path), 'bytes': path.stat().st_size} for path in sorted(ART.iterdir()) if path.is_file() and path.name != 'evidence_manifest.json'],
    'verification': 'verification.json',
    'recalculation_expected': 'mechanical_measurements.json',
}
write(ART / 'evidence_manifest.json', manifest)
stage_meta = read(STAGE / 'stage.json')
publication = {
    'destination': str(DEST),
    'output_name': stage_meta['output_name'],
    'files': [{'file': name, 'before_sha256': sha(STAGE / 'before' / name), 'after_sha256': sha(AFTER / name)} for name in stage_meta['files']],
    'artifacts': [{'file': path.name, 'sha256': sha(path)} for path in sorted(ART.iterdir()) if path.is_file()],
    'verification': {'scope_cross_checks': len(mapping), 'mechanical_checks_passed': len(verification['checks']), 'protocol_and_prompt_hashes_match': True, 'active_documents_subjective_metric_scan_passed': True},
}
write(STAGE / 'publication_manifest.json', publication)
print(json.dumps({'ready': True, 'files': len(publication['files']), 'artifacts': len(publication['artifacts']), 'mechanical_checks_passed': len(verification['checks'])}))
