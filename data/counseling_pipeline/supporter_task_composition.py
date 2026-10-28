"""Keep source counseling immutable and compose a separate supporter AI-draft set.

This is an experimental data composition, not human approval or a training run.
All derivations share the episode split. Token admission requires fresh encoding;
source-counseling token lengths cannot be borrowed for new supporter messages.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from . import agent_dataset as dataset
from .annotations import canonical, digest
from .agent_training import require
from . import gemma4_token_validation as adapter


SCHEMA = "malssi-supporter-task-composition-v1"
BUDGET = {"max_input_tokens": 65536, "max_output_tokens": 8192,
          "max_context_tokens": 69632, "effective_max_input_tokens": 61440}
DATA_FILES = {"episodes.jsonl", "reviews.jsonl"} | {
    f"{unit}/{split}.jsonl" for unit in dataset.UNITS for split in dataset.SPLITS}
FILES = DATA_FILES | {"exposure_events.jsonl"}


def sha(blob):
    return hashlib.sha256(blob).hexdigest()


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def parse(blob):
    def invalid(value):
        raise ValueError("non-finite JSON value: " + value)
    return json.loads(blob.decode("utf-8"), object_pairs_hook=_pairs, parse_constant=invalid)


def lines(blob):
    # JSONL is LF-delimited; U+2028/U+2029 inside JSON strings are content.
    return [parse(line) for line in blob.split(b"\n") if line.strip()]


def read(path):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), "missing or symlinked input file")
    return path.read_bytes()


def capture(root, names):
    root = Path(root)
    require(not root.is_symlink(), "artifact root must not be a symlink")
    # The repository's private-storage alias may occur ABOVE the artifact root.
    # Inside a captured artifact no directory or payload may redirect the read.
    root = root.resolve()
    result = {}
    for name in sorted(names):
        path = Path(name)
        require(not path.is_absolute() and ".." not in path.parts and str(path) == name,
                "unsafe manifest path")
        current = root
        for component in path.parts:
            current = current / component
            require(not current.is_symlink(), "symlinked artifact path component")
        result[name] = read(current)
    return result


def hashes(blobs):
    return {name: sha(blob) for name, blob in sorted(blobs.items())}


def baseline_snapshot(root):
    blobs = capture(root, DATA_FILES | {"manifest.json"})
    manifest = parse(blobs["manifest.json"])
    require(set(manifest.get("files", {})) == DATA_FILES, "baseline inventory changed")
    for name in DATA_FILES:
        require(canonical(manifest["files"][name]) == canonical(
            {"sha256": sha(blobs[name]), "rows": len(lines(blobs[name]))}),
                "baseline file binding mismatch")
    episodes, reviews = lines(blobs["episodes.jsonl"]), lines(blobs["reviews.jsonl"])
    dataset.validate_inputs(episodes, reviews)
    rows = dataset.derive_rows(episodes)
    for unit in dataset.UNITS:
        for split in dataset.SPLITS:
            require(canonical(lines(blobs[f"{unit}/{split}.jsonl"])) == canonical(rows[unit][split]),
                    "baseline derivation mismatch")
    require(canonical({k: v for k, v in manifest.items() if k != "files"}) ==
            canonical(dataset._inventory(episodes, rows)), "baseline metadata changed")
    return blobs, episodes, reviews


def source_snapshot(root):
    manifest_blob = read(Path(root) / "export_manifest.json")
    manifest = parse(manifest_blob)
    require(manifest.get("schema_version") == "malssi-source-volume-context-composition-v1"
            and manifest.get("status") == "verified", "expected verified v8 source composition")
    require(manifest.get("source_split_moved") is False
            and manifest.get("training_authorized") is False
            and manifest.get("original_jsonl_lines_preserved") is True,
            "source preservation/status mismatch")
    require(canonical(manifest.get("evaluation_budget")) == canonical(BUDGET), "source budget mismatch")
    names = manifest.get("files")
    require(isinstance(names, dict) and bool(names) and "export_manifest.json" not in names,
            "source inventory missing")
    blobs = capture(root, names)
    for name, blob in blobs.items():
        require(names[name].get("sha256") == sha(blob)
                and type(names[name].get("bytes")) is int and names[name]["bytes"] == len(blob),
                "source file binding mismatch")
    blobs["export_manifest.json"] = manifest_blob
    return blobs


def coverage(episodes):
    result = {}
    for split in dataset.SPLITS:
        selected = [e for e in episodes if e["split"] == split]
        annotations = [a for e in selected for a in e["annotations"]]
        spans = [s for a in annotations for s in a["focus_spans"]]
        result[split] = {
            "episodes": len(selected), "targets": len(annotations),
            "multiturn_episodes": sum(len(e["messages"]) > 2 for e in selected),
            "later_turn_targets": sum(len(e["messages"]) // 2 - 1 for e in selected),
            "relationships": dict(sorted(Counter(e["relationship"] for e in selected).items())),
            "actions": dict(sorted(Counter(a["primary_action"] for a in annotations).items())),
            "span_statuses": dict(sorted(Counter(s["assertion_status"] for s in spans).items())),
            "span_subjects": dict(sorted(Counter(s["subject"] for s in spans).items())),
        }
    return result


def events(episodes):
    return [{"episode_id": e["episode_id"], "episode_sha256": digest(e),
             "source_root_ids": e["source_root_ids"], "source_group_ids": e["source_group_ids"],
             "split": e["split"], "event": "development_authoring_and_ai_review",
             "independent_test_eligible": False} for e in episodes]


def implementation_hashes():
    package = Path(__file__).resolve().parent
    names = ["supporter_task_composition.py", "agent_dataset.py", "agent_training.py",
             "annotations.py", "source_selection_audit.py", "gemma4_token_validation.py"]
    result = {name: sha(read(package / name)) for name in names}
    result["question_bank.json"] = sha(read(package.parent / "docs/support_agent/question_bank.json"))
    return result


def payloads(episodes, reviews):
    for episode in episodes:
        for flag in ("human_approved", "human_or_expert_approved", "expert_approved",
                     "training_authorized", "training_allowed", "production_ready", "independent_test_eligible"):
            require(flag not in episode or episode[flag] is False,
                    "experimental episode contains contradictory approval metadata")
    dataset.validate_inputs(episodes, reviews)
    rows = dataset.derive_rows(episodes)
    records = {"episodes.jsonl": episodes, "reviews.jsonl": reviews,
               "exposure_events.jsonl": events(episodes)}
    for unit in dataset.UNITS:
        for split in dataset.SPLITS:
            require(bool(rows[unit][split]), "all unit/split partitions must be nonempty")
            records[f"{unit}/{split}.jsonl"] = rows[unit][split]
    return rows, {name: ("".join(canonical(r) + "\n" for r in values)).encode("utf-8")
                  for name, values in records.items()}


def inventory(episodes, rows, anchors, baseline_ids):
    return {
        "schema_version": SCHEMA, "status": dataset.STATUS,
        "human_or_expert_approved": False, "production_ready": False,
        "independent_test_eligible": False, "development_exposed": True,
        "tokenizer_validated": False, "token_admitted_rows": 0,
        "token_status": "fresh_encoding_required_for_every_supporter_row",
        "implementation_sha256": implementation_hashes(),
        "evaluation_budget": BUDGET, "source_anchors": anchors,
        "baseline_episode_ids": baseline_ids,
        "episode_count": len(episodes), "added_episode_count": len(episodes) - len(baseline_ids),
        "counts": {u: {s: len(rows[u][s]) for s in dataset.SPLITS} for u in dataset.UNITS},
        "coverage": coverage(episodes),
        "streams": {
            "supporter_conversation": {"role": "task_specific_experimental", "unit": "conversation"},
            "supporter_sentence": {"role": "separate_annotation_task", "unit": "sentence"},
            "supporter_span": {"role": "separate_grounding_task", "unit": "word"},
            "source_counseling_v8": {"role": "preserved_auxiliary_reference", "included_in_supporter_rows": False},
        },
        "sampling": {"automatic_cross_task_concatenation": False,
                     "automatic_upsampling": False,
                     "target_token_mixture_ratio_established": False},
        "app_contract": "supporter_policy_tasks; not the complete relationship_agent wire schema",
        "character_counts": {u: {s: {k: sum(r[k] for r in rows[u][s])
                                     for k in ("input_characters", "target_characters")}
                                for s in dataset.SPLITS} for u in dataset.UNITS},
        "recorded_rows": {r["row_id"]: digest(r) for u in dataset.UNITS for s in dataset.SPLITS for r in rows[u][s]},
    }


def _anchors(baseline, source, old_blobs, source_blobs):
    return {"supporter_v2": {"path": str(Path(baseline).absolute()), "files": hashes(old_blobs)},
            "source_v8": {"path": str(Path(source).absolute()), "files": hashes(source_blobs)}}


def _unchanged(anchors):
    for reference in anchors.values():
        require(hashes(capture(reference["path"], reference["files"])) == reference["files"],
                "preserved source changed since capture")


def build(baseline, source, additions, reviews, output):
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), "output exists; preserve previous releases")
    implementation = implementation_hashes()
    old_blobs, old, old_reviews = baseline_snapshot(baseline)
    source_blobs = source_snapshot(source)
    addition_blob, review_blob = read(additions), read(reviews)
    new, new_reviews = lines(addition_blob), lines(review_blob)
    require(bool(new), "new supporter episodes required")
    dataset.validate_inputs(new, new_reviews)
    episodes, combined_reviews = old + new, old_reviews + new_reviews
    rows, blobs = payloads(episodes, combined_reviews)
    anchors = _anchors(baseline, source, old_blobs, source_blobs)
    manifest = inventory(episodes, rows, anchors, [e["episode_id"] for e in old])
    manifest["files"] = {name: {"sha256": sha(blob), "rows": len(lines(blob)), "bytes": len(blob)}
                         for name, blob in sorted(blobs.items())}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".supporter-task-", dir=output.parent))
    try:
        for name, blob in blobs.items():
            path = temporary / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(blob)
        (temporary / "manifest.json").write_text(canonical(manifest) + "\n", encoding="utf-8")
        audit(temporary, allow_ai_draft=True)
        require(read(additions) == addition_blob and read(reviews) == review_blob, "authored inputs changed during build")
        require(implementation_hashes() == implementation, "implementation changed during build")
        _unchanged(anchors)
        require(not output.exists() and not output.is_symlink(), "output appeared during build")
        os.rename(temporary, output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return manifest


def audit(output, *, allow_ai_draft=False):
    require(allow_ai_draft is True, "explicit allow_ai_draft=True required")
    blobs = capture(output, FILES | {"manifest.json"})
    manifest = parse(blobs["manifest.json"])
    require(set(manifest.get("files", {})) == FILES, "release inventory mismatch")
    for name in FILES:
        require(canonical(manifest["files"][name]) == canonical(
            {"sha256": sha(blobs[name]), "rows": len(lines(blobs[name])), "bytes": len(blobs[name])}),
            "release file binding mismatch")
    episodes, reviews = lines(blobs["episodes.jsonl"]), lines(blobs["reviews.jsonl"])
    rows, rebuilt = payloads(episodes, reviews)
    require(all(blobs[name] == rebuilt[name] for name in FILES), "release derivation or exposure mismatch")
    anchors = manifest.get("source_anchors", {})
    require(set(anchors) == {"supporter_v2", "source_v8"}, "source anchors missing")
    old_blobs, old, old_reviews = baseline_snapshot(anchors["supporter_v2"]["path"])
    source_blobs = source_snapshot(anchors["source_v8"]["path"])
    require(canonical(anchors) == canonical(_anchors(anchors["supporter_v2"]["path"],
            anchors["source_v8"]["path"], old_blobs, source_blobs)), "anchor bytes changed")
    require(canonical(episodes[:len(old)]) == canonical(old)
            and canonical(reviews[:len(old_reviews)]) == canonical(old_reviews),
            "baseline episodes/reviews/order/split changed")
    expected = inventory(episodes, rows, anchors, [e["episode_id"] for e in old])
    require(canonical({k: v for k, v in manifest.items() if k != "files"}) == canonical(expected),
            "release metadata or row binding mismatch")
    return rows, manifest


def check_lengths(prefix, target, *, strict_4096=False):
    require(type(prefix) is int and type(target) is int and prefix > 0 and target > 0,
            "positive integer token lengths required")
    require(type(strict_4096) is bool, "strict_4096 must be boolean")
    require(target <= BUDGET["max_output_tokens"], "target exceeds 8192; truncation refused")
    require(prefix <= BUDGET["max_input_tokens"]
            and prefix + BUDGET["max_output_tokens"] <= BUDGET["max_context_tokens"],
            "prefix plus reserved output exceeds context; truncation refused")
    require(prefix + target <= BUDGET["max_context_tokens"], "sequence exceeds context")
    require(not strict_4096 or prefix + target <= 4096, "sequence exceeds strict 4096")
    return {"prefix_length": prefix, "target_length": target, "sequence_length": prefix + target,
            "prefix_plus_reserved_output": prefix + BUDGET["max_output_tokens"]}


def token_batch(output, unit, split, row_ids, tokenizer, *, allow_ai_draft=False, strict_4096=False):
    """Fresh pinned-template encoding only; never clip or reuse old length tables."""
    rows, manifest = audit(output, allow_ai_draft=allow_ai_draft)
    require(unit in dataset.UNITS and split in dataset.SPLITS, "invalid unit/split; independent test unsupported")
    require(isinstance(row_ids, list) and row_ids and len(set(row_ids)) == len(row_ids), "unique row IDs required")
    available = {r["row_id"]: r for r in rows[unit][split]}
    require(all(rid in available for rid in row_ids), "unknown row or mixed task/split")
    encoded, counts = [], []
    for rid in row_ids:
        row = available[rid]
        require(manifest["recorded_rows"][rid] == digest(row), "stale row binding")
        value = adapter.encode_example(row, tokenizer, max_length=BUDGET["max_context_tokens"])
        counts.append({"row_id": rid, "row_sha256": digest(row),
                       **check_lengths(value["prefix_length"], value["target_length"], strict_4096=strict_4096)})
        encoded.append(value)
    batch = adapter.collate_examples(encoded, tokenizer.pad_token_id,
                                    4096 if strict_4096 else BUDGET["max_context_tokens"])
    return batch, counts


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline")
    parser.add_argument("--source")
    parser.add_argument("--additions")
    parser.add_argument("--reviews")
    parser.add_argument("--output", required=True)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    if args.verify:
        _, manifest = audit(args.output, allow_ai_draft=True)
    else:
        require(all((args.baseline, args.source, args.additions, args.reviews)), "all build inputs required")
        manifest = build(args.baseline, args.source, args.additions, args.reviews, args.output)
    print(json.dumps({k: manifest[k] for k in ("status", "episode_count", "added_episode_count", "counts",
                     "coverage", "tokenizer_validated", "token_admitted_rows")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
