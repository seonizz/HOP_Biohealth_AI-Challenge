"""Explicit, task-local consumption of immutable supporter loss weights.

This is an opt-in backward helper, not a replacement for the frozen trainer.
The caller verifies the policy/export bindings, supplies already encoded rows,
and owns model loading, optimizer/zero_grad/step, clipping, window order, resume,
and complete-epoch accounting. No sampling or duplicate examples are introduced.

For K planned windows and Z = sum_i(w_i * n_i), each row's mean causal target
loss is multiplied by K*w_i*n_i/Z. Z is fixed for the complete task/train split,
including a last partial window; it must equal the original target-token total.
At fixed parameters the average of all planned window gradients equals the
full weighted-objective gradient. This does not imply identical optimizer
trajectories, model quality, input exposure, or lower forward-computation cost.

Weights never enter token IDs or labels. Validation's primary score remains the
unweighted target-token mean; its weighted score is explicitly auxiliary.
Importing this module needs neither torch nor a model/tokenizer.
"""
from __future__ import annotations

from copy import deepcopy
from fractions import Fraction
import hashlib
import json
import math
from numbers import Real
import random

from .gemma4_token_validation import collate_examples
from .supporter_task_composition import check_lengths


SCHEMA = "malssi-supporter-weighted-loss-plan-v1"
TASKS = {"conversation", "sentence", "word", "state_observations", "relationship_memory"}
ENTRY_FIELDS = {"stream", "split", "row_id", "encoded", "weight"}


class WeightedLossError(ValueError):
    """An input, immutable plan, or callback violates the weighted-loss contract."""


def _require(condition, message):
    if not condition:
        raise WeightedLossError(message)


def _json_bytes(value):
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=False,
                          separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, OverflowError) as exc:
        raise WeightedLossError("Noncanonical JSON input") from exc


def _digest(value):
    return hashlib.sha256(_json_bytes(value)).hexdigest()


def _ratio(value):
    return {"numerator": value.numerator, "denominator": value.denominator}


def _weight(value):
    _require(isinstance(value, dict) and set(value) == {"numerator", "denominator"},
             "Weight must be an exact rational object")
    numerator, denominator = value["numerator"], value["denominator"]
    _require(type(numerator) is int and type(denominator) is int
             and numerator > 0 and denominator > 0, "Weight requires positive integer terms")
    _require(math.gcd(numerator, denominator) == 1, "Weight must be a reduced fraction")
    return Fraction(numerator, denominator)


def _finite_number(value, message, *, positive):
    _require(isinstance(value, Real) and not isinstance(value, bool), message)
    try:
        result = float(value)
    except (OverflowError, TypeError, ValueError) as exc:
        raise WeightedLossError(message) from exc
    _require(math.isfinite(result) and (result > 0 if positive else result >= 0), message)
    return result


def _checked_entries(entries, *, task=None, split=None, pad_id=0, max_length=4096):
    _require(isinstance(entries, (list, tuple)) and bool(entries), "Empty weighted examples")
    _require(type(pad_id) is int and pad_id >= 0, "Invalid pad ID")
    _require(type(max_length) is int and max_length > 0, "Invalid maximum length")
    _require(task is None or isinstance(task, str) and task in TASKS, "Unknown task")
    counts, weights, seen = [], [], set()
    observed_task, observed_split = task, split
    for entry in entries:
        _require(isinstance(entry, dict) and set(entry) == ENTRY_FIELDS, "Unexpected weighted entry fields")
        stream, partition, identity = entry["stream"], entry["split"], entry["row_id"]
        _require(isinstance(stream, str) and stream in TASKS, "Unknown entry task")
        _require(isinstance(partition, str) and partition in {"train", "validation"}, "Invalid split")
        if observed_task is None:
            observed_task = stream
        if observed_split is None:
            observed_split = partition
        _require(stream == observed_task and partition == observed_split, "Mixed task or split")
        _require(isinstance(identity, str) and bool(identity.strip()) and identity not in seen,
                 "Missing or duplicate row identity")
        seen.add(identity)
        try:
            collate_examples([entry["encoded"]], pad_id, max_length, packing=False)
        except (ValueError, TypeError, KeyError) as exc:
            raise WeightedLossError("Invalid unshifted encoded example") from exc
        count = sum(label != -100 for label in entry["encoded"]["labels"][1:])
        _require(count == entry["encoded"]["target_length"] and count > 0,
                 "Invalid shifted target count")
        try:
            check_lengths(entry["encoded"]["prefix_length"], count)
        except ValueError as exc:
            raise WeightedLossError("Example violates the reserved 8192-output token budget") from exc
        counts.append(count)
        weights.append(_weight(entry["weight"]))
    raw_total = sum(counts)
    weighted_total = sum((weight * count for weight, count in zip(weights, counts)), Fraction())
    _require(weighted_total == raw_total, "Weights changed the task/split target-token mass")
    _json_bytes(entries)
    return observed_task, observed_split, counts, weights, raw_total, weighted_total


