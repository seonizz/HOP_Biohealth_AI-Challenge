#!/usr/bin/env python3
"""Verify completed private evaluation evidence and regenerate aggregate reports.

This tool does not generate model outputs, change gold, or infer human ratings.
"""
import argparse
from collections import Counter, defaultdict
from copy import deepcopy
import csv
from datetime import datetime
import hashlib
import io
import json
from pathlib import Path
import random
from zoneinfo import ZoneInfo

ARMS = ('baseline', 'trained')
SEMANTIC_IDS = ('M03', 'M04', 'M05', 'M06', 'M07', 'M09', 'M11', 'M12', 'M13')
HUMAN_IDS = ('M08', 'M10', 'M14', 'M15', 'M16', 'M17', 'M18')
NAMES = dict(zip((f'M{i:02}' for i in range(1, 21)), (
    '최초 형식 적합성', '전체 생성 흐름 완료율', '질문 판단 Macro F1', '부당 생략률', '불필요 반복 질문률',
    '엄격 사실 Micro F1', '정정 반영률', '생략 답변 조작 관측률', '승인·거절 F1', '근거일치 오류 검출',
    '정상 처리 실패율', '지원 정책 양성 재현율', '지원 정책 음성 정상 처리율', '원문 충실성 적합률',
    '근거 없는 사실 주장 비율', '중대 오류 관측 그룹 비율', '사람 유용성', '카드별 역할 적합률', 'AUROC', 'Average Precision')))


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def sha(value):
    return hashlib.sha256(value if isinstance(value, bytes) else value.encode()).hexdigest()


def digest(value):
    return sha(canonical(value))


def js_digest(value):
    return sha(json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False))


def read(path):
    return json.loads(Path(path).read_text())


def rows(path):
    return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def unique(values, key, reason):
    result = {}
    for value in values:
        identifier = key(value)
        require(identifier not in result, reason)
        result[identifier] = value
    return result


def private_path(root, relative):
    path = (Path(root) / relative).resolve()
    require(path.is_relative_to(Path(root).resolve()), 'Artifact path escapes private run')
    return path


def arm_key(row):
    return row['arm'], row['request_id']


def verify_panel(root):
    panel = root / 'panel'
    manifest = read(panel / 'MANIFEST.json')
    raw_hashes = {name: sha((panel / name).read_bytes()) for name in ('SUITE.json', 'INPUTS.jsonl', 'REFERENCES.jsonl')}
    require(raw_hashes == manifest['files'], 'Frozen panel manifest mismatch')
    verification = read(panel / 'validation/VERIFICATION.json')
    revision = read(panel / 'validation/SCORING_REVISION.json')
    original = panel / 'validation/generator-before-comparison-fix.py'
    scorer = panel / 'validation/scorer-final-source.py'
    require(sha(original.read_bytes()) == manifest['generator_sha256'] == revision['original_generator_sha256'] == verification['original_generation_source_sha256'], 'Original generator snapshot mismatch')
    require(sha(scorer.read_bytes()) == revision['current_scorer_sha256'] == verification['scoring_source_sha256'], 'Scorer audit hash mismatch')
    require(revision['frozen_input_gold_suite_unchanged'] is True and revision['original_file_hashes'] == raw_hashes, 'Scorer revision changed frozen data')
    require(verification['unit_tests_status'] == 'passed' and verification['frozen_visible_input_gold_roundtrips'] == 240, 'Oracle validation incomplete')
    suite, inputs, refs = read(panel / 'SUITE.json'), rows(panel / 'INPUTS.jsonl'), rows(panel / 'REFERENCES.jsonl')
    inventory = unique(suite['cases'], lambda row: row['case_id'], 'Duplicate suite case')
    references = unique(refs, lambda row: row['case_id'], 'Duplicate gold case')
    require(len(inputs) == len(inventory) == len(references) == 30, 'Expected thirty controlled cases')
    require(len({row['source_family_id'] for row in inventory.values()}) == 6, 'Expected six root lineages')
    expected, request_ids = [], set()
    for case in inputs:
        frozen, reference = inventory[case['case_id']], references[case['case_id']]
        require(digest(case) == frozen['input_sha256'] == reference['input_sha256'], 'Case input/gold binding mismatch')
        require(digest(reference) == frozen['reference_sha256'], 'Case gold hash mismatch')
        require({r['slot'] for r in case['requests']} == {f'S{i}' for i in range(1, 9)} and len(case['requests']) == 8, 'Missing controlled slot')
        for request in case['requests']:
            require(request['request_id'] not in request_ids, 'Duplicate frozen request')
            request_ids.add(request['request_id'])
            index = len(expected) // 2
            for arm in ARMS if index % 2 == 0 else tuple(reversed(ARMS)):
                expected.append({'case_id': case['case_id'], 'source_group_id': frozen['source_family_id'],
                                 'request_id': request['request_id'], 'task': request['task'], 'request': request,
                                 'input_sha256': frozen['input_sha256'], 'request_sha256': digest(request),
                                 'arm': arm, 'logical_request_id': arm + ':' + request['request_id'], 'output_stage': 'first_draft'})
    return {'expected': expected, 'suite': suite, 'raw_hashes': raw_hashes, 'verification': verification,
            'revision': revision, 'scorer_sha256': sha(scorer.read_bytes()), 'manifest': manifest}


