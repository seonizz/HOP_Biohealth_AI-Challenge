"""Fail-closed, JSON-only evidence gates for the stage-1 source-SFT kit.

This validates evidence identity and declared numerical checks. It does not
upgrade historical failed reports, authorize clinical use, or replace the GPU
probe/canary that produces the report. No assertions are used: -O stays strict.
"""

import hashlib
import json
import math
from pathlib import Path
import re


SCHEMA_VERSION = "malssi.stage1-readiness.v1"
BINDING_KEYS = frozenset({"dataset_sha256", "config_sha256", "model_sha256",
                          "template_sha256", "code_sha256"})
_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


class ReadinessError(ValueError):
    """A report cannot establish the requested preparation or canary gate."""


def _require(condition, message):
    if not condition:
        raise ReadinessError(message)


def _finite_json(value):
    if value is None or type(value) in (str, bool, int):
        return
    if type(value) is float:
        _require(math.isfinite(value), "Nonfinite report value")
        return
    if isinstance(value, list):
        for child in value:
            _finite_json(child)
        return
    if isinstance(value, dict):
        _require(all(type(key) is str for key in value), "JSON object keys must be strings")
        for child in value.values():
            _finite_json(child)
        return
    raise ReadinessError("Report must contain only finite JSON values")


def canonical_sha256(value):
    _finite_json(value)
    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True,
                            separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_artifact_hashes(root, artifacts):
    """Verify a nonempty relative-path manifest without escaping its root."""
    _require(isinstance(artifacts, dict) and bool(artifacts), "Missing artifact inventory")
    root = Path(root).resolve(strict=True)
    _require(root.is_dir(), "Artifact root must be a directory")
    for relative, expected in artifacts.items():
        _require(type(relative) is str and bool(relative), "Invalid artifact path")
        path = Path(relative)
        _require(not path.is_absolute() and ".." not in path.parts, "Artifact path escapes root")
        _require(type(expected) is str and _SHA256.fullmatch(expected), "Invalid artifact SHA256")
        resolved = (root / path).resolve(strict=True)
        _require(resolved.is_relative_to(root) and resolved.is_file(), "Artifact path escapes root or is not a file")
        _require(sha256_file(resolved) == expected, f"Artifact hash mismatch: {relative}")
    return dict(artifacts)


def _check_bindings(bindings):
    _require(isinstance(bindings, dict) and BINDING_KEYS <= set(bindings), "Missing required evidence bindings")
    _require(all(type(key) is str and bool(key) and type(value) is str and _SHA256.fullmatch(value)
                 for key, value in bindings.items()), "Bindings must be named SHA256 digests")


def _finite_number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _validate_comparisons(comparisons):
    _require(isinstance(comparisons, list) and bool(comparisons), "Empty or invalid comparison evidence")
    seen = set()
    for comparison in comparisons:
        _require(isinstance(comparison, dict), "Comparison must be an object")
        name = comparison.get("name")
        _require(type(name) is str and bool(name.strip()) and name not in seen, "Missing or duplicate comparison name")
        seen.add(name)
        for key in ("actual", "reference", "atol", "rtol"):
            value = comparison.get(key)
            _require(_finite_number(value), f"Invalid finite comparison field: {key}")
        _require(comparison["atol"] >= 0 and comparison["rtol"] >= 0, "Negative comparison tolerance")
        tolerance = comparison["atol"] + comparison["rtol"] * abs(comparison["reference"])
        difference = abs(comparison["actual"] - comparison["reference"])
        _require(math.isfinite(tolerance) and math.isfinite(difference), "Nonfinite comparison arithmetic")
        _require(difference <= tolerance, f"Numerical comparison failed: {name}")
        _require("passed" not in comparison or comparison["passed"] is True, "Comparison has non-passing status")


