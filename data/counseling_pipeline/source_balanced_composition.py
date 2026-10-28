"""Preserve the verified 8192 baseline and append missing late source cells.

No early rows are deleted. The original group cap applies to the baseline;
the augmented group size is baseline rows plus one per missing late cell.
The validation panel is an overlapping subset, never an independent split.
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

from . import source_budget_composition as budget, source_composition as base
from . import source_sft as source, token_admission as token, evaluation_history as history


SCHEMA = "malssi-source-balanced-composition-v1"
LATE_QUARTERS = frozenset(base.QUARTERS[2:])
CONFIG = {
    "schema_version": SCHEMA,
    "selection_policy": "preserve_verified_baseline_then_append_one_per_missing_eligible_late_cell",
    "tie_break_seed": "source-balanced-composition-20261016-v1",
    "representative_order": ["seeded_id_sha256", "id"],
    "output_budget": 8192,
    "budget_config_sha256": budget.digest(budget.make_config(8192)),
    "baseline_maximum_rows_per_group": 16,
    "final_group_limit_policy": "baseline_group_rows_plus_missing_eligible_late_conversation_quarters",
    "final_fixed_group_cap_is_16": False,
    "maximum_rows_per_conversation_quarter": 1,
    "early_row_policy": "preserve_every_baseline_row_add_no_early_rows",
    "strict_4096_policy": "preserve_hash_bound_baseline_reference_without_copying_or_relabeling",
    "validation_late_audit_policy": "filter_augmented_validation_late_rows_same_split_overlapping_subset",
    "source_admission_policy": "preserve_all_recomputed_holds",
    "source_line_policy": "copy_original_bytes_with_entire_prefix_and_loss_mask",
    "medical_context_policy": "hold_for_review",
    "procedural_context_policy": "retain_with_review_flag",
    "training_authorized": False,
}
FALSE_FLAGS = ("training_authorized", "model_training_authorized", "full_training_authorized",
               "independent_test_eligible", "source_split_moved", "tokens_truncated", "human_review_established",
               "runtime_configuration_changed", "current_runtime_configuration_verified", "new_independent_split_created",
               "strict_4096_copied", "strict_4096_changed", "final_fixed_group_cap_is_16")
TRUE_FLAGS = ("development_exposed", "original_jsonl_lines_preserved", "all_baseline_rows_preserved",
              "all_eligible_late_cells_covered", "validation_late_audit_is_overlapping_subset")
ROOT_FILES = frozenset(("summary.json", "composition_config.json", "selection_ledger.jsonl.gz", "evaluation_history_events.jsonl"))
EXPORT_FILES = frozenset(("train.jsonl.gz", "validation.jsonl.gz", "validation_late_audit.jsonl.gz"))
BUDGET_FIELDS = ("runtime_budget_evidence", "recorded_runtime_budget", "evaluation_budget", "output_budget_source",
                 "evaluation_matches_recorded_runtime_budget", "reserved_output_tokens")
require, encoded, digest = source.require, base.encoded, base.digest


def validate_config(config):
    require(encoded(config) == encoded(CONFIG), "unsupported balanced composition config")
    return json.loads(encoded(config))


def cell(row):
    return row["source_conversation_id"], row["position_band"]


def select_rows(rows, config=None):
    config = validate_config(CONFIG if config is None else config)
    identities, groups, conversations, baseline, late = set(), {}, {}, {}, defaultdict(list)
    for row in rows:
        require(all(isinstance(row.get(key), str) and row[key] for key in token.IDENTITY), "invalid balanced composition identity")
        rid, split, group, conv = (row[key] for key in token.IDENTITY)
        require(rid not in identities and split in source.SPLITS and row.get("position_band") in base.QUARTERS,
                "duplicate balanced identity or invalid split/quarter")
        identities.add(rid)
        require(groups.setdefault(group, split) == split, "balanced source group crosses splits")
        require(conversations.setdefault(conv, (split, group)) == (split, group), "balanced source conversation origin mismatch")
        decision = row.get("profiles", {}).get("runtime_budget", {})
        verified = budget.budget_decision(row, "runtime_budget", budget.make_config(8192))
        require(type(decision.get("chosen")) is bool and encoded({key: decision.get(key) for key in ("eligible", "hold_reasons")}) ==
                encoded({key: verified[key] for key in ("eligible", "hold_reasons")}), "balanced eligibility differs from verified budget")
        if decision["chosen"]:
            require(decision["eligible"] and cell(row) not in baseline, "invalid or duplicate baseline cell")
            baseline[cell(row)] = row
        if decision["eligible"] and row["position_band"] in LATE_QUARTERS:
            late[cell(row)].append(row)
    require(all(count <= config["baseline_maximum_rows_per_group"]
                for count in Counter(row["source_group_id"] for row in baseline.values()).values()), "baseline group cap violated")
    additions = {min(items, key=lambda row: (source.sha_text(config["tie_break_seed"] + "|" + row["id"]), row["id"]))["id"]
                 for key, items in late.items() if key not in baseline}
    return {row["id"] for row in baseline.values()}, additions


def numeric(values):
    values = list(values)
    return {"count": len(values), "sum": sum(values), "min": min(values) if values else None, **base.quantiles(values)}


def summarize(rows):
    result = base.summarize(rows)
    for split in (*source.SPLITS, "all"):
        subset = [row for row in rows if split == "all" or row["split"] == split]
        counts = Counter(row["source_group_id"] for row in subset)
        result[split]["groups_exceeding_baseline_cap16"] = sum(count > 16 for count in counts.values())
        result[split]["top_group_percent"] = {str(k): 100 * sum(sorted(counts.values(), reverse=True)[:k]) / len(subset) if subset else None
                                             for k in (1, 5, 10)}
        result[split]["relative_position"] = numeric(row["relative_position"] for row in subset)
        target_total = sum(row["target_length"] for row in subset)
        late_target_total = sum(row["target_length"] for row in subset if row["position_band"] in LATE_QUARTERS)
        result[split]["target_token_sum"] = target_total
        result[split]["late_target_token_sum"] = late_target_total
        result[split]["late_target_token_percent"] = 100 * late_target_total / target_total if target_total else None
        result[split]["token_lengths_by_half"] = {}
        for half, late in (("early", False), ("late", True)):
            items = [row for row in subset if (row["position_band"] in LATE_QUARTERS) is late]
            result[split]["token_lengths_by_half"][half] = {key: numeric(row[key] for row in items) for key in
                ("target_length", "prefix_length", "sequence_length", "prefix_plus_reserved_output")}
            result[split]["token_lengths_by_half"][half]["sequence_length_bands"] = dict(sorted(Counter(row["length_tier"] for row in items).items()))
    return result


def prepare(*, baseline, output_budget=8192, config=None, **inputs):
    require(type(output_budget) is int and output_budget == 8192, "balanced composition requires output budget 8192")
    config = validate_config(CONFIG if config is None else config)
    baseline = Path(baseline)
    implementation_hash = source.sha_file(Path(__file__))
    baseline_manifest_hash = source.sha_file(baseline / "export_manifest.json")
    verified = budget.prepare(output_budget=8192, **inputs)
    baseline_manifest = budget.verify_artifacts(baseline, verified)
    tracked = dict(verified["tracked"])
    tracked[Path(__file__)] = implementation_hash
    tracked[baseline / "export_manifest.json"] = baseline_manifest_hash
    for name, item in baseline_manifest["files"].items():
        tracked[baseline / name] = item["sha256"]
    baseline_ids, added_ids = select_rows(verified["rows"], config)
    chosen_ids = baseline_ids | added_ids
    rows = []
    for original in verified["rows"]:
        row = {**original, "budget_config_sha256": original["config_sha256"], "config_sha256": digest(config),
            "baseline_chosen": original["id"] in baseline_ids, "added_late_representative": original["id"] in added_ids,
            "chosen": original["id"] in chosen_ids}
        row["selection_reason"] = ("baseline_preserved" if row["baseline_chosen"] else "added_late_cell_representative" if row["added_late_representative"] else
            "held" if not row["profiles"]["runtime_budget"]["eligible"] else "late_cell_already_covered" if row["position_band"] in LATE_QUARTERS
            else "early_not_selected_in_baseline")
        rows.append(row)
    rows.sort(key=lambda row: (row["split"], row["id"]))
    old = [row for row in rows if row["baseline_chosen"]]
    added = [row for row in rows if row["added_late_representative"]]
    selected = [row for row in rows if row["chosen"]]
    eligible = [row for row in rows if row["profiles"]["runtime_budget"]["eligible"]]
    covered = budget.coverage(eligible, selected)
    require(len({cell(row) for row in selected}) == len(selected) and covered["all_eligible_late_conversation_quarters_covered"],
            "balanced late coverage or unique cell contract failed")
    old_counts = Counter(row["source_group_id"] for row in old)
    added_counts = Counter(row["source_group_id"] for row in added)
    final_counts = Counter(row["source_group_id"] for row in selected)
    require(final_counts == old_counts + added_counts and all(row["position_band"] in LATE_QUARTERS for row in added),
            "balanced group growth or early preservation contract failed")
    panel = [row for row in selected if row["split"] == "validation" and row["position_band"] in LATE_QUARTERS]
    reference = {"path": str(baseline.resolve()), "export_manifest_sha256": tracked[baseline / "export_manifest.json"],
        "files": {f"strict_4096/{split}.jsonl.gz": baseline_manifest["files"][f"strict_4096/{split}.jsonl.gz"] for split in source.SPLITS},
        "selected": verified["summary"]["profiles"]["strict_4096"]["selected"],
        "coverage": verified["summary"]["profiles"]["strict_4096"]["coverage"], "copied": False, "changed": False}
    prior = verified["summary"]
    summary = {"schema_version": SCHEMA, "status": "verified", "source_rows_examined": len(rows), "config_sha256": digest(config),
        "tables": {"baseline": summarize(old), "added_late": summarize(added), "augmented": summarize(selected), "validation_late_audit": summarize(panel)},
        "coverage": covered, "strict_4096_baseline_reference": reference,
        "baseline_export_manifest_sha256": tracked[baseline / "export_manifest.json"],
        "baseline_history_events_sha256": tracked[baseline / "evaluation_history_events.jsonl"],
        "baseline_files_bound": len(baseline_manifest["files"]) + 1,
        "baseline_rows_removed": 0, "new_conversations": len({row["source_conversation_id"] for row in selected} - {row["source_conversation_id"] for row in old}),
        "group_growth_policy": config["final_group_limit_policy"], "observed_maximum_group_rows": max(final_counts.values(), default=0),
        "validation_late_audit_overlap": {"rows": len(panel), "shared_with_augmented_validation": len(panel),
            "additional_unique_rows": 0, "independent": False},
        "hold_reasons_overlapping": dict(sorted(Counter(reason for row in rows for reason in row["profiles"]["runtime_budget"]["hold_reasons"]).items())),
        **{key: prior[key] for key in (*BUDGET_FIELDS, "admission_rules_recomputed", "previous_verified_events", "previous_history",
            "previous_events_sha256", "source_manifest_sha256", "verified_source_files")},
        **dict.fromkeys(FALSE_FLAGS, False), **dict.fromkeys(TRUE_FLAGS, True),
        "limitations": ["The augmented candidate exceeds the baseline group cap 16 by an explicitly counted missing-late-cell addition; group concentration can increase.",
            "No baseline early rows are removed. An exact 50:50 half ratio is neither forced nor promised; row ratios and supervised target-token mass differ.",
            "Seeded ID ranking chooses representatives without shortest-length or within-quarter position optimization.",
            "The strict 4096 baseline stays separate and unchanged; the late validation panel can exceed 4096 and is a subset of the same development-exposed validation.",
            "All eligible late cells are covered, but this does not establish semantic ending coverage, clinical quality or population representativeness.",
            "Recorded limits remain 65536/4096/69632; evaluation output 8192 leaves effective input 61440 and is not a current server configuration claim.",
            "Original full prefixes, target-only masks, splits and admission holds are preserved; no human approval or training authorization is established."]}
    require(all(source.sha_file(path) == value for path, value in tracked.items()), "balanced composition inputs changed during preparation")
    return {"config": config, "rows": rows, "summary": summary, "tracked": tracked}


def new_events(summary, occurred_at):
    events = base.new_events(summary, occurred_at)
    for event in events:
        event["event_id"] = "balanced_" + event["event_id"]
    return events


def export_ids(rows, name):
    split = "train" if name == "train.jsonl.gz" else "validation"
    return {row["id"] for row in rows if row["chosen"] and row["split"] == split
            and (name != "validation_late_audit.jsonl.gz" or row["position_band"] in LATE_QUARTERS)}


def verify_artifacts(output, plan):
    output = Path(output)
    require(output.is_dir() and not output.is_symlink(), "invalid balanced output directory")
    manifest_path = output / "export_manifest.json"
    require(manifest_path.is_file() and not manifest_path.is_symlink(), "invalid balanced manifest file")
    manifest = source.read_json(manifest_path)
    require(manifest.get("schema_version") == SCHEMA and manifest.get("status") == "verified"
            and all(manifest.get(key) is False for key in FALSE_FLAGS) and all(manifest.get(key) is True for key in TRUE_FLAGS),
            "invalid balanced manifest or authorization")
    bindings = {key: plan["summary"][key] for key in (*BUDGET_FIELDS, "config_sha256", "source_manifest_sha256", "previous_events_sha256",
        "baseline_export_manifest_sha256", "baseline_history_events_sha256", "strict_4096_baseline_reference", "group_growth_policy")}
    require(all(encoded(manifest.get(key)) == encoded(value) for key, value in bindings.items())
            and encoded(manifest.get("input_sha256")) == encoded({str(path.resolve()): value for path, value in plan["tracked"].items()}),
            "balanced input or metadata binding mismatch")
    names = ROOT_FILES | EXPORT_FILES
    require(isinstance(manifest.get("files"), dict) and set(manifest["files"]) == names
            and {path.name for path in output.iterdir()} == names | {"export_manifest.json"}, "balanced file inventory mismatch")
    for name in names:
        path, item = output / name, manifest["files"][name]
        require(isinstance(item, dict) and not path.is_symlink() and path.is_file() and type(item.get("bytes")) is int
                and path.stat().st_size == item["bytes"] and source.sha_file(path) == item.get("sha256"), "balanced artifact hash or size mismatch")
    require(encoded(source.read_json(output / "composition_config.json")) == encoded(plan["config"])
            and encoded(source.read_json(output / "summary.json")) == encoded(plan["summary"]), "balanced config or summary changed")
    expected = {row["id"]: row for row in plan["rows"]}
    _, actual = token.read_ledger(output / "selection_ledger.jsonl.gz")
    require(encoded(actual) == encoded(expected), "balanced ledger differs from recomputed decisions")
    require(encoded(list(history._json_rows(output / "evaluation_history_events.jsonl"))) ==
            encoded(new_events(plan["summary"], manifest.get("occurred_at"))), "balanced history sidecar changed")
    for name in EXPORT_FILES:
        selected = export_ids(plan["rows"], name)
        seen, order, uncompressed = set(), [], hashlib.sha256()
        with gzip.open(output / name, "rb") as stream:
            for line in stream:
                row = json.loads(line)
                rid = row.get("id") if isinstance(row, dict) else None
                require(rid in selected and rid not in seen and hashlib.sha256(line).hexdigest() == expected[rid]["source_row_sha256"],
                        "balanced original bytes or selection changed")
                seen.add(rid)
                order.append(rid)
                uncompressed.update(line)
        require(seen == selected and order == sorted(selected), "balanced export coverage or order mismatch")
        item = manifest["files"][name]
        require(type(item.get("rows")) is int and item["rows"] == len(seen), "balanced export count mismatch")
        require(item.get("uncompressed_sha256") == uncompressed.hexdigest(), "balanced uncompressed hash mismatch")
    require(all(source.sha_file(path) == value for path, value in plan["tracked"].items()), "balanced inputs changed during export")
    return manifest


def build(*, output, occurred_at=None, **inputs):
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), "balanced output already exists")
    for name in ("release", "frozen", "previous_candidate", "baseline"):
        require(not output.resolve().is_relative_to(Path(inputs[name]).resolve()), "balanced output overlaps input directory")
    plan = prepare(**inputs)
    occurred_at = occurred_at or datetime.now(timezone.utc).isoformat()
    events = new_events(plan["summary"], occurred_at)
    expected = {row["id"]: row for row in plan["rows"] if row["chosen"]}
    lines = {}
    for split in source.SPLITS:
        with gzip.open(Path(inputs["release"]) / f"conversation/{split}.jsonl.gz", "rb") as stream:
            for line in stream:
                row = json.loads(line)
                if row["id"] in expected:
                    require(hashlib.sha256(line).hexdigest() == expected[row["id"]]["source_row_sha256"], "source line changed during copying")
                    lines[row["id"]] = line
    require(lines.keys() == expected.keys(), "balanced source rows disappeared")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".balanced-composition-stage-", dir=output.parent) as temporary:
        staging = Path(temporary) / "artifact"
        staging.mkdir()
        (staging / "composition_config.json").write_bytes(encoded(plan["config"]))
        (staging / "summary.json").write_bytes(encoded(plan["summary"]))
        (staging / "evaluation_history_events.jsonl").write_bytes(b"".join(encoded(event) for event in events))
        base.write_gzip(staging / "selection_ledger.jsonl.gz", (encoded(row) for row in plan["rows"]))
        files = {}
        for name in EXPORT_FILES:
            ids = sorted(export_ids(plan["rows"], name))
            base.write_gzip(staging / name, (lines[rid] for rid in ids))
            uncompressed = hashlib.sha256()
            for rid in ids:
                uncompressed.update(lines[rid])
            files[name] = {"rows": len(ids), "uncompressed_sha256": uncompressed.hexdigest()}
        for name in ROOT_FILES | EXPORT_FILES:
            path = staging / name
            files.setdefault(name, {}).update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        manifest = {"schema_version": SCHEMA, "status": "verified", "occurred_at": occurred_at,
            **{key: plan["summary"][key] for key in (*BUDGET_FIELDS, "config_sha256", "source_manifest_sha256", "previous_events_sha256",
                "baseline_export_manifest_sha256", "baseline_history_events_sha256", "strict_4096_baseline_reference", "group_growth_policy")},
            "input_sha256": {str(path.resolve()): value for path, value in plan["tracked"].items()}, "files": files,
            **dict.fromkeys(FALSE_FLAGS, False), **dict.fromkeys(TRUE_FLAGS, True)}
        (staging / "export_manifest.json").write_bytes(encoded(manifest))
        verify_artifacts(staging, plan)
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
                 "row-lengths", "previous-candidate", "events", "runtime-budget-evidence", "baseline", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--output-budget", type=int, choices=(8192,), default=8192)
    parser.add_argument("--occurred-at")
    parser.add_argument("--verify", action="store_true")
    args = vars(parser.parse_args())
    output, verify, occurred_at = args.pop("output"), args.pop("verify"), args.pop("occurred_at")
    if verify:
        require(occurred_at is None, "--occurred-at is only valid when building")
        plan = prepare(**args)
        verify_artifacts(output, plan)
        result = plan["summary"]
    else:
        result = build(output=output, occurred_at=occurred_at, **args)
    print(json.dumps({key: result[key] for key in ("status", "training_authorized", "evaluation_budget", "tables", "coverage",
                                                  "group_growth_policy", "observed_maximum_group_rows", "validation_late_audit_overlap")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
