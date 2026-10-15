"""Join hash-bound independent AI reviews and publish the measured BASE12 subset."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import csv
import hashlib
import json
from pathlib import Path
import shutil
from zoneinfo import ZoneInfo
import summarize_base12_local as reporting

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / 'outputs/base12_local_20261009'
PPT = ROOT.parent / 'presentation'


def load(path):
    return json.loads(Path(path).read_text())


def rows(path):
    return [json.loads(s) for s in Path(path).read_text().splitlines() if s.strip()]


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, obj):
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=2, allow_nan=False) + '\n')


def integrate():
    checked_run, complete, verification, cases, generations, issues, public_text = reporting.validate(WORK)
    metrics = load(WORK / 'metrics.json')
    run = load(WORK / 'run_manifest.json')
    assert metrics['run_id'] == checked_run['run_id'] == run['run_id']
    for scope_id, label, task, split in reporting.SCOPES:
        assert metrics['local_measurements']['scopes'][scope_id] == reporting.measure(
            cases, generations, scope_id, label, task, split), 'Stale measurement report'
    protocol = load(WORK / 'ai_review_protocol.json')
    protocol_hash = sha(WORK / 'ai_review_protocol.json')
    public = {r['case_id']: r for r in rows(WORK / 'generations.jsonl')
              if r['task'] == 'response' and r['split'] == 'synthetic_public_regression'}
    assert len(public) == protocol['assigned_case_count'] == 31
    reviews = [r for p in sorted(WORK.glob('ai_reviews_batch*.jsonl')) for r in rows(p)]
    assert len({r['case_id'] for r in reviews}) == len(reviews) == 31
    assert {r['case_id'] for r in reviews} == set(public)
    for review in reviews:
        source = public[review['case_id']]
        assert review['run_id'] == run['run_id']
        assert review['generation_id'] == source['generation_id']
        assert review['response_sha256'] == source['response_sha256']
        assert review['protocol_sha256'] == protocol_hash
        assert review['reviewer_kind'] == 'ai_independent'
        assert review['independent_of_generator'] is True
        assert set(review['criteria']) == set(protocol['criteria'])
        assert review['reviewer_id'] and review['reviewed_at'] >= source['timestamp']
        for key, criterion in review['criteria'].items():
            allowed = protocol['question_verdicts'] if key == 'question_necessity' else protocol['allowed_verdicts']
            assert criterion['verdict'] in allowed and criterion['rationale'].strip()
    reviews.sort(key=lambda x: x['case_id'])
    (WORK / 'ai_reviews.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False, sort_keys=True) + '\n' for r in reviews))
    auxiliary = {'status': 'ai_auxiliary_only', 'condition': 'BASE12',
        'observed_at': max(r['reviewed_at'] for r in reviews),
        'scope': 'synthetic_public_regression', 'execution_units': 31, 'scenario_groups': 28,
        'reviewers': sorted({r['reviewer_id'] for r in reviews}), 'reviewer_kind': 'ai_independent',
        'human_approval': False, 'independent_test': False, 'clinical_validation': False,
        'protocol_sha256': protocol_hash, 'reviews_sha256': sha(WORK / 'ai_reviews.jsonl'),
        'metrics': {}, 'limitations': protocol['limitations']}
    definitions = [('request_resolution', '요청 해결률', 'pass'),
                   ('actionable_support', '말·행동 구체성 통과율', 'pass'),
                   ('subject_evidence', '주체·근거 보존율', 'pass'),
                   ('question_necessity', '불필요 질문률', 'unnecessary')]
    for key, label, numerator_verdict in definitions:
        counts = Counter(r['criteria'][key]['verdict'] for r in reviews)
        numerator = counts[numerator_verdict]
        auxiliary['metrics'][key] = {'label': label, 'value': numerator / 31 * 100,
            'numerator': numerator, 'denominator': 31, 'unit': 'percent', 'status_counts': dict(counts),
            'status': 'partial_ai_review' if counts['uncertain'] else 'reviewed_by_ai',
            'formula': f'100 * count({numerator_verdict}) / 31',
            'evidence': ['ai_reviews.jsonl', 'ai_review_protocol.json', 'generations.jsonl']}
    metrics['auxiliary_ai_review'] = auxiliary
    save(WORK / 'metrics.json', metrics)
    save(WORK / 'ai_review_summary.json', auxiliary)
    with (WORK / 'ai_review_metrics.csv').open('w') as f:
        writer = csv.writer(f)
        writer.writerow(['metric', 'BASE12_value', 'unit', 'numerator', 'denominator', 'status', 'scope'])
        for value in auxiliary['metrics'].values():
            writer.writerow([value['label'], value['value'], '%', value['numerator'], 31,
                             value['status'], 'public synthetic; AI review only'])
    lines = ['**원본 12B 답변 품질 — 독립 AI 보조 검토**', '',
        '공개 합성 회귀 31개 실행 사례(28개 상황 집단)에 대한 AI 검토다. 사람 평가·독립 test·임상 성능으로 해석하지 않는다.', '',
        '| 지표 | 원본 12B | 분자/분모 | 검토 상태 |', '|---|---:|---:|---|']
    for value in auxiliary['metrics'].values():
        state = '일부 미확정' if value['status'] == 'partial_ai_review' else 'AI 검토 완료'
        lines.append(f"| {value['label']} | {value['value']:.2f}% | {value['numerator']}/31 | {state} |")
    lines.extend(['', '불필요 질문은 현재 사용자에게 한 불필요·반복 질문만 센다. 제3자에게 건넬 말 예시 속 질문은 제외한다.',
                  '31B 두 조건과 사람 검토가 없어 Δ학습·Δ소형 및 최종 성능 우위는 미확인이다.', ''])
    ai_table = '\n'.join(lines)
    original = (WORK / 'comparison.md').read_text()
    marker = '**원본 12B 답변 품질 — 독립 AI 보조 검토**'
    (WORK / 'comparison.md').write_text(original.split(marker)[0].rstrip() + '\n\n' + ai_table)
    report_lines = [ai_table, '**판정 근거**', '']
    for review in reviews:
        report_lines += [f"**{review['case_id']}** · `{review['response_sha256']}`", '']
        for key, criterion in review['criteria'].items():
            report_lines.append(f"- {key}: {criterion['verdict']} — {criterion['rationale']}")
        report_lines.append('')
    (WORK / 'ai_review_report.md').write_text('\n'.join(report_lines))
    missing = (WORK / 'missing.md').read_text()
    missing += '\nAI 보조 검토 31건을 별도 수집했다. 사람 검토 대기 및 최종 test 미확인 상태는 유지한다.\n'
    (WORK / 'missing.md').write_text(missing)
    evidence = load(WORK / 'evidence_manifest.json')
    evidence['private_evidence_root'] = str(WORK)
    for item in evidence['private_evidence']:
        for field in ['source_path', 'raw_source_path']:
            item[field] = str(WORK / item[field])
    for filename, scope in [('ai_reviews.jsonl', 'independent AI auxiliary judgments, not human approval'),
                            ('ai_review_protocol.json', 'pre-review fixed rubric'),
                            ('environment.json', 'local runtime fingerprint'),
                            ('tags_after.json', 'unchanged model digest after collection'),
                            ('collector_provenance.json', 'executed code fingerprint')]:
        evidence['sources'].append({'evidence_id': filename, 'source_path': filename,
            'field': '*', 'sha256': sha(WORK / filename), 'run_id': run['run_id'],
            'observed_at': complete['completed_at'], 'scope': scope})
    save(WORK / 'evidence_manifest.json', evidence)
    queue = rows(WORK / 'review_queue.jsonl')
    for item in queue:
        item['private_evidence_root'] = str(WORK)
    (WORK / 'review_queue.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in queue))
    return metrics, run, ai_table


def stage_publication(metrics, run, ai_table):
    completed = load(WORK / 'COLLECTION_COMPLETE.json')['completed_at']
    completed_kst = datetime.fromisoformat(completed).astimezone(ZoneInfo('Asia/Seoul')).strftime('%Y-%m-%d %H:%M:%S KST')
    local = metrics['local_measurements']
    scopes = local['scopes']
    stamp = datetime.fromisoformat(completed).strftime('%Y%m%dT%H%M%SZ')
    folder = f"presentation_collection_{run['run_id']}_{stamp}"
    destination = PPT / 'outputs' / folder
    relative = 'outputs/' + folder
    doc = (WORK / 'snapshots/발표용_데이터_추출_활용안.md').read_text()
    doc = doc.replace('Gemma 4 12B IT 후보 · 정확한 ID·revision [미확인]',
                      'Gemma 4 12B IT · Ollama MLX NVFP4 · 학습 adapter 없음')
    doc = doc.replace('12B는 기존 프로젝트의 대안 기준이며 실측·설치 여부는 [미확인]. 학습 완료·성능도 근거 확보 전까지 [미확인].',
        f'12B는 로컬 M5·32GB에서 설치·생성을 검증했다. 배포 ID는 `gemma4:12b`, digest는 `{run["model"]["digest"]}`다. '
        'Google 원본 revision과의 연결은 미확인이다. 사람 검토 성능과 31B 비교는 아래 원칙에 따라 미확인으로 유지한다.')
    excerpt = ['**원본 12B 로컬 실측 — 발표에 사용 가능한 수치**', '',
        f'생성 측정 완료: {completed_kst}. 장치 **Apple M5·32GB**, Ollama 0.40.0·MLX·NVFP4, 프로젝트 adapter 없음. '
        '기존 검증용 상담 32건과 공개 합성 회귀 31건을 각각 측정했다. 독립 최종 test는 아니다.', '',
        '| 지표 | 기존 검증용 상담 | 공개 합성 상담 | 행동 분류 · 공개 합성 | 단위·조건 |',
        '|---|---:|---:|---:|---|']
    order = ['response_legacy_dev', 'response_public_regression', 'action_public_regression']
    data = [scopes[k] for k in order]
    excerpt.append('| 정상 종료·유효 출력 | ' + ' | '.join(
        f"{s['valid']}/{s['assigned']} ({s['rates_assigned']['valid']['percent']:.2f}%)" for s in data) + ' | 의미 정확도와 별개 |')
    excerpt.append('| 길이 소진 | ' + ' | '.join(str(s['length_limit']) for s in data) + ' | 건 |')
    excerpt.append('| 평균 응답 시간 | ' + ' | '.join(f"{s['wall_latency_seconds']['mean']:.2f}" for s in data) + ' | 초 · 모델 로드 후 단일 요청 |')
    excerpt.append('| 응답 시간 p95 | ' + ' | '.join(f"{s['wall_latency_seconds']['p95']:.2f}" for s in data) + ' | 초 · nearest-rank |')
    excerpt.append('| 평균 생성 길이 | ' + ' | '.join(f"{s['output_tokens']['mean']:.2f}" for s in data) + ' | 토큰 |')
    excerpt.append('| 생성 처리량 | ' + ' | '.join(f"{s['pooled_eval_tokens_per_second']['value']:.2f}" for s in data) + ' | 토큰/초 · Σ출력토큰÷Σ생성시간 |')
    excerpt += ['', '**방법:** temperature=0, seed=3407, thinking=false, 전체 문맥 4,096토큰, 상담 출력 예약 512토큰·분류 32토큰. '
        '최종 정답 발화를 제거한 입력만 사용했다. prompt cache가 활성화된 로컬 측정이며 서버 31B 속도와 직접 비교하지 않는다.', '',
        '모델 blobs **740/740개 해시·크기 일치**. 입력 토큰 사전 계산과 실제 API 기록을 모든 시도에서 대조했다. '
        '길이가 예산을 넘는 합성 장문 2건과 데이터 제작 절차 1건은 출력 전에 제외했다.', '',
        ai_table, '',
        f'[집계 JSON]({relative}/metrics.json) · [그래프용 실측 CSV]({relative}/local_measurements.csv) · '
        f'[AI 보조 수치 CSV]({relative}/ai_review_metrics.csv) · [AI 판정 근거]({relative}/ai_review_report.md) · '
        f'[공개 합성 실제 답변]({relative}/public_answers.md) · [근거 manifest]({relative}/evidence_manifest.json)', '']
    section = '\n'.join(excerpt)
    anchor = '**실제 답변 차이 — 3열 비교 + 항목별 점수**'
    assert doc.count(anchor) == 1
    doc = doc.replace(anchor, section + '\n' + anchor)
    snapshot = load(WORK / 'snapshots/발표데이터_최신확인_20261009.json')
    snapshot['base12_local_collection'] = {'run_id': run['run_id'], 'observed_at': completed,
        'artifact_directory': str(destination), 'local_measurements': local,
        'auxiliary_ai_review': metrics['auxiliary_ai_review'], 'human_reviewed_quality': None,
        'BASE31_comparison': None, 'FT31_comparison': None}
    stage = WORK / 'publication'; stage.mkdir(exist_ok=True)
    (stage / '발표용_데이터_추출_활용안.md').write_text(doc)
    save(stage / '발표데이터_최신확인_20261009.json', snapshot)
    public_names = ['metrics.json', 'comparison.md', 'missing.md', 'answer_comparisons.json',
        'public_answers.md', 'local_measurements.csv', 'review_queue.jsonl', 'evidence_manifest.json',
        'ai_reviews.jsonl', 'ai_review_protocol.json', 'ai_review_report.md', 'ai_review_summary.json',
        'ai_review_metrics.csv', 'run_manifest.json', 'case_manifest.jsonl', 'generations.jsonl',
        'COLLECTION_COMPLETE.json', 'model_verification.json', 'dataset_audit.json', 'environment.json',
        'collector.executed.py', 'collector_provenance.json', 'collector_tests.log',
        'tags.json', 'tags_after.json', 'show.json', 'version.json', 'ps_latest.json']
    public_names += [str(p.relative_to(WORK)) for p in sorted((WORK / 'snapshots').rglob('*')) if p.is_file()]
    public_names += [str(p.relative_to(WORK)) for p in sorted((WORK / 'evidence').glob('model_*')) if p.is_file()]
    artifacts = [{'path': name, 'sha256': sha(WORK / name)} for name in public_names]
    assert all(not item['path'].startswith('private/') for item in artifacts)
    save(stage / 'publication_manifest.json', {'destination': str(destination), 'run_id': run['run_id'],
        'private_evidence_root': str(WORK), 'public_artifacts': artifacts,
        'target_files': [{'name': name, 'before_sha256': sha(WORK / 'snapshots' / name),
                          'after_sha256': sha(stage / name)} for name in
                         ['발표용_데이터_추출_활용안.md', '발표데이터_최신확인_20261009.json']]})
    return destination


def publish():
    stage = WORK / 'publication'; manifest = load(stage / 'publication_manifest.json')
    destination = Path(manifest['destination'])
    assert not destination.exists(), 'Never overwrite previous collections'
    for item in manifest['target_files']:
        assert sha(PPT / item['name']) == item['before_sha256'], 'Presentation changed since snapshot; rebase required'
        assert sha(stage / item['name']) == item['after_sha256']
    for item in manifest['public_artifacts']:
        assert not item['path'].startswith('private/')
        assert sha(WORK / item['path']) == item['sha256'], 'Staged artifact changed'
    destination.mkdir(parents=True, exist_ok=False)
    for item in manifest['public_artifacts']:
        target = destination / item['path']; target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(WORK / item['path'], target)
        assert sha(target) == item['sha256']
    shutil.copy2(stage / 'publication_manifest.json', destination / 'publication_manifest.json')
    for item in manifest['target_files']:
        target = PPT / item['name']
        temporary = target.with_name(target.name + '.base12.tmp')
        shutil.copy2(stage / item['name'], temporary)
        temporary.replace(target)
        assert sha(target) == item['after_sha256']
    print(json.dumps({'published': str(destination), 'updated': [x['name'] for x in manifest['target_files']]}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--publish', action='store_true')
    args = parser.parse_args()
    if args.publish:
        publish()
    else:
        metrics, run, table = integrate()
        destination = stage_publication(metrics, run, table)
        print(json.dumps({'staged': str(destination), 'ai_metrics': metrics['auxiliary_ai_review']['metrics']}, ensure_ascii=False))
