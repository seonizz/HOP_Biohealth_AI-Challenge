#!/usr/bin/env python3
"""Offline, bounded-process audit of Gemma 4 source-SFT token boundaries.

Writes lengths and bounded representative examples; never trains or loads model
weights. A JSON quarantine policy accepts source_group_ids (or the explicitly
named quarantined_source_group_ids) and filters GPU representatives only.
"""

import argparse
from collections import Counter, defaultdict, deque
from concurrent.futures import ProcessPoolExecutor
import gzip
import hashlib
import importlib.metadata
import json
import math
import multiprocessing
import os
from pathlib import Path
import platform
import sys
import time

try:
    import gemma4_token_validation as adapter
except ImportError:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from counseling_pipeline import gemma4_token_validation as adapter

encode_example = adapter.encode_example
collate_examples = adapter.collate_examples
TokenValidationError = adapter.TokenValidationError


CAPS = (512, 1024, 2048, 4096, 8192, 16384, 32768)
PROBE_CAPS = (256, 512, 1024, 2048, 4096, 8192, 16384)
SPLITS = ("train", "validation")
TOKENIZER = None
QUARANTINED = set()


def require(value, message):
    if not value:
        raise ValueError(message)


def sha_file(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def dump(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def verify_inputs(data_dir):
    """Verify compressed bytes and decompressed row counts before processing."""
    manifest_path = data_dir / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = manifest.get("files")
    require(isinstance(files, dict), "Missing manifest files")
    results = {}
    for split in SPLITS:
        key = f"conversation/{split}.jsonl.gz"
        declaration = files.get(key)
        require(isinstance(declaration, dict), "Missing declaration: " + key)
        path = data_dir / f"{split}.jsonl.gz"
        if not path.is_file():
            path = data_dir / key
        require(path.is_file(), "Missing source data: " + key)
        require(type(declaration.get("rows")) is int and declaration["rows"] >= 0,
                "Invalid declared row count: " + key)
        require(type(declaration.get("bytes")) is int and path.stat().st_size == declaration["bytes"],
                "Compressed size mismatch: " + key)
        actual_sha = sha_file(path)
        require(actual_sha == declaration.get("sha256"), "SHA-256 mismatch: " + key)
        count = 0
        with gzip.open(path, "rt", encoding="utf-8") as stream:
            for line in stream:
                require(bool(line.strip()), "Blank source JSONL row: " + key)
                count += 1
        require(count == declaration["rows"], "Declared row count mismatch: " + key)
        results[split] = {"path": str(path.resolve()), "manifest_key": key,
                          "rows": count, "sha256": actual_sha, "bytes": path.stat().st_size}
    return results, sha_file(manifest_path)


def read_quarantine(path):
    if path is None:
        return set()
    policy = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(policy, dict):
        keys = [k for k in ("source_group_ids", "quarantined_source_group_ids", "quarantined_source_groups") if k in policy]
        require(bool(keys), "Quarantine policy needs explicit quarantined source groups")
        values = []
        for key in keys:
            require(isinstance(policy[key], list), "Quarantine group IDs must be a list")
            values.extend(policy[key])
    else:
        values = policy
    require(isinstance(values, list) and all(isinstance(x, str) and x.strip() for x in values),
            "Invalid quarantine group IDs")
    return set(values)


def worker_init(model_dir, quarantined):
    global TOKENIZER, QUARANTINED
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    from transformers import AutoTokenizer
    TOKENIZER = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, use_fast=True)
    require(getattr(TOKENIZER, "is_fast", False), "A local fast tokenizer is required")
    require(type(TOKENIZER.pad_token_id) is int, "Tokenizer has no pad token ID")
    QUARANTINED = set(quarantined)


def better(candidate, previous):
    """Prefer longest admitted input, then lexicographically smallest row ID."""
    return previous is None or (-candidate["sequence_length"], candidate["id"]) < (
        -previous["sequence_length"], previous["id"])


def prepare_prefix_family(rows, tokenizer):
    """Prove reuse against one native rendering, or return a fallback reason.

    The pinned template is linear only for alternating plain-text turns. Strict
    message-dictionary prefix equality also checks optional message identities.
    Character boundaries come from that proven composition, never text search.
    """
    try:
        require(bool(rows), "empty_family")
        longest = max(rows, key=lambda row: len(row["messages"]))
        messages = adapter._check_messages(longest, tokenizer)
        roles = [m["role"] for m in messages if m["role"] != "system"]
        require(all(left != right for left, right in zip(roles, roles[1:])), "nonalternating_roles")
        bos = getattr(tokenizer, "bos_token", None)
        require(isinstance(bos, str) and bool(bos), "missing_bos_token")
        for row in rows:
            require(all(row[key] == longest[key] for key in
                        ("source_conversation_id", "source_group_id", "split")), "mixed_source_family")
            current = row["messages"]
            require(current == messages[:len(current)], "message_prefix_mismatch")
            require(len(current) >= 2 and current[-1]["role"] == "assistant"
                    and current[-2]["role"] == "user", "invalid_target_role")
            if "loss_message_mask" in row:
                mask = row["loss_message_mask"]
                require(isinstance(mask, list) and all(type(x) is int for x in mask)
                        and mask == [0] * (len(current) - 1) + [1], "invalid_target_mask")
        serialized = adapter.serialize_example(longest, tokenizer)
        parts, boundaries = [bos], [len(bos)]
        for message in messages:
            role = "model" if message["role"] == "assistant" else message["role"]
            part = f"<|turn>{role}\n" + message["content"].strip() + adapter.TURN_END
            parts.append(part)
            boundaries.append(boundaries[-1] + len(part))
        require("".join(parts) == serialized["native_full_text"], "native_linear_composition_mismatch")
        return {"native_full": serialized["native_full_text"], "boundaries": boundaries,
                "template_sha256": serialized["template_sha256"], "checked_row_id": longest["id"]}, None
    except (ValueError, KeyError, TypeError) as error:
        return None, str(error)


def encode_family_row(row, tokenizer, family):
    count = len(row["messages"])
    base_end, full_end = family["boundaries"][count - 1:count + 1]
    native_full = family["native_full"][:full_end]
    native_base = native_full[:base_end]
    completion = native_full[base_end + len(adapter.MODEL_HEADER):]
    target = row["messages"][-1]["content"]
    adapter._require(native_full[base_end:base_end + len(adapter.MODEL_HEADER)] == adapter.MODEL_HEADER
                     and completion == target.strip() + adapter.TURN_END, "Cached target boundary changed")
    prefix = native_base + adapter.MODEL_HEADER + adapter.EMPTY_THOUGHT
    full = prefix + completion
    ids, prefix_ids = adapter._token_ids(tokenizer, full), adapter._token_ids(tokenizer, prefix)
    boundary = len(prefix_ids)
    adapter._require(ids[:boundary] == prefix_ids, "Token prefix mismatch; boundary must not be guessed")
    adapter._require(0 < boundary < len(ids), "Empty prefix or zero supervised target tokens")
    return {"input_ids": ids, "labels": [-100] * boundary + ids[boundary:],
            "attention_mask": [1] * len(ids), "prefix_length": boundary,
            "target_length": len(ids) - boundary, "sequence_length": len(ids),
            "raw_template_prefix_match": native_full.startswith(prefix),
            "canonicalization_applied": full != native_full,
            "target_boundary_whitespace_trimmed": target != target.strip(),
            "template_sha256": family["template_sha256"]}


def verify_collation(encoded_rows):
    batch = collate_examples(encoded_rows, TOKENIZER.pad_token_id,
                             max(r["sequence_length"] for r in encoded_rows))
    for i, encoded in enumerate(encoded_rows):
        size, prefix = encoded["sequence_length"], encoded["prefix_length"]
        require(batch["input_ids"][i][:size] == encoded["input_ids"], "Collator changed input")
        require(batch["labels"][i][:size] == encoded["labels"], "Collator changed labels")
        require(all(x == -100 for x in batch["labels"][i][:prefix]), "Prefix label leakage")
        require(all(x == -100 for x in batch["labels"][i][size:]), "Padding label leakage")
        require(batch["attention_mask"][i] == [1] * size + [0] * (len(batch["input_ids"][i]) - size),
                "Collator attention changed")


def process_chunk(rows, prefix_family_cache=False):
    records, encoded_rows, candidates = [], [], {}
    family, fallback = prepare_prefix_family(rows, TOKENIZER) if prefix_family_cache else (None, None)
    for row in rows:
        record = {key: row[key] for key in ("id", "source_conversation_id", "source_group_id", "split")}
        record["generation_prefix_message_count"] = len(row["messages"]) - 1
        first = next((m for m in row["messages"] if m.get("role") != "system"), {})
        record["starts_with_assistant"] = first.get("role") == "assistant"
        record["serialization_path"] = "verified_prefix_family" if family else "native_per_row"
        record["native_family_checked"] = bool(family and row["id"] == family["checked_row_id"])
        if fallback is not None:
            record["family_cache_fallback_reason"] = fallback
        try:
            encoded = encode_family_row(row, TOKENIZER, family) if family else encode_example(row, TOKENIZER)
        except TokenValidationError as error:
            record.update(status="held", error_type=type(error).__name__, error=str(error))
        except Exception as error:
            record.update(status="runtime_error", error_type=type(error).__name__, error=str(error))
        else:
            record.update(status="encoded", **{key: encoded[key] for key in (
                "sequence_length", "prefix_length", "target_length", "raw_template_prefix_match",
                "canonicalization_applied", "target_boundary_whitespace_trimmed", "template_sha256")})
            encoded_rows.append(encoded)
            if len(encoded_rows) == 16:
                verify_collation(encoded_rows)
                encoded_rows.clear()
            if row["split"] == "train" and row["source_group_id"] not in QUARANTINED:
                for cap in PROBE_CAPS:
                    if encoded["sequence_length"] <= cap and better(record, candidates.get(cap)):
                        candidates[cap] = {**record, "source_row": row, "encoded": encoded}
        records.append(record)
    if encoded_rows:
        verify_collation(encoded_rows)
    return records, candidates


def source_chunks(inputs, chunk_size):
    seen, group_splits, conversation_splits = set(), {}, {}
    chunk = []
    for split in SPLITS:
        count = 0
        with gzip.open(inputs[split]["path"], "rt", encoding="utf-8") as stream:
            for line in stream:
                row = json.loads(line)
                require(isinstance(row, dict), "Source row is not an object")
                for key in ("id", "source_conversation_id", "source_group_id"):
                    require(isinstance(row.get(key), str) and bool(row[key]), "Missing source identity: " + key)
                require(row.get("split") == split, "Source split mismatch")
                require(isinstance(row.get("messages"), list) and bool(row["messages"]), "Missing source messages")
                require(row["id"] not in seen, "Duplicate source row ID")
                seen.add(row["id"])
                for key, mapping in (("source_group_id", group_splits), ("source_conversation_id", conversation_splits)):
                    require(row[key] not in mapping or mapping[row[key]] == split, "Cross-split source identity")
                    mapping[row[key]] = split
                chunk.append(row);count += 1
                if len(chunk) == chunk_size:
                    yield chunk
                    chunk = []
        require(count == inputs[split]["rows"], "Source count changed during processing")
    if chunk:
        yield chunk


def source_families(inputs):
    """Preserve input order and require each conversation to be contiguous."""
    family, seen = [], set()
    for singleton in source_chunks(inputs, 1):
        row = singleton[0]
        identity = row["source_conversation_id"]
        if family and identity != family[0]["source_conversation_id"]:
            seen.add(family[0]["source_conversation_id"])
            yield family
            family = []
        require(identity not in seen, "Source conversation is not contiguous")
        family.append(row)
    if family:
        yield family


def distribution(values):
    if not values:
        return {"count": 0, "sum": 0, "p50": None, "p90": None, "p95": None, "p99": None, "max": None}
    ordered = sorted(values)
    result = {"count": len(values), "sum": sum(values), "max": ordered[-1], "percentile_method": "nearest_rank"}
    for p in (50, 90, 95, 99):
        result[f"p{p}"] = ordered[max(0, math.ceil(p / 100 * len(ordered)) - 1)]
    return result


def summarize(records):
    result = {}
    for split in SPLITS:
        subset = [r for r in records if r["split"] == split]
        good = [r for r in subset if r["status"] == "encoded"]
        groups = defaultdict(lambda: {"rows": 0, "full_tokens": 0, "supervised_tokens": 0})
        for row in good:
            group = groups[row["source_group_id"]]
            group["rows"] += 1;group["full_tokens"] += row["sequence_length"];group["supervised_tokens"] += row["target_length"]
        total_tokens = sum(r["sequence_length"] for r in good)
        for group in groups.values():
            group["row_share"] = group["rows"] / len(good)
            group["full_token_share"] = group["full_tokens"] / total_tokens
        caps = {}
        for cap in CAPS:
            keep = [r for r in good if r["sequence_length"] <= cap]
            caps[str(cap)] = {"admitted_rows": len(keep), "over_cap_rows": len(good) - len(keep),
                              "full_tokens": sum(r["sequence_length"] for r in keep),
                              "prefix_tokens": sum(r["prefix_length"] for r in keep),
                              "supervised_tokens": sum(r["target_length"] for r in keep),
                              "source_groups": len({r["source_group_id"] for r in keep}),
                              "source_conversations": len({r["source_conversation_id"] for r in keep})}
        result[split] = {"processed_rows": len(subset), "statuses": dict(Counter(r["status"] for r in subset)),
                         "full": distribution([r["sequence_length"] for r in good]),
                         "prefix": distribution([r["prefix_length"] for r in good]),
                         "supervised": distribution([r["target_length"] for r in good]),
                         "caps": caps, "groups": dict(sorted(groups.items())),
                         "starts_with_assistant_rows": sum(r["starts_with_assistant"] for r in subset),
                         "starts_with_assistant_encoded": sum(r["starts_with_assistant"] for r in good),
                         "raw_template_prefix_mismatch_rows": sum(not r["raw_template_prefix_match"] for r in good)}
    return result


def run(args):
    started = time.monotonic()
    cache_enabled = getattr(args, "prefix_family_cache", False)
    require(1 <= args.workers <= 16 and 1 <= args.chunk_size <= 16, "Invalid worker/chunk bounds")
    require(args.model_dir.is_dir(), "Local model directory does not exist")
    inputs, manifest_sha = verify_inputs(args.data_dir)
    quarantined = read_quarantine(args.quarantine_policy)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    expected = sum(v["rows"] for v in inputs.values())
    report = {"status": "running", "inputs": inputs, "manifest_sha256": manifest_sha,
              "expected_rows": expected, "workers": args.workers, "chunk_size": args.chunk_size,
              "prefix_family_cache": cache_enabled,
              "max_pending_work_units": min(8, args.workers * 2),
              "family_cache_contract": "Pinned native longest rendering equals linear role composition; all rows are exact message-dictionary prefixes; each row still has two exact tokenizations and full collator checks",
              "adapter_sha256": sha_file(Path(adapter.__file__)),
              "runner_sha256": sha_file(Path(__file__)),
              "network_access": False, "model_weights_loaded": False, "training_run": False,
              "quarantine_scope": "GPU representatives only; aggregate caps include all structurally encoded rows",
              "quarantine_groups": sorted(quarantined), "model_dir": str(args.model_dir.resolve()),
              "python_version": platform.python_version(), "library_versions": {},
              "model_metadata_sha256": {}}
    for name in ("transformers", "tokenizers", "huggingface-hub"):
        try: report["library_versions"][name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError: report["library_versions"][name] = None
    for name in ("chat_template.jinja", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "config.json"):
        path = args.model_dir / name
        if path.is_file(): report["model_metadata_sha256"][name] = sha_file(path)
    if args.quarantine_policy:
        report["quarantine_policy_sha256"] = sha_file(args.quarantine_policy)
    dump(args.output_dir / "audit.json", report)
    records, representatives = [], {}
    lengths_path = args.output_dir / "row_lengths.jsonl.gz"
    next_progress = 500
    try:
        chunks = iter(source_families(inputs) if cache_enabled else source_chunks(inputs, args.chunk_size))
        with gzip.open(lengths_path, "wt", encoding="utf-8") as lengths, ProcessPoolExecutor(
            max_workers=args.workers, mp_context=multiprocessing.get_context("spawn"),
            initializer=worker_init, initargs=(str(args.model_dir.resolve()), sorted(quarantined))) as pool:
            pending = deque()
            for _ in range(min(8, args.workers * 2)):
                chunk = next(chunks, None)
                if chunk is not None: pending.append(pool.submit(process_chunk, chunk, cache_enabled))
            while pending:
                rows, candidates = pending.popleft().result()
                for row in rows: lengths.write(json.dumps(row, ensure_ascii=False) + "\n")
                records.extend(rows)
                for cap, candidate in candidates.items():
                    if better(candidate, representatives.get(cap)): representatives[cap] = candidate
                chunk = next(chunks, None)
                if chunk is not None: pending.append(pool.submit(process_chunk, chunk, cache_enabled))
                if len(records) >= next_progress:
                    print(json.dumps({"event": "progress", "processed_rows": len(records), "expected_rows": expected,
                                      "elapsed_seconds": round(time.monotonic() - started, 2)}), flush=True)
                    next_progress = (len(records) // 500 + 1) * 500
        require(len(records) == expected, "Processed row count differs from verified source count")
        for split in SPLITS:
            require(sum(r["split"] == split for r in records) == inputs[split]["rows"], "Processed split count mismatch")
            require(sha_file(inputs[split]["path"]) == inputs[split]["sha256"], "Source changed during audit")
        for cap, candidate in sorted(representatives.items()):
            dump(args.output_dir / f"probe_cap_{cap}.json", {"requested_cap": cap, "selection": "longest_at_or_below_cap_then_id", **candidate})
        counts = Counter(r["status"] for r in records)
        successful = [r for r in records if r["status"] == "encoded"]
        report.update(status="failed" if counts["runtime_error"] else ("completed_with_holds" if counts["held"] else "passed"),
                      processed_rows=len(records), statuses=dict(counts), all_rows_encoded=counts["encoded"] == expected,
                      errors=dict(Counter((r["error_type"] + ": " + r["error"]) for r in records if r["status"] != "encoded")),
                      splits=summarize(records), probe_caps_saved=sorted(representatives),
                      totals={"full": distribution([r["sequence_length"] for r in successful]),
                              "prefix": distribution([r["prefix_length"] for r in successful]),
                              "supervised": distribution([r["target_length"] for r in successful])},
                      template_sha256s=sorted({r["template_sha256"] for r in records if r["status"] == "encoded"}),
                      native_full_templates_checked=sum(r["native_family_checked"] for r in records),
                      native_per_row_templates_checked=sum(r["serialization_path"] == "native_per_row" for r in successful),
                      exact_token_boundaries_checked=len(successful),
                      serialization_paths=dict(Counter(r["serialization_path"] for r in records)),
                      family_cache_fallback_rows=dict(Counter(r["family_cache_fallback_reason"] for r in records
                                                             if "family_cache_fallback_reason" in r)),
                      elapsed_seconds=round(time.monotonic() - started, 3),
                      row_lengths_sha256=sha_file(lengths_path),
                      privacy_note="Only representative JSON files contain original text/tokens; stdout and lengths omit text.")
    except Exception as error:
        report.update(status="failed", processed_rows=len(records), error_type=type(error).__name__, error=str(error),
                      elapsed_seconds=round(time.monotonic() - started, 3))
        dump(args.output_dir / "audit.json", report)
        raise
    dump(args.output_dir / "audit.json", report)
    print(json.dumps({"event": "complete", "status": report["status"], "processed_rows": len(records),
                      "statuses": report["statuses"], "elapsed_seconds": report["elapsed_seconds"]}), flush=True)
    return 1 if report["status"] == "failed" else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--chunk-size", type=int, default=8)
    parser.add_argument("--quarantine-policy", type=Path)
    parser.add_argument("--prefix-family-cache", action="store_true",
                        help="Reuse serialization only after a native-template proof for each contiguous conversation")
    args = parser.parse_args()
    try:
        return run(args)
    except Exception as error:
        print(json.dumps({"event": "error", "error_type": type(error).__name__, "error": str(error)}), flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
