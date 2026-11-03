"""Synthetic metric-only fixtures; no counseling text or model execution."""
from copy import deepcopy
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

import training_stop as stop


def checkpoint(n):
    return f"{n:064x}"


def role_fixture(policy, role, count=30):
    suite = {"schema": "malssi-role-evaluation-suite-v1", "model_role": role, "split": "development",
             "cases": [{"case_id": f"q{i}", "source_family_id": f"family-{i}",
                        "source_lineage_ids": [f"origin-{i}"], "input_sha256": checkpoint(i + 1000)}
                       for i in range(count)]}
    gates = policy["models"][role]["role_acceptance"]
    checks = {key: True for key in gates["critical_all_pass"] + gates["quality_checks"]}
    evidence = {"suite_sha256": stop.fingerprint(suite), "policy_sha256": stop.fingerprint(policy),
                "candidate_checkpoint_sha256": checkpoint(9), "baseline_checkpoint_sha256": checkpoint(0),
                "cases": [{"case_id": row["case_id"], "input_sha256": row["input_sha256"],
                           "candidate": deepcopy(checks), "baseline": deepcopy(checks)}
                          for row in suite["cases"]]}
    return suite, evidence


class StopFixture:
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.policy = stop.read_json(Path(__file__).with_name("training_stop_defaults.json"))
        self.configure_role("cards_31b")
        self.indexes = {"train": {"t1": {}, "t2": {}}, "validation": {
            "v1": {"target_length": 2, "weight": {"numerator": 1, "denominator": 2}},
            "v2": {"target_length": 200, "weight": {"numerator": 3, "denominator": 2}}}}

    def configure_role(self, role):
        self.role = role
        self.phases = [row["id"] for row in self.policy["models"][role]["phases"]]
        self.phase = self.phases[0]
        self.suite, self.role_evidence = role_fixture(self.policy, role)

    def evidence(self, name, rows):
        path = self.root / name
        path.write_text("".join(stop.canonical(row) + "\n" for row in rows))
        return {"path": name, "sha256": stop.file_hash(path)}

    def json_evidence(self, name, value):
        path = self.root / name
        path.write_text(stop.canonical(value) + "\n")
        return {"path": name, "sha256": stop.file_hash(path)}

    def history(self, losses, position=0, previous=None):
        events = []
        initial = previous["selected_checkpoint_sha256"] if previous else checkpoint(0)
        for epoch, loss in enumerate(losses):
            validation = [{"row_id": identity, "mean_target_ce": loss, "target_tokens": row["target_length"]}
                          for identity, row in self.indexes["validation"].items()]
            events.append({"epoch": epoch, "checkpoint_sha256": checkpoint(position * 100 + epoch) if epoch else initial,
                           "validation": self.evidence(f"val-{position}-{epoch}.jsonl", validation),
                           "train": self.evidence(f"train-{position}-{epoch}.jsonl", [{"row_id": key} for key in self.indexes["train"]]) if epoch else None})
        return {"schema": "malssi-training-history-v2", "policy_sha256": stop.fingerprint(self.policy),
                "model_role": self.role, "phase_id": self.phases[position], "run_id": "fixture-run",
                "input_checkpoint_sha256": initial, "model_start_checkpoint_sha256": checkpoint(0),
                "role_eval_suite_sha256": stop.fingerprint(self.suite),
                "role_baseline_judgments_sha256": stop.baseline_judgments_hash(self.role_evidence),
                "previous_decision_sha256": stop.fingerprint(previous) if previous else None, "events": events}

    def decide(self, losses):
        return stop.decide(self.policy, self.role, self.phase, self.history(losses), self.indexes, self.root)

    def final_history(self, losses, passes=None):
        previous = None
        for position in range(2):
            history = self.history([1.0, 0.8], position, previous)
            previous = stop.decide(self.policy, self.role, self.phases[position], history, self.indexes, self.root, previous)
        history = self.history(losses, 2, previous)
        for event in history["events"][1:]:
            judgments = deepcopy(self.role_evidence)
            judgments["policy_sha256"] = stop.fingerprint(self.policy)
            judgments["candidate_checkpoint_sha256"] = event["checkpoint_sha256"]
            if passes is not None and not passes[event["epoch"] - 1]:
                key = self.policy["models"][self.role]["role_acceptance"]["critical_all_pass"][0]
                judgments["cases"][0]["candidate"][key] = False
            event["role_evaluation"] = self.json_evidence(f"role-{event['epoch']}.json", judgments)
        return history, previous

    def decide_final(self, losses, passes=None):
        history, previous = self.final_history(losses, passes)
        return stop.decide(self.policy, self.role, self.phases[-1], history, self.indexes, self.root,
                           previous, self.suite, {"training-family"})


