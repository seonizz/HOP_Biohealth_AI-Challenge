"""Independent synthetic contracts for the opt-in weighting policy.

These tests use invented token metadata, never the private supporter corpus or
a model/tokenizer. Publication tests mock only external measurement and input
capture; policy math, manifests, files and loaders execute normally.
"""
import copy
from fractions import Fraction
import hashlib
import json
import math
from pathlib import Path
import random
import tempfile
import unittest
from unittest.mock import patch

from counseling_pipeline import supporter_group_weighting as weighting


def records_fixture():
    records = []
    for stream in weighting.audit.STREAMS:
        for split in ("train", "validation"):
            sizes = (1, 1, 2, 3) if stream in weighting.audit.STREAMS[:3] else (1, 1)
            line = 0
            for group, size in enumerate(sizes):
                for item in range(size):
                    line += 1
                    label = f"synthetic-{stream}-{split}-{group}-{item}"
                    record = {
                        "stream": stream, "split": split,
                        "row_id": label, "group_id": f"synthetic-{stream}-{split}-{group}",
                        "root_id": f"synthetic-root-{stream}-{split}-{group}",
                        "cohort": "baseline_v2" if group < 2 and stream in weighting.audit.STREAMS[:3] else "new_v9",
                        "source_file": f"{stream}/{split}.jsonl", "line_number": line,
                        "prefix_length": 100, "target_length": 10, "sequence_length": 110,
                        "runtime_8192": True, "strict_4096": True,
                        "prefix_plus_reserved_output": 8292,
                        "raw_template_prefix_match": False, "canonicalization_applied": True,
                        "source_boundary_whitespace_trimmed_messages": 0,
                    }
                    for field in weighting.HASH_FIELDS:
                        record[field] = hashlib.sha256(f"{label}-{field}".encode()).hexdigest()
                    records.append(record)
    return records


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def source_records_fixture():
    records = records_fixture()
    files, baseline = {}, set()
    for record in records:
        task, split = record["stream"], record["split"]
        app = task in weighting.audit.STREAMS[3:]
        name = f"app_stages_r2/{split}.jsonl" if app else f"supporter/{task}/{split}.jsonl"
        episode = "synthetic-episode-" + record["group_id"]
        if record["cohort"] == "baseline_v2":
            baseline.add(episode)
        source = {"messages": [{"role": "user", "content": "synthetic fixture request"},
                               {"role": "assistant", "content": "synthetic fixture response"}],
                  "split": split, "source_group_ids": [record["group_id"]],
                  "source_root_ids": [record["root_id"]]}
        if app:
            source.update(task=task, candidate_id=record["row_id"],
                          loss_mask={"unit": "message", "values": [0, 1], "token_mask_materialized": False})
        else:
            source.update(unit=task, row_id=record["row_id"], episode_id=episode, loss_message_mask=[0, 1])
        raw = (weighting.canonical(source) + "\n").encode()
        files.setdefault(name, []).append(raw)
        record.update(source_file=name, line_number=len(files[name]),
                      source_line_sha256=weighting.composition.sha(raw), row_sha256=weighting.digest(source),
                      messages_sha256=weighting.digest(source["messages"]))
    blobs = {name: b"".join(lines) for name, lines in files.items()}
    blobs["supporter/manifest.json"] = (weighting.canonical({"baseline_episode_ids": sorted(baseline)}) + "\n").encode()
    return records, blobs


