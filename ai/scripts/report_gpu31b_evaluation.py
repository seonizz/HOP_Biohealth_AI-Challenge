#!/usr/bin/env python3
"""Verify remote 31B worker/HTTP evidence without claiming local GGUF identity."""
import argparse
import csv
from copy import deepcopy
from datetime import datetime
import json
import io
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from zoneinfo import ZoneInfo
from report_controlled_auto_evaluation import (ARMS, read, rows, require, unique, private_path, arm_key,
    canonical, sha, digest, js_digest, verify_panel, registry, csv_text, number)
from gpu31b_eval_bridge import validate_ready, remote_identity


def reaggregate_metrics(root, panel):
    """Re-run frozen graders on a private temporary copy, never regenerate models."""
    source = root / 'frozen-source/ai/scripts'
    formatter, scorer = source / 'summarize_paired_role_evaluation.mjs', source / 'controlled_auto_panel.py'
    require(sha(scorer.read_bytes()) == panel['scorer_sha256'], 'Frozen scorer differs from audited scoring source')
    with tempfile.TemporaryDirectory(prefix='gpu31b-score-recheck-') as temporary:
        temporary = Path(temporary)
        for name in ('assignments.jsonl', 'outputs.jsonl', 'attempts.jsonl', 'metadata.json'):
            shutil.copyfile(root / 'fixed-run' / name, temporary / name)
        for command in ([
                'node', str(formatter), str(temporary)], [
                sys.executable, '-B', str(scorer), 'score', '--panel', str(root / 'panel'), '--run', str(temporary)]):
            result = subprocess.run(command, capture_output=True, text=True, timeout=120)
            require(result.returncode == 0, 'Fresh frozen metric reaggregation failed')
        require(all((temporary / name).read_bytes() == (root / 'fixed-run' / name).read_bytes()
                    for name in ('format-metrics.json', 'controlled-metrics.json')), 'Fresh frozen metric reaggregation differs from saved metrics')
    return {'format_reaggregation_identical': True, 'semantic_reaggregation_identical': True,
            'formatter_sha256': sha(formatter.read_bytes()), 'scorer_sha256': sha(scorer.read_bytes())}