class StopTests(StopFixture, unittest.TestCase):
    def test_prepared_evaluation_is_fixed_before_first_epoch(self):
        self.policy['models'][self.role]['role_evaluation_binding']={
            'development_suite_sha256':checkpoint(777),'test_suite_sha256':checkpoint(778),
            'evaluation_manifest_sha256':checkpoint(779)}
        with self.assertRaisesRegex(ValueError,'policy-bound'):
            self.decide([1.0,0.8])

    def test_baseline_does_not_finish_training(self):
        result = self.decide([1.0])
        self.assertEqual(result["status"], "continue")
        self.assertFalse(result["phase_complete"])
        self.assertFalse(result["model_training_criteria_satisfied_from_supplied_evidence"])

    def test_intermediate_performance_target_stops_before_epoch_cap(self):
        result = self.decide([1.0, 0.8])
        self.assertEqual(result["status"], "stop_phase_accepted")
        self.assertEqual(result["reason"], "validation_performance_target_met")
        self.assertEqual(result["selected_checkpoint_sha256"], checkpoint(1))
        self.assertEqual(result["epochs_completed"], 1)
        self.assertFalse(result["model_training_criteria_satisfied_from_supplied_evidence"])

    def test_resource_cap_without_performance_is_incomplete(self):
        self.policy["models"][self.role]["phases"][0]["safety_max_epochs"] = 1
        result = self.decide([1.0, 0.999])
        self.assertEqual(result["status"], "stop_resource_limit")
        self.assertEqual(result["reason"], "resource_guard")
        self.assertFalse(result["phase_complete"])
        self.assertIsNone(result["selected_checkpoint_sha256"])
        self.assertEqual(result["accepted_phase_ids"], [])

    def test_performance_target_at_cap_can_succeed_for_performance(self):
        self.policy["models"][self.role]["phases"][0]["safety_max_epochs"] = 1
        result = self.decide([1.0, 0.8])
        self.assertEqual(result["status"], "stop_phase_accepted")
        self.assertEqual(result["reason"], "validation_performance_target_met")

    def test_nonimprovement_stops_without_claiming_completion(self):
        result = self.decide([1.0, 1.001, 1.001])
        self.assertEqual(result["status"], "stop_phase_rejected")
        self.assertEqual(result["reason"], "validation_plateau")
        self.assertFalse(result["phase_complete"])
        self.assertIsNone(result["selected_checkpoint_sha256"])

    def test_deterioration_without_target_is_not_success(self):
        result = self.decide([1.0, 1.04, 1.05])
        self.assertEqual(result["status"], "stop_phase_rejected")
        self.assertEqual(result["reason"], "validation_deterioration")
        self.assertIsNone(result["selected_checkpoint_sha256"])

    def test_tiny_improvement_not_reported_as_success(self):
        result = self.decide([1.0, 0.999, 0.998])
        self.assertEqual(result["status"], "stop_phase_rejected")
        self.assertEqual(result["stale_evaluations"], 2)

    def test_tiny_absolute_losses_still_stop_at_two_evaluations(self):
        result = self.decide([0.0005, 0.0004, 0.0003])
        self.assertEqual(result["status"], "stop_phase_rejected")
        self.assertEqual(result["epochs_completed"], 2)
        self.assertEqual(result["reason"], "validation_plateau")

    def test_marginal_best_remains_recorded_when_not_adopted(self):
        result = self.decide([1.0, 0.999, 0.998])
        self.assertEqual(result["best_complete_epoch"]["checkpoint_sha256"], checkpoint(2))
        self.assertIsNone(result["selected_checkpoint_sha256"])
        self.assertEqual(result["fallback_checkpoint_sha256"], checkpoint(0))

    def test_validation_uses_row_weight_not_target_token_count(self):
        rows = [{"row_id": "v1", "mean_target_ce": 2.0, "target_tokens": 2},
                {"row_id": "v2", "mean_target_ce": 4.0, "target_tokens": 200}]
        self.assertEqual(stop.validation_loss(rows, self.indexes["validation"]), 3.5)

    def test_large_finite_losses_do_not_overflow_weighted_mean(self):
        result = self.decide([1.3e308, 0.8])
        self.assertAlmostEqual(result["baseline_validation_loss"] / 1.3e308, 1.0)
        self.assertAlmostEqual(result["required_loss_reduction"] / 6.5e305, 1.0)

    def test_nonfinite_weighted_term_or_aggregate_is_rejected(self):
        for numerator in (3, 4):
            expected = deepcopy(self.indexes["validation"])
            for row in expected.values():
                row["weight"] = {"numerator": numerator, "denominator": 1}
            rows = [{"row_id": key, "mean_target_ce": 1e308, "target_tokens": row["target_length"]}
                    for key, row in expected.items()]
            with self.subTest(numerator=numerator), self.assertRaisesRegex(ValueError, "Non-finite"):
                stop.validation_loss(rows, expected)

    def test_duplicate_or_missing_training_id_aborts(self):
        for rows in ([{"row_id": "t1"}], [{"row_id": "t1"}, {"row_id": "t1"}]):
            history = self.history([1.0, 0.8])
            history["events"][1]["train"] = self.evidence("bad-train.jsonl", rows)
            with self.assertRaisesRegex(ValueError, "epoch coverage"):
                stop.decide(self.policy, self.role, self.phase, history, self.indexes, self.root)

    def test_subset_or_duplicate_validation_aborts(self):
        row = {"row_id": "v1", "mean_target_ce": 1.0, "target_tokens": 2}
        for rows in ([row], [row, row]):
            with self.assertRaises(ValueError):
                stop.validation_loss(rows, self.indexes["validation"])

    def test_nonfinite_or_boolean_losses_abort(self):
        for value in (float("nan"), float("inf"), True, -1):
            rows = [{"row_id": "v1", "mean_target_ce": value, "target_tokens": 2}]
            with self.assertRaisesRegex(ValueError, "invalid validation loss"):
                stop.validation_loss(rows, self.indexes["validation"])

    def test_wrong_target_mask_length_aborts(self):
        with self.assertRaisesRegex(ValueError, "mask/length"):
            stop.validation_loss([{"row_id": "v1", "mean_target_ce": 1.0, "target_tokens": 3}], self.indexes["validation"])

    def test_fatal_error_aborts_before_epoch_end(self):
        history = self.history([1.0])
        history["fatal_error"] = "non_finite_loss_or_gradient"
        result = stop.decide(self.policy, self.role, self.phase, history, self.indexes, self.root)
        self.assertEqual(result["status"], "abort")
        self.assertFalse(result["phase_complete"])
        self.assertFalse(result["model_training_criteria_satisfied_from_supplied_evidence"])

    def test_partial_epoch_is_not_normal_completion(self):
        history = self.history([1.0, 0.8])
        history["events"][1]["epoch"] = 0.5
        with self.assertRaisesRegex(ValueError, "contiguous complete epochs"):
            stop.decide(self.policy, self.role, self.phase, history, self.indexes, self.root)

    def test_history_after_stalled_stop_is_invalid(self):
        with self.assertRaisesRegex(ValueError, "continued after stopping"):
            self.decide([1.0, 1.0, 1.0, 0.7])

    def test_history_after_performance_success_is_invalid(self):
        with self.assertRaisesRegex(ValueError, "continued after stopping"):
            self.decide([1.0, 0.8, 0.7])

    def test_modified_evidence_does_not_reuse_hash(self):
        history = self.history([1.0])
        (self.root / "val-0-0.jsonl").write_text("changed\n")
        with self.assertRaisesRegex(ValueError, "Evidence changed"):
            stop.decide(self.policy, self.role, self.phase, history, self.indexes, self.root)

    def test_reused_checkpoint_identity_is_rejected(self):
        history = self.history([1.0, 0.8])
        history["events"][1]["checkpoint_sha256"] = checkpoint(0)
        with self.assertRaisesRegex(ValueError, "reused checkpoint"):
            stop.decide(self.policy, self.role, self.phase, history, self.indexes, self.root)

    def test_later_phase_needs_accepted_parent_and_same_frozen_context(self):
        previous = self.decide([1.0, 0.8])
        history = self.history([1.0, 0.8], 1, previous)
        result = stop.decide(self.policy, self.role, self.phases[1], history, self.indexes, self.root, previous)
        self.assertEqual(result["status"], "stop_phase_accepted")
        self.assertEqual(result["accepted_phase_ids"], self.phases[:2])
        for key in ("role_eval_suite_sha256", "role_baseline_judgments_sha256", "previous_decision_sha256"):
            changed = deepcopy(history)
            changed[key] = checkpoint(999)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "preceding accepted"):
                stop.decide(self.policy, self.role, self.phases[1], changed, self.indexes, self.root, previous)

    def test_unaccepted_parent_cannot_advance(self):
        previous = self.decide([1.0, 1.0, 1.0])
        history = self.history([1.0], 1, previous)
        history["input_checkpoint_sha256"] = checkpoint(1)
        with self.assertRaisesRegex(ValueError, "preceding accepted"):
            stop.decide(self.policy, self.role, self.phases[1], history, self.indexes, self.root, previous)

    def test_policy_change_invalidates_history(self):
        history = self.history([1.0])
        self.policy["evaluation"]["min_delta_relative"] = 0.01
        with self.assertRaisesRegex(ValueError, "policy binding"):
            stop.decide(self.policy, self.role, self.phase, history, self.indexes, self.root)


