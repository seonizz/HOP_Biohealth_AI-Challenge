import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest


@unittest.skipUnless(importlib.util.find_spec("numpy"), "existing NumPy runtime required")
class EvaluationAuditTests(unittest.TestCase):
    def setUp(self):
        import numpy as np
        from counseling_pipeline.evaluation_audit import build_evaluation_audit
        self.np = np
        self.build = build_evaluation_audit
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db_path = self.root / "corpus.sqlite"
        self.numeric = self.root / "numeric"
        self.numeric.mkdir()
        self.output = self.root / "suitability"
        self.db = sqlite3.connect(self.db_path)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY, split TEXT, group_id TEXT, raw_json TEXT);
            CREATE TABLE sentences(sentence_id TEXT PRIMARY KEY, split TEXT, text TEXT);
        """)

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def conversation(self, cid, split, group, labels=(), age=30, **metadata):
        paragraphs = [{"paragraph_text": "PRIVATE synthetic utterance", "paragraph_speaker": "test",
                       "index": index, "code": value} for index, value in enumerate(labels)]
        obj = {"class": "test", "gender": "F", "age": age, "paragraph": paragraphs, **metadata}
        self.db.execute("INSERT INTO conversations VALUES(?,?,?,?)", (cid, split, group, json.dumps(obj)))

    def sentence(self, sid, split, text):
        self.db.execute("INSERT INTO sentences VALUES(?,?,?)", (sid, split, text))

    def mapping(self, mutate=None):
        self.db.commit()
        records = [{"row": i, "id": sid, "split": split, "rowid": rowid}
                   for i, (rowid, sid, split) in enumerate(self.db.execute("SELECT rowid,sentence_id,split FROM sentences ORDER BY sentence_id"))]
        if mutate:
            mutate(records)
        (self.numeric / "sentence_rows.jsonl").write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
        return records

    def test_normalized_overlap_long_subset_and_other_splits_remain_separate(self):
        self.conversation("c-train", "train", "g1")
        self.conversation("c-val", "validation", "g2")
        self.conversation("c-quarantine", "quarantine", "g3")
        self.conversation("c-unknown", "unknown", "g4")
        long_duplicate = "이 문장은 정규화한 다음에도 서른 글자 이상인 중복 검사 전용 예시입니다"
        long_unique = "이 문장은 학습 자료에 등장하지 않는 서른 글자 이상 검증용 새 예시입니다"
        rows = [
            ("a", "train", "ＡＢＣ\t테스트"),
            ("b", "train", long_duplicate),
            ("c", "validation", " ABC   테스트 "),
            ("d", "validation", long_duplicate.replace(" ", "\n\t")),
            ("e", "validation", long_unique),
            ("f", "validation", "짧은 새 문장"),
            ("g", "quarantine", "ABC 테스트"),
            ("h", "unknown", long_unique),
            ("i", "train", "ABC 테스트"),
        ]
        # Insert out of lexical order so accidental SQLite row-order use fails.
        for row in reversed(rows):
            self.sentence(*row)
        self.mapping()
        before = self.db_path.read_bytes()
        self.db.execute("PRAGMA query_only=ON")
        report = self.build(self.db, self.output, self.numeric)
        self.assertEqual(before, self.db_path.read_bytes())
        masks = self.np.load(self.output / "sentence_evaluation_masks.npy")
        seen = self.np.load(self.output / "sentence_seen_in_train.npy")
        self.np.testing.assert_array_equal(masks, [[0, 0], [0, 0], [0, 0], [0, 0], [1, 1], [1, 0], [0, 0], [0, 0], [0, 0]])
        self.np.testing.assert_array_equal(seen[:, 0], [1, 1, 1, 1, 0, 0, 1, 0, 1])
        self.assertEqual(masks.dtype, self.np.dtype("uint8"))
        self.assertEqual(seen.shape, (9, 1))
        self.assertEqual(report["validation_split_group_count"], 1)
        self.assertFalse(report["provisional_group_identity_verified"])
        self.assertEqual(report["split_counts"]["validation"]["sentences"], 4)
        self.assertEqual(report["split_counts"]["quarantine"]["sentences"], 1)
        duplicates = report["sentence_duplicates"]
        self.assertEqual(duplicates["validation_occurrences_seen_in_train"], 2)
        self.assertEqual(duplicates["validation_length_ge_30_occurrences_seen_in_train"], 1)
        self.assertEqual(duplicates["splits"]["validation"]["length_ge_30_occurrences"], 2)
        self.assertEqual(duplicates["splits"]["train"]["occurrences_beyond_first"], 1)
        self.assertEqual(report["validation_unseen_in_train_occurrences"], 2)
        self.assertEqual(report["validation_length_ge_30_unseen_in_train_occurrences"], 1)
        for item in report["artifacts"]:
            self.assertEqual(item["row_mapping"], "../numeric/sentence_rows.jsonl")
            self.assertTrue((self.output / item["path"]).is_file())
        serialized = json.dumps(report)
        self.assertNotIn("evaluation_eligible", serialized)
        self.assertNotIn("person_disjoint", serialized)
        self.assertNotIn(long_duplicate, serialized)

    def test_typed_zero_false_null_and_provisional_metadata_counts(self):
        self.conversation("a", "train", "g1", [0, False, None, 0.0], age=30)
        self.conversation("b", "validation", "g1", age=31)
        self.conversation("c", "validation", "g2", age=None)
        self.sentence("s", "train", "test")
        self.mapping()
        report = self.build(self.db, self.output, self.numeric)
        labels = report["raw_utterance_labels"]
        self.assertEqual(labels["all_label_cells"], 4)
        self.assertEqual(labels["numeric_cells"], 2)
        self.assertEqual(labels["numeric_zero_cells"], 2)
        self.assertEqual(labels["numeric_zero_ratio_among_all_label_cells"], 0.5)
        self.assertEqual(labels["numeric_zero_ratio_among_numeric_label_cells"], 1.0)
        values = labels["labels"][0]["typed_values"]
        self.assertEqual({value["type"] for value in values}, {"integer", "number", "boolean", "null"})
        self.assertEqual(report["group_metadata_inconsistency"], 1)
        self.assertEqual(report["group_metadata_inconsistency_by_field"], {"class": 0, "gender": 0, "age": 1})
        self.assertEqual(report["provisional_groups_in_multiple_splits"], 1)
        self.assertEqual(report["validation_split_group_count"], 2)
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_unknown_free_text_label_values_are_hashed(self):
        self.conversation("a", "train", "g1", ["PRIVATE note", {"name": "PRIVATE name"}, ["PRIVATE value"]])
        self.sentence("s", "train", "test")
        self.mapping()
        report = self.build(self.db, self.output, self.numeric)
        values = report["raw_utterance_labels"]["labels"][0]["typed_values"]
        self.assertTrue(all(v["raw_value_omitted"] for v in values))
        self.assertTrue(all(len(v["value_sha256"]) == 64 for v in values))
        self.assertNotIn("PRIVATE", json.dumps(report))

    def test_mapping_mismatches_fail_before_artifact_writes(self):
        self.conversation("c", "train", "g")
        self.sentence("a", "train", "one")
        self.sentence("b", "validation", "two")
        cases = {
            "identity": lambda rows: rows[0].update(id="wrong"),
            "row index": lambda rows: rows[0].update(row=1),
            "boolean index": lambda rows: rows[0].update(row=False),
            "split": lambda rows: rows[0].update(split="validation"),
            "rowid": lambda rows: rows[0].update(rowid=999),
            "missing": lambda rows: rows.pop(),
            "extra": lambda rows: rows.append(dict(rows[-1])),
            "reordered": lambda rows: rows.reverse(),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                self.mapping(mutate)
                with self.assertRaisesRegex(ValueError, "row mapping"):
                    self.build(self.db, self.output, self.numeric)
                self.assertFalse(self.output.exists())

    def test_database_path_is_opened_read_only_and_empty_corpus_is_supported(self):
        self.mapping()
        before = self.db_path.read_bytes()
        report = self.build(self.db_path, self.output, self.numeric)
        self.assertEqual(before, self.db_path.read_bytes())
        self.assertEqual(report["split_counts"], {})
        self.assertEqual(report["validation_split_group_count"], 0)
        self.assertIsNone(report["raw_utterance_labels"]["numeric_zero_ratio_among_all_label_cells"])
        self.assertEqual(self.np.load(self.output / "sentence_evaluation_masks.npy").shape, (0, 2))

    def test_nonstandard_numeric_directory_reports_actual_mapping_path(self):
        self.conversation("c", "validation", "g")
        self.sentence("s", "validation", "synthetic diagnostic")
        self.numeric = self.root / "custom" / "mappings_v2"
        self.numeric.mkdir(parents=True)
        self.mapping()
        before = self.db_path.read_bytes()
        report = self.build(self.db_path, self.output, self.numeric)
        self.assertEqual(before, self.db_path.read_bytes())
        for artifact in report["artifacts"]:
            reported = (self.output / artifact["row_mapping"]).resolve()
            self.assertEqual(reported, (self.numeric / "sentence_rows.jsonl").resolve())
            self.assertTrue(reported.is_file())
            self.assertEqual(artifact["row_mapping"], "../custom/mappings_v2/sentence_rows.jsonl")
        self.np.testing.assert_array_equal(self.np.load(self.output / "sentence_evaluation_masks.npy"), [[1, 0]])


if __name__ == "__main__":
    unittest.main()
