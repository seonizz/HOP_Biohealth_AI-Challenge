"""Round-2 adversarial controls; all approvals/permissions here are synthetic."""
import copy
from pathlib import Path
import tempfile
import unittest

from counseling_pipeline import agent_training as a
from test_agent_training import fixture, review


class RoundTwoTrainingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        evidence = self.root / "synthetic_permission.txt"
        evidence.write_text("Artificial permission fixture, no actual grant.")
        import hashlib
        self.permission = {"status": "verified", "local_training_allowed": True,
                           "verified_by": "synthetic", "verified_at": "2026-10-09T00:00:00Z",
                           "evidence_path": evidence.name, "evidence_sha256": hashlib.sha256(evidence.read_bytes()).hexdigest()}

    def registry(self, *cases, bank=False):
        entries = {root: dict(self.permission) for case in cases for root in case["source_root_ids"]}
        entries["question_bank"] = ({**self.permission, **{k: v for k, v in a.question_bank_dependency({"prefix"}).items()
                                                          if k in {"version", "content_sha256"}}}
                                    if bank else {"status": "unverified", "local_training_allowed": False})
        return entries

    def approved(self, case, expert=False):
        result = review(case)
        if expert:
            result.update(reviewer_type="domain_expert", qualification_ref="synthetic-expertise-only",
                          safety_policy_version="synthetic-policy-only")
        return result

    def bank_history(self):
        import json
        text = json.loads(a.QUESTION_BANK_PATH.read_text())["questions"][8]["canonical_question"]
        case = fixture()
        case["prefix"] = a.prepare_prefix([
            {"message_id": "u1", "role": "user", "content": "친구에게 존중하는 말을 하고 싶어요."},
            {"message_id": "a2", "role": "assistant", "content": text},
            {"message_id": "u3", "role": "user", "content": "그 정보는 말하기 싫어요. 일반적인 존중 표현만 주세요."},
        ], "u3")
        case["annotation_provenance"]["prefix_sha256"] = a.digest(case["prefix"])
        return case

    def test_f01_support_safety_component_requires_expert_and_policy(self):
        case = fixture()
        case["decision"].update(response_components=["wording_example", "safety_guidance"], safety_subjects=["friend"])
        result = a.audit([case], [self.approved(case)], self.registry(case), self.root)
        self.assertEqual(result["eligible_count"], 0)
        self.assertIn("risk_review_required", result["exclusion_counts"])
        self.assertIn("reviewed_safety_policy_required", result["exclusion_counts"])
        with self.assertRaisesRegex(ValueError, "no approved"):
            a.export([case], [self.approved(case)], self.registry(case), self.root / "blocked", self.root, exposures=[])
        self.assertFalse((self.root / "blocked").exists())
        self.assertEqual(a.audit([case], [self.approved(case, True)], self.registry(case), self.root)["eligible_count"], 1)

    def test_f01_all_explicit_safety_indicators_and_normal_control(self):
        normal = fixture()
        self.assertEqual(a.audit([normal], [review(normal)], self.registry(normal), self.root)["eligible_count"], 1)
        for variant in ("risk_tag", "safety_subjects", "primary_action"):
            with self.subTest(variant=variant):
                case = fixture()
                if variant == "risk_tag":
                    case["risk_tags"] = ["acute_safety"]
                elif variant == "safety_subjects":
                    case["decision"]["safety_subjects"] = ["friend"]
                else:
                    case["decision"].update(primary_action="SAFETY_SUPPORT", response_components=["safety_guidance"], safety_subjects=["friend"])
                result = a.audit([case], [review(case)], self.registry(case), self.root)
                self.assertIn("risk_review_required", result["exclusion_counts"])

    def test_h01_claim_requires_content_and_slot(self):
        claim = {"claim": "친구", "slot": "relationship", "subject": "friend", "time": "current",
                 "source_type": "user_report", "status": "reported",
                 "evidence": [{"message_id": "u1", "start_char": 0, "end_char": 2, "text": "친구"}]}
        case = fixture();case["claims"] = [claim]
        a.validate_case(case)
        for key in ("claim", "slot"):
            for value in (None, "", "   ", False):
                with self.subTest(key=key, value=value):
                    invalid = copy.deepcopy(case);invalid["claims"][0][key] = value
                    with self.assertRaisesRegex(ValueError, "claim content and slot"):
                        a.validate_case(invalid)
        invalid = copy.deepcopy(case);del invalid["claims"][0]["claim"]
        with self.assertRaisesRegex(ValueError, "claim content and slot"):
            a.validate_case(invalid)

    def test_h01_safety_subjects_are_nonempty_unique_strings(self):
        for value in ("   ", "friend", [], [""], ["friend", "friend"], [0], None):
            with self.subTest(value=value):
                case = fixture();case["decision"]["safety_subjects"] = value
                with self.assertRaisesRegex(ValueError, "safety subjects"):
                    a.validate_case(case)
        case = fixture();case["decision"]["response_components"] = ["safety_guidance"]
        with self.assertRaisesRegex(ValueError, "guidance needs valid subjects"):
            a.validate_case(case)

    def test_f05_undeclared_bank_in_history_is_rejected_even_for_support(self):
        case = self.bank_history()
        with self.assertRaisesRegex(ValueError, "known question-bank usage missing"):
            a.audit([case], [review(case)], self.registry(case), self.root)
        case["resource_dependencies"] = [a.question_bank_dependency({"prefix"})]
        result = a.audit([case], [review(case)], self.registry(case), self.root)
        self.assertEqual(result["eligible_count"], 0)
        self.assertIn("question_bank_use_unverified", result["exclusion_counts"])

    def test_f05_declared_verified_bank_survives_export_with_provenance(self):
        case = self.bank_history();case["resource_dependencies"] = [a.question_bank_dependency({"prefix"})]
        out = self.root / "valid"
        a.export([case], [review(case)], self.registry(case, bank=True), out, self.root, exposures=[])
        rows, _ = a.load_training_release(out, "train")
        self.assertEqual(rows[0]["resource_dependencies"], case["resource_dependencies"])
        self.assertEqual(rows[0]["messages"][2]["content"], case["prefix"]["messages"][1]["content"])

    def test_f05_resources_shared_across_splits_are_not_lineage_roots(self):
        first = self.bank_history();first["resource_dependencies"] = [a.question_bank_dependency({"prefix"})]
        second = copy.deepcopy(first)
        second.update(case_id="other", source_root_ids=["other_root"], split="validation")
        second["prefix"]["messages"][0]["content"] = "동생과 이야기하는 방법을 알고 싶어요."
        second["annotation_provenance"]["prefix_sha256"] = a.digest(second["prefix"])
        result = a.audit([first, second], [review(first), review(second)], self.registry(first, second, bank=True), self.root)
        self.assertEqual(result["eligible_count"], 2)
        self.assertEqual(result["source_root_count"], 2)

    def test_f05_target_borrowing_and_inventory_shape(self):
        case = fixture();case["target_response"] = self.bank_history()["prefix"]["messages"][1]["content"]
        with self.assertRaisesRegex(ValueError, "known question-bank usage missing"):
            a.validate_case(case)
        case["resource_dependencies"] = [a.question_bank_dependency({"target"})]
        a.validate_case(case)
        for invalid in (None, "question_bank", ["question_bank"], [{}]):
            changed = copy.deepcopy(case);changed["resource_dependencies"] = invalid
            with self.assertRaises(ValueError):a.validate_case(changed)

    def test_f05_resource_version_and_inventory_review_are_bound(self):
        case = self.bank_history();case["resource_dependencies"] = [a.question_bank_dependency({"prefix"})]
        registry = self.registry(case, bank=True);registry["question_bank"]["version"] = "stale"
        self.assertIn("resource_version_or_content_unverified", a.audit([case], [review(case)], registry, self.root)["exclusion_counts"])
        evidence_review = review(case);evidence_review["checks"].pop("resource_dependencies")
        self.assertIn("review_checks_incomplete", a.audit([case], [evidence_review], self.registry(case, bank=True), self.root)["exclusion_counts"])
        case["resource_dependencies"][0]["content_sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "version/content mismatch"):
            a.validate_case(case)

    def test_f05_declared_adaptation_and_other_template_require_permission(self):
        case = fixture()
        case["resource_dependencies"] = [{"resource_id": "outside_template", "version": "1", "content_sha256": "a" * 64, "used_in": ["adaptation"]}]
        self.assertIn("resource_use_unverified", a.audit([case], [review(case)], self.registry(case), self.root)["exclusion_counts"])
        case["resource_dependencies"] = [a.question_bank_dependency({"adaptation"})]
        self.assertIn("question_bank_use_unverified", a.audit([case], [review(case)], self.registry(case), self.root)["exclusion_counts"])

    def test_f05_verbatim_sentence_excerpt_and_split_messages_require_inventory(self):
        case = self.bank_history()
        bank_text = case["prefix"]["messages"][1]["content"]
        excerpt = bank_text[:bank_text.index("?") + 1]
        target = fixture()
        target["decision"] = {"primary_action": "CLARIFY", "response_components": ["user_question"],
                              "question_id": None, "question_need": "Synthetic dependency probe"}
        target["target_response"] = excerpt
        with self.assertRaisesRegex(ValueError, "known question-bank usage missing"):
            a.validate_case(target)
        # A split inside a sentence must not evade detection at message borders.
        pivot = len(bank_text) // 3
        case["prefix"] = a.prepare_prefix([
            {"message_id": "u1", "role": "user", "content": "배경을 설명해야 하나요?"},
            {"message_id": "a2", "role": "assistant", "content": bank_text[:pivot]},
            {"message_id": "a3", "role": "assistant", "content": bank_text[pivot:]},
            {"message_id": "u4", "role": "user", "content": "배경은 말하지 않을게요."},
        ], "u4")
        case["annotation_provenance"]["prefix_sha256"] = a.digest(case["prefix"])
        with self.assertRaisesRegex(ValueError, "known question-bank usage missing"):
            a.validate_case(case)

    def test_f05_generic_short_expression_does_not_assert_bank_dependency(self):
        case = fixture();case["target_response"] = "어떤 관계인가요?"
        case["decision"] = {"primary_action": "CLARIFY", "response_components": ["user_question"],
                            "question_id": None, "question_need": "Synthetic ordinary clarification"}
        self.assertEqual(a.detected_question_bank_usage(case), set())
        a.validate_case(case)


if __name__ == "__main__":
    unittest.main()
