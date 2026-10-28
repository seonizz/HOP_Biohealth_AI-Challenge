"""Synthetic contract tests and actual NumPy CE/gradient checks, without torch.

The scalar below spies on multiplication/backward and propagates an independently
computed analytic gradient. It is not a torch model or evidence of a training run.
"""
from copy import deepcopy
from fractions import Fraction
import importlib.util
import random
import unittest

from counseling_pipeline import supporter_weighted_loss as weighted


def ratio(numerator, denominator=1):
    return {"numerator": numerator, "denominator": denominator}


def fixtures(split="train", task="conversation"):
    result = []
    for index, (targets, weight) in enumerate([([2], ratio(2)), ([3, 4], ratio(1)), ([4, 5, 2], ratio(2, 3))]):
        tokens = [1, 6] + targets
        result.append({"stream": task, "split": split, "row_id": f"synthetic-{index}",
                       "weight": weight,
                       "encoded": {"input_ids": tokens, "labels": [-100, -100] + targets,
                                   "attention_mask": [1] * len(tokens), "prefix_length": 2,
                                   "target_length": len(targets), "sequence_length": len(tokens)}})
    return result


def plan(entries, **changes):
    settings = {"task": "conversation", "pad_id": 0, "accumulation_steps": 2,
                "shuffle": False, "bindings": {"policy_sha256": "synthetic-bound-policy"}}
    settings.update(changes)
    return weighted.make_plan(entries, **settings)


class Scalar:
    """Observable callback loss protocol, with an optional analytic derivative."""
    ndim = 0

    def __init__(self, value, calls, gradient=1.0):
        self.value, self.calls, self.gradient = value, calls, gradient

    def detach(self):
        return self

    def item(self):
        return self.value

    def __mul__(self, factor):
        self.calls.append(("multiply", factor))
        return Scalar(self.value * factor, self.calls, self.gradient * factor)

    def backward(self):
        self.calls.append(("backward", self.gradient))


