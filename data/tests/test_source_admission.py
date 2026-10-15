"""Synthetic admission boundaries and release/audit binding checks."""
import copy
import gzip
import json
from pathlib import Path
import tempfile
import unittest

from counseling_pipeline import source_admission as admission
from counseling_pipeline import source_sft as source


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.release = self.root / 'release'
        (self.release / 'conversation').mkdir(parents=True)
        self.audit_path = self.root / 'audit.json'
        self.output = self.root / 'out'
        self.data = {}
        self.matches = []
        for number, size in ((1, 200), (2, 199)):
            text = str(number) * size
            self.matches.append({'normalized_characters': size, 'text_sha256': source.sha_text(text),
                                 'validation_row_ids': [f'v{number}'],
                                 'validation_sources': [{'row_id': f'v{number}', 'conversation_id': f'vc{number}', 'group_id': f'vg{number}'}],
                                 'train_sources': [{'conversation_id': f'tc{number}', 'group_id': f'tg{number}', 'utterance_ids': [f'tpast{number}']}]})
            for split, short in (('train', 't'), ('validation', 'v')):
                row = {'id': f'{short}{number}', 'split': split,
                       'source_conversation_id': f'{short}c{number}', 'source_group_id': f'{short}g{number}',
                       'target_utterance_ids': [f'{short}target{number}'],
                       'messages': [{'role': 'system', 'content': 'task'}, {'role': 'user', 'content': 'context'}]}
                if split == 'train':
                    row['messages'] += [{'role': 'assistant', 'content': text}, {'role': 'user', 'content': 'next'}]
                row['messages'].append({'role': 'assistant', 'content': text if split == 'validation' else 'different final'})
                self.data.setdefault(f'conversation/{split}.jsonl.gz', []).append(row)
                dialogue = {'source_conversation_id': row['source_conversation_id'], 'source_group_id': row['source_group_id'],
                            'split': split, 'source_subject_key': f'{short}s{number}',
                            'utterances': [{'utterance_id': f'{short}target{number}'}, {'utterance_id': f'{short}past{number}'}]}
                self.data.setdefault(f'conversation/source_dialogues.{split}.jsonl.gz', []).append(dialogue)
        self.audit = {'schema_version': 'malssi-source-selection-audit-v1', 'candidate_counts': {'accepted': 4},
                      'bounded_cross_split_overlap': {
                          'first_8_context_messages_min200chars': {'unique_shared_blocks': 0, 'examples': []},
                          'whole_normalized_past_assistant_group': {'unique_validation_targets': 2, 'validation_rows': 2, 'matches': self.matches}}}
        self.save()

    def save(self):
        manifest = {'schema_version': source.SCHEMA, 'training_profile': 'observed_counselor_imitation', 'files': {}}
        for relative, rows in self.data.items():
            path = self.release / relative
            with gzip.open(path, 'wt', encoding='utf-8') as stream:
                for row in rows:
                    stream.write(json.dumps(row) + '\n')
            manifest['files'][relative] = {'sha256': source.sha_file(path), 'rows': len(rows), 'bytes': path.stat().st_size}
        source.dump_json(self.release / 'manifest.json', manifest)
        self.audit['input_manifest_sha256'] = source.sha_file(self.release / 'manifest.json')
        self.audit['verified_release_files'] = {relative: meta['sha256'] for relative, meta in manifest['files'].items()}
        source.dump_json(self.audit_path, self.audit)

    def build(self):
        return admission.build_admission(self.release, self.audit_path, self.output)

    def test_threshold_and_deduplicated_union_preserve_originals(self):
        before = {p: source.sha_file(p) for p in self.release.rglob('*') if p.is_file()}
        result = self.build()
        self.assertEqual(result['quarantined_source_groups'], ['tg1', 'vg1'])
        self.assertEqual(result['held_validation_example_ids'], ['v1', 'v2'])
        self.assertEqual(result['counts'], {'all_rows': 4, 'admitted_rows': 1, 'held_rows': 3,
                                          'group_quarantine_rows': 2, 'validation_target_hold_rows': 2,
                                          'partial_validation_target_hold_rows': 0, 'both_hold_reasons_rows': 1})
        self.assertEqual(result['after']['train']['rows'], 1)
        self.assertFalse(result['model_training_authorized'])
        self.assertTrue(result['token_length_gate_pending'])
        rows = list(source.read_rows(self.output / 'admission_rows.jsonl.gz'))
        self.assertEqual(len(rows), 4)
        self.assertTrue(all(r['model_training_authorized'] is False for r in rows))
        self.assertEqual(before, {p: source.sha_file(p) for p in before})

    def test_first_eight_evidence_adds_both_groups(self):
        audit = copy.deepcopy(self.audit)
        audit['bounded_cross_split_overlap']['first_8_context_messages_min200chars'] = {'unique_shared_blocks': 1, 'examples': [
            {'sha256': 'hash', 'train': {'row_id': 't2', 'conversation_id': 'tc2', 'group_id': 'tg2'},
             'validation': {'row_id': 'v2', 'conversation_id': 'vc2', 'group_id': 'vg2'}}]}
        groups, _, _, _ = admission.rule_sets(audit)
        self.assertEqual(groups, {'tg1', 'vg1', 'tg2', 'vg2'})

    def test_first_eight_full_build_rechecks_actual_text(self):
        shared = [{'role': 'user' if i % 2 == 0 else 'assistant',
                   'content': str(i) * 40} for i in range(8)]
        for split in source.SPLITS:
            row = self.data[f'conversation/{split}.jsonl.gz'][1]
            row['messages'] = row['messages'][:1] + copy.deepcopy(shared) + row['messages'][1:]
        train, validation = (self.data[f'conversation/{split}.jsonl.gz'][1] for split in source.SPLITS)
        digest = admission.block_keys(train['messages'])['first_8_context_messages_min200chars']
        self.audit['bounded_cross_split_overlap']['first_8_context_messages_min200chars'] = {
            'unique_shared_blocks': 1, 'examples': [{'sha256': digest,
            'train': {'row_id': 't2', 'conversation_id': 'tc2', 'group_id': 'tg2'},
            'validation': {'row_id': 'v2', 'conversation_id': 'vc2', 'group_id': 'vg2'}}]}
        self.save()
        result = self.build()
        self.assertEqual(result['quarantined_source_groups'], ['tg1', 'tg2', 'vg1', 'vg2'])
        self.assertEqual(result['counts']['held_rows'], 4)

    def test_missing_validation_ids_fail_closed(self):
        self.matches[0]['validation_row_ids'] = ['missing']
        self.matches[0]['validation_sources'][0]['row_id'] = 'missing'
        self.save()
        with self.assertRaisesRegex(ValueError, 'missing validation'):
            self.build()
        self.assertFalse(self.output.exists())

    def test_stale_manifest_is_rejected(self):
        path = self.release / 'manifest.json'
        path.write_text(path.read_text() + '\n')
        with self.assertRaisesRegex(ValueError, 'stale manifest'):
            self.build()

    def test_changed_source_bytes_are_rejected(self):
        path = self.release / 'conversation/train.jsonl.gz'
        path.write_bytes(path.read_bytes() + b'x')
        with self.assertRaisesRegex(ValueError, 'file size mismatch'):
            self.build()

    def test_shared_group_across_splits_is_rejected(self):
        self.data['conversation/source_dialogues.validation.jsonl.gz'][0]['source_group_id'] = 'tg1'
        self.save()
        with self.assertRaisesRegex(ValueError, 'group crosses splits'):
            self.build()

    def test_shared_subject_across_splits_is_rejected(self):
        self.data['conversation/source_dialogues.validation.jsonl.gz'][0]['source_subject_key'] = 'ts1'
        self.save()
        with self.assertRaisesRegex(ValueError, 'subject crosses splits'):
            self.build()

    def test_wrong_evidence_origin_is_rejected(self):
        self.matches[0]['train_sources'][0]['group_id'] = 'tg2'
        self.save()
        with self.assertRaisesRegex(ValueError, 'audit source origin mismatch'):
            self.build()

    def test_duplicate_row_ids_are_rejected(self):
        self.data['conversation/train.jsonl.gz'][1]['id'] = 't1'
        self.save()
        with self.assertRaisesRegex(ValueError, 'duplicate SFT'):
            self.build()

    def test_changed_target_evidence_is_rejected(self):
        self.matches[0]['text_sha256'] = '0' * 64
        self.save()
        with self.assertRaisesRegex(ValueError, 'validation target evidence mismatch'):
            self.build()

    def test_bool_length_is_not_integer(self):
        self.matches[0]['normalized_characters'] = True
        with self.assertRaisesRegex(ValueError, 'invalid normalized length'):
            admission.rule_sets(self.audit)


if __name__ == '__main__':
    unittest.main()
