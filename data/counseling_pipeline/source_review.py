"""Compare selection coverage and prepare private, unapproved review work.

Reuses source roles, lexical screening, annotation context and admission/history
gates. No target authoring, human decisions, source edits or training occur.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path

from . import annotations, evaluation_history, source_sft as source, token_admission
from .agent_training import ACTIONS, REVIEW_CHECKS, SCHEMA as AGENT_SCHEMA
from .ingest import canonical_json
from .source_selection_audit import PATTERNS


STAGES = ("all_original", "release_population", "source_sft", "content_admitted", "candidate_4096")


def position_band(ordinal, total):
    source.require(type(ordinal) is int and type(total) is int and 0 <= ordinal < total,
                   "invalid original position")
    fraction = ordinal / max(1, total - 1)
    return next(label for bound, label in ((.25, "q1_0_25"), (.5, "q2_25_50"),
                                          (.75, "q3_50_75"), (1, "q4_75_100")) if fraction <= bound)


def membership(row_id, in_release, admitted, candidates):
    if row_id in candidates:
        return "candidate_4096"
    if row_id in admitted and admitted[row_id]["admitted"]:
        return "content_admitted_over_cap"
    if row_id in admitted:
        return "content_held"
    return "source_heuristic_held" if in_release else "outside_release"


def stratum(row):
    tags = row["lexical_tags"]
    behavior = next((tag for tag in ("ending_like", "support_like", "question_like") if tag in tags), "other")
    return (row["split"], row["source_cohort"], row["position_band"], row["selection_tier"], behavior)


def select_review_rows(rows):
    """One deterministic contrast sample per observed cell, prefer new groups."""
    buckets = defaultdict(list)
    for row in rows:
        buckets[stratum(row)].append(row)
    chosen, groups, conversations = [], set(), set()
    for key in sorted(buckets):
        ordered = sorted(buckets[key], key=lambda row: (row["source_group_id"] in groups,
                         row["source_conversation_id"] in conversations, row["id"]))
        row = ordered[0]
        chosen.append(row)
        groups.add(row["source_group_id"])
        conversations.add(row["source_conversation_id"])
    return chosen


def summarize(rows):
    result = {}
    for stage in STAGES:
        result[stage] = {}
        for split in source.SPLITS:
            selected = [row for row in rows if stage in row["stages"] and row["split"] == split]
            result[stage][split] = {
                "rows": len(selected), "source_conversations": len({r["source_conversation_id"] for r in selected}),
                "source_groups": len({r["source_group_id"] for r in selected}),
                "first_half_rows": sum(r["relative_position"] <= .5 for r in selected),
                "position": dict(sorted(Counter(r["position_band"] for r in selected).items())),
                "source_cohort": dict(sorted(Counter(r["source_cohort"] for r in selected).items())),
                "lexical_tags_overlapping": dict(sorted(Counter(t for r in selected for t in r["lexical_tags"]).items())),
            }
    return result


def write_rows(path, rows):
    with Path(path).open("x", encoding="utf-8") as stream:
        for row in rows:
            stream.write(json.dumps(row, ensure_ascii=False) + "\n")


def prepare(*, release, frozen, corpus_output, admission_policy, admission_rows, selection_audit,
            tokenizer_audit, row_lengths, candidate_export, events, output):
    release, frozen, corpus_output, candidate_export, output = map(Path,
        (release, frozen, corpus_output, candidate_export, output))
    source.require(not output.exists(), "output exists; preserve prior review work")
    for path in (release, frozen, candidate_export):
        source.require(not output.resolve().is_relative_to(path.resolve()), "output overlaps source inputs")
    database = corpus_output / "corpus.sqlite"
    database_before = database.stat()
    frozen_rows, _, provenance = source.load_inputs(frozen, database)
    source_manifest = source.read_json(release / "manifest.json")
    source.require(source_manifest["source"]["database_sha256"] == provenance["database_sha256"],
                   "source database binding mismatch")
    # This existing gate verifies exact export lines, split/group identities,
    # recomputed admission and the declared history, without producing targets.
    history_args = dict(export_manifest=candidate_export / "export_manifest.json", source_ledger=admission_rows,
        intended_use="development", release=release, admission_policy=admission_policy,
        selection_audit=selection_audit, tokenizer_audit=tokenizer_audit, row_lengths=row_lengths)
    previous_history = evaluation_history.audit_history(events=events, **history_args)
    _, admitted = token_admission.read_ledger(admission_rows)
    candidate_ids = {row["id"] for split in source.SPLITS for row in source.read_rows(candidate_export / f"{split}.jsonl.gz")}
    source_targets = {row["id"]: {key: row[key] for key in ("source_conversation_id", "source_group_id", "split",
                      "target_end_ordinal", "target_sha256")} for split in source.SPLITS
                      for row in source.read_rows(release / f"conversation/{split}.jsonl.gz")}
    excluded_path = release / "review/excluded_targets.jsonl.gz"
    source.require(source.sha_file(excluded_path) == source_manifest["files"]["review/excluded_targets.jsonl.gz"]["sha256"],
                   "excluded targets binding mismatch")
    excluded = {row["id"]: row["reasons"] for row in source.read_rows(excluded_path)}
    frozen_by_id = {row["conversation_id"]: row for row in frozen_rows}
    rows, source_conversations, invalid_source = [], Counter(), Counter()
    with source.connect(database) as db:
        for conversation in db.execute("SELECT conversation_id,group_id,split,original_split,raw_json FROM conversations ORDER BY conversation_id"):
            cid, split = conversation["conversation_id"], conversation["split"]
            source.require(split in source.SPLITS and split == conversation["original_split"], "source split changed")
            payload = json.loads(conversation["raw_json"])
            cohort = payload.get("class")
            source.require(cohort in {"NORMAL", "DEPRESSION", "ANXIETY", "ADDICTION"}, "unknown source cohort")
            turns = [dict(t) for t in db.execute("SELECT utterance_id,ordinal,speaker,text FROM utterances WHERE conversation_id=? ORDER BY ordinal", (cid,))]
            source.require([t["ordinal"] for t in turns] == list(range(len(turns))), "noncontiguous source ordinals")
            paragraphs = payload["paragraph"]
            invalid_turns = sum(not isinstance(p, dict) or not isinstance(p.get("paragraph_text"), str) for p in paragraphs)
            # The existing ingest contract preserves non-string source text in
            # raw_json and uses empty text, never a fabricated string. Those
            # conversations remain visible in population counts, not the queue.
            expected = []
            for p in paragraphs:
                speaker = p.get("paragraph_speaker") if isinstance(p, dict) else None
                expected.append((speaker if speaker is None or isinstance(speaker, str) else canonical_json(speaker),
                    p["paragraph_text"] if isinstance(p, dict) and isinstance(p.get("paragraph_text"), str) else ""))
            source.require(expected == [(t["speaker"], t["text"]) for t in turns], "source utterances differ from ingest contract")
            if invalid_turns:
                source.require(cid not in frozen_by_id, "invalid source text entered release")
                invalid_source["conversations"] += 1
                invalid_source["non_string_text_turns"] += invalid_turns
            source_conversations[split] += 1
            if cid in frozen_by_id:
                original = frozen_by_id[cid]
                source.require(original["group_id"] == conversation["group_id"] and original["split"] == split,
                               "frozen source identity mismatch")
                full = "\n".join(f"[{t['speaker'] or '화자 미상'}] {t['text']}" for t in turns)
                source.require(source.sha_text(full) == original["source_full_text_sha256"], "full source hash mismatch")
            for group in source.group_turns(turns):
                if group["role"] != "assistant":
                    continue
                target = group["content"]
                ids = [t["utterance_id"] for t in group["turns"]]
                rid = "sft_" + source.sha_text("|".join(ids))
                end = group["turns"][-1]["ordinal"]
                if rid in source_targets:
                    saved = source_targets[rid]
                    source.require(saved["source_conversation_id"] == cid and saved["source_group_id"] == conversation["group_id"]
                                   and saved["split"] == split and saved["target_end_ordinal"] == end
                                   and saved["target_sha256"] == source.sha_text(target), "source target binding mismatch")
                stages = ["all_original"]
                if cid in frozen_by_id: stages.append("release_population")
                if rid in source_targets: stages.append("source_sft")
                if admitted.get(rid, {}).get("admitted"): stages.append("content_admitted")
                if rid in candidate_ids: stages.append("candidate_4096")
                rows.append({"id": rid, "source_conversation_id": cid, "source_group_id": conversation["group_id"],
                    "source_text_valid": not invalid_turns,
                    "split": split, "source_cohort": cohort, "target_utterance_ids": ids,
                    "target_start_ordinal": group["turns"][0]["ordinal"], "target_end_ordinal": end,
                    "original_turn_count": len(turns), "relative_position": end / max(1, len(turns)-1),
                    "position_band": position_band(end, len(turns)), "target_sha256": source.sha_text(target),
                    "lexical_tags": [tag for tag, pattern in PATTERNS.items() if pattern.search(target)] or ["other"],
                    "hold_reasons": admitted.get(rid, {}).get("reasons", excluded.get(rid, [])),
                    "selection_tier": membership(rid, cid in frozen_by_id, admitted, candidate_ids), "stages": stages})
        source.require(set(source_targets) == {r["id"] for r in rows if "source_sft" in r["stages"]}, "missing source targets")
        source.require(candidate_ids == {r["id"] for r in rows if "candidate_4096" in r["stages"]}, "missing candidate targets")
        reviewable = [row for row in rows if row["source_text_valid"]]
        selected = select_review_rows(reviewable)
        output.mkdir(parents=True)
        sentence_ids, queue = set(), []
        with (output / "source_review_queue.jsonl").open("x", encoding="utf-8") as stream:
            for row in selected:
                turns = [dict(t) for t in db.execute("SELECT utterance_id,ordinal,speaker,text FROM utterances WHERE conversation_id=? AND ordinal<=? ORDER BY ordinal",
                         (row["source_conversation_id"], row["target_end_ordinal"]))]
                groups = source.group_turns(turns)
                # Keep original speakers and exact target separate from the
                # blinded prefix; it is not a family/close-other target.
                item = {**row, "schema_version": "malssi-source-review-request-v1", "status": "review_pending",
                    "training_allowed": False, "human_verified": False,
                    "perspective": "unknown", "caregiver_perspective_assumed": False,
                    "target_origin": "observed_counselor_utterance", "target_response": groups[-1]["content"],
                    "prefix": {"messages": [{"message_id": g["turns"][0]["utterance_id"], "role": g["role"] or "unknown",
                               "content": g["content"]} for g in groups[:-1]]},
                    "original_speakers": sorted({t["speaker"] or "unknown" for t in turns}),
                    "source_manifest_sha256": previous_history["source_manifest_sha256"],
                    "source_database_sha256": provenance["database_sha256"],
                    "review": None, "independent_test_eligible": False,
                    "development_exposed_by_this_preparation": True}
                item["prefix_sha256"] = annotations.digest(item["prefix"])
                first_sentence = db.execute("SELECT sentence_id FROM sentences WHERE utterance_id=? ORDER BY ordinal LIMIT 1",
                                            (row["target_utterance_ids"][0],)).fetchone()
                item["annotation_sentence_id"] = first_sentence[0] if first_sentence else None
                if first_sentence: sentence_ids.add(first_sentence[0])
                stream.write(json.dumps(item, ensure_ascii=False) + "\n")
                queue.append({k: v for k, v in item.items() if k not in {"prefix", "target_response", "original_speakers"}})
    # Existing annotation format includes adjacent/future speech. It is only
    # for offline sentence labels, never a causal agent prompt or target.
    write_rows(output / "annotation_batch.jsonl", ({"context": context, "context_hash": annotations.digest(context)}
        for context in (annotations.context(corpus_output, sid) for sid in sorted(sentence_ids))))
    definitions = source.read_json(corpus_output / "annotation_queue/definitions.json")
    write_rows(output / "agent_authoring_requests.jsonl", ({
        "request_id": "caregiver_" + action.lower(), "status": "authoring_pending", "primary_action": action,
        "required_case_schema": AGENT_SCHEMA, "required_review_checks": sorted(REVIEW_CHECKS),
        "target_response": None, "prefix": None, "author_id": None, "review": None,
        "source_root_ids": [], "training_allowed": False, "human_verified": False,
        "instruction": "Create a separately sourced family/close-other case; do not relabel a source client. "
                       "Bind any adaptation to every source root, its split, permissions and the visible prefix.",
    } for action in sorted(ACTIONS)))
    summary = {"schema_version": "malssi-source-review-preparation-v1", "status": "prepared_pending_review",
        "source_conversations": dict(source_conversations), "invalid_source_text": dict(invalid_source), "tables": summarize(rows),
        "queue": {"rows": len(selected), "source_conversations": len({r["source_conversation_id"] for r in selected}),
                  "source_groups": len({r["source_group_id"] for r in selected}), "annotation_contexts": len(sentence_ids),
                  "selection_tiers": dict(Counter(r["selection_tier"] for r in selected)),
                  "all_reviewable_strata_covered": len(selected) == len({stratum(r) for r in reviewable}),
                  "invalid_source_rows_omitted": len(rows) - len(reviewable),
                  "human_verified": 0, "caregiver_targets_written": 0},
        "annotation_scale_status": definitions["scale_status"],
        "previous_candidate_history": previous_history["splits"],
        "source_manifest_sha256": previous_history["source_manifest_sha256"],
        "source_database_sha256": provenance["database_sha256"],
        "verified_source_files": source_manifest["files"],
        "source_text_modified": False, "source_split_moved": False, "training_allowed": False,
        "position_definition": "target_end_ordinal / max(1, original_turn_count - 1); inclusive quarter upper bounds",
        "lexical_patterns": {k: v.pattern for k, v in PATTERNS.items()},
        "limitations": ["Raw cohort labels and overlapping lexical tags are not reviewed meaning or clinical stages.",
                        "All-original population includes existing empty placeholders for non-string raw text; affected conversations are omitted from the review queue.",
                        "A deterministic one-per-cell contrast queue is not a prevalence or performance sample.",
                        "Source speakers are preserved; counselor responses are not caregiver-support gold targets.",
                        "Annotation contexts can include future turns and unresolved numeric definitions remain blocked.",
                        "Human/expert approval, source-use permission and new caregiver targets remain outstanding."]}
    source.dump_json(output / "summary.json", summary)
    copied_events = list(source.read_rows(events))
    for event in copied_events:
        path = Path(event["evidence"]["path"])
        if not path.is_absolute(): event["evidence"]["path"] = str((Path(events).parent / path).resolve())
    for split in source.SPLITS:
        key = f"conversation/{split}.jsonl.gz"
        copied_events.append({"schema_version": evaluation_history.EVENT_SCHEMA,
            "event_id": "source_review_" + split + "_" + source.sha_file(output / "summary.json")[:16],
            "purpose": "data_selection", "occurred_at": annotations.now(),
            "source_manifest_sha256": previous_history["source_manifest_sha256"],
            "scope": {"kind": "source_split", "split": split},
            "input_sha256": {key: source_manifest["files"][key]["sha256"]},
            "evidence": {"path": "summary.json", "sha256": source.sha_file(output / "summary.json"),
                         "input_pointers": {key: "/verified_source_files/" + key.replace("/", "~1") + "/sha256"}}})
    write_rows(output / "evaluation_history_events.jsonl", copied_events)
    history = evaluation_history.audit_history(events=output / "evaluation_history_events.jsonl", **history_args)
    source.dump_json(output / "evaluation_history.json", history)
    after = database.stat()
    source.require((after.st_size, after.st_mtime_ns) == (database_before.st_size, database_before.st_mtime_ns),
                   "source database changed during preparation")
    manifest = {"schema_version": summary["schema_version"], "status": "prepared_pending_review",
        "files": {p.name: {"sha256": source.sha_file(p), "bytes": p.stat().st_size} for p in sorted(output.iterdir())},
        "source_database_sha256": provenance["database_sha256"], "source_database_size_mtime_unchanged": True,
        "source_manifest_sha256": history["source_manifest_sha256"], "input_sha256": history["input_sha256"],
        "queue_rows": len(queue), "actual_human_decisions": 0, "training_allowed": False,
        "candidate_history_after_preparation": history["counts"]}
    source.dump_json(output / "manifest.json", manifest)
    return summary, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("release", "frozen", "corpus-output", "admission-policy", "admission-rows", "selection-audit",
                 "tokenizer-audit", "row-lengths", "candidate-export", "events", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    try:
        summary, manifest = prepare(**vars(args))
        print(json.dumps({"status": manifest["status"], "queue": summary["queue"],
                          "history": manifest["candidate_history_after_preparation"]}, ensure_ascii=False))
    except (ValueError, KeyError, TypeError, OSError):
        print(json.dumps({"status": "invalid", "message": "Review preparation failed; no approval or training occurred."}))
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
