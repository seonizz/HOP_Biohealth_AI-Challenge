import json
from pathlib import Path
import tempfile
import unittest
from copy import deepcopy
import controlled_auto_panel as c
import run_paired_role_evaluation as collector


class ControlledPanelTests(unittest.TestCase):
    def setUp(self):
        self.case, self.gold = c.make_case(73, 0, 0)

    def payload(self, case, slot):
        req = next(r for r in case['requests'] if r['slot'] == slot)
        return req, json.loads(req['messages'][-1]['content'])

    def test_visible_event_interpreter_matches_independent_construction_all_variants(self):
        lengths = set()
        for family in range(6):
            for variant in range(5):
                case, gold = c.make_case(73, family, variant)
                r, p = self.payload(case, 'S3')
                self.assertEqual(c.interpret_events(p['data']['events']), gold[r['request_id']]['facts'])
                lengths.add(len(gold[r['request_id']]['facts']))
        self.assertEqual(lengths, {3, 4, 5})

    def test_question_permissions_and_fixed_label_support(self):
        for variant in range(5):
            case, gold = c.make_case(73, 0, variant)
            r, p = self.payload(case, 'S1')
            self.assertEqual(c.question_oracle(p['data']), gold[r['request_id']]['labels'])
            candidates = p['data']['candidates']; labels = gold[r['request_id']]['labels']
            self.assertEqual(labels[candidates[3]['id']], 'retain')  # noSkip
            self.assertEqual(labels[candidates[2]['id']], 'retain')  # required and unknown
            self.assertEqual(labels[candidates[1]['id']], 'retain' if variant == 4 else 'not_needed')

    def test_event_order_negation_and_unknown_are_not_discarded(self):
        with self.assertRaises(ValueError): c.interpret_events(['2|a|x|yes|false|reported', '1|a|x|no|false|reported'])
        f = c.interpret_events(['1|a|x|yes|false|reported', '2|a|x|yes|true|unknown'])[0]
        self.assertEqual((f['negated'], f['certainty'], f['time']), ('true', 'unknown', '2'))

    def test_single_field_error_mutants_and_equal_value_negative_control(self):
        for family in range(6):
            for v in range(5):
                case, gold = c.make_case(73, family, v)
                _, p = self.payload(case, 'S6'); r, q = self.payload(case, 'S7')
                diffs = [(i, k) for i, (a, b) in enumerate(zip(p['data']['draft'], q['data']['draft'])) for k in c.FIELDS if a[k] != b[k]]
                m = gold[r['request_id']]['issues'][0]
                self.assertEqual(diffs, [(m['index'], m['field'])])
        with self.assertRaises(ValueError): c.inject_one([dict.fromkeys(c.FIELDS, 'same')], 0, 'person', 'same')

    def test_fact_matching_is_one_to_one_and_duplicates_are_false_positives(self):
        req, _ = self.payload(self.case, 'S3'); facts = self.gold[req['request_id']]['facts']
        self.assertEqual(c.fact_counts(facts, facts + [facts[0]]), (3, 1, 0))
        wrong = deepcopy(facts); wrong[0]['negated'] = 'true' if wrong[0]['negated'] == 'false' else 'false'
        self.assertEqual(c.fact_counts(facts, wrong), (2, 1, 1))

    def test_invalid_question_predictions_preserve_fixed_gold_units(self):
        r, _ = self.payload(self.case, 'S1'); g = self.gold[r['request_id']]
        stats = c.contributions('S1', g, None, False)
        value, counts = c.metric_value('M03', [stats['M03'], stats['M03']])
        self.assertEqual(value, 0); self.assertEqual(counts['units'], 8)
        self.assertEqual(stats['M04']['num'], 0); self.assertEqual(stats['M04']['den'], 2)
        self.assertEqual(stats['M04']['coverage'], 0)

    def test_duplicate_skip_ids_are_contract_invalid(self):
        r, _ = self.payload(self.case, 'S1'); g = self.gold[r['request_id']]
        q = next(iter(g['labels']))
        stats = c.contributions('S1', g, {'skip': [{'question_id': q, 'reason': 'already_covered'}] * 2}, True)
        self.assertEqual(stats['M03']['coverage'], 0)

    def test_failed_normal_reviews_count_as_failure_but_not_false_positive(self):
        a = c.contributions('S6', {'error_present': False}, None, False)
        self.assertEqual(a['M11']['num'], 1); self.assertEqual(a['M09']['fp'], 0)
        b = c.contributions('S7', {'error_present': True, 'issues': []}, None, False)
        self.assertEqual(b['M09']['fn'], 1); self.assertEqual(b['A10']['num'], 0)

    def test_unknown_slot_requires_identity_and_does_not_invent_value(self):
        r, _ = self.payload(self.case, 'S5'); g = self.gold[r['request_id']]
        wrong = deepcopy(g['slots']); wrong[0]['attribute'] = 'different'
        self.assertEqual(c.contributions('S5', g, {'slots': wrong}, True)['A08']['coverage'], 0)
        invented = deepcopy(g['slots']); invented[0].update(status='known', value='made_up')
        self.assertEqual(c.contributions('S5', g, {'slots': invented}, True)['A08']['num'], 1)
        self.assertEqual(c.contributions('S5', g, {'slots': g['slots']}, True)['A08']['num'], 0)

    def test_policy_is_public_nonclinical_and_abstention_not_probability(self):
        self.assertEqual(c.policy_oracle({'time_scope': 'current', 'current_action_signal': 'yes'}), 'positive')
        self.assertEqual(c.policy_oracle({'time_scope': 'past', 'current_action_signal': 'yes'}), 'negative')
        self.assertEqual(c.policy_oracle({'time_scope': 'unknown', 'current_action_signal': 'yes'}), 'abstain')
        stats = c.contributions('S8', {'label': 'negative'}, {'label': 'abstain'}, True)
        self.assertEqual(stats['M13']['num'], 0)

    def test_allowed_reconfirmation_is_not_unnecessary_repeat(self):
        case, gold = c.make_case(73, 0, 3); r, _ = self.payload(case, 'S2'); g = gold[r['request_id']]
        candidate = next(v for v in g['candidates'] if v['allow_reconfirmation'])
        self.assertEqual(c.contributions('S2', g, {'question_id': candidate['id']}, True)['M05']['num'], 0)

    def test_panel_freezes_30_cases_240_requests_separate_gold_and_no_id_hints(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / 'panel'; manifest = c.build(root)
            suite, assignments = collector.load_suite(root)
            self.assertEqual(len(suite['cases']), 30); self.assertEqual(len(assignments), 480)
            self.assertEqual(manifest['root_lineage_count'], 6)
            self.assertEqual(manifest['question_label_support'].keys(), set(c.LABELS))
            self.assertEqual(manifest['policy_label_support'], {'positive': 10, 'negative': 10, 'abstain': 10})
            self.assertTrue((root / 'inference/INPUTS.jsonl').is_file()); self.assertTrue((root / 'gold/REFERENCES.jsonl').is_file())
            for a in assignments:
                text = a['request']['messages'][-1]['content']
                self.assertNotIn(a['case_id'], text); self.assertNotIn(a['request_id'], text)
                self.assertNotIn('gold_by_request', text); self.assertNotIn('error_present', text)
                self.assertNotIn('root_lineage_id', text)
            with self.assertRaises(FileExistsError): c.build(root)

    def test_historical_old_value_does_not_replace_latest_current_fact(self):
        f = c.interpret_events(['1|a|meeting|old|false|reported', '2|a|meeting|new|false|reported'])
        self.assertEqual(len(f), 1); self.assertEqual(f[0]['value'], 'new')
        stats = c.contributions('S4', {'facts': f}, {'facts': [dict(f[0], value='old')]}, True)
        self.assertEqual(stats['M07']['num'], 0)


    def make_ideal_run(self, root):
        panel = root / 'panel'; c.build(panel); suite, assignments = collector.load_suite(panel)
        run = root / 'run'; run.mkdir()
        gold = {k: v for ref in c.read_rows(panel / 'REFERENCES.jsonl') for k, v in ref['gold_by_request'].items()}
        outputs, judgments = [], []
        for a in assignments:
            g = gold[a['request_id']]; slot = g['slot']
            if slot == 'S1': value = {'skip': [{'question_id': q, 'reason': label} for q, label in g['labels'].items() if label != 'retain']}
            elif slot == 'S2': value = {'question_id': g['selected']}
            elif slot in ('S3', 'S4'): value = {'facts': g['facts']}
            elif slot == 'S5': value = {'slots': g['slots']}
            elif slot in ('S6', 'S7'): value = {'approved': not g['error_present'], 'issues': g['issues']}
            else: value = {'label': g['label']}
            outputs.append(dict(a, text=c.canonical(value), execution_status='output_received', response_sha256='a' * 64))
            judgments.append(dict(a, schema_valid=True, execution_status='output_received'))
        for name, values in [('assignments.jsonl', assignments), ('outputs.jsonl', outputs)]:
            (run / name).write_text(''.join(c.canonical(v) + '\n' for v in values))
        (run / 'format-metrics.json').write_text(json.dumps({'judgments': judgments}))
        (run / 'metadata.json').write_text(json.dumps({'suite_sha256': c.digest(suite), 'suite_file_sha256': {name: c.hashlib.sha256((panel / name).read_bytes()).hexdigest() for name in ('SUITE.json', 'INPUTS.jsonl', 'REFERENCES.jsonl')}}))
        return panel, run, outputs, judgments

    def test_complete_scoring_and_recalculation_are_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel, run, _, _ = self.make_ideal_run(Path(tmp))
            result = c.score(panel, run)
            before = (run / 'controlled-metrics.json').read_bytes()
            c.score(panel, run)
            self.assertEqual(before, (run / 'controlled-metrics.json').read_bytes())
            self.assertEqual(len(result['verdicts']), 480)
            for metric in result['metrics']:
                expected = 0 if metric['metric_id'] in ('M04', 'M05', 'M11', 'A08') else 1
                self.assertEqual(metric['value'], expected)
                self.assertEqual(metric['status'], 'measured')
            self.assertTrue(all(row['ci95'] == [0, 0] for row in result['comparisons']))

    def test_missing_output_keeps_formal_value_null_and_ledger_fixed(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel, run, outputs, judgments = self.make_ideal_run(Path(tmp))
            removed = outputs.pop(0)
            (run / 'outputs.jsonl').write_text(''.join(c.canonical(v) + '\n' for v in outputs))
            judgments[0].update(schema_valid=None, execution_status='missing_execution_evidence')
            (run / 'format-metrics.json').write_text(json.dumps({'judgments': judgments}))
            result = c.score(panel, run)
            for metric in result['metrics']:
                if metric['arm'] == removed['arm'] and metric['metric_id'] in ('M03', 'M04'):
                    self.assertIsNone(metric['value']); self.assertEqual(metric['status'], 'incomplete')
                    self.assertEqual(metric['not_run_or_missing_execution_evidence'], 1)
            self.assertEqual(len(c.read_rows(run / 'assignments.jsonl')), 480)

    def test_tampered_run_suite_binding_stops_scoring(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel, run, _, _ = self.make_ideal_run(Path(tmp))
            (run / 'metadata.json').write_text(json.dumps({'suite_sha256': '0' * 64}))
            with self.assertRaisesRegex(ValueError, 'suite differs'): c.score(panel, run)


    def test_conditional_comparisons_use_common_observed_slots(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel, run, outputs, judgments = self.make_ideal_run(Path(tmp))
            inputs = c.read_rows(panel / 'INPUTS.jsonl')
            for slot in ('S2', 'S5'):
                request = next(r for r in inputs[0]['requests'] if r['slot'] == slot)
                request_id = request['request_id']
                baseline = next(r for r in outputs if r['arm'] == 'baseline' and r['request_id'] == request_id)
                baseline.update(execution_status='failed', text=None)
                verdict = next(r for r in judgments if r['arm'] == 'baseline' and r['request_id'] == request_id)
                verdict.update(execution_status='failed', schema_valid=False)
                trained = next(r for r in outputs if r['arm'] == 'trained' and r['request_id'] == request_id)
                data = json.loads(request['messages'][-1]['content'])['data']
                if slot == 'S2': value = {'question_id': data['candidates'][0]['id']}
                else:
                    value = {'slots': deepcopy(data['initial_slots'])}
                    value['slots'][0].update(status='known', value='unsupported')
                trained['text'] = c.canonical(value)
            (run / 'outputs.jsonl').write_text(''.join(c.canonical(v) + '\n' for v in outputs))
            (run / 'format-metrics.json').write_text(json.dumps({'judgments': judgments}))
            result = c.score(panel, run)
            for metric in ('M05', 'A08'):
                comparison = next(row for row in result['comparisons'] if row['metric_id'] == metric)
                self.assertEqual(comparison['trained_observed_rate'], 1 / 30)
                self.assertEqual(comparison['difference'], 0)
                self.assertEqual(comparison['common_fully_observed_slot_count'], 29)
                self.assertEqual(comparison['comparison_scope'], 'common_fully_observed_slots')


    def test_independent_visible_selection_and_gold_roundtrip(self):
        case, _ = c.make_case(73, 3, 4)
        request, payload = self.payload(case, 'S2')
        data = payload['data']
        self.assertEqual(c.selection_oracle(data), data['candidates'][1]['id'])
        # An explicitly allowed reconfirmation remains valid after resolving the
        # previously missing target; this does not assert its priority earlier.
        data['events'].append(c.event_line(7, data['candidates'][1]['person'], data['candidates'][1]['target'], 'yes'))
        data['candidates'][0]['allow_reconfirmation'] = True
        self.assertEqual(c.selection_oracle(data), data['candidates'][0]['id'])
        data['candidates'][0]['allow_reconfirmation'] = False
        self.assertIsNone(c.selection_oracle(data))
        with tempfile.TemporaryDirectory() as tmp:
            panel = Path(tmp) / 'panel'; c.build(panel)
            self.assertEqual(c.verify_visible_oracles(panel), 240)

    def test_assignment_and_judgment_inventory_cannot_shrink(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel, run, _, judgments = self.make_ideal_run(Path(tmp))
            assignments = c.read_rows(run / 'assignments.jsonl')
            (run / 'assignments.jsonl').write_text(''.join(c.canonical(a) + '\n' for a in assignments[:-1]))
            with self.assertRaisesRegex(ValueError, 'Assignment ledger'): c.score(panel, run)
            (run / 'assignments.jsonl').write_text(''.join(c.canonical(a) + '\n' for a in assignments))
            (run / 'format-metrics.json').write_text(json.dumps({'judgments': judgments[:-1]}))
            with self.assertRaisesRegex(ValueError, 'Missing schema judgments'): c.score(panel, run)
            (run / 'format-metrics.json').write_text(json.dumps({'judgments': judgments + [judgments[0]]}))
            with self.assertRaisesRegex(ValueError, 'duplicate schema judgment'): c.score(panel, run)

    def test_completed_judgment_without_output_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel, run, outputs, _ = self.make_ideal_run(Path(tmp))
            (run / 'outputs.jsonl').write_text(''.join(c.canonical(o) + '\n' for o in outputs[1:]))
            with self.assertRaisesRegex(ValueError, 'no matching model output'): c.score(panel, run)

    def test_extra_and_duplicate_outputs_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel, run, outputs, _ = self.make_ideal_run(Path(tmp))
            extra = dict(outputs[0], request_id='unassigned')
            for bad in (outputs + [outputs[0]], outputs + [extra]):
                (run / 'outputs.jsonl').write_text(''.join(c.canonical(o) + '\n' for o in bad))
                with self.assertRaisesRegex(ValueError, 'duplicate model output'): c.score(panel, run)

    def test_review_explanation_contradiction_is_separate_from_decision_f1(self):
        with tempfile.TemporaryDirectory() as tmp:
            panel, run, outputs, _ = self.make_ideal_run(Path(tmp))
            request = next(r for r in c.read_rows(panel / 'INPUTS.jsonl')[0]['requests'] if r['slot'] == 'S7')
            changed = next(o for o in outputs if o['arm'] == 'trained' and o['request_id'] == request['request_id'])
            changed['text'] = c.canonical({'approved': False, 'issues': []})
            (run / 'outputs.jsonl').write_text(''.join(c.canonical(o) + '\n' for o in outputs))
            result = c.score(panel, run)
            metric = next(m for m in result['metrics'] if m['arm'] == 'trained' and m['metric_id'] == 'M09')
            self.assertEqual(metric['value'], 1)
            verdict = next(v for v in result['verdicts'] if v['arm'] == 'trained' and v['request_id'] == request['request_id'])
            self.assertFalse(verdict['review_decision_issue_consistency']['consistent'])
            self.assertEqual(verdict['metrics']['A10']['num'], 0)


    def test_equal_value_person_swap_is_a_semantic_negative_control(self):
        data = {'events': ['1|a|available|yes|false|reported', '1|b|available|yes|false|reported']}
        facts = c.interpret_events(data['events'])
        draft = deepcopy(facts)
        draft[0]['person'], draft[1]['person'] = draft[1]['person'], draft[0]['person']
        self.assertEqual(c.fact_counts(facts, draft), (2, 0, 0))
        self.assertEqual(c.review_oracle(dict(data, draft=draft)), {'error_present': False, 'issues': []})
        # A speaker change with a differing value does alter the supported set.
        data['events'][1] = '1|b|available|no|false|reported'
        facts = c.interpret_events(data['events'])
        draft = deepcopy(facts); draft[0]['person'] = 'b'
        self.assertTrue(c.review_oracle(dict(data, draft=draft))['error_present'])


if __name__ == '__main__': unittest.main()
