"""Synthetic same-target swaps, exact prefix bounds and lineage attacks."""
import copy
from fractions import Fraction
import gzip
import json
from pathlib import Path
import random
import unittest
from unittest.mock import patch

from counseling_pipeline import source_prefix_balanced_composition as composition
from counseling_pipeline import source_token_balanced_composition as previous
from counseling_pipeline import source_composition as base, source_sft as source, evaluation_history as history
import test_source_token_balanced_composition as token_fixtures


def choice(identity, *, selected=True, v5=True, prefix=3000, target=100, **kwargs):
    row = token_fixtures.choice(identity, selected=v5, historical=v5, target=target, **kwargs)
    row.update(prefix_length=prefix, sequence_length=prefix + target)
    for profile in composition.budget.PROFILES:
        old_chosen = row["profiles"][profile]["chosen"]
        row["profiles"][profile] = composition.budget.budget_decision(row, profile, composition.budget.make_config(8192))
        row["profiles"][profile]["chosen"] = old_chosen
    row["selection_v6"] = {profile: {"baseline_chosen": v5, "chosen": selected,
        "reason": "retained_early" if v5 else "paired_early_replacement"} for profile in composition.PROFILES}
    return row


def fixture_rows():
    result = []
    for split in source.SPLITS:
        for index in range(12):
            group = f"{split}_{index:02d}"
            result.append(choice(group + "_v5", selected=index != 0, group=group, conv=group, split=split))
            result.append(choice(group + "_late", group=group, conv=group, split=split, prefix=500,
                                 quarter=base.QUARTERS[2]))
            if index == 0:
                result.append(choice(group + "_v6", v5=False, group=group, conv=group, split=split, prefix=3003))
    return result


