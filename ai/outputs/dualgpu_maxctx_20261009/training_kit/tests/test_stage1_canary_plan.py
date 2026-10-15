import unittest

from scripts.malssi_stage1 import canary_rows


class CanaryPlanTest(unittest.TestCase):
    def test_longest_source_is_exercised_after_optimizer_allocation_and_resume(self):
        rows = [{'id': str(i), 'sequence_length': 25316 - i} for i in range(30)]
        selected = canary_rows(list(reversed(rows)))
        self.assertEqual(len(selected), 24)
        self.assertEqual(len(rows), 30)
        for start in (0, 8, 16):
            self.assertEqual(selected[start:start + 8], rows[:8])
            self.assertEqual(max(r['sequence_length'] for r in selected[start:start + 8]), 25316)

    def test_incomplete_or_shortened_source_is_rejected(self):
        with self.assertRaises(ValueError):
            canary_rows([{'id': str(i), 'sequence_length': 25000} for i in range(10)])
        with self.assertRaises(ValueError):
            canary_rows([{'id': 'only', 'sequence_length': 25316}])


if __name__ == '__main__':
    unittest.main()
