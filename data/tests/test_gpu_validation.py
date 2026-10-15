import unittest

from scripts.malssi_gpu_validation import benchmark_status, probe_list, same_gpu_uuid


class GPUValidationContractTests(unittest.TestCase):
    def test_uuid_prefix_variation_does_not_change_card(self):
        self.assertTrue(same_gpu_uuid("ABC-123", "GPU-abc-123"))
        self.assertFalse(same_gpu_uuid("abc-124", "GPU-abc-123"))

    def test_single_and_collection_probe_formats(self):
        row = {"source_row": {"id": "x"}, "encoded": {}}
        for value in (row, [row], {"probes": [row]}):
            self.assertEqual(probe_list(value), [row])
        self.assertEqual(probe_list({}), [])

    def test_no_success_does_not_report_completion(self):
        self.assertEqual(benchmark_status([]), "no_successful_gradient_probe")
        self.assertEqual(benchmark_status([{"runs": [{"status": "oom"}]}]), "no_successful_gradient_probe")

    def test_oom_after_success_is_partial(self):
        self.assertEqual(benchmark_status([{"runs": [{"status": "passed"}, {"status": "oom"}]}]), "partial_gradient_validation_oom")
        self.assertEqual(benchmark_status([{"runs": [{"status": "passed"}]}]), "bounded_gradient_validation_completed")


if __name__ == "__main__":
    unittest.main()
