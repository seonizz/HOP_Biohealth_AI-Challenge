#!/usr/bin/env python3
"""Preserve the complete local dataset collection; never contact a server."""
from collections import Counter
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'data/데이터셋'
OUT = ROOT / 'training_data/full_training_20261022'
ARCHIVE = ROOT / 'training_data/malssi_full_training_20261022.zip'
SFT = SOURCE / '말씨_원본상담_SFT_v1_20261009'
ADMISSION = SOURCE / '문장별_데이터셋/malssi_partial_exposure_20261015/admission'


def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def identity(row):
    return tuple(row[k] for k in ('id', 'split', 'source_group_id', 'source_conversation_id'))


def materialize():
    pins = {'admission_policy.json': '36b03947e5176bd86f9fd621d49935cd67c51481b99334f6f09c143b510aa687',
            'admission_rows.jsonl.gz': '7b84f39fc689b9628b42040e3217f3626f0d178d64921a733f6608a234ee731a'}
    for name, expected in pins.items():
        require(sha(ADMISSION / name) == expected, 'Admission input changed')
    policy = json.loads((ADMISSION / 'admission_policy.json').read_text())
    require(sha(SFT / 'manifest.json') == policy['input_manifest_sha256'], 'SFT manifest changed')
    with gzip.open(ADMISSION / 'admission_rows.jsonl.gz', 'rt') as f:
        ledger = [json.loads(line) for line in f]
    by_id = {r['id']: r for r in ledger}
    require(len(by_id) == len(ledger) == 45974, 'Ledger ID count changed')
    seen, counts, line_hashes = set(), Counter(), {}
    for split in ('train', 'validation'):
        source = SFT / f'conversation/{split}.jsonl.gz'
        require(sha(source) == policy['verified_release_files'][f'conversation/{split}.jsonl.gz'], 'Source changed')
        handles = {}
        for category in ('content_admitted', 'held_do_not_train'):
            folder = OUT / 'derived' / category
            folder.mkdir(parents=True, exist_ok=True)
            handles[category] = gzip.GzipFile(filename=str(folder / (split + '.jsonl.gz')), mode='xb', compresslevel=3, mtime=0)
            line_hashes[(category, split)] = hashlib.sha256()
        try:
            with gzip.open(source, 'rb') as stream:
                for line in stream:
                    row = json.loads(line)
                    decision = by_id[row['id']]
                    require(row['id'] not in seen and identity(row) == identity(decision) and row['split'] == split,
                            'Source/decision identity differs')
                    seen.add(row['id'])
                    require(row['loss_message_mask'] == [0] * (len(row['messages']) - 1) + [1], 'Target mask changed')
                    admitted = decision['admitted'] is True
                    require((decision['status'] == 'admitted' and decision['reasons'] == []) == admitted,
                            'Inconsistent admission')
                    category = 'content_admitted' if admitted else 'held_do_not_train'
                    handles[category].write(line)  # Preserve original JSONL bytes and order.
                    line_hashes[(category, split)].update(line)
                    counts[(category, split)] += 1
        finally:
            for handle in handles.values():
                handle.close()
    require(seen == set(by_id), 'Not all source rows were accounted for')
    expected = {('content_admitted','train'):40415, ('content_admitted','validation'):4289,
                ('held_do_not_train','train'):237, ('held_do_not_train','validation'):1033}
    require(dict(counts) == expected, 'Unexpected filtered row counts')
    # Independently read back generated gzip streams, binding each exact row byte.
    for (category, split), expected_digest in line_hashes.items():
        h, count = hashlib.sha256(), 0
        with gzip.open(OUT / f'derived/{category}/{split}.jsonl.gz', 'rb') as stream:
            for line in stream:
                h.update(line)
                count += 1
        require(h.hexdigest() == expected_digest.hexdigest() and count == counts[(category, split)],
                'Filtered output read-back differs')
    report = {'original_rows':45974, 'source_bytes_and_order_preserved':True,
        'content_admitted': {'train':40415, 'validation':4289},
        'held_do_not_train': {'train':237, 'validation':1033},
        'token_length_gate_pending':True, 'training_or_clinical_approval':False,
        'policy_sha256':pins['admission_policy.json'], 'ledger_sha256':pins['admission_rows.jsonl.gz'],
        'uncompressed_sha256': {category+'/'+split: h.hexdigest() for (category,split),h in line_hashes.items()}}
    save(OUT / 'FILTER_VERIFICATION.json', report)
    print(json.dumps({'stage':'filtered_source_preserved','admitted':44704,'held':1270}), flush=True)


