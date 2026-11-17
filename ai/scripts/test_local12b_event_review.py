import json
from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

import local12b_event_review as m


class Local12BTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp=tempfile.TemporaryDirectory()
        parent=Path(cls.tmp.name).resolve()/'training_data';parent.mkdir()
        cls.bundle=parent/'fixture'
        cls.proof=m.build(cls.bundle,counts=dict(train=40,validation=40,test=40))
        cls.refs=m.c.read_rows(cls.bundle/'evaluation/validation/references.jsonl')
        cls.inputs=m.c.read_rows(cls.bundle/'evaluation/validation/inputs.jsonl')
        cls.perfect=[dict(request_id=r['request_id'],status='ok',finish_reason='stop',text=m.c.canonical(r['target'])) for r in cls.refs]

    @classmethod
    def tearDownClass(cls):cls.tmp.cleanup()

    def test_balanced_pairs_and_time_modes_no_test_training(self):
        for part in self.proof['partitions'].values():
            self.assertEqual(part['counts']['normal'],80)
            self.assertEqual(part['counts']['error'],80)
            self.assertEqual([part['counts'][k] for k in m.TIME_MODES],[10]*4)
        self.assertFalse((self.bundle/'data/test.jsonl').exists())
        self.assertFalse(json.loads((self.bundle/'COURSE_PROPOSAL.json').read_text())['training_ready'])

    def test_forward_gold_and_same_value_latest_sequence(self):
        dates=set(); positions=set()
        for number in range(25):
            events,facts=m.source(29,number)
            prior,latest=m.repeated_pair(events)
            self.assertEqual(latest['value'],prior['value'])
            self.assertNotEqual(latest['time'],prior['time'])
            dates.add(latest['value']);positions.add(events.index(latest)==len(events)-1)
            self.assertEqual(facts,m.c.parse_events(dict(events=events,event_grammar=m.c.GRAMMAR)))
        self.assertGreater(len(dates),20)
        self.assertEqual(positions,{True,False})

    def test_perfect_control_passes(self):
        report=m.evaluate(self.bundle,self.perfect)
        self.assertTrue(report['gate']['passed'])
        self.assertTrue(all(v['value']==1 for v in report['time_error_strata'].values()))

    def test_always_reject_cannot_pass_with_perfect_error_recall(self):
        rows=deepcopy(self.perfect)
        issue=next(r['target'] for r in self.refs if r['target'].get('approved') is False)
        for row,ref in zip(rows,self.refs):
            if ref['target'].get('approved') is True:row['text']=m.c.canonical(issue)
        report=m.evaluate(self.bundle,rows)
        self.assertEqual(report['metrics']['bad_rejection']['value'],1)
        self.assertEqual(report['metrics']['normal_approval']['value'],0)
        self.assertFalse(report['gate']['passed'])

    def test_value_correct_time_wrong_fails(self):
        rows=deepcopy(self.perfect)
        for row,ref in zip(rows,self.refs):
            if ref['task']=='event_state':
                target=deepcopy(ref['target'])
                for fact in target['facts']:fact['time']=fact['value']
                row['text']=m.c.canonical(target)
        report=m.evaluate(self.bundle,rows)
        self.assertEqual(report['metrics']['latest_value_accuracy']['value'],1)
        self.assertEqual(report['metrics']['time_accuracy']['value'],0)
        self.assertFalse(report['gate']['passed'])

    def test_individual_time_stratum_cannot_hide_in_aggregate(self):
        rows=deepcopy(self.perfect)
        changed=False
        for row,ref in zip(rows,self.refs):
            if not changed and ref['changed_field']=='time' and ref['challenge']==m.TIME_MODES[0]:
                row['text']=m.c.canonical(dict(approved=True,issues=[]));changed=True
        report=m.evaluate(self.bundle,rows)
        self.assertGreaterEqual(report['metrics']['bad_issues_exact']['value'],.95)
        self.assertIn('time_error:'+m.TIME_MODES[0],report['gate']['failed_thresholds'])

    def test_hallucinated_actual_is_not_correct_rejection(self):
        rows=deepcopy(self.perfect)
        for row,ref in zip(rows,self.refs):
            if ref['target'].get('approved') is False:
                target=deepcopy(ref['target']);target['issues'][0]['actual']='invented';row['text']=m.c.canonical(target)
        report=m.evaluate(self.bundle,rows)
        self.assertEqual(report['metrics']['bad_rejection']['value'],1)
        self.assertEqual(report['metrics']['actual_grounding']['value'],0)
        self.assertFalse(report['gate']['passed'])

    def test_missing_truncated_fenced_outputs_stay_in_denominator(self):
        for variant in ('missing','truncated','fenced'):
            rows=deepcopy(self.perfect)
            if variant=='missing':rows=[]
            elif variant=='truncated':
                for row in rows:row['finish_reason']='length'
            else:
                for row in rows:row['text']='```json\n'+row['text']+'\n```'
            report=m.evaluate(self.bundle,rows)
            self.assertEqual(report['metrics']['schema_completion']['denominator'],240)
            self.assertEqual(report['metrics']['schema_completion']['value'],0)
            self.assertFalse(report['gate']['passed'])

    def test_reference_tampering_with_rebound_manifest_still_fails_oracle(self):
        path=self.bundle/'evaluation/validation/references.jsonl';manifest=self.bundle/'MANIFEST.json'
        old=path.read_bytes();old_manifest=manifest.read_bytes()
        try:
            refs=deepcopy(self.refs);refs[0]['target']['facts'][0]['time']='999999'
            path.write_text(''.join(m.c.canonical(r)+'\n' for r in refs))
            data=json.loads(old_manifest);data['files']=m.c.inventory(self.bundle);manifest.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError,'semantic oracle'):m.verify(self.bundle)
        finally:path.write_bytes(old);manifest.write_bytes(old_manifest)

    def test_baseline_requires_same_cohort_and_no_regression(self):
        base=m.evaluate(self.bundle,self.perfect)
        self.assertTrue(m.evaluate(self.bundle,self.perfect,baseline=base)['gate']['passed'])
        wrong=deepcopy(base);wrong['cohort_sha256']='other'
        with self.assertRaises(ValueError):m.evaluate(self.bundle,self.perfect,baseline=wrong)
        rows=deepcopy(self.perfect);rows[0]['finish_reason']='length'
        self.assertFalse(m.evaluate(self.bundle,rows,baseline=base)['gate']['passed'])


if __name__=='__main__':unittest.main()
