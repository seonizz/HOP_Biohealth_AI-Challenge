"""12B repair scoring cannot hide invalid outputs, false approvals or thin probes."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import event_review_curriculum as event
import review_bias_curriculum as curriculum
import local12b_repair_evaluation as evaluator


def fixture(split='validation', repeats=1):
    inputs, refs, outputs = [], [], []
    cases = [(challenge, False) for challenge in evaluator.CHALLENGES] + [('negated', True), ('certainty', True)]
    for ordinal, (challenge, reverse) in enumerate(cases * repeats):
        root = 'private-source-' + str(ordinal)
        fact = dict(person='p', attribute='meeting', value='phone', time='21',
                    negated='true' if reverse and challenge == 'negated' else 'false',
                    certainty='unknown' if reverse and challenge == 'certainty' else 'reported')
        previous = dict(fact, time='13'); other = dict(fact, person='q', time='18')
        facts = [fact, other]; events = [previous, other, fact]
        field = 'time' if challenge.endswith('_as_time') or challenge == 'stale_same_value_time' else challenge
        wrong = {'value_as_time':'phone', 'person_as_time':'p', 'none_as_time':'none', 'stale_same_value_time':'13',
                 'person':'z', 'attribute':'travel', 'value':'office', 'negated':'false' if reverse else 'true',
                 'certainty':'reported' if reverse else 'unknown'}[challenge]
        for encoding in ('pipe', 'object'):
            encoded = ['|'.join(f[k] for k in ('time','person','attribute','value','negated','certainty')) for f in events] if encoding == 'pipe' else events
            payload = dict(data=dict(event_grammar=event.GRAMMAR, events=encoded, required_current_slots=[{k:f[k] for k in ('person','attribute')} for f in facts]),
                           rules=event.STATE_RULE, output_schema=event.schema('event_state'))
            req, ref, _ = curriculum.make_record('event_state', payload, {'facts':facts}, root, split, encoding+':state')
            req['encoding'] = ref['encoding'] = encoding
            inputs.append(req); refs.append(ref)
            for normal in (True, False):
                draft = deepcopy(facts)
                if not normal: draft[0][field] = wrong
                payload = dict(data=dict(event_grammar=event.GRAMMAR, events=encoded, draft=draft), rules=event.REVIEW_RULE, output_schema=event.schema('event_review'))
                target = dict(approved=True, issues=[]) if normal else dict(approved=False, issues=[dict(index=0, field=field, actual=wrong, expected=fact[field], rule='latest_supported_tuple')])
                req, ref, _ = curriculum.make_record('event_review', payload, target, root, split, encoding+':'+str(normal), pair=root+'-pair-'+encoding, challenge=challenge)
                req.update(encoding=encoding, changed_field=field, mutation_direction=wrong+'->'+fact[field] if field in evaluator.DIRECTIONS else 'any')
                ref.update(encoding=encoding, mutation_direction=wrong+'->'+fact[field] if field in evaluator.DIRECTIONS else 'any')
                inputs.append(req); refs.append(ref)
    outputs = [dict(request_id=ref['request_id'], status='ok', finish_reason='stop', text=json.dumps(ref['target'])) for ref in refs]
    return inputs, refs, outputs


def constant(outputs, refs, approve):
    changed = deepcopy(outputs)
    issue = next(r['target'] for r in refs if r['target'].get('approved') is False)
    for row, ref in zip(changed, refs):
        if ref['task'] == 'event_review': row['text'] = json.dumps(dict(approved=True, issues=[]) if approve else issue)
    return changed


class RepairEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.inputs, self.refs, self.outputs = fixture()
        self.coverage = evaluator.make_coverage(self.inputs, self.refs)

    def score(self, outputs=None, baseline=None, split='validation', coverage=True):
        return evaluator.evaluate_rows(self.inputs, self.refs, self.outputs if outputs is None else outputs, split,
                                      baseline, self.coverage if coverage else None)

    def test_perfect_full_validation_passes_preserved_and_explicit_gates(self):
        report = self.score(baseline=self.score())
        self.assertTrue(report['paired_report']['gate']['passed'])
        self.assertTrue(report['gate']['passed']); self.assertTrue(report['checkpoint_selection_allowed'])
        self.assertEqual(report['metrics']['bad_false_approval'], dict(numerator=0, denominator=22, value=0))
        self.assertEqual(report['source_macro']['unique_source_roots'], 11)
        self.assertFalse(report['ready_for_deployment']); self.assertFalse(report['training_started'])

    def test_baseline_is_required_and_must_have_full_output_coverage(self):
        report = self.score()
        self.assertTrue(report['gate']['passed'])
        self.assertTrue(report['evaluation_complete_for_selection'])
        self.assertFalse(report['baseline_verified_for_selection'])
        self.assertFalse(report['checkpoint_selection_allowed'])
        incomplete = self.score(self.outputs[:-1])
        candidate = self.score(baseline=incomplete)
        self.assertTrue(candidate['gate']['passed'])
        self.assertFalse(candidate['baseline_verified_for_selection'])
        self.assertFalse(candidate['checkpoint_selection_allowed'])
        self.assertEqual(candidate['selection_scope'], 'event_validation_only')
        self.assertTrue(candidate['requires_separate_app_validation_gate'])
        self.assertFalse(candidate['model_selection_ready'])

    def test_equal_aggregate_errors_moving_between_direction_buckets_are_regression(self):
        inputs, refs, outputs = fixture(repeats=16)
        coverage = evaluator.make_coverage(inputs, refs)
        for kind, metric in [('false_approval', 'bad_false_approval'), ('normal_rejection', 'normal_false_rejection'),
                             ('invalid', 'invalid'), ('evidence', 'bad_issues_exact')]:
            with self.subTest(kind=kind):
                old = deepcopy(outputs); new = deepcopy(outputs); buckets = {}
                for direction in ('reported->unknown', 'unknown->reported'):
                    buckets[direction] = [i for i, ref in enumerate(refs)
                                          if ref.get('challenge') == 'certainty' and ref.get('encoding') == 'object'
                                          and ref.get('mutation_direction') == direction
                                          and ref['target'].get('approved') is (kind == 'normal_rejection')]
                    self.assertEqual(len(buckets[direction]), 16)
                for changed, direction in [(old, 'reported->unknown'), (new, 'unknown->reported')]:
                    for i in buckets[direction][:3]:
                        if kind == 'false_approval': changed[i]['text'] = '{"approved":true,"issues":[]}'
                        elif kind == 'invalid': changed[i]['text'] = '{'
                        elif kind == 'evidence':
                            value = json.loads(changed[i]['text']); value['issues'][0]['actual'] = 'fabricated'
                            changed[i]['text'] = json.dumps(value)
                        else:
                            bad = next(ref['target'] for ref in refs if ref.get('pair_id') == refs[i]['pair_id'] and not ref['target']['approved'])
                            changed[i]['text'] = json.dumps(bad)
                baseline = evaluator.evaluate_rows(inputs, refs, old, coverage=coverage)
                report = evaluator.evaluate_rows(inputs, refs, new, baseline=baseline, coverage=coverage)
                if kind != 'invalid':
                    self.assertTrue(baseline['paired_report']['gate']['passed'])
                    self.assertTrue(report['paired_report']['gate']['passed'])
                self.assertEqual(report['metrics'][metric], baseline['metrics'][metric])
                key = 'bucket/certainty|object|unknown->reported/' + metric
                self.assertIn(key, report['gate']['failed_thresholds'])
                self.assertIn(key, report['gate']['regressions'])
                self.assertFalse(report['gate']['passed'])
                self.assertFalse(report['checkpoint_selection_allowed'])

    def test_always_approve_or_reject_cannot_trade_one_polarity_for_other(self):
        for approve in (True, False):
            report = self.score(constant(self.outputs, self.refs, approve))
            self.assertFalse(report['gate']['passed']); self.assertFalse(report['checkpoint_selection_allowed'])
            self.assertEqual(report['metrics']['balanced_decision_recall']['value'], .5)
            self.assertEqual(report['metrics']['bad_false_approval' if approve else 'normal_false_rejection']['value'], 1)

    def test_missing_schema_json_length_outputs_are_invalid_not_false_approvals(self):
        idx = next(i for i,r in enumerate(self.refs) if r['target'].get('approved') is False)
        for kind in ('missing', 'json', 'schema', 'length', 'failed'):
            outputs = deepcopy(self.outputs)
            if kind == 'missing': outputs.pop(idx)
            elif kind == 'json': outputs[idx]['text'] = '{'
            elif kind == 'schema': outputs[idx]['text'] = '{"approved":true,"issues":[{}]}'
            elif kind == 'length': outputs[idx]['finish_reason'] = 'length'
            else: outputs[idx]['status'] = 'failed'
            with self.subTest(kind=kind):
                report = self.score(outputs)
                self.assertEqual(report['metrics']['bad_false_approval']['numerator'], 0)
                self.assertEqual(report['metrics']['bad_invalid'], dict(numerator=1, denominator=22, value=1/22))
                self.assertEqual(report['metrics']['bad_rejection']['numerator'], 21)
                self.assertFalse(report['gate']['passed'])

    def test_false_approval_regression_and_decision_flips_are_explicit(self):
        baseline = self.score(); outputs = deepcopy(self.outputs)
        idx = next(i for i,r in enumerate(self.refs) if r['target'].get('approved') is False)
        outputs[idx]['text'] = '{"approved":true,"issues":[]}'
        report = self.score(outputs, baseline)
        self.assertIn('bad_false_approval', report['gate']['regressions'])
        self.assertEqual(report['decision_flips']['bad/reject->approve'], 1)
        self.assertEqual(report['pair_decision_transitions']['counts']['approve/reject->approve/approve'], 1)
        self.assertEqual(report['verdict'], 'regression_detected')

    def test_partial_probe_or_omitted_root_cannot_be_selection_eligible(self):
        # Keep complete pairs in the probe; coverage must still reject a tiny cohort.
        inputs, refs, outputs = self.inputs[:7], self.refs[:7], self.outputs[:7]
        report = evaluator.evaluate_rows(inputs, refs, outputs, coverage=self.coverage)
        self.assertFalse(report['checkpoint_selection_allowed'])
        self.assertIn('frozen_source_inventory', report['coverage']['failed'])
        self.assertIn('nine_challenge_coverage', report['coverage']['failed'])
        report = self.score(coverage=False)
        self.assertFalse(report['evaluation_complete_for_selection'])
        self.assertIn('missing_frozen_coverage', report['coverage']['failed'])

    def test_test_and_diagnostic_never_select_even_when_perfect(self):
        for split in ('test', 'diagnostic'):
            inputs, refs, outputs = fixture('test'); spec = evaluator.make_coverage(inputs, refs)
            report = evaluator.evaluate_rows(inputs, refs, outputs, split=split, coverage=spec)
            self.assertTrue(report['gate']['passed'])
            self.assertFalse(report['evaluation_complete_for_selection']); self.assertFalse(report['checkpoint_selection_allowed'])

    def test_both_directions_and_both_encodings_are_required(self):
        for mode in ('direction', 'encoding'):
            selected = [i for i,r in enumerate(self.inputs) if (r['source_root_ids'] != ['private-source-9'] if mode == 'direction' else r['encoding'] != 'object')]
            values = [[v[i] for i in selected] for v in [self.inputs,self.refs,self.outputs]]
            spec = evaluator.make_coverage(*values[:2]); report = evaluator.evaluate_rows(*values, coverage=spec)
            self.assertFalse(report['gate']['passed'])
            self.assertIn('negated_both_mutation_directions' if mode == 'direction' else 'every_root_both_encodings_state_and_pair', report['coverage']['failed'])

    def test_baseline_cohort_contract_and_private_identity_are_checked(self):
        baseline = self.score()
        for field in ('schema', 'split', 'coverage_spec_sha256', 'cohort_sha256'):
            changed = deepcopy(baseline); changed[field] = 'wrong'
            with self.subTest(field=field), self.assertRaises(ValueError): self.score(baseline=changed)
        inputs = deepcopy(self.inputs); inputs[0]['messages'][0]['content'] += inputs[0]['source_root_ids'][0]
        with self.assertRaisesRegex(ValueError, 'Private evaluation identity'): evaluator.evaluate_rows(inputs,self.refs,self.outputs,coverage=self.coverage)

    def test_declared_metadata_cannot_override_actual_payload(self):
        for key, value in [('encoding','object'), ('mutation_direction','invented'), ('changed_field','certainty')]:
            inputs = deepcopy(self.inputs); inputs[1][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): evaluator.evaluate_rows(inputs,self.refs,self.outputs,coverage=self.coverage)

    def test_wrong_time_and_bad_evidence_still_fail_original_gate(self):
        outputs = deepcopy(self.outputs); value = json.loads(outputs[0]['text']); value['facts'][0]['time'] = '13'; outputs[0]['text'] = json.dumps(value)
        idx = next(i for i,r in enumerate(self.refs) if r['target'].get('approved') is False)
        value = json.loads(outputs[idx]['text']); value['issues'][0]['actual'] = 'fabricated'; outputs[idx]['text'] = json.dumps(value)
        report = self.score(outputs)
        self.assertGreater(report['metrics']['time_error']['numerator'], 0)
        self.assertFalse(report['paired_report']['gate']['passed']); self.assertFalse(report['gate']['passed'])

    def test_cli_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); paths = {}
            for name, values in [('inputs',self.inputs),('references',self.refs),('outputs',self.outputs)]:
                paths[name] = root/(name+'.jsonl');paths[name].write_text(''.join(json.dumps(v)+'\n' for v in values))
            coverage = root/'coverage.json';coverage.write_text(json.dumps(self.coverage));report = root/'report.json'
            command = [sys.executable,str(Path(evaluator.__file__)),'score','--coverage',str(coverage),'--report',str(report)]
            for name,path in paths.items(): command += ['--'+name,str(path)]
            self.assertEqual(subprocess.run(command,capture_output=True).returncode,0)
            self.assertFalse(json.loads(report.read_text())['checkpoint_selection_allowed'])
            baseline = report; report = root/'candidate.json'
            command[command.index('--report')+1] = str(report)
            command += ['--baseline-report', str(baseline)]
            self.assertEqual(subprocess.run(command,capture_output=True).returncode,0)
            self.assertTrue(json.loads(report.read_text())['checkpoint_selection_allowed'])
            self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)


if __name__ == '__main__': unittest.main()
