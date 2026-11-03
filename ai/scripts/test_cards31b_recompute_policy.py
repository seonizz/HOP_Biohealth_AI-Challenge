"""Scoped dispatch tests plus optional CPU autograd/RNG equivalence checks."""
from contextlib import contextmanager
import functools
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("cards31b_recompute_policy", Path(__file__).with_name("cards31b_recompute_policy.py"))
policy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(policy)
TORCH_AVAILABLE = importlib.util.find_spec("torch") is not None
GC_NAME = "unsloth_zoo.gradient_checkpointing"


def config():
    value = types.SimpleNamespace(num_hidden_layers=60, hidden_size=5376, hidden_size_per_layer_input=0,
                                  enable_moe_block=False, num_kv_shared_layers=0)
    return types.SimpleNamespace(get_text_config=lambda: value)


def checkpointer(state):
    module = types.ModuleType(GC_NAME)
    module.FIRST_PASS = False
    module.LAST_GC_INDEX = 60
    module.BACKWARD_PASS = True
    module.CURRENT_GC_INDEX = 0
    module.in_gradient_checkpoint_recompute = lambda: state.recompute
    module.unsloth_checkpoint = lambda function, *args, **kwargs: function(*args)
    return module


class FakeTensor:
    def __init__(self, length=3, batch=1, width=5376, dtype="bf16", requires_grad=True):
        self.shape = (batch, length, width)
        self.ndim, self.dtype, self.requires_grad = 3, dtype, requires_grad


