"""Independent synthetic helper contracts; not real-tokenizer evidence.

No authored or source training text is read here. These checks cover immutable
wire adaptation, typed masks, concentration arithmetic and reservation limits.
"""
import copy
from fractions import Fraction
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from counseling_pipeline import supporter_token_audit as audit


def row_fixture(*, app=False, history=False):
    # Deliberately retain boundary whitespace, Unicode spelling and JSON order.
    messages = [
        {"role": "system", "content": "  synthetic system\n"},
        {"role": "user", "content": '{ "z": "e\u0301\u2028Ａ", "a": "\\n" }'},
    ]
    if history:
        messages.extend([
            {"role": "assistant", "content": '{"same":"target"}'},
            {"role": "user", "content": "synthetic later input\u2029"},
        ])
    messages.append({"role": "assistant", "content": ' \n{"same":"target"}\t '})
    mask = [0] * (len(messages) - 1) + [1]
    row = {"messages": messages, "opaque_metadata": {"review": False, "values": [3, 2, 1]}}
    if app:
        row["loss_mask"] = {"unit": "message", "values": mask, "token_mask_materialized": False}
    else:
        row["loss_message_mask"] = mask
    return row


class AdapterRowTests(unittest.TestCase):
    def assert_unchanged(self, source, before):
        self.assertEqual(source, before)
        self.assertEqual(
            json.dumps(source, ensure_ascii=False, separators=(",", ":")),
            json.dumps(before, ensure_ascii=False, separators=(",", ":")),
        )

    def assert_rejected_without_mutation(self, row, *, app):
        before = copy.deepcopy(row)
        with self.assertRaises(ValueError):
            audit.checked_adapter_row(row, is_app=app)
        self.assert_unchanged(row, before)

    def test_supporter_wire_strings_and_flat_mask_remain_exact(self):
        source = row_fixture(history=True)
        before = copy.deepcopy(source)
        adapted = audit.checked_adapter_row(source)
        self.assertEqual(adapted["messages"], before["messages"])
        self.assertEqual(adapted["loss_message_mask"], [0, 0, 0, 0, 1])
        self.assertTrue(all(type(value) is int for value in adapted["loss_message_mask"]))
        self.assert_unchanged(source, before)

    def test_app_nested_mask_is_explicitly_mapped_without_rewriting_wire(self):
        source = row_fixture(app=True)
        before = copy.deepcopy(source)
        adapted = audit.checked_adapter_row(source, is_app=True)
        self.assertEqual(adapted["messages"], before["messages"])
        self.assertEqual(adapted["loss_message_mask"], [0, 0, 1])
        self.assertTrue(all(type(value) is int for value in adapted["loss_message_mask"]))
        self.assert_unchanged(source, before)

    def test_repeated_prior_target_does_not_receive_supervision(self):
        source = row_fixture(app=True, history=True)
        adapted = audit.checked_adapter_row(source, is_app=True)
        self.assertEqual(adapted["loss_message_mask"], [0, 0, 0, 0, 1])
        self.assertEqual(adapted["messages"], source["messages"])

    def test_boolean_masks_cannot_pass_as_integer_zero_and_one(self):
        for app in (False, True):
            for mask in ([False, False, True], [0, 0, True], [False, 0, 1]):
                with self.subTest(app=app, mask=mask):
                    row = row_fixture(app=app)
                    if app:
                        row["loss_mask"]["values"] = mask
                    else:
                        row["loss_message_mask"] = mask
                    self.assert_rejected_without_mutation(row, app=app)

    def test_context_supervision_zero_supervision_and_wrong_lengths_are_rejected(self):
        for app in (False, True):
            for mask in ([1, 0, 1], [0, 1, 1], [1, 1, 1], [0, 0, 0], [0, 1],
                         [0, 0, 0, 1], [], [0, 0, 2], [0.0, 0, 1], [0, 0, "1"]):
                with self.subTest(app=app, mask=mask):
                    row = row_fixture(app=app)
                    if app:
                        row["loss_mask"]["values"] = mask
                    else:
                        row["loss_message_mask"] = mask
                    self.assert_rejected_without_mutation(row, app=app)

    def test_masks_must_be_lists(self):
        for app in (False, True):
            for mask in ((0, 0, 1), "001", None, {"0": 0, "1": 0, "2": 1}):
                with self.subTest(app=app, kind=type(mask).__name__):
                    row = row_fixture(app=app)
                    if app:
                        row["loss_mask"]["values"] = mask
                    else:
                        row["loss_message_mask"] = mask
                    self.assert_rejected_without_mutation(row, app=app)

    def test_supporter_requires_flat_mask_and_forbids_any_nested_mask(self):
        source = row_fixture()
        del source["loss_message_mask"]
        self.assert_rejected_without_mutation(source, app=False)
        for extra in (None, {}, {"unit": "message", "values": [0, 0, 1], "token_mask_materialized": False}):
            with self.subTest(extra=extra):
                source = row_fixture()
                source["loss_mask"] = extra
                self.assert_rejected_without_mutation(source, app=False)

    def test_app_requires_nested_mask_and_forbids_even_matching_flat_mask(self):
        source = row_fixture(app=True)
        del source["loss_mask"]
        self.assert_rejected_without_mutation(source, app=True)
        for extra in (None, [], [0, 0, 1]):
            with self.subTest(extra=extra):
                source = row_fixture(app=True)
                source["loss_message_mask"] = extra
                self.assert_rejected_without_mutation(source, app=True)

    def test_app_mask_unit_materialization_and_keys_are_exact(self):
        changes = [
            lambda m: m.update(unit="token"),
            lambda m: m.update(token_mask_materialized=True),
            lambda m: m.update(token_mask_materialized=0),
            lambda m: m.update(token_mask_materialized="false"),
            lambda m: m.update(token_mask_materialized=None),
            lambda m: m.pop("unit"),
            lambda m: m.pop("values"),
            lambda m: m.pop("token_mask_materialized"),
            lambda m: m.update(extra=False),
        ]
        for ordinal, change in enumerate(changes):
            with self.subTest(ordinal=ordinal):
                row = row_fixture(app=True)
                change(row["loss_mask"])
                self.assert_rejected_without_mutation(row, app=True)


