#!/usr/bin/env python3
"""Remote-local owner of the R2 worker, HTTP bridge, and fixed 480 assignments.

Detach this controller on the server with stdin=/dev/null and logs inside ROOT.
SSH is never a worker pipe or a lifetime dependency. No Node/package installation
is needed: the optional twelve-case Node flow remains an external HTTP client.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

# -I does not add the script directory to sys.path. Only bound task code is used.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from gpu31b_eval_bridge import WorkerSession, make_server

ROOT = Path('/home/slim/choieram/model_Training/gpu31b_controlled_20261112_v13_r2')
PYTHON = Path('/home/slim/choieram/malssi-validation-20261009/.venv/bin/python')
PORT = 18342
JOB_SECONDS = 12 * 60 * 60
WORKER_GRACE_SECONDS = 1200


def stamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    with temporary.open('w') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
    temporary.replace(path)


def read_json(path):
    return json.loads(path.read_text())


def gpu_snapshot():
    return {
        'gpu': subprocess.check_output(['nvidia-smi', '--query-gpu=index,uuid,memory.used,utilization.gpu',
                                        '--format=csv,noheader,nounits'], text=True),
        'compute': subprocess.check_output(['nvidia-smi', '--query-compute-apps=pid',
                                            '--format=csv,noheader,nounits'], text=True)}


def code_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_controller_scope(root):
    if root != ROOT or root.resolve(strict=True) != root:
        raise ValueError('Only the canonical new R2 evaluation root is supported')
    for path in (root, root / 'code', root / 'panel', root / 'work/worker-v1'):
        for parent in (path, *path.parents):
            if parent == Path('/home/slim'):
                break
            if parent.is_symlink():
                raise ValueError('Controller paths must not traverse symlinks')
        if not path.is_dir() or path.stat().st_uid != os.getuid():
            raise ValueError('Expected owned task directories')
    if list((root / 'work/worker-v1').iterdir()):
        raise ValueError('Worker directory must be precreated and empty')
    if (root / 'SUPERVISOR_RESULT.json').exists() or (root / 'fixed-run').exists() or (root / 'bridge').exists():
        raise ValueError('Use a fresh controller/result directory')
    sources = read_json(root / 'SOURCE_SHA256.json')
    required = {'gpu31b_durable_service.py', 'gpu31b_eval_worker.py', 'gpu31b_eval_bootstrap.py',
                'gpu31b_eval_bridge.py', 'gpu31b_request_control.py', 'run_gpu31b_paired_evaluation.py', 'boundary.py', 'speed_reference.py'}
    if not required.issubset(sources):
        raise ValueError('Missing controller/worker source binding')
    for name, expected in sources.items():
        source = root / 'code' / name
        if Path(name).name != name or source.resolve(strict=True) != source or source.stat().st_nlink != 1 or code_hash(source) != expected:
            raise ValueError('Task source binding mismatch')
    return sources


class DurableService:
    def __init__(self, root, *, python=PYTHON, port=PORT, job_seconds=JOB_SECONDS,
                 popen=subprocess.Popen, session_factory=WorkerSession, server_factory=make_server,
                 snapshot=gpu_snapshot, clock=time.monotonic, sleep=time.sleep,
                 worker_grace_seconds=WORKER_GRACE_SECONDS):
        self.root, self.python, self.port = Path(root), str(python), port
        self.job_seconds, self.worker_grace_seconds = job_seconds, worker_grace_seconds
        self.popen, self.session_factory, self.server_factory = popen, session_factory, server_factory
        self.snapshot, self.clock, self.sleep = snapshot, clock, sleep
        self.stop_requested = threading.Event()
        self.worker = self.collector = self.session = self.server = self.http_thread = None
        self.deadline = None
        self.worker_stderr = self.collector_log = None
        self.state = {'schema': 'controlled31b-durable-supervisor-v1', 'root': str(self.root),
                      'supervisor_pid': os.getpid(), 'started_at': stamp(), 'status': 'starting',
                      'worker_stdio_owner': 'remote_controller', 'ssh_lifetime_dependency': False,
                      'fixed_assigned': 480, 'full_flow_assigned_to_external_client': 12,
                      'force_killed_other_processes': False}

    def status(self, phase, **extra):
        self.state.update(phase=phase, updated_at=stamp(), **extra)
        write_json(self.root / 'SUPERVISOR_RESULT.json', self.state)
        view = {'status': self.state['status'], 'phase': phase, 'updated_at': self.state['updated_at'],
                'model': '31B', 'checkpoint_step': 4723, 'fixed_assigned': 480,
                'full_flow_assigned': 12, 'worker_pid': self.state.get('worker_pid'),
                'ssh_lifetime_dependency': False}
        summary_path = self.root / 'fixed-run/summary.json'
        if summary_path.exists():
            summary = read_json(summary_path)
            view['fixed_summary'] = summary
        view.update(extra)
        write_json(self.root / 'STATUS.json', view)

    def health_error(self):
        if self.session is not None and self.session.failure:
            return 'worker_transport_failure: ' + str(self.session.failure)
        if self.worker is not None and self.worker.poll() is not None:
            return 'resident_worker_exited: ' + str(self.worker.returncode)
        if self.session is not None and self.session.closed is not None:
            return 'resident_worker_closed_before_STOP'
        return None

    def stopping(self):
        if self.stop_requested.is_set() or (self.root / 'STOP').exists():
            return 'explicit_stop'
        if self.clock() >= self.deadline:
            return 'job_deadline_exceeded'
        return None

    def start(self):
        self.deadline = self.clock() + self.job_seconds
        before = self.snapshot()
        if before['compute'].strip():
            raise RuntimeError('Existing GPU compute process found; no worker started')
        self.state.update(gpu_before=before['gpu'], compute_before=before['compute'])
        self.status('loading_and_qualifying_31b', status='running')
        self.worker_stderr = (self.root / 'worker.stderr.log').open('x')
        command = [self.python, '-I', '-S', '-B', str(self.root / 'code/gpu31b_eval_bootstrap.py'),
                   '--work', 'work/worker-v1']
        self.worker = self.popen(command, cwd=self.root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=self.worker_stderr, text=True, bufsize=1)
        self.state.update(worker_pid=self.worker.pid, worker_command=command)
        self.status('loading_and_qualifying_31b')
        self.session = self.session_factory(self.worker, self.root / 'bridge',
                                            remote_root=str(self.root), request_timeout=1020)
        ready = self.session.wait_ready(min(900, self.job_seconds))
        self.server = self.server_factory(self.session, self.port)
        self.http_thread = threading.Thread(target=self.server.serve_forever, daemon=True,
                                             name='remote-local-evaluation-http')
        self.http_thread.start()
        write_json(self.root / 'bridge/bridge-ready.json',
                   {'ready_at': stamp(), 'port': self.port, 'remote_root': str(self.root),
                    'worker_ready_sha256': hashlib.sha256(json.dumps(ready, ensure_ascii=False, sort_keys=True,
                                                  separators=(',', ':'), allow_nan=False).encode()).hexdigest()})
        self.status('fixed_requests', port=self.port)

    def run_fixed(self):
        error = self.health_error()
        if error:
            raise RuntimeError(error)
        self.collector_log = (self.root / 'fixed-run.log').open('x')
        command = [self.python, '-I', '-S', '-B', str(self.root / 'code/run_gpu31b_paired_evaluation.py'),
                   '--suite-root', str(self.root / 'panel'), '--output', str(self.root / 'fixed-run'),
                   '--endpoint', f'http://127.0.0.1:{self.port}', '--worker-ready', str(self.root / 'bridge/worker-ready.json'),
                   '--max-tokens', '1024', '--timeout', '1100']
        # -I omits the script directory; collector imports its stdlib-only sibling.
        # A tiny runpy wrapper establishes just this bound task code directory.
        launcher = ('import runpy,sys;sys.path.insert(0,' + repr(str(self.root / 'code')) + ');'
                    'sys.argv=' + repr(command[4:]) + ';runpy.run_path(sys.argv[0],run_name="__main__")')
        command = [self.python, '-I', '-S', '-B', '-c', launcher]
        self.collector = self.popen(command, cwd=self.root, stdin=subprocess.DEVNULL,
                                   stdout=self.collector_log, stderr=subprocess.STDOUT)
        self.state.update(collector_pid=self.collector.pid, collector_command=command)
        self.status('fixed_requests')
        last_status = self.clock()
        while self.collector.poll() is None:
            error, stop = self.health_error(), self.stopping()
            if error:
                raise RuntimeError(error)
            if stop:
                raise RuntimeError(stop)
            if self.clock() - last_status >= 10:
                self.status('fixed_requests'); last_status = self.clock()
            self.sleep(1)
        if self.collector.returncode != 0:
            raise RuntimeError('Fixed collector exited with status ' + str(self.collector.returncode))
        summary = read_json(self.root / 'fixed-run/summary.json')
        arms = summary.get('arms', {})
        if summary.get('status') != 'completed' or set(arms) != {'baseline', 'trained'}:
            raise RuntimeError('Fixed collector did not complete the declared assignment inventory')
        if any(arm.get('assigned_count') != 240 or arm.get('not_run_count') != 0
               or arm.get('received_count', 0) + arm.get('failed_count', 0) != 240 for arm in arms.values()):
            raise RuntimeError('Fixed assignment counts do not reconcile')
        self.status('awaiting_full_flow', fixed_complete=True)

    def wait_for_stop(self):
        last_status = self.clock()
        while True:
            error = self.health_error()
            if error:
                raise RuntimeError(error)
            stop = self.stopping()
            if stop:
                self.state['stop_reason'] = stop
                if stop == 'job_deadline_exceeded':
                    raise RuntimeError(stop)
                return
            if self.clock() - last_status >= 10:
                self.status('awaiting_full_flow', fixed_complete=True); last_status = self.clock()
            self.sleep(1)

    @staticmethod
    def stop_owned(process, grace=30):
        if process is None or process.poll() is not None:
            return {'terminated': False, 'killed': False}
        process.terminate()
        try:
            process.wait(timeout=grace)
            return {'terminated': True, 'killed': False}
        except subprocess.TimeoutExpired:
            process.kill(); process.wait(timeout=30)
            return {'terminated': True, 'killed': True}

    def close(self):
        if self.collector is not None and self.collector.poll() is None:
            self.state['collector_stop'] = self.stop_owned(self.collector)
        if self.server is not None:
            self.server.shutdown(); self.server.server_close()
        verified = False
        if self.session is not None:
            result, failure = [], []
            def graceful_close():
                try:
                    already_exited = self.worker is not None and self.worker.poll() is not None
                    result.append(self.session.close(timeout=0 if already_exited else self.worker_grace_seconds))
                except BaseException as exc:
                    failure.append(type(exc).__name__)
            closer = threading.Thread(target=graceful_close, daemon=True)
            closer.start(); closer.join(self.worker_grace_seconds)
            verified = bool(result and result[0])
            self.state['worker_close_verified'] = verified
            if failure:
                self.state['worker_close_error_type'] = failure[0]
        if self.worker is not None:
            if self.worker.poll() is None and verified:
                try:
                    self.worker.wait(timeout=60)
                except subprocess.TimeoutExpired:
                    pass
            if self.worker.poll() is None:
                self.state['owned_worker_stop'] = self.stop_owned(self.worker, grace=30)
            self.state.update(worker_returncode=self.worker.returncode, owned_worker_absent=self.worker.poll() is not None)
        else:
            self.state['owned_worker_absent'] = True
        after = self.snapshot()
        self.state.update(gpu_after=after['gpu'], compute_after=after['compute'], finished_at=stamp(),
                          worker_close_verified=verified)
        if self.worker_stderr is not None:
            self.worker_stderr.close()
        if self.collector_log is not None:
            self.collector_log.close()
        return verified

    def run(self):
        error = None
        try:
            self.start(); self.run_fixed(); self.wait_for_stop()
        except BaseException as exc:
            error = exc
            self.state.update(error_type=type(exc).__name__, error=str(exc), status='failed')
            write_json(self.root / 'FAILURE.json', {'time': stamp(), 'error': str(exc),
                                                   'old_results_modified': False})
        finally:
            self.status('gpu_release')
            verified = self.close()
            succeeded = error is None and verified and self.state['owned_worker_absent']
            self.status('completed' if succeeded else 'failed', status='completed' if succeeded else 'failed', returncode=0 if succeeded else 1)
        return 0 if succeeded else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    verify_controller_scope(args.root)
    # The externally detached launcher supplies these directories before import;
    # forbid bytecode regardless of inherited parent interpreter flags.
    sys.dont_write_bytecode = True
    service = DurableService(args.root)
    signal.signal(signal.SIGTERM, lambda *_: service.stop_requested.set())
    signal.signal(signal.SIGINT, lambda *_: service.stop_requested.set())
    raise SystemExit(service.run())


if __name__ == '__main__':
    main()
