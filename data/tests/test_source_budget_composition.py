"""Synthetic budget, full-prefix preservation and publication attacks only."""
import copy
import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from counseling_pipeline import source_budget_composition as budget
from counseling_pipeline import source_composition as base, source_sft as source
from counseling_pipeline import source_admission as admission, evaluation_history as history, token_admission as token
import test_source_composition as source_fixtures


def metadata(identity="synthetic", *, group="group", conv=None, quarter=None, split="train", prefix=3000, target=100,
             reasons=None, flags=None, output_budget=4096):
    row = {"id": identity, "split": split, "source_group_id": group, "source_conversation_id": conv or identity,
        "position_band": quarter or base.QUARTERS[0], "source_reasons": reasons or [], "source_admitted": not reasons,
        "tokenizer_status": "encoded", "prefix_length": prefix, "target_length": target,
        "sequence_length": prefix + target, "context_flags": flags or []}
    row["profiles"] = {profile: budget.budget_decision(row, profile, budget.make_config(output_budget)) for profile in budget.PROFILES}
    return row


class BudgetTests(unittest.TestCase):
    def test_input_target_reserved_and_sequence_boundaries_are_distinct(self):
        cases = [
            (4000, 96, True, True, []),
            (4000, 97, True, False, ["sequence_exceeds_strict_4096_budget"]),
            (65536, 4096, True, False, ["sequence_exceeds_strict_4096_budget"]),
            (65536, 1, True, False, ["sequence_exceeds_strict_4096_budget"]),
            (65537, 1, False, False, ["prefix_exceeds_evaluation_input_budget", "prefix_plus_reserved_output_exceeds_evaluation_context_budget"]),
            (1, 4097, False, False, ["target_exceeds_evaluation_output_budget"]),
            (32768, 1, True, False, ["sequence_exceeds_strict_4096_budget"]),
        ]
        for prefix, target, runtime, strict, reasons in cases:
            row = metadata(prefix=prefix, target=target)
            with self.subTest(prefix=prefix, target=target):
                self.assertIs(row["profiles"]["runtime_budget"]["eligible"], runtime)
                self.assertIs(row["profiles"]["strict_4096"]["eligible"], strict)
                all_reasons = set(row["profiles"]["strict_4096"]["hold_reasons"])
                self.assertTrue(set(reasons) <= all_reasons)

    def test_previous_32768_and_selection_flags_do_not_define_new_pool(self):
        row = metadata(prefix=40000)
        row.update(eligible=False, pool_eligible=False, chosen=False, hold_reasons=["sequence_exceeds_composition_cap"])
        self.assertTrue(budget.budget_decision(row, "runtime_budget")["eligible"])
        self.assertFalse(budget.budget_decision(row, "strict_4096")["eligible"])

    def test_output_8192_effective_input_boundary_and_strict_sequence_are_separate(self):
        cases = [
            (61440, 8192, True, False, []),
            (61440, 1, True, False, []),
            (61441, 1, False, False, ["prefix_plus_reserved_output_exceeds_evaluation_context_budget"]),
            (1, 8193, False, False, ["target_exceeds_evaluation_output_budget"]),
            (4000, 96, True, True, []),
            (4000, 97, True, False, ["sequence_exceeds_strict_4096_budget"]),
        ]
        for prefix, target, runtime, strict, reasons in cases:
            row = metadata(prefix=prefix, target=target, output_budget=8192)
            with self.subTest(prefix=prefix, target=target):
                self.assertIs(row["profiles"]["runtime_budget"]["eligible"], runtime)
                self.assertIs(row["profiles"]["strict_4096"]["eligible"], strict)
                self.assertTrue(set(reasons) <= set(row["profiles"]["strict_4096"]["hold_reasons"]))
        blocked_by_reservation = metadata(prefix=61441, target=1, output_budget=8192)["profiles"]["runtime_budget"]
        self.assertNotIn("prefix_exceeds_evaluation_input_budget", blocked_by_reservation["hold_reasons"])
        self.assertEqual(blocked_by_reservation["hold_reasons"], ["prefix_plus_reserved_output_exceeds_evaluation_context_budget"])

    def test_output_scenario_config_rejects_unknown_types_and_keeps_recorded_limits(self):
        for value in (True, False, "8192", 8192.0, None, 4095, 8193, 16384):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "output budget"):
                budget.make_config(value)
        recorded, requested = budget.make_config(), budget.make_config(8192)
        self.assertEqual(recorded["recorded_runtime_budget"], requested["recorded_runtime_budget"])
        self.assertEqual(recorded["tie_break_seed"], requested["tie_break_seed"])
        self.assertEqual(requested["evaluation_budget"]["effective_max_input_tokens"], 61440)
        self.assertFalse(requested["evaluation_matches_recorded_runtime_budget"])
        self.assertEqual(recorded, budget.CONFIG)
        for field, value in (("effective_max_input_tokens", 65536), ("max_output_tokens", 8192.0),
                             ("max_context_tokens", 73728)):
            forged = copy.deepcopy(requested)
            forged["evaluation_budget"][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "config"):
                budget.validate_config(forged)

    def test_invalid_lengths_and_boolean_integer_values_fail_closed(self):
        for changes in ({"sequence_length": 3099}, {"target_length": 0, "sequence_length": 3000},
                        {"prefix_length": True, "target_length": 100, "sequence_length": 101},
                        {"sequence_length": 3100.0}, {"target_length": None}):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "arithmetic"):
                budget.budget_decision({**metadata(), **changes}, "runtime_budget")

    def test_original_holds_medical_context_and_tokenizer_holds_survive(self):
        for profile in budget.PROFILES:
            self.assertFalse(metadata(reasons=[admission.TARGET_REASON])["profiles"][profile]["eligible"])
            self.assertFalse(metadata(flags=["prior_assistant_medical_pattern"])["profiles"][profile]["eligible"])
            self.assertTrue(metadata(flags=["prior_assistant_procedural_pattern"])["profiles"][profile]["eligible"])
            row = {**metadata(), "tokenizer_status": "held", **dict.fromkeys(token.LENGTHS, None)}
            self.assertEqual(budget.budget_decision(row, profile)["hold_reasons"], ["tokenizer_held"])

    def test_fixed_policy_rejects_changed_budget_caps_and_authorization(self):
        for key, value in (("training_authorized", 0), ("maximum_rows_per_conversation_quarter", True),
                           ("maximum_rows_per_source_group", 17), ("reserved_output_tokens", 4095),
                           ("quarter_order", list(base.QUARTERS))):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "config"):
                budget.validate_config({**budget.CONFIG, key: value})

    def test_recorded_evidence_is_typed_and_policy_specific(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "runtime.json"
            source.dump_json(path, {"live": {"health": budget.RECORDED_BUDGET}})
            self.assertEqual(budget.read_runtime_budget(path)["sha256"], source.sha_file(path))
            for key, value in (("max_input_tokens", 65536.0), ("max_output_tokens", True), ("max_output_tokens", 8192),
                               ("max_context_tokens", 65536), ("policy_id", "other")):
                source.dump_json(path, {"live": {"health": {**budget.RECORDED_BUDGET, key: value}}})
                with self.subTest(key=key), self.assertRaisesRegex(ValueError, "recorded runtime budget"):
                    budget.read_runtime_budget(path)


class SelectionTests(unittest.TestCase):
    def test_order_invariant_all_splits_groups_quarters_and_caps(self):
        rows = [metadata(f"{split}_{g}_{c}_{q}_{duplicate}", group=f"{split}_{g}", conv=f"{split}_{g}_{c}",
                         quarter=q, split=split) for split in source.SPLITS for g in range(3)
                for c in range(6) for q in base.QUARTERS for duplicate in range(2)]
        for profile in budget.PROFILES:
            selected = budget.select_rows(rows, profile)
            with self.subTest(profile=profile):
                self.assertEqual(selected, budget.select_rows(list(reversed(rows)), profile))
                kept = [row for row in rows if row["id"] in selected]
                self.assertEqual(len(kept), 6 * 16)
                self.assertEqual(len({(row["source_conversation_id"], row["position_band"]) for row in kept}), len(kept))
                self.assertTrue(budget.coverage(rows, kept)["all_eligible_group_quarters_covered"])
                for group in {row["source_group_id"] for row in rows}:
                    subset = [row for row in kept if row["source_group_id"] == group]
                    self.assertEqual(len(subset), 16)
                    self.assertEqual(len({row["source_conversation_id"] for row in subset}), 6)

    def test_short_pool_is_filtered_before_selection_and_retains_rare_q4(self):
        identities = [f"synthetic_{index}" for index in range(17)]
        rare = max(identities, key=lambda rid: (source.sha_text(budget.CONFIG["tie_break_seed"] + "|" + rid), rid))
        rows = [metadata(rid, quarter=base.QUARTERS[-1], prefix=3680 if rid == rare else 5000, target=77)
                for rid in identities]
        runtime = budget.select_rows(rows, "runtime_budget")
        strict = budget.select_rows(rows, "strict_4096")
        self.assertNotIn(rare, runtime)
        self.assertEqual(strict, {rare})
        self.assertNotEqual(strict, {row["id"] for row in rows if row["id"] in runtime and row["sequence_length"] <= 4096})

    def test_strict_reserves_all_50_late_cells_without_duplicate_rows(self):
        rows = [metadata(f"g{g}_c{c}_{q}_{duplicate}", group=f"g{g}", conv=f"g{g}_c{c}", quarter=q)
                for g in range(5) for c in range(5) for q in base.QUARTERS for duplicate in range(2)]
        selected = budget.select_rows(rows, "strict_4096")
        kept = [row for row in rows if row["id"] in selected]
        covered = budget.coverage(rows, kept)
        self.assertEqual(covered["eligible_late_conversation_quarters"], 50)
        self.assertEqual(covered["selected_late_rows"], 50)
        self.assertTrue(covered["all_eligible_late_conversation_quarters_covered"])
        self.assertEqual(len(kept), 5 * 16)

    def test_strict_future_impossible_late_quota_fails_instead_of_dropping(self):
        rows = [metadata(f"late_{index}", quarter=base.QUARTERS[-1]) for index in range(15)]
        rows += [metadata("early_1", quarter=base.QUARTERS[0]), metadata("early_2", quarter=base.QUARTERS[1])]
        with self.assertRaisesRegex(ValueError, "policy review required"):
            budget.select_rows(rows, "strict_4096")
        self.assertEqual(len(budget.select_rows(rows[1:], "strict_4096")), 16)
        self.assertEqual(len(budget.select_rows(rows, "runtime_budget")), 16)

    def test_no_synthetic_empty_cells_and_held_origins_are_validated(self):
        rows = [metadata("one", conv="shared"), metadata("duplicate", conv="shared"),
                metadata("held", reasons=[admission.TARGET_REASON], quarter=base.QUARTERS[-1]),
                metadata("validation", split="validation", group="validation")]
        for profile in budget.PROFILES:
            selected = budget.select_rows(rows, profile)
            self.assertEqual(len(selected), 2)
            self.assertNotIn("held", selected)
            for bad in (metadata("other", split="validation", reasons=["held"]), metadata("one", reasons=["held"]),
                        metadata("other", group="other", conv="one", reasons=["held"])):
                with self.assertRaises(ValueError):
                    budget.select_rows([metadata("one"), bad], profile)

    def test_output_scenarios_keep_membership_when_the_same_rows_fit(self):
        ids = [f"synthetic_{index}" for index in range(20)]
        for profile in budget.PROFILES:
            selected = []
            for output in budget.OUTPUT_BUDGETS:
                rows = [metadata(rid, quarter=base.QUARTERS[index % 4], output_budget=output) for index, rid in enumerate(ids)]
                selected.append(budget.select_rows(rows, profile, budget.make_config(output)))
            self.assertEqual(selected[0], selected[1])


class ExportTests(unittest.TestCase):
    def setUp(self):
        fixture = self.fixture = source_fixtures.ExportTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.root = fixture.fixture.root
        evidence = self.root / "runtime_budget_evidence.json"
        source.dump_json(evidence, {"live": {"health": budget.RECORDED_BUDGET}})
        self.inputs = {**fixture.inputs, "runtime_budget_evidence": evidence}
        self.output = self.root / "budget_composition"
        self.when = fixture.when

    def build(self, output=None):
        return budget.build(output=output or self.output, occurred_at=self.when, **self.inputs)

    def rehash(self, name):
        path = self.output / name
        manifest = source.read_json(self.output / "export_manifest.json")
        manifest["files"][name].update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        source.dump_json(self.output / "export_manifest.json", manifest)

    def test_original_bytes_full_prefix_masks_splits_holds_and_input_hashes_preserved(self):
        before = {path: source.sha_file(path) for path in self.root.rglob("*") if path.is_file()}
        summary = self.build()
        self.assertEqual(summary["profiles"]["runtime_budget"]["selected"]["all"]["rows"], 3)
        self.assertEqual(summary["profiles"]["strict_4096"]["selected"]["all"]["rows"], 2)
        self.assertEqual(summary["source_rows_examined"], 5)
        self.assertEqual(summary["selected_profile_overlap"]["all"]["shared_rows"], 2)
        ledger = {row["id"]: row for row in source.read_rows(self.output / "selection_ledger.jsonl.gz")}
        for profile in budget.PROFILES:
            self.assertFalse(ledger["synthetic_older_validation"]["profiles"][profile]["chosen"])
            self.assertIn("medical_context_requires_review", ledger["synthetic_older_validation"]["profiles"][profile]["hold_reasons"])
            self.assertFalse(ledger["synthetic_held_validation"]["profiles"][profile]["chosen"])
            self.assertIn(admission.TARGET_REASON, ledger["synthetic_held_validation"]["profiles"][profile]["hold_reasons"])
            self.assertTrue(ledger["synthetic_other_validation"]["profiles"][profile]["chosen"])
            for split in source.SPLITS:
                originals = {json.loads(line)["id"]: line for line in gzip.decompress(
                    (self.inputs["release"] / f"conversation/{split}.jsonl.gz").read_bytes()).splitlines(keepends=True)}
                for line in gzip.decompress((self.output / f"{profile}/{split}.jsonl.gz").read_bytes()).splitlines(keepends=True):
                    row = json.loads(line)
                    self.assertEqual(line, originals[row["id"]])
                    self.assertEqual(row["loss_message_mask"], [0] * (len(row["messages"]) - 1) + [1])
                    self.assertNotIn("human_approved", row)
        self.assertIn("prior_assistant_procedural_pattern", ledger["synthetic_other_validation"]["context_flags"])
        self.assertTrue(ledger["synthetic_other_validation"]["review_required"])
        self.assertEqual(before, {path: source.sha_file(path) for path in before})
        lengths = summary["profiles"]["runtime_budget"]["token_lengths"]["selected"]["all"]
        self.assertEqual(lengths["sequence_length"]["max"], 9000)
        self.assertEqual(lengths["prefix_plus_reserved_output"]["max"], 8900 + 4096)

    def test_reproducible_nested_artifacts_and_no_overwrite(self):
        self.build()
        other = self.root / "second_budget"
        self.build(other)
        def inventory(root):
            return {path.relative_to(root).as_posix(): source.sha_file(path) for path in root.rglob("*") if path.is_file()}
        self.assertEqual(inventory(self.output), inventory(other))
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.build()
        empty = self.root / "existing_empty"
        empty.mkdir()
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.build(empty)
        self.assertTrue(empty.is_dir())

    def test_history_pointers_resolve_and_manifest_flags_are_unapproved(self):
        self.build()
        plan = budget.prepare(**self.inputs)
        manifest = budget.verify_artifacts(self.output, plan)
        for key in budget.FALSE_FLAGS:
            self.assertIs(manifest[key], False)
        for key in budget.TRUE_FLAGS:
            self.assertIs(manifest[key], True)
        for event in history._json_rows(self.output / "evaluation_history_events.jsonl"):
            self.assertEqual(source.sha_file(self.output / event["evidence"]["path"]), event["evidence"]["sha256"])
            self.assertEqual({key: history._pointer(plan["summary"], pointer) for key, pointer in
                              event["evidence"]["input_pointers"].items()}, event["input_sha256"])
            self.assertEqual(event["purpose"], "data_selection")

    def test_output_8192_export_separates_recorded_budget_and_requested_evaluation(self):
        inputs = {**self.inputs, "output_budget": 8192}
        summary = budget.build(output=self.output, occurred_at=self.when, **inputs)
        plan = budget.prepare(**inputs)
        manifest = budget.verify_artifacts(self.output, plan)
        for document in (summary, manifest):
            self.assertEqual(document["recorded_runtime_budget"]["max_output_tokens"], 4096)
            self.assertEqual(document["runtime_budget_evidence"]["max_output_tokens"], 4096)
            self.assertEqual(document["evaluation_budget"]["max_output_tokens"], 8192)
            self.assertEqual(document["evaluation_budget"]["effective_max_input_tokens"], 61440)
            self.assertEqual(document["reserved_output_tokens"], 8192)
            self.assertFalse(document["evaluation_matches_recorded_runtime_budget"])
            self.assertFalse(document["runtime_configuration_changed"])
            self.assertFalse(document["current_runtime_configuration_verified"])
        self.assertEqual(summary["profiles"]["runtime_budget"]["token_lengths"]["selected"]["all"]
                         ["prefix_plus_reserved_output"]["max"], 8900 + 8192)
        with self.assertRaisesRegex(ValueError, "metadata binding"):
            budget.verify_artifacts(self.output, budget.prepare(**self.inputs))

    def test_conflicting_explicit_output_and_config_fail_before_source_work(self):
        for value in (True, "8192", 8193):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "output budget"):
                budget.prepare(**self.inputs, output_budget=value)
        with self.assertRaisesRegex(ValueError, "disagrees"):
            budget.prepare(**self.inputs, config=budget.make_config(8192))

    def test_rehashed_scenario_config_and_manifest_cannot_forge_requested_budget(self):
        inputs = {**self.inputs, "output_budget": 8192}
        budget.build(output=self.output, occurred_at=self.when, **inputs)
        plan = budget.prepare(**inputs)
        original = source.read_json(self.output / "export_manifest.json")
        for field, value in (("evaluation_matches_recorded_runtime_budget", 0), ("reserved_output_tokens", 8192.0)):
            source.dump_json(self.output / "export_manifest.json", {**original, field: value})
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "metadata binding"):
                budget.verify_artifacts(self.output, plan)
        source.dump_json(self.output / "export_manifest.json", original)
        path = self.output / "composition_config.json"
        forged = source.read_json(path)
        forged["evaluation_budget"]["effective_max_input_tokens"] = 65536
        source.dump_json(path, forged)
        self.rehash(path.name)
        with self.assertRaisesRegex(ValueError, "config or summary"):
            budget.verify_artifacts(self.output, plan)

    def test_manifest_flags_reject_boolean_integer_and_authorization_forgery(self):
        self.build()
        plan = budget.prepare(**self.inputs)
        original = source.read_json(self.output / "export_manifest.json")
        for key in (*budget.FALSE_FLAGS, *budget.TRUE_FLAGS):
            for value in (not original[key], int(original[key])):
                source.dump_json(self.output / "export_manifest.json", {**original, key: value})
                with self.subTest(key=key, value=value), self.assertRaisesRegex(ValueError, "authorization"):
                    budget.verify_artifacts(self.output, plan)

    def test_rehashed_ledger_profiles_and_typed_values_are_recomputed(self):
        self.build()
        plan = budget.prepare(**self.inputs)
        path = self.output / "selection_ledger.jsonl.gz"
        original = list(source.read_rows(path))
        for field, value in (("chosen", 1), ("eligible", 1), ("hold_reasons", []), ("selection_reason", "approved")):
            rows = copy.deepcopy(original)
            row = next(row for row in rows if row["id"] == "synthetic_held_validation")
            row["profiles"]["runtime_budget"][field] = value
            path.unlink()
            base.write_gzip(path, (base.encoded(row) for row in rows))
            self.rehash(path.name)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "recomputed decisions"):
                budget.verify_artifacts(self.output, plan)

    def test_rehashed_config_and_summary_cannot_change_types(self):
        self.build()
        plan = budget.prepare(**self.inputs)
        for name in ("composition_config.json", "summary.json"):
            path = self.output / name
            original = path.read_bytes()
            document = json.loads(original)
            document["training_authorized"] = 0
            source.dump_json(path, document)
            self.rehash(name)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "config or summary"):
                budget.verify_artifacts(self.output, plan)
            path.write_bytes(original)
            self.rehash(name)

    def test_runtime_evidence_and_both_implementations_are_hash_bound(self):
        self.build()
        plan = budget.prepare(**self.inputs)
        for module in (base, budget):
            self.assertIn(Path(module.__file__), plan["tracked"])
        evidence = self.inputs["runtime_budget_evidence"]
        self.assertIn(evidence, plan["tracked"])
        document = source.read_json(evidence)
        document["unrelated_metadata"] = "synthetic modification"
        source.dump_json(evidence, document)
        with self.assertRaisesRegex(ValueError, "inputs changed"):
            budget.verify_artifacts(self.output, plan)
        with self.assertRaisesRegex(ValueError, "metadata binding"):
            budget.verify_artifacts(self.output, budget.prepare(**self.inputs))

    def test_nested_inventory_rejects_traversal_unexpected_files_and_directory_symlink(self):
        self.build()
        plan = budget.prepare(**self.inputs)
        original = source.read_json(self.output / "export_manifest.json")
        forged = copy.deepcopy(original)
        forged["files"]["../outside.json"] = forged["files"]["summary.json"]
        source.dump_json(self.output / "export_manifest.json", forged)
        with self.assertRaisesRegex(ValueError, "file inventory"):
            budget.verify_artifacts(self.output, plan)
        source.dump_json(self.output / "export_manifest.json", original)
        extra = self.output / "runtime_budget/extra.json"
        extra.write_text("{}")
        with self.assertRaisesRegex(ValueError, "nested file inventory"):
            budget.verify_artifacts(self.output, plan)
        extra.unlink()
        real_directory = self.root / "moved_runtime"
        (self.output / "runtime_budget").rename(real_directory)
        (self.output / "runtime_budget").symlink_to(real_directory, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "nested file inventory"):
            budget.verify_artifacts(self.output, plan)

    def test_rehashed_export_cannot_change_prefix_future_messages_or_loss_mask(self):
        self.build()
        plan = budget.prepare(**self.inputs)
        name = "strict_4096/train.jsonl.gz"
        path = self.output / name
        original = list(source.read_rows(path))
        for attack in ("prefix", "future", "mask"):
            rows = copy.deepcopy(original)
            if attack == "prefix":
                rows[0]["messages"][1]["content"] = "Synthetic replacement"
            elif attack == "future":
                rows[0]["messages"].extend([{"role": "user", "content": "Synthetic future user"},
                                           {"role": "assistant", "content": "Synthetic future target"}])
            else:
                rows[0]["loss_message_mask"][0] = 1
            path.unlink()
            base.write_gzip(path, (base.encoded(row) for row in rows))
            self.rehash(name)
            with self.subTest(attack=attack), self.assertRaisesRegex(ValueError, "original bytes"):
                budget.verify_artifacts(self.output, plan)

    def test_manifest_export_counts_and_uncompressed_hash_are_checked(self):
        self.build()
        plan = budget.prepare(**self.inputs)
        original = source.read_json(self.output / "export_manifest.json")
        for key, value, message in (("rows", True, "count mismatch"), ("uncompressed_sha256", "0" * 64, "uncompressed hash")):
            manifest = copy.deepcopy(original)
            manifest["files"]["runtime_budget/train.jsonl.gz"][key] = value
            source.dump_json(self.output / "export_manifest.json", manifest)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, message):
                budget.verify_artifacts(self.output, plan)

    def test_original_and_frozen_tampering_fail_before_publication(self):
        for path in (self.inputs["release"] / "conversation/train.jsonl.gz", self.inputs["frozen"] / "conversation/train.jsonl"):
            original = path.read_bytes()
            path.write_bytes(original + b"\n")
            with self.subTest(path=path.name), self.assertRaises(ValueError):
                self.build()
            self.assertFalse(self.output.exists())
            path.write_bytes(original)

    def test_synchronized_source_hold_removal_is_replayed(self):
        fixture = self.fixture.fixture
        for row in fixture.rows:
            if row["id"] == "synthetic_held_validation":
                row.update(admitted=True, status="admitted", reasons=[])
        for row in fixture.tokens:
            if row["id"] == "synthetic_held_validation":
                row.update(source_admitted=True, source_status="admitted", source_reasons=[], admitted=True, status="admitted", reasons=[])
        fixture.forge_matching_downstream_metadata(remove_hold=True)
        token.validate_and_summarize(fixture.release, fixture.admission_policy_path, fixture.source_path,
                                     fixture.tokenizer_audit_path, fixture.lengths_path)
        with self.assertRaisesRegex(ValueError, "recomputed rules"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_future_source_position_fails_before_selection(self):
        plan = budget.prepare(**self.inputs)
        original = self.fixture.fixture.payloads[0]
        manifest = source.read_json(self.inputs["release"] / "manifest.json")
        frozen = base.load_frozen_metadata(self.inputs["frozen"], manifest, {})[original["source_conversation_id"]]
        joined = next(row for row in plan["rows"] if row["id"] == original["id"])
        forged = {**original, "target_end_ordinal": frozen["source_turn_count"]}
        with self.assertRaisesRegex(ValueError, "source target position"):
            base.row_metadata(forged, base.encoded(forged), joined, frozen, base.CONFIG)

    def test_atomic_publication_failure_removes_only_owned_empty_placeholder(self):
        with patch.object(budget.os, "replace", side_effect=OSError("synthetic publication failure")):
            with self.assertRaisesRegex(OSError, "publication failure"):
                self.build()
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob(".budget-composition-stage-*")))


if __name__ == "__main__":
    unittest.main()
