#!/usr/bin/env python3
"""Materialize all eligible source training rows, followed by service correction.

Local CPU tokenization only. No model, SSH, GPU, training, or source mutations.
"""
from array import array
import argparse
from collections import Counter, deque
from concurrent.futures import ProcessPoolExecutor
from fractions import Fraction
import gzip
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SFT = ROOT / 'data/데이터셋/말씨_원본상담_SFT_v1_20261009'
POLICIES = ROOT / 'data/데이터셋/문장별_데이터셋'
ADMISSION = POLICIES / 'malssi_partial_exposure_20261015/admission'
COMPOSITION = POLICIES / 'composition_v2_20261016/source'
SMALL = ROOT / 'training_data/portable_training_20261022'
TOKENIZER = SMALL / 'original/v11/tokenizer'
COUNTS = {'01_original': {'train': 37083, 'validation': 3618},
          '02a_supporter': {'train': 43, 'validation': 29},
          '02b_service_wire': {'train': 123, 'validation': 33},
          'aux_sentence': {'train': 86, 'validation': 59},
          'aux_word': {'train': 102, 'validation': 76},
          'aux_state_observations': {'train': 6, 'validation': 6},
          'aux_relationship_memory': {'train': 6, 'validation': 6}}
SELECTED_IDS = {'train': '7190e6cc5872e5ee281be92333dd2abf620cf47d20b51a41c89091462f4a269f',
                'validation': '84402944f287a5a7375624e27ee598e3c6a9052fe9fecb1d99ef3cd755c200e2'}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def read_rows(path):
    opener = gzip.open if path.suffix == '.gz' else open
    with opener(path, 'rb') as f:
        for line in f:
            require(line.endswith(b'\n') and line.strip(), 'Blank/incomplete JSONL row')
            yield json.loads(line), line


def initializer():
    os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1',
                      HF_HUB_DISABLE_TELEMETRY='1', TOKENIZERS_PARALLELISM='false')
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(ROOT / 'data'))
    from transformers import AutoTokenizer
    from counseling_pipeline.gemma4_token_validation import encode_example
    global tokenizer, encode
    tokenizer = AutoTokenizer.from_pretrained(str(TOKENIZER), local_files_only=True, trust_remote_code=False)
    encode = encode_example


def encode_batch(batch):
    result = []
    for row, historical in batch:
        encoded = encode(row, tokenizer, 69632)
        for field in ('sequence_length', 'prefix_length', 'target_length'):
            require(encoded[field] == historical[field], 'Fresh token lengths differ: ' + row['row_id'])
        require(encoded['prefix_length'] <= 61440 and encoded['target_length'] <= 8192,
                'Generation budget exceeded; never truncate')
        if 'input_ids' in historical:
            require(encoded['input_ids'] == historical['input_ids'], 'Service token IDs changed')
        result.append((row, {k: v for k, v in encoded.items() if k not in ('labels', 'attention_mask')}))
    return result


def encode_ordered(executor, source):
    """Bound in-flight full-context rows; executor.map eagerly loads on Python 3.12."""
    pending, batch = deque(), []
    for pair in source:
        batch.append(pair)
        if len(batch) == 16:
            pending.append(executor.submit(encode_batch, batch))
            batch = []
            if len(pending) >= 8:
                yield from pending.popleft().result()
    if batch:
        pending.append(executor.submit(encode_batch, batch))
    while pending:
        yield from pending.popleft().result()


def normalized_source(row, line, ledger):
    return {'row_id': row['id'], 'task': row['task'], 'split': row['split'],
            'messages': row['messages'], 'loss_message_mask': row['loss_message_mask'],
            'weight': {'numerator': 1, 'denominator': 1},
            'source_group_ids': [row['source_group_id']],
            'source_root_ids': [row['source_conversation_id']],
            'source_row_sha256': digest(line), 'target_sha256': row['target_sha256'],
            'source_metadata': {k: v for k, v in row.items() if k not in ('messages', 'loss_message_mask')},
            'review_flags': ledger['review_reasons']}


