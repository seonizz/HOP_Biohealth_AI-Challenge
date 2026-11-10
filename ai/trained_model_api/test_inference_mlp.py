from types import SimpleNamespace
from functools import partial, update_wrapper
import unittest

from inference_mlp import install_decode_mlp, restore_inference_mlp


class MLP:
    def original(self, value):
        return value + self.adapter

    def tiled_forward_arctic_size(self, value):
        return self.original(value)

    def __init__(self):
        self.adapter = 7
        self._unsloth_forward = MLP.original
        self.forward = self.tiled_forward_arctic_size


class Model:
    def __init__(self):
        self.training = False
        self.layers = [MLP(), MLP()]
        self.vision = SimpleNamespace(forward=lambda value: value)
        self.weights = [SimpleNamespace(requires_grad=False, device=SimpleNamespace(type="cuda"))]
        self.config = SimpleNamespace(get_text_config=lambda: SimpleNamespace(num_hidden_layers=2, hidden_size=5376))

    def parameters(self):
        return iter(self.weights)

    def named_modules(self):
        return [(f"model.language_model.layers.{i}.mlp", layer) for i, layer in enumerate(self.layers)] + [("model.vision_tower.layers.0.mlp", self.vision)]


class RestoreTests(unittest.TestCase):
    def test_restores_bound_original_preserving_adapter_and_weights(self):
        model = Model()
        weights = model.weights[:]
        vision = model.vision.forward
        result = restore_inference_mlp(model)
        self.assertEqual(result["restored_layers"], 2)
        self.assertEqual([m.forward(3) for m in model.layers], [10, 10])
        self.assertTrue(all(a is b for a, b in zip(weights, model.weights)))
        self.assertIs(model.vision.forward, vision)

    def test_rejects_training_cpu_unknown_forward_or_device_hook_before_changes(self):
        for case in ("training", "grad", "cpu", "forward", "hook", "active_hook", "count", "original"):
            with self.subTest(case=case):
                model = Model()
                first = model.layers[0].forward
                if case == "training": model.training = True
                elif case == "grad": model.weights[0].requires_grad = True
                elif case == "cpu": model.weights[0].device.type = "cpu"
                elif case == "forward": model.layers[-1].forward = lambda x: x
                elif case == "hook": model.layers[-1]._hf_hook = SimpleNamespace(offload=True)
                elif case == "active_hook":
                    module = model.layers[-1]
                    module.forward = update_wrapper(partial(lambda function, x: function(x), module.forward), module.forward)
                elif case == "count": model.layers.pop()
                elif case == "original": model.layers[-1]._unsloth_forward = None
                with self.assertRaises(ValueError): restore_inference_mlp(model)
                self.assertIs(model.layers[0].forward, first)

    def test_inactive_non_offloading_hook_metadata_is_preserved(self):
        model = Model()
        hook = SimpleNamespace(offload=False)
        model.layers[0]._hf_hook = hook
        restore_inference_mlp(model)
        self.assertIs(model.layers[0]._hf_hook, hook)
        self.assertEqual(model.layers[0].forward(1), 8)


class Input:
    def __init__(self, shape=(1, 1, 5376), device="cuda", requires_grad=False):
        self.shape, self.ndim = shape, len(shape)
        self.device = SimpleNamespace(type=device)
        self.requires_grad = requires_grad
        self.value = 3


class TrackedMLP(MLP):
    def __init__(self, weight):
        super().__init__()
        self._unsloth_forward = TrackedMLP.original
        self.weight = weight
        self.training = False
        self.original_calls = self.tiled_calls = 0
        self.original_input = None

    def parameters(self):
        return iter([self.weight])

    def original(self, value):
        self.original_calls += 1
        self.original_input = value
        return value.value + self.adapter

    def tiled_forward_arctic_size(self, value):
        self.tiled_calls += 1
        return self.original(value)


