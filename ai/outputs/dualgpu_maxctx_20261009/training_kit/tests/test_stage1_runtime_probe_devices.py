"""Device identity/placement checks without CUDA or model downloads."""
from types import SimpleNamespace
import importlib.util
import json
import unittest

from counseling_pipeline.stage1_runtime_probe import (
    device_evidence, equivalence_metrics, mlp_forward_backward,
    tensor_equivalence, upstream_gradient_evidence,
)


UUIDS = ('GPU-first', 'GPU-second')


class Parameter:
    def __init__(self, device, trainable=True, grad=None):
        self.device = device
        self.requires_grad = trainable
        self.grad = grad

    def numel(self):
        return 6


class Model:
    def __init__(self, parameters=None):
        self.parameters = parameters if parameters is not None else [Parameter('cuda:0'), Parameter('cuda:1')]

    def named_parameters(self):
        return [(str(i), parameter) for i, parameter in enumerate(self.parameters)]

    def get_input_embeddings(self):
        return SimpleNamespace(weight=self.parameters[0])

    def get_base_model(self):
        return SimpleNamespace(lm_head=SimpleNamespace(weight=self.parameters[-1]))


class CUDA:
    def __init__(self, uuids=UUIDS):
        self.uuids = uuids

    def device_count(self):
        return len(self.uuids)

    def get_device_properties(self, index):
        return SimpleNamespace(uuid=self.uuids[index])


