"""Regression checks for review-label time, role and priority boundaries."""
import json
from pathlib import Path
import unittest

import project_answer_review_cases as p
import role_dataset as d

SOURCE = Path(__file__).resolve().parents[2] / 'training_data/chat_role_expansion_20261031/source'


@unittest.skipUnless(SOURCE.exists(), 'Local ignored source corpus required')
class AnswerReviewTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = {r['case_id']: r for f in SOURCE.glob('*.jsonl') for r in d.read_rows(f)}

    def test_every_case_has_time_balanced_normal_and_error_pairs(self):
        for number, case in enumerate(self.cases.values()):
            rows = p.project(case, number)['rows']
            self.assertEqual([(r['review_metadata']['stage'], r['review_metadata']['approved']) for r in rows],
                             [(1, True), (1, False), (2, True), (2, False)])
            for r in rows:
                p.validate(case, r)

    def test_first_turn_positive_does_not_read_future(self):
        case = self.cases['chat31-001']
        before = p.row(case, 1, case['reply1'])
        altered = {**case, 'turn2': '후속 발화의 내용이 완전히 바뀌었습니다.', 'reply2': '후속 답변도 바뀌었습니다.'}
        self.assertEqual(before, p.row(altered, 1, altered['reply1']))

    def test_priority_change_does_not_claim_earlier_goal_is_false(self):
        for case in self.cases.values():
            if case['challenge'] == 'topic_change':
                candidate, code, evidence, reason, _ = p.negative_latest(case, 0)
                self.assertEqual(code, 'ignored_goal_change')
                self.assertIn('마친 다음', candidate)
                self.assertIn('이전 과제가 영원히 무효가 됐다는 뜻은 아닙니다', reason)
                self.assertEqual(evidence['turn'], 2)

    def test_scope_evidence_is_supporter_report(self):
        for identity in ('chat31-044', 'chat31-070', 'chat31-139'):
            case = self.cases[identity]
            _, code, evidence, reason, _ = p.negative_latest(case, 0)
            self.assertEqual(code, 'scope_overreach')
            self.assertIn(evidence['quote'], [f['quote'] for f in case['facts'] if f['subject'] == 'supporter'])
            self.assertNotIn('사용자가 밝힌 거절', reason)

    def test_negation_errors_change_claim_instead_of_announcing_error(self):
        for case in self.cases.values():
            if case['challenge'] == 'negation':
                candidate, code, evidence, _, _ = p.negative_latest(case, 0)
                self.assertEqual(code, 'ignored_negation')
                self.assertNotIn('반대로 이해', candidate)
                self.assertNotIn(evidence['quote'], candidate)


if __name__ == '__main__':
    unittest.main()