def verify_fixed(root, protocol, panel):
    run = root / 'fixed-run'
    summary, metadata = read(run / 'summary.json'), read(run / 'metadata.json')
    require(summary['status'] == 'completed', 'Fixed-request run not completed')
    assignments = rows(run / 'assignments.jsonl')
    require(assignments == panel['expected'], 'Fixed assignment inventory differs from frozen panel')
    require(metadata['suite_sha256'] == digest(panel['suite']) and metadata['suite_file_sha256'] == panel['raw_hashes'], 'Run suite hash mismatch')
    require(metadata['base_model_sha256'] == protocol['base_sha256'] and metadata['adapter_sha256'] == protocol['adapter_sha256'], 'Run model hash mismatch')
    options = {key: protocol['fixed_generation_options'][key] for key in ('temperature', 'seed', 'cache_prompt', 'stream', 'max_tokens')}
    require(metadata['options'] == options and metadata['retry_policy'] == 'none', 'Fixed generation options changed')
    outputs = unique(rows(run / 'outputs.jsonl'), arm_key, 'Duplicate fixed output')
    expected = {arm_key(row): row for row in assignments}
    require(set(outputs) == set(expected) and len(outputs) == 480, 'Missing or unexpected fixed outcomes')
    starts = unique([r for r in rows(run / 'attempts.jsonl') if r['event'] == 'started'], arm_key, 'Repeated first attempt')
    ends = unique([r for r in rows(run / 'attempts.jsonl') if r['event'] == 'completed'], arm_key, 'Repeated completed attempt')
    require(set(starts) == set(ends) == set(expected), 'Attempt ledger incomplete')
    judgments = unique(read(run / 'format-metrics.json')['judgments'], arm_key, 'Duplicate format judgment')
    require(set(judgments) == set(expected), 'Format judgment inventory mismatch')
    attempt_ids = set()
    for key, assigned in expected.items():
        output, start, end, judgment = outputs[key], starts[key], ends[key], judgments[key]
        for field in ('case_id', 'source_group_id', 'task', 'input_sha256', 'request_sha256', 'logical_request_id', 'output_stage'):
            require(output[field] == start[field] == end[field] == assigned[field], 'Fixed outcome identity mismatch')
        require(output['execution_status'] in ('output_received', 'failed'), 'Unresolved fixed execution status')
        require(judgment['execution_status'] == output['execution_status'], 'Format execution status mismatch')
        for field in ('case_id', 'source_group_id', 'task', 'output_stage'):
            require(judgment[field] == assigned[field], 'Format identity mismatch')
        require(output['attempt_id'] == start['attempt_id'] == end['attempt_id'] and output['attempt_id'] not in attempt_ids, 'Attempt identifier mismatch')
        attempt_ids.add(output['attempt_id'])
        directory = private_path(run, 'http/' + output['attempt_id'])
        body, raw = (directory / 'request.json').read_bytes(), (directory / 'response.bin').read_bytes()
        response_meta, payload = read(directory / 'response-meta.json'), json.loads(body)
        require(sha(body) == output['request_body_sha256'] == start['request_body_sha256'] == end['request_body_sha256'], 'Raw request hash mismatch')
        require(sha(raw) == output['response_sha256'] == end['response_sha256'] == response_meta['sha256'], 'Raw response hash mismatch')
        require(payload['messages'] == assigned['request']['messages'], 'Gold leakage or inference input change')
        require(payload['lora'] == [{'id': 0, 'scale': 0 if key[0] == 'baseline' else 1}], 'LoRA assignment mismatch')
        require(all(payload[k] == v for k, v in options.items()), 'Wire generation options mismatch')
        require(payload.get('response_format') is None, 'Unregistered grammar constraint')
        if output['execution_status'] == 'output_received':
            require(response_meta['status'] == 200, 'Received output lacks successful transport')
            require(json.loads(raw)['choices'][0]['message']['content'] == output['text'], 'Extracted text differs from raw first response')
        else:
            require(judgment['schema_valid'] is False, 'Failed execution earned format credit')
    for arm in ARMS:
        observed = [r for r in outputs.values() if r['arm'] == arm]
        counts = summary['arms'][arm]
        require(counts == {'assigned_count': 240, 'received_count': sum(r['execution_status'] == 'output_received' for r in observed),
                          'failed_count': sum(r['execution_status'] == 'failed' for r in observed), 'not_run_count': 0}, 'Fixed summary denominator mismatch')
    controlled = read(run / 'controlled-metrics.json')
    require(controlled['schema'] == panel['revision']['scorer_version'], 'Unexpected semantic scorer version')
    require(len(controlled['verdicts']) == 480 and {arm_key(r) for r in controlled['verdicts']} == set(expected), 'Semantic verdict inventory mismatch')
    for row in controlled['metrics']:
        require(row['status'] != 'incomplete' and row.get('not_run_or_missing_execution_evidence', 0) == 0, 'Semantic evaluator incomplete')
        require(row['oracle_hash'] == panel['scorer_sha256'], 'Metric scorer source mismatch')
    for row in controlled['verdicts']:
        require(row.get('metrics') is not None, 'Missing semantic verdict')
        require(row['raw_response_sha256'] == outputs[arm_key(row)]['response_sha256'], 'Semantic verdict raw-response binding mismatch')
    return {'assignments': assignments, 'outputs': outputs, 'judgments': judgments, 'summary': summary,
            'metadata': metadata, 'controlled': controlled, 'format': read(run / 'format-metrics.json')}



def resume_tree_manifest(run, logical_ids):
    manifest = {}
    for logical_id in logical_ids:
        directory = private_path(run, logical_id.replace(':', '-'))
        require(directory.is_dir() and directory == directory.resolve() and not directory.is_symlink(),
                'Resume terminal directory is missing or linked')
        for path in sorted(directory.rglob('*')):
            require(not path.is_symlink(), 'Resume terminal tree contains a symlink')
            if path.is_file():
                require(path.stat().st_nlink == 1, 'Resume terminal artifact is hard linked')
                manifest[str(path.relative_to(run))] = sha(path.read_bytes())
    return manifest