def make_plan(entries, *, task, pad_id, accumulation_steps=8, max_length=4096,
              seed=3407, shuffle=True, bindings):
    """Bind one train task, complete row order, weights and fixed epoch divisor.

    ``bindings`` must come from the caller's independently verified policy and
    source manifests. A hash here binds values; it is not source authentication.
    """
    _require(type(accumulation_steps) is int and accumulation_steps > 0,
             "Invalid accumulation steps")
    _require(type(seed) is int and type(shuffle) is bool, "Invalid shuffle settings")
    _require(isinstance(bindings, dict) and bool(bindings)
             and all(isinstance(key, str) and bool(key) for key in bindings), "Missing policy bindings")
    snapshot = deepcopy(entries)
    task, split, counts, weights, raw_total, weighted_total = _checked_entries(
        snapshot, task=task, split="train", pad_id=pad_id, max_length=max_length)
    order = list(range(len(snapshot)))
    if shuffle:
        random.Random(seed).shuffle(order)
    windows = [order[start:start + accumulation_steps] for start in range(0, len(order), accumulation_steps)]
    count_windows = len(windows)
    coefficients = [count_windows * weight * count / weighted_total
                    for weight, count in zip(weights, counts)]
    for coefficient in coefficients:
        _finite_number(coefficient, "Coefficient is not representable as a positive finite float", positive=True)
    plan = {"schema_version": SCHEMA, "task": task, "split": split,
            "settings": {"pad_id": pad_id, "accumulation_steps": accumulation_steps,
                         "max_length": max_length, "seed": seed, "shuffle": shuffle},
            "bindings": deepcopy(bindings), "entries_sha256": _digest(snapshot),
            "rows": len(snapshot), "order": order, "windows": windows,
            "optimizer_windows": count_windows, "raw_target_tokens": raw_total,
            "weighted_target_tokens": _ratio(weighted_total),
            "row_coefficients": [_ratio(coefficient) for coefficient in coefficients],
            "normalization": "fixed_task_train_epoch_K_times_weighted_targets_over_Z"}
    _require(_digest(entries) == plan["entries_sha256"], "Examples changed during plan construction")
    return {**plan, "plan_sha256": _digest(plan)}


def _validate_plan(entries, plan):
    _require(isinstance(plan, dict) and plan.get("schema_version") == SCHEMA, "Invalid plan schema")
    try:
        rebuilt = make_plan(entries, task=plan["task"], bindings=plan["bindings"], **plan["settings"])
    except (KeyError, TypeError) as exc:
        raise WeightedLossError("Invalid plan fields") from exc
    _require(_json_bytes(plan) == _json_bytes(rebuilt), "Plan or bound examples changed")
    return rebuilt


def _scalar_mean_loss(loss):
    _require(type(getattr(loss, "ndim", None)) is int and loss.ndim == 0,
             "Callback must return a scalar mean loss object")
    _require(callable(getattr(loss, "detach", None)) and callable(getattr(loss, "backward", None)),
             "Loss object must support detach and backward")
    try:
        value = loss.detach().item()
    except (AttributeError, TypeError, ValueError, RuntimeError) as exc:
        raise WeightedLossError("Cannot read detached scalar loss") from exc
    return _finite_number(value, "Mean loss must be nonnegative and finite", positive=False)


