import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import report_gpu31b_evaluation as report
from test_gpu31b_eval_bridge import ready as bridge_ready, payload


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True); path.write_text(json.dumps(value) + '\n')


def proof_fixture(root, wrong_flags=False):
    ready = bridge_ready()
    ready.update(base_files={'weights.safetensors': {'sha256': '1' * 64}}, tokenizer_files={'tokenizer.json': {'sha256': '2' * 64}},
        adapter_module_count=1, adapter_disable_qualification={'status': 'passed', 'disabled_matches_zero_scaling': True, 'enabled_has_measurable_effect': True},
        actual_weight_identity={'base_files_verified_by_preflight': True, 'adapter_parameters_sha256': ready['adapter_tensor_digest']},
        loader_config={'model_revision': '8e256fc6d63003fc0ca8c91b976e6dcc38433385'},
        checkpoint='/home/slim/choieram/model_Training/cards/training/checkpoints/02_card_generation-e001-s000004723', base_loading='checkpoint-bound NF4')
    ready['base_manifest_sha256'] = report.digest(ready['base_files'])
    ready['tokenizer_manifest_sha256'] = report.digest(ready['tokenizer_files'])
    bridge = root / 'bridge'; bridge.mkdir(parents=True)
    write(bridge / 'worker-ready.json', ready)
    request = payload(0)
    evidence = {'lora_scale': 0, 'request_seed': 3407, 'temperature': 0, 'do_sample': False,
        'input_truncated': False, 'fresh_input_cache_per_request': True,
        'adapter_flags_before': {'layer': False}, 'adapter_flags_after': {'layer': False},
        'adapter_flags_during': {'layer': False if wrong_flags else True},
        'adapter_digest_before': ready['adapter_tensor_digest'], 'adapter_digest_after': ready['adapter_tensor_digest']}
    response = {'id': 1, 'response': {'choices': [{'message': {'content': '{}'}}], 'evidence': evidence}}
    (bridge / 'worker-stdin.jsonl').write_text(json.dumps({'id': 1, 'payload': request}) + '\n')
    (bridge / 'worker-stdout.jsonl').write_text(json.dumps(ready) + '\n' + json.dumps(response) + '\n')
    headers = {'X-Evaluation-Worker-Response-ID': '1', 'X-Evaluation-Worker-Reply-SHA256': report.digest(response)}
    return ready, request, headers, json.dumps(response['response']).encode()


def gpu_fixture(root, other_compute='', extra_memory=0):
    closed = {'worker_close_verified': True, 'worker_closed_received': True,
              'worker_closed': {'status': 'passed', 'adapter_unchanged': True}}
    supervisor = {'owned_worker_absent': True, 'status': 'completed', 'returncode': 0, 'worker_pid': 123,
        'gpu_before': '0, GPU-a, 10, 0\n1, GPU-b, 20, 0\n',
        'gpu_after': f'0, GPU-a, {10 + extra_memory}, 0\n1, GPU-b, 20, 0\n', 'compute_after': other_compute}
    write(root / 'gpu-return.json', {'worker_absent': True, 'supervisor': supervisor, 'verified_closed': closed,
                                   'other_processes_stopped': False, 'gpu_reset_used': False})
    write(root / 'REMOTE_RESULTS.json', {'SUPERVISOR_RESULT.json': supervisor,
        'work/worker-v1/WORKER_RESULT.json': {'status': 'passed', 'adapter_unchanged': True, 'checkpoint_unchanged': True}})


