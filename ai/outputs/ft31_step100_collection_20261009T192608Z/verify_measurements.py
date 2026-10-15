#!/usr/bin/env python3
"""Verify and export FT31_STEP100 measurements using saved files only.

No tokenizer, model, network, or API key is read. A missing measurement remains
null; final rates are withheld until every eligible first attempt is recorded.
"""

import argparse
from collections import Counter
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import shutil
import sys


CONDITION = "FT31_STEP100"
MODEL_ID = "malssi-gemma4-31b-step100"
CHECKPOINT_SHA256 = "56244f8a6736e648dd8f4cd13d0889d7499a6bf776b9e55491a4ed59c446effd"
ADAPTER_SHA256 = "153b2611645a5ce2cef69362d685fa241d67dac2333a5a47e5630ece99715b73"
FINGERPRINT = "step-100-56244f8a6736"
LABELS = ("ASK_CFI", "CLARIFY", "SUPPORT", "SUPPORT_LIMITED", "SAFETY_SUPPORT", "END")
STATUSES = ("valid", "length_limit", "input_token_mismatch", "empty_output",
            "format_error", "unverified_termination", "identity_mismatch",
            "http_error", "unknown_completion", "unexecuted", "excluded")
TASKS = ("response", "action")
RESERVATIONS = {"response": 512, "action": 32}
MAX_FILE_BYTES = 32 * 1024 * 1024
REQUIRED_FIELDS = (
    "run_id", "generation_id", "attempt_index", "condition", "task", "case_id",
    "split", "source_group_id", "model_id", "checkpoint_sha256", "adapter_file_sha256",
    "input_sha256", "request_sha256", "request_file", "attempt_file", "raw_response_file",
    "private_response_file", "raw_response_sha256", "response_sha256",
    "input_tokens_preflight", "input_tokens", "generated_tokens", "max_new_tokens",
    "started_at", "completed_at", "http_status", "finish_reason", "status", "error",
    "system_fingerprint", "predicted_label",
)


class VerificationError(Exception):
    """Saved evidence is inconsistent or cannot establish the claimed result."""


