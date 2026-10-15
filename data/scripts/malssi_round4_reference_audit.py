#!/usr/bin/env python3
"""Offline representative cached/native token-array equivalence audit.

Every source conversation is visited, but only its first/middle/last example and
one boundary-whitespace example, when present, are encoded by both paths. This
is not a cache-free rerun of every source row, and never loads model weights.
"""
import argparse
from collections import Counter, deque
from concurrent.futures import ProcessPoolExecutor
import gzip
import hashlib
import importlib.metadata
import json
import multiprocessing
from pathlib import Path
import platform
import sys
import time

try:
    import malssi_tokenizer_audit as runner
except ModuleNotFoundError:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import malssi_tokenizer_audit as runner

adapter = runner.adapter
ARRAY_FIELDS = ("input_ids", "labels", "attention_mask")
IDENTITY_FIELDS = ("id", "split", "source_group_id", "source_conversation_id")


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def select_family_rows(rows):
    """Select source-order first/middle/last, then one extra whitespace case."""
    runner.require(bool(rows), "Empty source family")
    selected = {}
    for index, reason in ((0, "first"), (len(rows) // 2, "middle"), (len(rows) - 1, "last")):
        selected.setdefault(index, []).append(reason)
    whitespace = next((i for i, row in enumerate(rows)
                       if row["messages"][-1]["content"] != row["messages"][-1]["content"].strip()), None)
    reason = "target_boundary_whitespace"
    if whitespace is None:
        whitespace = next((i for i, row in enumerate(rows)
                           if any(m["content"] != m["content"].strip() for m in row["messages"])), None)
        reason = "context_boundary_whitespace"
    if whitespace is not None:
        selected.setdefault(whitespace, []).append(reason)
    return [(index, rows[index], reasons) for index, reasons in sorted(selected.items())]


def encoded_fingerprint(encoded):
    return {"encoded_sha256": digest(encoded),
            "array_sha256": {key: digest(encoded[key]) for key in ARRAY_FIELDS},
            "metadata": {key: value for key, value in encoded.items() if key not in ARRAY_FIELDS}}


def audit_family(rows):
    selected = select_family_rows(rows)
    family, reason = runner.prepare_prefix_family(rows, runner.TOKENIZER)
    longest = max(rows, key=lambda row: len(row["messages"]))
    records = []
    for index, row, reasons in selected:
        messages = row["messages"]
        first = next((m for m in messages if m["role"] != "system"), {})
        becomes_history = (len(messages) < len(longest["messages"])
                           and messages == longest["messages"][:len(messages)])
        record = {**{key: row[key] for key in IDENTITY_FIELDS}, "source_family_row_index": index,
                  "selection_reasons": reasons, "family_source_rows": len(rows),
                  "message_count": len(messages), "starts_with_assistant": first.get("role") == "assistant",
                  "target_boundary_whitespace": messages[-1]["content"] != messages[-1]["content"].strip(),
                  "any_message_boundary_whitespace": any(m["content"] != m["content"].strip() for m in messages),
                  "target_becomes_history_in_longer_row": becomes_history,
                  "longer_row_id": longest["id"] if becomes_history else None,
                  "source_messages_sha256": digest(messages)}
        if family is None:
            record.update(status="cache_unavailable", error_type="FamilyProofRejected", error=reason)
        else:
            try:
                cached = runner.encode_family_row(row, runner.TOKENIZER, family)
                reference = adapter.encode_example(row, runner.TOKENIZER)
                differences = [key for key in sorted(set(cached) | set(reference))
                               if key not in cached or key not in reference
                               or canonical(cached[key]) != canonical(reference[key])]
                record.update(status="matched" if not differences else "mismatch", differing_fields=differences,
                              cached=encoded_fingerprint(cached), reference=encoded_fingerprint(reference))
            except Exception as error:
                record.update(status="runtime_error", error_type=type(error).__name__, error=str(error))
        records.append(record)
    return {"source_conversation_id": rows[0]["source_conversation_id"], "split": rows[0]["split"],
            "source_rows": len(rows), "selected_rows": len(records), "native_family_proof_passed": family is not None,
            "family_cache_rejection": reason, "records": records}


def run(args):
    started = time.monotonic()
    runner.require(type(args.workers) is int and 1 <= args.workers <= 4, "Use one to four workers")
    runner.require(args.model_dir.is_dir(), "Local model directory does not exist")
    runner.require(not args.output_dir.exists() and not args.output_dir.is_symlink(), "Audit output already exists")
    inputs, manifest_sha = runner.verify_inputs(args.data_dir)
    manifest = json.loads((args.data_dir / "manifest.json").read_text(encoding="utf-8"))
    expected_conversations = manifest.get("selected_conversations")
    if expected_conversations is not None:
        runner.require(isinstance(expected_conversations, dict)
                       and all(type(expected_conversations.get(split)) is int and expected_conversations[split] >= 0
                               for split in runner.SPLITS), "Invalid declared source conversation counts")
    expected = sum(item["rows"] for item in inputs.values())
    args.output_dir.mkdir(parents=True, exist_ok=False)
    report_path = args.output_dir / "reference_audit.json"
    rows_path = args.output_dir / "checked_rows.jsonl.gz"
    report = {"schema_version": "malssi-round4-reference-audit-v1", "status": "running",
              "scope": "First/middle/last and at most one whitespace example from every source conversation; not a cache-free full-row rerun",
              "selection_policy": "Source-order indices 0, floor(n/2), n-1; first target-trim case, else first any-message-trim case; deduplicated indices",
              "inputs": inputs, "manifest_sha256": manifest_sha, "expected_source_rows": expected,
              "expected_source_conversations_by_split": expected_conversations,
              "model_dir": str(args.model_dir.resolve()), "workers": args.workers,
              "max_pending_families": min(8, args.workers * 2), "python_version": platform.python_version(),
              "network_access": False, "model_weights_loaded": False, "training_run": False,
              "model_training_authorized": False, "hop_readiness": False,
              "code_sha256": {"reference_runner": runner.sha_file(Path(__file__)),
                              "tokenizer_runner": runner.sha_file(Path(runner.__file__)),
                              "adapter": runner.sha_file(Path(adapter.__file__))},
              "library_versions": {}, "model_metadata_sha256": {}}
    for name in ("transformers", "tokenizers", "huggingface-hub"):
        try:
            report["library_versions"][name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            report["library_versions"][name] = None
    for name in ("chat_template.jinja", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "config.json"):
        path = args.model_dir / name
        if path.is_file():
            report["model_metadata_sha256"][name] = runner.sha_file(path)
    runner.dump(report_path, report)
    families, records, seen, source_counts = [], [], set(), Counter()
    try:
        work = iter(runner.source_families(inputs))
        with gzip.open(rows_path, "xt", encoding="utf-8") as output, ProcessPoolExecutor(
                max_workers=args.workers, mp_context=multiprocessing.get_context("spawn"),
                initializer=runner.worker_init, initargs=(str(args.model_dir.resolve()), [])) as pool:
            pending = deque()
            for _ in range(report["max_pending_families"]):
                family = next(work, None)
                if family is not None:
                    pending.append(pool.submit(audit_family, family))
            while pending:
                result = pending.popleft().result()
                runner.require(result["source_conversation_id"] not in seen, "Duplicate completed source family")
                seen.add(result["source_conversation_id"])
                source_counts[result["split"]] += result["source_rows"]
                for row in result["records"]:
                    output.write(canonical(row) + "\n")
                records.extend(result["records"])
                families.append({key: value for key, value in result.items() if key != "records"})
                family = next(work, None)
                if family is not None:
                    pending.append(pool.submit(audit_family, family))
                if len(families) % 100 == 0:
                    print(canonical({"event": "progress", "source_conversations": len(families),
                                     "checked_rows": len(records), "source_rows_seen": sum(source_counts.values()),
                                     "elapsed_seconds": round(time.monotonic() - started, 2)}), flush=True)
        runner.require(sum(source_counts.values()) == expected, "Source family count coverage mismatch")
        conversation_counts = Counter(f["split"] for f in families)
        for split in runner.SPLITS:
            runner.require(source_counts[split] == inputs[split]["rows"], "Source split coverage mismatch")
            runner.require(runner.sha_file(inputs[split]["path"]) == inputs[split]["sha256"], "Source changed during reference audit")
            if expected_conversations is not None:
                runner.require(conversation_counts[split] == expected_conversations[split], "Source conversation coverage mismatch")
        runner.require(runner.sha_file(args.data_dir / "manifest.json") == manifest_sha, "Manifest changed during audit")
        for key, path in (("reference_runner", Path(__file__)), ("tokenizer_runner", Path(runner.__file__)),
                          ("adapter", Path(adapter.__file__))):
            runner.require(runner.sha_file(path) == report["code_sha256"][key], "Audit code changed during execution")
        for name, expected_hash in report["model_metadata_sha256"].items():
            runner.require(runner.sha_file(args.model_dir / name) == expected_hash, "Tokenizer metadata changed during audit")
        statuses = Counter(row["status"] for row in records)
        report.update(status="passed" if statuses["matched"] == len(records) and records else "failed",
                      source_conversations=len(families), source_rows_seen=sum(source_counts.values()),
                      source_conversations_by_split=dict(conversation_counts),
                      source_rows_by_split=dict(source_counts), checked_rows=len(records), statuses=dict(statuses),
                      native_family_proofs_passed=sum(f["native_family_proof_passed"] for f in families),
                      family_records=families, all_selected_fields_exactly_equal=statuses["matched"] == len(records) and bool(records),
                      arrays_compared=list(ARRAY_FIELDS), all_encoded_metadata_compared=True,
                      selected_feature_counts={key: sum(row[key] for row in records) for key in
                          ("starts_with_assistant", "target_boundary_whitespace", "any_message_boundary_whitespace",
                           "target_becomes_history_in_longer_row")},
                      selection_reason_counts=dict(Counter(reason for row in records for reason in row["selection_reasons"])),
                      checked_rows_sha256=runner.sha_file(rows_path),
                      array_hash_encoding="SHA256 of UTF-8 canonical JSON, sorted keys, ensure_ascii=False, compact separators",
                      privacy_note="Ledger contains IDs, lengths, comparison metadata and array hashes; no source text or token arrays.")
    except Exception as error:
        report.update(status="failed", error_type=type(error).__name__, error=str(error),
                      source_conversations=len(families), checked_rows=len(records))
        raise
    finally:
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)
        runner.dump(report_path, report)
    print(canonical({"event": "complete", "status": report["status"], "source_conversations": len(families),
                     "checked_rows": len(records), "statuses": report["statuses"],
                     "elapsed_seconds": report["elapsed_seconds"]}), flush=True)
    return 0 if report["status"] == "passed" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    try:
        return run(args)
    except Exception as error:
        print(canonical({"event": "error", "error_type": type(error).__name__, "error": str(error)}), flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