class ExactMathTests(unittest.TestCase):
    def test_positive_reduced_rational_round_trip(self):
        for value in (Fraction(1), Fraction(7, 4), Fraction(10**50 + 1, 10**50 + 3)):
            self.assertEqual(weighting.read_ratio(weighting.ratio(value)), value)

    def test_rational_types_sign_and_nonfinite_values_are_rejected(self):
        invalid = [True, False, 0, -1, 1.0, "1", None, math.nan, math.inf]
        for field in ("numerator", "denominator"):
            for value in invalid:
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    weighting.read_ratio({"numerator": 1, "denominator": 1, field: value})
        for value in ({"numerator": 2, "denominator": 4}, {"numerator": 1},
                      {"numerator": 1, "denominator": 1, "extra": False}, [1, 1], None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                weighting.read_ratio(value)

    def test_concentration_is_population_cv_and_not_raw_hhi(self):
        masses = [Fraction(1), Fraction(2), Fraction(3)]
        result = weighting.exact_concentration(masses)
        self.assertEqual(result["hhi"], Fraction(7, 18))
        self.assertEqual(result["normalized_hhi"], Fraction(1, 12))
        self.assertEqual(result["cv_squared"], Fraction(1, 6))
        self.assertEqual(result["effective_groups"], Fraction(18, 7))
        self.assertEqual(result["top5_share"], 1)

    def test_single_group_normalized_hhi_is_undefined(self):
        result = weighting.exact_concentration([Fraction(7)])
        self.assertIsNone(result["normalized_hhi"])
        self.assertEqual(result["hhi"], 1)
        self.assertEqual(result["cv_squared"], 0)

    def test_fraction_precision_does_not_silently_accept_tiny_mass_change(self):
        records = records_fixture()
        weights = weighting.weights_for(records)
        weights[weighting.identity(records[0])] += Fraction(1, 10**50)
        with self.assertRaisesRegex(ValueError, "target mass"):
            weighting.verify_weights(records, weights)


class RecordAndPolicyTests(unittest.TestCase):
    def setUp(self):
        self.records = records_fixture()

    def test_known_closed_form_weights_preserve_source_and_group_relative_rows(self):
        original = copy.deepcopy(self.records)
        weights = weighting.weights_for(self.records)
        for task in weighting.audit.STREAMS[:3]:
            for split in ("train", "validation"):
                selected = [r for r in self.records if r["stream"] == task and r["split"] == split]
                expected = [Fraction(7, 4), Fraction(7, 4), Fraction(7, 8), Fraction(7, 8),
                            Fraction(7, 12), Fraction(7, 12), Fraction(7, 12)]
                self.assertEqual([weights[weighting.identity(r)] for r in selected], expected)
        self.assertEqual(self.records, original)
        weighting.verify_weights(self.records, weights)
        for row in self.records:
            if row["stream"] in weighting.audit.STREAMS[3:]:
                self.assertEqual(weights[weighting.identity(row)], Fraction(1))

    def test_reverse_and_seeded_shuffle_have_identical_exact_weights(self):
        baseline = weighting.weights_for(self.records)
        shuffled = copy.deepcopy(self.records)
        random.Random(20261016).shuffle(shuffled)
        self.assertEqual(weighting.weights_for(shuffled), baseline)
        self.assertEqual(weighting.weights_for(list(reversed(self.records))), baseline)

    def test_train_is_exact_half_mixture_when_input_target_ratios_differ(self):
        rows = [copy.deepcopy(self.records[0]), copy.deepcopy(self.records[1])]
        for row, prefix, target in zip(rows, (100, 300), (20, 30)):
            row.update(prefix_length=prefix, target_length=target, sequence_length=prefix + target)
            row.update(weighting.audit.budget_flags(prefix, target))
        weights = weighting.weights_for(rows)
        self.assertEqual(weights[weighting.identity(rows[0])], Fraction(35, 24))
        self.assertEqual(weights[weighting.identity(rows[1])], Fraction(25, 36))
        prefix_only = weighting.weights_for(rows, "input_only")
        self.assertEqual(prefix_only[weighting.identity(rows[0])], Fraction(5, 3))
        self.assertEqual(prefix_only[weighting.identity(rows[1])], Fraction(5, 9))
        self.assertNotEqual(weights, prefix_only)

    def test_every_task_split_target_total_is_exactly_preserved(self):
        weights = weighting.weights_for(self.records)
        for task in weighting.audit.STREAMS:
            for split in ("train", "validation"):
                selected = [r for r in self.records if r["stream"] == task and r["split"] == split]
                self.assertEqual(sum(weights[weighting.identity(r)] * r["target_length"] for r in selected),
                                 sum(r["target_length"] for r in selected))

    def test_equal_global_total_cannot_hide_cross_split_target_transfer(self):
        weights = weighting.weights_for(self.records)
        train = next(r for r in self.records if r["stream"] == "conversation" and r["split"] == "train")
        validation = next(r for r in self.records if r["stream"] == "conversation" and r["split"] == "validation")
        weights[weighting.identity(train)] += Fraction(1, 10)
        weights[weighting.identity(validation)] -= Fraction(1, 10)
        self.assertEqual(sum(weights[weighting.identity(r)] * r["target_length"] for r in self.records),
                         sum(r["target_length"] for r in self.records))
        with self.assertRaisesRegex(ValueError, "task/split"):
            weighting.verify_weights(self.records, weights)

    def test_equal_task_total_cannot_hide_relative_changes_inside_a_group(self):
        weights = weighting.weights_for(self.records)
        same_group = self.records[2:4]
        self.assertEqual(same_group[0]["group_id"], same_group[1]["group_id"])
        weights[weighting.identity(same_group[0])] += Fraction(1, 10)
        weights[weighting.identity(same_group[1])] -= Fraction(1, 10)
        with self.assertRaisesRegex(ValueError, "within-group"):
            weighting.verify_weights(self.records, weights)

    def test_missing_extra_nonpositive_and_inexact_weights_are_rejected(self):
        original = weighting.weights_for(self.records)
        key = weighting.identity(self.records[0])
        mutations = [lambda w: w.pop(key), lambda w: w.update({("conversation", "extra"): Fraction(1)})]
        for value in (0, Fraction(0), Fraction(-1), True, 1.0, math.nan):
            mutations.append(lambda w, value=value: w.update({key: value}))
        for ordinal, mutate in enumerate(mutations):
            with self.subTest(ordinal=ordinal), self.assertRaises(ValueError):
                changed = original.copy()
                mutate(changed)
                weighting.verify_weights(self.records, changed)

    def test_duplicate_rows_and_group_or_root_split_leakage_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate"):
            weighting.weights_for(self.records + [copy.deepcopy(self.records[0])])
        for field in ("group_id", "root_id"):
            changed = copy.deepcopy(self.records)
            validation = next(r for r in changed if r["split"] == "validation")
            validation[field] = changed[0][field]
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "crossed split"):
                weighting.weights_for(changed)

    def test_measured_integer_fields_and_hashes_are_strict(self):
        for field in ("prefix_length", "target_length", "sequence_length", "line_number"):
            for value in (True, False, 0, -1, 1.0, "1", None):
                changed = copy.deepcopy(self.records)
                changed[0][field] = value
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    weighting.validate_records(changed)
        for field in weighting.HASH_FIELDS:
            changed = copy.deepcopy(self.records)
            changed[0][field] = "g" * 64
            with self.subTest(field=field), self.assertRaises(ValueError):
                weighting.validate_records(changed)

    def test_budget_flags_cannot_be_truthy_integers_or_forged(self):
        for field, values in (("runtime_8192", [1, 1.0, False, None]),
                              ("strict_4096", [1, 1.0, False, None]),
                              ("prefix_plus_reserved_output", [True, 8292.0, 8291, None])):
            for value in values:
                changed = copy.deepcopy(self.records)
                changed[0][field] = value
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    weighting.validate_records(changed)

    def test_output_reservation_and_observed_target_bounds_are_enforced(self):
        for prefix, target, accepted in ((61440, 8192, True), (61441, 1, False), (1, 8193, False)):
            changed = copy.deepcopy(self.records)
            changed[0].update(prefix_length=prefix, target_length=target, sequence_length=prefix + target)
            changed[0].update(weighting.audit.budget_flags(prefix, target))
            with self.subTest(prefix=prefix, target=target):
                if accepted:
                    weighting.validate_records(changed)
                else:
                    with self.assertRaises(ValueError):
                        weighting.validate_records(changed)

    def test_raw_hhi_improvement_cannot_hide_normalized_hhi_regression(self):
        weights = weighting.weights_for(self.records, "identity")
        gates = weighting.gates(self.records, weights)
        self.assertFalse(gates["all_pass"])
        selected = [g for g in gates["concentration"] if g["task"] == "conversation"
                    and g["split"] == "validation" and g["axis"] == "input"]
        self.assertTrue(next(g["pass"] for g in selected if g["metric"] == "hhi"))
        self.assertFalse(next(g["pass"] for g in selected if g["metric"] == "normalized_hhi"))
        self.assertTrue(weighting.gates(self.records, weighting.weights_for(self.records))["all_pass"])

    def test_exact_metric_gate_rejects_a_variation_below_float_precision(self):
        weights = weighting.weights_for(self.records)
        tiny = Fraction(1, 10**40)
        weights[weighting.identity(self.records[0])] += tiny
        weights[weighting.identity(self.records[1])] -= tiny
        weighting.verify_weights(self.records, weights)
        self.assertFalse(weighting.gates(self.records, weights)["all_pass"])

    def test_source_records_and_raw_summary_are_not_rewritten_by_weighted_summary(self):
        original = copy.deepcopy(self.records)
        raw = weighting.audit.summarize(self.records)
        summary = weighting.policy_summary(self.records, weighting.weights_for(self.records))
        self.assertEqual(self.records, original)
        self.assertEqual(weighting.audit.summarize(self.records), raw)
        self.assertIs(summary["raw_concentration_improved"], False)
        self.assertEqual(summary["primary_validation"], "unweighted")
        self.assertIs(summary["model_training_run"], False)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.root = self.base / "source"
        self.reference = self.base / "reference"
        self.tokenizer = self.base / "tokenizer"
        self.output = self.base / "weighted"
        self.historical = self.base / "historical.json"
        self.tokenizer.mkdir()
        for name in weighting.audit.ASSETS:
            (self.tokenizer / name).write_bytes(b"synthetic tokenizer fixture\n")
        self.source_blobs = {"synthetic.jsonl": b'{"synthetic":true}\n'}
        self.code_hashes = {"synthetic-module.py": "b" * 64}
        self.tokenizer_metadata = {
            "asset_sha256": weighting.composition.hashes(weighting.composition.capture(self.tokenizer, weighting.audit.ASSETS)),
            "chat_template_sha256": "c" * 64, "is_fast": True,
        }
        self.records = records_fixture()
        self.write_audit(self.reference, self.records)
        for patcher in (
            patch.object(weighting, "implementation_hashes", return_value=self.code_hashes),
            patch.object(weighting.audit, "capture_composition", return_value=self.source_blobs),
            patch.object(weighting.audit, "run", side_effect=self.measure_stub),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def write_audit(self, directory, records):
        directory.mkdir(parents=True)
        (directory / "row_lengths.jsonl").write_text("".join(weighting.canonical(r) + "\n" for r in records))
        write_json(directory / "summary.json", {
            "schema_version": "malssi-supporter-token-audit-v1", "status": "measured",
            "evaluation_budget": weighting.composition.BUDGET,
            "inventory_rows": len(records), "token_budget_eligible_rows": len(records),
            "strict_4096_rows": len(records), "all_rows_freshly_encoded": True,
            "source_files_unchanged": True, "no_truncation": True, "model_weights_loaded": False,
            "human_or_expert_approved": False, "training_run": False,
            "independent_test_eligible": False, "automatic_task_mixing": False,
            "summary": weighting.audit.summarize(records),
            "inventory_token_sums_not_a_training_mixture": {
                cohort: {"rows": len(selected), "input_tokens": sum(r["prefix_length"] for r in selected),
                         "target_tokens": sum(r["target_length"] for r in selected)}
                for cohort in ("all", "baseline_v2", "new_v9")
                if (selected := [r for r in records if cohort == "all" or r["cohort"] == cohort])},
            "serialization": {"target_includes_native_turn_termination": True,
                "native_full_prefix_match_rows": 0, "explicit_non_thinking_canonicalization_rows": len(records),
                "source_boundary_whitespace_trimmed_messages": 0, "decode_and_label_checks_rows": len(records)},
            "limits": ["Synthetic metadata fixture only; no actual encoding performed."],
        })
        write_json(directory / "provenance.json", {
            "inputs_sha256": weighting.composition.hashes(self.source_blobs),
            "tokenizer": self.tokenizer_metadata,
        })
        self.rehash_audit(directory)

    def rehash_audit(self, directory):
        files = {p.name: {"sha256": weighting.composition.sha(p.read_bytes()), "bytes": p.stat().st_size}
                 for p in directory.iterdir() if p.name != "manifest.json"}
        write_json(directory / "manifest.json", {"schema_version": "malssi-supporter-token-sidecar-v1",
                   "training_authorized": False, "files": files})

    def measure_stub(self, root, tokenizer, historical, output, *, node):
        self.write_audit(output, self.records)

    def build(self, output=None):
        return weighting.build(self.root, self.reference, self.tokenizer, self.historical,
                               output or self.output)

    def rehash_outer(self):
        manifest = json.loads((self.output / "manifest.json").read_text())
        manifest["files"] = {
            name: {"sha256": weighting.composition.sha((self.output / name).read_bytes()),
                   "bytes": (self.output / name).stat().st_size} for name in weighting.FILES}
        write_json(self.output / "manifest.json", manifest)

    def test_actual_policy_files_reproduce_and_preserve_reference_bytes(self):
        before = weighting.composition.capture(self.reference, weighting.AUDIT_FILES)
        summary = self.build()
        _, records, weights, _ = weighting.load(self.output)
        self.assertEqual(records, self.records)
        self.assertEqual(weights, weighting.weights_for(self.records))
        self.assertTrue(summary["gates"]["all_pass"])
        self.assertEqual(weighting.composition.capture(self.reference, weighting.AUDIT_FILES), before)
        self.assertEqual(weighting.composition.capture(self.output / "raw_tokens", weighting.AUDIT_FILES), before)
        second = self.base / "second"
        self.build(second)
        self.assertEqual(weighting.composition.capture(self.output, weighting.FILES | {"manifest.json"}),
                         weighting.composition.capture(second, weighting.FILES | {"manifest.json"}))

    def test_rehashed_missing_duplicate_and_changed_weights_are_rejected(self):
        self.build()
        path = self.output / "weights.jsonl"
        original = path.read_bytes()
        entries = weighting.composition.lines(original)
        variants = [entries[:-1], entries + [copy.deepcopy(entries[0])], copy.deepcopy(entries)]
        variants[-1][0]["weight"] = {"numerator": 1, "denominator": 1}
        for variant in variants:
            path.write_text("".join(weighting.canonical(e) + "\n" for e in variant))
            self.rehash_outer()
            with self.assertRaises(ValueError):
                weighting.load(self.output)

    def test_rehashed_weight_ledger_group_and_integer_boolean_mutations_are_rejected(self):
        self.build()
        path = self.output / "weights.jsonl"
        original = weighting.composition.lines(path.read_bytes())
        for field, value in (("group_id", "synthetic-wrong-group"), ("split", "validation"),
                             ("weight", {"numerator": True, "denominator": 1})):
            variant = copy.deepcopy(original)
            variant[0][field] = value
            path.write_text("".join(weighting.canonical(e) + "\n" for e in variant))
            self.rehash_outer()
            with self.subTest(field=field), self.assertRaises(ValueError):
                weighting.load(self.output)

    def test_manifest_byte_lengths_require_integer_type_even_after_rehash(self):
        self.build()
        for directory in (self.output, self.reference):
            path = directory / "manifest.json"
            manifest = json.loads(path.read_text())
            name = next(iter(manifest["files"]))
            manifest["files"][name]["bytes"] = float(manifest["files"][name]["bytes"])
            write_json(path, manifest)
            with self.subTest(directory=directory.name), self.assertRaises(ValueError):
                weighting.load(self.output) if directory == self.output else weighting.read_audit(self.reference)

    def test_rehashed_weighted_summary_type_and_truth_flag_changes_are_rejected(self):
        self.build()
        path = self.output / "summary.json"
        original = json.loads(path.read_text())
        for field, value in (("inventory_rows", float(len(self.records))),
                             ("raw_concentration_improved", True), ("model_training_run", 0)):
            changed = copy.deepcopy(original)
            changed[field] = value
            write_json(path, changed)
            self.rehash_outer()
            with self.subTest(field=field), self.assertRaises(ValueError):
                weighting.load(self.output)

    def test_raw_summary_float_row_count_is_rejected_with_valid_file_hash(self):
        path = self.reference / "summary.json"
        summary = json.loads(path.read_text())
        summary["summary"]["conversation"]["all"]["all"]["rows"] = 14.0
        write_json(path, summary)
        self.rehash_audit(self.reference)
        with self.assertRaisesRegex(ValueError, "raw summary"):
            weighting.read_audit(self.reference)

    def test_raw_summary_false_authority_and_count_contract_is_typed(self):
        path = self.reference / "summary.json"
        original = json.loads(path.read_text())
        for field, value in (("human_or_expert_approved", True), ("training_run", True),
                             ("model_weights_loaded", True), ("independent_test_eligible", True),
                             ("automatic_task_mixing", True), ("all_rows_freshly_encoded", 1),
                             ("inventory_rows", float(len(self.records))), ("no_truncation", False)):
            changed = copy.deepcopy(original)
            changed[field] = value
            write_json(path, changed)
            self.rehash_audit(self.reference)
            with self.subTest(field=field), self.assertRaises(ValueError):
                weighting.read_audit(self.reference)

    def test_policy_contract_cannot_claim_training_or_primary_weighted_validation(self):
        self.build()
        path = self.output / "policy.json"
        original = json.loads(path.read_text())
        for field, value in (("training_executed", True), ("human_or_expert_approved", 0),
                             ("primary_validation", "weighted"), ("rule", "identity")):
            variant = copy.deepcopy(original)
            variant[field] = value
            write_json(path, variant)
            self.rehash_outer()
            with self.subTest(field=field), self.assertRaises(ValueError):
                weighting.load(self.output)

    def test_internal_directory_symlink_and_unexpected_files_are_rejected(self):
        self.build()
        raw = self.output / "raw_tokens"
        saved = self.base / "saved-raw"
        raw.rename(saved)
        raw.symlink_to(saved, target_is_directory=True)
        with self.assertRaises(ValueError):
            weighting.load(self.output)
        raw.unlink()
        saved.rename(raw)
        (self.output / "unexpected.json").write_text("{}\n")
        with self.assertRaises(ValueError):
            weighting.load(self.output)

    def test_source_or_implementation_changes_invalidate_loading(self):
        self.build()
        with patch.object(weighting, "implementation_hashes", return_value={"changed.py": "d" * 64}):
            with self.assertRaisesRegex(ValueError, "implementation"):
                weighting.load(self.output)
        with patch.object(weighting.audit, "capture_composition", return_value={"changed.jsonl": b"{}\n"}):
            with self.assertRaisesRegex(ValueError, "source"):
                weighting.load(self.output)

    def test_fresh_measurement_deletion_cannot_replace_reference(self):
        self.records = self.records[:-1]
        with self.assertRaisesRegex(ValueError, "frozen reference"):
            self.build()
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.base.glob(".supporter-weighting-*")))

    def test_source_or_code_swap_before_publication_leaves_no_partial_output(self):
        with patch.object(weighting, "implementation_hashes", side_effect=[self.code_hashes, {"changed": "e" * 64}]):
            with self.assertRaisesRegex(ValueError, "implementation changed"):
                self.build()
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.base.glob(".supporter-weighting-*")))
        with patch.object(weighting.audit, "capture_composition", return_value={"changed.jsonl": b"{}\n"}):
            with self.assertRaisesRegex(ValueError, "source changed"):
                self.build()
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.base.glob(".supporter-weighting-*")))

    def test_no_overwrite_and_atomic_rename_failure_preserve_inputs(self):
        self.output.mkdir()
        marker = self.output / "preserve.txt"
        marker.write_text("synthetic existing output\n")
        with self.assertRaises(ValueError):
            self.build()
        self.assertEqual(marker.read_text(), "synthetic existing output\n")
        failure_output = self.base / "failed-publication"
        reference_before = weighting.composition.capture(self.reference, weighting.AUDIT_FILES)
        with patch.object(weighting.os, "rename", side_effect=OSError("synthetic rename failure")):
            with self.assertRaises(OSError):
                self.build(failure_output)
        self.assertFalse(failure_output.exists())
        self.assertFalse(list(self.base.glob(".supporter-weighting-*")))
        self.assertEqual(weighting.composition.capture(self.reference, weighting.AUDIT_FILES), reference_before)

    def test_publication_cannot_write_inside_any_preserved_input_artifact(self):
        for parent in (self.root, self.reference, self.tokenizer):
            with self.subTest(parent=parent.name), self.assertRaisesRegex(ValueError, "preserved input"):
                self.build(parent / "new-weighted-output")
            self.assertFalse((parent / "new-weighted-output").exists())


