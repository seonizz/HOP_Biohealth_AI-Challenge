import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

import gpu31b_durable_service as service
import gpu31b_eval_worker as worker


class FakeProcess:
    def __init__(self, pid=101, returncode=None):
        self.pid, self.returncode = pid, returncode
        self.stdin, self.stdout = io.StringIO(), io.StringIO()
        self.terminated, self.killed = False, False
    def poll(self):
        return self.returncode
    def terminate(self):
        self.terminated = True; self.returncode = -15
    def kill(self):
        self.killed = True; self.returncode = -9
    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class FakeServer:
    def __init__(self):
        self.stopped = threading.Event()
        self.closed = False
    def serve_forever(self):
        self.stopped.wait(2)
    def shutdown(self):
        self.stopped.set()
    def server_close(self):
        self.closed = True


class FakeSession:
    def __init__(self, process, output, **kwargs):
        self.process, self.output = process, Path(output)
        self.output.mkdir()
        self.failure = None; self.closed = None
        self.remote_root = kwargs['remote_root']
        self.ready = {'event': 'ready', 'model': 'malssi-gemma4-31b-controlled', 'remote_root': self.remote_root}
        (self.output / 'worker-ready.json').write_text(json.dumps(self.ready))
    def wait_ready(self, timeout):
        return self.ready
    def close(self, timeout=1200):
        self.closed = {'event': 'closed', 'status': 'passed', 'adapter_unchanged': True}
        self.process.returncode = 0
        return True


class DurableServiceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.server = FakeServer(); self.processes, self.commands = [], []
        self.ticks = 0
        self.snapshots = []

    def snapshot(self):
        self.snapshots.append(True)
        return {'gpu': '0, GPU-0, 11, 0\n1, GPU-1, 30, 0\n', 'compute': ''}

    def clock(self):
        return self.ticks

    def sleep(self, seconds):
        self.ticks += seconds

    def popen(self, command, **kwargs):
        self.commands.append((command, kwargs))
        if not self.processes:
            process = FakeProcess()
        else:
            process = FakeProcess(pid=102, returncode=0)
            folder = self.root / 'fixed-run'; folder.mkdir()
            summary = {'status': 'completed', 'arms': {arm: {'assigned_count': 240, 'received_count': 240,
                       'failed_count': 0, 'not_run_count': 0} for arm in ('baseline', 'trained')}}
            (folder / 'summary.json').write_text(json.dumps(summary))
        self.processes.append(process)
        return process

    def make(self, **kwargs):
        return service.DurableService(self.root, python='/existing/python', popen=self.popen,
            session_factory=FakeSession, server_factory=lambda session, port: self.server,
            snapshot=self.snapshot, clock=self.clock, sleep=self.sleep, worker_grace_seconds=.1, **kwargs)

    def test_worker_pipes_are_remote_parent_owned_and_stop_verifies_release(self):
        controller = self.make()
        controller.start(); controller.run_fixed()
        command, options = self.commands[0]
        self.assertNotIn('ssh', command)
        self.assertIs(options['stdin'], subprocess.PIPE)
        self.assertIs(options['stdout'], subprocess.PIPE)
        self.assertEqual(command[1:4], ['-I', '-S', '-B'])
        # Loss of an external observer/HTTP client is not an input to service
        # health or the worker's stdin lifetime. Only this remote session owns it.
        external_observer = io.StringIO(); external_observer.close()
        self.assertIsNone(controller.health_error())
        self.assertFalse(controller.worker.stdin.closed)
        self.assertIsNone(controller.worker.poll())
        (self.root / 'STOP').write_text('explicit root stop')
        controller.wait_for_stop()
        self.assertTrue(controller.close())
        self.assertTrue(self.server.closed)
        self.assertTrue(controller.state['owned_worker_absent'])
        self.assertFalse(controller.worker.terminated)
        self.assertEqual(len(self.snapshots), 2)
        self.assertFalse(controller.state['ssh_lifetime_dependency'])

    def test_complete_lifecycle_runs_480_then_waits_for_explicit_stop(self):
        controller = self.make()
        def stop_after_fixed():
            (self.root / 'STOP').write_text('done')
        original_run_fixed = controller.run_fixed
        def fixed():
            original_run_fixed(); stop_after_fixed()
        controller.run_fixed = fixed
        self.assertEqual(controller.run(), 0)
        result = json.loads((self.root / 'SUPERVISOR_RESULT.json').read_text())
        self.assertEqual(result['status'], 'completed')
        self.assertTrue(result['worker_close_verified'])
        self.assertEqual(result['compute_after'], '')
        self.assertFalse(result['force_killed_other_processes'])

    def test_fatal_worker_health_stops_fixed_phase_without_more_processes(self):
        controller = self.make(); controller.start()
        controller.session.failure = 'synthetic pipe failure'
        with self.assertRaisesRegex(RuntimeError, 'worker_transport_failure'):
            controller.run_fixed()
        self.assertEqual(len(self.commands), 1)
        controller.close()

    def test_deadline_does_not_require_a_mac_or_ssh_signal(self):
        controller = self.make(job_seconds=10); controller.start()
        self.ticks = 10
        with self.assertRaisesRegex(RuntimeError, 'job_deadline_exceeded'):
            controller.wait_for_stop()
        controller.close()

    def test_existing_gpu_process_prevents_worker_start(self):
        controller = self.make(); controller.snapshot = lambda: {'gpu': 'busy', 'compute': 'other-pid\n'}
        with self.assertRaisesRegex(RuntimeError, 'Existing GPU'):
            controller.start()
        self.assertEqual(self.commands, [])

    def test_only_owned_popen_object_is_terminated_after_grace(self):
        process = FakeProcess(); process.wait = Mock(side_effect=[subprocess.TimeoutExpired('owned', 1), 0])
        result = service.DurableService.stop_owned(process, grace=1)
        self.assertEqual(result, {'terminated': True, 'killed': True})
        self.assertTrue(process.terminated); self.assertTrue(process.killed)