def backward_window(loss_fn, entries, plan, window_index):
    """Consume fixed coefficients in real ``loss * coefficient`` backward calls.

    The callback receives a deep copy of one encoded row and must return its mean
    CE over exactly the shifted nonignored labels. It must not preweight the loss.
    This helper does not zero/step an optimizer or track whether a caller already
    executed a window. Callers must execute each planned window exactly once and
    must not mark a partial/failed epoch complete. A later failure cannot undo
    gradients from earlier rows; caller discards/clears that failed window.
    """
    _require(callable(loss_fn), "Loss callback is not callable")
    snapshot = deepcopy(entries)
    verified = _validate_plan(snapshot, plan)
    _require(type(window_index) is int and 0 <= window_index < verified["optimizer_windows"],
             "Invalid window index")
    input_sha, plan_sha = verified["entries_sha256"], _digest(verified)
    _require(_digest(entries) == input_sha and _digest(plan) == plan_sha,
             "Bound input or plan changed during validation")
    raw_loss_sum, scaled_sum, raw_count = 0.0, 0.0, 0
    coefficient_sum = Fraction()
    for index in verified["windows"][window_index]:
        row = deepcopy(snapshot[index]["encoded"])
        row_sha = _digest(row)
        loss = loss_fn(row)
        _require(_digest(row) == row_sha, "Callback mutated its encoded input")
        _require(_digest(entries) == input_sha and _digest(plan) == plan_sha,
                 "Bound input or plan changed during callback")
        value = _scalar_mean_loss(loss)
        coefficient = _weight(verified["row_coefficients"][index])
        scalar = _finite_number(coefficient, "Invalid float coefficient", positive=True)
        weighted_loss = loss * scalar
        _scalar_mean_loss(weighted_loss)
        weighted_loss.backward()
        _require(_digest(entries) == input_sha and _digest(plan) == plan_sha,
                 "Bound input or plan changed during backward")
        count = snapshot[index]["encoded"]["target_length"]
        raw_loss_sum += value * count
        raw_count += count
        scaled_sum += value * scalar
        coefficient_sum += coefficient
    _require(math.isfinite(raw_loss_sum) and math.isfinite(scaled_sum), "Nonfinite accumulated loss")
    return {"plan_sha256": verified["plan_sha256"], "window_index": window_index,
            "rows": len(verified["windows"][window_index]), "raw_target_tokens": raw_count,
            "sum_of_coefficients": _ratio(coefficient_sum),
            "primary_unweighted_target_token_mean_loss": raw_loss_sum / raw_count,
            "scaled_window_loss": scaled_sum,
            "optimizer_owned_by_caller": True, "complete_epoch_verified": False}


def evaluate_losses(entries, losses):
    """Aggregate supplied per-row mean losses; raw primary and weighted auxiliary.

    Entries must belong to a single task and a single train or validation split.
    There is no forward/model call, gradient, or behavioral-quality claim here.
    """
    _require(isinstance(entries, (list, tuple)) and bool(entries), "Empty weighted examples")
    _require(isinstance(losses, (list, tuple)) and len(losses) == len(entries),
             "Loss count must match entries")
    task, split, counts, weights, raw_total, weighted_total = _checked_entries(
        entries, max_length=69632)
    values = [_finite_number(loss, "Loss must be nonnegative and finite", positive=False) for loss in losses]
    primary = math.fsum(value * count for value, count in zip(values, counts)) / raw_total
    auxiliary = math.fsum(value * float(weight * count) for value, weight, count in zip(values, weights, counts)) / float(weighted_total)
    _require(math.isfinite(primary) and math.isfinite(auxiliary), "Nonfinite evaluation aggregate")
    return {"task": task, "split": split, "rows": len(entries), "raw_target_tokens": raw_total,
            "weighted_target_tokens": _ratio(weighted_total),
            "primary_unweighted_target_token_mean_loss": primary,
            "auxiliary_weighted_target_token_mean_loss": auxiliary,
            "primary_weighting": "shifted_nonignored_target_tokens",
            "auxiliary_weighting": "group_weight_times_shifted_nonignored_target_tokens",
            "behavioral_quality_verified": False}
