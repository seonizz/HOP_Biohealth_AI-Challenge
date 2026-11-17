#!/usr/bin/env python3
"""Confine the Ubuntu HOP evaluation and supervise only its own worker.

Launch /usr/bin/python3 -I -S -B this_file --supervise. No package installation,
network call, model import, or GPU reset is implemented in this module.
"""
import argparse
import csv
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import signal
import stat
import subprocess
import sys
import threading
import time

HOP = Path('/home/chihun/Documents/HOP')
ROOT = HOP / 'evaluations/role_eval_20261112'
VENV = HOP / 'gemma4_training/.venv'
MAX_SECONDS = 96 * 60 * 60
STOP_GRACE_SECONDS = 1200
DEVICES = ['/dev/null', '/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-uvm']
REQUIRED_FILES = {'code/ubuntu_eval_bootstrap.py', 'code/ubuntu_role_worker.py',
                  'code/ubuntu_role_panel.py', 'code/boundary.py', 'code/training_core.py', 'protocol.json'}
CACHE_PATHS = {
    'TMPDIR': 'tmp', 'TMP': 'tmp', 'TEMP': 'tmp', 'XDG_CACHE_HOME': 'cache',
    'XDG_CONFIG_HOME': 'config', 'XDG_DATA_HOME': 'data', 'XDG_STATE_HOME': 'state',
    'XDG_RUNTIME_DIR': 'run', 'HF_HOME': 'hf', 'HF_HUB_CACHE': 'hf/hub',
    'HUGGINGFACE_HUB_CACHE': 'hf/hub', 'HF_MODULES_CACHE': 'hf/modules',
    'HF_DATASETS_CACHE': 'hf/datasets', 'TORCH_HOME': 'torch',
    'TORCH_EXTENSIONS_DIR': 'torch-extensions', 'TORCHINDUCTOR_CACHE_DIR': 'inductor',
    'TORCH_COMPILE_DEBUG_DIR': 'compile-debug', 'TRITON_CACHE_DIR': 'triton',
    'CUDA_CACHE_PATH': 'cuda', 'NUMBA_CACHE_DIR': 'numba', 'MPLCONFIGDIR': 'matplotlib',
    'IPYTHONDIR': 'ipython', 'PIP_CACHE_DIR': 'pip', 'UV_CACHE_DIR': 'uv',
    'WANDB_DIR': 'wandb', 'WANDB_CACHE_DIR': 'wandb/cache', 'WANDB_CONFIG_DIR': 'wandb/config',
    'UNSLOTH_COMPILE_LOCATION': 'unsloth', 'CCACHE_DIR': 'ccache', 'CUPY_CACHE_DIR': 'cupy'}


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def file_sha(path):
    result = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(4 * 1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def real_owned(path, *, directory=True, base=HOP):
    path, base = Path(path), Path(base)
    require(path.is_absolute() and path.resolve(strict=True) == path and path.is_relative_to(base),
            'Path is not canonical inside the authorized HOP tree')
    device = base.stat().st_dev
    for parent in (path, *path.parents):
        if not parent.is_relative_to(base):
            break
        info = parent.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_dev == device, 'Path traverses a link or mount')
    info = path.stat()
    require(info.st_uid == os.getuid(), 'Unexpected path owner')
    require(path.is_dir() if directory else path.is_file(), 'Unexpected path type')
    if not directory:
        require(info.st_nlink == 1, 'Only single-link regular files are accepted')
    return path


def verify_sources(root=ROOT, base=HOP):
    real_owned(root, base=base); real_owned(root / 'code', base=base)
    manifest_path = real_owned(root / 'SOURCE_SHA256.json', directory=False, base=base)
    sources = json.loads(manifest_path.read_text())
    require(isinstance(sources, dict) and REQUIRED_FILES.issubset(sources), 'Required source bindings are missing')
    for relative, expected in sources.items():
        path = Path(relative)
        require(isinstance(relative, str) and not path.is_absolute() and '..' not in path.parts,
                'Unsafe source binding path')
        require(isinstance(expected, str) and re.fullmatch(r'[0-9a-f]{64}', expected), 'Invalid source hash')
        actual = real_owned(root / path, directory=False, base=base)
        require(file_sha(actual) == expected, 'Bound source changed: ' + relative)
    protocol = json.loads((root / 'protocol.json').read_text())
    require(isinstance(protocol.get('gpu_uuid'), str) and re.fullmatch(r'GPU-[0-9a-fA-F-]{36}', protocol['gpu_uuid']),
            'Protocol must pin one physical GPU UUID')
    thread_name_compat(protocol, sources, root)
    return sources, protocol



