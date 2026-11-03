"""Full-context and per-example-objective checks; optional CPU torch numerics."""
import importlib.util
import os
from pathlib import Path
import random
import sys
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("cards31b_compute", Path(__file__).with_name("cards31b_compute.py"))
compute = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(compute)
TORCH_AVAILABLE = importlib.util.find_spec("torch") is not None


def row(identity, length, prefix):
    ids = [2 + i % 13 for i in range(length)]
    encoded = {"sequence_length": length, "prefix_length": prefix, "target_length": length - prefix,
               "input_ids": ids, "attention_mask": [1] * length, "labels": [-100] * prefix + ids[prefix:]}
    return {"row_id": identity, "sequence_length": length, "prefix_length": prefix,
            "target_length": length - prefix, "encoded": encoded}


class PlanningTests(unittest.TestCase):
    def test_sorted_padded_budget_and_all_original_indices(self):
        entries = [row(str(i), length, 1) for i, length in enumerate([19, 3, 8, 8, 4, 20, 7])]
        batches = compute.plan_validation_batches(entries, token_budget=24, max_batch_size=3)
        self.assertEqual([i for batch in batches for i in batch], [1, 4, 6, 2, 3, 0, 5])
        self.assertEqual(sorted(i for batch in batches for i in batch), list(range(len(entries))))
        for batch in batches:
            self.assertLessEqual(len(batch), 3)
            self.assertLessEqual(len(batch) * max(entries[i]["sequence_length"] for i in batch), 24)

    def test_oversized_singleton_is_preserved_without_truncation(self):
        entries = [row("large", 25, 1), row("small", 3, 1)]
        self.assertEqual(compute.plan_validation_batches(entries, token_budget=8), [[1], [0]])

    def test_explicit_remaining_indices_and_empty_plan(self):
        entries = [row(str(i), i + 2, 1) for i in range(5)]
        self.assertEqual(compute.plan_validation_batches(entries, indices=[4, 1]), [[1, 4]])
        self.assertEqual(compute.plan_validation_batches(entries, indices=[]), [])
        self.assertEqual(compute.plan_validation_batches([]), [])

    def test_bad_indices_lengths_duplicate_ids_and_settings_rejected(self):
        entries = [row("a", 3, 1)]
        for indices in ([0, 0], [-1], [1], [True]):
            with self.subTest(indices=indices), self.assertRaises(ValueError):
                compute.plan_validation_batches(entries, indices=indices)
        for keyword, value in (("token_budget", 0), ("token_budget", True), ("max_batch_size", 0)):
            with self.subTest(keyword=keyword), self.assertRaises(ValueError):
                compute.plan_validation_batches(entries, **{keyword: value})
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            compute.plan_validation_batches(entries + entries)
        with self.assertRaisesRegex(ValueError, "sequence"):
            compute.plan_validation_batches([{"row_id": "bad", "sequence_length": 32769}])


class CollationTests(unittest.TestCase):
    def test_all_input_and_targets_preserved_with_only_right_padding(self):
        rows = [row("short", 3, 1), row("long", 7, 5)]
        before = repr(rows)
        batch = compute.collate_rows(rows)
        self.assertEqual(batch["row_ids"], ["short", "long"])
        self.assertEqual(batch["sequence_lengths"], [3, 7])
        self.assertEqual(batch["target_lengths"], [2, 2])
        self.assertEqual(batch["input_ids"][0], rows[0]["encoded"]["input_ids"] + [0] * 4)
        self.assertEqual(batch["attention_mask"][0], [1] * 3 + [0] * 4)
        self.assertEqual(batch["labels"][0], [-100, 3, 4] + [-100] * 4)
        self.assertEqual(batch["labels"][1], [-100] * 5 + [7, 8])
        self.assertEqual(repr(rows), before)

    def test_corrupted_mask_and_metadata_are_rejected(self):
        cases = []
        bad = row("bad", 5, 2); bad["encoded"]["labels"][1] = 3; cases.append(bad)
        bad = row("bad", 5, 2); bad["encoded"]["attention_mask"][0] = 0; cases.append(bad)
        bad = row("bad", 5, 2); bad["target_length"] = 2; cases.append(bad)
        bad = row("bad", 5, 2); bad["encoded"]["input_ids"][0] = -1; cases.append(bad)
        bad = row("bad", 5, 2); bad["encoded"]["input_ids"][0] = 262144; cases.append(bad)
        for bad in cases:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                compute.collate_rows([bad])

    def test_duplicate_empty_and_overlength_batches_are_rejected(self):
        for rows in ([], [row("same", 3, 1), row("same", 4, 1)]):
            with self.assertRaises(ValueError):
                compute.collate_rows(rows)
        with self.assertRaises(ValueError):
            compute.collate_rows([row("long", 9, 2)], max_length=8)


