"""Synthetic additive composition and immutable-baseline regression checks."""
import copy
import gzip
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from counseling_pipeline import source_balanced_composition as balanced
from counseling_pipeline import source_budget_composition as budget, source_composition as base
from counseling_pipeline import source_sft as source, token_admission as token, source_admission as admission, evaluation_history as history
import test_source_budget_composition as budget_fixtures


def choice(identity, *, baseline=False, **kwargs):
    row = budget_fixtures.metadata(identity, output_budget=8192, **kwargs)
    row["profiles"]["runtime_budget"]["chosen"] = baseline
    return row


class SelectionTests(unittest.TestCase):
    def test_preserves_baseline_and_adds_all_missing_late_cells_order_independently(self):
        rows = [choice("baseline_early", baseline=True, conv="shared"),
                choice("baseline_late", baseline=True, conv="shared", quarter=base.QUARTERS[2]),
                choice("different_row_same_late_cell", conv="shared", quarter=base.QUARTERS[2]),
                choice("new_q4_a", conv="shared", quarter=base.QUARTERS[3]),
                choice("new_q4_b", conv="shared", quarter=base.QUARTERS[3]),
                choice("unselected_early"),
                choice("validation_late", split="validation", group="validation", quarter=base.QUARTERS[2])]
        old, added = balanced.select_rows(rows)
        self.assertEqual((old, added), balanced.select_rows(list(reversed(rows))))
        self.assertEqual(old, {"baseline_early", "baseline_late"})
        self.assertEqual(len(added), 2)
        self.assertNotIn("different_row_same_late_cell", added)
        self.assertNotIn("unselected_early", added)
        kept = [row for row in rows if row["id"] in old | added]
        self.assertEqual(len({balanced.cell(row) for row in kept}), len(kept))

    def test_hash_representative_does_not_optimize_shortest_length(self):
        ids = ["synthetic_a", "synthetic_b"]
        expected = min(ids, key=lambda rid: (source.sha_text(balanced.CONFIG["tie_break_seed"] + "|" + rid), rid))
        rows = [choice(rid, conv="one", quarter=base.QUARTERS[3], prefix=12000 if rid == expected else 4000)
                for rid in ids]
        self.assertEqual(balanced.select_rows(rows), (set(), {expected}))
        self.assertGreater(next(row["sequence_length"] for row in rows if row["id"] == expected), 4096)

    def test_group_growth_above16_is_explicit_and_does_not_remove_early_rows(self):
        rows = [choice(f"old_{i}", baseline=True) for i in range(16)]
        rows += [choice(f"late_{i}", conv=f"old_{i}", quarter=base.QUARTERS[2]) for i in range(9)]
        old, added = balanced.select_rows(rows)
        self.assertEqual((len(old), len(added), len(old | added)), (16, 9, 25))
        self.assertIs(balanced.CONFIG["final_fixed_group_cap_is_16"], False)
        with self.assertRaisesRegex(ValueError, "baseline group cap"):
            balanced.select_rows(rows + [choice("invalid_baseline_17", baseline=True)])

    def test_holds_budget_edges_and_medical_context_are_not_released(self):
        rows = [choice("valid_edge", prefix=61440, target=8192, quarter=base.QUARTERS[2]),
                choice("context_over", prefix=61441, target=1, quarter=base.QUARTERS[2]),
                choice("target_over", prefix=100, target=8193, quarter=base.QUARTERS[2]),
                choice("prior_hold", reasons=[admission.TARGET_REASON], quarter=base.QUARTERS[2]),
                choice("medical_hold", flags=["prior_assistant_medical_pattern"], quarter=base.QUARTERS[2]),
                choice("procedural_review", flags=["prior_assistant_procedural_pattern"], quarter=base.QUARTERS[2])]
        self.assertEqual(balanced.select_rows(rows)[1], {"valid_edge", "procedural_review"})
        forged = copy.deepcopy(rows[1])
        forged["profiles"]["runtime_budget"].update(eligible=True, hold_reasons=[])
        with self.assertRaisesRegex(ValueError, "eligibility"):
            balanced.select_rows([forged])

    def test_all_identity_and_typed_contract_checks_include_held_rows(self):
        for bad in (choice("a"), choice("b", split="validation", reasons=["held"]),
                    choice("b", group="other", conv="a", reasons=["held"])):
            with self.assertRaises(ValueError):
                balanced.select_rows([choice("a", baseline=True), bad])
        for field, value in (("chosen", 1), ("eligible", 1)):
            row = choice("typed")
            row["profiles"]["runtime_budget"][field] = value
            with self.assertRaisesRegex(ValueError, "eligibility"):
                balanced.select_rows([row])
        duplicate_cell = [choice("one", baseline=True, conv="same"), choice("two", baseline=True, conv="same")]
        with self.assertRaisesRegex(ValueError, "baseline cell"):
            balanced.select_rows(duplicate_cell)

    def test_unversioned_configuration_cannot_hide_group_growth_or_approval(self):
        for key, value in (("training_authorized", 0), ("final_fixed_group_cap_is_16", True),
                           ("maximum_rows_per_conversation_quarter", True), ("representative_order", ["sequence_length", "id"])):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "config"):
                balanced.validate_config({**balanced.CONFIG, key: value})


