"""CPU-only safety/selection/report tests; no model, CUDA, or server access."""
from fractions import Fraction
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import qualify_cards31b_replica as probe


ROOT = Path(__file__).resolve().parents[2]
REFERENCE_DIR = ROOT / "runtime/gpu-lora31b-opt-20261101"


def row(name, length, target, numerator=1, denominator=1):
    return {"row_id": name, "sequence_length": length, "target_length": target,
            "prefix_length": length - target, "split": "train",
            "weight": {"numerator": numerator, "denominator": denominator}}


def datasets():
    return {"original": SimpleNamespace(entries=[row("long", 25316, 100, 3, 2),
                                                 row("short", 100, 10, 1, 2)]),
            "cards": SimpleNamespace(entries=[row("target", 4000, 3000)])}


class SelectionTests(unittest.TestCase):
    def test_global_maxima_and_repeat_without_truncation(self):
        result = probe.select_probes(datasets())
        self.assertEqual([r["row_id"] for r in result], ["long", "target", "long"])
        self.assertEqual([r["sequence_length"] for r in result], [25316, 4000, 25316])
        self.assertEqual([r["phase"] for r in result], ["original", "cards", "original"])

    def test_same_maximum_row_still_receives_three_updates(self):
        data = {"only": SimpleNamespace(entries=[row("same", 25316, 20000)])}
        self.assertEqual(len(probe.select_probes(data)), 3)

    def test_changed_maximum_fails(self):
        data = datasets()
        data["original"].entries[0] = row("changed", 25315, 100)
        with self.assertRaisesRegex(ValueError, "maximum"):
            probe.select_probes(data)

    def test_validation_row_rejected(self):
        data = datasets()
        data["cards"].entries[0]["split"] = "validation"
        with self.assertRaisesRegex(ValueError, "metadata"):
            probe.select_probes(data)

    def test_inconsistent_target_metadata_rejected(self):
        data = datasets()
        data["cards"].entries[0]["target_length"] += 1
        with self.assertRaisesRegex(ValueError, "metadata"):
            probe.select_probes(data)

    def test_immutable_reference_matches_actual_source(self):
        self.assertEqual(probe.sha(REFERENCE_DIR / "reference_train_cards_31b.py"), probe.REFERENCE_SHA)


class FilesystemTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()

    def test_symlink_and_relative_escape_rejected(self):
        (self.root / "data").write_text("data")
        (self.root / "link").symlink_to(self.root / "data")
        for name in ("link", "../escape", "/absolute", "a//b"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                probe.child_file(self.root, name)

    def test_atomic_report_replacement_and_nonfinite_rejection(self):
        probe.atomic_report(self.root, {"status": "running"})
        probe.atomic_report(self.root, {"status": "failed"})
        self.assertEqual(json.loads((self.root / probe.REPORT_NAME).read_text()), {"status": "failed"})
        with self.assertRaises(ValueError):
            probe.atomic_report(self.root, {"invalid": float("nan")})
        self.assertEqual([p.name for p in self.root.iterdir()], [probe.REPORT_NAME])

    def test_all_stop_locations(self):
        work = self.root / "work"
        work.mkdir()
        for marker in (work / "STOP", self.root / "STOP", self.root / "CANCEL"):
            marker.touch()
            with self.subTest(marker=marker), self.assertRaises(probe.StopRequested):
                probe.check_stop(work)
            marker.unlink()
        probe.check_stop(work)


class RunTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.work = self.root / "work"
        self.work.mkdir()
        self.args = SimpleNamespace(work=self.work, reference_dir=REFERENCE_DIR)
        spec = importlib.util.spec_from_file_location("_test_original_reference",
                                                     REFERENCE_DIR / "reference_train_cards_31b.py")
        original = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(original)
        self.data = datasets()
        self.reference = SimpleNamespace(
            epoch_plan=original.epoch_plan, coefficient=original.coefficient,
            update=Mock(return_value={"gradient_devices": {"cuda:0": {"finite": True, "nonzero": True}},
                                      "weighted_loss_sum": 1.0, "gradient_norm": 2.0}),
            parameters=Mock(return_value=[object()]), parameter_sha=Mock(return_value="changed"))
        self.proof = {"probe_sha256": probe.sha(Path(probe.__file__))}
        self.torch = SimpleNamespace(cuda=Mock(), isfinite=Mock())
        self.torch.cuda.max_memory_allocated.return_value = 123
        self.torch.cuda.max_memory_reserved.return_value = 456
        self.torch.isfinite.return_value.all.return_value.item.return_value = True
        self.report = {"status": "running", "updates": [], "completed_updates": 0}
        self.model, self.optimizer = object(), object()
        self.loader = self.enter(patch.object(probe, "load_replica", return_value=(
            self.model, self.optimizer, {"initial_adapter_sha256": probe.INITIAL_ADAPTER_SHA})))
        self.enter(patch.object(probe, "preflight", return_value=(self.reference, {}, self.data, self.proof)))
        self.inventory = self.enter(patch.object(probe, "optimizer_inventory", side_effect=[
            {"optimizer_step": 1, "all_finite": True}, {"optimizer_step": 2, "all_finite": True},
            {"optimizer_step": 3, "all_finite": True}]))
        self.enter(patch.dict(sys.modules, {"torch": self.torch}))

    def enter(self, context):
        value = context.__enter__()
        self.addCleanup(context.__exit__, None, None, None)
        return value

    def test_uses_original_updates_and_full_epoch_coefficients(self):
        probe.run(self.args, self.report)
        calls = self.reference.update.call_args_list
        self.assertEqual(len(calls), 3)
        self.assertEqual([call.args[2:] for call in calls], [
            (self.data["original"], [0], self.reference.epoch_plan(self.data["original"].entries, 8, 3407)),
            (self.data["cards"], [0], self.reference.epoch_plan(self.data["cards"].entries, 8, 3407)),
            (self.data["original"], [0], self.reference.epoch_plan(self.data["original"].entries, 8, 3407))])
        self.assertTrue(all(call.args[:2] == (self.model, self.optimizer) for call in calls))
        self.assertEqual([Fraction(**r["coefficient"]) for r in self.report["updates"]],
                         [Fraction(3, 4), Fraction(1), Fraction(3, 4)])
        self.assertEqual(self.report["status"], "fit_passed")
        self.assertFalse(self.report["numerical_qualification"])
        self.assertFalse(self.report["ddp_qualification"])
        self.assertEqual(self.report["completed_updates"], 3)
        self.assertEqual(self.inventory.call_count, 3)

    def test_failure_after_first_step_does_not_retry_or_load_again(self):
        self.reference.update.side_effect = [{"weighted_loss_sum": 1.0}, RuntimeError("full head failed")]
        with self.assertRaisesRegex(RuntimeError, "full head failed"):
            probe.run(self.args, self.report)
        self.assertEqual(self.report["stage"], "largest_target_update")
        self.assertEqual(self.report["completed_updates"], 1)
        self.assertEqual(self.reference.update.call_count, 2)
        self.assertEqual(self.loader.call_count, 1)

    def test_preexisting_stop_prevents_preflight_and_loading(self):
        (self.work / "STOP").touch()
        with self.assertRaises(probe.StopRequested):
            probe.run(self.args, self.report)
        self.loader.assert_not_called()
        self.reference.update.assert_not_called()

    def test_stop_after_load_prevents_first_update(self):
        def loaded(*_):
            (self.root / "CANCEL").touch()
            return self.model, self.optimizer, {"initial_adapter_sha256": probe.INITIAL_ADAPTER_SHA}
        self.loader.side_effect = loaded
        with self.assertRaises(probe.StopRequested):
            probe.run(self.args, self.report)
        self.reference.update.assert_not_called()

    def test_completed_update_record_survives_inventory_failure(self):
        self.inventory.side_effect = RuntimeError("inventory failed")
        with self.assertRaisesRegex(RuntimeError, "inventory failed"):
            probe.run(self.args, self.report)
        self.assertEqual(self.report["completed_updates"], 1)
        self.assertEqual(len(self.report["updates"]), 1)


class MainReportTests(unittest.TestCase):
    def exercise(self, error):
        class FakeOOM(RuntimeError):
            pass
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            argv = [arg for name in ("work", "dataset", "model", "legacy-kit", "initial-checkpoint", "reference-dir")
                    for arg in ("--" + name, str(root))] + ["--gpu-uuid", "GPU-example"]
            actual_error = FakeOOM("out of memory") if error == "oom" else error
            def fail(args, report):
                report.update(stage="largest_target_update", completed_updates=1)
                raise actual_error
            with patch.object(probe, "run", side_effect=fail) as run, patch.dict(
                    sys.modules, {"torch": SimpleNamespace(OutOfMemoryError=FakeOOM)}):
                with self.assertRaises(BaseException) as caught:
                    probe.main(argv)
            self.assertEqual(run.call_count, 1)
            return json.loads((root / probe.REPORT_NAME).read_text()), caught.exception

    def test_oom_report_preserves_stage_count_and_exception(self):
        report, error = self.exercise("oom")
        self.assertEqual(report["status"], "failed")
        self.assertEqual(report["failure_kind"], "cuda_out_of_memory")
        self.assertEqual(report["stage"], "largest_target_update")
        self.assertEqual(report["completed_updates"], 1)
        self.assertIn("out of memory", str(error))

    def test_cancellation_is_exit_130_and_forbids_fallback(self):
        report, error = self.exercise(probe.StopRequested("cancelled"))
        self.assertEqual(report["status"], "cancelled")
        self.assertFalse(report["automatic_fallback_allowed"])
        self.assertIsInstance(error, SystemExit)
        self.assertEqual(error.code, 130)

    def test_generic_error_is_not_disguised_as_oom(self):
        failure = ValueError("bad configuration")
        report, error = self.exercise(failure)
        self.assertIs(error, failure)
        self.assertEqual(report["failure_kind"], "exception")
        self.assertEqual(report["status"], "failed")


if __name__ == "__main__":
    unittest.main()
