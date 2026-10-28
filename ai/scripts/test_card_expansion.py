"""Regression fixtures are invented test strings, never counseling excerpts."""
from copy import deepcopy
from array import array
import json
from pathlib import Path
import tempfile
import unittest

import card_expansion as expansion
import expanded_card_dataset as dataset
import native_card_review as native
import audit_expanded_card_numeric as numeric
import role_dataset as data


def fixture():
    return {"case_id": "exp-a-001", "split": "train", "author_id": "native-author-a",
            "origin_type": "independent_ai_synthetic", "topic": "supporter_strain", "relationship": "테스트 관계",
            "facts": [{"id": "f1", "subject": "patient", "question_id": "p1", "text": "이용자가 상대의 일정 변경을 보고했다."},
                      {"id": "f2", "subject": "patient", "question_id": "p2", "text": "상대가 지금은 이야기하지 않겠다고 했다고 보고했다."},
                      {"id": "f3", "subject": "supporter", "question_id": "s1", "text": "이용자는 지쳐 있으며 오늘은 쉴 시간을 원한다."},
                      {"id": "f4", "subject": "user_goal", "question_id": "g1", "text": "이용자는 거절을 존중하며 자신의 범위도 전하려 한다."}],
            "cards": {"script": "테스트 전용 발화", "doList": ["테스트 전용 행동"],
                      "avoid": [{"avoid_phrase": "테스트 압박", "reason": "테스트 이유", "alternative": "테스트 선택권"}],
                      "next": "미래 조건 하나\n\n미래 조건 둘\n\n미래 조건 셋",
                      "care": {"feel": "테스트 이용자 공감", "tips": ["테스트 휴식"]}},
            "evidence_map": {field: ["f1", "f3", "f4"] for field in expansion.FIELDS}}


def verdict(identity, bad=None):
    return {"id": identity, "field_verdicts": {field: "unsupported" if field == bad else "pass" for field in expansion.FIELDS},
            "issues": [{"field": bad, "reason": "planted test error"}] if bad else []}


class CaseTests(unittest.TestCase):
    def setUp(self):
        self.case = fixture()
        self.frozen = {"exp-a-001": {"case_id": "exp-a-001", "author": "a", "split": "train"}}

    def test_valid_case(self):
        expansion.validate_case(self.case, self.frozen)

    def test_frozen_split_cannot_move(self):
        self.case["split"] = "validation"
        with self.assertRaisesRegex(ValueError, "Frozen split"):
            expansion.validate_case(self.case, self.frozen)

    def test_supporter_subject_cannot_disappear(self):
        self.case["facts"][2]["subject"] = "patient"
        with self.assertRaisesRegex(ValueError, "source actor"):
            expansion.validate_case(self.case, self.frozen)

    def test_evidence_cannot_reference_missing_fact(self):
        self.case["evidence_map"]["script"] = ["invented"]
        with self.assertRaisesRegex(ValueError, "evidence references"):
            expansion.validate_case(self.case, self.frozen)

    def test_saved_string_avoid_is_not_typed_wire(self):
        self.case["cards"]["avoid"] = ["legacy string"]
        with self.assertRaisesRegex(ValueError, "avoid roles"):
            expansion.validate_case(self.case, self.frozen)

    def test_missing_conditional_branch_rejected(self):
        self.case["cards"]["next"] = "one branch"
        with self.assertRaisesRegex(ValueError, "three future branches"):
            expansion.validate_case(self.case, self.frozen)

    def test_scope_hold(self):
        self.case["facts"][0]["text"] = "테스트 자해 내용"
        with self.assertRaisesRegex(ValueError, "outside nonclinical"):
            expansion.validate_case(self.case, self.frozen)

    def test_card_targets_never_enter_conditioning(self):
        rows = dataset.project_case(self.case, {"fixture_review": True})
        changed = deepcopy(self.case)
        changed["cards"]["script"] = "CHANGED_TARGET_SENTINEL"
        other = dataset.project_case(changed, {"fixture_review": True})
        self.assertEqual(len(rows), 5)
        for left, right in zip(rows, other):
            self.assertEqual(left["messages"][:-1], right["messages"][:-1])
            data.check_row(left)
            payload = json.loads(left["messages"][-2]["content"])
            self.assertEqual(set(payload["data"]), {"answers", "retrieval"})
            self.assertNotIn("CHANGED_TARGET_SENTINEL", data.canonical(payload))
        self.assertNotEqual(rows[0]["messages"][-1], other[0]["messages"][-1])

    def test_five_rows_share_family_and_split(self):
        rows = dataset.project_case(self.case, {})
        self.assertEqual(len({data.canonical(r["source_root_ids"]) for r in rows}), 1)
        self.assertEqual({r["split"] for r in rows}, {"train"})
        self.assertEqual({r["task"] for r in rows}, {"final_card_" + f for f in expansion.FIELDS})

    def test_projection_preserves_all_facts_without_teacher_evidence(self):
        row = dataset.project_case(self.case, {})[0]
        text = json.loads(row["messages"][-2]["content"])
        docs = text["data"]["retrieval"]["documents"]
        self.assertEqual({d["text"] for d in docs}, {f["text"] for f in self.case["facts"]})
        self.assertNotIn("evidence_map", data.canonical(text))
        self.assertNotIn("author_id", data.canonical(text))

    def test_near_identical_facts_held_across_split(self):
        other = deepcopy(self.case)
        other.update(case_id="exp-a-049", split="validation")
        with self.assertRaisesRegex(ValueError, "similar source facts"):
            dataset.novelty_report({"one": (self.case, {}), "two": (other, {})}, [])


class ReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        (self.root / "reviews").mkdir()
        self.case = fixture()
        control, field = expansion.control_case(self.case, 0)
        self.batch = {"version": expansion.REVIEW_VERSION,
            "request": {"model": "gemma4:12b", "messages": [
                {"role": "system", "content": expansion.REVIEW_PROMPT},
                {"role": "user", "content": data.canonical({"cases": [
                    {"id": "case", "facts": self.case["facts"], "cards": self.case["cards"]},
                    {"id": "negative", "facts": control["facts"], "cards": control["cards"]}]})}]},
            "case_hashes": {"case": expansion.case_hash(self.case)},
            "control_field": field, "control_passed": True,
            "response": {"done": True, "done_reason": "stop", "message": {
                "content": data.canonical({"reviews": [verdict("case"), verdict("negative", field)]})}}}
        self.record = {"case_id": self.case["case_id"], "case_sha256": expansion.case_hash(self.case),
            "reviewer_id": "local-ollama-gemma4:12b", "review_version": expansion.REVIEW_VERSION,
            "review_prompt_sha256": data.digest(expansion.REVIEW_PROMPT), "batch_evidence": "batch.json",
            "approval_scope": "independent_ai_experiment_only_not_human_clinical_review",
            "control_passed": True, "field_verdicts": verdict("case")["field_verdicts"], "issues": [], "accepted": True}
        self.persist()

    def persist(self):
        data.save(self.root / "reviews/batch.json", self.batch)
        self.record["batch_sha256"] = data.file_hash(self.root / "reviews/batch.json")

    def test_review_replays(self):
        self.assertTrue(dataset.verify_review(self.root, self.case, self.record))

    def test_stale_approval_after_target_edit_rejected(self):
        self.case["cards"]["care"]["feel"] = "a changed target"
        with self.assertRaisesRegex(ValueError, "Stale review"):
            dataset.verify_review(self.root, self.case, self.record)

    def test_review_payload_substitution_rejected_even_with_refreshed_file_hash(self):
        value = json.loads(self.batch["request"]["messages"][1]["content"])
        value["cases"][0]["facts"][0]["text"] = "different reviewer input"
        self.batch["request"]["messages"][1]["content"] = data.canonical(value)
        self.persist()
        with self.assertRaisesRegex(ValueError, "different case"):
            dataset.verify_review(self.root, self.case, self.record)

    def test_negative_control_must_fail(self):
        self.batch["response"]["message"]["content"] = data.canonical({"reviews": [verdict("case"), verdict("negative")]})
        self.persist()
        with self.assertRaisesRegex(ValueError, "accepted negative control"):
            dataset.verify_review(self.root, self.case, self.record)

    def test_tampered_planted_error_rejected(self):
        value = json.loads(self.batch["request"]["messages"][1]["content"])
        value["cases"][-1]["cards"]["script"] = "removed negative control"
        self.batch["request"]["messages"][1]["content"] = data.canonical(value)
        self.persist()
        with self.assertRaisesRegex(ValueError, "recorded corruption"):
            dataset.verify_review(self.root, self.case, self.record)

    def test_false_ledger_pass_rejected(self):
        self.batch["response"]["message"]["content"] = data.canonical({"reviews": [verdict("case", "care"), verdict("negative", "script")]})
        self.persist()
        with self.assertRaisesRegex(ValueError, "Ledger verdict"):
            dataset.verify_review(self.root, self.case, self.record)

    def test_proper_rejection_does_not_become_training_approval(self):
        bad = verdict("case", "care")
        self.batch["response"]["message"]["content"] = data.canonical({"reviews": [bad, verdict("negative", "script")]})
        self.record.update(accepted=False, field_verdicts=bad["field_verdicts"], issues=bad["issues"])
        self.persist()
        self.assertFalse(dataset.verify_review(self.root, self.case, self.record))

    def test_incomplete_review_rejected(self):
        self.batch["response"]["done_reason"] = "length"
        self.persist()
        with self.assertRaisesRegex(ValueError, "Incomplete stored review"):
            dataset.verify_review(self.root, self.case, self.record)

    def test_duplicate_reviewer_ids_rejected(self):
        with self.assertRaisesRegex(ValueError, "coverage/identity"):
            expansion.parse_review({"reviews": [verdict("one"), verdict("one")]}, ["one", "two"])

    def test_missing_issue_rejected(self):
        bad = verdict("one", "care")
        bad["issues"] = []
        with self.assertRaisesRegex(ValueError, "issues disagree"):
            expansion.parse_review({"reviews": [bad]}, ["one"])