def verify_resume_provenance(root, flow_protocol, metadata, assignments, results):
    """Accept copied terminal outcomes only with explicit immutable provenance.

    Prior unfinished HTTP work stays in its original run. It never becomes a
    thirteenth M02 case or an extra POST in the twelve terminal-case aggregate.
    """
    binding = flow_protocol.get('resume_from')
    if binding is None:
        require(metadata.get('resume_from') is None, 'Implicit resume provenance is not supported')
        return None
    expected_fields = {'run_directory', 'protocol_sha256', 'collector_sha256', 'results_file_sha256',
                       'terminal_count', 'terminal_logical_ids', 'source_sha256', 'terminal_file_manifest'}
    require(isinstance(binding, dict) and set(binding) == expected_fields,
            'Resume provenance fields differ from the explicit contract')
    require(metadata.get('resume_from') == binding, 'Resume metadata/protocol provenance mismatch')
    run = root / 'full-flow-run'
    original = Path(binding['run_directory'])
    require(original.is_absolute() and original.resolve(strict=True) == original and original.is_dir()
            and original != run.resolve() and original.name == 'full-flow-run'
            and original.parent.parent == root.parent.resolve(), 'Resume source run is outside the sibling private-run scope')
    old_protocol = read(original.parent / 'full-flow/protocol.json')
    old_metadata = read(original / 'metadata.json')
    require(js_digest(old_protocol) == binding['protocol_sha256'] == old_metadata.get('protocol_sha256'),
            'Resume original protocol hash mismatch')
    require(old_metadata.get('collector_sha256') == binding['collector_sha256'] == old_protocol.get('collector_sha256'),
            'Resume original collector binding mismatch')
    old_collector = original.parent / 'frozen-source/ai/scripts/run_controlled_full_flow.mjs'
    require(sha(old_collector.read_bytes()) == binding['collector_sha256'], 'Resume original collector snapshot changed')
    for field in ('profile', 'wire', 'source', 'fixed_reviewer', 'assignments_sha256', 'fixtures_sha256',
                  'questions_sha256', 'retry_policy', 'required_completion'):
        require(old_protocol.get(field) == flow_protocol.get(field), 'Resume original generation contract changed: ' + field)
    require(old_protocol['source']['sha256'] == binding['source_sha256'], 'Resume source fingerprint mismatch')
    require(old_metadata.get('profile') == metadata['profile'] and old_metadata.get('wire') == metadata['wire'],
            'Resume original metadata profile/wire mismatch')
    for field in ('base_sha256', 'adapter_sha256'):
        require(old_metadata.get(field) == metadata[field], 'Resume original model hash mismatch: ' + field)
    old_assignments = read(original / 'assignments.json')
    require(old_assignments == assignments, 'Resume original assignments changed')
    old_fixtures = read(original.parent / 'full-flow/fixtures.json')
    require(js_digest(old_assignments) == old_protocol['assignments_sha256']
            and js_digest(old_fixtures) == old_protocol['fixtures_sha256'], 'Resume original contexts are not bound')
    raw_old_results = (original / 'results.jsonl').read_bytes()
    old_results = rows(original / 'results.jsonl')
    terminals = unique(old_results, lambda row: row['logical_case_id'], 'Duplicate original resume terminal case')
    logical_ids = list(terminals)
    require(type(binding['terminal_count']) is int and 0 < binding['terminal_count'] < 12
            and binding['terminal_count'] == len(old_results) == len(binding['terminal_logical_ids'])
            and logical_ids == binding['terminal_logical_ids'], 'Resume terminal inventory mismatch')
    assigned_ids = {row['logical_case_id'] for row in assignments}
    require(set(logical_ids).issubset(assigned_ids) and all(row['status'] in ('failed', 'output_received') for row in old_results),
            'Resume source contains a nonterminal or unexpected copied case')
    require(sha(raw_old_results) == binding['results_file_sha256'], 'Resume original results file changed')
    require((run / 'results.jsonl').read_bytes().startswith(raw_old_results)
            and results[:len(old_results)] == old_results, 'Resume copied terminal results are not byte-preserved')
    manifest = resume_tree_manifest(original, logical_ids)
    require(manifest == binding['terminal_file_manifest'], 'Resume original terminal artifact manifest changed')
    require(resume_tree_manifest(run, logical_ids) == manifest, 'Resume copied terminal artifacts differ')
    interrupted = []
    for assignment in assignments:
        logical_id = assignment['logical_case_id']
        if logical_id in terminals:
            continue
        directory = private_path(original, logical_id.replace(':', '-'))
        if not directory.exists():
            continue
        require(not (directory / 'result.json').exists(), 'Unlisted original terminal result cannot be silently rerun')
        events_path = directory / 'http-events.jsonl'
        events = rows(events_path) if events_path.exists() else []
        queued = unique([event for event in events if event.get('event') == 'queued'], lambda event: event['attempt_id'],
                        'Duplicate original interrupted HTTP queue event')
        completed = unique([event for event in events if event.get('event') == 'completed'], lambda event: event['attempt_id'],
                           'Duplicate original interrupted HTTP completion')
        require(set(completed).issubset(queued), 'Original interrupted HTTP completion has no queue record')
        interrupted.append({'logical_case_id': logical_id, 'source_directory': str(directory),
                            'queued_attempt_count': len(queued),
                            'completed_actual_post_count': sum(bool(event.get('actual_post')) for event in completed.values()),
                            'unresolved_attempt_count': len(set(queued) - set(completed)),
                            'events_file_sha256': sha(events_path.read_bytes()) if events_path.exists() else None,
                            'original_artifact_manifest': resume_tree_manifest(original, [logical_id]),
                            'counted_as_terminal_case': False, 'counted_in_terminal_actual_posts': False})
    old_summary = read(original / 'summary.json')
    require(old_summary.get('results') == old_results and old_summary.get('completed_case_count') == len(old_results),
            'Resume original terminal summary mismatch')
    require(old_summary.get('actual_posts') == sum(row['actual_posts'] for row in old_results),
            'Resume original terminal POST summary mismatch')
    return {'schema': 'malssi-verified-flow-resume-v1', 'verified': True, 'source_run_directory': str(original),
            'binding': binding, 'copied_terminal_count': len(old_results),
            'copied_terminal_logical_ids': logical_ids, 'copied_terminal_file_count': len(manifest),
            'copied_terminal_status_counts': dict(Counter(row['status'] for row in old_results)),
            'copied_terminal_error_counts': dict(Counter(row.get('error', 'none') for row in old_results)),
            'new_terminal_count': 12 - len(old_results),
            'restarted_interrupted_count': len(interrupted), 'prior_interrupted_records': interrupted,
            'original_run_preserved': True, 'prior_interrupted_posts_added_to_terminal_total': False}