class SelectionTests(unittest.TestCase):
    def test_same_target_representatives_preserve_cells_late_groups_and_distributions(self):
        rows = fixture_rows()
        before = [row for row in rows if row["selection_v6"]["strict_4096"]["chosen"]]
        decisions = composition.select_rows(rows)
        for profile, decision in decisions.items():
            selected = [row for row in rows if row["id"] in decision["chosen_ids"]]
            with self.subTest(profile=profile):
                self.assertEqual(len(decision["trace"]), 2)
                self.assertEqual(len(decision["chosen_ids"] - decision["baseline_ids"]), 2)
                self.assertEqual(previous.loads(before), previous.loads(selected))
                self.assertEqual({composition.cell(row) for row in before}, {composition.cell(row) for row in selected})
                self.assertEqual({row["id"] for row in before if row["position_band"] in composition.LATE},
                                 {row["id"] for row in selected if row["position_band"] in composition.LATE})
                self.assertEqual(composition.stratified.concentration(before), composition.stratified.concentration(selected))
                self.assertTrue(composition.passed(composition.loads(selected), decision["limits"]))
                self.assertTrue(all(step["all_nine_prefix_metrics_nonincreasing"] for step in decision["trace"]))
                self.assertEqual(decision["trace"][-1]["score_exact"], [0, 1])

    def test_reverse_shuffle_and_equal_score_ties_are_deterministic(self):
        rows = fixture_rows()
        duplicate = copy.deepcopy(rows[0])
        duplicate["id"] = "another_equal_prefix_and_target_option"
        duplicate["selection_v5"] = copy.deepcopy(rows[-1]["selection_v5"])
        for profile in composition.PROFILES:
            duplicate["selection_v5"][profile].update(baseline_chosen=False, core_chosen=False, chosen=False)
            duplicate["selection_v6"][profile].update(baseline_chosen=False, chosen=False)
        duplicate.update(chosen=False, baseline_chosen=False)
        for profile in composition.budget.PROFILES:
            duplicate["profiles"][profile]["chosen"] = False
        rows.append(duplicate)
        expected = composition.select_rows(rows)
        shuffled = list(rows)
        random.Random(784).shuffle(shuffled)
        self.assertEqual(expected, composition.select_rows(list(reversed(rows))))
        self.assertEqual(expected, composition.select_rows(shuffled))

    def test_same_cell_other_target_lengths_are_excluded(self):
        rows = fixture_rows()
        baseline = [row for row in rows if row["selection_v6"]["strict_4096"]["chosen"]]
        alternative = choice("wrong_target", selected=False, v5=False, group="train_00", conv="train_00", target=99)
        options = composition.swap_options(rows + [alternative], baseline, "strict_4096")
        self.assertNotIn("wrong_target", {row["id"] for values in options.values() for row in values})

    def test_exact_integer_prefix_bound_accepts_boundary_and_rejects_one_token_more(self):
        old = [choice("high", group="high", prefix=4000, target=50), choice("low", group="low", prefix=1000, target=50)]
        selected = {composition.cell(row): row for row in old}
        baseline_totals = {"train": 5000, "validation": 0}
        replacement = {**old[0], "id": "boundary", "prefix_length": 3990, "sequence_length": 4040}
        desired = [replacement, old[1]]
        limits = composition.metrics(composition.loads(desired))
        self.assertEqual(composition.validate_move(selected, replacement, composition.loads(old), baseline_totals, limits, "strict_4096")[-1], -10)
        with self.assertRaisesRegex(ValueError, "exact 0.2 percent bound"):
            composition.validate_move(selected, {**replacement, "prefix_length": 3989, "sequence_length": 4039},
                                      composition.loads(old), baseline_totals, limits, "strict_4096")

    def test_move_rejects_target_origin_late_hold_budget_and_type_changes(self):
        rows = fixture_rows()
        old = [row for row in rows if row["selection_v6"]["strict_4096"]["chosen"]]
        selected = {composition.cell(row): row for row in old}
        replacement = rows[0]
        current = composition.loads(old)
        totals = {part: sum(values.values()) for part, values in current.items()}
        limits = composition.thresholds(old, [row for row in rows if row["selection_v5"]["strict_4096"]["chosen"]])
        attacks = [({**replacement, "target_length": 101, "sequence_length": 3101}, "target length"),
            ({**replacement, "target_length": True}, "target length"),
            ({**replacement, "source_group_id": "other"}, "origin"),
            ({**replacement, "split": "validation"}, "origin"),
            ({**replacement, "source_conversation_id": "unknown"}, "selected cell"),
            ({**replacement, "context_flags": ["prior_assistant_medical_pattern"]}, "held or over-budget"),
            ({**replacement, "source_reasons": ["held"], "source_admitted": False}, "held or over-budget"),
            ({**replacement, "prefix_length": 4000, "sequence_length": 4100}, "held or over-budget"),
            ({**replacement, "prefix_length": 61441, "sequence_length": 61541}, "held or over-budget"),
            ({**replacement, "prefix_length": True, "sequence_length": 101}, "arithmetic")]
        for row, message in attacks:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                composition.validate_move(selected, row, current, totals, limits, "strict_4096")
        late = next(row for row in old if row["position_band"] in composition.LATE)
        with self.assertRaisesRegex(ValueError, "late representative"):
            composition.validate_move(selected, {**late, "id": "late_changed", "prefix_length": 499, "sequence_length": 599}, current, totals, limits, "strict_4096")

    def test_stepwise_nonincrease_and_strict_score_are_required(self):
        old = [choice("high", group="high", prefix=4000, target=50), choice("low", group="low", prefix=1000, target=50)]
        selected, current = {composition.cell(row): row for row in old}, composition.loads(old)
        totals = {"train": 5000, "validation": 0}
        worse = {**old[1], "id": "low_smaller", "prefix_length": 999, "sequence_length": 1049}
        with self.assertRaisesRegex(ValueError, "worsened within a step"):
            composition.validate_move(selected, worse, current, totals, composition.metrics(current), "strict_4096")
        better = {**old[0], "id": "high_smaller", "prefix_length": 3999, "sequence_length": 4049}
        with self.assertRaisesRegex(ValueError, "did not strictly decrease"):
            composition.validate_move(selected, better, current, totals, composition.metrics(current), "strict_4096")

    def test_wrong_selected_cells_unknown_option_and_target_distribution_fail(self):
        rows = fixture_rows()
        old = [row for row in rows if row["selection_v6"]["strict_4096"]["chosen"]]
        options = composition.swap_options(rows, old, "strict_4096")
        limits = composition.metrics(composition.loads(old))
        with self.assertRaisesRegex(ValueError, "cells or row count"):
            composition.validate_selection(old, old[:-1], options, limits)
        changed = copy.deepcopy(old)
        changed[0]["source_row_sha256"] = "forged"
        with self.assertRaisesRegex(ValueError, "original allowed option"):
            composition.validate_selection(old, changed, options, limits)

    def test_empty_baseline_zero_steps_and_bounded_path_failure(self):
        self.assertTrue(all(not value["chosen_ids"] and not value["trace"] for value in composition.select_rows([]).values()))
        self.assertTrue(all(not value["trace"] for value in composition.select_rows([choice("already_balanced")]).values()))
        rows = fixture_rows()
        old = [row for row in rows if row["selection_v6"]["strict_4096"]["chosen"]]
        limits = composition.thresholds(old, [row for row in rows if row["selection_v5"]["strict_4096"]["chosen"]])
        with self.assertRaisesRegex(ValueError, "step limit.*global feasibility unknown"):
            composition.single_swap(old, composition.swap_options(rows, old, "strict_4096"), limits, "strict_4096", max_steps=0)
        with self.assertRaisesRegex(ValueError, "greedy path.*global feasibility unknown"):
            composition.single_swap(old, {composition.cell(row): [row] for row in old}, limits, "strict_4096")

    def test_typed_history_eligibility_config_and_seed_cannot_be_relaxed(self):
        for field in ("chosen", "baseline_chosen", "reason"):
            row = choice("typed")
            row["selection_v6"]["strict_4096"][field] = 1
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "typed v6"):
                composition.select_rows([row])
        held = choice("held", selected=False, v5=False, reasons=["hold"])
        held["profiles"]["runtime_budget"].update(eligible=True, hold_reasons=[])
        with self.assertRaisesRegex(ValueError, "eligibility"):
            composition.select_rows([held])
        for key, value in (("tie_break_seed", "other"), ("maximum_steps_per_profile", 60.0), ("training_authorized", 0),
            ("maximum_rows_per_conversation_quarter", True), ("maximum_split_prefix_change", {"numerator": True, "denominator": 500}),
            ("maximum_split_prefix_change", {"numerator": 1, "denominator": 499}), ("token_balanced_config_sha256", "0" * 64)):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "config"):
                composition.validate_config({**composition.CONFIG, key: value})

    def test_exact_fraction_score_and_source_position_tie(self):
        rows = [choice("a", group="a"), choice("b", group="b")]
        current = composition.loads(rows)
        limits = composition.metrics(current)
        limits["train"] = tuple(value - Fraction(1, 10 ** 30) for value in limits["train"])
        self.assertGreater(composition.score(current, limits), 0)
        self.assertIsInstance(composition.score(current, limits), Fraction)
        self.assertEqual(previous.position_delta(rows[0], {**rows[0], "target_end_ordinal": 2}), Fraction(1, 99))


