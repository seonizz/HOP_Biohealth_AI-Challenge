"""Small real-source cache fixtures, with only fixture split counts reduced to 2+1."""
import contextlib
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

DIRECTORY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('cache_rebind', DIRECTORY / 'rebind_token_cache.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)
TEMPLATE = '845f1ee48e39fc942fe190da9df6a1c5db229e17a96ea08966ad1c9274e73d1b'


def put(root, name, value):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(value if isinstance(value, bytes) else helper.canonical(value) + b'\n')
    return path


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read(root, name):
    return json.loads((root / name).read_text())


def refresh_bundle(root):
    files = {str(p.relative_to(root)): {'bytes': p.stat().st_size, 'sha256': sha(p)}
             for directory in ('config', 'data', 'scripts', 'counseling_pipeline')
             for p in (root / directory).rglob('*') if p.is_file()}
    put(root, 'MANIFEST.json', {'schema_version': 'malssi.training-kit-files.v1', 'files': files})


def fixture(root, longest=5000):
    kit = DIRECTORY / 'training_kit'
    for name in ('stage1_preparation.py', 'gemma4_token_validation.py'):
        code = (kit / 'counseling_pipeline' / name).read_text()
        if name == 'stage1_preparation.py':
            original = "SPLIT_COUNTS = {'train': 40415, 'validation': 4298}"
            assert original in code
            code = code.replace(original, "SPLIT_COUNTS = {'train': 2, 'validation': 1}")
        put(root, 'counseling_pipeline/' + name, code.encode())
    put(root, 'scripts/fixture.py', b'# fixture\n')
    old = read(kit, 'config/train.json')
    old.update(max_length=28672, device_map='layer_split', layer_split=26, unsloth_tiled_mlp=True)
    new = dict(old, max_length=25316, layer_split=25)
    put(root, 'config/train.json', new)
    put(root, 'work/original-config.json', old)
    put(root, 'config/model_fingerprint.json', {'fixture': True})
    put(root, 'config/requirements.server.freeze.txt', b'fixture==1\n')
    manifest = {'training_profile': 'observed_counselor_imitation', 'selected_cap': 32768, 'files': {}, 'selection': {}}
    ledger, token_manifest = [], {'status': 'passed', 'files': {}}
    for split, count in (('train', 2), ('validation', 1)):
        sources, tokens = [], []
        for i in range(count):
            row = {'id': split + str(i), 'split': split, 'source_group_id': split, 'source_conversation_id': split,
                   'task': 'original_counselor_continuation', 'target_origin': 'observed_counselor_utterance',
                   'caregiver_perspective_assumed': False}
            length, target = (longest if split == 'train' and i == 0 else 4), 2
            common = {'sequence_length': length, 'prefix_length': length - target, 'target_length': target,
                      'template_sha256': TEMPLATE}
            sources.append(helper.canonical(row) + b'\n')
            ledger.append({**row, **common, 'status': 'encoded'})
            tokens.append({'id': row['id'], **common, 'input_ids': [3]*length,
                           'attention_mask': [1]*length, 'labels': [-100]*(length-target)+[3]*target})
        raw = b''.join(sources)
        path = put(root, 'data/' + split + '.jsonl.gz', gzip.compress(raw))
        manifest['files'][path.name] = {'bytes': path.stat().st_size, 'sha256': sha(path),
                                      'rows': count, 'uncompressed_sha256': hashlib.sha256(raw).hexdigest()}
        manifest['selection'][split] = {'supervised_tokens': count*2}
        path = put(root, 'work/tokens/' + split + '.jsonl.gz', gzip.compress(b''.join(helper.canonical(row)+b'\n' for row in tokens)))
        token_manifest['files'][path.name] = {'sha256': sha(path), 'rows': count, 'supervised_tokens': count*2,
                                             'input_tokens': sum(row['sequence_length'] for row in tokens)}
    put(root, 'data/export_manifest.json', manifest)
    put(root, 'data/expected_lengths.jsonl.gz', gzip.compress(b''.join(helper.canonical(row)+b'\n' for row in ledger)))
    refresh_bundle(root)
    snapshots = {root / name: helper.fingerprint(root / name) for name in read(root, 'MANIFEST.json')['files']}
    with helper.preparation(root, snapshots) as prep:
        token_manifest['bindings'] = prep.bindings(root, old)
    put(root, 'work/tokens/manifest.json', token_manifest)


class RebindTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cache-rebind-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        fixture(self.root)
        self.old_config = self.root / 'work/original-config.json'
        self.old_manifest = (self.root / 'work/tokens/manifest.json').read_bytes()
        self.token_hashes = {name: sha(self.root / 'work/tokens' / name)
                             for name in ('train.jsonl.gz', 'validation.jsonl.gz')}

    def assert_unmodified(self):
        self.assertEqual((self.root / 'work/tokens/manifest.json').read_bytes(), self.old_manifest)
        self.assertEqual({name: sha(self.root / 'work/tokens' / name) for name in self.token_hashes}, self.token_hashes)

    def test_valid_rebind_preserves_gzip_and_immutable_audit(self):
        result = helper.rebind(self.root, self.old_config)
        self.assertEqual(result['status'], 'committed')
        self.assertFalse(result['fresh_tokenization'])
        manifest = read(self.root, 'work/tokens/manifest.json')
        self.assertEqual(manifest['files'], json.loads(self.old_manifest)['files'])
        self.assertFalse(manifest['rebind_provenance']['fresh_tokenization'])
        self.assertEqual(manifest['rebind_provenance']['changed_keys'], ['layer_split', 'max_length'])
        self.assertEqual({name: sha(self.root / 'work/tokens' / name) for name in self.token_hashes}, self.token_hashes)
        audit = Path(result['audit_directory'])
        self.assertEqual((audit / 'token_manifest.before.json').read_bytes(), self.old_manifest)
        self.assertEqual(read(audit, 'AUDIT.json')['validation']['train']['maximum_sequence_length'], 5000)
        self.assertEqual((audit.stat().st_mode & 0o222), 0)
        self.assertTrue(all((p.stat().st_mode & 0o222) == 0 for p in audit.iterdir()))
        self.assertNotIn('torch', __import__('sys').modules)
        self.assertNotIn('unsloth', __import__('sys').modules)

    def test_non_config_binding_change_rejected(self):
        manifest = read(self.root, 'work/tokens/manifest.json')
        manifest['bindings']['environment_sha256'] = '0'*64
        put(self.root, 'work/tokens/manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'Only configuration bindings'): helper.rebind(self.root, self.old_config)

    def test_extra_config_change_rejected(self):
        new = read(self.root, 'config/train.json'); new['capacity_configuration_status'] = 'changed-not-allowed'
        put(self.root, 'config/train.json', new); refresh_bundle(self.root)
        with self.assertRaisesRegex(ValueError, 'Incompatible'): helper.rebind(self.root, self.old_config)
        self.assert_unmodified()

    def test_old_config_digest_must_match_cache(self):
        old = read(self.root, 'work/original-config.json'); old['seed'] = 123
        put(self.root, 'work/original-config.json', old)
        with self.assertRaisesRegex(ValueError, 'Old config'): helper.rebind(self.root, self.old_config)
        self.assert_unmodified()

    def test_current_limit_must_fit_every_cached_source_row(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve(); fixture(root, longest=26000)
            original = (root / 'work/tokens/manifest.json').read_bytes()
            with self.assertRaisesRegex(ValueError, 'Bad token ledger'):
                helper.rebind(root, root / 'work/original-config.json')
            self.assertEqual((root / 'work/tokens/manifest.json').read_bytes(), original)

    def test_labels_are_revalidated_even_with_matching_cache_sha(self):
        path = self.root / 'work/tokens/train.jsonl.gz'
        rows = [json.loads(line) for line in gzip.decompress(path.read_bytes()).splitlines()]
        rows[0]['labels'][0] = 3
        path.write_bytes(gzip.compress(b''.join(helper.canonical(row)+b'\n' for row in rows)))
        manifest = read(self.root, 'work/tokens/manifest.json'); manifest['files'][path.name]['sha256'] = sha(path)
        put(self.root, 'work/tokens/manifest.json', manifest)
        with self.assertRaisesRegex(ValueError, 'Labels changed'): helper.rebind(self.root, self.old_config)

    def test_missing_finalized_cache_rejected(self):
        (self.root / 'work/tokens/manifest.json').unlink()
        with self.assertRaisesRegex(ValueError, 'Finalized token cache'): helper.rebind(self.root, self.old_config)

    def test_concurrent_change_detected_before_manifest_replacement(self):
        real_preparation = helper.preparation
        @contextlib.contextmanager
        def concurrent(kit, snapshots):
            with real_preparation(kit, snapshots) as prep:
                original = prep.load_tokens
                def loading(*args):
                    rows = original(*args)
                    with (kit / 'work/tokens/train.jsonl.gz').open('ab') as stream: stream.write(b'changed')
                    return rows
                prep.load_tokens = loading
                yield prep
        with patch.object(helper, 'preparation', concurrent):
            with self.assertRaisesRegex(ValueError, 'Evidence changed'): helper.rebind(self.root, self.old_config)
        self.assertEqual((self.root / 'work/tokens/manifest.json').read_bytes(), self.old_manifest)

    def test_failed_atomic_replace_preserves_original_and_records_failure(self):
        with patch.object(helper.os, 'replace', side_effect=OSError('fixture replace failure')):
            with self.assertRaises(OSError): helper.rebind(self.root, self.old_config)
        self.assert_unmodified()
        audit = next((self.root / 'work/token-cache-rebind').iterdir())
        self.assertFalse(read(audit, 'FAILED.json')['manifest_replaced'])
        self.assertFalse((audit / 'COMMIT.json').exists())
        self.assertFalse(list((self.root / 'work/tokens').glob('.manifest-rebind-*')))


if __name__ == '__main__':
    unittest.main()
