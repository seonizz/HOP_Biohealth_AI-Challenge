import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest

import ubuntu_role_panel as panel
import ubuntu_role_worker as worker


class NativeWorkerTests(unittest.TestCase):
    def fixture(self, root, split="validation"):
        ids = [10, 11, 12, 13]
        raw = struct.pack("<4I", *ids)
        row = {"row_id": "row1", "task": "question_plan", "source_group_ids": ["root1"],
               "source_root_ids": ["root1"], "split": split, "sequence_length": 4,
               "prefix_length": 2, "target_length": 2, "offset_tokens": 0,
               "weight": {"numerator": 2, "denominator": 1},
               "token_sha256": hashlib.sha256(raw).hexdigest()}
        (root / "tokens.bin").write_bytes(raw)
        (root / "index.jsonl").write_text(json.dumps(row) + "\n")
        (root / "MANIFEST.json").write_text(json.dumps({"files": {n: {"sha256": worker.digest(root / n)} for n in ["tokens.bin", "index.jsonl"]}}))
        return {"token_index": "index.jsonl", "token_binary": "tokens.bin", "rows": 1}, row, ids

    def test_native_reader_and_exact_prefix_boundary(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            part, row, ids = self.fixture(root)
            reader = worker.NativeTokenRows(root, part)
            try:
                self.assertEqual(reader[0], (row, ids))
                protocol = {"models": [{"id": "baseline", "suites": ["A"]}],
                            "generation": {"per_task_validation_sample": 16},
                            "expected_generation_assigned": 1, "ce": {"expected_assigned": 1}}
                gen, ce = worker.build_assignments(protocol, {"A": [(reader, 0)]}, panel)
                self.assertEqual(gen, ce)
                self.assertEqual(gen[0]["prefix_token_sha256"], worker.token_hash([10, 11]))
                self.assertNotEqual(gen[0]["prefix_token_sha256"], gen[0]["token_sha256"])
                self.assertEqual(gen[0]["sample_id"], "row1")
                self.assertNotIn("reference_text", gen[0])
            finally:
                reader.close()

    def test_native_hash_and_split_rejections(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            part, _, _ = self.fixture(root)
            (root / "tokens.bin").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "hash"):
                worker.NativeTokenRows(root, part)
            part, _, _ = self.fixture(root, split="train")
            with self.assertRaisesRegex(ValueError, "boundary/split"):
                worker.NativeTokenRows(root, part)

    def test_index_offset_and_individual_hash_rejections(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            part, row, _ = self.fixture(root)
            row["token_sha256"] = "0" * 64
            (root / "index.jsonl").write_text(json.dumps(row) + "\n")
            manifest = json.loads((root / "MANIFEST.json").read_text())
            manifest["files"]["index.jsonl"]["sha256"] = worker.digest(root / "index.jsonl")
            (root / "MANIFEST.json").write_text(json.dumps(manifest))
            reader = worker.NativeTokenRows(root, part)
            try:
                with self.assertRaisesRegex(ValueError, "row token"):
                    reader[0]
            finally:
                reader.close()

    def test_fatal_stops_preserve_one_failure_rest_not_run(self):
        assignments = [{"assignment_id": str(i), "model": "baseline", "task": "x", "sample_id": str(i)} for i in range(560)]
        records = [{**assignments[0], "execution_status": "failed", "error": "CUDA failure"}]
        reconciled = worker.reconcile(assignments, records)
        self.assertEqual(len(reconciled), 560)
        self.assertEqual(reconciled[0], records[0])
        self.assertEqual(sum(r["execution_status"] == "not_run" for r in reconciled), 559)
        with self.assertRaises(ValueError):
            worker.reconcile(assignments, records * 2)

    def test_stop_reason_eos_cap_timeout(self):
        self.assertEqual(worker.finish_reason([2], [2], True, 1), "eos")
        self.assertEqual(worker.finish_reason([4], [2], False, 1), "length")
        self.assertEqual(worker.finish_reason([4], [2], True, 8), "timeout")
        with self.assertRaises(RuntimeError):
            worker.finish_reason([4], [2], False, 8)

    def test_write_helpers_and_immutability(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "receipt.json"
            worker.save(path, {"private": "fixture"})
            worker.verify_files({str(path): worker.digest(path)})
            self.assertFalse((root / "receipt.json.tmp").exists())
            with self.assertRaises(ValueError):
                worker.verify_files({str(path): "0" * 64})
            with self.assertRaises(ValueError):
                worker.confined(root, "../outside")
            worker.append(root / "ledger.jsonl", {"id": 1})
            worker.append(root / "ledger.jsonl", {"id": 2})
            self.assertEqual(len((root / "ledger.jsonl").read_text().splitlines()), 2)

    def test_compute_profile_is_frozen(self):
        self.assertEqual(worker.CE_COMPUTE_PROFILE, {"name": "adaptive_gpu_head_v1", "gpu_max_sequence": 12288,
            "gpu_mlp_chunk": 512, "cpu_mlp_chunk": 512, "no_offload_max_sequence": 8192, "direct_mlp_max_sequence": 12288})

    def test_adapter_geometry_allows_optional_metadata_not_scaling_changes(self):
        config = {"r": 8, "lora_alpha": 16, "base_model_name_or_path": "base",
                  "target_modules": ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
                  "revision": None, "new_metadata": None}
        worker.validate_adapter_config(config, "base")
        for key, value in (("use_dora", True), ("use_rslora", True), ("rank_pattern", {"q_proj": 4}),
                           ("target_modules", ["q_proj"]), ("bias", "all")):
            with self.assertRaises(ValueError):
                worker.validate_adapter_config({**config, key: value}, "base")


if __name__ == "__main__":
    unittest.main()