class WeightedPlanTests(unittest.TestCase):
    def test_plan_uses_fixed_epoch_denominator_for_partial_window(self):
        value = plan(fixtures())
        self.assertEqual(value["windows"], [[0, 1], [2]])
        self.assertEqual(value["optimizer_windows"], 2)
        self.assertEqual(value["raw_target_tokens"], 6)
        self.assertEqual(value["weighted_target_tokens"], ratio(6))
        self.assertEqual(value["row_coefficients"], [ratio(2, 3)] * 3)

    def test_plan_determinism_does_not_mutate_entries_or_global_rng(self):
        entries = fixtures()
        original = deepcopy(entries)
        random.seed(19)
        state = random.getstate()
        first = plan(entries, shuffle=True)
        self.assertEqual(first, plan(entries, shuffle=True))
        self.assertEqual(entries, original)
        self.assertEqual(random.getstate(), state)
        self.assertEqual(sorted(first["order"]), [0, 1, 2])

    def test_all_task_types_are_separate_valid_plans(self):
        for task in sorted(weighted.TASKS):
            with self.subTest(task=task):
                self.assertEqual(plan(fixtures(task=task), task=task)["task"], task)

    def test_all_one_weights_and_one_window_match_target_token_mean(self):
        entries = fixtures()
        for entry in entries:
            entry["weight"] = ratio(1)
        value = plan(entries, accumulation_steps=3)
        self.assertEqual(value["row_coefficients"], [ratio(1, 6), ratio(1, 3), ratio(1, 2)])

    def test_rejects_invalid_or_nonreduced_weight_terms(self):
        bad = [ratio(0), ratio(-1), ratio(True), ratio(1, True), ratio(1.0), ratio(1, 0),
               ratio(1, -1), ratio(2, 2), ratio(float("nan")), {"numerator": 1},
               {"numerator": 1, "denominator": 1, "alias": 1}]
        for value in bad:
            with self.subTest(value=repr(value)):
                entries = fixtures()
                entries[0]["weight"] = value
                with self.assertRaises(ValueError):
                    plan(entries)

    def test_rejects_mass_change_and_global_rescaling(self):
        for weights in ([ratio(1)] + [ratio(1), ratio(2, 3)], [ratio(4), ratio(2), ratio(4, 3)]):
            entries = fixtures()
            for entry, value in zip(entries, weights):
                entry["weight"] = value
            with self.assertRaisesRegex(ValueError, "target-token mass"):
                plan(entries)

    def test_rejects_duplicate_missing_or_wrong_type_identity(self):
        for value in ("synthetic-1", "", " ", False, 1):
            entries = fixtures()
            entries[0]["row_id"] = value
            with self.assertRaises(ValueError):
                plan(entries)

    def test_rejects_mixed_tasks_splits_and_validation_training(self):
        for field, value in (("stream", "word"), ("stream", "invented"),
                             ("split", "validation"), ("split", "test")):
            entries = fixtures()
            entries[0][field] = value
            with self.assertRaises(ValueError):
                plan(entries)
        with self.assertRaisesRegex(ValueError, "Mixed task or split"):
            plan(fixtures(split="validation"))

    def test_rejects_wrong_settings_and_empty_bindings(self):
        changes = [{"accumulation_steps": True}, {"accumulation_steps": 0}, {"seed": True},
                   {"shuffle": 1}, {"pad_id": True}, {"max_length": True},
                   {"max_length": 0}, {"bindings": {}}, {"bindings": {1: "ambiguous"}},
                   {"bindings": {"bad": float("nan")}}]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                plan(fixtures(), **change)

    def test_rejects_empty_entries_and_extra_entry_aliases(self):
        for entries in ([], None):
            with self.assertRaises(ValueError):
                plan(entries)
        entries = fixtures()
        entries[0]["loss_weight"] = 0
        with self.assertRaisesRegex(ValueError, "entry fields"):
            plan(entries)

    def test_rejects_modified_labels_lengths_attention_and_bool_tokens(self):
        changes = [("labels", [2, -100, -100]), ("labels", [-100, -100, -100]),
                   ("target_length", 2), ("prefix_length", 0), ("sequence_length", 999),
                   ("attention_mask", [1, 0, 1]), ("input_ids", [1, True, 2])]
        for field, value in changes:
            entries = fixtures()
            entries[0]["encoded"][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                plan(entries)

    def test_over_limit_is_rejected_without_truncation(self):
        entries = fixtures()
        before = deepcopy(entries)
        with self.assertRaises(ValueError):
            plan(entries, max_length=4)
        self.assertEqual(entries, before)

    def test_reserved_input_and_output_budget_is_checked_in_consumer(self):
        for prefix, target, admitted in ((61440, 8192, True), (61441, 1, False),
                                        (1, 8193, False), (65536, 1, False)):
            with self.subTest(prefix=prefix, target=target):
                ids = [1] * prefix + [2] * target
                entry = {"stream": "conversation", "split": "train", "row_id": "synthetic-budget",
                         "weight": ratio(1), "encoded": {"input_ids": ids,
                         "labels": [-100] * prefix + [2] * target, "attention_mask": [1] * len(ids),
                         "prefix_length": prefix, "target_length": target, "sequence_length": len(ids)}}
                if admitted:
                    self.assertEqual(plan([entry], max_length=69632)["raw_target_tokens"], target)
                else:
                    with self.assertRaisesRegex(ValueError, "8192-output"):
                        plan([entry], max_length=69632)
                    with self.assertRaises(ValueError):
                        weighted.evaluate_losses([entry], [1.0])


class BackwardConsumerTests(unittest.TestCase):
    def test_actual_callback_protocol_consumes_every_fixed_coefficient(self):
        entries = fixtures()
        value = plan(entries)
        before = deepcopy(entries)
        calls, receipts, seen = [], [], []
        def callback(encoded):
            seen.append(encoded["target_length"])
            return Scalar(2.0, calls)
        for window in range(value["optimizer_windows"]):
            receipts.append(weighted.backward_window(callback, entries, value, window))
        self.assertEqual(seen, [1, 2, 3])
        self.assertEqual([item[1] for item in calls if item[0] == "multiply"], [2 / 3] * 3)
        self.assertEqual(len([item for item in calls if item[0] == "backward"]), 3)
        self.assertEqual(receipts[-1]["rows"], 1)
        self.assertEqual(receipts[-1]["sum_of_coefficients"], ratio(2, 3))
        self.assertFalse(receipts[-1]["complete_epoch_verified"])
        self.assertEqual(entries, before)

    def test_singleton_window_keeps_weight_effect(self):
        entries, calls = fixtures(), []
        value = plan(entries, accumulation_steps=1)
        weighted.backward_window(lambda encoded: Scalar(2.0, calls), entries, value, 0)
        # n=1, w=2, Z=6, K=3 -> 1, whereas all-one w gives 1/2.
        self.assertEqual(calls[0], ("multiply", 1.0))
        for entry in entries:
            entry["weight"] = ratio(1)
        calls.clear()
        weighted.backward_window(lambda encoded: Scalar(2.0, calls), entries,
                                 plan(entries, accumulation_steps=1), 0)
        self.assertEqual(calls[0], ("multiply", 0.5))

    def test_input_or_binding_change_is_rejected_before_callback(self):
        mutations = [lambda rows, value: rows[0].update(weight=ratio(1)),
                     lambda rows, value: rows[0].update(row_id="different-synthetic-row"),
                     lambda rows, value: value["bindings"].update(policy_sha256="other")]
        for mutate in mutations:
            entries, calls = fixtures(), []
            value = plan(entries)
            mutate(entries, value)
            with self.assertRaises(ValueError):
                weighted.backward_window(lambda encoded: calls.append(encoded), entries, value, 0)
            self.assertEqual(calls, [])

    def test_forged_coefficient_and_recomputed_plan_hash_still_rejected(self):
        entries, calls = fixtures(), []
        value = plan(entries)
        value["row_coefficients"][0] = ratio(1)
        value["plan_sha256"] = weighted._digest({key: item for key, item in value.items() if key != "plan_sha256"})
        with self.assertRaisesRegex(ValueError, "Plan or bound"):
            weighted.backward_window(lambda encoded: Scalar(2.0, calls), entries, value, 0)
        self.assertEqual(calls, [])

    def test_rejects_repeated_or_omitted_row_inside_forged_windows(self):
        for windows in ([[0, 0], [2]], [[0], [2]]):
            entries, calls = fixtures(), []
            value = plan(entries)
            value["windows"] = windows
            value["plan_sha256"] = weighted._digest({key: item for key, item in value.items() if key != "plan_sha256"})
            with self.assertRaises(ValueError):
                weighted.backward_window(lambda encoded: Scalar(2.0, calls), entries, value, 0)
            self.assertEqual(calls, [])

    def test_bad_window_or_noncallable_rejected(self):
        entries = fixtures()
        value = plan(entries)
        for index in (-1, 2, True, 1.0):
            with self.assertRaises(ValueError):
                weighted.backward_window(lambda encoded: Scalar(2.0, []), entries, value, index)
        with self.assertRaises(ValueError):
            weighted.backward_window(None, entries, value, 0)

    def test_invalid_callback_loss_rejected_before_backward(self):
        for bad in (True, -1.0, float("nan"), float("inf")):
            calls = []
            entries = fixtures()
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                weighted.backward_window(lambda encoded: Scalar(bad, calls), entries, plan(entries), 0)
            self.assertEqual(calls, [])
        for loss in (2.0, object()):
            entries = fixtures()
            with self.assertRaises(ValueError):
                weighted.backward_window(lambda encoded: loss, entries, plan(entries), 0)

    def test_zero_scalar_loss_remains_a_valid_backward(self):
        entries, calls = fixtures(), []
        receipt = weighted.backward_window(lambda encoded: Scalar(0.0, calls, 0.0), entries, plan(entries), 0)
        self.assertEqual(receipt["scaled_window_loss"], 0.0)
        self.assertEqual([v for kind, v in calls if kind == "backward"], [0.0, 0.0])

    def test_vector_loss_rejected(self):
        entries, calls = fixtures(), []
        loss = Scalar(2.0, calls)
        loss.ndim = 1
        with self.assertRaises(ValueError):
            weighted.backward_window(lambda encoded: loss, entries, plan(entries), 0)
        self.assertEqual(calls, [])

    def test_callback_input_copy_mutation_rejected_and_source_preserved(self):
        entries, calls = fixtures(), []
        before = deepcopy(entries)
        def callback(encoded):
            encoded["labels"][0] = 1
            return Scalar(2.0, calls)
        with self.assertRaisesRegex(ValueError, "Callback mutated"):
            weighted.backward_window(callback, entries, plan(entries), 0)
        self.assertEqual(entries, before)
        self.assertEqual(calls, [])

    def test_callback_external_input_or_plan_mutation_rejected(self):
        for mutate_plan in (False, True):
            entries, calls = fixtures(), []
            value = plan(entries)
            def callback(encoded):
                if mutate_plan:
                    value["optimizer_windows"] = 1
                else:
                    entries[1]["encoded"]["input_ids"][0] = 2
                return Scalar(2.0, calls)
            with self.assertRaisesRegex(ValueError, "changed during callback"):
                weighted.backward_window(callback, entries, value, 0)
            self.assertEqual(calls, [])


class LossEvaluationTests(unittest.TestCase):
    def test_validation_primary_stays_raw_and_weighted_score_is_auxiliary(self):
        entries = fixtures(split="validation")
        before = deepcopy(entries)
        result = weighted.evaluate_losses(entries, [1.0, 2.0, 4.0])
        self.assertEqual(result["split"], "validation")
        self.assertEqual(result["primary_unweighted_target_token_mean_loss"], 17 / 6)
        self.assertAlmostEqual(result["auxiliary_weighted_target_token_mean_loss"], 7 / 3)
        self.assertEqual(result["primary_weighting"], "shifted_nonignored_target_tokens")
        self.assertFalse(result["behavioral_quality_verified"])
        self.assertEqual(entries, before)

    def test_evaluation_rejects_wrong_counts_or_negative_nonfinite_losses(self):
        for losses in ([], [1.0], [1.0, 2.0, True], [1.0, 2.0, -1],
                       [1.0, 2.0, float("nan")], [1.0, 2.0, float("inf")]):
            with self.subTest(losses=losses), self.assertRaises(ValueError):
                weighted.evaluate_losses(fixtures(), losses)

    def test_evaluation_accepts_zero_losses(self):
        result = weighted.evaluate_losses(fixtures(split="validation"), [0.0, 0.0, 0.0])
        self.assertEqual(result["primary_unweighted_target_token_mean_loss"], 0.0)
        self.assertEqual(result["auxiliary_weighted_target_token_mean_loss"], 0.0)

    def test_evaluation_rejects_mixed_splits_tasks_or_bad_mask(self):
        for kind in ("split", "stream", "labels"):
            entries = fixtures()
            if kind == "labels":
                entries[0]["encoded"]["labels"][0] = 1
            else:
                entries[0][kind] = "validation" if kind == "split" else "word"
            with self.assertRaises(ValueError):
                weighted.evaluate_losses(entries, [1.0, 2.0, 3.0])

    def test_empty_evaluation_is_rejected(self):
        for entries in ([], None):
            with self.assertRaises(ValueError):
                weighted.evaluate_losses(entries, [])


NUMPY_AVAILABLE = importlib.util.find_spec("numpy") is not None


@unittest.skipUnless(NUMPY_AVAILABLE, "Actual CPU CE and finite-difference check requires NumPy")
class NumpyCausalLossChecks(unittest.TestCase):
    @staticmethod
    def causal_ce_and_gradient(encoded, theta):
        import numpy as np
        # These are freshly synthetic CPU logits, not model output or tokenized corpus.
        length, vocab = len(encoded["input_ids"]), 7
        grid = np.arange((length - 1) * vocab, dtype=np.float64).reshape(length - 1, vocab)
        basis = np.sin(grid + .3)
        logits = .02 * grid + theta * basis
        shifted_labels = np.asarray(encoded["labels"][1:], dtype=np.int64)
        valid = shifted_labels != -100
        target = shifted_labels[valid]
        active_logits, active_basis = logits[valid], basis[valid]
        shifted = active_logits - active_logits.max(axis=1, keepdims=True)
        log_partition = np.log(np.exp(shifted).sum(axis=1))
        mean_ce = (log_partition - shifted[np.arange(len(target)), target]).mean()
        probabilities = np.exp(shifted) / np.exp(shifted).sum(axis=1, keepdims=True)
        gradient = ((probabilities * active_basis).sum(axis=1)
                    - active_basis[np.arange(len(target)), target]).mean()
        return float(mean_ce), float(gradient)

    def full_objective(self, entries, theta):
        numer, total = 0.0, 0
        for entry in entries:
            loss, _ = self.causal_ce_and_gradient(entry["encoded"], theta)
            count = entry["encoded"]["target_length"]
            weight = Fraction(**entry["weight"])
            numer += float(weight * count) * loss
            total += count
        return numer / total

    def test_actual_ce_analytic_gradient_matches_finite_difference(self):
        theta, epsilon = .37, 1e-6
        entries = fixtures()
        for entry in entries:
            loss, analytic = self.causal_ce_and_gradient(entry["encoded"], theta)
            above, _ = self.causal_ce_and_gradient(entry["encoded"], theta + epsilon)
            below, _ = self.causal_ce_and_gradient(entry["encoded"], theta - epsilon)
            self.assertGreater(loss, 0)
            self.assertAlmostEqual(analytic, (above - below) / (2 * epsilon), places=8)

    def test_callback_backwards_average_matches_full_cpu_objective_for_all_partitions(self):
        theta, epsilon = .37, 1e-6
        entries = fixtures()
        finite_difference = (self.full_objective(entries, theta + epsilon)
                             - self.full_objective(entries, theta - epsilon)) / (2 * epsilon)
        objective = self.full_objective(entries, theta)
        for size in (1, 2, 3, 8):
            for shuffle in (False, True):
                with self.subTest(size=size, shuffle=shuffle):
                    value = plan(entries, accumulation_steps=size, shuffle=shuffle)
                    calls, receipts = [], []
                    def callback(encoded):
                        loss, derivative = self.causal_ce_and_gradient(encoded, theta)
                        return Scalar(loss, calls, derivative)
                    for window in range(value["optimizer_windows"]):
                        receipts.append(weighted.backward_window(callback, entries, value, window))
                    gradient = sum(v for kind, v in calls if kind == "backward") / value["optimizer_windows"]
                    measured_objective = sum(v["scaled_window_loss"] for v in receipts) / value["optimizer_windows"]
                    self.assertAlmostEqual(gradient, finite_difference, places=8)
                    self.assertAlmostEqual(measured_objective, objective, places=12)

    def test_weighted_cpu_objective_differs_from_all_one_control(self):
        entries = fixtures()
        weighted_value = self.full_objective(entries, .37)
        for entry in entries:
            entry["weight"] = ratio(1)
        self.assertNotAlmostEqual(weighted_value, self.full_objective(entries, .37), places=8)


if __name__ == "__main__":
    unittest.main()
