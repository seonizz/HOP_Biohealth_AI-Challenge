#!/usr/bin/env python3
"""Create three local, standalone 12B dataset ZIPs without training or inference."""
import argparse
from collections import Counter
from copy import deepcopy
from fractions import Fraction
import hashlib
from itertools import zip_longest
import json
from pathlib import Path
import shutil
import zipfile

import role_dataset as d

SCHEMA = 'malssi-chat-variants-v1'
VARIANTS = {
    'A_generator': {'conversation', 'supporter_chat', 'question_plan',
                    'state_observations', 'relationship_memory', 'turn_draft'},
    'B_question_reviewer': {'question_review'},
    'B_reviewer': {'question_review', 'answer_review', 'memory_review'},
    'C_combined': {'conversation', 'supporter_chat', 'question_plan',
                   'state_observations', 'relationship_memory', 'turn_draft', 'question_review', 'answer_review', 'memory_review'},
}
META = ('row_id', 'task', 'split', 'weight', 'source_group_ids', 'source_root_ids', 'target_sha256')


def read(path):
    return json.loads(Path(path).read_text())


def inventory(root):
    return {str(p.relative_to(root)): {'bytes': p.stat().st_size, 'sha256': d.file_hash(p)}
            for p in sorted(root.rglob('*')) if p.is_file()
            and p.relative_to(root).as_posix() not in ('MANIFEST.json', 'VERIFICATION.json')}


def subset_tokens(source, output, oldpart, part, rows):
    indexes = {r['row_id']: r for r in d.read_rows(source / oldpart['token_index'])}
    folder = output / 'encoded' / Path(part['path']).parent.name
    folder.mkdir(parents=True, exist_ok=True)
    split = rows[0]['split']
    idxpath, binpath = folder / (split + '.index.jsonl'), folder / (split + '.tokens.bin')
    offset = 0
    with (source / oldpart['token_binary']).open('rb') as src, binpath.open('xb') as dst, idxpath.open('x') as idx:
        for row in rows:
            entry = deepcopy(indexes[row['row_id']])
            src.seek(entry['offset_tokens'] * 4)
            raw = src.read(entry['sequence_length'] * 4)
            d.require(len(raw) == entry['sequence_length'] * 4 and d.digest(raw) == entry['token_sha256'],
                      'Source token bytes changed')
            entry['offset_tokens'] = offset
            for key in META:
                entry[key] = row[key]
            dst.write(raw)
            idx.write(d.canonical(entry) + '\n')
            offset += entry['sequence_length']
    part.update(token_index=str(idxpath.relative_to(output)), token_binary=str(binpath.relative_to(output)))