def _validate_fused_loss(evidence):
    _require(evidence.get("criterion") == "bf16_linear_fp32_softcap_v1", "Unrecognized fused-loss precision criterion")
    comparisons = evidence.get("comparisons")
    _validate_comparisons(comparisons)
    expected = {f"{part}_chunks_{chunks}" for part in ("all", "first", "body", "end") for chunks in (1, 3, 8)}
    expected.add("actual_model_all")
    by_name = {item["name"]: item for item in comparisons}
    _require(set(by_name) == expected, "Missing or unexpected fused-loss comparison inventory")
    for item in comparisons:
        _require(type(item["atol"]) is float and item["atol"] == 0.002
                 and type(item["rtol"]) is float and item["rtol"] == 0.002,
                 "Fused-loss tolerances must remain atol=0.002 and rtol=0.002")
        _require(item["actual"] >= 0 and item["reference"] >= 0, "Negative cross-entropy evidence")
        _require(item.get("passed") is True, "Fused-loss comparison did not pass")
    _require(evidence.get("chunks") == [1, 3, 8]
             and all(type(value) is int for value in evidence["chunks"]), "Fused-loss chunk schedule mismatch")
    _require(evidence.get("compiled") is True, "Fused-loss evidence was not compiled")
    values = evidence.get("per_token_reference_ce")
    _require(isinstance(values, list) and bool(values)
             and all(_finite_number(value) and value >= 0 for value in values), "Missing finite tokenwise CE evidence")
    reference = by_name["actual_model_all"]["reference"]
    _require(math.isclose(sum(values) / len(values), reference, rel_tol=1e-6, abs_tol=1e-8),
             "Tokenwise CE does not reproduce mean reference loss")
    positions = evidence.get("shifted_label_positions")
    _require(isinstance(positions, list) and len(positions) == len(values)
             and all(isinstance(item, list) and len(item) == 2
                     and all(type(index) is int for index in item) and item[0] >= 0 and item[1] > 0
                     for item in positions), "Missing shifted-label position evidence")
    _require(len({tuple(position) for position in positions}) == len(positions), "Duplicate shifted-label position")
    for chunks in (1, 3, 8):
        counts = {part: by_name[f"{part}_chunks_{chunks}"].get("supervised_items")
                  for part in ("all", "first", "body", "end")}
        _require(all(type(value) is int and value > 0 for value in counts.values()), "Invalid supervised-item counts")
        _require(counts["all"] == len(values) == counts["first"] + counts["body"] + counts["end"],
                 "First/body/end token accounting does not match all tokens")
        for part in counts:
            _require(counts[part] == by_name[f"{part}_chunks_1"]["supervised_items"],
                     "Supervised-item count changed across chunks")
    wrong = evidence.get("wrong_unshifted_ce")
    _require(_finite_number(wrong) and wrong >= 0 and abs(wrong - reference) > 0.01,
             "Missing discriminating unshifted negative control")


def _validate_fused_gradient(evidence):
    _require(evidence.get("criterion") == "hidden_gradient_bf16_v1", "Unrecognized fused-gradient criterion")
    results = evidence.get("results")
    _require(isinstance(results, list) and len(results) == 4, "Missing fused-gradient comparison inventory")
    expected = {"actual_model_hidden", "chunks_1", "chunks_3", "chunks_8"}
    names = []
    for result in results:
        _require(isinstance(result, dict), "Gradient result must be an object")
        name = result.get("name")
        _require(type(name) is str and name in expected and name not in names, "Missing or duplicate gradient result")
        names.append(name)
        _require(result.get("passed") is True, "Gradient result did not pass")
        for field in ("relative_l2_error", "maximum_relative_l2_error", "cosine", "minimum_cosine", "reference_norm"):
            _require(_finite_number(result.get(field)), f"Missing finite gradient metric: {field}")
        _require(result["maximum_relative_l2_error"] == 0.02 and result["minimum_cosine"] == 0.999,
                 "Gradient thresholds must remain relative L2 <=0.02 and cosine >=0.999")
        _require(0 <= result["relative_l2_error"] <= 0.02 and 0.999 <= result["cosine"] <= 1.000001
                 and result["reference_norm"] > 0, "Fused-gradient numerical bounds failed")


