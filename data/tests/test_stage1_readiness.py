import copy
import hashlib
from pathlib import Path
import tempfile
import unittest

from counseling_pipeline import stage1_readiness as gate
from counseling_pipeline.gemma4_generation_validation import deterministic_generation_config


class Stage1ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.bindings = {key: hashlib.sha256(key.encode()).hexdigest() for key in gate.BINDING_KEYS}
        self.names = ("token_contract", "fused_loss", "fused_gradient", "generation_profile",
                      "gpu_pin", "weights_unchanged")
        self.report = {
            "schema_version": gate.SCHEMA_VERSION, "mode": "preparation",
            "status": "passed", "optimizer_steps": 0, "bindings": self.bindings,
            "checks": [{"name": name, "passed": True, "evidence": {"recorded": True}}
                       for name in self.names],
        }
        self.report["checks"][1]["evidence"] = {
            "criterion": "bf16_linear_fp32_softcap_v1",
            "comparisons": [{"name": "actual_model_all", "actual": 1.0, "reference": 1.0,
                             "atol": 0.002, "rtol": 0.002, "passed": True}] + [
                {"name": f"{part}_chunks_{chunks}", "actual": 1.0, "reference": 1.0,
                 "atol": 0.002, "rtol": 0.002, "passed": True, "supervised_items": 3 if part == "all" else 1}
                for chunks in (1, 3, 8) for part in ("all", "first", "body", "end")],
            "chunks": [1, 3, 8], "compiled": True, "per_token_reference_ce": [1.0, 1.0, 1.0],
            "shifted_label_positions": [[0, 1], [0, 2], [0, 3]], "wrong_unshifted_ce": 2.0,
        }
        self.report["checks"][2]["evidence"] = {
            "criterion": "hidden_gradient_bf16_v1",
            "results": [{"name": name, "relative_l2_error": 0.001, "maximum_relative_l2_error": 0.02,
                         "cosine": 0.9999, "minimum_cosine": 0.999, "reference_norm": 0.1, "passed": True}
                        for name in ("actual_model_hidden", "chunks_1", "chunks_3", "chunks_8")],
        }
        config = deterministic_generation_config(max_new_tokens=8)
        case = {"prefix_ids": [2, 17], "actual_prefill_ids": [2, 17], "effective_config": config,
                "inspection": {"generation_profile_verified": True,
                               "no_extra_logits_processors": True, "no_extra_stopping_criteria": True,
                               "effective_generation_config": config,
                               "generation_config_sha256": gate.canonical_sha256(config),
                               "raw_suffix_ids": [777, 106], "generated_tokens": 2, "body": "답",
                               "body_sha256": hashlib.sha256("답".encode()).hexdigest(),
                               "semantic_completeness": "not_assessed", "cap_censored": False}}
        self.report["checks"][3]["evidence"] = {
            "cases": [{**copy.deepcopy(case), "case": name} for name in ("synthetic", "source")]}

    def validate(self, report=None, **kwargs):
        return gate.validate_report(self.report if report is None else report,
                                    expected_bindings=self.bindings, required_checks=self.names,
                                    expected_check_contracts={"fused_loss": "bf16_linear_fp32_softcap_v1"},
                                    **kwargs)

    def test_full_preparation_report_passes_without_mutation(self):
        before = copy.deepcopy(self.report)
        self.assertEqual(self.validate(), before)
        self.assertEqual(self.report, before)

    def test_only_exact_passed_status_is_accepted(self):
        for value in (None, "passed_with_bf16_branch_difference", "PASSED", "pass", True, 1):
            with self.subTest(value=value):
                bad = copy.deepcopy(self.report); bad["status"] = value
                with self.assertRaises(gate.ReadinessError): self.validate(bad)

    def test_empty_missing_duplicate_or_failed_checks_fail(self):
        cases = [[], self.report["checks"][:-1], self.report["checks"] * 2]
        for results in cases:
            with self.subTest(results=results):
                bad = copy.deepcopy(self.report); bad["checks"] = results
                with self.assertRaises(gate.ReadinessError): self.validate(bad)
        for value in (False, 1, "true", None):
            bad = copy.deepcopy(self.report); bad["checks"][0]["passed"] = value
            with self.assertRaises(gate.ReadinessError): self.validate(bad)
        bad = copy.deepcopy(self.report); bad["checks"][0]["evidence"] = {}
        with self.assertRaises(gate.ReadinessError): self.validate(bad)
        bad = copy.deepcopy(self.report)
        bad["checks"].append({"name": "extra", "passed": False, "evidence": {"reason": "failed"}})
        with self.assertRaises(gate.ReadinessError): self.validate(bad)

    def test_stale_identity_or_missing_binding_fails(self):
        for key in self.bindings:
            bad = copy.deepcopy(self.report); bad["bindings"][key] = "0" * 64
            with self.assertRaises(gate.ReadinessError): self.validate(bad)
            del bad["bindings"][key]
            with self.assertRaises(gate.ReadinessError): self.validate(bad)
        bad = copy.deepcopy(self.report); bad["bindings"]["extra_sha256"] = "a" * 64
        with self.assertRaises(gate.ReadinessError): self.validate(bad)

    def test_modes_cannot_misrepresent_optimizer_execution(self):
        for value in (True, -1, 1.0, "0", 1, None):
            bad = copy.deepcopy(self.report); bad["optimizer_steps"] = value
            with self.assertRaises(gate.ReadinessError): self.validate(bad)
        bad = copy.deepcopy(self.report); bad["mode"] = "optimizer_canary"
        with self.assertRaises(gate.ReadinessError): self.validate(bad, mode="optimizer_canary")
        bad["optimizer_steps"] = 2
        self.assertEqual(self.validate(bad, mode="optimizer_canary"), bad)
        with self.assertRaises(gate.ReadinessError): self.validate(bad)

    def test_nonfinite_and_forged_numerical_success_fail(self):
        for value in (float("nan"), float("inf"), -float("inf")):
            bad = copy.deepcopy(self.report); bad["nested_metadata"] = {"value": [value]}
            with self.assertRaises(gate.ReadinessError): self.validate(bad)
        for field, value in (("actual", True), ("rtol", -1), ("atol", "0.1"),
                             ("actual", 1e308), ("actual", 10 ** 1000), ("reference", None)):
            bad = copy.deepcopy(self.report)
            bad["checks"][1]["evidence"]["comparisons"][0][field] = value
            with self.assertRaises(gate.ReadinessError): self.validate(bad)
        bad = copy.deepcopy(self.report)
        comparison = bad["checks"][1]["evidence"]["comparisons"][0]
        comparison.update(actual=0.2910676897, reference=0.2864160538, atol=0.002, rtol=0.002, passed=True)
        with self.assertRaisesRegex(gate.ReadinessError, "Numerical comparison failed"):
            self.validate(bad)

    def test_old_failed_precision_criterion_is_not_upgraded(self):
        bad = copy.deepcopy(self.report)
        bad["checks"][1]["evidence"]["criterion"] = "fp32_linear_reference"
        with self.assertRaisesRegex(gate.ReadinessError, "criterion mismatch"):
            self.validate(bad)

    def test_fused_loss_cannot_relax_tolerances_or_omit_inventory(self):
        for field, value in (("atol", 0.003), ("rtol", 0.003), ("supervised_items", True)):
            bad = copy.deepcopy(self.report)
            bad["checks"][1]["evidence"]["comparisons"][1][field] = value
            with self.assertRaises(gate.ReadinessError): self.validate(bad)
        for field, value in (("compiled", 1), ("chunks", [1, 8]), ("per_token_reference_ce", []),
                             ("wrong_unshifted_ce", 1.0), ("shifted_label_positions", [[0, 1]])):
            bad = copy.deepcopy(self.report); bad["checks"][1]["evidence"][field] = value
            with self.assertRaises(gate.ReadinessError): self.validate(bad)
        bad = copy.deepcopy(self.report); bad["checks"][1]["evidence"]["comparisons"].pop()
        with self.assertRaises(gate.ReadinessError): self.validate(bad)

    def test_fused_gradient_bounds_are_computed_even_when_marked_passed(self):
        for field, value in (("relative_l2_error", 0.02001), ("cosine", 0.99899), ("reference_norm", 0),
                             ("maximum_relative_l2_error", 0.03), ("minimum_cosine", 0.99),
                             ("relative_l2_error", -0.1), ("cosine", float("nan")), ("passed", 1)):
            bad = copy.deepcopy(self.report)
            bad["checks"][2]["evidence"]["results"][0][field] = value
            with self.assertRaises(gate.ReadinessError): self.validate(bad)
        bad = copy.deepcopy(self.report); bad["checks"][2]["evidence"]["results"].pop()
        with self.assertRaises(gate.ReadinessError): self.validate(bad)
        bad = copy.deepcopy(self.report)
        bad["checks"][2]["evidence"]["results"][3] = bad["checks"][2]["evidence"]["results"][0]
        with self.assertRaises(gate.ReadinessError): self.validate(bad)

    def test_generation_profile_does_not_trust_a_passed_boolean(self):
        for field, value in (("generation_profile_verified", False), ("generation_config_sha256", "a" * 64),
                             ("no_extra_logits_processors", 1), ("raw_suffix_ids", []),
                             ("body_sha256", "a" * 64), ("cap_censored", True),
                             ("semantic_completeness", "complete")):
            bad = copy.deepcopy(self.report)
            bad["checks"][3]["evidence"]["cases"][0]["inspection"][field] = value
            with self.assertRaises(gate.ReadinessError): self.validate(bad)
        bad = copy.deepcopy(self.report)
        case = bad["checks"][3]["evidence"]["cases"][0]
        case["effective_config"]["forced_eos_token_id"] = 106
        case["inspection"]["generation_config_sha256"] = gate.canonical_sha256(case["effective_config"])
        with self.assertRaises(gate.ReadinessError): self.validate(bad)

    def test_empty_duplicate_and_nonpassing_comparisons_fail(self):
        comparison = self.report["checks"][1]["evidence"]["comparisons"][0]
        for comparisons in ([], [comparison, comparison], [{**comparison, "passed": 1}]):
            bad = copy.deepcopy(self.report); bad["checks"][1]["evidence"]["comparisons"] = comparisons
            with self.assertRaises(gate.ReadinessError): self.validate(bad)

    def test_schema_and_required_check_inventory_are_mandatory(self):
        for key in ("schema_version", "mode", "optimizer_steps", "checks", "bindings"):
            bad = copy.deepcopy(self.report); del bad[key]
            with self.assertRaises(gate.ReadinessError): self.validate(bad)
        for names in ([], "fused_loss", ["fused_loss", "fused_loss"], [1]):
            with self.assertRaises(gate.ReadinessError):
                gate.validate_report(self.report, expected_bindings=self.bindings, required_checks=names)

    def test_content_hashes_bind_exact_bytes_and_block_path_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); inside = root / "bundle"; inside.mkdir()
            data = inside / "data.jsonl"; data.write_text("{\"label\":1}\n")
            digest = gate.sha256_file(data)
            self.assertEqual(gate.verify_artifact_hashes(inside, {"data.jsonl": digest}), {"data.jsonl": digest})
            data.write_text("{\"label\":0}\n")
            with self.assertRaisesRegex(gate.ReadinessError, "hash mismatch"):
                gate.verify_artifact_hashes(inside, {"data.jsonl": digest})
            outside = root / "outside"; outside.write_text("private")
            (inside / "link").symlink_to(outside)
            for name in ("../outside", str(outside), "link"):
                with self.assertRaises(gate.ReadinessError):
                    gate.verify_artifact_hashes(inside, {name: gate.sha256_file(outside)})

    def test_canonical_hash_is_order_independent_and_rejects_nonfinite(self):
        self.assertEqual(gate.canonical_sha256({"a": 1, "b": 2}), gate.canonical_sha256({"b": 2, "a": 1}))
        self.assertNotEqual(gate.canonical_sha256({"a": True}), gate.canonical_sha256({"a": 1}))
        with self.assertRaises(gate.ReadinessError): gate.canonical_sha256({"loss": float("nan")})


if __name__ == "__main__":
    unittest.main()
