"""Offline, hash-bound evidence accounting for public support-agent regressions.

This module never runs a model or decides response semantics. Independent
reviewers supply judgments; validating their records is not clinical approval.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path


DEFAULT_DIRECTORY = Path(__file__).resolve().parents[1] / "docs" / "support_agent"


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def text_digest(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def require(condition, message):
    if not condition:
        raise ValueError(message)


def _object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _parse(text):
    def invalid_constant(value):
        raise ValueError(f"invalid JSON constant: {value}")
    return json.loads(text, object_pairs_hook=_object, parse_constant=invalid_constant)


def read_jsonl(path):
    return [_parse(line) for line in Path(path).read_text(encoding="utf-8").splitlines()
            if line.strip()]


def _nonempty(value, field):
    require(isinstance(value, str) and bool(value.strip()), f"missing/invalid {field}")


def _timestamp(value, field):
    _nonempty(value, field)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"invalid {field}") from error
    require(parsed.tzinfo is not None, f"{field} must include timezone")
    return parsed


def load_suite(directory=DEFAULT_DIRECTORY):
    directory = Path(directory)
    cases = read_jsonl(directory / "adversarial_cases.jsonl")
    protocol = _parse((directory / "evaluation_protocol.json").read_text(encoding="utf-8"))
    validate_suite(cases, protocol)
    return cases, protocol


def validate_suite(cases, protocol):
    """The file loader and direct evaluator share the same nonempty-group gate."""
    require(isinstance(cases, list) and cases and all(isinstance(c, dict) for c in cases),
            "suite requires nonempty case objects")
    require(isinstance(protocol, dict), "suite requires protocol object")
    require([c.get("case_id") for c in cases] == [f"T{i:02}" for i in range(1, 31)],
            "suite must contain T01–T30 exactly once in order")
    definitions = protocol.get("case_group_definitions")
    require(isinstance(definitions, dict) and set(definitions) == {c["case_id"] for c in cases},
            "missing/mismatched case-group definitions")
    scenarios = []
    for case in cases:
        case_scenarios = case.get("scenarios")
        require(isinstance(case_scenarios, list) and case_scenarios
                and all(isinstance(s, dict) for s in case_scenarios),
                f"{case['case_id']}: scenarios must be a nonempty list of execution units")
        require(case["scenario_group_id"] == case["case_id"], "case-group mismatch")
        require(case["kind"] in {"response", "data_production"}, "invalid case kind")
        definition = definitions[case["case_id"]]
        require(isinstance(definition, dict) and definition.get("kind") == case["kind"],
                "case-group kind mismatch")
        scenario_ids = [s.get("scenario_id") for s in case_scenarios]
        require(all(isinstance(s, str) and s.strip() for s in scenario_ids), "invalid scenario ID")
        require(scenario_ids == definition.get("scenario_ids"), "case-group scenario membership mismatch")
        if case["kind"] == "data_production":
            futures = case.get("future_fixtures")
            require(isinstance(futures, list) and len(futures) == 2
                    and all(isinstance(f, dict) for f in futures), "T30 requires two future fixtures")
            future_ids = [f.get("future_id") for f in futures]
            require(all(isinstance(f, str) and f.strip() for f in future_ids)
                    and len(set(future_ids)) == 2 and future_ids == definition.get("future_ids"),
                    "T30 future fixture membership mismatch")
        conditions = case["required_conditions"] + case["forbidden_conditions"]
        ids = [c["id"] for c in conditions]
        require(ids and len(ids) == len(set(ids)), "missing/duplicate condition IDs")
        for condition in conditions:
            _nonempty(condition["text"], "condition text")
        for scenario in case_scenarios:
            messages = scenario["input"]["messages"]
            require(isinstance(messages, list) and messages
                    and all(isinstance(m, dict) and m.get("role") in {"user", "assistant"}
                    and isinstance(m.get("content"), str) and m["content"].strip() for m in messages),
                    "invalid fixture messages")
            require(scenario["input_characters"] == sum(len(m["content"]) for m in messages),
                    "fixture character count mismatch")
            require(scenario["input_utf8_bytes"] == sum(len(m["content"].encode()) for m in messages),
                    "fixture UTF-8 length mismatch")
            scenarios.append(scenario["scenario_id"])
    require(len(scenarios) == len(set(scenarios)) == protocol["counts"]["execution_units"],
            "suite execution-unit count mismatch")
    require(len(cases) == protocol["counts"]["case_groups"], "suite case-group count mismatch")
    for kind, count_field in (("response", "response_case_groups"),
                              ("data_production", "data_production_case_groups")):
        require(sum(c["kind"] == kind for c in cases) == protocol["counts"][count_field],
                "suite case-group kind count mismatch")


def templates(cases, protocol):
    return [{"scenario_id": scenario["scenario_id"], "case_id": case["case_id"],
             "case_sha256": digest(case), "input_sha256": digest(scenario["input"]),
             "protocol_sha256": digest(protocol), "status": "not_run"}
            for case in cases for scenario in case["scenarios"]]


def _execution(case, scenario, run):
    require(isinstance(run, dict), "executed record requires run object")
    for field in ("producer_id", "run_id", "service_policy_version"):
        _nonempty(run.get(field), field)
    recorded_at = _timestamp(run.get("recorded_at"), "recorded_at")
    require(run.get("actual_execution") is True, "actual_execution attestation required")
    structure_pass = True
    if case["kind"] == "response":
        _nonempty(run.get("model_id"), "model_id")
        _nonempty(run.get("response"), "actual response")
        require(canonical(run.get("input_messages")) == canonical(scenario["input"]["messages"]),
                "actual input_messages differ from fixture; not this test execution")
        output_hash = text_digest(run["response"])
        if case["case_id"] == "T29":
            require(type(run.get("input_token_count")) is int and run["input_token_count"] > 0,
                    "T29 requires actual input_token_count")
            _nonempty(run.get("tokenizer_id"), "T29 tokenizer_id")
    else:
        _nonempty(run.get("pipeline_version"), "pipeline_version")
        artifacts = run.get("artifacts")
        futures = {f["future_id"]: f for f in case["future_fixtures"]}
        require(isinstance(artifacts, list) and len(artifacts) == len(futures),
                "T30 requires two actual production artifacts")
        require({a.get("future_id") for a in artifacts} == set(futures),
                "T30 missing/duplicate/unknown future ID")
        annotations = []
        for artifact in artifacts:
            require(artifact.get("future_sha256") == digest(futures[artifact["future_id"]]),
                    "T30 future hash mismatch")
            require(artifact.get("artifact_sha256") == digest(
                {k: v for k, v in artifact.items() if k != "artifact_sha256"}),
                "T30 artifact hash mismatch")
            require(isinstance(artifact.get("input_messages"), list), "T30 missing actual input")
            annotation = artifact.get("annotation")
            require(isinstance(annotation, dict), "T30 missing actual annotation")
            for field in ("preferred_action", "target_response"):
                _nonempty(annotation.get(field), f"T30 annotation.{field}")
            structure_pass &= canonical(artifact["input_messages"]) == canonical(scenario["input"]["messages"])
            annotations.append(annotation)
        structure_pass &= all(canonical(a) == canonical(annotations[0]) for a in annotations)
        output_hash = digest(artifacts)
    require(run.get("output_sha256") == output_hash, "execution output hash mismatch")
    return output_hash, bool(structure_pass), recorded_at


def _reviews(case, scenario, protocol, run, reviews, output_hash, recorded_at):
    require(isinstance(reviews, list), "reviews must be a list")
    condition_ids = {c["id"] for c in case["required_conditions"] + case["forbidden_conditions"]}
    seen, votes, critical = set(), [], False
    for review in reviews:
        require(isinstance(review, dict), "review must be an object")
        reviewer = review.get("reviewer_id")
        _nonempty(reviewer, "reviewer_id")
        require(reviewer != run["producer_id"] and reviewer not in seen,
                "self-review or duplicate reviewer")
        seen.add(reviewer)
        require(review.get("reviewer_kind") in {"human_independent", "ai_independent"},
                "independent semantic reviewer required; keyword checks are not reviews")
        require(review.get("independent_of_producer") is True, "independence attestation required")
        require(_timestamp(review.get("reviewed_at"), "reviewed_at") >= recorded_at,
                "review predates execution")
        require(review.get("rubric_version") == protocol["version"], "rubric version mismatch")
        for field, value in (("case_sha256", case), ("input_sha256", scenario["input"]),
                             ("protocol_sha256", protocol)):
            require(review.get(field) == digest(value), f"review {field} mismatch")
        require(review.get("output_sha256") == output_hash, "review output hash mismatch")
        _nonempty(review.get("rationale"), "review rationale")
        require(type(review.get("critical_failure")) is bool, "critical_failure must be boolean")
        critical |= review["critical_failure"]
        criteria = review.get("criteria")
        require(isinstance(criteria, dict) and set(criteria) == condition_ids,
                "missing/unknown review condition")
        for item in criteria.values():
            require(isinstance(item, dict) and item.get("verdict") in {"pass", "fail", "uncertain"},
                    "invalid semantic verdict")
            _nonempty(item.get("rationale"), "criterion rationale")
        votes.append({"reviewer_id": reviewer, "criteria": criteria})
    if not votes:
        return None, critical, False, {}
    conditions = {}
    for key in sorted(condition_ids):
        counts = Counter(v["criteria"][key]["verdict"] for v in votes)
        consensus = "fail" if set(counts) == {"fail"} else "pass" if set(counts) == {"pass"} else "inconclusive"
        conditions[key] = {"outcome": consensus, "verdict_counts": dict(counts),
                           "disagreement": len(counts) > 1,
                           "has_uncertainty": "uncertain" in counts,
                           "reviews": [{"reviewer_id": v["reviewer_id"],
                                        "verdict": v["criteria"][key]["verdict"],
                                        "rationale": v["criteria"][key]["rationale"]} for v in votes]}
    disagreement = any(c["disagreement"] for c in conditions.values())
    outcomes = {c["outcome"] for c in conditions.values()}
    # A confirmed failure of one necessary condition survives uncertainty in
    # another. Disagreement on the failed condition itself is not consensus.
    outcome = ("fail" if critical or "fail" in outcomes
               else "inconclusive" if "inconclusive" in outcomes else "pass")
    return outcome, critical, disagreement, conditions


def evaluate(cases, protocol, records=None):
    validate_suite(cases, protocol)
    expected = {r["scenario_id"]: r for r in templates(cases, protocol)}
    records = list(expected.values()) if records is None else records
    require(isinstance(records, list), "records must be a list")
    indexed = {}
    for record in records:
        require(isinstance(record, dict), "record must be an object")
        sid = record.get("scenario_id")
        require(isinstance(sid, str) and sid in expected, f"unknown scenario ID: {sid}")
        require(sid not in indexed, f"duplicate scenario ID: {sid}")
        for key in ("case_id", "case_sha256", "input_sha256", "protocol_sha256"):
            require(record.get(key) == expected[sid][key], f"{sid}: {key} mismatch")
        indexed[sid] = record
    require(set(indexed) == set(expected), f"missing scenario IDs: {sorted(set(expected) - set(indexed))}")
    units, groups, model_signatures = [], [], set()
    for case in cases:
        case_units = []
        for scenario in case["scenarios"]:
            sid = scenario["scenario_id"]
            record = indexed[sid]
            status = record.get("status")
            require(status in {"not_run", "executed"}, f"{sid}: invalid submitted status")
            unit = {"scenario_id": sid, "case_id": case["case_id"], "status": "not_run",
                    "outcome": None, "critical_failure": False, "review_disagreement": False,
                    "input_characters": scenario["input_characters"],
                    "input_utf8_bytes": scenario["input_utf8_bytes"]}
            if status == "not_run":
                require("run" not in record and not record.get("reviews"),
                        f"{sid}: not_run must not contain execution/reviews")
            else:
                run = record.get("run")
                output_hash, structure_pass, recorded_at = _execution(case, scenario, run)
                if case["kind"] == "response":
                    model_signatures.add((run["model_id"], run["service_policy_version"],
                                          canonical(run.get("generation_settings"))))
                    require(len(model_signatures) == 1,
                            "mixed model/policy/generation settings: use separate candidate ledgers")
                outcome, critical, disagreement, conditions = _reviews(
                    case, scenario, protocol, run, record.get("reviews", []), output_hash, recorded_at)
                unit.update(status="evaluated" if outcome else "needs_review", outcome=outcome,
                            critical_failure=critical, review_disagreement=disagreement,
                            review_count=len(record.get("reviews", [])), output_sha256=output_hash,
                            condition_results=conditions,
                            reviewer_kinds=dict(Counter(r["reviewer_kind"] for r in record.get("reviews", []))))
                if case["case_id"] == "T29":
                    unit.update(input_token_count=run["input_token_count"], tokenizer_id=run["tokenizer_id"])
                if case["kind"] == "data_production":
                    unit["structural_invariance"] = structure_pass
                    if outcome and not structure_pass:
                        unit["outcome"] = "fail"
            units.append(unit)
            case_units.append(unit)
        require(bool(case_units), "case-group has no execution units")
        complete = all(u["status"] == "evaluated" for u in case_units)
        group_status = ("evaluated" if complete else "not_run"
                        if all(u["status"] == "not_run" for u in case_units) else "incomplete")
        outcomes = {u["outcome"] for u in case_units}
        outcome = ("fail" if "fail" in outcomes else "inconclusive" if "inconclusive" in outcomes
                   else "pass") if complete else None
        groups.append({"case_id": case["case_id"], "category": case["category"],
                       "kind": case["kind"], "high_risk": case["high_risk"],
                       "status": group_status, "outcome": outcome,
                       "critical_failure_observed": any(u["critical_failure"] for u in case_units),
                       "execution_units": len(case_units)})

    def aggregate(rows):
        counts = Counter(r["status"] for r in rows)
        outcomes = Counter(r["outcome"] for r in rows if r["status"] == "evaluated")
        evaluated = counts["evaluated"]
        return {"total_case_groups": len(rows), "evaluated_case_groups": evaluated,
                "not_run_case_groups": counts["not_run"], "incomplete_case_groups": counts["incomplete"],
                "passed_case_groups": outcomes["pass"], "failed_case_groups": outcomes["fail"],
                "inconclusive_case_groups": outcomes["inconclusive"],
                "critical_failure_case_groups_observed": sum(r["critical_failure_observed"] for r in rows),
                "pass_rate_denominator": evaluated,
                "pass_rate_among_evaluated": outcomes["pass"] / evaluated if evaluated else None,
                "evaluation_coverage": evaluated / len(rows) if rows else None}

    return {"protocol_version": protocol["version"], "protocol_sha256": digest(protocol),
            "evaluation_role": "public_synthetic_regression_not_independent_final_evaluation",
            "independent_statistical_sample_count": None, "clinical_approval": False,
            "model_invocations_by_this_tool": 0, "summary": aggregate(groups),
            "response_candidate": ({"model_id": next(iter(model_signatures))[0],
                                    "service_policy_version": next(iter(model_signatures))[1]}
                                   if model_signatures else None),
            "by_category": {key: aggregate([r for r in groups if r["category"] == key])
                            for key in sorted({r["category"] for r in groups})},
            "by_kind": {key: aggregate([r for r in groups if r["kind"] == key])
                        for key in ("response", "data_production")},
            "high_risk": aggregate([r for r in groups if r["high_risk"]]),
            "groups": groups, "execution_units": units,
            "proposed_gates": protocol["proposed_gates"], "limits": protocol["limits"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--suite", type=Path, default=DEFAULT_DIRECTORY)
    parser.add_argument("--records", type=Path, help="complete JSONL execution/review ledger")
    parser.add_argument("--template", type=Path, help="write not_run ledger; never execute a model")
    parser.add_argument("--output", type=Path, help="write report JSON (default: stdout)")
    args = parser.parse_args(argv)
    try:
        require(not (args.template and (args.records or args.output)),
                "--template cannot combine with --records/--output")
        cases, protocol = load_suite(args.suite)
        if args.template:
            args.template.write_text("".join(canonical(r) + "\n" for r in templates(cases, protocol)), encoding="utf-8")
        else:
            report = evaluate(cases, protocol, read_jsonl(args.records) if args.records else None)
            rendered = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
            if args.output:
                args.output.write_text(rendered, encoding="utf-8")
            else:
                print(rendered, end="")
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
