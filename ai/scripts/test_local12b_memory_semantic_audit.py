import json
from copy import deepcopy
import unittest

import local12b_memory_semantic_audit as a


def memory_fixture():
    case=dict(facts=[dict(subject='patient',quote='current statement',turn=2)],
        superseded=[dict(subject='patient',quote='old statement',turn=1)],
        unknowns=['not yet reported'],turn1='old statement',turn2='current statement')
    claim=dict(id='patient.0',kind='reported_excerpt',claim='“current statement”',
               evidence=[dict(subject='patient',quote='current statement')])
    target=dict(state=dict(audits=[dict(id='patient.0',verdict='supported')],approved=True,issues=[]))
    payload=dict(data=dict(review_target=dict(claims=[claim],input=dict(reported_dialogue=[
        dict(turn=1,role='user',content=case['turn1']),dict(turn=2,role='user',content=case['turn2'])]))))
    row=dict(row_id='fixture',review_metadata=dict(stage=2),messages=[dict(content='system'),
        dict(content=json.dumps(payload)),dict(content=json.dumps(target))])
    return row,case


def event_fixture():
    def f(time,value):return dict(person='p',attribute='a',value=value,time=time,negated='false',certainty='reported')
    events=[f('3','old'),f('11','date value'),f('19','date value')]
    return dict(request_id='event',task='event_review',messages=[dict(content=json.dumps(
        dict(data=dict(events=events,draft=[events[-1]]))))])


class SemanticAuditTests(unittest.TestCase):
    def test_current_normal_is_approved_even_with_old_history(self):
        row,case=memory_fixture()
        self.assertTrue(a.memory_row(row,case)['independently_computed_approved'])

    def test_stale_memory_positive_target_fails(self):
        row,case=memory_fixture();p=json.loads(row['messages'][1]['content'])
        p['data']['review_target']['claims'][0].update(claim='“old statement”',evidence=[dict(subject='patient',quote='old statement')])
        row['messages'][1]['content']=json.dumps(p)
        with self.assertRaisesRegex(ValueError,'verdict mismatch'):a.memory_row(row,case)

    def test_correct_quote_wrong_role_is_unsupported(self):
        row,case=memory_fixture();p=json.loads(row['messages'][1]['content'])
        p['data']['review_target']['claims'][0]['evidence'][0]['subject']='supporter'
        row['messages'][1]['content']=json.dumps(p)
        with self.assertRaises(ValueError):a.memory_row(row,case)

    def test_candidate_invention_cannot_borrow_valid_evidence(self):
        row,case=memory_fixture();p=json.loads(row['messages'][1]['content'])
        p['data']['review_target']['claims'][0]['claim']='“invented permission”'
        row['messages'][1]['content']=json.dumps(p)
        with self.assertRaises(ValueError):a.memory_row(row,case)

    def test_event_normal_and_same_value_old_sequence(self):
        request=event_fixture()
        self.assertEqual(a.event_target(request),dict(approved=True,issues=[]))
        p=json.loads(request['messages'][0]['content']);p['data']['draft'][0]['time']='11'
        request['messages'][0]['content']=json.dumps(p)
        target=a.event_target(request)
        self.assertFalse(target['approved']);self.assertEqual(target['issues'][0]['actual'],'11')
        self.assertEqual(target['issues'][0]['expected'],'19')

    def test_event_date_value_cannot_replace_sequence(self):
        request=event_fixture();p=json.loads(request['messages'][0]['content'])
        p['data']['draft'][0]['time']='date value';request['messages'][0]['content']=json.dumps(p)
        self.assertEqual(a.event_target(request)['issues'][0]['field'],'time')

    def test_more_than_one_change_is_not_silently_accepted(self):
        request=event_fixture();p=json.loads(request['messages'][0]['content'])
        p['data']['draft'][0].update(time='11',value='invented')
        request['messages'][0]['content']=json.dumps(p)
        with self.assertRaisesRegex(ValueError,'single-field'):a.event_target(request)


if __name__=='__main__':unittest.main()
