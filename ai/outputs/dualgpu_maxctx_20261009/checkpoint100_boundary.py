"""Reversible stop after checkpoint commit, before the next optimizer window.

The pinned loop commits checkpoint100 before replacing its convenience pointer.
An owned directory at that pointer makes that replacement fail synchronously.
No process is signalled, no training code changes, and no step101 can begin.
"""
import hashlib
import json
import os
from pathlib import Path
import uuid


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def read(path):
    return json.loads(Path(path).read_text())


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_bytes(path, data):
    path = Path(path)
    temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    sync_directory(path.parent)


def atomic_json(path, value):
    atomic_bytes(path, canonical(value) + b'\n')


def last_record(training):
    path = Path(training) / 'train.jsonl'
    if not path.is_file():
        return {}
    with path.open('rb') as stream:
        stream.seek(max(0, path.stat().st_size - 16384))
        lines = stream.read().splitlines()
    for line in reversed(lines):
        try:
            value = json.loads(line)
            if value.get('mode') == 'train':
                return value
        except ValueError:
            pass
    return {}


def arm(training, audit):
    training, audit = Path(training), Path(audit)
    require(training == training.resolve() and audit == audit.resolve(), 'Unsafe boundary paths')
    require(last_record(training).get('step', 0) < 98, 'Too close to checkpoint100 to install a guard')
    require(not (training / 'checkpoints/step-000000100').exists(), 'Checkpoint100 already exists')
    pointer = training / 'latest.json'
    require(pointer.is_file() and not pointer.is_symlink(), 'Expected an ordinary latest pointer')
    prior = pointer.read_bytes()
    require(read(pointer) == {'checkpoint': 'checkpoints/step-000000016'}, 'Unexpected prior checkpoint pointer')
    audit.mkdir(parents=True, exist_ok=True)
    require(not (audit / 'guard_plan.json').exists(), 'Boundary audit already exists')
    run = read(training / 'RUN.json')
    plan = {'guard_id': uuid.uuid4().hex, 'training': str(training), 'target_step': 100,
            'target_cursor': 800, 'run_sha256': hashlib.sha256(canonical(run)).hexdigest(),
            'prior_pointer_sha256': hashlib.sha256(prior).hexdigest()}
    staged = audit / 'staged_pointer_guard'
    staged.mkdir()
    atomic_json(staged / 'OWNERSHIP.json', plan)
    atomic_json(audit / 'guard_plan.json', plan)
    info = staged.stat()
    atomic_json(audit / 'guard_installed.json', {'device': info.st_dev, 'inode': info.st_ino,
                                                'guard_id': plan['guard_id']})
    # Both renames are within the same run filesystem; an absent pointer between
    # them is harmless because recovery scans committed checkpoint directories.
    os.rename(pointer, audit / 'prior_latest.json')
    try:
        require((audit / 'prior_latest.json').read_bytes() == prior, 'Pointer changed during guard installation')
        require(not pointer.exists(), 'Pointer was recreated during guard installation')
        os.rename(staged, pointer)
        sync_directory(training)
        sync_directory(audit)
    except BaseException:
        if pointer.is_dir() and not pointer.is_symlink() and read(pointer / 'OWNERSHIP.json') == plan:
            os.rename(pointer, audit / ('aborted_pointer_guard_' + uuid.uuid4().hex))
        if not pointer.exists():
            atomic_bytes(pointer, (audit / 'prior_latest.json').read_bytes())
        raise
    require(read(pointer / 'OWNERSHIP.json') == plan, 'Installed guard identity changed')
    return plan


def committed100(training, plan):
    training = Path(training)
    checkpoint = training / 'checkpoints/step-000000100'
    require(checkpoint.is_dir() and not checkpoint.is_symlink(), 'Committed checkpoint100 missing')
    manifest = read(checkpoint / 'CHECKPOINT.json')
    require(manifest['step'] == 100 and manifest['cursor'] == 800
            and manifest['run_sha256'] == plan['run_sha256'], 'Checkpoint100 identity mismatch')
    require(not any(p.is_symlink() for p in checkpoint.rglob('*')), 'Checkpoint symlink is forbidden')
    inventory = {str(p.relative_to(checkpoint)) for p in checkpoint.rglob('*')
                 if p.is_file() and p.name != 'CHECKPOINT.json'}
    require(inventory == set(manifest['files']), 'Checkpoint inventory mismatch')
    for relative, expected in manifest['files'].items():
        path = checkpoint / relative
        require(path.resolve().is_relative_to(checkpoint.resolve()) and sha(path) == expected,
                'Checkpoint hash/path mismatch: ' + relative)
    records = [json.loads(line) for line in (training / 'train.jsonl').read_text().splitlines()]
    require([x['step'] for x in records] == list(range(1, 101)), 'Expected exactly logged steps1..100')
    require(all(x['mode'] == 'train' and x['microbatches'] == 8
                and x['next_row_cursor'] == x['step'] * 8 for x in records), 'Training cursor changed')
    return {'checkpoint_manifest_sha256': sha(checkpoint / 'CHECKPOINT.json'),
            'files': manifest['files'], 'step': 100, 'cursor': 800,
            'last_training_loss': records[-1]['target_mean_loss']}


def release(training, audit, *, committed=False):
    training, audit = Path(training), Path(audit)
    plan = read(audit / 'guard_plan.json')
    require(plan['training'] == str(training), 'Guard belongs to another run')
    prior = audit / 'prior_latest.json'
    require(sha(prior) == plan['prior_pointer_sha256'], 'Original pointer evidence changed')
    pointer = training / 'latest.json'
    installed = read(audit / 'guard_installed.json')
    archive = audit / ('released_pointer_guard_' + plan['guard_id'])
    owned = pointer if pointer.is_dir() else archive
    require(owned.is_dir() and not owned.is_symlink()
            and read(owned / 'OWNERSHIP.json') == plan, 'Only the owned guard may be released')
    info = owned.stat()
    require(installed == {'device': info.st_dev, 'inode': info.st_ino, 'guard_id': plan['guard_id']},
            'Guard directory inode changed')
    require({p.name for p in owned.iterdir()} == {'OWNERSHIP.json'}, 'Unknown contents in guard')
    if committed:
        committed100(training, plan)
    replacement = canonical({'checkpoint': 'checkpoints/step-000000100'}) + b'\n' if committed else prior.read_bytes()
    intent = {'guard_id': plan['guard_id'], 'archive': archive.name, 'committed100': committed,
              'replacement_sha256': hashlib.sha256(replacement).hexdigest()}
    intent_path = audit / 'release_intent.json'
    if intent_path.exists():
        require(read(intent_path) == intent, 'Release intent changed')
    else:
        atomic_json(intent_path, intent)
    if owned == pointer:
        require(not archive.exists(), 'Guard archive already exists')
        os.rename(pointer, archive)
        sync_directory(audit)
        sync_directory(training)
    elif pointer.exists():
        require(pointer.is_file() and not pointer.is_symlink() and pointer.read_bytes() == replacement,
                'Never overwrite a changed pointer during release recovery')
        return plan
    # A retry after the archive rename safely finishes the same recorded release.
    atomic_bytes(pointer, replacement)
    sync_directory(audit)
    return plan
