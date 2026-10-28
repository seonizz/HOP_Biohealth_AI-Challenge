#!/usr/bin/env python3
"""Offline independent numeric audit for the pinned text-only training course.

Does not import the exporter, AutoTokenizer, or its encoding adapter. It renders
the supported text-only template independently and re-encodes every row using
the pinned Rust tokenizer. Reports contain counts and hashes, never source text.
"""
import argparse
from collections import Counter
from concurrent.futures import ProcessPoolExecutor, as_completed
from fractions import Fraction
import gzip
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import re
import struct
import sys
import time

import staged_dataset


PINS = {
    "tokenizer.json": "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f",
    "tokenizer_config.json": "239e1a284bd1e75f2d968b11ea148aab984f753fcb437c4deef8c7ee9e5e6a6a",
    "chat_template.jinja": "845f1ee48e39fc942fe190da9df6a1c5db229e17a96ea08966ad1c9274e73d1b",
}
CONTROL = re.compile(r"<\||\|>|<bos>|<eos>|<pad>|<unk>|<mask>")
GENERATION = "<|turn>model\n<|channel>thought\n<channel|>"
END = "<turn|>\n"
_TOKENIZER = None
_TEMPLATE = None
_SPECIAL = None


def render_text_only(messages):
    """Deliberately narrow independent renderer; reject unsupported branches."""
    if not isinstance(messages, list) or len(messages) < 2:
        raise ValueError("Invalid message list")
    roles = []
    rendered = []
    for position, message in enumerate(messages):
        if not isinstance(message, dict) or set(message) - {"role", "content", "message_id"}:
            raise ValueError("Unsupported message fields")
        role, content = message.get("role"), message.get("content")
        if role not in ("system", "user", "assistant") or (role == "system" and position):
            raise ValueError("Unsupported role")
        if not isinstance(content, str) or not content.strip() or CONTROL.search(content):
            raise ValueError("Empty text or template control syntax")
        if _SPECIAL and any(token in content for token in _SPECIAL):
            raise ValueError("Special token in source text")
        roles.append(role)
        rendered.append("<|turn>" + ("model" if role == "assistant" else role)
                        + "\n" + content.strip() + END)
    dialogue = roles[1:] if roles[0] == "system" else roles
    if dialogue[-2:] != ["user", "assistant"] or any(a == b for a, b in zip(dialogue, dialogue[1:])):
        raise ValueError("Non-alternating text dialogue")
    base = "<bos>" + "".join(rendered[:-1])
    prefix = base + GENERATION
    target = messages[-1]["content"].strip() + END
    native = "<bos>" + "".join(rendered)
    return prefix, target, native


def initialize(tokenizer_dir):
    global _TOKENIZER, _TEMPLATE, _SPECIAL
    # Imports are delayed so lightweight renderer tests need no ML dependencies.
    from tokenizers import Tokenizer
    from jinja2.sandbox import ImmutableSandboxedEnvironment
    directory = Path(tokenizer_dir)
    for name, expected in PINS.items():
        if staged_dataset.digest(directory / name) != expected:
            raise ValueError("Unrecognized pinned tokenizer artifact: " + name)
    _TOKENIZER = Tokenizer.from_file(str(directory / "tokenizer.json"))
    _TOKENIZER.no_truncation()
    _TOKENIZER.no_padding()
    config = json.loads((directory / "tokenizer_config.json").read_text())
    if config["bos_token"] != "<bos>" or _TOKENIZER.get_vocab_size() != staged_dataset.VOCAB_SIZE:
        raise ValueError("Tokenizer vocabulary/BOS contract changed")
    raw = json.loads((directory / "tokenizer.json").read_text())
    _SPECIAL = {item["content"] for item in raw["added_tokens"] if item["special"]}
    _TEMPLATE = ImmutableSandboxedEnvironment().from_string(
        (directory / "chat_template.jinja").read_text())


