"""Synthetic final batch caps, context-cell references and immutable source lineage."""
import copy
from fractions import Fraction
import gzip
import json
from pathlib import Path
import random
import unittest
from unittest.mock import patch

from counseling_pipeline import source_volume_context_composition as composition
from counseling_pipeline import source_prefix_balanced_composition as previous
from counseling_pipeline import source_composition as base, source_sft as source, evaluation_history as history
import test_source_prefix_balanced_composition as prefix_fixtures


def choice(identity, *, v7=True, v6=True, v5=True, prefix=2000, target=100, flags=(), **kwargs):
    row = prefix_fixtures.choice(identity, selected=v6, v5=v5, prefix=prefix, target=target, **kwargs)
    row["context_flags"] = list(flags)
    row.update(relative_position=row["target_end_ordinal"] / max(1, row["original_turn_count"] - 1),
               source_cohort="synthetic", length_tier=base.length_tier(prefix + target), lexical_tags=["other"],
               target_characters=10, non_system_messages=2, prefix_plus_reserved_output=prefix + 8192,
               review_required=True)
    for profile in composition.budget.PROFILES:
        old = row["profiles"][profile]["chosen"]
        row["profiles"][profile] = composition.budget.budget_decision(row, profile, composition.budget.make_config(8192))
        row["profiles"][profile]["chosen"] = old
    row["selection_v7"] = {profile: {"baseline_chosen": v6, "chosen": v7,
        "reason": "retained_late" if row["position_band"] in composition.LATE and v7 else "retained_early" if v7 and v6
            else "same_target_prefix_replacement" if v7 else "early_replaced" if v6 else "not_selected"}
        for profile in composition.PROFILES}
    return row


def fixture_rows():
    rows = []
    for split in source.SPLITS:
        for index in range(12):
            group = f"{split}_{index:02d}"
            rows.append(choice(group + "_v5", v6=index != 0, v7=index > 1, group=group, conv=group, split=split))
            rows.append(choice(group + "_late", group=group, conv=group, split=split, prefix=500, quarter=base.QUARTERS[2]))
            if index == 0:
                rows.append(choice(group + "_v6", v5=False, group=group, conv=group, split=split, prefix=2004,
                                   flags=[composition.PROCEDURAL]))
            if index == 1:
                rows.append(choice(group + "_v7", v5=False, v6=False, group=group, conv=group, split=split, prefix=2004,
                                   flags=[composition.PROCEDURAL]))
    return rows


def references(rows, profile="strict_4096"):
    return tuple([row for row in rows if row[version][profile]["chosen"]] for version in ("selection_v7", "selection_v6", "selection_v5"))