class DecodeTests(unittest.TestCase):
    def make_model(self):
        model = Model()
        model.layers = [TrackedMLP(model.weights[0]), TrackedMLP(model.weights[0])]
        torch = SimpleNamespace(grad_enabled=False)
        torch.is_grad_enabled = lambda: torch.grad_enabled
        torch.is_tensor = lambda value: isinstance(value, Input)
        return model, torch

    def test_decode_calls_same_saved_original_with_unchanged_input(self):
        model, torch = self.make_model()
        weights = model.weights[:]
        hook = SimpleNamespace(offload=False)
        model.layers[0]._hf_hook = hook
        result = install_decode_mlp(model, torch)
        value = Input()
        for module in model.layers:
            self.assertEqual(module.forward(value), 10)
            self.assertIs(module.original_input, value)
            self.assertEqual((module.original_calls, module.tiled_calls), (1, 0))
            self.assertIs(module.forward.__self__, module)
        self.assertEqual(result["patched_layers"], 2)
        self.assertTrue(all(a is b for a, b in zip(weights, model.weights)))
        self.assertIs(model.layers[0]._hf_hook, hook)

    def test_prefill_batch_training_grad_or_cpu_uses_original_tiled_path(self):
        cases = ("prefill", "long_prefill", "batch", "rank", "model_train", "module_train", "grad",
                 "input_grad", "input_cpu", "unfrozen", "weight_cpu")
        for case in cases:
            with self.subTest(case=case):
                model, torch = self.make_model()
                install_decode_mlp(model, torch)
                value = Input()
                if case == "prefill": value = Input((1, 2, 5376))
                elif case == "long_prefill": value = Input((1, 25316, 5376))
                elif case == "batch": value = Input((2, 1, 5376))
                elif case == "rank": value = Input((1, 5376))
                elif case == "model_train": model.training = True
                elif case == "module_train": model.layers[0].training = True
                elif case == "grad": torch.grad_enabled = True
                elif case == "input_grad": value.requires_grad = True
                elif case == "input_cpu": value.device.type = "cpu"
                elif case == "unfrozen": model.weights[0].requires_grad = True
                elif case == "weight_cpu": model.weights[0].device.type = "cpu"
                self.assertEqual(model.layers[0].forward(value), 10)
                self.assertEqual(model.layers[0].tiled_calls, 1)

    def test_non_tensor_uses_original_tiled_path_without_tensor_property_access(self):
        model, torch = self.make_model()
        install_decode_mlp(model, torch)
        value = SimpleNamespace(value=3)
        self.assertEqual(model.layers[0].forward(value), 10)
        self.assertEqual(model.layers[0].tiled_calls, 1)

    def test_wrong_hidden_width_uses_original_tiled_path(self):
        model, torch = self.make_model()
        install_decode_mlp(model, torch)
        self.assertEqual(model.layers[0].forward(Input((1, 1, 5375))), 10)
        self.assertEqual(model.layers[0].tiled_calls, 1)

    def test_rejects_active_hook_before_mutating_any_layer(self):
        model, torch = self.make_model()
        first = model.layers[0].forward
        last = model.layers[-1]
        last.forward = update_wrapper(partial(lambda function, x: function(x), last.forward), last.forward)
        with self.assertRaises(ValueError):
            install_decode_mlp(model, torch)
        self.assertIs(model.layers[0].forward, first)

    def test_rejects_duplicate_install_before_mutation(self):
        model, torch = self.make_model()
        install_decode_mlp(model, torch)
        previous = [module.forward for module in model.layers]
        with self.assertRaisesRegex(ValueError, "already installed"):
            install_decode_mlp(model, torch)
        self.assertTrue(all(module.forward is old for module, old in zip(model.layers, previous)))

    def test_missing_parameters_on_late_layer_leaves_earlier_layer_unchanged(self):
        model, torch = self.make_model()
        first = model.layers[0].forward
        model.layers[-1].parameters = lambda: iter(())
        with self.assertRaisesRegex(ValueError, "parameters"):
            install_decode_mlp(model, torch)
        self.assertIs(model.layers[0].forward, first)


if __name__ == "__main__":
    unittest.main()
