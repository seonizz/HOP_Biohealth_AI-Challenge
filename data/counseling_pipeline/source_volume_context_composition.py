"""Recover prefix volume and procedural-context counts with a verified atomic batch.

Representatives keep every v7 cell and its target length. Search starts at v6;
strict split caps come from v5, runtime caps from v6. Final prefix concentration
cannot exceed v7. Intermediate metrics need not be monotone. No semantic or
global minimum-change guarantee follows from these metadata constraints.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
from fractions import Fraction
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from . import source_prefix_balanced_composition as previous
from . import source_token_balanced_composition as target_balance
from . import source_stratified_composition as stratified
from . import source_balanced_composition as balanced, source_budget_composition as budget
from . import source_composition as base, source_sft as source
from . import token_admission as token, evaluation_history as history


SCHEMA = "malssi-source-volume-context-composition-v1"
PROFILES, LATE = previous.PROFILES, previous.LATE
PROCEDURAL = "prior_assistant_procedural_pattern"
CONFIG = {
    "schema_version": SCHEMA,
    "selection_policy": "same_target_length_early_cell_joint_volume_context_atomic_batch",
    "tie_break_seed": "source-volume-context-discovery-20261016-v1",
    "prefix_balanced_config_sha256": base.digest(previous.CONFIG),
    "output_budget": 8192,
    "maximum_steps_per_profile": 60,
    "maximum_rows_per_conversation_quarter": 1,
    "initial_representatives": "v6",
    "selected_cells_and_target_length_reference": "v7",
    "prefix_concentration_reference": "v7",
    "profile_split_cap_reference": {"strict_4096": "v5", "runtime_capped": "v6"},
    "split_caps": "prefix_total_and_procedural_flag_row_count_le_reference_with_no_volume_lower_bound",
    "no_new_procedural_flag_cell_reference": "v6",
    "candidate_pool": "all_original_eligible_rows_in_selected_early_cells_with_identical_target_length_and_no_new_procedural_flag_vs_v6",
    "fixed_representatives": "all_selected_late_ids",
    "score_policy": "exact_fraction_sum_squared_positive_relative_excess_of_nine_v7_prefix_metrics_and_each_split_volume_and_procedural_count",
    "move_policy": "strict_score_decrease_then_fewer_changed_rows_vs_v7_then_absolute_prefix_delta_then_exact_position_distance_then_seeded_hash",
    "step_policy": "strict_joint_score_decrease_without_individual_metric_monotonicity",
    "stop_policy": "first_exact_joint_gate_pass_or_fail_closed_after_bounded_greedy_path",
    "validation_policy": "atomic_final_batch_gates_before_publish",
    "target_policy": "identical_target_length_per_v7_cell_and_exact_group_split_masses_and_length_distributions",
    "panel_policy": "copy_verified_v7_panel_compressed_bytes_unchanged",
    "source_line_policy": "copy_original_bytes_with_entire_prefix_and_loss_mask",
    "source_admission_policy": "preserve_all_recomputed_holds",
    "medical_context_policy": "hold_for_review",
    "procedural_context_policy": "retain_flagged_rows_with_review_status_subject_to_split_caps_and_no_new_vs_v6",
    "maximum_split_prefix_change_scope": "historical_v7_only_not_a_v8_constraint",
    "training_authorized": False,
}
FALSE_FLAGS = (*previous.FALSE_FLAGS, "intermediate_prefix_metrics_monotone_guaranteed",
    "v5_per_cell_procedural_no_new_guaranteed")
TRUE_FLAGS = (*(key for key in previous.TRUE_FLAGS if key != "split_prefix_change_within_bound"),
    "prefix_concentration_non_worsening_vs_v7", "split_prefix_and_procedural_caps_satisfied",
    "no_new_procedural_flag_cells_vs_v6", "atomic_final_batch_verified", "validation_panel_byte_identical_to_v7")
ROOT_FILES, PANEL_FILE, EXPORT_FILES = previous.ROOT_FILES, previous.PANEL_FILE, previous.EXPORT_FILES
BINDINGS = (*previous.BINDINGS, "prefix_balanced_config_sha256", "prefix_balanced_baseline_export_manifest_sha256",
    "prefix_balanced_baseline_history_events_sha256", "maximum_split_prefix_change_scope", "profile_split_cap_reference")
require, encoded, digest, cell = source.require, base.encoded, base.digest, stratified.cell
loads, metrics, passed = previous.loads, previous.metrics, previous.passed


def validate_config(config):
    require(encoded(config) == encoded(CONFIG), "unsupported volume-context composition config")
    return json.loads(encoded(config))


def rank(row):
    return source.sha_text(CONFIG["tie_break_seed"] + "|" + row["id"]), row["id"]


def prefix_totals(rows):
    return {split: sum(row["prefix_length"] for row in rows if row["split"] == split) for split in source.SPLITS}


def procedural_counts(rows):
    return {split: sum(PROCEDURAL in row["context_flags"] for row in rows if row["split"] == split) for split in source.SPLITS}


def excess(value, limit):
    return max(Fraction(0), Fraction(value) / Fraction(limit) - 1) ** 2 if limit else Fraction(value) ** 2


def score(current, flags, limits, volume_caps, flag_caps):
    result = sum((excess(value, limit) for split, values in metrics(current).items()
                  for value, limit in zip(values, limits[split])), Fraction(0))
    return result + sum((excess(sum(current[split].values()), volume_caps[split]) +
                        excess(flags[split], flag_caps[split]) for split in source.SPLITS), Fraction(0))


def validate_rows(rows):
    previous.validate_rows(rows)
    reasons = {"retained_late", "retained_early", "same_target_prefix_replacement", "early_replaced", "not_selected"}
    for row in rows:
        require(isinstance(row.get("selection_v7"), dict) and set(row["selection_v7"]) == set(PROFILES), "invalid v7 decisions")
        for profile in PROFILES:
            decision = row["selection_v7"][profile]
            require(isinstance(decision, dict) and set(decision) == {"baseline_chosen", "chosen", "reason"}
                and all(type(decision.get(key)) is bool for key in ("baseline_chosen", "chosen"))
                and isinstance(decision.get("reason"), str) and decision["reason"] in reasons, "invalid typed v7 decision")
            permitted = "strict_4096" if profile == "strict_4096" else "runtime_budget"
            require(decision["baseline_chosen"] is row["selection_v6"][profile]["chosen"]
                and (not decision["chosen"] or row["profiles"][permitted]["eligible"]), "ineligible or inconsistent v7 selection")


def reference_maps(baseline, initial, historical):
    maps = [{cell(row): row for row in rows} for rows in (baseline, initial, historical)]
    require(all(len(mapping) == len(rows) for mapping, rows in zip(maps, (baseline, initial, historical)))
            and maps[0].keys() == maps[1].keys() == maps[2].keys(), "baseline reference cells differ or duplicate")
    for key in maps[0]:
        require(all(maps[0][key][field] == mapping[key][field] for mapping in maps[1:]
                    for field in ("split", "source_group_id", "source_conversation_id", "position_band", "original_turn_count")),
                "baseline reference origin differs")
        require(maps[0][key]["target_length"] == maps[1][key]["target_length"], "v6 and v7 same-cell target length differs")
        if key[1] in LATE:
            require(maps[0][key]["id"] == maps[1][key]["id"] == maps[2][key]["id"], "baseline reference late IDs differ")
    return maps


def swap_options(rows, baseline, initial, profile):
    options = previous.swap_options(rows, baseline, profile)
    old = {cell(row): row for row in initial}
    require(old.keys() == options.keys(), "initial reference cells differ")
    result = {key: sorted((row for row in choices if PROCEDURAL not in row["context_flags"] or
                          PROCEDURAL in old[key]["context_flags"]), key=lambda row: row["id"])
              for key, choices in options.items()}
    require(all(any(row["id"] == old[key]["id"] for row in choices) for key, choices in result.items()),
            "v6 representative is not an allowed same-target no-new-flag option")
    return result


def validate_move(selected, replacement, initial, profile):
    require(profile in PROFILES and cell(replacement) in selected, "volume-context swap refers to an unknown profile or cell")
    old, original = selected[cell(replacement)], initial[cell(replacement)]
    require(replacement["position_band"] not in LATE and all(replacement[key] == old[key] for key in
        ("split", "source_group_id", "source_conversation_id", "position_band", "original_turn_count")), "swap changed origin/cell or late representative")
    require(type(replacement.get("target_length")) is int and replacement["target_length"] == old["target_length"], "swap changed target length")
    permitted = "strict_4096" if profile == "strict_4096" else "runtime_budget"
    require(budget.budget_decision(replacement, permitted, budget.make_config(8192))["eligible"], "swap selected held or over-budget row")
    require(PROCEDURAL not in replacement["context_flags"] or PROCEDURAL in original["context_flags"], "new procedural flag in v6 false cell")
    require(replacement["id"] != old["id"], "swap did not change a representative")
    return (replacement["split"], replacement["source_group_id"], replacement["prefix_length"] - old["prefix_length"],
            int(PROCEDURAL in replacement["context_flags"]) - int(PROCEDURAL in old["context_flags"]))


def joint_swap(baseline, initial, options, limits, volume_caps, flag_caps, profile, max_steps=None):
    max_steps = CONFIG["maximum_steps_per_profile"] if max_steps is None else max_steps
    require(type(max_steps) is int and max_steps >= 0, "invalid volume-context step limit")
    old, start = {cell(row): row for row in baseline}, {cell(row): row for row in initial}
    require(old.keys() == start.keys() == options.keys() and all(any(encoded(row) == encoded(start[key])
            for row in values) for key, values in options.items()), "initial representative is not an allowed option")
    selected, current, flags, trace = dict(start), loads(initial), procedural_counts(initial), []
    while score(current, flags, limits, volume_caps, flag_caps):
        require(len(trace) < max_steps, "volume-context greedy step limit reached; policy review required, global feasibility unknown")
        before_score, before_metrics, best = score(current, flags, limits, volume_caps, flag_caps), metrics(current), None
        for key, choices in options.items():
            previous_row = selected[key]
            for row in choices:
                if row["id"] == previous_row["id"]:
                    continue
                split, group = row["split"], row["source_group_id"]
                delta = row["prefix_length"] - previous_row["prefix_length"]
                flag_delta = int(PROCEDURAL in row["context_flags"]) - int(PROCEDURAL in previous_row["context_flags"])
                current[split][group] += delta
                flags[split] += flag_delta
                value, after_metrics = score(current, flags, limits, volume_caps, flag_caps), metrics(current)
                current[split][group] -= delta
                flags[split] -= flag_delta
                if value >= before_score:
                    continue
                changed = int(row["id"] != old[key]["id"]) - int(previous_row["id"] != old[key]["id"])
                tie = value, changed, abs(delta), target_balance.position_delta(previous_row, row), rank(row)
                nonincrease = all(value <= prior for part in before_metrics for value, prior in zip(after_metrics[part], before_metrics[part]))
                if best is None or tie < best[0]:
                    best = tie, key, row, nonincrease
        require(best is not None, "no improving single on fixed joint-score path; policy review required, global feasibility unknown")
        tie, key, row, nonincrease = best
        split, group, delta, flag_delta = validate_move(selected, row, start, profile)
        current[split][group] += delta
        flags[split] += flag_delta
        selected[key] = row
        trace.append({"step": len(trace) + 1, "split": split, "prefix_token_delta": delta,
            "procedural_flag_delta": flag_delta, "all_nine_prefix_metrics_nonincreasing": nonincrease,
            "score_exact": [tie[0].numerator, tie[0].denominator]})
    return sorted(selected.values(), key=lambda row: (row["split"], row["id"])), trace


def validate_selection(baseline, chosen, initial, historical, options, limits, profile):
    old, start, _ = reference_maps(baseline, initial, historical)
    new = {cell(row): row for row in chosen}
    require(profile in PROFILES and old.keys() == new.keys() and len(chosen) == len(new) == len({row["id"] for row in chosen}),
            "selected cells or row count changed")
    require(isinstance(limits, dict) and set(limits) == {*source.SPLITS, "all"}
        and all(isinstance(values, (tuple, list)) and len(values) == 3 and all(type(value) is Fraction for value in values)
                for values in limits.values()), "prefix ceilings must use exact Fraction values")
    require(encoded(target_balance.fraction_table(limits)) == encoded(target_balance.fraction_table(metrics(loads(baseline)))),
            "prefix ceilings must equal v7, not older relaxed limits")
    permitted = "strict_4096" if profile == "strict_4096" else "runtime_budget"
    for key, row in new.items():
        require(any(encoded(row) == encoded(option) for option in options[key]), "selected row is not an original allowed option")
        require(all(row[field] == old[key][field] for field in ("split", "source_group_id", "source_conversation_id", "position_band", "target_length")),
                "selected origin or same-cell target length changed")
        require(type(row["target_length"]) is int and budget.budget_decision(row, permitted, budget.make_config(8192))["eligible"],
                "selected row is held or over-budget")
        require(PROCEDURAL not in row["context_flags"] or PROCEDURAL in start[key]["context_flags"], "new procedural flag in v6 false cell")
    require({row["id"] for row in baseline if row["position_band"] in LATE} ==
        {row["id"] for row in chosen if row["position_band"] in LATE}, "late representative changed")
    require(Counter((row["split"], row["source_group_id"], row["position_band"]) for row in baseline) ==
        Counter((row["split"], row["source_group_id"], row["position_band"]) for row in chosen), "group-quarter row counts changed")
    require(target_balance.loads(baseline) == target_balance.loads(chosen) and
        Counter((row["split"], row["source_group_id"], row["target_length"]) for row in baseline) ==
        Counter((row["split"], row["source_group_id"], row["target_length"]) for row in chosen), "target group masses or length distributions changed")
    require(stratified.concentration(baseline) == stratified.concentration(chosen) and
        metrics(target_balance.loads(baseline)) == metrics(target_balance.loads(chosen)), "row or target concentration changed")
    reference = historical if CONFIG["profile_split_cap_reference"][profile] == "v5" else initial
    volume, caps, flags, flag_caps = prefix_totals(chosen), prefix_totals(reference), procedural_counts(chosen), procedural_counts(reference)
    require(all(volume[split] <= caps[split] for split in source.SPLITS), "final split prefix total exceeds reference cap")
    require(all(flags[split] <= flag_caps[split] for split in source.SPLITS), "final procedural count exceeds reference cap")
    require(passed(loads(chosen), limits), "final prefix concentration exceeds v7 ceiling")


def select_rows(rows, config=None):
    config = validate_config(CONFIG if config is None else config)
    validate_rows(rows)
    choices = {}
    for profile in PROFILES:
        baseline = [row for row in rows if row["selection_v7"][profile]["chosen"]]
        initial = [row for row in rows if row["selection_v6"][profile]["chosen"]]
        historical = [row for row in rows if row["selection_v5"][profile]["chosen"]]
        reference_maps(baseline, initial, historical)
        reference = historical if config["profile_split_cap_reference"][profile] == "v5" else initial
        options, limits = swap_options(rows, baseline, initial, profile), metrics(loads(baseline))
        chosen, trace = joint_swap(baseline, initial, options, limits, prefix_totals(reference), procedural_counts(reference), profile,
                                  config["maximum_steps_per_profile"])
        validate_selection(baseline, chosen, initial, historical, options, limits, profile)
        choices[profile] = {"baseline_ids": {row["id"] for row in baseline}, "initial_ids": {row["id"] for row in initial},
            "historical_ids": {row["id"] for row in historical}, "chosen_ids": {row["id"] for row in chosen}, "limits": limits, "trace": trace,
            "early_cells_with_same_target_no_new_alternatives": sum(len(items) > 1 for key, items in options.items() if key[1] not in LATE),
            "same_target_no_new_early_option_rows": sum(len(items) for key, items in options.items() if key[1] not in LATE)}
    return choices


def absolute_prefix_masses(rows):
    current = loads(rows)
    return {split: {"groups": len(values), "total_prefix_tokens": sum(values.values()), "top1_prefix_tokens": max(values.values(), default=0),
        "top5_prefix_tokens": sum(sorted(values.values(), reverse=True)[:5]), "top10_prefix_tokens": sum(sorted(values.values(), reverse=True)[:10])}
        for split, values in (*current.items(), ("all", current["train"] + current["validation"]))}


def change_summary(baseline, chosen, initial, historical, choice, profile):
    old, new, six, five = ({cell(row): row for row in rows} for rows in (baseline, chosen, initial, historical))
    swaps = [(old[key], new[key]) for key in old if old[key]["id"] != new[key]["id"]]
    before, after = metrics(loads(baseline)), metrics(loads(chosen))
    reference = CONFIG["profile_split_cap_reference"][profile]
    versions = {"v5": historical, "v6": initial, "v7": baseline, "selected": chosen}
    totals, flags = {name: prefix_totals(rows) for name, rows in versions.items()}, {name: procedural_counts(rows) for name, rows in versions.items()}
    return {"baseline_v7": previous.summarize(baseline), "initial_v6": previous.summarize(initial), "historical_v5": previous.summarize(historical),
        "selected": previous.summarize(chosen), "cap_reference": reference, "no_new_procedural_flag_cell_reference": "v6",
        "swapped_rows": len(swaps), "swapped_rows_by_split": dict(sorted(Counter(b["split"] for a, b in swaps).items())),
        "new_row_ids_added": len(choice["chosen_ids"] - choice["baseline_ids"]), "baseline_rows_removed": len(choice["baseline_ids"] - choice["chosen_ids"]),
        "steps": choice["trace"], "selection_steps": len(choice["trace"]), "termination": "first_exact_joint_gate_pass",
        "maximum_steps": CONFIG["maximum_steps_per_profile"], "changed_rows_are_globally_minimal": False,
        "all_nine_prefix_gates_passed": True, "all_nine_row_metrics_unchanged": True, "all_nine_target_metrics_unchanged": True,
        "strictly_improved_prefix_metrics_vs_v7": sum(value < prior for split in after for value, prior in zip(after[split], before[split])),
        "exact_prefix_ceiling": target_balance.fraction_table(choice["limits"]), "exact_selected_prefix_metrics": target_balance.fraction_table(after),
        "exact_target_metrics": target_balance.fraction_table(metrics(target_balance.loads(chosen))),
        "prefix_totals": {split: {**{name: values[split] for name, values in totals.items()}, "cap": totals[reference][split],
            "delta_vs_v7": totals["selected"][split] - totals["v7"][split], "cap_satisfied": totals["selected"][split] <= totals[reference][split]}
            for split in source.SPLITS},
        "procedural_context_counts": {split: {**{name: values[split] for name, values in flags.items()}, "cap": flags[reference][split],
            "cap_satisfied": flags["selected"][split] <= flags[reference][split]} for split in source.SPLITS},
        "new_procedural_flag_cells": {version: {split: sum(PROCEDURAL not in mapping[key]["context_flags"] and
            PROCEDURAL in new[key]["context_flags"] and new[key]["split"] == split for key in new) for split in source.SPLITS}
            for version, mapping in (("v5", five), ("v6", six), ("v7", old))},
        "procedural_flag_removals_vs_v7": {split: sum(PROCEDURAL in old[key]["context_flags"] and
            PROCEDURAL not in new[key]["context_flags"] and new[key]["split"] == split for key in new) for split in source.SPLITS},
        "absolute_prefix_group_masses": {name: absolute_prefix_masses(rows) for name, rows in versions.items()},
        "same_cell_target_lengths_preserved": True, "group_target_masses_preserved": True, "target_length_distribution_preserved": True,
        "swap_prefix_delta": balanced.numeric(b["prefix_length"] - a["prefix_length"] for a, b in swaps),
        "swap_target_delta": balanced.numeric(b["target_length"] - a["target_length"] for a, b in swaps),
        "swap_target_end_ordinal_delta": balanced.numeric(b["target_end_ordinal"] - a["target_end_ordinal"] for a, b in swaps),
        "swap_absolute_target_end_ordinal_delta": balanced.numeric(abs(b["target_end_ordinal"] - a["target_end_ordinal"]) for a, b in swaps),
        "swap_relative_position_delta": balanced.numeric(float(Fraction(b["target_end_ordinal"] - a["target_end_ordinal"], max(1, a["original_turn_count"] - 1))) for a, b in swaps),
        "early_cells_with_same_target_no_new_alternatives": choice["early_cells_with_same_target_no_new_alternatives"],
        "same_target_no_new_early_option_rows": choice["same_target_no_new_early_option_rows"]}


def prepare(*, baseline, balanced_baseline, stratified_baseline, token_balanced_baseline, prefix_balanced_baseline,
            output_budget=8192, config=None, **inputs):
    require(type(output_budget) is int and output_budget == 8192, "volume-context composition requires output budget 8192")
    config = validate_config(CONFIG if config is None else config)
    prefix_balanced_baseline = Path(prefix_balanced_baseline)
    implementation_hash = source.sha_file(Path(__file__))
    manifest_hash = source.sha_file(prefix_balanced_baseline / "export_manifest.json")
    verified = previous.prepare(baseline=baseline, balanced_baseline=balanced_baseline, stratified_baseline=stratified_baseline,
        token_balanced_baseline=token_balanced_baseline, output_budget=8192, **inputs)
    manifest = previous.verify_artifacts(prefix_balanced_baseline, verified)
    tracked = dict(verified["tracked"])
    tracked[Path(__file__)] = implementation_hash
    tracked[prefix_balanced_baseline / "export_manifest.json"] = manifest_hash
    for name, item in manifest["files"].items():
        tracked[prefix_balanced_baseline / name] = item["sha256"]
    choices, rows = select_rows(verified["rows"], config), []
    for original in verified["rows"]:
        row = {**original, "prefix_balanced_config_sha256": original["config_sha256"], "config_sha256": digest(config), "selection_v8": {}}
        for profile, choice in choices.items():
            old, chosen = row["id"] in choice["baseline_ids"], row["id"] in choice["chosen_ids"]
            row["selection_v8"][profile] = {"baseline_chosen": old, "chosen": chosen,
                "reason": "retained_late" if chosen and row["position_band"] in LATE else "retained_early" if chosen and old
                    else "same_target_volume_context_replacement" if chosen else "early_replaced" if old else "not_selected"}
        rows.append(row)
    rows.sort(key=lambda row: (row["split"], row["id"]))
    selected, tables = {}, {}
    for profile, choice in choices.items():
        old, chosen, initial, historical = ([row for row in rows if row["id"] in choice[key]] for key in
            ("baseline_ids", "chosen_ids", "initial_ids", "historical_ids"))
        selected[profile] = chosen
        tables[profile] = change_summary(old, chosen, initial, historical, choice, profile)
    panel, prior = [row for row in rows if row["validation_late_stratified"]["chosen"]], verified["summary"]
    inherited = (*previous.BINDINGS, "admission_rules_recomputed", "previous_verified_events", "previous_history", "verified_source_files",
                 "strict_structural_limits", "panel_source_profiles", "panel_sequence_bands", "hold_reasons_overlapping")
    summary = {**{key: prior[key] for key in inherited}, "schema_version": SCHEMA, "status": "verified", "source_rows_examined": len(rows),
        "config_sha256": digest(config), "prefix_balanced_config_sha256": digest(previous.CONFIG), "profiles": tables,
        "validation_late_stratified": previous.summarize(panel), "panel_sha256": tracked[prefix_balanced_baseline / PANEL_FILE],
        "maximum_split_prefix_change_scope": config["maximum_split_prefix_change_scope"], "profile_split_cap_reference": config["profile_split_cap_reference"],
        "overlap": {"strict_to_runtime": stratified.overlap(selected["strict_4096"], selected["runtime_capped"]),
            "panel_to_runtime": stratified.overlap(panel, selected["runtime_capped"]), "panel_to_strict": stratified.overlap(panel, selected["strict_4096"])},
        "prefix_balanced_baseline_export_manifest_sha256": manifest_hash,
        "prefix_balanced_baseline_history_events_sha256": tracked[prefix_balanced_baseline / "evaluation_history_events.jsonl"],
        "prefix_balanced_baseline_files_bound": len(manifest["files"]) + 1,
        **dict.fromkeys(FALSE_FLAGS, False), **dict.fromkeys(TRUE_FLAGS, True),
        "limitations": ["Same target length per v7 cell preserves group target mass and length distributions, not target text or clinical meaning. Target time and the complete original prefix can change together.",
            "Final strict split volume and procedural counts are capped by v5; runtime caps are v6. There is no lower bound on volume reduction. The inherited maximum_split_prefix_change value is historical v7 metadata only.",
            "No new procedural flag is measured against each v6 cell. Matching v5 aggregate counts does not guarantee v5 per-cell flag preservation. These lexical review indicators are not clinical or behavioral labels.",
            "The atomic final batch satisfies v7 prefix ceilings; individual search steps may worsen some metrics. The bounded strictly decreasing joint-score path can miss other paths and does not prove globally minimal changes.",
            "Late IDs, selected cells, conversations, groups, group-quarter counts, target metrics and original splits remain fixed. Strict validation late scarcity is unchanged.",
            "Recorded limits remain 65536/4096/69632; output limit and reservation8192 with effective input61440 is only the evaluation scenario. No tokenizer, model or live server is run.",
            "The overlapping profiles and unchanged panel are development-exposed, not independent tests. Source holds and review requirements persist; no human approval, semantic equivalence or training authorization is established."]}
    require(all(source.sha_file(path) == value for path, value in tracked.items()), "volume-context inputs changed during preparation")
    return {"config": config, "rows": rows, "summary": summary, "tracked": tracked, "panel_path": prefix_balanced_baseline / PANEL_FILE}


def new_events(summary, occurred_at):
    events = base.new_events(summary, occurred_at)
    for event in events:
        event["event_id"] = "volume_context_" + event["event_id"]
    return events


def export_ids(rows, name):
    require(name in EXPORT_FILES, "unknown volume-context export")
    if name == PANEL_FILE:
        return {row["id"] for row in rows if row["validation_late_stratified"]["chosen"]}
    profile, filename = name.split("/")
    return {row["id"] for row in rows if row["selection_v8"][profile]["chosen"] and row["split"] == filename.split(".")[0]}


def verify_artifacts(output, plan):
    output = Path(output)
    require(output.is_dir() and not output.is_symlink(), "invalid volume-context output directory")
    path = output / "export_manifest.json"
    require(path.is_file() and not path.is_symlink(), "invalid volume-context manifest file")
    manifest = source.read_json(path)
    require(manifest.get("schema_version") == SCHEMA and manifest.get("status") == "verified"
        and all(manifest.get(key) is False for key in FALSE_FLAGS) and all(manifest.get(key) is True for key in TRUE_FLAGS),
        "invalid volume-context manifest or authorization")
    require(all(encoded(manifest.get(key)) == encoded(plan["summary"][key]) for key in BINDINGS)
        and encoded(manifest.get("input_sha256")) == encoded({str(path.resolve()): value for path, value in plan["tracked"].items()}),
        "volume-context input or metadata binding mismatch")
    names = ROOT_FILES | EXPORT_FILES
    inventory = {path.relative_to(output).as_posix() for path in output.rglob("*")}
    require(isinstance(manifest.get("files"), dict) and set(manifest["files"]) == names
        and inventory == names | {"export_manifest.json"} | set(PROFILES), "volume-context file inventory mismatch")
    require(all((output / profile).is_dir() and not (output / profile).is_symlink() for profile in PROFILES), "invalid volume-context profile directory")
    for name in names:
        path, item = output / name, manifest["files"][name]
        require(isinstance(item, dict) and path.is_file() and not path.is_symlink() and type(item.get("bytes")) is int
            and path.stat().st_size == item["bytes"] and source.sha_file(path) == item.get("sha256"), "volume-context artifact hash or size mismatch")
    require(encoded(source.read_json(output / "composition_config.json")) == encoded(plan["config"])
        and encoded(source.read_json(output / "summary.json")) == encoded(plan["summary"]), "volume-context config or summary changed")
    expected = {row["id"]: row for row in plan["rows"]}
    _, actual = token.read_ledger(output / "selection_ledger.jsonl.gz")
    require(encoded(actual) == encoded(expected), "volume-context ledger differs from recomputed decisions")
    require(encoded(list(history._json_rows(output / "evaluation_history_events.jsonl"))) ==
        encoded(new_events(plan["summary"], manifest.get("occurred_at"))), "volume-context history sidecar changed")
    for name in EXPORT_FILES:
        selected = export_ids(plan["rows"], name)
        seen, order, uncompressed = set(), [], hashlib.sha256()
        with gzip.open(output / name, "rb") as stream:
            for line in stream:
                row = json.loads(line)
                rid = row.get("id") if isinstance(row, dict) else None
                require(rid in selected and rid not in seen and hashlib.sha256(line).hexdigest() == expected[rid]["source_row_sha256"],
                        "volume-context original bytes or selection changed")
                seen.add(rid)
                order.append(rid)
                uncompressed.update(line)
        require(seen == selected and order == sorted(selected), "volume-context export coverage or order mismatch")
        item = manifest["files"][name]
        require(type(item.get("rows")) is int and item["rows"] == len(seen), "volume-context export count mismatch")
        require(item.get("uncompressed_sha256") == uncompressed.hexdigest(), "volume-context uncompressed hash mismatch")
    require(source.sha_file(output / PANEL_FILE) == plan["summary"]["panel_sha256"], "validation panel compressed bytes changed")
    require(all(source.sha_file(path) == value for path, value in plan["tracked"].items()), "volume-context inputs changed during export")
    return manifest


def build(*, output, occurred_at=None, **inputs):
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), "volume-context output already exists")
    for name in ("release", "frozen", "previous_candidate", "baseline", "balanced_baseline", "stratified_baseline", "token_balanced_baseline", "prefix_balanced_baseline"):
        require(not output.resolve().is_relative_to(Path(inputs[name]).resolve()), "volume-context output overlaps input directory")
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
    require(lines.keys() == expected.keys(), "volume-context source rows disappeared")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".volume-context-stage-", dir=output.parent) as temporary:
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
            if name == PANEL_FILE:
                shutil.copyfile(plan["panel_path"], staging / name)
            else:
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
                 "row-lengths", "previous-candidate", "events", "runtime-budget-evidence", "baseline", "balanced-baseline", "stratified-baseline", "token-balanced-baseline", "prefix-balanced-baseline", "output"):
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
