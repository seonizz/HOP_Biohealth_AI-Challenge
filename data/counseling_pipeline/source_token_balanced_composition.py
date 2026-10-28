"""Replace early representatives by exact-token, same-cell paired transfers.

Every move preserves split token totals, cells, row counts and late IDs. This
bounded greedy path is not a global minimum-change or feasibility proof.
Original full-prefix bytes are copied; semantic equivalence is not established.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
from fractions import Fraction
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

from . import source_stratified_composition as stratified
from . import source_balanced_composition as balanced, source_budget_composition as budget
from . import source_composition as base, source_sft as source
from . import token_admission as token, evaluation_history as history


SCHEMA = "malssi-source-token-balanced-composition-v1"
PROFILES, LATE, QUARTERS = stratified.PROFILES, stratified.LATE, base.QUARTERS
CONFIG = {
    "schema_version": SCHEMA,
    "selection_policy": "same_early_cell_exact_token_paired_transfers",
    "tie_break_seed": "source-token-balance-discovery-20261016-v1",
    "stratified_config_sha256": base.digest(stratified.CONFIG),
    "output_budget": 8192,
    "maximum_steps_per_profile": 60,
    "maximum_rows_per_conversation_quarter": 1,
    "candidate_pool": "all_original_eligible_rows_in_selected_early_cells",
    "fixed_representatives": "all_selected_late_ids",
    "transfer_policy": "same_split_distinct_groups_equal_opposite_integer_delta_0_lt_2d_le_load_gap",
    "donor_policy": "union_of_split_and_overall_top10_sorted_by_descending_mass_then_group_id",
    "score_policy": "exact_fraction_sum_squared_positive_relative_excess_over_both_baseline_ceilings",
    "move_policy": "strict_score_decrease_then_fewer_changed_rows_then_delta_then_exact_position_distance_then_seeded_hash",
    "stop_policy": "first_exact_nine_metric_gate_pass_or_fail_closed_after_bounded_greedy_path",
    "concentration_gate": "target_top5_top10_hhi_for_train_validation_all_le_v5_and_historical",
    "row_and_token_total_policy": "preserve_all_cells_row_counts_and_each_split_target_token_sum_exactly",
    "panel_policy": "copy_verified_v5_panel_compressed_bytes_unchanged",
    "source_line_policy": "copy_original_bytes_with_entire_prefix_and_loss_mask",
    "source_admission_policy": "preserve_all_recomputed_holds",
    "medical_context_policy": "hold_for_review",
    "procedural_context_policy": "retain_with_review_flag",
    "training_authorized": False,
}
FALSE_FLAGS = ("training_authorized", "model_training_authorized", "full_training_authorized",
    "independent_test_eligible", "source_split_moved", "tokens_truncated", "human_review_established",
    "runtime_configuration_changed", "current_runtime_configuration_verified", "new_independent_split_created",
    "profiles_are_independent", "validation_panel_is_independent", "clinical_semantic_equivalence_established",
    "global_minimum_changes_proven", "global_feasibility_search_performed")
TRUE_FLAGS = ("development_exposed", "original_jsonl_lines_preserved", "all_baseline_late_representatives_preserved",
    "all_baseline_conversations_preserved", "all_baseline_group_quarters_preserved", "all_baseline_cells_preserved",
    "row_counts_and_group_counts_preserved", "row_concentration_unchanged", "split_target_token_totals_preserved",
    "target_concentration_non_worsening", "validation_panel_byte_identical_to_v5")
ROOT_FILES, PANEL_FILE, EXPORT_FILES = stratified.ROOT_FILES, stratified.PANEL_FILE, stratified.EXPORT_FILES
BINDINGS = (*balanced.BUDGET_FIELDS, "config_sha256", "stratified_config_sha256", "source_manifest_sha256",
    "previous_events_sha256", "baseline_export_manifest_sha256", "balanced_baseline_export_manifest_sha256",
    "stratified_baseline_export_manifest_sha256", "stratified_baseline_history_events_sha256", "panel_sha256")
require, encoded, digest, cell = source.require, base.encoded, base.digest, stratified.cell


def validate_config(config):
    require(encoded(config) == encoded(CONFIG), "unsupported token-balanced composition config")
    return json.loads(encoded(config))


def rank(row):
    return source.sha_text(CONFIG["tie_break_seed"] + "|" + row["id"]), row["id"]


def position_delta(old, new):
    require(old["original_turn_count"] == new["original_turn_count"], "same-cell source turn count changed")
    return Fraction(abs(new["target_end_ordinal"] - old["target_end_ordinal"]), max(1, old["original_turn_count"] - 1))


def loads(rows):
    result = {split: Counter() for split in source.SPLITS}
    for row in rows:
        result[row["split"]][row["source_group_id"]] += row["target_length"]
    return result


def metrics(values):
    result = {}
    for split, counts in (*values.items(), ("all", values["train"] + values["validation"])):
        sizes = sorted(counts.values(), reverse=True)
        total = sum(sizes)
        result[split] = ((Fraction(sum(sizes[:5]), total), Fraction(sum(sizes[:10]), total),
            Fraction(sum(value * value for value in sizes), total * total)) if total else (Fraction(0),) * 3)
    return result


def thresholds(baseline, historical):
    old, previous = metrics(loads(baseline)), metrics(loads(historical))
    return {split: tuple(min(a, b) for a, b in zip(old[split], previous[split])) for split in old}


def passed(values, limits):
    return all(value <= limit for split, values in metrics(values).items() for value, limit in zip(values, limits[split]))


def score(values, limits):
    return sum((max(Fraction(0), value / limit - 1) ** 2 if limit else value ** 2
                for split, values in metrics(values).items() for value, limit in zip(values, limits[split])), Fraction(0))


def donor_groups(values, split):
    # A stable top10 boundary is part of the policy, including equal-mass ties.
    local = sorted(values[split].items(), key=lambda item: (-item[1], item[0]))[:10]
    overall = sorted((values["train"] + values["validation"]).items(), key=lambda item: (-item[1], item[0]))[:10]
    return sorted({group for group, _ in local} | {group for group, _ in overall if group in values[split]})


def validate_rows(rows):
    identities, groups, conversations = set(), {}, {}
    for row in rows:
        require(isinstance(row, dict) and all(isinstance(row.get(key), str) and row[key] for key in token.IDENTITY),
                "invalid token-balanced identity")
        rid, split, group, conv = (row[key] for key in token.IDENTITY)
        require(rid not in identities and split in source.SPLITS and row.get("position_band") in QUARTERS,
                "duplicate token-balanced identity or invalid split/quarter")
        identities.add(rid)
        require(groups.setdefault(group, split) == split, "token-balanced group crosses splits")
        total, ordinal = row.get("original_turn_count"), row.get("target_end_ordinal")
        require(type(total) is int and type(ordinal) is int and 0 <= ordinal < total
                and base.position_band(ordinal, total) == row["position_band"], "invalid original source position")
        require(conversations.setdefault(conv, (split, group, total)) == (split, group, total), "token-balanced conversation origin mismatch")
        require(isinstance(row.get("profiles"), dict) and set(row["profiles"]) == set(budget.PROFILES), "invalid original profiles")
        for profile in budget.PROFILES:
            decision = row["profiles"][profile]
            verified = budget.budget_decision(row, profile, budget.make_config(8192))
            require(isinstance(decision, dict) and type(decision.get("chosen")) is bool and
                encoded({key: decision.get(key) for key in ("eligible", "hold_reasons")}) ==
                encoded({key: verified[key] for key in ("eligible", "hold_reasons")}), "token-balanced eligibility differs from verified budget")
            require(not decision["chosen"] or decision["eligible"], "ineligible original selection")
        require(all(type(row.get(key)) is bool for key in ("chosen", "baseline_chosen", "added_late_representative")),
                "original selection flags must be boolean")
        require(isinstance(row.get("selection_v5"), dict) and set(row["selection_v5"]) == set(PROFILES), "invalid v5 decisions")
        for profile in PROFILES:
            choice = row["selection_v5"][profile]
            require(isinstance(choice, dict) and all(type(choice.get(key)) is bool for key in ("baseline_chosen", "core_chosen", "chosen"))
                and isinstance(choice.get("reason"), str) and (choice.get("group_cap") is None or
                type(choice["group_cap"]) is int and choice["group_cap"] > 0), "invalid typed v5 decision")
            permitted = "strict_4096" if profile == "strict_4096" else "runtime_budget"
            prior_chosen = row["profiles"]["strict_4096"]["chosen"] if profile == "strict_4096" else row["chosen"]
            require(choice["baseline_chosen"] is prior_chosen and (not choice["core_chosen"] or choice["chosen"])
                and (not choice["chosen"] or choice["baseline_chosen"] and row["profiles"][permitted]["eligible"]),
                "ineligible or inconsistent v5 selection")


def swap_options(rows, baseline, profile):
    permitted = "strict_4096" if profile == "strict_4096" else "runtime_budget"
    original = {cell(row): row for row in baseline}
    require(len(original) == len(baseline), "duplicate baseline cell")
    result = defaultdict(list)
    for row in rows:
        key = cell(row)
        if key in original and row["position_band"] not in LATE and row["profiles"][permitted]["eligible"]:
            result[key].append(row)
    for key, row in original.items():
        if row["position_band"] in LATE:
            result[key] = [row]
        require(any(item["id"] == row["id"] for item in result[key]), "baseline representative is not an allowed option")
    return result


def validate_pair(selected, negative, positive, current, profile):
    """Validate a proposed move before any selected row or mass is mutated."""
    require(profile in PROFILES and all(cell(row) in selected for row in (negative, positive)),
            "paired swap refers to an unknown profile or selected cell")
    old_negative, old_positive = selected[cell(negative)], selected[cell(positive)]
    permitted = "strict_4096" if profile == "strict_4096" else "runtime_budget"
    for old, new in ((old_negative, negative), (old_positive, positive)):
        require(new["position_band"] not in LATE and cell(new) == cell(old)
            and all(new[key] == old[key] for key in ("split", "source_group_id", "source_conversation_id", "original_turn_count")),
            "paired swap changed cell/origin or late representative")
        require(budget.budget_decision(new, permitted, budget.make_config(8192))["eligible"], "paired swap selected held or over-budget row")
    split = negative["split"]
    high, low = negative["source_group_id"], positive["source_group_id"]
    require(split == positive["split"] and high != low, "paired swap must use distinct groups in the same split")
    d = old_negative["target_length"] - negative["target_length"]
    require(d > 0 and d == positive["target_length"] - old_positive["target_length"], "paired swap has unequal token deltas")
    require(2 * d <= current[split][high] - current[split][low], "paired transfer overshoots the load gap")
    return split, high, low, d


def paired_swap(baseline, options, limits, profile, max_steps=None):
    max_steps = CONFIG["maximum_steps_per_profile"] if max_steps is None else max_steps
    require(type(max_steps) is int and max_steps >= 0, "invalid paired step limit")
    initial = {cell(row): row for row in baseline}
    selected, current, trace = dict(initial), loads(baseline), []
    initial_totals = {split: sum(current[split].values()) for split in source.SPLITS}
    while not passed(current, limits):
        require(len(trace) < max_steps, "paired greedy step limit reached; policy review required, global feasibility unknown")
        before_score = score(current, limits)
        moves = {direction: defaultdict(dict) for direction in ("shorter", "longer")}
        for key, choices in options.items():
            old = selected[key]
            for row in choices:
                delta = row["target_length"] - old["target_length"]
                if not delta:
                    continue
                direction, d = ("shorter" if delta < 0 else "longer"), abs(delta)
                group = (row["split"], row["source_group_id"])
                changed = int(row["id"] != initial[key]["id"]) - int(old["id"] != initial[key]["id"])
                tie = changed, position_delta(old, row), rank(row)
                move = key, row, d, tie
                if d not in moves[direction][group] or tie < moves[direction][group][d][3]:
                    moves[direction][group][d] = move
        best = None
        for split in source.SPLITS:
            for high in donor_groups(current, split):
                negative = moves["shorter"].get((split, high), {})
                if not negative:
                    continue
                for low, mass in sorted(current[split].items()):
                    if current[split][high] <= mass:
                        continue
                    positive = moves["longer"].get((split, low), {})
                    deltas = sorted(d for d in negative.keys() & positive.keys() if 2 * d <= current[split][high] - mass)
                    if not deltas:
                        continue
                    def evaluate(d):
                        current[split][high] -= d
                        current[split][low] += d
                        value = score(current, limits)
                        current[split][high] += d
                        current[split][low] -= d
                        return value
                    best_score = evaluate(deltas[-1])
                    if best_score >= before_score:
                        continue
                    # For this same-split Robin-Hood transfer the exact deficit
                    # is monotone. Pick the smallest d attaining its best score.
                    left, right = 0, len(deltas) - 1
                    while left < right:
                        mid = (left + right) // 2
                        if evaluate(deltas[mid]) <= best_score:
                            right = mid
                        else:
                            left = mid + 1
                    d = deltas[left]
                    neg, pos = negative[d], positive[d]
                    key = (evaluate(d), neg[3][0] + pos[3][0], d, neg[3][1] + pos[3][1], neg[3][2], pos[3][2])
                    if best is None or key < best[0]:
                        best = key, neg, pos
        require(best is not None, "no improving pair on fixed top10 greedy path; policy review required, global feasibility unknown")
        key, neg, pos = best
        split, high, low, d = validate_pair(selected, neg[1], pos[1], current, profile)
        before = metrics(current)
        current[split][high] -= d
        current[split][low] += d
        selected[neg[0]], selected[pos[0]] = neg[1], pos[1]
        after = metrics(current)
        require(all(value <= old for part in before for value, old in zip(after[part], before[part])), "paired target concentration worsened")
        require(after[split][2] < before[split][2] and after["all"][2] < before["all"][2], "paired HHI did not strictly decrease")
        require({part: sum(current[part].values()) for part in source.SPLITS} == initial_totals, "paired token totals changed")
        require(key[0] < before_score, "paired score did not strictly decrease")
        trace.append({"step": len(trace) + 1, "split": split, "tokens_transferred": d,
            "target_totals_exactly_preserved": True, "all_nine_target_metrics_nonincreasing": True,
            "split_and_overall_hhi_strictly_decreased": True, "score_exact": [key[0].numerator, key[0].denominator]})
    return sorted(selected.values(), key=lambda row: (row["split"], row["id"])), trace


def validate_selection(baseline, selected, options, limits):
    before, after = {cell(row): row for row in baseline}, {cell(row): row for row in selected}
    require(len(before) == len(baseline) == len(after) == len(selected) == len({row["id"] for row in selected})
        and before.keys() == after.keys(), "selected cells or row count changed")
    for key, row in after.items():
        require(any(encoded(row) == encoded(option) for option in options[key]), "selected row is not an original allowed option")
        require(all(row[field] == before[key][field] for field in ("split", "source_group_id", "source_conversation_id", "position_band")),
                "selected source origin changed")
    require({row["id"] for row in baseline if row["position_band"] in LATE} ==
        {row["id"] for row in selected if row["position_band"] in LATE}, "late representatives changed")
    require(Counter((row["split"], row["source_group_id"], row["position_band"]) for row in baseline) ==
        Counter((row["split"], row["source_group_id"], row["position_band"]) for row in selected), "group-quarter counts changed")
    require(stratified.concentration(baseline) == stratified.concentration(selected), "row concentration changed")
    old, now = loads(baseline), loads(selected)
    require(all(sum(old[split].values()) == sum(now[split].values()) for split in source.SPLITS), "split target token totals changed")
    require(passed(now, limits), "final target concentration exceeds a baseline ceiling")


def select_rows(rows, config=None):
    config = validate_config(CONFIG if config is None else config)
    validate_rows(rows)
    result = {}
    for profile in PROFILES:
        baseline = [row for row in rows if row["selection_v5"][profile]["chosen"]]
        historical = [row for row in rows if (row["profiles"]["strict_4096"]["chosen"] if profile == "strict_4096" else row["chosen"])]
        options, limits = swap_options(rows, baseline, profile), thresholds(baseline, historical)
        chosen, trace = paired_swap(baseline, options, limits, profile, config["maximum_steps_per_profile"])
        validate_selection(baseline, chosen, options, limits)
        result[profile] = {"baseline_ids": {row["id"] for row in baseline}, "historical_ids": {row["id"] for row in historical},
            "chosen_ids": {row["id"] for row in chosen}, "limits": limits, "trace": trace,
            "option_cells_with_alternatives": sum(len(items) > 1 for items in options.values()),
            "available_option_rows": sum(len(items) for items in options.values())}
    return result


def fraction_table(table):
    return {split: {name: [value.numerator, value.denominator] for name, value in zip(("top5_share", "top10_share", "hhi"), values)}
            for split, values in table.items()}


def change_summary(baseline, chosen, historical, choice):
    old, new = {cell(row): row for row in baseline}, {cell(row): row for row in chosen}
    swaps = [(old[key], new[key]) for key in old if old[key]["id"] != new[key]["id"]]
    before, after = metrics(loads(baseline)), metrics(loads(chosen))
    return {"baseline": stratified.summarize(baseline), "historical": stratified.summarize(historical), "selected": stratified.summarize(chosen),
        "swapped_rows": len(swaps), "new_row_ids_added": len(choice["chosen_ids"] - choice["baseline_ids"]),
        "baseline_rows_removed": len(choice["baseline_ids"] - choice["chosen_ids"]),
        "paired_steps": len(choice["trace"]), "steps": choice["trace"],
        "termination": "first_exact_gate_pass", "maximum_steps": CONFIG["maximum_steps_per_profile"],
        "changed_rows_are_globally_minimal": False,
        "all_nine_target_gates_passed": True, "all_nine_row_metrics_unchanged": True,
        "strictly_improved_target_metrics_vs_v5": sum(value < old_value for split in after for value, old_value in zip(after[split], before[split])),
        "exact_target_ceiling": fraction_table(choice["limits"]), "exact_selected_target_metrics": fraction_table(after),
        "shorter_target_swaps": sum(new["target_length"] < old["target_length"] for old, new in swaps),
        "longer_target_swaps": sum(new["target_length"] > old["target_length"] for old, new in swaps),
        "swap_target_delta": balanced.numeric(new["target_length"] - old["target_length"] for old, new in swaps),
        "swap_prefix_delta": balanced.numeric(new["prefix_length"] - old["prefix_length"] for old, new in swaps),
        "swap_target_end_ordinal_delta": balanced.numeric(new["target_end_ordinal"] - old["target_end_ordinal"] for old, new in swaps),
        "swap_relative_position_delta": balanced.numeric(float(Fraction(new["target_end_ordinal"] - old["target_end_ordinal"], max(1, old["original_turn_count"] - 1))) for old, new in swaps),
        "split_target_totals": {split: {"before": sum(row["target_length"] for row in baseline if row["split"] == split),
            "after": sum(row["target_length"] for row in chosen if row["split"] == split), "delta": 0} for split in source.SPLITS},
        "option_cells_with_alternatives": choice["option_cells_with_alternatives"], "available_option_rows": choice["available_option_rows"],
        "selected_cells_preserved": True, "late_ids_preserved": True, "all_conversations_preserved": True,
        "group_quarter_counts_preserved": True}


def prepare(*, baseline, balanced_baseline, stratified_baseline, output_budget=8192, config=None, **inputs):
    require(type(output_budget) is int and output_budget == 8192, "token-balanced composition requires output budget 8192")
    config = validate_config(CONFIG if config is None else config)
    stratified_baseline = Path(stratified_baseline)
    implementation_hash = source.sha_file(Path(__file__))
    manifest_hash = source.sha_file(stratified_baseline / "export_manifest.json")
    verified = stratified.prepare(baseline=baseline, balanced_baseline=balanced_baseline, output_budget=8192, **inputs)
    manifest = stratified.verify_artifacts(stratified_baseline, verified)
    tracked = dict(verified["tracked"])
    tracked[Path(__file__)] = implementation_hash
    tracked[stratified_baseline / "export_manifest.json"] = manifest_hash
    for name, item in manifest["files"].items():
        tracked[stratified_baseline / name] = item["sha256"]
    selections = select_rows(verified["rows"], config)
    rows = []
    for original in verified["rows"]:
        row = {**original, "stratified_config_sha256": original["config_sha256"], "config_sha256": digest(config), "selection_v6": {}}
        for profile, choice in selections.items():
            previous, chosen = row["id"] in choice["baseline_ids"], row["id"] in choice["chosen_ids"]
            row["selection_v6"][profile] = {"baseline_chosen": previous, "chosen": chosen,
                "reason": "retained_late" if chosen and row["position_band"] in LATE else "retained_early" if chosen and previous
                    else "paired_early_replacement" if chosen else "early_replaced" if previous else "not_selected"}
        rows.append(row)
    rows.sort(key=lambda row: (row["split"], row["id"]))
    selected, tables = {}, {}
    for profile, choice in selections.items():
        old, chosen, historical = ([row for row in rows if row["id"] in choice[key]] for key in ("baseline_ids", "chosen_ids", "historical_ids"))
        selected[profile] = chosen
        tables[profile] = change_summary(old, chosen, historical, choice)
    panel = [row for row in rows if row["validation_late_stratified"]["chosen"]]
    prior = verified["summary"]
    summary = {"schema_version": SCHEMA, "status": "verified", "source_rows_examined": len(rows), "config_sha256": digest(config),
        "stratified_config_sha256": digest(stratified.CONFIG), "profiles": tables,
        "validation_late_stratified": stratified.summarize(panel), "panel_sha256": tracked[stratified_baseline / PANEL_FILE],
        "overlap": {"strict_to_runtime": stratified.overlap(selected["strict_4096"], selected["runtime_capped"]),
            "panel_to_runtime": stratified.overlap(panel, selected["runtime_capped"]), "panel_to_strict": stratified.overlap(panel, selected["strict_4096"])},
        "stratified_baseline_export_manifest_sha256": manifest_hash,
        "stratified_baseline_history_events_sha256": tracked[stratified_baseline / "evaluation_history_events.jsonl"],
        "stratified_baseline_files_bound": len(manifest["files"]) + 1,
        **{key: prior[key] for key in (*balanced.BUDGET_FIELDS, "admission_rules_recomputed", "previous_verified_events", "previous_history",
            "previous_events_sha256", "source_manifest_sha256", "verified_source_files", "baseline_export_manifest_sha256",
            "balanced_baseline_export_manifest_sha256", "strict_structural_limits", "panel_source_profiles", "panel_sequence_bands", "hold_reasons_overlapping")},
        **dict.fromkeys(FALSE_FLAGS, False), **dict.fromkeys(TRUE_FLAGS, True),
        "limitations": ["Early representatives may change to other eligible original rows in the same conversation quarter; the target time and entire original prefix change together. Clinical semantic equivalence is not established.",
            "Late IDs, selected cells, conversations, source groups, group-quarter counts and each split target-token total are unchanged. Exact position and target-length distributions need not be unchanged.",
            "The fixed top10-donor greedy path requires a strict exact deficit decrease. It does not explore score plateaus or all donors; failure means only this bounded path failed. Changes are not proven globally minimal.",
            "The profiles and unchanged validation panel overlap and are development-exposed, not independent tests. Source groups are not verified independent people, and quarters are not clinical stages.",
            "Recorded limits remain 65536/4096/69632. Evaluation uses output limit and reservation8192, effective input61440; this does not change or verify server operation.",
            "Strict validation late capacity and all existing holds remain unchanged. Original bytes, whole prefixes, masks and split are preserved; no human approval or training authorization is established."]}
    require(all(source.sha_file(path) == value for path, value in tracked.items()), "token-balanced inputs changed during preparation")
    return {"config": config, "rows": rows, "summary": summary, "tracked": tracked, "panel_path": stratified_baseline / PANEL_FILE}


def new_events(summary, occurred_at):
    events = base.new_events(summary, occurred_at)
    for event in events:
        event["event_id"] = "token_balanced_" + event["event_id"]
    return events


def export_ids(rows, name):
    require(name in EXPORT_FILES, "unknown token-balanced export")
    if name == PANEL_FILE:
        return {row["id"] for row in rows if row["validation_late_stratified"]["chosen"]}
    profile, filename = name.split("/")
    return {row["id"] for row in rows if row["selection_v6"][profile]["chosen"] and row["split"] == filename.split(".")[0]}


def verify_artifacts(output, plan):
    output = Path(output)
    require(output.is_dir() and not output.is_symlink(), "invalid token-balanced output directory")
    path = output / "export_manifest.json"
    require(path.is_file() and not path.is_symlink(), "invalid token-balanced manifest file")
    manifest = source.read_json(path)
    require(manifest.get("schema_version") == SCHEMA and manifest.get("status") == "verified"
        and all(manifest.get(key) is False for key in FALSE_FLAGS) and all(manifest.get(key) is True for key in TRUE_FLAGS),
        "invalid token-balanced manifest or authorization")
    require(all(encoded(manifest.get(key)) == encoded(plan["summary"][key]) for key in BINDINGS)
        and encoded(manifest.get("input_sha256")) == encoded({str(path.resolve()): value for path, value in plan["tracked"].items()}),
        "token-balanced input or metadata binding mismatch")
    names = ROOT_FILES | EXPORT_FILES
    inventory = {path.relative_to(output).as_posix() for path in output.rglob("*")}
    require(isinstance(manifest.get("files"), dict) and set(manifest["files"]) == names
        and inventory == names | {"export_manifest.json"} | set(PROFILES), "token-balanced file inventory mismatch")
    require(all((output / profile).is_dir() and not (output / profile).is_symlink() for profile in PROFILES), "invalid token-balanced profile directory")
    for name in names:
        path, item = output / name, manifest["files"][name]
        require(isinstance(item, dict) and path.is_file() and not path.is_symlink() and type(item.get("bytes")) is int
            and path.stat().st_size == item["bytes"] and source.sha_file(path) == item.get("sha256"), "token-balanced artifact hash or size mismatch")
    require(encoded(source.read_json(output / "composition_config.json")) == encoded(plan["config"])
        and encoded(source.read_json(output / "summary.json")) == encoded(plan["summary"]), "token-balanced config or summary changed")
    expected = {row["id"]: row for row in plan["rows"]}
    _, actual = token.read_ledger(output / "selection_ledger.jsonl.gz")
    require(encoded(actual) == encoded(expected), "token-balanced ledger differs from recomputed decisions")
    require(encoded(list(history._json_rows(output / "evaluation_history_events.jsonl"))) ==
        encoded(new_events(plan["summary"], manifest.get("occurred_at"))), "token-balanced history sidecar changed")
    for name in EXPORT_FILES:
        selected = export_ids(plan["rows"], name)
        seen, order, uncompressed = set(), [], hashlib.sha256()
        with gzip.open(output / name, "rb") as stream:
            for line in stream:
                row = json.loads(line)
                rid = row.get("id") if isinstance(row, dict) else None
                require(rid in selected and rid not in seen and hashlib.sha256(line).hexdigest() == expected[rid]["source_row_sha256"],
                        "token-balanced original bytes or selection changed")
                seen.add(rid)
                order.append(rid)
                uncompressed.update(line)
        require(seen == selected and order == sorted(selected), "token-balanced export coverage or order mismatch")
        item = manifest["files"][name]
        require(type(item.get("rows")) is int and item["rows"] == len(seen), "token-balanced export count mismatch")
        require(item.get("uncompressed_sha256") == uncompressed.hexdigest(), "token-balanced uncompressed hash mismatch")
    require(source.sha_file(output / PANEL_FILE) == plan["summary"]["panel_sha256"], "validation panel compressed bytes changed")
    require(all(source.sha_file(path) == value for path, value in plan["tracked"].items()), "token-balanced inputs changed during export")
    return manifest


def build(*, output, occurred_at=None, **inputs):
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), "token-balanced output already exists")
    for name in ("release", "frozen", "previous_candidate", "baseline", "balanced_baseline", "stratified_baseline"):
        require(not output.resolve().is_relative_to(Path(inputs[name]).resolve()), "token-balanced output overlaps input directory")
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
    require(lines.keys() == expected.keys(), "token-balanced source rows disappeared")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".token-balanced-stage-", dir=output.parent) as temporary:
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
                 "row-lengths", "previous-candidate", "events", "runtime-budget-evidence", "baseline", "balanced-baseline", "stratified-baseline", "output"):
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