class GPUReportTests(unittest.TestCase):
    def test_real_worker_manifest_reply_and_scale_proof_without_local_gguf(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); ready, request, headers, raw = proof_fixture(root)
            proof = report.WorkerProof(root)
            proof.verify_metadata({'remote_model_identity': proof.normalized,
                                   'training_base_revision': ready['loader_config']['model_revision']})
            proof.verify_http(request, headers, raw, 'output_received')
            self.assertEqual(proof.linked, 1); self.assertEqual(proof.generation_proofs, 1)
            self.assertEqual(proof.normalized['base_model_digest']['kind'], 'remote_directory_manifest_sha256')
            with self.assertRaisesRegex(ValueError, 'replay'): proof.verify_http(request, headers, raw, 'output_received')

    def test_actual_disable_flags_cannot_be_replaced_by_requested_scale(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); _, request, headers, raw = proof_fixture(root, wrong_flags=True)
            with self.assertRaisesRegex(ValueError, 'Actual LoRA layer flags'):
                report.WorkerProof(root).verify_http(request, headers, raw, 'output_received')

    def test_worker_envelope_hash_and_input_binding_reject_tampering(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); _, request, headers, raw = proof_fixture(root)
            changed = dict(headers); changed['X-Evaluation-Worker-Reply-SHA256'] = '0' * 64
            with self.assertRaisesRegex(ValueError, 'envelope hash'):
                report.WorkerProof(root).verify_http(request, changed, raw, 'output_received')
            request['messages'] = [{'role': 'user', 'content': 'changed'}]
            with self.assertRaisesRegex(ValueError, 'Worker input'):
                report.WorkerProof(root).verify_http(request, headers, raw, 'output_received')

    def test_fixed_panel_cannot_complete_from_unlinked_503s(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); _, request, _, _ = proof_fixture(root)
            proof = report.WorkerProof(root)
            with self.assertRaisesRegex(ValueError, 'Infrastructure outcome'):
                proof.verify_http(request, {}, b'{"error":{"code":"worker_transport_failure"}}', 'failed', require_worker_reply=True)
            self.assertEqual(proof.linked, 0)

    def test_gpu_memory_return_and_checkpoint_binding(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); gpu_fixture(root)
            result = report.verify_gpu_return(root)
            self.assertTrue(result['gpu_return_verified']); self.assertEqual(len(result['per_gpu']), 2)
            gpu_fixture(root, extra_memory=65)
            with self.assertRaisesRegex(ValueError, 'baseline plus64MiB'): report.verify_gpu_return(root)
            gpu_fixture(root, other_compute='999\n', extra_memory=10000)
            result = report.verify_gpu_return(root)
            self.assertFalse(result['gpu_return_verified']); self.assertTrue(result['owned_worker_absent'])
            self.assertEqual(result['memory_attribution'], 'unverified_other_compute_present')

    def test_reaggregation_runs_both_frozen_graders_and_compares_actual_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); source = root / 'frozen-source/ai/scripts'; source.mkdir(parents=True)
            (source / 'controlled_auto_panel.py').write_text('mock scorer')
            (source / 'summarize_paired_role_evaluation.mjs').write_text('mock formatter')
            run = root / 'fixed-run'; run.mkdir()
            for name in ('assignments.jsonl', 'outputs.jsonl', 'attempts.jsonl', 'metadata.json'):
                (run / name).write_text('{}\n')
            for name in ('format-metrics.json', 'controlled-metrics.json'): (run / name).write_text('{"fixed":true}\n')
            commands = []
            def execute(command, **kwargs):
                commands.append(command)
                target = Path(command[2]) if command[0] == 'node' else Path(command[command.index('--run') + 1])
                name = 'format-metrics.json' if command[0] == 'node' else 'controlled-metrics.json'
                (target / name).write_text('{"fixed":true}\n')
                return type('Result', (), {'returncode': 0})()
            panel = {'scorer_sha256': report.sha((source / 'controlled_auto_panel.py').read_bytes())}
            with patch.object(report.subprocess, 'run', side_effect=execute):
                result = report.reaggregate_metrics(root, panel)
            self.assertEqual(len(commands), 2)
            self.assertTrue(result['format_reaggregation_identical'] and result['semantic_reaggregation_identical'])
            (run / 'controlled-metrics.json').write_text('changed')
            with patch.object(report.subprocess, 'run', side_effect=execute):
                with self.assertRaisesRegex(ValueError, 'differs'): report.reaggregate_metrics(root, panel)


if __name__ == '__main__': unittest.main()