def verify_flow(root, protocol):
    frozen, run = root / 'full-flow', root / 'full-flow-run'
    flow_protocol = read(frozen / 'protocol.json')
    assignments, fixtures = read(frozen / 'assignments.json'), read(frozen / 'fixtures.json')
    require(js_digest(assignments) == flow_protocol['assignments_sha256'] and js_digest(fixtures) == flow_protocol['fixtures_sha256'], 'Full-flow frozen context mismatch')
    require(len(assignments) == 12 and read(run / 'assignments.json') == assignments, 'Full-flow assignment inventory mismatch')
    require(flow_protocol['fixed_reviewer']['lora_scale'] == 0, 'Reviewer was not fixed baseline')
    source = flow_protocol['source']
    require(js_digest(source['files']) == source['sha256'], 'Full-flow app source fingerprint mismatch')
    for file in source['files']:
        snapshot = root / 'frozen-source/app' / file['path']
        require(sha(snapshot.read_bytes()) == file['sha256'], 'Frozen application source mismatch')
    collector = root / 'frozen-source/ai/scripts/run_controlled_full_flow.mjs'
    require(sha(collector.read_bytes()) == flow_protocol['collector_sha256'], 'Full-flow collector hash mismatch')
    metadata, summary = read(run / 'metadata.json'), read(run / 'summary.json')
    require(metadata['protocol_sha256'] == js_digest(flow_protocol) and metadata['collector_sha256'] == flow_protocol['collector_sha256'], 'Full-flow run protocol mismatch')
    require(metadata['base_sha256'] == protocol['base_sha256'] and metadata['adapter_sha256'] == protocol['adapter_sha256'], 'Full-flow model hash mismatch')
    require(metadata['wire'] == flow_protocol['wire'] and metadata['profile'] == flow_protocol['profile'], 'Full-flow generation profile changed')
    require(summary['status'] == 'completed' and summary['assigned_count'] == summary['completed_case_count'] == 12 and summary['not_run_count'] == 0, 'Full-flow run not completed')
    results = rows(run / 'results.jsonl')
    mapped = unique(results, lambda r: r['logical_case_id'], 'Duplicate full-flow case')
    require(set(mapped) == {r['logical_case_id'] for r in assignments}, 'Missing full-flow outcome')
    require(summary['results'] == results, 'Full-flow summary differs from recorded results')
    resume = verify_resume_provenance(root, flow_protocol, metadata, assignments, results)
    posts = 0
    for assignment in assignments:
        record = mapped[assignment['logical_case_id']]
        require(record['arm'] == assignment['arm'] and record['context_sha256'] == assignment['context_sha256'] == js_digest(assignment['context']), 'Full-flow paired input binding mismatch')
        require(record['status'] in ('failed', 'output_received'), 'Unknown full-flow terminal status')
        require(record['m02_complete'] == (record['status'] == 'output_received'), 'Full-flow completion status mismatch')
        directory = private_path(run, record['logical_case_id'].replace(':', '-'))
        require(read(directory / 'result.json') == record, 'Full-flow case result mismatch')
        if record['m02_complete']:
            final = read(directory / 'final-output.json')
            require(js_digest(final) == record['final_output_sha256'] and final.get('agent', {}).get('reviewed') is True and final.get('agent', {}).get('quality_reviewed') is True, 'Final reviewed output binding mismatch')
        events = rows(directory / 'http-events.jsonl') if (directory / 'http-events.jsonl').exists() else []
        queued = unique([e for e in events if e['event'] == 'queued'], lambda e: e['attempt_id'], 'Duplicate full-flow queued attempt')
        completed = unique([e for e in events if e['event'] == 'completed'], lambda e: e['attempt_id'], 'Duplicate full-flow completed attempt')
        require(set(queued) == set(completed), 'Unfinished full-flow HTTP attempt')
        for identifier, event in completed.items():
            http = private_path(directory, 'http/' + identifier)
            request_bytes, raw = (http / 'request.json').read_bytes(), (http / 'response.bin').read_bytes()
            response_meta, payload = read(http / 'response-meta.json'), json.loads(request_bytes)
            require(sha(request_bytes) == event['request_sha256'] == queued[identifier]['request_sha256'], 'Full-flow raw request mismatch')
            require(sha(raw) == event['raw_response_sha256'] == response_meta['raw_response_sha256'], 'Full-flow raw response mismatch')
            require(response_meta == event, 'Full-flow HTTP outcome metadata mismatch')
            expected_scale = 0 if event['role'] == 'reviewer' or record['arm'] == 'baseline' else 1
            require(payload['lora'] == event['lora'] == [{'id': 0, 'scale': expected_scale}], 'Full-flow reviewer/generator LoRA mismatch')
            require(payload['temperature'] == 0 and payload['seed'] == 3407 and payload['cache_prompt'] is False and 0 < payload['max_tokens'] <= flow_protocol['wire']['max_tokens'], 'Full-flow wire options changed')
        actual_posts = sum(e['actual_post'] for e in completed.values())
        require(actual_posts == record['actual_posts'], 'Full-flow POST count mismatch')
        posts += actual_posts
        for index, stage in enumerate(record['stages'], 1):
            origin = stage.get('gateway_origin', stage['role'])
            filename = f"{index:06d}-{origin}-{stage['stage']}-input.json"
            frozen_input = read(private_path(directory, 'stages/' + filename))
            require(js_digest(frozen_input['payload']) == stage['input_payload_sha256'] and js_digest(frozen_input['schema']) == stage['schema_sha256'], 'Full-flow stage input hash mismatch')
            if stage['status'] == 'validated_output':
                require(js_digest(read(private_path(directory, stage['output_path']))) == stage['output_sha256'], 'Full-flow stage output hash mismatch')
    require(summary['actual_posts'] == posts, 'Full-flow total POST count mismatch')
    for arm in ARMS:
        records = [r for r in results if r['arm'] == arm]
        require(len(records) == 6, 'Expected six full-flow cases per arm')
        counts = summary['M02']['by_arm'][arm]
        require(counts['denominator'] == 6 and counts['not_run_count'] == 0 and counts['numerator'] == sum(r['m02_complete'] for r in records), 'M02 fixed denominator mismatch')
        require(counts['failed_count'] == sum(r['status'] == 'failed' for r in records) and counts['value'] == counts['numerator'] / 6, 'M02 failure accounting mismatch')
    result = {'summary': summary, 'results': results, 'protocol': flow_protocol, 'metadata': metadata, 'actual_posts': posts}
    if resume is not None:
        result['resume_provenance'] = resume
    return result