class ExportTests(unittest.TestCase):
    def setUp(self):
        fixture = self.fixture = budget_fixtures.ExportTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        self.root = fixture.root
        self.baseline = self.root / "baseline_8192"
        budget.build(output=self.baseline, occurred_at=fixture.when, output_budget=8192, **fixture.inputs)
        self.inputs = {**fixture.inputs, "baseline": self.baseline}
        self.output = self.root / "balanced"
        self.when = fixture.when

    def build(self, output=None):
        return balanced.build(output=output or self.output, occurred_at=self.when, **self.inputs)

    def rehash(self, name):
        path = self.output / name
        manifest = source.read_json(self.output / "export_manifest.json")
        manifest["files"][name].update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        source.dump_json(self.output / "export_manifest.json", manifest)

    def test_original_bytes_prefix_masks_and_every_baseline_row_are_preserved(self):
        before = {path: source.sha_file(path) for path in self.root.rglob("*") if path.is_file()}
        summary = self.build()
        self.assertEqual(summary["baseline_rows_removed"], 0)
        self.assertEqual(summary["baseline_files_bound"], 9)
        self.assertEqual(summary["tables"]["augmented"]["all"]["rows"], 3)
        for split in source.SPLITS:
            original = {json.loads(line)["id"]: line for line in gzip.decompress(
                (self.inputs["release"] / f"conversation/{split}.jsonl.gz").read_bytes()).splitlines(keepends=True)}
            baseline_ids = {row["id"] for row in source.read_rows(self.baseline / f"runtime_budget/{split}.jsonl.gz")}
            exported = gzip.decompress((self.output / f"{split}.jsonl.gz").read_bytes()).splitlines(keepends=True)
            self.assertTrue(baseline_ids <= {json.loads(line)["id"] for line in exported})
            for line in exported:
                row = json.loads(line)
                self.assertEqual(line, original[row["id"]])
                self.assertEqual(row["loss_message_mask"], [0] * (len(row["messages"])-1) + [1])
                self.assertNotIn("human_approved", row)
        self.assertEqual(before, {path: source.sha_file(path) for path in before})

    def test_panel_is_exact_overlapping_validation_subset_and_strict_is_reference_only(self):
        summary = self.build()
        plan = balanced.prepare(**self.inputs)
        balanced.verify_artifacts(self.output, plan)
        panel = list(source.read_rows(self.output / "validation_late_audit.jsonl.gz"))
        main = {row["id"]: row for row in source.read_rows(self.output / "validation.jsonl.gz")}
        expected = {row["id"] for row in plan["rows"] if row["chosen"] and row["split"] == "validation"
                    and row["position_band"] in balanced.LATE_QUARTERS}
        self.assertEqual({row["id"] for row in panel}, expected)
        self.assertTrue(all(row["split"] == "validation" and row == main[row["id"]] for row in panel))
        self.assertEqual(summary["validation_late_audit_overlap"]["additional_unique_rows"], 0)
        self.assertFalse(summary["validation_late_audit_overlap"]["independent"])
        self.assertFalse(any("strict_4096" in path.name for path in self.output.iterdir()))
        self.assertEqual(summary["strict_4096_baseline_reference"]["selected"]["all"]["rows"], 2)
        self.assertFalse(summary["strict_4096_changed"])

    def test_baseline_and_new_implementation_hashes_are_all_bound(self):
        self.build()
        plan = balanced.prepare(**self.inputs)
        expected_files = {path for path in self.baseline.rglob("*") if path.is_file()}
        self.assertEqual(len(expected_files), 9)
        self.assertTrue(expected_files <= plan["tracked"].keys())
        self.assertIn(Path(budget.__file__), plan["tracked"])
        self.assertIn(Path(balanced.__file__), plan["tracked"])
        path = self.baseline / "strict_4096/train.jsonl.gz"
        path.write_bytes(path.read_bytes() + b"\n")
        with self.assertRaisesRegex(ValueError, "inputs changed"):
            balanced.verify_artifacts(self.output, plan)
        with self.assertRaises(ValueError):
            balanced.prepare(**self.inputs)

    def test_baseline_manifest_swap_after_verification_fails_hash_binding(self):
        verify = budget.verify_artifacts
        def swapped(path, plan):
            manifest = verify(path, plan)
            changed = {**manifest, "synthetic_concurrent_change": True}
            source.dump_json(Path(path) / "export_manifest.json", changed)
            return manifest
        with patch.object(budget, "verify_artifacts", side_effect=swapped):
            with self.assertRaisesRegex(ValueError, "inputs changed during preparation"):
                self.build()
        self.assertFalse(self.output.exists())

    def test_target_token_mass_is_separate_from_row_count(self):
        summary = self.build()
        plan = balanced.prepare(**self.inputs)
        selected = [row for row in plan["rows"] if row["chosen"]]
        for split in (*source.SPLITS, "all"):
            rows = [row for row in selected if split=="all" or row["split"]==split]
            late = [row for row in rows if row["position_band"] in balanced.LATE_QUARTERS]
            stats = summary["tables"]["augmented"][split]
            total = sum(row["target_length"] for row in rows)
            late_total = sum(row["target_length"] for row in late)
            self.assertEqual(stats["target_token_sum"], total)
            self.assertEqual(stats["late_target_token_sum"], late_total)
            self.assertEqual(stats["late_target_token_percent"], 100*late_total/total if total else None)
            self.assertEqual(stats["token_lengths_by_half"]["late"]["target_length"]["sum"], late_total)

    def test_rehashed_baseline_selection_forgery_is_verified_against_original_plan(self):
        path = self.baseline / "selection_ledger.jsonl.gz"
        rows = list(source.read_rows(path))
        rows[0]["profiles"]["runtime_budget"]["chosen"] = not rows[0]["profiles"]["runtime_budget"]["chosen"]
        path.unlink()
        base.write_gzip(path, (base.encoded(row) for row in rows))
        manifest = source.read_json(self.baseline / "export_manifest.json")
        manifest["files"][path.name].update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        source.dump_json(self.baseline / "export_manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "recomputed decisions"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_only_fixed_output8192_is_accepted(self):
        for value in (4096, 16384, True, "8192", 8192.0):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "requires output budget"):
                balanced.prepare(**self.inputs, output_budget=value)

    def test_rehashed_ledger_flags_and_decisions_are_typed_and_recomputed(self):
        self.build()
        plan = balanced.prepare(**self.inputs)
        path = self.output / "selection_ledger.jsonl.gz"
        original = list(source.read_rows(path))
        for field, value in (("chosen", 1), ("baseline_chosen", 1), ("added_late_representative", True), ("selection_reason", "approved")):
            rows = copy.deepcopy(original)
            rows[0][field] = value
            path.unlink()
            base.write_gzip(path, (base.encoded(row) for row in rows))
            self.rehash(path.name)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "recomputed decisions"):
                balanced.verify_artifacts(self.output, plan)

    def test_rehashed_config_summary_and_manifest_contract_forgery_fail(self):
        self.build()
        plan = balanced.prepare(**self.inputs)
        original_manifest = source.read_json(self.output / "export_manifest.json")
        for key in (*balanced.FALSE_FLAGS, *balanced.TRUE_FLAGS):
            source.dump_json(self.output / "export_manifest.json", {**original_manifest, key: int(original_manifest[key])})
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "authorization"):
                balanced.verify_artifacts(self.output, plan)
        source.dump_json(self.output / "export_manifest.json", original_manifest)
        for name in ("composition_config.json", "summary.json"):
            path = self.output / name
            original = path.read_bytes()
            document = json.loads(original)
            document["training_authorized"] = 0
            source.dump_json(path, document)
            self.rehash(name)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "config or summary"):
                balanced.verify_artifacts(self.output, plan)
            path.write_bytes(original)
            self.rehash(name)

    def test_rehashed_export_and_panel_cannot_change_original_bytes_or_membership(self):
        self.build()
        plan = balanced.prepare(**self.inputs)
        for name in ("train.jsonl.gz", "validation_late_audit.jsonl.gz"):
            path = self.output / name
            original = path.read_bytes()
            rows = list(source.read_rows(path))
            rows[0]["messages"][1]["content"] = "Synthetic altered prefix"
            path.unlink()
            base.write_gzip(path, (base.encoded(row) for row in rows))
            self.rehash(name)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "original bytes"):
                balanced.verify_artifacts(self.output, plan)
            path.write_bytes(original)
            self.rehash(name)
        panel = self.output / "validation_late_audit.jsonl.gz"
        panel.write_bytes((self.output / "validation.jsonl.gz").read_bytes())
        self.rehash(panel.name)
        with self.assertRaisesRegex(ValueError, "original bytes"):
            balanced.verify_artifacts(self.output, plan)

    def test_inventory_symlinks_digest_counts_and_evidence_pointers(self):
        self.build()
        plan = balanced.prepare(**self.inputs)
        original = source.read_json(self.output / "export_manifest.json")
        for event in history._json_rows(self.output / "evaluation_history_events.jsonl"):
            self.assertEqual(event["evidence"]["sha256"], source.sha_file(self.output / "summary.json"))
            self.assertEqual({key: history._pointer(plan["summary"], pointer) for key, pointer in event["evidence"]["input_pointers"].items()},
                             event["input_sha256"])
        for field, value, message in (("rows", True, "count mismatch"), ("uncompressed_sha256", "0"*64, "uncompressed hash")):
            document = copy.deepcopy(original)
            document["files"]["train.jsonl.gz"][field] = value
            source.dump_json(self.output / "export_manifest.json", document)
            with self.assertRaisesRegex(ValueError, message):
                balanced.verify_artifacts(self.output, plan)
        source.dump_json(self.output / "export_manifest.json", original)
        extra = self.output / "unexpected"
        extra.mkdir()
        with self.assertRaisesRegex(ValueError, "inventory"):
            balanced.verify_artifacts(self.output, plan)
        extra.rmdir()
        path = self.output / "summary.json"
        other = self.root / "relocated_summary.json"
        path.rename(other)
        path.symlink_to(other)
        with self.assertRaisesRegex(ValueError, "hash or size"):
            balanced.verify_artifacts(self.output, plan)

    def test_reproducible_artifacts_and_no_overwrite_or_partial_publication(self):
        self.build()
        other = self.root / "second"
        self.build(other)
        self.assertEqual({path.name:source.sha_file(path) for path in self.output.iterdir()},
                         {path.name:source.sha_file(path) for path in other.iterdir()})
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.build()
        failed = self.root / "failed_output"
        with patch.object(balanced.os, "replace", side_effect=OSError("synthetic publication failure")):
            with self.assertRaisesRegex(OSError, "publication failure"):
                self.build(failed)
        self.assertFalse(failed.exists())
        self.assertFalse(list(self.root.glob(".balanced-composition-stage-*")))


if __name__ == "__main__":
    unittest.main()