class WorkerProof:
    def __init__(self, root, bridge_dir=None):
        self.root = Path(root)
        self.directory = Path(bridge_dir) if bridge_dir else self.root / 'bridge'
        self.ready_file = self.directory / 'worker-ready.json'
        self.ready = read(self.ready_file)
        self.normalized = validate_ready(self.ready)
        qualification = self.ready.get('adapter_disable_qualification', {})
        require(qualification.get('status') == 'passed' and qualification.get('disabled_matches_zero_scaling') is True
                and qualification.get('enabled_has_measurable_effect') is True, 'Real adapter-disable qualification missing')
        actual = self.ready.get('actual_weight_identity', {})
        require(actual.get('base_files_verified_by_preflight') is True and
                actual.get('adapter_parameters_sha256') == self.normalized['adapter_tensor_digest'], 'Actual remote parameter identity missing')
        require(digest(self.ready['base_files']) == self.normalized['base_model_digest']['value'], 'Remote base file manifest digest mismatch')
        require(digest(self.ready['tokenizer_files']) == self.normalized['tokenizer_manifest_sha256'], 'Remote tokenizer manifest digest mismatch')
        messages = rows(self.directory / 'worker-stdout.jsonl')
        ready = [r for r in messages if r.get('event') == 'ready']
        require(ready == [self.ready], 'Bridge ready file differs from actual JSONL ready event')
        self.responses = unique([r for r in messages if 'id' in r], lambda r: str(r['id']), 'Repeated worker response identifier')
        self.requests = unique(rows(self.directory / 'worker-stdin.jsonl'), lambda r: str(r['id']), 'Repeated worker request identifier')
        self.used_ids = set(); self.linked = 0; self.generation_proofs = 0; self.transport_failures = 0

    def verify_metadata(self, metadata):
        identity = metadata.get('remote_model_identity', {})
        require(all(identity.get(key) == value for key, value in self.normalized.items() if key != 'model')
                and identity.get('model', self.ready['model']) == self.ready['model'],
                'Remote manifest identity differs from pinned ready worker')
        require(metadata.get('base_model_sha256') is None and metadata.get('base_sha256') is None,
                'Remote directory manifest must not be labeled as a single GGUF/file digest')
        if 'base_model_digest' in metadata:
            require(metadata['base_model_digest'] == self.normalized['base_model_digest'], 'Wrong remote digest kind')
        if 'worker_ready_sha256' in metadata:
            require(metadata['worker_ready_sha256'] == digest(self.ready), 'Pinned ready digest mismatch')
        revision = metadata.get('training_base_revision')
        require(revision is None or revision == self.ready.get('loader_config', {}).get('model_revision'), 'Training base revision differs from verified loader')

    def verify_http(self, payload, headers, raw, execution_status, require_worker_reply=False):
        headers = {key.lower(): value for key, value in dict(headers).items()}
        identifier = headers.get('x-evaluation-worker-response-id')
        if identifier is None:
            require(not require_worker_reply, 'Infrastructure outcome without a worker reply cannot complete the fixed model panel')
            error = json.loads(raw).get('error', {}) if raw else {}
            require(execution_status == 'failed' and (not raw or isinstance(error, dict) and error.get('code') == 'worker_transport_failure'),
                    'HTTP response missing worker reply identity')
            self.transport_failures += 1
            return
        require(identifier not in self.used_ids and identifier in self.responses and identifier in self.requests, 'Worker reply replay/unknown identifier')
        message = self.responses[identifier]
        require(digest(message) == headers.get('x-evaluation-worker-reply-sha256'), 'Worker reply envelope hash mismatch')
        require(self.requests[identifier]['payload'] == payload, 'Worker input differs from recorded HTTP request')
        expected_body = message.get('response') if 'response' in message else {'error': message['error']}
        require(json.loads(raw) == expected_body, 'HTTP response differs from exact worker reply')
        evidence = message.get('response', {}).get('evidence') if 'response' in message else message.get('evidence', {})
        if 'response' in message:
            require(bool(evidence), 'Successful output lacks real parameter-state evidence')
        if evidence and 'adapter_flags_during' in evidence:
            scale = payload['lora'][0]['scale']; before = evidence.get('adapter_flags_before', {})
            during, after = evidence['adapter_flags_during'], evidence.get('adapter_flags_after', {})
            require(bool(before) and len(before) == self.ready['adapter_module_count'] and before == after and set(before) == set(during), 'LoRA flag coverage/restoration proof missing')
            require(all(value is False for value in before.values()) and all(value is (scale == 0) for value in during.values()),
                    'Actual LoRA layer flags disagree with assigned scale')
            require(evidence.get('lora_scale') == scale and evidence.get('request_seed') == 3407 and
                    evidence.get('temperature') == 0 and evidence.get('do_sample') is False and
                    evidence.get('input_truncated') is False and evidence.get('fresh_input_cache_per_request') is True,
                    'Actual worker generation contract mismatch')
            require(evidence.get('adapter_digest_before') == evidence.get('adapter_digest_after') == self.normalized['adapter_tensor_digest'],
                    'Actual adapter parameters changed during generation')
            self.generation_proofs += 1
        elif 'response' in message:
            raise ValueError('Successful output lacks actual LoRA layer flags')
        self.used_ids.add(identifier); self.linked += 1