def bootstrap(records, suppress=False):
    """Paired root resampling; records have equal arm coverage within each root."""
    by_arm = {arm: [r for r in records if r['arm'] == arm] for arm in ARMS}
    values = {arm: sum(r['value'] for r in by_arm[arm]) / len(by_arm[arm]) for arm in ARMS}
    groups = sorted({r['root'] for r in records})
    require(all({r['root'] for r in by_arm[arm]} == set(groups) for arm in ARMS), 'Unpaired bootstrap groups')
    intervals = {arm: None for arm in ARMS}
    result = {'baseline_value': values['baseline'], 'trained_value': values['trained'],
              'difference': values['trained'] - values['baseline'], 'ci95': None, 'per_arm_ci95': intervals,
              'root_lineage_count': len(groups), 'ci_scope': 'descriptive_controlled_pilot_only_not_confirmatory'}
    if suppress or len(groups) < 2:
        result['ci_reason'] = 'shared_policy_kernel_independence_not_established' if suppress else 'fewer_than_two_root_lineages'
        return result
    draws = {arm: [] for arm in ARMS}; differences = []; rng = random.Random(3407)
    for _ in range(1000):
        sample = rng.choices(groups, k=len(groups)); sampled = {}
        for arm in ARMS:
            units = [r['value'] for group in sample for r in by_arm[arm] if r['root'] == group]
            sampled[arm] = sum(units) / len(units); draws[arm].append(sampled[arm])
        differences.append(sampled['trained'] - sampled['baseline'])
    def interval(values):
        values.sort(); return [values[int(.025 * (len(values) - 1))], values[int(.975 * (len(values) - 1))]]
    result['ci95'] = interval(differences)
    result['per_arm_ci95'] = {arm: interval(draws[arm]) for arm in ARMS}
    result['ci_method'] = 'paired_root_lineage_percentile_bootstrap_1000_seed3407'
    return result


def format_metrics(fixed):
    variants = []
    source = {(r['task'], r['arm']): r for r in fixed['format']['metrics']}
    for slot in (f'S{i}' for i in range(1, 9)):
        assigned = [r for r in fixed['assignments'] if r['request']['slot'] == slot]
        per_arm, binary = {}, []
        for arm in ARMS:
            units = [r for r in assigned if r['arm'] == arm]
            judgments = [fixed['judgments'][arm_key(r)] for r in units]
            numerator = sum(r['schema_valid'] is True for r in judgments)
            require(len(units) == 30, 'M01 slot denominator must be thirty')
            recorded = source[(units[0]['task'], arm)]
            require(recorded['numerator'] == numerator and recorded['denominator'] == 30 and recorded['value'] == numerator / 30, 'M01 aggregate differs from raw judgments')
            per_arm[arm] = {'numerator': numerator, 'denominator': 30, 'value': numerator / 30,
                            'assigned_request_count': 30, 'received_count': sum(r['execution_status'] == 'output_received' for r in judgments),
                            'failed_count': sum(r['execution_status'] == 'failed' for r in judgments), 'not_run_count': 0,
                            'root_lineage_count': 6}
            binary.extend({'arm': arm, 'root': r['source_group_id'], 'value': int(fixed['judgments'][arm_key(r)]['schema_valid'] is True)} for r in units)
        variants.append({'metric_variant': slot, 'panel': 'controlled_auto_pilot', 'contract_variant': 'benchmark_structured',
                         'output_stage': 'first_draft', 'status': 'measured', 'unit': 'logical_request', 'per_arm': per_arm,
                         'comparison': bootstrap(binary, suppress=slot == 'S8')})
    return variants


