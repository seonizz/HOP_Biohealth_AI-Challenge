#!/usr/bin/env python3
"""Collect paired first outputs from a pinned verified remote 31B worker.

The externally managed loopback SSH bridge exposes verified remote manifests.
No local model files or GGUF identity is fabricated. This collector does not launch/stop servers or change global LoRA state.
All inputs, HTTP responses, and records belong in an ignored private run folder.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

from gpu31b_eval_bridge import remote_identity, validate_ready


class InfrastructureInterrupted(RuntimeError):
    pass


def health_check(endpoint, ready, timeout):
    try:
        value = fetch_json(endpoint, '/health', min(timeout, 15))
    except (OSError, ValueError) as error:
        raise InfrastructureInterrupted('Worker health unavailable: ' + type(error).__name__) from error
    if not isinstance(value, dict) or value.get('status') != 'ok' or value.get('worker_ready_sha256') != digest(ready):
        raise InfrastructureInterrupted('Worker health identity/readiness changed')
    return value


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def file_hash(path):
    result = hashlib.sha256()
    with Path(path).open('rb') as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w') as handle:
        handle.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
        handle.flush()
        os.fsync(handle.fileno())
    temporary.replace(path)


def append_json(path, value):
    with path.open('a') as handle:
        handle.write(canonical(value) + '\n')
        handle.flush()
        os.fsync(handle.fileno())


def load_suite(root, limit_groups=None, limit_requests=None):
    suite = json.loads((root / 'SUITE.json').read_text())
    inputs = [json.loads(line) for line in (root / 'INPUTS.jsonl').read_text().splitlines() if line.strip()]
    references = [json.loads(line) for line in (root / 'REFERENCES.jsonl').read_text().splitlines() if line.strip()]
    if suite.get('schema') != 'malssi-role-evaluation-suite-v1' or suite.get('split') != 'development':
        raise ValueError('Only the frozen development role suite is supported')
    inventory = {row['case_id']: row for row in suite['cases']}
    refs = {row['case_id']: row for row in references}
    if len(inventory) != len(suite['cases']) or len(refs) != len(references) or len(inputs) != len(inventory):
        raise ValueError('Duplicate or mismatched suite inventory')
    if set(inventory) != set(refs) or set(inventory) != {row['case_id'] for row in inputs}:
        raise ValueError('Input/reference case inventory mismatch')
    seen = set()
    requests = []
    for index, row in enumerate(inputs):
        frozen, reference = inventory[row['case_id']], refs[row['case_id']]
        if digest(row) != frozen['input_sha256'] or digest(reference) != frozen['reference_sha256']:
            raise ValueError('Frozen input/reference digest mismatch')
        if reference.get('input_sha256') != frozen['input_sha256']:
            raise ValueError('Reference input binding mismatch')
        if not row.get('requests'):
            raise ValueError('Empty request inventory')
        for request in row['requests']:
            request_id = request.get('request_id')
            if not isinstance(request_id, str) or not request_id or request_id in seen:
                raise ValueError('Duplicate or missing request ID')
            seen.add(request_id)
            if not isinstance(request.get('messages'), list) or not request['messages']:
                raise ValueError('Missing inference messages')
            if limit_groups is None or index < limit_groups:
                requests.append({'case_id': row['case_id'],
                                 'source_group_id': frozen['source_family_id'],
                                 'request_id': request_id, 'task': request['task'], 'request': request,
                                 'input_sha256': frozen['input_sha256'],
                                 'request_sha256': digest(request)})
    if limit_requests is not None:
        requests = requests[:limit_requests]
    if not requests:
        raise ValueError('No selected requests')
    assignments = []
    for index, request in enumerate(requests):
        arms = ('baseline', 'trained') if index % 2 == 0 else ('trained', 'baseline')
        for arm in arms:
            assignments.append(dict(request, arm=arm,
                                    logical_request_id=arm + ':' + request['request_id'],
                                    output_stage='first_draft'))
    return suite, assignments


def fetch_json(endpoint, route, timeout):
    with urllib.request.urlopen(endpoint + route, timeout=timeout) as response:
        return json.load(response)


def identity(endpoint, worker_ready, timeout):
    props = fetch_json(endpoint, '/props', timeout)
    adapters = fetch_json(endpoint, '/lora-adapters', timeout)
    expected = json.loads(Path(worker_ready).read_text())
    normalized = validate_ready(expected)
    if props.get('worker_ready') != expected or props.get('worker_ready_sha256') != digest(expected):
        raise ValueError('Bridge worker differs from pinned verified ready identity')
    if props.get('identity_kind') != 'verified_remote_worker_manifest' or props.get('base_model_digest') != normalized['base_model_digest']:
        raise ValueError('Remote base manifest kind/value mismatch')
    if props.get('model_path') != normalized['base_model_path'] or not isinstance(adapters, list) or len(adapters) != 1:
        raise ValueError('Bridge remote model/adapter inventory mismatch')
    if adapters[0].get('id') != 0 or adapters[0].get('path') != normalized['adapter_path'] or adapters[0].get('adapter_file_sha256') != normalized['adapter_file_sha256']:
        raise ValueError('Remote adapter path/file digest mismatch')
    return {'props': props, 'lora_adapters': adapters, 'verified_remote_identity': normalized}


def summary(assignments, outputs, interrupted=False):
    result = {'updated_at': now(), 'status': 'interrupted' if interrupted else
              ('completed' if len(outputs) == len(assignments) else 'running'),
              'semantic_quality_evaluated': False, 'arms': {}}
    for arm in ('baseline', 'trained'):
        assigned = sum(row['arm'] == arm for row in assignments)
        rows = [row for row in outputs if row['arm'] == arm]
        counts = {name: sum(row['execution_status'] == name for row in rows)
                  for name in ('output_received', 'failed')}
        result['arms'][arm] = {'assigned_count': assigned,
                              'received_count': counts['output_received'],
                              'failed_count': counts['failed'],
                              'not_run_count': assigned - len(rows)}
    return result


def collect(suite_root, output, endpoint, worker_ready,
            limit_groups=None, limit_requests=None, timeout=1100, max_tokens=4096):
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') or parsed.path not in ('', '/'):
        raise ValueError('Endpoint must be a loopback HTTP origin')
    endpoint = endpoint.rstrip('/')
    suite_root, worker_ready = [Path(path).resolve(strict=True) for path in (suite_root, worker_ready)]
    ready = json.loads(worker_ready.read_text())
    verified_identity = validate_ready(ready)
    suite, assignments = load_suite(suite_root, limit_groups, limit_requests)
    # Fresh directory makes accidental overwrite or silent retry impossible.
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    outputs = []
    metadata = {'schema': 'malssi-paired-role-run-v1', 'created_at': now(),
                'suite_root': str(suite_root), 'suite_sha256': digest(suite),
                'collector_sha256': file_hash(Path(__file__)),
                'suite_file_sha256': {name: file_hash(suite_root / name)
                                      for name in ('SUITE.json', 'INPUTS.jsonl', 'REFERENCES.jsonl')},
                'model_role': suite['model_role'], 'split': suite['split'],
                'remote_model_identity': verified_identity, 'worker_ready_sha256': digest(ready),
                'base_model_path': verified_identity['base_model_path'],
                'base_model_digest': verified_identity['base_model_digest'],
                'adapter_path': verified_identity['adapter_path'],
                'adapter_file_sha256': verified_identity['adapter_file_sha256'],
                'adapter_tensor_digest': verified_identity['adapter_tensor_digest'],
                'tokenizer_manifest_sha256': verified_identity['tokenizer_manifest_sha256'],
                'evaluated_model_parameter_class': '31B', 'training_role': 'card_generation',
                'suite_role_label_scope': 'original frozen benchmark suite label, not engine parameter class',
                'endpoint': endpoint, 'limit_groups': limit_groups, 'limit_requests': limit_requests,
                'options': {'temperature': 0, 'seed': 3407, 'max_tokens': max_tokens,
                            'stream': False, 'cache_prompt': False},
                'retry_policy': 'none',
                'training_base_revision': ready.get('loader_config', {}).get('model_revision'),
                'limitation': 'Controlled transfer benchmark for a 31B card model; directory manifest hashes are not single-weight-file/GGUF hashes.'}
    write_json(output / 'metadata.json', metadata)
    for assignment in assignments:
        append_json(output / 'assignments.jsonl', assignment)
    write_json(output / 'summary.json', summary(assignments, outputs))
    try:
        metadata['server_identity'] = identity(endpoint, worker_ready, min(timeout, 30))
        write_json(output / 'metadata.json', metadata)
    except Exception as exc:
        write_json(output / 'preflight-error.json', {'time': now(), 'error': str(exc)})
        stopped = summary(assignments, outputs)
        stopped['status'] = 'blocked_identity_or_connectivity'
        write_json(output / 'summary.json', stopped)
        raise
    interrupted = False
    infrastructure = None
    def save_summary():
        value = summary(assignments, outputs, interrupted)
        if infrastructure is not None:
            value.update(status='infrastructure_interrupted', infrastructure_error=infrastructure)
        write_json(output / 'summary.json', value)
        return value
    try:
        for index, assignment in enumerate(assignments):
            try:
                health_check(endpoint, ready, timeout)
            except InfrastructureInterrupted as exc:
                infrastructure = {'time': now(), 'phase': 'pre_dispatch_health', 'request_id': assignment['request_id'],
                                  'arm': assignment['arm'], 'reason': str(exc), 'model_post_dispatched': False}
                write_json(output / 'infrastructure-error.json', infrastructure)
                break
            attempt_id = f'{index + 1:06d}'
            payload = dict(metadata['options'], model=metadata['server_identity']['props'].get('model_alias', 'paired-role-eval'),
                           messages=assignment['request']['messages'],
                           lora=[{'id': 0, 'scale': 0 if assignment['arm'] == 'baseline' else 1}])
            request_bytes = canonical(payload).encode()
            record = {key: value for key, value in assignment.items() if key != 'request'}
            record.update(attempt_id=attempt_id, started_at=now())
            request_path = output / 'http' / attempt_id
            request_path.mkdir(parents=True)
            with (request_path / 'request.json').open('wb') as handle:
                handle.write(request_bytes); handle.flush(); os.fsync(handle.fileno())
            append_json(output / 'attempts.jsonl', dict(record, event='started',
                        request_body_sha256=hashlib.sha256(request_bytes).hexdigest()))
            raw = b''
            status, headers, error = None, [], None
            infrastructure_response = False
            try:
                req = urllib.request.Request(endpoint + '/v1/chat/completions', data=request_bytes,
                                             headers={'Content-Type': 'application/json'}, method='POST')
                try:
                    response = urllib.request.urlopen(req, timeout=timeout)
                except urllib.error.HTTPError as exc:
                    response = exc
                with response:
                    status = response.status
                    headers = list(response.headers.items())
                    raw = response.read()
                if status != 200:
                    error = 'http_status_' + str(status)
                header_map = {key.lower(): value for key, value in headers}
                if not header_map.get('x-evaluation-worker-response-id') or not header_map.get('x-evaluation-worker-reply-sha256'):
                    infrastructure_response = True
                    error = 'infrastructure_worker_reply_missing:' + (error or 'unlinked_response')
            except (OSError, ValueError) as exc:
                error = type(exc).__name__ + ': ' + str(exc)
                infrastructure_response = True
            except KeyboardInterrupt:
                error = 'confirmed_client_interruption'
                interrupted = True
            with (request_path / 'response.bin').open('wb') as handle:
                handle.write(raw); handle.flush(); os.fsync(handle.fileno())
            write_json(request_path / 'response-meta.json', {'status': status, 'headers': headers,
                       'error': error, 'sha256': hashlib.sha256(raw).hexdigest()})
            content, usage, finish = None, None, None
            if error is None:
                try:
                    parsed_response = json.loads(raw)
                    choice = parsed_response['choices'][0]
                    content = choice['message']['content']
                    finish = choice.get('finish_reason')
                    usage = parsed_response.get('usage')
                    if not isinstance(content, str) or not content.strip():
                        error = 'empty_or_nontext_content'
                except (ValueError, KeyError, IndexError, TypeError) as exc:
                    error = 'response_contract_error: ' + str(exc)
            record.update(completed_at=now(), text=content, finish_reason=finish, usage=usage,
                          http_status=status, error=error,
                          execution_status='failed' if error else 'output_received',
                          response_sha256=hashlib.sha256(raw).hexdigest(),
                          request_body_sha256=hashlib.sha256(request_bytes).hexdigest())
            outputs.append(record)
            append_json(output / 'outputs.jsonl', record)
            append_json(output / 'attempts.jsonl', dict(record, event='completed'))
            if infrastructure_response:
                infrastructure = {'time': now(), 'phase': 'post_dispatch_transport', 'request_id': assignment['request_id'],
                                  'arm': assignment['arm'], 'attempt_id': attempt_id, 'reason': error, 'model_post_dispatched': True,
                                  'worker_dispatch_or_generation_confirmed': False}
                write_json(output / 'infrastructure-error.json', infrastructure)
            save_summary()
            print(canonical({'attempt_id': attempt_id, 'arm': assignment['arm'],
                             'request_id': assignment['request_id'],
                             'execution_status': record['execution_status']}), flush=True)
            if interrupted or infrastructure is not None:
                break
    finally:
        save_summary()
        for arm in ('baseline', 'trained'):
            checkpoint = digest({'remote_model_identity': verified_identity, 'adapter_scale': 0 if arm == 'baseline' else 1})
            write_json(output / (arm + '-role-outputs.json'), {
                'schema': 'malssi-role-model-outputs-v1', 'model_role': suite['model_role'],
                'split': suite['split'], 'suite_sha256': digest(suite), 'checkpoint_sha256': checkpoint,
                'checkpoint_hash_kind': 'composite_remote_manifest_and_adapter_scale_identity',
                'responses': [{'case_id': row['case_id'], 'request_id': row['request_id'], 'text': row['text']}
                              for row in outputs if row['arm'] == arm]})
    result = save_summary()
    if infrastructure is not None:
        raise InfrastructureInterrupted(infrastructure['reason'])
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite-root', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--endpoint', default='http://127.0.0.1:11440')
    parser.add_argument('--worker-ready', required=True, type=Path, help='Pinned verified worker-ready.json emitted by the bridge')
    parser.add_argument('--limit-groups', type=int)
    parser.add_argument('--limit-requests', type=int)
    parser.add_argument('--timeout', type=float, default=1100)
    parser.add_argument('--max-tokens', type=int, default=4096)
    args = parser.parse_args()
    for name in ('limit_groups', 'limit_requests', 'timeout', 'max_tokens'):
        if getattr(args, name) is not None and getattr(args, name) <= 0:
            parser.error(name + ' must be positive')
    print(json.dumps(collect(**vars(args)), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
