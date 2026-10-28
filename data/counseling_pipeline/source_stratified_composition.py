"""Coverage-preserving subsets of the verified short and full-prefix baselines.

Only early representatives may be removed. Original late representatives,
conversations, source groups and observed group quarters remain covered.
The 8192 output budget is an evaluation scenario, not a runtime change.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from fractions import Fraction
import gzip
import hashlib
import itertools
import json
import os
from pathlib import Path
import tempfile

from . import source_balanced_composition as balanced, source_budget_composition as budget
from . import source_composition as base, source_sft as source
from . import token_admission as token, evaluation_history as history


SCHEMA = "malssi-source-stratified-composition-v1"
PROFILES = ("strict_4096", "runtime_capped")
QUARTERS = base.QUARTERS
LATE = balanced.LATE_QUARTERS
CONFIG = {
    "schema_version": SCHEMA,
    "selection_policy": "verified_baseline_subsets_preserve_late_conversations_group_quarters",
    "tie_break_seed": "source-alternatives-discovery-20261016-v1",
    "balanced_config_sha256": base.digest(balanced.CONFIG),
    "budget_config_sha256": base.digest(budget.make_config(8192)),
    "output_budget": 8192,
    "maximum_rows_per_conversation_quarter": 1,
    "strict_base_group_cap": 10,
    "runtime_base_group_cap": 16,
    "group_cap_policy": "max_base_cap_and_mandatory_core_count_per_group",
    "core_policy": "all_late_then_one_per_early_group_quarter_maximizing_new_conversations_then_seeded_hash",
    "strict_policy": "core_then_cover_each_missing_baseline_conversation_then_min_count_waterfill_until_nine_concentration_checks_pass",
    "runtime_policy": "core_then_fill_to_explicit_group_caps_preferring_uncovered_conversations",
    "concentration_gate": "row_weighted_top5_top10_hhi_non_worsening_for_train_validation_all_exact_fraction",
    "panel_policy": "one_per_runtime_validation_late_cell_prefer_selected_strict_representative",
    "source_line_policy": "copy_original_bytes_with_entire_prefix_and_loss_mask",
    "source_admission_policy": "preserve_all_recomputed_holds",
    "medical_context_policy": "hold_for_review",
    "procedural_context_policy": "retain_with_review_flag",
    "training_authorized": False,
}
FALSE_FLAGS = ("training_authorized", "model_training_authorized", "full_training_authorized",
    "independent_test_eligible", "source_split_moved", "tokens_truncated", "human_review_established",
    "runtime_configuration_changed", "current_runtime_configuration_verified", "new_independent_split_created",
    "profiles_are_independent", "validation_panel_is_independent", "new_row_ids_added", "final_fixed_group_cap_is_16")
TRUE_FLAGS = ("development_exposed", "original_jsonl_lines_preserved", "all_baseline_late_representatives_preserved",
    "all_baseline_conversations_preserved", "all_baseline_group_quarters_preserved", "baseline_subsets_only",
    "row_concentration_non_worsening", "validation_panel_prefers_strict_representatives")
ROOT_FILES = balanced.ROOT_FILES
PANEL_FILE = "validation_late_stratified.jsonl.gz"
EXPORT_FILES = frozenset(f"{profile}/{split}.jsonl.gz" for profile in PROFILES for split in source.SPLITS) | {PANEL_FILE}
BINDINGS = (*balanced.BUDGET_FIELDS, "config_sha256", "balanced_config_sha256", "source_manifest_sha256",
    "previous_events_sha256", "baseline_export_manifest_sha256", "balanced_baseline_export_manifest_sha256",
    "balanced_baseline_history_events_sha256", "group_cap_policy")
require, encoded, digest = source.require, base.encoded, base.digest


def validate_config(config):
    require(encoded(config) == encoded(CONFIG), "unsupported stratified composition config")
    return json.loads(encoded(config))


def cell(row):
    return row["source_conversation_id"], row["position_band"]


def rank(row):
    return source.sha_text(CONFIG["tie_break_seed"] + "|" + row["id"]), row["id"]


def by_group(rows):
    result = defaultdict(list)
    for row in rows:
        result[row["source_group_id"]].append(row)
    return result


def concentration(rows, weight="rows"):
    """Exact rational row gates; target-token weights are descriptive only."""
    result = {}
    for split in (*source.SPLITS, "all"):
        counts = Counter()
        for row in rows:
            if split == "all" or row["split"] == split:
                counts[row["source_group_id"]] += 1 if weight == "rows" else row["target_length"]
        sizes = sorted(counts.values(), reverse=True)
        n = sum(sizes)
        result[split] = ((Fraction(sum(sizes[:5]), n), Fraction(sum(sizes[:10]), n),
                         Fraction(sum(value * value for value in sizes), n * n)) if n else (Fraction(0),) * 3)
    return result


def concentration_check(selected, baseline):
    now, before = concentration(selected), concentration(baseline)
    failed = {split: [name for name, value, old in zip(("top5_share", "top10_share", "hhi"), now[split], before[split])
                      if value > old] for split in now}
    return not any(failed.values()), failed


def core(rows):
    result = []
    for _, items in sorted(by_group(rows).items()):
        late = [row for row in items if row["position_band"] in LATE]
        result.extend(late)
        covered = {row["source_conversation_id"] for row in late}
        buckets = [[row for row in items if row["position_band"] == quarter] for quarter in QUARTERS[:2]]
        buckets = [bucket for bucket in buckets if bucket]
        if buckets:
            choice = min(itertools.product(*buckets), key=lambda combo:
                (-len({row["source_conversation_id"] for row in combo} - covered), tuple(sorted(rank(row) for row in combo))))
            result.extend(choice)
    return result


def preserve_all_conversations(rows, required):
    selected = {cell(row): row for row in required}
    covered = {row["source_conversation_id"] for row in required}
    missing = defaultdict(list)
    for row in rows:
        if row["source_conversation_id"] not in covered:
            missing[row["source_conversation_id"]].append(row)
    counts = Counter((row["source_group_id"], row["position_band"]) for row in required)
    for _, items in sorted(missing.items()):
        chosen = min(items, key=lambda row: (counts[(row["source_group_id"], row["position_band"])], rank(row)))
        require(chosen["position_band"] not in LATE, "mandatory late representative was lost")
        selected[cell(chosen)] = chosen
        counts[(chosen["source_group_id"], chosen["position_band"])] += 1
    return list(selected.values())


def fill(rows, required, caps):
    selected = {cell(row): row for row in required}
    counts = Counter(row["source_group_id"] for row in required)
    require(all(count <= caps[group] for group, count in counts.items()), "mandatory core exceeds explicit group cap")
    candidates = [row for row in rows if row["position_band"] not in LATE and cell(row) not in selected]
    conversations = {row["source_conversation_id"] for row in required}
    quarter_counts = Counter((row["source_group_id"], row["position_band"]) for row in required)
    while candidates:
        available = [row for row in candidates if counts[row["source_group_id"]] < caps[row["source_group_id"]]]
        if not available:
            break
        chosen = min(available, key=lambda row: (counts[row["source_group_id"]] > 0,
            row["source_conversation_id"] in conversations, counts[row["source_group_id"]],
            quarter_counts[(row["source_group_id"], row["position_band"])], rank(row)))
        selected[cell(chosen)] = chosen
        counts[chosen["source_group_id"]] += 1
        conversations.add(chosen["source_conversation_id"])
        quarter_counts[(chosen["source_group_id"], chosen["position_band"])] += 1
        candidates.remove(chosen)
    return list(selected.values())


def waterfill_to_baseline(rows, required, caps):
    selected = {cell(row): row for row in required}
    candidates = [row for row in rows if row["position_band"] not in LATE and cell(row) not in selected]
    counts = Counter(row["source_group_id"] for row in required)
    conversations = {row["source_conversation_id"] for row in required}
    quarter_counts = Counter((row["source_group_id"], row["position_band"]) for row in required)
    require(all(count <= caps[group] for group, count in counts.items()), "mandatory core exceeds explicit group cap")
    steps, previous_failures = 0, None
    while True:
        passed, failures = concentration_check(list(selected.values()), rows)
        if passed:
            break
        previous_failures = failures
        available = [row for row in candidates if counts[row["source_group_id"]] < caps[row["source_group_id"]]]
        require(available, "concentration constraints cannot be met within group caps; policy review required")
        chosen = min(available, key=lambda row: (counts[row["source_group_id"]],
            row["source_conversation_id"] in conversations,
            quarter_counts[(row["source_group_id"], row["position_band"])], rank(row)))
        selected[cell(chosen)] = chosen
        counts[chosen["source_group_id"]] += 1
        conversations.add(chosen["source_conversation_id"])
        quarter_counts[(chosen["source_group_id"], chosen["position_band"])] += 1
        candidates.remove(chosen)
        steps += 1
    return list(selected.values()), {"added_to_core": steps, "mandatory_core_passed_all_nine_checks": steps == 0,
        "first_passing_point_on_deterministic_path": True, "previous_row_count": len(selected) - 1 if steps else None,
        "previous_point_failed_metrics": previous_failures, "failed_metrics": failures}


def validate_selection(baseline, selected, caps):
    ids = {row["id"] for row in selected}
    old_ids = {row["id"] for row in baseline}
    require(len(ids) == len(selected) == len({cell(row) for row in selected}) and ids <= old_ids,
            "selection added IDs or duplicated a conversation quarter")
    require({row["id"] for row in selected if row["position_band"] in LATE} ==
            {row["id"] for row in baseline if row["position_band"] in LATE}, "late representative preservation failed")
    for fields in (("source_group_id",), ("source_conversation_id",), ("source_group_id", "position_band")):
        require({tuple(row[key] for key in fields) for row in selected} ==
                {tuple(row[key] for key in fields) for row in baseline}, "baseline coverage preservation failed")
    require(all(count <= caps[group] for group, count in Counter(row["source_group_id"] for row in selected).items()),
            "selected group cap exceeded")
    require(concentration_check(selected, baseline)[0], "relative concentration worsened; policy review required")


def select_rows(rows, config=None):
    config = validate_config(CONFIG if config is None else config)
    identities, groups, conversations = set(), {}, {}
    baselines = {profile: [] for profile in PROFILES}
    for row in rows:
        require(isinstance(row, dict) and all(isinstance(row.get(key), str) and row[key] for key in token.IDENTITY),
                "invalid stratified identity")
        rid, split, group, conv = (row[key] for key in token.IDENTITY)
        require(rid not in identities and split in source.SPLITS and row.get("position_band") in QUARTERS,
                "duplicate stratified identity or invalid split/quarter")
        identities.add(rid)
        require(groups.setdefault(group, split) == split, "stratified group crosses splits")
        require(conversations.setdefault(conv, (split, group)) == (split, group), "stratified conversation origin mismatch")
        require(isinstance(row.get("profiles"), dict) and set(row["profiles"]) == set(budget.PROFILES), "invalid original profiles")
        for profile in budget.PROFILES:
            decision = row["profiles"][profile]
            verified = budget.budget_decision(row, profile, budget.make_config(8192))
            require(isinstance(decision, dict) and type(decision.get("chosen")) is bool and
                encoded({key: decision.get(key) for key in ("eligible", "hold_reasons")}) ==
                encoded({key: verified[key] for key in ("eligible", "hold_reasons")}), "stratified eligibility differs from verified budget")
            require(not decision["chosen"] or decision["eligible"], "ineligible original selection")
        require(all(type(row.get(key)) is bool for key in ("chosen", "baseline_chosen", "added_late_representative")),
                "stratified baseline selection flags must be boolean")
        for profile, chosen in (("strict_4096", row["profiles"]["strict_4096"]["chosen"]), ("runtime_capped", row["chosen"])):
            source_profile = "strict_4096" if profile == "strict_4096" else "runtime_budget"
            if chosen:
                require(row["profiles"][source_profile]["eligible"], "ineligible stratified baseline row")
                baselines[profile].append(row)
    selections = {}
    for profile, baseline in baselines.items():
        require(len({cell(row) for row in baseline}) == len(baseline), "duplicate baseline cell")
        required = core(baseline)
        if profile == "strict_4096":
            required = preserve_all_conversations(baseline, required)
        nominal = config["strict_base_group_cap"] if profile == "strict_4096" else config["runtime_base_group_cap"]
        counts = Counter(row["source_group_id"] for row in required)
        caps = {group: max(nominal, counts[group]) for group in by_group(baseline)}
        if profile == "strict_4096":
            chosen, stopping = waterfill_to_baseline(baseline, required, caps)
        else:
            chosen, stopping = fill(baseline, required, caps), None
        validate_selection(baseline, chosen, caps)
        selections[profile] = {"baseline_ids": {row["id"] for row in baseline}, "core_ids": {row["id"] for row in required},
            "chosen_ids": {row["id"] for row in chosen}, "caps": caps, "nominal_cap": nominal, "stopping": stopping}
    return selections


def panel_rows(rows, selections):
    main_rows = [row for row in rows if row["id"] in selections["runtime_capped"]["chosen_ids"]
                 and row["split"] == "validation" and row["position_band"] in LATE]
    strict_rows = [row for row in rows if row["id"] in selections["strict_4096"]["chosen_ids"]
                   and row["split"] == "validation" and row["position_band"] in LATE]
    main, strict = ({cell(row): row for row in subset} for subset in (main_rows, strict_rows))
    require(len(main) == len(main_rows) and len(strict) == len(strict_rows), "panel source duplicates a conversation quarter")
    require(strict.keys() <= main.keys(), "strict validation late cell is missing from runtime baseline")
    panel = {**main, **strict}
    require(len({row["id"] for row in panel.values()}) == len(panel), "panel duplicates a row or cell")
    return list(panel.values())


def summarize(rows):
    result = balanced.summarize(rows)
    metrics = {weight: concentration(rows, weight) for weight in ("rows", "target_tokens")}
    for split in (*source.SPLITS, "all"):
        subset = [row for row in rows if split == "all" or row["split"] == split]
        result[split]["concentration"] = {}
        for weight, table in metrics.items():
            top5, top10, hhi = table[split]
            result[split]["concentration"][weight] = {"top5_percent": float(100 * top5) if subset else None,
                "top10_percent": float(100 * top10) if subset else None, "hhi": float(hhi) if subset else None,
                "effective_group_count": float(1 / hhi) if hhi else None}
        result[split]["group_quarters"] = len({(row["source_group_id"], row["position_band"]) for row in subset})
        result[split]["late_cells"] = sum(row["position_band"] in LATE for row in subset)
        result[split]["input_repetition"] = {"prefix_token_sum": sum(row["prefix_length"] for row in subset),
            "input_unique_conversations": len({row["source_conversation_id"] for row in subset}),
            "repeated_conversation_rows": len(subset) - len({row["source_conversation_id"] for row in subset}),
            "interpretation": "Full-prefix token totals include repeated source context; they are not independent tokens or semantic duplicate estimates."}
        result[split]["target_length"] = balanced.numeric(row["target_length"] for row in subset)
    return result


def overlap(left, right):
    ids_left, ids_right = {row["id"] for row in left}, {row["id"] for row in right}
    cells_left, cells_right = {cell(row) for row in left}, {cell(row) for row in right}
    return {"left_rows": len(left), "right_rows": len(right), "shared_ids": len(ids_left & ids_right),
        "shared_cells": len(cells_left & cells_right), "left_ids_subset_of_right": ids_left <= ids_right,
        "left_cells_subset_of_right": cells_left <= cells_right, "independent": False}


def prepare(*, baseline, balanced_baseline, output_budget=8192, config=None, **inputs):
    require(type(output_budget) is int and output_budget == 8192, "stratified composition requires output budget 8192")
    config = validate_config(CONFIG if config is None else config)
    balanced_baseline = Path(balanced_baseline)
    implementation_hash = source.sha_file(Path(__file__))
    manifest_hash = source.sha_file(balanced_baseline / "export_manifest.json")
    verified = balanced.prepare(baseline=baseline, output_budget=8192, **inputs)
    manifest = balanced.verify_artifacts(balanced_baseline, verified)
    tracked = dict(verified["tracked"])
    tracked[Path(__file__)] = implementation_hash
    tracked[balanced_baseline / "export_manifest.json"] = manifest_hash
    for name, item in manifest["files"].items():
        tracked[balanced_baseline / name] = item["sha256"]
    selections = select_rows(verified["rows"], config)
    panel = panel_rows(verified["rows"], selections)
    panel_ids = {row["id"] for row in panel}
    rows = []
    for original in verified["rows"]:
        row = {**original, "balanced_config_sha256": original["config_sha256"], "config_sha256": digest(config)}
        row["selection_v5"] = {}
        for profile, choice in selections.items():
            in_baseline, in_core, chosen = (row["id"] in choice[key] for key in ("baseline_ids", "core_ids", "chosen_ids"))
            row["selection_v5"][profile] = {"baseline_chosen": in_baseline, "core_chosen": in_core, "chosen": chosen,
                "reason": "mandatory_core" if in_core else "selected_early_fill" if chosen else "early_removed" if in_baseline else "outside_verified_baseline",
                "group_cap": choice["caps"].get(row["source_group_id"])}
        panel_chosen = row["id"] in panel_ids
        row["validation_late_stratified"] = {"chosen": panel_chosen,
            "source_profile": ("strict_4096" if row["id"] in selections["strict_4096"]["chosen_ids"] else "runtime_capped") if panel_chosen else None,
            "sequence_band": ("le_4096" if row["sequence_length"] <= 4096 else "over_4096") if panel_chosen else None}
        rows.append(row)
    rows.sort(key=lambda row: (row["split"], row["id"]))
    tables, selected_rows = {}, {}
    for profile, choice in selections.items():
        old, required, chosen = ([row for row in rows if row["id"] in choice[key]] for key in ("baseline_ids", "core_ids", "chosen_ids"))
        selected_rows[profile] = chosen
        caps = choice["caps"]
        tables[profile] = {"baseline": summarize(old), "core": summarize(required), "selected": summarize(chosen),
            "coverage": budget.coverage(old, chosen), "baseline_rows_removed": len(old) - len(chosen),
            "baseline_conversations_removed": 0, "baseline_groups_removed": 0, "baseline_group_quarters_removed": 0,
            "baseline_late_representatives_removed": 0, "new_row_ids_added": 0,
            "all_nine_row_concentration_checks_passed": concentration_check(chosen, old)[0], "stopping": choice["stopping"],
            "group_caps": {"base_cap": choice["nominal_cap"], "maximum_effective_cap": max(caps.values(), default=0),
                "exception_groups": sum(value > choice["nominal_cap"] for value in caps.values()),
                "exception_cap_histogram": dict(sorted(Counter(value for value in caps.values() if value > choice["nominal_cap"]).items()))}}
    panel = [row for row in rows if row["id"] in panel_ids]
    strict_eligible_validation = [row for row in rows if row["split"] == "validation" and row["profiles"]["strict_4096"]["eligible"]]
    prior = verified["summary"]
    summary = {"schema_version": SCHEMA, "status": "verified", "source_rows_examined": len(rows), "config_sha256": digest(config),
        "balanced_config_sha256": digest(balanced.CONFIG), "profiles": tables, "validation_late_stratified": summarize(panel),
        "overlap": {"strict_to_runtime": overlap(selected_rows["strict_4096"], selected_rows["runtime_capped"]),
            "panel_to_runtime": overlap(panel, selected_rows["runtime_capped"]), "panel_to_strict": overlap(panel, selected_rows["strict_4096"])},
        "panel_source_profiles": dict(sorted(Counter(row["validation_late_stratified"]["source_profile"] for row in panel).items())),
        "panel_sequence_bands": dict(sorted(Counter(row["validation_late_stratified"]["sequence_band"] for row in panel).items())),
        "strict_structural_limits": {"validation_eligible_rows_by_quarter": {q: sum(row["position_band"] == q for row in strict_eligible_validation) for q in QUARTERS},
            "validation_eligible_late_cells": len({cell(row) for row in strict_eligible_validation if row["position_band"] in LATE}),
            "validation_q4_is_structural_zero_under_unchanged_holds_split_full_prefix_and_4096": not any(row["position_band"] == QUARTERS[-1] for row in strict_eligible_validation)},
        "baseline_export_manifest_sha256": prior["baseline_export_manifest_sha256"],
        "balanced_baseline_export_manifest_sha256": manifest_hash,
        "balanced_baseline_history_events_sha256": tracked[balanced_baseline / "evaluation_history_events.jsonl"],
        "balanced_baseline_files_bound": len(manifest["files"]) + 1,
        "group_cap_policy": config["group_cap_policy"],
        "hold_reasons_overlapping": {profile: dict(sorted(Counter(reason for row in rows for reason in row["profiles"][profile]["hold_reasons"]).items())) for profile in budget.PROFILES},
        **{key: prior[key] for key in (*balanced.BUDGET_FIELDS, "admission_rules_recomputed", "previous_verified_events", "previous_history",
            "previous_events_sha256", "source_manifest_sha256", "verified_source_files")},
        **dict.fromkeys(FALSE_FLAGS, False), **dict.fromkeys(TRUE_FLAGS, True),
        "limitations": ["Reduced early row counts improve ratios without adding late cases; the strict validation late capacity remains limited by unchanged full-prefix lengths and holds.",
            "All retained baseline conversations and observed group quarters remain covered, but some early representatives are removed; coverage does not establish clinical completeness.",
            "Row-weighted concentration is a selection constraint. Target-token-weighted concentration is reported separately and is not guaranteed to improve.",
            "The two profiles and the validation panel overlap; the panel prefers strict representatives and need not be an exact ID subset of the runtime candidate. None is an independent test split.",
            "Group caps explicitly rise to mandatory core counts; source groups are not verified independent people, and quarters are not clinical stages.",
            "Recorded limits remain 65536/4096/69632; the requested output8192 scenario leaves effective input61440 and is not a runtime configuration claim.",
            "Original bytes, full prefixes, target-only masks, source splits and admission holds remain unchanged; no human approval or training authorization is established."]}
    require(all(source.sha_file(path) == value for path, value in tracked.items()), "stratified inputs changed during preparation")
    return {"config": config, "rows": rows, "summary": summary, "tracked": tracked}


def new_events(summary, occurred_at):
    events = base.new_events(summary, occurred_at)
    for event in events:
        event["event_id"] = "stratified_" + event["event_id"]
    return events


def export_ids(rows, name):
    require(name in EXPORT_FILES, "unknown stratified export")
    if name == PANEL_FILE:
        return {row["id"] for row in rows if row["validation_late_stratified"]["chosen"]}
    profile, filename = name.split("/")
    split = filename.split(".")[0]
    return {row["id"] for row in rows if row["selection_v5"][profile]["chosen"] and row["split"] == split}


def verify_artifacts(output, plan):
    output = Path(output)
    require(output.is_dir() and not output.is_symlink(), "invalid stratified output directory")
    path = output / "export_manifest.json"
    require(path.is_file() and not path.is_symlink(), "invalid stratified manifest file")
    manifest = source.read_json(path)
    require(manifest.get("schema_version") == SCHEMA and manifest.get("status") == "verified"
        and all(manifest.get(key) is False for key in FALSE_FLAGS) and all(manifest.get(key) is True for key in TRUE_FLAGS),
        "invalid stratified manifest or authorization")
    require(all(encoded(manifest.get(key)) == encoded(plan["summary"][key]) for key in BINDINGS)
        and encoded(manifest.get("input_sha256")) == encoded({str(path.resolve()): value for path, value in plan["tracked"].items()}),
        "stratified input or metadata binding mismatch")
    names = ROOT_FILES | EXPORT_FILES
    inventory = {path.relative_to(output).as_posix() for path in output.rglob("*")}
    require(isinstance(manifest.get("files"), dict) and set(manifest["files"]) == names
        and inventory == names | {"export_manifest.json"} | set(PROFILES), "stratified file inventory mismatch")
    require(all((output / profile).is_dir() and not (output / profile).is_symlink() for profile in PROFILES),
            "invalid stratified profile directory")
    for name in names:
        path, item = output / name, manifest["files"][name]
        require(isinstance(item, dict) and path.is_file() and not path.is_symlink() and type(item.get("bytes")) is int
            and path.stat().st_size == item["bytes"] and source.sha_file(path) == item.get("sha256"), "stratified artifact hash or size mismatch")
    require(encoded(source.read_json(output / "composition_config.json")) == encoded(plan["config"])
        and encoded(source.read_json(output / "summary.json")) == encoded(plan["summary"]), "stratified config or summary changed")
    expected = {row["id"]: row for row in plan["rows"]}
    _, actual = token.read_ledger(output / "selection_ledger.jsonl.gz")
    require(encoded(actual) == encoded(expected), "stratified ledger differs from recomputed decisions")
    require(encoded(list(history._json_rows(output / "evaluation_history_events.jsonl"))) ==
        encoded(new_events(plan["summary"], manifest.get("occurred_at"))), "stratified history sidecar changed")
    for name in EXPORT_FILES:
        selected = export_ids(plan["rows"], name)
        seen, order, uncompressed = set(), [], hashlib.sha256()
        with gzip.open(output / name, "rb") as stream:
            for line in stream:
                row = json.loads(line)
                rid = row.get("id") if isinstance(row, dict) else None
                require(rid in selected and rid not in seen and hashlib.sha256(line).hexdigest() == expected[rid]["source_row_sha256"],
                        "stratified original bytes or selection changed")
                seen.add(rid)
                order.append(rid)
                uncompressed.update(line)
        require(seen == selected and order == sorted(selected), "stratified export coverage or order mismatch")
        item = manifest["files"][name]
        require(type(item.get("rows")) is int and item["rows"] == len(seen), "stratified export count mismatch")
        require(item.get("uncompressed_sha256") == uncompressed.hexdigest(), "stratified uncompressed hash mismatch")
    require(all(source.sha_file(path) == value for path, value in plan["tracked"].items()), "stratified inputs changed during export")
    return manifest


def build(*, output, occurred_at=None, **inputs):
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), "stratified output already exists")
    for name in ("release", "frozen", "previous_candidate", "baseline", "balanced_baseline"):
        require(not output.resolve().is_relative_to(Path(inputs[name]).resolve()), "stratified output overlaps input directory")
    plan = prepare(**inputs)
    occurred_at = occurred_at or datetime.now(timezone.utc).isoformat()
    events = new_events(plan["summary"], occurred_at)
    ids = set().union(*(export_ids(plan["rows"], name) for name in EXPORT_FILES))
    expected = {row["id"]: row for row in plan["rows"] if row["id"] in ids}
    lines = {}
    for split in source.SPLITS:
        with gzip.open(Path(inputs["release"]) / f"conversation/{split}.jsonl.gz", "rb") as stream:
            for line in stream:
                row = json.loads(line)
                if row["id"] in expected:
                    require(hashlib.sha256(line).hexdigest() == expected[row["id"]]["source_row_sha256"], "source line changed during copying")
                    lines[row["id"]] = line
    require(lines.keys() == expected.keys(), "stratified source rows disappeared")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".stratified-composition-stage-", dir=output.parent) as temporary:
        staging = Path(temporary) / "artifact"
        staging.mkdir()
        for profile in PROFILES:
            (staging / profile).mkdir()
        (staging / "composition_config.json").write_bytes(encoded(plan["config"]))
        (staging / "summary.json").write_bytes(encoded(plan["summary"]))
        (staging / "evaluation_history_events.jsonl").write_bytes(b"".join(encoded(event) for event in events))
        base.write_gzip(staging / "selection_ledger.jsonl.gz", (encoded(row) for row in plan["rows"]))
        files = {}
        for name in EXPORT_FILES:
            selected = sorted(export_ids(plan["rows"], name))
            base.write_gzip(staging / name, (lines[rid] for rid in selected))
            uncompressed = hashlib.sha256()
            for rid in selected:
                uncompressed.update(lines[rid])
            files[name] = {"rows": len(selected), "uncompressed_sha256": uncompressed.hexdigest()}
        for name in ROOT_FILES | EXPORT_FILES:
            path = staging / name
            files.setdefault(name, {}).update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        manifest = {"schema_version": SCHEMA, "status": "verified", "occurred_at": occurred_at,
            **{key: plan["summary"][key] for key in BINDINGS}, "input_sha256": {str(path.resolve()): value for path, value in plan["tracked"].items()},
            "files": files, **dict.fromkeys(FALSE_FLAGS, False), **dict.fromkeys(TRUE_FLAGS, True)}
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
                 "row-lengths", "previous-candidate", "events", "runtime-budget-evidence", "baseline", "balanced-baseline", "output"):
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
    print(json.dumps({key: result[key] for key in ("status", "training_authorized", "evaluation_budget", "profiles",
        "validation_late_stratified", "overlap", "strict_structural_limits")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
