#!/usr/bin/env python3
"""Recompute mechanical metrics from a frozen local run; no inference or network.

All source files, the dataset ZIP, and model blobs are opened read-only. The
result describes this captured run, not future output reproducibility, semantic
accuracy, safety, or upstream model authenticity. Token counts are API-reported
integers cross-checked against the captured preflight counts, not token-ID proof.
"""

import argparse
from collections import Counter
import gzip
import hashlib
import json
from pathlib import Path
import re
import sys
import zipfile


DEFAULT_SOURCE = Path('/Users/chihun/Documents/ChatGPT/HOP_agent/outputs/base12_local_20261009')
LABELS = ('ASK_CFI', 'CLARIFY', 'SUPPORT', 'SUPPORT_LIMITED', 'SAFETY_SUPPORT', 'END')
STATUSES = ('valid', 'length_limit', 'generation_error', 'format_error',
            'input_token_mismatch', 'incomplete', 'unverified_termination',
            'unexpected_thinking', 'empty_output')
CORE_EVIDENCE = ('run_manifest.json', 'case_manifest.jsonl', 'generations.jsonl',
                 'COLLECTION_COMPLETE.json', 'model_verification.json',
                 'dataset_audit.json', 'collector_provenance.json')


class VerificationError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_digest(path):
    """Hash bytes with bounded memory, rejecting changes during the read."""
    h = hashlib.sha256()
    with path.open('rb') as stream:
        before = path.stat()
        size = 0
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
            size += len(block)
        after = path.stat()
    require((before.st_ino, before.st_size, before.st_mtime_ns) ==
            (after.st_ino, after.st_size, after.st_mtime_ns),
            'File changed during hash: ' + str(path))
    require(size == after.st_size, 'File size changed: ' + str(path))
    return h.hexdigest(), size


def json_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key: ' + key)
        result[key] = value
    return result


def decode_json(data):
    return json.loads(data, object_pairs_hook=json_pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(
                          VerificationError('Invalid JSON number: ' + value)))


def read_json(path):
    return decode_json(path.read_text(encoding='utf-8'))


def read_jsonl_bytes(data, description):
    lines = data.splitlines()
    require(lines and all(line.strip() for line in lines),
            'Empty JSONL line/file: ' + description)
    return [decode_json(line) for line in lines]


def source_path(root, value):
    path = (root / value).resolve()
    require(path.is_relative_to(root), 'Source path escapes run directory: ' + str(value))
    return path


def render(messages):
    """Captured collector's text-only Gemma4 serialization, think=false."""
    result = '<bos>'
    for index, message in enumerate(messages):
        require(set(message) == {'role', 'content'}, 'Unexpected message fields')
        role, content = message['role'], message['content']
        require(role in {'system', 'user', 'assistant'} and isinstance(content, str),
                'Unexpected message type')
        require(role != 'system' or index == 0, 'System message outside first position')
        if role == 'assistant':
            content = re.sub(r'<\|channel>.*?<channel\|>', '', content, flags=re.S)
            content = content.split('<|channel>')[0]
        previous = messages[index - 1]['role'] if index else None
        following = messages[index + 1]['role'] if index + 1 < len(messages) else None
        if not (role == 'assistant' and previous == 'assistant'):
            result += '<|turn>' + ('model' if role == 'assistant' else role) + '\n'
        result += content.strip()
        if not (role == 'assistant' and following == 'assistant'):
            result += '<turn|>\n'
    return result + '<|turn>model\n<|channel>thought\n<channel|>'


def derive_status(raw, task, expected_tokens):
    if raw.get('error'):
        return 'generation_error'
    content = raw.get('message', {}).get('content', '')
    if raw.get('prompt_eval_count') != expected_tokens:
        return 'input_token_mismatch'
    if not raw.get('done'):
        return 'incomplete'
    if raw.get('done_reason') == 'length':
        return 'length_limit'
    if raw.get('done_reason') != 'stop':
        return 'unverified_termination'
    if raw.get('message', {}).get('thinking', '').strip():
        return 'unexpected_thinking'
    if not content.strip():
        return 'empty_output'
    if task == 'action' and content.strip() not in LABELS:
        return 'format_error'
    return 'valid'


