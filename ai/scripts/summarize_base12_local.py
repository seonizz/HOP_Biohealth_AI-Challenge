"""Report frozen local BASE12 measurements without inventing quality scores.

Run only after collect_base12_local.py has written COLLECTION_COMPLETE.json.
All reports stay in the collection directory; private counseling text stays private.
"""
import argparse
from collections import Counter
from copy import deepcopy
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
import math
from pathlib import Path
import statistics


ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / 'outputs/base12_local_20261009'
PUBLIC = 'synthetic_public_regression'
LEGACY = 'legacy_validation_development'
CRITERIA = ('request_resolution', 'actionable_support', 'subject_evidence',
            'question_necessity')
QUALITY = {'request_resolution_rate', 'actionable_support_rate',
           'unnecessary_question_rate'}
EXPECTED_SCOPES = {('response', LEGACY): 32, ('response', PUBLIC): 31,
                   ('action', PUBLIC): 31}
SCOPES = (
    ('all_requests', '전체 요청 (상담+분류)', None, None),
    ('response_all', '상담 전체', 'response', None),
    ('response_legacy_dev', '실제 상담 개발용', 'response', LEGACY),
    ('response_public_regression', '공개 합성 상담 회귀', 'response', PUBLIC),
    ('action_public_regression', '공개 합성 행동 분류', 'action', PUBLIC),
)
LIMITATIONS = [
    '실제 상담 legacy validation 개발용 32건과 공개 합성 회귀 상담 31건, 행동 분류 31건이다. 독립 최종 test가 아니다.',
    '상담 63건과 행동 분류 31건은 서로 다른 작업이다. 전체 요청 94건을 품질 평가 분모로 사용하지 않는다.',
    'BASE12는 프로젝트 학습 adapter가 없는 Ollama MLX NVFP4 배포본이다. BF16 원본 가중치와 수치적으로 동일하다고 검증하지 않았다.',
    '로컬 배포 manifest와 모델 blob 무결성을 확인했지만 Google/Hugging Face 원본 revision 연결은 미확인이다.',
    'BASE31·FT31 결과와 공통 길이 검사가 없어 Δ학습·Δ소형·속도 배율을 계산하지 않는다.',
    '사람 검토·승인 정답이 없으므로 해결률·구체성·불필요 질문률·분류 정확도는 null이다. 형식 유효성은 의미 정확도가 아니다.',
    '종료 이유 length는 유효 완료에 포함하지 않는다. 오류·길이 소진·누락도 사전 배정 분모에서 제외하지 않는다.',
    'wall latency는 요청 전체 경과 시간이며 모델 API eval_duration과 다르다. pooled 속도는 Σ출력 토큰/Σeval_duration이다.',
    '수집 전에 smoke 요청 1건으로 모델을 로드했다. 본 수집은 warm-run·동시성 1의 측정이며 cold-start 지연이 아니다.',
    'prompt cache 사용 요청을 포함한다. ps 메모리는 마지막 관측의 모델 메모리 표시이며 peak GPU 메모리나 최대 용량 검사가 아니다.',
    '4096 문맥과 출력 예약량 512/32는 설정값이다. 모델의 절대 최대 추론 길이 또는 전체 예약량 생성 성공을 뜻하지 않는다.',
    '실제 상담 원문·응답은 private에만 보존하며 공개 사례에는 공개 합성 시나리오만 사용한다.',
]


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8'))


def read_jsonl(path):
    rows = []
    for number, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f'{path.name}:{number}: invalid JSON; source preserved') from exc
        if not isinstance(row, dict):
            raise ValueError(f'{path.name}:{number}: object required; source preserved')
        rows.append(row)
    return rows


def sha(data):
    return hashlib.sha256(data).hexdigest()


def file_sha(path):
    with path.open('rb') as stream:
        digest = hashlib.sha256()
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def require(condition, message):
    if not condition:
        raise ValueError(message + '; source files have not been changed')


def key(row):
    return row['task'], row['case_id']


def local_path(work, relative, private=False):
    path = (work / relative).resolve()
    boundary = (work / 'private').resolve() if private else work.resolve()
    require(path.is_relative_to(boundary), 'Evidence path outside allowed directory')
    return path


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def describe(values):
    values = [value for value in values if number(value) and value >= 0]
    return {'n': len(values), 'total': sum(values) if values else None,
            'min': min(values) if values else None, 'max': max(values) if values else None,
            'mean': statistics.mean(values) if values else None}


def rate(count, denominator):
    return {'numerator': count, 'denominator': denominator,
            'percent': 100 * count / denominator if denominator else None}


