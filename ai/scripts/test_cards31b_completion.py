"""Synthetic CPU-only end-to-end journals; no model or training data."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import cards31b_completion as bridge
import training_stop as stop
import train_cards_31b as runner
from test_training_stop import role_fixture


class CompletionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.work = self.root / 'run'
        self.work.mkdir()
        (self.work / 'checkpoints').mkdir()
        (self.work / 'role-evaluations').mkdir()
        self.index = {'train': {'t1': {}, 't2': {}}, 'validation': {
            'v1': {'target_length': 3, 'weight': {'numerator': 1, 'denominator': 1}},
            'v2': {'target_length': 17, 'weight': {'numerator': 1, 'denominator': 1}}}}

    def write(self, path, value):
        path.write_text(stop.canonical(value) + '\n')

    def jsonl(self, path, rows):
        path.write_text(''.join(stop.canonical(r) + '\n' for r in rows))

    def reference(self, name, value):
        path = self.root / name
        self.write(path, value)
        return {'path': name, 'sha256': stop.file_hash(path)}

    def prepare(self, final_losses=(.8,), cap=5, baseline_change=None):
        self.policy = stop.read_json(Path(__file__).with_name('training_stop_defaults.json'))
        self.suite, self.evidence = role_fixture(self.policy, 'cards_31b')
        self.suite_hash = stop.fingerprint(self.suite)
        model = self.policy['models']['cards_31b']
        model['binding'] = {'course_sha256': 'a' * 64, 'manifest_sha256': 'b' * 64}
        model['role_evaluation_binding'] = {'development_suite_sha256': self.suite_hash,
                                          'test_suite_sha256': 'c' * 64, 'evaluation_manifest_sha256': 'd' * 64}
        model['phases'][-1]['safety_max_epochs'] = cap
        self.evidence['policy_sha256'] = stop.fingerprint(self.policy)
        baseline = {'baseline_checkpoint_sha256': self.evidence['baseline_checkpoint_sha256'],
                    'cases': [{k: r[k] for k in ('case_id', 'input_sha256', 'baseline')} for r in self.evidence['cases']]}
        if baseline_change:
            baseline_change(baseline)
        config = {'schema': bridge.SCHEMA, 'run_id': 'synthetic-bridge',
                  'policy': self.reference('policy.json', self.policy),
                  'suite': self.reference('suite.json', self.suite),
                  'baseline': self.reference('baseline.json', baseline)}
        path = self.root / 'completion.json'
        self.write(path, config)
        with patch.object(stop, 'bound_indexes', return_value=({}, self.index)), \
             patch.object(stop, 'bound_train_lineage', return_value={'training-only'}):
            self.gate = bridge.CompletionGate(path, self.root)
        self.binding = {'completion': self.gate.binding(), 'compute_profile': 'reference',
                        'course_sha256': 'a' * 64, 'dataset_manifest_sha256': 'b' * 64}
        state = {'accepted': bridge.PHASES[:-1], 'phases': {}}
        initial = baseline['baseline_checkpoint_sha256']
        for position, pid in enumerate(bridge.PHASES):
            losses = list(final_losses) if position == 2 else [.8]
            record = {'baseline': 1., 'losses': losses, 'epoch_checkpoints': [],
                      'decision': 'stop_pending_evaluation' if position == 2 else 'stop_phase_accepted'}
            for epoch, loss in enumerate([1., *losses]):
                identity = initial if epoch == 0 else f'{position * 100 + epoch:064x}'
                folder = self.work / 'checkpoints' / f'{pid}-e{epoch:03d}'
                folder.mkdir()
                (folder / 'adapter_model.safetensors').write_bytes(identity.encode())
                (folder / 'training_state.pt').write_bytes(b'synthetic optimizer fixture, not model tensors')
                self.write(folder / 'adapter_config.json', {'peft_type': 'LORA'})
                manifest = {'binding': self.binding, 'adapter_sha256': identity,
                            'progress': {'phase': pid, 'epoch': epoch, 'step': position * 10 + epoch,
                                         'cursor': 2 if epoch else 0},
                            'files': {p.name: runner.sha(p) for p in folder.iterdir()}}
                self.write(folder / 'CHECKPOINT.json', manifest)
                if epoch:
                    record['epoch_checkpoints'].append(str(folder))
                    self.jsonl(self.work / f'{pid}-e{epoch:03d}-coverage.jsonl', [{'row_id': k} for k in self.index['train']])
                else:
                    record['baseline_checkpoint'] = str(folder)
                label = f'e{epoch:03d}-validation' if epoch else 'baseline'
                self.jsonl(self.work / f'{pid}-{label}.jsonl', [
                    {'row_id': k, 'mean_target_ce': loss, 'target_tokens': row['target_length'],
                     'adapter_sha256': identity} for k, row in self.index['validation'].items()])
            if position < 2:
                record['selected_adapter_sha256'] = identity
            initial = identity
            state['phases'][pid] = record
        self.state = state
        return state

    def add_roles(self, count=1, fail=False):
        for epoch in range(1, count + 1):
            evidence = deepcopy(self.evidence)
            evidence['candidate_checkpoint_sha256'] = f'{200 + epoch:064x}'
            if fail:
                evidence['cases'][0]['candidate']['facts_grounded'] = False
            self.write(self.work / 'role-evaluations' / f'e{epoch:03d}.json', evidence)

    def assess(self):
        return self.gate.assess(self.state, bridge.PHASES[-1], self.work, self.binding, runner.verify_checkpoint)

    def test_missing_evaluation_stays_pending_and_does_not_accept(self):
        self.prepare()
        receipts = self.assess()
        result = bridge.apply_receipts(self.state, bridge.PHASES[-1], receipts)
        self.assertEqual(result['accepted'], bridge.PHASES[:-1])
        self.assertEqual(result['phases'][bridge.PHASES[-1]]['decision'], 'stop_pending_evaluation')

    def test_pending_then_real_matching_evidence_completes_without_loading_model(self):
        self.prepare()
        self.state = bridge.apply_receipts(self.state, bridge.PHASES[-1], self.assess())
        self.write(self.work / 'COURSE_STATE.json', self.state)
        self.add_roles()
        self.assertTrue(runner.reconcile_completion(self.work, self.binding, self.gate))
        result = bridge.read(self.work / 'STATUS.json')
        self.assertTrue(result['training_complete'])
        self.assertFalse(result['unseen_test_passed'])
        self.assertFalse(result['automatic_deployment'])
        self.assertTrue(runner.reconcile_completion(self.work, self.binding, self.gate))
        self.assertEqual(bridge.read(self.work / 'COURSE_STATE.json')['accepted'], bridge.PHASES)

    def test_matching_evaluation_allows_next_epoch_without_duplicate_acceptance(self):
        self.prepare(final_losses=(.999,))
        self.add_roles()
        self.write(self.work / 'COURSE_STATE.json', self.state)
        self.assertFalse(runner.reconcile_completion(self.work, self.binding, self.gate))
        result = bridge.read(self.work / 'COURSE_STATE.json')
        self.assertEqual(result['phases'][bridge.PHASES[-1]]['decision'], 'continue')
        self.assertEqual(result['accepted'], bridge.PHASES[:-1])

    def test_bad_quality_cannot_be_hidden_by_improved_loss(self):
        self.prepare()
        self.add_roles(fail=True)
        d = self.assess()[bridge.PHASES[-1]]['decision']
        self.assertEqual(d['status'], 'continue')
        self.assertFalse(d['model_training_criteria_satisfied_from_supplied_evidence'])

    def test_resource_limit_with_bad_quality_does_not_complete(self):
        self.prepare(cap=1)
        self.add_roles(fail=True)
        self.assertEqual(self.assess()[bridge.PHASES[-1]]['decision']['status'], 'stop_resource_limit')

    def test_plateau_with_valid_role_evidence_rejects(self):
        self.prepare(final_losses=(.999, .998))
        self.add_roles(count=2)
        self.assertEqual(self.assess()[bridge.PHASES[-1]]['decision']['status'], 'stop_phase_rejected')

    def test_current_epoch_cannot_skip_missing_earlier_role_evidence(self):
        self.prepare(final_losses=(.999, .8))
        self.add_roles(count=2)
        (self.work / 'role-evaluations/e001.json').unlink()
        with self.assertRaisesRegex(ValueError, 'History continued'):
            self.assess()

    def test_stale_candidate_or_baseline_is_rejected(self):
        self.prepare()
        self.add_roles()
        path = self.work / 'role-evaluations/e001.json'
        value = bridge.read(path)
        value['candidate_checkpoint_sha256'] = 'f' * 64
        self.write(path, value)
        with self.assertRaisesRegex(ValueError, 'bindings differ'):
            self.assess()

    def test_consumed_evaluation_cannot_be_replaced(self):
        self.prepare(final_losses=(.999,))
        self.add_roles()
        self.state = bridge.apply_receipts(self.state, bridge.PHASES[-1], self.assess())
        self.add_roles(fail=True)
        with self.assertRaisesRegex(ValueError, 'Previously consumed'):
            self.assess()

    def test_missing_validation_and_duplicate_coverage_are_rejected(self):
        self.prepare()
        path = self.work / (bridge.PHASES[-1] + '-e001-validation.jsonl')
        original = path.read_text()
        path.write_text(original.splitlines()[0] + '\n')
        with self.assertRaisesRegex(ValueError, 'Incomplete validation'):
            self.assess()
        path.write_text(original)
        coverage = self.work / (bridge.PHASES[-1] + '-e001-coverage.jsonl')
        self.jsonl(coverage, [{'row_id': 't1'}, {'row_id': 't1'}])
        with self.assertRaisesRegex(ValueError, 'Incomplete or duplicate'):
            self.assess()

    def test_changed_checkpoint_and_partial_epoch_are_rejected(self):
        self.prepare()
        folder = Path(self.state['phases'][bridge.PHASES[-1]]['epoch_checkpoints'][0])
        manifest = bridge.read(folder / 'CHECKPOINT.json')
        manifest['progress']['cursor'] = 1
        self.write(folder / 'CHECKPOINT.json', manifest)
        with self.assertRaisesRegex(ValueError, 'complete epoch'):
            self.assess()
        manifest['progress']['cursor'] = 2
        self.write(folder / 'CHECKPOINT.json', manifest)
        (folder / 'adapter_model.safetensors').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'hash differs'):
            self.assess()

    def test_nonboolean_baseline_is_not_manufactured_into_approval(self):
        with self.assertRaisesRegex(ValueError, 'boolean baseline'):
            self.prepare(baseline_change=lambda b: b['cases'][0]['baseline'].update(facts_grounded=None))

    def test_changed_config_is_rejected_after_loading(self):
        self.prepare()
        path = self.root / 'baseline.json'
        path.write_text(path.read_text() + ' ')
        with self.assertRaisesRegex(ValueError, 'configuration changed'):
            self.assess()

    def test_dataset_or_compute_profile_mismatch_cannot_approve(self):
        self.prepare()
        self.binding['compute_profile'] = 'optimized'
        with self.assertRaisesRegex(ValueError, 'reference metrics'):
            self.assess()

    def test_between_phases_rechecks_accepted_prefix_before_model_load(self):
        self.prepare()
        del self.state['phases'][bridge.PHASES[-1]]
        self.write(self.work / 'COURSE_STATE.json', self.state)
        self.assertFalse(runner.reconcile_completion(self.work, self.binding, self.gate))
        path = self.work / (bridge.PHASES[1] + '-e001-validation.jsonl')
        path.write_text(path.read_text().replace('0.8', '0.9'))
        with self.assertRaisesRegex(ValueError, 'aggregate differs'):
            runner.reconcile_completion(self.work, self.binding, self.gate)

    def test_prepare_validates_actual_inputs_and_never_overwrites(self):
        self.prepare()
        destination = self.root / 'frozen'
        with patch.object(stop, 'bound_indexes', return_value=({}, self.index)), \
             patch.object(stop, 'bound_train_lineage', return_value={'training-only'}):
            report = bridge.prepare(self.root / 'policy.json', self.root / 'suite.json',
                                    self.root / 'baseline.json', self.root, destination, 'new-run')
            self.assertFalse(report['training_complete'])
            with self.assertRaisesRegex(ValueError, 'fresh canonical'):
                bridge.prepare(self.root / 'policy.json', self.root / 'suite.json',
                               self.root / 'baseline.json', self.root, destination, 'new-run')

    def test_prepare_failure_leaves_no_partial_configuration(self):
        self.prepare()
        path = self.root / 'baseline.json'
        value = bridge.read(path)
        value['cases'][0]['baseline']['facts_grounded'] = None
        self.write(path, value)
        destination = self.root / 'invalid'
        with patch.object(stop, 'bound_indexes', return_value=({}, self.index)), \
             patch.object(stop, 'bound_train_lineage', return_value={'training-only'}):
            with self.assertRaisesRegex(ValueError, 'boolean baseline'):
                bridge.prepare(self.root / 'policy.json', self.root / 'suite.json', path,
                               self.root, destination, 'new-run')
        self.assertFalse(destination.exists())
        self.assertEqual(list(self.root.glob('.invalid-*')), [])

    def test_empty_checkpoint_inventory_cannot_complete_without_model_restore(self):
        self.prepare()
        self.add_roles()
        folder = Path(self.state['phases'][bridge.PHASES[-1]]['epoch_checkpoints'][0])
        manifest = bridge.read(folder / 'CHECKPOINT.json')
        for name in manifest['files']:
            (folder / name).unlink()
        manifest['files'] = {}
        self.write(folder / 'CHECKPOINT.json', manifest)
        with self.assertRaisesRegex(ValueError, 'checkpoint files required'):
            self.assess()

    def test_empty_optimizer_file_cannot_complete(self):
        self.prepare()
        self.add_roles()
        folder = Path(self.state['phases'][bridge.PHASES[-1]]['epoch_checkpoints'][0])
        manifest = bridge.read(folder / 'CHECKPOINT.json')
        (folder / 'training_state.pt').write_bytes(b'')
        manifest['files']['training_state.pt'] = runner.sha(folder / 'training_state.pt')
        self.write(folder / 'CHECKPOINT.json', manifest)
        with self.assertRaisesRegex(ValueError, 'checkpoint files required'):
            self.assess()


if __name__ == '__main__':
    unittest.main()
