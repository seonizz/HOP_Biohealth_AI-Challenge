"""Missing past-target exposure evidence must not re-admit source groups."""
import copy
import unittest

from counseling_pipeline import source_admission as admission
from counseling_pipeline import source_sft as source
from tests import test_round4_admission_boundaries as boundaries
from tests import test_source_sft as fixtures


class AdmissionCompletenessTests(unittest.TestCase):
    def pipeline(self, *, validation_count=1, text_length=200, final_only=False):
        case = boundaries.AdmissionBoundaryTests(methodName="runTest")
        self.addCleanup(case.doCleanups)
        specs = []
        for cid in ("train_a", "train_b"):
            content = [("내담자", f"{cid}의 개별 첫 질문"), ("상담사", "가" * text_length)]
            if not final_only:
                content += [("내담자", f"{cid}의 이어지는 개별 질문"), ("상담사", fixtures.RESPONSE + " " + cid)]
            specs.append((fixtures.source_row(cid, "train"), fixtures.turns(content, cid)))
        for n in range(validation_count):
            cid = "val_" + str(n)
            content = [("내담자", f"검증 원천 {n}의 개별 질문"), ("상담사", "가" * text_length)]
            specs.append((fixtures.source_row(cid, "validation"), fixtures.turns(content, cid)))
        return case.pipeline(specs)

    def matches(self, audit):
        return audit["bounded_cross_split_overlap"]["whole_normalized_past_assistant_group"]

    def build(self, fixture, audit, path):
        source.dump_json(path, audit)
        return admission.build_admission(fixture.output, path, fixture.root / "admission")

    def test_missing_train_origin_rejected_instead_of_readmitting_two_rows(self):
        fixture, audit, path = self.pipeline()
        match = self.matches(audit)["matches"][0]
        self.assertEqual(len(match["train_sources"]), 2)
        match["train_sources"].pop()
        with self.assertRaisesRegex(ValueError, "past-target train source inventory incomplete"):
            self.build(fixture, audit, path)
        self.assertFalse((fixture.root / "admission").exists())

    def test_missing_entire_shared_text_cannot_be_hidden_by_zero_counts(self):
        fixture, audit, path = self.pipeline()
        self.matches(audit).update(unique_validation_targets=0, validation_rows=0, matches=[])
        with self.assertRaisesRegex(ValueError, "past-target shared text evidence incomplete"):
            self.build(fixture, audit, path)

    def test_missing_validation_row_and_origin_fail_even_with_consistent_declared_counts(self):
        fixture, audit, path = self.pipeline(validation_count=2)
        matches = self.matches(audit);match = matches["matches"][0]
        omitted = match["validation_sources"].pop()["row_id"]
        match["validation_row_ids"].remove(omitted);matches["validation_rows"] -= 1
        with self.assertRaisesRegex(ValueError, "past-target validation source inventory incomplete"):
            self.build(fixture, audit, path)

    def test_duplicate_match_train_origin_and_validation_origin_fail(self):
        for mutation, message in (("match", "duplicate past-target shared text evidence"),
                                  ("train", "duplicate past-target train source conversation"),
                                  ("validation", "duplicate past-target validation source row")):
            with self.subTest(mutation=mutation):
                fixture, audit, path = self.pipeline()
                matches = self.matches(audit);match = matches["matches"][0]
                if mutation == "match":
                    matches["matches"].append(copy.deepcopy(match));matches["unique_validation_targets"] += 1
                elif mutation == "train":
                    match["train_sources"].append(copy.deepcopy(match["train_sources"][0]))
                else:
                    match["validation_sources"].append(copy.deepcopy(match["validation_sources"][0]))
                with self.assertRaisesRegex(ValueError, message):
                    self.build(fixture, audit, path)

    def test_complete_multiple_origins_and_validation_rows_preserve_union(self):
        fixture, audit, path = self.pipeline(validation_count=2)
        result = self.build(fixture, audit, path)
        self.assertEqual(result["quarantined_source_groups"], ["group-train_a", "group-train_b", "group-val_0", "group-val_1"])
        self.assertEqual(result["counts"], {"all_rows":6,"admitted_rows":0,"held_rows":6,
                                          "group_quarantine_rows":6,"validation_target_hold_rows":2,"both_hold_reasons_rows":2})
        self.assertTrue(result["past_target_source_inventory_verified"])

    def test_short_match_still_holds_only_validation_targets(self):
        fixture, audit, path = self.pipeline(validation_count=2, text_length=199)
        result = self.build(fixture, audit, path)
        self.assertEqual(result["quarantined_source_groups"], [])
        self.assertEqual(result["counts"]["admitted_rows"], 4)
        self.assertEqual(result["counts"]["held_rows"], 2)

    def test_final_train_targets_are_not_added_to_past_context_inventory(self):
        fixture, audit, path = self.pipeline(final_only=True)
        self.assertEqual(self.matches(audit)["matches"], [])
        result = self.build(fixture, audit, path)
        self.assertEqual(result["counts"]["admitted_rows"], 3)
        self.assertEqual(result["counts"]["held_rows"], 0)


if __name__ == "__main__":
    unittest.main()