def status(row):
    # Guard against a conflicting legacy status without dropping the raw status.
    return 'length_limit' if row.get('termination') == 'length' else row['status']


def validate(work):
    required = ['run_manifest.json', 'case_manifest.jsonl', 'generations.jsonl',
                'COLLECTION_COMPLETE.json', 'model_verification.json',
                'dataset_audit.json', 'snapshots/평가양식/발표수치_결과양식.json']
    for name in required:
        require((work / name).is_file(), f'Required collection file missing: {name}')
    run = read_json(work / 'run_manifest.json')
    complete = read_json(work / 'COLLECTION_COMPLETE.json')
    verification = read_json(work / 'model_verification.json')
    cases = read_jsonl(work / 'case_manifest.jsonl')
    rows = read_jsonl(work / 'generations.jsonl')
    require(run['case_manifest_sha256'] == file_sha(work / 'case_manifest.jsonl'),
            'Frozen case manifest hash mismatch')
    require(complete['generations_sha256'] == file_sha(work / 'generations.jsonl'),
            'Completed generation ledger hash mismatch')
    require(complete['run_id'] == run['run_id'], 'Completion run ID mismatch')
    require(complete['assigned'] == len(cases), 'Completion assigned count mismatch')
    require(complete['attempted'] == len(rows), 'Completion attempted count mismatch')
    require(verification.get('verified') is True, 'Local model blob verification missing/failed')
    require(verification['identity']['selected_distribution_manifest_digest'].removeprefix('sha256:')
            == run['model']['digest'], 'Verified model digest differs from generation model')
    require(verification['identity']['runner'] == 'mlx'
            and verification['identity']['quantization_level'].lower() == 'nvfp4',
            'Unexpected model runner/quantization for this report')
    require(run.get('condition') == 'BASE12' and run.get('trained_adapter') is False,
            'Unexpected model condition or trained adapter')
    require(Counter((case['task'], case['split']) for case in cases) == EXPECTED_SCOPES,
            'Frozen scope differs from 32 development + 31 public response + 31 action cases')
    by_case = {key(case): case for case in cases}
    require(len(by_case) == len(cases), 'Duplicate manifest case/task')
    by_generation = {key(row): row for row in rows}
    require(len(by_generation) == len(rows), 'Duplicate generation case/task')
    require(len({row['generation_id'] for row in rows}) == len(rows), 'Duplicate generation ID')
    require(set(by_generation) <= set(by_case), 'Unassigned generation in ledger')
    require(not any(case.get('eligible_for_final_test') for case in cases),
            'Unexpected independent-test eligibility claim')
    issues, public_text = [], {}
    for case in cases:
        case_key = key(case)
        row = by_generation.get(case_key)
        if row is None:
            issues.append({'task': case['task'], 'case_id': case['case_id'],
                           'issue': 'missing_generation'})
            continue
        require(row['run_id'] == run['run_id'], 'Generation run ID mismatch')
        require(row['generation_id'] == f"{run['run_id']}_{case['task']}_{case['case_id']}",
                'Generation ID is not bound to run/case/task')
        require(row['attempt_index'] == 1, 'Unexpected retry policy')
        require(row['model_digest'] == run['model']['digest'], 'Generation model digest mismatch')
        for field in ['input_sha256', 'request_sha256', 'prompt_sha256',
                      'generation_config_sha256', 'input_tokens_preflight', 'split']:
            require(row[field] == case[field], f'Generation binding mismatch: {field}')
        request = local_path(work, case['request_file'], private=True)
        require(request.is_file() and file_sha(request) == case['request_sha256'],
                'Private request evidence missing or changed')
        input_path = local_path(work, case['input_file'], private=True)
        require(input_path.is_file() and sha(canonical(read_json(input_path))) == case['input_sha256'],
                'Private input evidence missing or changed')
        raw_path = local_path(work, row['raw_response_file'], private=True)
        response_path = local_path(work, row['private_response_file'], private=True)
        require(raw_path.is_file() and file_sha(raw_path) == row['raw_response_sha256'],
                'Private raw response evidence missing or changed')
        require(response_path.is_file() and file_sha(response_path) == row['response_sha256'],
                'Private answer evidence missing or changed')
        if row.get('termination') == 'length' and row['status'] != 'length_limit':
            issues.append({'task': case['task'], 'case_id': case['case_id'],
                           'issue': 'length_termination_overrides_recorded_status',
                           'recorded_status': row['status']})
        if status(row) == 'valid':
            require(row.get('termination') == 'stop' and row.get('input_token_count_matches') is True,
                    'Valid generation has unverified termination or input length')
        if case['task'] == 'response' and case['split'] == PUBLIC:
            require(isinstance(case.get('public_input_messages'), list), 'Public input missing')
            public_text[case_key] = response_path.read_bytes().decode('utf-8')
    return run, complete, verification, cases, rows, issues, public_text