class ConcentrationTests(unittest.TestCase):
    def assert_concentration(self, values):
        before = copy.deepcopy(values)
        result = audit.concentration(values)
        self.assertEqual(values, before)
        ordered = sorted(values, reverse=True)
        count, total = len(values), sum(values)
        hhi = Fraction(sum(value * value for value in values), total * total)
        self.assertEqual(result["groups"], count)
        self.assertEqual(result["total"], total)
        self.assertIs(type(result["groups"]), int)
        self.assertIs(type(result["total"]), int)
        for k in (1, 5, 10):
            expected = Fraction(sum(ordered[:k]), total)
            actual = result[f"top{k}_share"]
            self.assertAlmostEqual(actual, float(expected), places=14)
            self.assertGreater(actual, 0)
            self.assertLessEqual(actual, 1)
        self.assertAlmostEqual(result["hhi"], float(hhi), places=14)
        self.assertAlmostEqual(result["effective_groups"], float(1 / hhi), places=12)
        self.assertAlmostEqual(result["cv"], math.sqrt(float(count * hhi - 1)), places=12)
        if count == 1:
            self.assertIsNone(result["normalized_hhi"])
        else:
            normalized_hhi = (hhi - Fraction(1, count)) / (1 - Fraction(1, count))
            self.assertAlmostEqual(result["normalized_hhi"], float(normalized_hhi), places=14)
            self.assertGreaterEqual(result["normalized_hhi"], 0)
            self.assertLessEqual(result["normalized_hhi"], 1)
        return result

    def test_one_group_has_no_defined_normalized_hhi(self):
        self.assert_concentration([37])

    def test_six_uniform_groups_do_not_make_top5_one(self):
        self.assert_concentration([5] * 6)

    def test_topk_sorts_masses_and_caps_k_at_group_count(self):
        self.assert_concentration([4, 1, 12, 7, 2, 10, 6, 3, 11, 5, 9, 8])

    def test_nonuniform_hhi_effective_groups_and_population_cv(self):
        self.assert_concentration([1, 2, 3])

    def test_large_integer_counts_do_not_become_row_weights_or_round_total(self):
        self.assert_concentration([2**54 + 1, 2**54 - 1, 7])

    def test_scaling_and_permutation_leave_shares_unchanged(self):
        base = audit.concentration([2, 7, 1, 4])
        changed = audit.concentration([4 * 17, 1 * 17, 7 * 17, 2 * 17])
        self.assertEqual(changed["total"], base["total"] * 17)
        for key in ("top1_share", "top5_share", "top10_share", "hhi", "normalized_hhi", "effective_groups", "cv"):
            self.assertAlmostEqual(base[key], changed[key], places=12)

    def test_empty_and_invalid_group_masses_are_rejected(self):
        for values in ([], [True], [False], [0], [-1], [1.0], [math.nan], [math.inf],
                       [1, False], [2, 0], [2, -1], [1, "2"], [None]):
            with self.subTest(values=values), self.assertRaises(ValueError):
                audit.concentration(values)


