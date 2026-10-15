"""Synthetic controls for the representative audit; no real tokenizer pass."""
import argparse
import copy
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from counseling_pipeline import gemma4_token_validation as adapter
from tests.test_gemma4_token_validation import FakeTokenizer, FAKE_TEMPLATE

PATH = Path(__file__).resolve().parents[1] / "scripts/malssi_round4_reference_audit.py"
SPEC = importlib.util.spec_from_file_location("malssi_round4_reference_audit", PATH)
reference = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reference)


class ImmediatePool:
    """Execute synchronously while measuring the caller's pending-work bound."""
    instances = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.pending = self.max_pending = 0
        self.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def submit(self, function, *args):
        self.pending += 1
        self.max_pending = max(self.max_pending, self.pending)
        value = function(*args)
        owner = self

        class Future:
            def result(self):
                owner.pending -= 1
                return value
        return Future()


class RoundFourReferenceAuditTests(unittest.TestCase):
    def setUp(self):
        self.tokenizer = FakeTokenizer()
        self.tokenizer.pad_token_id = 0;self.tokenizer.bos_token = "<bos>"
        digest = hashlib.sha256(FAKE_TEMPLATE.encode()).hexdigest()
        pin = patch.object(adapter, "PINNED_TEMPLATE_SHA256", digest)
        tokenizer = patch.object(reference.runner, "TOKENIZER", self.tokenizer)
        pin.start();tokenizer.start()
        self.addCleanup(pin.stop);self.addCleanup(tokenizer.stop)
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def family(self, identity="conversation", split="train", whitespace=True):
        messages = [{"role": "system", "content": "원문 상담"}, {"role": "assistant", "content": "먼저 이야기해 주세요."}]
        rows = []
        for n in range(7):
            target = " \n반복 답변\t " if whitespace and n == 1 else "반복 답변"
            messages.extend([{"role": "user", "content": f"이야기 {n}"}, {"role": "assistant", "content": target}])
            rows.append({"id": f"{identity}-{n}", "source_conversation_id": identity,
                         "source_group_id": "group-" + identity, "split": split,
                         "messages": copy.deepcopy(messages), "loss_message_mask": [0]*(len(messages)-1)+[1]})
        return rows

    def test_selects_first_middle_last_and_extra_target_whitespace_deterministically(self):
        rows = self.family()
        selected = reference.select_family_rows(rows)
        self.assertEqual([index for index, _, _ in selected], [0, 1, 3, 6])
        self.assertEqual([reasons for _, _, reasons in selected], [["first"], ["target_boundary_whitespace"], ["middle"], ["last"]])
        self.assertEqual(reference.select_family_rows(rows), selected)

    def test_single_row_deduplicates_selection_and_context_whitespace_is_fallback(self):
        one = self.family(whitespace=False)[:1]
        self.assertEqual(reference.select_family_rows(one)[0][2], ["first", "middle", "last"])
        rows = self.family(whitespace=False)
        for row in rows:
            row["messages"][0]["content"] += "\n"
        selected = reference.select_family_rows(rows)
        self.assertEqual([i for i, _, _ in selected], [0, 3, 6])
        self.assertIn("context_boundary_whitespace", selected[0][2])

    def test_exact_arrays_metadata_and_role_transition_match_without_storing_text(self):
        rows = self.family();before = copy.deepcopy(rows)
        with patch.object(self.tokenizer, "apply_chat_template", wraps=self.tokenizer.apply_chat_template) as render:
            result = reference.audit_family(rows)
        self.assertEqual(render.call_count, 3 + 3*4)  # One family proof; each reference renders independently.
        self.assertTrue(result["native_family_proof_passed"])
        self.assertEqual(result["selected_rows"], 4)
        self.assertTrue(all(r["status"] == "matched" for r in result["records"]))
        self.assertEqual(sum(r["target_becomes_history_in_longer_row"] for r in result["records"]), 3)
        self.assertTrue(all(r["starts_with_assistant"] for r in result["records"]))
        self.assertEqual(sum(r["target_boundary_whitespace"] for r in result["records"]), 1)
        for row in result["records"]:
            self.assertEqual(row["cached"], row["reference"])
            self.assertEqual(set(row["cached"]["array_sha256"]), set(reference.ARRAY_FIELDS))
            self.assertNotIn("messages", row)
            self.assertNotIn("input_ids", row["cached"])
        self.assertNotIn("반복 답변", json.dumps(result, ensure_ascii=False))
        self.assertEqual(rows, before)

    def test_label_array_difference_is_detected(self):
        original = reference.runner.encode_family_row

        def corrupt(*args):
            result = original(*args)
            result["labels"][result["prefix_length"]] = -100
            return result
        with patch.object(reference.runner, "encode_family_row", side_effect=corrupt):
            result = reference.audit_family(self.family())
        self.assertTrue(all(r["status"] == "mismatch" and r["differing_fields"] == ["labels"] for r in result["records"]))

    def test_boolean_number_metadata_difference_is_not_equal(self):
        original = reference.runner.encode_family_row

        def corrupt(*args):
            result = original(*args)
            result["canonicalization_applied"] = 1
            return result
        with patch.object(reference.runner, "encode_family_row", side_effect=corrupt):
            result = reference.audit_family(self.family())
        self.assertTrue(all(r["status"] == "mismatch" and r["differing_fields"] == ["canonicalization_applied"]
                            for r in result["records"]))

    def test_unusable_cache_is_failure_not_trivial_two_reference_pass(self):
        rows = self.family();rows[0]["messages"][0]["content"] = "변형"
        with patch.object(adapter, "encode_example", wraps=adapter.encode_example) as encode:
            result = reference.audit_family(rows)
        self.assertFalse(result["native_family_proof_passed"])
        self.assertEqual(encode.call_count, 0)
        self.assertTrue(all(r["status"] == "cache_unavailable" for r in result["records"]))

    def test_reference_runtime_error_is_recorded_and_not_skipped(self):
        with patch.object(adapter, "encode_example", side_effect=RuntimeError("synthetic failure")):
            result = reference.audit_family(self.family())
        self.assertEqual(len(result["records"]), 4)
        self.assertTrue(all(r["status"] == "runtime_error" and r["error"] == "synthetic failure" for r in result["records"]))

    def make_inputs(self):
        model = self.root / "model";model.mkdir()
        data = self.root / "data";data.mkdir()
        families = [self.family(str(n), "train" if n < 6 else "validation") for n in range(9)]
        manifest = {"files": {}, "selected_conversations": {"train": 6, "validation": 3}}
        for split in reference.runner.SPLITS:
            path = data / f"{split}.jsonl.gz"
            all_rows = [r for family in families for r in family if r["split"] == split]
            with gzip.open(path, "wt", encoding="utf-8") as stream:
                for row in all_rows:
                    stream.write(json.dumps(row) + "\n")
            manifest["files"][f"conversation/{split}.jsonl.gz"] = {"rows":len(all_rows),"bytes":path.stat().st_size,
                                                                     "sha256":reference.runner.sha_file(path)}
        (data / "manifest.json").write_text(json.dumps(manifest))
        args = argparse.Namespace(data_dir=data, model_dir=model, output_dir=self.root / "out", workers=4)
        return args

    def test_runner_covers_all_families_with_at_most_eight_pending_and_saves_ids(self):
        args = self.make_inputs()
        with patch.object(reference, "ProcessPoolExecutor", ImmediatePool):
            self.assertEqual(reference.run(args), 0)
        pool = ImmediatePool.instances[-1]
        self.assertEqual(pool.max_pending, 8)
        self.assertIs(pool.kwargs["initializer"], reference.runner.worker_init)
        report = json.loads((args.output_dir / "reference_audit.json").read_text())
        self.assertEqual(report["status"], "passed")
        self.assertEqual(report["source_rows_seen"], 63)
        self.assertEqual(report["source_conversations"], 9)
        self.assertEqual(report["source_conversations_by_split"], {"train": 6, "validation": 3})
        self.assertEqual(report["checked_rows"], 36)
        self.assertEqual(report["selected_feature_counts"]["target_becomes_history_in_longer_row"], 27)
        ledger = args.output_dir / "checked_rows.jsonl.gz"
        self.assertEqual(report["checked_rows_sha256"], reference.runner.sha_file(ledger))
        with gzip.open(ledger, "rt") as stream:
            ids = [json.loads(line)["id"] for line in stream]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertFalse(report["model_training_authorized"])
        self.assertIn("not a cache-free full-row rerun", report["scope"])

    def test_runner_rejects_source_hash_mismatch_before_creating_output(self):
        args = self.make_inputs()
        path = args.data_dir / "train.jsonl.gz"
        raw = bytearray(path.read_bytes());raw[-1] ^= 1;path.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):
            reference.run(args)
        self.assertFalse(args.output_dir.exists())

    def test_runner_rejects_unbounded_worker_count_and_existing_output(self):
        args = self.make_inputs();args.workers = 5
        with self.assertRaisesRegex(ValueError, "one to four"):
            reference.run(args)
        args.workers = 4;args.output_dir.mkdir()
        with self.assertRaisesRegex(ValueError, "already exists"):
            reference.run(args)

    def test_declared_conversation_coverage_mismatch_fails_even_with_valid_file_hashes(self):
        args = self.make_inputs()
        path = args.data_dir / "manifest.json"
        manifest = json.loads(path.read_text());manifest["selected_conversations"]["train"] = 7
        path.write_text(json.dumps(manifest))
        with patch.object(reference, "ProcessPoolExecutor", ImmediatePool):
            with self.assertRaisesRegex(ValueError, "conversation coverage mismatch"):
                reference.run(args)
        report = json.loads((args.output_dir / "reference_audit.json").read_text())
        self.assertEqual(report["status"], "failed")


if __name__ == "__main__":
    unittest.main()
