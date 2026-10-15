"""Checkpoint-100 evidence/privacy contracts and real CPU restoration checks."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import random
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
KIT = Path(os.environ.get('CHECKPOINT100_KIT', HERE / 'training_kit')).resolve()
spec = importlib.util.spec_from_file_location('checkpoint100_eval', HERE / 'checkpoint100_eval.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
early = driver.load_early(Path(os.environ.get('CHECKPOINT100_EARLY_DRIVER', HERE / 'early_training_driver.py')))


def rows(count):
    return [{'id': 'PRIVATE_ROW_%05d' % index, 'sequence_length': 10 + index % 71,
             'target_length': 1 + index % 7, 'input_ids': [index, 2], 'labels': [-100, 2]}
            for index in range(count)]


def evaluation(values, loss):
    return {'rows': len(values), 'supervised_tokens': sum(row['target_length'] for row in values),
            'target_mean_loss': loss, 'weighting': 'shifted_nonignored_target_tokens',
            'behavioral_quality_verified': False}


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.work = Path(temporary.name).resolve()
        for name in ('early', 'training', 'tokens', 'checkpoint100_evaluation'):
            (self.work / name).mkdir()
        self.bound = {'dataset_sha256': 'a' * 64, 'code_sha256': 'b' * 64}
        self.values = {'train': rows(40415), 'validation': rows(4298)}
        self.sample = early.sample_manifest(self.values['validation'], self.bound, 'c' * 64)
        self.sample_rows = [self.values['validation'][item['index']] for item in self.sample['selection']]
        self.original = SimpleNamespace(private=self.work / 'early', work=self.work, bound=self.bound,
                                        driver_sha=driver.EARLY_DRIVER_SHA256, sample=self.sample,
                                        sample_rows=self.sample_rows)
        self.context = SimpleNamespace(early=early, work=self.work, private=self.work / 'checkpoint100_evaluation',
                                       rows=self.values, bound=self.bound, original=self.original, driver_sha='d' * 64)
        self.order = list(range(40415))
        random.Random(3407).shuffle(self.order)
        early.save_json(self.work / 'training/RUN.json', {'plan': {'order': self.order}})
        self.records = [{'step': step, 'mode': 'train', 'microbatches': 8, 'next_row_cursor': step * 8,
                         'supervised_tokens': sum(self.values['train'][i]['target_length'] for i in self.order[(step - 1) * 8:step * 8]),
                         'elapsed_seconds': 2.0} for step in range(1, 101)]
        self.write_log()

    def write_log(self):
        (self.work / 'training/train.jsonl').write_text(''.join(json.dumps(value) + '\n' for value in self.records))

    def make_previous(self):
        baseline = {**early.identity(self.original, self.sample), 'evaluation': evaluation(self.sample_rows, 5.0),
                    'elapsed_seconds': 3.0, 'base_adapter_sha256': 'e' * 64}
        at16 = {**early.identity(self.original, self.sample), 'evaluation': evaluation(self.sample_rows, 4.5),
                'elapsed_seconds': 4.0, 'checkpoint_manifest_sha256': 'f' * 64}
        checkpoint = {'step': 16, 'cursor': 128, 'checkpoint_manifest_sha256': 'f' * 64,
                      'checkpoint_file_sha256': {'adapter_model.safetensors': 'e' * 64}}
        early.save_json(self.original.private / 'sample.private.json', self.sample)
        early.save_json(self.original.private / 'mini_B0.json', baseline)
        early.save_json(self.original.private / 'mini_B1.json', at16)
        counts = driver.training_accounting(self.context, step=16)
        early.publish_early(self.original, early.public_early_report(self.sample, counts, baseline, at16, checkpoint, counts['logged_seconds']))
        return baseline, at16, checkpoint

    def test_fixed_sample_is_read_only_and_rejects_changed_original_manifest(self):
        early.save_json(self.work / 'tokens/manifest.json', {'bindings': self.bound,
                        'files': {'validation.jsonl.gz': {'sha256': 'c' * 64}}})
        path = self.original.private / 'sample.private.json'
        early.save_json(path, self.sample)
        before = path.read_bytes()
        sample, actual = driver.fixed_sample(self.context)
        self.assertEqual(sample, self.sample)
        self.assertEqual(actual, self.sample_rows)
        self.assertEqual(path.read_bytes(), before)
        tampered = {**self.sample, 'sample_sha256': '0' * 64}
        early.save_json(path, tampered)
        with self.assertRaisesRegex(ValueError, 'originally fixed'):
            driver.fixed_sample(self.context)

    def test_counts_bind_all_100_real_windows_and_reject_missing_or_wrong_tokens(self):
        counts = driver.training_accounting(self.context)
        first = [self.values['train'][i] for i in self.order[:800]]
        self.assertEqual(counts, {'rows': 800, 'input_tokens': sum(r['sequence_length'] for r in first),
                                 'supervised_tokens': sum(r['target_length'] for r in first), 'logged_seconds': 200.0,
                                 'log_prefix_sha256': early.digest(self.records)})
        self.records[99]['supervised_tokens'] += 1
        self.write_log()
        with self.assertRaisesRegex(ValueError, 'accounting'):
            driver.training_accounting(self.context)
        self.records.pop()
        self.write_log()
        with self.assertRaisesRegex(ValueError, 'missing'):
            driver.training_accounting(self.context)

    def test_previous_baseline_and_step16_results_are_verified_against_original_public_result(self):
        baseline, at16, checkpoint = self.make_previous()
        with patch.object(early, 'checkpoint_evidence', return_value=(None, {}, checkpoint)):
            actual0, actual16, sources = driver.previous_evidence(self.context)
            self.assertEqual((actual0, actual16), (baseline, at16))
            self.assertIn('early_result.json', sources)
            at16['evaluation']['target_mean_loss'] += .1
            early.save_json(self.original.private / 'mini_B1.json', at16)
            with self.assertRaisesRegex(ValueError, 'disagrees'):
                driver.previous_evidence(self.context)

    def test_original_driver_identity_cannot_be_rebound_to_new_evaluator(self):
        _, _, checkpoint = self.make_previous()
        self.original.driver_sha = self.context.driver_sha
        with patch.object(early, 'checkpoint_evidence', return_value=(None, {}, checkpoint)), \
             self.assertRaisesRegex(ValueError, 'identity changed'):
            driver.previous_evidence(self.context)

    def test_restore_refuses_step99_and_cursor799_before_loading_state(self):
        checkpoint = self.work / 'training/step-000000100'
        checkpoint.mkdir()
        loader = SimpleNamespace(_load_checkpoint=lambda *args: self.fail('Invalid checkpoint must not be loaded'))
        self.context.api = SimpleNamespace(loop=loader)
        for step, cursor in ((99, 800), (100, 799), (True, 800)):
            early.save_json(checkpoint / 'CHECKPOINT.json', {'step': step, 'cursor': cursor})
            with self.assertRaisesRegex(ValueError, 'exactly checkpoint 100'):
                driver.restore_exact_checkpoint(self.context, None, None, None, {}, checkpoint)

    def test_public_report_privacy_deltas_hash_sidecar_and_preserves_original_results(self):
        baseline, at16, _ = self.make_previous()
        before = driver.protected_snapshot(self.context)
        checkpoint = {'step': 100, 'cursor': 800, 'checkpoint_manifest_sha256': 'f' * 64,
                      'checkpoint_file_sha256': {'adapter_model.safetensors': 'e' * 64},
                      'adapter_parameters_sha256': 'e' * 64}
        report = driver.public_report(self.context, evaluation(self.sample_rows, 4.0), 3.0, baseline, at16,
                                      checkpoint, driver.training_accounting(self.context), {'early_result.json': 'a' * 64})
        self.assertEqual(report['versus_base']['delta_nll'], -1.0)
        self.assertEqual(report['versus_base']['relative_change_percent'], -20.0)
        self.assertEqual(report['versus_checkpoint16']['delta_nll'], -.5)
        self.assertEqual(report['training_rows_completed_at_checkpoint'], 800)
        driver.save_measurement(self.context, report, checkpoint, driver.training_accounting(self.context),
                                {'early_result.json': 'a' * 64})
        driver.publish(self.context, report)
        driver.publish(self.context, report)
        self.assertEqual(driver.protected_snapshot(self.context), before)
        combined = (self.work / 'checkpoint100_result.json').read_text() + (self.work / 'checkpoint100_result.csv').read_text()
        for forbidden in ('PRIVATE_ROW_', 'input_ids', 'labels', 'selection'):
            self.assertNotIn(forbidden, combined)
        manifest = early.read_json(self.context.private / 'RESULT_MANIFEST.json')
        for name, sha in manifest['artifacts'].items():
            self.assertEqual(early.file_sha(self.work / name), sha)
        self.assertFalse(report['epoch_completed'])
        self.assertFalse(report['behavioral_quality_verified'])
        self.assertEqual(report['optimizer_updates_during_evaluation'], 0)

    def test_protected_snapshot_detects_training_and_previous_report_changes(self):
        self.make_previous()
        before = driver.protected_snapshot(self.context)
        (self.work / 'training/TRAINING_RESULT.json').write_text('{}')
        self.assertNotEqual(driver.protected_snapshot(self.context), before)
        before = driver.protected_snapshot(self.context)
        (self.work / 'early_result.csv').write_text('changed')
        self.assertNotEqual(driver.protected_snapshot(self.context), before)

    def test_interrupted_publication_recovers_saved_timing_after_training_advances(self):
        baseline, at16, _ = self.make_previous()
        checkpoint = {'step': 100, 'cursor': 800, 'checkpoint_manifest_sha256': 'f' * 64,
                      'checkpoint_file_sha256': {'adapter_model.safetensors': 'e' * 64},
                      'adapter_parameters_sha256': 'e' * 64}
        sources = {'early_result.json': early.file_sha(self.work / 'early_result.json')}
        counts = driver.training_accounting(self.context)
        report = driver.public_report(self.context, evaluation(self.sample_rows, 4.0), 7.25,
                                      baseline, at16, checkpoint, counts, sources)
        driver.save_measurement(self.context, report, checkpoint, counts, sources)
        measurement = (self.context.private / 'MEASUREMENT.json').read_bytes()
        real_save = early.save_once
        for phase in ('csv', 'manifest'):
            def interrupted_save(path, value):
                if path.name == 'RESULT_MANIFEST.json':
                    raise OSError('interrupted before sidecar')
                return real_save(path, value)

            fault = patch.object(driver.csv, 'DictWriter', side_effect=OSError('interrupted before CSV')) if phase == 'csv' else \
                    patch.object(early, 'save_once', side_effect=interrupted_save)
            with fault, self.assertRaises(OSError):
                driver.publish(self.context, report)
            self.assertTrue((self.work / 'checkpoint100_result.json').exists())
            with (self.work / 'training/train.jsonl').open('a') as stream:
                stream.write('{"unfinished_later_update":')
            (self.work / 'training/checkpoints').mkdir(exist_ok=True)
            (self.work / 'training/checkpoints/later-checkpoint').write_text('later training evidence')
            later_counts = driver.training_accounting(self.context)
            self.assertEqual(later_counts, counts)
            with patch.object(driver, 'run_evaluation', side_effect=AssertionError('Must not reevaluate')):
                self.assertTrue(driver.recover_measurement(self.context, baseline, at16, checkpoint, later_counts, sources))
            self.assertEqual((self.context.private / 'MEASUREMENT.json').read_bytes(), measurement)
            restored = early.read_json(self.work / 'checkpoint100_result.json')
            self.assertEqual(restored['timing_seconds']['evaluation'], 7.25)
            for path in (self.work / 'checkpoint100_result.json', self.work / 'checkpoint100_result.csv',
                         self.context.private / 'RESULT_MANIFEST.json'):
                path.unlink()

    def test_completed_recovery_is_idempotent_and_rejects_changed_measurement_identity(self):
        baseline, at16, _ = self.make_previous()
        checkpoint = {'step': 100, 'cursor': 800, 'checkpoint_manifest_sha256': 'f' * 64,
                      'checkpoint_file_sha256': {'adapter_model.safetensors': 'e' * 64},
                      'adapter_parameters_sha256': 'e' * 64}
        counts, sources = driver.training_accounting(self.context), {'early_result.json': 'a' * 64}
        report = driver.public_report(self.context, evaluation(self.sample_rows, 4.0), 3.0,
                                      baseline, at16, checkpoint, counts, sources)
        driver.save_measurement(self.context, report, checkpoint, counts, sources)
        self.assertTrue(driver.recover_measurement(self.context, baseline, at16, checkpoint, counts, sources))
        paths = [self.work / 'checkpoint100_result.json', self.work / 'checkpoint100_result.csv',
                 self.context.private / 'RESULT_MANIFEST.json', self.context.private / 'MEASUREMENT.json']
        before = [(path.read_bytes(), path.stat().st_mtime_ns) for path in paths]
        self.assertTrue(driver.recover_measurement(self.context, baseline, at16, checkpoint, counts, sources))
        self.assertEqual(before, [(path.read_bytes(), path.stat().st_mtime_ns) for path in paths])
        with self.assertRaisesRegex(ValueError, 'inputs changed'):
            driver.recover_measurement(self.context, baseline, at16,
                                       {**checkpoint, 'checkpoint_manifest_sha256': '0' * 64}, counts, sources)
        self.context.driver_sha = '0' * 64
        with self.assertRaisesRegex(ValueError, 'inputs changed'):
            driver.recover_measurement(self.context, baseline, at16, checkpoint, counts, sources)


TORCH_AVAILABLE = importlib.util.find_spec('torch') is not None


@unittest.skipUnless(TORCH_AVAILABLE, 'Real checkpoint restoration requires torch')
class TorchEvaluationTests(unittest.TestCase):
    def test_actual_cpu_checkpoint100_restore_evaluate_no_parameter_or_file_changes(self):
        sys.path.insert(0, str(KIT))
        spec = importlib.util.spec_from_file_location('checkpoint100_loop_fixture', KIT / 'tests/test_stage1_training_loop.py')
        fixture_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixture_module)
        fixture = fixture_module.TorchTrainingLoopTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        torch, loop = fixture.torch, fixture_module.loop
        config = {'seed': 3407, 'gradient_accumulation_steps': 8, 'max_length': 25316,
                  'warmup_ratio': .03, 'learning_rate': 2e-5, 'weight_decay': .01}
        source = [fixture.rows[i % 5] for i in range(805)]
        work = fixture.root
        (work / 'early').mkdir()
        (work / 'early_result.json').write_text('{}')
        (work / 'early_result.csv').write_text('preserved')

        def optimizer_for(model, config):
            return torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],
                                     lr=config['learning_rate'], weight_decay=config['weight_decay'], foreach=False)

        trained = fixture.make_model(dropout=.25)
        optimizer = optimizer_for(trained, config)
        scheduler = early.scheduler_for(optimizer, config)
        with contextlib.redirect_stdout(io.StringIO()):
            result = loop.run_training(trained, optimizer, source, work / 'training', pad_id=0,
                                       bindings=fixture.bindings, accumulation_steps=8, max_length=25316,
                                       checkpoint_every=100, max_steps=100, scheduler=scheduler)
        self.assertEqual((result['completed_optimizer_steps'], result['next_row_cursor']), (100, 800))
        context = SimpleNamespace(early=early, api=SimpleNamespace(loop=loop), work=work,
                                  config=config, bound=fixture.bindings, rows={'train': source})
        before_files = driver.protected_snapshot(context)
        fresh = fixture.make_model(dropout=.25)
        fresh_optimizer = optimizer_for(fresh, config)
        fresh_scheduler = early.scheduler_for(fresh_optimizer, config)
        tokenizer = SimpleNamespace(pad_token_id=0)
        run = driver.expected_run(context, fresh, fresh_optimizer, fresh_scheduler, tokenizer)
        checkpoint = Path(result['checkpoint'])
        manifest = driver.restore_exact_checkpoint(context, fresh, fresh_optimizer, fresh_scheduler,
                                                    run, checkpoint, restore_adapter=fixture.restore_adapter)
        self.assertTrue(torch.equal(trained.adapter.weight, fresh.adapter.weight))
        self.assertTrue(loop._state_equal(optimizer.state_dict(), fresh_optimizer.state_dict()))
        self.assertEqual(scheduler.state_dict(), fresh_scheduler.state_dict())
        adapter_before = loop._parameter_sha(fresh)
        with contextlib.redirect_stdout(io.StringIO()):
            measured = loop.evaluate(fresh, source[:32], pad_id=0, max_length=25316, device='cpu')
        self.assertEqual(measured['rows'], 32)
        self.assertFalse(measured['behavioral_quality_verified'])
        self.assertEqual(loop._parameter_sha(fresh), adapter_before)
        self.assertEqual(adapter_before, manifest['adapter_parameters_sha256'])
        self.assertEqual(driver.protected_snapshot(context), before_files)
        fresh_optimizer.param_groups[0]['lr'] = .1
        with self.assertRaisesRegex(ValueError, 'LR zero'):
            driver.expected_run(context, fresh, fresh_optimizer, fresh_scheduler, tokenizer)


if __name__ == '__main__':
    unittest.main()