class BudgetTests(unittest.TestCase):
    def assert_flags(self, prefix, target, runtime, strict):
        result = audit.budget_flags(prefix, target)
        self.assertIs(result["runtime_8192"], runtime)
        self.assertIs(result["strict_4096"], strict)
        self.assertEqual(result["prefix_plus_reserved_output"], prefix + 8192)
        self.assertIs(type(result["prefix_plus_reserved_output"]), int)

    def test_maximum_reserved_input_and_target_fit_exactly(self):
        self.assert_flags(61440, 8192, True, False)

    def test_observed_short_target_cannot_bypass_reserved_output(self):
        self.assert_flags(61441, 1, False, False)
        self.assert_flags(65536, 1, False, False)

    def test_target_may_not_exceed_8192_even_when_sequence_is_small(self):
        self.assert_flags(1, 8193, False, False)

    def test_strict_4096_boundary_uses_prefix_plus_observed_target(self):
        self.assert_flags(4095, 1, True, True)
        self.assert_flags(1, 4095, True, True)
        self.assert_flags(4096, 1, True, False)

    def test_output_8192_does_not_mean_every_prefix_reserves_only_observed_target(self):
        self.assert_flags(61440, 1, True, False)
        self.assert_flags(61439, 8192, True, False)
        self.assert_flags(1, 8192, True, False)

    def test_both_total_and_input_limits_reject_overflow(self):
        self.assert_flags(69632, 1, False, False)
        self.assert_flags(65537, 8192, False, False)
        self.assert_flags(61440, 8193, False, False)

    def test_nonpositive_boolean_float_and_string_lengths_are_errors(self):
        for invalid in (0, -1, True, False, 1.0, "1", None, math.nan, math.inf):
            with self.subTest(field="prefix", invalid=invalid), self.assertRaises(ValueError):
                audit.budget_flags(invalid, 1)
            with self.subTest(field="target", invalid=invalid), self.assertRaises(ValueError):
                audit.budget_flags(1, invalid)


