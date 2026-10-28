"""Measure immutable supporter candidates with the original pinned tokenizer.

Writes a separate, source-bound token sidecar. This never changes a release,
truncates text, trains a model, mixes tasks, or grants human approval.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

from . import gemma4_token_validation as adapter
from . import supporter_task_composition as composition
from .annotations import canonical, digest
from .agent_training import require


STREAMS = ("conversation", "sentence", "word", "state_observations", "relationship_memory")
ASSETS = {"chat_template.jinja", "tokenizer.json", "tokenizer_config.json", "config.json"}
COMPONENTS = {"preserved_source_v8", "preserved_supporter_v2", "supporter_v9", "app_stages_v9",
              "supporter_ai_reviews", "app_ai_reviews", "review_binding", "supporter_actual_audit", "app_actual_audit"}


def checked_adapter_row(row, *, is_app=False):
    """Translate only mask shape; retain each original wire content string."""
    require(type(is_app) is bool and isinstance(row, dict), "invalid row kind")
    messages = row.get("messages")
    require(isinstance(messages, list) and len(messages) >= 2, "missing messages")
    expected = [0] * (len(messages) - 1) + [1]
    if is_app:
        require("loss_message_mask" not in row, "conflicting flat app mask")
        mask = row.get("loss_mask")
        require(isinstance(mask, dict) and set(mask) == {"unit", "values", "token_mask_materialized"},
                "unexpected app mask fields")
        require(mask["unit"] == "message" and mask["token_mask_materialized"] is False,
                "app mask is not an unmaterialized message mask")
        values = mask["values"]
    else:
        require("loss_mask" not in row, "conflicting nested supporter mask")
        values = row.get("loss_message_mask")
    require(isinstance(values, list) and all(type(v) is int for v in values)
            and values == expected, "invalid last-target-only integer mask")
    return {"messages": deepcopy(messages), "loss_message_mask": list(values)}


def budget_flags(prefix, target):
    require(type(prefix) is int and type(target) is int and prefix > 0 and target > 0,
            "positive integer token lengths required")
    try:
        composition.check_lengths(prefix, target)
        admitted = True
    except ValueError:
        admitted = False
    return {"runtime_8192": admitted, "strict_4096": admitted and prefix + target <= 4096,
            "prefix_plus_reserved_output": prefix + 8192}


def concentration(values):
    """Shares use token totals per unique group, never number of derived rows."""
    require(isinstance(values, (list, tuple)) and bool(values)
            and all(type(v) is int and v > 0 for v in values), "positive group token totals required")
    ordered = sorted(values, reverse=True)
    count, total = len(ordered), sum(ordered)
    hhi = sum(v * v for v in ordered) / (total * total)
    mean = total / count
    return {"groups": count, "total": total, "top1_share": ordered[0] / total,
            "top5_share": sum(ordered[:5]) / total, "top10_share": sum(ordered[:10]) / total,
            "hhi": hhi, "normalized_hhi": None if count == 1 else max(0.0, (hhi - 1 / count) / (1 - 1 / count)),
            "effective_groups": 1 / hhi,
            "cv": math.sqrt(sum((v - mean) ** 2 for v in ordered) / count) / mean,
            "min": ordered[-1], "max": ordered[0]}


def lengths(values):
    ordered = sorted(values)
    return {"total": sum(values), "min": ordered[0], "p50": ordered[math.ceil(.5 * len(values)) - 1],
            "p95": ordered[math.ceil(.95 * len(values)) - 1], "max": ordered[-1]}


def summarize_subset(rows):
    groups = {field: defaultdict(int) for field in ("prefix_length", "target_length")}
    prefixes = {}
    for row in rows:
        for field in groups:
            groups[field][row["group_id"]] += row[field]
        prefix = row["prefix_ids_sha256"]
        require(prefix not in prefixes or prefixes[prefix] == row["prefix_length"], "inconsistent repeated prefix")
        prefixes[prefix] = row["prefix_length"]
    prefix_total = sum(row["prefix_length"] for row in rows)
    return {
        "rows": len(rows), "groups": len(groups["prefix_length"]),
        "prefix": lengths([r["prefix_length"] for r in rows]),
        "target": lengths([r["target_length"] for r in rows]),
        "sequence": lengths([r["sequence_length"] for r in rows]),
        "input_group_concentration": concentration(list(groups["prefix_length"].values())),
        "target_group_concentration": concentration(list(groups["target_length"].values())),
        "runtime_8192_pass": sum(r["runtime_8192"] for r in rows),
        "strict_4096_pass": sum(r["strict_4096"] for r in rows),
        "unique_exact_prefixes": len(prefixes),
        "repeated_exact_prefix_token_exposure_fraction": (prefix_total - sum(prefixes.values())) / prefix_total,
        "app_1800_target_pass": sum(r["target_length"] <= 1800 for r in rows)
            if rows[0]["stream"] in STREAMS[3:] else None,
    }


def summarize(records):
    require(bool(records), "empty measurement")
    result = {}
    for stream in STREAMS:
        stream_rows = [r for r in records if r["stream"] == stream]
        if not stream_rows:
            continue
        result[stream] = {}
        for cohort in ["all", *sorted({r["cohort"] for r in stream_rows})]:
            cohort_rows = [r for r in stream_rows if cohort == "all" or r["cohort"] == cohort]
            result[stream][cohort] = {}
            for split in ("all", "train", "validation"):
                selected = [r for r in cohort_rows if split == "all" or r["split"] == split]
                if selected:
                    result[stream][cohort][split] = summarize_subset(selected)
    return result


def capture_composition(root):
    root = Path(root)
    index = composition.parse(composition.read(root / "composition-index.json"))
    require(index.get("schema_version") == "malssi-supporter-composition-index-v9"
            and index.get("source_v8_unchanged") is True
            and all(index.get(k) is False for k in ("automatic_cross_task_mixing", "human_approved",
                    "training_authorized", "independent_test_eligible", "new_supporter_token_lengths_verified",
                    "new_app_token_lengths_verified"))
            and canonical(index.get("evaluation_budget")) == canonical(composition.BUDGET),
            "unexpected composition status")
    require(isinstance(index.get("components"), dict) and set(index["components"]) == COMPONENTS,
            "composition component inventory mismatch")
    manifest = composition.parse(composition.read(root / "supporter/manifest.json"))
    expected_paths = {
        "supporter_v9": root / "supporter/manifest.json",
        "app_stages_v9": root / "app_stages_r2/manifest.json",
        "preserved_source_v8": Path(manifest["source_anchors"]["source_v8"]["path"]) / "export_manifest.json",
        "preserved_supporter_v2": Path(manifest["source_anchors"]["supporter_v2"]["path"]) / "manifest.json",
        "supporter_ai_reviews": root / "authored/revision_2/independent_ai_reviews.jsonl",
        "app_ai_reviews": root / "app_authored/independent_ai_reviews_revision3.jsonl",
    }
    for role, entry in index["components"].items():
        require(isinstance(entry, dict) and set(entry) == {"path", "sha256"}, "invalid component reference")
        path = Path(entry["path"])
        if not path.is_absolute():
            path = Path(__file__).resolve().parents[2] / path
        require(role not in expected_paths or path.resolve() == expected_paths[role].resolve(),
                "composition component points outside its declared artifact role")
        require(composition.sha(composition.read(path)) == entry["sha256"], "composition index binding mismatch")
    files = {"composition-index.json"}
    for subdir in ("supporter", "app_stages_r2"):
        directory = root / subdir
        for path in directory.rglob("*"):
            require(not path.is_symlink(), "symlink in input artifact")
            if path.is_file():
                files.add(path.relative_to(root).as_posix())
    return composition.capture(root, files)


def validate_artifacts(root, node):
    rows, manifest = composition.audit(root / "supporter", allow_ai_draft=True)
    script = Path(__file__).resolve().parents[1] / "scripts/supporter_app_stage.mjs"
    command = [node, str(script), "verify", "--input", str(root / "app_authored/contexts.jsonl"),
               "--output", str(root / "app_stages_r2")]
    verified = subprocess.run(command, check=True, capture_output=True, text=True)
    return manifest, {"command": command, "exit_code": verified.returncode,
                      "stdout_sha256": composition.sha(verified.stdout.encode())}


def load_tokenizer(directory, historical):
    from transformers import AutoTokenizer
    old = composition.parse(composition.read(historical))
    require(set(old["model_metadata_sha256"]) == ASSETS, "unexpected historical tokenizer inventory")
    assets = composition.capture(directory, ASSETS)
    require(composition.hashes(assets) == old["model_metadata_sha256"], "tokenizer asset mismatch")
    versions = {name: importlib.metadata.version(name)
                for name in ("transformers", "tokenizers", "huggingface-hub", "jinja2")}
    require(all(versions[name] == version for name, version in old["library_versions"].items()),
            "historical tokenizer package version mismatch")
    tokenizer = AutoTokenizer.from_pretrained(directory, local_files_only=True, use_fast=True, trust_remote_code=False)
    require(tokenizer.is_fast and type(tokenizer.pad_token_id) is int, "fast tokenizer with pad ID required")
    require(adapter._check_template(tokenizer) == old["model_metadata_sha256"]["chat_template.jinja"],
            "loaded template mismatch")
    return tokenizer, {"asset_sha256": composition.hashes(assets), "library_versions": versions,
                       "class": type(tokenizer).__name__, "is_fast": True,
                       "historical_audit_sha256": composition.sha(composition.read(historical)),
                       "chat_template_sha256": adapter.PINNED_TEMPLATE_SHA256}, assets


def measure(root, tokenizer, baseline_ids, blobs):
    records, seen, group_splits, root_splits, batch = [], set(), {}, {}, []
    for name in sorted(blobs):
        is_app = name in {"app_stages_r2/train.jsonl", "app_stages_r2/validation.jsonl"}
        is_supporter = any(name == f"supporter/{s}/{p}.jsonl" for s in STREAMS[:3] for p in ("train", "validation"))
        if not (is_app or is_supporter):
            continue
        file_split = Path(name).stem
        for number, raw in enumerate(blobs[name].split(b"\n"), 1):
            if not raw:
                continue
            row = composition.parse(raw)
            adapted = checked_adapter_row(row, is_app=is_app)
            before = digest(row)
            stream = row["task"] if is_app else row["unit"]
            require(stream in (STREAMS[3:] if is_app else STREAMS[:3]), "invalid task")
            require(row["split"] == file_split, "split/file disagreement")
            for key, mapping in (("source_group_ids", group_splits), ("source_root_ids", root_splits)):
                identifiers = row[key]
                require(isinstance(identifiers, list) and len(identifiers) == 1
                        and isinstance(identifiers[0], str) and bool(identifiers[0]), "one unambiguous group/root required")
                value = identifiers[0]
                require(value not in mapping or mapping[value] == file_split, "cross-split group/root")
                mapping[value] = file_split
            row_id = row["candidate_id"] if is_app else row["row_id"]
            identity = (stream, row_id)
            require(identity not in seen, "duplicate measured identity")
            seen.add(identity)
            encoded = adapter.encode_example(adapted, tokenizer)
            serialized = adapter.serialize_example(adapted, tokenizer)
            require(tokenizer.decode(encoded["input_ids"], skip_special_tokens=False,
                    clean_up_tokenization_spaces=False) == serialized["full_text"], "token roundtrip changed text")
            require(encoded["labels"] == [-100] * encoded["prefix_length"] + encoded["input_ids"][encoded["prefix_length"]:],
                    "target mask changed")
            require(digest(row) == before and adapted["messages"] == row["messages"], "source message mutation")
            lengths_record = {k: encoded[k] for k in ("prefix_length", "target_length", "sequence_length",
                              "raw_template_prefix_match", "canonicalization_applied", "target_boundary_whitespace_trimmed")}
            records.append({"stream": stream, "split": file_split,
                            "cohort": "baseline_v2" if not is_app and row["episode_id"] in baseline_ids else "new_v9",
                            "row_id": row_id, "group_id": row["source_group_ids"][0], "root_id": row["source_root_ids"][0],
                            "source_file": name, "line_number": number,
                            "source_line_sha256": composition.sha(raw + b"\n"), "row_sha256": before,
                            "messages_sha256": digest(row["messages"]),
                            "prefix_ids_sha256": digest(encoded["input_ids"][:encoded["prefix_length"]]),
                            "target_ids_sha256": digest(encoded["input_ids"][encoded["prefix_length"]:]),
                            "full_ids_sha256": digest(encoded["input_ids"]),
                            "source_boundary_whitespace_trimmed_messages": sum(m["content"] != m["content"].strip() for m in row["messages"]),
                            **lengths_record, **budget_flags(encoded["prefix_length"], encoded["target_length"]),
                            "exact_decoded_canonical_roundtrip": True,
                            "last_target_only_labels_verified": True})
            batch.append(encoded)
            if len(batch) == 16:
                check_collation(batch, tokenizer.pad_token_id)
                batch.clear()
    if batch:
        check_collation(batch, tokenizer.pad_token_id)
    return records


def check_collation(encoded, pad_id):
    # Validate collation without clipping, even when reporting an over-budget row.
    result = adapter.collate_examples(encoded, pad_id, max(r["sequence_length"] for r in encoded))
    for index, row in enumerate(encoded):
        n = row["sequence_length"]
        require(result["input_ids"][index][:n] == row["input_ids"], "collation changed tokens")
        require(result["labels"][index][:n] == row["labels"] and all(v == -100 for v in result["labels"][index][n:]),
                "collation leaked padding or changed labels")


def implementation_hashes(root):
    repo = Path(__file__).resolve().parents[2]
    supporter = composition.parse(composition.read(Path(root) / "supporter/manifest.json"))
    app = composition.parse(composition.read(Path(root) / "app_stages_r2/manifest.json"))
    files = {Path(__file__).resolve(), *(repo / name for name in app["dependencies_sha256"])}
    package = Path(__file__).resolve().parent
    for name in supporter["implementation_sha256"]:
        files.add(package.parent / "docs/support_agent/question_bank.json" if name == "question_bank.json" else package / name)
    return {str(path.relative_to(repo)): composition.sha(composition.read(path)) for path in sorted(files)}


def run(root, tokenizer_dir, historical, output, *, node="node"):
    root, tokenizer_dir, output = Path(root).absolute(), Path(tokenizer_dir).absolute(), Path(output).absolute()
    require(not output.exists() and not output.is_symlink(), "output already exists")
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", TOKENIZERS_PARALLELISM="false")
    blobs = capture_composition(root)
    implementation = implementation_hashes(root)
    manifest, app_validation = validate_artifacts(root, node)
    tokenizer, tokenizer_provenance, assets = load_tokenizer(tokenizer_dir, historical)
    records = measure(root, tokenizer, set(manifest["baseline_episode_ids"]), blobs)
    require(composition.hashes(capture_composition(root)) == composition.hashes(blobs), "input changed during tokenization")
    require(composition.capture(tokenizer_dir, ASSETS) == assets, "tokenizer changed during measurement")
    require(implementation_hashes(root) == implementation, "implementation changed during measurement")
    summary = {"schema_version": "malssi-supporter-token-audit-v1", "status": "measured",
               "evaluation_budget": composition.BUDGET,
               "inventory_rows": len(records), "token_budget_eligible_rows": sum(r["runtime_8192"] for r in records),
               "strict_4096_rows": sum(r["strict_4096"] for r in records),
               "all_rows_freshly_encoded": True, "source_files_unchanged": True,
               "no_truncation": True, "model_weights_loaded": False, "training_run": False,
               "human_or_expert_approved": False, "independent_test_eligible": False,
               "automatic_task_mixing": False, "summary": summarize(records),
               "inventory_token_sums_not_a_training_mixture": {
                   cohort: {"rows": len(rows), "input_tokens": sum(r["prefix_length"] for r in rows),
                            "target_tokens": sum(r["target_length"] for r in rows)}
                   for cohort in ("all", "baseline_v2", "new_v9")
                   if (rows := [r for r in records if cohort == "all" or r["cohort"] == cohort])},
               "serialization": {"target_includes_native_turn_termination": True,
                    "native_full_prefix_match_rows": sum(r["raw_template_prefix_match"] for r in records),
                    "explicit_non_thinking_canonicalization_rows": sum(r["canonicalization_applied"] for r in records),
                    "source_boundary_whitespace_trimmed_messages": sum(r["source_boundary_whitespace_trimmed_messages"] for r in records),
                    "decode_and_label_checks_rows": len(records)},
               "limits": ["Dependent views are not independent people or cases.",
                    "Group concentration is per task and split; inventory totals are not an authorized mixture.",
                    "Exact token and byte checks do not establish semantic or clinical validity."]}
    provenance = {"recorded_at": datetime.now(timezone.utc).isoformat(), "tokenizer": tokenizer_provenance,
                  "inputs_sha256": composition.hashes(blobs), "input_root": str(root),
                  "implementation_sha256": implementation,
                  "app_artifact_verification": app_validation, "tokenization_network_access": False,
                  "source_and_split_preserved": True}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".supporter-token-audit-", dir=output.parent))
    try:
        (temporary / "row_lengths.jsonl").write_text("".join(canonical(r) + "\n" for r in records), encoding="utf-8")
        for name, value in (("summary.json", summary), ("provenance.json", provenance)):
            (temporary / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        output_manifest = {"schema_version": "malssi-supporter-token-sidecar-v1", "training_authorized": False,
                           "files": {p.name: {"sha256": composition.sha(p.read_bytes()), "bytes": p.stat().st_size}
                                     for p in sorted(temporary.iterdir())}}
        (temporary / "manifest.json").write_text(json.dumps(output_manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        require(composition.hashes(capture_composition(root)) == composition.hashes(blobs), "input changed before publication")
        require(composition.capture(tokenizer_dir, ASSETS) == assets, "tokenizer changed before publication")
        require(implementation_hashes(root) == implementation, "implementation changed before publication")
        require(not output.exists(), "output appeared during measurement")
        os.rename(temporary, output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--composition", required=True)
    parser.add_argument("--tokenizer", required=True)
    parser.add_argument("--historical-audit", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    summary = run(args.composition, args.tokenizer, args.historical_audit, args.output, node=args.node)
    print(json.dumps({k: summary[k] for k in ("status", "inventory_rows", "token_budget_eligible_rows", "strict_4096_rows",
                                            "inventory_token_sums_not_a_training_mixture")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
