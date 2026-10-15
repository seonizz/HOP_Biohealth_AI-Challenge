"""Pure contracts plus real CPU autograd checks when torch is installed."""

import importlib.util
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
        import shutil
        shutil.copytree(self.root / "original", self.root / "foreign")
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


if __name__ == "__main__":
    unittest.main()