class CompositionFixture(unittest.TestCase):
    """Manifest-only fixtures: these do not stand in for a validated dataset."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.root = self.directory / "composition"
        self.root.mkdir()
        old_source, old_supporter = self.directory / "source_v8", self.directory / "supporter_v2"
        self.paths = {
            "preserved_source_v8": old_source / "export_manifest.json",
            "preserved_supporter_v2": old_supporter / "manifest.json",
            "supporter_v9": self.root / "supporter/manifest.json",
            "app_stages_v9": self.root / "app_stages_r2/manifest.json",
            "supporter_ai_reviews": self.root / "authored/revision_2/independent_ai_reviews.jsonl",
            "app_ai_reviews": self.root / "app_authored/independent_ai_reviews_revision3.jsonl",
            "review_binding": self.directory / "review_binding.json",
            "supporter_actual_audit": self.directory / "supporter_audit.json",
            "app_actual_audit": self.directory / "app_audit.json",
        }
        for path in self.paths.values():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"synthetic_fixture":true}\n', encoding="utf-8")
        self.paths["supporter_v9"].write_text(json.dumps({
            "source_anchors": {"source_v8": {"path": str(old_source)},
                               "supporter_v2": {"path": str(old_supporter)}},
            "implementation_sha256": {"gemma4_token_validation.py": "fixture-inventory-only"},
        }), encoding="utf-8")
        self.paths["app_stages_v9"].write_text(json.dumps({
            "dependencies_sha256": {"data/scripts/supporter_app_stage.mjs": "fixture-inventory-only"},
        }), encoding="utf-8")
        self.index = {
            "schema_version": "malssi-supporter-composition-index-v9",
            "source_v8_unchanged": True, "automatic_cross_task_mixing": False,
            "human_approved": False, "training_authorized": False,
            "independent_test_eligible": False, "new_supporter_token_lengths_verified": False,
            "new_app_token_lengths_verified": False,
            "evaluation_budget": {"max_input_tokens": 65536, "max_output_tokens": 8192,
                                  "max_context_tokens": 69632, "effective_max_input_tokens": 61440},
            "components": {role: {"path": str(path), "sha256": audit.composition.sha(path.read_bytes())}
                           for role, path in self.paths.items()},
        }
        self.write_index()

    def write_index(self):
        (self.root / "composition-index.json").write_text(json.dumps(self.index), encoding="utf-8")


class CompositionCaptureTests(CompositionFixture):
    def test_complete_index_has_a_positive_capture_control(self):
        blobs = audit.capture_composition(self.root)
        self.assertEqual(set(blobs), {"composition-index.json", "supporter/manifest.json",
                                     "app_stages_r2/manifest.json"})
        for name, content in blobs.items():
            self.assertEqual(content, (self.root / name).read_bytes())

    def test_each_required_role_cannot_be_omitted_or_renamed(self):
        self.test_complete_index_has_a_positive_capture_control()
        original = copy.deepcopy(self.index)
        for role in original["components"]:
            with self.subTest(role=role):
                self.index = copy.deepcopy(original)
                del self.index["components"][role]
                self.write_index()
                with self.assertRaisesRegex(ValueError, "component inventory"):
                    audit.capture_composition(self.root)
        self.index = copy.deepcopy(original)
        self.index["components"]["unexpected_role"] = self.index["components"]["supporter_v9"]
        self.write_index()
        with self.assertRaisesRegex(ValueError, "component inventory"):
            audit.capture_composition(self.root)

    def test_rehashed_decoy_cannot_replace_measured_manifests_reviews_or_anchors(self):
        original = copy.deepcopy(self.index)
        for role in ("supporter_v9", "app_stages_v9", "preserved_source_v8",
                     "preserved_supporter_v2", "supporter_ai_reviews", "app_ai_reviews"):
            with self.subTest(role=role):
                self.index = copy.deepcopy(original)
                decoy = self.directory / (role + ".decoy")
                decoy.write_bytes(self.paths[role].read_bytes())
                self.index["components"][role] = {"path": str(decoy), "sha256": audit.composition.sha(decoy.read_bytes())}
                self.write_index()
                with self.assertRaisesRegex(ValueError, "declared artifact role"):
                    audit.capture_composition(self.root)

    def test_correct_path_with_changed_bytes_still_fails_hash_binding(self):
        self.test_complete_index_has_a_positive_capture_control()
        self.paths["app_stages_v9"].write_text('{"changed":true}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "index binding"):
            audit.capture_composition(self.root)

    def test_flags_and_budget_cannot_be_relabelled_as_already_approved(self):
        original = copy.deepcopy(self.index)
        for field in ("human_approved", "training_authorized", "independent_test_eligible",
                      "new_supporter_token_lengths_verified", "new_app_token_lengths_verified",
                      "automatic_cross_task_mixing"):
            for value in (True, 0, "false"):
                with self.subTest(field=field, value=value):
                    self.index = copy.deepcopy(original)
                    self.index[field] = value
                    self.write_index()
                    with self.assertRaisesRegex(ValueError, "composition status"):
                        audit.capture_composition(self.root)
        self.index = copy.deepcopy(original)
        self.index["evaluation_budget"]["max_output_tokens"] = 4096
        self.write_index()
        with self.assertRaisesRegex(ValueError, "composition status"):
            audit.capture_composition(self.root)

    def test_component_reference_has_no_unchecked_extra_fields(self):
        self.index["components"]["supporter_v9"]["verified"] = True
        self.write_index()
        with self.assertRaisesRegex(ValueError, "invalid component reference"):
            audit.capture_composition(self.root)


class PublicationGuardTests(CompositionFixture):
    """Mock encoding only to isolate I/O guards; never a tokenizer pass claim."""

    def run_fixture(self, phase=None):
        tokenizer_dir = self.directory / "tokenizer"
        tokenizer_dir.mkdir()
        assets = {name: b"synthetic asset fixture\n" for name in audit.ASSETS}
        for name, content in assets.items():
            (tokenizer_dir / name).write_bytes(content)
        output = self.directory / "output"
        record = {
            "stream": "conversation", "split": "train", "cohort": "new_v9",
            "group_id": "synthetic-fixture-group", "prefix_ids_sha256": "synthetic-prefix-digest",
            "prefix_length": 4, "target_length": 2, "sequence_length": 6,
            "runtime_8192": True, "strict_4096": True,
            "raw_template_prefix_match": False, "canonicalization_applied": True,
            "source_boundary_whitespace_trimmed_messages": 0,
        }
        changed = False
        original_read = audit.composition.read
        original_write = Path.write_text
        implementation_file = Path(audit.__file__).resolve()
        implementation_before = implementation_file.read_bytes()

        def read_with_simulated_code_race(path):
            content = original_read(path)
            if changed and Path(path).resolve() == implementation_file:
                return content + b"\n# simulated concurrent implementation change\n"
            return content

        def simulated_measure(*args, **kwargs):
            nonlocal changed
            if phase == "during_measurement":
                changed = True
            return [copy.deepcopy(record)]

        def write_with_simulated_code_race(path, *args, **kwargs):
            nonlocal changed
            result = original_write(path, *args, **kwargs)
            if phase == "before_publication" and path.name == "manifest.json" and path.parent.name.startswith(".supporter-token-audit-"):
                changed = True
            return result

        with patch.object(audit, "validate_artifacts", return_value=({"baseline_episode_ids": []}, {})), \
             patch.object(audit, "load_tokenizer", return_value=(object(), {"synthetic_test_fixture": True}, assets)), \
             patch.object(audit, "measure", side_effect=simulated_measure), \
             patch.object(audit.composition, "read", side_effect=read_with_simulated_code_race), \
             patch.object(Path, "write_text", new=write_with_simulated_code_race):
            if phase is None:
                result = audit.run(self.root, tokenizer_dir, self.directory / "historical.json", output)
                self.assertEqual(result["inventory_rows"], 1)
                self.assertTrue((output / "manifest.json").is_file())
            else:
                with self.assertRaisesRegex(ValueError, "implementation changed"):
                    audit.run(self.root, tokenizer_dir, self.directory / "historical.json", output)
                self.assertFalse(output.exists())
        self.assertEqual(implementation_file.read_bytes(), implementation_before)
        self.assertEqual(list(self.directory.glob(".supporter-token-audit-*")), [])

    def test_unchanged_guard_fixture_publishes_successfully(self):
        self.run_fixture()

    def test_implementation_change_during_measurement_is_rejected(self):
        self.run_fixture("during_measurement")

    def test_implementation_change_after_writing_before_publish_is_rejected(self):
        self.run_fixture("before_publication")


if __name__ == "__main__":
    unittest.main()