def measure(cases, rows, scope_id, label, task, split):
    selected = [case for case in cases if (task is None or case['task'] == task)
                and (split is None or case['split'] == split)]
    selected_keys = {key(case) for case in selected}
    observed = [row for row in rows if key(row) in selected_keys]
    counts = Counter(status(row) for row in observed)
    assigned, attempted = len(selected), len(observed)
    counts['missing_generation'] = assigned - attempted
    latency = describe(row.get('latency_seconds') for row in observed)
    latencies = sorted(row['latency_seconds'] for row in observed
                       if number(row.get('latency_seconds')) and row['latency_seconds'] >= 0)
    latency.update({'median': statistics.median(latencies) if latencies else None,
                    'p95': latencies[math.ceil(len(latencies) * .95) - 1] if latencies else None,
                    'p95_method': 'nearest-rank ceil(0.95*n)',
                    'scope': 'all attempted rows with measured wall latency, including failures'})
    pairs = [(row['generated_tokens'], row['eval_duration_ns']) for row in observed
             if number(row.get('generated_tokens')) and row['generated_tokens'] >= 0
             and number(row.get('eval_duration_ns')) and row['eval_duration_ns'] > 0]
    total_tokens = sum(tokens for tokens, _ in pairs)
    duration = sum(ns for _, ns in pairs)
    cache = describe(row.get('prompt_eval_cached_count') for row in observed)
    cache['requests_with_cache'] = sum(number(row.get('prompt_eval_cached_count'))
                                      and row['prompt_eval_cached_count'] > 0 for row in observed)
    cache['missing_records'] = attempted - cache['n']
    format_count = counts['format_error']
    errors = sum(count for name, count in counts.items()
                 if name not in {'valid', 'length_limit', 'format_error', 'missing_generation'})
    return {
        'scope_id': scope_id, 'label': label, 'task': task, 'split': split,
        'independent_test': False, 'assigned': assigned, 'attempted': attempted,
        'valid': counts['valid'], 'length_limit': counts['length_limit'],
        'format_error': format_count, 'error': errors, 'missing': assigned - attempted,
        'error_definition': 'all recorded statuses except valid/length_limit/format_error; excludes missing',
        'status_counts': dict(sorted(counts.items())),
        'raw_status_counts': dict(sorted(Counter(row['status'] for row in observed).items())),
        'rates_assigned': {name: rate(count, assigned) for name, count in {
            'attempted': attempted, 'valid': counts['valid'], 'length_limit': counts['length_limit'],
            'format_error': format_count, 'error': errors, 'missing': assigned - attempted}.items()},
        'wall_latency_seconds': latency,
        'input_tokens': describe(row.get('input_tokens') for row in observed),
        'output_tokens': describe(row.get('generated_tokens') for row in observed),
        'input_tokens_preflight': describe(case.get('input_tokens_preflight') for case in selected),
        'actual_input_plus_output_tokens': describe(row['input_tokens'] + row['generated_tokens']
            for row in observed if number(row.get('input_tokens')) and number(row.get('generated_tokens'))),
        'pooled_eval_tokens_per_second': {
            'value': total_tokens / (duration / 1e9) if duration else None,
            'output_tokens': total_tokens if pairs else None,
            'eval_duration_seconds': duration / 1e9 if pairs else None,
            'included_records': len(pairs), 'excluded_records': attempted - len(pairs),
            'formula': 'sum(generated_tokens) / (sum(eval_duration_ns) / 1e9)',
            'scope': 'all attempts with tokens and positive eval duration; includes length limits',
        },
        'prompt_eval_cached_count': cache,
        'human_review_denominators': {criterion: sum(case.get('criterion_applicability', {}).get(criterion)
            is True for case in selected if case['task'] == 'response') for criterion in CRITERIA},
        'action_accuracy_denominator': sum(case['task'] == 'action' for case in selected),
        'distinct_source_groups': len({case['source_group_id'] for case in selected}),
        'human_reviews_collected': 0, 'semantic_score': None,
    }