def verify_gpu_return(root):
    receipt = read(root / 'gpu-return.json'); remote = read(root / 'REMOTE_RESULTS.json')
    supervisor = remote.get('SUPERVISOR_RESULT.json', {}); worker = remote.get('work/worker-v1/WORKER_RESULT.json', {})
    close = receipt.get('verified_closed', {}); closed = close.get('worker_closed', {})
    require(receipt.get('worker_absent') is True and supervisor.get('owned_worker_absent') is True
            and receipt.get('supervisor') == supervisor, 'Owned worker absence receipt mismatch')
    require(close.get('worker_close_verified') is True and close.get('worker_closed_received') is True
            and closed.get('status') == 'passed' and closed.get('adapter_unchanged') is True,
            'Verified worker close/checkpoint receipt missing')
    require(worker.get('status') == 'passed' and worker.get('adapter_unchanged') is True and worker.get('checkpoint_unchanged') is True,
            'Remote final adapter/checkpoint verification failed')
    require(supervisor.get('status') == 'completed' and supervisor.get('returncode') == 0, 'Owned supervisor did not complete normally')
    def gpu_rows(text):
        result = {}
        for fields in csv.reader(io.StringIO(text)):
            if not fields: continue
            require(len(fields) == 4, 'Unexpected GPU telemetry columns')
            index, uuid, memory, utilization = [field.strip() for field in fields]
            require(index not in result and uuid and memory.isdigit() and utilization.isdigit(), 'Invalid GPU telemetry value')
            result[index] = {'index': int(index), 'uuid': uuid, 'memory_used_mib': int(memory), 'utilization_percent': int(utilization)}
        require(len(result) == 2, 'Expected telemetry for both supervised GPUs')
        return result
    before, after = gpu_rows(supervisor['gpu_before']), gpu_rows(supervisor['gpu_after'])
    require(set(before) == set(after) and all(before[key]['uuid'] == after[key]['uuid'] for key in before), 'GPU identity changed between return snapshots')
    compute = [value.strip() for value in supervisor.get('compute_after', '').splitlines() if value.strip()]
    require(all(value.isdigit() for value in compute), 'Unrecognized compute-process telemetry')
    require(str(supervisor.get('worker_pid')) not in compute, 'Owned worker still listed in GPU compute processes')
    per_gpu = [{'index': before[key]['index'], 'uuid': before[key]['uuid'], 'before': before[key], 'after': after[key],
                'memory_delta_mib': after[key]['memory_used_mib'] - before[key]['memory_used_mib']} for key in sorted(before)]
    if not compute:
        require(all(row['memory_delta_mib'] <= 64 for row in per_gpu), 'GPU memory remains above pre-run baseline plus64MiB')
    return {'owned_worker_absent': True, 'worker_close_checkpoint_verified': True, 'gpu_return_verified': not bool(compute),
            'memory_baseline_tolerance_mib': 64, 'per_gpu': per_gpu, 'other_compute_pids_after': compute,
            'memory_attribution': 'unverified_other_compute_present' if compute else 'returned_to_baseline_within64MiB',
            'other_processes_stopped': receipt.get('other_processes_stopped'), 'gpu_reset_used': receipt.get('gpu_reset_used'),
            'scope': 'Owned worker and memory-return checks, not a blanket assertion of zero GPU/system errors.'}


def verify_fixed(root, protocol, panel, proof):
    run = root / 'fixed-run'
    summary, metadata = read(run / 'summary.json'), read(run / 'metadata.json')
    require(summary['status'] == 'completed', 'Fixed-request run not completed')
    assignments = rows(run / 'assignments.jsonl')
    require(assignments == panel['expected'], 'Fixed assignment inventory differs from frozen panel')
    require(metadata['suite_sha256'] == digest(panel['suite']) and metadata['suite_file_sha256'] == panel['raw_hashes'], 'Run suite hash mismatch')
    proof.verify_metadata(metadata)
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
        proof.verify_http(payload, response_meta.get('headers', []), raw, output['execution_status'], require_worker_reply=True)
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


def verify_flow(root, protocol, proof):
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
    collector = root / 'frozen-source/ai/scripts/run_gpu31b_full_flow.mjs'
    require(sha(collector.read_bytes()) == flow_protocol['collector_sha256'], 'Full-flow collector hash mismatch')
    metadata, summary = read(run / 'metadata.json'), read(run / 'summary.json')
    require(metadata['protocol_sha256'] == js_digest(flow_protocol) and metadata['collector_sha256'] == flow_protocol['collector_sha256'], 'Full-flow run protocol mismatch')
    proof.verify_metadata(metadata)
    require(flow_protocol['profile'].get('agentFormat') == 'prompt' and flow_protocol.get('contract_variant') == 'production_prompt_transport', 'HF worker transport must be explicit prompt-only profile')
    require(metadata['wire'] == flow_protocol['wire'] and metadata['profile'] == flow_protocol['profile'], 'Full-flow generation profile changed')
    require(flow_protocol.get('expected_remote_root', proof.ready['remote_root']) == proof.ready['remote_root'], 'Full-flow expected task root differs from pinned worker')
    require(summary['status'] == 'completed' and summary['assigned_count'] == summary['completed_case_count'] == 12 and summary['not_run_count'] == 0, 'Full-flow run not completed')
    results = rows(run / 'results.jsonl')
    mapped = unique(results, lambda r: r['logical_case_id'], 'Duplicate full-flow case')
    require(set(mapped) == {r['logical_case_id'] for r in assignments}, 'Missing full-flow outcome')
    require(summary['results'] == results, 'Full-flow summary differs from recorded results')
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
            if event['actual_post']:
                proof.verify_http(payload, event.get('response_headers', {}), raw, 'output_received' if event.get('http_status') == 200 else 'failed')
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
    return {'summary': summary, 'results': results, 'protocol': flow_protocol, 'metadata': metadata, 'actual_posts': posts}



