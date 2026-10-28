#!/usr/bin/env python3
"""Offline integrity check and token preparation for the portable training bundle."""
import argparse
from collections import Counter
from fractions import Fraction
import hashlib
import json
import os
from pathlib import Path
import sys


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def rows(path):
    with path.open(encoding='utf-8') as f:
        return [json.loads(line) for line in f if line.strip()]


def verify(root):
    root = root.resolve(strict=True)
    manifest = json.loads((root / 'DATASET_MANIFEST.json').read_text())
    for name, info in manifest['files'].items():
        p = root / name
        if p.is_symlink() or not p.resolve().is_relative_to(root):
            raise ValueError('Unsafe bundle path')
        if not p.is_file() or p.stat().st_size != info['bytes'] or digest(p) != info['sha256']:
            raise ValueError('File checksum mismatch: ' + name)
    for dataset, expected in manifest['datasets'].items():
        entries = rows(root / expected['encoded'])
        source_rows = []
        for path in expected['message_files']:
            source_rows += rows(root / path)
        keys = lambda r: (r['task'], r['split'], r['row_id'])
        mapping = {keys(r): r for r in source_rows}
        if len(mapping) != len(source_rows):
            raise ValueError('Duplicate source row')
        counts, seen, groups = Counter(), set(), {'train': set(), 'validation': set()}
        for entry in entries:
            task, split, identity = entry['stream'], entry['split'], entry['row_id']
            key = task, split, identity
            if split not in groups or key in seen or key not in mapping:
                raise ValueError('Invalid encoded row identity')
            seen.add(key)
            row = mapping[key]
            if row['loss_message_mask'] != [0] * (len(row['messages']) - 1) + [1]:
                raise ValueError('Loss message mask changed')
            groups[split].update(row['source_group_ids'])
            groups[split].update(row['source_root_ids'])
            encoded = entry['encoded']
            ids, labels, mask = (encoded[k] for k in ('input_ids', 'labels', 'attention_mask'))
            n, prefix = encoded['sequence_length'], encoded['prefix_length']
            if not (len(ids) == len(labels) == len(mask) == n and 0 < prefix < n):
                raise ValueError('Invalid token lengths')
            if labels != [-100] * prefix + ids[prefix:] or mask != [1] * n:
                raise ValueError('Loss token mask changed')
            if encoded['target_length'] != n - prefix or any(type(t) is not int or not 0 <= t < 262144 for t in ids):
                raise ValueError('Invalid target/token vocabulary')
            w = entry['weight']
            if Fraction(w['numerator'], w['denominator']) <= 0 or w != row['weight']:
                raise ValueError('Weight changed')
            counts[split] += 1
        if dict(counts) != expected['counts'] or seen != set(mapping) or groups['train'] & groups['validation']:
            raise ValueError('Split, group, or row inventory changed')
    return {'status': 'passed', 'checked_files': len(manifest['files']),
            'datasets': {k: v['counts'] for k, v in manifest['datasets'].items()},
            'gpu_used': False, 'model_loaded': False}


def prepare_wire(root, output):
    """Retokenize with original audited functions; never imports a GPU backend."""
    verify(root)
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      HF_HUB_DISABLE_TELEMETRY='1', TOKENIZERS_PARALLELISM='false')
    sys.path.insert(0, str(root / 'reference_code'))
    from transformers import AutoTokenizer
    from counseling_pipeline import gemma4_token_validation as adapter
    from quality_training import encode_rows
    tokenizer = AutoTokenizer.from_pretrained(str(root / 'original/v11/tokenizer'),
                                              local_files_only=True, trust_remote_code=False)
    entries = encode_rows(rows(root / 'original/r7/rows.jsonl'), tokenizer, adapter, 69632)
    if entries != rows(root / 'encoded/r7.jsonl'):
        raise ValueError('Re-encoded rows differ from exported token/weight inventory')
    with output.open('x', encoding='utf-8') as f:
        for row in entries:
            f.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
    return {'status': 'passed', 'rows': len(entries), 'output_sha256': digest(output)}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['verify', 'prepare-wire'])
    p.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    p.add_argument('--output', type=Path)
    args = p.parse_args()
    if args.command == 'prepare-wire' and args.output is None:
        p.error('--output is required')
    result = verify(args.root) if args.command == 'verify' else prepare_wire(args.root.resolve(), args.output)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
