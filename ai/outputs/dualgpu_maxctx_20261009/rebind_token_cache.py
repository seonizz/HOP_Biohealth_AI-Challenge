#!/usr/bin/env python3
"""Validate an existing complete token cache against a compatible new config.

Only max_length, device_map, layer_split, and unsloth_tiled_mlp may differ.
No tokenization, GPU calls, network access, pickle loading or token-file writes.
Run while the kit is quiescent: cooperative locking and optimistic SHA/stat
checks detect observed races, but cannot lock out unrelated writers.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import types
import uuid

ALLOWED_CHANGES = {'max_length', 'device_map', 'layer_split', 'unsloth_tiled_mlp'}
BINDING_KEYS = {'dataset_sha256', 'config_sha256', 'model_sha256', 'template_sha256',
                'code_sha256', 'environment_sha256'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()


def parse(data):
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'Duplicate JSON key')
            value[key] = item
        return value
    value = json.loads(data, object_pairs_hook=pairs)
    require(isinstance(value, dict), 'Expected a JSON object')
    canonical(value)
    return value


def safe(path, root=None):
    path = Path(path).absolute()
    require(path == path.resolve(), 'Symlinks are not permitted')
    if root is not None:
        require(path != root and path.is_relative_to(root), 'Path escapes the kit')
    return path


def fingerprint(path):
    before = path.stat()
    require(stat.S_ISREG(before.st_mode), 'Evidence must be a regular file')
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(block)
    after = path.stat()
    signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
    require(signature(before) == signature(after), 'Evidence changed while being hashed')
    return {'sha256': digest.hexdigest(), 'bytes': after.st_size,
            'mode': stat.S_IMODE(after.st_mode), 'stat': signature(after)}


def assert_unchanged(snapshots):
    for path, expected in snapshots.items():
        require(fingerprint(safe(path)) == expected, 'Evidence changed during verification')


def write_exclusive(path, data):
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    path.chmod(0o444)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


@contextmanager
def preparation(kit, snapshots):
    """Load exact verified source bytes, without reading/writing bytecode caches."""
    package = '_rebind_verified_' + uuid.uuid4().hex
    namespace = types.ModuleType(package)
    namespace.__path__ = []
    names = [package]
    previous = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    sys.modules[package] = namespace
    try:
        for name in ('gemma4_token_validation', 'stage1_preparation'):
            path = safe(kit / 'counseling_pipeline' / (name + '.py'), kit)
            source = path.read_bytes()
            require(sha_bytes(source) == snapshots[path]['sha256'], 'Module changed before loading')
            qualified = package + '.' + name
            module = types.ModuleType(qualified)
            module.__package__, module.__file__ = package, str(path)
            sys.modules[qualified] = module
            names.append(qualified)
            exec(compile(source, str(path), 'exec'), module.__dict__)
            setattr(namespace, name, module)
        yield module
    finally:
        for name in reversed(names):
            sys.modules.pop(name, None)
        sys.dont_write_bytecode = previous


def rebind(kit, old_config_path):
    kit, old_config_path = safe(kit), safe(old_config_path)
    require(kit.is_dir(), 'Kit directory is missing')
    token_dir = safe(kit / 'work/tokens', kit)
    manifest_path = safe(token_dir / 'manifest.json', kit)
    require(token_dir.is_dir() and manifest_path.is_file(), 'Finalized token cache is missing; tokenization may still be running')
    lock_path = safe(kit / 'work/.token-cache-rebind.lock', kit)
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    audit = temporary = None
    committed = False
    with os.fdopen(descriptor, 'a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        snapshots = {}
        def track(path):
            path = safe(path, kit) if path != old_config_path else safe(path)
            observed = fingerprint(path)
            require(path not in snapshots or snapshots[path] == observed, 'Evidence changed while taking snapshot')
            snapshots[path] = observed
            return path
        def recorded_bytes(path):
            data = path.read_bytes()
            require(sha_bytes(data) == snapshots[path]['sha256'], 'Evidence changed between hashing and reading')
            return data
        bundle_path = track(kit / 'MANIFEST.json')
        bundle = parse(recorded_bytes(bundle_path))
        require(bundle.get('schema_version') == 'malssi.training-kit-files.v1', 'Unsupported kit manifest')
        require('work/tokens/manifest.json' not in bundle['files'], 'Token manifest must not be part of the immutable kit manifest')
        required = {'config/train.json', 'config/model_fingerprint.json', 'config/requirements.server.freeze.txt',
                    'data/train.jsonl.gz', 'data/validation.jsonl.gz', 'data/expected_lengths.jsonl.gz',
                    'data/export_manifest.json', 'counseling_pipeline/stage1_preparation.py',
                    'counseling_pipeline/gemma4_token_validation.py'}
        require(required <= set(bundle['files']), 'Immutable kit manifest omits required inputs')
        for name, expected in bundle['files'].items():
            path = track(kit / name)
            require(snapshots[path]['sha256'] == expected['sha256']
                    and snapshots[path]['bytes'] == expected['bytes'], 'Kit file does not match manifest')
        track(manifest_path); track(old_config_path)
        old_manifest_bytes = recorded_bytes(manifest_path)
        old_config_bytes = recorded_bytes(old_config_path)
        old_manifest, old_config = parse(old_manifest_bytes), parse(old_config_bytes)
        require(old_manifest.get('status') == 'passed', 'Token cache has not completed')
        require(set(old_manifest.get('files', {})) == {'train.jsonl.gz', 'validation.jsonl.gz'}, 'Unexpected cache file inventory')
        for name in old_manifest['files']:
            path = track(token_dir / name)
            require(snapshots[path]['sha256'] == old_manifest['files'][name]['sha256'], 'Token cache hash mismatch')
        with preparation(kit, snapshots) as prep:
            prep.verify_bundle(kit)
            new_config = prep.load_config(kit)
            new_bindings = prep.bindings(kit, new_config)
            old_bindings = old_manifest['bindings']
            require(set(old_bindings) == set(new_bindings) == BINDING_KEYS
                    and all(type(v) is str and re.fullmatch('[0-9a-f]{64}', v) for v in old_bindings.values()),
                    'Invalid cache binding inventory')
            require(prep.digest(old_config) == old_bindings['config_sha256'], 'Old config does not match tokenization binding')
            require(all(old_bindings[k] == new_bindings[k] for k in BINDING_KEYS - {'config_sha256'}),
                    'Only configuration bindings may change')
            changed = sorted(k for k in old_config.keys() | new_config.keys()
                             if k not in old_config or k not in new_config
                             or canonical(old_config[k]) != canonical(new_config[k]))
            require(changed and set(changed) <= ALLOWED_CHANGES, 'Incompatible or empty config change')
            # This uses CURRENT config for all source/ledger/length/mask checks,
            # while explicitly checking the cache against its OLD bindings.
            rows = prep.load_tokens(kit, old_bindings)
            validation = {}
            for split in ('train', 'validation'):
                values = rows[split]
                entry = old_manifest['files'][split + '.jsonl.gz']
                observed = {'rows': len(values), 'input_tokens': sum(r['sequence_length'] for r in values),
                            'supervised_tokens': sum(r['target_length'] for r in values),
                            'maximum_sequence_length': max(r['sequence_length'] for r in values)}
                require(all(observed[k] == entry[k] for k in ('rows', 'input_tokens', 'supervised_tokens')),
                        'Token manifest statistics disagree with validated cache')
                validation[split] = observed
            del rows
        assert_unchanged(snapshots)
        current_config_bytes = recorded_bytes(kit / 'config/train.json')
        require(parse(current_config_bytes) == new_config, 'Config changed after validation')
        audit_parent = safe(kit / 'work/token-cache-rebind', kit)
        audit_parent.mkdir(exist_ok=True)
        audit = safe(audit_parent / (dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex), kit)
        audit.mkdir()
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        new_manifest = dict(old_manifest)
        new_manifest['bindings'] = new_bindings
        new_manifest['rebind_provenance'] = {'kind': 'config_only_compatible_cache_rebind', 'fresh_tokenization': False,
            'audit_directory': str(audit), 'verified_utc': now, 'changed_keys': changed,
            'previous_manifest_sha256': sha_bytes(old_manifest_bytes),
            'previous_config_sha256': old_bindings['config_sha256'], 'new_config_sha256': new_bindings['config_sha256']}
        proposed_bytes = canonical(new_manifest) + b'\n'
        public_snapshots = {str(path): {'sha256': value['sha256'], 'bytes': value['bytes']}
                            for path, value in snapshots.items()}
        evidence = {'schema_version': 'malssi.token-cache-rebind.v1', 'status': 'validated_intent',
            'created_utc': now, 'kit': str(kit), 'changed_keys': changed, 'old_bindings': old_bindings,
            'new_bindings': new_bindings, 'fresh_tokenization': False, 'gpu_used': False,
            'fresh_gpu_qualification': False, 'tokenizer_reexecuted': False,
            'validation': validation, 'checks': ['verify_bundle', 'load_config', 'bindings',
                'load_tokens_under_current_config_with_old_bindings', 'hash_stat_stability'],
            'source_fingerprints': public_snapshots, 'proposed_manifest_sha256': sha_bytes(proposed_bytes)}
        try:
            for name, data in {'token_manifest.before.json': old_manifest_bytes, 'old_config.json': old_config_bytes,
                               'new_config.json': current_config_bytes, 'token_manifest.after.json': proposed_bytes,
                               'AUDIT.json': canonical(evidence) + b'\n'}.items():
                write_exclusive(audit / name, data)
            sync_directory(audit)
            assert_unchanged(snapshots)
            temporary = token_dir / ('.manifest-rebind-' + uuid.uuid4().hex + '.tmp')
            with temporary.open('xb') as stream:
                os.fchmod(stream.fileno(), snapshots[manifest_path]['mode'])
                stream.write(proposed_bytes); stream.flush(); os.fsync(stream.fileno())
            require(fingerprint(manifest_path) == snapshots[manifest_path], 'Token manifest changed immediately before commit')
            os.replace(temporary, manifest_path)
            temporary = None
            committed = True
            sync_directory(token_dir)
            require(manifest_path.read_bytes() == proposed_bytes, 'Manifest changed after commit')
            assert_unchanged({p: value for p, value in snapshots.items() if p != manifest_path})
            receipt = {'status': 'committed', 'fresh_tokenization': False, 'committed_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
                       'token_manifest_sha256': sha_bytes(proposed_bytes), 'audit_directory': str(audit)}
            write_exclusive(audit / 'COMMIT.json', canonical(receipt) + b'\n')
            sync_directory(audit)
        except BaseException as exc:
            failure = {'status': 'failed', 'manifest_replaced': committed, 'error_type': type(exc).__name__,
                       'fresh_tokenization': False}
            write_exclusive(audit / 'FAILED.json', canonical(failure) + b'\n')
            raise
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()  # Only this invocation's uncommitted temporary manifest.
            audit.chmod(0o555)
        return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kit', required=True, type=Path)
    parser.add_argument('--old-config', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        print(json.dumps(rebind(args.kit, args.old_config), ensure_ascii=False))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(json.dumps({'status': 'failed', 'error_type': type(exc).__name__, 'error': str(exc),
                          'fresh_tokenization': False}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
