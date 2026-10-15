import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from counseling_pipeline.agent_evaluation import (
    canonical, digest, evaluate, load_suite, read_jsonl, templates, text_digest,
)


class AgentEvaluationTests(unittest.TestCase):
    """Synthetic execution fixtures test the auditor, never model performance."""

    @classmethod
    def setUpClass(cls):
        cls.cases, cls.protocol = load_suite()

    def setUp(self):
        self.records = templates(self.cases, self.protocol)

    def execute(self, sid, reviewed=False):
        record = next(r for r in self.records if r["scenario_id"] == sid)
        case = next(c for c in self.cases if c["case_id"] == record["case_id"])
        scenario = next(s for s in case["scenarios"] if s["scenario_id"] == sid)
        run = {"producer_id": "fixture-generator", "run_id": "unittest-only",
               "recorded_at": "2026-10-09T00:00:00+00:00", "actual_execution": True,
               "service_policy_version": "unittest-fixture-not-policy"}
        if case["kind"] == "response":
            run.update(model_id="synthetic-test-fixture-not-real-model", response="합성 테스트 출력입니다.",
                       input_messages=copy.deepcopy(scenario["input"]["messages"]))
            run["output_sha256"] = text_digest(run["response"])
            if case["case_id"] == "T29":
                run.update(input_token_count=12345, tokenizer_id="fixture-tokenizer-not-measurement")
        else:
            run.update(pipeline_version="unittest-only", artifacts=[])
            for future in case["future_fixtures"]:
                artifact = {"future_id": future["future_id"], "future_sha256": digest(future),
                            "input_messages": copy.deepcopy(scenario["input"]["messages"]),
                            "annotation": {"preferred_action": "SUPPORT", "target_response": "산책 제안 예시"}}
                artifact["artifact_sha256"] = digest(artifact)
                run["artifacts"].append(artifact)
            run["output_sha256"] = digest(run["artifacts"])
        record.update(status="executed", run=run)
        if reviewed:
            record["reviews"] = [{
                "reviewer_id": "fixture-independent-reviewer", "reviewer_kind": "human_independent",
                "independent_of_producer": True, "reviewed_at": "2026-10-09T01:00:00+00:00",
                "rubric_version": self.protocol["version"], "output_sha256": run["output_sha256"],
                "case_sha256": digest(case), "input_sha256": digest(scenario["input"]),
                "protocol_sha256": digest(self.protocol),
                "critical_failure": False, "rationale": "단위 테스트용 판정이며 실제 의미 검토가 아님",
                "criteria": {c["id"]: {"verdict": "pass", "rationale": "단위 테스트 fixture"}
                             for c in case["required_conditions"] + case["forbidden_conditions"]}}]
        return record

    def report(self):
        return evaluate(self.cases, self.protocol, self.records)

    def test_public_fixtures_have_30_groups_34_units_and_no_training_permission(self):
        self.assertEqual(len(self.cases), 30)
        self.assertEqual(len(self.records), 34)
        self.assertTrue(all(not c["training_allowed"] and not c["clinical_approval"] for c in self.cases))
        self.assertEqual(len({c["source"]["sha256"] for c in self.cases}), 1)
        self.assertEqual(len(self.cases[27]["scenarios"]), 4)
        lengths = [s["input_characters"] for s in self.cases[28]["scenarios"]]
        self.assertGreater(lengths[0], 6000)
        self.assertGreater(lengths[1], 24000)
        self.assertEqual(self.cases[-1]["kind"], "data_production")

    def test_default_not_run_never_implies_a_pass(self):
        report = evaluate(self.cases, self.protocol)
        self.assertEqual(report["summary"]["not_run_case_groups"], 30)
        self.assertEqual(report["summary"]["evaluated_case_groups"], 0)
        self.assertIsNone(report["summary"]["pass_rate_among_evaluated"])
        self.assertIsNone(report["independent_statistical_sample_count"])
        self.assertFalse(report["clinical_approval"])
        self.assertEqual(report["by_kind"]["data_production"]["total_case_groups"], 1)
        self.assertEqual({v["total_case_groups"] for v in report["by_category"].values()}, {6})

    def test_empty_group_rejected_by_loader_and_direct_evaluator(self):
        malformed = copy.deepcopy(self.cases)
        # Preserve 30 case IDs and 34 unique executions, just as the report's
        # counterexample does. Global counts alone must not validate this suite.
        malformed[0]["scenarios"].extend(malformed[-1]["scenarios"])
        malformed[-1]["scenarios"] = []
        with self.assertRaisesRegex(ValueError, "membership|nonempty"):
            evaluate(malformed, self.protocol)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "adversarial_cases.jsonl").write_text("".join(canonical(c) + "\n" for c in malformed))
            (root / "evaluation_protocol.json").write_text(canonical(self.protocol))
            with self.assertRaisesRegex(ValueError, "membership|nonempty"):
                load_suite(root)

    def test_direct_evaluator_rejects_empty_or_invalid_group_definitions(self):
        for invalid in ([], None, {}, "T30"):
            with self.subTest(invalid=invalid):
                cases = copy.deepcopy(self.cases)
                cases[-1]["scenarios"] = invalid
                with self.assertRaisesRegex(ValueError, "nonempty"):
                    evaluate(cases, self.protocol)
        with self.assertRaisesRegex(ValueError, "nonempty"):
            evaluate([], self.protocol)
        cases = copy.deepcopy(self.cases)
        cases[0]["scenarios"], cases[1]["scenarios"] = cases[1]["scenarios"], cases[0]["scenarios"]
        with self.assertRaisesRegex(ValueError, "membership"):
            evaluate(cases, self.protocol)
        cases = copy.deepcopy(self.cases)
        cases[-1]["future_fixtures"] = []
        with self.assertRaisesRegex(ValueError, "two future fixtures"):
            evaluate(cases, self.protocol)

    def test_output_without_review_is_not_evaluated(self):
        self.execute("T01")
        report = self.report()
        self.assertEqual(report["execution_units"][0]["status"], "needs_review")
        self.assertEqual(report["summary"]["evaluated_case_groups"], 0)
        self.assertEqual(report["summary"]["incomplete_case_groups"], 1)

    def test_different_candidate_outputs_cannot_be_pooled(self):
        self.execute("T01", reviewed=True)
        record = self.execute("T02", reviewed=True)
        record["run"]["model_id"] = "different-fixture-model"
        with self.assertRaisesRegex(ValueError, "separate candidate ledgers"):
            self.report()

    def test_all_condition_review_enables_only_one_group(self):
        self.execute("T01", reviewed=True)
        report = self.report()
        self.assertEqual(report["summary"]["evaluated_case_groups"], 1)
        self.assertEqual(report["summary"]["passed_case_groups"], 1)
        self.assertEqual(report["summary"]["not_run_case_groups"], 29)
        self.assertEqual(report["by_category"]["source_state"]["pass_rate_denominator"], 1)

    def test_missing_duplicate_unknown_and_stale_hash_records_are_rejected(self):
        modifications = [lambda x: x.pop(), lambda x: x.append(dict(x[0])),
                         lambda x: x[0].update(scenario_id="T99"),
                         lambda x: x[0].update(case_id="T02"),
                         lambda x: x[0].update(input_sha256="0" * 64),
                         lambda x: x[0].update(case_sha256="0" * 64),
                         lambda x: x[0].update(protocol_sha256="0" * 64)]
        for mutate in modifications:
            with self.subTest(mutate=mutate):
                rows = copy.deepcopy(self.records)
                mutate(rows)
                with self.assertRaises(ValueError):
                    evaluate(self.cases, self.protocol, rows)

    def test_output_edit_invalidates_execution_and_review_hashes(self):
        record = self.execute("T01", reviewed=True)
        record["run"]["response"] = "편집된 출력"
        with self.assertRaisesRegex(ValueError, "execution output hash"):
            self.report()
        record["run"]["output_sha256"] = text_digest(record["run"]["response"])
        with self.assertRaisesRegex(ValueError, "review output hash"):
            self.report()

    def test_same_output_review_cannot_be_copied_to_another_case(self):
        first = self.execute("T01", reviewed=True)
        second = self.execute("T02", reviewed=True)
        self.assertEqual(first["run"]["output_sha256"], second["run"]["output_sha256"])
        second["reviews"] = copy.deepcopy(first["reviews"])
        with self.assertRaisesRegex(ValueError, "review case_sha256 mismatch"):
            self.report()

    def test_same_case_review_cannot_be_copied_to_another_variant(self):
        first = self.execute("T28-a", reviewed=True)
        second = self.execute("T28-b", reviewed=True)
        self.assertEqual(first["case_sha256"], second["case_sha256"])
        self.assertEqual(first["run"]["output_sha256"], second["run"]["output_sha256"])
        second["reviews"] = copy.deepcopy(first["reviews"])
        with self.assertRaisesRegex(ValueError, "review input_sha256 mismatch"):
            self.report()

    def test_review_requires_each_exact_context_hash(self):
        record = self.execute("T01", reviewed=True)
        original = copy.deepcopy(record["reviews"][0])
        for field in ("case_sha256", "input_sha256", "protocol_sha256"):
            for missing in (True, False):
                with self.subTest(field=field, missing=missing):
                    record["reviews"] = [copy.deepcopy(original)]
                    if missing:
                        record["reviews"][0].pop(field)
                    else:
                        record["reviews"][0][field] = "0" * 64
                    with self.assertRaisesRegex(ValueError, f"review {field} mismatch"):
                        self.report()

    def test_unlinked_input_and_faked_not_run_are_rejected(self):
        record = self.execute("T01")
        record["run"]["input_messages"] = [{"role": "user", "content": "다른 입력"}]
        with self.assertRaisesRegex(ValueError, "input_messages differ"):
            self.report()
        record["status"] = "not_run"
        with self.assertRaisesRegex(ValueError, "not_run must not"):
            self.report()

    def test_self_review_keyword_check_and_missing_condition_are_rejected(self):
        original = self.execute("T01", reviewed=True)
        for change in [lambda r: r.update(reviewer_id="fixture-generator"),
                       lambda r: r.update(reviewer_kind="keyword_checker"),
                       lambda r: r.update(independent_of_producer=False),
                       lambda r: r["criteria"].pop("F1"),
                       lambda r: r.update(reviewed_at="2026-10-08T00:00:00+00:00")]:
            with self.subTest(change=change):
                self.records = templates(self.cases, self.protocol)
                self.records[0] = copy.deepcopy(original)
                change(self.records[0]["reviews"][0])
                with self.assertRaises(ValueError):
                    self.report()

    def test_review_failure_uncertainty_and_disagreement_are_not_passes(self):
        record = self.execute("T13", reviewed=True)
        record["reviews"][0]["criteria"]["F1"]["verdict"] = "fail"
        self.assertEqual(self.report()["summary"]["failed_case_groups"], 1)
        record["reviews"][0]["criteria"]["F1"]["verdict"] = "uncertain"
        self.assertEqual(self.report()["summary"]["inconclusive_case_groups"], 1)
        other = copy.deepcopy(record["reviews"][0])
        other["reviewer_id"] = "fixture-second-reviewer"
        other["criteria"]["F1"]["verdict"] = "pass"
        record["reviews"].append(other)
        report = self.report()
        self.assertEqual(report["summary"]["inconclusive_case_groups"], 1)
        self.assertTrue(next(u for u in report["execution_units"] if u["scenario_id"] == "T13")["review_disagreement"])
        record["reviews"][0]["critical_failure"] = True
        self.assertEqual(self.report()["summary"]["failed_case_groups"], 1)

    def test_confirmed_condition_failure_survives_other_uncertainty(self):
        for reviewer_count in (1, 2):
            with self.subTest(reviewer_count=reviewer_count):
                self.records = templates(self.cases, self.protocol)
                record = self.execute("T13", reviewed=True)
                record["reviews"][0]["criteria"]["F1"].update(verdict="fail", rationale="금지된 강압 표현이라는 합성 판정")
                if reviewer_count == 2:
                    record["reviews"].append(copy.deepcopy(record["reviews"][0]))
                    record["reviews"][1]["reviewer_id"] = "fixture-reviewer-b"
                record["reviews"][-1]["criteria"]["R1"]["verdict"] = "uncertain"
                report = self.report()
                unit = next(u for u in report["execution_units"] if u["scenario_id"] == "T13")
                self.assertEqual(unit["outcome"], "fail")
                self.assertEqual(report["summary"]["failed_case_groups"], 1)
                self.assertEqual(report["summary"]["inconclusive_case_groups"], 0)
                self.assertEqual(unit["condition_results"]["F1"]["verdict_counts"], {"fail": reviewer_count})
                self.assertIn("강압", unit["condition_results"]["F1"]["reviews"][0]["rationale"])
                self.assertTrue(unit["condition_results"]["R1"]["has_uncertainty"])
                self.assertEqual(unit["review_disagreement"], reviewer_count == 2)

    def test_condition_consensus_controls_distinguish_disputed_failure(self):
        controls = [("pass", "pass", "pass"), ("fail", "fail", "fail"),
                    ("fail", "pass", "inconclusive"), ("fail", "uncertain", "inconclusive"),
                    ("uncertain", "uncertain", "inconclusive")]
        for left, right, expected in controls:
            with self.subTest(left=left, right=right):
                self.records = templates(self.cases, self.protocol)
                record = self.execute("T13", reviewed=True)
                record["reviews"].append(copy.deepcopy(record["reviews"][0]))
                record["reviews"][1]["reviewer_id"] = "fixture-reviewer-b"
                for review, verdict in zip(record["reviews"], (left, right)):
                    review["criteria"]["F1"]["verdict"] = verdict
                report = self.report()
                unit = next(u for u in report["execution_units"] if u["scenario_id"] == "T13")
                self.assertEqual(unit["outcome"], expected)
                self.assertEqual(unit["condition_results"]["F1"]["outcome"], expected)

    def test_variants_are_one_group_and_partial_execution_cannot_pass(self):
        self.execute("T28-a", reviewed=True)
        self.assertEqual(self.report()["summary"]["evaluated_case_groups"], 0)
        for sid in ("T28-b", "T28-c", "T28-d"):
            self.execute(sid, reviewed=True)
        self.assertEqual(self.report()["summary"]["evaluated_case_groups"], 1)
        self.assertEqual(self.report()["summary"]["total_case_groups"], 30)

    def test_long_context_requires_actual_token_measurement_and_all_lengths(self):
        record = self.execute("T29-64", reviewed=True)
        record["run"].pop("input_token_count")
        with self.assertRaisesRegex(ValueError, "input_token_count"):
            self.report()
        record["run"]["input_token_count"] = 100
        self.execute("T29-256", reviewed=True)
        report = self.report()
        self.assertEqual(report["summary"]["evaluated_case_groups"], 1)
        self.assertEqual(next(u for u in report["execution_units"] if u["scenario_id"] == "T29-64")["input_token_count"], 100)

    def test_t30_output_text_cannot_replace_production_evidence(self):
        record = self.execute("T30", reviewed=True)
        record["run"].pop("artifacts")
        record["run"]["response"] = "현재 입력만 썼습니다."
        with self.assertRaisesRegex(ValueError, "production artifacts"):
            self.report()

    def test_t30_future_leakage_fails_even_when_review_says_pass(self):
        record = self.execute("T30", reviewed=True)
        self.assertEqual(self.report()["by_kind"]["data_production"]["passed_case_groups"], 1)
        artifact = record["run"]["artifacts"][1]
        artifact["annotation"]["preferred_action"] = "SAFETY_SUPPORT"
        artifact["artifact_sha256"] = digest({k: v for k, v in artifact.items() if k != "artifact_sha256"})
        record["run"]["output_sha256"] = digest(record["run"]["artifacts"])
        record["reviews"][0]["output_sha256"] = record["run"]["output_sha256"]
        report = self.report()
        self.assertEqual(report["by_kind"]["data_production"]["failed_case_groups"], 1)
        self.assertFalse(report["execution_units"][-1]["structural_invariance"])

    def test_t30_wrong_artifact_or_future_hash_rejected(self):
        record = self.execute("T30")
        record["run"]["artifacts"][0]["artifact_sha256"] = "x"
        with self.assertRaisesRegex(ValueError, "artifact hash"):
            self.report()
        record["run"]["artifacts"][0]["future_sha256"] = "x"
        with self.assertRaisesRegex(ValueError, "future hash"):
            self.report()

    def test_t30_exact_json_invariance_preserves_boolean_and_number_types(self):
        for left, right, invariant in ((False, 0, False), (True, 1, False), (1, 1.0, False),
                                       (False, False, True), (0, 0, True)):
            with self.subTest(left=left, right=right, invariant=invariant):
                self.records = templates(self.cases, self.protocol)
                record = self.execute("T30", reviewed=True)
                for artifact, value in zip(record["run"]["artifacts"], (left, right)):
                    artifact["annotation"]["state_evidence"] = {"was_refused": value}
                    artifact["artifact_sha256"] = digest({k: v for k, v in artifact.items() if k != "artifact_sha256"})
                record["run"]["output_sha256"] = digest(record["run"]["artifacts"])
                record["reviews"][0]["output_sha256"] = record["run"]["output_sha256"]
                report = self.report()
                self.assertEqual(report["execution_units"][-1]["structural_invariance"], invariant)
                self.assertEqual(report["groups"][-1]["outcome"], "pass" if invariant else "fail")

    def test_t30_object_key_order_does_not_change_invariance(self):
        record = self.execute("T30", reviewed=True)
        artifact = record["run"]["artifacts"][1]
        artifact["annotation"] = dict(reversed(list(artifact["annotation"].items())))
        # Canonical artifact and output hashes stay valid after a key reorder.
        report = self.report()
        self.assertTrue(report["execution_units"][-1]["structural_invariance"])
        self.assertEqual(report["groups"][-1]["outcome"], "pass")

    def test_json_duplicate_keys_and_nan_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "records.jsonl"
            for bad in ['{"status":"not_run","status":"executed"}', '{"score":NaN}']:
                path.write_text(bad)
                with self.assertRaises(ValueError):
                    read_jsonl(path)

    def test_cli_template_and_audit_do_not_invoke_model(self):
        with tempfile.TemporaryDirectory() as folder:
            ledger = Path(folder) / "records.jsonl"
            command = [sys.executable, "-m", "counseling_pipeline.agent_evaluation"]
            subprocess.run(command + ["--template", str(ledger)], check=True, capture_output=True)
            result = subprocess.run(command + ["--records", str(ledger)], check=True, capture_output=True, text=True)
            report = json.loads(result.stdout)
            self.assertEqual(report["summary"]["not_run_case_groups"], 30)
            self.assertEqual(report["model_invocations_by_this_tool"], 0)
            ledger.write_text(canonical(self.records[0]) + "\n")
            failed = subprocess.run(command + ["--records", str(ledger)], capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertIn("missing scenario IDs", failed.stderr)


if __name__ == "__main__":
    unittest.main()
