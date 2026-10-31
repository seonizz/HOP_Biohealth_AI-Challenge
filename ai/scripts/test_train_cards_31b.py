"""CPU-only contract regressions for the 31B indexed curriculum runner."""
import importlib.util
import json
from fractions import Fraction
from pathlib import Path
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("train_cards_31b.py")
SPEC = importlib.util.spec_from_file_location("train_cards_31b", SCRIPT)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


def row(identity, numerator=1, denominator=1, target_length=1):
    return {"row_id": identity, "weight": {"numerator": numerator, "denominator": denominator},
            "target_length": target_length}


class EpochObjectiveTests(unittest.TestCase):
    def test_unequal_targets_and_last_window_preserve_full_epoch_row_objective(self):
        rows = [row("short", 1, 2, 1), row("long", 1, 1, 200), row("last", 3, 2, 7)]
        losses = [Fraction(2), Fraction(7), Fraction(11)]
        plan = runner.epoch_plan(rows, accumulation=2, seed=3407)
        self.assertEqual(plan["windows"], 2)
        self.assertEqual(sorted(plan["order"]), [0, 1, 2])
        coefficients = [runner.coefficient(r, plan) for r in rows]
        self.assertEqual(coefficients, [Fraction(1, 3), Fraction(2, 3), Fraction(1)])
        windows = [plan["order"][i:i + 2] for i in range(0, 3, 2)]
        self.assertEqual([len(w) for w in windows], [2, 1])
        window_mean = sum(sum(coefficients[i] * losses[i] for i in w) for w in windows) / len(windows)
        expected = sum(runner.weight(r) * loss for r, loss in zip(rows, losses)) / len(rows)
        self.assertEqual(window_mean, expected)
        token_mean = sum(runner.weight(r) * r["target_length"] * loss for r, loss in zip(rows, losses)) / sum(
            runner.weight(r) * r["target_length"] for r in rows)
        self.assertNotEqual(window_mean, token_mean)

    def test_accumulation_changes_scale_but_not_epoch_objective(self):
        rows = [row(str(i)) for i in range(5)]
        for accumulation in (1, 2, 5, 8):
            with self.subTest(accumulation=accumulation):
                plan = runner.epoch_plan(rows, accumulation, 1)
                self.assertEqual(sum(runner.coefficient(r, plan) for r in rows) / plan["windows"], 1)
                self.assertEqual(plan, runner.epoch_plan(rows, accumulation, 1))

    def test_normalized_weights_required_without_silently_rescaling(self):
        with self.assertRaisesRegex(ValueError, "Unnormalized"):
            runner.epoch_plan([row("a", 2), row("b", 2)], 2, 1)

    def test_duplicate_ids_rejected_even_when_weights_normalized(self):
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            runner.epoch_plan([row("same"), row("same")], 2, 1)

    def test_empty_plan_invalid_accumulation_and_invalid_weights(self):
        for accumulation in (0, -1, True, 1.5):
            with self.subTest(accumulation=accumulation), self.assertRaises(ValueError):
                runner.epoch_plan([row("a")], accumulation, 1)
        with self.assertRaises(ValueError):
            runner.epoch_plan([], 1, 1)
        for numerator, denominator in ((0, 1), (-1, 1), (True, 1), (1, 0), (1, 1.0)):
            with self.subTest(numerator=numerator, denominator=denominator), self.assertRaises(ValueError):
                runner.weight(row("bad", numerator, denominator))


