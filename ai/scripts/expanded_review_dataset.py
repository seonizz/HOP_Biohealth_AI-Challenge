#!/usr/bin/env python3
"""Add answer and memory reviews to a frozen 12B source, without training."""
import argparse
from collections import Counter
from copy import deepcopy
from fractions import Fraction
from itertools import zip_longest
import json
from pathlib import Path
import shutil

import chat_role_expansion as e
import role_dataset as d

SCHEMA = 'malssi-expanded-reviews-12b-v2'
META = ('row_id', 'task', 'split', 'weight', 'source_group_ids', 'source_root_ids', 'target_sha256')


def read(path):
    return json.loads(Path(path).read_text())


def inventory(root):
    return {str(p.relative_to(root)): {'bytes': p.stat().st_size, 'sha256': d.file_hash(p)}
            for p in sorted(root.rglob('*')) if p.is_file()
            and p.relative_to(root).as_posix() not in ('MANIFEST.json', 'VERIFICATION.json')}


def projections(root):
    cases = e.admitted(root / 'source_cases')
    rows, coverage = [], Counter()
    for task, filename in (('answer_review', 'answer_projections.jsonl'), ('memory_review', 'memory_projections.jsonl')):
        projected = list(d.read_rows(root / filename))
        projection_sha = d.file_hash(root / filename)
        d.require({p['case_id'] for p in projected} == set(cases) and len(projected) == len(cases), 'Source inventory differs')
        for entry in projected:
            case, review = cases[entry['case_id']]
            d.require(entry['case_sha256'] == d.digest(d.canonical(case)) and len(entry['rows']) == 4, 'Source binding changed')
            stages = Counter()
            for raw in entry['rows']:
                row = deepcopy(raw)
                metadata = row['review_metadata']
                d.require(row['task'] == task and type(metadata['approved']) is bool, 'Wrong task/label')
                stages[(metadata['stage'], metadata['approved'])] += 1
                label = json.loads(row['messages'][-1]['content'])
                judge = label if task == 'answer_review' else label['state']
                d.require(judge['approved'] == metadata['approved'] and judge['approved'] == (not judge['issues']), 'Label mismatch')
                lineage = 'synthetic:chat-expansion-20261031:' + case['case_id']
                row.update(row_id='review-v2-' + case['case_id'] + '-' + row['variant'],
                    phase='04_result_review', split=case['split'], weight={'numerator': 1, 'denominator': 1},
                    source_root_ids=[lineage], source_group_ids=[lineage],
                    loss_message_mask=[0, 0, 1], target_sha256=d.digest(row['messages'][-1]['content']),
                    origin_type='synthetic_perturbation_of_independently_ai_reviewed_fictional_source',
                    provenance=[{'case_id': case['case_id'], 'case_sha256': entry['case_sha256'],
                        'original_source_review_sha256': d.digest(d.canonical(review)),
                        'projection_sha256': projection_sha,
                        'transformation': 'time_scoped_positive_and_synthetic_negative_review_pair'}],
                    approval_scope='original_source_all_reviewed_new_labels_semantic_sample_only')
                d.check_row(row)
                coverage[(task, case['split'], metadata['stage'], metadata['approved'])] += 1
                rows.append(row)
            d.require(stages == {(1, True): 1, (1, False): 1, (2, True): 1, (2, False): 1}, 'Unbalanced time/label pairs')
    d.require(len(rows) == 1600, 'Expected 1600 new review rows')
    return rows, {'/'.join(map(str, k)): v for k, v in sorted(coverage.items())}


def validate_reviews(root):
    for task in ('answer', 'memory'):
        proof = read(root / 'reviews' / (task + '_review_native.json'))
        d.require(proof['status'] == 'approved_sample', 'Independent semantic sample requires fixes')
        d.require(proof['projection_sha256'] == d.file_hash(root / (task + '_projections.jsonl')), 'Stale semantic sample review')
        ids = proof['sampled_case_ids']
        d.require(len(ids) == len(set(ids)) and len(ids) >= 20, 'Incomplete semantic sample')
        report = read(root / (task + '_projections.jsonl.verification.json'))
        report_hash = report.get('projections_sha256', report.get('projection_sha256'))
        d.require(report['status'] == 'passed' and report_hash == proof['projection_sha256']
                  and report['cases'] == 200 and report['rows'] == 800, 'Stale structural projection evidence')
        d.require(not proof.get('unresolved_issues', []), 'Unresolved semantic sample issues')
        entries = {r['case_id']: r for r in d.read_rows(root / (task + '_projections.jsonl'))}
        d.require(set(ids) <= set(entries), 'Unknown sampled source')
        d.require(isinstance(proof.get('sampled_rows'), list) and len(proof['sampled_rows']) == 4 * len(ids), 'Missing semantic row-level evidence')
        expected = {(i, r['variant']): d.digest(d.canonical(r)) for i in ids for r in entries[i]['rows']}
        actual = {(r['case_id'], r['variant']): r['row_sha256'] for r in proof['sampled_rows']}
        d.require(len(actual) == len(proof['sampled_rows']) and actual == expected, 'Semantic sample row hashes differ or duplicate')
        d.require(all(not r.get('issues', []) for r in proof['sampled_rows']), 'Unresolved semantic row issues')
    return {'status': 'approved_stratified_sample', 'source_cases': 200,
            'sampled_cases_per_task': 20, 'sampled_rows_per_task': 80,
            'all_new_rows_semantically_reviewed': False, 'human_or_clinical_validation': False}


