#!/usr/bin/env python3
"""Read only this task's aggregate progress; never print examples or token IDs."""
import datetime
import json
from pathlib import Path

ROOT = Path('/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009')
WORK = ROOT / 'training_kit/work'


def read(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return {}


def select(value, keys):
    return {key: value[key] for key in keys if key in value}


def progress(path):
    if not path.is_file():
        return None
    with path.open('rb') as stream:
        stream.seek(max(0, path.stat().st_size - 65536))
        lines = stream.read().decode(errors='replace').splitlines()
    for line in reversed(lines):
        try:
            item = json.loads(line)
        except ValueError:
            continue
        if isinstance(item, dict) and item.get('event') in ('tokenized', 'evaluation_progress'):
            return select(item, ('event', 'split', 'rows', 'rows_completed', 'total_rows',
                                 'supervised_tokens', 'elapsed_seconds'))
    return None


result = {'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'probes': []}
for path in sorted((ROOT / 'work/probes').glob('*/result.json'))[-5:]:
    item = read(path)
    result['probes'].append({'id': path.parent.name, **select(item, (
        'status', 'arguments', 'microsteps_completed', 'optimizer_steps_completed',
        'actual_generated_tokens', 'actual_total_tokens', 'error_type', 'oom',
        'measured_phase_seconds', 'gpu_memory', 'prefill_parity'))})
result['token_preparation'] = progress(ROOT / 'work/collection/prepare-long-tokens-28672.log')
tokens = read(WORK / 'tokens/manifest.json')
result['token_cache'] = select(tokens, ('status', 'bindings', 'files', 'rebind_provenance'))
qualification = read(WORK / 'qualification.json')
result['qualification'] = {**select(qualification, ('status', 'error_type', 'optimizer_steps')),
                          'checks': [select(item, ('name', 'passed')) for item in qualification.get('checks', [])]}
for name in ('canary', 'training'):
    result[name] = select(read(WORK / name / 'TRAINING_RESULT.json'), (
        'status', 'completed_optimizer_steps', 'next_row_cursor', 'total_rows', 'epoch_completed'))
    log = WORK / name / 'train.jsonl'
    if log.is_file():
        with log.open('rb') as stream:
            stream.seek(max(0, log.stat().st_size - 8192))
            for line in reversed(stream.read().splitlines()):
                try:
                    result[name]['latest_logged_step'] = select(json.loads(line), (
                        'step', 'next_row_cursor', 'microbatches', 'supervised_tokens',
                        'target_mean_loss', 'elapsed_seconds'))
                    break
                except ValueError:
                    pass
result['baseline_exists'] = (WORK / 'validation_B0.json').is_file()
result['final_evaluation_exists'] = (WORK / 'validation_B1.json').is_file()
result['completion_marker_exists'] = (WORK / 'COMPLETE.json').is_file()
print(json.dumps(result, ensure_ascii=False, indent=2))
