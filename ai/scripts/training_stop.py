#!/usr/bin/env python3
"""Offline stopping decisions for frozen 12B/31B curricula; never runs training.

Full epoch ID logs and per-row validation losses are required. Optimizer behavior
and checkpoint tensor contents remain the training runner's responsibility.
"""
import argparse
from collections import Counter, defaultdict
from copy import deepcopy
from fractions import Fraction
import json
import math
from pathlib import Path
import re
import shutil

from role_dataset import canonical, digest, file_hash, read_rows, require, safe_path, save

SCHEMA = "malssi-training-stop-policy-v2"
CHECKPOINT = re.compile(r"^[0-9a-f]{64}$")


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def fingerprint(policy):
    return digest(canonical(policy))


def valid_hash(value):
    return isinstance(value, str) and CHECKPOINT.fullmatch(value) is not None


def load_index(path):
    result = {}
    for row in read_rows(path):
        require(row["row_id"] not in result, "Duplicate source row ID")
        require(type(row["target_length"]) is int and row["target_length"] > 0, "Invalid target length")
        weight = row["weight"]
        require(set(weight) == {"numerator", "denominator"}
                and all(type(v) is int and v > 0 for v in weight.values()), "Invalid source weight")
        result[row["row_id"]] = row
    require(result and sum(Fraction(**r["weight"]) for r in result.values()) == len(result), "Invalid normalized row weights")
    return result


def validate_policy(policy):
    require(policy.get("schema") == SCHEMA, "Unsupported stop policy")
    config = policy["evaluation"]
    require(config["schedule"] == "baseline_then_each_complete_epoch"
            and config["loss"] == "sum(weight_i * mean_last_assistant_target_CE_i) / N"
            and config["minimum_complete_epochs"] == 1
            and config["normal_stop_at_complete_epoch_only"] is True
            and config["full_train_once_per_epoch"] is True
            and config["validation_never_used_for_gradient"] is True
            and config["cross_model_adapter_reuse"] is False
            and config["advance_requires_meaningful_improvement_over_phase_input"] is True
            and config["intermediate_phase_success"] == "validation_loss_target_met"
            and config["final_phase_success"] == "current_checkpoint_loss_and_role_targets_met"
            and config["final_role_evaluation_schedule"] == "each_complete_epoch"
            and config["missing_role_evaluation"] == "stop_pending_evaluation"
            and config["restore"] == "first_complete_epoch_checkpoint_meeting_phase_performance_targets"
            and config["preserve_loss_best_for_review"] is True,
            "Unsafe evaluation contract")
    completion = policy["completion"]
    require(completion["basis"] == "measured_performance"
            and all(completion[key] is True for key in ("all_phases_accepted_in_order", "role_acceptance_required",
                    "missing_evidence_means_pending", "epoch_cap_alone_is_not_success",
                    "plateau_alone_is_not_success", "deterioration_alone_is_not_success")), "Unsafe completion contract")
    for key in ("min_delta_relative", "min_delta_absolute", "deterioration_relative"):
        value = config[key]
        require(type(value) in (int, float) and math.isfinite(value) and value > 0, "Invalid loss threshold")
    for key in ("patience_evaluations", "deterioration_patience"):
        require(type(config[key]) is int and config[key] > 0, "Invalid patience")
    require(set(policy["models"]) == {"chat_12b", "cards_31b"}, "Both model roles required")
    for role, model in policy["models"].items():
        require(role in ("chat_12b", "cards_31b") and model["parameter_size"] == ("12B" if role == "chat_12b" else "31B"), "Wrong model role")
        ids = [p["id"] for p in model["phases"]]
        require(len(ids) == len(set(ids)) == 3, "Invalid phase inventory")
        require(all(type(p["safety_max_epochs"]) is int and p["safety_max_epochs"] >= 1
                    and "max_epochs" not in p for p in model["phases"]), "Invalid resource guard")
        gates = model["role_acceptance"]
        require(gates["minimum_source_families"] >= 30 and gates["minimum_family_pass_rate"] == 0.95
                and gates["must_not_regress_against_baseline"] is True, "Unsafe role acceptance gate")


