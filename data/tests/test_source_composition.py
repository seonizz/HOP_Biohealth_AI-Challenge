"""Synthetic composition attacks; never uses private counseling fixtures."""
import copy
import gzip
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from counseling_pipeline import source_composition as composition
from counseling_pipeline import source_sft as source, source_admission as admission
from counseling_pipeline import token_admission as token, evaluation_history as history
import test_evaluation_history as history_fixtures


def choice(identity, *, group="group", conv=None, quarter=None, split="train", eligible=True):
    return {"id": identity, "split": split, "source_group_id": group,
            "source_conversation_id": conv or identity, "position_band": quarter or composition.QUARTERS[0],
            "eligible": eligible}


class SelectionTests(unittest.TestCase):
    def test_order_invariant_caps_and_all_observed_group_quarters(self):
        rows = [choice(f"{split}_{g}_{c}_{q}_{duplicate}", group=f"{split}_{g}", conv=f"{split}_{g}_{c}",
                quarter=q, split=split) for split in source.SPLITS for g in range(3)
                for c in range(8) for q in composition.QUARTERS for duplicate in range(2)]
        selected = composition.select_rows(rows)
        self.assertEqual(selected, composition.select_rows(list(reversed(rows))))
        kept = [r for r in rows if r["id"] in selected]
        self.assertEqual(len(kept), 6 * 16)
        self.assertEqual(len({(r["source_conversation_id"], r["position_band"]) for r in kept}), len(kept))
        self.assertEqual({(r["source_group_id"], r["position_band"]) for r in kept},
                         {(r["source_group_id"], r["position_band"]) for r in rows})
        for group in {r["source_group_id"] for r in rows}:
            subset = [r for r in kept if r["source_group_id"] == group]
            self.assertEqual(len(subset), 16)
            self.assertEqual(len({r["source_conversation_id"] for r in subset}), 8)

    def test_no_empty_cells_oversampling_or_held_selection(self):
        rows = [choice("one", conv="shared"), choice("duplicate_cell", conv="shared"),
                choice("held", eligible=False, quarter=composition.QUARTERS[-1]),
                choice("validation", split="validation", group="validation_group")]
        selected = composition.select_rows(rows)
        self.assertEqual(len(selected), 2)
        self.assertNotIn("held", selected)
        self.assertIn("validation", selected)

    def test_identity_checks_include_held_rows(self):
        for bad in (choice("other", split="validation", eligible=False), choice("one", eligible=False),
                    choice("other", group="other", conv="one", eligible=False)):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                composition.select_rows([choice("one"), bad])

    def test_unversioned_configuration_and_boolean_limits_rejected(self):
        for key, value in (("maximum_rows_per_source_group", 17), ("maximum_rows_per_conversation_quarter", True),
                           ("training_authorized", True), ("medical_context_policy", "retain")):
            config = {**composition.CONFIG, key: value}
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "config"):
                composition.select_rows([], config)