class LazyCompilerTests(unittest.TestCase):
    def test_cuda_forward_reuses_installed_source_options_and_one_compile(self):
        calls = []
        installed = types.ModuleType("unsloth_zoo.fused_losses.cross_entropy_loss")
        installed.compute_fused_ce_loss = object()
        installed.torch_compile_options = {"epilogue_fusion": True}
        compiled = object()
        fake_torch = types.ModuleType("torch")

        def compile_function(function, **kwargs):
            calls.append((function, kwargs))
            return compiled

        fake_torch.compile = compile_function
        with patch.object(compute, "_CUDA_FORWARD_CE", None), patch.dict(sys.modules, {
                "torch": fake_torch, installed.__name__: installed}):
            self.assertIs(compute._cuda_forward_ce(), compiled)
            self.assertIs(compute._cuda_forward_ce(), compiled)
        self.assertEqual(len(calls), 1)
        self.assertIs(calls[0][0], installed.compute_fused_ce_loss)
        self.assertEqual(calls[0][1], {"dynamic": True, "fullgraph": True,
                                      "options": installed.torch_compile_options})


class ReferenceChunkTests(unittest.TestCase):
    def test_short_target_keeps_original_gemm_row_count(self):
        self.assertEqual(compute.reference_chunk_ranges(297, 270, 1), [(0, 297)])

    def test_only_all_ignored_chunks_are_skipped_including_final_position(self):
        self.assertEqual(compute.reference_chunk_ranges(10, 8, 4), [(6, 9)])
        self.assertEqual(compute.reference_chunk_ranges(10, 8, 4, skip_masked=False),
                         [(0, 3), (3, 6), (6, 9), (9, 10)])
        self.assertEqual(compute.reference_chunk_ranges(13, 5, 4), [(4, 8), (8, 12)])

    def test_torch_chunk_can_return_fewer_slices_than_requested(self):
        self.assertEqual(compute.reference_chunk_ranges(5, 1, 4, skip_masked=False),
                         [(0, 2), (2, 4), (4, 5)])
        self.assertEqual(compute.reference_chunk_ranges(5, 1, 4), [(0, 2), (2, 4)])
        self.assertEqual(compute.reference_chunk_ranges(3, 1, 8), [(0, 1), (1, 2)])

    def test_invalid_chunk_contract_rejected(self):
        for args in ((3, 0, 1), (3, 3, 1), (32769, 1, 1), (3, 1, 0), (3, 1, True)):
            with self.subTest(args=args), self.assertRaises(ValueError):
                compute.reference_chunk_ranges(*args)

    def test_chunk_sizing_uses_full_hidden_gradient_buffer_budget(self):
        calls = []
        hidden = types.SimpleNamespace(ndim=2, shape=(297, 5376),
                                       numel=lambda: 297 * 5376, element_size=lambda: 2)
        head = types.SimpleNamespace(weight=types.SimpleNamespace(shape=(262144, 5376), requires_grad=False), bias=None)
        module = types.ModuleType("unsloth_zoo.fused_losses.cross_entropy_loss")

        def get_chunk_size(*args, **kwargs):
            calls.append((args, kwargs))
            return 1

        module.get_chunk_size = get_chunk_size
        with patch.dict(sys.modules, {module.__name__: module}):
            self.assertEqual(compute.reference_head_chunk_count(hidden, head), 1)
        self.assertEqual(calls, [((1, 297, 262144), {"target_gb": None,
                                                 "fixed_gb": 297 * 5376 * 2 / (1024 ** 3)})])


