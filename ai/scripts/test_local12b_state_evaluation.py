"""State gates retain denominators and expose format failures without hiding time errors."""
from copy import deepcopy
import json
import unittest

import local12b_state_evaluation as evaluation
from test_local12b_repair_evaluation import fixture


class StateEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.inputs, self.refs, self.outputs = fixture()
        self.coverage = evaluation.make_coverage(self.inputs, self.refs)
        self.idx = next(i for i,r in enumerate(self.refs) if r['task']=='event_state')

    def score(self, outputs=None, baseline=None):
        return evaluation.evaluate_rows(self.inputs,self.refs,self.outputs if outputs is None else outputs,
                                        baseline=baseline,coverage=self.coverage)

    def test_gold_and_baseline_admission(self):
        baseline=self.score(); result=self.score(baseline=baseline)
        self.assertTrue(result['gate']['passed']);self.assertTrue(result['checkpoint_selection_allowed'])
        self.assertFalse(baseline['checkpoint_selection_allowed']);self.assertFalse(result['model_selection_ready'])
        self.assertEqual(len(result['flag_direction_stats']),8)
        self.assertEqual(result['state_metrics']['state_invalid_rate']['numerator'],0)
        with self.assertRaisesRegex(ValueError,'new state evaluator schema'):
            self.score(baseline=baseline['legacy_report'])

    def test_duplicate_and_wrong_time_penalize_entire_invalid_state(self):
        outputs=deepcopy(self.outputs);value=json.loads(outputs[self.idx]['text'])
        value['facts'].append(dict(value['facts'][0],time='bad'))
        outputs[self.idx]['text']=json.dumps(value)
        result=self.score(outputs,self.score())
        self.assertEqual(result['state_metrics']['duplicate_slot_rate']['numerator'],1)
        self.assertEqual(result['state_metrics']['invalid_state_time_penalty']['numerator'],2)
        self.assertEqual(result['state_metrics']['eligible_time_error']['numerator'],0)
        self.assertEqual(result['state_metrics']['eligible_time_error']['denominator'],42)
        self.assertIn('duplicate_slot_rate',result['gate']['regressions'])
        self.assertFalse(result['gate']['passed'])

    def test_valid_time_error_uses_conditional_denominator_without_repair(self):
        outputs=deepcopy(self.outputs);value=json.loads(outputs[self.idx]['text']);value['facts'][0]['time']='bad'
        outputs[self.idx]['text']=json.dumps(value);result=self.score(outputs,self.score())
        self.assertEqual(result['state_metrics']['eligible_time_error'],dict(numerator=1,denominator=44,value=1/44))
        self.assertEqual(result['state_metrics']['invalid_state_time_penalty']['numerator'],0)
        self.assertEqual(result['matched_valid_time']['after']['numerator'],1)

    def test_missing_malformed_incomplete_and_flag_types_fail_closed(self):
        for kind in ('missing','json','incomplete','bool_negated','certainty_enum'):
            outputs=deepcopy(self.outputs)
            if kind=='missing':outputs.pop(self.idx)
            elif kind=='json':outputs[self.idx]['text']='{'
            elif kind=='incomplete':outputs[self.idx]['finish_reason']='length'
            else:
                value=json.loads(outputs[self.idx]['text']);value['facts'][0]['negated' if kind=='bool_negated' else 'certainty']=True if kind=='bool_negated' else 'certain'
                outputs[self.idx]['text']=json.dumps(value)
            with self.subTest(kind=kind):
                result=self.score(outputs)
                self.assertEqual(result['state_metrics']['state_invalid_rate']['numerator'],1)
                self.assertEqual(result['state_metrics']['time_error']['denominator'],44)
                self.assertFalse(result['gate']['passed']);self.assertFalse(result['checkpoint_selection_allowed'])

    def test_each_flag_encoding_direction_is_gated(self):
        for field in ('negated','certainty'):
            for encoding in ('pipe','object'):
                for direction in evaluation.legacy.DIRECTIONS[field]:
                    outputs=deepcopy(self.outputs)
                    idx=next(i for i,r in enumerate(self.refs) if r.get('challenge')==field and r.get('encoding')==encoding and r.get('mutation_direction')==direction and r['target'].get('approved') is False)
                    outputs[idx]['text']='{"approved":true,"issues":[]}'
                    result=self.score(outputs,self.score());key=f'bucket/{field}|{encoding}|{direction}/bad_false_approval'
                    self.assertIn(key,result['gate']['regressions']);self.assertIn(key,result['gate']['failed_thresholds'])

    def test_test_and_diagnostic_cannot_select(self):
        inputs,refs,outputs=fixture('test');coverage=evaluation.make_coverage(inputs,refs)
        for split in ('test','diagnostic'):
            baseline=evaluation.evaluate_rows(inputs,refs,outputs,split=split,coverage=coverage)
            result=evaluation.evaluate_rows(inputs,refs,outputs,split=split,baseline=baseline,coverage=coverage)
            self.assertTrue(result['gate']['passed']);self.assertFalse(result['checkpoint_selection_allowed'])

    def test_baseline_cohort_and_state_inventory_cannot_drift(self):
        for kind in ('cohort','state_id','slot_count'):
            baseline=self.score()
            if kind=='cohort':baseline['cohort_sha256']='bad'
            elif kind=='state_id':baseline['state_records'][0]['request_id']='bad'
            else:baseline['state_records'][0]['gold_slots']+=1
            with self.subTest(kind=kind),self.assertRaises(ValueError):self.score(baseline=baseline)

    def test_incomplete_baseline_cannot_admit_complete_candidate(self):
        baseline=self.score(self.outputs[:-1]);result=self.score(baseline=baseline)
        self.assertFalse(result['checkpoint_selection_allowed'])

if __name__=='__main__':unittest.main()