class ExportTests(unittest.TestCase):
    def setUp(self):
        # Reuse the existing realistic admission/history fixture construction,
        # including its actual cross-split past-assistant target hold.
        f = self.fixture = history_fixtures.EvaluationHistoryTests()
        f.setUp()
        self.addCleanup(f.doCleanups)
        self.frozen = f.root / "frozen"
        (self.frozen / "conversation").mkdir(parents=True)
        ends = [20, 80, 50, 100, 30]
        for row, end in zip(f.payloads, ends):
            row["messages"][0]["content"] = source.SYSTEM
            if row["id"] != "synthetic_held_validation":
                row["messages"][-1]["content"] += " synthetic source target" * 3
            if row["id"] in {"synthetic_older_validation", "synthetic_other_validation"}:
                phrase = "처방" if row["id"] == "synthetic_older_validation" else "다음 회기"
                row["messages"][2:2] = [{"role": "assistant", "content": "Synthetic context " + phrase},
                                            {"role": "user", "content": "Synthetic followup"}]
            row.update(schema_version=source.SCHEMA, task="original_counselor_continuation",
                context_policy="entire_original_prefix_no_holes_no_future", target_origin="observed_counselor_utterance",
                quality_status="heuristic_screened_not_human_reviewed", caregiver_perspective_assumed=False,
                loss_message_mask=[0] * (len(row["messages"]) - 1) + [1],
                target_sha256=source.sha_text(row["messages"][-1]["content"]),
                target_start_ordinal=end, target_end_ordinal=end, context_start_ordinal=0)
        for split in source.SPLITS:
            rows = [{"conversation_id": r["source_conversation_id"], "group_id": r["source_group_id"],
                "subject_id_key": r["source_conversation_id"], "split": split, "original_split": split,
                "source_turn_count": 101, "source_class": "NORMAL", "source_full_text_sha256": source.sha_text("synthetic full source")}
                for r in f.payloads if r["split"] == split]
            (self.frozen / f"conversation/{split}.jsonl").write_bytes(b"".join(composition.encoded(r) for r in rows))
        source.dump_json(self.frozen / "conversation/manifest.json", {"source_database_sha256": "a" * 64})
        source.dump_json(self.frozen / "conversation/input_filter_review.json", {"records": []})
        f.freeze_sources()
        f.original_manifest["source"] = {"database_sha256": "a" * 64,
            "frozen_files": {str(p.relative_to(self.frozen)): source.sha_file(p) for p in self.frozen.rglob("*") if p.is_file()}}
        source.dump_json(f.release / "manifest.json", f.original_manifest)
        f.original_hash = source.sha_file(f.release / "manifest.json")
        audit = source.read_json(f.selection_audit_path)
        audit["input_manifest_sha256"] = f.original_hash
        source.dump_json(f.selection_audit_path, audit)
        f.source_path = f.root / "rebound_admission/admission_rows.jsonl.gz"
        f.admission_policy_path = f.source_path.parent / "admission_policy.json"
        admission.build_admission(f.release, f.selection_audit_path, f.source_path.parent)
        f.rows = list(source.read_rows(f.source_path))
        f.write_rows(f.source_path, f.rows)
        f.rebind_source_policy_ledger()
        for row in f.tokens:
            if row["id"] == "synthetic_new_validation":
                row.update(sequence_length=9000, prefix_length=8900)
        f.write_rows(f.lengths_path, [{**{k: r[k] for k in token.IDENTITY}, "status": "encoded",
            **{k: r[k] for k in token.LENGTHS}} for r in f.tokens])
        f.save_tokenizer_audit()
        f.token_report, joined = token.validate_and_summarize(f.release, f.admission_policy_path,
            f.source_path, f.tokenizer_audit_path, f.lengths_path)
        f.tokens = token.make_cap_ledger(joined, 4096)
        f.save_inputs()
        source.dump_json(f.evidence_path, {"inputs": f.source_files})
        f.events = [f.event()]
        f.save_events()
        self.output = f.root / "composition"
        self.inputs = dict(release=f.release, frozen=self.frozen, admission_policy=f.admission_policy_path,
            admission_rows=f.source_path, selection_audit=f.selection_audit_path, tokenizer_audit=f.tokenizer_audit_path,
            row_lengths=f.lengths_path, previous_candidate=f.export, events=f.events_path)
        self.when = "2026-10-16T06:00:00+00:00"

    def build(self, output=None):
        return composition.build(output=output or self.output, occurred_at=self.when, **self.inputs)

    def rehash(self, name):
        path = self.output / name
        manifest = source.read_json(self.output / "export_manifest.json")
        manifest["files"][name].update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        source.dump_json(self.output / "export_manifest.json", manifest)

    def test_preserves_exact_lines_masks_splits_holds_and_context_flags(self):
        before = {p: source.sha_file(p) for p in self.fixture.root.rglob("*") if p.is_file()}
        summary = self.build()
        self.assertEqual(summary["tables"]["selected_full_context"]["all"]["rows"], 3)
        self.assertEqual(summary["tables"]["selected_compatible_4096"]["all"]["rows"], 2)
        self.assertEqual(summary["tables"]["selected_full_context"]["validation"]["length_tiers"],
                         {"8193_16384": 1, "le_4096": 1})
        ledger = {r["id"]: r for r in source.read_rows(self.output / "selection_ledger.jsonl.gz")}
        medical = ledger["synthetic_older_validation"]
        self.assertFalse(medical["chosen"])
        self.assertIn("medical_context_requires_review", medical["hold_reasons"])
        procedural = ledger["synthetic_other_validation"]
        self.assertTrue(procedural["chosen"] and procedural["review_required"])
        self.assertIn("prior_assistant_procedural_pattern", procedural["context_flags"])
        self.assertFalse(ledger["synthetic_held_validation"]["chosen"])
        self.assertIn(admission.TARGET_REASON, ledger["synthetic_held_validation"]["hold_reasons"])
        for split in source.SPLITS:
            originals = {json.loads(line)["id"]: line for line in gzip.decompress((self.fixture.release / f"conversation/{split}.jsonl.gz").read_bytes()).splitlines(keepends=True)}
            for line in gzip.decompress((self.output / f"{split}.jsonl.gz").read_bytes()).splitlines(keepends=True):
                row = json.loads(line)
                self.assertEqual(line, originals[row["id"]])
                self.assertEqual(row["loss_message_mask"], [0] * (len(row["messages"]) - 1) + [1])
                self.assertNotIn("human_approved", row)
        self.assertEqual(before, {p: source.sha_file(p) for p in before})

    def test_reproducible_artifacts_and_no_overwrite(self):
        self.build()
        other = self.fixture.root / "second"
        self.build(other)
        self.assertEqual({p.name: source.sha_file(p) for p in self.output.iterdir()},
                         {p.name: source.sha_file(p) for p in other.iterdir()})
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.build()

    def test_history_evidence_pointers_resolve_and_never_authorize_training(self):
        self.build()
        summary = source.read_json(self.output / "summary.json")
        for event in history._json_rows(self.output / "evaluation_history_events.jsonl"):
            self.assertEqual(source.sha_file(self.output / event["evidence"]["path"]), event["evidence"]["sha256"])
            self.assertEqual({key: history._pointer(summary, pointer) for key, pointer in event["evidence"]["input_pointers"].items()}, event["input_sha256"])
        manifest = source.read_json(self.output / "export_manifest.json")
        for key in ("training_authorized", "model_training_authorized", "full_training_authorized", "independent_test_eligible"):
            self.assertIs(manifest[key], False)
        self.assertTrue(manifest["development_exposed"])

    def test_manifest_authorization_and_preservation_flags_cannot_be_forged(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        original = source.read_json(self.output / "export_manifest.json")
        for key in ("training_authorized", "model_training_authorized", "full_training_authorized", "independent_test_eligible",
                    "source_split_moved", "tokens_truncated", "development_exposed", "original_jsonl_lines_preserved"):
            manifest = {**original, key: not original[key]}
            source.dump_json(self.output / "export_manifest.json", manifest)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "authorization"):
                composition.verify_artifacts(self.output, plan)

    def test_rehashed_ledger_decisions_and_boolean_integer_forgery_fail(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        path = self.output / "selection_ledger.jsonl.gz"
        original = list(source.read_rows(path))
        for field, value in (("chosen", 1), ("source_group_id", "forged"), ("training_authorized", True), ("relative_position", .99)):
            rows = copy.deepcopy(original)
            selected = next(r for r in rows if r["chosen"])
            selected[field] = value
            path.unlink()
            composition.write_gzip(path, (composition.encoded(r) for r in rows))
            self.rehash(path.name)
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "recomputed decisions"):
                composition.verify_artifacts(self.output, plan)

    def test_rehashed_config_and_summary_boolean_integer_forgery_fail(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        for name, field in (("composition_config.json", "training_authorized"), ("summary.json", "training_authorized")):
            path = self.output / name
            original = path.read_bytes()
            document = json.loads(original)
            document[field] = 0
            source.dump_json(path, document)
            self.rehash(name)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "config or summary"):
                composition.verify_artifacts(self.output, plan)
            path.write_bytes(original)
            self.rehash(name)

    def test_frozen_metadata_hash_forgery_fails_before_publication(self):
        path = self.frozen / "conversation/train.jsonl"
        document = json.loads(path.read_text())
        document["source_turn_count"] += 1
        path.write_bytes(composition.encoded(document))
        with self.assertRaisesRegex(ValueError, "frozen metadata hash"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_synchronized_policy_and_ledger_hold_removal_is_recomputed(self):
        f = self.fixture
        for row in f.rows:
            if row["id"] == "synthetic_held_validation":
                row.update(admitted=True, status="admitted", reasons=[])
        for row in f.tokens:
            if row["id"] == "synthetic_held_validation":
                row.update(source_admitted=True, source_status="admitted", source_reasons=[], admitted=True, status="admitted", reasons=[])
        f.forge_matching_downstream_metadata(remove_hold=True)
        # The mutually consistent downstream join passes; the source replay must fail.
        token.validate_and_summarize(f.release, f.admission_policy_path, f.source_path, f.tokenizer_audit_path, f.lengths_path)
        with self.assertRaisesRegex(ValueError, "recomputed rules"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_publication_failure_leaves_no_partial_output(self):
        real_link = composition.os.link
        calls = []
        def interrupted(src, dst):
            calls.append(dst)
            if len(calls) == 3:
                raise OSError("synthetic publication failure")
            return real_link(src, dst)
        with patch.object(composition.os, "link", interrupted), self.assertRaisesRegex(OSError, "publication"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_rehashed_export_cannot_change_prefix_or_loss_mask(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        path = self.output / "train.jsonl.gz"
        rows = list(source.read_rows(path))
        rows[0]["loss_message_mask"][0] = 1
        path.unlink()
        composition.write_gzip(path, (composition.encoded(r) for r in rows))
        self.rehash(path.name)
        with self.assertRaisesRegex(ValueError, "original bytes"):
            composition.verify_artifacts(self.output, plan)

    def test_uncompressed_digest_is_verified(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        manifest = source.read_json(self.output / "export_manifest.json")
        manifest["files"]["train.jsonl.gz"]["uncompressed_sha256"] = "0" * 64
        source.dump_json(self.output / "export_manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "uncompressed hash"):
            composition.verify_artifacts(self.output, plan)

    def test_implementation_version_is_bound(self):
        self.build()
        plan = composition.prepare(**self.inputs)
        code = Path(composition.__file__)
        self.assertIn(code, plan["tracked"])
        manifest = source.read_json(self.output / "export_manifest.json")
        manifest["input_sha256"][str(code.resolve())] = "0" * 64
        source.dump_json(self.output / "export_manifest.json", manifest)
        with self.assertRaisesRegex(ValueError, "metadata binding"):
            composition.verify_artifacts(self.output, plan)

    def test_original_mask_position_and_context_are_checked_before_selection(self):
        plan = composition.prepare(**self.inputs)
        original = self.fixture.payloads[0]
        manifest = source.read_json(self.fixture.release / "manifest.json")
        frozen = composition.load_frozen_metadata(self.frozen, manifest, {})[original["source_conversation_id"]]
        joined = next(r for r in plan["rows"] if r["id"] == original["id"])
        for field, value in (("loss_message_mask", [0] * len(original["messages"])),
                             ("target_end_ordinal", 101), ("source_group_id", "forged_group")):
            row = {**original, field: value}
            with self.subTest(field=field), self.assertRaises(ValueError):
                composition.row_metadata(row, composition.encoded(row), joined, frozen, composition.CONFIG)
        over = {**joined, "sequence_length": 32769, "prefix_length": 32669}
        held = composition.row_metadata(original, composition.encoded(original), over, frozen, composition.CONFIG)
        self.assertFalse(held["eligible"])
        self.assertIn("sequence_exceeds_composition_cap", held["hold_reasons"])


if __name__ == "__main__":
    unittest.main()