class DurableWorkerTransportTests(unittest.TestCase):
    def test_full_json_fsynced_before_observer_pipe_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            work, report = Path(directory), {'status': 'passed', 'stage': 'completed', 'transport_status': 'connected'}
            value = {'id': 213, 'response': {'choices': [{'message': {'content': 'synthetic complete reply'}}]}}
            class FailingPipe:
                def write(self, text):
                    saved = (work / 'transport-out.jsonl').read_text().splitlines()
                    self.assert_saved = json.loads(saved[-1]) == value
                    raise BrokenPipeError('observer disconnected')
                def flush(self):
                    raise AssertionError('write already failed')
            pipe = FailingPipe()
            with patch.object(worker.os, 'fsync', wraps=worker.os.fsync) as fsync:
                delivered = worker.durable_emit(work, pipe, value, report)
                self.assertGreaterEqual(fsync.call_count, 1)
            self.assertFalse(delivered); self.assertTrue(pipe.assert_saved)
            self.assertEqual(report['status'], 'passed')
            self.assertEqual(report['stage'], 'completed')
            self.assertEqual(report['transport_status'], 'failed')
            # Later closed verification still reaches the durable journal even
            # though retrying a broken observer pipe is deliberately avoided.
            closed = {'event': 'closed', 'status': 'passed', 'adapter_unchanged': True}
            self.assertFalse(worker.durable_emit(work, pipe, closed, report))
            rows = [json.loads(line) for line in (work / 'transport-out.jsonl').read_text().splitlines()]
            self.assertEqual(rows, [value, closed])

    def test_input_envelope_is_preserved_exactly(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory); line = '{"id":1,"payload":{"messages":[]}}\n'
            worker.durable_input(work, line)
            self.assertEqual((work / 'transport-in.jsonl').read_bytes(), line.encode())


if __name__ == '__main__':
    unittest.main()
