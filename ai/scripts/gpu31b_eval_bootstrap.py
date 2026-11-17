#!/usr/bin/env python3
"""Apply the established Linux boundary before importing the 31B runtime.

Run existing venv python with -I -S -B. All writable regular paths are confined
to one precreated, fresh work directory under this fixed evaluation task.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import runpy
import stat
import subprocess
import sys
import uuid

BASE = Path('/home/slim/choieram')
TASK = BASE / 'model_Training/gpu31b_controlled_20261112_v13_r2'
VENV = BASE / 'malssi-validation-20261009/.venv'
BOUNDARY_SHA = '8cd7cd20bd41a9161b553975aae717c22c78da6a32d50116e5691d92d165c6fc'
GPU_UUIDS = ('GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c', 'GPU-a2d3d60c-4eae-7e46-45bc-146e24457642')
CACHE_PATHS = {'TMPDIR': 'tmp', 'TMP': 'tmp', 'TEMP': 'tmp', 'XDG_CACHE_HOME': 'cache',
               'XDG_CONFIG_HOME': 'config', 'XDG_DATA_HOME': 'data', 'XDG_STATE_HOME': 'state',
               'XDG_RUNTIME_DIR': 'run', 'HF_HOME': 'hf', 'HF_HUB_CACHE': 'hf/hub',
               'HUGGINGFACE_HUB_CACHE': 'hf/hub', 'HF_MODULES_CACHE': 'hf/modules',
               'HF_DATASETS_CACHE': 'hf/datasets', 'TORCH_HOME': 'torch',
               'TORCH_EXTENSIONS_DIR': 'extensions', 'TORCHINDUCTOR_CACHE_DIR': 'inductor',
               'TORCH_COMPILE_DEBUG_DIR': 'compile-debug', 'TRITON_CACHE_DIR': 'triton',
               'CUDA_CACHE_PATH': 'cuda', 'NUMBA_CACHE_DIR': 'numba', 'MPLCONFIGDIR': 'mpl',
               'IPYTHONDIR': 'ipython', 'PIP_CACHE_DIR': 'pip', 'UV_CACHE_DIR': 'uv',
               'WANDB_DIR': 'wandb', 'UNSLOTH_COMPILE_LOCATION': 'unsloth'}


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def source_sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def selected_work(relative):
    value = Path(relative)
    require(not value.is_absolute() and '..' not in value.parts and value.parts
            and value.parts[0] == 'work', 'Work must be relative beneath TASK/work')
    return TASK / value


def acquire_idle_gpu_locks(real_owned):
    handles = []
    try:
        for gpu in GPU_UUIDS:
            path = BASE / ('.malssi-' + gpu + '.lock')
            real_owned(path, directory=False)
            info = path.stat()
            require(info.st_nlink == 1 and stat.S_ISREG(info.st_mode), 'GPU lock must be an existing single-link file')
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            handles.append(fd)
            require(os.fstat(fd).st_ino == info.st_ino and os.fstat(fd).st_dev == info.st_dev,
                    'GPU lock changed while opening')
            # Linux flock permits an exclusive advisory lock on a read-only FD.
            # No existing lockfile contents or metadata are changed.
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        compute = subprocess.check_output(
            ['nvidia-smi', '--query-compute-apps=gpu_uuid,pid', '--format=csv,noheader,nounits'], text=True)
        require(not any(line.split(',')[0].strip() in GPU_UUIDS for line in compute.splitlines()),
                'Pinned GPU has an existing compute process')
        status = subprocess.check_output(
            ['nvidia-smi', '--query-gpu=uuid,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], text=True)
        records = [[value.strip() for value in line.split(',')] for line in status.splitlines()]
        for gpu in GPU_UUIDS:
            found = [row for row in records if row and row[0] == gpu]
            require(len(found) == 1 and len(found[0]) == 3 and int(found[0][1]) < 512 and int(found[0][2]) == 0,
                    'Pinned GPU is not idle; do not stop other jobs')
        return handles, {'gpu_status': status, 'compute_processes': compute,
                         'lock_mode': 'existing_readonly_exclusive_nonblocking', 'gpu_uuids': list(GPU_UUIDS)}
    except BaseException:
        for fd in reversed(handles):
            os.close(fd)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--work', required=True)
    args = parser.parse_args()
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode, 'Run python -I -S -B')
    require(Path(__file__).resolve() == TASK / 'code/gpu31b_eval_bootstrap.py', 'Unexpected task/bootstrap path')
    boundary_path = TASK / 'code/boundary.py'
    require(source_sha(boundary_path) == BOUNDARY_SHA, 'Trusted boundary source changed')
    boundary = runpy.run_path(str(boundary_path))
    real_owned = boundary['real_owned']
    real_owned(TASK); real_owned(TASK / 'code')
    require(not any(line.split()[4] == str(BASE) or line.split()[4].startswith(str(BASE) + '/')
                    for line in Path('/proc/self/mountinfo').read_text().splitlines()), 'Mount within authorized tree')
    sources_path = TASK / 'SOURCE_SHA256.json'
    real_owned(sources_path, directory=False)
    sources = json.loads(sources_path.read_text())
    required_sources = {'gpu31b_eval_bootstrap.py', 'gpu31b_eval_worker.py', 'gpu31b_request_control.py', 'speed_reference.py', 'boundary.py'}
    require(required_sources.issubset(sources), 'Missing required code bindings')
    for name, digest in sources.items():
        require(Path(name).name == name, 'Unsafe source binding path')
        source = TASK / 'code' / name
        real_owned(source, directory=False)
        require(source.stat().st_nlink == 1 and source_sha(source) == digest, 'Source binding changed')
    work = selected_work(args.work)
    real_owned(work)
    require(not list(work.iterdir()), 'Use a precreated empty work directory')
    for name in ('UNSLOTH_CE_LOSS_N_CHUNKS', 'UNSLOTH_CE_LOSS_TARGET_GB', 'UNSLOTH_COMPILE_DISABLE', 'UNSLOTH_TILED_MLP'):
        require(not os.environ.get(name), 'Inherited training override: ' + name)
    os.umask(0o077)
    for name, relative in CACHE_PATHS.items():
        path = work / relative
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        real_owned(path)
        os.environ[name] = str(path)
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_DATASETS_OFFLINE='1',
                      HF_HUB_DISABLE_TELEMETRY='1', DO_NOT_TRACK='1', CUDA_CACHE_DISABLE='1',
                      WANDB_MODE='disabled', WANDB_DISABLED='true', TOKENIZERS_PARALLELISM='false',
                      OMP_NUM_THREADS='4', MKL_NUM_THREADS='4', OPENBLAS_NUM_THREADS='4',
                      CUDA_VISIBLE_DEVICES=','.join(GPU_UUIDS), CUDA_DEVICE_ORDER='PCI_BUS_ID',
                      UNSLOTH_DISABLE_STATISTICS='1', UNSLOTH_RETURN_LOGITS='0',
                      TORCHINDUCTOR_FORCE_DISABLE_CACHES='1', TORCH_COMPILE_FORCE_DISABLE_CACHES='1',
                      TORCH_COMPILE_CACHE_KEY_TAG=str(work), PYTHONDONTWRITEBYTECODE='1')
    handles, gpu_proof = acquire_idle_gpu_locks(real_owned)
    try:
        # Exercise the unchanged boundary on a harmless nested fixture first.
        probe = work / ('boundary-fixture-' + uuid.uuid4().hex)
        probe.mkdir(); allow, deny = probe / 'allow', probe / 'deny'
        allow.mkdir(); deny.mkdir(); (deny / 'sentinel').write_bytes(b'preserved')
        child = os.fork()
        if child == 0:
            try:
                boundary['sandbox'](allow, [])
                checks = {'create': lambda: os.open(deny / 'new', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600),
                          'truncate': lambda: os.open(deny / 'sentinel', os.O_WRONLY | os.O_TRUNC),
                          'unlink': lambda: os.unlink(deny / 'sentinel'),
                          'chmod': lambda: os.chmod(deny / 'sentinel', 0o600)}
                (allow / 'result.json').write_text(json.dumps({key: boundary['expect_denied'](action) for key, action in checks.items()}))
                os._exit(0)
            except BaseException:
                os._exit(1)
        _, status = os.waitpid(child, 0)
        require(status == 0 and (deny / 'sentinel').read_bytes() == b'preserved', 'Boundary fixture failed')
        policy = boundary['sandbox'](work, boundary['DEVICES'])
        policy['outside_existing_file_write_denied'] = boundary['expect_denied'](
            lambda: os.open(BASE / 'AGENTS.md', os.O_WRONLY | os.O_CLOEXEC | os.O_NOFOLLOW))
        policy.update(pid=os.getpid(), gpu_proof=gpu_proof, source_sha256=sources,
                      environment_paths={key: os.environ[key] for key in CACHE_PATHS})
        (work / 'BOUNDARY_PROOF.json').write_text(json.dumps(policy, indent=2))
        packages = VENV / 'lib/python3.12/site-packages'
        real_owned(packages)
        sys.path.insert(0, str(packages)); sys.prefix = sys.exec_prefix = str(VENV)
        os.chdir(work); sys.path.insert(0, str(TASK / 'code'))
        script = TASK / 'code/gpu31b_eval_worker.py'
        sys.argv = [str(script)]
        runpy.run_path(str(script), run_name='__main__')
    finally:
        for fd in reversed(handles):
            os.close(fd)


if __name__ == '__main__':
    main()
