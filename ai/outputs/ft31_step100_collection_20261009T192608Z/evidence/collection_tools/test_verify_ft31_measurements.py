"""Saved-file verifier regression tests; no tokenizer, model, or API calls."""
import json
from pathlib import Path
import tempfile
import unittest

import verify_ft31_measurements as v


def save_json(root, name, value):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def save_jsonl(root, name, values):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"".join(v.canonical(value) + b"\n" for value in values))


def fixture(root):
    run_id = "FT31_STEP100_fixture"
    cases, baseline, rows, preflight = [], [], [], []
    specs = [("response", "DEV001", "legacy_validation_development", "PRIVATE_INPUT_MARKER", "PRIVATE_ANSWER_MARKER"),
             ("response", "PUBLIC001", "synthetic_public_regression", "공개 상담 입력", "공개 상담 답변"),
             ("action", "PUBLIC001", "synthetic_public_regression", "공개 분류 입력", "SUPPORT")]
    for task, case_id, split, text, answer in specs:
        stem = task + "_" + case_id
        input_name = "private/inputs/" + stem + ".json"
        request_name = "private/requests/" + stem + ".json"
        attempt_name = "private/attempts/" + stem + ".json"
        raw_name = "private/raw/" + stem + ".json"
        answer_name = "private/responses/" + stem + ".txt"
        item = {"task": task, "case_id": case_id, "messages": [{"role": "user", "content": text}]}
        save_json(root, input_name, item)
        save_json(root, "source_baseline/" + input_name, item)
        baseline_request = {"model": "gemma4:12b", "messages": item["messages"],
                            "options": {"num_predict": v.RESERVATIONS[task], "num_ctx": 4096}}
        save_json(root, "source_baseline/" + request_name, baseline_request)
        case = {"task": task, "case_id": case_id, "split": split, "source_group_id": "group_" + case_id,
                "input_file": input_name, "input_sha256": v.sha(v.canonical(item)),
                "input_tokens_preflight": 12, "request_file": request_name,
                "request_sha256": v.sha((root / "source_baseline" / request_name).read_bytes())}
        cases.append(case)
        preflight.append({"task": task, "case_id": case_id, "eligible": True,
                          "input_tokens_preflight": 13, "exclusion_reason": None})
        baseline_answer = root / "source_baseline" / answer_name
        baseline_answer.parent.mkdir(parents=True, exist_ok=True)
        baseline_answer.write_bytes(answer.encode("utf-8"))
        baseline.append({"run_id": "BASE12_fixture", "condition": "BASE12", "attempt_index": 1,
                         **{key: case[key] for key in ("task", "case_id", "split", "source_group_id", "input_sha256")},
                         "private_response_file": answer_name, "response_sha256": v.sha(answer.encode("utf-8")),
                         "status": "valid", "input_tokens_preflight": 12, "input_tokens": 12,
                         "generated_tokens": 3, "max_new_tokens": v.RESERVATIONS[task],
                         "predicted_label": answer if task == "action" else None})
        request = {"model": v.MODEL_ID, "messages": item["messages"], "max_tokens": v.RESERVATIONS[task],
                   "temperature": 0, "stream": False}
        save_json(root, request_name, request)
        request_hash = v.sha((root / request_name).read_bytes())
        generation_id = run_id + "_" + stem
        save_json(root, attempt_name, {"run_id": run_id, "generation_id": generation_id,
            "task": task, "case_id": case_id, "attempt_index": 1, "started_at": "2026-10-09T00:00:00+00:00",
            "request_file": request_name, "request_sha256": request_hash})
        raw = {"model": v.MODEL_ID, "system_fingerprint": v.FINGERPRINT,
               "choices": [{"message": {"role": "assistant", "content": answer}, "finish_reason": "stop"}],
               "usage": {"prompt_tokens": 13, "completion_tokens": 3, "total_tokens": 16}}
        save_json(root, raw_name, raw)
        (root / answer_name).parent.mkdir(parents=True, exist_ok=True)
        (root / answer_name).write_bytes(answer.encode("utf-8"))
        rows.append({"run_id": run_id, "generation_id": generation_id, "attempt_index": 1,
            "condition": v.CONDITION, "model_id": v.MODEL_ID, "checkpoint_sha256": v.CHECKPOINT_SHA256,
            "adapter_file_sha256": v.ADAPTER_SHA256,
            **{key: case[key] for key in ("task", "case_id", "split", "source_group_id", "input_sha256")},
            "request_file": request_name, "attempt_file": attempt_name, "request_sha256": request_hash,
            "raw_response_file": raw_name, "private_response_file": answer_name,
            "raw_response_sha256": v.sha((root / raw_name).read_bytes()),
            "response_sha256": v.sha(answer.encode("utf-8")), "input_tokens_preflight": 13,
            "input_tokens": 13, "generated_tokens": 3, "max_new_tokens": v.RESERVATIONS[task],
            "started_at": "2026-10-09T00:00:00+00:00", "completed_at": "2026-10-09T00:00:01+00:00",
            "http_status": 200, "finish_reason": "stop", "status": "valid", "error": None,
            "system_fingerprint": v.FINGERPRINT, "predicted_label": answer if task == "action" else None})
    save_jsonl(root, "case_manifest.jsonl", cases)
    save_jsonl(root, "source_baseline/case_manifest.jsonl", cases)
    save_jsonl(root, "source_baseline/generations.jsonl", baseline)
    save_json(root, "source_baseline/run_manifest.json", {"run_id": "BASE12_fixture", "condition": "BASE12",
              "case_manifest_sha256": v.sha((root / "case_manifest.jsonl").read_bytes())})
    save_json(root, "preflight.json", {"cases": preflight})
    save_json(root, "evidence/health_before.json", {"status": "ready", "model": v.MODEL_ID,
              "checkpoint_step": 100, "checkpoint_sha256": v.CHECKPOINT_SHA256,
              "system_fingerprint": v.FINGERPRINT})
    save_json(root, "run_manifest.json", {"run_id": run_id, "condition": v.CONDITION,
              "model_id": v.MODEL_ID, "checkpoint_step": 100, "checkpoint_sha256": v.CHECKPOINT_SHA256,
              "adapter_file_sha256": v.ADAPTER_SHA256,
              "case_manifest_sha256": v.sha((root / "case_manifest.jsonl").read_bytes()),
              "preflight_sha256": v.sha((root / "preflight.json").read_bytes()),
              "health_before_sha256": v.sha((root / "evidence/health_before.json").read_bytes()),
              "expected_system_fingerprint": v.FINGERPRINT,
              "source_baseline_hashes": {str(path.relative_to(root / "source_baseline")): v.sha(path.read_bytes())
                                         for path in (root / "source_baseline").rglob("*") if path.is_file()},
              "response_max_new_tokens": 512, "classification_max_new_tokens": 32,
              "comparison_context_tokens": 4096, "temperature": 0, "concurrency": 1,
              "attempts_per_case": 1, "enable_thinking": False, "stream": False, "input_truncation": False})
    update_records(root, rows)
    return rows