def verify(root, source=None):
    root = root.resolve(strict=True)
    manifest = read(root / 'MANIFEST.json')
    d.require(manifest['schema'] == SCHEMA and manifest['files'] == inventory(root), 'Bundle inventory changed')
    for name in manifest['files']:
        d.safe_path(root, name)
    course = read(root / 'COURSE.json')
    variant = course['variant']
    allowed = VARIANTS[variant] | {'original_counselor_continuation'}
    original = read(root / 'provenance/SOURCE_COURSE.json')
    binding = read(root / 'provenance/SOURCE_BINDING.json')
    d.require(d.file_hash(root / 'provenance/SOURCE_MANIFEST.json') == binding['manifest_sha256'], 'Source manifest changed')
    source_manifest = read(root / 'provenance/SOURCE_MANIFEST.json')['files']
    d.require(d.file_hash(root / 'provenance/SOURCE_COURSE.json') == source_manifest['COURSE.json']['sha256'], 'Source course changed')
    d.require(course['model'] == original['model'] and course['loss'] == original['loss'], 'Model/loss changed')
    for key in ('truncation', 'packing', 'split_reassignment', 'validation_used_for_gradient', 'training_started'):
        d.require(course[key] is False, 'Invalid flag: ' + key)
    for name, expected in course['model']['tokenizer_sha256'].items():
        d.require(d.file_hash(root / 'tokenizer' / name) == expected, 'Tokenizer mismatch')
    if source:
        d.require(d.file_hash(source / 'MANIFEST.json') == binding['manifest_sha256'], 'Wrong source')
    oldphases = {p['id']: p for p in original['phases']}
    expected_phases = [p['id'] for p in original['phases'] if any(
        set(part['tasks']) & allowed for part in p['data'].values())]
    d.require([p['id'] for p in course['phases']] == expected_phases, 'Phase inventory changed')
    seen, lineage, inputs, counts = set(), {s: set() for s in d.SPLITS}, {s: set() for s in d.SPLITS}, {}
    total_tokens = 0
    for phase in course['phases']:
        counts[phase['id']] = {}
        for split in d.SPLITS:
            part = phase['data'][split]
            oldpart = oldphases[phase['id']]['data'][split]
            expected_tasks = {k: v for k, v in oldpart['tasks'].items() if k in allowed}
            d.require(part['tasks'] == expected_tasks, 'Filtered task inventory mismatch')
            rows = list(d.read_rows(root / part['path']))
            loader = d.IndexedTokens(root / part['token_index'], root / part['token_binary'])
            expected_weights = {r['row_id']: r['weight'] for r in d.balance(rows)}
            if phase['id'] == '01_dialogue_warmup':
                for key in ('path', 'token_index', 'token_binary'):
                    d.require(d.file_hash(root / part[key]) == source_manifest[oldpart[key]]['sha256'], 'Warmup changed')
            elif source:
                expected_rows = d.balance([r for r in d.read_rows(source / oldpart['path']) if r['task'] in allowed])
                d.require(rows == expected_rows, 'Filtered source text/metadata changed')
                source_indexes = {r['row_id']: r for r in d.read_rows(source / oldpart['token_index'])}
                for entry in loader.entries:
                    oldentry = source_indexes[entry['row_id']]
                    for key in ('token_sha256', 'prefix_length', 'sequence_length', 'target_length', 'messages_sha256'):
                        d.require(entry[key] == oldentry[key], 'Token identity/boundary changed')
            tasks, mass = Counter(), Fraction()
            with loader.binary.open('rb') as binary:
                for row, entry in zip_longest(rows, loader.entries):
                    d.require(row is not None and entry is not None, 'Token row inventory mismatch')
                    d.check_row(row)
                    d.require(row['task'] in allowed and row['split'] == split and row['row_id'] not in seen, 'Unexpected row')
                    d.require(row['weight'] == expected_weights[row['row_id']], 'Unbalanced weights')
                    for key in META:
                        d.require(row[key] == entry[key], 'Token metadata mismatch')
                    d.require(d.digest(d.canonical(row['messages'])) == entry['messages_sha256'], 'Text/token identity mismatch')
                    raw = binary.read(entry['sequence_length'] * 4)
                    d.require(len(raw) == entry['sequence_length'] * 4, 'Short token file')
                    if 'token_sha256' in entry:
                        d.require(d.digest(raw) == entry['token_sha256'], 'Token bytes mismatch')
                    d.require(entry['sequence_length'] <= 32768, 'Sequence over model export limit')
                    seen.add(row['row_id'])
                    lineage[split].update(row['source_group_ids'] + row['source_root_ids'])
                    inputs[split].add(d.digest(d.canonical(row['messages'][:-1])))
                    tasks[row['task']] += 1
                    mass += Fraction(**row['weight'])
                    total_tokens += entry['sequence_length']
                d.require(binary.read() == b'', 'Trailing token data')
            d.require(dict(tasks) == expected_tasks and len(rows) == part['rows'] and mass == len(rows), 'Counts/weights mismatch')
            d.require(part['id_set_sha256'] == d.digest('\n'.join(sorted(r['row_id'] for r in rows))), 'ID set mismatch')
            counts[phase['id']][split] = len(rows)
    d.require(not (lineage['train'] & lineage['validation']), 'Source lineage leakage')
    d.require(not (inputs['train'] & inputs['validation']), 'Exact input leakage')
    return {'status': 'passed', 'variant': variant, 'counts': counts,
            'totals': {s: sum(p[s] for p in counts.values()) for s in d.SPLITS},
            'role_totals': {s: sum(p[s] for k, p in counts.items() if k != '01_dialogue_warmup') for s in d.SPLITS},
            'sequence_tokens': total_tokens, 'cross_split_lineage_collisions': 0,
            'exact_input_cross_split_collisions': 0, 'source_row_and_token_identity_verified': bool(source),
            'training_started': False, 'new_examples_authored': sum(p['data'][s]['rows'] for p in course['phases'] if p['id'] == '04_result_review' for s in d.SPLITS)}