def main():
    os.umask(0o077)
    require(not OUT.exists() and not ARCHIVE.exists(), 'Output already exists')
    subprocess.run(['git','check-ignore','--quiet',str(ARCHIVE)],cwd=ROOT,check=True)
    OUT.mkdir()
    materialize()
    (OUT / 'README.md').write_bytes((ROOT / 'ai/scripts/full_training_README.md').read_bytes())
    inputs, exclusions = {}, []
    for path in sorted(SOURCE.rglob('*')):
        relative = path.relative_to(SOURCE)
        if path.is_symlink():
            exclusions.append({'path':str(relative),'reason':'duplicate_archive_symlink'})
        elif path.is_file():
            if '__pycache__' in relative.parts or path.name == '.DS_Store' or path.suffix in {'.pyc','.log'}:
                exclusions.append({'path':str(relative),'reason':'cache_or_execution_log'})
                continue
            require(not path.name.startswith('.env') and path.suffix not in {'.key','.pem'}, 'Unexpected credential file')
            inputs['datasets/' + relative.as_posix()] = path
    # Code/config/docs needed to interpret the historical packages; no models/caches.
    for folder in ('counseling_pipeline', 'scripts', 'config', 'docs/support_agent'):
        for path in sorted((ROOT / 'data' / folder).rglob('*')):
            if path.is_file() and not path.is_symlink() and path.suffix in {'.py','.mjs','.js','.json','.md','.yaml','.yml','.toml','.txt'}:
                inputs['reference_pipeline/' + path.relative_to(ROOT / 'data').as_posix()] = path
    small = ROOT / 'training_data/malssi_training_bundle_20261022.zip'
    require(small.is_file(), 'Missing separate 575-row bundle')
    inputs['focused_575/' + small.name] = small
    inputs['focused_575/' + small.with_suffix('.zip.sha256').name] = small.with_suffix('.zip.sha256')
    for p in sorted(OUT.rglob('*')):
        if p.is_file():
            inputs[p.relative_to(OUT).as_posix()] = p
    # Never copy a database with an outstanding journal into an ambiguous snapshot.
    for path in inputs.values():
        if path.suffix == '.sqlite':
            for suffix in ('-wal','-journal'):
                companion = Path(str(path) + suffix)
                require(not companion.exists() or companion.stat().st_size == 0, 'Active database journal; stop export')
    inventory = {}
    temporary = ARCHIVE.with_suffix('.zip.partial')
    require(not temporary.exists(), 'Prior partial archive exists')
    with zipfile.ZipFile(temporary,'x',allowZip64=True,compression=zipfile.ZIP_DEFLATED,compresslevel=1) as archive:
        for index,(name,path) in enumerate(inputs.items(),1):
            before = path.stat()
            h = hashlib.sha256()
            info = zipfile.ZipInfo('full_training_20261022/' + name)
            info.compress_type = zipfile.ZIP_STORED if path.suffix in {'.gz','.zip','.npz','.png','.jpg','.pdf'} else zipfile.ZIP_DEFLATED
            info._compresslevel = 1
            info.external_attr = 0o100600 << 16
            with path.open('rb') as src, archive.open(info,'w',force_zip64=True) as dst:
                for block in iter(lambda:src.read(4*1024*1024),b''):
                    h.update(block)
                    dst.write(block)
            after = path.stat()
            require((before.st_size,before.st_mtime_ns,before.st_ctime_ns,before.st_ino) ==
                    (after.st_size,after.st_mtime_ns,after.st_ctime_ns,after.st_ino), 'Input changed during archive')
            inventory[name] = {'bytes':before.st_size,'sha256':h.hexdigest(),
                               'source':str(path.relative_to(ROOT))}
            if index % 100 == 0:
                print(json.dumps({'stage':'archiving','files':index,'total_files':len(inputs)}),flush=True)
        # Bind the original SFT payload to its original publisher manifest.
        sft_manifest = json.loads((SFT/'manifest.json').read_text())
        for name, value in sft_manifest['files'].items():
            recorded = inventory['datasets/말씨_원본상담_SFT_v1_20261009/'+name]
            require(recorded['sha256'] == value['sha256'] and recorded['bytes'] == value['bytes'], 'SFT archive identity differs')
        manifest = {'schema':'malssi-full-training-archive-v1','date':'2026-10-22',
            'files':inventory,'excluded_non_dataset_files':exclusions,
            'dataset_tree_complete_except_listed_exclusions':True,
            'automatic_training_merge':False,'source_sft_rows':45974,
            'source_auxiliary_sentence_rows':513170,'source_auxiliary_word_occurrences':4496325,
            'model_weights_included':False,'remote_server_contacted':False}
        save(OUT/'FULL_MANIFEST.json',manifest)
        archive.write(OUT/'FULL_MANIFEST.json','full_training_20261022/FULL_MANIFEST.json')
    print(json.dumps({'stage':'verifying_archive','files':len(inventory)}),flush=True)
    with zipfile.ZipFile(temporary) as archive:
        require(len(archive.infolist()) == len(inventory) + 1, 'Unexpected ZIP item count')
        require(archive.read('full_training_20261022/FULL_MANIFEST.json') ==
                (OUT/'FULL_MANIFEST.json').read_bytes(), 'Manifest round-trip mismatch')
        for name, expected in inventory.items():
            h, size = hashlib.sha256(), 0
            with archive.open('full_training_20261022/'+name) as f:
                for block in iter(lambda:f.read(4*1024*1024),b''):
                    h.update(block);size+=len(block)
            require(h.hexdigest()==expected['sha256'] and size==expected['bytes'], 'Archive round-trip mismatch')
    temporary.rename(ARCHIVE)
    report = {'status':'passed','files':len(inventory),'source_bytes':sum(x['bytes'] for x in inventory.values()),
              'archive_bytes':ARCHIVE.stat().st_size,'archive_sha256':sha(ARCHIVE),
              'all_archived_bytes_read_back_and_hashed':True,
              'derived_rows':{'admitted':44704,'held':1270},'gpu_or_model_execution':False}
    save(OUT/'ARCHIVE_VERIFICATION.json',report)
    ARCHIVE.with_suffix('.zip.sha256').write_text(report['archive_sha256']+'  '+ARCHIVE.name+'\n')
    print(json.dumps(report,ensure_ascii=False),flush=True)


if __name__ == '__main__':
    main()