def thread_name_compat(protocol, sources, root=ROOT):
    config = protocol.get('cuda_thread_name_compat')
    if config is None:
        return None
    require(isinstance(config, dict), 'Invalid CUDA thread-name compatibility configuration')
    require(config.get('library') == 'code/ubuntu_cuda_name_compat.so'
            and config.get('source', 'code/ubuntu_cuda_name_compat.c') == 'code/ubuntu_cuda_name_compat.c'
            and config.get('sink', 'work/cuda-threadnames.log') == 'work/cuda-threadnames.log'
            and config.get('scope', 'own_process_thread_name_cosmetic_only') == 'own_process_thread_name_cosmetic_only',
            'CUDA thread-name compatibility must use the bound task-only library and sink')
    for path in ('code/ubuntu_cuda_name_compat.c', 'code/ubuntu_cuda_name_compat.so'):
        require(path in sources, 'CUDA compatibility source and binary must both be SHA-bound')
    return {'library': str(root / 'code/ubuntu_cuda_name_compat.so'),
            'source': str(root / 'code/ubuntu_cuda_name_compat.c'),
            'sink': str(root / 'work/cuda-threadnames.log'),
            'library_sha256': sources['code/ubuntu_cuda_name_compat.so'],
            'source_sha256': sources['code/ubuntu_cuda_name_compat.c'],
            'scope': 'own_process_thread_name_cosmetic_only'}


def worker_environment(protocol, sources, root=ROOT, inherited=None):
    environment = dict(os.environ if inherited is None else inherited)
    # Never append an inherited, unverified preload or redirect a different path.
    environment.pop('LD_PRELOAD', None)
    environment.pop('HOP_CUDA_THREAD_NAME_SINK', None)
    compatibility = thread_name_compat(protocol, sources, root)
    if compatibility is not None:
        environment['LD_PRELOAD'] = compatibility['library']
        environment['HOP_CUDA_THREAD_NAME_SINK'] = compatibility['sink']
    return environment


def check_mounts(base=HOP, mountinfo=None):
    text = Path('/proc/self/mountinfo').read_text() if mountinfo is None else mountinfo
    for line in text.splitlines():
        fields = line.split()
        require(len(fields) >= 5, 'Malformed mount information')
        mounted = fields[4].replace('\\040', ' ').replace('\\134', '\\')
        require(mounted != str(base) and not mounted.startswith(str(base) + '/'), 'Mount inside the authorized HOP tree')


def fresh_directory(path, *, base=HOP):
    real_owned(path, base=base)
    require(not list(path.iterdir()), 'Use a precreated empty runtime directory')
    return path


def configure_environment(work, gpu_uuid, *, base=HOP):
    fresh_directory(work, base=base)
    os.umask(0o077)
    for name, relative in CACHE_PATHS.items():
        path = work / relative
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        real_owned(path, base=base)
        os.environ[name] = str(path)
    os.environ.update(
        HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_DATASETS_OFFLINE='1',
        HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1', WANDB_MODE='disabled', WANDB_DISABLED='true',
        TOKENIZERS_PARALLELISM='false', CUDA_VISIBLE_DEVICES=gpu_uuid, CUDA_DEVICE_ORDER='PCI_BUS_ID',
        PYTHONDONTWRITEBYTECODE='1', CUDA_CACHE_DISABLE='1', PYTHONUNBUFFERED='1',
        PYTORCH_ALLOC_CONF='expandable_segments:True',
        OMP_NUM_THREADS='4', MKL_NUM_THREADS='4', OPENBLAS_NUM_THREADS='4',
        TORCHINDUCTOR_FORCE_DISABLE_CACHES='0', TORCH_COMPILE_FORCE_DISABLE_CACHES='0')
    sys.dont_write_bytecode = True
    return {name: os.environ[name] for name in CACHE_PATHS}


def atomic(path, value):
    require(not path.is_symlink(), 'Report target cannot be linked')
    temporary = path.with_suffix(path.suffix + '.tmp')
    require(not temporary.is_symlink(), 'Report temporary cannot be linked')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write('\n'); handle.flush(); os.fsync(handle.fileno())
    os.replace(temporary, path)


def acquire_task_lock(root=ROOT, base=HOP):
    path = root / 'task.lock'
    try:
        created = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        pass
    else:
        os.close(created)
    real_owned(path, directory=False, base=base)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        expected = path.stat(); actual = os.fstat(fd)
        require((expected.st_dev, expected.st_ino) == (actual.st_dev, actual.st_ino), 'Task lock changed while opening')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except BaseException:
        os.close(fd)
        raise


def verify_inherited_lock(root=ROOT, base=HOP):
    text = os.environ.get('UBUNTU_EVAL_TASK_LOCK_FD', '')
    require(text.isdigit(), 'Worker must inherit its supervisor task lock')
    fd = int(text)
    path = real_owned(root / 'task.lock', directory=False, base=base)
    actual, expected = os.fstat(fd), path.stat()
    require((actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino), 'Inherited lock identity mismatch')
    require(fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE == os.O_RDONLY, 'Inherited lock must be read-only')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    return fd


