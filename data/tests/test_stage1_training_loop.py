"""Pure contracts plus real CPU autograd checks when torch is installed."""

import importlib.util
from copy import deepcopy
import json
from pathlib import Path
import random
import tempfile
import unittest

from counseling_pipeline import stage1_training_loop as loop


def encoded(tokens, prefix=1):
    return {"input_ids": tokens, "labels": [-100] * prefix + tokens[prefix:],
            "attention_mask": [1] * len(tokens), "prefix_length": prefix,
            "target_length": len(tokens) - prefix, "sequence_length": len(tokens)}


def weighted_entries(rows):
    weights = [(2, 1), (1, 1), (1, 2), (1, 1), (1, 1)]
    return [{"stream": "conversation", "split": "train", "row_id": f"fixture-{i}",
             "encoded": deepcopy(row), "weight": {"numerator": a, "denominator": b}}
            for i, (row, (a, b)) in enumerate(zip(rows, weights))]


class TrainingPlanTests(unittest.TestCase):
    def setUp(self):
        self.rows = [encoded([1, 2]), encoded([2, 3, 4, 5]), encoded([3, 1, 2])]

    def test_plan_keeps_partial_window_and_does_not_mutate_global_rng(self):
        random.seed(17)
        before = random.getstate()
        plan = loop.make_plan(self.rows, pad_id=0, accumulation_steps=2)
        self.assertEqual(random.getstate(), before)
        self.assertEqual(plan, loop.make_plan(self.rows, pad_id=0, accumulation_steps=2))
        self.assertEqual(plan["optimizer_steps"], 2)
        self.assertEqual(plan["supervised_tokens"], 6)
        self.assertEqual(sorted(plan["order"]), [0, 1, 2])

    def test_unequal_target_lengths_are_token_weighted(self):
        self.assertEqual(loop.window_weights(self.rows, [0, 1]), ([1, 3], [0.25, 0.75]))
        self.assertEqual(loop.window_weights(self.rows, [2]), ([2], [1.0]))

    def test_rejects_shifted_labels(self):
        self.rows[0]["labels"] = [2, -100]
        with self.assertRaises(ValueError):
            loop.make_plan(self.rows, pad_id=0)

    def test_rejects_over_limit_without_truncation(self):
        with self.assertRaises(ValueError):
            loop.make_plan(self.rows, pad_id=0, max_length=3)
        self.assertEqual(self.rows[1]["input_ids"], [2, 3, 4, 5])

    def test_digest_binds_ids_and_dataset_order(self):
        first = loop.make_plan(self.rows, pad_id=0)
        second = loop.make_plan(list(reversed(self.rows)), pad_id=0)
        self.assertNotEqual(first["encoded_rows_sha256"], second["encoded_rows_sha256"])

    def test_rejects_empty_rows_and_invalid_window(self):
        for rows, size in [([], 8), (self.rows, 0), (self.rows, True), (self.rows, 1.5)]:
            with self.assertRaises(ValueError):
                loop.make_plan(rows, pad_id=0, accumulation_steps=size)

    def test_rejects_nan_bindings_serialization(self):
        with self.assertRaises(ValueError):
            loop._json_bytes({"learning_rate": float("nan")})

    def test_weighted_plan_preserves_full_task_divisor_and_tail(self):
        rows = self.rows + [encoded([4, 5, 2, 1]), encoded([2, 1])]
        entries = weighted_entries(rows)
        snapshot = deepcopy(entries)
        plan = loop._weighted_plan(rows, entries, task="conversation", bindings={"policy": "v11"},
                                   pad_id=0, accumulation_steps=2, shuffle=False)
        self.assertEqual(entries, snapshot)
        self.assertEqual(plan["windows"], [[0, 1], [2, 3], [4]])
        self.assertEqual(plan["weighted_target_tokens"], {"numerator": 10, "denominator": 1})
        self.assertEqual(plan["row_coefficients"], [
            {"numerator": 3, "denominator": 5}, {"numerator": 9, "denominator": 10},
            {"numerator": 3, "denominator": 10}, {"numerator": 9, "denominator": 10},
            {"numerator": 3, "denominator": 10}])

    def test_weighted_plan_rejects_mismatched_rows_split_and_partial_mass(self):
        rows = self.rows + [encoded([4, 5, 2, 1]), encoded([2, 1])]
        entries = weighted_entries(rows)
        kwargs = dict(task="conversation", bindings={"policy": "v11"}, pad_id=0)
        changed = deepcopy(rows)
        changed[0] = encoded([1, 3])
        with self.assertRaisesRegex(loop.TrainingLoopError, "encoded rows differ"):
            loop._weighted_plan(changed, entries, **kwargs)
        with self.assertRaisesRegex(ValueError, "target-token mass"):
            loop._weighted_plan(rows[:2], entries[:2], **kwargs)
        entries[0]["split"] = "validation"
        with self.assertRaisesRegex(ValueError, "Mixed task or split"):
            loop._weighted_plan(rows, entries, **kwargs)


