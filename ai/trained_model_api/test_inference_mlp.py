from types import SimpleNamespace
from functools import partial, update_wrapper
import unittest

from inference_mlp import restore_inference_mlp


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
        self.config = SimpleNamespace(get_text_config=lambda: SimpleNamespace(num_hidden_layers=2))

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


if __name__ == "__main__":
    unittest.main()
