"""Synthetic, CPU-only regression fixtures; never load model weights or torch."""
import copy
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

DIRECTORY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('dualgpu_collector', DIRECTORY / 'collect_results.py')
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
PRIVATE = 'DO_NOT_EXPORT_PRIVATE_TEXT_OR_TOKEN_IDS'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def put(root, name, value):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value if isinstance(value, bytes) else (json.dumps(value) + '\n').encode())
    return path


def read(root, name):
    return json.loads((root / name).read_text())


def fixture(root):
    template = DIRECTORY / 'training_kit'
    for directory in ('counseling_pipeline', 'scripts'):
        for path in (template / directory).glob('*.py'):
            put(root, str(path.relative_to(template)), path.read_bytes())
    config = json.loads((template / 'config/train.json').read_text())
    config.update(max_length=32768, device_map='layer_split', layer_split=28, unsloth_tiled_mlp=True)
    put(root, 'config/train.json', config)
    put(root, 'config/model_fingerprint.json', {'fixture_only': True})
    put(root, 'config/requirements.server.freeze.txt', b'fixture==1\n')
    put(root, 'run.sh', b'#!/bin/sh\n# fixture only\n')
    manifest = {'training_profile': 'observed_counselor_imitation', 'selected_cap': 32768, 'files': {}, 'selection': {}}
    ledger, tokenfiles = [], {}
    for split, (rows, tokens) in collector.SPLITS.items():
        base, remainder = divmod(tokens, rows)
        raw, inputs = [], 0
        for i in range(rows):
            target = base + int(i < remainder)
            length = 25316 if i == 0 else target + 1
            row = {'id': split + '-' + str(i), 'split': split, 'source_group_id': split,
                   'source_conversation_id': split, 'task': 'original_counselor_continuation',
                   'target_origin': 'observed_counselor_utterance', 'caregiver_perspective_assumed': False,
                   'private_source': PRIVATE}
            raw.append(collector.canonical(row) + b'\n')
            ledger.append({**{key: row[key] for key in ('id', 'split', 'source_group_id', 'source_conversation_id')},
                           'status': 'encoded', 'sequence_length': length, 'target_length': target,
                           'prefix_length': length - target, 'template_sha256': collector.TEMPLATE_SHA256})
            inputs += length
        data = b''.join(raw)
        path = put(root, 'data/' + split + '.jsonl.gz', gzip.compress(data))
        manifest['files'][path.name] = {'rows': rows, 'bytes': path.stat().st_size,
                                      'sha256': sha(path), 'uncompressed_sha256': hashlib.sha256(data).hexdigest()}
        manifest['selection'][split] = {'supervised_tokens': tokens, 'full_tokens': inputs}
        path = put(root, 'work/tokens/' + split + '.jsonl.gz', b'SYNTHETIC_PRIVATE_TOKEN_CACHE')
        tokenfiles[path.name] = {'rows': rows, 'supervised_tokens': tokens, 'input_tokens': inputs, 'sha256': sha(path)}
    put(root, 'data/expected_lengths.jsonl.gz', gzip.compress(b''.join(collector.canonical(r) + b'\n' for r in ledger)))
    put(root, 'data/export_manifest.json', manifest)
    files = {str(p.relative_to(root)): {'bytes': p.stat().st_size, 'sha256': sha(p)}
             for p in root.rglob('*') if p.is_file() and not p.is_relative_to(root / 'work')}
    put(root, 'MANIFEST.json', {'schema_version': 'malssi.training-kit-files.v1', 'files': files})
    c = collector.Collector(root)
    c.verify_identity()
    bound = c.bound
    put(root, 'work/tokens/manifest.json', {'status': 'passed', 'bindings': bound, 'files': tokenfiles})
    archive = DIRECTORY.parents[1] / '말씨_학습_에이전트_인수인계_2026-10-09.zip'
    with zipfile.ZipFile(archive) as z:
        q = json.loads(z.read('malssi_stage1_training_20261009/evidence/qualification.json'))
    q.update(bindings=bound, private_extra=PRIVATE)
    checks = {item['name']: item for item in q['checks']}
    checks['gpu_pin']['evidence'] = {'requested_uuids': list(collector.GPU_UUIDS), 'actual_uuids': list(collector.GPU_UUIDS),
        'placement': {device: {'tensors': 12, 'elements': 100, 'trainable_tensors': 2} for device in ('cuda:0', 'cuda:1')}}
    checks['token_contract']['evidence']['context_budget'] = 32768
    checks['fused_gradient']['evidence']['upstream_gradients_by_device'] = {
        device: {'all_finite': True, 'tensors': 2, 'l2_norm': .1} for device in ('cuda:0', 'cuda:1')}
    metric = {'reference_norm': 1.0, 'observed_norm': 1.0, 'relative_l2_error': .001,
              'cosine': 1 - .001**2 / 2, 'both_exactly_zero': False, 'passed': True,
              'all_finite': True, 'elements': 10752*5376, 'maximum_relative_l2_error': .02, 'minimum_cosine': .999}
    calls = ([{'shape': [1, 5376, 5376], 'grad_enabled': False}] * 2
             + [{'shape': [1, 5376, 5376], 'grad_enabled': True}] * 2)
    tiled = {'criterion': 'tiled_mlp_bf16_v1', 'patched_language_mlp_count': 60, 'optimizer_steps': 0,
             'adapter_hash_before': 'a'*64, 'adapter_hash_after': 'a'*64, 'weights_unchanged': True,
             'synthetic_inputs': True, 'passed': True, 'modules': []}
    for index, device in enumerate(('cuda:0', 'cuda:1')):
        tiled['modules'].append({'device': device, 'module': 'model.language_model.layers.' + str(index*28) + '.mlp',
                                'input_shape': [1, 10752, 5376], 'expected_tiles': 2,
                                'observed_tile_calls': calls, 'passed': True, 'metrics': {
                                    'output': metric, 'hidden_gradient': metric,
                                    'lora_gradients': {projection + '.lora_' + part + '.default.weight': metric
                                                       for projection in ('gate_proj', 'up_proj', 'down_proj')
                                                       for part in ('A', 'B')}}})
    q['checks'].append({'name': 'tiled_mlp_equivalence', 'passed': True, 'evidence': tiled})
    put(root, 'work/qualification.json', q)
    def make_run(directory, mode, rows, steps, tokens):
        run = {'schema_version': 1, 'mode': mode, 'output_directory': str(root / directory), 'bindings': bound,
               'plan': {'rows': rows, 'optimizer_steps': steps, 'order': list(range(rows)),
                        'supervised_tokens': tokens, 'encoded_rows_sha256': 'a'*64},
               'settings': {'epochs': 1, 'microbatch_size': 1, 'accumulation_steps': 8, 'max_length': 32768,
                            'seed': 3407, 'clip_grad_norm': 1.0, 'shuffle': mode == 'train'}, 'private': PRIVATE}
        put(root, directory + '/RUN.json', run)
        return run
    def checkpoint(directory, run, step, cursor, adapter):
        path = directory + '/checkpoints/step-' + str(step).zfill(9)
        files = {}
        for name in ('adapter_model.safetensors', 'training_state.pt'):
            files[name] = sha(put(root, path + '/' + name, PRIVATE.encode()))
        manifest = {'schema_version': 1, 'step': step, 'cursor': cursor, 'run_sha256': collector.digest(run),
                    'adapter_parameters_sha256': adapter, 'files': files}
        return sha(put(root, path + '/CHECKPOINT.json', manifest))
    def result(directory, run, step, cursor, done):
        return {'schema_version': 1, 'status': 'completed' if done else 'step_cap_reached', 'mode': run['mode'],
                'completed_optimizer_steps': step, 'next_row_cursor': cursor, 'total_rows': run['plan']['rows'],
                'epoch_completed': done, 'checkpoint': str(root / directory / 'checkpoints' / ('step-' + str(step).zfill(9))),
                'run_sha256': collector.digest(run), 'hop_readiness': False}
    run = make_run('work/canary', 'canary', 24, 3, 1000)
    step2sha = checkpoint('work/canary', run, 2, 16, '2'*64)
    checkpoint('work/canary', run, 3, 24, '3'*64)
    r3 = result('work/canary', run, 3, 24, True)
    put(root, 'work/canary/TRAINING_RESULT.json', r3)
    put(root, 'work/canary/train.jsonl', b'SYNTHETIC_CANARY_LOG')
    for name, steps, cursor, done, after in (('canary', 2, 16, False, '4'*64), ('canary-resume', 3, 24, True, '5'*64)):
        put(root, 'work/' + name + '_execution.json', {'result': result('work/canary', run, steps, cursor, done),
            'initial_base_adapter_sha256': '1'*64, 'after_adapter_sha256': after,
            'gpu_peaks': [{'uuid': gpu, 'peak_allocated_gib': 20.0, 'peak_reserved_gib': 22.0} for gpu in collector.GPU_UUIDS]})
    gate = {'schema_version': 'malssi.stage1-readiness.v1', 'mode': 'optimizer_canary', 'status': 'passed',
            'optimizer_steps': 3, 'bindings': bound, 'checks': [
        {'name': 'weights_updated', 'passed': True, 'evidence': {'before': '1'*64, 'after': '5'*64}},
        {'name': 'checkpoint_saved', 'passed': True, 'evidence': {'checkpoint': r3['checkpoint']}},
        {'name': 'checkpoint_resumed', 'passed': True, 'evidence': {'step2_manifest_sha256': step2sha,
            'step2_adapter_sha256': '2'*64, 'step3_adapter_sha256': '3'*64, 'resumed_in_separate_process': True}},
        {'name': 'longest_source_context', 'passed': True, 'evidence': {'max_source_sequence_length': 25316,
            'configured_context_limit': 32768, 'microbatch_size': 1, 'accumulation_steps': 8,
            'gpu_uuids': list(collector.GPU_UUIDS), 'canary_only_repeat_longest_eight_each_step': True,
            'max_sequence_length_each_step': [25316, 25316, 25316]}}],
        'artifacts': {name: sha(root / 'work' / name) for name in collector.CANARY_ARTIFACTS}}
    put(root, 'work/canary_gate.json', gate)
    run = make_run('work/training', 'train', 40415, 5052, 3291230)
    checkpoint('work/training', run, 5052, 40415, '6'*64)
    result = result('work/training', run, 5052, 40415, True)
    put(root, 'work/training/TRAINING_RESULT.json', result)
    def evaluation(loss):
        return {'rows': 4298, 'supervised_tokens': 362003, 'target_mean_loss': loss,
                'weighting': 'shifted_nonignored_target_tokens', 'behavioral_quality_verified': False}
    b0, b1 = evaluation(2.0), evaluation(1.5)
    put(root, 'work/validation_B0.json', {'bindings': bound, 'evaluation': b0, 'model': 'base_plus_zero_initialized_lora'})
    put(root, 'work/validation_B1.json', {'bindings': bound, 'evaluation': b1,
                                      'checkpoint': result['checkpoint'], 'delta_target_mean_loss': -.5})
    put(root, 'work/COMPLETE.json', {'status': 'stage1_epoch_completed', 'bindings': bound, 'training': result,
                                  'baseline': b0, 'final': b1, 'hop_deployment_ready': False})
    base, remainder = divmod(3291230, 5052)
    rows = [{'step': i, 'next_row_cursor': min(i*8, 40415), 'microbatches': 7 if i == 5052 else 8,
             'supervised_tokens': base + int(i <= remainder), 'target_mean_loss': 1.0,
             'gradient_norm_before_clip': .5, 'learning_rates': [.00001], 'elapsed_seconds': 2.0,
             'mode': 'train', 'private': PRIVATE} for i in range(1, 5053)]
    put(root, 'work/training/train.jsonl', b''.join(collector.canonical(r) + b'\n' for r in rows))
    segment = '20261009T010000Z-start-42'; path = 'work/collection/' + segment
    events = [{'event': event, 'action': 'start', 'segment_id': segment, 'utc': utc,
               'monotonic_seconds': time, 'exit_code': code, 'log_exit_code': code} for event, utc, time, code in (
                   ('start', '2026-10-09T01:00:00+00:00', 10, None), ('end', '2026-10-09T01:01:00+00:00', 70, 0))]
    put(root, path + '/events.jsonl', b''.join(collector.canonical(r) + b'\n' for r in events))
    put(root, path + '/gpu_monitor.stderr', b'')
    put(root, path + '/console.log', PRIVATE.encode())
    csv = 'timestamp, index, uuid, memory.used [MiB], memory.total [MiB], utilization.gpu [%], temperature.gpu, power.draw [W]\n'
    csv += ''.join('2026/10/09 01:00:00.000, ' + str(i) + ', ' + gpu + ', 20000 MiB, 24000 MiB, 99 %, 60, 200.0 W\n' for i, gpu in enumerate(collector.GPU_UUIDS))
    put(root, path + '/gpu_samples.csv', csv.encode())


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='dualgpu-collector-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        fixture(self.root)

    def ready(self):
        instance = collector.Collector(self.root)
        instance.verify_identity()
        return instance

    def test_complete_full_source_and_privacy_safe_zip(self):
        c = collector.Collector(self.root); s = c.collect()
        self.assertTrue(s['stage1_sft_completed'], s['verification_errors'])
        self.assertEqual(s['training']['cursor'], 40415)
        self.assertEqual(s['validation']['supervised_tokens'], 362003)
        self.assertEqual(s['train_log']['successful_path_step_wall_seconds'], 10104)
        self.assertEqual(s['measurements']['sampled_device_memory_max_mib_by_uuid'], dict.fromkeys(collector.GPU_UUIDS, 20000))
        output = c.write()
        with zipfile.ZipFile(output / 'presentation_results.zip') as z:
            self.assertIsNone(z.testzip())
            for name in z.namelist():
                self.assertNotIn(PRIVATE.encode(), z.read(name), name)
                self.assertFalse(name.endswith(('.pt', '.safetensors', 'console.log', '/RUN.json', '/qualification.json')))

    def test_checkpoint_tamper_cannot_complete(self):
        put(self.root, 'work/training/checkpoints/step-000005052/training_state.pt', b'changed')
        summary = collector.Collector(self.root).collect()
        self.assertFalse(summary['stage1_sft_completed'])
        self.assertIn('training', [e['section'] for e in summary['verification_errors']])

    def test_source_hash_and_partial_epoch_rejected(self):
        result = read(self.root, 'work/training/TRAINING_RESULT.json')
        result['completed_optimizer_steps'] = 5051
        put(self.root, 'work/training/TRAINING_RESULT.json', result)
        summary = collector.Collector(self.root).collect()
        self.assertFalse(summary['stage1_sft_completed'])
        self.assertIn('training', [e['section'] for e in summary['verification_errors']])
        put(self.root, 'data/train.jsonl.gz', b'changed')
        with self.assertRaises(ValueError): self.ready()
        self.assertFalse(collector.Collector(self.root).collect()['stage1_sft_completed'])

    def test_validation_denominator_and_tiled_tolerance_rejected(self):
        value = read(self.root, 'work/validation_B1.json'); value['evaluation']['rows'] = 1724
        put(self.root, 'work/validation_B1.json', value)
        with self.assertRaises(ValueError): self.ready().verify_validation()
        q = read(self.root, 'work/qualification.json')
        tiled = next(c['evidence'] for c in q['checks'] if c['name'] == 'tiled_mlp_equivalence')
        tiled['modules'][0]['metrics']['output']['relative_l2_error'] = .5
        put(self.root, 'work/qualification.json', q)
        with self.assertRaises(ValueError): self.ready().verify_qualification()

    def test_changed_config_cannot_reuse_previous_run_bindings(self):
        config = read(self.root, 'config/train.json')
        config['max_length'] = 65536
        path = put(self.root, 'config/train.json', config)
        manifest = read(self.root, 'MANIFEST.json')
        manifest['files']['config/train.json'] = {'bytes': path.stat().st_size, 'sha256': sha(path)}
        put(self.root, 'MANIFEST.json', manifest)
        with self.assertRaises(ValueError): self.ready().verify_training()

    def test_canary_requires_longest_context_each_step_and_both_gpu_peaks(self):
        gate = read(self.root, 'work/canary_gate.json')
        original = copy.deepcopy(gate)
        gate['checks'][-1]['evidence']['max_sequence_length_each_step'][-1] = 100
        put(self.root, 'work/canary_gate.json', gate)
        with self.assertRaises(ValueError): self.ready().verify_canary()
        execution = read(self.root, 'work/canary_execution.json'); execution['gpu_peaks'].pop()
        path = put(self.root, 'work/canary_execution.json', execution)
        original['artifacts']['canary_execution.json'] = sha(path)
        put(self.root, 'work/canary_gate.json', original)
        with self.assertRaises(ValueError): self.ready().verify_canary()

    def test_missing_step_and_duplicate_attribution(self):
        path = self.root / 'work/training/train.jsonl'; data = path.read_bytes()
        path.write_bytes(b'\n'.join(data.splitlines()[:-1]) + b'\n')
        with self.assertRaises(ValueError): self.ready().collect_train_log()
        path.write_bytes(data + data.splitlines(keepends=True)[0])
        value = self.ready().collect_train_log()
        self.assertEqual(value['duplicate_extra_records'], 1)
        self.assertIsNone(value['successful_path_step_wall_seconds'])
        self.assertIsNone(value['retry_logged_step_wall_seconds'])

    def test_missing_final_wrapper_end_cannot_complete(self):
        path = self.root / 'work/collection/20261009T010000Z-start-42/events.jsonl'
        path.write_bytes(path.read_bytes().splitlines(keepends=True)[0])
        summary = collector.Collector(self.root).collect()
        self.assertFalse(summary['stage1_sft_completed'])
        self.assertIn('command_completion', [e['section'] for e in summary['verification_errors']])

    def test_incomplete_cli_requires_explicit_flag_and_remains_incomplete(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(collector.main(['--kit', str(root)]), 2)
            self.assertFalse((root / 'work').exists())
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(collector.main(['--kit', str(root), '--allow-incomplete']), 0)
            result = json.loads(output.getvalue())
            self.assertFalse(result['stage1_sft_completed'])
            summary = read(Path(result['output_directory']), 'summary.json')
            self.assertEqual(summary['status'], 'incomplete_or_unverified')
            self.assertFalse(summary['hop_deployment_ready'])


if __name__ == '__main__':
    unittest.main()