def gpu_snapshot(gpu_uuid, runner=subprocess.check_output):
    gpu = runner(['nvidia-smi', '--query-gpu=index,uuid,memory.used,memory.free,utilization.gpu',
                  '--format=csv,noheader,nounits'], text=True)
    compute = runner(['nvidia-smi', '--query-compute-apps=gpu_uuid,pid',
                      '--format=csv,noheader,nounits'], text=True)
    gpu_rows = [[value.strip() for value in row] for row in csv.reader(gpu.splitlines()) if row]
    selected = [row for row in gpu_rows if len(row) == 5 and row[1] == gpu_uuid]
    require(len(selected) == 1 and all(value.isdigit() for value in (selected[0][0], *selected[0][2:])),
            'Pinned physical GPU telemetry is missing or invalid')
    processes = []
    for fields in csv.reader(compute.splitlines()):
        if not fields:
            continue
        require(len(fields) == 2 and fields[1].strip().isdigit(), 'Invalid compute-process telemetry')
        if fields[0].strip() == gpu_uuid:
            processes.append(int(fields[1].strip()))
    return {'gpu_raw': gpu, 'compute_raw': compute, 'gpu_uuid': gpu_uuid,
            'gpu_index': int(selected[0][0]), 'memory_used_mib': int(selected[0][2]),
            'memory_free_mib': int(selected[0][3]), 'utilization_percent': int(selected[0][4]),
            'compute_pids': processes}


def apply_boundary(boundary, writable, proof_path):
    policy = boundary['sandbox'](writable, DEVICES)
    policy['writable_regular_tree'] = str(writable)
    policy['gpu_device_exceptions'] = DEVICES
    atomic(proof_path, policy)
    return policy


def worker_command(root=ROOT, venv=VENV):
    return [str(venv / 'bin/python'), '-I', '-S', '-B', '-u',
            str(root / 'code/ubuntu_eval_bootstrap.py'), '--worker']


def run_worker(boundary, sources, protocol):
    inherited = verify_inherited_lock()
    expected_environment = worker_environment(protocol, sources)
    require(os.environ.get('LD_PRELOAD') == expected_environment.get('LD_PRELOAD')
            and os.environ.get('HOP_CUDA_THREAD_NAME_SINK') == expected_environment.get('HOP_CUDA_THREAD_NAME_SINK'),
            'Worker compatibility preload/sink differs from its verified protocol')
    work = ROOT / 'work'
    environment = configure_environment(work, protocol['gpu_uuid'])
    policy = apply_boundary(boundary, work, work / 'BOUNDARY_PROOF.json')
    policy.update(source_sha256=sources, environment_paths=environment,
                  readonly_inherited_task_lock=True, inherited_task_lock_fd=inherited,
                  cuda_thread_name_compat=thread_name_compat(protocol, sources))
    before = gpu_snapshot(protocol['gpu_uuid'])
    require(not before['compute_pids'], 'Pinned GPU already has a compute process; no model loaded')
    policy['gpu_before_model_import'] = before
    atomic(work / 'BOUNDARY_PROOF.json', policy)
    packages = VENV / 'lib/python3.12/site-packages'
    real_owned(packages)
    sys.path.insert(0, str(packages)); sys.path.insert(0, str(ROOT / 'code'))
    sys.prefix = sys.exec_prefix = str(VENV)
    os.chdir(work)
    script = ROOT / 'code/ubuntu_role_worker.py'
    sys.argv = [str(script), '--root', str(ROOT)]
    runpy.run_path(str(script), run_name='__main__')


def pump_logs(pipe, path):
    with path.open('xb') as output:
        while True:
            block = pipe.read(64 * 1024)
            if not block:
                break
            output.write(block); output.flush()
        os.fsync(output.fileno())


def stop_owned(process, grace=STOP_GRACE_SECONDS):
    if process.poll() is not None:
        return {'terminated': False, 'killed': False}
    process.terminate()
    try:
        process.wait(timeout=grace)
        return {'terminated': True, 'killed': False}
    except subprocess.TimeoutExpired:
        process.kill(); process.wait(timeout=30)
        return {'terminated': True, 'killed': True}


