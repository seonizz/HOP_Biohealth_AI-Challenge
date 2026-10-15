"""Join source-exposure admission and an offline, complete tokenizer audit.

This establishes token-cap eligibility only. It neither authorizes training nor
establishes optimizer memory fit, clinical quality, or HOP service readiness.
"""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
import hashlib
import json
import os
from pathlib import Path
import tempfile

from . import source_admission as admission
from . import source_sft as source


SCHEMA = "malssi-token-admission-v1"
CAPS = (512, 1024, 2048, 4096, 8192, 16384, 32768)
IDENTITY = ("id", "split", "source_group_id", "source_conversation_id")
LENGTHS = ("sequence_length", "prefix_length", "target_length")
TOKEN_STATUSES = {"encoded", "held", "runtime_error"}
require = source.require


def read_ledger(path):
    """Reject blank lines, nonobjects, duplicate IDs, and unstable identities."""
    rows, by_id, groups, conversations = [], {}, {}, {}
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as stream:
        for line in stream:
            require(bool(line.strip()), "blank ledger line")
            row = json.loads(line)
            require(isinstance(row, dict), "ledger row must be an object")
            require(all(isinstance(row.get(k), str) and row[k].strip() for k in IDENTITY),
                    "missing ledger identity")
            require(row["split"] in source.SPLITS, "unknown ledger split")
            require(row["id"] not in by_id, "duplicate ledger row ID")
            require(groups.setdefault(row["source_group_id"], row["split"]) == row["split"],
                    "source group crosses splits")
            origin = (row["split"], row["source_group_id"])
            require(conversations.setdefault(row["source_conversation_id"], origin) == origin,
                    "source conversation origin mismatch")
            by_id[row["id"]] = row
            rows.append(row)
    return rows, by_id


def _integer(value):
    return type(value) is int and value >= 0


def _identifiers(values, label):
    require(isinstance(values, list) and all(isinstance(v, str) and v.strip() for v in values)
            and len(values) == len(set(values)), "invalid " + label)
    return set(values)


def _check_counts(actual, declared, label):
    require(isinstance(declared, dict) and all(_integer(v) for v in declared.values())
            and Counter(actual) == Counter(declared), label + " count mismatch")


def _check_length_summary(rows, summary):
    for field, key in zip(LENGTHS, ("full", "prefix", "supervised")):
        values = [row[field] for row in rows if row["tokenizer_status"] == "encoded"]
        declared = summary.get(key, {})
        require(type(declared.get("count")) is int and declared["count"] == len(values)
                and type(declared.get("sum")) is int and declared["sum"] == sum(values)
                and (type(declared.get("max")) is int if values else declared.get("max") is None)
                and declared.get("max") == (max(values) if values else None),
                "tokenizer length summary mismatch")