class ExportTests(unittest.TestCase):
    def setUp(self):
        fixture = self.fixture = token_fixtures.ExportTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.root, self.when = fixture.root, fixture.when
        self.token_balanced_baseline = self.root / "v6"
        previous.build(output=self.token_balanced_baseline, occurred_at=self.when, **fixture.inputs)
        self.inputs = {**fixture.inputs, "token_balanced_baseline": self.token_balanced_baseline}
        self.output = self.root / "v7"

    def build(self, output=None):
        return composition.build(output=output or self.output, occurred_at=self.when, **self.inputs)

    def rehash(self, name):
        path = self.output / name
        manifest = source.read_json(self.output / "export_manifest.json")
        manifest["files"][name].update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        source.dump_json(self.output / "export_manifest.json", manifest)

    def test_exact_bytes_prefix_masks_panel_and_all_old_inputs_are_preserved(self):
        before = {path: source.sha_file(path) for path in self.root.rglob("*") if path.is_file()}
        summary = self.build()
        plan = composition.prepare(**self.inputs)
        composition.verify_artifacts(self.output, plan)
        source_rows = {json.loads(line)["id"]: line for split in source.SPLITS
            for line in gzip.decompress((self.inputs["release"] / f"conversation/{split}.jsonl.gz").read_bytes()).splitlines(keepends=True)}
        for name in composition.EXPORT_FILES:
            for line in gzip.decompress((self.output / name).read_bytes()).splitlines(keepends=True):
                row = json.loads(line)
                self.assertEqual(line, source_rows[row["id"]])
                self.assertEqual(row["loss_message_mask"], [0] * (len(row["messages"]) - 1) + [1])
        self.assertEqual((self.output / composition.PANEL_FILE).read_bytes(), (self.token_balanced_baseline / composition.PANEL_FILE).read_bytes())
        self.assertEqual(sum(path.is_file() for path in self.output.rglob("*")), 10)
        self.assertEqual(before, {path: source.sha_file(path) for path in before})
        self.assertEqual(summary["token_balanced_baseline_files_bound"], 10)
        self.assertFalse(summary["training_authorized"])
        self.assertFalse(summary["profiles_are_independent"])
        self.assertTrue(summary["development_exposed"])
        self.assertNotIn("baseline_subsets_only", summary)
        self.assertNotIn("new_row_ids_added", summary)

    def test_previous_decisions_and_panel_metadata_are_preserved_separately(self):
        self.build()
        old = {row["id"]: row for row in source.read_rows(self.token_balanced_baseline / "selection_ledger.jsonl.gz")}
        for row in source.read_rows(self.output / "selection_ledger.jsonl.gz"):
            for key in ("profiles", "selection_v5", "selection_v6", "chosen", "validation_late_stratified", "balanced_config_sha256", "stratified_config_sha256"):
                self.assertEqual(row[key], old[row["id"]][key])
            self.assertEqual(row["token_balanced_config_sha256"], old[row["id"]]["config_sha256"])
            self.assertEqual(set(row["selection_v7"]), set(composition.PROFILES))

    def test_all_artifacts_and_implementations_are_hash_bound(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        expected = {path for name in ("baseline", "balanced_baseline", "stratified_baseline", "token_balanced_baseline")
                    for path in self.inputs[name].rglob("*") if path.is_file()}
        self.assertTrue(expected <= plan["tracked"].keys())
        self.assertTrue({Path(composition.__file__), Path(previous.__file__)} <= plan["tracked"].keys())
        path = self.token_balanced_baseline / "strict_4096/train.jsonl.gz"
        path.write_bytes(path.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "inputs changed"):
            composition.verify_artifacts(self.output, plan)

    def test_v6_manifest_swap_after_successful_verification_fails_before_publish(self):
        verify = previous.verify_artifacts
        def swapped(path, plan):
            manifest = verify(path, plan)
            source.dump_json(Path(path) / "export_manifest.json", {**manifest, "concurrent_swap": True})
            return manifest
        with patch.object(previous, "verify_artifacts", side_effect=swapped):
            with self.assertRaisesRegex(ValueError, "inputs changed during preparation"):
                self.build()
        self.assertFalse(self.output.exists())

    def test_rehashed_old_ledger_cannot_redefine_the_verified_v6_baseline(self):
        path = self.token_balanced_baseline / "selection_ledger.jsonl.gz"
        rows = list(source.read_rows(path))
        rows[0]["selection_v6"]["strict_4096"]["chosen"] = not rows[0]["selection_v6"]["strict_4096"]["chosen"]
        path.unlink()
        base.write_gzip(path, (base.encoded(row) for row in rows))
        manifest = source.read_json(self.token_balanced_baseline / "export_manifest.json")
        manifest["files"][path.name].update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        source.dump_json(self.token_balanced_baseline / "export_manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "recomputed decisions"):
            self.build()

    def test_rehashed_new_ledger_and_summary_config_types_are_recomputed(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        path = self.output / "selection_ledger.jsonl.gz"
        original = list(source.read_rows(path))
        for field in ("chosen", "baseline_chosen", "reason"):
            rows = copy.deepcopy(original)
            rows[0]["selection_v7"]["strict_4096"][field] = 1
            path.unlink()
            base.write_gzip(path, (base.encoded(row) for row in rows))
            self.rehash(path.name)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "recomputed decisions"):
                composition.verify_artifacts(self.output, plan)
        path.unlink()
        base.write_gzip(path, (base.encoded(row) for row in original))
        self.rehash(path.name)
        for name in ("composition_config.json", "summary.json"):
            original_doc = source.read_json(self.output / name)
            source.dump_json(self.output / name, {**original_doc, "training_authorized": 0})
            self.rehash(name)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "config or summary"):
                composition.verify_artifacts(self.output, plan)
            source.dump_json(self.output / name, original_doc)
            self.rehash(name)

    def test_rehashed_original_source_bytes_are_rejected(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        name = "strict_4096/train.jsonl.gz"
        path = self.output / name
        rows = list(source.read_rows(path))
        rows[0]["messages"][1]["content"] = "Synthetic changed full-prefix text"
        path.unlink()
        base.write_gzip(path, (base.encoded(row) for row in rows))
        self.rehash(name)
        with self.assertRaisesRegex(ValueError, "original bytes"):
            composition.verify_artifacts(self.output, plan)

    def test_panel_recompression_even_with_identical_lines_is_rejected(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        path = self.output / composition.PANEL_FILE
        original = gzip.decompress(path.read_bytes())
        path.write_bytes(gzip.compress(original, mtime=1710000000))
        self.rehash(composition.PANEL_FILE)
        with self.assertRaisesRegex(ValueError, "panel compressed bytes"):
            composition.verify_artifacts(self.output, plan)

    def test_manifest_flags_counts_hashes_and_history_are_checked(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        original = source.read_json(self.output / "export_manifest.json")
        for field in (*composition.FALSE_FLAGS, *composition.TRUE_FLAGS):
            source.dump_json(self.output / "export_manifest.json", {**original, field: int(original[field])})
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "authorization"):
                composition.verify_artifacts(self.output, plan)
        source.dump_json(self.output / "export_manifest.json", original)
        for field, value, message in (("rows", True, "count mismatch"), ("uncompressed_sha256", "0" * 64, "uncompressed hash")):
            changed = copy.deepcopy(original)
            changed["files"]["strict_4096/train.jsonl.gz"][field] = value
            source.dump_json(self.output / "export_manifest.json", changed)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, message):
                composition.verify_artifacts(self.output, plan)
        source.dump_json(self.output / "export_manifest.json", original)
        path = self.output / "evaluation_history_events.jsonl"
        events = list(history._json_rows(path))
        events[0]["event_id"] = "forged_event"
        path.write_bytes(b"".join(base.encoded(event) for event in events))
        self.rehash(path.name)
        with self.assertRaisesRegex(ValueError, "history sidecar"):
            composition.verify_artifacts(self.output, plan)

    def test_inventory_symlinks_and_history_pointers(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        for event in history._json_rows(self.output / "evaluation_history_events.jsonl"):
            self.assertEqual(event["evidence"]["sha256"], source.sha_file(self.output / "summary.json"))
            self.assertEqual({key: history._pointer(plan["summary"], pointer) for key, pointer in event["evidence"]["input_pointers"].items()}, event["input_sha256"])
        extra = self.output / "unexpected"
        extra.mkdir()
        with self.assertRaisesRegex(ValueError, "inventory"):
            composition.verify_artifacts(self.output, plan)
        extra.rmdir()
        directory = self.output / "strict_4096"
        moved = self.root / "moved_profile"
        directory.rename(moved)
        directory.symlink_to(moved, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "inventory|profile directory"):
            composition.verify_artifacts(self.output, plan)

    def test_fixed_budget_reproducibility_no_overwrite_and_atomic_cleanup(self):
        for value in (4096, True, "8192", 8192.0):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "requires output budget"):
                composition.prepare(**self.inputs, output_budget=value)
        self.build()
        other = self.root / "second_v7"
        self.build(other)
        self.assertEqual({path.relative_to(self.output).as_posix(): source.sha_file(path) for path in self.output.rglob("*") if path.is_file()},
                         {path.relative_to(other).as_posix(): source.sha_file(path) for path in other.rglob("*") if path.is_file()})
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.build()
        failed = self.root / "failed_v7"
        with patch.object(composition.os, "replace", side_effect=OSError("synthetic publication failure")):
            with self.assertRaisesRegex(OSError, "publication failure"):
                self.build(failed)
        self.assertFalse(failed.exists())
        self.assertFalse(list(self.root.glob(".prefix-balanced-stage-*")))


if __name__ == "__main__":
    unittest.main()
