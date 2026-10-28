#!/usr/bin/env python3
"""Blinded review handoff when the requested local model is unavailable.

The native reviewer writes a real verdict artifact, not an emulated API response.
Only fictional source facts and targets are exposed. Negative-control bindings
are kept separately and are never part of the reviewer's inputs.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import uuid

import card_expansion as expansion
import role_dataset as data

VERSION = "native-independent-fictional-card-review-v1"
REVIEWER = "native-codex-gpt-6.1-sol-independent-reviewer"
SCOPE = "independent_ai_experiment_only_not_human_clinical_review"


def review_records(root):
    return [row for name in ("reviews.jsonl", "native_reviews.jsonl")
            if (root / "reviews" / name).exists() for row in data.read_rows(root / "reviews" / name)]


def prepare(root, batch_size=12):
    root = root.resolve(strict=True)
    cases = expansion.load_cases(root, partial=True)
    known = {r["case_sha256"] for r in review_records(root)}
    bindings_path = root / "reviews/native_bindings.json"
    bindings = json.loads(bindings_path.read_text()) if bindings_path.exists() else {}
    for batch in bindings.values():
        known.update(batch["case_hashes"].values())
    pending = [c for c in cases.values() if expansion.case_hash(c) not in known]
    inputs = root / "native_review_inputs"
    outputs = root / "native_review_outputs"
    inputs.mkdir(exist_ok=True)
    outputs.mkdir(exist_ok=True)
    prepared = []
    for start in range(0, len(pending), batch_size):
        chunk = pending[start:start + batch_size]
        number = len(bindings)
        case_hashes, requests = {}, []
        for case in chunk:
            identity = uuid.uuid4().hex[:16]
            case_hashes[identity] = expansion.case_hash(case)
            requests.append({"id": identity, "facts": case["facts"], "cards": case["cards"]})
        control, field = expansion.control_case(chunk[0], number)
        control_id = uuid.uuid4().hex[:16]
        base_id = requests[0]["id"]
        requests.append({"id": control_id, "facts": control["facts"], "cards": control["cards"]})
        # UUID order hides the control's position and original author/frozen split.
        requests.sort(key=lambda c: c["id"])
        name = f"batch-{number:03d}.json"
        data.save(inputs / name, {"review_instruction": expansion.REVIEW_PROMPT, "cases": requests})
        bindings[name] = {"version": VERSION, "input_file": "native_review_inputs/" + name,
            "output_file": "native_review_outputs/" + name, "input_sha256": data.file_hash(inputs / name),
            "case_hashes": case_hashes, "control_id": control_id, "control_base_id": base_id, "control_field": field,
            "reviewer_id": REVIEWER, "requested_native_model": "gpt-6.1-sol", "requested_reasoning_effort": "high"}
        prepared.append(name)
    data.save(bindings_path, bindings)
    return {"prepared_batches": prepared, "fictional_cases": len(pending)}


def inspect_batch(root, binding, require_output_hash=True):
    data.require(binding["version"] == VERSION and binding["reviewer_id"] == REVIEWER, "Wrong native reviewer contract")
    input_path, output_path = (data.safe_path(root, binding[k]) for k in ("input_file", "output_file"))
    data.require(data.file_hash(input_path) == binding["input_sha256"], "Native input hash changed")
    if require_output_hash:
        data.require(data.file_hash(output_path) == binding["output_sha256"], "Native output hash changed")
    request, response = json.loads(input_path.read_text()), json.loads(output_path.read_text())
    data.require(request["review_instruction"] == expansion.REVIEW_PROMPT, "Native review instruction changed")
    cases = {c["id"]: c for c in request["cases"]}
    data.require(len(cases) == len(request["cases"]) and set(cases) == set(binding["case_hashes"]) | {binding["control_id"]}, "Native review identity mismatch")
    verdicts = expansion.parse_review(response, list(cases))
    field = binding["control_field"]
    fields = ("script", "doList", "care", "next", "avoid")
    data.require(field in fields, "Invalid native control field")
    planted, _ = expansion.control_case(cases[binding["control_base_id"]], fields.index(field))
    planted["id"] = binding["control_id"]
    data.require(cases[binding["control_id"]] == planted, "Native planted error changed")
    data.require(verdicts[binding["control_id"]]["field_verdicts"][field] != "pass", "Native reviewer accepted negative control")
    return cases, verdicts


def verify_record(root, case, record):
    data.require(record["case_id"] == case["case_id"] and record["case_sha256"] == expansion.case_hash(case), "Stale native review")
    data.require(record["reviewer_id"] == REVIEWER and record["review_version"] == VERSION
                 and record["approval_scope"] == SCOPE and record["control_passed"] is True, "Invalid native review scope")
    binding = record["native_evidence"]
    sources, verdicts = inspect_batch(root, binding)
    matches = [i for i, value in binding["case_hashes"].items() if value == expansion.case_hash(case)]
    data.require(len(matches) == 1, "Case missing from native binding")
    identity = matches[0]
    data.require(sources[identity] == {"id": identity, "facts": case["facts"], "cards": case["cards"]}, "Native reviewer saw a different case")
    verdict = verdicts[identity]
    data.require(record["field_verdicts"] == verdict["field_verdicts"] and record["issues"] == verdict["issues"], "Native ledger verdict changed")
    accepted = all(v == "pass" for v in verdict["field_verdicts"].values()) and not verdict["issues"]
    data.require(type(record["accepted"]) is bool and record["accepted"] == accepted, "False native admission flag")
    return accepted


def ingest(root):
    root = root.resolve(strict=True)
    cases = {expansion.case_hash(c): c for c in expansion.load_cases(root, partial=True).values()}
    bindings = json.loads((root / "reviews/native_bindings.json").read_text())
    # Separate ledger avoids concurrent writes with the running Ollama reviewer.
    ledger = root / "reviews/native_reviews.jsonl"
    known = {(r["case_sha256"], r["reviewer_id"]) for r in data.read_rows(ledger)} if ledger.exists() else set()
    added = []
    for name, binding in bindings.items():
        output = data.safe_path(root, binding["output_file"])
        if not output.exists():
            continue
        binding = {**binding, "output_sha256": data.file_hash(output)}
        _, verdicts = inspect_batch(root, binding)
        for identity, hash_value in binding["case_hashes"].items():
            if (hash_value, REVIEWER) in known:
                continue
            data.require(hash_value in cases, "Native verdict refers to stale case")
            verdict = verdicts[identity]
            record = {"case_id": cases[hash_value]["case_id"], "case_sha256": hash_value,
                "reviewer_id": REVIEWER, "review_version": VERSION, "review_prompt_sha256": data.digest(expansion.REVIEW_PROMPT),
                "reviewed_at": datetime.now(timezone.utc).isoformat(), "accepted": all(v == "pass" for v in verdict["field_verdicts"].values()),
                "field_verdicts": verdict["field_verdicts"], "issues": verdict["issues"],
                "native_evidence": binding, "control_passed": True, "approval_scope": SCOPE}
            verify_record(root, cases[hash_value], record)
            added.append(record)
    if added:
        with ledger.open("a") as handle:
            for row in added:
                handle.write(data.canonical(row) + "\n")
    return {"ingested": len(added), "accepted": sum(r["accepted"] for r in added)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "ingest"))
    parser.add_argument("--root", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps((prepare if args.command == "prepare" else ingest)(args.root), ensure_ascii=False))