def supervise(boundary, sources, protocol):
    require(not (ROOT / 'SUPERVISOR_RESULT.json').exists() and not (ROOT / 'worker.log').exists(),
            'Use a fresh supervisor result and log directory')
    controller = ROOT / 'controller-work'
    environment = configure_environment(controller, protocol['gpu_uuid'])
    policy = apply_boundary(boundary, ROOT, controller / 'BOUNDARY_PROOF.json')
    policy.update(source_sha256=sources, environment_paths=environment)
    atomic(controller / 'BOUNDARY_PROOF.json', policy)
    lock = acquire_task_lock()
    child = None; pump = None; exitcode = 1; stopped = threading.Event()
    state = {'schema': 'ubuntu-hop-evaluation-supervisor-v1', 'status': 'starting', 'root': str(ROOT),
             'supervisor_pid': os.getpid(), 'started_at': time.time(), 'source_sha256': sources,
             'task_lock_scope': 'this evaluation task only; GPU idle checked separately',
             'worker_work_directory': str(ROOT / 'work'), 'max_lifetime_seconds': MAX_SECONDS,
             'other_processes_stopped': False, 'gpu_reset_used': False}
    def record():
        state['updated_at'] = time.time(); atomic(ROOT / 'SUPERVISOR_RESULT.json', state)
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    try:
        before = gpu_snapshot(protocol['gpu_uuid'])
        state['gpu_before'] = before; record()
        require(not before['compute_pids'], 'Pinned GPU has an existing compute process; no worker started')
        environment = worker_environment(protocol, sources)
        environment['UBUNTU_EVAL_TASK_LOCK_FD'] = str(lock)
        state['cuda_thread_name_compat'] = thread_name_compat(protocol, sources)
        command = worker_command()
        # Parent alone writes ROOT/worker.log. The restricted worker receives
        # only a pipe, /dev/null stdin and a read-only inherited lock descriptor.
        child = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, pass_fds=(lock,), env=environment, bufsize=0)
        state.update(status='running', worker_pid=child.pid, worker_command=command); record()
        pump = threading.Thread(target=pump_logs, args=(child.stdout, ROOT / 'worker.log'), daemon=True)
        pump.start()
        deadline = time.monotonic() + MAX_SECONDS
        while child.poll() is None:
            if stopped.is_set() or (ROOT / 'STOP').exists():
                state.update(stop_reason='explicit_stop', owned_worker_stop=stop_owned(child)); break
            if time.monotonic() >= deadline:
                state.update(stop_reason='supervisor_lifetime_exceeded', owned_worker_stop=stop_owned(child)); break
            record(); time.sleep(5)
        exitcode = child.wait(timeout=30)
        state.update(returncode=exitcode, status='completed' if exitcode == 0 and not state.get('stop_reason') else
                     'stopped' if state.get('stop_reason') == 'explicit_stop' else 'failed')
    except BaseException as error:
        state.update(status='failed', error_type=type(error).__name__)
    finally:
        if child is not None and child.poll() is None:
            state['owned_worker_stop'] = stop_owned(child)
        if pump is not None:
            pump.join(timeout=30)
        if child is not None:
            state.update(returncode=child.returncode, owned_worker_absent=child.poll() is not None)
        else:
            state['owned_worker_absent'] = True
        try:
            after = gpu_snapshot(protocol['gpu_uuid'])
            for _ in range(15):
                owned_listed = child is not None and child.pid in after['compute_pids']
                memory_pending = (not after['compute_pids'] and
                                  after['memory_used_mib'] > state.get('gpu_before', after)['memory_used_mib'] + 64)
                if not owned_listed and not memory_pending:
                    break
                time.sleep(1); after = gpu_snapshot(protocol['gpu_uuid'])
            state['gpu_after'] = after
            state['owned_worker_listed_after'] = child is not None and child.pid in after['compute_pids']
            state['memory_delta_mib'] = after['memory_used_mib'] - state.get('gpu_before', after)['memory_used_mib']
            state['gpu_return_verified'] = (not after['compute_pids'] and state['owned_worker_absent']
                                            and state['memory_delta_mib'] <= 64)
        except BaseException as error:
            state.update(gpu_return_verified=False, gpu_return_error_type=type(error).__name__)
        state['finished_at'] = time.time(); record(); os.close(lock)
    return exitcode if state['status'] == 'completed' else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--supervise', action='store_true'); mode.add_argument('--worker', action='store_true')
    args = parser.parse_args()
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode, 'Run python -I -S -B')
    require(Path(__file__).resolve() == ROOT / 'code/ubuntu_eval_bootstrap.py', 'Unexpected evaluation bootstrap location')
    sources, protocol = verify_sources()
    check_mounts()
    # The boundary helper is imported only after its exact source bytes and all
    # executable siblings/protocol have been checked against the task manifest.
    boundary = runpy.run_path(str(ROOT / 'code/boundary.py'))
    require(boundary.get('BASE') == HOP, 'Boundary helper does not target this HOP tree')
    if args.worker:
        run_worker(boundary, sources, protocol)
        return 0
    return supervise(boundary, sources, protocol)


if __name__ == '__main__':
    raise SystemExit(main())