def update_records(root, rows, state="complete"):
    save_jsonl(root, "generations.jsonl", rows)
    attempts = len(list((root / "private/attempts").glob("*.json")))
    save_json(root, "COLLECTION_COMPLETE.json", {"run_id": "FT31_STEP100_fixture", "assigned": 3,
              "excluded": 0, "attempted": attempts, "responses": sum(row["http_status"] == 200 for row in rows),
              "unexecuted": 3 - attempts, "ledger_records": len(rows), "state": state,
              "generations_sha256": v.sha((root / "generations.jsonl").read_bytes())})


def health_bind(root, row, fingerprint=v.FINGERPRINT):
    health = {"status": "ready", "model": v.MODEL_ID, "checkpoint_step": 100,
              "checkpoint_sha256": v.CHECKPOINT_SHA256, "model_fingerprint": fingerprint, "pid": 4488}
    for phase in ("before", "after"):
        name = "evidence/identity/" + row["task"] + "_" + row["case_id"] + "_" + phase + ".json"
        save_json(root, name, health)
        row["identity_" + phase + "_file"] = name
        row["identity_" + phase + "_sha256"] = v.sha((root / name).read_bytes())
    row["verified_model_fingerprint"] = fingerprint
    row["model_identity_source"] = "authenticated_health_before_after"


def remove_raw_fingerprint(root, row):
    raw_path = root / row["raw_response_file"]
    raw = json.loads(raw_path.read_text())
    raw.pop("system_fingerprint")
    save_json(root, row["raw_response_file"], raw)
    row["system_fingerprint"] = None
    row["raw_response_sha256"] = v.sha(raw_path.read_bytes())
    return raw


class VerifierTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.rows = fixture(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def verify(self, export=False):
        return v.verify(self.root, expected_assigned=3, export=export)

    def test_valid_exports_and_public_boundary(self):
        result = self.verify(export=True)
        self.assertTrue(result["verification"]["verified"])
        self.assertEqual(result["metrics"]["overall"]["generated_tokens"]["sum"], 9)
        self.assertEqual(result["metrics"]["by_task"]["action"]["label_counts"]["END"], 0)
        public = (self.root / "public_answers.md").read_text()
        self.assertIn("PUBLIC001", public)
        self.assertNotIn("DEV001", public)
        self.assertNotIn("PRIVATE_INPUT_MARKER", public)
        self.assertNotIn("PRIVATE_ANSWER_MARKER", public)
        self.assertTrue((self.root / "verify_measurements.py").is_file())
        self.verify(export=True)  # Regeneration is deterministic and preserves evidence.

    def test_raw_tamper_rejected(self):
        path = self.root / self.rows[0]["raw_response_file"]
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(v.VerificationError, "Raw response hash"):
            self.verify()

    def test_health_model_fingerprint_alias_supported(self):
        path = self.root / "evidence/health_before.json"
        health = json.loads(path.read_text())
        health["model_fingerprint"] = health.pop("system_fingerprint")
        save_json(self.root, "evidence/health_before.json", health)
        manifest = json.loads((self.root / "run_manifest.json").read_text())
        manifest["health_before_sha256"] = v.sha(path.read_bytes())
        save_json(self.root, "run_manifest.json", manifest)
        self.assertTrue(self.verify()["verification"]["verified"])

    def test_documented_runtime_fingerprint_is_frozen_and_supported(self):
        fingerprint = "5e266a95c9846ca08d62a2e86c0ca8dec3b012b31bc46d0fb411155ba138caec"
        health_path = self.root / "evidence/health_before.json"
        health = json.loads(health_path.read_text())
        health["model_fingerprint"] = fingerprint
        health.pop("system_fingerprint")
        save_json(self.root, "evidence/health_before.json", health)
        manifest = json.loads((self.root / "run_manifest.json").read_text())
        manifest.update(expected_system_fingerprint=fingerprint,
                        requested_system_fingerprint=v.FINGERPRINT,
                        system_fingerprint_discrepancy="Serving policy uses a full runtime fingerprint.",
                        health_before_sha256=v.sha(health_path.read_bytes()))
        save_json(self.root, "run_manifest.json", manifest)
        for row in self.rows:
            raw_path = self.root / row["raw_response_file"]
            raw = json.loads(raw_path.read_text())
            raw["system_fingerprint"] = fingerprint
            save_json(self.root, row["raw_response_file"], raw)
            row["system_fingerprint"] = fingerprint
            row["raw_response_sha256"] = v.sha(raw_path.read_bytes())
        update_records(self.root, self.rows)
        self.assertTrue(self.verify()["verification"]["verified"])

    def test_duplicate_first_attempt_rejected(self):
        update_records(self.root, self.rows + [self.rows[0]])
        with self.assertRaisesRegex(v.VerificationError, "Duplicate first attempt"):
            self.verify()

    def test_missing_answer_file_rejected(self):
        (self.root / self.rows[0]["private_response_file"]).unlink()
        with self.assertRaisesRegex(v.VerificationError, "Missing evidence file"):
            self.verify()

    def test_wrong_fingerprint_rejected_even_with_matching_row_hash(self):
        row = self.rows[0]
        raw = json.loads((self.root / row["raw_response_file"]).read_text())
        raw["system_fingerprint"] = "other-model"
        save_json(self.root, row["raw_response_file"], raw)
        row["raw_response_sha256"] = v.sha((self.root / row["raw_response_file"]).read_bytes())
        row["system_fingerprint"] = "other-model"
        row["status"] = "identity_mismatch"
        update_records(self.root, self.rows)
        with self.assertRaisesRegex(v.VerificationError, "fingerprint identity mismatch"):
            self.verify()

    def test_absent_raw_fingerprint_requires_explicit_health_binding(self):
        row = self.rows[0]
        raw = remove_raw_fingerprint(self.root, row)
        self.assertEqual(v.derive_status(raw, "response", 13), "identity_mismatch")
        update_records(self.root, self.rows)
        with self.assertRaisesRegex(v.VerificationError, "Missing verified health identity"):
            self.verify()

    def test_absent_raw_fingerprint_valid_with_before_after_health_binding(self):
        row = self.rows[0]
        raw = remove_raw_fingerprint(self.root, row)
        health_bind(self.root, row)
        update_records(self.root, self.rows)
        self.assertTrue(self.verify()["verification"]["verified"])
        self.assertNotIn("system_fingerprint", raw)
        self.assertIsNone(row["system_fingerprint"])

    def test_health_binding_changed_pid_rejected_even_with_updated_hash(self):
        row = self.rows[0]
        remove_raw_fingerprint(self.root, row)
        health_bind(self.root, row)
        path = self.root / row["identity_after_file"]
        health = json.loads(path.read_text())
        health["pid"] = 4489
        save_json(self.root, row["identity_after_file"], health)
        row["identity_after_sha256"] = v.sha(path.read_bytes())
        update_records(self.root, self.rows)
        with self.assertRaisesRegex(v.VerificationError, "PID changed"):
            self.verify()

    def test_health_binding_snapshot_tamper_rejected(self):
        row = self.rows[0]
        remove_raw_fingerprint(self.root, row)
        health_bind(self.root, row)
        path = self.root / row["identity_after_file"]
        path.write_bytes(path.read_bytes() + b" ")
        update_records(self.root, self.rows)
        with self.assertRaisesRegex(v.VerificationError, "snapshot hash mismatch"):
            self.verify()

    def test_health_binding_cannot_override_different_raw_fingerprint(self):
        row = self.rows[0]
        health_bind(self.root, row)
        raw_path = self.root / row["raw_response_file"]
        raw = json.loads(raw_path.read_text())
        raw["system_fingerprint"] = "other-model"
        save_json(self.root, row["raw_response_file"], raw)
        row["raw_response_sha256"] = v.sha(raw_path.read_bytes())
        row["system_fingerprint"] = "other-model"
        row["status"] = "identity_mismatch"
        update_records(self.root, self.rows)
        with self.assertRaisesRegex(v.VerificationError, "fingerprint identity mismatch"):
            self.verify()

    def test_input_serialization_tamper_rejected(self):
        path = self.root / "private/inputs/response_DEV001.json"
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaisesRegex(v.VerificationError, "Input byte copy mismatch"):
            self.verify()

    def test_missing_first_attempt_keeps_denominator_and_blank_rates(self):
        row = self.rows.pop()
        for field in ("request_file", "attempt_file", "raw_response_file", "private_response_file"):
            (self.root / row[field]).unlink()
        update_records(self.root, self.rows, state="partial")
        result = self.verify()
        action = result["metrics"]["by_task"]["action"]
        self.assertEqual(action["eligible"], 1)
        self.assertEqual(action["unexecuted"], 1)
        self.assertIsNone(action["final_valid_rate"]["percent"])
        self.assertIsNone(result["metrics"]["paired_BASE12"]["action"]["difference_percentage_points"])
        self.assertEqual(action["generated_tokens"], {"observed": 0, "missing": 1, "sum": 0, "min": None, "max": None})

    def test_interrupted_attempt_counted_as_unknown_completion(self):
        row = self.rows.pop()
        for field in ("raw_response_file", "private_response_file"):
            (self.root / row[field]).unlink()
        update_records(self.root, self.rows, state="interrupted")
        action = self.verify()["metrics"]["by_task"]["action"]
        self.assertEqual(action["attempted"], 1)
        self.assertEqual(action["unexecuted"], 0)
        self.assertEqual(action["status_counts"]["unknown_completion"], 1)
        self.assertIsNone(action["final_valid_rate"]["percent"])

    def test_error_measurements_remain_null(self):
        row = self.rows[-1]
        (self.root / row["private_response_file"]).unlink()
        save_json(self.root, row["raw_response_file"], {"error": "HTTP busy"})
        row.update(http_status=429, error={"message": "HTTP busy"}, status="http_error",
                   private_response_file=None, response_sha256=None, system_fingerprint=None,
                   finish_reason=None, input_tokens=None, generated_tokens=None, predicted_label=None)
        row["raw_response_sha256"] = v.sha((self.root / row["raw_response_file"]).read_bytes())
        update_records(self.root, self.rows, state="blocked")
        result = self.verify()
        action = result["metrics"]["by_task"]["action"]
        self.assertEqual(action["final_valid_rate"]["percent"], 0)
        self.assertEqual(action["generated_tokens"]["missing"], 1)
        self.assertIsNone(action["generated_tokens"]["min"])

    def test_existing_aggregate_tamper_rejected(self):
        self.verify(export=True)
        metrics = json.loads((self.root / "metrics.json").read_text())
        metrics["overall"]["valid"] = 999
        save_json(self.root, "metrics.json", metrics)
        with self.assertRaisesRegex(v.VerificationError, "aggregate metrics mismatch"):
            self.verify()

    def test_fabricated_completion_rejected(self):
        row = self.rows.pop()
        for field in ("request_file", "attempt_file", "raw_response_file", "private_response_file"):
            (self.root / row[field]).unlink()
        update_records(self.root, self.rows, state="complete")
        with self.assertRaisesRegex(v.VerificationError, "claims complete"):
            self.verify()


if __name__ == "__main__":
    unittest.main()
