#!/usr/bin/env python3
"""Freeze and collect the unchanged BASE12 cases from the step100 HTTP API.

No model loading, service changes, retries, training, or input rewriting.
Commands: prepare; collect RUN; finalize RUN. Preflight is calculated separately
in the serving environment, before any generation, and must cover all 94 cases.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import sys
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'outputs/base12_local_20261009'
MODEL = 'malssi-gemma4-31b-step100'
CHECKPOINT = '56244f8a6736e648dd8f4cd13d0889d7499a6bf776b9e55491a4ed59c446effd'
ADAPTER = '153b2611645a5ce2cef69362d685fa241d67dac2333a5a47e5630ece99715b73'
PARAMETERS = '79258bc8ca13ea4a0b0fa91722453c0c0de46dbb539675876d63b30b4cc6f004'
FINGERPRINT = 'step-100-56244f8a6736'
LABELS = ('ASK_CFI', 'CLARIFY', 'SUPPORT', 'SUPPORT_LIMITED', 'SAFETY_SUPPORT', 'END')


def now():
    return datetime.now(timezone.utc).isoformat()


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical_sha(value):
    return sha(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf8'))


def read(path):
    return json.loads(Path(path).read_text(encoding='utf8'))


def lines(path):
    return [json.loads(s) for s in Path(path).read_text(encoding='utf8').splitlines() if s.strip()]


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + '\n').encode('utf8')


def write(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_bytes(encoded(value))
    temp.replace(path)


def require(value, message):
    if not value:
        raise ValueError(message)


def key(case):
    return case['task'], case['case_id']


def local(root, name):
    path = (root / name).resolve()
    require(path.is_relative_to(root.resolve()), 'Evidence path escapes run')
    return path


def copy(source, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)


def prepare():
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    run = ROOT / 'outputs' / ('ft31_step100_collection_' + stamp)
    run.mkdir(mode=0o700, parents=True)
    for sub in ('evidence', 'private/inputs', 'private/requests', 'private/raw', 'private/responses', 'private/attempts', 'source_baseline/private/responses'):
        (run / sub).mkdir(parents=True, exist_ok=True)
    cases = lines(BASE / 'case_manifest.jsonl')
    require(len(cases) == 94 and len({key(c) for c in cases}) == 94, 'Expected 94 unique source cases')
    copy(BASE / 'case_manifest.jsonl', run / 'case_manifest.jsonl')
    for name in ('run_manifest.json', 'case_manifest.jsonl', 'generations.jsonl', 'dataset_audit.json'):
        copy(BASE / name, run / 'source_baseline' / name)
    for c in cases:
        data = (BASE / c['input_file']).read_bytes()
        require(canonical_sha(json.loads(data)) == c['input_sha256'], 'Source input hash mismatch: ' + c['case_id'])
        copy(BASE / c['input_file'], run / c['input_file'])
        copy(BASE / c['input_file'], run / 'source_baseline' / c['input_file'])
        copy(BASE / c['request_file'], run / 'source_baseline' / c['request_file'])
    for r in lines(BASE / 'generations.jsonl'):
        copy(BASE / r['private_response_file'], run / 'source_baseline' / r['private_response_file'])
    code = Path(__file__).read_bytes()
    (run / 'evidence/collect_ft31_comparison.py').write_bytes(code)
    (run / 'generations.jsonl').write_text('', encoding='utf8')
    write(run / 'run_manifest.json', {
        'run_id': 'FT31_STEP100_' + stamp, 'condition': 'FT31_STEP100', 'prepared_at': now(),
        'model_id': MODEL, 'checkpoint_step': 100, 'checkpoint_sha256': CHECKPOINT,
        'adapter_file_sha256': ADAPTER, 'loaded_adapter_parameter_sha256': PARAMETERS,
        'training_progress': {'optimizer_steps': 100, 'planned_optimizer_steps': 5052, 'trained_rows': 800, 'planned_rows': 40415},
        'case_manifest_sha256': sha((run / 'case_manifest.jsonl').read_bytes()),
        'baseline_source': str(BASE), 'baseline_manifest_sha256': sha((BASE / 'run_manifest.json').read_bytes()),
        'source_baseline_hashes': {str(p.relative_to(run / 'source_baseline')): sha(p.read_bytes())
            for p in sorted((run / 'source_baseline').rglob('*')) if p.is_file()},
        'collector_sha256': sha(code), 'assigned': dict(Counter(c['task'] for c in cases)),
        'response_max_new_tokens': 512, 'classification_max_new_tokens': 32,
        'comparison_context_tokens': 4096, 'temperature': 0, 'enable_thinking': False,
        'concurrency': 1, 'attempts_per_case': 1, 'stream': False, 'input_truncation': False,
        'baseline_only_settings': {'seed': 3407, 'top_k': 64, 'top_p': .95, 'repeat_penalty': 1.0},
        'api_request_settings': {'temperature': 0, 'stream': False},
        'generation_ready': False,
    })
    print(run, flush=True)
    return run


def http(base, suffix, body=None, timeout=30):
    token = (ROOT / 'trained_model_api/runtime/api_key').read_text().strip()
    request = urllib.request.Request(base.rstrip('/') + suffix, data=body,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def health(run, base, phase):
    for suffix, filename in (('/healthz', 'health'), ('/v1/models', 'models')):
        status, data = http(base, suffix)
        (run / 'evidence' / f'{filename}_{phase}.json').write_bytes(data)
        require(status == 200, f'{filename}: HTTP {status}')
        value = json.loads(data)
        if filename == 'health':
            require(value.get('status') == 'ready' and value.get('model') == MODEL
                and value.get('checkpoint_step') == 100 and value.get('checkpoint_sha256') == CHECKPOINT,
                'Unexpected running model/checkpoint')
        else:
            require([v['id'] for v in value['data']] == [MODEL], 'Unexpected model list')


def derive(raw, task, expected_tokens, expected_fingerprint=FINGERPRINT):
    if raw.get('model') != MODEL or raw.get('system_fingerprint') != expected_fingerprint:
        return 'identity_mismatch', None
    answer = raw['choices'][0]['message']['content']
    finish = raw['choices'][0]['finish_reason']
    if raw['usage']['prompt_tokens'] != expected_tokens:
        status = 'input_token_mismatch'
    elif finish == 'length':
        status = 'length_limit'
    elif finish != 'stop':
        status = 'unverified_termination'
    elif not answer.strip():
        status = 'empty_output'
    elif task == 'action' and answer.strip() not in LABELS:
        status = 'format_error'
    else:
        status = 'valid'
    return status, answer.strip() if task == 'action' and status == 'valid' else None


def completion(run, state, reason=None):
    cases, rows = lines(run / 'case_manifest.jsonl'), lines(run / 'generations.jsonl')
    pre = read(run / 'preflight.json')['cases'] if (run / 'preflight.json').exists() else []
    eligible = sum(c['eligible'] for c in pre)
    attempted = len(list((run / 'private/attempts').glob('*.json')))
    write(run / 'COLLECTION_COMPLETE.json', {
        'run_id': read(run / 'run_manifest.json')['run_id'], 'recorded_at': now(),
        'assigned': len(cases), 'excluded': len(cases) - eligible if pre else None,
        'eligible': eligible if pre else None, 'attempted': attempted, 'ledger_records': len(rows),
        'responses': sum(r['http_status'] == 200 for r in rows),
        'unexecuted': eligible - attempted if pre else len(cases),
        'state': state, 'reason': reason, 'generations_sha256': sha((run / 'generations.jsonl').read_bytes()),
        'full_94_collected': len(rows) == 94 and all(r['http_status'] == 200 for r in rows),
    })


def collect(run, base, chat_path='/v1/chat/completions'):
    manifest = read(run / 'run_manifest.json')
    cases = lines(run / 'case_manifest.jsonl')
    preflight = read(run / 'preflight.json')
    pre = {key(c): c for c in preflight['cases']}
    require(len(pre) == len(cases) == 94 and set(pre) == {key(c) for c in cases}, 'Incomplete tokenizer preflight')
    require(manifest.get('generation_ready') is True, 'Compatibility/tokenizer evidence not approved for full collection')
    require(manifest['preflight_sha256'] == sha((run / 'preflight.json').read_bytes()), 'Preflight changed')
    require(manifest['case_manifest_sha256'] == sha((run / 'case_manifest.jsonl').read_bytes()), 'Case manifest changed')
    require(manifest['collector_sha256'] == sha(Path(__file__).read_bytes()), 'Collector changed since freeze')
    for c in pre.values():
        require(type(c['input_tokens_preflight']) is int and c['input_tokens_preflight'] >= 0, 'Missing actual tokenizer counts')
        require(not c['eligible'] or c['input_tokens_preflight'] + (32 if c['task'] == 'action' else 512) <= 4096, 'Context exceeded')
    done = {key(r) for r in lines(run / 'generations.jsonl')}
    # Saved attempts without a ledger record are ambiguous after interruption.
    for c in cases:
        require(key(c) in done or not (run / 'private/attempts' / f"{c['task']}_{c['case_id']}.json").exists(),
            'Interrupted attempt requires server-log reconciliation; refusing resubmission')
    health(run, base, 'collection_start' if not done else 'resume')
    start_health = read(run / 'evidence' / ('health_collection_start.json' if not done else 'health_resume.json'))
    require(start_health.get('system_fingerprint', start_health.get('model_fingerprint')) == manifest['expected_system_fingerprint'],
        'Current runtime fingerprint differs from frozen manifest')
    try:
        for c in cases:
            if key(c) in done or not pre[key(c)]['eligible']:
                continue
            stem = f"{c['task']}_{c['case_id']}"
            data = local(run, c['input_file']).read_bytes()
            require(canonical_sha(json.loads(data)) == c['input_sha256'], 'Frozen input changed')
            messages = json.loads(data)['messages']
            budget = 32 if c['task'] == 'action' else 512
            body = encoded({'model': MODEL, 'messages': messages, 'max_tokens': budget, 'temperature': 0, 'stream': False})
            request_name, attempt_name = f'private/requests/{stem}.json', f'private/attempts/{stem}.json'
            require(not (run / attempt_name).exists(), 'Attempt already exists')
            (run / request_name).write_bytes(body)
            started = now()
            generation_id = manifest['run_id'] + '_' + stem
            write(run / attempt_name, {'run_id': manifest['run_id'], 'task': c['task'], 'case_id': c['case_id'],
                'generation_id': generation_id, 'attempt_index': 1, 'started_at': started,
                'request_file': request_name, 'request_sha256': sha(body), 'input_sha256': c['input_sha256']})
            print(json.dumps({'event': 'started', 'task': c['task'], 'case_id': c['case_id'], 'recorded': len(done)}, ensure_ascii=False), flush=True)
            error = None
            try:
                code, raw_bytes = http(base, chat_path, body, timeout=1800)
            except (OSError, TimeoutError, socket.timeout) as exc:
                code = None
                error = {'type': type(exc).__name__, 'message': str(exc), 'completion_state': 'unknown'}
                raw_bytes = encoded({'transport_error': error})
            raw_name = f'private/raw/{stem}.json'
            (run / raw_name).write_bytes(raw_bytes)  # Save raw body before parsing/deriving.
            try:
                raw = json.loads(raw_bytes)
            except (ValueError, UnicodeError):
                if code == 200:
                    raise ValueError('Successful HTTP body is not JSON; saved raw requires reconciliation')
                raw = {'error': {'type': 'non_json_http_error', 'message': raw_bytes.decode('utf8', errors='replace')}}
            row = {k: c[k] for k in ('task', 'case_id', 'split', 'source_group_id', 'input_sha256')}
            row.update(run_id=manifest['run_id'], generation_id=generation_id, attempt_index=1,
                condition='FT31_STEP100', model_id=MODEL, checkpoint_sha256=CHECKPOINT, adapter_file_sha256=ADAPTER,
                request_file=request_name, request_sha256=sha(body), attempt_file=attempt_name,
                raw_response_file=raw_name, raw_response_sha256=sha(raw_bytes), private_response_file=None,
                response_sha256=None, input_tokens_preflight=pre[key(c)]['input_tokens_preflight'],
                input_tokens=None, generated_tokens=None, max_new_tokens=budget, started_at=started, completed_at=now(),
                http_status=code, finish_reason=None, status='unknown_completion' if code is None else 'http_error',
                error=error or raw.get('error'), system_fingerprint=raw.get('system_fingerprint'), predicted_label=None,
                server_request_id=raw.get('id'), usage=raw.get('usage'))
            if code == 200:
                answer = raw['choices'][0]['message']['content']
                answer_bytes = answer.encode('utf8')
                answer_name = f'private/responses/{stem}.txt'
                (run / answer_name).write_bytes(answer_bytes)
                status, label = derive(raw, c['task'], pre[key(c)]['input_tokens_preflight'], manifest['expected_system_fingerprint'])
                row.update(private_response_file=answer_name, response_sha256=sha(answer_bytes),
                    input_tokens=raw['usage']['prompt_tokens'], generated_tokens=raw['usage']['completion_tokens'],
                    finish_reason=raw['choices'][0]['finish_reason'], status=status, predicted_label=label)
            with (run / 'generations.jsonl').open('a', encoding='utf8') as stream:
                stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True, allow_nan=False) + '\n')
                stream.flush()
                os.fsync(stream.fileno())
            done.add(key(c))
            completion(run, 'collecting')
            print(json.dumps({'event': 'completed', 'task': c['task'], 'case_id': c['case_id'], 'recorded': len(done),
                'status': row['status'], 'input_tokens': row['input_tokens'], 'generated_tokens': row['generated_tokens']}, ensure_ascii=False), flush=True)
            if code != 200 or row['status'] in ('identity_mismatch', 'input_token_mismatch'):
                completion(run, 'blocked', f"Stopped after {stem}: {row['status']} HTTP {code}; no automatic retry")
                return 2
        health(run, base, 'after')
        completion(run, 'complete' if len(done) == sum(c['eligible'] for c in pre.values()) else 'partial')
        return 0
    except BaseException as exc:
        completion(run, 'interrupted', type(exc).__name__ + ': ' + str(exc))
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('prepare', 'collect', 'finalize'))
    parser.add_argument('run', nargs='?', type=Path)
    parser.add_argument('--base-url', default='http://127.0.0.1:18080')
    parser.add_argument('--chat-path', default='/v1/chat/completions')
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare()
        return 0
    require(args.run is not None, 'Run path required')
    if args.command == 'collect':
        return collect(args.run.resolve(), args.base_url, args.chat_path)
    completion(args.run.resolve(), 'blocked', 'Generation prerequisites unresolved; no requests submitted')
    return 0


if __name__ == '__main__':
    sys.exit(main())