def validate_and_summarize(release, admission_policy, admission_rows, tokenizer_audit, row_lengths):
    """Return a seven-cap report and joined rows without selecting a cap.

    Paths may be relocated: audit absolute source paths are not trusted or
    followed. Source files are resolved under the supplied release directory.
    No source contents, splits, or prior hold decisions are rewritten.
    """
    release, policy_path, rows_path, audit_path, lengths_path = map(
        Path, (release, admission_policy, admission_rows, tokenizer_audit, row_lengths))
    manifest_path = release / "manifest.json"
    tracked = (manifest_path, policy_path, rows_path, audit_path, lengths_path)
    digests = {str(p): source.sha_file(p) for p in tracked}
    manifest, policy, audit = map(source.read_json, (manifest_path, policy_path, audit_path))
    require(manifest.get("schema_version") == source.SCHEMA
            and manifest.get("training_profile") == "observed_counselor_imitation", "unsupported source manifest")
    require(policy.get("schema_version") == admission.SCHEMA, "unsupported admission policy")
    require(policy.get("model_training_authorized") is False, "source admission unexpectedly authorizes training")
    require(policy.get("input_manifest_sha256") == audit.get("manifest_sha256") == digests[str(manifest_path)],
            "manifest hash binding mismatch")
    require(audit.get("status") in {"passed", "completed_with_holds", "failed"}, "tokenizer audit is incomplete")
    require(audit.get("network_access") is False and audit.get("model_weights_loaded") is False
            and audit.get("training_run") is False, "unexpected tokenizer audit execution scope")
    require(audit.get("row_lengths_sha256") == digests[str(lengths_path)], "row lengths hash mismatch")
    declaration = policy.get("files", {}).get("admission_rows.jsonl.gz", {})
    require(declaration.get("sha256") == digests[str(rows_path)], "admission rows hash mismatch")
    require(_integer(declaration.get("bytes")) and declaration["bytes"] == rows_path.stat().st_size,
            "admission rows byte count mismatch")
    expected, verified = {}, {}
    for split in source.SPLITS:
        key = f"conversation/{split}.jsonl.gz"
        meta = manifest.get("files", {}).get(key, {})
        audit_input = audit.get("inputs", {}).get(split, {})
        require(_integer(meta.get("rows")) and _integer(meta.get("bytes")), "invalid source manifest counts")
        require(audit_input.get("manifest_key") == key, "tokenizer input manifest key mismatch")
        require(audit_input.get("sha256") == policy.get("verified_release_files", {}).get(key) == meta.get("sha256"),
                "source hash binding mismatch")
        require(type(audit_input.get("rows")) is int and audit_input["rows"] == meta["rows"]
                and type(audit_input.get("bytes")) is int and audit_input["bytes"] == meta["bytes"],
                "tokenizer source count mismatch")
        path = release / key
        if not path.is_file():
            path = release / Path(key).name
        require(path.is_file() and path.stat().st_size == meta["bytes"], "source file byte count mismatch")
        require(source.sha_file(path) == meta["sha256"], "source file hash mismatch")
        digests[str(path)] = meta["sha256"]
        verified[key] = meta["sha256"]
        expected[split] = meta["rows"]
    total = sum(expected.values())
    for value in (audit.get("expected_rows"), audit.get("processed_rows"), declaration.get("rows")):
        require(type(value) is int and value == total, "declared total row count mismatch")
    ledger, source_ids = read_ledger(rows_path)
    token_rows, token_ids = read_ledger(lengths_path)
    require(len(ledger) == len(token_rows) == total, "actual total row count mismatch")
    require(source_ids.keys() == token_ids.keys(), "ledger ID set mismatch (missing or extra rows)")
    _check_counts(Counter(r["split"] for r in ledger), expected, "admission split")
    _check_counts(Counter(r["split"] for r in token_rows), expected, "tokenizer split")
    groups = _identifiers(policy.get("quarantined_source_groups"), "quarantined groups")
    targets = _identifiers(policy.get("held_validation_example_ids"), "held validation IDs")
    require(groups <= {r["source_group_id"] for r in ledger} and targets <= source_ids.keys(),
            "policy references missing source IDs")
    joined = []
    for row in ledger:
        token = token_ids[row["id"]]
        require(all(row[k] == token[k] for k in IDENTITY), "joined source identity mismatch")
        reasons = ([admission.GROUP_REASON] if row["source_group_id"] in groups else [])
        if row["id"] in targets:
            require(row["split"] == "validation", "validation target hold assigned to train")
            reasons.append(admission.TARGET_REASON)
        require(row.get("reasons") == reasons and type(row.get("admitted")) is bool
                and row["admitted"] == (not reasons)
                and row.get("status") == ("held" if reasons else "admitted"), "source hold decision inconsistent")
        require(row.get("model_training_authorized") is False, "ledger unexpectedly authorizes training")
        status = token.get("status")
        require(status in TOKEN_STATUSES, "unknown tokenizer status")
        item = {**{k: row[k] for k in IDENTITY}, "source_admitted": row["admitted"],
                "source_status": row["status"], "source_reasons": list(reasons), "tokenizer_status": status}
        if status == "encoded":
            require(all(type(token.get(k)) is int and token[k] > 0 for k in LENGTHS), "invalid token lengths")
            require(token["sequence_length"] == token["prefix_length"] + token["target_length"],
                    "inconsistent token lengths")
            item.update({k: token[k] for k in LENGTHS})
        else:
            require(not any(k in token for k in LENGTHS), "failed tokenizer row contains unverified lengths")
            require(all(isinstance(token.get(k), str) and token[k] for k in ("error_type", "error")),
                    "tokenizer failure reason missing")
            item["tokenizer_error"] = {k: token[k] for k in ("error_type", "error")}
        joined.append(item)
    statuses = Counter(r["tokenizer_status"] for r in joined)
    _check_counts(statuses, audit.get("statuses"), "tokenizer status")
    expected_status = "failed" if statuses["runtime_error"] else ("completed_with_holds" if statuses["held"] else "passed")
    require(audit["status"] == expected_status and audit.get("all_rows_encoded") is (statuses["encoded"] == total),
            "tokenizer audit outcome inconsistent")
    _check_length_summary(joined, audit.get("totals", {}))
    for split in source.SPLITS:
        split_audit = audit.get("splits", {}).get(split, {})
        require(type(split_audit.get("processed_rows")) is int and split_audit["processed_rows"] == expected[split],
                "tokenizer split summary mismatch")
        _check_counts(Counter(r["tokenizer_status"] for r in joined if r["split"] == split),
                      split_audit.get("statuses"), "tokenizer split status")
        _check_length_summary([r for r in joined if r["split"] == split], split_audit)
    held = [r for r in ledger if not r["admitted"]]
    counts = {"all_rows": total, "admitted_rows": total - len(held), "held_rows": len(held),
              "group_quarantine_rows": sum(admission.GROUP_REASON in r["reasons"] for r in held),
              "validation_target_hold_rows": len(targets),
              "both_hold_reasons_rows": sum(len(r["reasons"]) == 2 for r in held)}
    _check_counts(counts, policy.get("counts"), "source admission")
    for key, subset in (("before", ledger), ("after", [r for r in ledger if r["admitted"]]), ("held", held)):
        require(policy.get(key) == admission.summary(subset), "source admission summary mismatch")
    require(all(source.sha_file(p) == digest for p, digest in digests.items()), "join inputs changed during validation")
    report = {"schema_version": SCHEMA, "status": "verified", "rows": total,
              "input_sha256": digests, "input_manifest_sha256": digests[str(manifest_path)],
              "verified_release_files": verified, "source_admission_counts": counts,
              "tokenizer_statuses": dict(statuses), "caps": summarize_caps(joined), "selected_cap": None,
              "full_training_authorized": False, "model_training_authorized": False,
              "optimizer_fit": "unknown", "hop_readiness": False,
              "source_text_modified": False, "source_split_moved": False,
              "interpretation": "Eligibility requires both source admission and successful untruncated encoding within the explicit cap; token eligibility is not training or deployment approval."}
    return report, joined


