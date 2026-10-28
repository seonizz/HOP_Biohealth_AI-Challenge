"""Synthetic paired transfers, original-byte lineage and publication attacks."""
import copy
from fractions import Fraction
import gzip
import json
from pathlib import Path
import random
import unittest
from unittest.mock import patch

from counseling_pipeline import source_token_balanced_composition as composition
from counseling_pipeline import source_stratified_composition as stratified
from counseling_pipeline import source_composition as base, source_sft as source, evaluation_history as history
import test_source_stratified_composition as fixtures


def choice(identity, *, selected=True, historical=True, **kwargs):
    row = fixtures.choice(identity, main=historical, strict=historical, prefix=1000, **kwargs)
    row.update(original_turn_count=100, target_end_ordinal={q: i * 25 + 1 for i, q in enumerate(base.QUARTERS)}[row["position_band"]])
    row["selection_v5"] = {profile: {"baseline_chosen": historical, "core_chosen": selected, "chosen": selected,
        "reason": "mandatory_core" if selected else "early_removed", "group_cap": 10} for profile in composition.PROFILES}
    return row


def paired_fixture():
    rows = []
    for split in source.SPLITS:
        for index in range(12):
            group = f"{split}_{index:02d}"
            target = 200 if index == 0 else 20 if index == 1 else 110
            rows.append(choice(group + "_early", group=group, conv=group, split=split, target=target))
            rows.append(choice(group + "_late", group=group, conv=group, split=split, target=10, quarter=base.QUARTERS[2]))
            if index:
                rows.append(choice(group + "_historical", selected=False, group=group, conv=group,
                    split=split, target=200 - target, quarter=base.QUARTERS[1]))
            if index < 2:
                rows.append(choice(group + "_replacement", selected=False, historical=False, group=group,
                    conv=group, split=split, target=110))
    return rows


