"""Deterministic, unapproved source-composition experiments preserving byte lines.

The 16-row group cap is an experimental composition limit, not a claim of
representativeness. Existing exposure holds are recomputed; no source content,
split, labels, human approval or training authorization is created or changed.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from functools import lru_cache
import gzip
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import tempfile

from . import evaluation_history as history, source_sft as source, token_admission as token
from .source_review import position_band
from .source_selection_audit import PATTERNS


SCHEMA = "malssi-source-composition-v1"
QUARTERS = ("q1_0_25", "q2_25_50", "q3_50_75", "q4_75_100")
CONFIG = {
    "schema_version": SCHEMA,
    "selection_policy": "group_quarter_round_robin_prefer_underrepresented_conversations",
    "tie_break_seed": "source-composition-20261016-v1",
    "maximum_sequence_length": 32768,
    "compatible_sequence_length": 4096,
    "maximum_rows_per_source_group": 16,
    "maximum_rows_per_conversation_quarter": 1,
    "quarter_order": list(QUARTERS),
    "medical_context_policy": "hold_for_review",
    "procedural_context_policy": "retain_with_review_flag",
    "source_admission_policy": "preserve_all_recomputed_holds",
    "source_line_policy": "copy_original_bytes_with_entire_prefix_and_loss_mask",
    "group_cap_interpretation": "experimental_limit_not_representativeness_guarantee",
    "training_authorized": False,
}
require = source.require


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(value):
    return hashlib.sha256(encoded(value)).hexdigest()


def validate_config(config):
    # Reject booleans masquerading as integers and unversioned policy changes.
    require(encoded(config) == encoded(CONFIG), "unsupported composition config")
    return json.loads(encoded(config))


def select_rows(rows, config=None):
    """Select only supplied eligible cells; input order cannot affect selection."""
    config = validate_config(CONFIG if config is None else config)
    buckets, ids, origins, conversations = defaultdict(lambda: defaultdict(list)), set(), {}, {}
    for row in rows:
        require(all(isinstance(row.get(k), str) and row[k] for k in token.IDENTITY), "invalid composition identity")
        rid, split, group, conv = (row[k] for k in token.IDENTITY)
        require(rid not in ids and split in source.SPLITS and row.get("position_band") in QUARTERS,
                "duplicate composition ID or invalid split/quarter")
        ids.add(rid)
        require(origins.setdefault(group, split) == split, "composition group crosses splits")
        require(conversations.setdefault(conv, (split, group)) == (split, group), "composition conversation origin mismatch")
        require(type(row.get("eligible")) is bool, "composition eligibility must be explicit")
        if row["eligible"]:
            buckets[(split, group)][row["position_band"]].append(row)
    chosen = set()
    for key in sorted(buckets):
        counts, cells, group_count = Counter(), set(), 0
        while group_count < config["maximum_rows_per_source_group"]:
            progress = False
            for quarter in QUARTERS:
                available = [r for r in buckets[key][quarter] if (r["source_conversation_id"], quarter) not in cells]
                if not available or group_count == config["maximum_rows_per_source_group"]:
                    continue
                row = min(available, key=lambda r: (counts[r["source_conversation_id"]],
                    source.sha_text(config["tie_break_seed"] + "|" + r["id"]), r["id"]))
                chosen.add(row["id"])
                counts[row["source_conversation_id"]] += 1
                cells.add((row["source_conversation_id"], quarter))
                group_count += 1
                progress = True
            if not progress:
                break
    return chosen


def load_frozen_metadata(frozen, manifest, tracked):
    """Use the same frozen conversation metadata/quarter definition as source_review."""
    frozen = Path(frozen)
    binding = manifest.get("source", {}).get("frozen_files", {})
    names = [f"conversation/{s}.jsonl" for s in source.SPLITS] + [
        "conversation/manifest.json", "conversation/input_filter_review.json"]
    for name in names:
        path = frozen / name
        require(isinstance(binding.get(name), str) and source.sha_file(path) == binding[name], "frozen metadata hash mismatch")
        tracked[path] = binding[name]
    require(source.read_json(frozen / "conversation/manifest.json").get("source_database_sha256") ==
            manifest["source"].get("database_sha256"), "frozen database binding mismatch")
    result, groups, subjects = {}, {}, {}
    for split in source.SPLITS:
        for row in source.read_rows(frozen / f"conversation/{split}.jsonl"):
            cid, group, subject = (row.get(k) for k in ("conversation_id", "group_id", "subject_id_key"))
            require(all(isinstance(v, str) and v for v in (cid, group, subject)), "invalid frozen identity")
            require(cid not in result and row.get("split") == row.get("original_split") == split, "frozen split or conversation mismatch")
            require(groups.setdefault(group, split) == split and subjects.setdefault(subject, split) == split,
                    "frozen group or subject crosses splits")
            require(type(row.get("source_turn_count")) is int and row["source_turn_count"] > 0,
                    "invalid frozen source turn count")
            require(row.get("source_class") in {"NORMAL", "DEPRESSION", "ANXIETY", "ADDICTION"}, "invalid frozen source cohort")
            meta = {k: row[k] for k in ("conversation_id", "group_id", "split", "original_split",
                    "subject_id_key", "source_class", "source_turn_count", "source_full_text_sha256")}
            result[cid] = {**meta, "metadata_sha256": digest(meta)}
    return result


@lru_cache(maxsize=100000)
def context_patterns(text):
    return (bool(source.MEDICAL_TARGET.search(text)), bool(source.PROCEDURAL.search(text)))


def length_tier(length):
    if length is None:
        return "unverified"
    return next((label for cap, label in ((4096, "le_4096"), (8192, "4097_8192"),
        (16384, "8193_16384"), (32768, "16385_32768")) if length <= cap), "over_32768")


def row_metadata(row, line, joined, frozen, config):
    require(all(row.get(k) == joined[k] for k in token.IDENTITY), "source identity differs from verified ledger")
    require((row["source_group_id"], row["split"]) == (frozen["group_id"], frozen["split"]), "source identity differs from frozen metadata")
    require(row.get("schema_version") == source.SCHEMA and row.get("task") == "original_counselor_continuation"
            and row.get("context_policy") == "entire_original_prefix_no_holes_no_future"
            and row.get("target_origin") == "observed_counselor_utterance"
            and row.get("quality_status") == "heuristic_screened_not_human_reviewed"
            and row.get("caregiver_perspective_assumed") is False, "unsupported original row contract")
    messages = row.get("messages")
    require(isinstance(messages, list) and len(messages) >= 3
            and messages[0] == {"role": "system", "content": source.SYSTEM}
            and all(isinstance(m, dict) and m.get("role") in {"user", "assistant"}
                    and isinstance(m.get("content"), str) for m in messages[1:])
            and messages[-1]["role"] == "assistant" and messages[-2]["role"] == "user",
            "invalid original message structure")
    require(all(a["role"] != b["role"] for a, b in zip(messages[1:], messages[2:])), "unmerged adjacent source roles")
    mask = row.get("loss_message_mask")
    require(isinstance(mask, list) and all(type(v) is int for v in mask)
            and mask == [0] * (len(messages) - 1) + [1], "source loss mask changed")
    target = messages[-1]["content"]
    require(row.get("target_sha256") == source.sha_text(target), "source target hash mismatch")
    start, end, total = row.get("target_start_ordinal"), row.get("target_end_ordinal"), frozen["source_turn_count"]
    require(type(start) is int and type(end) is int and 0 <= start <= end < total
            and type(row.get("context_start_ordinal")) is int and row["context_start_ordinal"] == 0,
            "invalid source target position")
    hits = [context_patterns(m["content"]) for m in messages[1:-1] if m["role"] == "assistant"]
    flags = [flag for i, flag in enumerate(("prior_assistant_medical_pattern", "prior_assistant_procedural_pattern"))
             if any(hit[i] for hit in hits)]
    reasons = list(joined["source_reasons"])
    if joined["tokenizer_status"] != "encoded":
        reasons.append("tokenizer_" + joined["tokenizer_status"])
    elif joined["sequence_length"] > config["maximum_sequence_length"]:
        reasons.append("sequence_exceeds_composition_cap")
    pool_eligible = not reasons
    if "prior_assistant_medical_pattern" in flags:
        reasons.append("medical_context_requires_review")
    return {**joined, "source_row_sha256": hashlib.sha256(line).hexdigest(), "target_sha256": row["target_sha256"],
        "frozen_metadata_sha256": frozen["metadata_sha256"], "source_cohort": frozen["source_class"],
        "original_turn_count": total, "target_start_ordinal": start, "target_end_ordinal": end,
        "relative_position": end / max(1, total - 1), "position_band": position_band(end, total),
        "length_tier": length_tier(joined.get("sequence_length")), "context_flags": flags,
        "review_required": True, "review_reasons": ["source_not_human_reviewed", *flags],
        "lexical_tags": [k for k, pattern in PATTERNS.items() if pattern.search(target)] or ["other"],
        "target_characters": len(target), "non_system_messages": len(messages) - 1,
        "pool_eligible": pool_eligible, "eligible": not reasons, "hold_reasons": reasons,
        "chosen": False, "config_sha256": digest(config), "training_authorized": False,
        "development_exposed": True, "independent_test_eligible": False}


def quantiles(values):
    values = sorted(values)
    return ({"median": statistics.median(values), "p90_nearest_rank": values[math.ceil(.9 * len(values)) - 1],
             "max": values[-1]} if values else {"median": None, "p90_nearest_rank": None, "max": None})


def summarize(rows):
    result = {}
    for split in (*source.SPLITS, "all"):
        subset = [r for r in rows if split == "all" or r["split"] == split]
        groups = Counter(r["source_group_id"] for r in subset)
        conversations = Counter(r["source_conversation_id"] for r in subset)
        n = len(subset)
        result[split] = {"rows": n, "source_groups": len(groups), "source_conversations": len(conversations),
            "position_quarters": dict(sorted(Counter(r["position_band"] for r in subset).items())),
            "first_half_rows": sum(r["relative_position"] <= .5 for r in subset),
            "first_half_percent": 100 * sum(r["relative_position"] <= .5 for r in subset) / n if n else None,
            "source_cohorts": dict(sorted(Counter(r["source_cohort"] for r in subset).items())),
            "length_tiers": dict(sorted(Counter(r["length_tier"] for r in subset).items())),
            "lexical_tags_overlapping": dict(sorted(Counter(t for r in subset for t in r["lexical_tags"]).items())),
            "context_flags_overlapping": dict(sorted(Counter(t for r in subset for t in r["context_flags"]).items())),
            "rows_per_source_group": quantiles(groups.values()), "rows_per_conversation": quantiles(conversations.values()),
            "target_characters": quantiles(r["target_characters"] for r in subset),
            "non_system_messages": quantiles(r["non_system_messages"] for r in subset),
            "top_group_rows": {str(k): sum(sorted(groups.values(), reverse=True)[:k]) for k in (1, 5, 10)}}
    return result


def prepare(*, release, frozen, admission_policy, admission_rows, selection_audit, tokenizer_audit,
            row_lengths, previous_candidate, events, config=None):
    """Recompute admission and history before constructing any new decisions."""
    config = validate_config(CONFIG if config is None else config)
    release, previous_candidate, events = map(Path, (release, previous_candidate, events))
    old = source.read_json(previous_candidate / "export_manifest.json")
    require(old.get("selected_cap") == 4096, "previous comparison candidate must use cap 4096")
    previous_history = history.audit_history(previous_candidate / "export_manifest.json", admission_rows, events,
        intended_use="development", release=release, admission_policy=admission_policy,
        selection_audit=selection_audit, tokenizer_audit=tokenizer_audit, row_lengths=row_lengths)
    report, joined = token.validate_and_summarize(release, admission_policy, admission_rows, tokenizer_audit, row_lengths)
    tracked = {Path(p): value for p, value in report["input_sha256"].items()}
    for name in ("source_composition", "source_review", "source_sft", "source_selection_audit",
                 "token_admission", "evaluation_history", "source_admission", "partial_exposure"):
        path = Path(__file__).parent / (name + ".py")
        tracked[path] = source.sha_file(path)
    for path in (Path(selection_audit), events, previous_candidate / "export_manifest.json",
                 previous_candidate.parent / "token_admission_policy.json", previous_candidate.parent / "token_admission_rows.jsonl.gz"):
        tracked[path] = source.sha_file(path)
    manifest = source.read_json(release / "manifest.json")
    for key in source.read_json(admission_policy)["verified_release_files"]:
        tracked[release / key] = manifest["files"][key]["sha256"]
    for name, declaration in old["files"].items():
        tracked[previous_candidate / name] = declaration["sha256"]
    for event in history._json_rows(events):
        path = Path(event["evidence"]["path"])
        path = path if path.is_absolute() else events.parent / path
        tracked[path] = event["evidence"]["sha256"]
    frozen_by_id = load_frozen_metadata(frozen, manifest, tracked)
    by_id = {r["id"]: r for r in joined}
    metadata, longest = {}, {}
    for split in source.SPLITS:
        with gzip.open(release / f"conversation/{split}.jsonl.gz", "rb") as stream:
            count = 0
            for line in stream:
                require(bool(line.strip()), "blank original source line")
                row = json.loads(line)
                require(isinstance(row, dict) and row.get("id") in by_id and row["id"] not in metadata
                        and row.get("split") == split, "source row identity or split mismatch")
                cid = row.get("source_conversation_id")
                require(cid in frozen_by_id, "source conversation missing from frozen metadata")
                metadata[row["id"]] = row_metadata(row, line, by_id[row["id"]], frozen_by_id[cid], config)
                prior, current = longest.get(cid), row["messages"]
                if prior is not None:
                    require(prior[:min(len(prior), len(current))] == current[:min(len(prior), len(current))],
                            "source conversation prefixes are inconsistent")
                if prior is None or len(current) > len(prior):
                    longest[cid] = current
                count += 1
            require(count == manifest["files"][f"conversation/{split}.jsonl.gz"]["rows"], "source count mismatch")
    require(metadata.keys() == by_id.keys(), "source/ledger coverage mismatch")
    chosen = select_rows(metadata.values(), config)
    chosen_cells = {(metadata[r]["source_conversation_id"], metadata[r]["position_band"]) for r in chosen}
    for row in metadata.values():
        row["chosen"] = row["id"] in chosen
        row["selection_reason"] = ("stratified_selected" if row["chosen"] else "held" if not row["eligible"] else
            "conversation_quarter_cap" if (row["source_conversation_id"], row["position_band"]) in chosen_cells else "source_group_cap")
    rows = sorted(metadata.values(), key=lambda r: (r["split"], r["id"]))
    selected = [r for r in rows if r["chosen"]]
    eligible = [r for r in rows if r["eligible"]]
    require({(r["split"], r["source_group_id"], r["position_band"]) for r in selected} ==
            {(r["split"], r["source_group_id"], r["position_band"]) for r in eligible}, "eligible group-quarter coverage lost")
    require(len(chosen_cells) == len(selected)
            and all(v <= config["maximum_rows_per_source_group"] for v in Counter(r["source_group_id"] for r in selected).values()),
            "composition cap violated")
    stages = {"source_sft": rows, "content_admitted": [r for r in rows if r["source_admitted"]],
        "previous_4096": [r for r in rows if r["source_admitted"] and r["tokenizer_status"] == "encoded" and r["sequence_length"] <= 4096],
        "pool_32768_before_context_hold": [r for r in rows if r["pool_eligible"]], "eligible_after_context_hold": eligible,
        "selected_full_context": selected, "selected_compatible_4096": [r for r in selected if r["sequence_length"] <= 4096]}
    summary = {"schema_version": SCHEMA, "status": "verified", "tables": {k: summarize(v) for k, v in stages.items()},
        "hold_reasons_overlapping": dict(sorted(Counter(reason for r in rows for reason in r["hold_reasons"]).items())),
        "eligible_group_quarters_covered": True, "source_rows_examined": len(rows),
        "admission_rules_recomputed": True, "previous_verified_events": previous_history["verified_events"],
        "previous_history": previous_history["splits"], "previous_events_sha256": source.sha_file(events),
        "source_manifest_sha256": report["input_manifest_sha256"], "verified_source_files": report["verified_release_files"],
        "config_sha256": digest(config), "original_jsonl_lines_preserved": True, "source_split_moved": False,
        "tokens_truncated": False, "training_authorized": False, "development_exposed": True,
        "independent_test_eligible": False, "human_review_established": False,
        "limitations": ["Experimental group cap 16 is not a representativeness guarantee; groups are not authenticated people.",
            "Original client/counselor perspective is retained; these are not caregiver-support gold targets.",
            "Medical/procedural context patterns are lexical review triggers, not clinical harm judgments.",
            "All rows require human review; clean lexical flags do not establish human approval or safety.",
            "The full-context candidate includes lengths above 4096; its compatible subset has different composition.",
            "Maximum length 32768 is a selection condition, not authorization to train or a runtime-capacity claim.",
            "Frozen release metadata is hash-bound; the underlying corpus database is not reread here."]}
    require(all(source.sha_file(p) == h for p, h in tracked.items()), "composition inputs changed during preparation")
    return {"config": config, "rows": rows, "summary": summary, "tracked": tracked}


def write_gzip(path, lines):
    with Path(path).open("xb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0, compresslevel=5) as stream:
            for line in lines:
                stream.write(line)


def new_events(summary, occurred_at):
    try:
        when = datetime.fromisoformat(occurred_at)
    except (TypeError, ValueError):
        raise ValueError("invalid composition event timestamp") from None
    require(when.utcoffset() is not None, "composition timestamp requires timezone")
    evidence_hash = digest(summary)
    return [{"schema_version": history.EVENT_SCHEMA, "event_id": "composition_" + split + "_" + evidence_hash[:16],
        "purpose": "data_selection", "occurred_at": occurred_at, "source_manifest_sha256": summary["source_manifest_sha256"],
        "scope": {"kind": "source_split", "split": split}, "input_sha256": {key: summary["verified_source_files"][key]},
        "evidence": {"path": "summary.json", "sha256": evidence_hash,
            "input_pointers": {key: "/verified_source_files/" + key.replace("/", "~1")}}}
        for split in source.SPLITS for key in [f"conversation/{split}.jsonl.gz"]]


def verify_artifacts(output, plan):
    """Check persisted decisions against recomputed metadata, even if rehashed."""
    output = Path(output)
    manifest = source.read_json(output / "export_manifest.json")
    expected = {r["id"]: r for r in plan["rows"]}
    require(manifest.get("schema_version") == SCHEMA and manifest.get("status") == "verified"
            and all(manifest.get(k) is False for k in ("training_authorized", "model_training_authorized",
                "full_training_authorized", "independent_test_eligible", "source_split_moved", "tokens_truncated"))
            and manifest.get("development_exposed") is True and manifest.get("original_jsonl_lines_preserved") is True,
            "invalid composition manifest or authorization")
    require(manifest.get("config_sha256") == digest(plan["config"])
            and manifest.get("source_manifest_sha256") == plan["summary"]["source_manifest_sha256"]
            and manifest.get("previous_events_sha256") == plan["summary"]["previous_events_sha256"]
            and manifest.get("input_sha256") == {str(p.resolve()): h for p, h in plan["tracked"].items()},
            "composition input or metadata binding mismatch")
    names = {"composition_config.json", "selection_ledger.jsonl.gz", "summary.json", "evaluation_history_events.jsonl"}
    names |= {name for split in source.SPLITS for name in (f"{split}.jsonl.gz", f"{split}.compatible_4096.jsonl.gz")}
    require(set(manifest.get("files", {})) == names
            and {p.name for p in output.iterdir()} == names | {"export_manifest.json"}, "composition file inventory mismatch")
    for name in names:
        path, item = output / name, manifest["files"][name]
        require(not path.is_symlink() and path.is_file() and type(item.get("bytes")) is int and path.stat().st_size == item["bytes"]
                and source.sha_file(path) == item.get("sha256"), "composition artifact hash or size mismatch")
    require(encoded(source.read_json(output / "composition_config.json")) == encoded(plan["config"])
            and encoded(source.read_json(output / "summary.json")) == encoded(plan["summary"]), "composition config or summary changed")
    _, actual = token.read_ledger(output / "selection_ledger.jsonl.gz")
    require(encoded(actual) == encoded(expected), "composition ledger differs from recomputed decisions")
    require(encoded(list(history._json_rows(output / "evaluation_history_events.jsonl"))) == encoded(new_events(plan["summary"], manifest["occurred_at"])),
            "composition history sidecar changed")
    for split in source.SPLITS:
        for compatible in (False, True):
            name = f"{split}.compatible_4096.jsonl.gz" if compatible else f"{split}.jsonl.gz"
            selected = {r["id"] for r in plan["rows"] if r["chosen"] and r["split"] == split
                        and (not compatible or r["sequence_length"] <= 4096)}
            seen, order, uncompressed = set(), [], hashlib.sha256()
            with gzip.open(output / name, "rb") as stream:
                for line in stream:
                    row = json.loads(line)
                    rid = row.get("id")
                    require(rid in selected and rid not in seen and hashlib.sha256(line).hexdigest() == expected[rid]["source_row_sha256"],
                            "composition original bytes or selection changed")
                    seen.add(rid); order.append(rid); uncompressed.update(line)
            require(seen == selected and order == sorted(selected), "composition export coverage or order mismatch")
            require(type(manifest["files"][name].get("rows")) is int and manifest["files"][name]["rows"] == len(seen),
                    "composition export count mismatch")
            require(manifest["files"][name].get("uncompressed_sha256") == uncompressed.hexdigest(), "composition uncompressed hash mismatch")
    require(all(source.sha_file(p) == h for p, h in plan["tracked"].items()), "composition inputs changed during export")
    return manifest


def build(*, output, occurred_at=None, **inputs):
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), "composition output already exists")
    for name in ("release", "frozen", "previous_candidate"):
        require(not output.resolve().is_relative_to(Path(inputs[name]).resolve()), "composition output overlaps input directory")
    plan = prepare(**inputs)
    occurred_at = occurred_at or datetime.now(timezone.utc).isoformat()
    events = new_events(plan["summary"], occurred_at)
    expected = {r["id"]: r for r in plan["rows"] if r["chosen"]}
    original_lines = {}
    for split in source.SPLITS:
        with gzip.open(Path(inputs["release"]) / f"conversation/{split}.jsonl.gz", "rb") as stream:
            for line in stream:
                row = json.loads(line)
                if row["id"] in expected:
                    require(hashlib.sha256(line).hexdigest() == expected[row["id"]]["source_row_sha256"], "source line changed during copying")
                    original_lines[row["id"]] = line
    require(original_lines.keys() == expected.keys(), "selected source rows disappeared")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".composition-stage-", dir=output.parent) as temporary:
        staging = Path(temporary)
        (staging / "composition_config.json").write_bytes(encoded(plan["config"]))
        (staging / "summary.json").write_bytes(encoded(plan["summary"]))
        (staging / "evaluation_history_events.jsonl").write_bytes(b"".join(encoded(e) for e in events))
        write_gzip(staging / "selection_ledger.jsonl.gz", (encoded(r) for r in plan["rows"]))
        files = {}
        for split in source.SPLITS:
            for compatible in (False, True):
                name = f"{split}.compatible_4096.jsonl.gz" if compatible else f"{split}.jsonl.gz"
                ids = sorted(rid for rid, r in expected.items() if r["split"] == split and (not compatible or r["sequence_length"] <= 4096))
                write_gzip(staging / name, (original_lines[rid] for rid in ids))
                files[name] = {"rows": len(ids), "uncompressed_sha256": hashlib.sha256(b"".join(original_lines[rid] for rid in ids)).hexdigest()}
        for path in sorted(staging.iterdir()):
            files.setdefault(path.name, {}).update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        manifest = {"schema_version": SCHEMA, "status": "verified", "occurred_at": occurred_at,
            "config_sha256": digest(plan["config"]), "source_manifest_sha256": plan["summary"]["source_manifest_sha256"],
            "previous_events_sha256": plan["summary"]["previous_events_sha256"],
            "input_sha256": {str(p.resolve()): h for p, h in plan["tracked"].items()}, "files": files,
            "original_jsonl_lines_preserved": True, "source_split_moved": False, "tokens_truncated": False,
            "training_authorized": False, "model_training_authorized": False, "full_training_authorized": False,
            "development_exposed": True, "independent_test_eligible": False,
            "interpretation": "Unapproved source-composition experiment; full-context and <=4096 subsets are distinct."}
        (staging / "export_manifest.json").write_bytes(encoded(manifest))
        verify_artifacts(staging, plan)
        output.mkdir(exist_ok=False)
        published = []
        try:
            for name in (*sorted(files), "export_manifest.json"):
                destination = output / name
                os.link(staging / name, destination)
                published.append(destination)
        except BaseException:
            for path in published:
                path.unlink()
            try:
                output.rmdir()
            except OSError:
                pass
            raise
    return plan["summary"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("release", "frozen", "admission-policy", "admission-rows", "selection-audit", "tokenizer-audit",
                 "row-lengths", "previous-candidate", "events", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--verify", action="store_true", help="Recompute decisions and verify an existing export")
    args = vars(parser.parse_args())
    output, verification = args.pop("output"), args.pop("verify")
    if verification:
        plan = prepare(**args)
        verify_artifacts(output, plan)
        result = plan["summary"]
    else:
        result = build(output=output, **args)
    print(json.dumps({"status": result["status"], "training_authorized": False,
        "selected": result["tables"]["selected_full_context"],
        "compatible_4096": result["tables"]["selected_compatible_4096"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
