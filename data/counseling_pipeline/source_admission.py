"""Conservative exposure admission ledger; never rewrites the source SFT.

Admission here is only a content-exposure selection, not permission to train,
clinical approval, participant identity inference, or tokenizer verification.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
import gzip
import json
from pathlib import Path

from . import source_sft as source
from .source_selection_audit import block_keys, normalize
import hashlib

SCHEMA = "malssi-source-admission-v1"
LONG_MATCH_CHARACTERS = 200
GROUP_REASON = "quarantined_source_group_context_exposure"
TARGET_REASON = "validation_target_seen_in_train_context"


def identifier(value):
    source.require(isinstance(value, str) and bool(value.strip()), "missing source identifier")
    return value


def block_sources(block, split):
    """Read full inventories, or legacy representatives pending source checks."""
    has_inventory = [name + "_sources" in block for name in source.SPLITS]
    source.require(all(has_inventory) or not any(has_inventory), "partial block source inventory")
    records = block[split + "_sources"] if all(has_inventory) else [block[split]]
    source.require(isinstance(records, list) and bool(records), "empty block source inventory")
    conversations = set()
    for record in records:
        source.require(isinstance(record, dict), "invalid block source record")
        for field in ("row_id", "conversation_id", "group_id"):
            identifier(record.get(field))
        source.require(record["conversation_id"] not in conversations, "duplicate block source conversation")
        conversations.add(record["conversation_id"])
    if all(has_inventory):
        source.require(block.get(split) == records[0], "block display representative disagrees with inventory")
    return records


def rule_sets(audit):
    """Derive declared memberships; build_admission verifies completeness."""
    source.require(audit.get("schema_version") == "malssi-source-selection-audit-v1", "unsupported selection audit")
    overlap = audit["bounded_cross_split_overlap"]
    blocks = overlap["first_8_context_messages_min200chars"]
    source.require(type(blocks["unique_shared_blocks"]) is int and blocks["unique_shared_blocks"] == len(blocks["examples"]),
                   "incomplete first-eight block evidence")
    source.require(blocks.get("source_inventory") in (None, "all_matching_conversations_v1"),
                   "unsupported block source inventory")
    source.require(len({identifier(block["sha256"]) for block in blocks["examples"]}) == len(blocks["examples"]),
                   "duplicate first-eight block evidence")
    groups, ids, origins, evidence = set(), set(), [], []
    for block in blocks["examples"]:
        item = {"rule": "first_8_context_messages_min200chars", "sha256": block["sha256"]}
        for split in source.SPLITS:
            if blocks.get("source_inventory") is not None:
                source.require(split + "_sources" in block, "missing declared full block source inventory")
            records = block_sources(block, split)
            for record in records:
                groups.add(record["group_id"])
                origins.append((split, record))
            item[split + "_sources"] = records
            item[split] = records[0]
        evidence.append(item)
    matches = overlap["whole_normalized_past_assistant_group"]
    source.require(type(matches["unique_validation_targets"]) is int and
                   matches["unique_validation_targets"] == len(matches["matches"]), "incomplete match evidence")
    match_hashes = set()
    for match in matches["matches"]:
        digest = identifier(match["text_sha256"])
        source.require(digest not in match_hashes, "duplicate past-target shared text evidence")
        match_hashes.add(digest)
        size = match["normalized_characters"]
        source.require(type(size) is int and size >= 0, "invalid normalized length")
        for field, identity, message in (
                ("train_sources", "conversation_id", "duplicate past-target train source conversation"),
                ("validation_sources", "row_id", "duplicate past-target validation source row")):
            records = match[field]
            source.require(isinstance(records, list) and bool(records), "empty overlap evidence")
            seen = set()
            for record in records:
                source.require(isinstance(record, dict), "invalid past-target source record")
                key = identifier(record.get(identity))
                source.require(key not in seen, message)
                seen.add(key)
        row_ids = match["validation_row_ids"]
        source.require(len(row_ids) == len(set(row_ids)) and set(row_ids) == {r["row_id"] for r in match["validation_sources"]}, "inconsistent validation match ids")
        source.require(bool(row_ids) and bool(match["train_sources"]), "empty overlap evidence")
        ids.update(identifier(row_id) for row_id in row_ids)
        for split, field in (("train", "train_sources"), ("validation", "validation_sources")):
            for record in match[field]:
                identifier(record["conversation_id"])
                identifier(record["group_id"])
                origins.append((split, record))
                if size >= LONG_MATCH_CHARACTERS:
                    groups.add(record["group_id"])
        if size >= LONG_MATCH_CHARACTERS:
            evidence.append({"rule": "validation_target_matches_train_past_at_least_200_normalized_characters", **match})
    source.require(type(matches["validation_rows"]) is int and matches["validation_rows"] == len(ids), "inconsistent matched row count")
    return groups, ids, origins, evidence


def file_check(release, manifest, relative):
    path = release / relative
    metadata = manifest["files"][relative]
    source.require(type(metadata["rows"]) is int and metadata["rows"] >= 0, "invalid manifest row count")
    source.require(type(metadata["bytes"]) is int and metadata["bytes"] == path.stat().st_size, "manifest file size mismatch")
    source.require(source.sha_file(path) == metadata["sha256"], "manifest file hash mismatch")
    return path


def summary(rows):
    return {split: {"rows": sum(r["split"] == split for r in rows),
                    "source_groups": len({r["source_group_id"] for r in rows if r["split"] == split}),
                    "source_conversations": len({r["source_conversation_id"] for r in rows if r["split"] == split})}
            for split in source.SPLITS}


def build_admission(release, selection_audit, output):
    release, selection_audit, output = map(Path, (release, selection_audit, output))
    manifest_path = release / "manifest.json"
    manifest_sha, audit_sha = source.sha_file(manifest_path), source.sha_file(selection_audit)
    manifest, audit = source.read_json(manifest_path), source.read_json(selection_audit)
    source.require(manifest.get("schema_version") == source.SCHEMA and manifest.get("training_profile") == "observed_counselor_imitation", "unsupported source release")
    source.require(audit["input_manifest_sha256"] == manifest_sha, "selection audit references stale manifest")
    for relative, digest in audit["verified_release_files"].items():
        source.require(manifest["files"].get(relative, {}).get("sha256") == digest, "audit file hash disagrees with manifest")
    groups, held_ids, evidence_origins, evidence = rule_sets(audit)
    policy_path, rows_path = output / "admission_policy.json", output / "admission_rows.jsonl.gz"
    source.require(not policy_path.exists() and not rows_path.exists(), "admission output already exists")
    origins, group_splits, subject_splits, target_ids = {}, {}, {}, {}
    verified = {}
    for split in source.SPLITS:
        relative = f"conversation/source_dialogues.{split}.jsonl.gz"
        path = file_check(release, manifest, relative)
        count = 0
        for row in source.read_rows(path):
            conv, group = identifier(row["source_conversation_id"]), identifier(row["source_group_id"])
            source.require(row["split"] == split and conv not in origins, "source conversation duplicate or split mismatch")
            source.require(group_splits.setdefault(group, split) == split, "source group crosses splits")
            subject = row.get("source_subject_key")
            if subject is not None:
                source.require(subject_splits.setdefault(subject, split) == split, "source subject crosses splits")
            origins[conv] = (split, group)
            target_ids[conv] = {u["utterance_id"] for u in row["utterances"]}
            count += 1
        source.require(count == manifest["files"][relative]["rows"], "source dialogue row count mismatch")
        verified[relative] = manifest["files"][relative]["sha256"]
    past_hashes = defaultdict(set)
    past_origins, validation_origins = defaultdict(set), defaultdict(set)
    fingerprints = {}

    def fingerprint(content):
        # Prefix rows repeat old turns; normalize each distinct raw string once.
        if content not in fingerprints:
            text = normalize(content)
            fingerprints[content] = (len(text), hashlib.sha256(text.encode()).hexdigest())
        return fingerprints[content]

    block_hashes, observed_target_hashes = {}, {}
    observed_blocks = {split: {} for split in source.SPLITS}
    ledger, by_id = [], {}
    for split in source.SPLITS:
        relative = f"conversation/{split}.jsonl.gz"
        path = file_check(release, manifest, relative)
        source.require(audit["verified_release_files"].get(relative) == manifest["files"][relative]["sha256"], "conversation file missing from audit")
        count = 0
        for row in source.read_rows(path):
            row_id, conv, group = (identifier(row[k]) for k in ("id", "source_conversation_id", "source_group_id"))
            source.require(row_id not in by_id, "duplicate SFT row id")
            source.require(row["split"] == split and origins.get(conv) == (split, group), "SFT source origin mismatch")
            source.require(bool(row["target_utterance_ids"]) and set(row["target_utterance_ids"]) <= target_ids[conv], "unknown target source utterance")
            reasons = ([GROUP_REASON] if group in groups else []) + ([TARGET_REASON] if row_id in held_ids else [])
            source.require(row_id not in held_ids or split == "validation", "evaluation hold targets train row")
            item = {"id": row_id, "split": split, "source_conversation_id": conv, "source_group_id": group,
                    "admitted": not reasons, "status": "held" if reasons else "admitted", "reasons": reasons,
                    "token_length_gate_pending": True, "model_training_authorized": False}
            ledger.append(item)
            by_id[row_id] = item
            if split == "train":
                for message in row["messages"][:-1]:
                    if message["role"] == "assistant":
                        digest = fingerprint(message["content"])[1]
                        past_hashes[conv].add(digest)
                        past_origins[digest].add((conv, group))
            else:
                observed_target_hashes[row_id] = fingerprint(row["messages"][-1]["content"])
                validation_origins[observed_target_hashes[row_id][1]].add((row_id, conv, group))
            block_hashes[row_id] = block_keys(row["messages"]).get("first_8_context_messages_min200chars")
            digest = block_hashes[row_id]
            if digest is not None:
                observed_blocks[split].setdefault(digest, set()).add((conv, group))
            count += 1
        source.require(count == manifest["files"][relative]["rows"], "SFT file row count mismatch")
        verified[relative] = manifest["files"][relative]["sha256"]
    source.require(len(ledger) == audit["candidate_counts"]["accepted"], "audit accepted count mismatch")
    source.require(held_ids <= by_id.keys(), "audit references missing validation example")
    source.require(groups <= group_splits.keys(), "audit references missing source group")
    for split, record in evidence_origins:
        source.require(origins.get(record["conversation_id"]) == (split, record["group_id"]), "audit source origin mismatch")
        if "row_id" in record:
            actual = by_id.get(record["row_id"], {})
            source.require((actual.get("split"), actual.get("source_conversation_id"), actual.get("source_group_id")) == (split, record["conversation_id"], record["group_id"]), "audit row origin mismatch")
        if "utterance_ids" in record:
            source.require(bool(record["utterance_ids"]) and set(record["utterance_ids"]) <= target_ids[record["conversation_id"]], "audit unknown source utterance")
    overlap = audit["bounded_cross_split_overlap"]
    actual_shared = set(observed_blocks["train"]) & set(observed_blocks["validation"])
    source.require({block["sha256"] for block in overlap["first_8_context_messages_min200chars"]["examples"]} == actual_shared,
                   "first-eight shared block evidence incomplete")
    for block in overlap["first_8_context_messages_min200chars"]["examples"]:
        for split in source.SPLITS:
            records = block_sources(block, split)
            declared = {(record["conversation_id"], record["group_id"]) for record in records}
            source.require(declared == observed_blocks[split][block["sha256"]],
                           "first-eight source inventory incomplete; legacy representatives require complete source coverage")
            source.require(all(block_hashes.get(record["row_id"]) == block["sha256"] for record in records),
                           "first-eight evidence does not match source rows")
    for match in overlap["whole_normalized_past_assistant_group"]["matches"]:
        source.require(all(observed_target_hashes.get(row_id) == (match["normalized_characters"], match["text_sha256"]) for row_id in match["validation_row_ids"]), "validation target evidence mismatch")
        source.require(all(match["text_sha256"] in past_hashes[r["conversation_id"]] for r in match["train_sources"]), "train past-context evidence mismatch")
    matches = overlap["whole_normalized_past_assistant_group"]["matches"]
    shared_targets = set(past_origins) & set(validation_origins)
    source.require({match["text_sha256"] for match in matches} == shared_targets,
                   "past-target shared text evidence incomplete")
    for match in matches:
        digest = match["text_sha256"]
        declared_train = {(record["conversation_id"], record["group_id"]) for record in match["train_sources"]}
        source.require(declared_train == past_origins[digest], "past-target train source inventory incomplete")
        declared_validation = {(record["row_id"], record["conversation_id"], record["group_id"])
                               for record in match["validation_sources"]}
        source.require(declared_validation == validation_origins[digest], "past-target validation source inventory incomplete")
    source.require(source.sha_file(manifest_path) == manifest_sha and source.sha_file(selection_audit) == audit_sha, "inputs changed during admission build")
    held = [r for r in ledger if not r["admitted"]]
    policy = {"schema_version": SCHEMA, "training_profile": "observed_counselor_imitation",
              "release_directory": str(release.resolve()), "selection_audit_path": str(selection_audit.resolve()),
              "input_manifest_sha256": manifest_sha, "selection_audit_sha256": audit_sha, "verified_release_files": verified,
              "quarantined_source_groups": sorted(groups), "held_validation_example_ids": sorted(held_ids),
              "threshold_normalized_characters": LONG_MATCH_CHARACTERS, "evidence": evidence,
              "first_eight_source_inventory_verified": True,
              "past_target_source_inventory_verified": True,
              "legacy_first_eight_evidence": overlap["first_8_context_messages_min200chars"].get("source_inventory") is None,
              "before": summary(ledger), "after": summary([r for r in ledger if r["admitted"]]), "held": summary(held),
              "counts": {"all_rows": len(ledger), "admitted_rows": len(ledger) - len(held), "held_rows": len(held),
                         "group_quarantine_rows": sum(GROUP_REASON in r["reasons"] for r in held),
                         "validation_target_hold_rows": len(held_ids),
                         "both_hold_reasons_rows": sum(len(r["reasons"]) == 2 for r in held)},
              "token_length_gate_pending": True, "model_training_authorized": False,
              "original_release_modified": False, "source_split_moved": False, "source_text_modified": False,
              "minimum_target_character_rule_changed": False, "clinical_or_human_approval": False,
              "interpretation": "Conservative validation exposure policy; shared text does not establish participant identity. Common 40-199 character phrases only hold matching validation targets, not whole source groups.",
              "limitations": ["Admission is conditional on future real-tokenizer length gating.", "Not a training authorization, deployment approval, source-rights verification, or independent test set.", "Exact normalized block/message exposure checks do not prove absence of semantic or arbitrary-substring overlap."]}
    output.mkdir(parents=True, exist_ok=True)
    with gzip.open(rows_path, "wt", encoding="utf-8") as stream:
        for row in ledger:
            stream.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    policy["files"] = {rows_path.name: {"sha256": source.sha_file(rows_path), "rows": len(ledger), "bytes": rows_path.stat().st_size}}
    source.dump_json(policy_path, policy)
    return policy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", required=True)
    parser.add_argument("--selection-audit", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    result = build_admission(args.release, args.selection_audit, args.output)
    print(json.dumps({"counts": result["counts"], "before": result["before"], "after": result["after"], "quarantined_source_groups": result["quarantined_source_groups"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
