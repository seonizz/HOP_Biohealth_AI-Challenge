#!/usr/bin/env python3
"""Sequential synthetic inference capacity measurements on the two reserved GPUs.

Waits for this task's training stress probe; never stops another process.
No production deployment or dataset access. Every measurement is a fresh process.
"""
import datetime
import json
import os
from pathlib import Path
import subprocess
import time
import traceback

ROOT = Path('/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009')
PYTHON = '/home/slim/choieram/malssi-validation-20261009/.venv/bin/python'
WAIT_REPORT = ROOT / 'work/probes/20261009T091847Z-d3f03097f3a9/result.json'
WAIT_PID = 1043804
REPORT = ROOT / 'work/collection/inference_capacity_pipeline.json'
GPU_UUIDS = {'GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c', 'GPU-a2d3d60c-4eae-7e46-45bc-146e24457642'}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


state = {'status': 'running', 'phase': 'waiting_for_training_probe', 'pid': os.getpid(),
         'started_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
         'profiles': [], 'synthetic_only': True, 'model_context_limit': 262144,
         'maximum_output_measured': False, 'maximum_input_measured': False,
         'hop_deployment_ready': False}


def save():
    state['updated_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    temporary = REPORT.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, indent=2, allow_nan=False) + '\n')
    temporary.replace(REPORT)


def measure(name, inputs, output, chunk, parity=False):
    state['phase'] = name
    before = set((ROOT / 'work/probes').glob('*/result.json'))
    command = [PYTHON, '-B', str(ROOT / 'scripts/capacity_probe_v6.py'),
               '--mode', 'inference', '--length', str(inputs), '--new-tokens', str(output),
               '--force-budget', '--layer-split', '32', '--prefill-chunk-size', str(chunk)]
    if parity:
        command.append('--verify-prefill-parity')
    log = ROOT / 'work/collection' / (name + '.log')
    with log.open('xb') as handle:
        process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=handle,
                                   stderr=subprocess.STDOUT, cwd=ROOT)
        state['active_child'] = {'pid': process.pid, 'command': command, 'log': str(log)}
        save()
        code = process.wait()
    paths = set((ROOT / 'work/probes').glob('*/result.json')) - before
    require(len(paths) == 1, 'Expected exactly one fresh inference probe report')
    path = paths.pop()
    result = json.loads(path.read_text())
    summary = {key: result.get(key) for key in (
        'status', 'arguments', 'oom', 'error_type', 'actual_input_tokens',
        'actual_generated_tokens', 'actual_total_tokens', 'measured_phase_seconds',
        'gpu_memory', 'prefill_parity', 'inference_observation')}
    summary.update(name=name, result_path=str(path), process_exit=code)
    state['profiles'].append(summary)
    state.pop('active_child', None)
    save()
    require(code == 0 and result['status'] == 'passed' or code != 0 and result['status'] == 'failed',
            'Probe exit/report mismatch')
    if result['status'] == 'failed':
        require(result.get('oom') is True, 'Inference failed for a reason other than capacity: ' + str(result.get('error_type')))
    return result


require(ROOT == ROOT.resolve() and REPORT == REPORT.resolve(), 'Unsafe root or report path')
# Exclusive creation must happen outside the failure handler, so a duplicate
# invocation cannot replace evidence from an already running measurement.
with REPORT.open('x') as handle:
    handle.write(json.dumps(state, indent=2, allow_nan=False) + '\n')
try:
    save()
    while True:
        previous = json.loads(WAIT_REPORT.read_text())
        if previous['status'] in ('passed', 'failed'):
            state['preceding_training_probe_status'] = previous['status']
            break
        time.sleep(10)
    # A probe saves its terminal report just before process exit. Wait for CUDA
    # teardown of that exact process; do not suppress an unrelated GPU owner.
    for attempt in range(30):
        output = subprocess.check_output(['nvidia-smi', '--query-compute-apps=gpu_uuid,pid',
                                          '--format=csv,noheader,nounits'], text=True)
        owners = [(fields[0].strip(), int(fields[1])) for line in output.splitlines()
                  if len(fields := line.split(',')) == 2 and fields[0].strip() in GPU_UUIDS]
        require(not any(pid != WAIT_PID for _, pid in owners), 'Another process owns a requested GPU')
        if not owners:
            break
        time.sleep(2)
    else:
        raise RuntimeError('Previous CUDA process did not release GPUs')
    parity = measure('inference-parity-8192-plus64', 8192, 64, 4096, parity=True)
    require(parity['status'] == 'passed', 'Short prefill parity must pass before a long inference measurement')
    selected_chunk = None
    for chunk in (4096, 2048, 1024, 512, 256, 128):
        result = measure('inference-max-input-chunk' + str(chunk), 262143, 1, chunk)
        if result['status'] == 'passed':
            selected_chunk = chunk
            state['maximum_input_measured'] = True
            state['maximum_input_tokens_with_one_generated_token'] = 262143
            save()
            break
    require(selected_chunk is not None, 'Native context did not fit; preserve observations for bounded lower-context search')
    result = measure('inference-max-output-from2', 2, 262142, selected_chunk)
    require(result['status'] == 'passed', 'Maximum output profile did not finish')
    state.update(status='passed', phase='completed', maximum_output_measured=True,
                 maximum_generated_tokens_with_two_input_tokens=262142,
                 tested_total_token_budget=262144, input_output_share_budget=True,
                 prefill_chunk_size=selected_chunk, layer_split=32,
                 context_quality_verified=False, concurrent_requests_verified=1)
except BaseException as error:
    state.update(status='failed', error_type=type(error).__name__, error=str(error))
    (ROOT / 'work/collection/inference_capacity_pipeline.error.log').write_text(traceback.format_exc())
finally:
    save()
print(json.dumps({'status': state['status'], 'report': str(REPORT)}))
raise SystemExit(0 if state['status'] == 'passed' else 1)