class SelectionTests(unittest.TestCase):
    def test_atomic_selection_keeps_cells_targets_late_split_and_meets_final_caps(self):
        rows = fixture_rows()
        decisions = composition.select_rows(rows)
        for profile, decision in decisions.items():
            old, initial, historical = references(rows, profile)
            chosen = [row for row in rows if row["id"] in decision["chosen_ids"]]
            reference = historical if profile == "strict_4096" else initial
            with self.subTest(profile=profile):
                self.assertEqual(len(chosen), len(old))
                self.assertEqual({composition.cell(row) for row in chosen}, {composition.cell(row) for row in old})
                self.assertEqual(composition.target_balance.loads(old), composition.target_balance.loads(chosen))
                self.assertEqual(composition.stratified.concentration(old), composition.stratified.concentration(chosen))
                self.assertTrue(all(composition.prefix_totals(chosen)[s] <= composition.prefix_totals(reference)[s] for s in source.SPLITS))
                self.assertTrue(all(composition.procedural_counts(chosen)[s] <= composition.procedural_counts(reference)[s] for s in source.SPLITS))
                self.assertTrue(composition.passed(composition.loads(chosen), decision["limits"]))
                self.assertEqual({row["id"] for row in old if row["position_band"] in composition.LATE},
                                 {row["id"] for row in chosen if row["position_band"] in composition.LATE})
                if decision["trace"]:
                    self.assertEqual(decision["trace"][-1]["score_exact"], [0, 1])
                else:
                    self.assertEqual(decision["chosen_ids"], decision["initial_ids"])

    def test_reverse_shuffle_and_equal_score_ties_preserve_exact_trace(self):
        rows = fixture_rows()
        rows.append(choice("equal_option", v5=False, v6=False, v7=False, group="train_00", conv="train_00"))
        expected = composition.select_rows(rows)
        shuffled = list(rows)
        random.Random(20261016).shuffle(shuffled)
        self.assertEqual(expected, composition.select_rows(list(reversed(rows))))
        self.assertEqual(expected, composition.select_rows(shuffled))

    def test_same_target_and_no_new_v6_cell_filters_are_separate_from_count_cap(self):
        rows = fixture_rows()
        old, initial, _ = references(rows)
        wrong = choice("other_length", v5=False, v6=False, v7=False, group="train_00", conv="train_00", target=99)
        options = composition.swap_options(rows + [wrong], old, initial, "strict_4096")
        allowed = {row["id"] for values in options.values() for row in values}
        self.assertNotIn("other_length", allowed)
        self.assertNotIn("train_01_v7", allowed)
        self.assertIn("train_00_v6", allowed)

    def test_reference_caps_are_strict_v5_runtime_v6_with_no_reduction_floor(self):
        rows = [choice("v5", v6=False, v7=False, prefix=1000),
                choice("v6", v5=False, v7=False, prefix=2000),
                choice("v7", v5=False, v6=False, prefix=2001)]
        for row in rows:
            row["source_conversation_id"] = "same"
        choices = composition.select_rows(rows)
        self.assertEqual(choices["strict_4096"]["chosen_ids"], {"v5"})
        self.assertEqual(choices["runtime_capped"]["chosen_ids"], {"v6"})
        self.assertNotIn("split_prefix_change_within_bound", composition.TRUE_FLAGS)

    def test_intermediate_metric_increase_is_allowed_when_final_batch_passes(self):
        rows = [choice("a_v5", v6=True, v7=False, prefix=2000, group="a", conv="a"),
                choice("a_v7", v5=False, v6=False, prefix=2500, group="a", conv="a"),
                choice("b_v5", v6=False, v7=False, prefix=1800, group="b", conv="b"),
                choice("b_v6", v5=False, prefix=2000, group="b", conv="b", flags=[composition.PROCEDURAL])]
        decision = composition.select_rows(rows)["strict_4096"]
        self.assertTrue(any(not step["all_nine_prefix_metrics_nonincreasing"] for step in decision["trace"]))
        self.assertEqual(decision["chosen_ids"], {"a_v5", "b_v5"})

    def test_zero_prefix_delta_context_replacement_can_reduce_joint_score(self):
        rows = [choice("clear", v6=False, v7=False, prefix=2000, conv="same"),
                choice("flagged", v5=False, prefix=2000, conv="same", flags=[composition.PROCEDURAL])]
        result = composition.select_rows(rows)["strict_4096"]
        self.assertEqual(result["chosen_ids"], {"clear"})
        self.assertEqual(result["trace"][0]["prefix_token_delta"], 0)
        self.assertEqual(result["trace"][0]["procedural_flag_delta"], -1)

    def test_v5_count_match_does_not_claim_v5_per_cell_flag_preservation(self):
        rows = [choice("a_v5", v6=False, v7=False, group="a", conv="a", target=101),
                choice("a_v6", v5=False, group="a", conv="a", flags=[composition.PROCEDURAL]),
                choice("b_old", group="b", conv="b", flags=[composition.PROCEDURAL]),
                choice("b_clear", v5=False, v6=False, v7=False, group="b", conv="b")]
        result = composition.select_rows(rows)["strict_4096"]
        baseline, initial, historical = references(rows)
        chosen = [row for row in rows if row["id"] in result["chosen_ids"]]
        summary = composition.change_summary(baseline, chosen, initial, historical, result, "strict_4096")
        self.assertEqual(summary["procedural_context_counts"]["train"]["selected"], 1)
        self.assertEqual(summary["new_procedural_flag_cells"]["v6"]["train"], 0)
        self.assertEqual(summary["new_procedural_flag_cells"]["v5"]["train"], 1)
        self.assertIn("v5_per_cell_procedural_no_new_guaranteed", composition.FALSE_FLAGS)

    def test_final_caps_and_v7_ceiling_cannot_be_relaxed_to_older_limits(self):
        rows = fixture_rows()
        old, initial, historical = references(rows)
        options = composition.swap_options(rows, old, initial, "strict_4096")
        limits = composition.metrics(composition.loads(old))
        with self.assertRaisesRegex(ValueError, "prefix total exceeds"):
            composition.validate_selection(old, initial, initial, historical, options, limits, "strict_4096")
        chosen = [row for row in rows if row["id"] in composition.select_rows(rows)["strict_4096"]["chosen_ids"]]
        relaxed = {s: tuple(v + Fraction(1, 10 ** 9) for v in values) for s, values in limits.items()}
        with self.assertRaisesRegex(ValueError, "ceilings must equal v7"):
            composition.validate_selection(old, chosen, initial, historical, options, relaxed, "strict_4096")
        same_volume_flagged = [choice("old_flag", v5=False, prefix=1000, conv="same", flags=[composition.PROCEDURAL]),
                              choice("historical_clear", v6=False, v7=False, prefix=1000, conv="same")]
        old, initial, historical = references(same_volume_flagged)
        with self.assertRaisesRegex(ValueError, "procedural count exceeds"):
            composition.validate_selection(old, old, initial, historical, composition.swap_options(same_volume_flagged, old, initial, "strict_4096"),
                                           composition.metrics(composition.loads(old)), "strict_4096")

    def test_final_per_cell_flag_guard_rejects_unchanged_aggregate_count(self):
        old = [choice("a", group="a", conv="a", flags=[composition.PROCEDURAL]), choice("b", group="b", conv="b")]
        changed = [{**old[0], "id": "a_clear", "context_flags": []}, {**old[1], "id": "b_new", "context_flags": [composition.PROCEDURAL]}]
        options = {composition.cell(a): [a, b] for a, b in zip(old, changed)}
        self.assertEqual(composition.procedural_counts(old), composition.procedural_counts(changed))
        with self.assertRaisesRegex(ValueError, "new procedural flag"):
            composition.validate_selection(old, changed, old, old, options, composition.metrics(composition.loads(old)), "strict_4096")

    def test_final_prefix_metrics_must_pass_even_with_correct_caps_and_flags(self):
        old = [choice("a_v7", group="a", conv="a", prefix=2000), choice("b_v7", group="b", conv="b", prefix=2000)]
        changed = [{**old[0], "id": "a_v6", "prefix_length": 3000, "sequence_length": 3100},
                   {**old[1], "id": "b_v6", "prefix_length": 1000, "sequence_length": 1100}]
        options = {composition.cell(a): [a, b] for a, b in zip(old, changed)}
        limits = composition.metrics(composition.loads(old))
        with self.assertRaisesRegex(ValueError, "final prefix concentration exceeds v7"):
            composition.validate_selection(old, changed, changed, changed, options, limits, "strict_4096")
        for value in (True, 1.0):
            bad = copy.deepcopy(limits)
            bad["train"] = (value, *limits["train"][1:])
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "exact Fraction"):
                composition.validate_selection(old, old, changed, changed, options, bad, "strict_4096")

    def test_move_rejects_origin_target_late_hold_budget_and_type_attacks(self):
        old = choice("old", group="g", conv="g", prefix=2000)
        replacement = {**old, "id": "new", "prefix_length": 1999, "sequence_length": 2099}
        selected = {composition.cell(old): old}
        attacks = [({**replacement, "target_length": True}, "target length"),
            ({**replacement, "target_length": 101, "sequence_length": 2100}, "target length"),
            ({**replacement, "source_group_id": "elsewhere"}, "origin"),
            ({**replacement, "split": "validation"}, "origin"),
            ({**replacement, "source_conversation_id": "unknown"}, "unknown.*cell"),
            ({**replacement, "source_reasons": ["hold"], "source_admitted": False}, "held or over-budget"),
            ({**replacement, "context_flags": ["prior_assistant_medical_pattern"]}, "held or over-budget"),
            ({**replacement, "context_flags": [composition.PROCEDURAL]}, "new procedural flag"),
            ({**replacement, "prefix_length": 4000, "sequence_length": 4100}, "held or over-budget"),
            ({**replacement, "prefix_length": 61441, "sequence_length": 61541}, "held or over-budget"),
            ({**replacement, "prefix_length": True, "sequence_length": 101}, "arithmetic")]
        for row, message in attacks:
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                composition.validate_move(selected, row, selected, "strict_4096")
        late = choice("late", quarter=base.QUARTERS[2])
        with self.assertRaisesRegex(ValueError, "late representative"):
            composition.validate_move({composition.cell(late): late}, {**late, "id": "changed_late"}, {composition.cell(late): late}, "strict_4096")

    def test_final_original_option_and_target_and_cell_guards(self):
        rows = fixture_rows()
        old, initial, historical = references(rows)
        options = composition.swap_options(rows, old, initial, "strict_4096")
        limits = composition.metrics(composition.loads(old))
        chosen = [row for row in rows if row["id"] in composition.select_rows(rows)["strict_4096"]["chosen_ids"]]
        with self.assertRaisesRegex(ValueError, "cells or row count"):
            composition.validate_selection(old, chosen[:-1], initial, historical, options, limits, "strict_4096")
        changed = copy.deepcopy(chosen)
        changed[0]["source_row_sha256"] = "forged"
        with self.assertRaisesRegex(ValueError, "original allowed option"):
            composition.validate_selection(old, changed, initial, historical, options, limits, "strict_4096")
        changed = copy.deepcopy(chosen)
        changed[0].update(target_length=101, sequence_length=changed[0]["prefix_length"] + 101)
        fake_options = copy.deepcopy(options)
        fake_options[composition.cell(changed[0])].append(changed[0])
        with self.assertRaisesRegex(ValueError, "target length changed"):
            composition.validate_selection(old, changed, initial, historical, fake_options, limits, "strict_4096")

    def test_typed_history_eligibility_config_and_reference_policy_are_fixed(self):
        for field in ("chosen", "baseline_chosen", "reason"):
            row = choice("typed")
            row["selection_v7"]["strict_4096"][field] = 1
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "typed v7"):
                composition.select_rows([row])
        held = choice("held", v5=False, v6=False, v7=False, reasons=["hold"])
        held["profiles"]["runtime_budget"].update(eligible=True, hold_reasons=[])
        with self.assertRaisesRegex(ValueError, "eligibility"):
            composition.select_rows([held])
        for key, value in (("maximum_steps_per_profile", 60.0), ("maximum_rows_per_conversation_quarter", True),
            ("training_authorized", 0), ("tie_break_seed", "different"), ("prefix_concentration_reference", "v6"),
            ("no_new_procedural_flag_cell_reference", "v7"), ("profile_split_cap_reference", {"strict_4096": "v6", "runtime_capped": "v6"}),
            ("prefix_balanced_config_sha256", "0" * 64)):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "config"):
                composition.validate_config({**composition.CONFIG, key: value})

    def test_empty_zero_step_and_bounded_failure_are_explicit(self):
        self.assertTrue(all(not c["chosen_ids"] and not c["trace"] for c in composition.select_rows([]).values()))
        self.assertTrue(all(not c["trace"] for c in composition.select_rows([choice("same")]).values()))
        rows = fixture_rows()
        old, initial, historical = references(rows)
        options = composition.swap_options(rows, old, initial, "strict_4096")
        limits = composition.metrics(composition.loads(old))
        args = (old, initial, options, limits, composition.prefix_totals(historical), composition.procedural_counts(historical), "strict_4096")
        with self.assertRaisesRegex(ValueError, "step limit.*global feasibility unknown"):
            composition.joint_swap(*args, max_steps=0)
        with self.assertRaisesRegex(ValueError, "joint-score path.*global feasibility unknown"):
            composition.joint_swap(old, initial, {composition.cell(row): [row] for row in initial}, *args[3:])
        with self.assertRaisesRegex(ValueError, "invalid.*step limit"):
            composition.joint_swap(*args, max_steps=True)

    def test_fraction_joint_score_includes_integer_caps_without_tolerance(self):
        current = composition.loads([choice("a", prefix=1000), choice("b", group="b", prefix=1000)])
        limits = composition.metrics(current)
        self.assertEqual(composition.score(current, {"train": 0, "validation": 0}, limits,
                                           {"train": 2000, "validation": 0}, {"train": 0, "validation": 0}), 0)
        value = composition.score(current, {"train": 1, "validation": 0}, limits,
                                  {"train": 1999, "validation": 0}, {"train": 0, "validation": 0})
        self.assertEqual(value, Fraction(1, 1999 ** 2) + 1)
        limits["train"] = tuple(v - Fraction(1, 10 ** 30) for v in limits["train"])
        self.assertGreater(composition.score(current, {"train": 0, "validation": 0}, limits,
                                            {"train": 2000, "validation": 0}, {"train": 0, "validation": 0}), 0)