def original_rows(split, ledger, admissions, decisions, selected):
    seen = set()
    for row, line in read_rows(SFT / f'conversation/{split}.jsonl.gz'):
        rid = row['id']
        require(rid not in seen, 'Duplicate original ID')
        seen.add(rid)
        meta, admission = ledger[rid], admissions[rid]
        for field in ('id', 'split', 'source_group_id', 'source_conversation_id'):
            require(row[field] == meta[field] == admission[field], 'Source identity differs')
        require(row['split'] == split and digest(line) == meta['source_row_sha256'], 'Original source row changed')
        require(row['target_sha256'] == digest(row['messages'][-1]['content'].encode()), 'Target content changed')
        require(row['loss_message_mask'] == [0] * (len(row['messages']) - 1) + [1], 'Source mask changed')
        require(admission['admitted'] == meta['source_admitted'] and admission['reasons'] == meta['source_reasons'],
                'Admission decision changed')
        reasons = list(admission['reasons'])
        if 'prior_assistant_medical_pattern' in meta['context_flags']:
            reasons.append('medical_context_requires_review')
        require(meta['tokenizer_status'] == 'encoded' and reasons == meta['hold_reasons'], 'Unaccounted hold')
        include = not reasons
        require(include == meta['eligible'], 'Full-pool eligibility differs')
        decisions.write(canonical({'row_id': rid, 'split': split, 'included': include,
                                   'reasons': reasons, 'source_row_sha256': digest(line)}) + b'\n')
        if include:
            selected[split].append(rid)
            yield normalized_source(row, line, meta), meta
    require(len(seen) == (40652 if split == 'train' else 5322), 'Original split count changed')


def service_rows(dataset, task, split, entries):
    for row, line in read_rows(SMALL / f'data/{dataset}/{task}/{split}.jsonl'):
        require(row['task'] == task and row['split'] == split, 'Service task/split changed')
        encoded = entries[(task, split, row['row_id'])]
        require(row['weight'] == encoded['weight'], 'Service weight changed')
        yield {**row, 'source_row_sha256': digest(line),
               'target_sha256': digest(row['messages'][-1]['content'].encode())}, encoded['encoded']


def write_split(output, phase, split, encoded_rows):
    folder = output / 'data' / phase
    folder.mkdir(parents=True, exist_ok=True)
    names = {kind: f'data/{phase}/{split}.{suffix}' for kind, suffix in
             [('messages', 'messages.jsonl.gz'), ('index', 'index.jsonl'), ('tokens', 'tokens.bin')]}
    count, offset, target_total, long_rows, maximum, weight_mass = 0, 0, 0, 0, 0, Fraction()
    with gzip.GzipFile(filename=str(output / names['messages']), mode='xb', compresslevel=3, mtime=0) as messages, \
            (output / names['index']).open('xb') as index, (output / names['tokens']).open('xb') as tokens:
        for row, encoded in encoded_rows:
            ids = array('I', encoded['input_ids'])
            require(ids.itemsize == 4, 'uint32 storage unavailable')
            if sys.byteorder != 'little':
                ids.byteswap()
            tokens.write(ids.tobytes())
            metadata = {k: row[k] for k in ('row_id', 'task', 'split', 'weight', 'source_group_ids',
                         'source_root_ids', 'source_row_sha256', 'target_sha256')}
            metadata.update({k: encoded[k] for k in ('sequence_length', 'prefix_length', 'target_length')})
            metadata.update(offset_tokens=offset, messages_sha256=digest(canonical(row['messages'])),
                            target_boundary_whitespace_trimmed=encoded['target_boundary_whitespace_trimmed'])
            messages.write(canonical(row) + b'\n')
            index.write(canonical(metadata) + b'\n')
            offset += encoded['sequence_length']
            target_total += encoded['target_length']
            weight_mass += Fraction(**row['weight']) * encoded['target_length']
            maximum = max(maximum, encoded['sequence_length'])
            long_rows += encoded['sequence_length'] > 4096
            count += 1
            if count % 5000 == 0:
                print(json.dumps({'phase': phase, 'split': split, 'encoded_rows': count}), flush=True)
    require(count == COUNTS[phase][split], 'Entire split was not materialized')
    require(weight_mass == target_total, 'Weighted target mass differs from original')
    return {**names, 'rows': count, 'sequence_tokens': offset, 'target_tokens': target_total,
            'max_sequence_length': maximum, 'rows_over_4096': long_rows}