def fake_model(gc):
    def tiled_forward_arctic_size(self, x):
        self.calls.append("tiled")
        return x

    class Gemma4TextMLP:
        def __init__(self):
            self.training, self.calls = True, []
            self._unsloth_forward = type(self).forward
            self.forward = types.MethodType(tiled_forward_arctic_size, self)

        def forward(self, x):
            self.calls.append("original")
            return x

    class Gemma4TextDecoderLayer:
        def __init__(self):
            self.training = self.gradient_checkpointing = True
            self.mlp = Gemma4TextMLP()
            self._gradient_checkpointing_func = functools.partial(gc.unsloth_checkpoint, preserve_rng_state=True)

    language = types.SimpleNamespace(layers=[Gemma4TextDecoderLayer() for _ in range(60)])
    model = types.SimpleNamespace(training=True, model=types.SimpleNamespace(language_model=language), config=config())
    model.get_base_model = lambda: model
    return model


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.state = types.SimpleNamespace(grad=True, recompute=False)
        self.gc = checkpointer(self.state)
        self.model = fake_model(self.gc)
        self.layers = self.model.model.language_model.layers
        self.saved = [layer.mlp.forward for layer in self.layers]
        self.torch = types.SimpleNamespace(is_grad_enabled=lambda: self.state.grad,
                                           is_tensor=lambda x: isinstance(x, FakeTensor), bfloat16="bf16")
        modules = patch.dict(sys.modules, {"torch": self.torch, GC_NAME: self.gc})
        modules.start()
        self.addCleanup(modules.stop)

    def assert_restored(self):
        self.assertTrue(all(layer.mlp.forward is saved for layer, saved in zip(self.layers, self.saved)))

    def initial(self, x):
        self.state.grad, self.state.recompute = False, False
        for layer in self.layers:
            x = layer.mlp.forward(x)
        return x

    def replay(self, x):
        self.state.grad, self.state.recompute = True, True
        try:
            for layer in reversed(self.layers):
                x = layer.mlp.forward(x)
            return x
        finally:
            self.state.recompute = False

    def test_only_single_tile_recompute_changes_and_exact_methods_restore(self):
        before = (self.gc.FIRST_PASS, self.gc.LAST_GC_INDEX, self.gc.BACKWARD_PASS, self.gc.CURRENT_GC_INDEX)
        x = FakeTensor()
        with policy.single_tile_recompute(self.model) as report:
            self.assertIs(self.initial(x), x)
            self.assertIs(self.replay(x), x)
        self.assertEqual(self.layers[0].mlp.calls, ["tiled", "original"])
        self.assertEqual(report["bypassed_recompute_calls"], 60)
        self.assertTrue(report["completed"] and report["restored"])
        self.assertEqual(before, (self.gc.FIRST_PASS, self.gc.LAST_GC_INDEX, self.gc.BACKWARD_PASS, self.gc.CURRENT_GC_INDEX))
        self.assert_restored()

    def test_long_rows_and_evaluation_keep_original_dispatch(self):
        with policy.single_tile_recompute(self.model) as report:
            self.initial(FakeTensor(length=5377))
            self.replay(FakeTensor(length=5377))
            self.layers[0].mlp.training = False
            self.layers[0].mlp.forward(FakeTensor(batch=2, dtype="fp32"))
        self.assertEqual(self.layers[0].mlp.calls, ["tiled", "tiled", "tiled"])
        self.assertEqual(report["long_recompute_calls"], 60)
        self.assertEqual(report["evaluation_calls"], 1)
        self.assertEqual(report["bypassed_recompute_calls"], 0)
        self.assert_restored()

    def test_second_row_forward_is_rejected_until_previous_backward_finishes(self):
        with self.assertRaisesRegex(ValueError, "previous row's backward"):
            with policy.single_tile_recompute(self.model) as report:
                self.initial(FakeTensor(length=3))
                self.initial(FakeTensor(length=4))
        self.assertEqual(report["original_forward_calls"], 60)
        self.assertTrue(report["restored"])
        self.assert_restored()

    def test_new_row_is_rejected_when_another_layer_still_has_pending_backward(self):
        with self.assertRaisesRegex(ValueError, "previous row's backward"):
            with policy.single_tile_recompute(self.model):
                self.initial(FakeTensor())
                self.state.grad, self.state.recompute = True, True
                self.layers[0].mlp.forward(FakeTensor())
                self.initial(FakeTensor())
        self.assert_restored()

    def test_nonzero_layer_cannot_start_a_row_out_of_order(self):
        with self.assertRaisesRegex(ValueError, "60 layers in order"):
            with policy.single_tile_recompute(self.model):
                self.state.grad = False
                self.layers[3].mlp.forward(FakeTensor())
        self.assert_restored()

    def test_next_row_is_allowed_after_the_entire_previous_backward(self):
        with policy.single_tile_recompute(self.model) as report:
            for length in (3, 4):
                self.initial(FakeTensor(length=length))
                self.replay(FakeTensor(length=length))
        self.assertEqual(report["original_forward_calls"], 120)
        self.assertEqual(report["bypassed_recompute_calls"], 120)
        self.assert_restored()

    def test_early_exit_without_backward_fails_and_restores(self):
        with self.assertRaisesRegex(ValueError, "through every backward"):
            with policy.single_tile_recompute(self.model) as report:
                self.initial(FakeTensor())
        self.assertTrue(report["restored"])
        self.assertFalse(report["completed"])
        self.assert_restored()

    def test_nested_scope_rejected_without_disturbing_outer_scope(self):
        with policy.single_tile_recompute(self.model) as report:
            with self.assertRaisesRegex(ValueError, "Nested or concurrent"):
                with policy.single_tile_recompute(self.model):
                    self.fail("Nested scope must not open")
        self.assertTrue(report["completed"])
        self.assert_restored()

    def test_original_function_exception_restores_all_modules(self):
        error = RuntimeError("original MLP failed")
        def fail(self, x):
            raise error
        self.layers[0].mlp._unsloth_forward = fail
        with self.assertRaises(RuntimeError) as raised:
            with policy.single_tile_recompute(self.model) as report:
                self.initial(FakeTensor())
                self.replay(FakeTensor())
        self.assertIs(raised.exception, error)
        self.assertTrue(report["restored"])
        self.assert_restored()

    def test_grad_path_requires_outer_marker_bf16_and_differentiable_input(self):
        for dtype, differentiable, marker in (("fp32", True, True), ("bf16", False, True), ("bf16", True, False)):
            with self.subTest(dtype=dtype, differentiable=differentiable, marker=marker):
                self.state.grad, self.state.recompute = True, False
                with self.assertRaises(ValueError):
                    with policy.single_tile_recompute(self.model):
                        self.initial(FakeTensor(dtype=dtype, requires_grad=differentiable))
                        self.state.grad, self.state.recompute = True, marker
                        self.layers[0].mlp.forward(FakeTensor(dtype=dtype, requires_grad=differentiable))
                self.assert_restored()

    def test_unsupported_training_shapes_and_limits_fail_closed(self):
        for x in (FakeTensor(batch=2), FakeTensor(width=4), FakeTensor(length=0), FakeTensor(length=32769)):
            self.state.grad, self.state.recompute = True, False
            with self.subTest(shape=x.shape), self.assertRaises(ValueError):
                with policy.single_tile_recompute(self.model):
                    self.initial(x)
            self.assert_restored()
        for limit in (0, True, 5377):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                with policy.single_tile_recompute(self.model, max_tokens=limit):
                    pass

    def test_model_and_checkpoint_guards_reject_before_modification(self):
        changes = [lambda m: setattr(m.config.get_text_config(), "hidden_size", 4),
                   lambda m: setattr(m.model.language_model.layers[0], "gradient_checkpointing", False),
                   lambda m: setattr(m.model.language_model.layers[0], "_gradient_checkpointing_func", lambda f: f),
                   lambda m: setattr(m.model.language_model.layers[0], "_gradient_checkpointing_func",
                                     functools.partial(self.gc.unsloth_checkpoint, preserve_rng_state=False)),
                   lambda m: setattr(m.model.language_model.layers[0].mlp, "training", False),
                   lambda m: setattr(m.model.language_model.layers[0].mlp, "forward", lambda x: x)]
        for change in changes:
            model = fake_model(self.gc)
            change(model)
            saved = [layer.mlp.forward for layer in model.model.language_model.layers]
            with self.subTest(change=change), self.assertRaises(ValueError):
                with policy.single_tile_recompute(model):
                    self.fail("Unqualified model must not enter")
            self.assertTrue(all(layer.mlp.forward is old for layer, old in zip(model.model.language_model.layers, saved)))

    def test_original_checkpoint_warmup_is_required(self):
        self.gc.FIRST_PASS = True
        with self.assertRaisesRegex(ValueError, "original training update"):
            with policy.single_tile_recompute(self.model):
                pass
        self.assert_restored()

    def test_entering_during_an_existing_checkpoint_recompute_is_rejected(self):
        self.state.recompute = True
        with self.assertRaisesRegex(ValueError, "boundary cannot occur"):
            with policy.single_tile_recompute(self.model):
                pass
        self.assert_restored()


