"""Select original full-prefix rows for recorded or requested output budgets.

This is an unapproved composition experiment. The 8192 output scenario is a
user-requested evaluation, not a claim that the recorded server uses that limit.
Selection conditions do not establish training feasibility.
The existing composition release and its 32768 policy are never rewritten.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import json
import os
from pathlib import Path
import tempfile

from . import source_composition as base
from . import evaluation_history as history, source_sft as source, token_admission as token


SCHEMA = "malssi-source-budget-composition-v2"
OUTPUT_BUDGETS = (4096, 8192)
PROFILES = ("runtime_budget", "strict_4096")
QUARTERS = tuple(reversed(base.QUARTERS))
LATE_QUARTERS = frozenset(QUARTERS[:2])
RECORDED_BUDGET = {
    "policy_id": "active-cache-64k-v1",
    "max_input_tokens": 65536,
    "max_output_tokens": 4096,
    "max_context_tokens": 69632,
}
CONFIG = {
    "schema_version": SCHEMA,
    "selection_policy": "independent_pools_late_first_group_quarter_round_robin",
    "tie_break_seed": "source-budget-composition-20261016-v1",
    "recorded_runtime_budget": RECORDED_BUDGET,
    "runtime_budget_evidence_pointer": "/live/health",
    "evaluation_budget": {"max_input_tokens": 65536, "max_output_tokens": 4096,
                          "max_context_tokens": 69632, "effective_max_input_tokens": 65536},
    "output_budget_source": "recorded_runtime_evidence",
    "evaluation_matches_recorded_runtime_budget": True,
    "reserved_output_tokens": 4096,
    "strict_maximum_sequence_length": 4096,
    "maximum_rows_per_source_group": 16,
    "maximum_rows_per_conversation_quarter": 1,
    "quarter_order": list(QUARTERS),
    "strict_late_cell_policy": "reserve_every_eligible_late_conversation_quarter_or_fail",
    "medical_context_policy": "hold_for_review",
    "procedural_context_policy": "retain_with_review_flag",
    "source_admission_policy": "preserve_all_recomputed_holds",
    "source_line_policy": "copy_original_bytes_with_entire_prefix_and_loss_mask",
    "group_cap_interpretation": "experimental_limit_not_representativeness_guarantee",
    "training_authorized": False,
}
FALSE_FLAGS = ("training_authorized", "model_training_authorized", "full_training_authorized",
               "independent_test_eligible", "source_split_moved", "tokens_truncated",
               "human_review_established", "profiles_are_independent", "runtime_configuration_changed",
               "current_runtime_configuration_verified")
TRUE_FLAGS = ("development_exposed", "original_jsonl_lines_preserved", "pools_selected_independently")
ROOT_FILES = frozenset(("summary.json", "composition_config.json", "selection_ledger.jsonl.gz",
                        "evaluation_history_events.jsonl"))
EXPORT_FILES = frozenset(f"{profile}/{split}.jsonl.gz" for profile in PROFILES for split in source.SPLITS)
require, encoded, digest = source.require, base.encoded, base.digest


def make_config(output_budget=4096):
    require(type(output_budget) is int and output_budget in OUTPUT_BUDGETS, "unsupported output budget; expected 4096 or 8192")
    config = json.loads(encoded(CONFIG))
    config["reserved_output_tokens"] = output_budget
    config["evaluation_budget"]["max_output_tokens"] = output_budget
    config["evaluation_budget"]["effective_max_input_tokens"] = min(RECORDED_BUDGET["max_input_tokens"],
                                                                     RECORDED_BUDGET["max_context_tokens"] - output_budget)
    config["output_budget_source"] = ("recorded_runtime_evidence" if output_budget == 4096 else "user_requested_output_budget_scenario")
    config["evaluation_matches_recorded_runtime_budget"] = output_budget == 4096
    return config


def validate_config(config):
    require(isinstance(config, dict) and type(config.get("reserved_output_tokens")) is int
            and config["reserved_output_tokens"] in OUTPUT_BUDGETS, "unsupported budget composition config output budget")
    require(encoded(config) == encoded(make_config(config["reserved_output_tokens"])), "unsupported budget composition config")
    return json.loads(encoded(config))


def read_runtime_budget(path):
    """Bind only the health limits we use, while hashing the entire evidence file."""
    path = Path(path)
    before = source.sha_file(path)
    document = source.read_json(path)
    require(isinstance(document, dict) and isinstance(document.get("live"), dict), "runtime budget live evidence is missing")
    health = document["live"].get("health", {})
    require(isinstance(health, dict), "runtime budget health evidence is missing")
    observed = {key: health.get(key) for key in RECORDED_BUDGET}
    require(encoded(observed) == encoded(RECORDED_BUDGET), "unsupported recorded runtime budget")
    require(source.sha_file(path) == before, "runtime budget evidence changed during reading")
    return {"path": str(path.resolve()), "sha256": before, "json_pointer": "/live/health", **observed}


def budget_decision(row, profile, config=None):
    """Derive from original source holds, never from the older 32768 selection."""
    config = validate_config(CONFIG if config is None else config)
    require(profile in PROFILES, "unknown budget profile")
    reasons = row.get("source_reasons")
    require(isinstance(reasons, list) and all(isinstance(reason, str) and reason for reason in reasons)
            and type(row.get("source_admitted")) is bool and row["source_admitted"] == (not reasons),
            "invalid verified source admission metadata")
    reasons = list(reasons)
    status = row.get("tokenizer_status")
    require(status in token.TOKEN_STATUSES, "invalid verified tokenizer status")
    flags = row.get("context_flags")
    require(isinstance(flags, list) and all(flag in {"prior_assistant_medical_pattern", "prior_assistant_procedural_pattern"}
                                          for flag in flags), "invalid context review flags")
    if status != "encoded":
        reasons.append("tokenizer_" + status)
    else:
        require(all(type(row.get(key)) is int and row[key] > 0 for key in token.LENGTHS)
                and row["sequence_length"] == row["prefix_length"] + row["target_length"],
                "invalid verified token length arithmetic")
        limits = config["evaluation_budget"]
        if row["prefix_length"] > limits["max_input_tokens"]:
            reasons.append("prefix_exceeds_evaluation_input_budget")
        if row["target_length"] > limits["max_output_tokens"]:
            reasons.append("target_exceeds_evaluation_output_budget")
        if row["prefix_length"] + config["reserved_output_tokens"] > limits["max_context_tokens"]:
            reasons.append("prefix_plus_reserved_output_exceeds_evaluation_context_budget")
        if profile == "strict_4096" and row["sequence_length"] > config["strict_maximum_sequence_length"]:
            reasons.append("sequence_exceeds_strict_4096_budget")
    if "prior_assistant_medical_pattern" in flags:
        reasons.append("medical_context_requires_review")
    return {"eligible": not reasons, "hold_reasons": reasons, "chosen": False, "selection_reason": "held" if reasons else "pending"}


def select_rows(rows, profile, config=None):
    """Cover all observed group quarters, then prefer unused conversations.

    Strict selection also reserves every available late conversation-quarter
    cell. An impossible future quota fails instead of silently dropping cells.
    """
    config = validate_config(CONFIG if config is None else config)
    require(profile in PROFILES, "unknown budget profile")
    buckets, ids, origins, conversations = defaultdict(lambda: defaultdict(list)), set(), {}, {}
    for row in rows:
        require(all(isinstance(row.get(key), str) and row[key] for key in token.IDENTITY), "invalid budget composition identity")
        rid, split, group, conv = (row[key] for key in token.IDENTITY)
        require(rid not in ids and split in source.SPLITS and row.get("position_band") in base.QUARTERS,
                "duplicate budget composition ID or invalid split/quarter")
        ids.add(rid)
        require(origins.setdefault(group, split) == split, "budget composition group crosses splits")
        require(conversations.setdefault(conv, (split, group)) == (split, group), "budget composition conversation origin mismatch")
        decision = row.get("profiles", {}).get(profile, {})
        require(type(decision.get("eligible")) is bool, "budget composition eligibility must be explicit")
        if decision["eligible"]:
            buckets[(split, group)][row["position_band"]].append(row)
    chosen, limit = set(), config["maximum_rows_per_source_group"]
    for key in sorted(buckets):
        counts, cells, group_count = Counter(), set(), 0

        def take(quarter):
            nonlocal group_count
            available = [row for row in buckets[key][quarter]
                         if (row["source_conversation_id"], quarter) not in cells]
            if not available or group_count == limit:
                return False
            row = min(available, key=lambda item: (counts[item["source_conversation_id"]],
                source.sha_text(config["tie_break_seed"] + "|" + item["id"]), item["id"]))
            chosen.add(row["id"])
            cells.add((row["source_conversation_id"], quarter))
            counts[row["source_conversation_id"]] += 1
            group_count += 1
            return True

        if profile == "strict_4096":
            late_cells = {(row["source_conversation_id"], quarter) for quarter in LATE_QUARTERS
                          for row in buckets[key][quarter]}
            early_quarters = sum(bool(buckets[key][quarter]) for quarter in QUARTERS if quarter not in LATE_QUARTERS)
            require(len(late_cells) + early_quarters <= limit,
                    "strict late-cell preservation exceeds group cap; policy review required")
        for quarter in QUARTERS:
            take(quarter)
        if profile == "strict_4096":
            for quarter in QUARTERS[:2]:
                while take(quarter):
                    pass
            require(late_cells <= cells, "strict late-cell preservation failed")
        while group_count < limit:
            progress = False
            for quarter in QUARTERS:
                progress = take(quarter) or progress
            if not progress:
                break
    return chosen


def length_summary(rows, reserved_output):
    result = {}
    for split in (*source.SPLITS, "all"):
        subset = [row for row in rows if (split == "all" or row["split"] == split) and row["tokenizer_status"] == "encoded"]
        result[split] = {}
        for field in (*token.LENGTHS, "prefix_plus_reserved_output"):
            values = [row["prefix_length"] + reserved_output if field == "prefix_plus_reserved_output" else row[field] for row in subset]
            bins = Counter(next((f"le_{cap}" for cap in (4096, 8192, 16384, 32768, 65536, 69632)
                                 if value <= cap), "over_69632") for value in values)
            result[split][field] = {"count": len(values), "min": min(values) if values else None,
                **base.quantiles(values), "nonoverlapping_upper_bound_bins": dict(sorted(bins.items()))}
    return result


def coverage(rows, chosen):
    eligible_group_cells = {(row["split"], row["source_group_id"], row["position_band"]) for row in rows}
    chosen_group_cells = {(row["split"], row["source_group_id"], row["position_band"]) for row in chosen}
    late_cells = {(row["source_conversation_id"], row["position_band"]) for row in rows if row["position_band"] in LATE_QUARTERS}
    chosen_late_cells = {(row["source_conversation_id"], row["position_band"]) for row in chosen if row["position_band"] in LATE_QUARTERS}
    return {"eligible_group_quarters": len(eligible_group_cells), "selected_group_quarters": len(chosen_group_cells),
            "all_eligible_group_quarters_covered": eligible_group_cells == chosen_group_cells,
            "eligible_late_conversation_quarters": len(late_cells), "selected_late_conversation_quarters": len(chosen_late_cells),
            "all_eligible_late_conversation_quarters_covered": late_cells == chosen_late_cells,
            "eligible_late_rows": sum(row["position_band"] in LATE_QUARTERS for row in rows),
            "selected_late_rows": sum(row["position_band"] in LATE_QUARTERS for row in chosen)}


def prepare(*, runtime_budget_evidence, output_budget=4096, config=None, **inputs):
    requested_config = make_config(output_budget)
    config = validate_config(requested_config if config is None else config)
    require(encoded(config) == encoded(requested_config), "output budget disagrees with composition config")
    evidence = read_runtime_budget(runtime_budget_evidence)
    implementation_hash = source.sha_file(Path(__file__))
    verified = base.prepare(**inputs)
    tracked = dict(verified["tracked"])
    tracked[Path(runtime_budget_evidence)] = evidence["sha256"]
    tracked[Path(__file__)] = implementation_hash
    obsolete = {"eligible", "pool_eligible", "hold_reasons", "chosen", "selection_reason", "config_sha256"}
    rows = [{key: value for key, value in row.items() if key not in obsolete} for row in verified["rows"]]
    for row in rows:
        row["config_sha256"] = digest(config)
        row["prefix_plus_reserved_output"] = (row["prefix_length"] + config["reserved_output_tokens"]
                                               if row["tokenizer_status"] == "encoded" else None)
        row["profiles"] = {profile: budget_decision(row, profile, config) for profile in PROFILES}
    profiles = {}
    for profile in PROFILES:
        chosen = select_rows(rows, profile, config)
        cells = {(row["source_conversation_id"], row["position_band"]) for row in rows if row["id"] in chosen}
        for row in rows:
            decision = row["profiles"][profile]
            decision["chosen"] = row["id"] in chosen
            decision["selection_reason"] = ("stratified_selected" if decision["chosen"] else "held" if not decision["eligible"] else
                "conversation_quarter_cap" if (row["source_conversation_id"], row["position_band"]) in cells else "source_group_cap")
        eligible = [row for row in rows if row["profiles"][profile]["eligible"]]
        selected = [row for row in rows if row["profiles"][profile]["chosen"]]
        covered = coverage(eligible, selected)
        require(covered["all_eligible_group_quarters_covered"], "eligible budget group-quarter coverage lost")
        require(profile != "strict_4096" or covered["all_eligible_late_conversation_quarters_covered"], "strict late-cell coverage lost")
        require(len(cells) == len(selected) and all(count <= config["maximum_rows_per_source_group"]
            for count in Counter(row["source_group_id"] for row in selected).values()), "budget composition cap violated")
        profiles[profile] = {"pool": base.summarize(eligible), "selected": base.summarize(selected), "coverage": covered,
            "token_lengths": {"pool": length_summary(eligible, config["reserved_output_tokens"]),
                              "selected": length_summary(selected, config["reserved_output_tokens"])},
            "hold_reasons_overlapping": dict(sorted(Counter(reason for row in rows
                for reason in row["profiles"][profile]["hold_reasons"]).items()))}
    overlap = {}
    for split in (*source.SPLITS, "all"):
        ids = [{row["id"] for row in rows if (split == "all" or row["split"] == split) and row["profiles"][profile]["chosen"]}
               for profile in PROFILES]
        overlap[split] = {"runtime_budget_rows": len(ids[0]), "strict_4096_rows": len(ids[1]),
            "shared_rows": len(ids[0] & ids[1]), "runtime_budget_only_rows": len(ids[0] - ids[1]),
            "strict_4096_only_rows": len(ids[1] - ids[0]), "profiles_are_independent": False}
    prior = verified["summary"]
    summary = {"schema_version": SCHEMA, "status": "verified", "source_rows_examined": len(rows),
        "profiles": profiles, "selected_profile_overlap": overlap, "runtime_budget_evidence": evidence,
        **{key: config[key] for key in ("recorded_runtime_budget", "evaluation_budget", "output_budget_source",
                                      "evaluation_matches_recorded_runtime_budget", "reserved_output_tokens")},
        "tables": {"source_sft": base.summarize(rows), "content_admitted": base.summarize([r for r in rows if r["source_admitted"]])},
        **{key: prior[key] for key in ("admission_rules_recomputed", "previous_verified_events", "previous_history",
            "previous_events_sha256", "source_manifest_sha256", "verified_source_files")},
        "config_sha256": digest(config), **dict.fromkeys(FALSE_FLAGS, False), **dict.fromkeys(TRUE_FLAGS, True),
        "limitations": ["Group cap 16 is an experimental limit, not a representativeness guarantee; groups are not authenticated people.",
            "The two overlapping candidates are independently selected from the same development-exposed source, not independent tests.",
            "Recorded input, observed target, reserved output and full sequence lengths have separate meanings.",
            "Recorded input/output/context limits remain 65536/4096/69632; the requested 8192 output scenario is not a current server configuration claim.",
            "An 8192 reserved output within context 69632 limits the full input prefix to 61440 despite the recorded input cap 65536.",
            "Evaluation budgets are selection conditions, not training authorization or a training-feasibility measurement.",
            "Full original prefixes and targets are copied; no truncation, summary, split move or hold release fills an absent cell.",
            "A late source position does not establish a therapeutic ending or semantic completeness.",
            "Medical/procedural lexical flags trigger review, not a clinical harm judgment; all rows remain unapproved for human-review purposes.",
            "Original client/counselor targets are not caregiver-support gold targets; frozen metadata is bound without rereading the source database."]}
    require(all(source.sha_file(path) == value for path, value in tracked.items()), "budget composition inputs changed during preparation")
    return {"config": config, "rows": rows, "summary": summary, "tracked": tracked}


def new_events(summary, occurred_at):
    events = base.new_events(summary, occurred_at)
    for event in events:
        event["event_id"] = "budget_" + event["event_id"]
    return events


def verify_artifacts(output, plan):
    """Validate nested inventory, original bytes and recomputed typed decisions."""
    output = Path(output)
    require(output.is_dir() and not output.is_symlink(), "invalid budget composition output directory")
    manifest_path = output / "export_manifest.json"
    require(manifest_path.is_file() and not manifest_path.is_symlink(), "invalid budget composition manifest file")
    manifest = source.read_json(manifest_path)
    require(manifest.get("schema_version") == SCHEMA and manifest.get("status") == "verified"
            and all(manifest.get(key) is False for key in FALSE_FLAGS) and all(manifest.get(key) is True for key in TRUE_FLAGS),
            "invalid budget composition manifest or authorization")
    require(manifest.get("config_sha256") == digest(plan["config"])
            and manifest.get("source_manifest_sha256") == plan["summary"]["source_manifest_sha256"]
            and manifest.get("previous_events_sha256") == plan["summary"]["previous_events_sha256"]
            and encoded(manifest.get("runtime_budget_evidence")) == encoded(plan["summary"]["runtime_budget_evidence"])
            and all(encoded(manifest.get(key)) == encoded(plan["summary"][key]) for key in
                    ("recorded_runtime_budget", "evaluation_budget", "output_budget_source",
                     "evaluation_matches_recorded_runtime_budget", "reserved_output_tokens"))
            and encoded(manifest.get("input_sha256")) == encoded({str(path.resolve()): value for path, value in plan["tracked"].items()}),
            "budget composition input or metadata binding mismatch")
    names = ROOT_FILES | EXPORT_FILES
    require(isinstance(manifest.get("files"), dict) and set(manifest["files"]) == names, "budget composition file inventory mismatch")
    entries = list(output.rglob("*"))
    require(all(not path.is_symlink() for path in entries)
            and {path.relative_to(output).as_posix() for path in entries} == names | {"export_manifest.json", *PROFILES}
            and all((output / profile).is_dir() for profile in PROFILES), "budget composition unsafe nested file inventory")
    for name in names:
        path, item = output / name, manifest["files"][name]
        require(isinstance(item, dict) and path.is_file() and type(item.get("bytes")) is int
                and path.stat().st_size == item["bytes"] and source.sha_file(path) == item.get("sha256"),
                "budget composition artifact hash or size mismatch")
    require(encoded(source.read_json(output / "composition_config.json")) == encoded(plan["config"])
            and encoded(source.read_json(output / "summary.json")) == encoded(plan["summary"]), "budget composition config or summary changed")
    expected = {row["id"]: row for row in plan["rows"]}
    _, actual = token.read_ledger(output / "selection_ledger.jsonl.gz")
    require(encoded(actual) == encoded(expected), "budget composition ledger differs from recomputed decisions")
    require(encoded(list(history._json_rows(output / "evaluation_history_events.jsonl"))) ==
            encoded(new_events(plan["summary"], manifest.get("occurred_at"))), "budget composition history sidecar changed")
    for profile in PROFILES:
        for split in source.SPLITS:
            name = f"{profile}/{split}.jsonl.gz"
            selected = {row["id"] for row in plan["rows"] if row["split"] == split and row["profiles"][profile]["chosen"]}
            seen, order, uncompressed = set(), [], hashlib.sha256()
            with gzip.open(output / name, "rb") as stream:
                for line in stream:
                    row = json.loads(line)
                    rid = row.get("id") if isinstance(row, dict) else None
                    require(rid in selected and rid not in seen and hashlib.sha256(line).hexdigest() == expected[rid]["source_row_sha256"],
                            "budget composition original bytes or selection changed")
                    seen.add(rid)
                    order.append(rid)
                    uncompressed.update(line)
            require(seen == selected and order == sorted(selected), "budget composition export coverage or order mismatch")
            item = manifest["files"][name]
            require(type(item.get("rows")) is int and item["rows"] == len(seen), "budget composition export count mismatch")
            require(item.get("uncompressed_sha256") == uncompressed.hexdigest(), "budget composition uncompressed hash mismatch")
    require(all(source.sha_file(path) == value for path, value in plan["tracked"].items()), "budget composition inputs changed during export")
    return manifest


def build(*, output, occurred_at=None, **inputs):
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), "budget composition output already exists")
    for name in ("release", "frozen", "previous_candidate"):
        require(not output.resolve().is_relative_to(Path(inputs[name]).resolve()), "budget composition output overlaps input directory")
    plan = prepare(**inputs)
    occurred_at = occurred_at or datetime.now(timezone.utc).isoformat()
    events = new_events(plan["summary"], occurred_at)
    expected = {row["id"]: row for row in plan["rows"] if any(row["profiles"][profile]["chosen"] for profile in PROFILES)}
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
    with tempfile.TemporaryDirectory(prefix=".budget-composition-stage-", dir=output.parent) as temporary:
        staging = Path(temporary) / "artifact"
        staging.mkdir()
        (staging / "composition_config.json").write_bytes(encoded(plan["config"]))
        (staging / "summary.json").write_bytes(encoded(plan["summary"]))
        (staging / "evaluation_history_events.jsonl").write_bytes(b"".join(encoded(event) for event in events))
        base.write_gzip(staging / "selection_ledger.jsonl.gz", (encoded(row) for row in plan["rows"]))
        files = {}
        for profile in PROFILES:
            (staging / profile).mkdir()
            for split in source.SPLITS:
                name = f"{profile}/{split}.jsonl.gz"
                ids = sorted(rid for rid, row in expected.items() if row["split"] == split and row["profiles"][profile]["chosen"])
                base.write_gzip(staging / name, (original_lines[rid] for rid in ids))
                uncompressed = hashlib.sha256()
                for rid in ids:
                    uncompressed.update(original_lines[rid])
                files[name] = {"rows": len(ids), "uncompressed_sha256": uncompressed.hexdigest()}
        for name in sorted(ROOT_FILES | EXPORT_FILES):
            path = staging / name
            files.setdefault(name, {}).update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        manifest = {"schema_version": SCHEMA, "status": "verified", "occurred_at": occurred_at,
            "config_sha256": digest(plan["config"]), "source_manifest_sha256": plan["summary"]["source_manifest_sha256"],
            "previous_events_sha256": plan["summary"]["previous_events_sha256"], "runtime_budget_evidence": plan["summary"]["runtime_budget_evidence"],
            **{key: plan["summary"][key] for key in ("recorded_runtime_budget", "evaluation_budget", "output_budget_source",
                                                    "evaluation_matches_recorded_runtime_budget", "reserved_output_tokens")},
            "input_sha256": {str(path.resolve()): value for path, value in plan["tracked"].items()}, "files": files,
            **dict.fromkeys(FALSE_FLAGS, False), **dict.fromkeys(TRUE_FLAGS, True)}
        (staging / "export_manifest.json").write_bytes(encoded(manifest))
        verify_artifacts(staging, plan)
        # Claim a new empty destination without replacing any existing path.
        # Replacing this owned placeholder publishes the verified tree atomically.
        output.mkdir(exist_ok=False)
        claimed = output.stat()
        try:
            os.replace(staging, output)
        except BaseException:
            if output.is_dir() and not output.is_symlink() and output.stat().st_ino == claimed.st_ino:
                try:
                    output.rmdir()
                except OSError:
                    pass
            raise
    return plan["summary"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("release", "frozen", "admission-policy", "admission-rows", "selection-audit", "tokenizer-audit",
                 "row-lengths", "previous-candidate", "events", "runtime-budget-evidence", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--occurred-at", help="Timezone-qualified timestamp for reproducible publication")
    parser.add_argument("--output-budget", type=int, choices=OUTPUT_BUDGETS, default=4096,
                        help="Observed-target limit and output reservation; 8192 is an evaluation scenario, not recorded server state")
    parser.add_argument("--verify", action="store_true", help="Recompute both pools and verify an existing export")
    args = vars(parser.parse_args())
    output, verification, occurred_at = args.pop("output"), args.pop("verify"), args.pop("occurred_at")
    if verification:
        require(occurred_at is None, "--occurred-at is only valid when building")
        plan = prepare(**args)
        verify_artifacts(output, plan)
        result = plan["summary"]
    else:
        result = build(output=output, occurred_at=occurred_at, **args)
    print(json.dumps({"status": result["status"], "training_authorized": False,
        **{key: result[key] for key in ("recorded_runtime_budget", "evaluation_budget", "output_budget_source",
                                       "evaluation_matches_recorded_runtime_budget")},
        "profiles": {profile: {key: result["profiles"][profile][key] for key in ("selected", "coverage")}
                     for profile in PROFILES}, "selected_profile_overlap": result["selected_profile_overlap"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