def native_equivalence(messages, prefix, native):
    options = {"bos_token": "<bos>", "enable_thinking": False}
    return (
        _TEMPLATE.render(messages=messages[:-1], add_generation_prompt=True, **options) == prefix
        and _TEMPLATE.render(messages=messages, add_generation_prompt=False, **options) == native
    )


def check_encoded(messages, index, loaded):
    """Return numerical defects without quoting source content."""
    prefix, target, native = render_text_only(messages)
    full = prefix + target
    expected = _TOKENIZER.encode(full, add_special_tokens=False).ids
    prefix_ids = _TOKENIZER.encode(prefix, add_special_tokens=False).ids
    boundary = len(prefix_ids)
    observed = loaded["encoded"]
    defects = []
    checks = {
        "token_ids": expected == observed["input_ids"],
        "prefix_stability": expected[:boundary] == prefix_ids,
        "prefix_length": boundary == index["prefix_length"],
        "target_length": len(expected) - boundary == index["target_length"],
        "sequence_length": len(expected) == index["sequence_length"],
        "loss_labels": observed["labels"] == [-100] * boundary + expected[boundary:],
        "attention": observed["attention_mask"] == [1] * len(expected),
        "roundtrip_full": _TOKENIZER.decode(expected, skip_special_tokens=False) == full,
        "roundtrip_target": _TOKENIZER.decode(expected[boundary:], skip_special_tokens=False) == target,
        "nonempty_target": 0 < boundary < len(expected),
        "boundary_trim_flag": index.get("target_boundary_whitespace_trimmed") is
                              (messages[-1]["content"] != messages[-1]["content"].strip()),
        "no_unknown_or_padding": not ({_TOKENIZER.token_to_id("<unk>"),
                                        _TOKENIZER.token_to_id("<pad>")} & set(expected)),
    }
    for name, passed in checks.items():
        if not passed:
            defects.append(name)
    return defects, (prefix, native), expected


def audit_partition(job):
    root, phase, split, shard, shards = job
    root = Path(root)
    config = phase["data"][split]
    loader = staged_dataset.IndexedDataset(root / config["index"], root / config["tokens"])
    counts = Counter()
    lengths = []
    failures = []
    weighted = Fraction(0)
    weights = []
    checksums = hashlib.sha256()
    template_positions = {0, len(loader) // 2, len(loader) - 1,
                          max(range(len(loader)), key=lambda i: loader._entries[i]["sequence_length"])}
    with gzip.open(root / config["messages"], "rt", encoding="utf-8") as handle:
        for position, line in enumerate(handle):
            if position % shards != shard:
                continue
            row = json.loads(line)
            index = loader._entries[position]
            loaded = loader[position]
            try:
                defects, (prefix, native), ids = check_encoded(row["messages"], index, loaded)
                if position in template_positions:
                    counts["native_template_parity_rows"] += 1
                    if not native_equivalence(row["messages"], prefix, native):
                        defects.append("native_template_parity")
                # Explicit little-endian reserialization also checks byte order.
                checksums.update(struct.pack("<" + "I" * len(ids), *ids))
                if loaded["row_id"] != row["row_id"] or loaded["weight"] != row["weight"]:
                    defects.append("loader_identity_or_weight")
            except (ValueError, KeyError, TypeError) as error:
                defects = ["unsupported_source:" + type(error).__name__]
            for defect in defects:
                counts["error:" + defect] += 1
            if defects and len(failures) < 10:
                failures.append({"row_id_sha256": hashlib.sha256(row["row_id"].encode()).hexdigest(),
                                 "defects": defects})
            counts["rows"] += 1
            counts["sequence_tokens"] += index["sequence_length"]
            counts["target_tokens"] += index["target_length"]
            counts["rows_over_4096"] += index["sequence_length"] > 4096
            counts["target_boundary_trimmed_rows"] += row["messages"][-1]["content"] != row["messages"][-1]["content"].strip()
            counts["trimmed_message_occurrences"] += sum(m["content"] != m["content"].strip() for m in row["messages"])
            counts["message_occurrences"] += len(row["messages"])
            counts["first_assistant_rows"] += next(m["role"] for m in row["messages"] if m["role"] != "system") == "assistant"
            lengths.append(index["sequence_length"])
            weight = Fraction(**row["weight"])
            weights.append(weight)
            weighted += weight * index["target_length"]
    return {"phase": phase["id"], "split": split, "shard": shard, "counts": dict(counts),
            "failures": failures, "max_sequence_length": max(lengths),
            "weighted_target_mass": str(weighted), "min_weight": str(min(weights)),
            "max_weight": str(max(weights)), "reencoded_shard_sha256": checksums.hexdigest()}