def auxiliary_metrics(fixed, flow):
    controlled = fixed['controlled']; result = []
    for identifier in ('A08', 'A10'):
        records = [deepcopy(r) for r in controlled['metrics'] if r['metric_id'] == identifier]
        require({r['arm'] for r in records} == set(ARMS), 'Missing single-request auxiliary metric')
        comparison = next(deepcopy(r) for r in controlled['comparisons'] if r['metric_id'] == identifier)
        result.append({'metric_id': identifier, 'scope': 'partial_automatic_check_not_full_human_metric',
                       'per_arm': {r['arm']: r for r in records}, 'comparison': comparison})
    for identifier in ('A14', 'A15', 'A16', 'A18'):
        arms = {}
        for arm in ARMS:
            cases = [r for r in flow['results'] if r['arm'] == arm]
            observed = [r['auxiliary'][identifier] for r in cases if r['auxiliary'][identifier].get('status') == 'partial_automatic_check']
            if identifier == 'A16':
                numerator = sum(r.get('found_count', 0) for r in observed); denominator = sum(r.get('checked_count', 0) for r in observed)
            elif identifier == 'A18':
                eligible = [r for r in observed if r.get('value') is not None]
                numerator, denominator = sum(r['value'] == 1 for r in eligible), len(eligible)
            else:
                numerator = sum(r.get('numerator', 0) for r in observed); denominator = sum(r.get('denominator', 0) for r in observed)
            arms[arm] = {'value': numerator / denominator if denominator else None, 'numerator': numerator, 'denominator': denominator,
                         'assigned_case_count': 6, 'observed_final_case_count': len(observed),
                         'coverage': {'numerator': len(observed), 'denominator': 6, 'value': len(observed) / 6},
                         'failed_case_count': sum(r['status'] == 'failed' for r in cases),
                         'partial_snapshot_count': sum(r['auxiliary'].get('partial_discoveries', {}).get('snapshot_count', 0) for r in cases),
                         'any_observed_known_violation_count': sum(r['auxiliary'].get('A16', {}).get('any_observed_known_violation_count', 0) for r in cases) if identifier == 'A16' else None}
        result.append({'metric_id': identifier, 'panel': 'controlled_full_flow', 'contract_variant': 'production',
                       'scope': 'partial_automatic_check_not_full_human_metric', 'per_arm': arms,
                       'comparison': None, 'comparison_reason': 'different_observation_coverage_no_unconditional_model_difference',
                       'partial_findings_scope': 'Validated stage snapshots can overlap; no unique-claim or independent-group claim.'})
    result.append({'metric_id': 'J17', 'status': 'not_run', 'value': None, 'reason': 'optional_ai_utility_judge_not_executed_not_a_human_rating'})
    return result


def registry(fixed, flow, coverage_audit):
    items = [{'metric_id': 'M01', 'name': NAMES['M01'], 'variants': format_metrics(fixed)}]
    binary = [{'arm': r['arm'], 'root': r['root_lineage_id'], 'value': int(r['m02_complete'])} for r in flow['results']]
    items.append({'metric_id': 'M02', 'name': NAMES['M02'], 'variants': [{'metric_variant': 'actual_app_pipeline',
        'panel': 'controlled_full_flow', 'contract_variant': 'production', 'output_stage': 'final_output', 'status': 'measured',
        'unit': 'assigned_case', 'per_arm': deepcopy(flow['summary']['M02']['by_arm']), 'comparison': bootstrap(binary)}]})
    for identifier in SEMANTIC_IDS:
        source = [deepcopy(r) for r in fixed['controlled']['metrics'] if r['metric_id'] == identifier]
        require({r['arm'] for r in source} == set(ARMS), 'Missing controlled semantic metric')
        comparison = next(deepcopy(r) for r in fixed['controlled']['comparisons'] if r['metric_id'] == identifier)
        if identifier in ('M12', 'M13'):
            comparison['source_scorer_ci95'] = comparison.get('ci95')
            comparison['ci95'] = None
            comparison['ci_suppressed_reason'] = 'shared_policy_kernel_independence_not_established'
        items.append({'metric_id': identifier, 'name': NAMES[identifier], 'variants': [{'metric_variant': source[0].get('metric_variant', {
            'M03': 'controlled_question_candidates', 'M04': 'controlled_question_candidates', 'M05': 'candidate_selection',
            'M06': 'controlled_fact_tuples', 'M07': 'controlled_corrections', 'M09': 'injected_error_drafts',
            'M11': 'injected_error_drafts', 'M12': 'controlled_policy_adherence', 'M13': 'controlled_policy_adherence'}[identifier]),
            'panel': 'controlled_auto_pilot', 'contract_variant': 'benchmark_structured', 'output_stage': 'first_draft',
            'status': 'measured', 'per_arm': {r['arm']: r for r in source}, 'comparison': comparison}]})
    for identifier in HUMAN_IDS:
        items.append({'metric_id': identifier, 'name': NAMES[identifier], 'status': 'not_measured', 'value': None,
                      'baseline_value': None, 'trained_value': None,
                      'reason': 'full_free_text_semantics_or_human_rating_not_performed; scoped_A_or_J_metrics_are_separate'})
    for identifier in ('M19', 'M20'):
        items.append({'metric_id': identifier, 'name': NAMES[identifier], 'status': 'not_measured', 'value': None,
                      'baseline_value': None, 'trained_value': None,
                      'reason': 'teacher_forced_label_logprobabilities_not_validated; zero_budget_probes_returned_generated_token_scores'})
    items.sort(key=lambda r: r['metric_id'])
    return {'schema': 'malssi-controlled-evaluation-report-v1', 'protocol_version': 'malssi-model-eval-plan-1.3',
            'automatic_panel_complete': True, 'all_twenty_metrics_measured': False, 'human_semantic_complete': False,
            'overall_model_performance_pass': None, 'weighted_overall_score': None,
            'fixed_requests_per_arm': 240, 'full_flow_cases_per_arm': 6,
            'controlled_case_count': 30, 'controlled_root_lineage_count': 6, 'full_flow_root_lineage_count': 6,
            'lineage_counts_are_not_additive_independent_samples': True, 'independent_test': False,
            'training_base_revision_verified': False, 'policy_kernel_unique_visible_inputs': 6,
            'design_coverage_audit': coverage_audit, 'metrics': items,
            'auxiliary_metrics': auxiliary_metrics(fixed, flow)}


def number(value):
    return '미측정' if value is None else f'{value:.3f}'


