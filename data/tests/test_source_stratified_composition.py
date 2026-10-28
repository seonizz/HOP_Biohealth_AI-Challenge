"""Synthetic subset, full-prefix lineage and publication regression checks."""
import copy
import gzip
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from counseling_pipeline import source_stratified_composition as stratified
from counseling_pipeline import source_balanced_composition as balanced, source_budget_composition as budget
from counseling_pipeline import source_composition as base, source_sft as source, evaluation_history as history
import test_source_budget_composition as budget_fixtures
import test_source_balanced_composition as balanced_fixtures


def choice(identity, *, main=True, strict=False, **kwargs):
    row = budget_fixtures.metadata(identity, output_budget=8192, **kwargs)
    row["profiles"]["runtime_budget"]["chosen"] = main
    row["profiles"]["strict_4096"]["chosen"] = strict
    row.update(chosen=main, baseline_chosen=main, added_late_representative=False)
    return row


class SelectionTests(unittest.TestCase):
    def test_subsets_preserve_late_conversations_group_quarters_and_order_invariance(self):
        rows = [choice(f"{split}_{g}_{c}_{q}", main=True, strict=True, group=f"{split}_{g}",
            conv=f"{split}_{g}_{c}", split=split, quarter=q) for split in source.SPLITS for g in range(8)
            for c in range(4) for q in base.QUARTERS[:2]]
        rows += [choice(f"{split}_late", main=True, strict=True, group=f"{split}_0", conv=f"{split}_0_0",
            split=split, quarter=base.QUARTERS[2]) for split in source.SPLITS]
        first = stratified.select_rows(rows)
        self.assertEqual(first, stratified.select_rows(list(reversed(rows))))
        for profile, result in first.items():
            old = [row for row in rows if row["id"] in result["baseline_ids"]]
            new = [row for row in rows if row["id"] in result["chosen_ids"]]
            stratified.validate_selection(old, new, result["caps"])
            self.assertEqual({row["source_conversation_id"] for row in old}, {row["source_conversation_id"] for row in new})
            self.assertTrue(result["chosen_ids"] <= result["baseline_ids"])
            self.assertTrue(stratified.concentration_check(new, old)[0])
        self.assertLess(len(first["strict_4096"]["chosen_ids"]), len(rows))

    def test_empty_splits_and_empty_baseline_are_exact_and_safe(self):
        self.assertEqual(stratified.concentration([])["validation"], (0, 0, 0))
        chosen = stratified.select_rows([choice("only", strict=True)])
        self.assertEqual(chosen["strict_4096"]["chosen_ids"], {"only"})
        self.assertTrue(chosen["strict_4096"]["stopping"]["mandatory_core_passed_all_nine_checks"])
        self.assertIsNone(chosen["strict_4096"]["stopping"]["previous_point_failed_metrics"])
        self.assertEqual(stratified.select_rows([])["runtime_capped"]["chosen_ids"], set())

    def test_caps_are_explicit_mandatory_exceptions_and_late_representatives_never_change(self):
        rows = [choice(f"late_{i}", quarter=base.QUARTERS[2], prefix=6000) for i in range(17)]
        rows += [choice("early1"), choice("early2", quarter=base.QUARTERS[1])]
        result = stratified.select_rows(rows)["runtime_capped"]
        self.assertEqual(result["caps"], {"group": 19})
        self.assertEqual(result["chosen_ids"], {row["id"] for row in rows})
        self.assertEqual(result["core_ids"], result["chosen_ids"])
        strict = [choice(f"conversation_{i}", strict=True) for i in range(12)]
        self.assertEqual(stratified.select_rows(strict)["strict_4096"]["caps"], {"group": 12})

    def test_all_held_rows_still_receive_identity_and_typed_eligibility_checks(self):
        for bad in (choice("a", main=False, reasons=["held"]),
                    choice("b", split="validation", main=False, reasons=["held"]),
                    choice("b", group="other", conv="a", main=False, reasons=["held"])):
            with self.subTest(bad=bad["id"]), self.assertRaises(ValueError):
                stratified.select_rows([choice("a"), bad])
        for profile in budget.PROFILES:
            for field in ("chosen", "eligible"):
                row = choice("typed", strict=True)
                row["profiles"][profile][field] = 1
                with self.subTest(profile=profile, field=field), self.assertRaisesRegex(ValueError, "eligibility"):
                    stratified.select_rows([row])
        for field in ("chosen", "baseline_chosen", "added_late_representative"):
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "boolean"):
                stratified.select_rows([{**choice("typed"), field: 1}])

    def test_holds_budget_edges_and_original_selection_cannot_be_forged(self):
        valid = choice("edge", prefix=61440, target=8192, quarter=base.QUARTERS[2])
        self.assertEqual(stratified.select_rows([valid])["runtime_capped"]["chosen_ids"], {"edge"})
        for row in (choice("input_over", prefix=61441, target=1), choice("output_over", prefix=1, target=8193),
                    choice("held", reasons=["prior_hold"]), choice("medical", flags=["prior_assistant_medical_pattern"]),
                    choice("strict_over", prefix=4000, target=97, strict=True)):
            with self.subTest(identity=row["id"]), self.assertRaisesRegex(ValueError, "ineligible"):
                stratified.select_rows([row])
        allowed = choice("procedural", flags=["prior_assistant_procedural_pattern"])
        self.assertEqual(stratified.select_rows([allowed])["runtime_capped"]["chosen_ids"], {"procedural"})
        forged = choice("held", main=False, reasons=["original_hold"])
        forged["profiles"]["runtime_budget"].update(eligible=True, hold_reasons=[])
        with self.assertRaisesRegex(ValueError, "eligibility"):
            stratified.select_rows([forged])

    def test_duplicate_cells_and_missing_coverage_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate baseline cell"):
            stratified.select_rows([choice("one", conv="same"), choice("two", conv="same")])
        rows = [choice("one"), choice("two")]
        with self.assertRaisesRegex(ValueError, "coverage"):
            stratified.validate_selection(rows, rows[:1], {"group": 10})
        with self.assertRaisesRegex(ValueError, "cap"):
            stratified.validate_selection(rows, rows, {"group": 1})

    def test_relative_concentration_failure_is_not_hidden_by_lower_absolute_cap(self):
        rows = [choice(f"a_{i}", group="a", quarter=base.QUARTERS[2], prefix=6000) for i in range(19)]
        rows += [choice(f"{group}_{i}", group=group) for group in ("b", "c") for i in range(20)]
        with self.assertRaisesRegex(ValueError, "coverage|concentration"):
            stratified.select_rows(rows)
        # All conversations covered: removing repeated early-quarter rows alone can worsen HHI.
        rows = [choice(f"a_{i}", group="a", quarter=base.QUARTERS[2], prefix=6000) for i in range(19)]
        rows += [choice(f"{group}_{i}_{q}", group=group, conv=f"{group}_{i}", quarter=q)
                 for group in ("b", "c") for i in range(10) for q in base.QUARTERS[:2]]
        with self.assertRaisesRegex(ValueError, "concentration"):
            stratified.select_rows(rows)
        required = stratified.core(rows)
        with self.assertRaisesRegex(ValueError, "concentration constraints"):
            stratified.waterfill_to_baseline(rows, required, {"a": 19, "b": 10, "c": 10})

    def test_waterfill_records_previous_failure_and_stops_at_first_pass(self):
        rows = [choice(f"a{i}", group="a") for i in range(5)] + [choice(f"b{i}", group="b") for i in range(5)]
        required = rows[:4] + rows[5:6]
        selected, details = stratified.waterfill_to_baseline(rows, required, {"a": 5, "b": 5})
        self.assertEqual(len(selected), 8)
        self.assertEqual(details["added_to_core"], 3)
        self.assertEqual(details["previous_row_count"], 7)
        self.assertIn("hhi", details["previous_point_failed_metrics"]["train"])
        self.assertFalse(details["mandatory_core_passed_all_nine_checks"])

    def test_panel_prefers_short_representative_without_duplicate_cell_or_split(self):
        rows = [choice("long_q3", split="validation", group="v", conv="same", quarter=base.QUARTERS[2], prefix=7000),
                choice("short_q3", main=False, strict=True, split="validation", group="v", conv="same", quarter=base.QUARTERS[2]),
                choice("long_q4", split="validation", group="v", conv="same", quarter=base.QUARTERS[3], prefix=9000)]
        decisions = stratified.select_rows(rows)
        panel = stratified.panel_rows(rows, decisions)
        self.assertEqual({row["id"] for row in panel}, {"short_q3", "long_q4"})
        self.assertEqual(len(panel), len({stratified.cell(row) for row in panel}))
        self.assertFalse({row["id"] for row in panel} <= decisions["runtime_capped"]["chosen_ids"])
        duplicate = choice("another_q3", split="validation", group="v", conv="same", quarter=base.QUARTERS[2])
        forged = copy.deepcopy(decisions)
        forged["runtime_capped"]["chosen_ids"].add("another_q3")
        with self.assertRaisesRegex(ValueError, "duplicates"):
            stratified.panel_rows(rows + [duplicate], forged)

    def test_config_types_and_fixed_output_policy_cannot_be_relaxed(self):
        for key, value in (("training_authorized", 0), ("strict_base_group_cap", 10.0),
                           ("maximum_rows_per_conversation_quarter", True), ("output_budget", "8192"),
                           ("balanced_config_sha256", "0" * 64)):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "config"):
                stratified.validate_config({**stratified.CONFIG, key: value})


