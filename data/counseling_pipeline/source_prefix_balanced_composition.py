"""Bound prefix concentration by changing same-target-length early representatives.

Source cells, all late IDs and target-token masses remain exact. Input totals
may change by at most 1/500 per split. This is a bounded greedy selection,
not a semantic equivalence or global minimum-change proof.
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

from . import source_token_balanced_composition as previous
from . import source_stratified_composition as stratified
from . import source_balanced_composition as balanced, source_budget_composition as budget
from . import source_composition as base, source_sft as source
from . import token_admission as token, evaluation_history as history


SCHEMA = "malssi-source-prefix-balanced-composition-v1"
PROFILES, LATE = previous.PROFILES, previous.LATE
CONFIG = {
    "schema_version": SCHEMA,
    "selection_policy": "same_early_cell_same_target_length_bounded_prefix_single_swaps",
    "tie_break_seed": "source-prefix-balance-discovery-20261016-v1",
    "token_balanced_config_sha256": base.digest(previous.CONFIG),
    "output_budget": 8192,
    "maximum_steps_per_profile": 60,
    "maximum_rows_per_conversation_quarter": 1,
    "maximum_split_prefix_change": {"numerator": 1, "denominator": 500},
    "candidate_pool": "all_original_eligible_rows_in_selected_early_cells_with_identical_target_length",
    "fixed_representatives": "all_selected_late_ids",
    "score_policy": "exact_fraction_sum_squared_positive_relative_prefix_excess_over_v5_v6_ceilings",
    "move_policy": "strict_score_decrease_then_fewer_changed_rows_then_absolute_prefix_delta_then_exact_position_distance_then_seeded_hash",
    "step_policy": "all_nine_prefix_metrics_nonincreasing_and_exact_split_prefix_total_bound",
    "stop_policy": "first_exact_nine_prefix_gate_pass_or_fail_closed_after_bounded_greedy_path",
    "concentration_gate": "prefix_top5_top10_hhi_for_train_validation_all_le_v5_and_v6",
    "target_policy": "identical_target_length_per_selected_cell_and_exact_group_split_target_masses",
    "panel_policy": "copy_verified_v6_panel_compressed_bytes_unchanged",
    "source_line_policy": "copy_original_bytes_with_entire_prefix_and_loss_mask",
    "source_admission_policy": "preserve_all_recomputed_holds",
    "medical_context_policy": "hold_for_review",
    "procedural_context_policy": "retain_with_review_flag",
    "training_authorized": False,
}
FALSE_FLAGS = previous.FALSE_FLAGS
TRUE_FLAGS = (*previous.TRUE_FLAGS, "group_target_token_masses_preserved", "target_length_distribution_preserved",
    "target_concentration_unchanged", "prefix_concentration_non_worsening", "split_prefix_change_within_bound",
    "validation_panel_byte_identical_to_v6")
ROOT_FILES, PANEL_FILE, EXPORT_FILES = previous.ROOT_FILES, previous.PANEL_FILE, previous.EXPORT_FILES
BINDINGS = (*previous.BINDINGS, "token_balanced_config_sha256", "token_balanced_baseline_export_manifest_sha256",
    "token_balanced_baseline_history_events_sha256", "maximum_split_prefix_change")
require, encoded, digest, cell = source.require, base.encoded, base.digest, stratified.cell
metrics, score, passed = previous.metrics, previous.score, previous.passed


def validate_config(config):
    require(encoded(config) == encoded(CONFIG), "unsupported prefix-balanced composition config")
    return json.loads(encoded(config))


def rank(row):
    return source.sha_text(CONFIG["tie_break_seed"] + "|" + row["id"]), row["id"]


def loads(rows):
    result = {split: Counter() for split in source.SPLITS}
    for row in rows:
        result[row["split"]][row["source_group_id"]] += row["prefix_length"]
    return result


def thresholds(baseline, historical):
    old, prior = metrics(loads(baseline)), metrics(loads(historical))
    return {split: tuple(min(a, b) for a, b in zip(old[split], prior[split])) for split in old}


def validate_rows(rows):
    previous.validate_rows(rows)
    for row in rows:
        require(isinstance(row.get("selection_v6"), dict) and set(row["selection_v6"]) == set(PROFILES), "invalid v6 decisions")
        for profile in PROFILES:
            decision = row["selection_v6"][profile]
            require(isinstance(decision, dict) and all(type(decision.get(key)) is bool for key in ("baseline_chosen", "chosen"))
                and isinstance(decision.get("reason"), str), "invalid typed v6 decision")
            permitted = "strict_4096" if profile == "strict_4096" else "runtime_budget"
            require(decision["baseline_chosen"] is row["selection_v5"][profile]["chosen"] and
                (not decision["chosen"] or row["profiles"][permitted]["eligible"]), "ineligible or inconsistent v6 selection")


def swap_options(rows, baseline, profile):
    original = {cell(row): row for row in baseline}
    require(len(original) == len(baseline), "duplicate v6 baseline cell")
    permitted = "strict_4096" if profile == "strict_4096" else "runtime_budget"
    options = defaultdict(list)
    for row in rows:
        key = cell(row)
        if key in original and row["position_band"] not in LATE and row["profiles"][permitted]["eligible"] and row["target_length"] == original[key]["target_length"]:
            options[key].append(row)
    for key, row in original.items():
        if row["position_band"] in LATE:
            options[key] = [row]
        require(any(item["id"] == row["id"] for item in options[key]), "v6 representative is not an allowed option")
    return options


def within_prefix_bound(current, baseline_totals):
    return all(abs(sum(current[split].values()) - baseline_totals[split]) * 500 <= baseline_totals[split] for split in source.SPLITS)


def validate_move(selected, replacement, current, baseline_totals, limits, profile):
    require(profile in PROFILES and cell(replacement) in selected, "prefix swap refers to an unknown profile or selected cell")
    old = selected[cell(replacement)]
    require(replacement["position_band"] not in LATE and all(replacement[key] == old[key] for key in
        ("split", "source_group_id", "source_conversation_id", "position_band", "original_turn_count")), "prefix swap changed origin/cell or late representative")
    require(type(replacement.get("target_length")) is int and replacement["target_length"] == old["target_length"], "prefix swap changed target length")
    permitted = "strict_4096" if profile == "strict_4096" else "runtime_budget"
    require(budget.budget_decision(replacement, permitted, budget.make_config(8192))["eligible"], "prefix swap selected held or over-budget row")
    split, group = replacement["split"], replacement["source_group_id"]
    delta = replacement["prefix_length"] - old["prefix_length"]
    require(delta != 0 and replacement["id"] != old["id"], "prefix swap did not change a representative")
    changed = {part: counts.copy() for part, counts in current.items()}
    changed[split][group] += delta
    require(within_prefix_bound(changed, baseline_totals), "split prefix total exceeds the exact 0.2 percent bound")
    before, after = metrics(current), metrics(changed)
    require(all(value <= prior for part in before for value, prior in zip(after[part], before[part])), "prefix concentration worsened within a step")
    require(score(changed, limits) < score(current, limits), "prefix deficit score did not strictly decrease")
    return split, group, delta


def single_swap(baseline, options, limits, profile, max_steps=None):
    max_steps = CONFIG["maximum_steps_per_profile"] if max_steps is None else max_steps
    require(type(max_steps) is int and max_steps >= 0, "invalid prefix step limit")
    initial = {cell(row): row for row in baseline}
    selected, current, trace = dict(initial), loads(baseline), []
    baseline_totals = {split: sum(current[split].values()) for split in source.SPLITS}
    while not passed(current, limits):
        require(len(trace) < max_steps, "prefix greedy step limit reached; policy review required, global feasibility unknown")
        before_score, before = score(current, limits), metrics(current)
        best = None
        for key, choices in options.items():
            old = selected[key]
            for row in choices:
                delta = row["prefix_length"] - old["prefix_length"]
                if not delta:
                    continue
                split, group = row["split"], row["source_group_id"]
                if abs(sum(current[split].values()) + delta - baseline_totals[split]) * 500 > baseline_totals[split]:
                    continue
                current[split][group] += delta
                value, after = score(current, limits), metrics(current)
                current[split][group] -= delta
                if value >= before_score or any(value > prior for part in before for value, prior in zip(after[part], before[part])):
                    continue
                changes = int(row["id"] != initial[key]["id"]) - int(old["id"] != initial[key]["id"])
                tie = value, changes, abs(delta), previous.position_delta(old, row), rank(row)
                if best is None or tie < best[0]:
                    best = tie, key, row
        require(best is not None, "no improving single on bounded stepwise-nonincreasing greedy path; policy review required, global feasibility unknown")
        tie, key, row = best
        split, group, delta = validate_move(selected, row, current, baseline_totals, limits, profile)
        current[split][group] += delta
        selected[key] = row
        trace.append({"step": len(trace) + 1, "split": split, "prefix_token_delta": delta,
            "all_nine_prefix_metrics_nonincreasing": True, "score_exact": [tie[0].numerator, tie[0].denominator]})
    return sorted(selected.values(), key=lambda row: (row["split"], row["id"])), trace


def validate_selection(baseline, chosen, options, limits):
    old, new = {cell(row): row for row in baseline}, {cell(row): row for row in chosen}
    require(old.keys() == new.keys() and len(old) == len(baseline) == len(chosen) == len({row["id"] for row in chosen}), "selected cells or row count changed")
    for key, row in new.items():
        require(any(encoded(row) == encoded(option) for option in options[key]), "selected row is not an original allowed option")
        require(all(row[field] == old[key][field] for field in ("split", "source_group_id", "source_conversation_id", "position_band", "target_length")),
                "selected origin or same-cell target length changed")
    require({row["id"] for row in baseline if row["position_band"] in LATE} ==
        {row["id"] for row in chosen if row["position_band"] in LATE}, "late representative changed")
    require(Counter((row["split"], row["source_group_id"], row["position_band"]) for row in baseline) ==
        Counter((row["split"], row["source_group_id"], row["position_band"]) for row in chosen), "group-quarter row counts changed")
    require(previous.loads(baseline) == previous.loads(chosen), "target group or split masses changed")
    require(Counter((row["split"], row["target_length"]) for row in baseline) == Counter((row["split"], row["target_length"]) for row in chosen), "target length distribution changed")
    require(stratified.concentration(baseline) == stratified.concentration(chosen) and
        metrics(previous.loads(baseline)) == metrics(previous.loads(chosen)), "row or target concentration changed")
    totals = {split: sum(loads(baseline)[split].values()) for split in source.SPLITS}
    require(within_prefix_bound(loads(chosen), totals), "final split prefix total exceeds bound")
    require(passed(loads(chosen), limits), "final prefix concentration exceeds a baseline ceiling")


def select_rows(rows, config=None):
    config = validate_config(CONFIG if config is None else config)
    validate_rows(rows)
    choices = {}
    for profile in PROFILES:
        baseline = [row for row in rows if row["selection_v6"][profile]["chosen"]]
        historical = [row for row in rows if row["selection_v5"][profile]["chosen"]]
        options, limits = swap_options(rows, baseline, profile), thresholds(baseline, historical)
        chosen, trace = single_swap(baseline, options, limits, profile, config["maximum_steps_per_profile"])
        validate_selection(baseline, chosen, options, limits)
        choices[profile] = {"baseline_ids": {row["id"] for row in baseline}, "historical_ids": {row["id"] for row in historical},
            "chosen_ids": {row["id"] for row in chosen}, "limits": limits, "trace": trace,
            "early_cells_with_same_target_alternatives": sum(len(items) > 1 for items in options.values()),
            "same_target_early_option_rows": sum(len(items) for key, items in options.items() if key[1] not in LATE)}
    return choices


def summarize(rows):
    result = stratified.summarize(rows)
    prefix = metrics(loads(rows))
    for split, entries in prefix.items():
        top5, top10, hhi = entries
        subset = [row for row in rows if split == "all" or row["split"] == split]
        result[split]["concentration"]["prefix_tokens"] = {"top5_percent": float(100 * top5) if subset else None,
            "top10_percent": float(100 * top10) if subset else None, "hhi": float(hhi) if subset else None,
            "effective_group_count": float(1 / hhi) if hhi else None}
        result[split]["prefix_length"] = balanced.numeric(row["prefix_length"] for row in subset)
    return result


def change_summary(baseline, chosen, historical, choice):
    old, new = {cell(row): row for row in baseline}, {cell(row): row for row in chosen}
    swaps = [(old[key], new[key]) for key in old if old[key]["id"] != new[key]["id"]]
    before, after = metrics(loads(baseline)), metrics(loads(chosen))
    totals = {}
    for split in source.SPLITS:
        start = sum(row["prefix_length"] for row in baseline if row["split"] == split)
        end = sum(row["prefix_length"] for row in chosen if row["split"] == split)
        totals[split] = {"before": start, "after": end, "delta": end - start,
            "delta_percent": 100 * (end - start) / start if start else None,
            "maximum_absolute_delta_tokens": start // 500, "within_exact_bound": abs(end - start) * 500 <= start}
    return {"baseline_v6": summarize(baseline), "historical_v5": summarize(historical), "selected": summarize(chosen),
        "swapped_rows": len(swaps), "new_row_ids_added": len(choice["chosen_ids"] - choice["baseline_ids"]),
        "baseline_rows_removed": len(choice["baseline_ids"] - choice["chosen_ids"]),
        "steps": choice["trace"], "selection_steps": len(choice["trace"]), "termination": "first_exact_gate_pass",
        "maximum_steps": CONFIG["maximum_steps_per_profile"], "changed_rows_are_globally_minimal": False,
        "all_nine_prefix_gates_passed": True, "all_nine_row_metrics_unchanged": True, "all_nine_target_metrics_unchanged": True,
        "strictly_improved_prefix_metrics_vs_v6": sum(value < prior for split in after for value, prior in zip(after[split], before[split])),
        "exact_prefix_ceiling": previous.fraction_table(choice["limits"]), "exact_selected_prefix_metrics": previous.fraction_table(after),
        "exact_target_metrics": previous.fraction_table(metrics(previous.loads(chosen))),
        "prefix_totals": totals, "maximum_split_prefix_change": CONFIG["maximum_split_prefix_change"],
        "prefix_totals_exactly_preserved": all(item["delta"] == 0 for item in totals.values()),
        "swap_prefix_delta": balanced.numeric(b["prefix_length"] - a["prefix_length"] for a, b in swaps),
        "swap_target_delta": balanced.numeric(b["target_length"] - a["target_length"] for a, b in swaps),
        "swap_target_end_ordinal_delta": balanced.numeric(b["target_end_ordinal"] - a["target_end_ordinal"] for a, b in swaps),
        "swap_relative_position_delta": balanced.numeric(float(Fraction(b["target_end_ordinal"] - a["target_end_ordinal"], max(1, a["original_turn_count"] - 1))) for a, b in swaps),
        "same_cell_target_lengths_preserved": True, "group_target_masses_preserved": True, "target_length_distribution_preserved": True,
        "early_cells_with_same_target_alternatives": choice["early_cells_with_same_target_alternatives"],
        "same_target_early_option_rows": choice["same_target_early_option_rows"]}


def prepare(*, baseline, balanced_baseline, stratified_baseline, token_balanced_baseline, output_budget=8192, config=None, **inputs):
    require(type(output_budget) is int and output_budget == 8192, "prefix-balanced composition requires output budget 8192")
    config = validate_config(CONFIG if config is None else config)
    token_balanced_baseline = Path(token_balanced_baseline)
    implementation_hash = source.sha_file(Path(__file__))
    manifest_hash = source.sha_file(token_balanced_baseline / "export_manifest.json")
    verified = previous.prepare(baseline=baseline, balanced_baseline=balanced_baseline, stratified_baseline=stratified_baseline,
                                output_budget=8192, **inputs)
    manifest = previous.verify_artifacts(token_balanced_baseline, verified)
    tracked = dict(verified["tracked"])
    tracked[Path(__file__)] = implementation_hash
    tracked[token_balanced_baseline / "export_manifest.json"] = manifest_hash
    for name, item in manifest["files"].items():
        tracked[token_balanced_baseline / name] = item["sha256"]
    choices = select_rows(verified["rows"], config)
    rows = []
    for original in verified["rows"]:
        row = {**original, "token_balanced_config_sha256": original["config_sha256"], "config_sha256": digest(config), "selection_v7": {}}
        for profile, choice in choices.items():
            old, chosen = row["id"] in choice["baseline_ids"], row["id"] in choice["chosen_ids"]
            row["selection_v7"][profile] = {"baseline_chosen": old, "chosen": chosen,
                "reason": "retained_late" if chosen and row["position_band"] in LATE else "retained_early" if chosen and old
                    else "same_target_prefix_replacement" if chosen else "early_replaced" if old else "not_selected"}
        rows.append(row)
    rows.sort(key=lambda row: (row["split"], row["id"]))
    selected, tables = {}, {}
    for profile, choice in choices.items():
        old, chosen, historical = ([row for row in rows if row["id"] in choice[key]] for key in ("baseline_ids", "chosen_ids", "historical_ids"))
        selected[profile] = chosen
        tables[profile] = change_summary(old, chosen, historical, choice)
    panel = [row for row in rows if row["validation_late_stratified"]["chosen"]]
    prior = verified["summary"]
    summary = {"schema_version": SCHEMA, "status": "verified", "source_rows_examined": len(rows), "config_sha256": digest(config),
        "token_balanced_config_sha256": digest(previous.CONFIG), "profiles": tables,
        "validation_late_stratified": summarize(panel), "panel_sha256": tracked[token_balanced_baseline / PANEL_FILE],
        "maximum_split_prefix_change": config["maximum_split_prefix_change"],
        "overlap": {"strict_to_runtime": stratified.overlap(selected["strict_4096"], selected["runtime_capped"]),
            "panel_to_runtime": stratified.overlap(panel, selected["runtime_capped"]), "panel_to_strict": stratified.overlap(panel, selected["strict_4096"])},
        "token_balanced_baseline_export_manifest_sha256": manifest_hash,
        "token_balanced_baseline_history_events_sha256": tracked[token_balanced_baseline / "evaluation_history_events.jsonl"],
        "token_balanced_baseline_files_bound": len(manifest["files"]) + 1,
        **{key: prior[key] for key in (*balanced.BUDGET_FIELDS, "admission_rules_recomputed", "previous_verified_events", "previous_history",
            "previous_events_sha256", "source_manifest_sha256", "verified_source_files", "baseline_export_manifest_sha256",
            "balanced_baseline_export_manifest_sha256", "stratified_config_sha256", "stratified_baseline_export_manifest_sha256",
            "stratified_baseline_history_events_sha256", "strict_structural_limits", "panel_source_profiles", "panel_sequence_bands", "hold_reasons_overlapping")},
        **dict.fromkeys(FALSE_FLAGS, False), **dict.fromkeys(TRUE_FLAGS, True),
        "limitations": ["The same target length per cell preserves group target mass and length distributions, not target text or clinical meaning. Target time and full original prefix can change together.",
            "Prefix totals may increase or decrease by at most 1/500 of each v6 split total. This is an experimental composition cap, not a token-independence or representativeness guarantee.",
            "The bounded greedy path requires strict exact deficit decrease and stepwise nonincreasing prefix metrics; it can miss plateau or other paths and does not prove globally minimal changes.",
            "Late IDs, all selected cells, conversations, groups, group-quarter counts, target metrics and original splits remain fixed. Strict validation late scarcity is unchanged.",
            "Recorded limits remain 65536/4096/69632; output limit and reservation8192 with effective input61440 is only the evaluation scenario. No tokenizer, model or live server is run.",
            "The overlapping profiles and unchanged panel are development-exposed, not independent tests. Original source holds persist; no human approval, semantic equivalence or training authorization is established."]}
    require(all(source.sha_file(path) == value for path, value in tracked.items()), "prefix-balanced inputs changed during preparation")
    return {"config": config, "rows": rows, "summary": summary, "tracked": tracked, "panel_path": token_balanced_baseline / PANEL_FILE}

def new_events(summary, occurred_at):
    events = base.new_events(summary, occurred_at)
    for event in events:
        event["event_id"] = "prefix_balanced_" + event["event_id"]
    return events


def export_ids(rows, name):
    require(name in EXPORT_FILES, "unknown prefix-balanced export")
    if name == PANEL_FILE:
        return {row["id"] for row in rows if row["validation_late_stratified"]["chosen"]}
    profile, filename = name.split("/")
    return {row["id"] for row in rows if row["selection_v7"][profile]["chosen"] and row["split"] == filename.split(".")[0]}


def verify_artifacts(output, plan):
    output = Path(output)
    require(output.is_dir() and not output.is_symlink(), "invalid prefix-balanced output directory")
    path = output / "export_manifest.json"
    require(path.is_file() and not path.is_symlink(), "invalid prefix-balanced manifest file")
    manifest = source.read_json(path)
    require(manifest.get("schema_version") == SCHEMA and manifest.get("status") == "verified"
        and all(manifest.get(key) is False for key in FALSE_FLAGS) and all(manifest.get(key) is True for key in TRUE_FLAGS),
        "invalid prefix-balanced manifest or authorization")
    require(all(encoded(manifest.get(key)) == encoded(plan["summary"][key]) for key in BINDINGS)
        and encoded(manifest.get("input_sha256")) == encoded({str(path.resolve()): value for path, value in plan["tracked"].items()}),
        "prefix-balanced input or metadata binding mismatch")
    names = ROOT_FILES | EXPORT_FILES
    inventory = {path.relative_to(output).as_posix() for path in output.rglob("*")}
    require(isinstance(manifest.get("files"), dict) and set(manifest["files"]) == names
        and inventory == names | {"export_manifest.json"} | set(PROFILES), "prefix-balanced file inventory mismatch")
    require(all((output / profile).is_dir() and not (output / profile).is_symlink() for profile in PROFILES), "invalid prefix-balanced profile directory")
    for name in names:
        path, item = output / name, manifest["files"][name]
        require(isinstance(item, dict) and path.is_file() and not path.is_symlink() and type(item.get("bytes")) is int
            and path.stat().st_size == item["bytes"] and source.sha_file(path) == item.get("sha256"), "prefix-balanced artifact hash or size mismatch")
    require(encoded(source.read_json(output / "composition_config.json")) == encoded(plan["config"])
        and encoded(source.read_json(output / "summary.json")) == encoded(plan["summary"]), "prefix-balanced config or summary changed")
    expected = {row["id"]: row for row in plan["rows"]}
    _, actual = token.read_ledger(output / "selection_ledger.jsonl.gz")
    require(encoded(actual) == encoded(expected), "prefix-balanced ledger differs from recomputed decisions")
    require(encoded(list(history._json_rows(output / "evaluation_history_events.jsonl"))) ==
        encoded(new_events(plan["summary"], manifest.get("occurred_at"))), "prefix-balanced history sidecar changed")
    for name in EXPORT_FILES:
        selected = export_ids(plan["rows"], name)
        seen, order, uncompressed = set(), [], hashlib.sha256()
        with gzip.open(output / name, "rb") as stream:
            for line in stream:
                row = json.loads(line)
                rid = row.get("id") if isinstance(row, dict) else None
                require(rid in selected and rid not in seen and hashlib.sha256(line).hexdigest() == expected[rid]["source_row_sha256"],
                        "prefix-balanced original bytes or selection changed")
                seen.add(rid)
                order.append(rid)
                uncompressed.update(line)
        require(seen == selected and order == sorted(selected), "prefix-balanced export coverage or order mismatch")
        item = manifest["files"][name]
        require(type(item.get("rows")) is int and item["rows"] == len(seen), "prefix-balanced export count mismatch")
        require(item.get("uncompressed_sha256") == uncompressed.hexdigest(), "prefix-balanced uncompressed hash mismatch")
    require(source.sha_file(output / PANEL_FILE) == plan["summary"]["panel_sha256"], "validation panel compressed bytes changed")
    require(all(source.sha_file(path) == value for path, value in plan["tracked"].items()), "prefix-balanced inputs changed during export")
    return manifest


def build(*, output, occurred_at=None, **inputs):
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), "prefix-balanced output already exists")
    for name in ("release", "frozen", "previous_candidate", "baseline", "balanced_baseline", "stratified_baseline", "token_balanced_baseline"):
        require(not output.resolve().is_relative_to(Path(inputs[name]).resolve()), "prefix-balanced output overlaps input directory")
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
    require(lines.keys() == expected.keys(), "prefix-balanced source rows disappeared")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".prefix-balanced-stage-", dir=output.parent) as temporary:
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
                 "row-lengths", "previous-candidate", "events", "runtime-budget-evidence", "baseline", "balanced-baseline", "stratified-baseline", "token-balanced-baseline", "output"):
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
