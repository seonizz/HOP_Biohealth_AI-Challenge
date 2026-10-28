import math
import unittest
from unittest.mock import patch

from inference_attention import folded_decode_attention

try:
    import torch
    from torch.nn import functional as F
except ImportError:
    torch = None
    F = None


@unittest.skipIf(torch is None, "PyTorch is not installed; run tensor checks in the existing model environment")
class FoldedDecodeAttentionTests(unittest.TestCase):
    def tensors(self):
        generator = torch.Generator().manual_seed(1701)
        return (
            torch.randn(2, 6, 1, 4, generator=generator, dtype=torch.float64),
            torch.randn(2, 2, 5, 4, generator=generator, dtype=torch.float64),
            torch.randn(2, 2, 5, 3, generator=generator, dtype=torch.float64),
        )

    def reference(self, query, key, value, mask=None, scale=None):
        # An explicit softmax reference, independent of the SDPA implementation.
        groups = query.shape[1] // key.shape[1]
        repeated_key = key.repeat_interleave(groups, dim=1)
        repeated_value = value.repeat_interleave(groups, dim=1)
        factor = 1 / math.sqrt(query.shape[-1]) if scale is None else scale
        scores = torch.matmul(query, repeated_key.transpose(-2, -1)) * factor
        if mask is not None:
            if mask.dtype == torch.bool:
                scores = scores.masked_fill(~mask, float("-inf"))
            else:
                scores = scores + mask
        weights = torch.nan_to_num(scores.softmax(dim=-1), nan=0.0)
        return torch.matmul(weights, repeated_value).transpose(1, 2).contiguous()

    def assert_reference(self, query, key, value, mask=None, scale=None):
        actual = folded_decode_attention(query, key, value, mask, scale=scale)
        self.assertIsNotNone(actual)
        self.assertEqual(actual.shape, (query.shape[0], 1, query.shape[1], value.shape[-1]))
        self.assertTrue(actual.is_contiguous())
        torch.testing.assert_close(actual, self.reference(query, key, value, mask, scale),
                                   rtol=1e-10, atol=1e-12)
        return actual

    def test_contiguous_head_groups_and_independent_queries(self):
        query = torch.tensor([-2.0, 2.0, -1.0, 1.0], dtype=torch.float64).reshape(1, 4, 1, 1)
        key = torch.tensor([-1.0, 1.0, -1.0, 1.0], dtype=torch.float64).reshape(1, 2, 2, 1)
        value = torch.tensor([0.0, 1.0, 10.0, 20.0], dtype=torch.float64).reshape(1, 2, 2, 1)
        actual = self.assert_reference(query, key, value, scale=1.0)
        expected = [1 / (1 + math.exp(4)), 1 / (1 + math.exp(-4)),
                    10 + 10 / (1 + math.exp(2)), 10 + 10 / (1 + math.exp(-2))]
        torch.testing.assert_close(actual.flatten(), torch.tensor(expected, dtype=torch.float64),
                                   rtol=1e-10, atol=1e-12)

    def test_batched_decode_with_different_value_dimension(self):
        self.assert_reference(*self.tensors())

    def test_boolean_masks_with_broadcast_and_per_head_shapes(self):
        query, key, value = self.tensors()
        for batch in (1, query.shape[0]):
            for heads in (1, query.shape[1]):
                with self.subTest(batch=batch, heads=heads):
                    mask = torch.ones(batch, heads, 1, key.shape[2], dtype=torch.bool)
                    mask[..., -1] = False
                    if heads > 1:
                        mask[:, 1::2, :, 0] = False
                    if batch > 1:
                        mask[1, ..., 1] = False
                    self.assert_reference(query, key, value, mask)

    def test_additive_masks_with_broadcast_and_per_head_shapes(self):
        query, key, value = self.tensors()
        for batch in (1, query.shape[0]):
            for heads in (1, query.shape[1]):
                with self.subTest(batch=batch, heads=heads):
                    mask = torch.zeros(batch, heads, 1, key.shape[2], dtype=query.dtype)
                    mask[..., -1] = float("-inf")
                    if heads > 1:
                        mask[:, 1::2, :, 0] = -1.25
                    if batch > 1:
                        mask[1, ..., 1] = 0.75
                    self.assert_reference(query, key, value, mask)

    def test_float32_additive_mask_is_preserved(self):
        query, key, value = self.tensors()
        mask = torch.tensor([0, -1, 0.5, float("-inf"), 0], dtype=torch.float32).reshape(1, 1, 1, 5)
        with patch.object(F, "scaled_dot_product_attention", wraps=F.scaled_dot_product_attention) as sdpa:
            self.assert_reference(query, key, value, mask)
        self.assertIs(sdpa.call_args.kwargs["attn_mask"], mask)

    def test_fully_masked_head_is_zero(self):
        query, key, value = self.tensors()
        for dtype in (torch.bool, query.dtype):
            with self.subTest(dtype=dtype):
                mask = torch.ones(1, query.shape[1], 1, key.shape[2], dtype=torch.bool)
                mask[:, 2] = False
                if dtype != torch.bool:
                    mask = torch.zeros_like(mask, dtype=dtype).masked_fill(~mask, float("-inf"))
                actual = self.assert_reference(query, key, value, mask)
                self.assertEqual(torch.count_nonzero(actual[:, :, 2]).item(), 0)

    def test_noncontiguous_query_key_value_and_head_mask(self):
        query, key, value = self.tensors()
        query = torch.stack((query, query + 1), dim=-1)[..., 0]
        key = torch.stack((key, key + 1), dim=-1)[..., 0]
        value = torch.stack((value, value + 1), dim=-1)[..., 0]
        mask = torch.ones(2, 6, 1, 10, dtype=torch.bool)[..., ::2]
        mask[:, ::2, :, 1] = False
        for tensor in (query, key, value, mask):
            self.assertFalse(tensor.is_contiguous())
        self.assert_reference(query, key, value, mask)

    def test_explicit_scale_including_zero(self):
        for scale in (0.0, 0.25, 1.5):
            with self.subTest(scale=scale):
                self.assert_reference(*self.tensors(), scale=scale)

    def test_one_sdpa_call_uses_original_kv_and_does_not_mutate_inputs(self):
        query, key, value = self.tensors()
        mask = torch.zeros(2, 6, 1, 5, dtype=query.dtype)
        inputs = (query, key, value, mask)
        before = [tensor.clone() for tensor in inputs]
        with patch.object(F, "scaled_dot_product_attention", wraps=F.scaled_dot_product_attention) as sdpa:
            folded_decode_attention(query, key, value, mask, scale=0.25)
        sdpa.assert_called_once()
        self.assertIs(sdpa.call_args.args[1], key)
        self.assertIs(sdpa.call_args.args[2], value)
        self.assertEqual(sdpa.call_args.args[0].shape, (2, 2, 3, 4))
        self.assertEqual(sdpa.call_args.kwargs["attn_mask"].shape, (2, 2, 3, 5))
        self.assertEqual(sdpa.call_args.kwargs["dropout_p"], 0.0)
        self.assertIs(sdpa.call_args.kwargs["is_causal"], False)
        self.assertEqual(sdpa.call_args.kwargs["scale"], 0.25)
        for tensor, original in zip(inputs, before):
            torch.testing.assert_close(tensor, original, rtol=0, atol=0)

    def test_invalid_tensor_shapes_and_dtypes_return_fallback_without_sdpa(self):
        query, key, value = self.tensors()
        cases = {
            "non_tensor": (None, key, value),
            "query_rank": (query.squeeze(2), key, value),
            "key_rank": (query, key[0], value),
            "value_rank": (query, key, value[0]),
            "prefill": (query.repeat(1, 1, 2, 1), key, value),
            "same_head_count": (query[:, :2], key, value),
            "fewer_query_heads": (query[:, :1], key, value),
            "nondivisible_heads": (query[:, :5], key, value),
            "key_batch": (query, key[:1], value),
            "value_batch": (query, key, value[:1]),
            "key_dimension": (query, key[..., :3], value),
            "value_heads": (query, key, value[:, :1]),
            "value_length": (query, key, value[:, :, :4]),
            "empty_batch": (query[:0], key[:0], value[:0]),
            "empty_query_heads": (query[:, :0], key, value),
            "empty_kv_heads": (query, key[:, :0], value[:, :0]),
            "empty_key_length": (query, key[:, :, :0], value[:, :, :0]),
            "empty_head_dimension": (query[..., :0], key[..., :0], value),
            "empty_value_dimension": (query, key, value[..., :0]),
            "integer_dtype": (query.long(), key.long(), value.long()),
            "complex_dtype": (query.cdouble(), key.cdouble(), value.cdouble()),
            "key_dtype": (query, key.float(), value),
            "value_dtype": (query, key, value.float()),
            "key_device": (query, key.to("meta"), value),
            "value_device": (query, key, value.to("meta")),
            "sparse_query": (query.to_sparse(), key, value),
        }
        with patch.object(F, "scaled_dot_product_attention") as sdpa:
            for name, tensors in cases.items():
                with self.subTest(case=name):
                    self.assertIsNone(folded_decode_attention(*tensors))
        sdpa.assert_not_called()

    def test_invalid_masks_return_fallback_without_sdpa(self):
        query, key, value = self.tensors()
        cases = {
            "non_tensor": [[True]],
            "rank_two": torch.ones(2, 5, dtype=torch.bool),
            "rank_three": torch.ones(2, 1, 5, dtype=torch.bool),
            "batch": torch.ones(3, 1, 1, 5, dtype=torch.bool),
            "kv_head_mask": torch.ones(2, 2, 1, 5, dtype=torch.bool),
            "query_length": torch.ones(2, 6, 2, 5, dtype=torch.bool),
            "key_length": torch.ones(2, 6, 1, 4, dtype=torch.bool),
            "integer": torch.ones(2, 6, 1, 5, dtype=torch.int64),
            "mismatched_float": torch.ones(2, 6, 1, 5, dtype=torch.float16),
            "device": torch.ones(2, 6, 1, 5, dtype=torch.bool, device="meta"),
            "sparse": torch.ones(2, 6, 1, 5, dtype=torch.bool).to_sparse(),
        }
        with patch.object(F, "scaled_dot_product_attention") as sdpa:
            for name, mask in cases.items():
                with self.subTest(case=name):
                    self.assertIsNone(folded_decode_attention(query, key, value, mask))
        sdpa.assert_not_called()


if __name__ == "__main__":
    unittest.main()
