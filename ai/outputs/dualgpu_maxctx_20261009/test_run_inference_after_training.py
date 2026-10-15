"""CPU-only gate/ordering regressions. All probe and GPU invocations are mocked."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

DIRECTORY = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load('inference_after_training', DIRECTORY / 'run_inference_after_training.py')
fixtures = load('collector_fixtures', DIRECTORY / 'test_collect_results.py')


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


class GateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        (self.root / 'scripts').mkdir()
        for name in ('collect_results.py', 'capacity_probe_v6.py'):
            shutil.copyfile(DIRECTORY / name, self.root / 'scripts' / name)
        self.subject = runner.Runner(self.root, sys.executable)

    def test_full_actual_fixture_fresh_collector_archive_and_race(self):
        fixtures.fixture(self.subject.kit)
        with mock.patch.object(runner.subprocess, 'Popen', wraps=subprocess.Popen) as popen:
            self.subject.verify_training()
        self.assertTrue(self.subject.state['training_gate_passed'])
        self.assertEqual(len(popen.call_args_list), 1)
        command = popen.call_args_list[0].args[0]
        self.assertNotIn('--allow-incomplete', command)
        self.assertEqual(Path(command[2]).name, 'collect_results.py')
        gate = self.subject.state['training_gate']
        self.assertEqual((gate['optimizer_steps'], gate['training_rows'], gate['validation_rows']), (5052, 40415, 4298))
        self.assertTrue((Path(gate['result_directory']) / 'presentation_results.zip').is_file())
        with (self.subject.kit / 'work/validation_B1.json').open('a') as handle:
            handle.write(' ')
        with mock.patch.object(runner.subprocess, 'check_output') as query, mock.patch.object(runner.subprocess, 'Popen') as probe:
            with self.assertRaisesRegex(RuntimeError, 'changed'):
                self.subject.measure('must-refuse', 8192, 64, 4096, True)
        query.assert_not_called()
        probe.assert_not_called()

    def test_forged_complete_cannot_bypass_actual_checkpoint_hash(self):
        fixtures.fixture(self.subject.kit)
        checkpoint = self.subject.kit / 'work/training/checkpoints/step-000005052/adapter_model.safetensors'
        checkpoint.write_bytes(b'changed weights')
        runner.candidate(self.subject.kit)  # Marker still looks complete.
        with mock.patch.object(runner.subprocess, 'check_output') as query:
            with self.assertRaisesRegex(RuntimeError, 'Fresh strict final collection failed'):
                self.subject.verify_training()
        self.assertFalse(self.subject.state['training_gate_passed'])
        query.assert_not_called()

    def test_complete_marker_waits_for_wrapper_and_monitor_shutdown(self):
        fixtures.fixture(self.subject.kit)
        path = self.subject.kit / 'work/collection/20261009T010000Z-start-42/events.jsonl'
        events = [json.loads(line) for line in path.read_text().splitlines()]
        path.write_text(json.dumps(events[0]) + '\n')
        with self.assertRaisesRegex(RuntimeError, 'not ended'):
            runner.candidate(self.subject.kit)
        events[1]['utc'] = runner.utc().isoformat()
        path.write_text(''.join(json.dumps(event) + '\n' for event in events))
        with self.assertRaisesRegex(RuntimeError, 'settle'):
            runner.candidate(self.subject.kit)

    def test_existing_complete_report_is_rejected_even_with_success_exit(self):
        old = self.subject.kit / 'work/collection/results-20261009T000000Z-aaaaaaaa'
        old.mkdir(parents=True)
        receipt = {'status': 'verified_complete', 'stage1_sft_completed': True,
                   'hop_deployment_ready': False, 'output_directory': str(old)}
        completed = subprocess.CompletedProcess([], 0, json.dumps(receipt), '')
        with mock.patch.object(runner, 'candidate', return_value={}), mock.patch.object(runner.subprocess, 'run', return_value=completed):
            with self.assertRaisesRegex(RuntimeError, 'old or unrelated'):
                self.subject.verify_training()
        self.assertFalse(self.subject.state['training_gate_passed'])

    def test_allow_incomplete_success_receipt_is_rejected(self):
        completed = subprocess.CompletedProcess([], 0, json.dumps({'status': 'incomplete_or_unverified',
                                                   'stage1_sft_completed': False}), '')
        with mock.patch.object(runner, 'candidate', return_value={}), mock.patch.object(runner.subprocess, 'run', return_value=completed):
            with self.assertRaisesRegex(RuntimeError, 'did not attest'):
                self.subject.verify_training()
        self.assertFalse(self.subject.state['training_gate_passed'])

    def test_missing_completion_waits_without_gpu_work(self):
        with mock.patch.object(runner.subprocess, 'check_output') as query, mock.patch.object(runner.subprocess, 'Popen') as probe:
            with self.assertRaisesRegex(RuntimeError, 'not available'):
                self.subject.wait_for_candidate(1, 0, check_only=True)
            with self.assertRaisesRegex(RuntimeError, 'gate has not passed'):
                self.subject.measure('forbidden', 8192, 64, 4096, True)
        query.assert_not_called()
        probe.assert_not_called()

    def test_wait_continues_until_candidate_and_does_not_query_gpu(self):
        with mock.patch.object(runner, 'candidate', side_effect=[FileNotFoundError(), {}]), \
                mock.patch.object(runner.time, 'sleep') as sleep, mock.patch.object(runner.subprocess, 'check_output') as query:
            self.subject.wait_for_candidate(10, 0)
        sleep.assert_called_once_with(10)
        query.assert_not_called()

    def test_busy_gpu_prevents_probe_launch(self):
        self.subject.state['training_gate_passed'] = True
        with mock.patch.object(runner.subprocess, 'check_output', return_value=runner.GPU_UUIDS[1] + ', 1234\n'), \
                mock.patch.object(runner.subprocess, 'Popen') as probe:
            with self.assertRaisesRegex(RuntimeError, 'compute owner'):
                self.subject.measure('busy', 8192, 64, 4096, True)
        probe.assert_not_called()

    def test_new_runs_never_overwrite_prior_pipeline_evidence(self):
        old = self.root / 'work/collection/inference_capacity_pipeline.json'
        old.write_text('preserve old deferred evidence')
        other = runner.Runner(self.root, sys.executable)
        self.assertNotEqual(self.subject.directory, other.directory)
        self.assertEqual(old.read_text(), 'preserve old deferred evidence')

    def test_v6_child_command_and_both_gpu_lock_evidence(self):
        self.subject.state['training_gate_passed'] = True
        arguments = {'mode': 'inference', 'length': 8192, 'new_tokens': 64, 'force_budget': True,
                     'layer_split': 32, 'prefill_chunk_size': 4096, 'verify_prefill_parity': True}
        result = {'schema_version': 'malssi.dualgpu-capacity-probe.v6', 'status': 'passed',
                  'script_sha256': self.subject.scripts[self.subject.probe]['sha256'],
                  'gpu_uuids': list(runner.GPU_UUIDS), 'arguments': arguments,
                  'actual_input_tokens': 8192, 'actual_generated_tokens': 64, 'actual_total_tokens': 8256}
        calls = []
        def spawn(command, **kwargs):
            calls.append(command)
            path = self.root / 'work/probes/fresh-probe'
            put(path / 'result.json', result)
            (path / 'events.log').write_text(json.dumps({'event': 'both_gpu_locks_acquired'}) + '\n')
            return mock.Mock(pid=999, wait=mock.Mock(return_value=0))
        with mock.patch.object(runner.subprocess, 'check_output', return_value=''), \
                mock.patch.object(runner.subprocess, 'Popen', side_effect=spawn):
            observed = self.subject.measure('parity', 8192, 64, 4096, True)
        self.assertEqual(observed, result)
        self.assertEqual(calls[0], [sys.executable, '-B', str(self.subject.probe), '--mode', 'inference',
                                   '--length', '8192', '--new-tokens', '64', '--force-budget', '--layer-split', '32',
                                   '--prefill-chunk-size', '4096', '--verify-prefill-parity'])

    def test_v6_search_preserves_parity_then_chunk_ladder_then_output(self):
        results = [{'status': status} for status in ('passed', 'failed', 'failed', 'passed', 'passed')]
        with mock.patch.object(self.subject, 'measure', side_effect=results) as measure:
            self.subject.search()
        self.assertEqual(measure.call_args_list, [
            mock.call('inference-parity-8192-plus64', 8192, 64, 4096, parity=True),
            mock.call('inference-max-input-chunk4096', 262143, 1, 4096),
            mock.call('inference-max-input-chunk2048', 262143, 1, 2048),
            mock.call('inference-max-input-chunk1024', 262143, 1, 1024),
            mock.call('inference-max-output-from2', 2, 262142, 1024)])
        self.assertTrue(self.subject.state['maximum_input_measured'])
        self.assertTrue(self.subject.state['maximum_output_measured'])

    def test_check_only_never_queries_or_launches_probes(self):
        with mock.patch.object(runner, 'Runner', return_value=self.subject), \
                mock.patch.object(self.subject, 'wait_for_candidate'), mock.patch.object(self.subject, 'verify_training'), \
                mock.patch.object(self.subject, 'search') as search, \
                mock.patch.object(runner.subprocess, 'check_output') as query, contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(runner.main(['--check-only']), 0)
        search.assert_not_called()
        query.assert_not_called()
        self.assertEqual(self.subject.state['status'], 'gate_passed')

    def test_cli_rejects_invalid_poll_and_timeout(self):
        for arguments in (['--poll-seconds', '0'], ['--poll-seconds', '61'], ['--poll-seconds', 'nan'],
                          ['--wait-timeout', '-1'], ['--wait-timeout', 'inf']):
            with self.subTest(arguments=arguments), contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    runner.arguments(arguments)


if __name__ == '__main__':
    unittest.main()