def evidence_manifest(work, run, complete, collected_at, rows):
    sources = [
        ('run', 'run_manifest.json', 'model, hardware, runtime, generation configuration'),
        ('cases', 'case_manifest.jsonl', 'task, split, criterion_applicability, input bindings'),
        ('generations', 'generations.jsonl', 'status, termination, token counts, durations, response bindings'),
        ('completion', 'COLLECTION_COMPLETE.json', 'run_id, assigned, attempted, generations_sha256'),
        ('model_verification', 'model_verification.json', 'verified, identity, summary'),
        ('dataset_audit', 'dataset_audit.json', 'selection, overlap counts, exclusions'),
        ('template', 'snapshots/평가양식/발표수치_결과양식.json', 'presentation schema'),
        ('ps', 'ps_latest.json', 'models[].size, size_vram; latest snapshot, not peak'),
        ('warmup', 'smoke.json', 'precollection smoke inference; not included in 94 assigned requests'),
    ]
    records = []
    for evidence_id, relative, fields in sources:
        path = work / relative
        records.append({'evidence_id': evidence_id, 'source_path': relative,
                        'field': fields, 'sha256': file_sha(path) if path.is_file() else None,
                        'run_id': run['run_id'], 'observed_at': collected_at,
                        'scope': 'BASE12 local development/public regression',
                        'status': 'verified' if path.is_file() else 'unknown'})
    records.append({'evidence_id': 'reporter', 'source_path': str(Path(__file__).resolve()),
                    'field': 'report aggregation implementation', 'sha256': file_sha(Path(__file__)),
                    'run_id': run['run_id'], 'observed_at': collected_at, 'scope': 'report code'})
    return {'run_id': run['run_id'], 'observed_at': collected_at, 'sources': records,
            'collection_completed_at': complete['completed_at'],
            'hash_checks': {'case_manifest': True, 'generation_ledger': True,
                            'input_request_raw_response_bindings': True,
                            'verified_generation_records': len(rows)},
            'private_evidence': [
                {'generation_id': row['generation_id'], 'case_id': row['case_id'], 'task': row['task'],
                 'response_sha256': row['response_sha256'],
                 'source_path': row['private_response_file'],
                 'raw_source_path': row['raw_response_file'],
                 'raw_sha256': row['raw_response_sha256']} for row in rows],
            'note': 'Private evidence index contains paths and hashes only; no counseling text.'}


def public_answers(template, cases, rows, public_text):
    by_case = {key(row): row for row in rows}
    answers, markdown = [], ['# BASE12 공개 합성 상담 실제 답변', '',
        '공개 합성 회귀 시나리오 31개 전체를 보존했다. 개발·회귀용이며 독립 최종 test가 아니다.',
        'BASE31·FT31 비교 출력과 사람 판정은 미수집이다. 길이 제한 응답도 그대로 표시한다.', '']
    for case in cases:
        if case['task'] != 'response' or case['split'] != PUBLIC:
            continue
        row = by_case.get(key(case))
        entry = deepcopy(template['answer_comparison_template'])
        messages = case['public_input_messages']
        question = '\n\n'.join(f"{message['role']}: {message['content']}" for message in messages)
        entry.update({'case_id': case['case_id'], 'input_sha256': case['input_sha256'],
                      'public_question': question, 'public_input_messages': messages,
                      'selection_reason': 'All preassigned public synthetic response cases; no outcome selection',
                      'excerpted': False, 'public_use_checked': True,
                      'public_use_basis': 'Frozen manifest identifies synthetic_public_regression; no real counseling',
                      'split': case['split'], 'independent_test': False,
                      'human_review_status': 'pending'})
        if row:
            entry['responses']['BASE12'].update({
                'public_response': public_text[key(case)], 'generation_id': row['generation_id'],
                'response_sha256': row['response_sha256'], 'generation_status': status(row),
                'recorded_status': row['status'], 'termination': row.get('termination')})
        answers.append(entry)
        markdown.extend([f"## {case['case_id']}", '', f"상태: {status(row) if row else 'missing_generation'}",
                         '', '입력:', '', *['> ' + line for line in question.splitlines()], '',
                         'BASE12 실제 답변:', '',
                         *['> ' + line for line in (public_text.get(key(case), '[미수집]')).splitlines()], '',
                         f"generation_id: `{row['generation_id'] if row else '[미수집]'}`", '',
                         f"response_sha256: `{row['response_sha256'] if row else '[미수집]'}`", ''])
    return answers, '\n'.join(markdown) + '\n'


def review_queue(cases, rows, run_id):
    by_case = {key(row): row for row in rows}
    queue = []
    for case in cases:
        if case['task'] != 'response':
            continue
        row = by_case.get(key(case))
        queue.append({'run_id': run_id, 'case_id': case['case_id'], 'condition': 'BASE12',
            'task': 'response', 'split': case['split'], 'input_sha256': case['input_sha256'],
            'generation_id': row['generation_id'] if row else None,
            'response_sha256': row['response_sha256'] if row else None,
            'private_input_file': case['input_file'],
            'private_response_file': row['private_response_file'] if row else None,
            'generation_status': status(row) if row else 'missing_generation',
            'criterion_applicability': case['criterion_applicability'],
            'criteria': {criterion: None for criterion in CRITERIA},
            'reviewer': None, 'reviewed_at': None, 'review_evidence': None,
            'review_status': 'pending', 'independent_test': False})
    return queue


