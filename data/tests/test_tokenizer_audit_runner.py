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
from tests.test_gemma4_token_validation import FakeTokenizer, FAKE_TEMPLATE, example


PATH = Path(__file__).resolve().parents[1] / "scripts" / "malssi_tokenizer_audit.py"
SPEC = importlib.util.spec_from_file_location("malssi_tokenizer_audit", PATH)
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)


class TokenizerAuditRunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        files = {}
        for split in runner.SPLITS:
            path = self.root / f"{split}.jsonl.gz"
            with gzip.open(path, "wt") as out:
                out.write(json.dumps({"id": split, "split": split, "source_group_id": split,
                                      "source_conversation_id": split, "messages": [{"role": "user", "content": "synthetic"}]}) + "\n")
            files[f"conversation/{split}.jsonl.gz"] = {"sha256": runner.sha_file(path), "rows": 1, "bytes": path.stat().st_size}
        self.manifest = {"files": files}
        self.save()

    def save(self):
        (self.root / "manifest.json").write_text(json.dumps(self.manifest))

    def test_flat_input_names_match_original_manifest_keys(self):
        inputs, digest = runner.verify_inputs(self.root)
        self.assertEqual(sum(v["rows"] for v in inputs.values()), 2)
        self.assertEqual(len(list(runner.source_chunks(inputs, 1))), 2)
        self.assertEqual(len(digest), 64)

    def test_hash_and_declared_count_are_independent(self):
        self.manifest["files"]["conversation/train.jsonl.gz"]["rows"] = 2;self.save()
        with self.assertRaisesRegex(ValueError, "row count mismatch"):runner.verify_inputs(self.root)
        self.manifest["files"]["conversation/train.jsonl.gz"]["rows"] = 1
        self.manifest["files"]["conversation/train.jsonl.gz"]["sha256"] = "0" * 64;self.save()
        with self.assertRaisesRegex(ValueError, "SHA-256 mismatch"):runner.verify_inputs(self.root)

    def test_percentiles_and_cap_counts_include_only_encoded_rows(self):
        rows = [{"id": str(n), "split": "train", "source_group_id": "g", "source_conversation_id": str(n),
                 "status": "encoded", "sequence_length": n, "prefix_length": n-2, "target_length": 2,
                 "starts_with_assistant": True, "raw_template_prefix_match": False} for n in (10, 500, 1000)]
        rows.append({"id": "held", "split": "train", "status": "held", "starts_with_assistant": False})
        out = runner.summarize(rows)["train"]
        self.assertEqual(out["full"]["p50"], 500)
        self.assertEqual(out["full"]["sum"], 1510)
        self.assertEqual(out["caps"]["512"]["admitted_rows"], 2)
        self.assertEqual(out["caps"]["512"]["source_conversations"], 2)
        self.assertEqual(out["groups"]["g"]["row_share"], 1)
        self.assertEqual(out["starts_with_assistant_encoded"], 3)

    def test_probe_selection_is_deterministic_and_quarantine_is_explicit(self):
        a = {"id": "a", "sequence_length": 200};b = {"id": "b", "sequence_length": 200}
        self.assertTrue(runner.better(a, b));self.assertFalse(runner.better(b, a))
        policy = self.root / "policy.json";policy.write_text(json.dumps({"source_group_ids": ["g"]}))
        self.assertEqual(runner.read_quarantine(policy), {"g"})
        policy.write_text(json.dumps({"unrecognized": ["g"]}))
        with self.assertRaises(ValueError):runner.read_quarantine(policy)

    def test_worker_collates_and_reports_holds_without_selecting_quarantined_probe(self):
        rows = []
        for identity in ("allowed", "blocked", "held"):
            row = example();row.update(id=identity, source_group_id=identity,
                                       source_conversation_id=identity, split="train")
            if identity == "held": row["messages"][-1]["content"] += "<|unknown_control>"
            rows.append(row)
        digest = hashlib.sha256(FAKE_TEMPLATE.encode()).hexdigest()
        tokenizer = FakeTokenizer();tokenizer.pad_token_id = 0
        with patch.object(adapter, "PINNED_TEMPLATE_SHA256", digest), \
             patch.object(runner, "TOKENIZER", tokenizer), \
             patch.object(runner, "QUARANTINED", {"blocked"}):
            records, probes = runner.process_chunk(rows)
        self.assertEqual([r["status"] for r in records], ["encoded", "encoded", "held"])
        self.assertEqual(records[-1]["error_type"], "TokenValidationError")
        self.assertTrue(probes)
        self.assertTrue(all(r["source_group_id"] == "allowed" for r in probes.values()))
        self.assertTrue(all("messages" not in r and "input_ids" not in r for r in records))

    def family_fixture(self, leading_assistant=True):
        longest = example(" \n마지막 답변입니다.\t ")
        if not leading_assistant:
            del longest["messages"][1]
        longest["messages"] += [{"role": "user", "content": "마지막 답변입니다."},
                                 {"role": "assistant", "content": "마지막 답변입니다."}]
        rows = []
        for n in range(2, len(longest["messages"]) + 1):
            if longest["messages"][n-1]["role"] != "assistant" or longest["messages"][n-2]["role"] != "user":
                continue
            rows.append({"id": str(n), "source_conversation_id": "conversation", "source_group_id": "group",
                         "split": "train", "messages": copy.deepcopy(longest["messages"][:n]),
                         "loss_message_mask": [0] * (n - 1) + [1]})
        tokenizer = FakeTokenizer();tokenizer.pad_token_id = 0;tokenizer.bos_token = "<bos>"
        return rows, tokenizer

    def test_family_all_prefixes_match_reference_including_leading_assistant_repetition_and_whitespace(self):
        digest = hashlib.sha256(FAKE_TEMPLATE.encode()).hexdigest()
        for leading in (False, True):
            rows, tokenizer = self.family_fixture(leading)
            original = copy.deepcopy(rows)
            with patch.object(adapter, "PINNED_TEMPLATE_SHA256", digest), \
                 patch.object(tokenizer, "apply_chat_template", wraps=tokenizer.apply_chat_template) as render:
                family, reason = runner.prepare_prefix_family(rows, tokenizer)
                self.assertIsNone(reason)
                self.assertEqual(render.call_count, 3)
                fast = [runner.encode_family_row(r, tokenizer, family) for r in rows]
                self.assertEqual(render.call_count, 3)
                reference = [adapter.encode_example(r, tokenizer) for r in rows]
                self.assertEqual(fast, reference)
                self.assertEqual(rows, original)
                self.assertTrue(any(x["target_boundary_whitespace_trimmed"] for x in fast))

    def test_mutated_prefix_dictionary_rejects_reuse_and_exact_path_remains_available(self):
        digest = hashlib.sha256(FAKE_TEMPLATE.encode()).hexdigest()
        for mutation in ("content", "message_id"):
            rows, tokenizer = self.family_fixture()
            rows[0]["messages"][0][mutation] = "different"
            with patch.object(adapter, "PINNED_TEMPLATE_SHA256", digest), \
                 patch.object(runner, "TOKENIZER", tokenizer):
                family, reason = runner.prepare_prefix_family(rows, tokenizer)
                self.assertIsNone(family);self.assertEqual(reason, "message_prefix_mismatch")
                records, _ = runner.process_chunk(rows, True)
            self.assertTrue(all(r["status"] == "encoded" and r["serialization_path"] == "native_per_row"
                                for r in records))

    def test_nonalternating_roles_fall_back_even_when_renderer_is_linear(self):
        rows, tokenizer = self.family_fixture()
        rows = rows[-1:]
        rows[0]["messages"][1]["role"] = "user"
        digest = hashlib.sha256(FAKE_TEMPLATE.encode()).hexdigest()
        with patch.object(adapter, "PINNED_TEMPLATE_SHA256", digest), \
             patch.object(runner, "TOKENIZER", tokenizer):
            family, reason = runner.prepare_prefix_family(rows, tokenizer)
            self.assertIsNone(family);self.assertEqual(reason, "nonalternating_roles")
            records, _ = runner.process_chunk(rows, True)
        self.assertEqual(records[0]["status"], "encoded")
        self.assertEqual(records[0]["serialization_path"], "native_per_row")

    def test_family_native_composition_and_token_boundaries_are_both_checked(self):
        rows, tokenizer = self.family_fixture()
        digest = hashlib.sha256(FAKE_TEMPLATE.encode()).hexdigest()
        native = tokenizer.apply_chat_template
        tokenizer.apply_chat_template = lambda *a, **kw: native(*a, **kw).replace("<bos>", "<bos>\n")
        with patch.object(adapter, "PINNED_TEMPLATE_SHA256", digest):
            family, reason = runner.prepare_prefix_family(rows, tokenizer)
            self.assertIsNone(family);self.assertEqual(reason, "native_linear_composition_mismatch")
        tokenizer.apply_chat_template = native
        with patch.object(adapter, "PINNED_TEMPLATE_SHA256", digest):
            family, _ = runner.prepare_prefix_family(rows, tokenizer)
            with patch.object(adapter, "_token_ids", side_effect=[[1, 2, 3], [7, 8]]):
                with self.assertRaisesRegex(adapter.TokenValidationError, "Token prefix mismatch"):
                    runner.encode_family_row(rows[0], tokenizer, family)

    def test_invalid_family_mask_and_unknown_template_fall_back_then_hold(self):
        digest = hashlib.sha256(FAKE_TEMPLATE.encode()).hexdigest()
        for invalid in ("mask", "template"):
            rows, tokenizer = self.family_fixture()
            if invalid == "mask":
                rows[0]["loss_message_mask"][-1] = True
            else:
                tokenizer.chat_template += "unknown"
            with patch.object(adapter, "PINNED_TEMPLATE_SHA256", digest), \
                 patch.object(runner, "TOKENIZER", tokenizer):
                records, _ = runner.process_chunk(rows, True)
            self.assertEqual(records[0]["status"], "held")
            self.assertTrue(all(r["serialization_path"] == "native_per_row" for r in records))
            self.assertEqual(sum(r["native_family_checked"] for r in records), 0)

    def test_family_worker_collates_and_counts_one_native_proof_for_all_rows(self):
        rows, tokenizer = self.family_fixture()
        digest = hashlib.sha256(FAKE_TEMPLATE.encode()).hexdigest()
        with patch.object(adapter, "PINNED_TEMPLATE_SHA256", digest), \
             patch.object(runner, "TOKENIZER", tokenizer), \
             patch.object(runner, "verify_collation", wraps=runner.verify_collation) as collate:
            records, _ = runner.process_chunk(rows, True)
        self.assertEqual(collate.call_count, 1)
        self.assertTrue(all(r["status"] == "encoded" and r["serialization_path"] == "verified_prefix_family"
                            for r in records))
        self.assertEqual(sum(r["native_family_checked"] for r in records), 1)

    def test_source_families_preserve_contiguity_and_reject_reopened_conversations(self):
        rows, _ = self.family_fixture()
        other = copy.deepcopy(rows[0]);other.update(id="other", source_conversation_id="other")
        with patch.object(runner, "source_chunks", return_value=iter([[r] for r in rows + [other]])):
            self.assertEqual([len(f) for f in runner.source_families({})], [3, 1])
        with patch.object(runner, "source_chunks", return_value=iter([[rows[0]], [other], [rows[1]]])):
            with self.assertRaisesRegex(ValueError, "not contiguous"):
                list(runner.source_families({}))


if __name__ == "__main__":
    unittest.main()
