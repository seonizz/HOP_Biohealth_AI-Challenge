"""Read-only, bounded selection and dependence audit of a source SFT release.

Behavior names below are lexical screening tags, not reviewed clinical labels.
Overlap checks use exact normalized messages/blocks, not semantic similarity or
arbitrary substring search. This module never promotes a held training target.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re
import unicodedata

from . import source_sft as source


PATTERNS = {
    "question_like": re.compile(r"[?？]|(?:나요|까요|어때요|신가요|인가요)[.!。]?\s*$|어떻게|어떤|무엇|언제|어디|왜"),
    "support_like": re.compile(r"괜찮|이해|힘드|고생|수고|걱정|천천히|마음|편안|그럴.*있"),
    "ending_like": re.compile(r"(?:여기서|여기까지|상담을|오늘은).*마치|마무리|다음.*뵙|안녕히|수고하셨|(?:오늘|상담).*끝내"),
}


def normalize(text):
    return " ".join(unicodedata.normalize("NFKC", text).split())


def key(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def length_bin(size):
    for bound, label in ((10, "0-9"), (20, "10-19"), (40, "20-39"), (80, "40-79"),
                         (160, "80-159"), (320, "160-319")):
        if size < bound:
            return label
    return "320+"


def stage(ordinal, total_turns):
    fraction = ordinal / max(1, total_turns - 1)
    return "opening_0_10pct" if fraction < .1 else "middle_10_90pct" if fraction < .9 else "ending_90_100pct"


def concentration(values):
    total = sum(values.values())
    shares = [(name, number, number / total) for name, number in values.items()] if total else []
    shares.sort(key=lambda item: (-item[1], item[0]))
    return {"units": len(values), "total": total, "max_share": shares[0][2] if shares else None,
            "hhi": sum(share ** 2 for _, _, share in shares),
            "inverse_hhi_not_independent_sample_size": 1 / sum(s ** 2 for _, _, s in shares) if shares else None,
            "per_unit": [{"id": name, "value": number, "share": share} for name, number, share in shares],
            "top10": [{"id": name, "value": number, "share": share} for name, number, share in shares[:10]]}


def normalized_block(messages):
    return [(m["role"], normalize(m["content"])) for m in messages if m["role"] != "system"]


def block_keys(messages):
    context = normalized_block(messages[:-1])
    out = {}
    if len(context) >= 8:
        recent = context[-8:]
        if sum(len(text) for _, text in recent) >= 200:
            out["recent_8_context_messages_min200chars"] = key(recent)
        initial = context[:8]
        if sum(len(text) for _, text in initial) >= 200:
            out["first_8_context_messages_min200chars"] = key(initial)
    return out


def overlap_graph(matches, threshold):
    adjacency = defaultdict(set)
    row_ids, source_pairs = set(), set()
    for match in matches:
        if match["normalized_characters"] < threshold:
            continue
        for val in match["validation_sources"]:
            row_ids.add(val["row_id"])
            for train in match["train_sources"]:
                a, b = "train:" + train["group_id"], "validation:" + val["group_id"]
                adjacency[a].add(b)
                adjacency[b].add(a)
                source_pairs.add((train["conversation_id"], val["conversation_id"]))
    components, seen = [], set()
    for root in sorted(adjacency):
        if root in seen:
            continue
        stack, component = [root], []
        while stack:
            node = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            component.append(node)
            stack.extend(adjacency[node] - seen)
        components.append(sorted(component))
    return {"minimum_normalized_characters": threshold, "validation_rows": len(row_ids),
            "validation_row_ids": sorted(row_ids), "conversation_pairs": len(source_pairs),
            "train_groups": sorted(k.removeprefix("train:") for k in adjacency if k.startswith("train:")),
            "validation_groups": sorted(k.removeprefix("validation:") for k in adjacency if k.startswith("validation:")),
            "connected_components": components, "interpretation": "shared text exposure, not confirmed participant identity"}


def audit(release, frozen, database, sample_per_stratum=4):
    release, frozen, database = Path(release), Path(frozen), Path(database)
    manifest = source.read_json(release / "manifest.json")
    source.require(manifest["schema_version"] == source.SCHEMA, "Unsupported source release")
    before = database.stat()
    accepted, held = {}, {}
    blocks = {kind: defaultdict(dict) for kind in ("recent_8_context_messages_min200chars", "first_8_context_messages_min200chars")}
    context_ends = defaultdict(lambda: -1)
    weights = {split: {unit: {metric: Counter() for metric in ("rows", "characters")}
                       for unit in ("conversation", "group")} for split in source.SPLITS}
    validation_targets, train_targets = {}, set()
    verified_files = {}
    for split in source.SPLITS:
        name = f"conversation/{split}.jsonl.gz"
        source.require(source.sha_file(release / name) == manifest["files"][name]["sha256"], "SFT input hash mismatch")
        verified_files[name] = manifest["files"][name]["sha256"]
        count = 0
        for row in source.read_rows(release / name):
            source.require(row["id"] not in accepted and row["split"] == split, "Repeated/wrong accepted row")
            cid = row["source_conversation_id"]
            target = row["messages"][-1]["content"]
            accepted[row["id"]] = {"split": split, "conversation_id": cid, "target_sha256": source.sha_text(target)}
            context_ends[cid] = max(context_ends[cid], row["target_start_ordinal"] - 1)
            chars = sum(len(m["content"]) for m in row["messages"])
            for unit, identity in (("conversation", cid), ("group", row["source_group_id"])):
                weights[split][unit]["rows"][identity] += 1
                weights[split][unit]["characters"][identity] += chars
            for kind, block in block_keys(row["messages"]).items():
                origins = blocks[kind][split].setdefault(block, {})
                origins.setdefault(cid, {"row_id": row["id"], "conversation_id": cid,
                                         "group_id": row["source_group_id"]})
            text_key = normalize(target)
            if split == "validation":
                validation_targets.setdefault(text_key, []).append({"row_id": row["id"], "conversation_id": cid,
                                                                   "group_id": row["source_group_id"]})
            else:
                train_targets.add(text_key)
            count += 1
        source.require(count == manifest["files"][name]["rows"], "SFT declared count mismatch")
    name = "review/excluded_targets.jsonl.gz"
    source.require(source.sha_file(release / name) == manifest["files"][name]["sha256"], "Held ledger hash mismatch")
    verified_files[name] = manifest["files"][name]["sha256"]
    for row in source.read_rows(release / name):
        source.require(row["id"] not in held and row["id"] not in accepted, "Repeated accepted/held ID")
        held[row["id"]] = row
    source.require(len(held) == manifest["files"][name]["rows"], "Held declared count mismatch")
    frozen_index = source.read_json(frozen / "FILES.sha256.json")
    frozen_rows = []
    for split in source.SPLITS:
        name = f"conversation/{split}.jsonl"
        source.require(source.sha_file(frozen / name) == frozen_index[name], "Frozen file hash mismatch")
        frozen_rows.extend(source.read_rows(frozen / name))
    tables = {name: defaultdict(Counter) for name in ("length", "behavior", "position", "split", "length_by_position")}
    reasons = Counter()
    samples = {name: [] for name in (*PATTERNS, "other")}
    candidates_seen, match_details, aliases = set(), {}, []
    past_blocks, past_turns = {}, {}
    per_source = []
    with source.connect(database) as db:
        for row in frozen_rows:
            cid, split = row["conversation_id"], row["split"]
            meta = db.execute("SELECT group_id,split,original_split FROM conversations WHERE conversation_id=?", (cid,)).fetchone()
            source.require(meta is not None and meta["group_id"] == row["group_id"] and meta["split"] == meta["original_split"] == split,
                           "DB source lineage mismatch")
            turns = [dict(t) for t in db.execute("SELECT utterance_id,ordinal,speaker,text FROM utterances WHERE conversation_id=? ORDER BY ordinal", (cid,))]
            groups = source.group_turns(turns)
            candidate_count = accepted_count = 0
            alias_turns = [t for t in turns if t["speaker"] == "상담자"]
            if alias_turns:
                sources = [dict(x) for x in db.execute("SELECT source_id,path,member FROM sources WHERE conversation_id=?", (cid,))]
                selected = sorted(alias_turns, key=lambda t: (not bool(PATTERNS["question_like"].search(t["text"])), -len(t["text"])))[:2]
                aliases.append({"conversation_id": cid, "source_group_id": row["group_id"], "split": split,
                                "alias_utterances": len(alias_turns), "speaker_counts": dict(Counter(t["speaker"] for t in turns)),
                                "sources": sources, "samples": [{"ordinal": t["ordinal"], "utterance_id": t["utterance_id"],
                                  "text": t["text"], "previous_turn": turns[t["ordinal"] - 1] if t["ordinal"] else None} for t in selected]})
            for index, group in enumerate(groups):
                if group["role"] != "assistant":
                    continue
                ts, text = group["turns"], group["content"]
                rid = "sft_" + source.sha_text("|".join(t["utterance_id"] for t in ts))
                source.require(rid in accepted or rid in held, "Source candidate missing from selection ledger")
                source.require(rid not in candidates_seen, "Duplicate source candidate")
                candidates_seen.add(rid)
                candidate_count += 1
                selected = rid in accepted
                if selected:
                    source.require(accepted[rid]["target_sha256"] == source.sha_text(text), "Accepted source target differs")
                    accepted_count += 1
                excluded = held[rid]["reasons"] if not selected else []
                status = "accepted" if selected else "held"
                size = len(text.strip())
                short_only = excluded == ["short_response_under_40_chars"]
                tags = [tag for tag, pattern in PATTERNS.items() if pattern.search(text)] or ["other"]
                position = stage(ts[0]["ordinal"], len(turns))
                categories = {"length": [length_bin(size)], "behavior": tags, "position": [position], "split": [split],
                              "length_by_position": [length_bin(size) + "/" + position]}
                for dimension, labels in categories.items():
                    for label in labels:
                        tables[dimension][label][status] += 1
                        if short_only:
                            tables[dimension][label]["length_only_held"] += 1
                        if "short_response_under_40_chars" in excluded:
                            tables[dimension][label]["length_reason_with_or_without_others"] += 1
                reasons.update(excluded)
                if short_only and 8 <= size < 40:
                    stratum = "ending_like" if "ending_like" in tags else "support_like" if "support_like" in tags else "question_like" if "question_like" in tags else "other"
                    sample = {"row_id": rid, "conversation_id": cid, "split": split, "target_start_ordinal": ts[0]["ordinal"],
                              "characters": size, "target_text": text, "tags": tags, "reasons": excluded,
                              "previous_group": {"role": groups[index - 1]["role"], "text": groups[index - 1]["content"]} if index else None,
                              "training_allowed_by_this_audit": False, "manual_review": "pending"}
                    bucket = samples[stratum]
                    if not any(x["conversation_id"] == cid for x in bucket):
                        bucket.append(sample)
                        bucket.sort(key=lambda x: x["row_id"])
                        del bucket[sample_per_stratum:]
                if split == "train" and ts[-1]["ordinal"] <= context_ends[cid]:
                    past_blocks.setdefault(normalize(text), {}).setdefault(cid, {"conversation_id": cid, "group_id": row["group_id"],
                        "utterance_ids": [t["utterance_id"] for t in ts]})
                    for turn in ts:
                        past_turns.setdefault(normalize(turn["text"]), {}).setdefault(cid, {"conversation_id": cid, "group_id": row["group_id"],
                            "utterance_ids": [turn["utterance_id"]]})
            per_source.append({"conversation_id": cid, "group_id": row["group_id"], "split": split,
                               "candidates": candidate_count, "accepted": accepted_count, "held": candidate_count - accepted_count})
    source.require(candidates_seen == set(accepted) | set(held), "Selection ledger contains unknown source candidates")
    overlaps = {}
    for name, index in (("whole_normalized_past_assistant_group", past_blocks), ("whole_normalized_past_assistant_utterance", past_turns)):
        matches = [text for text in validation_targets if text in index]
        overlaps[name] = {"unique_validation_targets": len(matches),
                          "validation_rows": sum(len(validation_targets[t]) for t in matches),
                          "characters_below40_after_normalization": sum(len(t) < 40 for t in matches),
                          "characters_at_least40_after_normalization": sum(len(t) >= 40 for t in matches),
                          "matches": [{"validation_row_ids": [x["row_id"] for x in validation_targets[t]],
                                       "validation_sources": validation_targets[t], "normalized_characters": len(t),
                                       "text_sha256": source.sha_text(t), "train_sources": list(index[t].values())} for t in matches]}
    overlaps["validation_target_vs_train_final_target"] = {"unique_targets": len(set(validation_targets) & train_targets),
        "validation_rows": sum(len(validation_targets[t]) for t in set(validation_targets) & train_targets)}
    for kind, parts in blocks.items():
        shared = set(parts["train"]) & set(parts["validation"])
        evidence = []
        for digest in sorted(shared):
            record = {"sha256": digest}
            for split in source.SPLITS:
                origins = [parts[split][digest][cid] for cid in sorted(parts[split][digest])]
                record[split + "_sources"] = origins
                record[split] = origins[0]  # Display-only compatibility representative.
            evidence.append(record)
        overlaps[kind] = {"unique_shared_blocks": len(shared),
                          "source_inventory": "all_matching_conversations_v1", "examples": evidence}
    after = database.stat()
    source.require((before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns), "Database changed during read-only audit")
    return {"schema_version": "malssi-source-selection-audit-v1", "read_only": True,
            "input_manifest_sha256": source.sha_file(release / "manifest.json"), "verified_release_files": verified_files,
            "database_full_hash_repeated": False, "database_size_mtime_unchanged": True,
            "candidate_counts": {"all": len(candidates_seen), "accepted": len(accepted), "held": len(held)},
            "selection_tables": {k: {label: dict(count) for label, count in values.items()} for k, values in tables.items()},
            "held_reason_counts_overlapping": dict(reasons),
            "short_only_samples_stratified": samples, "source_alias_review": {"label": "상담자", "conversations": aliases,
                 "total_utterances": sum(x["alias_utterances"] for x in aliases), "semantic_review": "pending",
                 "formal_source_role_definition_verified": False},
            "bounded_cross_split_overlap": overlaps,
            "overlap_source_group_graphs": [overlap_graph(overlaps["whole_normalized_past_assistant_group"]["matches"], n)
                                            for n in (40, 100, 200, 400)],
            "concentration": {split: {unit: {metric: concentration(values) for metric, values in metrics.items()}
                              for unit, metrics in units.items()} for split, units in weights.items()},
            "per_source_candidate_selection": per_source,
            "behavior_tag_patterns": {name: pattern.pattern for name, pattern in PATTERNS.items()},
            "limitations": ["Question/support/ending tags are overlapping lexical proxies, not clinical or behavior truth.",
                "No held row is admitted or rewritten; short-response samples require review and do not show model behavior.",
                "Overlap detects whole NFKC/whitespace-normalized utterances or merged assistant groups and exact first/recent eight-message blocks of at least 200 characters. Arbitrary substrings, near-duplicates and semantic equivalence are not covered.",
                "Concentration uses Unicode character workload including repeated full prefixes and system prompt, not tokenizer tokens or independent statistical units.",
                "Groups are inherited source group IDs; effective independent participants and the formal meaning of 상담자 are not established by matching hashes.",
                "This audit does not run a model, train, certify safety, or grant source-use/clinical approval."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path, required=True)
    parser.add_argument("--frozen", type=Path, required=True)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.release, args.frozen, args.database)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    source.dump_json(args.output, result)
    print(json.dumps({"candidate_counts": result["candidate_counts"], "output": str(args.output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
