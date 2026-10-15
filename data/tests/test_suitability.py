import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

from counseling_pipeline.ingest import ingest

HAS_NUMPY = bool(importlib.util.find_spec('numpy'))
if HAS_NUMPY:
    import numpy as np
    from counseling_pipeline.numeric import representations, fingerprint
    from counseling_pipeline.suitability import (
        assess, aligned_rows, contrast_probe, distributional_masks,
        load_features, numeric_reasons, REASONS, code_hashes,
    )


@unittest.skipUnless(HAS_NUMPY, 'NumPy required')
class NumericValidityTests(unittest.TestCase):
    def test_zero_missing_bool_string_and_negative_remain_distinct(self):
        columns = ['age', 'silence', 'total_time', 'cps', 'start_point']
        flags = numeric_reasons({'age': 0, 'silence': False, 'total_time': '3', 'cps': -1}, columns)
        self.assertEqual(flags.tolist(), [0, REASONS['not_numeric'], REASONS['not_numeric'],
                                         REASONS['negative'], REASONS['missing']])

    def test_time_order_count_and_float32_representability(self):
        columns = ['start_point', 'end_point', 'character_count', 'cps']
        flags = numeric_reasons(dict(zip(columns, [5, 2, 1.5, 1e40])), columns)
        self.assertEqual(flags.tolist(), [REASONS['end_before_start'], REASONS['end_before_start'],
                                         REASONS['noninteger_count'], REASONS['float32_overflow']])
        flags = numeric_reasons({'start_point': 0, 'character_count': 0, 'cps': float('inf')}, columns)
        self.assertEqual(flags.tolist(), [0, REASONS['missing'], 0, REASONS['not_finite']])

    def test_mapping_rejects_order_count_and_split_mismatches(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'rows.jsonl'
            path.write_text(json.dumps({'row': 0, 'id': 'a', 'split': 'train'}) + '\n')
            for rows in [[], [('b', 'train')], [('a', 'validation')], [('a', 'train'), ('b', 'train')]]:
                with self.assertRaisesRegex(ValueError, 'mapping'):
                    list(aligned_rows(path, rows, True))

    def test_synthetic_collision_is_reported_not_promoted_to_semantics(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'distributional_vocabulary.json').write_text(json.dumps({'words': ['싶어요']}))
            np.save(root / 'word_distributional.npy', np.array([[1., 2.]], dtype=np.float32))
            (root / 'vocabulary.json').write_text(json.dumps({'terms': ['u:자살하고', 'u:행복하고', 'u:싶어요']}))
            np.save(root / 'idf.npy', np.ones(3))
            probe = contrast_probe(root, {'char_hash_dimensions': 8192})
            self.assertTrue(probe['distributional_vectors_identical'])
            self.assertTrue(probe['tfidf_distinguishes_this_pair'])
            self.assertTrue(probe['char_hash_distinguishes_this_pair'])

    def test_zero_vector_excludes_coverage_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            base = {'artifacts': []}
            for unit in ('sentence', 'conversation'):
                np.save(root / f'{unit}_distributional.npy', np.array([[0., 0., 1.], [1., 2., .5]]))
                np.save(root / f'{unit}_statistics.npy', np.array([[4., 4., 1.], [8., 8., 2.]]))
                base['artifacts'].append({'path': f'{unit}_distributional.npy', 'oov_rate': 1/3})
            _, report = distributional_masks(root, root, base)
            self.assertEqual(report['sentence']['zero_vector_rows'], 1)
            self.assertFalse(report['policy']['standalone_semantic_use'])
            self.assertFalse(report['policy']['nonzero_or_full_coverage_proves_meaning_preserved'])


@unittest.skipUnless(HAS_NUMPY, 'NumPy required')
class SuitabilityIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source, self.out = self.root / 'source', self.root / 'out'
        payloads = [
            ('Training', {'id': 'one', 'class': 'synthetic', 'age': -1, 'silence': 0, 'total_time': 10,
                'paragraph': [
                    {'paragraph_text': '반복 단어 반복 단어.', 'start_point': 5, 'end_point': 2,
                     'character_count': 1.5, 'cps': -1, 'depressive_mood': 0},
                    {'paragraph_text': 3, 'start_point': 0, 'end_point': 0, 'character_count': 0, 'cps': 0},
                    {'paragraph_text': '정상 문장.', 'start_point': 0, 'end_point': 0, 'character_count': 0, 'cps': 0}]}),
            ('Validation', {'id': 'two', 'class': 'synthetic', 'age': 0, 'silence': 0, 'total_time': 0,
                'paragraph': [{'paragraph_text': '반복 단어 반복 단어. 새 문장.', 'start_point': 0, 'character_count': 0}]}),
        ]
        for split, payload in payloads:
            path = self.source / split / 'a.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(payload, ensure_ascii=False))
        ingest(self.source, self.out)
        config = {'word_vocabulary_limit': 50, 'word_hash_dimensions': 16, 'char_hash_dimensions': 16,
                  'cooccurrence_vocabulary_limit': 20, 'cooccurrence_window': 2, 'svd_dimensions': 3, 'random_seed': 17}
        representations(self.out, config)
        self.original = fingerprint(self.out / 'corpus.sqlite')
        self.base = fingerprint(self.out / 'numeric/manifest.json')
        self.result = assess(self.out)

    def tearDown(self):
        self.temp.cleanup()

    def test_masks_retain_local_sentences_but_exclude_incomplete_conversations(self):
        conv = load_features(self.out, 'conversation', 'tfidf')
        by_split = {r['split']: bool(mask) for r, mask in zip(conv['rows'], conv['row_use_mask'])}
        self.assertEqual(by_split, {'train': False, 'validation': True})
        local = load_features(self.out, 'sentence', 'tfidf')
        full = load_features(self.out, 'sentence', 'tfidf', require_complete_context=True)
        train = np.array([r['split'] == 'train' for r in local['rows']])
        self.assertTrue(local['row_use_mask'][train].all())
        self.assertFalse(full['row_use_mask'][train].any())
        self.assertFalse(local['clinical_training_ready'])
        self.assertEqual(fingerprint(self.out / 'corpus.sqlite'), self.original)
        self.assertEqual(fingerprint(self.out / 'numeric/manifest.json'), self.base)

    def test_invalid_numbers_are_masked_and_missing_bound_never_creates_duration(self):
        result = load_features(self.out, 'utterance', 'source_numeric')
        with sqlite3.connect(self.out / 'corpus.sqlite') as db:
            ids = dict(db.execute('SELECT utterance_id,text FROM utterances'))
        duration_valid = np.load(self.out / 'suitability/utterance_duration_valid.npy')
        for i, row in enumerate(result['rows']):
            text = ids[row['id']]
            if text == '반복 단어 반복 단어.':
                self.assertTrue(result['matrix'].mask[i].all())
                self.assertFalse(duration_valid[i, 0])
            elif text == '정상 문장.':
                self.assertFalse(result['matrix'].mask[i].any())
                self.assertTrue(duration_valid[i, 0])
            elif text.endswith('새 문장.'):
                self.assertFalse(result['matrix'].mask[i, 0])
                self.assertTrue(result['matrix'].mask[i, 1])
                self.assertFalse(duration_valid[i, 0])

    def test_loader_rejects_svd_targets_unverified_purpose_and_tampered_masks(self):
        for method in ('distributional', 'original_labels', 'structure'):
            with self.assertRaisesRegex(ValueError, 'excluded'):
                load_features(self.out, 'sentence', method)
        with self.assertRaisesRegex(ValueError, 'purpose'):
            load_features(self.out, 'sentence', 'tfidf', purpose='counseling_training')
        path = self.out / 'suitability/conversation_text_masks.npy'
        data = np.load(path); data[:] = 1; np.save(path, data)
        with self.assertRaisesRegex(ValueError, 'changed artifact'):
            load_features(self.out, 'sentence', 'tfidf')
        assess(self.out)
        self.assertEqual(self.result, assess(self.out) | {'created_at': self.result['created_at']})

    def test_resume_and_mapping_corruption_are_checked(self):
        self.assertEqual(self.result, assess(self.out))
        mapping = self.out / 'numeric/sentence_rows.jsonl'
        mapping.write_text(mapping.read_text().replace('validation', 'train'))
        with self.assertRaisesRegex(ValueError, 'base artifact changed'):
            assess(self.out)
        with self.assertRaisesRegex(ValueError, 'changed base feature'):
            load_features(self.out, 'sentence', 'tfidf')

    def test_changed_tokenizer_cannot_rebind_existing_numeric_outputs(self):
        changed = {**code_hashes(), 'text.py': '0' * 64}
        with patch('counseling_pipeline.suitability.code_hashes', return_value=changed):
            with self.assertRaisesRegex(ValueError, 'numeric implementation/config changed'):
                assess(self.out)
            with self.assertRaisesRegex(ValueError, 'numeric implementation/config changed'):
                load_features(self.out, 'sentence', 'tfidf')
        self.assertEqual(self.result, assess(self.out))


if __name__ == '__main__':
    unittest.main()