class DeviceEvidenceTests(unittest.TestCase):
    def evidence(self, model=None, cuda=None, visible=None, expected=UUIDS):
        return device_evidence(model or Model(), cuda or CUDA(),
                               visible if visible is not None else ','.join(UUIDS), expected)

    def test_proves_both_uuid_identities_and_actual_placements(self):
        result = self.evidence(cuda=CUDA(('first', 'second')))
        self.assertEqual(result['actual_uuids'], list(UUIDS))
        self.assertEqual(result['requested_uuids'], list(UUIDS))
        self.assertEqual(result['input_device'], 'cuda:0')
        self.assertEqual(result['head_device'], 'cuda:1')
        self.assertEqual(result['placement']['cuda:1'],
                         {'tensors': 1, 'elements': 6, 'trainable_tensors': 1})

    def test_rejects_missing_or_additional_gpu(self):
        for uuids in (UUIDS[:1], UUIDS + ('GPU-third',)):
            with self.subTest(uuids=uuids), self.assertRaises(ValueError):
                self.evidence(cuda=CUDA(uuids))

    def test_rejects_identity_and_order_mismatch(self):
        for kwargs in ({'cuda': CUDA(tuple(reversed(UUIDS)))},
                       {'visible': ','.join(reversed(UUIDS))},
                       {'visible': '0,1'}, {'expected': (UUIDS[0], UUIDS[0])}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                self.evidence(**kwargs)

    def test_rejects_nominal_two_gpu_model_using_only_one(self):
        with self.assertRaisesRegex(ValueError, 'Both pinned GPUs'):
            self.evidence(model=Model([Parameter('cuda:0'), Parameter('cuda:0')]))

    def test_rejects_cpu_or_meta_offload(self):
        for device in ('cpu', 'meta'):
            with self.subTest(device=device), self.assertRaises(ValueError):
                self.evidence(model=Model([Parameter('cuda:0'), Parameter('cuda:1'), Parameter(device, False)]))

    def test_rejects_gpu_without_trainable_adapters(self):
        with self.assertRaisesRegex(ValueError, 'trainable adapters'):
            self.evidence(model=Model([Parameter('cuda:0'), Parameter('cuda:1', False)]))

    def test_missing_gradient_fails_before_cuda_or_torch_is_needed(self):
        with self.assertRaisesRegex(ValueError, 'Missing upstream LoRA gradient'):
            upstream_gradient_evidence(Model(), None)


class EquivalenceMetricTests(unittest.TestCase):
    def test_exact_zero_gradients_are_valid_and_reported_explicitly(self):
        result = equivalence_metrics(0, 0, 0, 0)
        self.assertTrue(result['passed'])
        self.assertTrue(result['both_exactly_zero'])
        self.assertEqual((result['relative_l2_error'], result['cosine']), (0, 1))

    def test_only_one_zero_gradient_fails(self):
        for values in ((0, 1, 1, 0), (1, 0, 1, 0)):
            with self.subTest(values=values):
                self.assertFalse(equivalence_metrics(*values)['passed'])

    def test_relative_error_threshold_is_not_relaxed_for_tiny_gradients(self):
        for scale in (1, 1e-40):
            good = equivalence_metrics(scale, 1.01**2 * scale, .01**2 * scale, 1.01 * scale)
            bad = equivalence_metrics(scale, 1.021**2 * scale, .021**2 * scale, 1.021 * scale)
            self.assertTrue(good['passed'])
            self.assertFalse(bad['passed'])
            self.assertAlmostEqual(bad['relative_l2_error'], .021)

    def test_opposite_gradient_direction_fails(self):
        result = equivalence_metrics(1, 1, 4, -1)
        self.assertEqual(result['cosine'], -1)
        self.assertFalse(result['passed'])


@unittest.skipUnless(importlib.util.find_spec('torch') is not None, 'CPU tensor/backward checks require torch')
class MLPEquivalenceTorchTests(unittest.TestCase):
    def setUp(self):
        import torch
        self.torch = torch
        torch.manual_seed(3407)
        torch.set_num_threads(1)

    def make_mlp(self):
        torch = self.torch
        class MLP(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.register_buffer('weight', torch.randn(4, 8) / 4)
                self.register_buffer('down', torch.randn(8, 4) / 4)
                self.lora_A = torch.nn.Parameter(torch.randn(4, 2) / 4)
                self.lora_B = torch.nn.Parameter(torch.zeros(2, 8))

            def forward(self, inputs):
                return torch.nn.functional.silu(inputs @ self.weight + inputs @ self.lora_A @ self.lora_B) @ self.down
        return MLP()

    def test_whole_and_split_backward_preserve_weights_and_cover_all_lora_gradients(self):
        torch = self.torch
        for zero_b in (True, False):
            with self.subTest(zero_b=zero_b):
                module = self.make_mlp()
                if not zero_b:
                    with torch.no_grad():
                        module.lora_B.normal_(std=.1)
                before = {name: parameter.detach().clone() for name, parameter in module.named_parameters()}
                inputs = torch.randn(1, 7, 4)
                gradient = torch.randn_like(inputs)
                reference = mlp_forward_backward(module, module.forward, inputs, gradient)
                observed = mlp_forward_backward(module, lambda x: torch.cat(
                    [module.forward(chunk) for chunk in x.split(3, dim=1)], dim=1), inputs, gradient)
                for field in ('output', 'hidden_gradient'):
                    self.assertTrue(tensor_equivalence(reference[field], observed[field])['passed'])
                self.assertEqual(set(reference['lora_gradients']), {'lora_A', 'lora_B'})
                for name, parameter in module.named_parameters():
                    metric = tensor_equivalence(reference['lora_gradients'][name], observed['lora_gradients'][name])
                    self.assertTrue(metric['passed'])
                    self.assertEqual(metric['both_exactly_zero'], zero_b and name == 'lora_A')
                    self.assertIsNone(parameter.grad)
                    self.assertTrue(torch.equal(before[name], parameter))

    def test_nonfinite_or_wrong_shape_comparison_fails_closed(self):
        torch = self.torch
        result = tensor_equivalence(torch.ones(4), torch.tensor([1., float('nan'), 1., 1.]))
        self.assertFalse(result['passed'])
        self.assertFalse(result['all_finite'])
        json.dumps(result, allow_nan=False)
        with self.assertRaises(ValueError):
            tensor_equivalence(torch.ones(4), torch.ones(3))


if __name__ == '__main__':
    unittest.main()
