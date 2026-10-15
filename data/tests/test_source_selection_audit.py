"""Bounded selection statistics, with synthetic source fixtures only."""
import math
import unittest

from counseling_pipeline import source_selection_audit as audit
from counseling_pipeline import source_sft as source
from tests import test_source_sft as fixtures


class SelectionAuditTests(unittest.TestCase):
    def test_lengths_use_explicit_boundaries(self):
        self.assertEqual([audit.length_bin(n) for n in (0, 9, 10, 19, 20, 39, 40, 79, 80, 319, 320)],
                         ["0-9", "0-9", "10-19", "10-19", "20-39", "20-39", "40-79", "40-79", "80-159", "160-319", "320+"])

    def test_position_is_source_position_not_selected_row_position(self):
        self.assertEqual(audit.stage(0, 101), "opening_0_10pct")
        self.assertEqual(audit.stage(10, 101), "middle_10_90pct")
        self.assertEqual(audit.stage(90, 101), "ending_90_100pct")

    def test_concentration_reports_weighted_shares_without_claiming_independence(self):
        result = audit.concentration({"a": 3, "b": 1})
        self.assertEqual(result["max_share"], .75)
        self.assertTrue(math.isclose(result["hhi"], .625))
        self.assertTrue(math.isclose(result["inverse_hhi_not_independent_sample_size"], 1.6))
        self.assertIsNone(audit.concentration({})["max_share"])

    def test_block_keys_exclude_final_target_and_short_generic_context(self):
        messages = [{"role": "system", "content": "system"}]
        messages += [{"role": "user" if i % 2 == 0 else "assistant", "content": str(i) + " 긴맥락" * 20} for i in range(9)]
        messages += [{"role": "assistant", "content": "target"}]
        expected = audit.block_keys(messages)
        messages[-1]["content"] = "different target"
        self.assertEqual(audit.block_keys(messages), expected)
        self.assertEqual(len(expected), 2)
        self.assertEqual(audit.block_keys([{"role": "user", "content": "네"}] * 10), {})

    def test_normalization_is_not_semantic_matching(self):
        self.assertEqual(audit.normalize("Ａ\n  B"), "A B")
        self.assertNotEqual(audit.normalize("걱정돼요"), audit.normalize("불안해요"))

    def test_ending_proxy_does_not_treat_simile_as_session_end(self):
        self.assertFalse(audit.PATTERNS["ending_like"].search("마치 끔찍한 일이 생길 것처럼 두렵게 느껴진다."))
        self.assertTrue(audit.PATTERNS["ending_like"].search("오늘은 여기서 마치겠습니다. 수고하셨습니다."))

    def test_graph_is_thresholded_transitive_source_exposure_not_identity(self):
        matches = [{"normalized_characters": 100, "validation_sources": [{"row_id": "v1", "conversation_id": "vc", "group_id": "vg"}],
                    "train_sources": [{"conversation_id": "t1", "group_id": "tg1"}, {"conversation_id": "t2", "group_id": "tg2"}]}]
        graph = audit.overlap_graph(matches, 100)
        self.assertEqual(graph["validation_rows"], 1)
        self.assertEqual(graph["conversation_pairs"], 2)
        self.assertEqual(len(graph["connected_components"]), 1)
        self.assertEqual(audit.overlap_graph(matches, 200)["connected_components"], [])

    def test_whole_audit_counts_short_only_and_actual_past_target_overlap(self):
        fixture = fixtures.SourceSftTests(methodName="runTest")
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        train = fixtures.turns([
            ("내담자", "친구에게 보내는 문자를 생각하고 있어요."), ("상담사", fixtures.RESPONSE),
            ("내담자", "지금은 어떤 반응이 필요할까요?"), ("상담사", "지금은 이야기를 들어 주기만 하면 될까요?"),
            ("내담자", "조금 더 자세히 이야기하고 싶어요."), ("상담자", fixtures.SECOND_RESPONSE)])
        validation = fixtures.turns([("내담자", "동생을 위한 안부 문자를 생각하고 있어요."),
                                    ("상담사", fixtures.RESPONSE)], "two")
        fixture.fixture([(fixtures.source_row(), train), (fixtures.source_row("two", "validation"), validation)])
        import sqlite3
        db = sqlite3.connect(fixture.database)
        db.execute("CREATE TABLE sources(source_id TEXT,path TEXT,member TEXT,conversation_id TEXT)")
        db.execute("INSERT INTO sources VALUES('fixture-source','synthetic.zip','example.json','one')")
        db.commit()
        db.close()
        path = fixture.release / "conversation/manifest.json"
        source.dump_json(path, {"source_database_sha256": source.sha_file(fixture.database)})
        hashes = source.read_json(fixture.release / "FILES.sha256.json")
        hashes["conversation/manifest.json"] = source.sha_file(path)
        source.dump_json(fixture.release / "FILES.sha256.json", hashes)
        source.build(fixture.release, fixture.database, fixture.output)
        result = audit.audit(fixture.output, fixture.release, fixture.database)
        self.assertEqual(result["candidate_counts"], {"all": 4, "accepted": 3, "held": 1})
        self.assertEqual(result["selection_tables"]["split"]["train"]["length_only_held"], 1)
        self.assertEqual(result["bounded_cross_split_overlap"]["whole_normalized_past_assistant_group"]["validation_rows"], 1)
        self.assertEqual(result["source_alias_review"]["total_utterances"], 1)
        self.assertFalse(result["source_alias_review"]["formal_source_role_definition_verified"])
        samples = [row for bucket in result["short_only_samples_stratified"].values() for row in bucket]
        self.assertEqual(len(samples), 1)
        self.assertFalse(samples[0]["training_allowed_by_this_audit"])
        self.assertTrue(result["database_size_mtime_unchanged"])


if __name__ == "__main__":
    unittest.main()