class ExportTests(unittest.TestCase):
    def setUp(self):
        fixture = self.fixture = prefix_fixtures.ExportTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.root, self.when = fixture.root, fixture.when
        self.prefix_balanced_baseline = self.root / "v7"
        previous.build(output=self.prefix_balanced_baseline, occurred_at=self.when, **fixture.inputs)
        self.inputs = {**fixture.inputs, "prefix_balanced_baseline": self.prefix_balanced_baseline}
        self.output = self.root / "v8"

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
        self.assertEqual((self.output / composition.PANEL_FILE).read_bytes(), (self.prefix_balanced_baseline / composition.PANEL_FILE).read_bytes())
        self.assertEqual(sum(path.is_file() for path in self.output.rglob("*")), 10)
        self.assertEqual(before, {path: source.sha_file(path) for path in before})
        self.assertEqual(summary["prefix_balanced_baseline_files_bound"], 10)
        self.assertFalse(summary["training_authorized"])
        self.assertFalse(summary["profiles_are_independent"])
        self.assertTrue(summary["development_exposed"])
        self.assertNotIn("baseline_subsets_only", summary)
        self.assertNotIn("new_row_ids_added", summary)

    def test_previous_decisions_and_panel_metadata_are_preserved_separately(self):
        self.build()
        old = {row["id"]: row for row in source.read_rows(self.prefix_balanced_baseline / "selection_ledger.jsonl.gz")}
        for row in source.read_rows(self.output / "selection_ledger.jsonl.gz"):
            for key in ("profiles", "selection_v5", "selection_v6", "selection_v7", "chosen", "validation_late_stratified", "balanced_config_sha256", "stratified_config_sha256", "token_balanced_config_sha256"):
                self.assertEqual(row[key], old[row["id"]][key])
            self.assertEqual(row["prefix_balanced_config_sha256"], old[row["id"]]["config_sha256"])
            self.assertEqual(set(row["selection_v8"]), set(composition.PROFILES))

    def test_all_artifacts_and_implementations_are_hash_bound(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        expected = {path for name in ("baseline", "balanced_baseline", "stratified_baseline", "token_balanced_baseline", "prefix_balanced_baseline")
                    for path in self.inputs[name].rglob("*") if path.is_file()}
        self.assertTrue(expected <= plan["tracked"].keys())
        self.assertTrue({Path(composition.__file__), Path(previous.__file__)} <= plan["tracked"].keys())
        path = self.prefix_balanced_baseline / "strict_4096/train.jsonl.gz"
        path.write_bytes(path.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "inputs changed"):
            composition.verify_artifacts(self.output, plan)

    def test_v7_manifest_swap_after_successful_verification_fails_before_publish(self):
        verify = previous.verify_artifacts
        def swapped(path, plan):
            manifest = verify(path, plan)
            source.dump_json(Path(path) / "export_manifest.json", {**manifest, "concurrent_swap": True})
            return manifest
        with patch.object(previous, "verify_artifacts", side_effect=swapped):
            with self.assertRaisesRegex(ValueError, "inputs changed during preparation"):
                self.build()
        self.assertFalse(self.output.exists())

    def test_rehashed_old_ledger_cannot_redefine_the_verified_v7_baseline(self):
        path = self.prefix_balanced_baseline / "selection_ledger.jsonl.gz"
        rows = list(source.read_rows(path))
        rows[0]["selection_v7"]["strict_4096"]["chosen"] = not rows[0]["selection_v7"]["strict_4096"]["chosen"]
        path.unlink()
        base.write_gzip(path, (base.encoded(row) for row in rows))
        manifest = source.read_json(self.prefix_balanced_baseline / "export_manifest.json")
        manifest["files"][path.name].update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        source.dump_json(self.prefix_balanced_baseline / "export_manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "recomputed decisions"):
            self.build()

    def test_rehashed_new_ledger_and_summary_config_types_are_recomputed(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        path = self.output / "selection_ledger.jsonl.gz"
        original = list(source.read_rows(path))
        for field in ("chosen", "baseline_chosen", "reason"):
            rows = copy.deepcopy(original)
            rows[0]["selection_v8"]["strict_4096"][field] = 1
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
        other = self.root / "second_v8"
        self.build(other)
        self.assertEqual({path.relative_to(self.output).as_posix(): source.sha_file(path) for path in self.output.rglob("*") if path.is_file()},
                         {path.relative_to(other).as_posix(): source.sha_file(path) for path in other.rglob("*") if path.is_file()})
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.build()
        failed = self.root / "failed_v8"
        with patch.object(composition.os, "replace", side_effect=OSError("synthetic publication failure")):
            with self.assertRaisesRegex(OSError, "publication failure"):
                self.build(failed)
        self.assertFalse(failed.exists())
        self.assertFalse(list(self.root.glob(".volume-context-stage-*")))


if __name__ == "__main__":
    unittest.main()