def fmt(value, digits=2):
    return '[미확인]' if value is None else f'{value:,.{digits}f}'


def measurements_csv(metrics, scopes):
    output = io.StringIO(newline='')
    writer = csv.DictWriter(output, fieldnames=[
        'metric', 'scope', 'value', 'unit', 'numerator', 'denominator', 'status', 'evidence'])
    writer.writeheader()

    def add(metric, scope, value, unit, numerator=None, denominator=None,
            status_value=None, evidence='generations.jsonl;case_manifest.jsonl'):
        writer.writerow({'metric': metric, 'scope': scope, 'value': value, 'unit': unit,
                         'numerator': numerator, 'denominator': denominator,
                         'status': status_value or ('verified' if value is not None else 'unknown'),
                         'evidence': evidence})

    for metric in metrics['metrics']:
        for condition, value in metric.get('values', {}).items():
            add(metric['metric_id'], condition, value['value'], metric['unit'],
                value['numerator'], value['denominator'], value['status'], 'metrics.json')
        for comparison_id, value in metric.get('comparisons', {}).items():
            add(metric['metric_id'], comparison_id, value['change'], value['change_unit'],
                status_value=value['status'], evidence='metrics.json')
        for field in ('observation', 'derived_value'):
            if field in metric:
                value = metric[field]
                add(metric['metric_id'], metric.get('scope'), value['value'], metric['unit'],
                    value['numerator'], value['denominator'], value['status'], 'metrics.json')
    for scope_id, scope in scopes.items():
        name = 'BASE12/' + scope_id
        for metric in ('assigned', 'attempted', 'valid', 'length_limit', 'format_error', 'error', 'missing'):
            add(metric, name, scope[metric], 'requests', scope[metric], scope['assigned'])
        for metric, value in scope['rates_assigned'].items():
            add(metric + '_rate', name, value['percent'], 'percent', value['numerator'], value['denominator'])
        for metric in ('wall_latency_seconds', 'input_tokens', 'output_tokens',
                       'actual_input_plus_output_tokens', 'prompt_eval_cached_count'):
            values = scope[metric]
            unit = 'seconds' if metric == 'wall_latency_seconds' else 'tokens'
            for statistic in ('total', 'min', 'max', 'mean', 'median', 'p95'):
                if statistic in values:
                    add(metric + '_' + statistic, name, values[statistic], unit, denominator=values['n'])
        pooled = scope['pooled_eval_tokens_per_second']
        add('pooled_eval_tokens_per_second', name, pooled['value'], 'tokens/second',
            pooled['output_tokens'], pooled['eval_duration_seconds'])
        cache = scope['prompt_eval_cached_count']
        add('requests_with_prompt_cache', name, cache['requests_with_cache'], 'requests',
            cache['requests_with_cache'], cache['n'])
        for criterion, denominator in scope['human_review_denominators'].items():
            if denominator:
                add(criterion + '_human_review', name, None, 'percent', denominator=denominator,
                    evidence='case_manifest.jsonl;review_queue.jsonl')
        if scope['action_accuracy_denominator']:
            add('action_classification_accuracy', name, None, 'percent',
                denominator=scope['action_accuracy_denominator'], evidence='case_manifest.jsonl')
    memory = metrics['local_measurements']['inference_memory_snapshot']
    add('inference_memory_snapshot_size_vram', 'BASE12/latest_ps_snapshot_not_peak',
        memory['size_vram_gib'], 'GiB', evidence='ps_latest.json')
    add('peak_gpu_memory', 'BASE12', None, 'GiB', evidence='not_measured')
    return output.getvalue()