class HiddenStateEnvironmentTests(unittest.TestCase):
    def test_existing_flag_is_restored_after_success_and_failure(self):
        key = "UNSLOTH_RETURN_HIDDEN_STATES"
        for previous in ("0", "1", "other"):
            with self.subTest(previous=previous), patch.dict(os.environ, {key: previous}):
                with compute._return_hidden_states():
                    self.assertEqual(os.environ[key], "1")
                self.assertEqual(os.environ[key], previous)
                with self.assertRaisesRegex(RuntimeError, "forward failed"):
                    with compute._return_hidden_states():
                        self.assertEqual(os.environ[key], "1")
                        raise RuntimeError("forward failed")
                self.assertEqual(os.environ[key], previous)

    def test_absent_flag_is_removed_even_on_failure(self):
        key = "UNSLOTH_RETURN_HIDDEN_STATES"
        with patch.dict(os.environ):
            os.environ.pop(key, None)
            with self.assertRaises(RuntimeError):
                with compute._return_hidden_states():
                    self.assertEqual(os.environ[key], "1")
                    raise RuntimeError("forward failed")
            self.assertNotIn(key, os.environ)


@unittest.skipUnless(TORCH_AVAILABLE, "torch is not installed locally; run numerics in qualified environment")
class StabilizationTests(unittest.TestCase):
    def setUp(self):
        import torch
        self.torch = torch

        class Backbone(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.embed = torch.nn.Embedding(17, 4)
                self.embed.requires_grad_(False)
                self.lora_A = torch.nn.Parameter(torch.ones(4))
                self.register_buffer("scale", torch.tensor(1.0))
                self.embed.weight.quant_state = types.SimpleNamespace(
                    absmax=torch.tensor(1.0), code=torch.arange(3.0), offset=torch.tensor(0.0),
                    state2=types.SimpleNamespace(absmax=torch.tensor(2.0), code=torch.arange(2.0),
                                                 offset=torch.tensor(0.0), state2=None))
                self.calls = 0
                self.behavior = "cold"
                self.mutation = None

            def forward(self, input_ids, attention_mask, labels, use_cache):
                self.calls += 1
                assert not self.training and not torch.is_grad_enabled() and use_cache is False
                assert os.environ.get("UNSLOTH_RETURN_HIDDEN_STATES", "0") != "1"
                random.random()
                torch.rand(1)
                if self.mutation == "adapter":
                    self.lora_A.data.add_(1)  # Byte hash must catch writes bypassing _version.
                elif self.mutation == "parameter":
                    self.embed.weight.add_(1)
                elif self.mutation == "buffer":
                    self.scale.add_(1)
                elif self.mutation == "quant":
                    self.embed.weight.quant_state.state2.offset.add_(1)
                if self.behavior == "error":
                    raise RuntimeError("original forward failed")
                shift = float(self.calls) if self.behavior == "drift" else float(self.calls == 1)
                hidden = self.embed(input_ids) + self.lora_A + shift
                return types.SimpleNamespace(last_hidden_state=hidden)

        class Model(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.model = Backbone()
                self.lm_head = torch.nn.Linear(4, 17, bias=False)
                self.lm_head.requires_grad_(False)
                self.constant_loss = False

            def get_base_model(self):
                return self

            def get_input_embeddings(self):
                return self.model.embed

            def forward(self, **kwargs):
                hidden = self.model(**kwargs).last_hidden_state
                loss = torch.tensor(1.0) if self.constant_loss else hidden.mean()
                return types.SimpleNamespace(loss=loss)

        self.model_factory = Model
        self.model = Model()
        self.sample = row("warmup", 5, 3)

    def invoke_and_check_restoration(self, model):
        torch = self.torch
        model.train()
        model.model.embed.eval()  # Deliberately mixed original modes.
        modes = [(module, module.training) for module in model.modules()]
        python_state, cpu_state = random.getstate(), torch.get_rng_state().clone()
        cuda_states = torch.cuda.get_rng_state_all() if torch.cuda.is_available() else []
        hooks = len(model.model._forward_hooks)
        try:
            return compute.stabilize_evaluation(model, self.sample)
        finally:
            self.assertEqual(random.getstate(), python_state)
            self.assertTrue(torch.equal(torch.get_rng_state(), cpu_state))
            if cuda_states:
                self.assertTrue(all(torch.equal(a, b) for a, b in zip(torch.cuda.get_rng_state_all(), cuda_states)))
            self.assertTrue(all(module.training == training for module, training in modes))
            self.assertEqual(len(model.model._forward_hooks), hooks)

    def test_cold_transition_retained_and_three_calls_are_exactly_bounded(self):
        report = self.invoke_and_check_restoration(self.model)
        self.assertEqual(self.model.model.calls, 3)
        self.assertEqual(report["protocol"], compute.WARMUP_PROTOCOL)
        self.assertEqual(report["row_id"], self.sample["row_id"])
        self.assertEqual(report["status"], "passed")
        self.assertNotEqual(report["losses"][0], report["losses"][1])
        self.assertEqual(report["losses"][1], report["losses"][2])
        self.assertGreater(report["cold_hidden_max_abs"], 0)
        self.assertFalse(report["cold_hidden_equals_steady"])
        self.assertTrue(report["ce_2_equals_3"] and report["hidden_2_equals_3"])
        self.assertTrue(report["rng_restored"] and report["model_mode_restored"])
        self.assertTrue(report["adapter_bytes_unchanged"] and report["buffer_quant_bytes_unchanged"])
        self.assertGreater(report["buffer_quant_count"], 1)

    def test_persistent_ce_drift_fails_after_exactly_three_calls(self):
        self.model.model.behavior = "drift"
        with self.assertRaisesRegex(ValueError, "CE did not stabilize exactly"):
            self.invoke_and_check_restoration(self.model)
        self.assertEqual(self.model.model.calls, 3)

    def test_equal_ce_cannot_hide_persistent_hidden_drift(self):
        self.model.model.behavior = "drift"
        self.model.constant_loss = True
        with self.assertRaisesRegex(ValueError, "hidden states did not stabilize exactly"):
            self.invoke_and_check_restoration(self.model)
        self.assertEqual(self.model.model.calls, 3)

    def test_adapter_byte_mutation_without_version_change_is_rejected(self):
        self.model.model.mutation = "adapter"
        with self.assertRaisesRegex(ValueError, "adapters mutated"):
            self.invoke_and_check_restoration(self.model)

    def test_frozen_parameter_version_mutation_is_rejected(self):
        self.model.model.mutation = "parameter"
        with self.assertRaisesRegex(ValueError, "parameters mutated"):
            self.invoke_and_check_restoration(self.model)

    def test_registered_buffer_and_nested_quant_scalar_mutations_are_rejected(self):
        for mutation in ("buffer", "quant"):
            with self.subTest(mutation=mutation):
                model = self.model_factory()
                model.model.mutation = mutation
                with self.assertRaisesRegex(ValueError, "buffers_quant mutated"):
                    self.invoke_and_check_restoration(model)

    def test_original_exception_restores_rng_modes_and_hook(self):
        self.model.model.behavior = "error"
        with self.assertRaisesRegex(RuntimeError, "original forward failed"):
            self.invoke_and_check_restoration(self.model)

    def test_active_hidden_only_flag_is_rejected_without_changing_environment(self):
        with patch.dict(os.environ, {"UNSLOTH_RETURN_HIDDEN_STATES": "1"}):
            with self.assertRaisesRegex(ValueError, "original loss-returning"):
                self.invoke_and_check_restoration(self.model)
            self.assertEqual(os.environ["UNSLOTH_RETURN_HIDDEN_STATES"], "1")
        self.assertEqual(self.model.model.calls, 0)


@unittest.skipUnless(TORCH_AVAILABLE, "torch is not installed locally; run numerics in qualified environment")
class TorchNumericsTests(unittest.TestCase):
    def setUp(self):
        import torch
        self.torch = torch
        torch.manual_seed(7)

        class Backbone(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.embed = torch.nn.Embedding(17, 5)
                self.embed.weight.requires_grad_(False)
                self.adapter = torch.nn.Linear(5, 5, bias=False)
                self.norm = torch.nn.LayerNorm(5)
                self.norm.requires_grad_(False)

            def forward(self, input_ids, attention_mask, labels, use_cache, return_dict):
                assert use_cache is False and return_dict is True
                # Prefix tokens influence every target; padding has no influence.
                h = (self.embed(input_ids) * attention_mask.unsqueeze(-1)).cumsum(dim=1)
                h = h / torch.arange(1, h.shape[1] + 1, device=h.device).view(1, -1, 1)
                return types.SimpleNamespace(last_hidden_state=self.norm(self.adapter(h)))

        class Model(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.model = Backbone()
                self.lm_head = torch.nn.Linear(5, 17, bias=True)
                self.lm_head.requires_grad_(False)
                self.config = types.SimpleNamespace(get_text_config=lambda: types.SimpleNamespace(final_logit_softcapping=30.0))
                self.forward_calls = 0

            def forward(self, **kwargs):
                self.forward_calls += 1
                hidden = self.model(**kwargs).last_hidden_state
                assert os.environ.get("UNSLOTH_RETURN_HIDDEN_STATES") == "1"
                return types.SimpleNamespace(logits=hidden, loss=None)

            def get_base_model(self):
                return self

            def get_input_embeddings(self):
                return self.model.embed

        self.model = Model()
        self.rows = [row("a", 8, 6), row("b", 4, 1), row("c", 7, 2)]
        self.loss_module = types.ModuleType("unsloth_zoo.fused_losses.cross_entropy_loss")
        self.loss_module.get_chunk_size = lambda *args, **kwargs: 1
        module_patch = patch.dict(sys.modules, {self.loss_module.__name__: self.loss_module})
        module_patch.start()
        self.addCleanup(module_patch.stop)

    def dense_reference(self, row_value):
        torch = self.torch
        base, hidden, collated = compute.backbone_hidden(self.model, [row_value])
        logits = base.lm_head(hidden)
        logits = torch.tanh(logits / 30.0) * 30.0
        targets = torch.tensor(collated["labels"], device=logits.device)[:, 1:]
        return torch.nn.functional.cross_entropy(logits[:, :-1].reshape(-1, 17).float(), targets.reshape(-1))

    def test_target_full_and_batched_equal_dense_per_example(self):
        torch = self.torch
        self.model.eval()
        with torch.no_grad():
            reference = torch.stack([self.dense_reference(r) for r in self.rows])
            for mode in ("full", "target"):
                for chunk in (1, 3, 128):
                    actual = compute.evaluation_losses(self.model, self.rows, head_mode=mode, chunk_tokens=chunk)
                    torch.testing.assert_close(actual, reference, rtol=1e-5, atol=1e-6)
                    self.assertFalse(actual.requires_grad)
            self.assertTrue(all(p.grad is None for p in self.model.parameters()))
            self.assertEqual(self.model.forward_calls, len(self.rows) + 6)

    def test_top_level_forward_failure_restores_environment_and_unsupported_output_fails(self):
        key = "UNSLOTH_RETURN_HIDDEN_STATES"
        with patch.dict(os.environ, {key: "0"}):
            with patch.object(self.model, "forward", side_effect=RuntimeError("forward failed")):
                with self.assertRaisesRegex(RuntimeError, "forward failed"):
                    compute.backbone_hidden(self.model, self.rows)
            self.assertEqual(os.environ[key], "0")
            with patch.object(self.model, "forward", return_value=types.SimpleNamespace(loss=1, logits=None)):
                with self.assertRaisesRegex(ValueError, "did not honor"):
                    compute.backbone_hidden(self.model, self.rows)
            self.assertEqual(os.environ[key], "0")

    def test_prefix_changes_affect_target_loss_and_batch_mean_is_not_token_mean(self):
        torch = self.torch
        self.model.eval()
        changed = row("a", 8, 6)
        changed["encoded"]["input_ids"][0] = 15
        with torch.no_grad():
            values = compute.evaluation_losses(self.model, self.rows)
            changed_value = compute.evaluation_losses(self.model, [changed])[0]
        self.assertGreater(float((values[0] - changed_value).abs()), 1e-7)
        counts = torch.tensor([r["target_length"] for r in self.rows])
        self.assertGreater(float((values.mean() - (values * counts).sum() / counts.sum()).abs()), 1e-7)

    def test_aligned_training_ce_preserves_full_context_gradient(self):
        torch = self.torch
        calls = []

        def fused(**kwargs):
            calls.append(kwargs)
            self.assertFalse(kwargs["shift_labels"])
            self.assertFalse(kwargs["overwrite"])
            self.assertEqual(kwargs["n_chunks"], 1)
            h = kwargs["hidden_states"]
            logits = torch.nn.functional.linear(h, kwargs["lm_head_weight"], kwargs["lm_head_bias"])
            logits = torch.tanh(logits / kwargs["logit_softcapping"]) * kwargs["logit_softcapping"]
            return torch.nn.functional.cross_entropy(logits.reshape(-1, 17).float(), kwargs["labels"].reshape(-1),
                                                      reduction="sum", ignore_index=-100) / kwargs["n_items"]

        module_name = "unsloth_zoo.fused_losses.cross_entropy_loss"
        module = types.ModuleType(module_name)
        module.unsloth_fused_ce_loss = fused
        module.get_chunk_size = lambda *args, **kwargs: 1
        self.model.train()
        reference = self.dense_reference(self.rows[0])
        reference.backward()
        gradients = {n: p.grad.clone() for n, p in self.model.named_parameters() if p.requires_grad}
        self.model.zero_grad(set_to_none=True)
        with patch.dict(sys.modules, {module_name: module}):
            actual = compute.training_loss(self.model, self.rows[0])
            actual.backward()
        torch.testing.assert_close(actual, reference, rtol=1e-5, atol=1e-6)
        for name, parameter in self.model.named_parameters():
            if parameter.requires_grad:
                torch.testing.assert_close(parameter.grad, gradients[name], rtol=1e-5, atol=1e-6)
        self.assertEqual(tuple(calls[0]["hidden_states"].shape[:2]), (1, self.rows[0]["sequence_length"]))
        self.assertEqual(float(calls[0]["n_items"]), self.rows[0]["target_length"])

    def test_aligned_chunks_preserve_ignored_edges_and_full_context_gradient(self):
        torch = self.torch
        calls = []
        sample = row("chunked", 10, 8)
        self.loss_module.get_chunk_size = lambda *args, **kwargs: 4

        def fused(**kwargs):
            calls.append(kwargs)
            logits = torch.nn.functional.linear(kwargs["hidden_states"], kwargs["lm_head_weight"],
                                                kwargs["lm_head_bias"])
            logits = torch.tanh(logits / kwargs["logit_softcapping"]) * kwargs["logit_softcapping"]
            return torch.nn.functional.cross_entropy(logits.reshape(-1, 17).float(),
                                                      kwargs["labels"].reshape(-1), reduction="sum",
                                                      ignore_index=-100) / kwargs["n_items"]

        self.loss_module.unsloth_fused_ce_loss = fused
        self.model.train()
        reference = self.dense_reference(sample)
        reference.backward()
        gradients = {n: p.grad.clone() for n, p in self.model.named_parameters() if p.requires_grad}
        self.model.zero_grad(set_to_none=True)
        actual = compute.training_loss(self.model, sample)
        actual.backward()
        torch.testing.assert_close(actual, reference, rtol=1e-5, atol=1e-6)
        for name, parameter in self.model.named_parameters():
            if parameter.requires_grad:
                torch.testing.assert_close(parameter.grad, gradients[name], rtol=1e-5, atol=1e-6)
        self.assertEqual(len(calls), 1)
        self.assertEqual(tuple(calls[0]["hidden_states"].shape[:2]), (1, 3))
        self.assertEqual(calls[0]["labels"].tolist(), [[-100, 10, 11]])
        self.assertEqual(float(calls[0]["n_items"]), 2)
        self.assertEqual(calls[0]["n_chunks"], 1)

    def test_multiple_aligned_chunks_normalize_each_by_total_row_targets(self):
        torch = self.torch
        calls = []
        sample = row("multiple", 13, 5)
        self.loss_module.get_chunk_size = lambda *args, **kwargs: 4

        def fused(**kwargs):
            calls.append(kwargs)
            logits = torch.nn.functional.linear(kwargs["hidden_states"], kwargs["lm_head_weight"],
                                                kwargs["lm_head_bias"])
            logits = torch.tanh(logits / kwargs["logit_softcapping"]) * kwargs["logit_softcapping"]
            return torch.nn.functional.cross_entropy(logits.reshape(-1, 17).float(),
                                                      kwargs["labels"].reshape(-1), reduction="sum",
                                                      ignore_index=-100) / kwargs["n_items"]

        self.loss_module.unsloth_fused_ce_loss = fused
        self.model.train()
        reference = self.dense_reference(sample)
        reference.backward()
        gradients = {n: p.grad.clone() for n, p in self.model.named_parameters() if p.requires_grad}
        self.model.zero_grad(set_to_none=True)
        actual = compute.training_loss(self.model, sample)
        actual.backward()
        torch.testing.assert_close(actual, reference, rtol=1e-5, atol=1e-6)
        for name, parameter in self.model.named_parameters():
            if parameter.requires_grad:
                torch.testing.assert_close(parameter.grad, gradients[name], rtol=1e-5, atol=1e-6)
        self.assertEqual([tuple(c["hidden_states"].shape[:2]) for c in calls], [(1, 4), (1, 4)])
        self.assertEqual([float(c["n_items"]) for c in calls], [8, 8])
        self.assertTrue(all(c["n_chunks"] == 1 and not c["shift_labels"] for c in calls))
        self.model.eval()
        with torch.no_grad():
            skipped = compute.evaluation_losses(self.model, [sample], head_mode="target")
            full = compute.evaluation_losses(self.model, [sample], head_mode="full")
        torch.testing.assert_close(skipped, full, rtol=1e-5, atol=1e-6)

    def test_modes_and_trainable_head_rejected(self):
        torch = self.torch
        with self.assertRaisesRegex(ValueError, "Evaluation"):
            compute.evaluation_losses(self.model, self.rows)
        self.model.eval()
        with self.assertRaisesRegex(ValueError, "Training"):
            compute.training_loss(self.model, self.rows[0])
        self.model.lm_head.weight.requires_grad_(True)
        with torch.no_grad(), self.assertRaisesRegex(ValueError, "frozen"):
            compute.evaluation_losses(self.model, self.rows)


if __name__ == "__main__":
    unittest.main()