def bind(defaults, roots, output):
    policy = deepcopy(read_json(defaults))
    validate_policy(policy)
    require(not output.exists(), "Use a new policy output directory")
    require(output.parent.resolve().name == "training_data", "Policy must be under ignored training_data")
    for role, root in roots.items():
        root = root.resolve(strict=True)
        course_path = root / "COURSE.json"
        course = read_json(course_path)
        require(course["role"] == role and course["model"]["family"] == "Gemma 4"
                and course["model"]["parameter_size"] == policy["models"][role]["parameter_size"], "Wrong dataset/model")
        require(course["loss"]["reduction"] == "mean_target_token_CE_per_row" and course["loss"]["weighting"] == "equal_task_then_connected_source_family", "Wrong dataset loss")
        manifest_root = root.parent if role == "chat_12b" else root
        manifest_path = manifest_root / "MANIFEST.json"
        manifest = read_json(manifest_path)
        require(file_hash(course_path) == manifest["files"][str(course_path.relative_to(manifest_root))]["sha256"], "Unbound course")
        settings = policy["models"][role]
        require([p["id"] for p in course["phases"]] == [p["id"] for p in settings["phases"]], "Phase order changed")
        settings["binding"] = {"root_at_binding": str(root), "course_sha256": file_hash(course_path),
                               "manifest_sha256": file_hash(manifest_path), "manifest_at_parent": role == "chat_12b",
                               "tokenizer_sha256": course["model"]["tokenizer_sha256"]}
        for rule, phase in zip(settings["phases"], course["phases"]):
            rule["data"] = {}
            for split in ("train", "validation"):
                part = phase["data"][split]
                path = safe_path(root, part["token_index"])
                index = load_index(path)
                checksum = file_hash(path)
                require(checksum == manifest["files"][str(path.relative_to(manifest_root))]["sha256"]
                        and len(index) == part["rows"] and all(r["split"] == split for r in index.values()), "Unbound index/split")
                rule["data"][split] = {"index": part["token_index"], "sha256": checksum, "rows": len(index),
                    "id_set_sha256": digest("\n".join(sorted(index))),
                    "files": {part[k]: manifest["files"][str((root / part[k]).relative_to(manifest_root))]
                              for k in ("path", "token_index", "token_binary")},
                    "source_groups": len({g for r in index.values() for g in r["source_group_ids"]}),
                    "source_roots": len({g for r in index.values() for g in r["source_root_ids"]})}
    output.mkdir(mode=0o700)
    (output / "scripts").mkdir()
    save(output / "POLICY.json", policy)
    save(output / "STATUS.json", {"policy_sha256": fingerprint(policy), "training_started": False,
         "training_complete": False, "role_acceptance": "pending_actual_runs_and_frozen_evaluation_suite",
         "automatic_training_hook_installed": False, "dataset_files_modified": False})
    for name in ("training_stop.py", "training_stop_defaults.json", "role_dataset.py", "test_training_stop.py"):
        shutil.copyfile(Path(__file__).with_name(name), output / "scripts" / name)
    shutil.copyfile(Path(__file__).with_name("training_stop_README.md"), output / "README.md")
    return {"status": "policy_ready", "policy_sha256": fingerprint(policy), "training_started": False}


def bound_indexes(policy, role, phase_id, root=None):
    validate_policy(policy)
    model = policy["models"][role]
    root = Path(root or model["binding"]["root_at_binding"]).resolve(strict=True)
    binding = model["binding"]
    require(file_hash(root / "COURSE.json") == binding["course_sha256"], "Dataset course changed")
    manifest = (root.parent if binding["manifest_at_parent"] else root) / "MANIFEST.json"
    require(file_hash(manifest) == binding["manifest_sha256"], "Dataset manifest changed; rebind deliberately")
    for name, expected in binding["tokenizer_sha256"].items():
        require(file_hash(safe_path(root, "tokenizer/" + name)) == expected, "Tokenizer artifact changed")
    phase = next(p for p in model["phases"] if p["id"] == phase_id)
    indexes = {}
    for split, part in phase["data"].items():
        for name, metadata in part["files"].items():
            actual = safe_path(root, name)
            require(actual.stat().st_size == metadata["bytes"] and file_hash(actual) == metadata["sha256"], "Dataset file changed")
        path = safe_path(root, part["index"])
        require(file_hash(path) == part["sha256"], "Index changed")
        indexes[split] = load_index(path)
        require(len(indexes[split]) == part["rows"]
                and digest("\n".join(sorted(indexes[split]))) == part["id_set_sha256"], "Index inventory changed")
    require(not set(indexes["train"]) & set(indexes["validation"]), "Train/validation identity overlap")
    return phase, indexes


