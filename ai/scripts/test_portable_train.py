"""CPU-only contract tests; these do not load a model or claim CUDA compatibility."""
from contextlib import contextmanager, redirect_stdout
from copy import deepcopy
from fractions import Fraction
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("portable_train", Path(__file__).with_name("portable_train.py"))
trainer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trainer)


def entry(identity, split="train", task="conversation", targets=2):
    ids = [2, 20, *range(30, 30 + targets)]
    return {"stream": task, "split": split, "row_id": identity,
            "weight": {"numerator": 1, "denominator": 1},
            "encoded": {"input_ids": ids, "attention_mask": [1] * len(ids),
                        "labels": [-100, -100, *ids[2:]], "prefix_length": 2,
                        "target_length": targets, "sequence_length": len(ids)}}


class PortableTrainingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.entries = self.root / "entries.jsonl"

    def write(self, entries):
        self.entries.write_text("".join(json.dumps(e) + "\n" for e in entries))
        return self.entries

    def test_fixed_epoch_coefficient_preserves_full_weighted_objective(self):
        rows = [entry("a", targets=1), entry("b", targets=2), entry("c", targets=3)]
        rows[0]["weight"] = {"numerator": 3, "denominator": 2}
        rows[1]["weight"] = {"numerator": 3, "denominator": 4}
        windows, coefficients = trainer.make_plan(rows, 2, 3407)
        self.assertEqual(sorted(map(len, windows)), [1, 2])
        self.assertEqual(coefficients, [Fraction(1, 2), Fraction(1, 2), Fraction(1)])
        # Average planned window gradient is exactly the weighted objective.
        gradients = [Fraction(7), Fraction(-3), Fraction(2)]
        planned = sum(sum(coefficients[i] * gradients[i] for i in w) for w in windows) / len(windows)
        expected = sum(trainer.weight(e) * e["encoded"]["target_length"] * g for e, g in zip(rows, gradients)) / 6
        self.assertEqual(planned, expected)

    def test_validation_never_enters_backward_plan(self):
        with self.assertRaisesRegex(ValueError, "train rows"):
            trainer.make_plan([entry("v", "validation")], 8, 3407)

    def test_selected_task_keeps_original_masks_and_separates_splits(self):
        rows = [entry("a"), entry("b", "validation"), entry("other", task="sentence")]
        original = deepcopy(rows)
        self.write(rows)
        splits = trainer.read_entries(self.entries, "conversation", 4096)
        self.assertEqual(splits, {"train": [original[0]], "validation": [original[1]]})

    def test_rejects_test_or_sealed_split(self):
        self.write([entry("a"), entry("b", "test")])
        with self.assertRaisesRegex(ValueError, "Only train and validation"):
            trainer.read_entries(self.entries, "conversation", 4096)

    def test_rejects_duplicate_row_across_splits(self):
        self.write([entry("a"), entry("a", "validation")])
        with self.assertRaisesRegex(ValueError, "duplicate row"):
            trainer.read_entries(self.entries, "conversation", 4096)

    def test_rejects_family_overlap(self):
        rows = [entry("a"), entry("b", "validation")]
        for e in rows:
            e["family_id"] = "same-family"
        self.write(rows)
        with self.assertRaisesRegex(ValueError, "Family overlaps"):
            trainer.read_entries(self.entries, "conversation", 4096)

    def test_requires_both_partitions(self):
        self.write([entry("a")])
        with self.assertRaisesRegex(ValueError, "Missing validation"):
            trainer.read_entries(self.entries, "conversation", 4096)

    def test_rejects_modified_token_mass(self):
        rows = [entry("a"), entry("b", "validation")]
        rows[0]["weight"]["numerator"] = 2
        self.write(rows)
        with self.assertRaisesRegex(ValueError, "weighted token mass"):
            trainer.read_entries(self.entries, "conversation", 4096)

    def test_rejects_shifted_labels_and_masked_target(self):
        for labels in ([2, 20, 30, 31], [-100, -100, -100, 31], [-100, 30, 31, -100]):
            with self.subTest(labels=labels):
                row = entry("a")["encoded"]
                row["labels"] = labels
                with self.assertRaisesRegex(ValueError, "Target mask"):
                    trainer.checked_row(row, 4096)

    def test_rejects_truncation_padding_and_out_of_vocab(self):
        original = entry("a")["encoded"]
        with self.assertRaisesRegex(ValueError, "truncation"):
            trainer.checked_row(original, 3)
        row = deepcopy(original)
        row["attention_mask"][-1] = 0
        with self.assertRaisesRegex(ValueError, "unpadded"):
            trainer.checked_row(row, 4096)
        row = deepcopy(original)
        row["input_ids"][-1] = 262144
        with self.assertRaisesRegex(ValueError, "token IDs"):
            trainer.checked_row(row, 4096)

    def test_validation_uses_eval_no_grad_and_weighted_token_mean(self):
        rows = [entry("a", "validation", targets=1), entry("b", "validation", targets=3)]
        rows[0]["weight"] = {"numerator": 2, "denominator": 1}
        rows[1]["weight"] = {"numerator": 2, "denominator": 3}
        state = {"no_grad": False, "eval": False}

        @contextmanager
        def no_grad():
            state["no_grad"] = True
            yield
            state["no_grad"] = False

        class Model:
            def eval(self):
                state["eval"] = True

        def loss(model, row):
            self.assertTrue(state["no_grad"] and state["eval"])
            return SimpleNamespace(item=lambda: 2.0 if row["target_length"] == 1 else 4.0)

        with patch.dict(sys.modules, {"torch": SimpleNamespace(no_grad=no_grad)}), patch.object(trainer, "selected_loss", side_effect=loss):
            self.assertEqual(trainer.validation_loss(Model(), rows), {
                "primary_unweighted_target_token_mean_loss": 3.5,
                "auxiliary_weighted_target_token_mean_loss": 3.0})
            with self.assertRaisesRegex(ValueError, "Validation requires"):
                trainer.validation_loss(Model(), [entry("train")])

    def args(self, extra=()):
        return ["--entries", str(self.entries), "--task", "conversation", "--tokenizer", str(self.root),
                "--epochs", "1", "--seed", "3407", "--accumulation", "8", "--rank", "8", "--lr", "0.00001",
                "--max-length", "4096", *extra]

    def test_validate_only_needs_no_model_compute_import_or_output(self):
        self.write([entry("a"), entry("b", "validation")])
        (self.root / "test-asset").write_text("synthetic fixture")
        pins = {"test-asset": trainer.sha_file(self.root / "test-asset")}
        before = set(sys.modules)
        with patch.object(trainer, "TOKENIZER_FILES", pins), patch.object(trainer, "train") as train, redirect_stdout(io.StringIO()):
            report = trainer.main(self.args(["--validate-only"]))
        train.assert_not_called()
        self.assertEqual(report["status"], "validated_only")
        self.assertFalse(report["behavioral_quality_verified"])
        self.assertFalse({"torch", "transformers", "peft", "bitsandbytes"} & (set(sys.modules) - before))

    def test_training_requires_model_and_new_output(self):
        with patch.object(trainer, "check_assets", return_value=self.root):
            with self.assertRaisesRegex(ValueError, "Training requires"):
                trainer.validate_args(trainer.parser().parse_args(self.args()))
            with self.assertRaisesRegex(ValueError, "already exists"):
                trainer.validate_args(trainer.parser().parse_args(self.args(["--validate-only", "--output", str(self.root)])))

    def test_rejects_asset_drift(self):
        (self.root / "asset").write_text("original")
        pins = {"asset": trainer.sha_file(self.root / "asset")}
        trainer.check_assets(self.root, pins)
        (self.root / "asset").write_text("modified")
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            trainer.check_assets(self.root, pins)

    def test_explicit_arguments_and_device_map(self):
        args = trainer.parser().parse_args(self.args(["--validate-only", "--device-map", "cuda:0"]))
        self.assertEqual(args.device_map, "cuda:0")
        self.assertEqual(args.seed, 3407)
        args.lr = float("nan")
        with self.assertRaisesRegex(ValueError, "Learning rate"):
            trainer.validate_args(args)

    def test_documented_argument_aliases(self):
        original = self.args(["--validate-only"])
        aliases = [{"--accumulation": "--accumulation-steps", "--lr": "--learning-rate"}.get(arg, arg)
                   for arg in original]
        self.assertEqual(vars(trainer.parser().parse_args(original)), vars(trainer.parser().parse_args(aliases)))


if __name__ == "__main__":
    unittest.main()
