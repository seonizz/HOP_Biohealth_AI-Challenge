"""Independent structural tests; synthetic fixtures assert no clinical truth."""
import copy
import gzip
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from counseling_pipeline import source_sft as s


RESPONSE = "친구에게 마음을 전하고 싶으시군요. 상대가 편하게 선택할 수 있도록 답장을 서두르지 않아도 괜찮다는 말을 함께 전해 볼 수 있겠습니다."
SECOND_RESPONSE = "스스로 지친 마음도 돌아보고 계시는군요. 지금 가능한 만큼만 연락하고 쉬는 시간을 정해 보겠다고 자신의 사정을 차분하게 전해 보세요."


def turns(contents=None, prefix="one"):
    contents = contents or [("내담자", "친구에게 안부 문자를 보내고 싶어요."), ("상담사", RESPONSE),
                            ("내담자", "저도 잠깐 쉬고 싶다는 말을 어떻게 전할까요?"), ("상담자", SECOND_RESPONSE)]
    return [{"utterance_id": f"{prefix}-u{i}", "ordinal": i, "speaker": speaker, "text": text}
            for i, (speaker, text) in enumerate(contents)]


def source_row(cid="one", split="train"):
    return {"conversation_id": cid, "group_id": f"group-{cid}", "split": split,
            "original_split": split, "subject_id_key": json.dumps(f"subject-{cid}"), "source_class": "NORMAL"}


def accepted(row, utterances, removed=()):
    return [example for example, held in s.examples_for_conversation(row, utterances, set(removed)) if example]


class SourceSftTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.release = self.root / "frozen"
        self.database = self.root / "source.sqlite"
        self.output = self.root / "output"

    def fixture(self, specs=None):
        specs = specs or [(source_row(), turns()),
                          (source_row("two", "validation"), turns([
                              ("내담자", "동생이 편히 쉴 수 있게 짧은 인사를 전하고 싶어요."),
                              ("상담사", RESPONSE + " 짧은 안부로 시작해 보셔도 좋겠습니다.")], "two"))]
        db = sqlite3.connect(self.database)
        db.executescript("""
        CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY, raw_json TEXT,
          split TEXT, original_split TEXT, group_id TEXT, subject_id TEXT);
        CREATE TABLE utterances(utterance_id TEXT PRIMARY KEY, conversation_id TEXT,
          ordinal INTEGER, speaker TEXT, text TEXT);
        CREATE TABLE sentences(sentence_id TEXT PRIMARY KEY, utterance_id TEXT,
          conversation_id TEXT, ordinal INTEGER, speaker TEXT, text TEXT,
          start_char INTEGER, end_char INTEGER, split TEXT);
        CREATE TABLE words(word_occurrence_id TEXT PRIMARY KEY, sentence_id TEXT,
          conversation_id TEXT, ordinal INTEGER, surface TEXT, normalized TEXT,
          start_char INTEGER, end_char INTEGER, split TEXT);
        """)
        export = {part: [] for part in s.SPLITS}
        for row, utterances in specs:
            cid, split = row["conversation_id"], row["split"]
            payload = {"paragraph": [{"paragraph_speaker": u["speaker"], "paragraph_text": u["text"]} for u in utterances]}
            db.execute("INSERT INTO conversations VALUES(?,?,?,?,?,?)",
                       (cid, json.dumps(payload, ensure_ascii=False), split, split, row["group_id"], row["subject_id_key"]))
            for u in utterances:
                uid, ordinal, text = u["utterance_id"], u["ordinal"], u["text"]
                sid = uid + "-sentence"
                # A nonzero sentence origin exercises the corpus word-offset
                # contract: word offsets are relative to the whole utterance.
                sentence_start = text.find(" ") + 1 if " " in text else 0
                sentence_text = text[sentence_start:]
                db.execute("INSERT INTO utterances VALUES(?,?,?,?,?)", (uid, cid, ordinal, u["speaker"], text))
                db.execute("INSERT INTO sentences VALUES(?,?,?,?,?,?,?,?,?)",
                           (sid, uid, cid, ordinal, u["speaker"], sentence_text, sentence_start, len(text), split))
                word = sentence_text.split()[0]
                db.execute("INSERT INTO words VALUES(?,?,?,?,?,?,?,?,?)",
                           (uid + "-word", sid, cid, ordinal, word, word,
                            sentence_start, sentence_start + len(word), split))
            full = "\n".join(f'[{u["speaker"] or "화자 미상"}] {u["text"]}' for u in utterances)
            export[split].append({**row, "text": full, "source_full_text_sha256": s.sha_text(full)})
        db.commit()
        db.close()
        folder = self.release / "conversation"
        folder.mkdir(parents=True)
        for split in s.SPLITS:
            (folder / f"{split}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in export[split]), encoding="utf-8")
        s.dump_json(folder / "input_filter_review.json", {"records": []})
        s.dump_json(folder / "manifest.json", {"source_database_sha256": s.sha_file(self.database)})
        s.dump_json(self.release / "FILES.sha256.json", {
            str(p.relative_to(self.release)): s.sha_file(p) for p in folder.iterdir()})

    def build(self):
        self.fixture()
        return s.build(self.release, self.database, self.output)

    def rewrite(self, name, mutate):
        path = self.output / name
        rows = list(s.read_rows(path))
        mutate(rows)
        with gzip.open(path, "wt", encoding="utf-8") as handle:
            handle.write("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows))
        manifest = s.read_json(self.output / "manifest.json")
        manifest["files"][name].update(sha256=s.sha_file(path), rows=len(rows), bytes=path.stat().st_size)
        s.dump_json(self.output / "manifest.json", manifest)

    def test_original_prefix_exact_and_prior_assistants_masked(self):
        utterances = turns()
        rows = accepted(source_row(), utterances)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["messages"], [{"role": "system", "content": s.SYSTEM},
                                              {"role": "user", "content": utterances[0]["text"]},
                                              {"role": "assistant", "content": RESPONSE}])
        self.assertEqual(rows[1]["loss_message_mask"], [0, 0, 0, 0, 1])
        self.assertEqual(rows[1]["messages"][2]["content"], RESPONSE)
        self.assertEqual(rows[1]["target_utterance_ids"], [utterances[3]["utterance_id"]])
        changed = copy.deepcopy(utterances)
        changed[2]["text"] = "미래에 바뀐 이야기"
        changed[3]["text"] = SECOND_RESPONSE + " 내용 추가"
        self.assertEqual(rows[0], accepted(source_row(), changed)[0])

    def test_merge_exact_newline_and_counselor_alias(self):
        utterances = turns([("내담자", "🙂 안부를 묻고 싶어요.\n새 줄도 있어요."),
                           ("상담사", RESPONSE), ("상담자", "  공백도 그대로 보존합니다.  ")])
        row = accepted(source_row(), utterances)[0]
        self.assertEqual(row["messages"][-1]["content"], RESPONSE + "\n  공백도 그대로 보존합니다.  ")
        self.assertEqual(row["target_utterance_ids"], ["one-u1", "one-u2"])
        self.assertEqual(row["messages"][1]["content"], utterances[0]["text"])

    def test_leading_counselor_held_but_preserved_as_context(self):
        utterances = turns([("상담자", RESPONSE), ("내담자", "오늘 친구에게 연락하고 싶어요."),
                           ("상담사", SECOND_RESPONSE)])
        output = list(s.examples_for_conversation(source_row(), utterances, set()))
        self.assertIn("no_preceding_client_turn", output[0][1]["reasons"])
        self.assertEqual(output[1][0]["messages"][1], {"role": "assistant", "content": RESPONSE})
        self.assertEqual(output[1][0]["loss_message_mask"], [0, 0, 0, 1])

    def test_multiline_filter_uses_line_owner_and_deduplicates_review(self):
        utterances = turns([("내담자", "첫 줄\n둘째 줄"), ("상담사", RESPONSE),
                           ("내담자", "자료 수집 범주 설명"), ("상담사", SECOND_RESPONSE)])
        record = {"turn_line": 3, "original_turn": "[내담자] 자료 수집 범주 설명"}
        removed, lines, seen = s.removal_ordinals(utterances, [record, record])
        self.assertEqual(removed, {2})
        self.assertEqual(len(seen), 1)
        results = list(s.examples_for_conversation(source_row(), utterances, removed))
        self.assertIsNotNone(results[0][0])
        self.assertIn("context_contains_reviewed_cohort_disclosure", results[1][1]["reasons"])
        self.assertEqual(len(lines), 5)
        with self.assertRaisesRegex(ValueError, "Removal text"):
            s.removal_ordinals(utterances, [{**record, "original_turn": "wrong"}])
        with self.assertRaisesRegex(ValueError, "Invalid removal"):
            s.removal_ordinals(utterances, [{**record, "turn_line": True}])

    def test_conservative_safety_privacy_and_unknown_hold_all_later_prefixes(self):
        for speaker, text, reason in [
            ("내담자", "자해라는 표현을 들었어요.", "context_requires_safety_review"),
            ("내담자", "연락처는 010-1234-5678입니다.", "context_requires_privacy_review"),
            ("화자 미상", "어떤 말을 해야 할지 모르겠어요.", "unknown_speaker_or_empty_turn"),
        ]:
            utterances = turns([(speaker, text), ("상담사", RESPONSE), ("내담자", "조금 더 이야기할게요."),
                               ("상담자", SECOND_RESPONSE)])
            with self.subTest(reason=reason):
                result = list(s.examples_for_conversation(source_row(), utterances, set()))
                self.assertTrue(all(example is None and reason in held["reasons"] for example, held in result))

    def test_empty_turn_inside_merged_group_is_not_hidden(self):
        utterances = turns([("내담자", "친구에게 문자를 쓰고 싶어요."), ("내담자", ""), ("상담사", RESPONSE)])
        example, held = list(s.examples_for_conversation(source_row(), utterances, set()))[0]
        self.assertIsNone(example)
        self.assertIn("unknown_speaker_or_empty_turn", held["reasons"])

    def test_target_only_screening_does_not_delete_prior_context(self):
        short = "네, 그러셨군요."
        utterances = turns([("내담자", "처음 말씀드려요."), ("상담사", short),
                           ("내담자", "친구와 대화를 다시 시작하고 싶어요."), ("상담사", RESPONSE)])
        result = list(s.examples_for_conversation(source_row(), utterances, set()))
        self.assertIn("short_response_under_40_chars", result[0][1]["reasons"])
        self.assertEqual(result[1][0]["messages"][2]["content"], short)

    def test_build_roundtrip_and_database_unchanged(self):
        self.fixture()
        before = s.sha_file(self.database)
        manifest = s.build(self.release, self.database, self.output)
        audit = s.audit(self.output)
        self.assertTrue(audit["passed"])
        self.assertEqual(audit["files_checked"], 9)
        self.assertEqual(manifest["files"]["conversation/train.jsonl.gz"]["rows"], 2)
        self.assertEqual(manifest["files"]["conversation/validation.jsonl.gz"]["rows"], 1)
        self.assertEqual(s.sha_file(self.database), before)
        for unit in ("sentence", "word"):
            self.assertTrue(all(r["standalone_sft_target"] is False for r in s.read_rows(self.output / unit / "train.jsonl.gz")))
        self.assertFalse(manifest["readiness"]["actual_model_tokenization_verified"])
        self.assertFalse(manifest["readiness"]["clinical_or_human_approval"])

    def test_dedup_final_pair_keeps_validation_and_holds_train(self):
        content = [("내담자", "오늘은 같은 질문을 하려고 합니다."), ("상담사", RESPONSE)]
        self.fixture([(source_row(), turns(content)), (source_row("two", "validation"), turns(content, "two"))])
        manifest = s.build(self.release, self.database, self.output)
        self.assertEqual(manifest["files"]["conversation/train.jsonl.gz"]["rows"], 0)
        self.assertEqual(manifest["files"]["conversation/validation.jsonl.gz"]["rows"], 1)
        held = list(s.read_rows(self.output / "review/excluded_targets.jsonl.gz"))
        self.assertEqual(len(held), 1)
        self.assertEqual(held[0]["split"], "train")
        self.assertTrue(any(reason.startswith("duplicate_") for reason in held[0]["reasons"]))
        self.assertTrue(s.audit(self.output)["passed"])

    def test_input_group_or_subject_leak_rejected(self):
        for field in ("group_id", "subject_id_key"):
            with self.subTest(field=field):
                with tempfile.TemporaryDirectory() as directory:
                    original_root = self.root
                    self.root = Path(directory)
                    self.release, self.database = self.root / "frozen", self.root / "db.sqlite"
                    left, right = source_row(), source_row("two", "validation")
                    right[field] = left[field]
                    self.fixture([(left, turns()), (right, turns(prefix="two"))])
                    with self.assertRaisesRegex(ValueError, "crosses split"):
                        s.load_inputs(self.release, self.database)
                    self.root = original_root

    def test_corrupted_file_and_frozen_source_hash_rejected(self):
        self.build()
        with (self.output / "word/train.jsonl.gz").open("ab") as handle:
            handle.write(b"changed")
        with self.assertRaisesRegex(ValueError, "File hash"):
            s.audit(self.output)
        with (self.release / "conversation/train.jsonl").open("a") as handle:
            handle.write("{}\n")
        with self.assertRaisesRegex(ValueError, "Frozen source hash"):
            s.load_inputs(self.release, self.database)

    def test_omitted_manifest_inventory_is_rejected(self):
        self.build()
        manifest = s.read_json(self.output / "manifest.json")
        manifest["files"] = {}
        s.dump_json(self.output / "manifest.json", manifest)
        with self.assertRaises(ValueError):
            s.audit(self.output)

    def test_future_context_and_old_assistant_loss_tampering_rejected(self):
        self.build()
        name = "conversation/train.jsonl.gz"
        original = list(s.read_rows(self.output / name))
        def future(rows):
            rows[0]["messages"].insert(-1, {"role": "user", "content": "아직 보이지 않는 미래 발화"})
        self.rewrite(name, future)
        with self.assertRaisesRegex(ValueError, "future turn"):
            s.audit(self.output)
        self.rewrite(name, lambda rows: rows.__setitem__(slice(None), copy.deepcopy(original)))
        self.rewrite(name, lambda rows: rows[1]["loss_message_mask"].__setitem__(2, 1))
        with self.assertRaisesRegex(ValueError, "Loss mask"):
            s.audit(self.output)

    def test_target_ordinal_must_identify_actual_final_group(self):
        self.build()
        self.rewrite("conversation/train.jsonl.gz", lambda rows: rows[1].update(target_end_ordinal=1000000))
        with self.assertRaises(ValueError):
            s.audit(self.output)

    def test_auxiliary_offsets_reject_negative_aliases_despite_same_slice(self):
        self.build()
        name = "sentence/train.jsonl.gz"
        self.rewrite(name, lambda rows: rows[0].update(start_char=-len(rows[0]["text"])))
        with self.assertRaises(ValueError):
            s.audit(self.output)

    def test_auxiliary_positive_wrong_surface_rejected_with_updated_file_hash(self):
        self.build()
        self.rewrite("word/train.jsonl.gz", lambda rows: rows[0].update(surface="잘못된구절"))
        with self.assertRaisesRegex(ValueError, "Word source span"):
            s.audit(self.output)

    def test_words_preserve_utterance_offsets_and_explicit_sentence_offsets(self):
        self.build()
        sources = list(s.read_rows(self.output / "conversation/source_dialogues.train.jsonl.gz"))
        utterances = {u["utterance_id"]: u["text"] for d in sources for u in d["utterances"]}
        sentences = {row["id"]: row for row in s.read_rows(self.output / "sentence/train.jsonl.gz")}
        for word in s.read_rows(self.output / "word/train.jsonl.gz"):
            sentence = sentences[word["sentence_id"]]
            self.assertGreater(sentence["start_char"], 0)
            self.assertEqual(word["offset_reference"], "source_utterance_unicode_codepoints")
            self.assertEqual(word["start_char"], sentence["start_char"] + word["sentence_start_char"])
            self.assertEqual(utterances[word["utterance_id"]][word["start_char"]:word["end_char"]], word["surface"])
            self.assertEqual(sentence["text"][word["sentence_start_char"]:word["sentence_end_char"]], word["surface"])

    def test_word_relative_offset_tamper_rejected(self):
        self.build()
        self.rewrite("word/train.jsonl.gz", lambda rows: rows[0].update(sentence_start_char=-1))
        with self.assertRaisesRegex(ValueError, "Word source span"):
            s.audit(self.output)

    def test_output_subject_split_leak_is_rejected(self):
        self.build()
        train_source = next(s.read_rows(self.output / "conversation/source_dialogues.train.jsonl.gz"))
        self.rewrite("conversation/source_dialogues.validation.jsonl.gz",
                     lambda rows: rows[0].update(source_subject_key=train_source["source_subject_key"]))
        with self.assertRaises(ValueError):
            s.audit(self.output)

    def test_boolean_context_start_is_not_an_integer_ordinal(self):
        self.build()
        self.rewrite("conversation/train.jsonl.gz", lambda rows: rows[0].update(context_start_ordinal=False))
        with self.assertRaisesRegex(ValueError, "Incomplete original prefix"):
            s.audit(self.output)

    def test_boolean_loss_mask_does_not_alias_zero_and_one(self):
        self.build()
        self.rewrite("conversation/train.jsonl.gz",
                     lambda rows: rows[0].update(loss_message_mask=[bool(v) for v in rows[0]["loss_message_mask"]]))
        with self.assertRaisesRegex(ValueError, "Loss mask"):
            s.audit(self.output)

    def test_manifest_file_counts_and_sizes_require_exact_integers_and_size(self):
        original = self.build()
        name = "conversation/validation.jsonl.gz"
        for field, value in (("rows", True), ("rows", 1.0), ("bytes", True),
                             ("bytes", float(original["files"][name]["bytes"])),
                             ("bytes", original["files"][name]["bytes"] + 1)):
            manifest = copy.deepcopy(original)
            manifest["files"][name][field] = value
            s.dump_json(self.output / "manifest.json", manifest)
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, "count/size"):
                s.audit(self.output)

    def test_target_cannot_stop_inside_a_contiguous_counselor_group(self):
        utterances = turns([("내담자", "친구와 연락을 시작하고 싶어요."), ("상담사", RESPONSE),
                           ("상담자", "그리고 사용자님이 원하는 연락 간격을 함께 전해도 좋겠습니다."),
                           ("내담자", "다른 이야기도 조금 더 나누고 싶어요."), ("상담사", SECOND_RESPONSE)])
        self.fixture([(source_row(), utterances),
                      (source_row("two", "validation"), turns([
                          ("내담자", "동생과 편하게 말하고 싶어요."), ("상담사", SECOND_RESPONSE)], "two"))])
        s.build(self.release, self.database, self.output)
        self.assertTrue(s.audit(self.output)["passed"])
        def shorten_group(rows):
            row = rows[0]
            row["target_end_ordinal"] = 1
            row["target_utterance_ids"] = [utterances[1]["utterance_id"]]
            row["messages"][-1]["content"] = RESPONSE
            row["target_sha256"] = s.sha_text(RESPONSE)
        self.rewrite("conversation/train.jsonl.gz", shorten_group)
        with self.assertRaisesRegex(ValueError, "inside a merged counselor"):
            s.audit(self.output)

    def test_auxiliary_offset_convention_cannot_be_relabelled(self):
        self.build()
        for unit in ("word", "sentence"):
            name = f"{unit}/train.jsonl.gz"
            original = list(s.read_rows(self.output / name))
            self.rewrite(name, lambda rows: rows[0].update(offset_reference="source_sentence_unicode_codepoints"))
            with self.subTest(unit=unit), self.assertRaisesRegex(ValueError, "offset convention"):
                s.audit(self.output)
            self.rewrite(name, lambda rows: rows.__setitem__(slice(None), original))


if __name__ == "__main__":
    unittest.main()