class PairTests(unittest.TestCase):
    def setUp(self):
        self.rows = paired_fixture()
        self.old = [row for row in self.rows if row["selection_v5"]["strict_4096"]["chosen"]]
        self.selected = {composition.cell(row): row for row in self.old}
        self.negative, self.positive = [row for row in self.rows if row["id"] in ("train_00_replacement", "train_01_replacement")]

    def test_exact_paired_selection_preserves_cells_late_ids_rows_and_split_totals(self):
        decisions = composition.select_rows(self.rows)
        for profile, result in decisions.items():
            with self.subTest(profile=profile):
                chosen = [row for row in self.rows if row["id"] in result["chosen_ids"]]
                self.assertEqual(len(result["trace"]), 2)
                self.assertEqual(len(result["chosen_ids"] - result["baseline_ids"]), 4)
                self.assertEqual({composition.cell(row) for row in chosen}, self.selected.keys())
                self.assertEqual(composition.stratified.concentration(chosen), composition.stratified.concentration(self.old))
                self.assertEqual({row["id"] for row in chosen if row["position_band"] in composition.LATE},
                    {row["id"] for row in self.old if row["position_band"] in composition.LATE})
                for split in source.SPLITS:
                    self.assertEqual(sum(row["target_length"] for row in chosen if row["split"] == split),
                                     sum(row["target_length"] for row in self.old if row["split"] == split))
                self.assertEqual(result["trace"][-1]["score_exact"], [0, 1])
                self.assertTrue(all(step["split_and_overall_hhi_strictly_decreased"] for step in result["trace"]))

    def test_reverse_and_seeded_shuffle_keep_exact_selection_and_trace(self):
        expected = composition.select_rows(self.rows)
        shuffled = list(self.rows)
        random.Random(1847).shuffle(shuffled)
        self.assertEqual(composition.select_rows(list(reversed(self.rows))), expected)
        self.assertEqual(composition.select_rows(shuffled), expected)

    def test_equal_mass_top10_boundary_is_explicit_and_order_invariant(self):
        baseline = [choice(f"g{i:02d}", group=f"g{i:02d}", target=200) for i in range(11)]
        baseline.append(choice("low", group="z_low", target=20))
        options = {composition.cell(row): [row, {**row, "id": row["id"] + "_new", "target_length": 110, "sequence_length": 1110}] for row in baseline}
        expected_donors = [f"g{i:02d}" for i in range(10)]
        self.assertEqual(composition.donor_groups(composition.loads(baseline), "train"), expected_donors)
        desired = [options[composition.cell(row)][1] if row["id"] in ("g00", "low") else row for row in baseline]
        limits = composition.metrics(composition.loads(desired))
        expected = composition.paired_swap(baseline, options, limits, "strict_4096")
        reverse_options = {key: list(reversed(items)) for key, items in reversed(list(options.items()))}
        self.assertEqual(composition.paired_swap(list(reversed(baseline)), reverse_options, limits, "strict_4096"), expected)
        shuffled = list(baseline)
        random.Random(9).shuffle(shuffled)
        self.assertEqual(composition.paired_swap(shuffled, reverse_options, limits, "strict_4096"), expected)
        self.assertEqual(len(expected[1]), 1)
        self.assertTrue(any(row["id"] == "g10" for row in expected[0]))

    def test_fraction_score_and_position_tie_do_not_use_tolerance(self):
        old = composition.metrics(composition.loads(self.old))
        limits = copy.deepcopy(old)
        limits["train"] = tuple(value - Fraction(1, 10 ** 30) for value in old["train"])
        exact = composition.score(composition.loads(self.old), limits)
        self.assertIsInstance(exact, Fraction)
        self.assertGreater(exact, 0)
        self.assertFalse(composition.passed(composition.loads(self.old), limits))
        changed = {**self.negative, "target_end_ordinal": 2}
        self.assertEqual(composition.position_delta(self.negative, changed), Fraction(1, 99))

    def test_same_group_cross_split_unequal_delta_and_overshoot_are_rejected(self):
        cases = [
            ({**self.positive, "source_group_id": self.negative["source_group_id"]}, "origin|distinct"),
            ({**self.positive, "split": "validation"}, "origin|same split"),
            ({**self.positive, "target_length": 111, "sequence_length": 1111}, "unequal"),
        ]
        for positive, message in cases:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                composition.validate_pair(self.selected, self.negative, positive, composition.loads(self.old), "strict_4096")
        current = composition.loads(self.old)
        current["train"]["train_00"] = 209
        with self.assertRaisesRegex(ValueError, "overshoots"):
            composition.validate_pair(self.selected, self.negative, self.positive, current, "strict_4096")

    def test_held_medical_over_budget_and_late_pair_options_fail_closed(self):
        cases = [
            {**self.negative, "source_reasons": ["original_hold"], "source_admitted": False},
            {**self.negative, "context_flags": ["prior_assistant_medical_pattern"]},
            {**self.negative, "prefix_length": 4000, "sequence_length": 4110},
        ]
        for negative in cases:
            with self.subTest(flags=negative["context_flags"]), self.assertRaisesRegex(ValueError, "held or over-budget"):
                composition.validate_pair(self.selected, negative, self.positive, composition.loads(self.old), "strict_4096")
        late = {**self.negative, "position_band": base.QUARTERS[2]}
        with self.assertRaisesRegex(ValueError, "late representative"):
            composition.validate_pair(self.selected, late, self.positive, composition.loads(self.old), "strict_4096")
        allowed = {**self.negative, "context_flags": ["prior_assistant_procedural_pattern"]}
        self.assertEqual(composition.validate_pair(self.selected, allowed, self.positive, composition.loads(self.old), "strict_4096")[-1], 90)

    def test_wrong_cell_unknown_option_and_changed_late_id_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "selected cell"):
            composition.validate_pair(self.selected, {**self.negative, "source_conversation_id": "missing"},
                self.positive, composition.loads(self.old), "strict_4096")
        options = composition.swap_options(self.rows, self.old, "strict_4096")
        limits = composition.metrics(composition.loads(self.old))
        changed = copy.deepcopy(self.old)
        changed[0]["source_conversation_id"] = "other"
        with self.assertRaisesRegex(ValueError, "cells"):
            composition.validate_selection(self.old, changed, options, limits)
        changed = copy.deepcopy(self.old)
        changed[0]["target_end_ordinal"] += 1
        with self.assertRaisesRegex(ValueError, "original allowed"):
            composition.validate_selection(self.old, changed, options, limits)
        changed = copy.deepcopy(self.old)
        late = next(row for row in changed if row["position_band"] in composition.LATE)
        late["id"] = "forged_late"
        with self.assertRaisesRegex(ValueError, "original allowed|late representatives"):
            composition.validate_selection(self.old, changed, options, limits)

    def test_bounded_path_failure_is_not_claimed_as_global_impossibility(self):
        historical = [row for row in self.rows if row["profiles"]["strict_4096"]["chosen"]]
        limits = composition.thresholds(self.old, historical)
        no_moves = {composition.cell(row): [row] for row in self.old}
        with self.assertRaisesRegex(ValueError, "fixed top10 greedy path.*global feasibility unknown"):
            composition.paired_swap(self.old, no_moves, limits, "strict_4096")
        options = composition.swap_options(self.rows, self.old, "strict_4096")
        with self.assertRaisesRegex(ValueError, "step limit.*global feasibility unknown"):
            composition.paired_swap(self.old, options, limits, "strict_4096", max_steps=0)

    def test_empty_rows_and_already_passing_baseline_stop_without_changes(self):
        empty = composition.select_rows([])
        self.assertTrue(all(not result["chosen_ids"] and not result["trace"] for result in empty.values()))
        result = composition.select_rows([choice("only")])
        self.assertTrue(all(result[p]["chosen_ids"] == {"only"} and result[p]["trace"] == [] for p in composition.PROFILES))

    def test_all_rows_including_held_rows_receive_identity_eligibility_and_typed_checks(self):
        original = choice("one")
        held = choice("held", selected=False, historical=False, reasons=["prior_hold"])
        for bad in ({**held, "id": "one"}, {**held, "split": "validation"}, {**held, "source_conversation_id": "one", "source_group_id": "different"},
                    {**held, "original_turn_count": True}, {**held, "target_end_ordinal": 1.0}):
            with self.subTest(identity=bad["id"]), self.assertRaises(ValueError):
                composition.select_rows([original, bad])
        for section, key in (("selection_v5", "chosen"), ("selection_v5", "core_chosen"), ("selection_v5", "baseline_chosen"), ("profiles", "eligible")):
            bad = copy.deepcopy(original)
            bad[section]["strict_4096"][key] = 1
            with self.subTest(section=section, key=key), self.assertRaises(ValueError):
                composition.select_rows([bad])
        bad = copy.deepcopy(held)
        bad["profiles"]["runtime_budget"].update(eligible=True, hold_reasons=[])
        with self.assertRaisesRegex(ValueError, "eligibility"):
            composition.select_rows([bad])

    def test_budget_boundaries_and_config_types_cannot_be_relaxed(self):
        for prefix, target, valid in ((61440, 8192, True), (61441, 1, False), (1, 8193, False)):
            row = choice("edge", selected=False, historical=False, target=target)
            row.update(prefix_length=prefix, sequence_length=prefix + target)
            for profile in composition.budget.PROFILES:
                row["profiles"][profile] = composition.budget.budget_decision(row, profile, composition.budget.make_config(8192))
            row["chosen"] = True
            row["selection_v5"]["runtime_capped"].update(baseline_chosen=True, core_chosen=True, chosen=True)
            if valid:
                self.assertEqual(composition.select_rows([row])["runtime_capped"]["chosen_ids"], {"edge"})
            else:
                with self.assertRaisesRegex(ValueError, "ineligible"):
                    composition.select_rows([row])
        for key, value in (("maximum_steps_per_profile", 60.0), ("maximum_rows_per_conversation_quarter", True),
                           ("training_authorized", 0), ("output_budget", "8192"), ("stratified_config_sha256", "0" * 64)):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "config"):
                composition.validate_config({**composition.CONFIG, key: value})


