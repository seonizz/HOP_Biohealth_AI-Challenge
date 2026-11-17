import unittest

import ubuntu_role_panel as p


class PanelTests(unittest.TestCase):
    def test_selection_stable_and_root_stratified(self):
        rows = [{"task": "conversation", "sample_id": str(i),
                 "source_group_id": str(i % 4), "split": "validation"} for i in range(40)]
        chosen = p.build_generation_selection(rows)["conversation"]
        self.assertEqual(len(chosen), 16)
        self.assertEqual({rows[i]["source_group_id"] for i in chosen[:4]}, {"0", "1", "2", "3"})
        reverse = list(reversed(rows))
        self.assertEqual([rows[i]["sample_id"] for i in chosen],
                         [reverse[i]["sample_id"] for i in p.build_generation_selection(reverse)["conversation"]])
        for row in rows:
            row.update(reference_text="hidden changed target", model="other")
        self.assertEqual(chosen, p.build_generation_selection(rows)["conversation"])

    def test_reject_bad_selection(self):
        row = {"task": "x", "id": "a"}
        with self.assertRaises(ValueError):
            p.build_generation_selection([row, row])
        with self.assertRaises(ValueError):
            p.build_generation_selection([{**row, "split": "train"}])

    def test_strict_json_and_shape_surrogate(self):
        for bad in ['{"approved":true,"approved":false}', '{"approved":NaN}', '{"approved":1e999}', '```json\n{}\n```', '{} trailing']:
            self.assertFalse(p.score_generation("answer_review", bad, '{"approved":true}')["strict_json_valid"])
        invalid = p.score_generation("answer_review", 'malformed', '{"approved":true}')
        self.assertIsNone(invalid["approved_comparisons"][0]["predicted"])
        score = p.score_generation("answer_review", '{"approved":1}', '{"approved":true}')
        self.assertTrue(score["strict_json_valid"])
        self.assertFalse(score["typed_shape_surrogate"])
        self.assertFalse(score["content_exact"])
        self.assertIsNone(score["approved_comparisons"][0]["predicted"])
        self.assertFalse(score["shape_is_formal_schema"])

    def test_review_and_task_fields_only_gold(self):
        score = p.score_generation("question_plan", '{"decision":"skip","facts":[],"issue_codes":["X"]}',
                                   '{"decision":"ask","facts":[],"issue_codes":["Y"]}')
        self.assertFalse(score["question_decision_exact"][0]["match"])
        self.assertTrue(score["fact_exact"][0]["match"])
        self.assertFalse(score["issue_code_comparisons"][0]["match"])
        self.assertEqual(score["approved_comparisons"], [])
        self.assertIsNone(score["clinical_quality"])
        text = p.score_generation("conversation", "hello", "welcome")
        self.assertIsNone(text["strict_json_valid"])
        self.assertTrue(text["text_nonempty"])

    def test_failure_denominator_and_record_contract(self):
        assignments = [{"model": "base", "task": "answer_review", "sample_id": str(i), "source_group_id": "g"} for i in range(5)]
        records = [dict(assignments[0], execution_status="output_received", finish_reason="eos",
                        scores=p.score_generation("answer_review", '{"approved":true}', '{"approved":true}')),
                   dict(assignments[1], execution_status="failed", finish_reason="timeout"),
                   dict(assignments[2], execution_status="output_received", finish_reason="length"),
                   dict(assignments[3], execution_status="output_received", finish_reason="eos",
                        scores=p.score_generation("answer_review", '{"approved":false}', '{"approved":false}'))]
        row = p.aggregate(records, assignments)["base"]["answer_review"]
        self.assertEqual([row[k] for k in ("assigned", "completed", "failed", "outcap", "not_run")], [5, 2, 1, 1, 1])
        self.assertEqual(row["fixed_denominator_rates"]["strict_json_valid"], .4)
        self.assertEqual(row["approval"]["f1"], 1)
        self.assertEqual(row["approval"]["observed_fields"], 2)
        self.assertIsNone(row["descriptive_ci"])
        with self.assertRaises(ValueError):
            p.aggregate(records + records[:1], assignments)
        self.assertIn("미실행", p.reportmarkdown({"generation": p.aggregate(records, assignments)}))

    def test_ce_weight_and_microtoken_and_incomplete(self):
        rows = [{"model": "base", "task": "x", "sample_id": "a", "loss": 2., "weighted_loss": 6., "target_length": 2, "execution_status": "output_received"},
                {"model": "base", "task": "x", "sample_id": "b", "loss": 4., "weighted_loss": 4., "target_length": 6, "execution_status": "output_received"}]
        value = p.aggregate_ce(rows)["base"]["x"]
        self.assertEqual(value["weighted_row_ce"], 5)
        self.assertEqual(value["microtoken_ce"], 3.5)
        rows[1]["execution_status"] = "failed"
        value = p.aggregate_ce(rows)["base"]["x"]
        self.assertEqual(value["assigned"], 2)
        self.assertIsNone(value["weighted_row_ce"])
        self.assertIsNone(value["microtoken_ce"])


if __name__ == "__main__":
    unittest.main()
