#!/usr/bin/env python3
"""Build the selected local v11 + r7 dataset handoff. No SSH or model calls."""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
V11 = ROOT / 'runtime/gpu-server-validation-20261017/portable-local-test'
R7 = ROOT / 'training_data/quality_grounding_pilot_20261018/admitted-wire-r7'
RUNNER = ROOT / 'runtime/scenario24-improvement-20261018-r7/quality-training'
V11_SHA = '7d1e112fcc2598a03c12683ec09a93746d5cda192007b435b0a40ce811d9dcf6'
R7_SHA = 'b141b0b1e660447f7d812877d44230a97a1d6bdb99ea330e4421601caf7713e9'


def sha(blob):
    return hashlib.sha256(blob).hexdigest()


def read(path, expected=None):
    if path.is_symlink() or not path.is_file():
        raise ValueError('Input is not a regular file: ' + str(path))
    blob = path.read_bytes()
    if expected and sha(blob) != expected:
        raise ValueError('Pinned input changed: ' + str(path))
    return blob


def jsonl(path):
    return [json.loads(line) for line in read(path).splitlines() if line.strip()]


def write_rows(path, values):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as f:
        for value in values:
            f.write(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')


def build(output):
    os.umask(0o077)
    output = output.absolute()
    if output.exists() or output.is_symlink() or output.parent.resolve() != ROOT / 'training_data':
        raise ValueError('Use a new direct child of the ignored training_data directory')
    subprocess.run(['git', 'check-ignore', '--quiet', str(output / 'rows.jsonl')], cwd=ROOT, check=True)
    output.mkdir()
    sources = {}

    def copy(path, name, expected=None):
        blob = read(path, expected)
        target = output / name
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as f:
            f.write(blob)
        sources[name] = {'source': str(path.relative_to(ROOT)), 'sha256': sha(blob)}

    read(V11 / 'bundle/policy/manifest.json', V11_SHA)
    transport = json.loads(read(V11 / 'bundle/transport_manifest.json'))
    for name, info in transport['files'].items():
        copy(V11 / 'bundle' / name, 'original/v11/' + name, info['sha256'])
    copy(V11 / 'bundle/transport_manifest.json', 'original/v11/transport_manifest.json')
    copy(V11 / 'output/entries.json', 'original/v11-encoded.json',
         'd4baacbd4da408f48bfcaee834683c107bee165be6997e126db483f7d114b556')
    r7 = json.loads(read(R7 / 'manifest.json', R7_SHA))
    copy(R7 / 'manifest.json', 'original/r7/manifest.json', R7_SHA)
    copy(R7 / 'rows.jsonl', 'original/r7/rows.jsonl', r7['rows']['sha256'])
    for name, pin in r7['source_files'].items():
        copy(R7 / name, 'original/r7/' + name, pin)
    for name, pin in r7['code_files'].items():
        copy(ROOT / 'data' / name, 'reference_code/' + name, pin)
    for name, pin in r7['runner_files'].items():
        copy(RUNNER / name, 'reference_code/' + name, pin)
    for name in ('portable_dataset.py', 'portable_train.py'):
        copy(ROOT / 'ai/scripts' / name, 'scripts/' + name)
    for name in ('test_portable_train.py',):
        copy(ROOT / 'ai/scripts' / name, 'scripts/' + name)

    v11_entries = json.loads(read(V11 / 'output/entries.json'))['entries']
    weight_map = {(e['stream'], e['split'], e['row_id']): e['weight'] for e in v11_entries}
    v11_rows = []
    for path in sorted((V11 / 'bundle/source').rglob('*.jsonl')):
        if path.name not in ('train.jsonl', 'validation.jsonl'):
            continue
        for row in jsonl(path):
            task, identity = row.get('task', row.get('unit')), row.get('row_id', row.get('candidate_id'))
            mask = row.get('loss_message_mask', row.get('loss_mask', {}).get('values'))
            v11_rows.append({'row_id': identity, 'task': task, 'split': row['split'],
                'messages': row['messages'], 'loss_message_mask': mask,
                'weight': weight_map[(task, row['split'], identity)],
                'source_group_ids': row['source_group_ids'], 'source_root_ids': row['source_root_ids']})
    if len(v11_rows) != 419:
        raise ValueError('v11 row inventory differs')
    write_rows(output / 'encoded/v11.jsonl', v11_entries)

    # Tokenizer only. Original audited conversion and family-weight formula.
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
                      TOKENIZERS_PARALLELISM='false', PYTHONDONTWRITEBYTECODE='1')
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(output / 'reference_code'))
    from transformers import AutoTokenizer
    from counseling_pipeline import gemma4_token_validation as adapter
    from quality_training import encode_rows
    tokenizer = AutoTokenizer.from_pretrained(str(output / 'original/v11/tokenizer'),
                                              local_files_only=True, trust_remote_code=False)
    wire_rows = jsonl(R7 / 'rows.jsonl')
    r7_entries = encode_rows(wire_rows, tokenizer, adapter, 69632)
    write_rows(output / 'encoded/r7.jsonl', r7_entries)
    weights = {e['row_id']: e['weight'] for e in r7_entries}
    portable_wire = [{'row_id': row['row_id'], 'task': row['task'], 'split': row['split'],
        'messages': row['messages'], 'loss_message_mask': row['loss_message_mask'],
        'weight': weights[row['row_id']], 'source_group_ids': row['source_group_ids'],
        'source_root_ids': row['source_root_ids']} for row in wire_rows]
    datasets = {}
    for name, messages, entries in [('v11', v11_rows, v11_entries), ('r7', portable_wire, r7_entries)]:
        paths = []
        for task in sorted({row['task'] for row in messages}):
            for split in ('train', 'validation'):
                relative = f'data/{name}/{task}/{split}.jsonl'
                write_rows(output / relative, [r for r in messages if r['task'] == task and r['split'] == split])
                paths.append(relative)
        datasets[name] = {'encoded': f'encoded/{name}.jsonl', 'message_files': paths,
            'counts': dict(Counter(e['split'] for e in entries)),
            'max_sequence_length': max(e['encoded']['sequence_length'] for e in entries),
            'max_target_length': max(e['encoded']['target_length'] for e in entries),
            'tasks': sorted({e['stream'] for e in entries}), 'automatic_task_mixing': False}
    copy(ROOT / 'ai/outputs/dualgpu_maxctx_20261009/training_kit/config/requirements.server.freeze.txt',
         'environment/historical-server.freeze.txt')
    copy(ROOT / 'ai/scripts/portable_training_README.md', 'README.md')
    (output / 'environment/requirements-tokenizer.txt').write_text(
        'transformers==5.17.0\ntokenizers==0.23.2\nhuggingface-hub==1.33.0\nJinja2==3.1.6\n')
    (output / 'environment/requirements-training.txt').write_text(
        '# Install a platform-compatible PyTorch CUDA build separately. Historical: torch 2.13.0+cu126.\n'
        'transformers==5.17.0\ntokenizers==0.23.2\nhuggingface-hub==1.33.0\nJinja2==3.1.6\n'
        'peft==0.21.2\nbitsandbytes==0.50.2\naccelerate==1.15.0\nsafetensors==0.8.0\n')
    (output / 'SOURCE_MAP.json').write_text(json.dumps(sources, indent=2, ensure_ascii=False) + '\n')
    files = {str(p.relative_to(output)): {'sha256': sha(read(p)), 'bytes': p.stat().st_size}
             for p in sorted(output.rglob('*')) if p.is_file()}
    manifest = {'schema': 'malssi-portable-training-v1', 'created_date': '2026-10-22',
        'datasets': datasets, 'files': files, 'model_weights_included': False,
        'gpu_training_run_during_export': False, 'human_or_expert_approved': False,
        'independent_test_eligible': False, 'original_policy_manifest_sha256': V11_SHA,
        'original_wire_manifest_sha256': R7_SHA,
        'excluded': ['evaluation_24_cases', 'sealed_families', 'historical_failed_wire_versions',
                     'unreviewed_candidates', 'legacy_classifier_and_source_sft', 'credentials', 'model_weights']}
    (output / 'DATASET_MANIFEST.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + '\n')
    sums = {**files, 'DATASET_MANIFEST.json': {'sha256': sha(read(output / 'DATASET_MANIFEST.json'))}}
    (output / 'SHA256SUMS').write_text(''.join(v['sha256'] + '  ' + k + '\n' for k, v in sorted(sums.items())))
    subprocess.run([sys.executable, '-B', str(output / 'scripts/portable_dataset.py'), 'verify', '--root', str(output)], check=True)
    print(json.dumps({'output': str(output), 'datasets': datasets, 'files': len(files)}, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    build(parser.parse_args().output)