class ExportTests(unittest.TestCase):
    def setUp(self):
        fixture = self.fixture = fixtures.ExportTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.root, self.when = fixture.root, fixture.when
        self.stratified_baseline = self.root / "v5"
        stratified.build(output=self.stratified_baseline, occurred_at=self.when, **fixture.inputs)
        self.inputs = {**fixture.inputs, "stratified_baseline": self.stratified_baseline}
        self.output = self.root / "v6"

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
        self.assertEqual((self.output / composition.PANEL_FILE).read_bytes(), (self.stratified_baseline / composition.PANEL_FILE).read_bytes())
        self.assertEqual(sum(path.is_file() for path in self.output.rglob("*")), 10)
        self.assertEqual(before, {path: source.sha_file(path) for path in before})
        self.assertEqual(summary["stratified_baseline_files_bound"], 10)
        self.assertFalse(summary["training_authorized"])
        self.assertFalse(summary["profiles_are_independent"])
        self.assertTrue(summary["development_exposed"])
        self.assertNotIn("baseline_subsets_only", summary)
        self.assertNotIn("new_row_ids_added", summary)

    def test_previous_decisions_and_panel_metadata_are_preserved_separately(self):
        self.build()
        old = {row["id"]: row for row in source.read_rows(self.stratified_baseline / "selection_ledger.jsonl.gz")}
        for row in source.read_rows(self.output / "selection_ledger.jsonl.gz"):
            for key in ("profiles", "selection_v5", "chosen", "validation_late_stratified", "balanced_config_sha256"):
                self.assertEqual(row[key], old[row["id"]][key])
            self.assertEqual(row["stratified_config_sha256"], old[row["id"]]["config_sha256"])
            self.assertEqual(set(row["selection_v6"]), set(composition.PROFILES))

    def test_all_artifacts_and_implementations_are_hash_bound(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        expected = {path for name in ("baseline", "balanced_baseline", "stratified_baseline")
                    for path in self.inputs[name].rglob("*") if path.is_file()}
        self.assertTrue(expected <= plan["tracked"].keys())
        self.assertTrue({Path(composition.__file__), Path(stratified.__file__)} <= plan["tracked"].keys())
        path = self.stratified_baseline / "strict_4096/train.jsonl.gz"
        path.write_bytes(path.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "inputs changed"):
            composition.verify_artifacts(self.output, plan)

    def test_v5_manifest_swap_after_successful_verification_fails_before_publish(self):
        verify = stratified.verify_artifacts
        def swapped(path, plan):
            manifest = verify(path, plan)
            source.dump_json(Path(path) / "export_manifest.json", {**manifest, "concurrent_swap": True})
            return manifest
        with patch.object(stratified, "verify_artifacts", side_effect=swapped):
            with self.assertRaisesRegex(ValueError, "inputs changed during preparation"):
                self.build()
        self.assertFalse(self.output.exists())

    def test_rehashed_old_ledger_cannot_redefine_the_verified_v5_baseline(self):
        path = self.stratified_baseline / "selection_ledger.jsonl.gz"
        rows = list(source.read_rows(path))
        rows[0]["selection_v5"]["strict_4096"]["chosen"] = not rows[0]["selection_v5"]["strict_4096"]["chosen"]
        path.unlink()
        base.write_gzip(path, (base.encoded(row) for row in rows))
        manifest = source.read_json(self.stratified_baseline / "export_manifest.json")
        manifest["files"][path.name].update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        source.dump_json(self.stratified_baseline / "export_manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "recomputed decisions"):
            self.build()

    def test_rehashed_new_ledger_and_summary_config_types_are_recomputed(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        path = self.output / "selection_ledger.jsonl.gz"
        original = list(source.read_rows(path))
        for field in ("chosen", "baseline_chosen", "reason"):
            rows = copy.deepcopy(original)
            rows[0]["selection_v6"]["strict_4096"][field] = 1
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
        other = self.root / "second_v6"
        self.build(other)
        self.assertEqual({path.relative_to(self.output).as_posix(): source.sha_file(path) for path in self.output.rglob("*") if path.is_file()},
                         {path.relative_to(other).as_posix(): source.sha_file(path) for path in other.rglob("*") if path.is_file()})
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.build()
        failed = self.root / "failed_v6"
        with patch.object(composition.os, "replace", side_effect=OSError("synthetic publication failure")):
            with self.assertRaisesRegex(OSError, "publication failure"):
                self.build(failed)
        self.assertFalse(failed.exists())
        self.assertFalse(list(self.root.glob(".token-balanced-stage-*")))


if __name__ == "__main__":
    unittest.main()