def comparison_markdown(metrics, scopes, run, complete):
    lines = ['# BASE12 로컬 실측 발표표', '',
        f"실행: `{run['run_id']}` · 수집 완료: {complete['completed_at']}", '',
        f"장치: {run['hardware']['chip']} / 통합 메모리 {run['hardware']['unified_memory_gib']} GiB. "
        f"모델: {run['model']['name']} / MLX NVFP4 / 학습 adapter 없음. 런타임: {run['runtime']}.", '',
        '독립 최종 test와 사람 품질 평가는 미완료다. 아래 품질 지표의 미확인을 0으로 표시하지 않는다.', '',
        '| 지표 | 원본 31B | 원본 12B | 학습 후 31B | Δ학습 | Δ소형 | 단위 | 분자/분모 | 상태 | 근거 |',
        '|---|---:|---:|---:|---:|---:|---|---|---|---|']
    for metric in metrics['metrics']:
        base12 = '비적용' if metric.get('values', {}).get('BASE12', {}).get('status') == 'not_applicable' else '[미확인]'
        delta12 = '비적용' if metric.get('comparisons', {}).get('FT31_vs_BASE12', {}).get('status') == 'not_applicable' else '[미확인]'
        denominator = '[미확인]/63 (개발32+합성31)' if metric['metric_id'] in QUALITY else (
            '[미확인]/31 (합성)' if metric['metric_id'] == 'action_classification_accuracy' else '[미확인]')
        lines.append(f"| {metric['label']} | [미확인] | {base12} | [미확인] | [미확인] | {delta12} | "
                     f"{metric['unit']} | {denominator} | 미확인 | metrics.json |")
    lines.extend(['', '## 생성 상태 실측', '',
        '분모는 각 행의 사전 배정 수다. 유효 완료는 정상 stop과 출력 형식 확인을 뜻하며 의미 품질 판정이 아니다.', '',
        '| 범위 | 배정 | 시도 | 유효 완료 | 길이 소진 | 형식 오류 | 기타 오류 | 누락 | 유효 완료율 |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|'])
    for scope in scopes.values():
        lines.append(f"| {scope['label']} | {scope['assigned']} | {scope['attempted']} | {scope['valid']} | "
                     f"{scope['length_limit']} | {scope['format_error']} | {scope['error']} | {scope['missing']} | "
                     f"{fmt(scope['rates_assigned']['valid']['percent'])}% |")
    lines.extend(['', '## 요청 시간·토큰 실측', '',
        '오류와 길이 소진을 포함해 해당 측정값이 있는 시도만 사용하며 n을 기록한다. p95는 nearest-rank 방식이다.', '',
        '| 범위 | 시간 n | 평균 초 | 중앙값 초 | p95 초 | 입력 토큰 합계 / 최소 / 최대 / 평균 | 출력 토큰 합계 / 최소 / 최대 / 평균 | pooled 출력 tok/s |',
        '|---|---:|---:|---:|---:|---|---|---:|'])
    for scope in scopes.values():
        latency = scope['wall_latency_seconds']
        tokens = [' / '.join(fmt(scope[field][stat], 2 if stat == 'mean' else 0)
                            for stat in ('total', 'min', 'max', 'mean'))
                  for field in ('input_tokens', 'output_tokens')]
        lines.append(f"| {scope['label']} | {latency['n']} | {fmt(latency['mean'])} | {fmt(latency['median'])} | "
                     f"{fmt(latency['p95'])} | {tokens[0]} | {tokens[1]} | "
                     f"{fmt(scope['pooled_eval_tokens_per_second']['value'])} |")
    overall = scopes['all_requests']
    cache = overall['prompt_eval_cached_count']
    memory = metrics['local_measurements']['inference_memory_snapshot']
    lines.extend(['', f"prompt cache: 측정 {cache['n']}건 중 cache>0 {cache['requests_with_cache']}건, "
                  f"cached token 합계 {fmt(cache['total'], 0)}, 누락 {cache['missing_records']}건.", '',
                  f"마지막 Ollama ps size_vram: {fmt(memory['size_vram_gib'])} GiB. "
                  'peak 메모리는 미측정이다. 전체 요청 속도는 상담과 짧은 분류를 섞은 기록이므로 상담 속도의 대표값으로 사용하지 않는다.', '',
                  '## 사용 범위와 한계', '', *['- ' + note for note in LIMITATIONS], '',
                  '근거: `evidence_manifest.json`, `generations.jsonl`, `case_manifest.jsonl`. '
                  '공개 합성 실제 답변: `public_answers.md`. 사람 검토 대기: `review_queue.jsonl`.'])
    return '\n'.join(lines) + '\n'