def make_cap_ledger(joined, cap):
    """Select a cap for rows returned by validate_and_summarize."""
    require(type(cap) is int and cap in CAPS, "an explicit supported token cap is required")
    result = []
    for row in joined:
        reasons = list(row["source_reasons"])
        if row["tokenizer_status"] != "encoded":
            reasons.append("tokenizer_" + row["tokenizer_status"])
            gate = "failed"
        elif row["sequence_length"] > cap:
            reasons.append("sequence_exceeds_cap")
            gate = "over_cap"
        else:
            gate = "passed"
        result.append({**row, "cap": cap, "admitted": not reasons,
                       "status": "held" if reasons else "admitted", "reasons": reasons,
                       "token_length_gate_status": gate, "full_training_authorized": False,
                       "model_training_authorized": False, "optimizer_fit": "unknown", "hop_readiness": False})
    return result


def summarize_caps(joined):
    results = {}
    for cap in CAPS:
        ledger = make_cap_ledger(joined, cap)
        splits = {}
        for split in source.SPLITS:
            rows = [r for r in ledger if r["split"] == split]
            keep = [r for r in rows if r["admitted"]]
            splits[split] = {"admitted_rows": len(keep), "held_rows": len(rows) - len(keep),
                             "full_tokens": sum(r["sequence_length"] for r in keep),
                             "prefix_tokens": sum(r["prefix_length"] for r in keep),
                             "supervised_tokens": sum(r["target_length"] for r in keep),
                             "source_groups": len({r["source_group_id"] for r in keep}),
                             "source_conversations": len({r["source_conversation_id"] for r in keep}),
                             "hold_reason_rows": dict(Counter(reason for r in rows for reason in r["reasons"]))}
        results[str(cap)] = splits
    return results