def require(condition, message):
    if not condition:
        raise VerificationError(message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key: " + key)
        result[key] = value
    return result


def decode_json(data):
    try:
        return json.loads(data, object_pairs_hook=json_pairs,
                          parse_constant=lambda value: (_ for _ in ()).throw(
                              VerificationError("Invalid JSON number: " + value)))
    except (UnicodeError, ValueError) as exc:
        raise VerificationError("Invalid UTF-8 JSON: " + str(exc)) from exc


class SavedFiles:
    """Bound reads to the run and keep an immutable source-evidence inventory."""

    def __init__(self, root):
        self.root = Path(root).resolve()
        self.observed = {}

    def path(self, relative):
        require(isinstance(relative, str) and relative and not Path(relative).is_absolute(),
                "Expected relative evidence path: " + str(relative))
        path = (self.root / relative).resolve()
        require(path.is_relative_to(self.root), "Evidence path escapes run: " + relative)
        return path

    def read(self, relative):
        path = self.path(relative)
        require(path.is_file(), "Missing evidence file: " + relative)
        before = path.stat()
        require(before.st_size <= MAX_FILE_BYTES, "Oversized evidence file: " + relative)
        data = path.read_bytes()
        after = path.stat()
        require((before.st_ino, before.st_size, before.st_mtime_ns) ==
                (after.st_ino, after.st_size, after.st_mtime_ns),
                "Evidence changed during read: " + relative)
        self.observed[relative] = {"sha256": sha(data), "size_bytes": len(data)}
        return data

    def json(self, relative):
        value = decode_json(self.read(relative))
        require(isinstance(value, dict), "Expected JSON object: " + relative)
        return value

    def jsonl(self, relative, empty=False):
        data = self.read(relative)
        if not data and empty:
            return []
        lines = data.splitlines()
        require(lines and all(line.strip() for line in lines), "Empty JSONL line: " + relative)
        require(len(lines) <= 1000, "Too many JSONL records: " + relative)
        result = [decode_json(line) for line in lines]
        require(all(isinstance(row, dict) for row in result), "Invalid JSONL object: " + relative)
        return result

    def unchanged(self):
        for relative, entry in list(self.observed.items()):
            require(sha(self.path(relative).read_bytes()) == entry["sha256"],
                    "Source evidence changed during verification: " + relative)


def unique_map(rows, description):
    result = {}
    for row in rows:
        require(row.get("task") in TASKS and isinstance(row.get("case_id"), str),
                "Invalid task/case identity in " + description)
        key = (row["task"], row["case_id"])
        require(key not in result, "Duplicate first attempt/case in " + description + ": " + str(key))
        result[key] = row
    return result


def numeric_tokens(value):
    return type(value) is int and value >= 0


def extract_success(raw):
    choices = raw.get("choices")
    require(isinstance(choices, list) and len(choices) == 1 and isinstance(choices[0], dict),
            "Expected one saved OpenAI response choice")
    choice = choices[0]
    content = choice.get("message", {}).get("content")
    require(isinstance(content, str), "Expected text saved OpenAI response content")
    usage = raw.get("usage")
    require(isinstance(usage, dict), "Missing raw API token usage")
    prompt, completion, total = (usage.get(name) for name in
                                 ("prompt_tokens", "completion_tokens", "total_tokens"))
    require(all(numeric_tokens(value) for value in (prompt, completion, total)),
            "Missing/invalid raw API token usage")
    require(total == prompt + completion, "Raw API total_tokens sum mismatch")
    return content, choice.get("finish_reason"), prompt, completion


def derive_status(raw, task, expected_tokens, http_status=200, expected_fingerprint=FINGERPRINT,
                  verified_model_fingerprint=None):
    if http_status is None:
        return "unknown_completion"
    if http_status != 200:
        return "http_error"
    content, finish, prompt, _ = extract_success(raw)
    raw_fingerprint = raw.get("system_fingerprint")
    fingerprint_matches = raw_fingerprint == expected_fingerprint or (
        raw_fingerprint is None and verified_model_fingerprint == expected_fingerprint)
    if raw.get("model") != MODEL_ID or not fingerprint_matches:
        return "identity_mismatch"
    if prompt != expected_tokens:
        return "input_token_mismatch"
    if finish == "length":
        return "length_limit"
    if finish != "stop":
        return "unverified_termination"
    if not content.strip():
        return "empty_output"
    if task == "action" and content.strip() not in LABELS:
        return "format_error"
    return "valid"


def token_stats(values):
    observed = [value for value in values if value is not None]
    require(all(numeric_tokens(value) for value in observed), "Invalid measured token count")
    return {"observed": len(observed), "missing": len(values) - len(observed),
            "sum": sum(observed), "min": min(observed) if observed else None,
            "max": max(observed) if observed else None}


def aggregate(cases, preflight, records, attempts):
    assigned = len(cases)
    eligible_keys = {key for key in cases if preflight[key]["eligible"]}
    rows = [records[key] for key in eligible_keys if key in records]
    attempted = sum(key in attempts for key in eligible_keys)
    missing = len(eligible_keys) - len(rows)
    complete = missing == 0
    statuses = Counter(row["status"] for row in rows)
    statuses["unknown_completion"] += sum(key in attempts and key not in records for key in eligible_keys)
    statuses["unexecuted"] += sum(key not in attempts for key in eligible_keys)
    statuses["excluded"] = assigned - len(eligible_keys)
    labels = Counter(row.get("predicted_label") for row in rows if row["status"] == "valid")
    denominator = len(eligible_keys)
    return {"assigned": assigned, "eligible": denominator, "excluded": assigned - denominator,
            "attempted": attempted, "recorded_first_attempts": len(rows),
            "responses": sum(row["http_status"] == 200 for row in rows),
            "unexecuted": denominator - attempted, "missing_first_attempt_records": missing,
            "all_first_attempts_recorded": complete,
            "valid": statuses["valid"], "length_limit": statuses["length_limit"],
            "status_counts": {status: statuses[status] for status in STATUSES},
            "finish_reason_counts": dict(sorted(Counter(str(row.get("finish_reason")) for row in rows).items())),
            "final_valid_rate": {"numerator": statuses["valid"], "denominator": denominator,
                                 "percent": 100 * statuses["valid"] / denominator
                                 if complete and denominator else None},
            "token_count_denominator": assigned,
            "input_tokens": token_stats([records.get(key, {}).get("input_tokens") for key in cases]),
            "generated_tokens": token_stats([records.get(key, {}).get("generated_tokens") for key in cases]),
            "label_counts": {label: labels[label] for label in LABELS}}


def validate_attempt(attempt, key, run, request_file, request_hash):
    require(attempt.get("generation_id") == run["run_id"] + "_" + "_".join(key),
            "Attempt generation ID mismatch: " + str(key))
    require(attempt.get("attempt_index") == 1, "Attempt is not first attempt: " + str(key))
    for field, value in (("run_id", run["run_id"]), ("task", key[0]), ("case_id", key[1]),
                         ("request_file", request_file), ("request_sha256", request_hash)):
        require(attempt.get(field) == value, "Attempt " + field + " mismatch: " + str(key))
    require(isinstance(attempt.get("started_at"), str), "Attempt start timestamp missing: " + str(key))


def verify_health_identity_binding(files, row, expected_fingerprint):
    """Check separately saved authenticated health evidence without fabricating raw fields."""
    require(row.get("model_identity_source") == "authenticated_health_before_after"
            and row.get("verified_model_fingerprint") == expected_fingerprint,
            "Missing verified health identity binding")
    before_file, after_file = row.get("identity_before_file"), row.get("identity_after_file")
    require(isinstance(before_file, str) and isinstance(after_file, str) and before_file != after_file,
            "Health identity requires distinct before/after evidence files")
    identities = []
    for phase, relative in (("before", before_file), ("after", after_file)):
        require(relative.startswith("evidence/") and relative.endswith(".json"),
                "Health identity path must be a saved evidence JSON file")
        health_bytes = files.read(relative)
        require(sha(health_bytes) == row.get("identity_" + phase + "_sha256"),
                "Health identity snapshot hash mismatch: " + phase)
        health = decode_json(health_bytes)
        require(isinstance(health, dict) and health.get("status") == "ready"
                and health.get("model") == MODEL_ID and health.get("checkpoint_step") == 100
                and health.get("checkpoint_sha256") == CHECKPOINT_SHA256,
                "Health identity snapshot model/checkpoint mismatch: " + phase)
        fingerprint = health.get("system_fingerprint", health.get("model_fingerprint"))
        require(fingerprint == expected_fingerprint,
                "Health identity snapshot fingerprint mismatch: " + phase)
        require(type(health.get("pid")) is int and health["pid"] > 0,
                "Health identity snapshot PID missing/invalid: " + phase)
        identities.append(health)
    require(identities[0]["pid"] == identities[1]["pid"], "Health identity server PID changed")
    return expected_fingerprint


def verify_baseline(files, cases, run):
    baseline_run = files.json("source_baseline/run_manifest.json")
    source_cases_data = files.read("source_baseline/case_manifest.jsonl")
    require(source_cases_data == files.read("case_manifest.jsonl"), "Original case manifest was changed")
    require(baseline_run.get("condition") == "BASE12", "Wrong source baseline condition")
    require(baseline_run.get("case_manifest_sha256") == sha(source_cases_data),
            "Source baseline case manifest hash mismatch")
    source_hashes = run.get("source_baseline_hashes", {})
    require(isinstance(source_hashes, dict), "Invalid source_baseline_hashes")
    for relative in ("run_manifest.json", "generations.jsonl", "case_manifest.jsonl"):
        require(relative in source_hashes, "Missing source baseline hash: " + relative)
        require(sha(files.read("source_baseline/" + relative)) == source_hashes[relative],
                "Source baseline snapshot hash mismatch: " + relative)
    for relative, expected_hash in source_hashes.items():
        require(sha(files.read("source_baseline/" + relative)) == expected_hash,
                "Source baseline snapshot hash mismatch: " + relative)
    baseline = unique_map(files.jsonl("source_baseline/generations.jsonl"), "BASE12 generations")
    require(set(baseline) == set(cases), "Source baseline missing/extra first attempt")
    for key, row in baseline.items():
        case = cases[key]
        require(row.get("run_id") == baseline_run["run_id"] and row.get("condition") == "BASE12"
                and row.get("attempt_index") == 1, "Source baseline attempt identity mismatch: " + str(key))
        for field in ("task", "case_id", "split", "source_group_id", "input_sha256"):
            require(row.get(field) == case.get(field), "Source baseline case mismatch: " + field)
        response_bytes = files.read("source_baseline/" + row["private_response_file"])
        require(sha(response_bytes) == row["response_sha256"], "Source baseline answer hash mismatch: " + str(key))
        require(row.get("status") in STATUSES and numeric_tokens(row.get("input_tokens"))
                and numeric_tokens(row.get("generated_tokens")), "Invalid source baseline measurement: " + str(key))
        require(row.get("max_new_tokens") == RESERVATIONS[key[0]], "Source baseline output budget mismatch")
        require(row.get("input_tokens_preflight") == case["input_tokens_preflight"],
                "Source baseline preflight mismatch")
        require(row.get("input_tokens") == row["input_tokens_preflight"],
                "Source baseline actual/preflight tokens differ")
        require(key[0] != "action" or row.get("status") != "valid"
                or response_bytes.decode("utf-8").strip() == row.get("predicted_label") in LABELS,
                "Source baseline label mismatch")
    return baseline


def verify(root, expected_assigned=94, export=True):
    files = SavedFiles(root)
    run = files.json("run_manifest.json")
    for field, expected in (("condition", CONDITION), ("model_id", MODEL_ID),
                            ("checkpoint_sha256", CHECKPOINT_SHA256), ("adapter_file_sha256", ADAPTER_SHA256)):
        require(run.get(field) == expected, "Run " + field + " mismatch")
    require(isinstance(run.get("run_id"), str) and run["run_id"], "Missing run ID")
    for field, expected in (("checkpoint_step", 100), ("concurrency", 1), ("attempts_per_case", 1),
                            ("response_max_new_tokens", 512), ("classification_max_new_tokens", 32),
                            ("comparison_context_tokens", 4096), ("temperature", 0),
                            ("enable_thinking", False), ("stream", False), ("input_truncation", False)):
        require(run.get(field) == expected, "Run generation control mismatch: " + field)
    cases = unique_map(files.jsonl("case_manifest.jsonl"), "case manifest")
    require(len(cases) == expected_assigned, "Expected " + str(expected_assigned) + " assigned cases")
    if expected_assigned == 94:
        require(Counter((case["task"], case["split"]) for case in cases.values()) ==
                Counter({("response", "legacy_validation_development"): 32,
                         ("response", "synthetic_public_regression"): 31,
                         ("action", "synthetic_public_regression"): 31}),
                "Original 32/31/31 task/split assignment changed")
    require(sha(files.read("case_manifest.jsonl")) == run.get("case_manifest_sha256"),
            "Case manifest hash mismatch")
    preflight = unique_map(files.json("preflight.json").get("cases", []), "preflight")
    require(sha(files.read("preflight.json")) == run.get("preflight_sha256"), "Preflight hash mismatch")
    require(set(preflight) == set(cases), "Preflight missing/extra assigned case")
    baseline = verify_baseline(files, cases, run)
    records = unique_map(files.jsonl("generations.jsonl", empty=True), "FT31 generations")
    require(set(records) <= set(cases), "Generation for unassigned case")
    expected_fingerprint = run.get("expected_system_fingerprint", FINGERPRINT)
    require(isinstance(expected_fingerprint, str) and expected_fingerprint, "Missing expected model fingerprint")
    health_path = files.path("evidence/health_before.json")
    if records or health_path.is_file():
        health = files.json("evidence/health_before.json")
        require(sha(files.read("evidence/health_before.json")) == run.get("health_before_sha256"),
                "Frozen health evidence hash mismatch")
        require(health.get("status") == "ready" and health.get("model") == MODEL_ID
                and health.get("checkpoint_step") == 100 and health.get("checkpoint_sha256") == CHECKPOINT_SHA256,
                "Frozen health model/checkpoint mismatch")
        require(health.get("system_fingerprint", health.get("model_fingerprint")) == expected_fingerprint,
                "Frozen health/manifest system fingerprint mismatch")
    if expected_fingerprint != FINGERPRINT:
        require(run.get("requested_system_fingerprint") == FINGERPRINT
                and isinstance(run.get("system_fingerprint_discrepancy"), str)
                and run["system_fingerprint_discrepancy"],
                "Changed runtime fingerprint requires recorded specification discrepancy")
    inputs, attempts = {}, {}
    expected_paths = {folder: set() for folder in ("inputs", "requests", "attempts", "raw", "responses")}
    for key, case in cases.items():
        task, case_id = key
        pre = preflight[key]
        require(type(pre.get("eligible")) is bool and numeric_tokens(pre.get("input_tokens_preflight")),
                "Invalid preflight values: " + str(key))
        within_budget = pre["input_tokens_preflight"] + RESERVATIONS[task] <= 4096
        require(not pre["eligible"] or within_budget, "Eligible case exceeds context budget: " + str(key))
        require(pre["eligible"] or isinstance(pre.get("exclusion_reason"), str)
                and pre["exclusion_reason"], "Missing exclusion reason: " + str(key))
        input_bytes = files.read(case["input_file"])
        expected_paths["inputs"].add(case["input_file"])
        input_record = decode_json(input_bytes)
        require(input_record.get("task") == task and input_record.get("case_id") == case_id,
                "Input identity mismatch: " + str(key))
        require(sha(canonical(input_record)) == case["input_sha256"], "Input hash mismatch: " + str(key))
        baseline_request_bytes = files.read("source_baseline/" + case["request_file"])
        baseline_request = decode_json(baseline_request_bytes)
        require(sha(baseline_request_bytes) == case["request_sha256"], "Source baseline request hash mismatch")
        require(baseline_request.get("messages") == input_record["messages"],
                "Source baseline input/request mismatch")
        require(baseline_request.get("options", {}).get("num_predict") == RESERVATIONS[task]
                and baseline_request.get("options", {}).get("num_ctx") == 4096,
                "Source baseline context/output budget mismatch")
        # BASE12 input_sha256 identifies canonical JSON. Preserve and independently
        # verify original byte serialization whenever its frozen byte hash is supplied.
        input_snapshot = "source_baseline/" + case["input_file"]
        byte_hash = run.get("source_baseline_hashes", {}).get(case["input_file"])
        if files.path(input_snapshot).is_file():
            require(files.read(input_snapshot) == input_bytes, "Input byte copy mismatch: " + str(key))
        if byte_hash is not None:
            require(sha(input_bytes) == byte_hash, "Original input byte hash mismatch: " + str(key))
        require(files.path(input_snapshot).is_file() or byte_hash is not None,
                "No byte-exact original input anchor: " + str(key))
        inputs[key] = input_record
        request_file = "private/requests/" + task + "_" + case_id + ".json"
        attempt_file = "private/attempts/" + task + "_" + case_id + ".json"
        attempt_exists = files.path(attempt_file).is_file()
        request_exists = files.path(request_file).is_file()
        require(not attempt_exists or request_exists, "Saved attempt has no request: " + str(key))
        require(not (attempt_exists or key in records) or pre["eligible"], "Attempt for excluded case: " + str(key))
        if request_exists:
            request_bytes = files.read(request_file)
            request = decode_json(request_bytes)
            expected_paths["requests"].add(request_file)
            require(request.get("messages") == input_record["messages"], "Request changed messages: " + str(key))
            require(request.get("model") == MODEL_ID and request.get("max_tokens") == RESERVATIONS[task]
                    and request.get("temperature") == 0 and request.get("stream") is False,
                    "Request generation control mismatch: " + str(key))
            require(not (set(request) & {"seed", "top_k", "repeat_penalty", "think", "num_ctx"}),
                    "Unsupported BASE12 control in FT31 request: " + str(key))
        if attempt_exists:
            attempt = files.json(attempt_file)
            expected_paths["attempts"].add(attempt_file)
            validate_attempt(attempt, key, run, request_file, sha(request_bytes))
            attempts[key] = attempt
        if key not in records:
            continue
        row = records[key]
        require(all(field in row for field in REQUIRED_FIELDS), "Missing generation fields: " + str(key))
        require(attempt_exists, "First attempt marker missing: " + str(key))
        for field in ("task", "case_id", "split", "source_group_id", "input_sha256"):
            require(row[field] == case[field], "Case/generation mismatch: " + field + ": " + str(key))
        for field in ("run_id", "condition", "model_id", "checkpoint_sha256", "adapter_file_sha256"):
            require(row[field] == run[field], "Run/generation mismatch: " + field + ": " + str(key))
        require(row["generation_id"] == run["run_id"] + "_" + task + "_" + case_id
                and row["attempt_index"] == 1, "Generation first attempt identity mismatch: " + str(key))
        require(row["request_file"] == request_file and row["attempt_file"] == attempt_file,
                "Generation request/attempt path mismatch: " + str(key))
        require(row["request_sha256"] == sha(request_bytes), "Request hash mismatch: " + str(key))
        require(row["started_at"] == attempts[key]["started_at"], "Attempt timestamp mismatch: " + str(key))
        require(isinstance(row["completed_at"], str) and row["completed_at"] >= row["started_at"],
                "Invalid completion timestamp: " + str(key))
        require(row["input_tokens_preflight"] == pre["input_tokens_preflight"]
                and row["max_new_tokens"] == RESERVATIONS[task], "Generation token reservation mismatch")
        evidence_fields = [("raw_response_file", "raw", ".json")]
        if row["http_status"] == 200 or row["private_response_file"] is not None:
            evidence_fields.append(("private_response_file", "responses", ".txt"))
        for field, folder, suffix in evidence_fields:
            require(row[field] == "private/" + folder + "/" + task + "_" + case_id + suffix,
                    "Unexpected generation evidence path: " + str(key))
            expected_paths[folder].add(row[field])
        raw_bytes = files.read(row["raw_response_file"])
        response_bytes = files.read(row["private_response_file"]) if row["private_response_file"] is not None else b""
        require(sha(raw_bytes) == row["raw_response_sha256"], "Raw response hash mismatch: " + str(key))
        require(row["response_sha256"] == (sha(response_bytes) if row["private_response_file"] is not None else None),
                "Answer hash mismatch: " + str(key))
        http_status = row["http_status"]
        require(http_status is None or type(http_status) is int and 100 <= http_status <= 599,
                "Invalid HTTP status: " + str(key))
        raw = decode_json(raw_bytes) if http_status == 200 or http_status is None else {}
        require(isinstance(raw, dict), "Invalid raw response envelope: " + str(key))
        verified_fingerprint = None
        if http_status == 200 and (raw.get("system_fingerprint") is None
                                   or row.get("model_identity_source") is not None):
            verified_fingerprint = verify_health_identity_binding(files, row, expected_fingerprint)
        status = derive_status(raw, task, pre["input_tokens_preflight"], http_status,
                               expected_fingerprint, verified_fingerprint)
        require(row["status"] == status, "Derived generation status mismatch: " + str(key))
        if http_status == 200:
            content, finish, prompt, completion = extract_success(raw)
            # A fingerprint mismatch is both a recorded runtime failure and a
            # failed verification gate; different models must not be aggregated.
            raw_fingerprint = raw.get("system_fingerprint")
            require(raw.get("model") == MODEL_ID and (raw_fingerprint == expected_fingerprint
                    or raw_fingerprint is None and verified_fingerprint == expected_fingerprint),
                    "Raw model/fingerprint identity mismatch: " + str(key))
            require(response_bytes == content.encode("utf-8"), "Raw/answer bytes mismatch: " + str(key))
            require(row["finish_reason"] == finish and row["system_fingerprint"] == raw_fingerprint,
                    "Raw/ledger termination or fingerprint mismatch: " + str(key))
            require(row["input_tokens"] == prompt and row["generated_tokens"] == completion,
                    "Raw/ledger token count mismatch: " + str(key))
            require(completion <= RESERVATIONS[task], "Output exceeds token reservation: " + str(key))
            require(row["error"] is None, "Successful HTTP response has recorded error: " + str(key))
            expected_label = content.strip() if task == "action" and status == "valid" else None
        else:
            require(row["input_tokens"] is None and row["generated_tokens"] is None,
                    "Error tokens must remain null: " + str(key))
            require(response_bytes == b"" and row["finish_reason"] is None
                    and row["system_fingerprint"] is None, "Error response has fabricated output")
            require(row["error"] is not None, "Missing recorded HTTP/network error")
            expected_label = None
        require(row["predicted_label"] == expected_label, "Recorded action label mismatch: " + str(key))
    for folder, expected in expected_paths.items():
        path = files.path("private/" + folder)
        actual = {str(item.relative_to(files.root)) for item in path.rglob("*") if item.is_file()} if path.exists() else set()
        require(actual == expected, "Missing/extra private evidence files in " + folder)
    overall = aggregate(cases, preflight, records, attempts)
    tasks = {task: aggregate({key: value for key, value in cases.items() if key[0] == task},
                             preflight, records, attempts) for task in TASKS}
    splits = {split: {task: aggregate({key: value for key, value in cases.items()
                                      if value["split"] == split and key[0] == task},
                                     preflight, records, attempts) for task in TASKS}
              for split in sorted({case["split"] for case in cases.values()})}
    paired = {}
    for task in TASKS:
        intersection = {key: case for key, case in cases.items() if key[0] == task and preflight[key]["eligible"]
                        and baseline[key]["input_tokens_preflight"] + RESERVATIONS[task] <= 4096
                        and baseline[key]["input_tokens"] + RESERVATIONS[task] <= 4096}
        ft = aggregate(intersection, preflight, records, attempts)
        base_valid = sum(baseline[key]["status"] == "valid" for key in intersection)
        n = len(intersection)
        base_percent = 100 * base_valid / n if n else None
        task_complete = tasks[task]["all_first_attempts_recorded"]
        ft_percent = ft["final_valid_rate"]["percent"] if task_complete else None
        paired[task] = {"case_keys": [[*key] for key in sorted(intersection)], "denominator": n,
                        "all_first_attempts_recorded": task_complete,
                        "BASE12_valid": base_valid, "FT31_STEP100_valid": ft["valid"],
                        "BASE12_percent": base_percent,
                        "FT31_STEP100_percent": ft_percent,
                        "difference_percentage_points": ft_percent - base_percent
                        if ft_percent is not None and base_percent is not None else None}
    generation_hash = sha(files.read("generations.jsonl"))
    complete = files.json("COLLECTION_COMPLETE.json")
    require(complete.get("run_id") == run["run_id"] and complete.get("generations_sha256") == generation_hash,
            "Collection marker run/ledger hash mismatch")
    for field in ("assigned", "excluded", "attempted", "responses", "unexecuted"):
        require(complete.get(field) == overall[field], "Collection marker " + field + " mismatch")
    if "ledger_records" in complete:
        require(complete["ledger_records"] == len(records), "Collection marker ledger_records mismatch")
    require(isinstance(complete.get("state"), str), "Missing collection state")
    require(complete["state"] not in {"complete", "completed", "collected"}
            or overall["all_first_attempts_recorded"], "Collection claims complete with missing first attempts")
    notes = ["종료·형식·실제 토큰 측정이며 상담 품질·안전성·분류 정확도 점수가 아니다.",
             "기존 검증용 개발 사례와 공개 합성 회귀 사례이며 독립 최종 test가 아니다.",
             "오류·길이 소진·미실행도 사전 실행 가능 분모에 남긴다. 미측정 토큰은 null이다.",
             "각 과제의 첫 시도 기록이 모두 있을 때만 최종 비율과 차이를 표시한다.",
             "BASE12와의 차이에는 모델 크기·배포 방식·학습 상태가 함께 반영된다."]
    metrics = {"schema_version": "ft31-saved-measurements-v1", "run_id": run["run_id"],
               "condition": CONDITION, "model_id": MODEL_ID, "checkpoint_sha256": CHECKPOINT_SHA256,
               "generations_sha256": generation_hash, "collection_state": complete["state"],
               "overall": overall, "by_task": tasks, "by_split": splits,
               "paired_BASE12": paired, "notes": notes,
               "semantic_scores_verified": False, "latency_comparison": None}
    existing_metrics = files.path("metrics.json")
    if existing_metrics.is_file():
        previous = decode_json(existing_metrics.read_bytes())
        if previous.get("generations_sha256") == generation_hash:
            require(previous == metrics, "Existing aggregate metrics mismatch")
    files.unchanged()
    verification = {"verified": True, "scope": "Saved FT31 and frozen BASE12 evidence only; no model/API requests",
                    "run_id": run["run_id"], "condition": CONDITION,
                    "assigned": len(cases), "eligible": overall["eligible"],
                    "attempted": overall["attempted"], "recorded_first_attempts": len(records),
                    "responses": overall["responses"], "unexecuted": overall["unexecuted"],
                    "collection_complete": overall["all_first_attempts_recorded"],
                    "generations_sha256": generation_hash,
                    "source_files_checked": len(files.observed), "source_mutations": 0,
                    "semantic_scores_verified": False}
    if export:
        write_exports(files, run, cases, preflight, records, inputs, baseline, metrics, verification)
    return {"verification": verification, "metrics": metrics}


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def percent(value):
    return "미확정" if value is None else f"{value:.2f}"


def write_exports(files, run, cases, preflight, records, inputs, baseline, metrics, verification):
    root = files.root
    write_json(root / "metrics.json", metrics)
    write_json(root / "verification.json", verification)
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(("metric", "scope", "task", "split", "value", "unit", "numerator", "denominator", "status", "evidence"))
    for task, group in metrics["by_task"].items():
        rate = group["final_valid_rate"]
        writer.writerow(("normal_stop_rate" if task == "response" else "action_format_valid_rate",
                         CONDITION, task, "all", rate["percent"], "percent", rate["numerator"],
                         rate["denominator"], "verified" if group["all_first_attempts_recorded"] else "partial", "metrics.json"))
        for name in ("assigned", "eligible", "excluded", "attempted", "responses", "unexecuted", "valid", "length_limit"):
            writer.writerow((name, CONDITION, task, "all", group[name], "count", "", "", "verified", "metrics.json"))
    for split, task_groups in metrics["by_split"].items():
        for task, group in task_groups.items():
            for kind in ("input_tokens", "generated_tokens"):
                for stat, value in group[kind].items():
                    writer.writerow((kind + "_" + stat, CONDITION, task, split, value,
                                     "count" if stat in {"observed", "missing"} else "tokens",
                                     "", "", "partial" if group[kind]["missing"] else "verified", "metrics.json"))
    for label, count in metrics["by_task"]["action"]["label_counts"].items():
        writer.writerow(("action_label_" + label, CONDITION, "action", "all", count, "count", "", "", "verified", "metrics.json"))
    for task, pair in metrics["paired_BASE12"].items():
        writer.writerow(("normal_stop_rate_difference" if task == "response" else "action_format_valid_rate_difference",
                         "FT31_STEP100_vs_BASE12", task, "paired_eligible", pair["difference_percentage_points"],
                         "percentage_points", "", pair["denominator"],
                         "verified" if pair["all_first_attempts_recorded"] else "partial", "metrics.json"))
    (root / "local_measurements.csv").write_text(output.getvalue(), encoding="utf-8")
    overall = metrics["overall"]
    lines = ["# FT31_STEP100 실제 수집 결과", "", f"Run: `{run['run_id']}`", "",
             f"모델 `{MODEL_ID}`, 체크포인트 100 step / `{CHECKPOINT_SHA256}`.", "",
             f"배정 {overall['assigned']}건, 실행 가능 {overall['eligible']}건, 제외 {overall['excluded']}건, "
             f"시도 {overall['attempted']}건, HTTP 200 응답 {overall['responses']}건, 미실행 {overall['unexecuted']}건.", "",
             "| 과제 | 실행 가능 N | 첫 시도 기록 | 유효 | 출력 소진 | 최종 비율 (%) |", "|---|---:|---:|---:|---:|---:|"]
    for task, group in metrics["by_task"].items():
        lines.append(f"| {task} | {group['eligible']} | {group['recorded_first_attempts']} | {group['valid']} | "
                     f"{group['length_limit']} | {percent(group['final_valid_rate']['percent'])} |")
    lines += ["", "| 동일 사례 과제 | N | BASE12 (%) | FT31_STEP100 (%) | 차이 (%p) |", "|---|---:|---:|---:|---:|"]
    for task, pair in metrics["paired_BASE12"].items():
        lines.append(f"| {task} | {pair['denominator']} | {percent(pair['BASE12_percent'])} | "
                     f"{percent(pair['FT31_STEP100_percent'])} | {percent(pair['difference_percentage_points'])} |")
    lines += ["", "상태 건수: `" + json.dumps(overall["status_counts"], ensure_ascii=False) + "`.", ""]
    lines += ["- " + note for note in metrics["notes"]]
    (root / "comparison.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    public = ["# 공개 합성 사례의 실제 답변", "", "공개 합성 회귀 사례만 포함한다. 품질·안전성 판정은 수행하지 않았다.", ""]
    for key, case in cases.items():
        if case["split"] != "synthetic_public_regression":
            continue
        task, case_id = key
        public += [f"## {task} / {case_id}", "", "입력:", "```json",
                   json.dumps(inputs[key]["messages"], ensure_ascii=False, indent=2), "```", "",
                   "BASE12 답변:", "```text",
                   files.read("source_baseline/" + baseline[key]["private_response_file"]).decode("utf-8"), "```", ""]
        if key in records:
            response_file = records[key]["private_response_file"]
            public += ["FT31_STEP100 답변:", "```text",
                       files.read(response_file).decode("utf-8") if response_file else "(생성 답변 없음)", "```", "",
                       "상태: `" + records[key]["status"] + "`", ""]
        else:
            public += ["FT31_STEP100: " + ("미실행" if preflight[key]["eligible"] else "사전 제외"), ""]
    (root / "public_answers.md").write_text("\n".join(public) + "\n", encoding="utf-8")
    source = Path(__file__).resolve()
    copied = root / "verify_measurements.py"
    if source != copied:
        shutil.copyfile(source, copied)
    files.unchanged()
    names = ("metrics.json", "verification.json", "local_measurements.csv", "comparison.md", "public_answers.md", "verify_measurements.py")
    evidence = {relative: entry for relative, entry in sorted(files.observed.items())}
    for name in names:
        data = (root / name).read_bytes()
        evidence[name] = {"sha256": sha(data), "size_bytes": len(data)}
    write_json(root / "evidence_manifest.json", {"schema_version": "ft31-evidence-v1", "run_id": run["run_id"],
                                                "contains_private_source_material": True,
                                                "files": evidence, "source_mutations": 0})


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="Saved FT31 run root")
    args = parser.parse_args(argv)
    try:
        result = verify(args.root)
    except (VerificationError, OSError, KeyError, TypeError, UnicodeError) as exc:
        failure = {"verified": False, "error": str(exc), "checked_at": datetime.now(timezone.utc).isoformat(),
                   "scope": "Saved files only; no model/API requests"}
        if args.root.is_dir():
            write_json(args.root / "verification.json", failure)
        print(json.dumps(failure, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result["verification"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