class ExportTests(unittest.TestCase):
    def setUp(self):
        fixture = self.fixture = balanced_fixtures.ExportTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.root, self.when = fixture.root, fixture.when
        self.balanced_baseline = self.root / "v4"
        balanced.build(output=self.balanced_baseline, occurred_at=self.when, **fixture.inputs)
        self.inputs = {**fixture.inputs, "balanced_baseline": self.balanced_baseline}
        self.output = self.root / "v5"

    def build(self, output=None):
        return stratified.build(output=output or self.output, occurred_at=self.when, **self.inputs)

    def rehash(self, name):
        path = self.output / name
        manifest = source.read_json(self.output / "export_manifest.json")
        manifest["files"][name].update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        source.dump_json(self.output / "export_manifest.json", manifest)

    def test_exact_bytes_masks_baselines_and_all_ten_files_are_preserved(self):
        before = {path: source.sha_file(path) for path in self.root.rglob("*") if path.is_file()}
        summary = self.build()
        plan = stratified.prepare(**self.inputs)
        stratified.verify_artifacts(self.output, plan)
        source_rows = {}
        for split in source.SPLITS:
            for line in gzip.decompress((self.inputs["release"] / f"conversation/{split}.jsonl.gz").read_bytes()).splitlines(keepends=True):
                source_rows[json.loads(line)["id"]] = line
        for name in stratified.EXPORT_FILES:
            for line in gzip.decompress((self.output / name).read_bytes()).splitlines(keepends=True):
                row = json.loads(line)
                self.assertEqual(line, source_rows[row["id"]])
                self.assertEqual(row["loss_message_mask"], [0] * (len(row["messages"]) - 1) + [1])
                self.assertNotIn("human_approved", row)
        self.assertEqual(sum(path.is_file() for path in self.output.rglob("*")), 10)
        self.assertEqual(before, {path: source.sha_file(path) for path in before})
        self.assertEqual(summary["balanced_baseline_files_bound"], 8)
        self.assertFalse(summary["training_authorized"])
        self.assertFalse(summary["profiles_are_independent"])
        self.assertTrue(summary["development_exposed"])

    def test_original_ledger_profiles_are_preserved_and_v5_decisions_are_separate(self):
        self.build()
        old = {row["id"]: row for row in source.read_rows(self.balanced_baseline / "selection_ledger.jsonl.gz")}
        new = list(source.read_rows(self.output / "selection_ledger.jsonl.gz"))
        for row in new:
            self.assertEqual(row["profiles"], old[row["id"]]["profiles"])
            self.assertIs(row["chosen"], old[row["id"]]["chosen"])
            self.assertEqual(row["balanced_config_sha256"], old[row["id"]]["config_sha256"])
            self.assertEqual(set(row["selection_v5"]), set(stratified.PROFILES))

    def test_row_and_target_token_concentration_and_overlap_are_distinct(self):
        summary = self.build()
        plan = stratified.prepare(**self.inputs)
        for profile in stratified.PROFILES:
            rows = [row for row in plan["rows"] if row["selection_v5"][profile]["chosen"]]
            stats = summary["profiles"][profile]["selected"]["all"]
            self.assertEqual(stats["target_token_sum"], sum(row["target_length"] for row in rows))
            self.assertEqual(stats["input_repetition"]["prefix_token_sum"], sum(row["prefix_length"] for row in rows))
            self.assertEqual(set(stats["concentration"]), {"rows", "target_tokens"})
        self.assertFalse(summary["overlap"]["panel_to_runtime"]["independent"])
        self.assertEqual(sum(summary["panel_sequence_bands"].values()), summary["validation_late_stratified"]["all"]["rows"])

    def test_hash_bindings_include_all_old_artifacts_and_both_implementations(self):
        self.build()
        plan = stratified.prepare(**self.inputs)
        expected = {path for root in (self.inputs["baseline"], self.balanced_baseline) for path in root.rglob("*") if path.is_file()}
        self.assertTrue(expected <= plan["tracked"].keys())
        self.assertTrue({Path(stratified.__file__), Path(balanced.__file__), Path(budget.__file__)} <= plan["tracked"].keys())
        path = self.balanced_baseline / "train.jsonl.gz"
        path.write_bytes(path.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "inputs changed"):
            stratified.verify_artifacts(self.output, plan)

    def test_v4_manifest_swap_after_valid_verification_is_detected(self):
        verify = balanced.verify_artifacts
        def swapped(path, plan):
            manifest = verify(path, plan)
            source.dump_json(Path(path) / "export_manifest.json", {**manifest, "concurrent_swap": True})
            return manifest
        with patch.object(balanced, "verify_artifacts", side_effect=swapped):
            with self.assertRaisesRegex(ValueError, "inputs changed during preparation"):
                self.build()
        self.assertFalse(self.output.exists())

    def test_rehashed_previous_ledger_change_cannot_redefine_baseline(self):
        path = self.balanced_baseline / "selection_ledger.jsonl.gz"
        rows = list(source.read_rows(path))
        rows[0]["chosen"] = not rows[0]["chosen"]
        path.unlink()
        base.write_gzip(path, (base.encoded(row) for row in rows))
        manifest = source.read_json(self.balanced_baseline / "export_manifest.json")
        manifest["files"][path.name].update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        source.dump_json(self.balanced_baseline / "export_manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "recomputed decisions"):
            self.build()

    def test_rehashed_new_decision_types_panel_and_config_are_recomputed(self):
        self.build()
        plan = stratified.prepare(**self.inputs)
        path = self.output / "selection_ledger.jsonl.gz"
        original = list(source.read_rows(path))
        for kind in ("chosen", "baseline_chosen", "core_chosen", "group_cap", "panel"):
            rows = copy.deepcopy(original)
            if kind == "panel":
                rows[0]["validation_late_stratified"]["chosen"] = 1
            else:
                rows[0]["selection_v5"]["strict_4096"][kind] = True if kind == "group_cap" else 1
            path.unlink()
            base.write_gzip(path, (base.encoded(row) for row in rows))
            self.rehash(path.name)
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, "recomputed decisions"):
                stratified.verify_artifacts(self.output, plan)
        path.unlink()
        base.write_gzip(path, (base.encoded(row) for row in original))
        self.rehash(path.name)
        for name in ("composition_config.json", "summary.json"):
            document = source.read_json(self.output / name)
            document["training_authorized"] = 0
            source.dump_json(self.output / name, document)
            self.rehash(name)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "config or summary"):
                stratified.verify_artifacts(self.output, plan)

    def test_manifest_flags_export_counts_and_original_bytes_are_checked(self):
        self.build()
        plan = stratified.prepare(**self.inputs)
        original = source.read_json(self.output / "export_manifest.json")
        for field in (*stratified.FALSE_FLAGS, *stratified.TRUE_FLAGS):
            source.dump_json(self.output / "export_manifest.json", {**original, field: int(original[field])})
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "authorization"):
                stratified.verify_artifacts(self.output, plan)
        source.dump_json(self.output / "export_manifest.json", original)
        name = "strict_4096/train.jsonl.gz"
        for field, value, message in (("rows", True, "count mismatch"), ("uncompressed_sha256", "0" * 64, "uncompressed hash")):
            changed = copy.deepcopy(original)
            changed["files"][name][field] = value
            source.dump_json(self.output / "export_manifest.json", changed)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, message):
                stratified.verify_artifacts(self.output, plan)
        source.dump_json(self.output / "export_manifest.json", original)
        path = self.output / name
        rows = list(source.read_rows(path))
        rows[0]["messages"][1]["content"] = "Synthetic changed full-prefix content"
        path.unlink()
        base.write_gzip(path, (base.encoded(row) for row in rows))
        self.rehash(name)
        with self.assertRaisesRegex(ValueError, "original bytes"):
            stratified.verify_artifacts(self.output, plan)

    def test_nested_inventory_symlink_and_event_pointers(self):
        self.build()
        plan = stratified.prepare(**self.inputs)
        for event in history._json_rows(self.output / "evaluation_history_events.jsonl"):
            self.assertEqual(event["evidence"]["sha256"], source.sha_file(self.output / "summary.json"))
            self.assertEqual({key: history._pointer(plan["summary"], pointer) for key, pointer in event["evidence"]["input_pointers"].items()}, event["input_sha256"])
        extra = self.output / "strict_4096" / "unexpected"
        extra.mkdir()
        with self.assertRaisesRegex(ValueError, "inventory"):
            stratified.verify_artifacts(self.output, plan)
        extra.rmdir()
        path = self.output / "strict_4096"
        moved = self.root / "relocated_profile"
        path.rename(moved)
        path.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "inventory|profile directory"):
            stratified.verify_artifacts(self.output, plan)

    def test_fixed_output_budget_reproducibility_and_atomic_no_overwrite(self):
        for value in (4096, True, "8192", 8192.0):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "requires output budget"):
                stratified.prepare(**self.inputs, output_budget=value)
        self.build()
        other = self.root / "second_v5"
        self.build(other)
        self.assertEqual({path.relative_to(self.output).as_posix(): source.sha_file(path) for path in self.output.rglob("*") if path.is_file()},
                         {path.relative_to(other).as_posix(): source.sha_file(path) for path in other.rglob("*") if path.is_file()})
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.build()
        failed = self.root / "failed_v5"
        with patch.object(stratified.os, "replace", side_effect=OSError("synthetic publication failure")):
            with self.assertRaisesRegex(OSError, "publication failure"):
                self.build(failed)
        self.assertFalse(failed.exists())
        self.assertFalse(list(self.root.glob(".stratified-composition-stage-*")))


if __name__ == "__main__":
    unittest.main()