def verify(root):
    root = root.resolve(strict=True)
    manifest = read(root / 'MANIFEST.json')
    d.require(manifest['schema'] == SCHEMA and manifest['files'] == inventory(root), 'Changed review bundle')
    for name in manifest['files']:
        d.safe_path(root, name)
    base = read(root / 'provenance/BASE_COURSE.json')
    base_manifest = read(root / 'provenance/BASE_MANIFEST.json')
    binding = read(root / 'provenance/REVIEW_BINDING.json')
    d.require(d.file_hash(root / 'provenance/BASE_MANIFEST.json') == binding['base_manifest_sha256'], 'Base binding changed')
    course = read(root / 'COURSE.json')
    d.require(course['phases'][:-1] == base['phases'] and course['model'] == base['model'] and course['loss'] == base['loss'], 'Base contract changed')
    d.require(course['phases'][-1]['id'] == '04_result_review', 'Review phase absent')
    for key in ('truncation', 'packing', 'split_reassignment', 'validation_used_for_gradient', 'training_started'):
        d.require(course[key] is False, 'Wrong flag ' + key)
    for filename, expected in course['model']['tokenizer_sha256'].items():
        d.require(d.file_hash(root / 'tokenizer' / filename) == expected, 'Tokenizer changed')
    for phase in base['phases']:
        for part in phase['data'].values():
            for key in ('path', 'token_index', 'token_binary'):
                d.require(d.file_hash(root / part[key]) == base_manifest['files'][part[key]]['sha256'], 'Old data changed')
    reviewroot = root / 'provenance/review_expansion'
    semantic = validate_reviews(reviewroot)
    projected, coverage = projections(reviewroot)
    lineage = {s: set() for s in d.SPLITS}
    inputs = {s: set() for s in d.SPLITS}
    seen, counts = set(), {}
    for phase in course['phases']:
        counts[phase['id']] = {}
        for split, part in phase['data'].items():
            rows = list(d.read_rows(root / part['path']))
            loader = d.IndexedTokens(root / part['token_index'], root / part['token_binary'])
            if phase['id'] == '04_result_review':
                d.require(rows == d.balance([r for r in projected if r['split'] == split]), 'New projected rows changed')
            mass, tasks = Fraction(), Counter()
            with loader.binary.open('rb') as binary:
                for row, index in zip_longest(rows, loader.entries):
                    d.require(row is not None and index is not None, 'Index/row count mismatch')
                    d.check_row(row)
                    d.require(row['row_id'] not in seen and row['split'] == split, 'Row duplication/wrong split')
                    seen.add(row['row_id'])
                    for key in META:
                        d.require(row[key] == index[key], 'Token metadata mismatch')
                    d.require(d.digest(d.canonical(row['messages'])) == index['messages_sha256'], 'Text/token hash mismatch')
                    raw = binary.read(index['sequence_length'] * 4)
                    d.require(len(raw) == index['sequence_length'] * 4, 'Token file truncated')
                    if 'token_sha256' in index:
                        d.require(d.digest(raw) == index['token_sha256'], 'Token bytes mismatch')
                    lineage[split].update(row['source_group_ids'] + row['source_root_ids'])
                    inputs[split].add(d.digest(d.canonical(row['messages'][:-1])))
                    mass += Fraction(**row['weight']); tasks[row['task']] += 1
                d.require(binary.read() == b'', 'Trailing tokens')
            d.require(mass == len(rows) == part['rows'] and dict(tasks) == part['tasks'], 'Counts/weights mismatch')
            counts[phase['id']][split] = len(rows)
    d.require(not (lineage['train'] & lineage['validation']), 'Cross-split source leakage')
    d.require(not (inputs['train'] & inputs['validation']), 'Cross-split exact input leakage')
    audit = read(root / 'NUMERIC_AUDIT.json')
    d.require(audit['mismatches'] == 0 and audit['independently_reencoded_rows'] == 3296, 'Missing new numeric audit')
    return {'status': 'passed', 'counts': counts, 'new_review_rows': 1600, 'coverage': coverage,
            'source_cases_reused': 200, 'new_independent_source_cases': 0,
            'cross_split_lineage_collisions': 0, 'exact_input_cross_split_collisions': 0,
            'independent_numeric_audit': audit, 'semantic_review': semantic, 'training_started': False}


