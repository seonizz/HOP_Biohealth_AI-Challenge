"""Focused proposal tests; imports the active kit read-only for unchanged contracts."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
KIT = HERE.parent / 'training_kit'
sys.path.insert(0, str(KIT))
sys.path.insert(0, str(KIT / 'tests'))
spec = importlib.util.spec_from_file_location('counseling_pipeline.stage1_runtime_probe_proposed',
                                            HERE / 'stage1_runtime_probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ChunkLayoutTests(unittest.TestCase):
    def test_exact_requested_qualification_shapes(self):
        for chunks, sizes in ((1, [1024]), (3, [342, 342, 340]), (8, [128] * 8)):
            with self.subTest(chunks=chunks):
                ranges = probe.ce_chunk_ranges(1024, chunks)
                self.assertEqual([stop - start for start, stop in ranges], sizes)
                self.assertEqual([index for start, stop in ranges for index in range(start, stop)], list(range(1024)))

    def test_effective_chunk_count_may_be_smaller_without_padding(self):
        self.assertEqual(probe.ce_chunk_ranges(10, 6), [(0, 2), (2, 4), (4, 6), (6, 8), (8, 10)])
        self.assertEqual(probe.ce_chunk_ranges(3, 8), [(0, 1), (1, 2), (2, 3)])

    def test_invalid_dimensions_fail(self):
        for total, chunks in ((0, 1), (1, 0), (True, 1), (1, 1.0), (-1, 3)):
            with self.subTest(total=total, chunks=chunks), self.assertRaises(ValueError):
                probe.ce_chunk_ranges(total, chunks)

    def test_global_target_denominator_handles_unequal_chunk_supervision(self):
        # Two targets in one chunk, zero in another, one in the last chunk.
        # The incorrect mean of nonempty chunk means would be 6, not 14/3.
        values = [1., 3., 10.]
        self.assertAlmostEqual(probe.masked_reference_mean(values, [True, True, True]), 14 / 3)
        self.assertEqual(probe.masked_reference_mean(values, [True, False, False]), 1)
        self.assertEqual(probe.masked_reference_mean(values, [False, True, True]), 6.5)
        for selector in ([], [False] * 3, [1, 0, 1]):
            with self.subTest(selector=selector), self.assertRaises(ValueError):
                probe.masked_reference_mean(values, selector)

    def test_readiness_accepts_distinct_chunk_references_without_relaxing_contract(self):
        from test_stage1_readiness import Stage1ReadinessTests
        fixture = Stage1ReadinessTests()
        fixture.setUp()
        evidence = fixture.report['checks'][1]['evidence']
        for comparison in evidence['comparisons'][1:]:
            comparison.update(actual=2., reference=2., reference_layout='flattened_torch_chunk_before_bf16_linear')
        evidence['chunk_references'] = {'1': {'per_token_reference_ce': [2., 2., 2.]}}
        fixture.validate()
        evidence['comparisons'][-1]['actual'] = 2.01  # exceeds .002 + .002*2
        with self.assertRaises(ValueError):
            fixture.validate()


@unittest.skipUnless(importlib.util.find_spec('torch') is not None, 'Actual CPU tensor reference requires torch')
class TorchChunkReferenceTests(unittest.TestCase):
    def setUp(self):
        import torch
        self.torch = torch
        torch.set_num_threads(1)
        generator = torch.Generator().manual_seed(3407)
        self.hidden = torch.randn(2, 5, 4, dtype=torch.bfloat16, generator=generator)
        self.weight = torch.randn(7, 4, dtype=torch.bfloat16, generator=generator)
        self.labels = torch.tensor([[-100, -100, -100, 3, -100], [-100, -100, -100, 1, 2]])

    def test_ranges_match_real_torch_chunk(self):
        torch = self.torch
        for rows in (1, 3, 10, 1024):
            for chunks in (1, 3, 6, 8, 1025):
                expected = [part.numel() for part in torch.arange(rows).chunk(chunks)]
                actual = [stop-start for start, stop in probe.ce_chunk_ranges(rows, chunks)]
                self.assertEqual(actual, expected)

    def test_shift_happens_per_row_before_flatten_and_empty_chunks_are_kept(self):
        torch = self.torch
        linear = torch.nn.functional.linear
        shapes = []
        def record_linear(inputs, weight, bias):
            shapes.append(list(inputs.shape))
            return linear(inputs, weight, bias)
        with patch.object(torch.nn.functional, 'linear', side_effect=record_linear):
            values, layout = probe.chunk_reference_ce(self.hidden, self.weight, None, self.labels, chunks=6, cap=30.)
        self.assertEqual(shapes, [[2, 4]] * 5)  # Never just the selected token rows.
        self.assertEqual(layout['effective_chunks'], 5)
        self.assertEqual(layout['padding_rows_added'], 0)
        self.assertEqual(layout['supervised_items_per_chunk'], [0, 1, 0, 1, 1])
        expected = []
        # Source labels at [0,3], [1,3], [1,4] predict from flat hidden rows 2,7,8.
        for chunk, positions, targets in ((self.hidden.reshape(-1, 4)[2:4], [0], [3]),
                                           (self.hidden.reshape(-1, 4)[6:8], [1], [1]),
                                           (self.hidden.reshape(-1, 4)[8:10], [0], [2])):
            logits = linear(chunk, self.weight)[positions].float()
            expected.extend(torch.nn.functional.cross_entropy(torch.tanh(logits / 30.) * 30.,
                                                               torch.tensor(targets), reduction='none').tolist())
        self.assertEqual(values, expected)

    def test_shape_dependent_linear_rounding_is_not_mistaken_for_fused_ce_error(self):
        torch = self.torch
        self.weight.zero_()  # Make the shape-dependent discrepancy deterministic.
        linear = torch.nn.functional.linear
        def shape_sensitive_linear(inputs, weight, bias=None):
            result = linear(inputs, weight, bias)
            # A deterministic surrogate for a BF16 GEMM kernel changing with M.
            if inputs.shape[0] == 2:
                result = result.clone()
                result[..., 0] += .5
            return result
        flat = self.hidden.reshape(-1, 4)
        shifted = torch.full_like(self.labels, -100)
        shifted[:, :-1] = self.labels[:, 1:]
        shifted = shifted.reshape(-1)
        native_chunk_values = []
        for states, labels in zip(flat.chunk(6), shifted.chunk(6)):
            logits = shape_sensitive_linear(states, self.weight).float()
            token_ce = torch.nn.functional.cross_entropy(torch.tanh(logits / 30.) * 30., labels,
                                                         reduction='none', ignore_index=-100)
            native_chunk_values.extend(token_ce[labels != -100].tolist())
        full = linear(flat, self.weight).float()
        full_ce = torch.nn.functional.cross_entropy(torch.tanh(full / 30.) * 30., shifted,
                                                    reduction='none', ignore_index=-100)[shifted != -100].tolist()
        with patch.object(torch.nn.functional, 'linear', side_effect=shape_sensitive_linear):
            matched, _ = probe.chunk_reference_ce(self.hidden, self.weight, None, self.labels, chunks=6, cap=30.)
        self.assertEqual(matched, native_chunk_values)
        self.assertGreater(max(abs(a-b) for a, b in zip(full_ce, native_chunk_values)), .002)

    def test_invalid_row_start_target_and_empty_supervision_are_rejected(self):
        for change in ('row_start', 'no_targets'):
            labels = self.labels.clone()
            if change == 'row_start': labels[1, 0] = 1
            else: labels.fill_(-100)
            with self.subTest(change=change), self.assertRaises(ValueError):
                probe.chunk_reference_ce(self.hidden, self.weight, None, labels, chunks=8, cap=30.)


if __name__ == '__main__':
    unittest.main()
