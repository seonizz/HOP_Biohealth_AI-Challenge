"""Synthetic mechanics, not human approval or real-tokenizer evidence."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from counseling_pipeline import agent_dataset as baseline
from counseling_pipeline import supporter_task_composition as composition
from counseling_pipeline.annotations import canonical, digest
from test_agent_dataset import episode, review


class CompositionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old = self.root / "old"
        self.source = self.root / "source"
        self.output = self.root / "release"
        self.additions = self.root / "additions.jsonl"
        self.reviews = self.root / "reviews.jsonl"
        self.original = [episode("old-train"), episode("old-val", "validation")]
        baseline.build_dataset(self.original, [review(e) for e in self.original], self.old)
        self.source.mkdir()
        blob = b"immutable source bytes\n"
        (self.source / "source.jsonl").write_bytes(blob)
        manifest = {"schema_version": "malssi-source-volume-context-composition-v1", "status": "verified",
                    "source_split_moved": False, "training_authorized": False,
                    "original_jsonl_lines_preserved": True, "evaluation_budget": composition.BUDGET,
                    "files": {"source.jsonl": {"sha256": composition.sha(blob), "bytes": len(blob)}}}
        (self.source / "export_manifest.json").write_text(canonical(manifest))
        self.new = [episode("new-train"), episode("new-val", "validation")]
        self.inputs()

    def inputs(self, reviews=None):
        self.additions.write_text("".join(canonical(e) + "\n" for e in self.new))
        self.reviews.write_text("".join(canonical(r) + "\n" for r in
                                       (reviews if reviews is not None else [review(e) for e in self.new])))

    def build(self):
        return composition.build(self.old, self.source, self.additions, self.reviews, self.output)

    def mutate_manifest(self, change):
        path = self.output / "manifest.json"
        value = json.loads(path.read_text())
        change(value)
        path.write_text(canonical(value))

    def test_build_preserves_baseline_all_units_and_source_bytes(self):
        before = {p: p.read_bytes() for root in (self.old, self.source) for p in root.rglob("*") if p.is_file()}
        manifest = self.build()
        rows, loaded = composition.audit(self.output, allow_ai_draft=True)
        self.assertEqual(manifest, loaded)
        self.assertEqual(manifest["episode_count"], 4)
        self.assertEqual(manifest["added_episode_count"], 2)
        self.assertFalse(manifest["tokenizer_validated"])
        self.assertEqual(manifest["token_admitted_rows"], 0)
        self.assertFalse(manifest["human_or_expert_approved"])
        for unit in baseline.UNITS:
            for split in baseline.SPLITS:
                old_rows = composition.lines((self.old / unit / (split + ".jsonl")).read_bytes())
                self.assertEqual(rows[unit][split][:len(old_rows)], old_rows)
                for row in rows[unit][split]:
                    self.assertTrue(all(type(x) is int for x in row["loss_message_mask"]))
                    self.assertEqual(row["loss_message_mask"], [0] * (len(row["messages"]) - 1) + [1])
        self.assertEqual(before, {p: p.read_bytes() for p in before})

    def test_default_load_is_blocked(self):
        self.build()
        with self.assertRaisesRegex(ValueError, "allow_ai_draft"):
            composition.audit(self.output)

    def test_baseline_float_row_count_and_source_float_bytes_rejected(self):
        old_path = self.old / "manifest.json"
        original = old_path.read_bytes()
        value = json.loads(original)
        value["files"]["episodes.jsonl"]["rows"] = 2.0
        old_path.write_text(canonical(value))
        with self.assertRaisesRegex(ValueError, "baseline file"):
            self.build()
        old_path.write_bytes(original)
        source_path = self.source / "export_manifest.json"
        value = json.loads(source_path.read_bytes())
        value["files"]["source.jsonl"]["bytes"] = float(value["files"]["source.jsonl"]["bytes"])
        source_path.write_text(canonical(value))
        with self.assertRaisesRegex(ValueError, "source file"):
            self.build()

    def test_contradictory_approval_metadata_rejected_even_with_rebound_ai_review(self):
        for flag in ("human_approved", "human_or_expert_approved", "expert_approved", "training_authorized",
                     "training_allowed", "production_ready", "independent_test_eligible"):
            for value in (True, 0, 1, "false"):
                self.new[0][flag] = value; self.inputs()
                with self.subTest(flag=flag, value=value), self.assertRaisesRegex(ValueError, "approval"):
                    self.build()
            del self.new[0][flag]

    def test_internal_directory_symlink_is_rejected_but_parent_storage_alias_is_allowed(self):
        self.build()
        actual = self.root / "external-conversation"
        (self.output / "conversation").rename(actual)
        (self.output / "conversation").symlink_to(actual, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            composition.audit(self.output, allow_ai_draft=True)
        (self.output / "conversation").unlink(); actual.rename(self.output / "conversation")
        alias = self.root / "storage-alias"
        alias.symlink_to(self.root, target_is_directory=True)
        composition.audit(alias / "release", allow_ai_draft=True)

    def test_reviews_stale_missing_self_human_and_false_pass_rejected(self):
        for change in (lambda r: r.update(episode_sha256="stale"), lambda r: r.update(reviewer_id="fixture-author"),
                       lambda r: r.update(reviewer_type="human"), lambda r: r.update(status="hold"),
                       lambda r: r.update(checks={k: 1 for k in baseline.CHECKS})):
            reviews = [review(e) for e in self.new]
            change(reviews[0]); self.inputs(reviews)
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.build()
        self.inputs([])
        with self.assertRaises(ValueError):
            self.build()
        self.assertFalse(self.output.exists())

    def test_cross_release_renamed_and_whitespace_dialogue_rejected(self):
        original = copy.deepcopy(self.new)
        for whitespace in (False, True):
            self.new = copy.deepcopy(original)
            self.new[0]["messages"] = copy.deepcopy(self.original[0]["messages"])
            self.new[0]["annotations"] = copy.deepcopy(self.original[0]["annotations"])
            if whitespace:
                self.new[0]["messages"][0]["content"] = "  " + self.new[0]["messages"][0]["content"] + "\n"
            self.inputs()
            with self.subTest(whitespace=whitespace), self.assertRaisesRegex(ValueError, "duplicate"):
                self.build()

    def test_root_or_group_cross_split_rejected(self):
        for field in ("source_root_ids", "source_group_ids"):
            original = copy.deepcopy(self.new)
            self.new[1][field] = self.original[0][field]
            self.inputs()
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "cross-split"):
                self.build()
            self.new = original

    def test_source_adaptation_and_safety_are_not_synthetic_shortcuts(self):
        for field, value in (("origin_type", "adapted_from_source"), ("source_refs", [{"id": "raw"}]),
                             ("risk_tags", ["crisis"]), ("resource_dependencies", [{"id": "bank"}])):
            original = copy.deepcopy(self.new)
            self.new[0][field] = value; self.inputs()
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.build()
            self.new = original

    def test_new_future_does_not_change_earlier_prefix_or_targets(self):
        before = baseline.derive_rows(self.new)
        self.new[0]["messages"][2]["content"] += " 미래의 추가 정보"
        after = baseline.derive_rows(self.new)
        for unit in baseline.UNITS:
            self.assertEqual(before[unit]["train"][0], after[unit]["train"][0] | {
                "episode_sha256": before[unit]["train"][0]["episode_sha256"]})

    def test_unicode_line_separators_are_preserved_in_real_jsonl_roundtrip(self):
        for separator in ("\u2028", "\u2029"):
            self.new[0]["messages"][0]["content"] += separator + "追記"
        self.inputs(); self.build()
        records = composition.lines((self.output / "episodes.jsonl").read_bytes())
        self.assertEqual(records[-2], self.new[0])
        composition.audit(self.output, allow_ai_draft=True)

    def test_duplicate_json_keys_and_nonfinite_numbers_rejected(self):
        for blob in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}'):
            with self.subTest(blob=blob), self.assertRaises(ValueError):
                composition.parse(blob)

    def test_source_changed_is_rejected_even_when_supporter_payload_is_unchanged(self):
        self.build()
        (self.source / "source.jsonl").write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "source file"):
            composition.audit(self.output, allow_ai_draft=True)

    def test_manifest_false_promotion_old_budget_and_row_binding_rejected(self):
        self.build()
        original = (self.output / "manifest.json").read_bytes()
        for mutate in (lambda m: m.update(human_or_expert_approved=True),
                       lambda m: m.update(tokenizer_validated=True, token_admitted_rows=1),
                       lambda m: m.update(independent_test_eligible=True),
                       lambda m: m["evaluation_budget"].update(max_output_tokens=4096),
                       lambda m: m.update(recorded_rows={}),
                       lambda m: m["counts"]["conversation"].update(train=True)):
            (self.output / "manifest.json").write_bytes(original)
            self.mutate_manifest(mutate)
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                composition.audit(self.output, allow_ai_draft=True)

    def test_rehashed_target_mask_exposure_corruption_still_rejected(self):
        self.build()
        for name, mutate in (
                ("conversation/train.jsonl", lambda r: r["messages"][-1].update(content="unsupported answer")),
                ("conversation/train.jsonl", lambda r: r.update(loss_message_mask=[False, False, True])),
                ("exposure_events.jsonl", lambda r: r.update(independent_test_eligible=True))):
            path = self.output / name; original = path.read_bytes()
            manifest_original = (self.output / "manifest.json").read_bytes()
            records = composition.lines(original); mutate(records[0])
            blob = ("".join(canonical(r) + "\n" for r in records)).encode()
            path.write_bytes(blob)
            self.mutate_manifest(lambda m: m["files"].update({name: {"sha256": composition.sha(blob), "rows": len(records), "bytes": len(blob)}}))
            with self.subTest(name=name, mutate=mutate), self.assertRaisesRegex(ValueError, "derivation"):
                composition.audit(self.output, allow_ai_draft=True)
            path.write_bytes(original); (self.output / "manifest.json").write_bytes(manifest_original)

    def test_no_overwrite_symlink_payload_or_unsafe_manifest_path(self):
        self.build()
        with self.assertRaisesRegex(ValueError, "output exists"):
            self.build()
        with self.assertRaisesRegex(ValueError, "unsafe"):
            composition.capture(self.source, ["../external"])
        target = self.output / "reviews.jsonl"
        target.unlink(); target.symlink_to(self.reviews)
        with self.assertRaisesRegex(ValueError, "symlink"):
            composition.audit(self.output, allow_ai_draft=True)

    def test_failed_staged_verification_publishes_nothing(self):
        with patch.object(composition, "audit", side_effect=ValueError("injected verification failure")):
            with self.assertRaisesRegex(ValueError, "injected"):
                self.build()
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob(".supporter-task-*")))

    def test_source_hash_and_parse_use_the_same_captured_bytes(self):
        real_read = composition.read
        calls = CounterForTest()
        def counted(path):
            calls[str(path)] += 1
            return real_read(path)
        with patch.object(composition, "read", side_effect=counted):
            composition.baseline_snapshot(self.old)
        self.assertTrue(calls)
        self.assertTrue(all(count == 1 for count in calls.values()))

    def test_token_batch_uses_fresh_adapter_and_rejects_mixed_task_or_split(self):
        self.build()
        rows, _ = composition.audit(self.output, allow_ai_draft=True)
        rid = rows["conversation"]["train"][0]["row_id"]
        fake = type("FakeTokenizer", (), {"pad_token_id": 0})()
        def encode(row, tokenizer, max_length):
            return {"input_ids": [1, 2, 3], "labels": [-100, -100, 3], "attention_mask": [1, 1, 1],
                    "prefix_length": 2, "target_length": 1, "sequence_length": 3}
        with patch.object(composition.adapter, "encode_example", side_effect=encode) as encode_mock:
            batch, counts = composition.token_batch(self.output, "conversation", "train", [rid], fake, allow_ai_draft=True)
            self.assertEqual(encode_mock.call_count, 1)
            self.assertEqual(batch["labels"], [[-100, -100, 3]])
            self.assertEqual(counts[0]["prefix_plus_reserved_output"], 8194)
            for split, ids in (("test", [rid]), ("validation", [rid]), ("train", [rid, rid])):
                with self.subTest(split=split, ids=ids), self.assertRaises(ValueError):
                    composition.token_batch(self.output, "conversation", split, ids, fake, allow_ai_draft=True)

    def test_unrecognized_or_missing_tokenizer_cannot_admit_a_row(self):
        self.build()
        rows, _ = composition.audit(self.output, allow_ai_draft=True)
        rid = rows["conversation"]["train"][0]["row_id"]
        for tokenizer in (None, type("UnpinnedTokenizer", (), {"chat_template": "different"})()):
            with self.subTest(tokenizer=tokenizer), self.assertRaises(ValueError):
                composition.token_batch(self.output, "conversation", "train", [rid], tokenizer, allow_ai_draft=True)


class CounterForTest(dict):
    def __missing__(self, key):
        return 0


class BudgetTests(unittest.TestCase):
    def test_exact_limits_and_output_reservation(self):
        self.assertEqual(composition.check_lengths(61440, 8192)["sequence_length"], 69632)
        for prefix, target in ((61441, 1), (1, 8193), (65536, 1)):
            with self.subTest(prefix=prefix, target=target), self.assertRaises(ValueError):
                composition.check_lengths(prefix, target)

    def test_strict_4096_is_observed_total_not_reserved_output(self):
        self.assertEqual(composition.check_lengths(4000, 96, strict_4096=True)["sequence_length"], 4096)
        with self.assertRaisesRegex(ValueError, "strict"):
            composition.check_lengths(4000, 97, strict_4096=True)

    def test_fake_counts_boolean_negative_float_zero_rejected(self):
        for value in (True, 0, -1, 1.0, "1", None):
            for pair in ((value, 1), (1, value)):
                with self.subTest(pair=pair), self.assertRaises(ValueError):
                    composition.check_lengths(*pair)


if __name__ == "__main__":
    unittest.main()
