"""Lossless source-counselor continuation data; auxiliary units are not SFT targets.

This is a local research preparation profile, not the human-approved HOP agent
exporter in agent_training.py. No model loading, token truncation or training.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from contextlib import ExitStack
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import re
import sqlite3

SCHEMA = "malssi-source-sft-v1"
SPLITS = ("train", "validation")
ROLES = {"내담자": "user", "상담사": "assistant", "상담자": "assistant"}
SYSTEM = ("주어진 원본 상담 대화의 맥락을 따라 다음 상담사 발화를 작성하세요. "
          "대화 속 내담자의 관점과 관계를 그대로 유지하세요.")
MIN_TARGET_CHARS = 40
# These are conservative review triggers, NOT diagnoses or complete safety tests.
SAFETY = re.compile(r"자살|자해|죽고\s*싶|죽을\s*생각|죽어\s*버|목숨|극단적\s*선택|"
                    r"폭행|성폭력|성폭행|가정\s*폭력|학대|살해|과다\s*복용")
PII = re.compile(r"(?<!\d)01[016789][- .]?\d{3,4}[- .]?\d{4}(?!\d)|"
                 r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?<!\d)\d{6}[- ]?[1-4]\d{6}(?!\d)")
PROCEDURAL = re.compile(r"설문|문항|녹음|녹화|연구원|스크리닝|스크리밍|사전\s*검사|사후\s*검사|"
                       r"화면\s*공유|화면.*끊|소리.*안\s*들|접속|줌으로|다음\s*회기|"
                       r"상담\s*시간|다음\s*시간|오늘.*마무리|지난\s*과제|숙제")
MEDICAL_TARGET = re.compile(r"복용|단약|처방|약물|약을\s*(?:끊|줄|늘|드|먹)|진단(?:을|이|명|받)")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha_file(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def sha_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def valid_span(text, start, end):
    return type(start) is int and type(end) is int and 0 <= start < end <= len(text)


def read_rows(path):
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def dump_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def connect(database):
    db = sqlite3.connect(Path(database).resolve().as_uri() + "?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA query_only=ON")
    return db


def removal_ordinals(turns, records):
    """Map original splitlines indices, never assume line number == turn ordinal."""
    lines, owners = [], []
    for turn in turns:
        parts = f"[{turn['speaker'] or '화자 미상'}] {turn['text']}".splitlines()
        lines.extend(parts)
        owners.extend([turn["ordinal"]] * len(parts))
    removed = set()
    seen = {}
    for item in records:
        line = item["turn_line"]
        require(type(line) is int and 0 <= line < len(lines), "Invalid removal line")
        require(lines[line] == item["original_turn"], "Removal text mismatch")
        require(line not in seen or seen[line] == item["original_turn"], "Conflicting removal")
        seen[line] = item["original_turn"]
        removed.add(owners[line])
    return removed, lines, seen


def group_turns(turns):
    """Keep exact text, including newlines, and merge only adjacent equal roles."""
    groups = []
    for turn in turns:
        role = ROLES.get(turn["speaker"])
        if groups and role is not None and groups[-1]["role"] == role:
            group = groups[-1]
            group["content"] += "\n" + turn["text"]
            group["turns"].append(turn)
        else:
            groups.append({"role": role, "content": turn["text"], "turns": [turn]})
    return groups


def examples_for_conversation(row, turns, removed):
    """Yield either an original-prefix target or an explicit exclusion ledger row."""
    groups = group_turns(turns)
    messages = [{"role": "system", "content": SYSTEM}]
    prefix_flags, observed_user = set(), False
    for group in groups:
        ts, content, role = group["turns"], group["content"], group["role"]
        if any(t["ordinal"] in removed for t in ts):
            prefix_flags.add("context_contains_reviewed_cohort_disclosure")
        if role is None or any(not t["text"].strip() for t in ts):
            prefix_flags.add("unknown_speaker_or_empty_turn")
        if SAFETY.search(content):
            prefix_flags.add("context_requires_safety_review")
        if PII.search(content):
            prefix_flags.add("context_requires_privacy_review")
        if role == "assistant":
            reasons = set(prefix_flags)
            if not observed_user:
                reasons.add("no_preceding_client_turn")
            if len(content.strip()) < MIN_TARGET_CHARS:
                reasons.add("short_response_under_40_chars")
            if PROCEDURAL.search(content):
                reasons.add("procedural_or_session_specific_target")
            if MEDICAL_TARGET.search(content):
                reasons.add("target_requires_clinical_review")
            base = {"id": "sft_" + sha_text("|".join(t["utterance_id"] for t in ts)),
                    "source_conversation_id": row["conversation_id"],
                    "source_group_id": row["group_id"], "split": row["split"],
                    "target_utterance_ids": [t["utterance_id"] for t in ts],
                    "target_start_ordinal": ts[0]["ordinal"],
                    "target_end_ordinal": ts[-1]["ordinal"]}
            if reasons:
                yield None, {**base, "reasons": sorted(reasons)}
            else:
                target = {"role": "assistant", "content": content}
                yield {**base, "schema_version": SCHEMA,
                       "task": "original_counselor_continuation",
                       "messages": [*messages, target],
                       "loss_message_mask": [0] * len(messages) + [1],
                       "target_sha256": sha_text(content),
                       "context_start_ordinal": turns[0]["ordinal"],
                       "context_policy": "entire_original_prefix_no_holes_no_future",
                       "target_origin": "observed_counselor_utterance",
                       "caregiver_perspective_assumed": False,
                       "quality_status": "heuristic_screened_not_human_reviewed"}, None
        if role == "user":
            observed_user = True
        # Blocked/unknown turns are never used by a later accepted example.
        messages.append({"role": role or "unknown", "content": content})


def load_inputs(release, database):
    release = Path(release)
    names = [f"conversation/{s}.jsonl" for s in SPLITS] + [
        "conversation/input_filter_review.json", "conversation/manifest.json"]
    index = read_json(release / "FILES.sha256.json")
    for name in names:
        require(name in index and sha_file(release / name) == index[name], "Frozen source hash mismatch: " + name)
    db_hash = sha_file(database)
    require(db_hash == read_json(release / "conversation/manifest.json")["source_database_sha256"],
            "Source database hash mismatch")
    rows = [r for split in SPLITS for r in read_rows(release / f"conversation/{split}.jsonl")]
    require(len({r["conversation_id"] for r in rows}) == len(rows), "Repeated source conversation")
    groups, subjects = defaultdict(set), defaultdict(set)
    for r in rows:
        require(r["split"] in SPLITS and r["split"] == r["original_split"], "Changed original split")
        groups[r["group_id"]].add(r["split"])
        subjects[r["subject_id_key"]].add(r["split"])
    require(all(len(v) == 1 for v in groups.values()), "Source group crosses split")
    require(all(len(v) == 1 for v in subjects.values()), "Source subject crosses split")
    removals = defaultdict(list)
    for item in read_json(release / "conversation/input_filter_review.json")["records"]:
        removals[item["conversation_id"]].append(item)
    return rows, removals, {"database_sha256": db_hash, "frozen_release": str(release.resolve()),
                           "frozen_files": {n: index[n] for n in names}}


def build(release, database, output):
    rows, removals, provenance = load_inputs(release, database)
    output = Path(output)
    require(not output.exists(), "Output already exists; use a new version directory")
    output.mkdir(parents=True)
    counts, excluded, cohort_counts = Counter(), Counter(), Counter()
    source_counts, selected_conversations = Counter(), Counter()
    longest = Counter()
    all_ids, pair_split, full_hashes = set(), {}, {}
    files = {}
    with connect(database) as db, ExitStack() as stack:
        streams = {}
        names = [f"{unit}/{split}.jsonl.gz" for unit in ("conversation", "sentence", "word") for split in SPLITS]
        names += [f"conversation/source_dialogues.{s}.jsonl.gz" for s in SPLITS]
        names += ["review/excluded_targets.jsonl.gz"]
        for name in names:
            p = output / name
            p.parent.mkdir(parents=True, exist_ok=True)
            streams[name] = stack.enter_context(gzip.open(p, "wt", encoding="utf-8", compresslevel=5))

        def write(name, value):
            streams[name].write(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n")
            counts[name] += 1

        # Validation-first prevents repeated final user/response pairs entering train.
        for row in sorted(rows, key=lambda r: (r["split"] == "train", r["conversation_id"])):
            cid, split = row["conversation_id"], row["split"]
            src = db.execute("SELECT * FROM conversations WHERE conversation_id=?", (cid,)).fetchone()
            require(src is not None and src["split"] == src["original_split"] == split
                    and src["group_id"] == row["group_id"], "Source identity/group mismatch")
            require(src["subject_id"] == row["subject_id_key"], "Source subject mismatch")
            turns = [dict(t) for t in db.execute(
                "SELECT utterance_id,ordinal,speaker,text FROM utterances WHERE conversation_id=? ORDER BY ordinal", (cid,))]
            require([t["ordinal"] for t in turns] == list(range(len(turns))), "Noncontiguous source ordinals")
            payload = json.loads(src["raw_json"])
            require([(p.get("paragraph_speaker"), p["paragraph_text"]) for p in payload["paragraph"]]
                    == [(t["speaker"], t["text"]) for t in turns], "DB utterances differ from raw source")
            cut, lines, cut_lines = removal_ordinals(turns, removals.get(cid, []))
            full = "\n".join(f"[{t['speaker'] or '화자 미상'}] {t['text']}" for t in turns)
            require(sha_text(full) == row["source_full_text_sha256"], "Full source text mismatch")
            require("\n".join(t for i, t in enumerate(lines) if i not in cut_lines) == row["text"],
                    "Frozen filtered text mismatch")
            source_counts[split] += 1
            source_counts["utterances"] += len(turns)
            source_counts["reviewed_disclosure_turns"] += len(cut)
            max_used, target_ids = -1, set()
            for example, held in examples_for_conversation(row, turns, cut):
                if example:
                    # Normalized last client+response equality is a dedup heuristic,
                    # independent of cohort labels; the complete prefix is also checked.
                    pair = sha_text("\n".join(" ".join(m["content"].split()) for m in example["messages"][-2:]))
                    full_digest = sha_text(json.dumps(example["messages"], ensure_ascii=False, sort_keys=True))
                    reason = None
                    if pair in pair_split:
                        reason = "duplicate_last_client_response_pair"
                    if full_digest in full_hashes:
                        reason = "duplicate_complete_example"
                    if reason:
                        held = {k: example[k] for k in ("id", "source_conversation_id", "source_group_id", "split",
                                                        "target_utterance_ids", "target_start_ordinal", "target_end_ordinal")}
                        held["reasons"] = [reason]
                        example = None
                    else:
                        pair_split[pair] = split
                        full_hashes[full_digest] = split
                if held:
                    write("review/excluded_targets.jsonl.gz", held)
                    excluded.update(held["reasons"])
                    continue
                require(example["id"] not in all_ids, "Duplicate example ID")
                all_ids.add(example["id"])
                write(f"conversation/{split}.jsonl.gz", example)
                max_used = example["target_end_ordinal"]
                target_ids.update(example["target_utterance_ids"])
                cohort_counts[row["source_class"]] += 1
                longest[split] = max(longest[split], sum(len(m["content"]) for m in example["messages"]))
            if max_used < 0:
                continue
            selected_conversations[split] += 1
            retained = turns[:max_used + 1]
            by_id = {t["utterance_id"]: t for t in retained}
            common = {"source_conversation_id": cid, "source_group_id": row["group_id"], "split": split}
            write(f"conversation/source_dialogues.{split}.jsonl.gz", {
                **common, "source_subject_key": row["subject_id_key"],
                "retained_through_ordinal": max_used, "original_turn_count": len(turns),
                "purpose": "exact_prefix_reconstruction_only_never_append_future_turns", "utterances": retained})
            sentences = {}
            for raw in db.execute("SELECT * FROM sentences WHERE conversation_id=? ORDER BY ordinal", (cid,)):
                s = dict(raw)
                if s["utterance_id"] not in by_id:
                    continue
                u = by_id[s["utterance_id"]]
                require(s["split"] == split and valid_span(u["text"], s["start_char"], s["end_char"])
                        and u["text"][s["start_char"]:s["end_char"]] == s["text"], "Sentence span/split mismatch")
                sentences[s["sentence_id"]] = s
                write(f"sentence/{split}.jsonl.gz", {**common, "id": s["sentence_id"],
                    "utterance_id": s["utterance_id"], "utterance_ordinal": u["ordinal"],
                    "sentence_ordinal": s["ordinal"], "speaker": s["speaker"],
                    "text": s["text"], "start_char": s["start_char"], "end_char": s["end_char"],
                    "offset_reference": "source_utterance_unicode_codepoints",
                    "part_of_selected_response": s["utterance_id"] in target_ids,
                    "use": "context_reconstruction_case_mining_quality_dedup", "standalone_sft_target": False})
            for raw in db.execute("SELECT * FROM words WHERE conversation_id=? ORDER BY ordinal", (cid,)):
                w = dict(raw)
                s = sentences.get(w["sentence_id"])
                if s is None:
                    continue
                u = by_id[s["utterance_id"]]
                start, end = w["start_char"] - s["start_char"], w["end_char"] - s["start_char"]
                require(w["split"] == split and valid_span(s["text"], start, end)
                        and s["text"][start:end] == w["surface"]
                        and u["text"][w["start_char"]:w["end_char"]] == w["surface"], "Word span/split mismatch")
                write(f"word/{split}.jsonl.gz", {**common, "id": w["word_occurrence_id"],
                    "sentence_id": w["sentence_id"], "utterance_id": s["utterance_id"],
                    "surface": w["surface"], "normalized": w["normalized"],
                    "start_char": w["start_char"], "end_char": w["end_char"],
                    "offset_reference": "source_utterance_unicode_codepoints",
                    "sentence_start_char": start, "sentence_end_char": end,
                    "use": "expression_retrieval_auxiliary_analysis", "standalone_sft_target": False})
    for name in names:
        files[name] = {"sha256": sha_file(output / name), "rows": counts[name], "bytes": (output / name).stat().st_size}
    manifest = {"schema_version": SCHEMA, "training_profile": "observed_counselor_imitation",
        "created_at": datetime.now(timezone.utc).isoformat(), "files": files,
        "source": provenance, "source_counts": dict(source_counts),
        "selected_conversations": dict(selected_conversations), "target_source_cohorts_for_audit_only": dict(cohort_counts),
        "excluded_reasons_overlapping": dict(excluded), "max_context_chars_not_tokens": dict(longest),
        "system_prompt": SYSTEM, "speaker_role_mapping": ROLES,
        "model_plan": {"primary": "Gemma 4 31B IT", "fallback": "Gemma 4 12B IT",
                       "method": "Unsloth 4-bit QLoRA", "training_execution": "excluded_by_user_GPU_server_later"},
        "loss_contract": {"only_final_assistant": True, "all_context_including_prior_assistants": -100,
                          "padding_label": -100, "packing": False, "truncate": False,
                          "tokenizer_overflow": "hold_and_report_on_training_server"},
        "policy": {"min_target_chars": MIN_TARGET_CHARS, "safety_pattern": SAFETY.pattern,
                   "privacy_pattern": PII.pattern, "procedural_pattern": PROCEDURAL.pattern,
                   "clinical_target_pattern": MEDICAL_TARGET.pattern,
                   "after_reviewed_disclosure": "hold_entire_remaining_prefix_no_silent_context_deletion",
                   "dedup": "normalized_last_user_response_pair_validation_priority"},
        "readiness": {"format_ready_for_tokenization": True, "actual_model_tokenization_verified": False,
                      "model_trained": False, "clinical_or_human_approval": False,
                      "caregiver_agent_training_complete": False, "source_use_rights_verified": False,
                      "production_ready": False},
        "limitations": ["Heuristics do not certify clinical quality, safety or complete anonymization.",
                        "Original clients are not relabeled as caregivers; this is a source-response foundation stage.",
                        "No independent test split or actual model evaluation was created.",
                        "Words are source token occurrences, not diagnoses, emotion truth or generation targets.",
                        "Do not append whole auxiliary dialogues to individual examples: that can introduce future turns."]}
    dump_json(output / "manifest.json", manifest)
    return manifest


def audit(output):
    """Reconstruct every training row and auxiliary span from delivered source turns."""
    output = Path(output).resolve()
    manifest = read_json(output / "manifest.json")
    require(manifest.get("schema_version") == SCHEMA, "Wrong schema")
    required = {f"{unit}/{split}.jsonl.gz" for unit in ("conversation", "sentence", "word") for split in SPLITS}
    required.update(f"conversation/source_dialogues.{s}.jsonl.gz" for s in SPLITS)
    required.add("review/excluded_targets.jsonl.gz")
    require(set(manifest.get("files", {})) == required, "Incomplete/changed required file inventory")
    counts, source_groups, source_splits = Counter(), {}, {}
    source_subjects = {}
    all_example_ids, pair_hashes = set(), set()
    checked_target_turns = 0
    for name, info in manifest["files"].items():
        path = (output / name).resolve()
        require(path.is_relative_to(output) and path.is_file(), "Unsafe/missing manifest file")
        require(sha_file(path) == info["sha256"], "File hash mismatch: " + name)
        require(type(info.get("rows")) is int and info["rows"] >= 0
                and type(info.get("bytes")) is int and info["bytes"] == path.stat().st_size,
                "Invalid file count/size declaration")
    for split in SPLITS:
        dialogues = {}
        for row in read_rows(output / f"conversation/source_dialogues.{split}.jsonl.gz"):
            cid, group = row["source_conversation_id"], row["source_group_id"]
            require(row["split"] == split and cid not in source_splits, "Repeated/wrong source split")
            require(group not in source_groups or source_groups[group] == split, "Cross-split source group")
            subject = row["source_subject_key"]
            require(subject not in source_subjects or source_subjects[subject] == split, "Cross-split source subject")
            source_subjects[subject] = split
            source_splits[cid], source_groups[group] = split, split
            require([t["ordinal"] for t in row["utterances"]] == list(range(row["retained_through_ordinal"] + 1)), "Broken dialogue ordinals")
            dialogues[cid] = row
            counts[f"conversation/source_dialogues.{split}.jsonl.gz"] += 1
        by_utterance = {t["utterance_id"]: (d, t) for d in dialogues.values() for t in d["utterances"]}
        for row in read_rows(output / f"conversation/{split}.jsonl.gz"):
            require(row["id"] not in all_example_ids, "Repeated SFT row")
            all_example_ids.add(row["id"])
            d = dialogues[row["source_conversation_id"]]
            require(row["split"] == split and row["source_group_id"] == d["source_group_id"], "SFT lineage mismatch")
            require(type(row["context_start_ordinal"]) is int and row["context_start_ordinal"] == 0, "Incomplete original prefix")
            require(type(row["target_start_ordinal"]) is int and type(row["target_end_ordinal"]) is int
                    and 0 <= row["target_start_ordinal"] <= row["target_end_ordinal"] < len(d["utterances"]), "Invalid target ordinals")
            turns = d["utterances"][:row["target_end_ordinal"] + 1]
            groups = group_turns(turns)
            expected = [{"role": "system", "content": SYSTEM}] + [{"role": g["role"], "content": g["content"]} for g in groups]
            require(row["messages"] == expected, "Source target/context mismatch or future turn")
            require(groups[-1]["role"] == "assistant" and any(g["role"] == "user" for g in groups[:-1]), "Invalid target role")
            require([t["utterance_id"] for t in groups[-1]["turns"]] == row["target_utterance_ids"], "Target identity mismatch")
            require(groups[-1]["turns"][0]["ordinal"] == row["target_start_ordinal"]
                    and groups[-1]["turns"][-1]["ordinal"] == row["target_end_ordinal"], "Target ordinal mismatch")
            require(row["target_end_ordinal"] == len(d["utterances"]) - 1
                    or ROLES.get(d["utterances"][row["target_end_ordinal"] + 1]["speaker"]) != "assistant",
                    "Target ends inside a merged counselor response")
            require(all(type(v) is int for v in row["loss_message_mask"])
                    and row["loss_message_mask"] == [0] * (len(expected) - 1) + [1], "Loss mask mismatch")
            require(sha_text(expected[-1]["content"]) == row["target_sha256"], "Target hash mismatch")
            pair = sha_text("\n".join(" ".join(m["content"].split()) for m in expected[-2:]))
            require(pair not in pair_hashes, "Duplicate final pair across/in splits")
            pair_hashes.add(pair)
            checked_target_turns += len(row["target_utterance_ids"])
            counts[f"conversation/{split}.jsonl.gz"] += 1
        sentences = {}
        for row in read_rows(output / f"sentence/{split}.jsonl.gz"):
            require(row["id"] not in sentences, "Duplicate sentence")
            d, u = by_utterance[row["utterance_id"]]
            require(row["split"] == split and row["source_group_id"] == d["source_group_id"]
                    and row["source_conversation_id"] == d["source_conversation_id"], "Sentence lineage mismatch")
            require(valid_span(u["text"], row["start_char"], row["end_char"])
                    and u["text"][row["start_char"]:row["end_char"]] == row["text"], "Sentence source span mismatch")
            require(row["offset_reference"] == "source_utterance_unicode_codepoints", "Wrong sentence offset convention")
            require(row["standalone_sft_target"] is False, "Sentence role changed")
            sentences[row["id"]] = row
            counts[f"sentence/{split}.jsonl.gz"] += 1
        word_ids = set()
        for row in read_rows(output / f"word/{split}.jsonl.gz"):
            require(row["id"] not in word_ids, "Duplicate word occurrence")
            word_ids.add(row["id"])
            s = sentences[row["sentence_id"]]
            require(row["split"] == split and row["source_group_id"] == s["source_group_id"]
                    and row["source_conversation_id"] == s["source_conversation_id"], "Word lineage mismatch")
            require(row["utterance_id"] == s["utterance_id"], "Word utterance mismatch")
            require(row["offset_reference"] == "source_utterance_unicode_codepoints", "Wrong word offset convention")
            _, u = by_utterance[row["utterance_id"]]
            require(valid_span(u["text"], row["start_char"], row["end_char"])
                    and valid_span(s["text"], row["sentence_start_char"], row["sentence_end_char"])
                    and row["sentence_start_char"] == row["start_char"] - s["start_char"]
                    and row["sentence_end_char"] == row["end_char"] - s["start_char"]
                    and u["text"][row["start_char"]:row["end_char"]] == row["surface"]
                    and s["text"][row["sentence_start_char"]:row["sentence_end_char"]] == row["surface"], "Word source span mismatch")
            require(row["standalone_sft_target"] is False, "Word role changed")
            counts[f"word/{split}.jsonl.gz"] += 1
    for _ in read_rows(output / "review/excluded_targets.jsonl.gz"):
        counts["review/excluded_targets.jsonl.gz"] += 1
    for name, info in manifest["files"].items():
        require(counts[name] == info["rows"], "Declared row count mismatch: " + name)
    return {"passed": True, "files_checked": len(manifest["files"]), "rows_checked": dict(counts),
            "target_source_utterances_checked": checked_target_turns,
            "cross_split_source_group_conflicts": 0, "duplicate_last_client_response_pairs": 0,
            "future_turns_in_sft": 0, "incorrect_loss_message_masks": 0,
            "actual_tokenizer_checked": False, "clinical_quality_certified": False,
            "manifest_sha256": sha_file(output / "manifest.json")}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", type=Path)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--audit", action="store_true")
    args = parser.parse_args()
    if args.audit:
        result = audit(args.output)
        dump_json(args.output / "audit.json", result)
    else:
        parser.error("--release and --database are required") if not (args.release and args.database) else None
        result = build(args.release, args.database, args.output)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