def build_reports(work):
    run, complete, verification, cases, rows, issues, public_text = validate(work)
    template = read_json(work / 'snapshots/평가양식/발표수치_결과양식.json')
    metrics = deepcopy(template)
    collected_at = datetime.now(timezone.utc).isoformat()
    scopes = {scope_id: measure(cases, rows, scope_id, label, task, split)
              for scope_id, label, task, split in SCOPES}
    ps_path = work / 'ps_latest.json'
    ps_model = next((model for model in read_json(ps_path).get('models', [])
                     if model.get('digest') == run['model']['digest']), {}) if ps_path.exists() else {}
    size_vram = ps_model.get('size_vram')
    audit = read_json(work / 'dataset_audit.json')
    evidence = evidence_manifest(work, run, complete, collected_at, rows)
    answers, public_markdown = public_answers(template, cases, rows, public_text)
    queue = review_queue(cases, rows, run['run_id'])
    metrics.update({'template_only': False, 'collection_status': 'partial',
                    'run_id': run['run_id'], 'collected_at': collected_at,
                    'generation_collection_status': 'complete' if len(rows) == len(cases) else 'partial',
                    'human_review_status': 'pending', 'comparison_ready': False,
                    'notes': template['notes'] + LIMITATIONS,
                    'evidence': evidence['sources'], 'answer_comparisons': answers})
    for metric in metrics['metrics']:
        metric_id = metric['metric_id']
        if metric_id in QUALITY or metric_id == 'action_classification_accuracy':
            reason = ('사람 검토·합의 판정 미수집' if metric_id in QUALITY else
                      '사람 검토 정답 라벨 미수집; 형식 유효성을 정확도로 대체하지 않음')
            metric.update({'status': 'unknown', 'scope': 'BASE12 local development/public regression; not final test',
                           'split': [LEGACY, PUBLIC] if metric_id in QUALITY else PUBLIC,
                           'observed_at': complete['completed_at'], 'missing_reason': reason,
                           'next_action': ('고정 사례·응답 해시에 연결된 사람 독립 검토와 합의 판정 수집'
                            if metric_id in QUALITY else '현재 합성31건은 개발 보조 분석에만 사용; 최종 정확도는 모델 출력 전에 '
                            '2명 독립 검토로 gold를 확정한 새 미사용 test에서 측정')})
            metric['values']['BASE12']['missing_reason'] = reason
        for condition, value in metric.get('values', {}).items():
            if condition in {'BASE31', 'FT31'} and value['status'] != 'not_applicable':
                value['missing_reason'] = '이번 로컬 수집에 해당 모델 출력 없음'
        for comparison in metric.get('comparisons', {}).values():
            if comparison['status'] != 'not_applicable':
                comparison['missing_reason'] = '동일 사례의 BASE31·FT31 출력과 사람 검토 미수집'
    metrics['local_measurements'] = {
        'condition': 'BASE12', 'status': 'verified' if not issues else 'partial',
        'observed_at': complete['completed_at'], 'independent_test': False,
        'model': {'tag': run['model']['name'], 'distribution_digest': run['model']['digest'],
                  'upstream_model_id': run['upstream_model_id'], 'upstream_revision': None,
                  'quantization': verification['identity']['quantization_level'],
                  'runner': verification['identity']['runner'], 'trained_adapter': False,
                  'scope': run['model_scope']},
        'hardware': run['hardware'], 'runtime': run['runtime'],
        'measurement_conditions': {'warm_run': True, 'precollection_smoke_requests': 1,
            'smoke_requests_in_assigned_denominator': 0, 'prompt_cache': 'runtime default; active',
            'latency_scope': 'single concurrency warm run, not cold start'},
        'configuration': {field: run[field] for field in ['attempts_per_case', 'concurrency',
            'response_max_new_tokens', 'classification_max_new_tokens', 'context_tokens',
            'thinking', 'seed', 'temperature']},
        'scopes': scopes,
        'inference_memory_snapshot': {
            'source': 'ps_latest.json', 'snapshot_file_mtime_utc': datetime.fromtimestamp(
                ps_path.stat().st_mtime, timezone.utc).isoformat() if ps_path.exists() else None,
            'model_size_bytes': ps_model.get('size'), 'size_vram_bytes': size_vram,
            'size_vram_gib': size_vram / 2 ** 30 if number(size_vram) else None,
            'peak_gpu_memory_bytes': None, 'is_peak': False,
            'interpretation': 'Latest Ollama model-memory snapshot on Apple unified memory; not process RSS or peak'},
        'pre_generation_exclusions': audit['pre_generation_exclusions'],
        'selected_development_source_groups': audit['selected_source_groups'],
        'public_response_distinct_source_groups': scopes['response_public_regression']['distinct_source_groups'],
        'legacy_train_validation_overlap_counts': audit['legacy_train_validation_overlap_counts'],
        'full_current_train_dev_overlap_audit': None,
        'collection_issues': issues,
        'nonvalid_generation_records': [
            {'case_id': row['case_id'], 'task': row['task'], 'split': row['split'],
             'generation_id': row['generation_id'], 'status': status(row),
             'recorded_status': row['status'], 'termination': row.get('termination'),
             'response_sha256': row['response_sha256'], 'raw_response_file': row['raw_response_file'],
             'error_present': row.get('error') is not None}
            for row in rows if status(row) != 'valid'],
        'action_label_counts_valid_outputs_only': dict(sorted(Counter(row['predicted_label']
            for row in rows if row['task'] == 'action' and status(row) == 'valid').items())),
        'evidence_ids': ['run', 'cases', 'generations', 'completion', 'model_verification', 'ps'],
    }
    missing = ['# 남은 미확인 항목', '',
        '생성 수집 완료와 품질·모델 간 비교 완료는 별개다. 기존 원자료와 실패 기록은 수정하지 않았다.', '',
        '| 항목 | 사유 | 필요 자료·다음 작업 |', '|---|---|---|',
        '| 요청 해결률·구체성·불필요 질문률 | 사람 검토 미수집 | 상담 63건 review_queue.jsonl에 generation_id+response_sha256로 사람 판정 연결; 실제32/합성31을 별도 보고 |',
        '| 행동 분류 정확도 | 승인 정답 없음 | 현재 합성31건의 사후 정답은 개발 보조 분석에만 사용. 최종 정확도는 모델 출력 전 2명 독립 검토로 gold를 확정한 새 미사용 test에서 측정; 현재 사례를 최종 test로 승격하지 않음 |',
        '| BASE31·FT31 및 Δ학습·Δ소형 | 동일 사례의 비교 모델 출력 없음 | 모델별 길이 검사 후 같은 정책·예산으로 수집, 완료 FT31 adapter 검증 |',
        '| 독립 최종 test 성능 | legacy 개발용·공개 합성 회귀 사용 | 학습/개발 중복 감사와 미사용 test 확보 |',
        '| NLL 및 감소율 | 로컬 BASE12 생성 수집 범위 밖 | 동일 31B tokenizer·마스크·평가 ID의 B0/B1; BASE12 NLL은 비적용 |',
        '| 본학습 완료·업데이트·승인 사례 수 | 이 수집에서 확인하지 않음 | 동일 학습 run 완료 기록·checkpoint·승인 기록 별도 검증 |',
        '| 원본 모델 revision 연결 | 로컬 배포 digest만 검증 | 원본 revision과 배포 변환 기록 연결 |',
        '| peak GPU 메모리·절대 최대 길이 | ps snapshot과 지정 예산만 있음 | 별도 계측·용량 검증; snapshot을 peak로 표기하지 않음 |',
        '| 심리학·CBT 학습 계획 | 승인 자료·일정 미수집 | 승인 계획과 자료 manifest 확보 |', '',
        '## 사전 제외 사례', '',
        *[f"- {row['case_id']}: {row['reason']}" for row in audit['pre_generation_exclusions']], '',
        '## 수집 오류·누락', '',
        f"기록된 비유효 시도: {sum(status(row) != 'valid' for row in rows)}건. "
        f"배정 후 생성 누락: {len(cases) - len(rows)}건. 세부 상태는 metrics.json의 local_measurements에 보존했다.", '',
        *['- ' + note for note in LIMITATIONS], '']
    artifacts = {
        'metrics.json': metrics,
        'answer_comparisons.json': {'run_id': run['run_id'], 'collection_status': 'partial',
                                  'independent_test': False, 'answer_comparisons': answers},
        'evidence_manifest.json': evidence,
        'comparison.md': comparison_markdown(metrics, scopes, run, complete),
        'missing.md': '\n'.join(missing), 'public_answers.md': public_markdown,
        'local_measurements.csv': measurements_csv(metrics, scopes),
        'review_queue.jsonl': ''.join(canonical(row).decode('utf-8') + '\n' for row in queue),
    }
    # Fully serialize before writing, so NaN or schema errors cannot leave half a report.
    serialized = {name: (json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n'
                         if name.endswith('.json') else value) for name, value in artifacts.items()}
    for name, contents in serialized.items():
        target = work / name
        temporary = work / (name + '.tmp')
        temporary.write_text(contents, encoding='utf-8')
        temporary.replace(target)
    return {'run_id': run['run_id'], 'artifacts': list(serialized),
            'assigned': len(cases), 'attempted': len(rows), 'public_answers': len(answers),
            'review_queue': len(queue), 'quality_scores': None, 'comparison_ready': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', type=Path, default=WORK, help='Frozen collection directory')
    args = parser.parse_args()
    try:
        result = build_reports(args.work.resolve())
    except (KeyError, OSError, ValueError) as exc:
        parser.exit(1, f'Report not completed: {exc}\n')
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))
