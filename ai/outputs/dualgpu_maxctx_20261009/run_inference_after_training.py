#!/usr/bin/env python3
"""Run the preserved v6 synthetic capacity search only after final SFT results.

Each invocation creates new evidence. A fresh strict collector must verify the
complete 40,415-row epoch and both 4,298-row evaluations before any GPU query or
probe. The v6 child acquires both shared GPU locks before importing CUDA code.
"""
import argparse
import csv
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import traceback
import uuid
import zipfile

ROOT = Path('/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009')
PYTHON = '/home/slim/choieram/malssi-validation-20261009/.venv/bin/python'
GPU_UUIDS = ('GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c',
             'GPU-a2d3d60c-4eae-7e46-45bc-146e24457642')
BINDINGS = {name + '_sha256' for name in ('dataset', 'config', 'model', 'template', 'code', 'environment')}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def utc():
    return dt.datetime.now(dt.timezone.utc)


def confined(root, path):
    path = Path(path).absolute()
    require(path == path.resolve() and path.is_relative_to(root), 'Unsafe artifact path')
    return path


def signature(path):
    stat = path.stat()
    require(path.is_file() and path == path.resolve(), 'Artifact must be a regular nonsymlink file')
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns


def fingerprint(path):
    before = signature(path)
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda: handle.read(8 * 1024 * 1024), b''):
            digest.update(block)
    require(signature(path) == before, 'Artifact changed while hashing')
    return {'sha256': digest.hexdigest(), 'bytes': before[2], 'signature': before}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def read_json(path):
    before = signature(path)
    data = path.read_bytes()
    require(signature(path) == before, 'JSON artifact changed while reading')
    return json.loads(data, object_pairs_hook=unique_object,
                      parse_constant=lambda _: require(False, 'Nonfinite JSON value'))


def candidate(kit):
    """Cheap readiness filter only; never substitutes for the strict collector."""
    complete = read_json(kit / 'work/COMPLETE.json')
    training = read_json(kit / 'work/training/TRAINING_RESULT.json')
    run = read_json(kit / 'work/training/RUN.json')
    b0, b1 = (read_json(kit / ('work/validation_' + name + '.json')) for name in ('B0', 'B1'))
    bound = complete.get('bindings', {})
    require(set(bound) == BINDINGS and all(isinstance(v, str) and re.fullmatch('[0-9a-f]{64}', v)
                                         for v in bound.values()), 'Incomplete completion bindings')
    require(all(report.get('bindings') == bound for report in (run, b0, b1)), 'Completion bindings mismatch')
    require(complete.get('status') == 'stage1_epoch_completed' and complete.get('training') == training
            and complete.get('hop_deployment_ready') is False, 'Final completion marker is not ready')
    require(training.get('status') == 'completed' and training.get('completed_optimizer_steps') == 5052
            and training.get('total_rows') == training.get('next_row_cursor') == 40415
            and training.get('epoch_completed') is True and training.get('hop_readiness') is False,
            'Full training epoch is not complete')
    require(run.get('plan', {}).get('rows') == 40415 and run['plan'].get('optimizer_steps') == 5052
            and run.get('settings', {}).get('epochs') == 1, 'Full epoch plan mismatch')
    for report in (b0, b1):
        evaluation = report['evaluation']
        loss = evaluation.get('target_mean_loss')
        require(evaluation.get('rows') == 4298 and evaluation.get('supervised_tokens') == 362003
                and type(loss) in (int, float) and math.isfinite(loss) and loss >= 0,
                'Full validation is not complete')
    require(complete.get('baseline') == b0['evaluation'] and complete.get('final') == b1['evaluation']
            and b1.get('checkpoint') == training.get('checkpoint'), 'Evaluation completion mismatch')
    attempts = sorted(path for path in (kit / 'work/collection').glob('*')
                      if re.fullmatch(r'\d{8}T\d{6}Z-(start|resume|evaluate)-\d+', path.name))
    require(attempts, 'Final training/evaluation wrapper is not recorded')
    events = [json.loads(line) for line in (attempts[-1] / 'events.jsonl').read_text().splitlines()]
    require(len(events) == 2 and events[0].get('event') == 'start' and events[1].get('event') == 'end'
            and events[1].get('exit_code') == events[1].get('log_exit_code') == 0,
            'Final training/evaluation wrapper has not ended successfully')
    ended = dt.datetime.fromisoformat(events[1]['utc'])
    require(ended.tzinfo is not None and (utc() - ended).total_seconds() >= 5,
            'Waiting for final wrapper and its GPU monitor to settle')
    return bound


