"""Own the requested checkpoint100 evaluation and original full-epoch continuation."""
from pathlib import Path
import datetime
import fcntl
import json
import os
import signal
import subprocess
import time
import traceback

from checkpoint100_boundary import (arm, atomic_json, canonical, committed100,
                                    last_record, read, release, require, sha)

ROOT = Path('/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009')
KIT = ROOT / 'training_kit'
WORK = KIT / 'work'
TRAINING = WORK / 'training'
AUDIT = ROOT / 'work/collection/checkpoint100_handoff_v1'
REPORT = ROOT / 'work/collection/checkpoint100_pipeline_v1.json'
PYTHON = '/home/slim/choieram/malssi-validation-20261009/.venv/bin/python'
ORIGINAL_DRIVER_SHA = '1f86d192f23c7d32e97834bd22ddc2bce4582f9ad7ea7bd6bd3f971b07c284ba'


def process(pid):
    try:
        path = Path('/proc') / str(pid)
        fields = path.joinpath('stat').read_text().rsplit(')', 1)[1].split()
        return {'pid': pid, 'ppid': int(fields[1]), 'state': fields[0], 'start_ticks': int(fields[19]),
                'argv': [x.decode() for x in path.joinpath('cmdline').read_bytes().split(b'\0') if x]}
    except FileNotFoundError:
        return None


def live(original):
    current = process(original['pid'])
    if current is None or current['state'] == 'Z':
        return False
    require(current['start_ticks'] == original['start_ticks'], 'An owned PID was reused')
    if not current['argv']:
        return False  # Linux can clear cmdline between reading stat and exit.
    require(current['argv'] == original['argv'], 'An owned process changed identity')
    return True


def validate_previous_exit(events, console, target):
    require(len(events) == 2 and events[0]['event'] == 'start' and events[-1]['event'] == 'end'
            and events[-1]['exit_code'] == 1 and events[-1]['log_exit_code'] == 0,
            'Previous metrics wrapper did not preserve the expected exit1/log0')
    errors = [line for line in console.splitlines() if line.startswith('IsADirectoryError:')]
    require(len(errors) == 1 and str(target) in errors[0] and '.latest.json.' in errors[0],
            'Missing exact planned latest-pointer failure')
    require(console.count('Traceback (most recent call last):') == 1,
            'Unexpected additional exception in previous training segment')
    return errors[0]


def verify_deployment():
    manifest = read(ROOT / 'work/collection/checkpoint100_deployment.json')
    for relative, entry in manifest['files'].items():
        path = ROOT / relative
        require(path == path.resolve() and path.is_relative_to(ROOT)
                and sha(path) == entry['sha256'], 'Deployment changed: ' + relative)
    require(sha(ROOT / 'scripts/early_training_driver.py') == ORIGINAL_DRIVER_SHA,
            'Original evaluation/training driver identity changed')
    return manifest