def archive(root):
    path = root.with_suffix('.zip')
    with zipfile.ZipFile(path, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as out:
        for file in sorted(root.rglob('*')):
            if file.is_file():
                out.write(file, root.name + '/' + str(file.relative_to(root)))
    expected = {root.name + '/' + str(p.relative_to(root)): {'sha256': d.file_hash(p), 'bytes': p.stat().st_size}
                for p in root.rglob('*') if p.is_file()}
    with zipfile.ZipFile(path) as zipped:
        d.require(len(zipped.namelist()) == len(expected) and set(zipped.namelist()) == set(expected), 'ZIP inventory mismatch')
        for name, info in expected.items():
            sha, size = hashlib.sha256(), 0
            with zipped.open(name) as handle:
                for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b''):
                    sha.update(chunk)
                    size += len(chunk)
            d.require(sha.hexdigest() == info['sha256'] and size == info['bytes'], 'ZIP content mismatch')
    return {'file': path.name, 'bytes': path.stat().st_size, 'sha256': d.file_hash(path),
            'verified_members': len(expected), 'all_member_hashes_and_crc_verified': True}


def build(source, output, variants=None, tag='20261101'):
    import expanded_chat_dataset
    source = source.resolve(strict=True)
    d.require(output.parent.resolve().name == 'training_data' and not output.exists(), 'Use a new training_data directory')
    if read(source / 'COURSE.json')['schema'] == 'malssi-expanded-reviews-12b-v2':
        import expanded_review_dataset
        source_report = expanded_review_dataset.verify(source)
    else:
        source_report = expanded_chat_dataset.verify(source)
    original = read(source / 'COURSE.json')
    output.mkdir(mode=0o700)
    summary = {'schema': SCHEMA, 'date': '2026-11-01', 'source_manifest_sha256': d.file_hash(source / 'MANIFEST.json'),
               'variants': {}, 'training_started': False, 'new_examples_authored': 0}
    for variant in variants or ('A_generator', 'B_question_reviewer', 'C_combined'):
        allowed = VARIANTS[variant]
        root = output / ('gemma4_12b_' + variant + '_' + tag)
        root.mkdir(mode=0o700)
        (root / 'scripts').mkdir()
        (root / 'provenance').mkdir()
        shutil.copytree(source / 'tokenizer', root / 'tokenizer')
        for filename in ('MANIFEST.json', 'COURSE.json', 'NUMERIC_AUDIT.json', 'APP_CONTRACT.json'):
            shutil.copyfile(source / filename, root / 'provenance' / ('SOURCE_' + filename))
        d.save(root / 'provenance/SOURCE_VERIFICATION.json', source_report)
        if 'semantic_review' in source_report:
            shutil.copytree(source / 'provenance/review_expansion/reviews', root / 'provenance/independent_review_samples')
            shutil.copyfile(source / 'ADMISSION.json', root / 'provenance/REVIEW_ADMISSION.json')
            shutil.copyfile(source / 'provenance/review_expansion/memory_projections.jsonl.verification.json', root / 'provenance/MEMORY_REVIEW_APP_CONTRACT.json')
        d.save(root / 'provenance/SOURCE_BINDING.json', {'manifest_sha256': summary['source_manifest_sha256'],
            'source_root_at_build': str(source), 'selection': sorted(allowed),
            'transformation': 'unchanged_messages_and_tokens_filtered_by_task_rebalanced_per_phase'})
        course = deepcopy(original)
        course.update(schema=SCHEMA, variant=variant, phases=[],
                      coverage_status='task_subset_of_verified_source_with_scope_in_readme',
                      source_app_contract='provenance/SOURCE_APP_CONTRACT.json',
                      evaluation_policy_status='not_rebound_to_variant_requires_variant_baseline_and_role_evaluation')
        for oldphase in original['phases']:
            warmup = oldphase['id'] == '01_dialogue_warmup'
            if not warmup and not (set(oldphase['data']['train']['tasks']) & allowed):
                continue
            phase = deepcopy(oldphase)
            phase['purpose'] = 'shared_original_counseling_warmup' if warmup else variant + '_role_specialization'
            for split, oldpart in oldphase['data'].items():
                if warmup:
                    for key in ('path', 'token_index', 'token_binary'):
                        dest = root / oldpart[key]
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copyfile(source / oldpart[key], dest)
                else:
                    rows = d.balance([r for r in d.read_rows(source / oldpart['path']) if r['task'] in allowed])
                    part = d.write_partition(root, phase['id'], split, rows)
                    subset_tokens(source, root, oldpart, part, rows)
                    phase['data'][split] = part
            course['phases'].append(phase)
        d.save(root / 'COURSE.json', course)
        for filename in ('package_chat_variants.py', 'role_dataset.py'):
            shutil.copyfile(Path(__file__).with_name(filename), root / 'scripts' / filename)
        counts = {s: sum(p['data'][s]['rows'] for p in course['phases']) for s in d.SPLITS}
        rolecounts = {s: sum(p['data'][s]['rows'] for p in course['phases'][1:]) for s in d.SPLITS}
        expanded = 'answer_review' in {t for p in course['phases'] for t in p['data']['train']['tasks']}
        scope_note = ('''답변 전체 검토(answer_review)와 메모리 검토(memory_review)를 추가했습니다. 신규 각 과제는 train640/validation160이며 정상/오류가 시점별1:1입니다. 기존 질문 검토는 train320/validation80입니다. 기존200가상사례에서 파생한 자료이며 새 독립사례1600개가 아닙니다.

answer_review는 별도 데이터 계약이며 앱에 자동 연결한 기능이 아닙니다. memory_review는 앱 turn_review 프롬프트·출력스키마·검증콜백을 사용하며 전체 원문 reported_dialogue를 추가한 입력확장입니다. 일반 안전·위기·임상 검토 전용 자료나 검토 후 답변 수정 자료를 추가했다는 뜻은 아닙니다.

신규1600행은 전수 구조·인용·분할·토큰검사를 수행하고 독립 의미 표본검토는 과제별20사례80행(각10%)에 한정합니다. 미검토행까지 독립 의미 승인을 받았다고 간주하지 마세요. 오류는 합성변형이며 실제 모델 오류·장기 대화·복합 오류 분포를 대표하지 않습니다.

역할 train 기준 B는 질문검토20%, 답변검토40%, 메모리검토40%입니다. C는 생성·추출38.8%, 검토61.2%입니다. 행 수 비율이며 단계별 손실 가중치와 동일하지 않습니다. 단계별 COURSE 순서를 유지하며 최종 평가에서는 세 검토 과제를 모두 다시 검사해야 합니다.''' if expanded else '''B는 질문 검토 전용이며 C도 질문 검토만 포함합니다. 완성 답변 전체 검토, 메모리 검토, turn_review, safety_review, 검토 후 답변 수정 자료를 새로 추가한 묶음이 아닙니다. 이전 기획의 생성/수정75:25 목표를 달성했다고 간주하지 마세요.''')
        text = f'''# Gemma 4 12B — {variant}

검증된 원본에서 과제별로 분리한 학습 데이터입니다. 모델 학습은 실행하지 않았습니다. 신규 검토 행의 생성·검토 범위는 아래에 구분합니다.

- 전체 train {counts['train']:,}행 / validation {counts['validation']:,}행
- 역할 train {rolecounts['train']:,}행 / validation {rolecounts['validation']:,}행
- 공통 원상담 train 37,065행 / validation 3,618행 포함
- 역할 과제: {', '.join(sorted(allowed))}

## 사용

1. ZIP을 풀고 `COURSE.json`의 `phases` 순서대로 학습 데이터 경로를 읽습니다.
2. 새 기반 모델에서 시작하면 원상담 단계부터 사용합니다. 같은 데이터/모델로 만든 공통 원상담 체크포인트를 재사용하는 경우 그 해시를 기록하고 역할 단계부터 분기합니다. A/B/C 역할 어댑터를 순차로 이어 학습하는 구성이 아닙니다.
3. `data/`는 messages와 메타데이터가 포함된 gzip JSONL입니다. 학습 타깃은 마지막 assistant 메시지뿐입니다. JSONL의 메타데이터·provenance·문서는 프롬프트에 넣지 않습니다.
4. `encoded/`는 원본 12B 토큰을 그대로 추출한 uint32 little-endian 파일과 인덱스입니다. `scripts/role_dataset.py`의 `IndexedTokens`로 읽을 수 있습니다. labels는 prefix에 -100을 넣고 마지막 assistant만 학습하며 미리 shift하지 않습니다.
5. `weight`를 적용한 행별 평균 target CE를 사용합니다. 각 단계의 과제·연결 원천별로 가중치를 다시 계산했습니다. validation은 역전파에 사용하지 않습니다.
6. 압축 해제 폴더에서 `python3 -B scripts/package_chat_variants.py verify --root .`로 로컬 검증합니다. 외부 패키지·네트워크·GPU 없이 가능합니다.

## 범위와 한계

{scope_note}

세 버전은 같은 원천과 같은 train/validation 분할을 공유합니다. 서로 독립된 세 데이터 원천이 아니며, 같은 사례의 생성 행과 검토 행이 서로 다른 분할로 이동하지 않습니다. validation은 모델 선택용이고 별도 최종 test는 이 ZIP에 포함하지 않습니다.

기존 앱 계약 스냅샷은 `provenance/SOURCE_APP_CONTRACT.json`입니다. 현재 앱과의 재통합·재검증 완료를 의미하지 않습니다. 기존 독립 AI 검토·수치 검증을 거친 원본의 텍스트/토큰을 보존했으며 사람·임상 검증이나 서비스 전체 성능을 보증하지 않습니다. 원천 전체 검토 기록은 SOURCE_BINDING에 기록된 기존 로컬 묶음에 보존되어 있습니다. 신규행의 의미 검토는 위 표본 범위만 적용됩니다.

기존 종료 정책은 원본 데이터 해시에 묶여 있으므로 이 분리 묶음에 그대로 적용하지 않습니다. 횟수가 아닌 validation 손실 개선과 역할 평가를 사용하되, 각 버전의 baseline과 평가 기준을 새로 연결해야 합니다. B의 답변·메모리 검토 성능은 질문 검토로 대체 평가하지 않고 별도로 측정해야 합니다. 학습기·자동 종료 연결은 포함하지 않습니다.

학습 데이터·ZIP은 로컬 전용이며 Git 커밋/원격 업로드 대상이 아닙니다.
'''
        (root / 'README.md').write_text(text, encoding='utf-8')
        d.save(root / 'MANIFEST.json', {'schema': SCHEMA, 'files': inventory(root)})
        result = verify(root, source)
        d.save(root / 'VERIFICATION.json', result)
        print(d.canonical({'verified': variant, 'totals': counts, 'role_totals': rolecounts}), flush=True)
        zipped = archive(root)
        result['new_examples_authored'] = 1600 if expanded else 0
        summary['variants'][variant] = {'directory': root.name, **result, 'archive': zipped}
        if expanded:
            summary['new_examples_authored'] = 1600
            summary['new_independent_source_cases'] = 0
        print(d.canonical({'archived': variant, **zipped}), flush=True)
    d.save(output / 'SUMMARY.json', summary)
    (output / 'SHA256SUMS.txt').write_text(''.join(v['archive']['sha256'] + '  ' + v['archive']['file'] + '\n'
                                              for v in summary['variants'].values()))
    listing = '\n'.join('- ' + key + ': ' + value['archive']['file'] for key, value in summary['variants'].items())
    (output / 'README.md').write_text('# 12B 학습 데이터 ZIP — ' + tag + '\n\n' + listing +
        '\n\n각 ZIP은 공통 원상담, 해당 역할의 train/validation, 12B 토크나이저, 수치 토큰, 검증 도구, 사용 설명을 포함합니다. 모델 가중치·학습 실행기는 포함하지 않습니다. 정확한 건수·크기·해시는 SUMMARY.json과 SHA256SUMS.txt를 확인하세요. 이전 A/ZIP과 원본은 변경하지 않았습니다. 신규 검토 자료의 독립 의미 검토 범위는 각 ZIP README에 구분합니다. 학습·성능 측정은 실행하지 않았습니다.\n', encoding='utf-8')
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('build', 'verify'))
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--variants', nargs='+', choices=tuple(VARIANTS))
    parser.add_argument('--tag', default='20261101')
    args = parser.parse_args()
    if args.command == 'build':
        parser.error('--source is required for build') if args.source is None else None
        d.require(args.tag and all(c.isalnum() or c in '_-' for c in args.tag), 'Unsafe tag')
        result = build(args.source, args.root, args.variants, args.tag)
    else:
        result = verify(args.root, args.source)
    print(d.canonical(result))
