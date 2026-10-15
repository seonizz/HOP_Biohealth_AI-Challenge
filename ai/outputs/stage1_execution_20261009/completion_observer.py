#!/usr/bin/env python3
"""Observe one already running wrapper and collect its final evidence once."""
import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

KIT = Path('/home/slim/choieram/model_Training/malssi_stage1_training_20261009')
SEGMENT = '20261009T080621Z-start-1039749'
LAUNCHER_PID = 1039749
PYTHON = '/home/slim/choieram/malssi-validation-20261009/.venv/bin/python'

def main():
    if KIT.resolve() != KIT:
        raise RuntimeError('Unexpected kit path')
    collection = KIT / 'work/collection'
    if collection.resolve() != collection:
        raise RuntimeError('Unexpected collection path')
    observer = collection / ('observer-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + str(os.getpid()))
    observer.mkdir()
    events_file = collection / SEGMENT / 'events.jsonl'
    outcome = {'observed_segment': SEGMENT, 'launcher_pid': LAUNCHER_PID}
    while True:
        events = [json.loads(line) for line in events_file.read_text().splitlines() if line.strip()]
        endings = [event for event in events if event.get('event') == 'end']
        if endings:
            outcome['wrapper_end'] = endings[-1]
            break
        command = Path('/proc') / str(LAUNCHER_PID) / 'cmdline'
        if not command.exists() or b'run_with_metrics.sh' not in command.read_bytes():
            outcome['wrapper_disappeared_without_end'] = True
            break
        time.sleep(30)
    # Allow the wrapper's monitor EXIT trap to flush/exit before verification.
    time.sleep(5)
    command = [PYTHON, str(collection / 'collect_results.py'), '--kit', str(KIT)]
    with (observer / 'collector.log').open('xb') as output:
        completed = subprocess.run(command, cwd=KIT, stdout=output, stderr=subprocess.STDOUT, check=False)
    outcome['strict_collection_exit_code'] = completed.returncode
    if completed.returncode != 0:
        with (observer / 'incomplete_collector.log').open('xb') as output:
            incomplete = subprocess.run(command + ['--allow-incomplete'], cwd=KIT, stdout=output, stderr=subprocess.STDOUT, check=False)
        outcome['incomplete_collection_exit_code'] = incomplete.returncode
    strict_lines = (observer / 'collector.log').read_text().splitlines()
    if completed.returncode == 0 and strict_lines:
        report = json.loads(strict_lines[-1])
        source = Path(report['output_directory']) / 'RESULTS.md'
        if not source.resolve().is_relative_to(collection) or source.resolve() != source:
            raise RuntimeError('Unexpected collector output')
        outcome['output_directory'] = report['output_directory']
        outcome['stage1_sft_completed'] = report['stage1_sft_completed']
        if report['stage1_sft_completed']:
            destination = collection / 'RESULTS.md'
            if not destination.exists():
                with source.open('rb') as src, destination.open('xb') as dst:
                    shutil.copyfileobj(src, dst)
                outcome['canonical_results_created'] = True
            else:
                outcome['canonical_results_preserved'] = True
    outcome['finished_utc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    with (observer / 'observer_result.json').open('x') as output:
        json.dump(outcome, output, ensure_ascii=False, indent=2)
    print(json.dumps(outcome, ensure_ascii=False), flush=True)
    return completed.returncode

if __name__ == '__main__':
    raise SystemExit(main())
