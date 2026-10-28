"""Synthetic coverage and review-queue boundaries; no source text fixtures."""
import unittest

from counseling_pipeline import source_review as review


def row(identity, *, split="train", group=None, cohort="NORMAL", band="q1_0_25",
        tier="candidate_4096", tags=None, stages=None, position=.1):
    return {"id": identity, "split": split, "source_group_id": group or identity,
            "source_conversation_id": identity, "source_cohort": cohort,
            "position_band": band, "selection_tier": tier, "relative_position": position,
            "lexical_tags": tags or ["question_like"], "stages": stages or list(review.STAGES)}


class SourceReviewTests(unittest.TestCase):
    def test_position_uses_complete_source_and_inclusive_quarter_boundaries(self):
        self.assertEqual([review.position_band(i, 101) for i in (0, 25, 26, 50, 51, 75, 76, 100)],
                         ["q1_0_25", "q1_0_25", "q2_25_50", "q2_25_50", "q3_50_75", "q3_50_75", "q4_75_100", "q4_75_100"])
        self.assertEqual(review.position_band(0, 1), "q1_0_25")
        for ordinal, total in [(-1, 100), (100, 100), (0, 0), (False, 10), (1.5, 20)]:
            with self.assertRaises(ValueError): review.position_band(ordinal, total)

    def test_held_rows_remain_distinct_from_content_and_length_candidates(self):
        admission = {"selected": {"admitted": True}, "long": {"admitted": True}, "held": {"admitted": False}}
        expected = {"selected": "candidate_4096", "long": "content_admitted_over_cap", "held": "content_held",
                    "short": "source_heuristic_held"}
        for identity, label in expected.items():
            self.assertEqual(review.membership(identity, True, admission, {"selected"}), label)
        self.assertEqual(review.membership("outside", False, admission, {"selected"}), "outside_release")

    def test_stratification_is_order_invariant_and_prefers_a_new_source_group(self):
        rows = [row("a", group="shared"), row("b", group="shared", band="q2_25_50"),
                row("c", group="new", band="q2_25_50"), row("d", split="validation"),
                row("e", tags=["question_like", "ending_like"])]
        selected = review.select_review_rows(rows)
        self.assertEqual(selected, review.select_review_rows(list(reversed(rows))))
        self.assertEqual({r["id"] for r in selected}, {"a", "c", "d", "e"})
        self.assertEqual({review.stratum(r) for r in selected}, {review.stratum(r) for r in rows})
        self.assertTrue(all(set(r) == set(rows[0]) for r in selected), "selection must not invent review or approval fields")

    def test_summary_uses_per_stage_denominators_and_overlapping_tags(self):
        rows = [row("first", tags=["question_like", "support_like"]),
                row("later", stages=["all_original", "release_population"], position=.8, band="q4_75_100"),
                row("validation", split="validation", position=.5, band="q2_25_50")]
        tables = review.summarize(rows)
        self.assertEqual(tables["all_original"]["train"]["rows"], 2)
        self.assertEqual(tables["candidate_4096"]["train"]["rows"], 1)
        self.assertEqual(tables["all_original"]["train"]["first_half_rows"], 1)
        self.assertEqual(tables["candidate_4096"]["validation"]["first_half_rows"], 1)
        self.assertEqual(tables["all_original"]["train"]["lexical_tags_overlapping"],
                         {"question_like": 2, "support_like": 1})
        self.assertEqual(tables["candidate_4096"]["train"]["source_conversations"], 1)


if __name__ == "__main__":
    unittest.main()
