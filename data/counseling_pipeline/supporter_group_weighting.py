"""Source-bound, positive group weights for the unchanged supporter inventory.

Raw tokens, raw validation and all source rows remain unchanged. Weighted token
mass describes a loss objective, not tokens processed or independent cases.
This opt-in policy is consumed by supporter_weighted_loss, never by adding an
ignored field to the existing stage-1 trainer. No model training occurs here.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from fractions import Fraction
import json
import math
import os
from pathlib import Path
import shutil
import tempfile

from . import supporter_token_audit as audit
from . import supporter_task_composition as composition
from .annotations import canonical, digest
from .agent_training import require


RULE = "train_half_input_half_target__validation_input__apps_identity"
VERSION = "malssi-supporter-group-weighting-v1"
AUDIT_FILES = {"manifest.json", "row_lengths.jsonl", "summary.json", "provenance.json"}
FILES = {"policy.json", "weights.jsonl", "summary.json", *("raw_tokens/" + n for n in AUDIT_FILES)}
HASH_FIELDS = ("source_line_sha256", "row_sha256", "messages_sha256", "prefix_ids_sha256",
               "target_ids_sha256", "full_ids_sha256")


def ratio(value):
    value = Fraction(value)
    return {"numerator": value.numerator, "denominator": value.denominator}


def read_ratio(value):
    require(isinstance(value, dict) and set(value) == {"numerator", "denominator"}, "invalid rational fields")
    n, d = value["numerator"], value["denominator"]
    require(type(n) is int and type(d) is int and n > 0 and d > 0, "positive integer rational required")
    result = Fraction(n, d)
    require(result.numerator == n and result.denominator == d, "rational must be reduced")
    return result


def identity(record):
    return record["stream"], record["row_id"]


def validate_records(records):
    require(isinstance(records, list) and bool(records), "empty token records")
    seen, groups, roots = set(), {}, {}
    for r in records:
        require(isinstance(r, dict), "invalid token record")
        require(r["stream"] in audit.STREAMS and r["split"] in {"train", "validation"}, "invalid task/split")
        require(r["cohort"] in {"baseline_v2", "new_v9"}, "invalid cohort")
        for name in ("row_id", "group_id", "root_id", "source_file"):
            require(isinstance(r[name], str) and bool(r[name]), "missing identity")
        require(identity(r) not in seen, "duplicate row identity")
        seen.add(identity(r))
        for name in ("prefix_length", "target_length", "sequence_length", "line_number"):
            require(type(r[name]) is int and r[name] > 0, "invalid measured length/line")
        require(r["sequence_length"] == r["prefix_length"] + r["target_length"], "sequence length mismatch")
        flags = audit.budget_flags(r["prefix_length"], r["target_length"])
        require(flags["runtime_8192"], "output 8192 budget failed")
        require(all(type(r.get(k)) is type(v) and r[k] == v for k, v in flags.items()), "budget flags mismatch")
        for name in HASH_FIELDS:
            require(isinstance(r[name], str) and len(r[name]) == 64
                    and all(c in "0123456789abcdef" for c in r[name]), "invalid token/source hash")
        for field, mapping in (("group_id", groups), ("root_id", roots)):
            require(r[field] not in mapping or mapping[r[field]] == r["split"], "group/root crossed split")
            mapping[r[field]] = r["split"]


def group_masses(records, weights, field):
    result = defaultdict(Fraction)
    for r in records:
        result[r["group_id"]] += weights[identity(r)] * r[field]
    return dict(result)


def exact_concentration(masses):
    ordered = sorted(masses, reverse=True)
    require(bool(ordered) and all(x > 0 for x in ordered), "positive group mass required")
    count, total = len(ordered), sum(ordered, Fraction())
    hhi = sum((x * x for x in ordered), Fraction()) / (total * total)
    return {"groups": count, "total": total, "top1_share": ordered[0] / total,
            "top5_share": sum(ordered[:5]) / total, "top10_share": sum(ordered[:10]) / total,
            "hhi": hhi, "normalized_hhi": (count * hhi - 1) / (count - 1) if count > 1 else None,
            "cv_squared": count * hhi - 1, "effective_groups": 1 / hhi,
            "min": ordered[-1], "max": ordered[0]}


def display_metrics(metrics):
    result = {k: float(v) if isinstance(v, Fraction) else v for k, v in metrics.items()}
    result["cv"] = math.sqrt(float(metrics["cv_squared"]))
    result["exact"] = {k: ratio(v) for k, v in metrics.items() if isinstance(v, Fraction)}
    return result


def weights_for(records, rule=RULE):
    """Each group receives one weight per task/split; every task total is fixed."""
    validate_records(records)
    require(rule in {RULE, "identity", "validation_only", "input_only"}, "unknown weighting rule")
    subsets = defaultdict(list)
    for r in records:
        subsets[r["stream"], r["split"]].append(r)
    weights = {}
    for (task, split), rows in subsets.items():
        if task in audit.STREAMS[3:] or rule == "identity" or (rule == "validation_only" and split == "train"):
            weights.update({identity(r): Fraction(1) for r in rows})
            continue
        ones = {identity(r): Fraction(1) for r in rows}
        prefix = group_masses(rows, ones, "prefix_length")
        target = group_masses(rows, ones, "target_length")
        total, count = sum(target.values()), len(target)
        normalizer = total / sum((target[g] / prefix[g] for g in target), Fraction())
        for r in rows:
            g = r["group_id"]
            value = normalizer / prefix[g]
            if rule == RULE and split == "train":
                value = (value + total / (count * target[g])) / 2
            weights[identity(r)] = value
    return weights


def verify_weights(records, weights):
    require(set(weights) == {identity(r) for r in records}, "missing or extra row weight")
    require(all(isinstance(w, Fraction) and w > 0 for w in weights.values()), "nonpositive or inexact weight")
    for task in audit.STREAMS:
        for split in ("train", "validation"):
            rows = [r for r in records if r["stream"] == task and r["split"] == split]
            if not rows:
                continue
            require(sum(weights[identity(r)] * r["target_length"] for r in rows)
                    == sum(r["target_length"] for r in rows), "task/split target mass changed")
            for group in {r["group_id"] for r in rows}:
                require(len({weights[identity(r)] for r in rows if r["group_id"] == group}) == 1,
                        "within-group relative weighting changed")


def summarize(records, weights):
    result = {}
    for task in audit.STREAMS:
        result[task] = {}
        for split in ("all", "train", "validation"):
            rows = [r for r in records if r["stream"] == task and (split == "all" or r["split"] == split)]
            if not rows:
                continue
            result[task][split] = {
                "rows": len(rows), "groups": len({r["group_id"] for r in rows}),
                "input": display_metrics(exact_concentration(group_masses(rows, weights, "prefix_length").values())),
                "target": display_metrics(exact_concentration(group_masses(rows, weights, "target_length").values())),
                "weight_min": float(min(weights[identity(r)] for r in rows)),
                "weight_max": float(max(weights[identity(r)] for r in rows)),
                "cohorts": {cohort: {
                    "rows": len(selected), "raw_target_tokens": sum(r["target_length"] for r in selected),
                    "weighted_target_mass": float(sum(weights[identity(r)] * r["target_length"] for r in selected)),
                    "weighted_target_mass_exact": ratio(sum(weights[identity(r)] * r["target_length"] for r in selected)),
                } for cohort in ("baseline_v2", "new_v9")
                    if (selected := [r for r in rows if r["cohort"] == cohort])},
            }
    return result


def gates(records, weights):
    """Compare with both v2 and the actual-token v10 inventory using exact math."""
    verify_weights(records, weights)
    ones = {identity(r): Fraction(1) for r in records}
    concentration, masses = [], []
    for task in audit.STREAMS:
        for split in ("all", "train", "validation"):
            rows = [r for r in records if r["stream"] == task and (split == "all" or r["split"] == split)]
            if not rows:
                continue
            baseline = [r for r in rows if r["cohort"] == "baseline_v2"]
            for axis, field in (("input", "prefix_length"), ("target", "target_length")):
                current = exact_concentration(group_masses(rows, weights, field).values())
                old = exact_concentration(group_masses(rows, ones, field).values())
                base = exact_concentration(group_masses(baseline, ones, field).values()) if baseline else None
                for metric in ("hhi", "normalized_hhi", "cv_squared"):
                    limit = min(old[metric], base[metric]) if base else old[metric]
                    concentration.append({"task": task, "split": split, "axis": axis, "metric": metric,
                        "v2": ratio(base[metric]) if base else None, "v10": ratio(old[metric]),
                        "weighted": ratio(current[metric]), "pass": current[metric] <= limit})
                if split != "all":
                    masses.append({"task": task, "split": split, "axis": axis,
                        "raw": ratio(old["total"]), "weighted": ratio(current["total"]),
                        "pass": current["total"] == old["total"] if axis == "target" else current["total"] <= old["total"]})
    return {"concentration": concentration, "mass": masses,
            "all_pass": all(g["pass"] for g in concentration + masses)}


def ledger(records, weights):
    return [{"stream": r["stream"], "split": r["split"], "row_id": r["row_id"],
             "group_id": r["group_id"], "token_record_sha256": digest(r), "weight": ratio(weights[identity(r)])}
            for r in records]


def implementation_hashes(root):
    hashes = audit.implementation_hashes(root)
    repo = Path(__file__).resolve().parents[2]
    for name in ("supporter_group_weighting.py", "supporter_weighted_loss.py"):
        path = Path(__file__).with_name(name)
        hashes[path.relative_to(repo).as_posix()] = composition.sha(composition.read(path))
    return hashes


def check_inventory(directory, names):
    directory = Path(directory)
    require(directory.is_dir() and not directory.is_symlink(), "invalid artifact directory")
    files = set()
    for path in directory.rglob("*"):
        require(not path.is_symlink(), "symlink inside artifact")
        if path.is_file():
            files.add(path.relative_to(directory).as_posix())
    require(files == set(names), "unexpected artifact file inventory")


def read_audit(directory):
    check_inventory(directory, AUDIT_FILES)
    blobs = composition.capture(directory, AUDIT_FILES)
    manifest = composition.parse(blobs["manifest.json"])
    require(manifest.get("schema_version") == "malssi-supporter-token-sidecar-v1"
            and manifest.get("training_authorized") is False, "invalid raw audit manifest")
    expected = {n: {"sha256": composition.sha(b), "bytes": len(b)} for n, b in blobs.items() if n != "manifest.json"}
    require(canonical(manifest["files"]) == canonical(expected), "raw audit content binding mismatch")
    records = composition.lines(blobs["row_lengths.jsonl"])
    validate_records(records)
    summary = composition.parse(blobs["summary.json"])
    contract = {"schema_version": "malssi-supporter-token-audit-v1", "status": "measured",
                "evaluation_budget": composition.BUDGET, "inventory_rows": len(records),
                "token_budget_eligible_rows": sum(r["runtime_8192"] for r in records),
                "strict_4096_rows": sum(r["strict_4096"] for r in records),
                **{k: True for k in ("all_rows_freshly_encoded", "source_files_unchanged", "no_truncation")},
                **{k: False for k in ("model_weights_loaded", "training_run", "human_or_expert_approved",
                                     "independent_test_eligible", "automatic_task_mixing")},
                "inventory_token_sums_not_a_training_mixture": {
                    cohort: {"rows": len(rows), "input_tokens": sum(r["prefix_length"] for r in rows),
                             "target_tokens": sum(r["target_length"] for r in rows)}
                    for cohort in ("all", "baseline_v2", "new_v9")
                    if (rows := [r for r in records if cohort == "all" or r["cohort"] == cohort])},
                "serialization": {"target_includes_native_turn_termination": True,
                    "native_full_prefix_match_rows": sum(r["raw_template_prefix_match"] for r in records),
                    "explicit_non_thinking_canonicalization_rows": sum(r["canonicalization_applied"] for r in records),
                    "source_boundary_whitespace_trimmed_messages": sum(r["source_boundary_whitespace_trimmed_messages"] for r in records),
                    "decode_and_label_checks_rows": len(records)}}
    require(set(summary) == set(contract) | {"summary", "limits"}, "unexpected raw audit claim fields")
    require(canonical({k: summary.get(k) for k in contract}) == canonical(contract), "raw audit contract changed")
    require(canonical(summary["summary"]) == canonical(audit.summarize(records)), "raw summary changed")
    return blobs, records


def policy_summary(records, weights):
    checked = gates(records, weights)
    require(checked["all_pass"], "weighting worsens a protected metric/mass")
    alternatives = {}
    for rule in ("identity", "validation_only", "input_only", RULE):
        candidate = weights_for(records, rule)
        result = gates(records, candidate)
        alternatives[rule] = {"all_pass": result["all_pass"],
            "failed_concentration": [g for g in result["concentration"] if not g["pass"]],
            "failed_mass": [g for g in result["mass"] if not g["pass"]],
            "nonunit_train_rows": sum(candidate[identity(r)] != 1 for r in records if r["split"] == "train")}
    return {"schema_version": VERSION, "rule": RULE, "inventory_rows": len(records),
            "raw_inventory_unchanged": True, "raw_concentration_improved": False,
            "primary_validation": "unweighted", "weighted_validation": "development_exposed_auxiliary",
            "model_training_run": False, "human_or_expert_approved": False,
            "independent_test_eligible": False, "automatic_task_mixing": False,
            "raw_input_tokens": sum(r["prefix_length"] for r in records),
            "raw_target_tokens": sum(r["target_length"] for r in records),
            "weighted_input_mass": float(sum(weights[identity(r)] * r["prefix_length"] for r in records)),
            "weighted_target_mass_exact": ratio(sum(weights[identity(r)] * r["target_length"] for r in records)),
            "nonunit_rows": sum(w != 1 for w in weights.values()),
            "runtime_8192_pass": sum(r["runtime_8192"] for r in records),
            "strict_4096_pass": sum(r["strict_4096"] for r in records),
            "weighted": summarize(records, weights), "gates": checked, "alternatives": alternatives}


def build(root, reference_audit, tokenizer_dir, historical, output, *, node="node"):
    root, reference_audit, tokenizer_dir, historical, output = map(lambda p: Path(p).absolute(),
        (root, reference_audit, tokenizer_dir, historical, output))
    require(not output.exists() and not output.is_symlink(), "output already exists")
    require(all(not output.resolve().is_relative_to(p.resolve()) for p in (root, reference_audit, tokenizer_dir)),
            "output must not be inside a preserved input artifact")
    reference_blobs, old_records = read_audit(reference_audit)
    code_before = implementation_hashes(root)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".supporter-weighting-", dir=output.parent))
    try:
        audit.run(root, tokenizer_dir, historical, temporary / "raw_tokens", node=node)
        fresh_blobs, records = read_audit(temporary / "raw_tokens")
        require(canonical(records) == canonical(old_records), "fresh token records differ from the frozen reference")
        require(fresh_blobs["summary.json"] == reference_blobs["summary.json"], "fresh raw summary differs from reference")
        weights = weights_for(records)
        summary = policy_summary(records, weights)
        provenance = composition.parse(fresh_blobs["provenance.json"])
        policy = {"schema_version": VERSION, "rule": RULE, "source_root": str(root),
                  "reference_audit": str(reference_audit), "reference_sha256": composition.hashes(reference_blobs),
                  "source_sha256": provenance["inputs_sha256"], "tokenizer": provenance["tokenizer"],
                  "tokenizer_dir": str(tokenizer_dir), "historical_audit": str(historical),
                  "implementation_sha256": code_before, "evaluation_budget": composition.BUDGET,
                  "primary_validation": "unweighted", "weighted_validation": "development_exposed_auxiliary",
                  "consumer": "counseling_pipeline.supporter_weighted_loss",
                  "training_executed": False, "human_or_expert_approved": False,
                  "independent_test_eligible": False, "automatic_task_mixing": False}
        (temporary / "weights.jsonl").write_text("".join(canonical(x) + "\n" for x in ledger(records, weights)), encoding="utf-8")
        for name, content in (("policy.json", policy), ("summary.json", summary)):
            (temporary / name).write_text(json.dumps(content, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
        blobs = composition.capture(temporary, FILES)
        manifest = {"schema_version": VERSION, "files": {n: {"sha256": composition.sha(b), "bytes": len(b)}
                     for n, b in sorted(blobs.items())}, "training_executed": False}
        (temporary / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        require(implementation_hashes(root) == code_before, "implementation changed during build")
        require(composition.hashes(audit.capture_composition(root)) == policy["source_sha256"], "source changed before publication")
        require(composition.hashes(composition.capture(tokenizer_dir, audit.ASSETS)) == policy["tokenizer"]["asset_sha256"],
                "tokenizer changed before publication")
        require(composition.hashes(read_audit(reference_audit)[0]) == policy["reference_sha256"], "reference changed")
        require(not output.exists(), "output appeared during build")
        os.rename(temporary, output)
        return summary
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def load(directory):
    """Verify source/code/hash bindings and recalculate the exact weighting policy."""
    directory = Path(directory).absolute()
    check_inventory(directory, FILES | {"manifest.json"})
    blobs = composition.capture(directory, FILES | {"manifest.json"})
    manifest = composition.parse(blobs["manifest.json"])
    require(manifest.get("schema_version") == VERSION and manifest.get("training_executed") is False,
            "invalid policy manifest")
    require(canonical(manifest["files"]) == canonical({n: {"sha256": composition.sha(blobs[n]), "bytes": len(blobs[n])} for n in FILES}),
            "policy file binding mismatch")
    policy = composition.parse(blobs["policy.json"])
    require(policy.get("schema_version") == VERSION and policy.get("rule") == RULE
            and policy.get("primary_validation") == "unweighted"
            and policy.get("weighted_validation") == "development_exposed_auxiliary"
            and policy.get("consumer") == "counseling_pipeline.supporter_weighted_loss"
            and all(policy.get(k) is False for k in ("training_executed", "human_or_expert_approved",
                                                   "independent_test_eligible", "automatic_task_mixing"))
            and canonical(policy.get("evaluation_budget")) == canonical(composition.BUDGET), "invalid policy contract")
    root = Path(policy["source_root"])
    require(implementation_hashes(root) == policy["implementation_sha256"], "policy implementation is stale")
    require(composition.hashes(audit.capture_composition(root)) == policy["source_sha256"], "source binding changed")
    reference, old = read_audit(policy["reference_audit"])
    require(composition.hashes(reference) == policy["reference_sha256"], "reference audit changed")
    raw_blobs, records = read_audit(directory / "raw_tokens")
    require(canonical(records) == canonical(old), "policy changed frozen token records")
    require(raw_blobs["summary.json"] == reference["summary.json"], "policy changed frozen raw summary")
    weights = weights_for(records)
    entries = composition.lines(blobs["weights.jsonl"])
    for entry in entries:
        read_ratio(entry["weight"])
    require(canonical(entries) == canonical(ledger(records, weights)), "weights do not match exact source-bound policy")
    require(canonical(composition.parse(blobs["summary.json"])) == canonical(policy_summary(records, weights)), "weighted summary changed")
    provenance = composition.parse(blobs["raw_tokens/provenance.json"])
    require(canonical(provenance["inputs_sha256"]) == canonical(policy["source_sha256"])
            and canonical(provenance["tokenizer"]) == canonical(policy["tokenizer"]),
            "fresh measurement provenance mismatch")
    return policy, records, weights, composition.sha(blobs["manifest.json"])


def check_source_records(records, blobs):
    """Bind the complete ledger identity inventory to authoritative source lines."""
    baseline = set(composition.parse(blobs["supporter/manifest.json"])["baseline_episode_ids"])
    expected = {}
    for name in sorted(blobs):
        is_app = name in {f"app_stages_r2/{s}.jsonl" for s in ("train", "validation")}
        if not is_app and name not in {f"supporter/{t}/{s}.jsonl" for t in audit.STREAMS[:3] for s in ("train", "validation")}:
            continue
        for number, raw in enumerate(blobs[name].split(b"\n"), 1):
            if not raw:
                continue
            source = composition.parse(raw)
            audit.checked_adapter_row(source, is_app=is_app)
            stream = source["task"] if is_app else source["unit"]
            require(stream in (audit.STREAMS[3:] if is_app else audit.STREAMS[:3]), "source task mismatch")
            require(source["split"] == Path(name).stem, "source split/file mismatch")
            require(is_app or name == f"supporter/{stream}/{source['split']}.jsonl", "source task/file mismatch")
            for field in ("source_group_ids", "source_root_ids"):
                require(isinstance(source[field], list) and len(source[field]) == 1
                        and isinstance(source[field][0], str) and bool(source[field][0]), "ambiguous source identity")
            item = {"stream": stream, "split": source["split"],
                    "row_id": source["candidate_id"] if is_app else source["row_id"],
                    "group_id": source["source_group_ids"][0], "root_id": source["source_root_ids"][0],
                    "cohort": "baseline_v2" if not is_app and source["episode_id"] in baseline else "new_v9",
                    "source_file": name, "line_number": number, "source_line_sha256": composition.sha(raw + b"\n"),
                    "row_sha256": digest(source), "messages_sha256": digest(source["messages"])}
            require(identity(item) not in expected, "duplicate source identity")
            expected[identity(item)] = item
    require(len(records) == len(expected) and {identity(r) for r in records} == set(expected), "source row inventory differs")
    for r in records:
        item = expected[identity(r)]
        require(canonical({k: r[k] for k in item}) == canonical(item), "source metadata/line binding changed")


def prepare_view(directory, tokenizer, *, task, split):
    """Freshly encode one task/split for the explicit weighted-loss consumer."""
    require(task in audit.STREAMS and split in {"train", "validation"}, "invalid view")
    policy, records, weights, manifest_hash = load(directory)
    require(audit.adapter._check_template(tokenizer) == policy["tokenizer"]["chat_template_sha256"], "template changed")
    root, entries = Path(policy["source_root"]), []
    blobs = audit.capture_composition(root)
    check_source_records(records, blobs)
    for r in records:
        if r["stream"] != task or r["split"] != split:
            continue
        raw = blobs[r["source_file"]].split(b"\n")[r["line_number"] - 1]
        require(composition.sha(raw + b"\n") == r["source_line_sha256"], "source line changed")
        source = composition.parse(raw)
        encoded = audit.adapter.encode_example(audit.checked_adapter_row(source, is_app=task in audit.STREAMS[3:]), tokenizer)
        for field in ("prefix_length", "target_length", "sequence_length"):
            require(encoded[field] == r[field], "actual token length changed")
        require(digest(encoded["input_ids"]) == r["full_ids_sha256"], "actual token IDs changed")
        entries.append({"stream": task, "split": split, "row_id": r["row_id"], "encoded": encoded,
                        "weight": ratio(weights[identity(r)])})
    require(bool(entries), "empty task view")
    require(load(directory)[3] == manifest_hash, "policy changed during view preparation")
    return entries, {"policy_manifest_sha256": manifest_hash, "source_sha256": policy["source_sha256"],
                     "tokenizer": policy["tokenizer"], "task": task, "split": split}


def verify(directory, *, node="node"):
    policy, records, _, manifest_hash = load(directory)
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", TOKENIZERS_PARALLELISM="false")
    root = Path(policy["source_root"])
    source_manifest, _ = audit.validate_artifacts(root, node)
    tokenizer, provenance, _ = audit.load_tokenizer(Path(policy["tokenizer_dir"]), Path(policy["historical_audit"]))
    require(canonical(provenance) == canonical(policy["tokenizer"]), "tokenizer provenance changed")
    fresh = audit.measure(root, tokenizer, set(source_manifest["baseline_episode_ids"]), audit.capture_composition(root))
    require(canonical(fresh) == canonical(records), "fresh actual tokenizer disagrees")
    require(composition.hashes(composition.capture(Path(policy["tokenizer_dir"]), audit.ASSETS))
            == policy["tokenizer"]["asset_sha256"], "tokenizer files changed during verification")
    require(load(directory)[3] == manifest_hash, "policy changed during verification")
    return {"status": "verified", "rows_freshly_reencoded": len(fresh), "policy_manifest_sha256": manifest_hash,
            "source_and_split_preserved": True, "raw_metrics_unchanged": True, "weighted_gates_pass": True,
            "model_training_run": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build_parser = sub.add_parser("build")
    for option in ("composition", "reference-audit", "tokenizer", "historical-audit", "output"):
        build_parser.add_argument("--" + option, required=True)
    build_parser.add_argument("--node", default="node")
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--policy", required=True)
    verify_parser.add_argument("--node", default="node")
    args = parser.parse_args()
    if args.command == "verify":
        result = verify(args.policy, node=args.node)
    else:
        summary = build(args.composition, args.reference_audit, args.tokenizer, args.historical_audit,
                        args.output, node=args.node)
        result = {k: summary[k] for k in ("inventory_rows", "raw_input_tokens", "raw_target_tokens",
                  "weighted_input_mass", "nonunit_rows", "runtime_8192_pass", "strict_4096_pass")}
        result["weighted_gates_pass"] = summary["gates"]["all_pass"]
    print(json.dumps(result, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