class CurriculumTests(unittest.TestCase):
    def course(self):
        course = dataset.course_config()
        for phase in course["phases"]:
            phase["data"] = {s: {} for s in data.SPLITS}
        return course

    def test_adapter_chain_ends_in_generation(self):
        dataset.check_course(self.course())
        self.assertEqual(dataset.PHASES[-1], "02_card_generation")

    def test_resetting_adapter_between_stages_rejected(self):
        course = self.course()
        course["phases"][1]["new_lora"] = True
        with self.assertRaisesRegex(ValueError, "adapter continuity"):
            dataset.check_course(course)

    def test_12b_adapter_reuse_rejected(self):
        course = self.course()
        course["cross_model_adapter_reuse"] = True
        with self.assertRaisesRegex(ValueError, "cross_model_adapter_reuse"):
            dataset.check_course(course)

    def test_validation_gradient_and_truncation_rejected(self):
        for key in ("validation_used_for_gradient", "truncation", "packing", "sampling"):
            with self.subTest(key=key):
                course = self.course()
                course[key] = True
                with self.assertRaises(ValueError):
                    dataset.check_course(course)


class OriginalWarmupTests(unittest.TestCase):
    def test_keeps_selection_and_reads_original_31b_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory).resolve()
            source, prior, output = (base / p for p in ("source", "prior", "output"))
            source.mkdir()
            prior.mkdir()
            output.mkdir()
            (output / "provenance").mkdir()
            original = {"id": "01_original", "data": {}}
            previous = {"id": "01_dialogue_warmup", "data": {}}
            expected_bytes = {}
            for split in data.SPLITS:
                row = dataset.project_case(fixture(), {})[0]
                row.update(row_id="original-" + split, split=split, task="original_counselor_continuation")
                row["source_root_ids"] = ["root-" + split]
                row["source_group_ids"] = ["group-" + split]
                held = deepcopy(row)
                held["row_id"] += "-held"
                selected = [row]
                all_rows = [held, row] if split == "train" else [row]
                tokens = array("I", [15, 20, 25]).tobytes()
                binary = source / (split + ".tokens.bin")
                binary.write_bytes(tokens * len(all_rows))
                index = source / (split + ".index.jsonl")
                lengths = {"prefix_length": 2, "target_length": 1, "sequence_length": 3, "target_boundary_whitespace_trimmed": False}
                index.write_text("".join(data.canonical(dataset.index_entry(r, lengths, i * 3, tokens)) + "\n" for i, r in enumerate(all_rows)))
                original["data"][split] = {"index": index.name, "tokens": binary.name}
                previous["data"][split] = data.write_partition(prior / "chat_12b", previous["id"], split, selected)
                data.write_partition(prior / "chat_12b", "hold_shared_openers", split, [held] if split == "train" else [])
                # A deliberately wrong 12B binary must never be read by warmup.
                (prior / "chat_12b" / (split + ".tokens.bin")).write_bytes(b"WRONG_12B")
                expected_bytes[split] = tokens
            data.save(source / "COURSE.json", {"phases": [original]})
            data.save(prior / "chat_12b/COURSE.json", {"phases": [previous]})
            course = dataset.course_config()
            stats = dataset.warmup(output, source, prior, course)
            for split in data.SPLITS:
                part = course["phases"][0]["data"][split]
                self.assertEqual(part["rows"], 1)
                self.assertEqual((output / part["token_binary"]).read_bytes(), expected_bytes[split])
                loader = data.IndexedTokens(output / part["token_index"], output / part["token_binary"])
                self.assertEqual(loader[0]["encoded"]["labels"], [-100, -100, 25])
                self.assertEqual(stats[dataset.PHASES[0] + "/" + split]["rows"], 1)


class NativeFallbackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        (self.root / "source").mkdir()
        (self.root / "reviews").mkdir()
        self.case = fixture()
        data.save(self.root / "SPLITS.json", {"assignments": [{"case_id": "exp-a-001", "split": "train", "author": "a"}]})
        (self.root / "source/author_a.jsonl").write_text(data.canonical(self.case) + "\n")
        native.prepare(self.root)
        self.bindings = json.loads((self.root / "reviews/native_bindings.json").read_text())
        self.binding = next(iter(self.bindings.values()))

    def output(self, negative_pass=False):
        ids = list(self.binding["case_hashes"])
        reviews = [verdict(i) for i in ids]
        reviews.append(verdict(self.binding["control_id"], None if negative_pass else self.binding["control_field"]))
        data.save(self.root / self.binding["output_file"], {"reviews": reviews})

    def test_blinded_inputs_omit_author_split_and_ground_truth(self):
        content = (self.root / self.binding["input_file"]).read_text()
        for marker in ("exp-a-001", "native-author-a", "evidence_map", "control_id", "validation"):
            self.assertNotIn(marker, content)

    def test_native_verdict_ingests_once_and_replays(self):
        self.output()
        self.assertEqual(native.ingest(self.root), {"ingested": 1, "accepted": 1})
        self.assertEqual(native.ingest(self.root), {"ingested": 0, "accepted": 0})
        record = list(data.read_rows(self.root / "reviews/native_reviews.jsonl"))[0]
        self.assertTrue(dataset.verify_review(self.root, self.case, record))

    def test_passing_native_control_cannot_enter_ledger(self):
        self.output(negative_pass=True)
        with self.assertRaisesRegex(ValueError, "accepted negative control"):
            native.ingest(self.root)
        self.assertFalse((self.root / "reviews/native_reviews.jsonl").exists())

    def test_modified_native_verdict_rejected(self):
        self.output()
        native.ingest(self.root)
        record = list(data.read_rows(self.root / "reviews/native_reviews.jsonl"))[0]
        self.output(negative_pass=True)
        with self.assertRaisesRegex(ValueError, "output hash changed"):
            dataset.verify_review(self.root, self.case, record)

    def test_altered_case_cannot_reuse_native_approval(self):
        self.output()
        native.ingest(self.root)
        record = list(data.read_rows(self.root / "reviews/native_reviews.jsonl"))[0]
        self.case["cards"]["script"] = "changed"
        with self.assertRaisesRegex(ValueError, "Stale native review"):
            dataset.verify_review(self.root, self.case, record)


class RequiredNumericAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.course = dataset.course_config()
        self.counts, self.tokens = {}, {}
        for phase in self.course["phases"]:
            self.counts[phase["id"]] = {}
            for split in data.SPLITS:
                part = {k: phase["id"] + "-" + split + "-" + k for k in ("path", "token_index", "token_binary")}
                phase["data"][split] = part
                for name in part.values():
                    (self.root / name).write_text("numeric-test-fixture")
                self.counts[phase["id"]][split] = 1
                self.tokens[phase["id"] + "/" + split] = 3
        (self.root / "tokenizer").mkdir()
        for name in dataset.PINS:
            (self.root / "tokenizer" / name).write_text("tokenizer-test-fixture")
        (self.root / "provenance").mkdir()
        (self.root / "scripts").mkdir()
        (self.root / "scripts/audit_expanded_card_numeric.py").write_text("audit-test-fixture")
        data.save(self.root / "COURSE.json", self.course)
        data.save(self.root / "provenance/SOURCE.json", {"staged_manifest_sha256": "test-source-hash"})
        self.proof = {"status": "passed", "mismatches": 0, "audited_files": numeric.numeric_inputs(self.root, self.course),
                      "counts": {"original_rows": 2, "card_rows": 4, "original_tokens": 6, "card_tokens": 12},
                      "source_manifest_sha256": "test-source-hash",
                      "audit_script_sha256": data.file_hash(self.root / "scripts/audit_expanded_card_numeric.py")}
        data.save(self.root / "NUMERIC_AUDIT.json", self.proof)

    def test_current_complete_proof_is_required(self):
        dataset.check_numeric_report(self.root, self.course, self.counts, self.tokens)

    def test_missing_audit_fails(self):
        (self.root / "NUMERIC_AUDIT.json").unlink()
        with self.assertRaisesRegex(ValueError, "audit is missing"):
            dataset.check_numeric_report(self.root, self.course, self.counts, self.tokens)

    def test_binary_index_and_manifest_change_cannot_reuse_audit(self):
        part = self.course["phases"][2]["data"]["train"]
        for key in ("token_binary", "token_index"):
            (self.root / part[key]).write_text("modified-in-vocab-token-test")
        dataset.refresh_manifest(self.root)
        with self.assertRaisesRegex(ValueError, "stale or incomplete"):
            dataset.check_numeric_report(self.root, self.course, self.counts, self.tokens)

    def test_zero_or_partial_coverage_fails(self):
        for counts in ({}, {**self.proof["counts"], "card_rows": 3}):
            with self.subTest(counts=counts):
                data.save(self.root / "NUMERIC_AUDIT.json", {**self.proof, "counts": counts})
                with self.assertRaisesRegex(ValueError, "Incomplete numerical audit coverage"):
                    dataset.check_numeric_report(self.root, self.course, self.counts, self.tokens)

    def test_empty_course_rejected_by_audit_prerequisite(self):
        for phase in self.course["phases"]:
            phase["data"] = {}
        with self.assertRaisesRegex(ValueError, "Missing split"):
            dataset.check_course(self.course)

if __name__ == "__main__":
    unittest.main()