def build(base, expansion, output):
    import encode_chat_role as encoder
    import expanded_chat_dataset as previous
    base, expansion = base.resolve(strict=True), expansion.resolve(strict=True)
    d.require(not output.exists() and output.parent.resolve().name == 'training_data', 'Use fresh ignored root')
    base_report = previous.verify(base)
    validate_reviews(expansion)
    new, coverage = projections(expansion)
    shutil.copytree(base, output)
    shutil.copyfile(base / 'COURSE.json', output / 'provenance/BASE_COURSE.json')
    shutil.copyfile(base / 'MANIFEST.json', output / 'provenance/BASE_MANIFEST.json')
    d.save(output / 'provenance/BASE_VERIFICATION.json', base_report)
    # Only final admitted projections/reviews, not failed intermediate outputs.
    proof = output / 'provenance/review_expansion'
    proof.mkdir()
    shutil.copytree(expansion / 'source_cases', proof / 'source_cases')
    shutil.copytree(expansion / 'reviews', proof / 'reviews')
    for name in ('answer_projections.jsonl', 'memory_projections.jsonl',
                 'answer_projections.jsonl.verification.json', 'memory_projections.jsonl.verification.json'):
        shutil.copyfile(expansion / name, proof / name)
    d.save(output / 'provenance/REVIEW_BINDING.json', {'base_manifest_sha256': d.file_hash(base / 'MANIFEST.json'),
        'base_root_at_build': str(base), 'new_source_cases': 0,
        'new_labels': 'deterministic_perturbations_with_stratified_independent_semantic_sample'})
    course = read(base / 'COURSE.json')
    course.update(schema=SCHEMA, coverage_status='answer_question_memory_review_expansion',
        quality_status='original_sources_ai_reviewed_new_labels_independent_semantic_sample_only')
    phase = {'id': '04_result_review', 'purpose': 'full_answer_and_memory_review_normal_and_synthetic_errors', 'data': {}}
    encoder.initialize(output / 'tokenizer')
    tokenization = read(base / 'TOKENIZATION.json')
    for split in d.SPLITS:
        part = d.write_partition(output, phase['id'], split, d.balance([r for r in new if r['split'] == split]))
        stats = previous.encode(output, phase['id'], split, part)
        phase['data'][split] = part
        tokenization['partitions'][phase['id'] + '/' + split] = stats
        print(d.canonical({'encoded_review_split': split, **stats}), flush=True)
    course['phases'].append(phase)
    d.save(output / 'TOKENIZATION.json', tokenization)
    d.save(output / 'COURSE.json', course)
    # Independent public HF API re-encodes all old+new role rows; no model weights.
    d.save(output / 'NUMERIC_AUDIT.json', previous.audit_numeric(output))
    d.save(output / 'ADMISSION.json', {'new_review_rows': 1600, 'coverage': coverage, **validate_reviews(expansion)})
    for name in ('expanded_review_dataset.py', 'project_answer_review_cases.py', 'project_memory_review_cases.mjs'):
        shutil.copyfile(Path(__file__).with_name(name), output / 'scripts' / name)
    (output / 'README.md').write_text('''# 12B 검토 증량 원본 v2 — 2026-11-01

기존 12B 전체 자료를 유지하고 답변 전체 검토 800행, 메모리 검토 800행을 추가했습니다. 원천은 기존 가상200사례를 재사용하며 새 독립 사례1600개가 아닙니다. 각 신규 과제는 train640/validation160, 시점별 정상/반려1:1입니다.

answer_review는 별도 학습 데이터 계약입니다. memory_review는 실제 앱 turn_review 프롬프트·출력 스키마·검증기를 사용하고 전체 사용자 원문 reported_dialogue를 추가한 입력 확장입니다. 현재 앱 자동 라우팅/배포까지 완료했다는 뜻은 아닙니다.

원천200사례는 기존 독립AI검토를 유지합니다. 신규1600행은 전수 구조·원문·분할·수치 검증을 하고 과제별20사례80행을 독립 의미 표본검토했습니다. 모든 신규행을 의미적으로 독립 검토한 것은 아닙니다. 정상 답변은 기존 검토된 답변, 오류는 결정적 합성 변형이며 실제 모델 오류 분포·장기 대화·임상 안전을 대표하지 않습니다.

이 원본에서 B검토용과 C통합용 ZIP을 파생합니다. 기존 A 및 이전 ZIP은 보존합니다. 기존 종료 정책은 새 데이터에 해시 재결합되지 않았으며 새 버전 baseline/역할 평가를 연결해야 합니다. 학습은 실행하지 않았습니다.
''', encoding='utf-8')
    d.save(output / 'MANIFEST.json', {'schema': SCHEMA, 'files': inventory(output)})
    result = verify(output)
    d.save(output / 'VERIFICATION.json', result)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('build', 'verify'))
    parser.add_argument('--base', type=Path)
    parser.add_argument('--expansion', type=Path)
    parser.add_argument('--root', type=Path, required=True)
    args = parser.parse_args()
    print(d.canonical(verify(args.root) if args.command == 'verify' else build(args.base, args.expansion, args.root)))