def build(output, workers):
    os.umask(0o077)
    require(1 <= workers <= 8, 'Use between one and eight CPU workers')
    require(output.parent.resolve() == ROOT / 'training_data' and not output.exists(), 'Use a fresh ignored training_data child')
    subprocess.run(['git', 'check-ignore', '--quiet', str(output / 'rows.jsonl')], cwd=ROOT, check=True)
    pins = {SFT / 'manifest.json': '5928bc8c03263a538411d5f7d2bb5a942589b263ce2e0c9e2a253f60ee9f1dac',
            ADMISSION / 'admission_policy.json': '36b03947e5176bd86f9fd621d49935cd67c51481b99334f6f09c143b510aa687',
            ADMISSION / 'admission_rows.jsonl.gz': '7b84f39fc689b9628b42040e3217f3626f0d178d64921a733f6608a234ee731a',
            COMPOSITION / 'export_manifest.json': '225d3241e6c143b4f855af6d8eccbfdb5a8cd555d2ea55af7c1f4bfce15662d4',
            COMPOSITION / 'selection_ledger.jsonl.gz': '8d14d30161d69a17648ce35a48db017c5bd16c4270c4975197ad50356083223c'}
    manifest = json.loads((SFT / 'manifest.json').read_text())
    for split in ('train', 'validation'):
        key = f'conversation/{split}.jsonl.gz'
        pins[SFT / key] = manifest['files'][key]['sha256']
    small_manifest = json.loads((SMALL / 'DATASET_MANIFEST.json').read_text())
    pins[SMALL / 'DATASET_MANIFEST.json'] = sha(SMALL / 'DATASET_MANIFEST.json')
    for name, info in small_manifest['files'].items():
        pins[SMALL / name] = info['sha256']
    pins[ROOT / 'data/counseling_pipeline/gemma4_token_validation.py'] = sha(ROOT / 'data/counseling_pipeline/gemma4_token_validation.py')
    for path, expected in pins.items():
        require(sha(path) == expected, 'Bound source changed: ' + str(path))
    ledger = {r['id']: r for r, _ in read_rows(COMPOSITION / 'selection_ledger.jsonl.gz')}
    admissions = {r['id']: r for r, _ in read_rows(ADMISSION / 'admission_rows.jsonl.gz')}
    require(len(ledger) == len(admissions) == 45974 and set(ledger) == set(admissions), 'Ledger completeness differs')
    output.mkdir()
    (output / 'provenance').mkdir()
    for path, name in [(SFT / 'manifest.json', 'original_sft_manifest.json'),
                       (ADMISSION / 'admission_policy.json', 'admission_policy.json'),
                       (ADMISSION / 'admission_rows.jsonl.gz', 'admission_rows.jsonl.gz'),
                       (COMPOSITION / 'selection_ledger.jsonl.gz', 'full_pool_ledger.jsonl.gz'),
                       (COMPOSITION / 'export_manifest.json', 'historical_composition_manifest.json')]:
        shutil.copyfile(path, output / 'provenance' / name)
    shutil.copytree(TOKENIZER, output / 'tokenizer')
    entries = {}
    for dataset in ('v11', 'r7'):
        for row, _ in read_rows(SMALL / f'encoded/{dataset}.jsonl'):
            key = row['stream'], row['split'], row['row_id']
            require(key not in entries, 'Duplicate service entry')
            entries[key] = row
    specs = [('01_original', 'original_counselor_continuation', None, None),
             ('02a_supporter', 'conversation', 'v11', '01_original'),
             ('02b_service_wire', 'relationship_agent_wire', 'r7', '02a_supporter')]
    specs += [('aux_' + task, task, 'v11', None) for task in
              ('sentence', 'word', 'state_observations', 'relationship_memory')]
    phases, selected = [], {'train': [], 'validation': []}
    with ProcessPoolExecutor(max_workers=workers, initializer=initializer,
                             mp_context=multiprocessing.get_context('spawn')) as pool, \
            gzip.GzipFile(filename=str(output / 'provenance/source_decisions.jsonl.gz'),
                          mode='xb', compresslevel=3, mtime=0) as decisions:
        for phase, task, dataset, parent in specs:
            data = {}
            for split in ('train', 'validation'):
                source = (original_rows(split, ledger, admissions, decisions, selected) if dataset is None
                          else service_rows(dataset, task, split, entries))
                data[split] = write_split(output, phase, split, encode_ordered(pool, source))
            phases.append({'id': phase, 'task': task, 'data': data, 'initial_adapter_from': parent,
                           'weighting': 'uniform_target_tokens' if dataset is None else 'preserve_frozen_per_task_split_rational_weights',
                           'new_lora': phase == '01_original', 'fresh_optimizer_at_phase_start': True,
                           'checkpoint_binding': 'preceding_phase_newly_produced_adapter_sha256' if parent else None})
            print(json.dumps({'phase_complete': phase, 'counts': {s: v['rows'] for s, v in data.items()}}), flush=True)
    for split, ids in selected.items():
        require(digest(''.join(x + '\n' for x in sorted(ids)).encode()) == SELECTED_IDS[split], 'Full eligible ID set changed')
    for path, expected in pins.items():
        require(sha(path) == expected, 'Source changed during export')
    course = {'schema': 'malssi-two-stage-training-v1', 'phases': phases[:3], 'optional_auxiliary': phases[3:],
              'logical_stages': {'1': ['01_original'], '2': ['02a_supporter', '02b_service_wire']},
              'token_storage': 'little_endian_uint32_contiguous_no_padding',
              'label_rule': '[-100] * prefix_length + input_ids[prefix_length:]; no pre-shift',
              'serialization': 'pinned_gemma4_nonthinking_generation_prefix_plus_native_completion',
              'tokenizer_sha256': {p.name: sha(p) for p in (output / 'tokenizer').iterdir() if p.is_file()},
              'model_context': {'max_sequence_length': 69632, 'max_input_tokens': 61440, 'max_output_tokens': 8192,
                                'recommended_training_capacity': 32768},
              'truncation': False, 'packing': False, 'sampling': False, 'split_reassignment': False,
              'validation_used_for_gradient': False, 'full_train_iteration_required_each_epoch': True,
              'old_r7_or_step100_adapter_required': False, 'model_weights_included': False,
              'training_started': False, 'data_export_remote_server_contacted': False,
              'gpu_training_server_contacted': False,
              'authorization': 'User requested local data preparation for full-train then service correction on 2026-10-22; GPU remains prohibited.',
              'quality_acceptance': 'Compare stage1 and service-corrected final conclusions on unchanged held-out evaluation before deployment; no automatic promotion.',
              'notes': ['Auxiliary tasks are retained separately and are not mixed into the default language-model chain.',
                        'Historical training_authorized flags in provenance are preserved; no new clinical or human approval is asserted.']}
    save(output / 'COURSE.json', course)
    save(output / 'provenance/SOURCE_HASHES.json', {str(p.relative_to(ROOT)): h for p, h in pins.items()})
    save(output / 'BUILD_COMPLETE.json', {'status': 'data_built', 'phase_counts': COUNTS,
         'selected_id_set_sha256': SELECTED_IDS, 'raw_source_rows': {'train': 40652, 'validation': 5322},
         'excluded': {'admission': {'train': 237, 'validation': 1033},
                      'additional_medical_context_review': {'train': 3332, 'validation': 671}},
         'all_eligible_source_rows_reencoded': True, 'service_rows_reencoded_equal_original_ids': True,
         'model_or_gpu_used': False, 'source_files_unchanged': True})


