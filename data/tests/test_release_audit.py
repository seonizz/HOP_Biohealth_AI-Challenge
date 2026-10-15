import importlib.util
import json
import math
import hashlib
from collections import Counter
from copy import deepcopy
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch


@unittest.skipUnless(importlib.util.find_spec("numpy"), "existing NumPy runtime required")
class ReleaseAuditTests(unittest.TestCase):
    def setUp(self):
        import numpy as np
        from counseling_pipeline import release_audit as audit
        from counseling_pipeline.numeric import CSR
        self.np, self.audit = np, audit
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.folder = self.root / "word"
        self.numeric = self.folder / "numeric"
        self.numeric.mkdir(parents=True)
        # Small artificial strings make feature rows different and inspectable.
        texts = {"train": ["aaa", "abb", "bcc", "cdd"],
                 "validation": ["aab", "bbb", "ccc", "ddd"]}
        for split, items in texts.items():
            records = [{"record_id": split + str(i), "text": text, "split": split,
                        "labels": [label], "label_id": i, "label_ids": [i],
                        "labels_multihot": [int(i == j) for j in range(4)],
                        "leakage_group": split + str(i)}
                       for i, (text, label) in enumerate(zip(items, audit.LABELS))]
            (self.folder / (split + ".jsonl")).write_text(
                "".join(json.dumps(row) + "\n" for row in records), encoding="utf-8")
            self.write_json(self.numeric / (split + "_rows.json"), [r["record_id"] for r in records])
            np.save(self.numeric / (split + "_y.npy"), np.eye(4, dtype=np.uint8))
        # Fixture builder uses the existing CSR writer, not the checker transform.
        def grams(text):
            return [text[i:i+n] for n in (1, 2, 3) for i in range(len(text)-n+1)]
        df = Counter()
        for text in texts["train"]:
            df.update(set(grams(text)))
        terms = sorted(df, key=lambda term: (-df[term], term))
        vocab = {term: i for i, term in enumerate(terms)}
        idf = np.asarray([math.log(5 / (1 + df[t])) + 1 for t in terms], dtype=np.float32)
        for split, items in texts.items():
            matrix = CSR(len(vocab))
            for text in items:
                matrix.append(Counter(vocab[t] for t in grams(text) if t in vocab))
            matrix.save(self.numeric / (split + "_X.npz"), mode="tfidf", idf=idf)
        np.save(self.numeric / "idf.npy", idf)
        np.save(self.numeric / "train_sample_weight.npy", np.ones(4, dtype=np.float32))
        self.write_json(self.numeric / "vocabulary.json", vocab)
        self.write_json(self.numeric / "document_frequency.json", [df[t] for t in terms])
        self.write_json(self.numeric / "manifest.json", {
            "label_order": audit.LABELS, "input_columns": ["text"],
            "target_columns": ["labels_multihot"], "feature_fit_split": "train",
            "counts": {split: {"rows": 4, "labels": dict.fromkeys(audit.LABELS, 1),
                "multi_label_rows": 0, "matrix_shape": [4, len(vocab)], "zero_feature_rows": 0}
                for split in audit.SPLITS},
            "training_positive_class_counts": [1, 1, 1, 1],
            "validation_used_for_vocabulary_or_idf": False})
        self.rehash()

    def tearDown(self):
        self.temp.cleanup()

    def write_json(self, path, obj):
        path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")

    def rehash(self):
        self.write_json(self.root / "FILES.sha256.json", {
            str(p.relative_to(self.root)): self.audit.fingerprint(p)
            for p in self.root.rglob("*") if p.is_file() and p.name != "FILES.sha256.json"})

    def load(self, split="train"):
        return self.audit.load_checked_unit(self.root, "word", split)

    def mutate_matrix(self, transform):
        path = self.numeric / "train_X.npz"
        with self.np.load(path, allow_pickle=False) as archive:
            parts = {k: archive[k].copy() for k in archive.files}
        transform(parts)
        self.np.savez_compressed(path, **parts)
        self.rehash()

    def test_valid_loader_and_all_row_train_only_feature_reconstruction(self):
        loaded = {split: self.load(split) for split in self.audit.SPLITS}
        report = self.audit.audit_features(self.root, "word", loaded)
        self.assertEqual(report["text_feature_rows_recomputed"], 8)
        self.assertTrue(report["train_df_idf_vocabulary_recomputed"])
        self.assertEqual(loaded["train"][1].shape, (4, 4))

    def test_stale_hash_is_rejected_before_loading(self):
        with (self.folder / "train.jsonl").open("a") as stream:
            stream.write("\n")
        with self.assertRaisesRegex(ValueError, "Artifact hash mismatch"):
            self.load()

    def test_missing_hash_coverage_is_not_treated_as_success(self):
        path = self.root / "FILES.sha256.json"
        hashes = json.loads(path.read_text())
        del hashes["word/numeric/train_X.npz"]
        self.write_json(path, hashes)
        with self.assertRaisesRegex(ValueError, "missing from hash index"):
            self.load()

    def test_hash_index_path_escape_is_rejected(self):
        self.write_json(self.root / "FILES.sha256.json", {"../outside": "anything"})
        with self.assertRaisesRegex(ValueError, "escapes release"):
            self.audit.verify_hashes(self.root)

    def test_csr_shape_mismatch_is_rejected_even_with_updated_hash(self):
        self.mutate_matrix(lambda p: p["shape"].__setitem__(0, 5))
        with self.assertRaisesRegex(ValueError, "CSR shape mismatch"):
            self.load()

    def test_unsigned_decreasing_csr_pointer_is_rejected(self):
        def damage(parts):
            parts["indptr"] = parts["indptr"].astype(self.np.uint64)
            parts["indptr"][2] = parts["indptr"][1] - 1
        self.mutate_matrix(damage)
        with self.assertRaisesRegex(ValueError, "Invalid/empty CSR"):
            self.load()

    def test_nonfinite_csr_value_is_rejected(self):
        self.mutate_matrix(lambda p: p["data"].__setitem__(0, self.np.nan))
        with self.assertRaisesRegex(ValueError, "Invalid CSR values"):
            self.load()

    def test_duplicate_column_is_rejected(self):
        self.mutate_matrix(lambda p: p["indices"].__setitem__(1, p["indices"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate/unsorted"):
            self.load()

    def test_target_and_row_order_mismatches_are_rejected(self):
        self.np.save(self.numeric / "train_y.npy", self.np.eye(4, dtype=self.np.uint8)[::-1])
        self.rehash()
        with self.assertRaisesRegex(ValueError, "target mismatch"):
            self.load()
        self.np.save(self.numeric / "train_y.npy", self.np.eye(4, dtype=self.np.uint8))
        self.write_json(self.numeric / "train_rows.json", ["train1", "train0", "train2", "train3"])
        self.rehash()
        with self.assertRaisesRegex(ValueError, "identity/order mismatch"):
            self.load()

    def test_sample_weight_fit_mismatch_is_rejected(self):
        self.np.save(self.numeric / "train_sample_weight.npy", self.np.full(4, 2, dtype=self.np.float32))
        self.rehash()
        with self.assertRaisesRegex(ValueError, "weight fit mismatch"):
            self.load()

    def test_wrong_feature_row_is_detected_despite_valid_shape_norm_and_hash(self):
        def damage(parts):
            start, end = parts["indptr"][:2]
            parts["data"][start:end] = parts["data"][start:end][::-1]
        self.mutate_matrix(damage)
        loaded = {split: self.load(split) for split in self.audit.SPLITS}
        with self.assertRaisesRegex(ValueError, "Text/feature row mismatch"):
            self.audit.audit_features(self.root, "word", loaded)

    def test_idf_not_fitted_on_train_is_detected_despite_manifest_claim(self):
        path = self.numeric / "idf.npy"
        self.np.save(path, self.np.load(path) + self.np.float32(.1))
        self.rehash()
        loaded = {split: self.load(split) for split in self.audit.SPLITS}
        with self.assertRaisesRegex(ValueError, "Train IDF mismatch"):
            self.audit.audit_features(self.root, "word", loaded)

    def test_multisource_exposure_checks_every_origin_and_unknowns(self):
        records = [
            {"unit": "conversation", "row_id": "one", "split": "train", "source_conversation_ids": ["a"]},
            {"unit": "synthetic", "row_id": "two", "split": "validation", "source_conversation_ids": ["a", "b"]},
            {"unit": "word", "row_id": "three", "split": "train", "source_conversation_ids": []},
            {"unit": "adaptation", "row_id": "four", "split": "train", "source_conversation_ids": ["unknown"]}]
        result = self.audit.check_source_links(records, {"a": "train", "b": "validation"})
        self.assertFalse(result["passed"])
        self.assertEqual(result["wrong_source_split_rows"], 1)
        self.assertEqual(result["unknown_origin_rows"], 2)
        self.assertEqual(result["cross_split_shared_origins"], 1)

    def test_valid_source_links_and_duplicate_lineage_row(self):
        records = [{"unit": "synthetic", "row_id": "one", "split": "train",
                    "source_conversation_ids": ["a", "b"]}]
        self.assertTrue(self.audit.check_source_links(records, {"a": "train", "b": "train"})["passed"])
        with self.assertRaisesRegex(ValueError, "Duplicate lineage"):
            self.audit.check_source_links(records + records, {"a": "train", "b": "train"})

    def test_unknown_origins_block_joint_gate_without_failing_standalone_integrity(self):
        with patch.object(self.audit, "UNITS", ("word",)):
            standalone = self.audit.audit_release(self.root, require_joint_lineage=False)
            joint = self.audit.audit_release(self.root)
        self.assertTrue(standalone["passed"])
        self.assertTrue(joint["classification_integrity_passed"])
        self.assertFalse(joint["passed"])
        self.assertEqual(joint["checks"]["cross_path_lineage"]["unknown_origin_rows"], 8)
        self.assertEqual(joint["failures"], [])

    def source_fixture(self):
        database = self.root / "source.sqlite"
        payload = {"class": "NORMAL", "paragraph": [
            {"paragraph_speaker": "test", "paragraph_text": "removed disclosure"},
            {"paragraph_speaker": "test", "paragraph_text": "hello one"}]}
        with sqlite3.connect(database) as db:
            db.executescript("""
                CREATE TABLE conversations(conversation_id TEXT,split TEXT,group_id TEXT,
                    subject_id TEXT,original_split TEXT,raw_json TEXT);
                CREATE TABLE sources(source_id TEXT,conversation_id TEXT);
                CREATE TABLE utterances(utterance_id TEXT,text TEXT);
                CREATE TABLE sentences(sentence_id TEXT,text TEXT,utterance_id TEXT,
                    conversation_id TEXT,split TEXT,start_char INTEGER,end_char INTEGER);
            """)
            db.execute("INSERT INTO conversations VALUES(?,?,?,?,?,?)",
                       ("c", "train", "g", "null", "train", json.dumps(payload)))
            db.execute("INSERT INTO sources VALUES('source','c')")
            db.execute("INSERT INTO utterances VALUES('u','hello one')")
            db.execute("INSERT INTO sentences VALUES('s','one','u','c','train',6,9)")
        folder = self.root / "conversation"
        folder.mkdir()
        self.write_json(folder / "manifest.json", {
            "source_database_sha256": self.audit.fingerprint(database),
            "exported_conversations": 1,
            "output_counts": {split: {label: int(split == "train" and label == "기타")
                                       for label in self.audit.LABELS} for split in self.audit.SPLITS},
            "collection_disclosure_filter": {"removed_turns": 1}})
        self.write_json(folder / "input_filter_review.json", {"records": [
            {"conversation_id": "c", "turn_line": 0, "original_turn": "[test] removed disclosure"}]})
        full = "[test] removed disclosure\n[test] hello one"
        common = {"conversation_id": "c", "group_id": "g", "subject_id": None}
        conversation = {**common, "labels": ["기타"], "source_ids": ["source"],
            "source_full_text_sha256": hashlib.sha256(full.encode()).hexdigest(),
            "text_sha256": hashlib.sha256(b"[test] hello one").hexdigest(),
            "text": "[test] hello one", "input_turn_count": 1, "collection_disclosure_turns_removed": 1}
        sentence = {**common, "id": "s", "utterance_id": "u", "text": "one", "start_char": 6, "end_char": 9}
        self.rehash()
        return database, {"conversation": {"train": [conversation], "validation": []},
                          "sentence": {"train": [sentence], "validation": []}}

    def test_source_text_span_split_and_filter_lineage_replayed_read_only(self):
        database, records = self.source_fixture()
        before = database.read_bytes()
        result, splits = self.audit.audit_sources(self.root, database, records)
        self.assertEqual(result["removed_source_turns_checked"], 1)
        self.assertEqual(result["sentences_checked"], 1)
        self.assertEqual(splits, {"c": "train"})
        self.assertEqual(database.read_bytes(), before)
        self.assertNotIn("hello", json.dumps(result))

    def test_wrong_filter_turn_is_rejected_even_with_updated_hash(self):
        database, records = self.source_fixture()
        self.write_json(self.root / "conversation/input_filter_review.json", {"records": [
            {"conversation_id": "c", "turn_line": 1, "original_turn": "[test] removed disclosure"}]})
        self.rehash()
        with self.assertRaisesRegex(ValueError, "Filter source turn mismatch"):
            self.audit.audit_sources(self.root, database, records)

    def test_changed_sentence_origin_offsets_are_rejected(self):
        database, records = self.source_fixture()
        records["sentence"]["train"][0]["start_char"] = 5
        with self.assertRaisesRegex(ValueError, "sentence identity/offset mismatch"):
            self.audit.audit_sources(self.root, database, records)

    def test_renamed_conversation_duplicates_rejected_even_when_counts_are_updated(self):
        database, records = self.source_fixture()
        row = records["conversation"]["train"][0]
        records["conversation"]["train"] = [{**row, "id": str(i)} for i in range(21)]
        path = self.root / "conversation/manifest.json"
        manifest = json.loads(path.read_text())
        manifest["exported_conversations"] = 21
        manifest["output_counts"]["train"]["기타"] = 21
        self.write_json(path, manifest)
        self.rehash()
        with self.assertRaisesRegex(ValueError, "Duplicate source conversation"):
            self.audit.audit_sources(self.root, database, records)
        # The checked loader also rejects this before requiring a source DB.
        with self.assertRaisesRegex(ValueError, "Duplicate source conversation"):
            self.audit._check_rows(records["conversation"]["train"], "conversation", "train")

    def test_conversation_manifest_total_split_and_labels_checked_independently(self):
        database, records = self.source_fixture()
        path = self.root / "conversation/manifest.json"
        original = json.loads(path.read_text())
        mutations = {
            "total": lambda m: m.update(exported_conversations=2),
            "split": lambda m: m["output_counts"].update(
                train=original["output_counts"]["validation"], validation=original["output_counts"]["train"]),
            "labels": lambda m: m["output_counts"]["train"].update(우울=1, 기타=0),
            "typed total": lambda m: m.update(exported_conversations=True),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                manifest = deepcopy(original)
                mutate(manifest)
                self.write_json(path, manifest)
                self.rehash()
                with self.assertRaisesRegex(ValueError, "Declared count mismatch"):
                    self.audit.audit_sources(self.root, database, records)
                with self.assertRaisesRegex(ValueError, "Declared count mismatch"):
                    self.audit.audit_declared_counts(self.root, {"conversation": records["conversation"]})
        self.write_json(path, original)
        self.rehash()
        self.assertTrue(self.audit.audit_sources(self.root, database, records)[0]["passed"])

    def test_numeric_manifest_counts_match_actual_rows_even_after_rehash(self):
        path = self.numeric / "manifest.json"
        original = json.loads(path.read_text())
        changes = {"rows": 5, "labels": dict.fromkeys(self.audit.LABELS, 2),
                   "multi_label_rows": 1, "matrix_shape": [5, 1], "zero_feature_rows": 1}
        for key, value in changes.items():
            with self.subTest(field=key):
                manifest = deepcopy(original)
                manifest["counts"]["validation"][key] = value
                self.write_json(path, manifest)
                self.rehash()
                with self.assertRaisesRegex(ValueError, "Declared count mismatch"):
                    self.load("validation")
        manifest = deepcopy(original)
        manifest["training_positive_class_counts"] = [2, 1, 1, 1]
        self.write_json(path, manifest)
        self.rehash()
        with self.assertRaisesRegex(ValueError, "training_positive_class_counts"):
            self.load("train")

    def test_optional_unit_and_release_summary_counts_match_delivered_rows(self):
        rows = {split: self.load(split)[3] for split in self.audit.SPLITS}
        manifest = {"active_families": 8, "splits": {
            split: {"rows": 4, "label_counts": dict.fromkeys(self.audit.LABELS, 1)}
            for split in self.audit.SPLITS}}
        summary = {"units": {"word": {"train": 4, "validation": 4, "total": 8,
                                      "label_counts": dict.fromkeys(self.audit.LABELS, 2)}}}
        unit_path, summary_path = self.folder / "build_summary.json", self.root / "summary.json"
        self.write_json(unit_path, manifest)
        self.write_json(summary_path, summary)
        self.rehash()
        self.assertTrue(self.audit.audit_declared_counts(self.root, {"word": rows})["passed"])
        cases = ((unit_path, manifest, lambda m: m.update(active_families=9)),
                 (unit_path, manifest, lambda m: m["splits"]["train"].update(rows=5)),
                 (unit_path, manifest, lambda m: m["splits"]["train"]["label_counts"].update(우울=2)),
                 (summary_path, summary, lambda m: m["units"]["word"].update(total=9)),
                 (summary_path, summary, lambda m: m["units"]["word"].update(train=5)),
                 (summary_path, summary, lambda m: m["units"]["word"]["label_counts"].update(불안=3)))
        for path, original, mutate in cases:
            with self.subTest(path=path.name):
                altered = deepcopy(original)
                mutate(altered)
                self.write_json(path, altered)
                self.rehash()
                with self.assertRaisesRegex(ValueError, "Declared count mismatch"):
                    self.audit.audit_declared_counts(self.root, {"word": rows})
                self.write_json(path, original)
                self.rehash()

    def test_sentence_manifest_multilabel_counts_do_not_assume_one_label_per_row(self):
        rows = {"train": [{"labels": ["우울", "불안"]}, {"labels": ["기타"]}], "validation": []}
        folder = self.root / "sentence"
        folder.mkdir()
        manifest = {"counts": {"train": {"rows": 2, "labels": {"우울": 1, "중독": 0, "불안": 1, "기타": 1}},
                               "validation": {"rows": 0, "labels": dict.fromkeys(self.audit.LABELS, 0)}},
                    "ai_labeled": 10, "other_withheld": 8}
        self.write_json(folder / "manifest.json", manifest)
        self.rehash()
        self.assertTrue(self.audit.audit_declared_counts(self.root, {"sentence": rows})["passed"])
        manifest["counts"]["train"]["labels"]["불안"] = 0
        self.write_json(folder / "manifest.json", manifest)
        self.rehash()
        with self.assertRaisesRegex(ValueError, "Declared count mismatch"):
            self.audit.audit_declared_counts(self.root, {"sentence": rows})


if __name__ == "__main__":
    unittest.main()
