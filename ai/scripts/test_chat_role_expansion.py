"""Artificial contract fixtures only; no original counseling or corpus examples."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

import chat_role_expansion as e
import native_chat_review as n
import role_dataset as d


def fixture():
    return {'case_id':'unit','split':'train','origin_type':'independent_ai_synthetic','author_id':'native-author-a',
        'domain':'family','challenge':'correction','turn1':'Actor reported a place. I can help today. I want a bounded task. Former detail was wrong.',
        'reply1':'Which time was agreed?', 'turn2':'Actor corrected the place. There is no confirmed time yet.',
        'reply2':'Use the corrected place and keep the time unconfirmed.',
        'facts':[{'subject':'patient','turn':1,'quote':'Actor reported a place.'},
                 {'subject':'supporter','turn':1,'quote':'I can help today.'},
                 {'subject':'user_goal','turn':1,'quote':'I want a bounded task.'},
                 {'subject':'patient','turn':2,'quote':'Actor corrected the place.'}],
        'unknowns':['Agreed time'], 'superseded':[{'subject':'patient','turn':1,'quote':'Former detail was wrong.'}],
        'redundant_question':{'subject':'supporter','text':'Can you help today?','reason':'The stated availability answers this.',
                              'turn':1,'quote':'I can help today.'},
        'needed_question':{'subject':'supporter','text':'How much time can you offer?','reason':'Duration has not been given.'}}


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name).resolve()
        (self.root/'source').mkdir();(self.root/'reviews').mkdir()
        d.save(self.root/'SPLITS.json',{'assignments':[{'case_id':'unit','split':'train','author':'a'}]})
        self.case=fixture();self.write_case()

    def write_case(self):
        (self.root/'source/cases.jsonl').write_text(d.canonical(self.case)+'\n')

    def test_literal_attribution_and_split_required(self):
        e.validate_case(self.case,e.assignments(self.root))
        for mutation in ('quote','subject','split'):
            case=deepcopy(self.case)
            if mutation=='quote':case['facts'][0]['quote']='invented source'
            elif mutation=='subject':case['needed_question'].pop('subject')
            else:case['split']='validation'
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):e.validate_case(case,e.assignments(self.root))

    def test_current_fact_cannot_be_superseded(self):
        self.case['superseded']=[deepcopy(self.case['facts'][0])]
        with self.assertRaisesRegex(ValueError,'Superseded'):e.validate_case(self.case,e.assignments(self.root))

    def prepare_verdict(self,control_pass=False):
        n.prepare(self.root,batch_size=10)
        binding=e.read_json(self.root/'reviews/native_bindings.json')['batch-000.json']
        sources=e.read_json(self.root/binding['input_file'])['cases'];reviews=[]
        for source in sources:
            checks=dict.fromkeys(e.CHECKS,'pass');issues=[]
            if source['id']==binding['control_id'] and not control_pass:
                field=binding['control_field'];checks[field]='fail';issues=[{'field':field,'reason':'Planted contradiction detected in this artificial fixture.'}]
            reviews.append({'id':source['id'],'verdicts':checks,'issues':issues})
        d.save(self.root/binding['output_file'],{'reviews':reviews})
        return binding

    def test_no_automatic_approval_of_missing_or_missed_control(self):
        with self.assertRaisesRegex(ValueError,'Unreviewed'):e.admitted(self.root)
        self.prepare_verdict(control_pass=True)
        with self.assertRaisesRegex(ValueError,'planted error'):n.ingest(self.root,'native-reviewer')

    def test_native_review_binds_content_and_reviewer(self):
        binding=self.prepare_verdict()
        with self.assertRaisesRegex(ValueError,'Self/invalid'):n.ingest(self.root,'native-author-a')
        self.assertEqual(n.ingest(self.root,'native-reviewer')['accepted'],1)
        self.assertEqual(len(e.admitted(self.root)),1)
        self.case['reply2']+=' Changed.';self.write_case()
        with self.assertRaisesRegex(ValueError,'Unreviewed'):e.admitted(self.root)

    def test_stored_verdict_cannot_be_rewritten(self):
        binding=self.prepare_verdict();n.ingest(self.root,'native-reviewer')
        path=self.root/binding['output_file'];path.write_text(path.read_text()+' ')
        with self.assertRaisesRegex(ValueError,'Changed verdict'):e.admitted(self.root)

    def test_blind_view_omits_author_split_and_case_id(self):
        self.assertTrue({'author_id','split','case_id'}.isdisjoint(n.view(self.case)))


if __name__=='__main__':unittest.main()
