import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import unicodedata
import zipfile

from counseling_pipeline.ingest import _group_splits, ingest, inventory, verify_ingest
from counseling_pipeline.text import iter_sentences, iter_words, tokenize


def document(text="안녕하세요. 오늘은 3.14점? 좋아요!", subject="p1", **extra):
    return {"id": subject, "filename": "preserve.json", "class": 0,
            "paragraph": [{"paragraph_text": text, "paragraph_speaker": "내담자",
                           "depressive_mood": 0, "unknown_label": None,
                           "unknown_structured": {"boolean": False, "array": [0, None, "값"]}}],
            **extra}


def write_json(root, name, payload):
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


class TextTests(unittest.TestCase):
    def test_unicode_offsets_and_decimal_boundaries(self):
        text = "  안녕? ‘괜찮아.’\n3.14점 입니다. \t마지막 "
        spans = list(iter_sentences(text))
        self.assertEqual([s.text for s in spans], ["안녕?", "‘괜찮아.’", "3.14점 입니다.", "마지막"])
        for span in spans:
            self.assertEqual(span.text, text[span.start:span.end])
            for word in iter_words(span.text, span.start):
                self.assertEqual(word.text, text[word.start:word.end])
        self.assertEqual("".join(s.text.replace(" ", "") for s in spans), "".join(text.split()))

    def test_combining_characters_are_not_discarded(self):
        decomposed = unicodedata.normalize("NFD", "가나다")
        text = f"{decomposed} café cafe\u0301 don't ＡＢＣ"
        words = list(iter_words(text))
        self.assertEqual(len(words), 5)
        self.assertEqual(words[0].normalized, "가나다")
        self.assertEqual(words[1].normalized, words[2].normalized)
        self.assertEqual(tokenize(text)[-1], "abc")


class IngestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        self.output = self.root / "private"

    def tearDown(self):
        self.temp.cleanup()

    def connection(self):
        return sqlite3.connect(self.output / "corpus.sqlite")

    def test_lossless_duplicate_unicode_pairing_offsets_and_resume(self):
        payload = document(extra_unknown={"nested": [0, None, False, 1.5]})
        nfc_name = "한국"
        nfd_name = unicodedata.normalize("NFD", nfc_name)
        training = self.source / "Training"
        training.mkdir()
        with zipfile.ZipFile(training / "labels.zip", "w") as archive:
            archive.writestr(f"/label_{nfc_name}.json", json.dumps(payload, ensure_ascii=False))
        with zipfile.ZipFile(training / "texts.zip", "w") as archive:
            archive.writestr(f"../resource_{nfd_name}.txt", payload["paragraph"][0]["paragraph_text"])
        write_json(self.source, f"Training/label_{nfc_name}.json", payload)
        write_json(self.source, f"Validation/label_{nfc_name}.json", payload)
        (self.source / ".DS_Store").write_bytes(b"metadata")
        original_inventory = inventory(self.source)
        report = ingest(self.source, self.output)
        self.assertEqual(original_inventory, inventory(self.source))
        self.assertTrue(report["all_sources_accounted"])
        self.assertEqual(report["counts"]["conversations"], 1)
        self.assertEqual(report["payload_duplicate_sources"], 2)
        self.assertEqual(report["counts"]["sentences"], 3)
        self.assertEqual(report["pairing"]["comparison_counts"]["exact"], 2)
        self.assertEqual(len(report["pairing"]["unmatched_json_source_ids"]), 1)
        self.assertEqual(report["splits"], {"quarantine": 1})
        self.assertTrue(report["validation"]["passed"])
        with self.connection() as conn:
            raw, split, original = conn.execute("SELECT raw_json,split,original_split FROM conversations").fetchone()
            self.assertEqual(json.loads(raw), payload)
            self.assertEqual(original, "train|validation")
            self.assertEqual(split, "quarantine")
            before_ids = list(conn.execute("SELECT word_occurrence_id FROM words ORDER BY word_occurrence_id"))
        resumed = ingest(self.source, self.output)
        self.assertEqual(resumed["resume"], "reused_identical_verified_build")
        with self.connection() as conn:
            self.assertEqual(before_ids, list(conn.execute("SELECT word_occurrence_id FROM words ORDER BY word_occurrence_id")))
        self.assertFalse((self.root / f"resource_{nfd_name}.txt").exists())

    def test_missing_null_zero_false_and_unknown_fields(self):
        first = document(subject="one")
        first["paragraph"].append({"paragraph_text": "두 번째.", "depressive_mood": None, "boolean_label": False})
        first["paragraph"].append({"paragraph_text": "세 번째.", "boolean_label": 0})
        write_json(self.source, "Training/label_one.json", first)
        report = ingest(self.source, self.output)
        labels = json.loads((self.output / "label_dictionary.json").read_text())["labels"]
        mood = next(label for label in labels if label["original_key"] == "depressive_mood")
        self.assertEqual((mood["missing_count"], mood["null_count"], mood["zero_count"]), (1, 1, 1))
        boolean = next(label for label in labels if label["original_key"] == "boolean_label")
        self.assertEqual(boolean["value_counts"], {"false": 1, "0": 1})
        with self.connection() as conn:
            raw = conn.execute("SELECT raw_json FROM conversations").fetchone()[0]
            self.assertEqual(json.loads(raw), first)
            rows = dict(conn.execute("SELECT label_key,value_json FROM original_labels WHERE label_key='unknown_structured'"))
            self.assertEqual(json.loads(rows["unknown_structured"]), first["paragraph"][0]["unknown_structured"])
        self.assertTrue(report["validation"]["passed"])

    def test_cross_split_observed_id_and_text_quarantine(self):
        write_json(self.source, "Training/a.json", document("원문 하나.", "same"))
        write_json(self.source, "Validation/b.json", document("다른 원문.", "same"))
        write_json(self.source, "Training/c.json", document("다른 원문.", "different"))
        write_json(self.source, "Training/d.json", document("고유 상담.", "unique"))
        report = ingest(self.source, self.output)
        self.assertEqual(report["splits"], {"quarantine": 3, "train": 1})
        self.assertEqual(len(report["grouping"]["conflicts"]), 1)
        self.assertIn("unverified", report["grouping"]["subject_identity_status"])

    def test_bad_json_invalid_utf8_and_non_string_text_are_tracked(self):
        bad = self.source / "broken.json"
        bad.write_bytes(b'{"paragraph": [invalid]}')
        (self.source / "undecodable.txt").write_bytes(b"\xff\xfe\xfa")
        write_json(self.source, "Training/non_text.json", document(7))
        write_json(self.source, "unsupported.json", {"all_fields": [1, None, True]})
        (self.source / "broken.zip").write_bytes(b"not a zip")
        report = ingest(self.source, self.output)
        self.assertEqual(report["status_counts"], {"error": 4, "held": 1})
        self.assertEqual(len(report["issues"]), 1)
        self.assertEqual(report["counts"]["conversations"], 1)
        self.assertEqual(report["counts"]["sentences"], 0)
        with self.connection() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM source_error_bytes").fetchone()[0], 3)
            self.assertIn(bad.read_bytes(), [row[0] for row in conn.execute("SELECT data FROM source_error_bytes")])
            raw, text = conn.execute("SELECT raw_json,text FROM conversations").fetchone()
            self.assertEqual(json.loads(raw)["paragraph"][0]["paragraph_text"], 7)
            self.assertEqual(text, "")
        self.assertTrue(report["all_sources_accounted"])

    def test_content_differences_missing_pairs_and_restart_stage(self):
        write_json(self.source, "Training/label_pair.json", document("JSON text."))
        (self.source / "Training/resource_pair.txt").write_text("different TXT", encoding="utf-8")
        (self.source / "Training/resource_orphan.txt").write_text("orphan", encoding="utf-8")
        self.output.mkdir()
        (self.output / "corpus.sqlite.building").write_bytes(b"interrupted")
        report = ingest(self.source, self.output)
        self.assertEqual(report["pairing"]["comparison_counts"], {"content_difference": 1})
        self.assertEqual(len(report["pairing"]["unmatched_txt_source_ids"]), 1)
        self.assertFalse((self.output / "corpus.sqlite.building").exists())
        write_json(self.source, "Training/new.json", document("Added text.", "new"))
        rebuilt = ingest(self.source, self.output)
        self.assertEqual(rebuilt["counts"]["conversations"], 2)
        self.assertEqual(rebuilt["resume"], "deterministic_atomic_rebuild")

    def test_validation_detects_corrupt_offsets(self):
        write_json(self.source, "Training/a.json", document())
        ingest(self.source, self.output)
        with self.connection() as conn:
            conn.execute("UPDATE sentences SET start_char=start_char+1")
        validation = verify_ingest(self.output / "corpus.sqlite")
        self.assertFalse(validation["passed"])
        self.assertIn("sentence_offset", validation["errors"])

    def test_cannot_write_inside_source(self):
        with self.assertRaises(ValueError):
            ingest(self.source, self.source / "outputs")

    def completed_stage(self):
        with mock.patch("counseling_pipeline.ingest.verify_ingest", side_effect=RuntimeError("interrupted during final verification")):
            with self.assertRaisesRegex(RuntimeError, "interrupted during final verification"):
                ingest(self.source, self.output)
        stage = self.output / "corpus.sqlite.building"
        self.assertTrue(stage.exists())
        self.assertFalse((self.output / "corpus.sqlite").exists())
        return stage

    def test_completed_stage_recovers_aggregates_without_reingesting(self):
        payload = document()
        write_json(self.source, "Training/label_one.json", payload)
        write_json(self.source, "Validation/label_one.json", payload)
        write_json(self.source, "Training/non_text.json", document(None, "other"))
        (self.source / "Training/resource_one.txt").write_text(payload["paragraph"][0]["paragraph_text"], encoding="utf-8")
        (self.source / "broken.json").write_text('{"paragraph": invalid}', encoding="utf-8")
        stage = self.completed_stage()
        with sqlite3.connect(stage) as conn:
            source_rows = list(conn.execute("SELECT * FROM sources ORDER BY source_id"))
            word_rows = list(conn.execute("SELECT * FROM words ORDER BY word_occurrence_id"))
        with mock.patch("counseling_pipeline.ingest._read", side_effect=AssertionError("must not reread ingested payloads")), mock.patch("counseling_pipeline.ingest._group_splits", side_effect=AssertionError("must not redo committed splits")), mock.patch("counseling_pipeline.ingest._labels_add", side_effect=AssertionError("must not reinsert labels")):
            restored = ingest(self.source, self.output)
        self.assertEqual(restored["resume"], "resumed_completed_stage")
        self.assertTrue(restored["validation"]["passed"])
        self.assertFalse(stage.exists())
        with self.connection() as conn:
            self.assertEqual(source_rows, list(conn.execute("SELECT * FROM sources ORDER BY source_id")))
            self.assertEqual(word_rows, list(conn.execute("SELECT * FROM words ORDER BY word_occurrence_id")))
        fresh_output = self.root / "fresh_private"
        fresh = ingest(self.source, fresh_output)
        for key in ("counts", "status_counts", "kind_counts", "pairing", "splits", "issues"):
            self.assertEqual(restored[key], fresh[key], key)
        for filename in ("schema_dictionary.json", "label_dictionary.json"):
            self.assertEqual(json.loads((self.output / filename).read_text()), json.loads((fresh_output / filename).read_text()))

    def test_completed_stage_rejects_changed_inventory_and_preserves_stage(self):
        source_path = write_json(self.source, "Training/a.json", document())
        stage = self.completed_stage()
        before_bytes = stage.read_bytes()
        source_path.write_text(json.dumps(document("changed input")), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "metadata does not match"):
            ingest(self.source, self.output)
        self.assertEqual(before_bytes, stage.read_bytes())
        self.assertFalse((self.output / "corpus.sqlite").exists())

    def test_completed_stage_rejects_source_row_mismatch(self):
        write_json(self.source, "Training/a.json", document())
        stage = self.completed_stage()
        with sqlite3.connect(stage) as conn:
            conn.execute("UPDATE sources SET sha256='tampered'")
        with self.assertRaisesRegex(ValueError, "source rows do not match"):
            ingest(self.source, self.output)
        self.assertTrue(stage.exists())

    def test_hot_journal_rollback_precedes_completed_stage_checks(self):
        write_json(self.source, "Training/a.json", document())
        stage = self.completed_stage()
        crash = """import os, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
conn.execute('PRAGMA cache_size=1')
conn.execute('BEGIN IMMEDIATE')
conn.execute("UPDATE sources SET status='pending'")
conn.execute("UPDATE conversations SET raw_json=raw_json || printf('%1000000s','')")
os._exit(17)
"""
        process = subprocess.run([sys.executable, "-c", crash, str(stage)], capture_output=True, text=True, check=False)
        self.assertEqual(process.returncode, 17, process.stderr)
        self.assertTrue(Path(str(stage) + "-journal").exists())
        restored = ingest(self.source, self.output)
        self.assertEqual(restored["resume"], "resumed_completed_stage")
        self.assertEqual(restored["status_counts"], {"success": 1})
        self.assertTrue(restored["validation"]["passed"])

    def test_split_update_uses_compact_map_and_verification_avoids_large_joins(self):
        write_json(self.source, "Training/a.json", document("word. " * 50))
        ingest(self.source, self.output)
        with self.connection() as conn:
            _group_splits(conn)
            plan = list(conn.execute("EXPLAIN QUERY PLAN UPDATE words SET split=(SELECT split FROM effective_splits e WHERE e.conversation_id=words.conversation_id) WHERE split != (SELECT split FROM effective_splits e WHERE e.conversation_id=words.conversation_id)"))
            detail = " ".join(row[3] for row in plan)
            self.assertIn("SEARCH e USING PRIMARY KEY", detail)
            self.assertNotIn("conversations", detail)
            queries = []
            conn.set_trace_callback(queries.append)
            self.assertTrue(verify_ingest(conn)["passed"])
            self.assertFalse(any("JOIN conversations" in query for query in queries))

    def test_validation_checks_typed_utterance_payload_and_source_derived_text(self):
        write_json(self.source, "Training/a.json", document())
        ingest(self.source, self.output)
        with self.connection() as conn:
            raw = json.loads(conn.execute("SELECT raw_json FROM utterances").fetchone()[0])
            raw["depressive_mood"] = False  # Python 0 == False must not hide type loss.
            conn.execute("UPDATE utterances SET raw_json=?", (json.dumps(raw),))
            conn.execute("UPDATE conversations SET text=text || ' changed'")
        validation = verify_ingest(self.output / "corpus.sqlite")
        self.assertFalse(validation["passed"])
        self.assertEqual(validation["errors"]["lossless_utterance_json"], 1)
        self.assertEqual(validation["errors"]["conversation_text_from_source"], 1)


if __name__ == "__main__":
    unittest.main()