def finish(output):
    require(output.parent.resolve() == ROOT / 'training_data' and not output.is_symlink(),
            'Finalize only the ignored local training_data child')
    require((output / 'BUILD_COMPLETE.json').is_file(), 'Data build incomplete')
    built = json.loads((output / 'BUILD_COMPLETE.json').read_text())
    require(built.get('status') == 'data_built' and built.get('phase_counts') == COUNTS,
            'Build completion record is incomplete or from another inventory')
    require(not (output / 'DATASET_MANIFEST.json').exists(), 'Already finalized')
    (output / 'scripts').mkdir(exist_ok=True)
    for name in ('staged_dataset.py', 'test_staged_dataset.py', 'export_staged_training.py'):
        shutil.copyfile(ROOT / 'ai/scripts' / name, output / 'scripts' / name)
    shutil.copyfile(ROOT / 'ai/scripts/staged_training_README.md', output / 'README.md')
    shutil.copyfile(ROOT / 'data/counseling_pipeline/gemma4_token_validation.py', output / 'scripts/gemma4_token_validation.py')
    review = ROOT / 'runtime/two-stage-dataset-review-20261022/ADJUDICATION.json'
    require(review.is_file(), 'Missing requested model review adjudication')
    shutil.copyfile(review, output / 'provenance/REVIEW_DECISIONS.json')
    course = json.loads((output / 'COURSE.json').read_text())
    course.pop('remote_server_contacted', None)
    course.update(data_export_remote_server_contacted=False, gpu_training_server_contacted=False,
                  external_code_review=json.loads(review.read_text())['reviewer'])
    save(output / 'COURSE.json', course)
    (output / 'requirements-tokenizer.txt').write_text('transformers==5.17.0\ntokenizers==0.23.2\nhuggingface-hub==1.33.0\nJinja2==3.1.6\n')
    files = {str(p.relative_to(output)): {'bytes': p.stat().st_size, 'sha256': sha(p)}
             for p in sorted(output.rglob('*')) if p.is_file()}
    save(output / 'DATASET_MANIFEST.json', {'schema': 'malssi-two-stage-data-manifest-v1', 'files': files,
         'phase_counts': COUNTS, 'clinical_or_human_approval': False, 'independent_test_eligible': False})
    result = subprocess.run([sys.executable, '-B', str(output / 'scripts/staged_dataset.py'),
                             'verify', '--root', str(output)], check=True, capture_output=True, text=True)
    verification = json.loads(result.stdout)
    save(output / 'VERIFICATION.json', verification)
    print(result.stdout, flush=True)
    sums = {str(p.relative_to(output)): sha(p) for p in sorted(output.rglob('*')) if p.is_file()}
    (output / 'SHA256SUMS').write_text(''.join(h + '  ' + name + '\n' for name, h in sums.items()))
    archive = output.with_suffix('.zip')
    require(not archive.exists(), 'Archive already exists')
    temporary = archive.with_suffix('.zip.partial')
    with zipfile.ZipFile(temporary, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as z:
        for path in sorted(output.rglob('*')):
            if path.is_file():
                z.write(path, output.name + '/' + str(path.relative_to(output)))
    with zipfile.ZipFile(temporary) as z:
        require(len(z.namelist()) == len(sums) + 1, 'Archive inventory differs')
        for name in z.namelist():
            relative = name.removeprefix(output.name + '/')
            h = hashlib.sha256()
            with z.open(name) as f:
                for block in iter(lambda: f.read(4 * 1024 * 1024), b''):
                    h.update(block)
            require(h.hexdigest() == (sha(output / relative) if relative == 'SHA256SUMS' else sums[relative]),
                    'Archive payload changed')
    temporary.rename(archive)
    archive.with_suffix('.zip.sha256').write_text(sha(archive) + '  ' + archive.name + '\n')
    print(json.dumps({'status': 'complete', 'archive': str(archive), 'bytes': archive.stat().st_size}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('build', 'finish'))
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--workers', type=int, default=4)
    args = parser.parse_args()
    if args.command == 'build':
        build(args.output.absolute(), args.workers)
    else:
        finish(args.output.absolute())
