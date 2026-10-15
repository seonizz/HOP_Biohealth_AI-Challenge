#!/usr/bin/env python3
"""One-shot local completion hook; never submits model/API requests."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
from pathlib import Path
import subprocess
import sys
import time


NODE = Path('/Users/chihun/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node')
MARKER = Path('/Users/chihun/.codex/plugins/cache/openai-primary-runtime/spreadsheets/26.1007.11041/skills/spreadsheets/container_tools/mark_artifact_operation_started.mjs')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    parser.add_argument('presentation', type=Path)
    args = parser.parse_args()
    run, presentation = args.run.resolve(), args.presentation.resolve()
    state_path = run / 'COMPLETION_HOOK.json'
    lock = (run / '.completion_hook.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if state_path.exists():
        previous = json.loads(state_path.read_text())
        if previous.get('state') not in ('waiting',):
            raise RuntimeError('Existing hook state requires inspection; no automatic rerun')

    def state(stage, **details):
        value = {'state': stage, 'updated_at': datetime.now(timezone.utc).isoformat(),
                 'run': str(run), 'presentation': str(presentation),
                 'scope': 'Saved local files only; zero model/API requests', **details}
        temporary = state_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
        temporary.replace(state_path)
        print(json.dumps(value, ensure_ascii=False), flush=True)

    def execute(command, name):
        with (run / 'evidence' / name).open('w') as log:
            subprocess.run(command, cwd=Path(__file__).resolve().parent.parent,
                           stdout=log, stderr=subprocess.STDOUT, check=True)

    try:
        state('waiting')
        while True:
            try:
                completion = json.loads((run / 'COLLECTION_COMPLETE.json').read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                time.sleep(1)
                continue
            if completion['state'] in ('blocked', 'interrupted', 'partial'):
                raise RuntimeError('Collector requires inspection: ' + str(completion.get('reason')))
            if completion['state'] == 'complete':
                if not (completion['full_94_collected'] and completion['ledger_records'] == 94
                        and completion['attempted'] == 94 and completion['unexecuted'] == 0):
                    raise RuntimeError('Completion signal does not establish all 94 first attempts')
                break
            time.sleep(1)
        state('verifying')
        execute([sys.executable, str(Path(__file__).with_name('verify_ft31_measurements.py')), str(run)],
                'completion_verification.log')
        verification = json.loads((run / 'verification.json').read_text())
        if not verification.get('verified') or not verification.get('collection_complete'):
            raise RuntimeError('Saved measurement verification did not pass')
        state('building_excel')
        marker_record = run / 'evidence/artifact_operation_marker.json'
        if marker_record.exists():
            raise RuntimeError('Artifact marker already exists; inspect before rerunning')
        execute([str(NODE), str(MARKER), '--operation-kind', 'create',
                 '--expected-output-count', '1', '--output-format', 'xlsx'], 'artifact_operation_marker.log')
        marker_record.write_text(json.dumps({'operation': 'create', 'format': 'xlsx', 'count': 1,
                                             'recorded_at': datetime.now(timezone.utc).isoformat()}) + '\n')
        execute([str(NODE), str(presentation / 'build_datasheet.mjs'), '--ft31', str(run),
                 '--output', str(presentation / 'FT31_STEP100_데이터시트.xlsx')], 'build_datasheet.log')
        state('awaiting_visual_verification', previews=['summary_preview.png', 'cases_preview.png', 'ft31_preview.png'])
    except Exception as exc:
        state('failed', error=type(exc).__name__ + ': ' + str(exc))
        raise


if __name__ == '__main__':
    main()
