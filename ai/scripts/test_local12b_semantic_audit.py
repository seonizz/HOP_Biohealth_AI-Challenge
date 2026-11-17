from copy import deepcopy
import hashlib
import json
from pathlib import Path
import unittest

import local12b_semantic_audit as audit


class AnswerSemanticAuditTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle=Path(__file__).resolve().parents[2]/'training_data/gemma4_12b_app_review_supplement_20261112_v2'
        cls.rows,cls.cases=audit.load(cls.bundle)

    def row(self,case,stage=2,error=None):
        return deepcopy(next(r for r in self.rows if r['source_root_ids'][0].endswith(':'+case)
            and r['review_metadata']['stage']==stage and (r['review_metadata']['error_type']!='none' if error is None else r['review_metadata']['error_type']==error)))

    def bind_target(self,row,target):
        row['messages'][-1]['content']=audit.canonical(target)
        row['target_sha256']=hashlib.sha256(row['messages'][-1]['content'].encode()).hexdigest()

    def test_all800_pass_with_only_two_reviewed_repairs(self):
        report=audit.audit(self.bundle)
        self.assertEqual(report['status'],'passed');self.assertEqual(report['mechanically_checked_rows'],800)
        self.assertEqual(len(report['patches']),2);self.assertEqual(len(report['planned_independent_sample_rows']),268)

    def test_repairs_are_idempotent_and_keep_negative_label_excerpt_bound(self):
        for case in ('chat31-042','chat31-182'):
            original=self.row(case);fixed=audit.repair(original)
            self.assertNotEqual(original,fixed);self.assertEqual(audit.repair(fixed),fixed)
            target=json.loads(fixed['messages'][-1]['content']);payload=json.loads(fixed['messages'][1]['content'])
            self.assertFalse(target['approved']);self.assertEqual(target['issues'][0]['excerpt'],payload['data']['candidate_reply'])
            self.assertEqual(fixed['split'],original['split']);self.assertEqual(fixed['row_id'],original['row_id'])
            audit.inspect(fixed,self.cases[case])

    def test_unreviewed_repair_source_change_is_rejected(self):
        row=self.row('chat31-042');payload=json.loads(row['messages'][1]['content'])
        payload['data']['candidate_reply']='새로운 후보 문장';row['messages'][1]['content']=audit.canonical(payload)
        with self.assertRaisesRegex(ValueError,'no longer matches'):audit.repair(row)

    def test_fabricated_and_future_evidence_are_rejected(self):
        for evidence in ({'turn':1,'quote':'없는 인용'}, {'turn':2,'quote':self.cases['chat31-001']['turn2']}):
            row=self.row('chat31-001',stage=1);target=json.loads(row['messages'][-1]['content']);target['issues'][0]['evidence']=[evidence];self.bind_target(row,target)
            with self.assertRaisesRegex(ValueError,'evidence'):audit.inspect(row,self.cases['chat31-001'])

    def test_stale_target_must_refer_to_actual_prior_fact(self):
        row=self.row('chat31-001');payload=json.loads(row['messages'][1]['content']);target=json.loads(row['messages'][-1]['content'])
        payload['data']['candidate_reply']='현재 사실을 바르게 정리했어요.';target['issues'][0]['excerpt']=payload['data']['candidate_reply']
        row['messages'][1]['content']=audit.canonical(payload);self.bind_target(row,target)
        with self.assertRaisesRegex(ValueError,'not superseded'):audit.inspect(row,self.cases['chat31-001'])

    def test_normal_false_rejection_label_is_detected(self):
        row=self.row('chat31-001',error='none');target=json.loads(row['messages'][-1]['content']);target['approved']=False;self.bind_target(row,target)
        with self.assertRaisesRegex(ValueError,'Approval'):audit.inspect(row,self.cases['chat31-001'])

    def test_stage1_cannot_include_future_conversation(self):
        row=self.row('chat31-001',stage=1);payload=json.loads(row['messages'][1]['content'])
        payload['data']['conversation'].append(dict(role='user',content=self.cases['chat31-001']['turn2']))
        row['messages'][1]['content']=audit.canonical(payload)
        with self.assertRaisesRegex(ValueError,'Future'):audit.inspect(row,self.cases['chat31-001'])

    def test_sample_includes_all_correction_and_negation_faults(self):
        selected=audit.select_review_cases(self.rows,self.cases)
        critical=[r for r in self.rows if r['review_metadata']['error_type'] in ('stale_information','ignored_negation')]
        self.assertEqual(len(critical),40)
        self.assertTrue(all(r['source_root_ids'][0].split(':')[-1] in selected for r in critical))


if __name__=='__main__':unittest.main()
