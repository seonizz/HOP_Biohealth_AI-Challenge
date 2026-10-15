"""Audit local evaluation-use history without promoting an unverified holdout.

The local event inventory is evidence of recorded use, not proof that all
past use was recorded. This sidecar never creates an independent test set.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime
import gzip
import hashlib
import json
import os
from pathlib import Path
import tempfile

from . import source_sft as source
from . import source_admission as admission
from . import token_admission as token


SCHEMA = "malssi-evaluation-history-v2"
EVENT_SCHEMA = "malssi-evaluation-history-event-v1"
DEVELOPMENT_PURPOSES = frozenset({"development_audit", "data_selection", "training",
                                  "tuning", "prompt_design", "annotation_review"})
PURPOSES = DEVELOPMENT_PURPOSES | {"custody_record", "independent_evaluation"}
INTENDED_USES = ("development", "independent_test")
require = source.require


def _digest(value):
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def _integer(value):
    return type(value) is int and value >= 0


def _json_rows(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as stream:
        for line in stream:
            require(bool(line.strip()), "blank history line")
            row = json.loads(line)
            require(isinstance(row, dict), "history row must be an object")
            yield row


def _pointer(document, pointer):
    """Resolve an explicit JSON pointer; never search arbitrary evidence text."""
    require(isinstance(pointer, str) and pointer.startswith("/"), "invalid evidence input pointer")
    value = document
    for part in pointer[1:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if isinstance(value, dict):
            require(part in value, "evidence input pointer is missing")
            value = value[part]
        elif isinstance(value, list):
            require(part.isdigit() and str(int(part)) == part and int(part) < len(value),
                    "evidence input pointer is missing")
            value = value[int(part)]
        else:
            raise ValueError("evidence input pointer is missing")
    return value


def _scope_groups(scope, rows, by_id):
    require(isinstance(scope, dict), "history scope must be explicit")
    kind = scope.get("kind")
    require(isinstance(kind, str), "unknown history scope")
    if kind == "source_split":
        require(set(scope) == {"kind", "split"} and scope["split"] in source.SPLITS,
                "unknown history source split")
        groups = {r["source_group_id"] for r in rows if r["split"] == scope["split"]}
    else:
        require(kind in {"rows", "source_groups"} and set(scope) == {"kind", "ids"},
                "unknown history scope")
        ids = scope["ids"]
        require(isinstance(ids, list) and ids and all(isinstance(v, str) and v.strip() for v in ids)
                and len(ids) == len(set(ids)), "empty or duplicate history scope")
        if kind == "rows":
            require(set(ids) <= by_id.keys(), "history row missing from source ledger")
            groups = {by_id[value]["source_group_id"] for value in ids}
        else:
            groups = set(ids)
            require(groups <= {r["source_group_id"] for r in rows},
                    "history group missing from source ledger")
    require(bool(groups), "empty history scope")
    return groups


def _verify_source(release, admission_policy, selection_audit, tokenizer_audit, row_lengths,
                   manifest, policy, ledger_path, token_rows, by_id, tracked):
    """Anchor every decision to actual source bytes and recomputed admission rules."""
    release = Path(release)
    original_manifest = source.read_json(release / "manifest.json")
    source_policy = source.read_json(admission_policy)
    require(isinstance(original_manifest, dict) and isinstance(source_policy, dict),
            "source manifest and admission policy must be objects")
    require(source.sha_file(release / "manifest.json") == manifest.get("source_manifest_sha256")
            and source.sha_file(admission_policy) == manifest.get("source_admission_policy_sha256"),
            "actual source manifest or admission policy hash mismatch")
    require(source_policy.get("schema_version") == admission.SCHEMA
            and source_policy.get("selection_audit_sha256") == source.sha_file(selection_audit),
            "source admission selection audit binding mismatch")
    report, joined = token.validate_and_summarize(release, admission_policy, ledger_path, tokenizer_audit, row_lengths)
    require(isinstance(policy.get("input_sha256"), dict)
            and Counter(policy["input_sha256"].values()) == Counter(report["input_sha256"].values()),
            "token policy differs from actual source inputs")
    cap = manifest.get("selected_cap")
    expected_tokens = {row["id"]: row for row in token.make_cap_ledger(joined, cap)}
    require({row["id"]: row for row in token_rows} == expected_tokens,
            "selected token ledger differs from verified source decisions")
    require(policy.get("selected") == manifest.get("selection") == report["caps"][str(cap)],
            "selected token summary differs from verified source decisions")
    for path, digest in report["input_sha256"].items():
        path = Path(path)
        require(path not in tracked or tracked[path] == digest, "source inputs changed during validation")
        tracked[path] = digest
    # Recompute existing rules instead of accepting a mutually edited policy and
    # ledger. Temporary outputs contain only the existing local ledger metadata.
    with tempfile.TemporaryDirectory(prefix="evaluation-history-admission-") as temporary:
        rebuilt = admission.build_admission(release, selection_audit, temporary)
        decision_keys = set(rebuilt) - {"files", "release_directory", "selection_audit_path"}
        require(all(source_policy.get(key) == rebuilt[key] for key in decision_keys),
                "source admission policy differs from recomputed rules")
        _, rebuilt_ids = token.read_ledger(Path(temporary) / "admission_rows.jsonl.gz")
        require(by_id == rebuilt_ids, "source admission ledger differs from reconstructed source rows")
        for key, digest in rebuilt["verified_release_files"].items():
            tracked[release / key] = digest
    # Retain only line hashes, never source text, while checking full coverage.
    line_hashes = {}
    for split in source.SPLITS:
        key = f"conversation/{split}.jsonl.gz"
        path = admission.file_check(release, original_manifest, key)
        count = 0
        with gzip.open(path, "rb") as stream:
            for line in stream:
                require(bool(line.strip()), "blank original source line")
                row = json.loads(line)
                require(isinstance(row, dict) and isinstance(row.get("id"), str), "invalid original source identity")
                identity = row["id"]
                require(identity not in line_hashes and identity in by_id
                        and row.get("split") == split
                        and all(row.get(k) == by_id[identity][k] for k in token.IDENTITY),
                        "original source identity differs from ledger")
                line_hashes[identity] = hashlib.sha256(line).hexdigest()
                count += 1
        require(count == original_manifest["files"][key]["rows"], "original source row count mismatch")
    require(line_hashes.keys() == by_id.keys(), "original source ledger coverage mismatch")
    return line_hashes


def _candidate_rows(manifest_path, manifest, source_rows, by_id, policy, token_rows, original_lines, tracked):
    require(manifest.get("schema_version") == "malssi-source-filtered-export-v1"
            and manifest.get("status") == "verified"
            and manifest.get("training_profile") == "observed_counselor_imitation"
            and manifest.get("dataset_kind") == "source_conversation_only", "unsupported source export")
    require(policy.get("schema_version") == token.SCHEMA and policy.get("status") == "verified",
            "unsupported token policy")
    require(_digest(manifest.get("source_manifest_sha256"))
            and policy.get("input_manifest_sha256") == manifest["source_manifest_sha256"],
            "source manifest binding mismatch")
    expected_files = {f"conversation/{split}.jsonl.gz" for split in source.SPLITS}
    source_files = manifest.get("verified_source_files")
    require(isinstance(source_files, dict) and set(source_files) == expected_files
            and all(_digest(v) for v in source_files.values())
            and source_files == policy.get("verified_release_files"), "source file binding mismatch")
    require(_digest(manifest.get("source_admission_policy_sha256"))
            and isinstance(policy.get("input_sha256"), dict)
            and all(_digest(value) for value in policy["input_sha256"].values())
            and {manifest["source_manifest_sha256"], manifest.get("source_admission_policy_sha256"),
                 manifest.get("source_admission_ledger_sha256"), *source_files.values()}
            <= set(policy["input_sha256"].values()), "source admission input binding mismatch")
    require(type(manifest.get("selected_cap")) is int and manifest["selected_cap"] in token.CAPS
            and policy.get("selected_cap") == manifest["selected_cap"], "selected cap mismatch")
    require(all(manifest.get(k) is False and policy.get(k) is False
                for k in ("model_training_authorized", "full_training_authorized", "hop_readiness")),
            "unexpected training or service authorization")
    require(type(manifest.get("source_rows_examined")) is int
            and manifest["source_rows_examined"] == len(source_rows)
            and type(policy.get("rows")) is int and policy["rows"] == len(source_rows)
            and {r["id"] for r in token_rows} == by_id.keys(), "source ledger coverage mismatch")
    selected = {}
    for row in token_rows:
        original = by_id[row["id"]]
        require(all(row[k] == original[k] for k in token.IDENTITY), "source identity mismatch")
        require(type(original.get("admitted")) is bool and isinstance(original.get("reasons"), list)
                and original["admitted"] == (not original["reasons"])
                and original.get("status") == ("admitted" if original["admitted"] else "held"),
                "source admission decision mismatch")
        require(row.get("source_admitted") is original["admitted"]
                and row.get("source_status") == original["status"]
                and row.get("source_reasons") == original["reasons"]
                and row.get("cap") == manifest["selected_cap"], "token source binding mismatch")
        require(row.get("tokenizer_status") in token.TOKEN_STATUSES, "invalid tokenizer status")
        if row["tokenizer_status"] == "encoded":
            require(all(type(row.get(k)) is int and row[k] > 0 for k in token.LENGTHS)
                    and row["sequence_length"] == row["prefix_length"] + row["target_length"],
                    "invalid recorded token lengths")
        decision = token.make_cap_ledger([row], manifest["selected_cap"])[0]
        require(type(row.get("admitted")) is bool
                and all(row.get(k) == decision[k] for k in ("admitted", "status", "reasons", "token_length_gate_status")),
                "token admission decision mismatch")
        if row["admitted"]:
            selected[row["id"]] = row
    files = manifest.get("files")
    require(isinstance(files, dict) and len(files) == len(source.SPLITS), "incomplete export file inventory")
    seen, seen_splits, candidates = set(), set(), []
    for name, meta in files.items():
        require(isinstance(name, str) and Path(name).name == name and name not in {".", ".."}
                and isinstance(meta, dict), "invalid export file declaration")
        key = meta.get("source_manifest_key")
        require(key in expected_files, "unknown export source split")
        split = key.split("/")[1].split(".")[0]
        require(split not in seen_splits, "duplicate export source split")
        seen_splits.add(split)
        path = manifest_path.parent / name
        require(path.resolve().parent == manifest_path.parent.resolve(), "export file escapes its directory")
        require(_integer(meta.get("bytes")) and path.stat().st_size == meta["bytes"]
                and source.sha_file(path) == meta.get("sha256"), "export file hash or size mismatch")
        tracked[path] = meta["sha256"]
        count, uncompressed = 0, hashlib.sha256()
        with gzip.open(path, "rb") as stream:
            for line in stream:
                require(bool(line.strip()), "blank export line")
                uncompressed.update(line)
                row = json.loads(line)
                require(isinstance(row, dict) and isinstance(row.get("id"), str), "invalid export identity")
                identity = row["id"]
                require(identity not in seen, "duplicate export row")
                require(identity in selected and row.get("split") == split
                        and all(row.get(k) == selected[identity][k] for k in token.IDENTITY),
                        "export row missing from selected ledger or source identity changed")
                require(hashlib.sha256(line).hexdigest() == original_lines.get(identity),
                        "export content differs from original source line")
                seen.add(identity)
                candidates.append({k: row[k] for k in token.IDENTITY})
                count += 1
        require(_integer(meta.get("rows")) and count == meta["rows"]
                and uncompressed.hexdigest() == meta.get("uncompressed_sha256"), "export content hash or count mismatch")
        for declaration in (manifest.get("selection", {}), policy.get("selected", {})):
            require(type(declaration.get(split, {}).get("admitted_rows")) is int
                    and declaration[split]["admitted_rows"] == count, "export selection count mismatch")
    require(seen == selected.keys(), "export missing selected rows")
    return candidates


def audit_history(export_manifest, source_ledger, events, *, intended_use, release, admission_policy,
                  selection_audit, tokenizer_audit, row_lengths, token_policy=None, token_ledger=None):
    """Return only aggregates, validating local events against immutable inputs.

    Token files default to the export directory's parent. Actual source files,
    selection evidence and recomputed admission rules anchor the ledgers. A single
    used row exposes its entire source group, including rows omitted by a cap.
    Files may move or be recompressed with a new manifest; event binding uses
    original source hashes and groups rather than candidate filenames.
    """
    require(isinstance(intended_use, str) and intended_use in INTENDED_USES, "unknown intended use")
    manifest_path, ledger_path, events_path = map(Path, (export_manifest, source_ledger, events))
    policy_path = Path(token_policy) if token_policy else manifest_path.parent.parent / "token_admission_policy.json"
    token_path = Path(token_ledger) if token_ledger else manifest_path.parent.parent / "token_admission_rows.jsonl.gz"
    inputs = {"export_manifest": manifest_path, "source_ledger": ledger_path, "events": events_path,
              "token_policy": policy_path, "token_ledger": token_path,
              "source_manifest": Path(release) / "manifest.json", "admission_policy": Path(admission_policy),
              "selection_audit": Path(selection_audit), "tokenizer_audit": Path(tokenizer_audit),
              "row_lengths": Path(row_lengths)}
    hashes = {name: source.sha_file(path) for name, path in inputs.items()}
    tracked = {path: hashes[name] for name, path in inputs.items()}
    manifest, policy = source.read_json(manifest_path), source.read_json(policy_path)
    require(isinstance(manifest, dict) and isinstance(policy, dict), "manifest and policy must be objects")
    for field, name in (("source_admission_ledger_sha256", "source_ledger"),
                        ("token_admission_policy_sha256", "token_policy"),
                        ("token_admission_ledger_sha256", "token_ledger")):
        require(manifest.get(field) == hashes[name], "export ledger or policy hash mismatch")
    require(isinstance(policy.get("files"), dict), "token policy files must be an object")
    declaration = policy["files"].get("token_admission_rows.jsonl.gz", {})
    require(isinstance(declaration, dict), "token ledger declaration must be an object")
    require(declaration.get("sha256") == hashes["token_ledger"]
            and type(declaration.get("bytes")) is int and declaration["bytes"] == token_path.stat().st_size,
            "token ledger hash or size mismatch")
    rows, by_id = token.read_ledger(ledger_path)
    token_rows, _ = token.read_ledger(token_path)
    require(type(declaration.get("rows")) is int and declaration["rows"] == len(token_rows),
            "token ledger row count mismatch")
    original_lines = _verify_source(release, admission_policy, selection_audit, tokenizer_audit, row_lengths,
                                    manifest, policy, ledger_path, token_rows, by_id, tracked)
    candidates = _candidate_rows(manifest_path, manifest, rows, by_id, policy, token_rows, original_lines, tracked)
    group_splits = {r["source_group_id"]: r["split"] for r in rows}
    exposed, event_ids, fingerprints, purposes, evidence_hashes = set(), set(), set(), Counter(), set()
    for event in _json_rows(events_path):
        require(event.get("schema_version") == EVENT_SCHEMA and isinstance(event.get("event_id"), str)
                and event["event_id"].strip(), "invalid history event identity")
        require(event["event_id"] not in event_ids, "duplicate or conflicting history event")
        event_ids.add(event["event_id"])
        require(isinstance(event.get("purpose"), str) and event["purpose"] in PURPOSES, "unknown history purpose")
        try:
            when = datetime.fromisoformat(event["occurred_at"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("invalid history timestamp") from None
        require(when.utcoffset() is not None, "history timestamp requires a timezone")
        require(event.get("source_manifest_sha256") == manifest["source_manifest_sha256"],
                "history source manifest binding mismatch")
        groups = _scope_groups(event.get("scope"), rows, by_id)
        expected_keys = {f"conversation/{group_splits[group]}.jsonl.gz" for group in groups}
        binding = event.get("input_sha256")
        # A complete source-admission ledger also binds all row/group identities.
        # Its old hash cannot be silently dropped when a later ledger is supplied.
        ledger_key = "source_admission_ledger_sha256"
        expected_binding = {**manifest["verified_source_files"], ledger_key: hashes["source_ledger"]}
        require(isinstance(binding, dict) and set(binding) in (expected_keys, {ledger_key})
                and all(binding[k] == expected_binding[k] for k in binding),
                "history input binding does not cover its source scope")
        evidence = event.get("evidence")
        require(isinstance(evidence, dict) and isinstance(evidence.get("path"), str)
                and bool(evidence["path"]) and _digest(evidence.get("sha256")), "invalid history evidence")
        evidence_path = Path(evidence["path"])
        if not evidence_path.is_absolute():
            evidence_path = events_path.parent / evidence_path
        evidence_hash = source.sha_file(evidence_path)
        require(evidence_hash == evidence["sha256"], "history evidence hash mismatch")
        require(evidence_path not in tracked or tracked[evidence_path] == evidence_hash, "conflicting evidence binding")
        tracked[evidence_path] = evidence_hash
        pointers = evidence.get("input_pointers")
        require(isinstance(pointers, dict) and set(pointers) == set(binding), "incomplete evidence input pointers")
        document = source.read_json(evidence_path)
        require(all(_pointer(document, pointers[k]) == binding[k] for k in binding),
                "evidence does not bind the declared source input")
        # A new ID, path alias, or equivalent row/group scope cannot duplicate an event.
        fingerprint = (event["purpose"], when.timestamp(), tuple(sorted(groups)), evidence_hash)
        require(fingerprint not in fingerprints, "duplicate history event content")
        fingerprints.add(fingerprint)
        purposes[event["purpose"]] += 1
        evidence_hashes.add(evidence_hash)
        if event["purpose"] in DEVELOPMENT_PURPOSES:
            exposed.update(groups)
    require(all(source.sha_file(path) == digest for path, digest in tracked.items()),
            "history audit inputs changed during validation")

    def summarize(subset):
        groups = {r["source_group_id"] for r in subset}
        count = sum(r["source_group_id"] in exposed for r in subset)
        return {"rows": len(subset), "source_groups": len(groups), "development_exposed": count,
                "history_unverified": len(subset) - count,
                "development_exposed_source_groups": len(groups & exposed),
                "history_unverified_source_groups": len(groups - exposed)}

    return {"schema_version": SCHEMA, "status": "blocked" if intended_use == "independent_test" else "verified",
            "intended_use": intended_use, "independent_test_eligible": False,
            "counts": summarize(candidates),
            "splits": {split: summarize([r for r in candidates if r["split"] == split]) for split in source.SPLITS},
            "source_admitted_rows": dict(Counter(r["split"] for r in rows if r["admitted"])),
            "verified_events": len(event_ids), "events_by_purpose": dict(sorted(purposes.items())),
            "input_sha256": hashes, "source_manifest_sha256": manifest["source_manifest_sha256"],
            "evidence_sha256": sorted(evidence_hashes), "history_completeness_verified": False,
            "admission_rules_recomputed": True, "source_ledger_reconstructed": True,
            "original_export_lines_verified": True,
            "inputs_unchanged": True, "source_text_modified": False, "source_split_moved": False,
            "raw_content_or_row_ids_exported": False, "model_executed": False, "model_training_authorized": False,
            "limitations": ["Missing events are not evidence of unused data; local history is not independently attested.",
                            "Recorded development use propagates to the whole original source group.",
                            "This audit does not establish purpose suitability, label accuracy, or human-review completion."]}


def write_report(output, report):
    """Publish one aggregate report atomically, without overwriting any path."""
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), "history report output already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".evaluation-history-", dir=output.parent) as temporary:
        staging = Path(temporary) / "report.json"
        source.dump_json(staging, report)
        os.link(staging, output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("export-manifest", "source-ledger", "events", "output", "release", "admission-policy",
                 "selection-audit", "tokenizer-audit", "row-lengths"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--token-policy", type=Path)
    parser.add_argument("--token-ledger", type=Path)
    parser.add_argument("--intended-use", choices=INTENDED_USES, required=True)
    args = parser.parse_args()
    try:
        require(not args.output.exists() and not args.output.is_symlink(), "history report output already exists")
        report = audit_history(args.export_manifest, args.source_ledger, args.events,
                               intended_use=args.intended_use, release=args.release, admission_policy=args.admission_policy,
                               selection_audit=args.selection_audit, tokenizer_audit=args.tokenizer_audit,
                               row_lengths=args.row_lengths, token_policy=args.token_policy, token_ledger=args.token_ledger)
        write_report(args.output, report)
    except (ValueError, OSError, TypeError, KeyError, AttributeError, IndexError):
        # Input filenames and parser errors need not be safe for public logs.
        print(json.dumps({"schema_version": SCHEMA, "status": "invalid", "reason": "history input validation failed"}))
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 2 if report["status"] == "blocked" else 0


if __name__ == "__main__":
    raise SystemExit(main())