def report_markdown(data, fixed, flow, proof):
    ended = max([r['completed_at'] for r in fixed['outputs'].values()] + [r['completed_at'] for r in flow['results']])
    visible = datetime.fromisoformat(ended.replace('Z', '+00:00')).astimezone(ZoneInfo('Asia/Seoul')).strftime('%Y-%m-%d %H:%M:%S KST')
    lines = ['# Gemma 4 31B step 4723 학습 전후 자동 평가', '', '실행 완료 시각: ' + visible, '',
        '**31B 기반 모델과 최종 학습 어댑터의 480개 고정 요청·12개 실제 앱 전체 흐름 실행을 집계했다. 실행 완료는 성능 기준 통과나 학습 최종 승인을 의미하지 않는다.**', '',
        '기반은 체크포인트에 결합된 기존 NF4 로더이며 동일한 기반·토크나이저·템플릿·greedy 설정에서 어댑터 적용 여부만 바꿨다. 전체 흐름의 검토자는 기반 모델 scale 0으로 고정했다. 실제 LoRA 레이어의 disable 플래그, 요청 전후 파라미터 digest와 SSH 워커 응답을 대조했다.', '',
        f"기반 revision: `{proof.ready['loader_config']['model_revision']}`. 파일 디렉터리의 manifest digest와 어댑터 파일 SHA·명명된 LoRA 텐서 digest를 구분했다. 로컬 GGUF 파일이나 GGUF 파일 SHA로 바꾸어 표시하지 않는다.", '',
        '31B는 카드 학습 후보다. 30개 복합 사례의 8개 닫힌 과제는 기존 12B와 동일한 입력·정답을 사용한 역할 전이 벤치마크이며 31B의 실제 카드 품질 전체를 뜻하지 않는다. 공유 계보는 6개이고 신규 독립 test가 아니다.', '',
        '## 최초 형식 적합성 M01', '', '| 슬롯 | 기반 통과/30 | 학습 통과/30 | 학습−기반 |', '|---|---:|---:|---:|']
    for variant in data['metrics'][0]['variants']:
        b, t = variant['per_arm']['baseline'], variant['per_arm']['trained']
        lines.append(f"| {variant['metric_variant']} | {b['numerator']}/30 | {t['numerator']}/30 | {number(variant['comparison']['difference'])} |")
    lines += ['', '처음 수신한 출력에 JSON 복구나 문법 강제를 적용하지 않았다. 슬롯별 결과를 가중 종합 점수로 합산하지 않는다.', '',
        '## 과제별 통제 점수', '', '| 지표 | 기반 | 학습 | 학습−기반 |', '|---|---:|---:|---:|']
    for metric in data['metrics'][1:]:
        if not metric.get('variants'): continue
        comparison = metric['variants'][0]['comparison']
        lines.append(f"| {metric['metric_id']} {metric['name']} | {number(comparison['baseline_value'])} | {number(comparison['trained_value'])} | {number(comparison['difference'])} |")
    lines += ['', 'M02는 실제 앱 생성·필수 검토·최종 출력 계약을 마친 사례 수를 모델당 배정 6개로 나눈 값이다. 확인된 실패도 분모에 남고 미실행과 구분된다. 전체 흐름은 JSON 문법 강제를 지원하지 않는 HF 워커에 맞춰 `production_prompt_transport` 프로파일을 사전에 고정했다. 기존 12B의 문법 제약 전송과 조건이 다르므로 모델 크기 간 차이를 학습 효과의 인과 비교로 해석하지 않는다.', '',
        '## 해석 범위와 미측정', '',
        '- M03~M13의 닫힌 튜플·공개 정책 점수는 자유 문장 이해·임상 안전성·실제 사용자 유용성을 확증하지 않는다.',
        '- M05와 A08 비교는 양쪽이 모두 완전 관측된 공통 슬롯만 사용하며 원래 관측률·coverage는 별도로 보존한다.',
        '- S2 정답 후보는 모두 두 번째 위치다. S8은 보이는 입력 6종과 세 정책 조합을 반복하므로 M01 S8·M12·M13의 구간은 미산출 처리했다. 나머지 구간도 공유 계보 6개를 묶은 기술적 파일럿 구간이며 통계적 합격 선언에 사용하지 않는다.',
        '- A08·A10·A14·A15·A16·A18은 제한된 부분 검사이며 전체 의미 지표를 대체하지 않는다. 실패 중간 출력의 알려진 위반도 별도 남기지만 겹치는 스냅샷을 독립 주장으로 합산하지 않는다.',
        '- M08·M10·M14·M15·M16·M17·M18은 사람 의미 판정이 없어 null이다. 선택적 J17은 실행하지 않았다.',
        '- M19·M20은 teacher-forced 라벨 전체 로그확률 수집·검증을 이번 경로에서 완료하지 않아 null이다. 이는 엔진이 모든 점수 방식을 지원하지 않는다는 단정이 아니다.', '',
        '## 실행 증거', '',
        f"워커 응답 ID·봉투 해시까지 연결한 HTTP 결과 {proof.linked}건, 실제 LoRA 파라미터 상태를 확인한 생성 {proof.generation_proofs}건, 워커 응답이 돌아오지 않은 확인된 전송 실패 {proof.transport_failures}건이다. 전송 실패를 생성 성공으로 바꾸지 않았다.", '',
        '- `all-metrics.json`, `metrics.csv`: 20개 지표 및 별도 부분 검사, 분자·분모·coverage·미측정 사유.',
        '- `fixed-run/`: 480개 배정과 최초 HTTP 요청·응답·채점 기록.',
        '- `full-flow-run/`: 실제 앱 경로 12개, 동적 POST·재시도·중간 출력·승인·최종 결과의 해시.',
        '- `bridge/worker-stdin.jsonl`, `worker-stdout.jsonl`: SSH 워커의 실제 요청·응답과 ready 식별 정보.',
        '- `verification.json`: 원격 manifest·워커 실제 적용 상태·고정 분모 결합 검증.', '',
        '## GPU 반환 확인', '',
        '소유 워커 PID 부재, 워커 정상 종료 및 체크포인트·어댑터 무변경을 확인했다. 메모리는 실행 전 기준 +64MiB를 허용 범위로 검사하며, 다른 작업이 나타나면 해당 메모리의 귀속은 미확인으로 남긴다.', '',
        '| GPU | 실행 전 MiB | 실행 후 MiB | 차이 MiB |', '|---|---:|---:|---:|']
    for gpu in data['gpu_return_verification']['per_gpu']:
        lines.append(f"| {gpu['index']} | {gpu['before']['memory_used_mib']} | {gpu['after']['memory_used_mib']} | {gpu['memory_delta_mib']:+d} |")
    lines += ['', 'GPU 반환 판정: ' + ('기준 범위 복귀 확인' if data['gpu_return_verification']['gpu_return_verified'] else '다른 compute 작업이 있어 메모리 귀속 미확인'),
              '이 확인은 소유 프로세스와 메모리 반환에 한정하며 모든 GPU·시스템 오류가 없다는 뜻은 아니다.']
    return '\n'.join(lines) + '\n'