class FinalPerformanceTests(StopFixture, unittest.TestCase):
    def test_both_roles_finish_as_soon_as_performance_targets_are_met(self):
        for role in ("chat_12b", "cards_31b"):
            with self.subTest(role=role):
                self.configure_role(role)
                result = self.decide_final([1.0, 0.8])
                self.assertEqual(result["status"], "stop_phase_accepted")
                self.assertEqual(result["reason"], "role_performance_target_met")
                self.assertEqual(result["epochs_completed"], 1)
                self.assertEqual(result["accepted_phase_ids"], self.phases)
                self.assertTrue(result["model_training_criteria_satisfied_from_supplied_evidence"])
                self.assertFalse(result["automatic_deployment"])

    def test_poor_quality_continues_despite_loss_target(self):
        result = self.decide_final([1.0, 0.8], [False])
        self.assertEqual(result["status"], "continue")
        self.assertEqual(result["role_acceptance"]["status"], "role_acceptance_failed")
        self.assertFalse(result["phase_complete"])
        self.assertFalse(result["model_training_criteria_satisfied_from_supplied_evidence"])

    def test_plateau_with_loss_improvement_but_poor_quality_is_incomplete(self):
        result = self.decide_final([1.0, 0.8, 0.799, 0.798], [False, False, False])
        self.assertEqual(result["status"], "stop_phase_rejected")
        self.assertEqual(result["reason"], "validation_plateau")
        self.assertEqual(result["stale_evaluations"], 2)
        self.assertEqual(result["best_complete_epoch"]["checkpoint_sha256"], checkpoint(203))
        self.assertIsNone(result["selected_checkpoint_sha256"])
        self.assertFalse(result["model_training_criteria_satisfied_from_supplied_evidence"])

    def test_deterioration_retains_loss_best_but_never_accepts_poor_quality(self):
        result = self.decide_final([1.0, 0.8, 0.85, 0.86], [False, False, False])
        self.assertEqual(result["status"], "stop_phase_rejected")
        self.assertEqual(result["reason"], "validation_deterioration")
        self.assertEqual(result["best_complete_epoch"]["checkpoint_sha256"], checkpoint(201))
        self.assertIsNone(result["selected_checkpoint_sha256"])

    def test_meaningful_recovery_resets_both_streaks(self):
        result = self.decide_final([1.0, 0.8, 0.84, 0.79], [False, False, False])
        self.assertEqual(result["status"], "continue")
        self.assertEqual(result["stale_evaluations"], 0)
        self.assertEqual(result["deteriorated_evaluations"], 0)

    def test_cap_with_improving_loss_but_poor_quality_is_incomplete(self):
        result = self.decide_final([1.0, 0.9, 0.8, 0.7, 0.6, 0.5], [False] * 5)
        self.assertEqual(result["status"], "stop_resource_limit")
        self.assertEqual(result["reason"], "resource_guard")
        self.assertEqual(result["accepted_phase_ids"], self.phases[:2])
        self.assertFalse(result["phase_complete"])
        self.assertFalse(result["model_training_criteria_satisfied_from_supplied_evidence"])

    def test_final_performance_target_takes_precedence_over_cap(self):
        self.policy["models"][self.role]["phases"][-1]["safety_max_epochs"] = 1
        result = self.decide_final([1.0, 0.8])
        self.assertEqual(result["reason"], "role_performance_target_met")
        self.assertTrue(result["phase_complete"])

    def test_role_passing_checkpoint_can_differ_from_loss_best(self):
        result = self.decide_final([1.0, 0.8, 0.81], [False, True])
        self.assertEqual(result["status"], "stop_phase_accepted")
        self.assertEqual(result["selected_checkpoint_sha256"], checkpoint(202))
        self.assertEqual(result["best_complete_epoch"]["checkpoint_sha256"], checkpoint(201))

    def test_current_checkpoint_must_meet_loss_target_even_if_prior_one_did(self):
        result = self.decide_final([1.0, 0.8, 1.001], [False, True])
        self.assertEqual(result["status"], "continue")
        self.assertEqual(result["role_acceptance"]["status"], "role_acceptance_passed")
        self.assertIsNone(result["selected_checkpoint_sha256"])
        self.assertFalse(result["model_training_criteria_satisfied_from_supplied_evidence"])

    def test_missing_role_evidence_or_context_is_pending_not_success(self):
        for missing in ("judgments", "suite", "lineage"):
            with self.subTest(missing=missing):
                history, previous = self.final_history([1.0, 0.8])
                if missing == "judgments":
                    del history["events"][1]["role_evaluation"]
                result = stop.decide(self.policy, self.role, self.phases[-1], history, self.indexes, self.root,
                                     previous, None if missing == "suite" else self.suite,
                                     None if missing == "lineage" else {"training-family"})
                self.assertEqual(result["status"], "stop_pending_evaluation")
                self.assertFalse(result["phase_complete"])
                self.assertFalse(result["model_training_criteria_satisfied_from_supplied_evidence"])

    def test_final_role_evidence_is_bound_to_current_checkpoint(self):
        history, previous = self.final_history([1.0, 0.8])
        evidence = deepcopy(self.role_evidence)
        history["events"][1]["role_evaluation"] = self.json_evidence("wrong-checkpoint.json", evidence)
        with self.assertRaisesRegex(ValueError, "bindings differ"):
            stop.decide(self.policy, self.role, self.phases[-1], history, self.indexes, self.root,
                        previous, self.suite, {"training-family"})

    def test_changed_role_evidence_bytes_are_rejected(self):
        history, previous = self.final_history([1.0, 0.8])
        (self.root / "role-1.json").write_text("{}\n")
        with self.assertRaisesRegex(ValueError, "Evidence changed"):
            stop.decide(self.policy, self.role, self.phases[-1], history, self.indexes, self.root,
                        previous, self.suite, {"training-family"})

    def test_changed_baseline_judgments_are_rejected(self):
        history, previous = self.final_history([1.0, 0.8])
        evidence = stop.read_json(self.root / "role-1.json")
        evidence["cases"][0]["baseline"]["schema_valid"] = False
        history["events"][1]["role_evaluation"] = self.json_evidence("changed-baseline.json", evidence)
        with self.assertRaisesRegex(ValueError, "Baseline judgments changed"):
            stop.decide(self.policy, self.role, self.phases[-1], history, self.indexes, self.root,
                        previous, self.suite, {"training-family"})

    def test_assess_role_rechecks_actual_stopping_evidence(self):
        result = self.decide_final([1.0, 0.8])
        evidence = stop.read_json(self.root / "role-1.json")
        assessment = stop.assess_role(self.policy, self.role, self.suite, evidence, result, {"training-family"})
        self.assertTrue(assessment["model_training_criteria_satisfied_from_supplied_evidence"])
        evidence["cases"][0]["candidate"]["facts_grounded"] = False
        with self.assertRaisesRegex(ValueError, "differs from stopping decision"):
            stop.assess_role(self.policy, self.role, self.suite, evidence, result, {"training-family"})

    def test_assess_role_cannot_turn_resource_stop_into_success(self):
        self.policy["models"][self.role]["phases"][-1]["safety_max_epochs"] = 1
        result = self.decide_final([1.0, 0.8], [False])
        with self.assertRaisesRegex(ValueError, "All model phases"):
            stop.assess_role(self.policy, self.role, self.suite, stop.read_json(self.root / "role-1.json"),
                             result, {"training-family"})

    def test_final_selection_requires_all_phases(self):
        result = self.decide_final([1.0, 0.8])
        result["accepted_phase_ids"] = self.phases[-1:]
        with self.assertRaisesRegex(ValueError, "All model phases"):
            stop.assess_role(self.policy, self.role, self.suite, stop.read_json(self.root / "role-1.json"),
                             result, {"training-family"})


class RoleAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.policy = stop.read_json(Path(__file__).with_name("training_stop_defaults.json"))
        self.role = "cards_31b"
        self.suite, self.evidence = role_fixture(self.policy, self.role)
        self.freeze()

    def freeze(self):
        self.suite_hash = self.evidence["suite_sha256"] = stop.fingerprint(self.suite)
        self.baseline_hash = stop.baseline_judgments_hash(self.evidence)

    def score(self, lineage=None):
        return stop.score_role(self.policy, self.role, self.suite, self.evidence, checkpoint(9), checkpoint(0),
                               self.suite_hash, self.baseline_hash, lineage or {"training-family"})

    def test_role_score_alone_never_claims_training_complete(self):
        result = self.score()
        self.assertEqual(result["status"], "role_acceptance_passed")
        self.assertFalse(result["model_training_criteria_satisfied_from_supplied_evidence"])
        self.assertFalse(result["automatic_deployment"])
        self.assertFalse(result["unseen_test_passed"])

    def test_policy_bound_suite_cannot_be_replaced_by_rehashed_evidence(self):
        self.policy['models'][self.role]['role_evaluation_binding']={
            'development_suite_sha256':self.suite_hash,'test_suite_sha256':checkpoint(778),
            'evaluation_manifest_sha256':checkpoint(779)}
        self.evidence['policy_sha256']=stop.fingerprint(self.policy)
        self.assertEqual(self.score()['status'],'role_acceptance_passed')
        self.suite['cases'][0]['input_sha256']=checkpoint(999)
        self.evidence['cases'][0]['input_sha256']=checkpoint(999)
        self.freeze()
        with self.assertRaisesRegex(ValueError,'policy-bound'):
            self.score()

    def test_each_role_critical_error_fails(self):
        for role in ("chat_12b", "cards_31b"):
            for check in self.policy["models"][role]["role_acceptance"]["critical_all_pass"]:
                with self.subTest(role=role, check=check):
                    self.role = role
                    self.suite, self.evidence = role_fixture(self.policy, role)
                    self.freeze()
                    self.evidence["cases"][0]["candidate"][check] = False
                    result = self.score()
                    self.assertEqual(result["status"], "role_acceptance_failed")
                    self.assertIn(check + ":critical_error", result["failures"])

    def test_95_percent_and_no_regression_are_both_required(self):
        self.evidence["cases"][0]["candidate"]["practically_usable"] = False
        self.assertIn("practically_usable:regression", self.score()["failures"])
        self.evidence["cases"][0]["baseline"]["practically_usable"] = False
        self.freeze()
        self.assertEqual(self.score()["status"], "role_acceptance_passed")
        self.evidence["cases"][1]["candidate"]["practically_usable"] = False
        self.evidence["cases"][1]["baseline"]["practically_usable"] = False
        self.freeze()
        self.assertIn("practically_usable:below_95_percent", self.score()["failures"])

    def test_exact_95_percent_quality_boundary_passes(self):
        self.suite, self.evidence = role_fixture(self.policy, self.role, 40)
        for row in self.evidence["cases"][:2]:
            row["candidate"]["practically_usable"] = row["baseline"]["practically_usable"] = False
        self.freeze()
        result = self.score()
        self.assertEqual(result["status"], "role_acceptance_passed")
        self.assertEqual(result["family_pass_rates"]["practically_usable"]["candidate"], 0.95)

    def test_case_variants_cannot_inflate_family_count(self):
        for row in self.suite["cases"]:
            row["source_family_id"] = "one-family"
        self.freeze()
        with self.assertRaisesRegex(ValueError, "too-small"):
            self.score()

    def test_shared_origins_merge_different_family_labels(self):
        for row in self.suite["cases"]:
            row["source_lineage_ids"] = ["shared-origin"]
        self.freeze()
        with self.assertRaisesRegex(ValueError, "too-small"):
            self.score()

    def test_each_family_variant_must_pass_critical_check(self):
        variant = deepcopy(self.suite["cases"][0])
        variant["case_id"] = "extra-variant"
        self.suite["cases"].append(variant)
        judgment = deepcopy(self.evidence["cases"][0])
        judgment["case_id"] = variant["case_id"]
        judgment["candidate"]["facts_grounded"] = False
        self.evidence["cases"].append(judgment)
        self.freeze()
        result = self.score()
        self.assertEqual(result["source_families"], 30)
        self.assertIn("facts_grounded:critical_error", result["failures"])

    def test_missing_or_nonboolean_candidate_judgment_is_rejected(self):
        for value in (None, 1):
            _, self.evidence = role_fixture(self.policy, self.role)
            if value is None:
                del self.evidence["cases"][0]["candidate"]["facts_grounded"]
            else:
                self.evidence["cases"][0]["candidate"]["facts_grounded"] = value
            with self.assertRaisesRegex(ValueError, "quality judgments"):
                self.score()

    def test_missing_case_is_rejected_even_if_incomplete_baseline_was_frozen(self):
        self.evidence["cases"].pop()
        self.freeze()
        with self.assertRaisesRegex(ValueError, "Incomplete"):
            self.score()

    def test_suite_changed_after_training_is_rejected(self):
        self.suite["cases"][0]["input_sha256"] = checkpoint(999)
        self.evidence["suite_sha256"] = stop.fingerprint(self.suite)
        with self.assertRaisesRegex(ValueError, "bindings differ"):
            self.score()

    def test_baseline_judgments_cannot_change_after_freeze(self):
        self.evidence["cases"][0]["baseline"]["facts_grounded"] = False
        with self.assertRaisesRegex(ValueError, "Baseline judgments changed"):
            self.score()

    def test_training_family_or_origin_cannot_be_evaluation(self):
        for identity in ("family-0", "origin-0"):
            with self.subTest(identity=identity), self.assertRaisesRegex(ValueError, "training lineage"):
                self.score({identity})

    def test_test_split_cannot_be_used_for_checkpoint_selection(self):
        self.suite["split"] = "test"
        with self.assertRaisesRegex(ValueError, "development suite"):
            self.score()
class DatasetBindingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.policy = stop.read_json(Path(__file__).with_name("training_stop_defaults.json"))
        model = self.policy["models"]["cards_31b"]
        (self.root / "COURSE.json").write_text("{}\n")
        (self.root / "MANIFEST.json").write_text("{}\n")
        (self.root / "tokenizer").mkdir()
        (self.root / "tokenizer/tokenizer.json").write_text("fixture-tokenizer")
        model["binding"] = {"root_at_binding": str(self.root), "course_sha256": stop.file_hash(self.root / "COURSE.json"),
            "manifest_sha256": stop.file_hash(self.root / "MANIFEST.json"), "manifest_at_parent": False,
            "tokenizer_sha256": {"tokenizer.json": stop.file_hash(self.root / "tokenizer/tokenizer.json")}}
        model["phases"][0]["data"] = {}
        for split in ("train", "validation"):
            index = self.root / (split + ".index.jsonl")
            row = {"row_id": split + "-fixture", "target_length": 2, "weight": {"numerator": 1, "denominator": 1}}
            index.write_text(stop.canonical(row) + "\n")
            binary = self.root / (split + ".bin")
            binary.write_bytes(b"test")
            model["phases"][0]["data"][split] = {"index": index.name, "sha256": stop.file_hash(index), "rows": 1,
                "id_set_sha256": stop.digest(row["row_id"]),
                "files": {p.name: {"sha256": stop.file_hash(p), "bytes": p.stat().st_size} for p in (index, binary)}}

    def test_intact_binding_loads(self):
        _, indexes = stop.bound_indexes(self.policy, "cards_31b", "00_original_warmup")
        self.assertEqual(set(indexes), {"train", "validation"})

    def test_tokenizer_change_is_detected_without_manifest_update(self):
        (self.root / "tokenizer/tokenizer.json").write_text("changed")
        with self.assertRaisesRegex(ValueError, "Tokenizer artifact changed"):
            stop.bound_indexes(self.policy, "cards_31b", "00_original_warmup")

    def test_binary_change_is_detected_without_manifest_update(self):
        (self.root / "train.bin").write_bytes(b"bad!")
        with self.assertRaisesRegex(ValueError, "Dataset file changed"):
            stop.bound_indexes(self.policy, "cards_31b", "00_original_warmup")