class LossDecisionTests(unittest.TestCase):
    def test_relative_half_percent_improvement_is_required(self):
        self.assertEqual(runner.loss_decision(10.0, [9.951], 3), "continue")
        self.assertEqual(runner.loss_decision(10.0, [9.95], 3), "stop_phase_accepted")

    def test_absolute_point_zero_zero_one_floor_applies(self):
        self.assertEqual(runner.loss_decision(0.1, [0.0991], 3), "continue")
        self.assertEqual(runner.loss_decision(0.1, [0.099], 3), "stop_phase_accepted")

    def test_resource_cap_does_not_mark_unmet_performance_accepted(self):
        self.assertEqual(runner.loss_decision(10.0, [], 3), "continue")
        self.assertEqual(runner.loss_decision(10.0, [9.99], 1), "stop_resource_limit")
        self.assertEqual(runner.loss_decision(10.0, [10.0, 10.0], 3), "stop_phase_rejected")
        self.assertEqual(runner.loss_decision(10.0, [10.4, 10.5], 3), "stop_phase_rejected")

    def test_final_phase_always_requires_role_evaluation(self):
        for value in (8.0, 9.99, 10.5):
            with self.subTest(value=value):
                self.assertEqual(runner.loss_decision(10.0, [value], 5, final=True), "stop_pending_evaluation")

    def test_no_history_may_continue_after_a_stop(self):
        for values, cap, final in (([9.0, 8.0], 3, False), ([10.0, 10.0, 9.0], 3, False),
                                   ([9.99, 9.98], 5, True), ([10.0, 10.0], 1, False)):
            with self.subTest(values=values, cap=cap, final=final), self.assertRaises(ValueError):
                runner.loss_decision(10.0, values, cap, final)

    def test_invalid_losses_and_caps_rejected(self):
        for baseline, values, cap in ((float("nan"), [], 1), (-1, [], 1), (1, [float("inf")], 2),
                                      (1, [-1], 2), (1, [], 0)):
            with self.subTest(baseline=baseline, values=values, cap=cap), self.assertRaises(ValueError):
                runner.loss_decision(baseline, values, cap)


class CheckpointIntegrityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        # Resolve macOS /var -> /private/var before testing ancestor links.
        self.root = Path(self.temp.name).resolve()
        self.checkpoint = self.root / "checkpoint"
        self.checkpoint.mkdir()
        self.binding = {"dataset": "fixed", "objective": "row_mean", "seed": 3407}
        (self.checkpoint / "adapter_model.safetensors").write_bytes(b"local adapter fixture")
        (self.checkpoint / "training_state.pt").write_bytes(b"local optimizer fixture")
        self.manifest = {"binding": self.binding, "progress": {"step": 1, "cursor": 2},
                         "files": {p.name: runner.sha(p) for p in self.checkpoint.iterdir()}}
        self.write_manifest()

    def write_manifest(self):
        (self.checkpoint / "CHECKPOINT.json").write_text(json.dumps(self.manifest))

    def test_valid_checkpoint_and_binding(self):
        self.assertEqual(runner.verify_checkpoint(self.checkpoint, self.binding), self.manifest)
        with self.assertRaisesRegex(ValueError, "binding"):
            runner.verify_checkpoint(self.checkpoint, {**self.binding, "dataset": "changed"})

    def test_changed_or_missing_files_rejected(self):
        adapter = self.checkpoint / "adapter_model.safetensors"
        adapter.write_bytes(b"changed fixture")
        with self.assertRaisesRegex(ValueError, "hash"):
            runner.verify_checkpoint(self.checkpoint, self.binding)
        adapter.unlink()
        with self.assertRaisesRegex(ValueError, "inventory"):
            runner.verify_checkpoint(self.checkpoint, self.binding)

    def test_unexpected_file_rejected(self):
        (self.checkpoint / "extra.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "inventory"):
            runner.verify_checkpoint(self.checkpoint, self.binding)

    def test_nested_checkpoint_named_file_cannot_escape_inventory(self):
        nested = self.checkpoint / "extra"
        nested.mkdir()
        (nested / "CHECKPOINT.json").write_text("{}")
        with self.assertRaises(ValueError):
            runner.verify_checkpoint(self.checkpoint, self.binding)

    def test_checkpoint_directory_link_rejected(self):
        link = self.root / "checkpoint-link"
        link.symlink_to(self.checkpoint, target_is_directory=True)
        with self.assertRaises(ValueError):
            runner.verify_checkpoint(link, self.binding)

    def test_ancestor_directory_link_rejected(self):
        link = self.root / "parent-link"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(ValueError):
            runner.verify_checkpoint(link / "checkpoint", self.binding)

    def test_manifest_symlink_rejected(self):
        path = self.checkpoint / "CHECKPOINT.json"
        external = self.root / "manifest.json"
        external.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(external)
        with self.assertRaises(ValueError):
            runner.verify_checkpoint(self.checkpoint, self.binding)

    def test_data_symlink_and_traversal_manifest_rejected(self):
        path = self.checkpoint / "adapter_model.safetensors"
        external = self.root / "adapter.bin"
        external.write_bytes(path.read_bytes())
        path.unlink()
        path.symlink_to(external)
        with self.assertRaises(ValueError):
            runner.verify_checkpoint(self.checkpoint, self.binding)
        path.unlink()
        path.write_bytes(external.read_bytes())
        self.manifest["files"]["../adapter.bin"] = runner.sha(external)
        self.write_manifest()
        with self.assertRaises(ValueError):
            runner.verify_checkpoint(self.checkpoint, self.binding)


class LatestCheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name).resolve()
        (self.work / "checkpoints").mkdir()
        self.binding = {"dataset": "fixed", "objective": "row_mean", "seed": 3407}

    def checkpoint(self, name, step, phase="00_original_warmup", epoch=1):
        path = self.work / "checkpoints" / name
        path.mkdir()
        (path / "adapter_model.safetensors").write_bytes(b"local adapter fixture")
        (path / "training_state.pt").write_bytes(b"local optimizer fixture")
        manifest = {"binding": self.binding,
                    "progress": {"phase": phase, "epoch": epoch, "step": step, "cursor": 2},
                    "files": {p.name: runner.sha(p) for p in path.iterdir()}}
        (path / "CHECKPOINT.json").write_text(json.dumps(manifest))
        return path

    def test_missing_latest_pointer_uses_highest_committed_global_step(self):
        self.checkpoint("z-lexically-last-but-older", step=4, epoch=3)
        latest = self.checkpoint("a-newer-global-step", step=5, epoch=1)
        self.assertFalse((self.work / "latest.json").exists())
        self.assertEqual(runner.latest_checkpoint(self.work, self.binding), latest)

    def test_stale_latest_pointer_does_not_hide_new_commit(self):
        older = self.checkpoint("old", step=4)
        latest = self.checkpoint("new", step=5)
        (self.work / "latest.json").write_text(json.dumps({"checkpoint": str(older.relative_to(self.work))}))
        self.assertEqual(runner.latest_checkpoint(self.work, self.binding), latest)

    def test_incomplete_writing_directory_is_ignored(self):
        committed = self.checkpoint("committed", step=4)
        partial = self.work / "checkpoints" / ".writing-interrupted"
        partial.mkdir()
        # A crash can leave an absent, truncated, or untrusted manifest here.
        (partial / "CHECKPOINT.json").write_text("not valid JSON")
        self.assertEqual(runner.latest_checkpoint(self.work, self.binding), committed)

    def test_same_global_step_prefers_next_phase_epoch_zero(self):
        self.checkpoint("warmup-last", step=10, phase="00_original_warmup", epoch=3)
        repair = self.checkpoint("repair-start", step=10, phase="01_card_repair", epoch=0)
        self.assertEqual(runner.latest_checkpoint(self.work, self.binding), repair)
        self.checkpoint("repair-last", step=11, phase="01_card_repair", epoch=2)
        generation = self.checkpoint("generation-start", step=11, phase="02_card_generation", epoch=0)
        self.assertEqual(runner.latest_checkpoint(self.work, self.binding), generation)

    def test_selected_checkpoint_hash_tampering_rejected_without_fallback(self):
        self.checkpoint("older-intact", step=4)
        latest = self.checkpoint("newer-tampered", step=5)
        (latest / "adapter_model.safetensors").write_bytes(b"changed adapter fixture")
        with self.assertRaisesRegex(ValueError, "hash"):
            runner.latest_checkpoint(self.work, self.binding)

    def test_selected_checkpoint_binding_tampering_rejected_without_fallback(self):
        self.checkpoint("older-intact", step=4)
        latest = self.checkpoint("newer-tampered", step=5)
        path = latest / "CHECKPOINT.json"
        manifest = json.loads(path.read_text())
        manifest["binding"] = {**self.binding, "dataset": "different"}
        path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(ValueError, "binding"):
            runner.latest_checkpoint(self.work, self.binding)


if __name__ == "__main__":
    unittest.main()