@unittest.skipUnless(TORCH_AVAILABLE, "torch unavailable locally; run CPU autograd checks in qualified environment")
class TorchAutogradTests(unittest.TestCase):
    def exercise(self, max_tokens, expected_calls):
        import torch
        state = types.SimpleNamespace(recompute=False)
        gc = checkpointer(state)

        @contextmanager
        def marker():
            old, state.recompute = state.recompute, True
            try:
                yield
            finally:
                state.recompute = old

        class OuterCheckpoint(torch.autograd.Function):
            @staticmethod
            def forward(ctx, function, x):
                ctx.function, ctx.rng = function, torch.get_rng_state()
                ctx.save_for_backward(x)
                return function(x)

            @staticmethod
            def backward(ctx, gradient):
                x = ctx.saved_tensors[0].detach().requires_grad_(True)
                with torch.random.fork_rng(devices=[]):
                    torch.set_rng_state(ctx.rng)
                    with torch.enable_grad(), marker():
                        output = ctx.function(x)
                torch.autograd.backward(output, gradient)
                return None, x.grad

        class TiledStyle(torch.autograd.Function):
            @staticmethod
            def forward(ctx, module, x):
                ctx.module, ctx.rng = module, torch.get_rng_state()
                ctx.save_for_backward(x)
                return module._unsloth_forward.__get__(module, type(module))(x)

            @staticmethod
            def backward(ctx, gradient):
                x = ctx.saved_tensors[0].detach().requires_grad_(True)
                with torch.random.fork_rng(devices=[]):
                    torch.set_rng_state(ctx.rng)
                    with torch.enable_grad():
                        output = ctx.module._unsloth_forward.__get__(ctx.module, type(ctx.module))(x)
                    torch.autograd.backward(output, gradient)
                return None, x.grad

        gc.unsloth_checkpoint = lambda function, x, **kwargs: OuterCheckpoint.apply(function, x)

        def tiled_forward_arctic_size(self, x):
            return TiledStyle.apply(self, x)

        class Gemma4TextMLP(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.weight = torch.nn.Parameter(torch.linspace(.1, .2, 5376, dtype=torch.bfloat16))
                self.dropout = torch.nn.Dropout(.25)
                self.calls = 0
                self._unsloth_forward = type(self).forward
                self.forward = types.MethodType(tiled_forward_arctic_size, self)

            def forward(self, x):
                self.calls += 1
                return x + .01 * torch.tanh(self.dropout(x * self.weight))

        class Gemma4TextDecoderLayer(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.mlp = Gemma4TextMLP()
                self.gradient_checkpointing = True
                self._gradient_checkpointing_func = gc.unsloth_checkpoint

            def forward(self, x):
                return self._gradient_checkpointing_func(self.mlp, x)

        class Model(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.model = torch.nn.Module()
                self.model.language_model = torch.nn.Module()
                self.model.language_model.layers = torch.nn.ModuleList([Gemma4TextDecoderLayer() for _ in range(60)])
                self.config = config()

            def get_base_model(self):
                return self

            def forward(self, x):
                for layer in self.model.language_model.layers:
                    x = layer(x)
                return x

        model = Model()
        mlp = model.model.language_model.layers[0].mlp
        hooks = []
        pre = mlp.register_forward_pre_hook(lambda module, args: hooks.append("pre"))
        post = mlp.register_forward_hook(lambda module, args, output: hooks.append("post"))
        initial_rng = torch.Generator().manual_seed(3407).get_state()
        data = (torch.arange(2 * 5376).reshape(1, 2, 5376) / 10000).to(torch.bfloat16)
        with torch.random.fork_rng(devices=[]), patch.dict(sys.modules, {GC_NAME: gc}):
            torch.set_rng_state(initial_rng)
            x = data.clone().requires_grad_(True)
            reference = model(x)
            reference.float().square().sum().backward()
            expected_x_grad = x.grad.clone()
            expected_parameter_grads = {name: p.grad.clone() for name, p in model.named_parameters()}
            expected_rng, expected_hooks = torch.get_rng_state(), list(hooks)
            self.assertEqual(mlp.calls, 3)
            model.zero_grad(set_to_none=True)
            mlp.calls = 0
            hooks.clear()
            torch.set_rng_state(initial_rng)
            x = data.clone().requires_grad_(True)
            saved = mlp.forward
            with policy.single_tile_recompute(model, max_tokens=max_tokens) as report:
                actual = model(x)
                actual.float().square().sum().backward()
            torch.testing.assert_close(actual, reference, rtol=0, atol=0)
            torch.testing.assert_close(x.grad, expected_x_grad, rtol=0, atol=0)
            for name, p in model.named_parameters():
                torch.testing.assert_close(p.grad, expected_parameter_grads[name], rtol=0, atol=0)
            self.assertTrue(torch.equal(torch.get_rng_state(), expected_rng))
            self.assertEqual(hooks, expected_hooks)
            self.assertEqual(mlp.calls, expected_calls)
            self.assertIs(mlp.forward, saved)
            self.assertEqual(report["bypassed_recompute_calls"], 60 if expected_calls == 2 else 0)
            self.assertEqual(len(mlp._forward_pre_hooks), 1)
            self.assertEqual(len(mlp._forward_hooks), 1)
        pre.remove()
        post.remove()

    def test_single_tile_preserves_outputs_gradients_rng_and_hooks_with_three_to_two_calls(self):
        self.exercise(max_tokens=5376, expected_calls=2)

    def test_row_over_policy_limit_keeps_three_calls_and_identical_gradients(self):
        self.exercise(max_tokens=1, expected_calls=3)


if __name__ == "__main__":
    unittest.main()
