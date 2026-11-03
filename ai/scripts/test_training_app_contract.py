"""Offline contract drift checks; synthetic metadata only."""
from contextlib import redirect_stdout
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import check_training_app_contract as c


class ContractCheckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.repo, self.root = self.base / 'repo', self.base / 'bundle'
        (self.repo / 'app/src').mkdir(parents=True)
        self.root.mkdir()
        self.app = self.repo / 'app/src/relationship-turn.js'
        self.app.write_text('// synthetic current implementation\n')
        self.save('APP_CONTRACT.json', {'contract_sha256': {'app/src/relationship-turn.js': c.file_hash(self.app)}})
        self.save('COURSE.json', {'phases': []})
        self.bind()

    def save(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def bind(self):
        self.save('MANIFEST.json', {'files': {p.relative_to(self.root).as_posix():
            {'bytes': p.stat().st_size, 'sha256': c.file_hash(p)}
            for p in self.root.rglob('*') if p.is_file() and p.name != 'MANIFEST.json'}})

    def memory(self):
        self.save('data/reviews.jsonl', {'synthetic': True})
        self.save('COURSE.json', {'phases': [{'data': {'train': {
            'path': 'data/reviews.jsonl', 'tasks': {'memory_review': 2, 'answer_review': 2}}}}]})
        self.bind()

    def callback(self, **updates):
        report = {'status': 'compatible', 'rows_checked': 2, 'model_calls': 0,
                  'semantic_quality_evaluated': False, 'previous_semantic_approval_reused': False}
        report.update(updates)
        return subprocess.CompletedProcess([], 0, json.dumps(report), '')

    def test_matching_snapshot_is_not_semantic_or_training_approval(self):
        report = c.check(self.root, self.repo)
        self.assertEqual(report['status'], 'snapshot_match_unvalidated_tasks')
        self.assertFalse(report['training_ready'])
        self.assertFalse(report['previous_semantic_approval_reused'])

    def test_hash_drift_survives_passing_current_callback(self):
        self.memory()
        self.app.write_text('// changed implementation\n')
        with patch.object(c.subprocess, 'run', return_value=self.callback()):
            report = c.check(self.root, self.repo)
        self.assertEqual(report['status'], 'review_required')
        self.assertEqual(report['memory_review_current_callback']['status'], 'compatible')
        self.assertEqual(report['current_callback_untested_tasks'], ['answer_review'])

    def test_rewriting_snapshot_hash_without_manifest_is_rejected(self):
        self.app.write_text('// changed implementation\n')
        self.save('APP_CONTRACT.json', {'contract_sha256': {'app/src/relationship-turn.js': c.file_hash(self.app)}})
        with self.assertRaisesRegex(c.CheckError, 'bundle_file_hash_mismatch'):
            c.check(self.root, self.repo)

    def test_missing_snapshot_source_reported_as_drift(self):
        self.app.unlink()
        report = c.check(self.root, self.repo)
        self.assertEqual(report['snapshots'][0]['files'][0]['status'], 'missing')
        self.assertEqual(report['status'], 'review_required')

    def test_snapshot_path_escape_rejected(self):
        self.save('APP_CONTRACT.json', {'contract_sha256': {'app/src/../../secret.js': '0' * 64}})
        self.bind()
        with self.assertRaisesRegex(c.CheckError, 'unsafe_relative_path'):
            c.check(self.root, self.repo)

    def test_symlinked_source_rejected(self):
        self.app.unlink()
        self.app.symlink_to(self.base / 'elsewhere.js')
        with self.assertRaises(c.CheckError):
            c.check(self.root, self.repo)

    def test_memory_data_must_still_match_manifest(self):
        self.memory()
        (self.root / 'data/reviews.jsonl').write_text('changed private content')
        with self.assertRaisesRegex(c.CheckError, 'bundle_file_hash_mismatch'):
            c.check(self.root, self.repo)

    def test_callback_cannot_silently_skip_rows(self):
        self.memory()
        with patch.object(c.subprocess, 'run', return_value=self.callback(rows_checked=1)):
            with self.assertRaisesRegex(c.CheckError, 'memory_row_inventory_mismatch'):
                c.check(self.root, self.repo)

    def test_concurrent_app_change_invalidates_replay_evidence(self):
        self.memory()
        def change(*_args, **_kwargs):
            self.app.write_text('// edited while callback runs\n')
            return self.callback()
        with patch.object(c.subprocess, 'run', side_effect=change):
            with self.assertRaisesRegex(c.CheckError, 'app_changed_during_check'):
                c.check(self.root, self.repo)

    def test_concurrent_data_change_invalidates_replay_evidence(self):
        self.memory()
        def change(*_args, **_kwargs):
            (self.root / 'data/reviews.jsonl').write_text('changed while checking')
            return self.callback()
        with patch.object(c.subprocess, 'run', side_effect=change):
            with self.assertRaisesRegex(c.CheckError, 'bundle_file_hash_mismatch'):
                c.check(self.root, self.repo)

    def test_incompatible_callback_is_not_approved_by_matching_hash(self):
        self.memory()
        with patch.object(c.subprocess, 'run', return_value=self.callback(status='incompatible')):
            report = c.check(self.root, self.repo)
        self.assertEqual(report['status'], 'incompatible')
        self.assertFalse(report['training_ready'])

    def test_no_input_text_or_subprocess_stderr_leaks_from_cli_failure(self):
        self.memory()
        output = io.StringIO()
        with patch.object(c.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, 'PRIVATE', 'PRIVATE')):
            with redirect_stdout(output):
                code = c.main(['--root', str(self.root), '--repo', str(self.repo)])
        self.assertEqual(code, 2)
        self.assertNotIn('PRIVATE', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['status'], 'check_failed')

    def test_basename_snapshot_maps_only_to_app_src(self):
        self.save('provenance/MEMORY_REVIEW_APP_CONTRACT.json', {'app_sha256': {
            'relationship-turn.js': c.file_hash(self.app)}})
        self.bind()
        report = c.check(self.root, self.repo)
        self.assertEqual(len(report['snapshots']), 2)
        self.assertEqual(report['snapshot_file_mismatches'], 0)


if __name__ == '__main__':
    unittest.main()