def evidence_path(base, reference):
    require(set(reference) == {"path", "sha256"} and valid_hash(reference["sha256"]), "Invalid evidence reference")
    path = safe_path(base, reference["path"])
    require(file_hash(path) == reference["sha256"], "Evidence changed")
    return path


def evidence_rows(base, reference):
    return list(read_rows(evidence_path(base, reference)))


def baseline_judgments_hash(evidence):
    """Freeze actual baseline judgments as well as its checkpoint and inputs."""
    rows = [{"case_id": r["case_id"], "input_sha256": r["input_sha256"], "baseline": r["baseline"]}
            for r in evidence["cases"]]
    return fingerprint(sorted(rows, key=lambda r: r["case_id"]))


def epoch_coverage(rows, expected):
    require(all(set(r) == {"row_id"} for r in rows), "Invalid consumed-ID log")
    counts = Counter(r["row_id"] for r in rows)
    require(set(counts) == set(expected) and all(n == 1 for n in counts.values()), "Incomplete or duplicate epoch coverage")


def validation_loss(rows, expected):
    seen, losses = set(), []
    for row in rows:
        require(set(row) == {"row_id", "mean_target_ce", "target_tokens"}, "Invalid validation metric")
        identity = row["row_id"]
        require(identity in expected and identity not in seen, "Unexpected/duplicate validation row")
        seen.add(identity)
        require(type(row["target_tokens"]) is int and row["target_tokens"] == expected[identity]["target_length"], "Target mask/length mismatch")
        loss = row["mean_target_ce"]
        require(type(loss) in (int, float) and math.isfinite(loss) and loss >= 0, "Non-finite/invalid validation loss")
        contribution = float(Fraction(**expected[identity]["weight"]) / len(expected)) * loss
        require(math.isfinite(contribution), "Non-finite weighted validation loss")
        losses.append(contribution)
    require(seen == set(expected), "Incomplete validation coverage")
    try:
        result = math.fsum(losses)
    except OverflowError as error:
        raise ValueError("Non-finite aggregate validation loss") from error
    require(math.isfinite(result), "Non-finite aggregate validation loss")
    return result