TORCH_AVAILABLE = importlib.util.find_spec("torch") is not None


@unittest.skipUnless(TORCH_AVAILABLE, "Real CPU autograd verification requires torch")
class TorchTrainingLoopTests(unittest.TestCase):
    def setUp(self):
        import torch
        self.torch = torch
        torch.set_num_threads(1)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.rows = [encoded([1, 2]), encoded([2, 3, 4, 5]), encoded([3, 1, 2]),
                     encoded([4, 5, 2, 1]), encoded([2, 1])]
        self.bindings = {"model": "cpu-fixture", "data": "fixture-five-rows", "config": "fixture"}

    def make_model(self, dropout=0.0):
        torch = self.torch

        class TinyAdapter(torch.nn.Module):
            def __init__(self):
                super().__init__()
                self.embedding = torch.nn.Embedding(8, 4)
                self.embedding.weight.requires_grad_(False)
                self.adapter = torch.nn.Linear(4, 8, bias=False)
                self.dropout = torch.nn.Dropout(dropout)

            def forward(self, input_ids, labels, attention_mask):
                from types import SimpleNamespace
                logits = self.adapter(self.dropout(self.embedding(input_ids[:, :-1])))
                loss = torch.nn.functional.cross_entropy(logits.reshape(-1, 8),
                                                          labels[:, 1:].reshape(-1), ignore_index=-100)
                return SimpleNamespace(loss=loss)

            def save_pretrained(self, directory, safe_serialization=True):
                torch.save(self.adapter.state_dict(), Path(directory) / "adapter_model.pt")

        torch.manual_seed(1234)
        return TinyAdapter()

    def restore_adapter(self, model, checkpoint):
        model.adapter.load_state_dict(self.torch.load(checkpoint / "adapter_model.pt", weights_only=True))

    def optimizer(self, model):
        return self.torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],
                                      lr=0.01, foreach=False)

    def run_model(self, model, directory, **kwargs):
        optimizer = self.optimizer(model)
        scheduler = self.torch.optim.lr_scheduler.LambdaLR(optimizer, lambda step: 0.9 ** step)
        report = loop.run_training(model, optimizer, self.rows, directory, pad_id=0,
                                   bindings=self.bindings, accumulation_steps=2, checkpoint_every=2,
                                   scheduler=scheduler, restore_adapter=self.restore_adapter, **kwargs)
        return report, optimizer, scheduler

    def test_resume_matches_uninterrupted_parameters_optimizer_scheduler(self):
        full = self.make_model(dropout=0.25)
        full_report, full_optimizer, full_scheduler = self.run_model(full, self.root / "full")
        interrupted = self.make_model(dropout=0.25)
        paused, _, _ = self.run_model(interrupted, self.root / "resume", max_steps=1)
        self.assertEqual(paused["status"], "step_cap_reached")
        resumed = self.make_model(dropout=0.25)
        report, optimizer, scheduler = self.run_model(resumed, self.root / "resume", resume_from="latest")
        self.assertEqual(report["status"], "completed")
        self.assertEqual(report["completed_optimizer_steps"], 3)
        self.assertEqual(report["next_row_cursor"], 5)
        self.assertEqual(full_report["completed_optimizer_steps"], 3)
        self.assertTrue(self.torch.equal(full.adapter.weight, resumed.adapter.weight))
        self.assertEqual(full_scheduler.state_dict(), scheduler.state_dict())
        for key, expected in full_optimizer.state_dict()["state"][0].items():
            self.assertTrue(self.torch.equal(expected, optimizer.state_dict()["state"][0][key]))
        events = [json.loads(line) for line in (self.root / "resume" / "train.jsonl").read_text().splitlines()]
        self.assertEqual([item["microbatches"] for item in events], [2, 2, 1])
        self.assertEqual(sum(item["supervised_tokens"] for item in events), 10)

    def test_accumulation_matches_token_weighted_reference_update(self):
        reference, actual = self.make_model(), self.make_model()
        opt_reference, opt_actual = self.optimizer(reference), self.optimizer(actual)
        counts = [1, 3]
        loss = sum(reference(**loop._batch(row, 0, 4096, "cpu")).loss * count
                   for row, count in zip(self.rows[:2], counts)) / sum(counts)
        loss.backward()
        self.torch.nn.utils.clip_grad_norm_(reference.adapter.parameters(), 1.0, error_if_nonfinite=True)
        opt_reference.step()
        result = loop.run_training(actual, opt_actual, self.rows[:2], self.root / "weighted", pad_id=0,
                                   bindings=self.bindings, accumulation_steps=8, shuffle=False)
        self.assertTrue(self.torch.equal(reference.adapter.weight, actual.adapter.weight))
        self.assertEqual(result["completed_optimizer_steps"], 1)
        event = json.loads((self.root / "weighted" / "train.jsonl").read_text())
        self.assertAlmostEqual(event["target_mean_loss"], float(loss.item()), places=6)

    def test_eval_weights_tokens_and_preserves_model_mode(self):
        model = self.make_model()
        model.train()
        expected = sum(float(model(**loop._batch(row, 0, 4096, "cpu")).loss.item()) * row["target_length"]
                       for row in self.rows) / 10
        result = loop.evaluate(model, self.rows, pad_id=0)
        self.assertAlmostEqual(result["target_mean_loss"], expected, places=6)
        self.assertTrue(model.training)
        self.assertFalse(result["behavioral_quality_verified"])

    def test_resume_recovers_committed_checkpoint_without_latest_pointer(self):
        self.run_model(self.make_model(), self.root / "recover", max_steps=1)
        (self.root / "recover" / "latest.json").unlink()
        result, _, _ = self.run_model(self.make_model(), self.root / "recover", resume_from="latest")
        self.assertEqual(result["completed_optimizer_steps"], 3)

    def test_tampered_checkpoint_is_rejected_before_restoration(self):
        self.run_model(self.make_model(), self.root / "tamper", max_steps=1)
        checkpoint = self.root / "tamper" / "checkpoints" / "step-000000001" / "adapter_model.pt"
        with checkpoint.open("ab") as handle:
            handle.write(b"tamper")
        with self.assertRaisesRegex(loop.TrainingLoopError, "hash/path"):
            self.run_model(self.make_model(), self.root / "tamper", resume_from="latest")

    def test_changed_bindings_and_foreign_directory_are_rejected(self):
        self.run_model(self.make_model(), self.root / "original", max_steps=1)
        self.bindings = {**self.bindings, "model": "changed"}
        with self.assertRaisesRegex(loop.TrainingLoopError, "bindings/settings"):
            self.run_model(self.make_model(), self.root / "original", resume_from="latest")
        source, foreign = self.root / "original", self.root / "foreign"
        foreign.mkdir()
        # This fixture needs identical contents at a foreign path, not copied
        # metadata (chmod/utime are deliberately denied by the server sandbox).
        for path in sorted(source.rglob("*")):
            destination = foreign / path.relative_to(source)
            if path.is_dir():
                destination.mkdir()
            else:
                destination.write_bytes(path.read_bytes())
        self.bindings["model"] = "cpu-fixture"
        with self.assertRaisesRegex(loop.TrainingLoopError, "bindings/settings"):
            self.run_model(self.make_model(), self.root / "foreign", resume_from="latest")

    def test_nonfinite_loss_does_not_create_successful_checkpoint(self):
        model = self.make_model()
        with self.torch.no_grad():
            model.adapter.weight.fill_(float("nan"))
        with self.assertRaisesRegex(loop.TrainingLoopError, "Nonfinite"):
            self.run_model(model, self.root / "nonfinite")
        result = json.loads((self.root / "nonfinite" / "TRAINING_RESULT.json").read_text())
        self.assertEqual(result["status"], "running")
        self.assertFalse((self.root / "nonfinite" / "latest.json").exists())

    def test_adapter_restore_mismatch_is_rejected(self):
        self.run_model(self.make_model(), self.root / "wrongload", max_steps=1)
        model = self.make_model()
        optimizer = self.optimizer(model)
        scheduler = self.torch.optim.lr_scheduler.LambdaLR(optimizer, lambda s: .9 ** s)
        with self.assertRaisesRegex(loop.TrainingLoopError, "Restored adapter"):
            loop.run_training(model, optimizer, self.rows, self.root / "wrongload", pad_id=0,
                              bindings=self.bindings, accumulation_steps=2, checkpoint_every=2,
                              scheduler=scheduler,
                              resume_from="latest", restore_adapter=lambda model, path: None)

    def test_v11_update_uses_full_task_coefficients_without_window_renormalization(self):
        reference, actual = self.make_model(), self.make_model()
        opt_reference, opt_actual = self.optimizer(reference), self.optimizer(actual)
        entries = weighted_entries(self.rows)
        loss = (reference(**loop._batch(self.rows[0], 0, 4096, "cpu")).loss * .6
                + reference(**loop._batch(self.rows[1], 0, 4096, "cpu")).loss * .9)
        loss.backward()
        self.torch.nn.utils.clip_grad_norm_(reference.adapter.parameters(), 1.0, error_if_nonfinite=True)
        opt_reference.step()
        result = loop.run_training(actual, opt_actual, self.rows, self.root / "v11-reference",
                                   pad_id=0, bindings=self.bindings, accumulation_steps=2,
                                   shuffle=False, max_steps=1, weighted_entries=entries,
                                   task="conversation", required_gradient_devices=["cpu"])
        self.assertTrue(self.torch.equal(reference.adapter.weight, actual.adapter.weight))
        self.assertFalse(result["complete_weighted_epoch_verified"])
        event = json.loads((self.root / "v11-reference" / "train.jsonl").read_text())
        self.assertEqual(event["weighted_loss"]["sum_of_coefficients"],
                         {"numerator": 3, "denominator": 2})
        self.assertAlmostEqual(event["weighted_loss"]["scaled_window_loss"], loss.item(), places=6)
        self.assertEqual([e["row_id"] for e in event["coefficient_evidence"]], ["fixture-0", "fixture-1"])
        for evidence, expected in zip(event["coefficient_evidence"], [.6, .9]):
            self.assertEqual(evidence["observed_upstream_gradient"],
                             self.torch.tensor(expected).item())
        self.assertTrue(event["gradient_devices"]["cpu"]["nonzero"])

    def test_v11_resume_matches_uninterrupted_full_epoch_and_retains_tail(self):
        entries = weighted_entries(self.rows)
        kwargs = dict(weighted_entries=entries, task="conversation")
        full = self.make_model(dropout=.25)
        full_result, full_optimizer, full_scheduler = self.run_model(full, self.root / "v11-full", **kwargs)
        self.run_model(self.make_model(dropout=.25), self.root / "v11-resume", max_steps=1, **kwargs)
        resumed = self.make_model(dropout=.25)
        result, optimizer, scheduler = self.run_model(resumed, self.root / "v11-resume",
                                                     resume_from="latest", **kwargs)
        self.assertTrue(self.torch.equal(full.adapter.weight, resumed.adapter.weight))
        self.assertTrue(loop._state_equal(full_optimizer.state_dict(), optimizer.state_dict()))
        self.assertEqual(full_scheduler.state_dict(), scheduler.state_dict())
        self.assertTrue(result["complete_weighted_epoch_verified"])
        self.assertEqual(result["completed_optimizer_steps"], full_result["completed_optimizer_steps"])
        events = [json.loads(line) for line in (self.root / "v11-resume" / "train.jsonl").read_text().splitlines()]
        self.assertEqual([event["microbatches"] for event in events], [2, 2, 1])
        seen = [item["row_id"] for event in events for item in event["coefficient_evidence"]]
        self.assertEqual(len(seen), 5)
        self.assertEqual(set(seen), {entry["row_id"] for entry in entries})
        resume = json.loads((self.root / "v11-resume" / "resume.jsonl").read_text())
        for name in ["adapter_equal", "optimizer_equal", "scheduler_equal", "rng_equal"]:
            self.assertTrue(resume[name])
        manifest = json.loads((self.root / "v11-resume" / "RUN.json").read_text())
        checkpoint = json.loads((Path(result["checkpoint"]) / "CHECKPOINT.json").read_text())
        self.assertEqual(manifest["weighted_loss_plan"]["plan_sha256"], checkpoint["weighted_plan_sha256"])

    def test_v11_rejects_changed_weight_order_policy_and_callback_binding_on_resume(self):
        entries = weighted_entries(self.rows)
        self.run_model(self.make_model(), self.root / "v11-bound", max_steps=1,
                       weighted_entries=entries, task="conversation")
        changed = deepcopy(entries)
        changed[0]["weight"] = changed[2]["weight"] = {"numerator": 1, "denominator": 1}
        with self.assertRaisesRegex(loop.TrainingLoopError, "bindings/settings"):
            self.run_model(self.make_model(), self.root / "v11-bound", resume_from="latest",
                           weighted_entries=changed, task="conversation")
        self.rows.reverse()
        with self.assertRaisesRegex(loop.TrainingLoopError, "bindings/settings"):
            self.run_model(self.make_model(), self.root / "v11-bound", resume_from="latest",
                           weighted_entries=list(reversed(entries)), task="conversation")
        self.rows.reverse()
        original_bindings = self.bindings
        self.bindings = {**self.bindings, "policy": "changed"}
        with self.assertRaisesRegex(loop.TrainingLoopError, "bindings/settings"):
            self.run_model(self.make_model(), self.root / "v11-bound", resume_from="latest",
                           weighted_entries=entries, task="conversation")
        self.bindings = original_bindings
        with self.assertRaisesRegex(loop.TrainingLoopError, "bindings/settings"):
            self.run_model(self.make_model(), self.root / "v11-bound", resume_from="latest",
                           weighted_entries=entries, task="conversation", loss_callback=lambda row: None,
                           loss_callback_id="changed-forward-contract")

    def test_v11_custom_loss_sees_full_input_and_mutation_is_rejected(self):
        model = self.make_model()
        seen = []

        def callback(row):
            seen.append(deepcopy(row))
            return model(**loop._batch(row, 0, 4096, "cpu")).loss

        self.run_model(model, self.root / "v11-callback", max_steps=1,
                       weighted_entries=weighted_entries(self.rows), task="conversation",
                       shuffle=False, loss_callback=callback, loss_callback_id="fixture-ce-v1")
        self.assertEqual(seen, self.rows[:2])
        model = self.make_model()

        def destructive(row):
            result = model(**loop._batch(row, 0, 4096, "cpu")).loss
            row["input_ids"].pop()
            return result

        with self.assertRaisesRegex(loop.TrainingLoopError, "mutated"):
            self.run_model(model, self.root / "v11-mutation", weighted_entries=weighted_entries(self.rows),
                           task="conversation", loss_callback=destructive, loss_callback_id="mutating-fixture")
        self.assertFalse((self.root / "v11-mutation" / "latest.json").exists())

    def test_v11_rejects_wrong_gradient_devices_before_optimizer_step(self):
        model = self.make_model()
        before = model.adapter.weight.detach().clone()
        with self.assertRaisesRegex(loop.TrainingLoopError, "gradient devices"):
            self.run_model(model, self.root / "v11-devices", weighted_entries=weighted_entries(self.rows),
                           task="conversation", required_gradient_devices=["cuda:0", "cuda:1"])
        self.assertTrue(self.torch.equal(before, model.adapter.weight))
        self.assertFalse((self.root / "v11-devices" / "latest.json").exists())

    def test_failed_checkpoint_write_does_not_publish_or_leave_partial_directory(self):
        model = self.make_model()

        def fail_save(directory, safe_serialization=True):
            (Path(directory) / "adapter_model.pt").write_bytes(b"incomplete")
            raise OSError("injected checkpoint failure")

        model.save_pretrained = fail_save
        with self.assertRaisesRegex(OSError, "injected"):
            self.run_model(model, self.root / "failed-save", max_steps=1)
        self.assertFalse((self.root / "failed-save" / "latest.json").exists())
        self.assertEqual(list((self.root / "failed-save" / "checkpoints").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
