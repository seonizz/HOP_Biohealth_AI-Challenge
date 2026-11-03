"""Prevent absent, stale or duplicate semantic evidence from admitting rows."""
from copy import deepcopy
from pathlib import Path
import unittest
from unittest.mock import patch

import expanded_review_dataset as e

ROOT = Path(__file__).resolve().parents[2] / 'training_data/reviewer_expansion_20261101_v2'


@unittest.skipUnless((ROOT / 'memory_projections.jsonl').exists(), 'Local ignored reviewed corpus required')
class ReviewAdmissionTests(unittest.TestCase):
    def assert_rejected(self, mutate):
        original = e.read
        def changed_read(path):
            result = original(path)
            if Path(path).name == 'answer_review_native.json':
                result = deepcopy(result)
                mutate(result)
            return result
        with patch.object(e, 'read', side_effect=changed_read):
            with self.assertRaises(ValueError):
                e.validate_reviews(ROOT)

    def test_current_evidence_accepted(self):
        self.assertEqual(e.validate_reviews(ROOT)['status'], 'approved_stratified_sample')

    def test_missing_row_evidence_rejected(self):
        self.assert_rejected(lambda proof: proof.pop('sampled_rows'))

    def test_duplicate_replacing_reviewed_row_rejected(self):
        def duplicate(proof):
            proof['sampled_rows'][-1] = deepcopy(proof['sampled_rows'][0])
        self.assert_rejected(duplicate)

    def test_stale_projection_rejected(self):
        self.assert_rejected(lambda proof: proof.update(projection_sha256='0' * 64))

    def test_unresolved_row_issue_rejected(self):
        self.assert_rejected(lambda proof: proof['sampled_rows'][0].update(issues=['unresolved']))


if __name__ == '__main__':
    unittest.main()
