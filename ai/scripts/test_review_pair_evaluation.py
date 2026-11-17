"""Paired evaluation must defeat constant labels, invalid outputs and tradeoffs."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import event_review_curriculum as curriculum
import review_pair_evaluation as evaluator
from test_local12b_app_review import fixture as original_app_fixture


def fixture(count=2):
    inputs, references, outputs = [], [], []
    for index in range(count):
        fact = dict(person=f'p{index}', attribute='meeting', value='phone', time='21', negated='false', certainty='reported')
        previous = dict(fact, value='office', time='13')
        other = dict(fact, person=f'q{index}', time='18')
        projections = curriculum.project([previous, other, fact], [fact, other], f'root{index}', 'validation', 'time', 3407)
        for request, ref, _ in projections[:3]:
            request['split'] = ref['split'] = 'validation'
            if request['task'] == 'event_review':
                request['pair_id'] = ref['pair_id'] = f'private-pair-{index}'
            inputs.append(request);references.append(ref)
            outputs.append(dict(request_id=request['request_id'], status='ok', finish_reason='stop', text=json.dumps(ref['target'])))
    return inputs, references, outputs


def replace_decision(outputs, references, approve):
    changed = deepcopy(outputs)
    issue = next(r['target'] for r in references if r['target'].get('approved') is False)
    for row, ref in zip(changed, references):
        if ref['task'] == 'event_review':
            row['text'] = json.dumps(dict(approved=True, issues=[]) if approve else issue)
    return changed


class EventPairsTests(unittest.TestCase):
    def test_perfect_reference_passes_both_members_and_evidence(self):
        report = evaluator.evaluate_rows(*fixture())
        self.assertTrue(report['gate']['passed'])
        self.assertEqual(report['pair_metrics']['overall']['decision_success']['value'], 1)
        self.assertEqual(report['pair_metrics']['overall']['evidence_exact']['value'], 1)
        self.assertFalse(report['gate']['deployment_approved'])

    def test_always_approve_and_reject_fail_despite_balanced_accuracy_half(self):
        inputs, refs, outputs = fixture()
        for approve in (True, False):
            with self.subTest(approve=approve):
                report = evaluator.evaluate_rows(inputs, refs, replace_decision(outputs, refs, approve))
                self.assertFalse(report['gate']['passed'])
                self.assertEqual(report['pair_metrics']['overall']['decision_success']['value'], 0)
                self.assertEqual(report['base_report']['metrics']['balanced_decision_accuracy']['value'], .5)
                self.assertTrue(report['collapse']['event_review']['complete_constant_decision'])

    def test_pair_blind_balanced_predictions_fail_without_global_label_collapse(self):
        inputs, refs, outputs = fixture()
        approved = replace_decision(outputs, refs, True)
        rejected = replace_decision(outputs, refs, False)
        outputs = [approved[i] if ref.get('pair_id') == 'private-pair-0' else rejected[i]
                   for i, ref in enumerate(refs)]
        report = evaluator.evaluate_rows(inputs, refs, outputs)
        self.assertEqual(report['base_report']['metrics']['balanced_decision_accuracy']['value'], .5)
        self.assertEqual(report['pair_metrics']['overall']['decision_success']['value'], 0)
        self.assertFalse(report['collapse']['event_review']['complete_constant_decision'])
        self.assertFalse(report['gate']['passed'])

    def test_missing_json_length_duplicate_keys_are_assigned_failures(self):
        inputs, refs, outputs = fixture()
        bad_index = next(i for i, r in enumerate(refs) if r['target'].get('approved') is False)
        for kind in ('missing', 'json', 'length', 'duplicate', 'nan'):
            changed = deepcopy(outputs)
            if kind == 'missing':
                changed.pop(bad_index)
            elif kind == 'length':
                changed[bad_index]['finish_reason'] = 'length'
            else:
                changed[bad_index]['text'] = {'json':'{', 'duplicate':'{"approved":true,"approved":false,"issues":[]}', 'nan':'{"approved":NaN,"issues":[]}'}[kind]
            with self.subTest(kind=kind):
                report = evaluator.evaluate_rows(inputs, refs, changed)
                self.assertEqual(report['pair_metrics']['overall']['decision_success'], {'numerator':1,'denominator':2,'value':.5})
                self.assertFalse(report['gate']['passed'])

    def test_false_actual_cannot_pass_exact_pair(self):
        inputs, refs, outputs = fixture()
        idx = next(i for i, r in enumerate(refs) if r['target'].get('approved') is False)
        value = json.loads(outputs[idx]['text']);value['issues'][0]['actual'] = 'invented'
        outputs[idx]['text'] = json.dumps(value)
        report = evaluator.evaluate_rows(inputs, refs, outputs)
        self.assertEqual(report['pair_metrics']['overall']['decision_success']['value'], 1)
        self.assertEqual(report['pair_metrics']['overall']['evidence_exact']['value'], .5)
        self.assertFalse(report['gate']['passed'])

    def test_wrong_time_fails_existing_state_gate(self):
        inputs, refs, outputs = fixture()
        value = json.loads(outputs[0]['text']);value['facts'][0]['time'] = '13';outputs[0]['text'] = json.dumps(value)
        report = evaluator.evaluate_rows(inputs, refs, outputs)
        self.assertIn('time_accuracy', report['gate']['failed_thresholds'])
        self.assertFalse(report['gate']['passed'])

    def test_time_challenge_failure_cannot_hide_in_passing_field_average(self):
        inputs, refs, outputs = fixture(count=20)
        negatives = [i for i,r in enumerate(refs) if r['target'].get('approved') is False]
        for i in negatives:
            refs[i]['challenge'] = 'common-time-mode'
        refs[negatives[0]]['challenge'] = 'rare-time-mode'
        baseline = evaluator.evaluate_rows(inputs, refs, outputs)
        self.assertTrue(baseline['gate']['passed'])
        outputs[negatives[0]]['text'] = json.dumps(dict(approved=True,issues=[]))
        report = evaluator.evaluate_rows(inputs, refs, outputs, baseline=baseline)
        self.assertEqual(report['base_report']['negative_field_strata']['time']['rejection']['value'], .95)
        self.assertEqual(report['pair_metrics']['overall']['decision_success']['value'], .95)
        self.assertIn('event/challenge_rare-time-mode/rejection',report['gate']['failed_thresholds'])
        self.assertIn('event/challenge_rare-time-mode/rejection',report['gate']['regressions'])
        self.assertFalse(report['gate']['passed'])

    def test_root_macro_counts_source_groups_separately_from_pairs(self):
        inputs, refs, outputs = fixture(count=2)
        for request, ref in zip(inputs,refs):
            request['source_root_ids'] = ref['source_root_ids'] = ['shared-root']
        report = evaluator.evaluate_rows(inputs, refs, outputs)
        self.assertEqual(report['root_summary'],dict(unique_source_roots=1,root_groups=1,pair_count=2,
            descriptive_only=True,macro_pair_decision_success=1,macro_pair_evidence_exact=1))

    def test_improved_normals_do_not_override_bad_rejection_regression(self):
        inputs, refs, outputs = fixture()
        baseline = evaluator.evaluate_rows(inputs, refs, replace_decision(outputs, refs, False))
        report = evaluator.evaluate_rows(inputs, refs, replace_decision(outputs, refs, True), baseline=baseline)
        self.assertGreater(report['descriptive_changes']['event/normal_approval']['delta'], 0)
        self.assertLess(report['descriptive_changes']['event/normal_false_rejection']['delta'], 0)
        self.assertIn('event/bad_rejection', report['gate']['regressions'])
        self.assertEqual(report['verdict'], 'regression_detected')
        self.assertFalse(report['gate']['passed'])

    def test_metadata_pair_sources_polarity_and_split_are_verified(self):
        for mode in ('missing_pair','different_pair','different_source','same_polarity','split','leaked'):
            inputs, refs, outputs = fixture()
            review = next(i for i, r in enumerate(refs) if r['target'].get('approved') is True)
            bad = next(i for i, r in enumerate(refs) if r['target'].get('approved') is False)
            if mode == 'missing_pair':inputs[review].pop('pair_id')
            elif mode == 'different_pair':refs[review]['pair_id'] = 'wrong'
            elif mode == 'different_source':inputs[review]['source_root_ids'] = refs[review]['source_root_ids'] = ['other-root']
            elif mode == 'same_polarity':refs[bad]['target'] = deepcopy(refs[review]['target'])
            elif mode == 'split':inputs[review]['split'] = 'test'
            elif mode == 'leaked':inputs[review]['messages'][0]['content'] += inputs[review]['pair_id']
            with self.subTest(mode=mode), self.assertRaises(ValueError):evaluator.evaluate_rows(inputs, refs, outputs)

    def test_duplicate_or_unknown_outputs_fail(self):
        inputs, refs, outputs = fixture()
        for added in (deepcopy(outputs[0]), dict(outputs[0], request_id='unknown')):
            with self.assertRaises(ValueError):evaluator.evaluate_rows(inputs, refs, outputs+[added])

    def test_baseline_version_domain_split_cohort_and_nonfinite_fail(self):
        inputs, refs, outputs = fixture();base = evaluator.evaluate_rows(inputs, refs, outputs)
        for field, value in [('schema','old'),('domain','app'),('split','test'),('cohort_sha256','other')]:
            altered = deepcopy(base);altered[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):evaluator.evaluate_rows(inputs, refs, outputs, baseline=altered)
        altered = deepcopy(base);altered['base_report']['metrics']['normal_approval']['value'] = float('nan')
        with self.assertRaises(ValueError):evaluator.evaluate_rows(inputs, refs, outputs, baseline=altered)

    def test_validation_and_exposed_diagnostic_are_distinct(self):
        inputs, refs, outputs = fixture();a=evaluator.evaluate_rows(inputs, refs, outputs)
        b=evaluator.evaluate_rows(inputs, refs, outputs,split='diagnostic')
        self.assertNotEqual(a['cohort_sha256'], b['cohort_sha256'])
        self.assertEqual(b['split'], 'diagnostic')

    def test_diagnostic_still_requires_matched_source_splits(self):
        inputs, refs, outputs = fixture()
        inputs[1]['split'] = refs[1]['split'] = 'test'
        with self.assertRaises(ValueError):
            evaluator.evaluate_rows(inputs, refs, outputs, split='diagnostic')

    def test_cli_scores_and_refuses_to_overwrite_source_or_report(self):
        with tempfile.TemporaryDirectory() as directory:
            directory = Path(directory)
            paths = [directory/name for name in ('inputs.jsonl', 'references.jsonl', 'outputs.jsonl')]
            for path, rows in zip(paths, fixture()):
                path.write_text(''.join(json.dumps(row)+'\n' for row in rows))
            report = directory/'report.json'
            command = [sys.executable, str(Path(evaluator.__file__)), 'score', '--domain', 'event']
            for name, path in zip(('inputs', 'references', 'outputs'), paths):
                command.extend(['--'+name, str(path)])
            self.assertEqual(subprocess.run(command+['--report', str(report)], capture_output=True).returncode, 0)
            self.assertTrue(json.loads(report.read_text())['gate']['passed'])
            before = paths[0].read_bytes()
            for protected in (report, paths[0]):
                self.assertNotEqual(subprocess.run(command+['--report', str(protected)], capture_output=True).returncode, 0)
            self.assertEqual(paths[0].read_bytes(), before)


class AppPairsTests(unittest.TestCase):
    def setUp(self):
        self.inputs, self.refs, self.outputs = original_app_fixture()
        for request, ref in zip(self.inputs, self.refs):
            request['pair_id'] = ref['pair_id'] = 'private-pair-' + request['task']

    def score(self, baseline=None):
        return evaluator.evaluate_rows(self.inputs, self.refs, self.outputs, domain='app', baseline=baseline)

    def test_real_app_contracts_pass_and_report_tasks_separately(self):
        report = self.score()
        self.assertTrue(report['gate']['passed'])
        self.assertEqual(set(report['pair_metrics']), {'overall', 'answer_review', 'memory_review'})
        self.assertEqual(report['pair_metrics']['overall']['evidence_exact']['value'], 1)

    def test_real_app_all_approval_fails_both_tasks(self):
        for task in evaluator.app.TASKS:
            normal = next(row['text'] for row in self.outputs if row['request_id'] == task+'True')
            next(row for row in self.outputs if row['request_id'] == task+'False')['text'] = normal
        report = self.score()
        self.assertFalse(report['gate']['passed'])
        for task in evaluator.app.TASKS:
            self.assertEqual(report['pair_metrics'][task]['decision_success']['value'], 0)
            self.assertTrue(report['collapse'][task]['complete_constant_decision'])

    def test_correct_decision_with_fabricated_quote_fails_pair_evidence(self):
        bad = next(row for row in self.outputs if row['request_id'] == 'answer_reviewFalse')
        value = json.loads(bad['text']);value['issues'][0]['evidence'][0]['quote'] = 'absent quotation'
        bad['text'] = json.dumps(value)
        report = self.score()
        self.assertEqual(report['pair_metrics']['answer_review']['decision_success']['value'], 1)
        self.assertEqual(report['pair_metrics']['answer_review']['evidence_exact']['value'], 0)
        self.assertFalse(report['gate']['passed'])

    def test_normal_gain_with_bad_regression_is_not_overall_improvement(self):
        originals = deepcopy(self.outputs)
        for task in evaluator.app.TASKS:
            bad = next(row['text'] for row in self.outputs if row['request_id'] == task+'False')
            next(row for row in self.outputs if row['request_id'] == task+'True')['text'] = bad
        baseline = self.score()
        self.outputs = originals
        for task in evaluator.app.TASKS:
            normal = next(row['text'] for row in self.outputs if row['request_id'] == task+'True')
            next(row for row in self.outputs if row['request_id'] == task+'False')['text'] = normal
        report = self.score(baseline)
        self.assertEqual(report['verdict'], 'regression_detected')
        self.assertIn('answer_review/bad_rejection', report['gate']['regressions'])
        self.assertIn('memory_review/bad_rejection', report['gate']['regressions'])


if __name__ == '__main__':unittest.main()