def decide(policy, role, phase_id, history, indexes, evidence_base, previous=None, role_suite=None, train_lineage=None):
    """Pure decision over recorded evidence; no optimizer/model side effects."""
    validate_policy(policy)
    rules = policy["evaluation"]
    model = policy["models"][role]
    position = [p["id"] for p in model["phases"]].index(phase_id)
    phase = model["phases"][position]
    final_phase = position == len(model["phases"]) - 1
    require(history["schema"] == "malssi-training-history-v2" and history["policy_sha256"] == fingerprint(policy)
            and history["model_role"] == role and history["phase_id"] == phase_id, "Wrong history/policy binding")
    require(isinstance(history["run_id"], str) and history["run_id"].strip() and valid_hash(history["input_checkpoint_sha256"]), "Missing run/input checkpoint identity")
    require(valid_hash(history["role_eval_suite_sha256"]) and valid_hash(history["model_start_checkpoint_sha256"])
            and valid_hash(history["role_baseline_judgments_sha256"]),
            "Freeze the role-evaluation suite, baseline judgments and model-start checkpoint before training")
    if position:
        require(previous is not None and previous["status"] == "stop_phase_accepted"
                and previous["policy_sha256"] == fingerprint(policy) and previous["model_role"] == role
                and previous["phase_id"] == model["phases"][position - 1]["id"]
                and previous["run_id"] == history["run_id"]
                and previous["role_eval_suite_sha256"] == history["role_eval_suite_sha256"]
                and previous["role_baseline_judgments_sha256"] == history["role_baseline_judgments_sha256"]
                and previous["model_start_checkpoint_sha256"] == history["model_start_checkpoint_sha256"]
                and previous["accepted_phase_ids"] == [p["id"] for p in model["phases"][:position]]
                and previous["selected_checkpoint_sha256"] == history["input_checkpoint_sha256"]
                and history["previous_decision_sha256"] == digest(canonical(previous)), "Missing/wrong preceding accepted checkpoint")
    else:
        require(previous is None and history.get("previous_decision_sha256") is None, "First phase must start its own model chain")
        require(history["model_start_checkpoint_sha256"] == history["input_checkpoint_sha256"], "First phase model start differs")
    common = {"schema": "malssi-training-decision-v2", "policy_sha256": fingerprint(policy),
        "history_sha256": digest(canonical(history)), "model_role": role, "phase_id": phase_id, "run_id": history["run_id"],
        "input_checkpoint_sha256": history["input_checkpoint_sha256"], "scope": "offline_supplied_evidence_only",
        "model_start_checkpoint_sha256": history["model_start_checkpoint_sha256"],
        "role_eval_suite_sha256": history["role_eval_suite_sha256"],
        "role_baseline_judgments_sha256": history["role_baseline_judgments_sha256"],
        "training_executed_by_tool": False, "checkpoint_tensor_contents_verified": False, "automatic_deployment": False}
    fatal = history.get("fatal_error")
    if fatal:
        require(fatal in policy["abort_immediately_on"], "Unknown fatal error")
        return {**common, "status": "abort", "reason": fatal, "phase_complete": False,
                "model_training_criteria_satisfied_from_supplied_evidence": False,
                "accepted_phase_ids": [p["id"] for p in model["phases"][:position]],
                "selected_checkpoint_sha256": None, "fallback_checkpoint_sha256": history["input_checkpoint_sha256"]}
    events = history["events"]
    require(events and [e["epoch"] for e in events] == list(range(len(events)))
            and all(type(e["epoch"]) is int for e in events), "Baseline then contiguous complete epochs required")
    require(events[0]["checkpoint_sha256"] == history["input_checkpoint_sha256"] and events[0].get("train") is None, "Invalid baseline")
    baseline = None
    best = None
    reference = minimum = None
    stale = bad = 0
    reason = None
    selected = role_result = None
    status = "continue"
    checkpoints = set()
    for event in events:
        require(reason is None, "History continued after stopping criterion")
        epoch = event["epoch"]
        checkpoint = event["checkpoint_sha256"]
        require(valid_hash(checkpoint) and checkpoint not in checkpoints, "Missing/reused checkpoint identity")
        checkpoints.add(checkpoint)
        if epoch:
            epoch_coverage(evidence_rows(evidence_base, event["train"]), indexes["train"])
        loss = validation_loss(evidence_rows(evidence_base, event["validation"]), indexes["validation"])
        if epoch == 0:
            baseline = reference = minimum = loss
            continue
        if best is None or loss < best["loss"]:
            best = {"epoch": epoch, "loss": loss, "checkpoint_sha256": checkpoint}
        delta = max(rules["min_delta_absolute"], abs(reference) * rules["min_delta_relative"])
        if reference - loss >= delta:
            reference, stale = loss, 0
        else:
            stale += 1
        margin = max(rules["min_delta_absolute"], abs(minimum) * rules["deterioration_relative"])
        bad = bad + 1 if loss > minimum + margin else 0
        minimum = min(minimum, loss)
        improved = baseline - loss >= max(rules["min_delta_absolute"], abs(baseline) * rules["min_delta_relative"])
        if final_phase:
            if role_suite is None or train_lineage is None or event.get("role_evaluation") is None:
                reason, status = "role_evaluation_missing", "stop_pending_evaluation"
                continue
            role_evidence = read_json(evidence_path(evidence_base, event["role_evaluation"]))
            role_result = score_role(policy, role, role_suite, role_evidence, checkpoint,
                                     history["model_start_checkpoint_sha256"], history["role_eval_suite_sha256"],
                                     history["role_baseline_judgments_sha256"], train_lineage)
        if improved and (not final_phase or role_result["status"] == "role_acceptance_passed"):
            reason = "role_performance_target_met" if final_phase else "validation_performance_target_met"
            status, selected = "stop_phase_accepted", checkpoint
        elif bad >= rules["deterioration_patience"]:
            reason = "validation_deterioration"
            status = "stop_phase_rejected"
        elif stale >= rules["patience_evaluations"]:
            reason = "validation_plateau"
            status = "stop_phase_rejected"
        elif epoch >= phase["safety_max_epochs"]:
            reason, status = "resource_guard", "stop_resource_limit"
    return {**common, "status": status, "reason": reason, "phase_complete": status == "stop_phase_accepted",
            "accepted_phase_ids": [p["id"] for p in model["phases"][:position + (status == "stop_phase_accepted")]],
            "epochs_completed": len(events) - 1, "baseline_validation_loss": baseline,
            "required_loss_reduction": max(rules["min_delta_absolute"], abs(baseline) * rules["min_delta_relative"]),
            "best_complete_epoch": best, "stale_evaluations": stale, "deteriorated_evaluations": bad,
            "selected_checkpoint_sha256": selected,
            "fallback_checkpoint_sha256": history["input_checkpoint_sha256"],
            "role_acceptance": role_result,
            "model_training_criteria_satisfied_from_supplied_evidence": final_phase and status == "stop_phase_accepted"}