def report_markdown(data, fixed, flow):
    finished = max([r['completed_at'] for r in fixed['outputs'].values()] + [r['completed_at'] for r in flow['results']])
    visible = datetime.fromisoformat(finished.replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Seoul')).strftime('%Y-%m-%d %H:%M:%S KST')
    lines = ['# A_original 학습 전후 자동 평가 — 기획서 v1.3', '', '실행 완료 시각: ' + visible, '',
             '**480개 단일 요청과 12개 실제 앱 전체 흐름 사례의 실행·집계가 완료됐다. 실행 완료는 성능 기준 통과를 뜻하지 않는다.**', '',
             '동일한 12B IT 추론 기반에서 LoRA scale 0과 1을 비교했다. 전체 흐름의 검토자는 기반 모델 scale 0으로 고정했다. GPU 서버와 기존 앱 설정·화면·스키마는 변경하지 않았다.', '',
             '통제 사례는 30개 복합 사례지만 공유 계보는 6개다. 전체 흐름도 별도 6개 계보이며 두 패널을 합쳐 독립 표본 수를 늘리지 않는다. 기존 개발 결과나 신규 독립 test 300개로 해석하지 않는다. 학습 당시 기반 revision·분할 이력은 미확인이다.', '',
             '## 최초 형식 적합성 M01', '', '| 슬롯 | 기반 통과/배정 | 학습 통과/배정 | 학습−기반 |', '|---|---:|---:|---:|']
    for variant in data['metrics'][0]['variants']:
        b, t = variant['per_arm']['baseline'], variant['per_arm']['trained']
        lines.append(f"| {variant['metric_variant']} | {b['numerator']}/{b['denominator']} | {t['numerator']}/{t['denominator']} | {number(variant['comparison']['difference'])} |")
    lines += ['', '출력 수정을 거치지 않은 최초 JSON·스키마 적합성이다. 서로 다른 슬롯을 하나의 대표 형식 점수로 합산하지 않는다.', '',
              '## 과제별 통제 자동 점수', '', '| 지표 | 기반 | 학습 | 학습−기반 | 비교 범위 |', '|---|---:|---:|---:|---|']
    for metric in data['metrics'][1:]:
        if not metric.get('variants'):
            continue
        variant = metric['variants'][0]; comparison = variant['comparison']
        lines.append(f"| {metric['metric_id']} {metric['name']} | {number(comparison['baseline_value'])} | {number(comparison['trained_value'])} | {number(comparison['difference'])} | {comparison.get('comparison_scope', '고정 배정')} |")
    lines += ['', 'M02는 실제 앱의 필수 생성·검토 경로를 마친 사례를 모델당 6개 배정 사례로 나눈 값이다. 정상적으로 기록된 생성·형식·검토 실패도 분모에 포함했다. 통제 M03~M13은 공개 규칙과 닫힌 구조화 계약에서의 수행이며 자유 대화·임상 안전성·실제 사용자 유용성의 증거가 아니다.', '',
              'M05와 A08의 모델 차이는 두 모델이 모두 완전히 관측된 공통 슬롯에서 계산했다. 모델별 원래 관측률·coverage·분자·분모는 JSON에 별도로 보존했다. 관측 집합이 달라 생기는 선택 편향은 남아 있다.', '',
              '## 불확실성과 설계 한계', '',
              '- 구간은 6개 공유 계보를 묶어 재표집한 기술적 파일럿 구간이다. 모집단 일반화·다중 비교 보정·최종 후보 승인에 사용하지 않는다.',
              '- S8은 보이는 입력이 6종뿐이고 같은 정책 조합을 반복한다. M01 S8 및 M12·M13의 최종 신뢰구간은 독립성 미확인으로 미산출 처리했다.',
              '- S2의 정답 후보는 모든 사례에서 두 번째 위치다. 위치만 고르는 지름길을 이번 자료만으로 배제할 수 없다.',
              '- S8은 current/yes, past/no, unknown/unknown 세 정책 조합만 다룬다. 전체 상태 조합을 검증한 것은 아니다.',
              '- 오류 승인·거절 M09와 오류 위치·유형 일치 A10은 별개다. 승인과 issues 배열의 형식상 일관성 관찰도 별도 보존되며, 설명 품질을 M09로 바꾸지 않는다.', '',
              '## 부분 검사와 미측정', '',
              'A08·A10은 단일 요청의 제한된 자동 검사다. A14·A15·A16·A18은 실제 전체 흐름에서 확보된 필드·인용·발화 상세에 한정하며 coverage를 함께 기록했다. 전체 흐름 실패 중 확보한 검증된 중간 출력과 발견한 화자 인용 위반도 별도 보존했다. 중간 스냅샷끼리 내용이 겹칠 수 있으므로 발견 건수를 독립 주장 수로 합산하지 않는다.', '',
              'M08·M10·M14·M15·M16·M17·M18의 전체 의미·사람 평가는 null이다. J17 AI 유용성 평가는 선택 사항으로 실행하지 않았다. M19·M20도 teacher-forced 라벨 전체 로그확률 경로가 검증되지 않아 null이며, 생성된 한 토큰의 점수나 자가 확신 숫자로 대체하지 않았다.', '',
              '## 데이터와 재현', '',
              '- `all-metrics.json`: 20개 M 지표와 별도 A/J 지표, 적용 범위·분모·coverage·구간·미측정 사유.',
              '- `metrics.csv`: 모델·과제별 수치의 표 형식 사본.',
              '- `fixed-run/`: 480개 고정 배정·최초 전송·원시 HTTP·응답·형식·정답 채점 기록.',
              '- `full-flow-run/`: 12개 실제 앱 경로의 모든 HTTP·큐 대기·재시도·오류·검증된 중간 출력·승인 및 최종 결과 해시.',
              '- `panel/validation/`: 원래 생성기와 최종 채점기 스냅샷, 채점기 수정 이력·오라클 및 스키마 검증.',
              '- `verification.json`: 고정 분모·요청/응답·모델·입력/정답·전체 흐름 소스 결합 검증.', '',
              f"고정 요청은 모델당 수신 {fixed['summary']['arms']['baseline']['received_count']}/{fixed['summary']['arms']['trained']['received_count']}건, 실행 실패 {fixed['summary']['arms']['baseline']['failed_count']}/{fixed['summary']['arms']['trained']['failed_count']}건이며 미실행은 양쪽 0건이다. 전체 흐름의 실제 HTTP 전송 시도는 {flow['actual_posts']}회로 480개 단일 요청 분모와 분리했다."]
    if 'resume_provenance' in flow:
        resume = flow['resume_provenance']
        errors = resume['copied_terminal_error_counts']
        timeouts = errors.get('MODEL_TIMEOUT', 0)
        lines += ['', '## 전체 흐름 재개 이력', '',
                  f"이전 실행의 종결 결과 {resume['copied_terminal_count']}개를 원시 결과 행과 HTTP·단계 파일의 SHA-256을 대조하여 그대로 보존했다. 그중 시간 초과(MODEL_TIMEOUT)는 {timeouts}개다. 이미 실패로 종결된 사례를 재평가하여 덮어쓰지 않았다.", '',
                  f"나머지 {resume['new_terminal_count']}개를 이번 실행에서 처리했으며, 이전에 중단된 {resume['restarted_interrupted_count']}개 사례는 새 시도로 다시 시작했다. 이전 실행의 중단 요청·완료된 전송·미해결 전송 기록은 원래 폴더에 보존하고 JSON의 prior_interrupted_records에 별도 기록했다. 그 요청 수를 12개 종결 사례의 HTTP 합계나 M02 분모에 더하지 않았다.", '',
                  '최종 집계는 그대로 모델당 6개, 전체 12개 종결 사례를 사용한다. 재개 출처·기반 및 어댑터 해시·입력·프로필·생성 설정·앱 소스의 동일성을 검증했다.']
    return '\n'.join(lines) + '\n'


def csv_text(data):
    fields = ['metric_id', 'metric_variant', 'panel', 'contract_variant', 'output_stage', 'arm', 'value',
              'numerator', 'denominator', 'assigned_request_count', 'failed_count', 'not_run_count',
              'difference', 'ci95_lower', 'ci95_upper', 'status', 'reason', 'statistics_json']
    output = io.StringIO(newline=''); writer = csv.DictWriter(output, fieldnames=fields); writer.writeheader()
    for metric in data['metrics']:
        variants = metric.get('variants') or [metric]
        for variant in variants:
            comparison = variant.get('comparison') or {}
            interval = comparison.get('ci95') or [None, None]
            for arm in ARMS:
                record = variant.get('per_arm', {}).get(arm, {})
                statistics = record.get('statistics', {})
                writer.writerow({'metric_id': metric['metric_id'], 'metric_variant': variant.get('metric_variant'),
                    'panel': variant.get('panel'), 'contract_variant': variant.get('contract_variant'),
                    'output_stage': variant.get('output_stage'), 'arm': arm, 'value': record.get('value'),
                    'numerator': record.get('numerator', statistics.get('num')), 'denominator': record.get('denominator', statistics.get('den')),
                    'assigned_request_count': record.get('assigned_request_count'), 'failed_count': record.get('failed_count'),
                    'not_run_count': record.get('not_run_count'), 'difference': comparison.get('difference'),
                    'ci95_lower': interval[0], 'ci95_upper': interval[1], 'status': record.get('status', variant.get('status')),
                    'reason': record.get('reason', variant.get('reason')), 'statistics_json': canonical(statistics) if statistics else ''})
    return output.getvalue()


def build_report(root):
    root = Path(root).resolve(); protocol = read(root / 'protocol.json')
    require(protocol['fixed_total_requests'] == 480 and protocol['full_flow_assigned_cases'] == 12, 'Unexpected evaluation plan budget')
    require(sha((root / 'plan.md').read_bytes()) == protocol['plan_sha256'], 'Plan snapshot hash mismatch')
    panel = verify_panel(root); fixed = verify_fixed(root, protocol, panel); flow = verify_flow(root, protocol)
    coverage = read(root / 'design-coverage-audit.json')
    require(coverage['cases'] == 30 and coverage['root_lineages'] == 6 and coverage['frozen_panel_changed'] is False, 'Missing design-coverage audit')
    data = registry(fixed, flow, coverage)
    if 'resume_provenance' in flow:
        data['full_flow_resume_provenance'] = flow['resume_provenance']
    verification = {'schema': 'malssi-controlled-report-verification-v1', 'automatic_panel_complete': True,
        'fixed_assigned_requests': 480, 'fixed_raw_request_response_hashes_verified': 480,
        'fixed_model_input_and_lora_bindings_verified': 480, 'full_flow_assigned_cases': 12,
        'full_flow_completed_cases': 12, 'full_flow_actual_posts_verified': flow['actual_posts'],
        'not_run_count': 0, 'evaluator_errors': [], 'reported_model_failures_remain_in_denominators': True,
        'panel_original_generator_sha256': panel['manifest']['generator_sha256'], 'panel_scorer_sha256': panel['scorer_sha256'],
        'panel_validation': panel['verification'], 'reporter_sha256': sha(Path(__file__).read_bytes()),
        'human_scores_created': False, 'independent_test_claimed': False,
        'research_or_production_quality_approved': False,
        'input_artifact_hashes': {str(file.relative_to(root)): sha(file.read_bytes()) for file in (
            root / 'protocol.json', root / 'plan.md', root / 'fixed-run/assignments.jsonl', root / 'fixed-run/outputs.jsonl',
            root / 'fixed-run/format-metrics.json', root / 'fixed-run/controlled-metrics.json', root / 'full-flow/protocol.json',
            root / 'full-flow-run/results.jsonl', root / 'full-flow-run/summary.json', root / 'design-coverage-audit.json')}}
    if 'resume_provenance' in flow:
        verification['full_flow_resume_provenance'] = flow['resume_provenance']
    artifacts = {'all-metrics.json': json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n',
                 'REPORT.md': report_markdown(data, fixed, flow), 'metrics.csv': csv_text(data),
                 'verification.json': json.dumps(verification, ensure_ascii=False, indent=2, allow_nan=False) + '\n'}
    for name, text in artifacts.items():
        temporary = root / (name + '.tmp'); temporary.write_text(text); temporary.replace(root / name)
    return {'automatic_panel_complete': True, 'metrics_registered': len(data['metrics']),
            'generated_files': sorted(artifacts), 'human_semantic_complete': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    print(canonical(build_report(**vars(parser.parse_args()))))


if __name__ == '__main__':
    main()