def rate(numerator, denominator):
    return {'numerator': numerator, 'denominator': denominator,
            'percent': 100 * numerator / denominator if denominator else None}


def token_stats(values):
    require(all(type(value) is int and value >= 0 for value in values),
            'Missing/noninteger token count; refusing silent exclusion')
    return {'n': len(values), 'total': sum(values), 'min': min(values),
            'max': max(values), 'mean': sum(values) / len(values),
            'mean_exact': {'numerator': sum(values), 'denominator': len(values)}}


def aggregate(records, assigned):
    counts = Counter(record['status'] for record in records)
    n = len(records)
    result = {'assigned': assigned, 'attempted': n,
              'status_counts': {status: counts[status] for status in STATUSES},
              'attempt_rate': rate(n, assigned),
              'normal_stop_rate': rate(counts['valid'], assigned),
              'length_limit_rate': rate(counts['length_limit'], assigned),
              'error_rate': rate(counts['generation_error'], assigned),
              'format_invalid_rate': rate(counts['format_error'], assigned),
              'non_normal_stop_rate': rate(n - counts['valid'], assigned),
              'input_token_count_matches': rate(sum(r['token_match'] for r in records), assigned),
              'thinking_disabled_requests': rate(sum(r['think_disabled'] for r in records), assigned),
              'outputs_without_thinking_text': rate(sum(r['no_thinking'] for r in records), assigned),
              'nonempty_output': rate(sum(r['nonempty'] for r in records), assigned),
              'input_tokens': token_stats([r['input_tokens'] for r in records]),
              'generated_tokens': token_stats([r['generated_tokens'] for r in records])}
    if all(r['task'] == 'action' for r in records):
        labels = Counter(r['label'] for r in records)
        result['label_format_valid'] = rate(sum(labels[label] for label in LABELS), assigned)
        result['label_counts'] = {label: labels[label] for label in LABELS}
    return result


def verify_model(root, report, run):
    selected = [entry for entry in report['blobs']
                if entry['required_for_selected_installation'] is True]
    require(len(selected) == 740, 'Expected 740 selected model blobs')
    entries = {entry['digest']: entry for entry in selected}
    require(len(entries) == len(selected), 'Duplicate selected model blob digest')
    selected_digest = report['identity']['selected_distribution_manifest_digest']
    require(selected_digest == 'sha256:' + run['model']['digest'], 'Model digest mismatch')
    manifest_hashes = {}
    for entry in report['manifest_files']:
        path = Path(entry['path'])
        actual_hash, actual_size = file_digest(path)
        require(actual_hash == entry['actual_sha256'], 'Model manifest fingerprint mismatch')
        require(actual_size == entry['actual_size_bytes'], 'Model manifest size mismatch')
        if entry['expected_sha256'] is not None:
            require(actual_hash == entry['expected_sha256'], 'Model manifest digest mismatch')
        manifest_hashes[str(path)] = actual_hash
    actual_bytes = 0
    expected_bytes = 0
    # Do not rely on the prior report's verified/hash_verified booleans.
    for key in sorted(entries):
        entry = entries[key]
        require(key == 'sha256:' + entry['expected_sha256'], 'Blob digest schema mismatch')
        actual_hash, actual_size = file_digest(Path(entry['path']))
        require(actual_hash == entry['expected_sha256'], 'Model blob hash mismatch: ' + key)
        require(actual_size == entry['expected_size_bytes'], 'Model blob size mismatch: ' + key)
        expected_bytes += entry['expected_size_bytes']
        actual_bytes += actual_size
    distribution = read_json(Path(entries[selected_digest]['path']))
    index_digest = report['identity']['distribution_index_digest']
    index = read_json(Path(entries[index_digest]['path']))
    require(any(item['digest'] == selected_digest and item.get('runner') == 'mlx'
                for item in index['manifests']), 'MLX selection absent from distribution index')
    required = {item['digest'] for item in [distribution['config'], *distribution['layers']]}
    required.update((selected_digest, index_digest))
    require(required == set(entries), 'Selected blob list does not cover distribution exactly')
    for item in [distribution['config'], *distribution['layers']]:
        require(item['size'] == entries[item['digest']]['expected_size_bytes'],
                'Manifest/blob size declaration mismatch')
    return {'selected_required_blobs': len(required), 'actual_hash_and_size_matches': len(selected),
            'expected_total_bytes': expected_bytes, 'actual_total_bytes': actual_bytes,
            'selected_distribution_digest': selected_digest,
            'distribution_index_digest': index_digest, 'manifest_sha256': manifest_hashes,
            'scope': 'Local selected MLX content-addressed distribution only; not upstream authenticity.'}


