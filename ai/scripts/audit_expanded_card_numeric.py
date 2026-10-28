#!/usr/bin/env python3
"""Compare all warmup bytes to 31B sources; independently re-encode all cards."""
import argparse
from collections import Counter
from pathlib import Path
import json

import audit_staged_numeric as independent
import role_dataset as data


def numeric_inputs(root, course):
    names = {"COURSE.json"}
    names.update("tokenizer/" + name for name in independent.PINS)
    for phase in course["phases"]:
        for part in phase["data"].values():
            names.update(part[key] for key in ("path", "token_index", "token_binary"))
    return {name: data.file_hash(data.safe_path(root, name)) for name in sorted(names)}


def audit(root, source):
    # Structural gates are shared; the numerical renderer/encoder below remains
    # separate from the exporter's AutoTokenizer/serialization implementation.
    from expanded_card_dataset import verify
    verify(root, require_numeric=False)
    course = json.loads((root / "COURSE.json").read_text())
    source_course = json.loads((source / "COURSE.json").read_text())
    source_manifest = json.loads((source / "DATASET_MANIFEST.json").read_text())
    binding = json.loads((root / "provenance/SOURCE.json").read_text())
    data.require(data.file_hash(source / "DATASET_MANIFEST.json") == binding["staged_manifest_sha256"], "Original 31B source manifest changed")
    original_phase = next(p for p in source_course["phases"] if p["id"] == "01_original")
    counts = Counter()
    warmup = course["phases"][0]
    for split, part in warmup["data"].items():
        source_part = original_phase["data"][split]
        for key in ("index", "tokens"):
            name = source_part[key]
            data.require(data.file_hash(source / name) == source_manifest["files"][name]["sha256"], "Original 31B source file changed")
        original = {r["row_id"]: r for r in data.read_rows(source / source_part["index"])}
        seen = 0
        with (source / source_part["tokens"]).open("rb") as previous, (root / part["token_binary"]).open("rb") as current:
            for row in data.read_rows(root / part["token_index"]):
                prior = original[row["row_id"]]
                for field in ("messages_sha256", "prefix_length", "target_length", "sequence_length", "target_sha256", "target_boundary_whitespace_trimmed"):
                    data.require(row[field] == prior[field], "Original source identity/boundary mismatch")
                previous.seek(4 * prior["offset_tokens"])
                current.seek(4 * row["offset_tokens"])
                length = 4 * row["sequence_length"]
                first, second = previous.read(length), current.read(length)
                data.require(len(first) == len(second) == length and first == second, "Original 31B token bytes differ")
                counts["original_rows"] += 1
                counts["original_tokens"] += row["sequence_length"]
                seen += 1
        data.require(seen == part["rows"] and seen > 0, "Incomplete original numeric coverage")
    independent.initialize(root / "tokenizer")
    for phase in course["phases"][1:]:
        for part in phase["data"].values():
            loader = data.IndexedTokens(root / part["token_index"], root / part["token_binary"])
            seen = 0
            for position, row in enumerate(data.read_rows(root / part["path"])):
                loaded = loader[position]
                data.require(loaded["row_id"] == row["row_id"], "Card row order differs")
                failures, (prefix, native), ids = independent.check_encoded(row["messages"], loaded, loaded)
                data.require(not failures and independent.native_equivalence(row["messages"], prefix, native),
                             "Independent card token/mask/template mismatch: " + str(failures))
                counts["card_rows"] += 1
                counts["card_tokens"] += len(ids)
                seen += 1
            data.require(seen == len(loader) == part["rows"] and seen > 0, "Incomplete card numeric coverage")
    return {"status": "passed", "counts": dict(counts), "mismatches": 0,
            "original_method": "every selected token byte and target boundary compared to the frozen original 31B export",
            "card_method": "every row independently rendered and Rust re-encoded; native Jinja template parity, labels and roundtrip checked",
            "source_manifest_sha256": data.file_hash(source / "DATASET_MANIFEST.json"),
            "audited_files": numeric_inputs(root, course),
            "audit_script_sha256": data.file_hash(Path(__file__)), "gpu_used": False, "model_weights_loaded": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(audit(args.root.resolve(), args.source.resolve()), ensure_ascii=False))