class FreshViewTests(unittest.TestCase):
    def setUp(self):
        self.record = records_fixture()[0]
        self.record["source_file"] = "supporter/conversation/train.jsonl"
        self.source = {"messages": [{"role": "user", "content": "synthetic request"},
                                     {"role": "assistant", "content": "synthetic response"}],
                       "loss_message_mask": [0, 1], "unit": "conversation", "split": "train",
                       "row_id": self.record["row_id"], "episode_id": "synthetic-episode",
                       "source_group_ids": [self.record["group_id"]],
                       "source_root_ids": [self.record["root_id"]]}
        self.raw = (weighting.canonical(self.source) + "\n").encode()
        self.record["source_line_sha256"] = weighting.composition.sha(self.raw)
        self.record["row_sha256"] = weighting.digest(self.source)
        self.record["messages_sha256"] = weighting.digest(self.source["messages"])
        self.encoded = {"prefix_length": 100, "target_length": 10, "sequence_length": 110,
                        "input_ids": list(range(110)), "labels": [-100] * 100 + list(range(100, 110))}
        self.record["full_ids_sha256"] = weighting.digest(self.encoded["input_ids"])
        self.record["prefix_ids_sha256"] = weighting.digest(self.encoded["input_ids"][:100])
        self.record["target_ids_sha256"] = weighting.digest(self.encoded["input_ids"][100:])
        self.policy = {"source_root": "/synthetic/source", "source_sha256": {"synthetic": "a" * 64},
                       "tokenizer": {"chat_template_sha256": "b" * 64}}
        self.loaded = (self.policy, [self.record], {weighting.identity(self.record): Fraction(1)}, "c" * 64)

    def prepare(self, *, second_hash=None, raw=None, encoded=None):
        second = self.loaded if second_hash is None else (*self.loaded[:3], second_hash)
        blobs = {self.record["source_file"]: raw or self.raw,
                 "supporter/manifest.json": b'{"baseline_episode_ids":["synthetic-episode"]}\n'}
        with patch.object(weighting, "load", side_effect=[self.loaded, second]), \
             patch.object(weighting.audit, "capture_composition", return_value=blobs), \
             patch.object(weighting.audit.adapter, "_check_template", return_value="b" * 64), \
             patch.object(weighting.audit.adapter, "encode_example", return_value=encoded or self.encoded):
            return weighting.prepare_view("/synthetic/policy", object(), task="conversation", split="train")

    def test_fresh_view_uses_original_row_and_expected_exact_weight(self):
        entries, binding = self.prepare()
        self.assertEqual(entries[0]["encoded"], self.encoded)
        self.assertEqual(entries[0]["weight"], {"numerator": 1, "denominator": 1})
        self.assertEqual(binding["policy_manifest_sha256"], "c" * 64)

    def test_policy_swap_during_view_preparation_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "policy changed"):
            self.prepare(second_hash="d" * 64)

    def test_source_line_or_token_ids_change_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "source.*binding|source line"):
            self.prepare(raw=self.raw[:-1] + b" \n")
        changed = copy.deepcopy(self.encoded)
        changed["input_ids"][0] = 999
        with self.assertRaisesRegex(ValueError, "token IDs"):
            self.prepare(encoded=changed)

    def test_consumer_rejects_metadata_forgery_even_after_a_successful_policy_load(self):
        original = copy.deepcopy(self.record)
        for field, value in (("group_id", "synthetic-forged-group"), ("root_id", "synthetic-forged-root"),
                             ("cohort", "new_v9"), ("row_id", "synthetic-forged-row")):
            self.record.clear()
            self.record.update(original)
            self.record[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.prepare()


class SourceBindingTests(unittest.TestCase):
    def setUp(self):
        self.records, self.blobs = source_records_fixture()

    def mutate_first_source(self, name, mutate):
        blobs = self.blobs.copy()
        lines = blobs[name].splitlines(keepends=True)
        source = json.loads(lines[0])
        mutate(source)
        lines[0] = (weighting.canonical(source) + "\n").encode()
        blobs[name] = b"".join(lines)
        return blobs

    def test_full_inventory_and_reverse_order_bind_without_mutating_source(self):
        before_records, before_blobs = copy.deepcopy(self.records), self.blobs.copy()
        weighting.check_source_records(self.records, self.blobs)
        weighting.check_source_records(list(reversed(self.records)), self.blobs)
        self.assertEqual(self.records, before_records)
        self.assertEqual(self.blobs, before_blobs)

    def test_group_root_cohort_and_row_identity_changes_are_rejected(self):
        changes = {"group_id": "synthetic-forged-group", "root_id": "synthetic-forged-root",
                   "cohort": "new_v9", "row_id": "synthetic-forged-row",
                   "split": "validation", "stream": "word"}
        for field, value in changes.items():
            records = copy.deepcopy(self.records)
            records[0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                weighting.check_source_records(records, self.blobs)

    def test_source_pointer_line_type_and_all_source_hashes_are_bound(self):
        changes = {"source_file": "supporter/word/train.jsonl", "line_number": True,
                   "source_line_sha256": "0" * 64, "row_sha256": "0" * 64,
                   "messages_sha256": "0" * 64}
        for field, value in changes.items():
            records = copy.deepcopy(self.records)
            records[0][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                weighting.check_source_records(records, self.blobs)

    def test_deletion_duplicate_and_same_length_duplicate_replacement_are_rejected(self):
        variants = [self.records[:-1], self.records + [copy.deepcopy(self.records[0])],
                    self.records[:-1] + [copy.deepcopy(self.records[0])]]
        for ordinal, records in enumerate(variants):
            with self.subTest(ordinal=ordinal), self.assertRaisesRegex(ValueError, "inventory"):
                weighting.check_source_records(records, self.blobs)

    def test_source_line_deletion_or_duplicate_cannot_be_hidden_in_ledger(self):
        name = "supporter/conversation/train.jsonl"
        lines = self.blobs[name].splitlines(keepends=True)
        for value in (b"".join(lines[1:]), b"".join(lines + [lines[0]])):
            blobs = self.blobs.copy()
            blobs[name] = value
            with self.assertRaises(ValueError):
                weighting.check_source_records(self.records, blobs)

    def test_supporter_unit_split_and_file_must_agree(self):
        name = "supporter/conversation/train.jsonl"
        for field, value in (("unit", "word"), ("unit", "relationship_memory"), ("split", "validation")):
            blobs = self.mutate_first_source(name, lambda source: source.update({field: value}))
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, "task|split"):
                weighting.check_source_records(self.records, blobs)

    def test_app_stage_identity_and_supported_task_are_bound(self):
        name = "app_stages_r2/train.jsonl"
        for field, value in (("candidate_id", "synthetic-forged-app-row"), ("task", "conversation"),
                             ("task", "relationship_memory")):
            blobs = self.mutate_first_source(name, lambda source: source.update({field: value}))
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                weighting.check_source_records(self.records, blobs)

    def test_source_masks_and_ambiguous_lineage_are_rejected(self):
        name = "supporter/conversation/train.jsonl"
        for field, value in (("loss_message_mask", [1, 1]), ("loss_message_mask", [False, True]),
                             ("source_group_ids", []), ("source_group_ids", ["synthetic-one", "synthetic-two"]),
                             ("source_root_ids", ["synthetic-one", "synthetic-two"])):
            blobs = self.mutate_first_source(name, lambda source: source.update({field: value}))
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                weighting.check_source_records(self.records, blobs)


if __name__ == "__main__":
    unittest.main()