def verify_source_archive(root, audit, cases, inputs):
    archive = Path(audit['archive'])
    require(file_digest(archive)[0] == audit['archive_sha256'], 'Dataset ZIP hash mismatch')
    with zipfile.ZipFile(archive, 'r') as source_zip:
        compressed = source_zip.read(audit['validation_member'])
        require(digest(compressed) == audit['validation_member_sha256'],
                'Validation archive member hash mismatch')
        source_rows = read_jsonl_bytes(gzip.decompress(compressed), 'archive validation')
        # The archived producer explicitly defines target_sha256 as SHA256(UTF-8 content).
        producer_path = audit['validation_member'].split('/data/')[0] + \
            '/verification_source/counseling_pipeline/source_sft.py'
        producer = source_zip.read(producer_path).decode('utf-8')
        require('def sha_text(text):\n    return hashlib.sha256(text.encode("utf-8")).hexdigest()' in producer
                and '"target_sha256": sha_text(content)' in producer,
                'Archived target hash representation not established')
    require(len(source_rows) == audit['validation_population'], 'Validation population mismatch')
    lookup = {row['id']: row for row in source_rows}
    require(len(lookup) == len(source_rows), 'Duplicate source validation ID')
    dev_cases = [case for case in cases if case['split'] == 'legacy_validation_development']
    require(len(dev_cases) == 32, 'Expected 32 source development inputs')
    source_ids, groups, conversations = set(), set(), set()
    for case in dev_cases:
        row = lookup[case['source_id']]
        require(row['split'] == 'validation', 'Selected row is not source validation')
        for field in ('source_group_id', 'source_conversation_id'):
            require(row[field] == case[field], 'Source identity mismatch: ' + case['case_id'])
        require(row['messages'][-1]['role'] == 'assistant', 'Source target is not assistant')
        require(row['target_sha256'] == case['source_target_sha256'] ==
                digest(row['messages'][-1]['content'].encode('utf-8')),
                'Source target hash mismatch: ' + case['case_id'])
        require(inputs[(case['task'], case['case_id'])]['messages'] == row['messages'][:-1],
                'Source target removal/prefix mismatch: ' + case['case_id'])
        source_ids.add(row['id'])
        groups.add(row['source_group_id'])
        conversations.add(row['source_conversation_id'])
    require(len(source_ids) == audit['selected_source_rows'] == 32, 'Source selected row count mismatch')
    require(len(groups) == audit['selected_source_groups'], 'Source selected group count mismatch')
    require(len(conversations) == audit['selected_source_conversations'], 'Source conversation count mismatch')
    return {'selected_rows': len(source_ids), 'selected_groups': len(groups),
            'selected_conversations': len(conversations), 'source_prefix_and_target_removal_matches': 32,
            'source_target_sha256_matches': 32, 'archive_sha256': audit['archive_sha256'],
            'validation_member_sha256': audit['validation_member_sha256'],
            'validation_population': len(source_rows), 'target_hash_producer_member': producer_path}


