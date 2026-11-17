"""Regression tests for refusal collapse, time errors, and fixed-denominator gates."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest

import evaluate_event_review as e


def fact(person, attribute, value, time):
    return dict(person=person, attribute=attribute, value=value, time=time,
                negated='false', certainty='reported')


def fixture():
    # The draft intentionally reverses the canonical person/attribute order.
    current = [fact('a', 'meeting', '목요일', '7'), fact('b', 'place', '도서관', '11')]
    draft = list(reversed(deepcopy(current)))
    bad = deepcopy(draft)
    bad[1]['value'] = '화요일'
    string = {'type': 'string', 'minLength': 1}
    fact_schema = {'type': 'object', 'properties': {k:string for k in e.FIELDS},
                   'required': list(e.FIELDS), 'additionalProperties': False}
    issue_schema = {'type': 'object', 'properties': {
        'index': {'type': 'integer', 'minimum': 0}, 'field': {'type':'string','enum':list(e.FIELDS)},
        'actual':string, 'expected':string, 'rule':{'type':'string','enum':['latest_supported_tuple']}},
        'required':list(e.ISSUE_FIELDS), 'additionalProperties':False}
    schemas = {
        'event_state': {'type':'object','properties':{'facts':{'type':'array','items':fact_schema}},
                        'required':['facts'],'additionalProperties':False},
        'event_review': {'type':'object','properties':{'approved':{'type':'boolean'},
                         'issues':{'type':'array','items':issue_schema}},
                         'required':['approved','issues'],'additionalProperties':False},
    }
    events = ['1|a|meeting|화요일|false|reported', '7|a|meeting|목요일|false|reported',
              '11|b|place|도서관|false|reported']
    cases = [('state','event_state',None,{'facts':current}),
             ('normal','event_review',draft,{'approved':True,'issues':[]}),
             ('bad','event_review',bad,{'approved':False,'issues':[
                 {'index':1,'field':'value','expected':'목요일','actual':'화요일','rule':'latest_supported_tuple'}]})]
    inputs, references, outputs = [], [], []
    for identity, task, candidate, target in cases:
        data = {'events':events,'event_grammar':'time|person|attribute|value|negated|certainty'}
        if candidate is not None:
            data['draft'] = candidate
        inputs.append({'request_id':identity,'task':task,'source_root_ids':['fixture'],
                       'messages':[{'role':'system','content':'Return JSON.'}, {'role':'user',
                           'content':json.dumps({'data':data,'output_schema':schemas[task]})}]})
        references.append({'request_id':identity,'task':task,'target':target,
                           'changed_field':'value' if identity=='bad' else None,'source_root_ids':['fixture']})
        outputs.append({'request_id':identity,'status':'ok','finish_reason':'stop','text':json.dumps(target)})
    return inputs, references, outputs


class EventEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.inputs, self.gold, self.outputs = fixture()

    def score(self, **kwargs):
        return e.score_rows(self.inputs, self.gold, self.outputs, **kwargs)

    def mutate(self, identity, mutation):
        row = next(r for r in self.outputs if r['request_id']==identity)
        value = json.loads(row['text'])
        mutation(value)
        row['text'] = json.dumps(value)

    def test_perfect_gold_passes_all_gates_with_shuffled_draft(self):
        result = self.score()
        self.assertTrue(result['gate']['passed'])
        for name in e.DEFAULT_THRESHOLDS:
            self.assertEqual(result['metrics'][name]['value'], 1)
        self.assertEqual(result['metrics']['actual_grounding']['value'],1)
        self.assertEqual(result['metrics']['expected_grounding']['value'],1)
        self.assertEqual(result['negative_field_strata']['value']['issues_exact']['value'],1)

    def test_always_reject_cannot_pass_even_with_perfect_bad_recall(self):
        bad_target = deepcopy(self.gold[2]['target'])
        self.outputs[1]['text'] = json.dumps(bad_target)
        result = self.score()
        self.assertEqual(result['metrics']['bad_rejection']['value'],1)
        self.assertEqual(result['metrics']['normal_false_rejection']['value'],1)
        self.assertEqual(result['metrics']['balanced_decision_accuracy']['value'],.5)
        self.assertIn('normal_approval',result['gate']['failed_thresholds'])

    def test_hallucinated_actual_does_not_count_as_exact_review(self):
        self.mutate('bad',lambda v:v['issues'][0].update(actual='金曜日'))
        result = self.score()
        self.assertEqual(result['metrics']['bad_rejection']['value'],1)
        self.assertEqual(result['metrics']['bad_issues_exact']['value'],0)
        self.assertEqual(result['metrics']['actual_grounding']['value'],0)

    def test_expected_must_match_reference_and_actual_must_match_draft_index(self):
        self.mutate('bad',lambda v:v['issues'][0].update(index=0,expected='図書館'))
        result = self.score()
        self.assertEqual(result['metrics']['actual_grounding']['value'],0)
        self.assertEqual(result['metrics']['expected_grounding']['value'],0)
        self.assertEqual(result['metrics']['predicted_issue_actual_grounding']['value'],0)

    def test_same_actual_and_expected_is_reported_and_not_exact(self):
        self.mutate('bad',lambda v:v['issues'][0].update(expected='화요일'))
        result = self.score()
        self.assertEqual(result['counts']['equal_actual_expected_issues'],1)
        self.assertEqual(result['metrics']['bad_issues_exact']['value'],0)

    def test_wrong_time_cannot_hide_behind_correct_latest_value(self):
        self.mutate('state',lambda v:v['facts'][0].update(time='a'))
        result = self.score()
        self.assertEqual(result['metrics']['latest_value_accuracy']['value'],1)
        self.assertEqual(result['metrics']['time_accuracy']['value'],.5)
        self.assertEqual(result['metrics']['fact_exact']['value'],0)
        self.assertIn('time_accuracy', result['gate']['failed_thresholds'])

    def test_fact_order_is_irrelevant_but_missing_slots_keep_denominator(self):
        self.mutate('state',lambda v:v['facts'].reverse())
        self.assertEqual(self.score()['metrics']['fact_exact']['value'],1)
        self.mutate('state',lambda v:v['facts'].pop())
        result = self.score()
        self.assertEqual(result['metrics']['time_accuracy']['denominator'],2)
        self.assertEqual(result['metrics']['time_accuracy']['value'],.5)

    def test_duplicate_fact_slot_and_duplicate_issue_are_invalid(self):
        self.mutate('state',lambda v:v['facts'].append(deepcopy(v['facts'][0])))
        self.mutate('bad',lambda v:v['issues'].append(deepcopy(v['issues'][0])))
        result = self.score()
        self.assertEqual(result['counts']['invalid_schema'],2)
        self.assertEqual(result['metrics']['time_accuracy']['value'],0)
        self.assertEqual(result['metrics']['bad_issues_exact']['value'],0)

    def test_unknown_and_duplicate_output_identity_fail_closed(self):
        self.outputs.append(deepcopy(self.outputs[0]))
        with self.assertRaisesRegex(ValueError,'Duplicate'):
            self.score()
        self.outputs[-1]['request_id']='unknown'
        with self.assertRaisesRegex(ValueError,'Unknown'):
            self.score()

    def test_missing_error_and_length_keep_all_assigned_denominators(self):
        self.outputs.pop(1)
        self.outputs[0]['finish_reason']='length'
        self.outputs[1]['status']='error'
        result = self.score()
        self.assertEqual(result['metrics']['schema_completion'],e.metric(0,3))
        self.assertEqual(result['metrics']['normal_invalid'],e.metric(1,1))
        self.assertEqual(result['metrics']['bad_rejection'],e.metric(0,1))
        self.assertEqual(result['metrics']['time_accuracy'],e.metric(0,2))

    def test_extra_keys_bool_index_and_inconsistent_approval_fail(self):
        for identity, mutation in [('normal',lambda v:v.update(extra='x')),
                                   ('bad',lambda v:v['issues'][0].update(index=True)),
                                   ('bad',lambda v:v.update(approved=True)),
                                   ('normal',lambda v:v.update(approved=False))]:
            with self.subTest(identity=identity,mutation=mutation):
                self.inputs,self.gold,self.outputs=fixture()
                self.mutate(identity,mutation)
                self.assertEqual(self.score()['counts']['invalid_schema'],1)

    def test_fences_duplicate_json_keys_and_nonfinite_json_are_not_repaired(self):
        for text in ['```json\n{"approved":true,"issues":[]}\n```',
                     '{"approved":false,"approved":true,"issues":[]}',
                     '{"approved":true,"issues":[],"x":NaN}']:
            with self.subTest(text=text):
                self.outputs[1]['text']=text
                result=self.score()
                self.assertEqual(result['metrics']['normal_approval']['value'],0)
                self.assertEqual(result['counts']['invalid_json'],1)

    def test_unknown_schema_rules_fail_closed_instead_of_ignoring(self):
        payload=json.loads(self.inputs[0]['messages'][-1]['content'])
        payload['output_schema']['unsupported']=True
        self.inputs[0]['messages'][-1]['content']=json.dumps(payload)
        with self.assertRaisesRegex(ValueError,'Unsupported'):
            self.score()

    def test_baseline_regression_blocks_even_if_absolute_threshold_allows_it(self):
        baseline=self.score()
        self.mutate('state',lambda v:v['facts'][0].update(time='a'))
        result=self.score(baseline=baseline,thresholds={'fact_exact':0,'time_accuracy':0})
        self.assertEqual(result['gate']['failed_thresholds'],[])
        self.assertEqual(set(result['gate']['regressions']),{'fact_exact','time_accuracy'})
        self.assertFalse(result['gate']['passed'])

    def test_baseline_cannot_compare_different_cohort_or_split(self):
        baseline=self.score()
        self.inputs[0]['source_root_ids']=['different']
        with self.assertRaisesRegex(ValueError,'frozen cohort'):
            self.score(baseline=baseline)
        self.inputs,self.gold,self.outputs=fixture()
        with self.assertRaisesRegex(ValueError,'frozen cohort'):
            self.score(baseline=baseline,split='test')

    def test_empty_label_support_never_vacuously_passes(self):
        self.inputs=self.inputs[:1];self.gold=self.gold[:1];self.outputs=self.outputs[:1]
        result=self.score()
        self.assertIsNone(result['metrics']['normal_approval']['value'])
        self.assertIn('normal_approval',result['gate']['failed_thresholds'])

    def test_output_order_does_not_change_frozen_comparison_identity(self):
        baseline=self.score()
        self.inputs.reverse();self.gold.reverse();self.outputs.reverse()
        result=self.score(baseline=baseline)
        self.assertTrue(result['gate']['passed'])
        self.assertEqual(result['outputs_sha256'],baseline['outputs_sha256'])

    def test_generated_bundle_verification_and_both_encodings_integrate(self):
        import event_review_curriculum as curriculum
        with tempfile.TemporaryDirectory(prefix='event-evaluation-test-') as temporary:
            root=Path(temporary).resolve()
            (root/'training_data').mkdir()
            bundle=root/'training_data'/'bundle'
            curriculum.build(bundle,dict(train=6,validation=6,test=6))
            references=e.read_rows(bundle/'evaluation/validation/references.jsonl')
            outputs=[dict(request_id=r['request_id'],status='ok',finish_reason='stop',
                          text=json.dumps(r['target'])) for r in references]
            path=root/'outputs.jsonl'
            path.write_text(''.join(json.dumps(r)+'\n' for r in outputs))
            result=e.evaluate(bundle,path)
            self.assertTrue(result['gate']['passed'])
            self.assertEqual(result['counts']['assigned'],36)
            self.assertTrue(all(s['assigned']==2 for s in result['negative_field_strata'].values()))


if __name__=='__main__':
    unittest.main()