def _validate_generation_profile(evidence):
    cases = evidence.get("cases")
    _require(isinstance(cases, list) and bool(cases), "Missing generation profile cases")
    seen = set()
    for case in cases:
        _require(isinstance(case, dict), "Generation case must be an object")
        name = case.get("case")
        _require(type(name) is str and bool(name) and name not in seen, "Missing or duplicate generation case")
        seen.add(name)
        inspection = case.get("inspection")
        _require(isinstance(inspection, dict) and inspection.get("generation_profile_verified") is True,
                 "Generation provenance was not verified")
        _require(inspection.get("no_extra_logits_processors") is True
                 and inspection.get("no_extra_stopping_criteria") is True, "Generation call provenance missing")
        prefix = case.get("prefix_ids")
        _require(isinstance(prefix, list) and bool(prefix) and all(type(value) is int and value >= 0 for value in prefix)
                 and prefix == case.get("actual_prefill_ids"), "Generation prefill evidence mismatch")
        config = case.get("effective_config")
        _require(isinstance(config, dict) and config == inspection.get("effective_generation_config")
                 and canonical_sha256(config) == inspection.get("generation_config_sha256"),
                 "Generation effective config evidence mismatch")
        from .gemma4_generation_validation import _generation_provenance
        _, _, valid = _generation_provenance(config, {"max_new_tokens": config.get("max_new_tokens")},
                                             config.get("eos_token_id", []), True, True)
        _require(valid, "Generation config still has forcing or unsupported controls")
        suffix = inspection.get("raw_suffix_ids")
        _require(isinstance(suffix, list) and bool(suffix)
                 and all(type(value) is int and value >= 0 for value in suffix), "Missing raw generation suffix")
        _require(type(inspection.get("generated_tokens")) is int
                 and len(suffix) == inspection["generated_tokens"] <= config["max_new_tokens"],
                 "Generated token accounting mismatch")
        _require(type(inspection.get("body")) is str
                 and hashlib.sha256(inspection["body"].encode("utf-8")).hexdigest() == inspection.get("body_sha256"),
                 "Generated body hash mismatch")
        _require(inspection.get("semantic_completeness") == "not_assessed", "Unsupported generation completeness claim")
        _require(inspection.get("cap_censored") is (len(suffix) == config["max_new_tokens"]),
                 "Generation cap censoring mismatch")
    _require({"synthetic", "source"} <= seen, "Missing synthetic or source generation case")


def validate_report(report, *, expected_bindings, required_checks, mode="preparation",
                    expected_check_contracts=None):
    """Validate a named preparation (zero updates) or optimizer-canary report.

    Required checks are a nonempty list/tuple of unique names. Additional checks
    are accepted only if they also pass. Bindings must exactly match the caller's
    freshly derived identity; merely supplying a hash-looking string in a report
    is not sufficient. Optional contracts bind an evidence ``criterion`` to its
    intended numeric/reference definition (including any precision policy).
    """
    _finite_json(report)
    _require(isinstance(report, dict), "Report must be an object")
    _require(mode in ("preparation", "optimizer_canary"), "Unknown report mode")
    _require(report.get("schema_version") == SCHEMA_VERSION, "Unsupported report schema")
    _require(report.get("mode") == mode, "Report mode mismatch")
    _require(report.get("status") == "passed", "Report status must be exactly passed")
    steps = report.get("optimizer_steps")
    _require(type(steps) is int and steps >= 0, "Invalid optimizer step count")
    _require(steps == 0 if mode == "preparation" else steps > 0,
             "Preparation must not update weights; optimizer canary must execute updates")
    _check_bindings(expected_bindings)
    _check_bindings(report.get("bindings"))
    _require(report["bindings"] == expected_bindings, "Evidence bindings mismatch")
    _require(isinstance(required_checks, (list, tuple)) and bool(required_checks)
             and all(type(name) is str and bool(name.strip()) for name in required_checks)
             and len(required_checks) == len(set(required_checks)), "Invalid required-check inventory")
    contracts = {} if expected_check_contracts is None else expected_check_contracts
    _require(isinstance(contracts, dict) and set(contracts) <= set(required_checks)
             and all(type(value) is str and bool(value.strip()) for value in contracts.values()),
             "Invalid required-check contracts")
    checks = report.get("checks")
    _require(isinstance(checks, list) and bool(checks), "Missing named check results")
    seen = set()
    for check in checks:
        _require(isinstance(check, dict), "Check result must be an object")
        name = check.get("name")
        _require(type(name) is str and bool(name.strip()) and name not in seen, "Missing or duplicate check name")
        seen.add(name)
        _require(check.get("passed") is True, f"Check did not pass: {name}")
        _require("status" not in check or check["status"] == "passed", f"Check status did not pass: {name}")
        evidence = check.get("evidence")
        _require(isinstance(evidence, dict) and bool(evidence), f"Missing check evidence: {name}")
        if name in contracts:
            _require(evidence.get("criterion") == contracts[name], f"Check criterion mismatch: {name}")
        if "comparisons" in evidence:
            _validate_comparisons(evidence["comparisons"])
        if name == "fused_loss":
            _validate_fused_loss(evidence)
        elif name == "fused_gradient":
            _validate_fused_gradient(evidence)
        elif name == "generation_profile":
            _validate_generation_profile(evidence)
    _require(set(required_checks) <= seen, "Missing required named checks")
    return report