class Runner:
    def __init__(self, root=ROOT, python=PYTHON):
        self.root = Path(root).absolute()
        require(self.root == self.root.resolve() and self.root.is_dir(), 'Unsafe or missing task root')
        self.kit = confined(self.root, self.root / 'training_kit')
        self.python = python
        self.collector = confined(self.root, self.root / 'scripts/collect_results.py')
        self.probe = confined(self.root, self.root / 'scripts/capacity_probe_v6.py')
        self.scripts = {path: fingerprint(path) for path in (self.collector, self.probe)}
        name = 'inference-after-training-' + utc().strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:12]
        self.directory = confined(self.root, self.root / 'work/collection' / name)
        self.directory.mkdir(parents=True, exist_ok=False)
        self.report = self.directory / 'report.json'
        self.watched = {}
        self.state = {'schema_version': 'malssi.inference-after-training.v1', 'status': 'running',
                      'phase': 'waiting_for_training_results', 'pid': os.getpid(), 'started_utc': utc().isoformat(),
                      'profiles': [], 'synthetic_only': True, 'model_context_limit': 262144,
                      'maximum_output_measured': False, 'maximum_input_measured': False,
                      'hop_deployment_ready': False, 'training_gate_passed': False,
                      'runner_sha256': fingerprint(Path(__file__).resolve())['sha256'],
                      'scripts': {str(p): {k: v[k] for k in ('sha256', 'bytes')} for p, v in self.scripts.items()},
                      'gpu_lock_policy': 'Each v6 child exclusively acquires both shared .malssi-UUID.lock files before CUDA imports'}
        self.save()

    def save(self):
        self.state['updated_utc'] = utc().isoformat()
        temporary = self.directory / ('report-' + uuid.uuid4().hex + '.tmp')
        with temporary.open('x') as handle:
            json.dump(self.state, handle, indent=2, allow_nan=False)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(self.report)

    def wait_for_candidate(self, poll_seconds, timeout, check_only=False):
        began = time.monotonic()
        while True:
            try:
                candidate(self.kit)
                return
            except (OSError, ValueError, KeyError, TypeError, RuntimeError):
                self.state['phase'] = 'waiting_for_training_results'
                self.save()
                require(not check_only, 'Complete training and B0/B1 evidence is not available')
                require(not timeout or time.monotonic() - began < timeout, 'Timed out waiting for training results')
                time.sleep(min(poll_seconds, max(0.01, timeout - (time.monotonic() - began))) if timeout else poll_seconds)

    def verify_unchanged(self):
        for path, evidence in {**self.scripts, **self.watched}.items():
            require(signature(path) == evidence['signature'], 'Verified training evidence or executable changed')

    def verify_training(self):
        """Always invoke a fresh strict collection; never select a stored report."""
        bound = candidate(self.kit)
        self.verify_unchanged()
        parent = confined(self.root, self.kit / 'work/collection')
        previous = set(parent.glob('results-*'))
        began = utc()
        self.state['phase'] = 'verifying_final_training_results'
        self.save()
        command = [self.python, '-B', str(self.collector), '--kit', str(self.kit)]
        process = subprocess.run(command, cwd=self.root, stdin=subprocess.DEVNULL, capture_output=True, text=True)
        for name, data in (('collector.stdout.log', process.stdout), ('collector.stderr.log', process.stderr)):
            with (self.directory / name).open('x') as handle:
                handle.write(data)
        require(process.returncode == 0, 'Fresh strict final collection failed; GPU work refused')
        receipt = json.loads(process.stdout, object_pairs_hook=unique_object)
        require(receipt.get('status') == 'verified_complete' and receipt.get('stage1_sft_completed') is True
                and receipt.get('hop_deployment_ready') is False, 'Collector did not attest final completion')
        output = confined(self.root, receipt['output_directory'])
        require(output.parent == parent and re.fullmatch(r'results-\d{8}T\d{6}Z-[0-9a-f]{8}', output.name)
                and output not in previous, 'Collector returned an old or unrelated result directory')
        summary_path = confined(self.root, output / 'summary.json')
        summary = read_json(summary_path)
        stamp = dt.datetime.fromisoformat(summary['created_utc'])
        require(stamp.tzinfo is not None and began <= stamp <= utc(), 'Stale collector summary timestamp')
        require(summary.get('schema_version') == 'malssi.stage1-dualgpu-collection.v1'
                and summary.get('status') == 'verified_complete' and summary.get('stage1_sft_completed') is True
                and summary.get('hop_deployment_ready') is False and summary.get('verification_errors') == []
                and summary.get('kit_path') == str(self.kit), 'Invalid strict collection summary')
        for section in ('identity', 'source_data', 'tokens', 'qualification', 'canary', 'training', 'validation',
                        'train_log', 'command_completion', 'snapshot_stability'):
            require(summary.get(section, {}).get('verified') is True, 'Unverified collection section: ' + section)
        training, validation = summary['training'], summary['validation']
        require(summary['identity']['bindings'] == bound == candidate(self.kit)
                and training.get('optimizer_steps') == 5052 and training.get('cursor') == 40415
                and training.get('epoch_completed') is True and validation.get('rows') == 4298
                and validation.get('supervised_tokens') == 362003
                and summary['train_log'].get('unique_steps') == 5052
                and summary['train_log'].get('missing_steps') == [], 'Collected full-epoch proof mismatch')
        results = confined(self.root, output / 'RESULTS.md')
        archive = confined(self.root, output / 'presentation_results.zip')
        require(results.stat().st_size > 0, 'Final RESULTS.md is absent or empty')
        with zipfile.ZipFile(archive) as handle:
            require(handle.testzip() is None and len(handle.namelist()) == len(set(handle.namelist()))
                    and handle.read('summary.json') == summary_path.read_bytes()
                    and handle.read('RESULTS.md') == results.read_bytes(), 'Final results archive mismatch')
        references = summary['private_server_source_references']
        required = {'work/COMPLETE.json', 'work/validation_B0.json', 'work/validation_B1.json',
                    'work/training/RUN.json', 'work/training/TRAINING_RESULT.json', 'work/training/train.jsonl',
                    'work/training/checkpoints/step-000005052/CHECKPOINT.json'}
        require(required <= references.keys(), 'Collector omitted required source proof')
        manifest = read_json(self.kit / 'MANIFEST.json')
        expected = {**manifest['files'], **references,
                    'MANIFEST.json': {'sha256': summary['identity']['manifest_sha256']}}
        for relative, evidence in expected.items():
            path = confined(self.kit, self.kit / relative)
            actual = fingerprint(path)
            require(actual['sha256'] == evidence['sha256']
                    and actual['bytes'] == evidence.get('bytes', actual['bytes']), 'Collected source changed after verification')
            self.watched[path] = actual
        for path in (summary_path, results, archive):
            self.watched[path] = fingerprint(path)
        self.verify_unchanged()
        self.state.update(training_gate_passed=True, phase='training_results_verified', training_gate={
            'strict_collector_exit_code': 0, 'allow_incomplete': False, 'result_directory': str(output),
            'summary_sha256': self.watched[summary_path]['sha256'], 'results_sha256': self.watched[results]['sha256'],
            'archive_sha256': self.watched[archive]['sha256'], 'bindings': bound,
            'optimizer_steps': 5052, 'training_rows': 40415, 'validation_rows': 4298,
            'validation_supervised_tokens': 362003, 'verified_utc': utc().isoformat()})
        self.save()

    def require_no_gpu_owner(self):
        require(self.state['training_gate_passed'], 'Training gate must pass before GPU queries')
        output = subprocess.check_output(['nvidia-smi', '--query-compute-apps=gpu_uuid,pid',
                                          '--format=csv,noheader,nounits'], text=True, timeout=30)
        for fields in csv.reader(output.splitlines()):
            require(len(fields) == 2, 'Malformed GPU owner inventory')
            require(fields[0].strip() not in GPU_UUIDS, 'A requested GPU still has a compute owner; probe refused')

    def measure(self, name, inputs, output, chunk, parity=False):
        require(self.state['training_gate_passed'], 'Full training/evaluation/results gate has not passed')
        self.verify_unchanged()
        self.require_no_gpu_owner()
        self.state['phase'] = name
        before = set((self.root / 'work/probes').glob('*/result.json'))
        command = [self.python, '-B', str(self.probe), '--mode', 'inference', '--length', str(inputs),
                   '--new-tokens', str(output), '--force-budget', '--layer-split', '32', '--prefill-chunk-size', str(chunk)]
        if parity:
            command.append('--verify-prefill-parity')
        log = self.directory / (name + '.log')
        with log.open('xb') as handle:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=handle,
                                       stderr=subprocess.STDOUT, cwd=self.root)
            self.state['active_child'] = {'pid': process.pid, 'command': command, 'log': str(log)}
            self.save()
            code = process.wait()
        paths = set((self.root / 'work/probes').glob('*/result.json')) - before
        require(len(paths) == 1, 'Expected exactly one fresh inference probe report')
        path = confined(self.root, paths.pop())
        result = read_json(path)
        summary = {key: result.get(key) for key in ('status', 'arguments', 'oom', 'error_type', 'actual_input_tokens',
                   'actual_generated_tokens', 'actual_total_tokens', 'measured_phase_seconds', 'gpu_memory',
                   'prefill_parity', 'inference_observation')}
        summary.update(name=name, result_path=str(path), result_sha256=fingerprint(path)['sha256'], process_exit=code)
        self.state['profiles'].append(summary)
        self.state.pop('active_child', None)
        self.save()
        self.verify_unchanged()
        require(result.get('schema_version') == 'malssi.dualgpu-capacity-probe.v6'
                and result.get('script_sha256') == self.scripts[self.probe]['sha256']
                and result.get('gpu_uuids') == list(GPU_UUIDS), 'Probe implementation/device identity mismatch')
        for key, value in {'mode': 'inference', 'length': inputs, 'new_tokens': output,
                           'force_budget': True, 'layer_split': 32, 'prefill_chunk_size': chunk,
                           'verify_prefill_parity': parity}.items():
            require(result.get('arguments', {}).get(key) == value, 'Probe arguments do not match request')
        require(code == 0 and result['status'] == 'passed' or code != 0 and result['status'] == 'failed',
                'Probe exit/report mismatch')
        if result['status'] == 'failed':
            require(result.get('oom') is True, 'Inference failed for a reason other than capacity')
        else:
            require(result.get('actual_input_tokens') == inputs and result.get('actual_generated_tokens') == output
                    and result.get('actual_total_tokens') == inputs + output, 'Forced token budget was not measured')
        events = [json.loads(line) for line in (path.parent / 'events.log').read_text().splitlines()]
        require(any(event.get('event') == 'both_gpu_locks_acquired' for event in events), 'Probe lacks both-GPU lock evidence')
        return result

    def search(self):
        # Deliberately identical v6 search order, budgets, split and chunk ladder.
        parity = self.measure('inference-parity-8192-plus64', 8192, 64, 4096, parity=True)
        require(parity['status'] == 'passed', 'Short prefill parity must pass before a long inference measurement')
        selected_chunk = None
        for chunk in (4096, 2048, 1024, 512, 256, 128):
            result = self.measure('inference-max-input-chunk' + str(chunk), 262143, 1, chunk)
            if result['status'] == 'passed':
                selected_chunk = chunk
                self.state.update(maximum_input_measured=True, maximum_input_tokens_with_one_generated_token=262143)
                self.save()
                break
        require(selected_chunk is not None, 'Native context did not fit; preserve observations for bounded lower-context search')
        result = self.measure('inference-max-output-from2', 2, 262142, selected_chunk)
        require(result['status'] == 'passed', 'Maximum output profile did not finish')
        self.state.update(status='passed', phase='completed', maximum_output_measured=True,
                          maximum_generated_tokens_with_two_input_tokens=262142, tested_total_token_budget=262144,
                          input_output_share_budget=True, prefill_chunk_size=selected_chunk, layer_split=32,
                          context_quality_verified=False, concurrent_requests_verified=1)


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--poll-seconds', type=float, default=10)
    parser.add_argument('--wait-timeout', type=float, default=0, help='Seconds; 0 waits without a deadline')
    parser.add_argument('--check-only', action='store_true', help='Verify completion once; never query GPUs or run probes')
    args = parser.parse_args(argv)
    if not math.isfinite(args.poll_seconds) or not 0 < args.poll_seconds <= 60:
        parser.error('poll-seconds must be finite and in (0, 60]')
    if not math.isfinite(args.wait_timeout) or args.wait_timeout < 0:
        parser.error('wait-timeout must be finite and nonnegative')
    return args


def main(argv=None):
    args = arguments(argv)
    runner = Runner()
    try:
        runner.wait_for_candidate(args.poll_seconds, args.wait_timeout, args.check_only)
        runner.verify_training()
        if args.check_only:
            runner.state.update(status='gate_passed', phase='check_only_completed')
        else:
            runner.search()
    except BaseException as error:
        runner.state.update(status='failed', error_type=type(error).__name__, error=str(error))
        with (runner.directory / 'error.log').open('x') as handle:
            handle.write(traceback.format_exc())
    finally:
        runner.save()
    print(json.dumps({'status': runner.state['status'], 'report': str(runner.report)}))
    return 0 if runner.state['status'] in ('passed', 'gate_passed') else 1


if __name__ == '__main__':
    raise SystemExit(main())
