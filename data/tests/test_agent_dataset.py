"""Synthetic mechanics only: these fixtures are not actual AI-reviewed cases."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from counseling_pipeline import agent_dataset as d
from counseling_pipeline.annotations import canonical, digest
from counseling_pipeline.agent_training import QUESTION_BANK_PATH


def episode(eid="one", split="train"):
    prompt = f"친구 {eid}가 오늘 🙂 조용히 쉬고 싶대요. 답장을 도와주세요."
    followup = "저도 잠깐 쉬고 싶지만 미안해요."
    first = [{"text": "친구의 쉬고 싶은 마음을 존중하고 싶으시군요.", "function": "empathy"},
             {"text": "'편히 쉬어. 답장은 천천히 해도 괜찮아.'라고 전해 보세요.", "function": "wording_example"}]
    second = [{"text": "사용자님에게도 쉬는 시간이 필요하군요.", "function": "empathy"},
              {"text": "'나도 잠깐 쉬고 저녁에 다시 연락할게.'라고 말할 수 있어요.", "function": "wording_example"}]
    span = lambda mid, text, subject: {
        "message_id": mid, "text": text, "subject": subject, "temporal_scope": "current",
        "assertion_status": "reported", "quoted": False, "contextual_role": "휴식에 대한 요청",
    }
    return {
        "schema_version": d.EPISODE_SCHEMA, "episode_id": eid, "origin_type": "synthetic_scenario",
        "source_root_ids": [f"synthetic:{eid}"], "source_group_ids": [f"synthetic:group:{eid}"],
        "split": split, "author_id": "fixture-author", "relationship": "friend", "domain": "communication",
        "goal": "친구와 사용자 모두의 휴식 존중", "source_refs": [],
        "safety_scope": "non_acute_communication", "risk_tags": [], "resource_dependencies": [],
        "messages": [
            {"message_id": "u1", "role": "user", "content": prompt},
            {"message_id": "a1", "role": "assistant", "content": " ".join(s["text"] for s in first)},
            {"message_id": "u2", "role": "user", "content": followup},
            {"message_id": "a2", "role": "assistant", "content": " ".join(s["text"] for s in second)},
        ],
        "annotations": [
            {"message_id": "a1", "primary_action": "SUPPORT", "response_components": ["empathy", "wording_example"],
             "segments": first, "focus_spans": [span("u1", "🙂 조용히 쉬고 싶대요", "subject")]},
            {"message_id": "a2", "primary_action": "SUPPORT", "response_components": ["empathy", "wording_example"],
             "segments": second, "focus_spans": [span("u2", "저도 잠깐 쉬고 싶지만", "user")]},
        ],
    }


def review(row):
    return {"episode_id": row["episode_id"], "episode_sha256": digest(row),
            "reviewer_id": "fixture-independent-reviewer", "reviewer_type": "ai",
            "status": "accepted_for_experiment", "checks": {k: True for k in d.CHECKS},
            "rationale": "Synthetic mechanics test; no real review asserted.", "reviewed_at": "2026-10-09T00:00:00+09:00"}


class AgentDatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "release"
        self.episodes = [episode(), episode("two", "validation")]

    def build(self):
        return d.build_dataset(self.episodes, [review(e) for e in self.episodes], self.output)

    def test_three_units_roundtrip_preserves_lineage_splits_and_masks(self):
        manifest = self.build()
        self.assertEqual(manifest["counts"], {"conversation": {"train": 2, "validation": 2},
                                           "sentence": {"train": 4, "validation": 4},
                                           "word": {"train": 2, "validation": 2}})
        self.assertFalse(manifest["human_or_expert_approved"])
        self.assertFalse(manifest["production_ready"])
        self.assertFalse(manifest["model_trained"])
        rows, loaded = d.audit_release(self.output, allow_ai_draft=True)
        self.assertEqual(manifest, loaded)
        for unit in d.UNITS:
            for split in d.SPLITS:
                for row in rows[unit][split]:
                    self.assertEqual(row["split"], split)
                    self.assertEqual(row["status"], d.STATUS)
                    self.assertEqual(row["loss_message_mask"], [0] * (len(row["messages"]) - 1) + [1])
                    self.assertTrue(row["source_root_ids"][0].startswith("synthetic:"))

    def test_loader_refuses_default_even_for_valid_experimental_release(self):
        self.build()
        with self.assertRaisesRegex(ValueError, "allow_ai_draft"):
            d.load_dataset(self.output, "conversation", "train")

    def test_prefix_excludes_future_and_metadata_and_retains_prior_response(self):
        self.episodes[0]["messages"][0]["secret_label"] = "HIDDEN_METADATA"
        self.build()
        rows, _ = d.load_dataset(self.output, "conversation", "train", allow_ai_draft=True)
        self.assertEqual(len(rows[0]["messages"]), 3)
        self.assertEqual(len(rows[1]["messages"]), 5)
        first_input = str(rows[0]["messages"][:-1])
        self.assertNotIn("저도 잠깐", first_input)
        self.assertNotIn("HIDDEN_METADATA", first_input)
        self.assertNotIn("source_root_ids", first_input)
        self.assertEqual(rows[1]["messages"][2]["content"], self.episodes[0]["messages"][1]["content"])
        changed = copy.deepcopy(self.episodes)
        changed[0]["messages"][2]["content"] += " 새로운 미래"
        changed_rows = d.derive_rows(changed)["conversation"]["train"]
        self.assertEqual(rows[0]["messages"], changed_rows[0]["messages"])

    def test_sentence_has_only_visible_prefix_and_selected_candidate(self):
        self.build()
        rows, _ = d.load_dataset(self.output, "sentence", "train", allow_ai_draft=True)
        payload = json.loads(rows[0]["messages"][1]["content"])
        self.assertEqual(len(payload["dialogue_prefix"]), 1)
        self.assertEqual(set(payload), {"dialogue_prefix", "candidate"})
        self.assertNotIn("천천히", canonical(payload))
        evidence = rows[1]["evidence"]
        assistant = self.episodes[0]["messages"][1]["content"]
        self.assertEqual(assistant[evidence["start_char"]:evidence["end_char"]], evidence["text"])

    def test_word_spans_use_unicode_codepoints_and_negation_is_explicit(self):
        self.episodes[0]["annotations"][0]["focus_spans"][0]["assertion_status"] = "negated"
        self.build()
        rows, _ = d.load_dataset(self.output, "word", "train", allow_ai_draft=True)
        selected = json.loads(rows[0]["messages"][1]["content"])["selected_span"]
        content = self.episodes[0]["messages"][0]["content"]
        self.assertEqual(selected["start_char"], content.index("🙂"))
        self.assertEqual(content[selected["start_char"]:selected["end_char"]], selected["text"])
        self.assertTrue(json.loads(rows[0]["messages"][-1]["content"])["negated"])

    def test_missing_stale_failed_and_same_author_reviews_rejected(self):
        base = self.episodes[0]
        bad_reviews = [[], [{**review(base), "episode_sha256": "wrong"}],
                       [{**review(base), "status": "hold"}],
                       [{**review(base), "reviewer_id": base["author_id"]}],
                       [{**review(base), "reviewer_type": "human"}],
                       [{**review(base), "checks": {k: 1 for k in d.CHECKS}}]]
        for reviews in bad_reviews:
            with self.subTest(reviews=reviews), self.assertRaises(ValueError):
                d.validate_inputs([base], reviews)

    def test_conflicting_review_is_not_last_write_wins(self):
        r = review(self.episodes[0])
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            d.validate_inputs([self.episodes[0]], [r, {**r, "status": "hold"}])

    def test_source_root_or_group_split_overlap_rejected(self):
        for field in ("source_root_ids", "source_group_ids"):
            cases = copy.deepcopy(self.episodes)
            cases[1][field] = cases[0][field]
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "cross-split"):
                d.validate_inputs(cases, [review(e) for e in cases])

    def test_renamed_dialogue_and_shared_prefix_extension_rejected(self):
        cases = copy.deepcopy(self.episodes)
        cases[1]["messages"] = copy.deepcopy(cases[0]["messages"])
        cases[1]["annotations"] = copy.deepcopy(cases[0]["annotations"])
        with self.assertRaisesRegex(ValueError, "duplicate dialogue"):
            d.validate_inputs(cases, [review(e) for e in cases])
        cases[0]["messages"] = cases[0]["messages"][:2]
        cases[0]["annotations"] = cases[0]["annotations"][:1]
        with self.assertRaisesRegex(ValueError, "extended dialogue prefix"):
            d.validate_inputs(cases, [review(e) for e in cases])

    def test_whitespace_or_unicode_cannot_disguise_a_renamed_dialogue(self):
        for split in ("train", "validation"):
            for transform in (lambda text: " \n" + text + "  ",
                              lambda text: text.replace("A", "Ａ")):
                first = episode("A", "train")
                renamed = copy.deepcopy(first)
                renamed.update(episode_id="renamed", split=split,
                               source_root_ids=["synthetic:renamed"],
                               source_group_ids=["synthetic:group:renamed"])
                for message in renamed["messages"]:
                    if message["role"] == "user":
                        message["content"] = transform(message["content"])
                with self.subTest(split=split, transform=transform), self.assertRaisesRegex(ValueError, "duplicate dialogue"):
                    d.validate_inputs([first, renamed], [review(first), review(renamed)])

    def test_normalized_shared_prefix_is_rejected_even_with_a_different_answer(self):
        first = episode("A", "train")
        renamed = copy.deepcopy(first)
        renamed.update(episode_id="renamed", split="validation",
                       source_root_ids=["synthetic:renamed"],
                       source_group_ids=["synthetic:group:renamed"])
        renamed["messages"][0]["content"] = "  " + renamed["messages"][0]["content"].replace("A", "Ａ")
        segment = renamed["annotations"][0]["segments"][0]
        segment["text"] = "친구의 요청에 답하려는 상황이군요."
        renamed["messages"][1]["content"] = " ".join(s["text"] for s in renamed["annotations"][0]["segments"])
        with self.assertRaisesRegex(ValueError, "extended dialogue prefix"):
            d.validate_inputs([first, renamed], [review(first), review(renamed)])

    def test_unresolved_speaker_is_preserved_as_unknown_in_word_targets(self):
        span = self.episodes[0]["annotations"][0]["focus_spans"][0]
        span.update(subject="unknown", temporal_scope="unknown", contextual_role="speaker_unresolved")
        self.build()
        rows, _ = d.load_dataset(self.output, "word", "train", allow_ai_draft=True)
        target = json.loads(rows[0]["messages"][-1]["content"])
        self.assertEqual(target["subject"], "unknown")
        self.assertEqual(target["temporal_scope"], "unknown")
        for unsupported in (None, "anyone", True):
            span["subject"] = unsupported
            with self.subTest(subject=unsupported), self.assertRaisesRegex(ValueError, "span subject"):
                d.validate_episode(self.episodes[0])

    def test_unsafe_or_source_adapted_episode_rejected(self):
        for field, value in [("safety_scope", "acute"), ("risk_tags", ["crisis"]),
                             ("origin_type", "adapted_from_source"), ("source_refs", [{"id": "raw"}]),
                             ("source_root_ids", ["corpus:123"]), ("resource_dependencies", [{"id": "bank"}])]:
            row = episode()
            row[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                d.validate_episode(row)
        for action in ("SAFETY_SUPPORT", "ASK_CFI"):
            row = episode()
            row["annotations"][0]["primary_action"] = action
            with self.assertRaises(ValueError):
                d.validate_episode(row)
        row = episode()
        row["annotations"][0]["response_components"].append("safety_guidance")
        with self.assertRaisesRegex(ValueError, "acute-safety"):
            d.validate_episode(row)

    def test_known_question_bank_borrowing_rejected(self):
        row = episode()
        bank = json.loads(QUESTION_BANK_PATH.read_text(encoding="utf-8"))
        row["messages"][0]["content"] += bank["questions"][0]["canonical_question"]
        with self.assertRaisesRegex(ValueError, "question-bank"):
            d.validate_episode(row)

    def test_bad_segments_missing_annotation_and_source_roles_rejected(self):
        row = episode()
        row["annotations"][0]["segments"][0]["text"] += "changed"
        with self.assertRaisesRegex(ValueError, "reconstruct"):
            d.validate_episode(row)
        row = episode()
        row["annotations"].pop()
        with self.assertRaisesRegex(ValueError, "one annotation"):
            d.validate_episode(row)
        row = episode()
        row["messages"][0]["role"] = "system"
        with self.assertRaisesRegex(ValueError, "alternate"):
            d.validate_episode(row)

    def test_future_or_assistant_span_cannot_be_word_input(self):
        for mid in ("u2", "a1", "unknown"):
            row = episode()
            row["annotations"][0]["focus_spans"][0]["message_id"] = mid
            with self.subTest(mid=mid), self.assertRaisesRegex(ValueError, "visible user"):
                d.validate_episode(row)

    def test_ambiguous_span_requires_valid_explicit_offset(self):
        row = episode()
        row["messages"][0]["content"] = "쉬고 쉬고"
        span = row["annotations"][0]["focus_spans"][0]
        span["text"] = "쉬고"
        with self.assertRaisesRegex(ValueError, "exactly once"):
            d.validate_episode(row)
        span["start_char"] = 3
        d.validate_episode(row)
        span["start_char"] = True
        with self.assertRaisesRegex(ValueError, "start_char"):
            d.validate_episode(row)

    def test_overlapping_ambiguous_span_not_silently_selected(self):
        with self.assertRaisesRegex(ValueError, "exactly once"):
            d._span("aaa", {"text": "aa"})

    def test_changed_file_rejected(self):
        self.build()
        with (self.output / "conversation/train.jsonl").open("a", encoding="utf-8") as handle:
            handle.write("{}\n")
        with self.assertRaisesRegex(ValueError, "file hash"):
            d.audit_release(self.output, allow_ai_draft=True)

    def test_changed_row_with_updated_file_hash_still_rejected(self):
        manifest = self.build()
        name = "conversation/train.jsonl"
        path = self.output / name
        rows = d.read_jsonl(path)
        rows[0]["messages"][-1]["content"] = "tampered response"
        path.write_text("".join(canonical(r) + "\n" for r in rows), encoding="utf-8")
        manifest["files"][name]["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        (self.output / "manifest.json").write_text(canonical(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "derivation"):
            d.audit_release(self.output, allow_ai_draft=True)

    def test_changed_episodes_with_updated_file_hash_invalidates_review(self):
        manifest = self.build()
        name = "episodes.jsonl"
        path = self.output / name
        episodes = d.read_jsonl(path)
        episodes[0]["goal"] += "changed"
        path.write_text("".join(canonical(r) + "\n" for r in episodes), encoding="utf-8")
        manifest["files"][name]["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        (self.output / "manifest.json").write_text(canonical(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "stale content-bound"):
            d.audit_release(self.output, allow_ai_draft=True)

    def test_manifest_status_and_counts_not_trusted(self):
        manifest = self.build()
        manifest["human_or_expert_approved"] = True
        (self.output / "manifest.json").write_text(canonical(manifest), encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "metadata/row binding"):
            d.audit_release(self.output, allow_ai_draft=True)

    def test_hr2_release_manifest_root_must_be_object(self):
        original = self.build()
        for value in ([], None, True, 7, "SYNTHETIC_PRIVATE_MARKER"):
            with self.subTest(value_type=type(value).__name__):
                (self.output / "manifest.json").write_text(canonical(value), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "manifest must be an object"):
                    d.audit_release(self.output, allow_ai_draft=True)
        (self.output / "manifest.json").write_text(canonical(original), encoding="utf-8")
        self.assertEqual(d.audit_release(self.output, allow_ai_draft=True)[1], original)

    def test_hr2_each_release_file_metadata_must_be_object(self):
        original = self.build()
        for name in original["files"]:
            for value in ([], None, "SYNTHETIC_PRIVATE_MARKER", True, 7):
                with self.subTest(name=name, value_type=type(value).__name__):
                    manifest = copy.deepcopy(original)
                    manifest["files"][name] = value
                    (self.output / "manifest.json").write_text(canonical(manifest), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "file metadata must be an object"):
                        d.audit_release(self.output, allow_ai_draft=True)

    def test_hr2_release_file_metadata_fields_remain_typed_and_content_bound(self):
        original = self.build()
        for field, values in (("sha256", [None, [], 7, "a" * 63, "0" * 64]),
                              ("rows", [None, [], True, -1, "2", 2.0, 999])):
            for value in values:
                with self.subTest(field=field, value_type=type(value).__name__):
                    manifest = copy.deepcopy(original)
                    manifest["files"]["episodes.jsonl"][field] = value
                    (self.output / "manifest.json").write_text(canonical(manifest), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        d.audit_release(self.output, allow_ai_draft=True)

    def test_existing_output_and_empty_auxiliary_split_rejected(self):
        self.build()
        with self.assertRaisesRegex(ValueError, "output exists"):
            self.build()
        for annotation in self.episodes[1]["annotations"]:
            annotation["focus_spans"] = []
        output = self.output.parent / "empty-word-release"
        with self.assertRaisesRegex(ValueError, "word requires"):
            d.build_dataset(self.episodes, [review(e) for e in self.episodes], output)
        self.assertFalse(output.exists())

    def test_token_adapter_masks_prefix_and_refuses_truncation_and_default(self):
        self.build()
        rows, manifest = d.load_dataset(self.output, "conversation", "train", allow_ai_draft=True)
        encoder = lambda prefix, target: ([5] * len(prefix), [8, 9])
        batch = d.build_token_batch(rows, encoder, 20, 0, manifest=manifest, allow_ai_draft=True)
        self.assertEqual(batch["labels"], [[-100, -100, 8, 9, -100, -100], [-100, -100, -100, -100, 8, 9]])
        self.assertEqual(batch["attention_mask"][0], [1, 1, 1, 1, 0, 0])
        with self.assertRaisesRegex(ValueError, "allow_ai_draft"):
            d.build_token_batch(rows, encoder, 20, 0, manifest=manifest)
        with self.assertRaisesRegex(ValueError, "truncation refused"):
            d.build_token_batch(rows, encoder, 3, 0, manifest=manifest, allow_ai_draft=True)
        rows[0]["messages"][-1]["content"] = "changed"
        with self.assertRaisesRegex(ValueError, "row changed"):
            d.build_token_batch(rows, encoder, 20, 0, manifest=manifest, allow_ai_draft=True)


if __name__ == "__main__":
    unittest.main()