def build_report(root, bridge_dir=None):
    root = Path(root).resolve(); protocol = read(root / 'protocol.json')
    require(protocol['fixed_total_requests'] == 480 and protocol['full_flow_assigned_cases'] == 12, 'Unexpected evaluation budget')
    require(sha((root / 'plan.md').read_bytes()) == protocol['plan_sha256'], 'Plan snapshot hash mismatch')
    proof = WorkerProof(root, bridge_dir)
    require(proof.ready.get('loader_config', {}).get('model_revision') == '8e256fc6d63003fc0ca8c91b976e6dcc38433385', 'Unexpected checkpoint-bound base revision')
    require('s000004723' in proof.ready.get('checkpoint', ''), 'Unexpected final training checkpoint')
    require('nf4' in proof.ready.get('base_loading', '').lower(), 'Expected checkpoint-bound NF4 loader')
    panel = verify_panel(root); fixed = verify_fixed(root, protocol, panel, proof); flow = verify_flow(root, protocol, proof)
    reaggregation = reaggregate_metrics(root, panel)
    gpu_return = verify_gpu_return(root)
    coverage = read(root / 'design-coverage-audit.json')
    data = registry(fixed, flow, coverage)
    data.update(model_parameter_class='31B', checkpoint_step=4723, remote_model_identity=proof.normalized,
                base_loading=proof.ready['base_loading'], training_base_revision=proof.ready['loader_config']['model_revision'],
                training_base_revision_verified=True, evaluation_role='controlled_benchmark_transfer_for_card_model',
                cross_size_causal_comparison=False, full_flow_transport_profile='production_prompt_transport',
                gpu_return_verification=gpu_return)
    for metric in data['metrics']:
        if metric['metric_id'] == 'M02': metric['variants'][0]['contract_variant'] = 'production_prompt_transport'
        if metric['metric_id'] in ('M19', 'M20'):
            metric['reason'] = 'teacher_forced_label_logprob_collection_not_validated_in_this_run_not_a_blanket_engine_support_claim'
    for metric in data['auxiliary_metrics']:
        if metric.get('panel') == 'controlled_full_flow': metric['contract_variant'] = 'production_prompt_transport'
    verification = {'schema': 'malssi-gpu31b-report-verification-v1', 'automatic_panel_complete': True,
        'fixed_assigned_requests': 480, 'full_flow_completed_cases': 12, 'full_flow_actual_posts': flow['actual_posts'],
        'worker_http_reply_links_verified': proof.linked, 'actual_lora_generation_proofs_verified': proof.generation_proofs,
        'confirmed_transport_failures_without_worker_reply': proof.transport_failures, 'worker_ready_sha256': digest(proof.ready),
        'base_digest_kind': proof.normalized['base_model_digest']['kind'], 'remote_model_identity': proof.normalized,
        'not_run_count': 0, 'evaluator_errors': [], 'human_scores_created': False, 'research_quality_approved': False,
        'gpu_return_verified': gpu_return['gpu_return_verified'], 'gpu_return_verification': gpu_return,
        'reporter_sha256': sha(Path(__file__).read_bytes()),
        'fresh_metric_reaggregation': reaggregation,
        'input_artifact_hashes': {str(p.relative_to(root)): sha(p.read_bytes()) for p in (
            root / 'protocol.json', root / 'plan.md', root / 'fixed-run/outputs.jsonl', root / 'fixed-run/format-metrics.json',
            root / 'fixed-run/controlled-metrics.json', root / 'full-flow/protocol.json', root / 'full-flow-run/results.jsonl')},
        'bridge_transcript_sha256': {'worker-stdin.jsonl': sha((proof.directory / 'worker-stdin.jsonl').read_bytes()),
                                    'worker-stdout.jsonl': sha((proof.directory / 'worker-stdout.jsonl').read_bytes())}}
    artifacts = {'REPORT.md': report_markdown(data, fixed, flow, proof),
                 'all-metrics.json': json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + '\n',
                 'metrics.csv': csv_text(data), 'verification.json': json.dumps(verification, ensure_ascii=False, indent=2, allow_nan=False) + '\n'}
    for name, text in artifacts.items():
        temporary = root / (name + '.tmp'); temporary.write_text(text); temporary.replace(root / name)
    return {'automatic_panel_complete': True, 'metrics_registered': 20, 'worker_reply_links': proof.linked, 'generated_files': sorted(artifacts)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path); parser.add_argument('--bridge-dir', type=Path)
    print(canonical(build_report(**vars(parser.parse_args()))))


if __name__ == '__main__': main()