def main():
    os.umask(0o077)
    require(ROOT == ROOT.resolve() and TRAINING == TRAINING.resolve(), 'Unsafe runtime paths')
    lock = (ROOT / 'work/collection/.checkpoint100_pipeline.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    require(not REPORT.exists() and not AUDIT.exists(), 'Existing milestone execution must be preserved')
    AUDIT.mkdir()
    state = {'status': 'running', 'phase': 'preparing_boundary', 'pid': os.getpid(),
             'target_optimizer_step': 100, 'total_optimizer_steps': 5052,
             'supersedes': 'early_training_pipeline_v1.json',
             'authorization_thread': '01a12000-fb4f-7fc3-b76d-6435d39db351'}

    def save(**updates):
        state.update(updates, updated_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
        atomic_json(REPORT, state)
        print(json.dumps({key: state.get(key) for key in ('status', 'phase', 'completed_optimizer_steps')},
                         ensure_ascii=False), flush=True)

    def interrupted(signum, frame):
        raise RuntimeError('Coordinator signal ' + str(signum) + '; training was not signalled')

    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    guard_armed = False
    try:
        deployment = verify_deployment()
        source = read(WORK / 'early/driver_status.json')
        original = process(source['pid'])
        require(original is not None and original['state'] != 'Z'
                and original['argv'] == [PYTHON, str(ROOT / 'scripts/early_training_driver.py'),
                                         'continue', '--kit', str(KIT)]
                and source['driver_sha256'] == ORIGINAL_DRIVER_SHA, 'Original live continuation changed')
        require(source['stage'] == 'continue' and source['status'] == 'running', 'Training is not in continuation')
        run = read(TRAINING / 'RUN.json')
        require(run['bindings'] == source['bindings'] and run['mode'] == 'train'
                and run['plan']['rows'] == 40415 and run['plan']['optimizer_steps'] == 5052,
                'Original full-source run changed')
        old = read(ROOT / 'work/collection/early_training_pipeline_v1.json')
        require(old['status'] == 'running', 'Original coordinator is not running')
        stage = process(original['ppid'])
        wrapper = process(old['active_child']['pid'])
        coordinator = process(old['pid'])
        require(stage and stage['argv'] == ['bash', str(ROOT / 'scripts/run_early_stages.sh')], 'Stage owner changed')
        require(wrapper and wrapper['argv'] == ['bash', str(ROOT / 'scripts/run_with_metrics_early_v1.sh')], 'Wrapper owner changed')
        require(coordinator and str(ROOT / 'scripts/continue_early_training.py') in coordinator['argv'], 'Coordinator owner changed')
        require(stage['ppid'] == wrapper['pid'] and wrapper['ppid'] == coordinator['pid'],
                'Original process ownership tree changed')
        segments = list((WORK / 'collection').glob('*-start-' + str(wrapper['pid'])))
        require(len(segments) == 1, 'Expected exactly one original metrics segment')
        segment = segments[0]
        console = segment / 'console.log'
        console_stat = console.stat()
        initial = {'driver': original, 'stage': stage, 'wrapper': wrapper, 'coordinator': coordinator,
                   'original_run_file_sha256': sha(TRAINING / 'RUN.json'),
                   'original_driver_sha256': ORIGINAL_DRIVER_SHA,
                   'original_bindings': run['bindings'], 'deployment': deployment,
                   'metrics_segment': str(segment), 'console_offset': console_stat.st_size,
                   'console_device': console_stat.st_dev, 'console_inode': console_stat.st_ino,
                   'last_step_before_arm': last_record(TRAINING)}
        atomic_json(AUDIT / 'original_execution.json', initial)
        plan = arm(TRAINING, AUDIT)
        guard_armed = True
        save(phase='waiting_for_committed100_boundary', original_driver_pid=original['pid'],
             intentional_handoff=True, completed_optimizer_steps=last_record(TRAINING)['step'])
        while live(original):
            current = last_record(TRAINING)
            require(current['step'] <= 100, 'Training passed the intended boundary; never roll it back')
            require(read(TRAINING / 'latest.json/OWNERSHIP.json') == plan, 'Boundary guard changed')
            if current['step'] != state.get('completed_optimizer_steps'):
                save(completed_optimizer_steps=current['step'], latest_main_training_loss=current['target_mean_loss'])
            time.sleep(5)
        # No GPU is acquired until the old trainer and every old owner have exited.
        for _ in range(60):
            if not any(live(owner) for owner in (stage, wrapper, coordinator)):
                break
            time.sleep(2)
        require(not any(live(owner) for owner in (stage, wrapper, coordinator)), 'Previous owners have not exited')
        current_stat = console.stat()
        require((current_stat.st_dev, current_stat.st_ino) == (console_stat.st_dev, console_stat.st_ino),
                'Original console file was replaced')
        with console.open('rb') as stream:
            stream.seek(console_stat.st_size)
            ending = stream.read().decode(errors='replace')
        events = [json.loads(line) for line in (segment / 'events.jsonl').read_text().splitlines()]
        expected_error = validate_previous_exit(events, ending, TRAINING / 'latest.json')
        evidence = committed100(TRAINING, plan)
        require(sha(TRAINING / 'RUN.json') == initial['original_run_file_sha256'], 'Original RUN changed')
        # Preserve the failed pointer temporary file; it is outside all checkpoint inventories.
        temporary_files = [{'name': p.name, 'sha256': sha(p)} for p in TRAINING.glob('.latest.json.*.tmp')]
        atomic_json(AUDIT / 'committed_boundary.json', {**evidence, 'expected_error': expected_error,
                    'previous_wrapper_exit': 1, 'previous_log_exit': 0, 'temporary_pointer_files': temporary_files,
                    'processes_exited': [x['pid'] for x in (original, stage, wrapper, coordinator)]})
        release(TRAINING, AUDIT, committed=True)
        guard_armed = False
        verify_deployment()
        save(phase='checkpoint100_evaluation_then_full_continuation', completed_optimizer_steps=100,
             previous_wrapper_exit=1, previous_log_exit=0, boundary_evidence=evidence)
        output = ROOT / 'work/collection/checkpoint100-training-start-v1.log'
        with output.open('xb') as stream:
            child = subprocess.Popen(['bash', str(ROOT / 'scripts/run_with_metrics_checkpoint100_v1.sh')],
                                     stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, cwd=KIT)
            save(active_child={'pid': child.pid, 'log': str(output)})
            while child.poll() is None:
                current = last_record(TRAINING)
                ready = (WORK / 'checkpoint100_result.json').is_file()
                if current['step'] != state.get('completed_optimizer_steps') or ready != state.get('checkpoint100_result_ready'):
                    save(completed_optimizer_steps=current['step'], latest_main_training_loss=current['target_mean_loss'],
                         checkpoint100_result_ready=ready)
                time.sleep(5)
            exit_code = child.returncode
        state.pop('active_child', None)
        save(last_process_exit=exit_code)
        require(exit_code == 0, 'Milestone/full-training wrapper failed; preserve all evidence')
        save(phase='strict_final_collection')
        with (ROOT / 'work/collection/checkpoint100-final-results-v1.log').open('xb') as stream:
            result = subprocess.run([PYTHON, '-B', str(ROOT / 'scripts/collect_results.py'), '--kit', str(KIT)],
                                    stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, cwd=KIT)
        require(result.returncode == 0, 'Strict final collection failed')
        save(status='passed', phase='training_all_evaluations_collected')
        return 0
    except BaseException as error:
        (AUDIT / 'error.log').write_text(traceback.format_exc())
        cleanup = 'not_needed'
        if guard_armed:
            try:
                # Unexpected errors never become permission to discard newer work.
                exists = (TRAINING / 'checkpoints/step-000000100/CHECKPOINT.json').is_file()
                release(TRAINING, AUDIT, committed=exists)
                cleanup = 'owned_guard_released_without_signalling_training'
            except BaseException:
                (AUDIT / 'cleanup_error.log').write_text(traceback.format_exc())
                cleanup = 'requires_review_no_unknown_files_changed'
        save(status='failed', error_type=type(error).__name__, error=str(error), cleanup=cleanup)
        return 1
    finally:
        lock.close()


if __name__ == '__main__':
    raise SystemExit(main())