def assess_role(policy, role, suite, evidence, decision, train_lineage):
    """Recheck final completion, including the role evidence that stopped training."""
    validate_policy(policy)
    require(decision["policy_sha256"] == fingerprint(policy) and decision["model_role"] == role
            and decision["status"] == "stop_phase_accepted"
            and decision["reason"] == "role_performance_target_met" and decision["phase_complete"] is True
            and decision["accepted_phase_ids"] == [p["id"] for p in policy["models"][role]["phases"]]
            and decision["phase_id"] == policy["models"][role]["phases"][-1]["id"], "All model phases must be accepted in order")
    result = score_role(policy, role, suite, evidence, decision["selected_checkpoint_sha256"],
                        decision["model_start_checkpoint_sha256"], decision["role_eval_suite_sha256"],
                        decision["role_baseline_judgments_sha256"], train_lineage)
    require(result == decision["role_acceptance"], "Final role evidence differs from stopping decision")
    return {**result, "model_training_criteria_satisfied_from_supplied_evidence": result["status"] == "role_acceptance_passed"}


def score_role(policy, role, suite, evidence, candidate, baseline, suite_sha256, baseline_sha256, train_lineage):
    """Family-level performance of one checkpoint; never claims training complete."""
    validate_policy(policy)
    gates = policy["models"][role]["role_acceptance"]
    require(valid_hash(candidate) and valid_hash(baseline) and candidate != baseline, "Invalid role-evaluation checkpoint identities")
    require(suite["schema"] == "malssi-role-evaluation-suite-v1" and suite["model_role"] == role
            and suite["split"] == "development", "Role selection must use a frozen development suite")
    require(evidence["suite_sha256"] == digest(canonical(suite)) and evidence["policy_sha256"] == fingerprint(policy)
            and suite_sha256 == digest(canonical(suite))
            and evidence["candidate_checkpoint_sha256"] == candidate and evidence["baseline_checkpoint_sha256"] == baseline,
            "Role evaluation bindings differ")
    require(baseline_judgments_hash(evidence) == baseline_sha256, "Baseline judgments changed after training started")
    cases = {row["case_id"]: row for row in suite["cases"]}
    require(len(cases) == len(suite["cases"]) and cases, "Duplicate/empty role suite")
    parent, owners = {key: key for key in cases}, {}
    def family(key):
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key
    for row in cases.values():
        require(isinstance(row["source_family_id"], str) and row["source_family_id"]
                and valid_hash(row["input_sha256"]), "Missing family/input identity")
        origins = row["source_lineage_ids"]
        require(isinstance(origins, list) and origins and len(origins) == len(set(origins))
                and all(isinstance(v, str) and v for v in origins), "Missing evaluation source lineage")
        require(not ({row["source_family_id"]} | set(origins)) & train_lineage, "Role evaluation overlaps training lineage")
        for origin in [row["source_family_id"], *origins]:
            if origin in owners:
                parent[family(row["case_id"])] = family(owners[origin])
            owners[origin] = row["case_id"]
    expected_checks = set(gates["critical_all_pass"] + gates["quality_checks"])
    seen, groups = set(), defaultdict(list)
    for row in evidence["cases"]:
        identity = row["case_id"]
        require(identity in cases and identity not in seen, "Unknown/duplicate evaluated case")
        seen.add(identity)
        require(row["input_sha256"] == cases[identity]["input_sha256"], "Evaluation case changed")
        for variant in ("candidate", "baseline"):
            checks = row[variant]
            require(set(checks) == expected_checks and all(type(v) is bool for v in checks.values()), "Missing/nonboolean quality judgments")
        groups[family(identity)].append(row)
    require(seen == set(cases) and len(groups) >= gates["minimum_source_families"], "Incomplete/too-small role evaluation")
    failures, rates = [], {}
    for check in sorted(expected_checks):
        counts = {variant: sum(all(row[variant][check] for row in members) for members in groups.values())
                  for variant in ("candidate", "baseline")}
        rates[check] = {variant: counts[variant] / len(groups) for variant in counts}
        if check in gates["critical_all_pass"] and counts["candidate"] != len(groups):
            failures.append(check + ":critical_error")
        if check in gates["quality_checks"] and counts["candidate"] / len(groups) < gates["minimum_family_pass_rate"]:
            failures.append(check + ":below_95_percent")
        if counts["candidate"] < counts["baseline"]:
            failures.append(check + ":regression")
    return {"status": "role_acceptance_passed" if not failures else "role_acceptance_failed",
            "policy_sha256": fingerprint(policy), "model_role": role, "suite_sha256": digest(canonical(suite)),
            "candidate_checkpoint_sha256": candidate, "source_families": len(groups), "cases": len(cases),
            "evidence_sha256": fingerprint(evidence), "baseline_judgments_sha256": baseline_sha256,
            "failures": failures, "family_pass_rates": rates, "judgments_independently_generated_by_this_tool": False,
            "model_training_criteria_satisfied_from_supplied_evidence": False,
            "unseen_test_passed": False, "automatic_deployment": False}