def verify(root):
    run = read_json(root / 'run_manifest.json')
    complete = read_json(root / 'COLLECTION_COMPLETE.json')
    evidence = read_json(root / 'evidence_manifest.json')
    require(complete['run_id'] == evidence['run_id'] == run['run_id'], 'Run ID mismatch')
    hashes = {}
    for name in CORE_EVIDENCE:
        refs = [item for item in evidence['sources'] if item['source_path'] == name]
        require(len(refs) == 1 and refs[0]['run_id'] == run['run_id'], 'Evidence reference mismatch: ' + name)
        hashes[name] = file_digest(root / name)[0]
        require(hashes[name] == refs[0]['sha256'], 'Evidence file hash mismatch: ' + name)
    require(hashes['case_manifest.jsonl'] == run['case_manifest_sha256'], 'Frozen case manifest mismatch')
    require(hashes['generations.jsonl'] == complete['generations_sha256'], 'Completed ledger mismatch')
    provenance = read_json(root / 'collector_provenance.json')
    require(file_digest(root / 'collector.executed.py')[0] == provenance['executed_script_sha256'],
            'Executed collector fingerprint mismatch')
    require(provenance['frozen_plan_script_sha256'] == run['collector_sha256'], 'Collector provenance mismatch')
    cases = read_jsonl_bytes((root / 'case_manifest.jsonl').read_bytes(), 'cases')
    ledger = read_jsonl_bytes((root / 'generations.jsonl').read_bytes(), 'ledger')
    jobs = read_json(root / 'jobs.json')
    case_map = {(case['task'], case['case_id']): case for case in cases}
    ledger_map = {(row['task'], row['case_id']): row for row in ledger}
    job_map = {(job['task'], job['case_id']): job for job in jobs}
    require(len(case_map) == len(cases) == len(ledger_map) == len(ledger) == len(job_map) == len(jobs) == 94,
            'Expected 94 unique assigned requests, attempts, and jobs')
    require(set(case_map) == set(ledger_map) == set(job_map), 'Missing or extra request/attempt/job')
    require(complete['assigned'] == complete['attempted'] == 94, 'Completion count mismatch')
    require(run['attempts_per_case'] == run['concurrency'] == 1 and run['thinking'] is False,
            'Unexpected frozen run controls')
    require(run['trained_adapter'] is False and run['condition'] == 'BASE12', 'Unexpected model condition')
    inputs, records, generation_ids = {}, [], set()
    expected_files = {folder: set() for folder in ('inputs', 'requests', 'responses', 'raw')}
    for key in sorted(case_map):
        case, row, job = case_map[key], ledger_map[key], job_map[key]
        task, case_id = key
        label = task + '/' + case_id
        require(task in {'response', 'action'}, 'Unexpected task: ' + label)
        expected_id = run['run_id'] + '_' + task + '_' + case_id
        require(row['generation_id'] == expected_id and expected_id not in generation_ids,
                'Duplicate/mismatched generation ID: ' + label)
        generation_ids.add(expected_id)
        require(row['run_id'] == run['run_id'] and row['attempt_index'] == 1, 'Attempt identity mismatch: ' + label)
        require(row['condition'] == row['model_condition'] == 'BASE12' and row['adapter_sha256'] is None,
                'Model condition mismatch: ' + label)
        require(row['model_digest'] == run['model']['digest'], 'Model identity mismatch: ' + label)
        for field in ('split', 'source_group_id', 'input_sha256', 'prompt_sha256',
                      'generation_config_sha256', 'request_sha256', 'input_tokens_preflight'):
            require(case[field] == row[field], 'Case/ledger mismatch for ' + field + ': ' + label)
        require(job['request_file'] == case['request_file'], 'Job request mismatch: ' + label)
        input_path = source_path(root, case['input_file'])
        request_path = source_path(root, case['request_file'])
        raw_path = source_path(root, row['raw_response_file'])
        response_path = source_path(root, row['private_response_file'])
        for folder, path in [('inputs', input_path), ('requests', request_path),
                             ('raw', raw_path), ('responses', response_path)]:
            expected_files[folder].add(path)
        item, request, raw = read_json(input_path), read_json(request_path), read_json(raw_path)
        inputs[key] = item
        require(item['case_id'] == case_id and item['task'] == task, 'Input identity mismatch: ' + label)
        require(digest(canonical(item)) == case['input_sha256'], 'Input canonical hash mismatch: ' + label)
        require(file_digest(request_path)[0] == case['request_sha256'], 'Request hash mismatch: ' + label)
        require(request['messages'] == item['messages'], 'Request/input message mismatch: ' + label)
        require(request['model'] == run['model']['name'] and request['think'] is False
                and request['stream'] is False, 'Request model/control mismatch: ' + label)
        require(digest(request['messages'][0]['content'].encode('utf-8')) == case['prompt_sha256'],
                'System prompt hash mismatch: ' + label)
        require(digest(render(request['messages']).encode('utf-8')) == case['expected_rendered_prompt_sha256'],
                'Rendered prompt hash mismatch: ' + label)
        require(digest(canonical({'options': request['options'], 'think': False})) ==
                case['generation_config_sha256'], 'Generation config hash mismatch: ' + label)
        limit = run['classification_max_new_tokens'] if task == 'action' else run['response_max_new_tokens']
        require(request['options']['num_predict'] == row['max_new_tokens'] == limit,
                'Output token limit mismatch: ' + label)
        require(request['options']['num_ctx'] == run['context_tokens'] and
                request['options']['seed'] == row['seed'] == run['seed'] and
                request['options']['temperature'] == run['temperature'], 'Request settings mismatch: ' + label)
        require(case['input_tokens_preflight'] + limit <= run['context_tokens'], 'Context budget exceeded: ' + label)
        require(file_digest(raw_path)[0] == row['raw_response_sha256'], 'Raw response hash mismatch: ' + label)
        response_bytes = response_path.read_bytes()
        require(digest(response_bytes) == row['response_sha256'], 'Decoded response hash mismatch: ' + label)
        content = raw.get('message', {}).get('content', '')
        require(isinstance(content, str) and response_bytes == content.encode('utf-8'),
                'Raw/decoded content mismatch: ' + label)
        status = derive_status(raw, task, case['input_tokens_preflight'])
        require(status == row['status'], 'Derived status mismatch: ' + label)
        require(raw.get('error') == row['error'], 'Generation error mismatch: ' + label)
        require(raw.get('done_reason') == row['termination'], 'Termination mismatch: ' + label)
        require(raw.get('model') == request['model'], 'Raw model mismatch: ' + label)
        require(raw.get('prompt_eval_count') == row['input_tokens'] and
                raw.get('eval_count') == row['generated_tokens'], 'Token count mismatch: ' + label)
        token_match = raw.get('prompt_eval_count') == case['input_tokens_preflight']
        require(token_match == row['input_token_count_matches'], 'Preflight match flag mismatch: ' + label)
        require(type(raw.get('eval_count')) is int and 0 <= raw['eval_count'] <= limit,
                'Invalid output token count: ' + label)
        predicted = content.strip() if task == 'action' and status == 'valid' else None
        require(predicted == row['predicted_label'], 'Recorded label mismatch: ' + label)
        attempt_path = root / ('private/raw/' + task + '_' + case_id + '.attempt.json')
        require(read_json(attempt_path)['generation_id'] == expected_id, 'Attempt marker mismatch: ' + label)
        expected_files['raw'].add(attempt_path.resolve())
        records.append({'task': task, 'case_id': case_id, 'split': case['split'], 'status': status,
                        'input_tokens': raw['prompt_eval_count'], 'generated_tokens': raw['eval_count'],
                        'token_match': token_match, 'think_disabled': request['think'] is False,
                        'no_thinking': not raw.get('message', {}).get('thinking', '').strip(),
                        'nonempty': bool(content.strip()), 'label': content.strip() if task == 'action' else None})
    for folder, expected in expected_files.items():
        actual = {path.resolve() for path in (root / 'private' / folder).iterdir() if path.is_file()}
        require(actual == expected, 'Unaccounted or missing private evidence file in ' + folder)
    audit = read_json(root / 'dataset_audit.json')
    source_result = verify_source_archive(root, audit, cases, inputs)
    model_result = verify_model(root, read_json(root / 'model_verification.json'), run)
    groups = {
        'response_legacy_dev32': [r for r in records if r['task'] == 'response' and r['split'] == 'legacy_validation_development'],
        'response_public_regression31': [r for r in records if r['task'] == 'response' and r['split'] == 'synthetic_public_regression'],
        'action_public_regression31': [r for r in records if r['task'] == 'action' and r['split'] == 'synthetic_public_regression'],
        'response_all63': [r for r in records if r['task'] == 'response'],
        'all_requests94': records,
    }
    expected_counts = dict(zip(groups, (32, 31, 31, 63, 94)))
    for name, subset in groups.items():
        require(len(subset) == expected_counts[name], 'Unexpected group size: ' + name)
    require(audit['task_counts'] == {'response': 63, 'action': 31}, 'Audit task counts mismatch')
    return {'schema_version': 1, 'run_id': run['run_id'],
            'scope': 'Frozen captured run only. Recalculation is deterministic for these files; future inference, semantic accuracy, and model safety are not measured or guaranteed.',
            'token_count_scope': 'API-reported counts cross-checked against captured preflight counts; input token IDs are not available.',
            'status_definition': 'normal_stop means done=true, done_reason=stop, matching preflight token count, no thinking text, nonempty content, and an allowed exact label after whitespace stripping for action tasks.',
            'assigned_request_uniqueness': {'assigned': len(cases), 'unique_task_case_pairs': len(case_map),
                                            'unique_generation_ids': len(generation_ids), 'all_assigned_attempted_once': True},
            'groups': {name: aggregate(subset, expected_counts[name]) for name, subset in groups.items()},
            'source_validation': source_result, 'model_integrity': model_result,
            'pre_generation_exclusions': audit['pre_generation_exclusions'],
            'evidence_sha256': hashes, 'collector_executed_sha256': provenance['executed_script_sha256'],
            'abnormal_cases': [{'task': r['task'], 'case_id': r['case_id'], 'status': r['status']}
                               for r in records if r['status'] != 'valid']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--output', type=Path, help='Write recomputed metrics JSON after all checks pass')
    parser.add_argument('--expected', type=Path, help='Fail if canonical recomputed metrics differ from this JSON')
    args = parser.parse_args()
    root = args.source.resolve()
    try:
        if args.output:
            output = args.output.resolve()
            require(not output.is_relative_to(root), 'Output must not modify source evidence')
            require(not output.exists() or output.is_file(), 'Output is not a regular file')
            require(args.expected is None or output != args.expected.resolve(), 'Output must not overwrite expected evidence')
        result = verify(root)
        payload_hash = digest(canonical(result))
        if args.expected:
            require(canonical(result) == canonical(read_json(args.expected)), 'Computed metrics differ from expected JSON')
        if args.output:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
        print(json.dumps({'verified': True, 'metrics_canonical_sha256': payload_hash,
                          'requests_verified': 94, 'model_blobs_rehashed': 740,
                          'source_target_removal_verified': 32,
                          'expected_matches': True if args.expected else None}, sort_keys=True))
        if not args.output and not args.expected:
            print(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False))
        return 0
    except (VerificationError, OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(json.dumps({'verified': False, 'error': str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