def run(root, output, workers=4):
    started = time.monotonic()
    root, output = root.resolve(strict=True), output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if output == root or root in output.parents:
        raise ValueError("Keep the original immutable bundle separate from audit output")
    before = staged_dataset.digest(root / "DATASET_MANIFEST.json")
    structural = staged_dataset.verify(root)
    if not structural["original_provenance_bound"]:
        raise ValueError("Strict numeric audit requires original provenance ledgers")
    course = json.loads((root / "COURSE.json").read_text())
    jobs = []
    for phase in course["phases"] + course["optional_auxiliary"]:
        for split in staged_dataset.SPLITS:
            shards = workers if phase["id"] == "01_original" else 1
            jobs.extend((str(root), phase, split, shard, shards) for shard in range(shards))
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    results = []
    with ProcessPoolExecutor(max_workers=workers, mp_context=multiprocessing.get_context("spawn"),
                             initializer=initialize, initargs=(str(root / "tokenizer"),)) as pool:
        futures = [pool.submit(audit_partition, job) for job in jobs]
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            name = f"{result['phase']}-{result['split']}-{result['shard']}.json"
            (output / name).write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    # A concurrent change anywhere in the pinned payload invalidates this audit.
    after = staged_dataset.verify(root)
    if staged_dataset.digest(root / "DATASET_MANIFEST.json") != before or structural != after:
        raise ValueError("Bundle changed during audit")
    totals = Counter()
    for item in results:
        totals.update(item["counts"])
    expected_rows = sum(p["counts"][s] for p in structural["phases"].values() for s in staged_dataset.SPLITS)
    if totals["rows"] != expected_rows:
        raise ValueError("Numeric audit did not cover every row")
    report = {
        "schema": "malssi-independent-numeric-audit-v1",
        "status": "failed" if any(k.startswith("error:") and v for k, v in totals.items()) else "passed",
        "scope": "all bundled rows, independently rendered and retokenized; no model training",
        "bundle_manifest_sha256": before, "auditor_sha256": staged_dataset.digest(Path(__file__)),
        "loader_sha256": staged_dataset.digest(Path(staged_dataset.__file__)),
        "tokenizer_pins": PINS, "counts": dict(totals),
        "partitions": sorted(results, key=lambda r: (r["phase"], r["split"], r["shard"])),
        "structural_verification": structural, "elapsed_seconds": round(time.monotonic() - started, 3),
        "gpu_used": False, "model_loaded": False, "exporter_imported": False,
        "limitations": ["Pinned tokenizer engine is shared; serialization and IO audit are independent.",
                        "Native Jinja rendering is cross-checked on boundary/longest rows per partition; the narrow renderer covers every row.",
                        "No evidence of model quality, clinical label validity, or optimizer/checkpoint continuity."]}
    (output / "NUMERIC_AUDIT.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"status": report["status"], "counts": report["counts"], "output": str(output)}, ensure_ascii=False))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workers", type=int, choices=range(1, 5), default=4)
    args = parser.parse_args()
    report = run(args.root, args.output, args.workers)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