def bound_train_lineage(policy, role, root=None):
    lineage = set()
    for phase in policy["models"][role]["phases"]:
        _, indexes = bound_indexes(policy, role, phase["id"], root)
        lineage.update(identity for row in indexes["train"].values()
                       for field in ("source_group_ids", "source_root_ids") for identity in row[field])
    return lineage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("bind", "decide", "assess-role"))
    parser.add_argument("--defaults", type=Path, default=Path(__file__).with_name("training_stop_defaults.json"))
    parser.add_argument("--chat-root", type=Path)
    parser.add_argument("--cards-root", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--policy", type=Path)
    parser.add_argument("--model", choices=("chat_12b", "cards_31b"))
    parser.add_argument("--phase")
    parser.add_argument("--history", type=Path)
    parser.add_argument("--previous", type=Path)
    parser.add_argument("--dataset-root", type=Path)
    parser.add_argument("--suite", type=Path)
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--decision", type=Path)
    args = parser.parse_args()
    if args.command == "bind":
        if not all((args.chat_root, args.cards_root, args.output)):
            parser.error("bind requires --chat-root --cards-root --output")
        result = bind(args.defaults, {"chat_12b": args.chat_root, "cards_31b": args.cards_root}, args.output)
    else:
        if not args.policy or not args.model:
            parser.error("--policy and --model required")
        policy = read_json(args.policy)
        try:
            if args.command == "decide":
                if not args.phase or not args.history:
                    parser.error("decide requires --phase --history")
                _, indexes = bound_indexes(policy, args.model, args.phase, args.dataset_root)
                final_phase = args.phase == policy["models"][args.model]["phases"][-1]["id"]
                suite = read_json(args.suite) if args.suite else None
                lineage = bound_train_lineage(policy, args.model, args.dataset_root) if final_phase and suite is not None else None
                result = decide(policy, args.model, args.phase, read_json(args.history), indexes,
                                args.history.resolve().parent, read_json(args.previous) if args.previous else None,
                                role_suite=suite, train_lineage=lineage)
            else:
                if not all((args.suite, args.evidence, args.decision)):
                    parser.error("assess-role requires --suite --evidence --decision")
                lineage = bound_train_lineage(policy, args.model, args.dataset_root)
                result = assess_role(policy, args.model, read_json(args.suite), read_json(args.evidence), read_json(args.decision), lineage)
        except (ValueError, KeyError, TypeError, OSError, StopIteration) as error:
            result = {"status": "abort_invalid_evidence", "phase_complete": False, "automatic_deployment": False,
                      "model_training_criteria_satisfied_from_supplied_evidence": False,
                      "error_type": type(error).__name__, "reason": str(error)}
        if args.output:
            save(args.output, result)
    print(json.dumps(result, ensure_ascii=False))
    if result["status"].startswith("abort"):
        raise SystemExit(2)


if __name__ == "__main__":
    main()