def build_token_admission(release, admission_policy, admission_rows, tokenizer_audit, row_lengths, output, *, cap):
    require(type(cap) is int and cap in CAPS, "an explicit supported token cap is required")
    output = Path(output)
    ledger_path, report_path = output / "token_admission_rows.jsonl.gz", output / "token_admission_policy.json"
    require(not any(p.exists() or p.is_symlink() for p in (ledger_path, report_path)),
            "token admission output already exists")
    report, joined = validate_and_summarize(release, admission_policy, admission_rows, tokenizer_audit, row_lengths)
    ledger = make_cap_ledger(joined, cap)
    output.mkdir(parents=True, exist_ok=True)
    with gzip.open(ledger_path, "xt", encoding="utf-8") as stream:
        for row in ledger:
            stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    report.update(selected_cap=cap, selected=report["caps"][str(cap)],
                  files={ledger_path.name: {"rows": len(ledger), "bytes": ledger_path.stat().st_size,
                                            "sha256": source.sha_file(ledger_path)}})
    with report_path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    return report


def export_source_rows(release, admission_policy, admission_rows, tokenizer_audit, row_lengths,
                       selected_policy, selected_rows, output, *, cap):
    """Copy admitted original JSONL byte lines into a new, distinct directory.

    Revalidate the complete join and the persisted selection before reading
    source examples. All source IDs, including held IDs, must match the ledger.
    Staging prevents a failed verification from publishing a partial export.
    """
    require(type(cap) is int and cap in CAPS, "an explicit supported token cap is required")
    release, selected_policy, selected_rows, output = map(Path, (release, selected_policy, selected_rows, output))
    require(not output.exists() and not output.is_symlink(), "source export output already exists")
    report, joined = validate_and_summarize(release, admission_policy, admission_rows, tokenizer_audit, row_lengths)
    selected_digests = {str(path): source.sha_file(path) for path in (selected_policy, selected_rows)}
    policy = source.read_json(selected_policy)
    require(policy.get("schema_version") == SCHEMA and policy.get("status") == "verified"
            and type(policy.get("selected_cap")) is int and policy["selected_cap"] == cap,
            "selected policy or cap mismatch")
    require(policy.get("input_manifest_sha256") == report["input_manifest_sha256"]
            and policy.get("verified_release_files") == report["verified_release_files"],
            "selected policy source binding mismatch")
    require(isinstance(policy.get("input_sha256"), dict)
            and Counter(policy["input_sha256"].values()) == Counter(report["input_sha256"].values()),
            "selected policy input hashes mismatch")
    require(all(policy.get(k) is False for k in ("full_training_authorized", "model_training_authorized", "hop_readiness")),
            "selected policy unexpectedly authorizes training or HOP")
    declaration = policy.get("files", {}).get("token_admission_rows.jsonl.gz", {})
    require(declaration.get("sha256") == selected_digests[str(selected_rows)]
            and type(declaration.get("bytes")) is int and declaration["bytes"] == selected_rows.stat().st_size,
            "selected ledger hash or size mismatch")
    ledger, by_id = read_ledger(selected_rows)
    expected = {r["id"]: r for r in make_cap_ledger(joined, cap)}
    require(type(declaration.get("rows")) is int and declaration["rows"] == len(ledger) == len(expected)
            and by_id.keys() == expected.keys(), "selected ledger ID set or count mismatch")
    for row in ledger:
        require(json.dumps(row, sort_keys=True) == json.dumps(expected[row["id"]], sort_keys=True),
                "selected ledger differs from verified decisions")
    require(policy.get("selected") == report["caps"][str(cap)], "selected policy summary mismatch")
    manifest = source.read_json(release / "manifest.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    files, seen = {}, set()
    with tempfile.TemporaryDirectory(prefix=".malssi-source-export-", dir=output.parent) as temporary:
        staging = Path(temporary)
        for split in source.SPLITS:
            key = f"conversation/{split}.jsonl.gz"
            source_path = release / key
            if not source_path.is_file():
                source_path = release / Path(key).name
            destination = staging / f"{split}.jsonl.gz"
            copied_hash = hashlib.sha256()
            count, admitted_count = 0, 0
            with gzip.open(source_path, "rb") as stream, gzip.open(destination, "xb") as target:
                for line in stream:
                    require(bool(line.strip()), "blank source JSONL line")
                    row = json.loads(line)
                    require(isinstance(row, dict) and isinstance(row.get("id"), str), "invalid source JSONL identity")
                    identity = row["id"]
                    require(identity not in seen, "duplicate source JSONL ID")
                    require(identity in by_id, "source JSONL ID missing from selected ledger")
                    require(row.get("split") == split and all(row.get(k) == by_id[identity][k] for k in IDENTITY),
                            "source JSONL identity disagrees with selected ledger")
                    seen.add(identity);count += 1
                    if by_id[identity]["admitted"]:
                        target.write(line)
                        copied_hash.update(line)
                        admitted_count += 1
            require(count == manifest["files"][key]["rows"], "source JSONL row count mismatch")
            require(admitted_count == report["caps"][str(cap)][split]["admitted_rows"], "export admitted count mismatch")
            actual_hash, actual_count = hashlib.sha256(), 0
            with gzip.open(destination, "rb") as stream:
                for line in stream:
                    actual_hash.update(line);actual_count += 1
            require(actual_hash.digest() == copied_hash.digest() and actual_count == admitted_count,
                    "exported source bytes or row count changed")
            files[destination.name] = {"rows": admitted_count, "bytes": destination.stat().st_size,
                                       "sha256": source.sha_file(destination),
                                       "uncompressed_sha256": actual_hash.hexdigest(), "source_manifest_key": key}
        require(seen == by_id.keys(), "source JSONL missing selected ledger IDs")
        require(all(source.sha_file(path) == digest for path, digest in
                    {**report["input_sha256"], **selected_digests}.items()), "export inputs changed during copying")
        exported = {"schema_version": "malssi-source-filtered-export-v1", "status": "verified",
                    "training_profile": "observed_counselor_imitation", "dataset_kind": "source_conversation_only",
                    "source_manifest_sha256": report["input_manifest_sha256"], "selected_cap": cap,
                    "source_admission_policy_sha256": source.sha_file(admission_policy),
                    "source_admission_ledger_sha256": source.sha_file(admission_rows),
                    "token_admission_policy_sha256": selected_digests[str(selected_policy)],
                    "token_admission_ledger_sha256": selected_digests[str(selected_rows)],
                    "verified_source_files": report["verified_release_files"], "files": files,
                    "selection": report["caps"][str(cap)], "source_rows_examined": len(seen),
                    "original_jsonl_lines_preserved": True, "source_text_modified": False,
                    "source_split_moved": False, "tokens_truncated": False,
                    "full_training_authorized": False, "model_training_authorized": False,
                    "hop_readiness": False, "optimizer_fit": "unknown",
                    "analysis_references": {
                        kind: {"purpose": "existing_analysis_only", "exported": False, "training_approved": False,
                               "source_manifest_keys": [key for key in manifest["files"] if key.startswith(kind + "/")]}
                        for kind in ("sentence", "word")},
                    "interpretation": "Only source counselor-imitation conversation rows are exported. Sentence and word datasets remain existing analysis references; this is not approval of three training datasets or HOP deployment."}
        source.dump_json(staging / "export_manifest.json", exported)
        output.mkdir(exist_ok=False)
        published = []
        try:
            for name in (*files, "export_manifest.json"):
                destination = output / name
                os.link(staging / name, destination)  # Atomic no-overwrite publication on the same filesystem.
                published.append(destination)
        except BaseException:
            for destination in published:
                destination.unlink()
            try:
                output.rmdir()
            except OSError:
                pass
            raise
    return exported


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("release", "admission-policy", "admission-rows", "tokenizer-audit", "row-lengths", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--cap", type=int, choices=CAPS, required=True)
    parser.add_argument("--export-source-rows", action="store_true",
                        help="Also copy admitted original JSONL lines into a new output/source_rows directory")
    args = parser.parse_args()
    if args.export_source_rows:
        destination = args.output / "source_rows"
        require(not destination.exists() and not destination.is_symlink(), "source export output already exists")
    result = build_token_admission(args.release, args.admission_policy, args.admission_rows,
                                   args.tokenizer_audit, args.row_lengths, args.output, cap=args.cap)
    if args.export_source_rows:
        export_source_rows(args.release, args.admission_policy, args.admission_rows, args.tokenizer_audit,
                           args.row_lengths, args.output / "token_admission_policy.json",
                           args.output / "token_admission_rows.jsonl.gz", args.output / "source_rows", cap=args.cap)
    print(json.dumps({k: result[k] for k in ("status", "rows", "selected_cap", "selected",
                                            "model_training_authorized", "optimizer_fit", "hop_readiness")},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