class VariantPolicyTests(StopFixture, unittest.TestCase):
    """Metadata-only curricula and evaluation inputs; no model or source text."""
    def make_dataset(self, role, variant=None):
        root = self.root / (variant or role)
        root.mkdir()
        (root / "tokenizer").mkdir()
        (root / "tokenizer/tokenizer.json").write_text("synthetic-tokenizer")
        specs = (stop.VARIANT_PHASES[variant] if variant else
                 [(p["id"], p["safety_max_epochs"], ("synthetic",))
                  for p in self.policy["models"][role]["phases"]])
        course = {"schema": "malssi-chat-variants-v1" if variant else "synthetic-course",
                  "role": role, "model": {"family": "Gemma 4", "parameter_size": "12B" if role == "chat_12b" else "31B",
                      "tokenizer_sha256": {"tokenizer.json": stop.file_hash(root / "tokenizer/tokenizer.json")}},
                  "loss": {"reduction": "mean_target_token_CE_per_row", "weighting": "equal_task_then_connected_source_family"},
                  "phases": [], **{key: False for key in ("truncation", "packing", "split_reassignment",
                                    "validation_used_for_gradient", "cross_model_adapter_reuse")}}
        if variant:
            course["variant"] = variant
        for phase, _, tasks in specs:
            data = {}
            for split in ("train", "validation"):
                stem = phase + "-" + split
                rows = [{"row_id": stem + "-" + task, "task": task, "split": split,
                         "target_length": 2, "weight": {"numerator": 1, "denominator": 1},
                         "source_group_ids": [stem], "source_root_ids": [stem]} for task in tasks]
                (root / (stem + ".jsonl")).write_text("".join(stop.canonical(r) + "\n" for r in rows))
                (root / (stem + ".bin")).write_bytes(b"synthetic")
                data[split] = {"rows": len(rows), "tasks": {task: 1 for task in tasks},
                               "path": stem + ".jsonl", "token_index": stem + ".jsonl", "token_binary": stem + ".bin"}
            course["phases"].append({"id": phase, "data": data})
        stop.save(root / "COURSE.json", course)
        self.reseal(root)
        return root

    def reseal(self, root):
        stop.save(root / "MANIFEST.json", {"schema": "malssi-prepared-role-evaluation-v1", "files": {
            str(p.relative_to(root)): {"bytes": p.stat().st_size, "sha256": stop.file_hash(p)}
            for p in root.rglob("*") if p.is_file() and p.name != "MANIFEST.json"}})

    def make_evaluation(self, tasks=None, shared_origin=False):
        root = self.root / "evaluation"
        tasks = sorted(tasks or stop.SUPPORTED_ROLE_TASKS)
        gates = self.policy["models"]["chat_12b"]["role_acceptance"]
        for split in ("development", "test"):
            folder = root / "chat_12b" / split
            folder.mkdir(parents=True)
            inputs = [{"case_id": f"q{i}", "requests": [{"request_id": f"q{i}-{task}", "task": task,
                       "messages": [{"role": "user", "content": "synthetic"}]} for task in tasks]} for i in range(30)]
            suite = {"schema": "malssi-role-evaluation-suite-v1", "model_role": "chat_12b", "split": split,
                     "cases": [{"case_id": row["case_id"], "source_family_id": row["case_id"],
                                "source_lineage_ids": ["shared" if shared_origin else "origin-" + row["case_id"]],
                                "input_sha256": stop.fingerprint(row)} for row in inputs]}
            stop.save(folder / "SUITE.json", suite)
            stop.save(folder / "RUBRIC.json", {"model_role": "chat_12b",
                "critical_all_pass": gates["critical_all_pass"], "quality_checks": gates["quality_checks"],
                "family_aggregation": "all_applicable_requests_must_pass_each_check", "judgment_requires_actual_outputs": True})
            (folder / "INPUTS.jsonl").write_text("".join(stop.canonical(row) + "\n" for row in inputs))
        self.reseal(root)
        return root

    def bind_variant(self, variant, evaluation=None, output_name="new-policy", app_root=None):
        chat = self.make_dataset("chat_12b", variant)
        cards = self.make_dataset("cards_31b")
        output = self.root / "training_data" / output_name
        output.parent.mkdir()
        result = stop.bind(Path(__file__).with_name("training_stop_defaults.json"),
                           {"chat_12b": chat, "cards_31b": cards}, output,
                           chat_variant=variant, evaluation_root=evaluation, app_root=app_root)
        return stop.read_json(output / "POLICY.json"), output, result

    def test_each_supported_variant_binds_exact_phases_tasks_and_indexes(self):
        for variant in stop.VARIANT_PHASES:
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as temp:
                original = self.root
                self.root = Path(temp).resolve()
                policy, _, result = self.bind_variant(variant)
                model = policy["models"]["chat_12b"]
                self.assertEqual([p["id"] for p in model["phases"]], [s[0] for s in stop.VARIANT_PHASES[variant]])
                self.assertEqual(result["variant_role_evaluation"]["status"], "role_acceptance_pending")
                for phase in model["phases"]:
                    _, indexes = stop.bound_indexes(policy, "chat_12b", phase["id"])
                    self.assertEqual({r["task"] for r in indexes["train"].values()}, set(phase["tasks"]))
                self.root = original

    def test_course_variant_requires_explicit_matching_selection(self):
        chat = self.make_dataset("chat_12b", "A_generator")
        cards = self.make_dataset("cards_31b")
        output = self.root / "training_data/new"
        output.parent.mkdir()
        for variant in (None, "B_reviewer"):
            with self.subTest(variant=variant), self.assertRaisesRegex(ValueError, "explicit selection"):
                stop.bind(Path(__file__).with_name("training_stop_defaults.json"),
                          {"chat_12b": chat, "cards_31b": cards}, output, chat_variant=variant)
            self.assertFalse(output.exists())

    def test_unknown_legacy_two_phase_reviewer_is_not_silently_supported(self):
        with self.assertRaisesRegex(ValueError, "Unsupported curriculum variant"):
            stop.bind(Path(__file__).with_name("training_stop_defaults.json"),
                      {"chat_12b": self.root, "cards_31b": self.root}, self.root / "new", chat_variant="B_question_reviewer")

    def test_variant_phase_order_task_and_cap_changes_are_rejected(self):
        policy, _, _ = self.bind_variant("C_combined")
        for change in ("order", "task", "cap", "boolean_cap", "missing_variant", "missing_completion_contract"):
            changed = deepcopy(policy); model = changed["models"]["chat_12b"]
            if change == "order": model["phases"].reverse()
            if change == "task": model["phases"][-1]["tasks"] = ["question_review"]
            if change == "cap": model["phases"][-1]["safety_max_epochs"] = 3
            if change == "boolean_cap": model["phases"][-1]["safety_max_epochs"] = True
            if change == "missing_variant": del model["curriculum_variant"]
            if change == "missing_completion_contract": del model["variant_completion_contract"]
            with self.subTest(change=change), self.assertRaises(ValueError): stop.validate_policy(changed)

    def test_variant_requires_actual_index_tasks_not_only_declared_course(self):
        chat = self.make_dataset("chat_12b", "B_reviewer"); cards = self.make_dataset("cards_31b")
        path = chat / "04_result_review-train.jsonl"
        rows = list(stop.read_rows(path)); rows[0]["task"] = "question_review"
        path.write_text("".join(stop.canonical(row) + "\n" for row in rows)); self.reseal(chat)
        output = self.root / "training_data/new"; output.parent.mkdir()
        with self.assertRaisesRegex(ValueError, "index task inventory"):
            stop.bind(Path(__file__).with_name("training_stop_defaults.json"),
                      {"chat_12b": chat, "cards_31b": cards}, output, chat_variant="B_reviewer")
        self.assertFalse(output.exists())

    def test_existing_role_suite_covers_generator_but_not_new_reviews(self):
        for variant in stop.VARIANT_PHASES:
            with self.subTest(variant=variant), tempfile.TemporaryDirectory() as temp:
                original = self.root; self.root = Path(temp).resolve()
                evaluation = self.make_evaluation()
                policy, _, result = self.bind_variant(variant, evaluation)
                if variant == "A_generator":
                    self.assertIsNone(result["variant_role_evaluation"])
                else:
                    gap = result["variant_role_evaluation"]
                    self.assertEqual(gap["missing_tasks"], ["answer_review", "memory_review"])
                    self.assertEqual(gap["unsupported_semantic_tasks"], gap["missing_tasks"])
                self.root = original

    def test_new_task_names_do_not_create_a_semantic_evaluation_contract(self):
        evaluation = self.make_evaluation(tasks=stop.SUPPORTED_ROLE_TASKS | {"answer_review", "memory_review"})
        policy, _, result = self.bind_variant("B_reviewer", evaluation)
        gap = result["variant_role_evaluation"]
        self.assertEqual(gap["missing_tasks"], [])
        self.assertEqual(gap["unsupported_semantic_tasks"], ["answer_review", "memory_review"])
        self.assertEqual(gap["status"], "role_acceptance_pending")

    def test_connected_sources_do_not_inflate_task_coverage(self):
        evaluation = self.make_evaluation(shared_origin=True)
        policy, _, result = self.bind_variant("A_generator", evaluation)
        coverage = policy["models"]["chat_12b"]["role_task_coverage"]
        self.assertEqual(set(coverage["source_families_by_task"].values()), {1})
        self.assertEqual(result["variant_role_evaluation"]["missing_tasks"], coverage["required_tasks"])

    def test_rehashed_inputs_must_still_match_the_frozen_suite(self):
        evaluation = self.make_evaluation()
        path = evaluation / "chat_12b/development/INPUTS.jsonl"
        rows = list(stop.read_rows(path)); rows[0]["requests"].pop()
        path.write_text("".join(stop.canonical(row) + "\n" for row in rows)); self.reseal(evaluation)
        with self.assertRaisesRegex(ValueError, "not bound to suite"):
            self.bind_variant("A_generator", evaluation)

    def test_forged_coverage_without_suite_binding_is_rejected(self):
        policy, _, _ = self.bind_variant("A_generator")
        coverage = policy["models"]["chat_12b"]["role_task_coverage"]
        coverage["covered_tasks"] = coverage["required_tasks"]
        with self.assertRaisesRegex(ValueError, "Unbound variant evaluation"):
            stop.validate_policy(policy)

    def test_review_variant_final_epoch_is_pending_even_with_passing_old_judgments(self):
        self.policy, _, _ = self.bind_variant("C_combined")
        self.configure_role("chat_12b")
        previous = None
        for position in range(len(self.phases) - 1):
            history = self.history([1.0, 0.8], position, previous)
            previous = stop.decide(self.policy, self.role, self.phases[position], history,
                                   self.indexes, self.root, previous)
            self.assertEqual(previous["status"], "stop_phase_accepted")
        history = self.history([1.0, 0.8], len(self.phases) - 1, previous)
        result = stop.decide(self.policy, self.role, self.phases[-1], history, self.indexes, self.root,
                             previous, self.suite, {"training-family"})
        self.assertEqual(result["status"], "stop_pending_evaluation")
        self.assertEqual(result["reason"], "role_evaluation_task_coverage_missing")
        self.assertFalse(result["phase_complete"])
        self.assertFalse(result["model_training_criteria_satisfied_from_supplied_evidence"])
        score = stop.score_role(self.policy, self.role, self.suite, self.role_evidence,
                                checkpoint(9), checkpoint(0), stop.fingerprint(self.suite),
                                stop.baseline_judgments_hash(self.role_evidence), {"training-family"})
        self.assertEqual(score["status"], "role_acceptance_pending")

    def test_generator_score_uses_bound_suite_and_current_app_contract(self):
        evaluation = self.make_evaluation()
        app = self.root / "app"; (app / "src").mkdir(parents=True)
        report = {"status": "snapshot_match_unvalidated_tasks", "training_ready": False, "model_calls": 0,
                  "semantic_quality_evaluated": False, "bundle_modified": False}
        with patch("check_training_app_contract.check", return_value=report):
            policy, _, _ = self.bind_variant("A_generator", evaluation, app_root=app)
        suite = stop.read_json(evaluation / "chat_12b/development/SUITE.json")
        gates = policy["models"]["chat_12b"]["role_acceptance"]
        checks = {key: True for key in gates["critical_all_pass"] + gates["quality_checks"]}
        evidence = {"policy_sha256": stop.fingerprint(policy), "suite_sha256": stop.fingerprint(suite),
                    "candidate_checkpoint_sha256": checkpoint(9), "baseline_checkpoint_sha256": checkpoint(0),
                    "cases": [{"case_id": row["case_id"], "input_sha256": row["input_sha256"],
                               "candidate": deepcopy(checks), "baseline": deepcopy(checks)} for row in suite["cases"]]}
        def score():
            return stop.score_role(policy, "chat_12b", suite, evidence, checkpoint(9), checkpoint(0),
                                   stop.fingerprint(suite), stop.baseline_judgments_hash(evidence), {"train"})
        with patch("check_training_app_contract.check", return_value=report):
            result = score()
        self.assertEqual(result["status"], "role_acceptance_passed")
        self.assertFalse(result["model_training_criteria_satisfied_from_supplied_evidence"])
        with patch("check_training_app_contract.check", return_value={**report, "status": "review_required"}):
            result = score()
        self.assertEqual(result["status"], "role_acceptance_pending")
        self.assertEqual(result["app_contract_status"], "changed_since_binding")
        with patch("check_training_app_contract.check", side_effect=ValueError("private fixture")):
            result = score()
        self.assertEqual(result["app_contract_status"], "check_failed")
        suite["cases"][0]["input_sha256"] = checkpoint(888)
        evidence["suite_sha256"] = stop.fingerprint(suite)
        with self.assertRaisesRegex(ValueError, "policy-bound"):
            score()

    def test_app_drift_blocks_final_acceptance_even_when_task_coverage_is_ready(self):
        evaluation = self.make_evaluation()
        self.policy, _, _ = self.bind_variant("A_generator", evaluation)
        self.configure_role("chat_12b")
        # Use the actual frozen synthetic suite instead of the default fixture suite.
        self.suite = stop.read_json(evaluation / "chat_12b/development/SUITE.json")
        previous = None
        for position in range(2):
            history = self.history([1.0, 0.8], position, previous)
            previous = stop.decide(self.policy, self.role, self.phases[position], history,
                                   self.indexes, self.root, previous)
        history = self.history([1.0, 0.8], 2, previous)
        result = stop.decide(self.policy, self.role, self.phases[-1], history, self.indexes, self.root,
                             previous, self.suite, {"training-family"})
        self.assertEqual(result["status"], "stop_pending_evaluation")
        self.assertEqual(result["reason"], "app_contract_review_required")
        self.assertFalse(result["model_training_criteria_satisfied_from_supplied_evidence"])

    def test_cli_variant_and_evaluation_flags_create_a_fresh_pending_policy(self):
        chat = self.make_dataset("chat_12b", "B_reviewer"); cards = self.make_dataset("cards_31b")
        evaluation = self.make_evaluation()
        output = self.root / "training_data/cli-policy"; output.parent.mkdir()
        command = [sys.executable, "-B", str(Path(stop.__file__).resolve()), "bind",
                   "--chat-root", str(chat), "--cards-root", str(cards), "--chat-variant", "B_reviewer",
                   "--evaluation-root", str(evaluation), "--output", str(output)]
        result = subprocess.run(command, capture_output=True, text=True, check=True)
        value = stop.json.loads(result.stdout)
        self.assertEqual(value["status"], "policy_ready")
        self.assertEqual(value["variant_role_evaluation"]["missing_tasks"], ["answer_review", "memory_review"])
        self.assertEqual(value["training_readiness"]["app_contract_status"], "not_checked")
        self.assertTrue((output / "POLICY.json").is_file())

    def test_app_drift_is_bound_as_training_readiness_not_a_completion_result(self):
        app = self.root / "app"; (app / "src").mkdir(parents=True)
        report = {"status": "review_required", "training_ready": False, "model_calls": 0,
                  "semantic_quality_evaluated": False, "bundle_modified": False,
                  "memory_review_current_callback": {"rows_checked": 800, "prompt_drift_rows": 800}}
        with patch("check_training_app_contract.check", return_value=report) as check:
            policy, output, result = self.bind_variant("B_reviewer", app_root=app)
        check.assert_called_once_with(self.root / "B_reviewer", self.root)
        self.assertEqual(stop.read_json(output / "APP_CONTRACT_CHECK.json"), report)
        self.assertEqual(policy["models"]["chat_12b"]["app_contract_binding"]["canonical_report_sha256"], stop.fingerprint(report))
        self.assertEqual(result["training_readiness"]["status"], "pending")
        self.assertTrue(result["training_readiness"]["app_contract_review_required"])
        for helper in ("check_training_app_contract.py", "check_training_memory_contract.mjs"):
            self.assertEqual(stop.file_hash(output / "scripts" / helper), stop.file_hash(Path(__file__).with_name(helper)))

    def test_app_check_failure_never_records_readiness_or_private_error(self):
        app = self.root / "app"; (app / "src").mkdir(parents=True)
        with patch("check_training_app_contract.check", side_effect=ValueError("private fixture source")):
            _, output, result = self.bind_variant("A_generator", app_root=app)
        self.assertEqual(result["training_readiness"]["app_contract_status"], "check_failed")
        self.assertFalse(result["training_readiness"]["training_ready"])
        self.assertNotIn("private fixture source", (output / "APP_CONTRACT_CHECK.json").read_text())

    def test_matched_app_contract_still_requires_actual_baseline_and_semantics(self):
        app = self.root / "app"; (app / "src").mkdir(parents=True)
        report = {"status": "contract_match", "training_ready": False, "model_calls": 0,
                  "semantic_quality_evaluated": False, "bundle_modified": False}
        with patch("check_training_app_contract.check", return_value=report):
            _, _, result = self.bind_variant("A_generator", self.make_evaluation(), app_root=app)
        self.assertIsNone(result["variant_role_evaluation"])
        self.assertFalse(result["training_readiness"]["app_contract_review_required"])
        self.assertFalse(result["training_readiness"]["training_ready"])
        self.assertTrue(result["training_readiness"]["actual_baseline_and_semantic_evaluation_required"])

    def test_no_existing_policy_is_overwritten(self):
        policy, output, _ = self.bind_variant("A_generator")
        before = (output / "POLICY.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "new policy output"):
            stop.bind(Path(__file__).with_name("training_stop_defaults.json"),
                      {"chat_12b": self.root / "A_generator", "cards_31b": self.root / "cards_31b"},
                      output, chat_variant="A_generator")
        self.assertEqual((output / "POLICY.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
