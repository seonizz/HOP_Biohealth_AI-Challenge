"""External-driver contracts; real CPU resume equivalence when torch is present."""
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
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
KIT = Path(os.environ.get('EARLY_DRIVER_KIT', HERE / 'training_kit')).resolve()
spec = importlib.util.spec_from_file_location('early_training_driver', HERE / 'early_training_driver.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)


def rows(count):
    return [{'id': 'PRIVATE_ID_%05d' % index, 'sequence_length': 10 + index % 250,
             'target_length': 1 + index % 7, 'input_ids': [index, 2], 'labels': [-100, 2]}
            for index in range(count)]


def evaluation(values, loss=5.0):
    return {'rows': len(values), 'supervised_tokens': sum(row['target_length'] for row in values),
            'target_mean_loss': loss, 'weighting': 'shifted_nonignored_target_tokens',
            'behavioral_quality_verified': False}


class DriverTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.work = Path(temporary.name).resolve()
        self.private = self.work / 'early'
        self.private.mkdir()
        self.bound = {'dataset_sha256': 'a' * 64, 'code_sha256': 'b' * 64}
        self.validation = rows(driver.VALIDATION_ROWS)
        self.train = rows(driver.TRAIN_ROWS)
        self.config = {'seed': 3407, 'gradient_accumulation_steps': 8, 'checkpoint_every': 100,
                       'max_length': 25316, 'warmup_ratio': .03, 'learning_rate': 2e-5,
                       'weight_decay': .01}
        self.sample = driver.sample_manifest(self.validation, self.bound, 'c' * 64)
        self.sample_rows = [self.validation[item['index']] for item in self.sample['selection']]
        self.context = SimpleNamespace(work=self.work, private=self.private, bound=self.bound,
                                       config=self.config, driver_sha='d' * 64, command='early',
                                       rows={'train': self.train, 'validation': self.validation},
                                       sample=self.sample, sample_rows=self.sample_rows)
        self.model = Mock()
        self.model.get_input_embeddings.return_value.weight.device = 'cpu'
        self.tokenizer = Mock(pad_token_id=0)

    def report(self):
        baseline = {'evaluation': evaluation(self.sample_rows), 'elapsed_seconds': 2.0}
        final = {'evaluation': evaluation(self.sample_rows, 4.5), 'elapsed_seconds': 3.0}
        checkpoint = {'step': 16, 'cursor': 128, 'checkpoint_manifest_sha256': 'e' * 64,
                      'checkpoint_file_sha256': {'adapter_model.safetensors': 'f' * 64}}
        return driver.public_early_report(self.sample, driver.early_training_counts(self.train),
                                          baseline, final, checkpoint, 16.0)

    def test_sample_is_fixed_stratified_and_preserves_global_rng(self):
        before = random.getstate()
        sample = driver.sample_manifest(self.validation, self.bound, 'c' * 64)
        self.assertEqual(random.getstate(), before)
        self.assertEqual(sample, self.sample)
        self.assertEqual(len({item['id'] for item in sample['selection']}), 32)
        self.assertEqual([item['sample_rows'] for item in sample['strata']], [8] * 4)
        ranked = sorted(range(len(self.validation)), key=lambda i: (self.validation[i]['sequence_length'], self.validation[i]['id']))
        for quartile in range(4):
            bucket = set(ranked[quartile * len(ranked) // 4:(quartile + 1) * len(ranked) // 4])
            self.assertTrue(all(item['index'] in bucket for item in sample['selection'][quartile * 8:(quartile + 1) * 8]))
        self.assertTrue(sample['selected_before_predictions'])
        self.assertNotEqual(driver.sample_manifest(self.validation, self.bound, 'f' * 64)['sample_sha256'], sample['sample_sha256'])

    def test_sample_reuse_rejects_changed_id_token_or_binding(self):
        cache = {'bindings': self.bound, 'files': {'validation.jsonl.gz': {'sha256': 'c' * 64}}}
        self.context.api = SimpleNamespace(prep=SimpleNamespace(read_json=lambda _: cache))
        first, _ = driver.ensure_sample(self.context)
        self.assertEqual(first, self.sample)
        driver.ensure_sample(self.context)
        selected = first['selection'][0]['index']
        self.validation[selected]['input_ids'][0] = 999999
        with self.assertRaisesRegex(ValueError, 'Existing evidence differs'):
            driver.ensure_sample(self.context)
        self.validation[selected]['input_ids'][0] = selected
        self.validation[1]['id'] = self.validation[0]['id']
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            driver.ensure_sample(self.context)

    def test_sample_cannot_be_first_selected_after_training(self):
        cache = {'bindings': self.bound, 'files': {'validation.jsonl.gz': {'sha256': 'c' * 64}}}
        self.context.api = SimpleNamespace(prep=SimpleNamespace(read_json=lambda _: cache))
        (self.work / 'training').mkdir()
        (self.work / 'training/RUN.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'after early predictions or training'):
            driver.ensure_sample(self.context)

    def test_training_cap_does_not_change_epoch_settings_or_shuffle(self):
        scheduler = object()
        early = driver.training_kwargs(self.context, self.tokenizer, self.model, scheduler, early=True)
        self.assertEqual(early['max_steps'], 16)
        self.assertIsNone(early['resume_from'])
        (self.work / 'training').mkdir()
        (self.work / 'training/RUN.json').write_text('{}')
        resumed = driver.training_kwargs(self.context, self.tokenizer, self.model, scheduler, early=False)
        self.assertIsNone(resumed['max_steps'])
        self.assertEqual(resumed['resume_from'], 'latest')
        self.assertEqual({k: v for k, v in early.items() if k not in ('max_steps', 'resume_from')},
                         {k: v for k, v in resumed.items() if k not in ('max_steps', 'resume_from')})
        self.assertEqual((early['seed'], early['accumulation_steps'], early['checkpoint_every']), (3407, 8, 100))
        order = list(range(len(self.train)))
        random.Random(3407).shuffle(order)
        first = [self.train[index] for index in order[:128]]
        self.assertEqual(driver.early_training_counts(self.train),
                         {'rows': 128, 'input_tokens': sum(r['sequence_length'] for r in first),
                          'supervised_tokens': sum(r['target_length'] for r in first)})
        with self.assertRaises(ValueError):
            driver.early_training_counts(first)

    def test_public_json_csv_are_private_data_free_and_durable_before_continue(self):
        report = self.report()
        self.assertEqual(report['relative_change_percent'], -10.0)
        self.assertEqual(report['delta_nll_B1_minus_B0'], -.5)
        with self.assertRaises(FileNotFoundError):
            driver.require_early_complete(self.context)
        driver.publish_early(self.context, report)
        driver.require_early_complete(self.context)
        driver.publish_early(self.context, report)
        public = (self.work / 'early_result.json').read_text() + (self.work / 'early_result.csv').read_text()
        for forbidden in ('PRIVATE_ID_', 'input_ids', 'labels', 'selection', 'adapter_parameters'):
            self.assertNotIn(forbidden, public)
        self.assertFalse(report['epoch_completed'])
        self.assertFalse(report['hop_deployment_ready'])
        (self.work / 'early_result.csv').write_text('tampered')
        with self.assertRaisesRegex(ValueError, 'durable'):
            driver.require_early_complete(self.context)

    def test_evaluation_rejects_wrong_target_accounting_and_nonfinite_loss(self):
        value = evaluation(self.sample_rows)
        driver.verify_evaluation(value, self.sample_rows)
        for change in ({'rows': 31}, {'supervised_tokens': 0}, {'target_mean_loss': float('nan')},
                       {'target_mean_loss': float('inf')}, {'behavioral_quality_verified': True}):
            with self.assertRaises(ValueError):
                driver.verify_evaluation({**value, **change}, self.sample_rows)

    def test_early_order_forwards_all_rows_and_publishes_after_same_sample_B1(self):
        order = list(range(len(self.train)))
        random.Random(3407).shuffle(order)
        events = []

        def train(model, optimizer, actual_rows, output_dir, **kwargs):
            self.assertIs(actual_rows, self.train)
            self.assertEqual((len(actual_rows), kwargs['max_steps']), (40415, 16))
            events.append('train')
            output_dir.mkdir()
            records = [{'step': step, 'microbatches': 8, 'next_row_cursor': step * 8,
                        'supervised_tokens': sum(self.train[i]['target_length'] for i in order[(step - 1) * 8:step * 8]),
                        'elapsed_seconds': 1.0} for step in range(1, 17)]
            (output_dir / 'train.jsonl').write_text(''.join(json.dumps(item) + '\n' for item in records))
            return {'completed_optimizer_steps': 16, 'next_row_cursor': 128, 'epoch_completed': False}

        def evaluate(context, model, tokenizer, actual_rows):
            self.assertIs(actual_rows, self.sample_rows)
            label = 'B0' if not events else 'B1'
            events.append(label)
            return evaluation(actual_rows, 5.0 if label == 'B0' else 4.5), 1.0, 'base' if label == 'B0' else 'trained'

        optimizer = SimpleNamespace(param_groups=[{'lr': 0.0}])
        self.context.api = SimpleNamespace(cli=SimpleNamespace(optimizer_for=lambda *_: optimizer),
                                          loop=SimpleNamespace(run_training=train, _parameter_sha=lambda _: 'trained'))
        evidence = self.report()['checkpoint']
        with patch.object(driver, 'fresh_base_hash', return_value='base'), \
             patch.object(driver, 'scheduler_for', return_value=object()), \
             patch.object(driver, 'checkpoint_evidence', return_value=(None, {'adapter_parameters_sha256': 'trained'}, evidence)), \
             patch.object(driver, 'evaluate', side_effect=evaluate), contextlib.redirect_stdout(io.StringIO()):
            driver.run_early(self.context, self.model, self.tokenizer)
        self.assertEqual(events, ['B0', 'train', 'B1'])
        driver.require_early_complete(self.context)
        self.assertFalse((self.work / 'validation_B0.json').exists())
        self.assertFalse((self.work / 'COMPLETE.json').exists())

    def test_continue_requires_durable_report_before_optimizer_or_training(self):
        self.context.api = SimpleNamespace(cli=Mock(), loop=Mock())
        with self.assertRaises(FileNotFoundError):
            driver.run_continue(self.context, self.model, self.tokenizer)
        self.context.api.cli.optimizer_for.assert_not_called()
        self.context.api.loop.run_training.assert_not_called()

    def test_continue_defers_B0_and_completes_full_B1_before_tokenizer_save(self):
        driver.publish_early(self.context, self.report())
        training = self.work / 'training'
        training.mkdir()
        (training / 'RUN.json').write_text('{}')
        events = []
        optimizer = SimpleNamespace(param_groups=[{'lr': 0.0}])
        result = {'checkpoint': str(training / 'checkpoints/step-000005052'), 'epoch_completed': True}
        evidence = {'checkpoint_manifest_sha256': 'e' * 64}

        def train(model, optimizer, actual_rows, output_dir, **kwargs):
            self.assertIs(actual_rows, self.train)
            self.assertIsNone(kwargs['max_steps'])
            self.assertEqual(kwargs['resume_from'], 'latest')
            events.append('resume')

        def evaluate(context, model, tokenizer, actual_rows):
            self.assertIs(actual_rows, self.validation)
            events.append('full_B1')
            return evaluation(actual_rows, 4.0), 1.0, 'trained'

        self.context.api = SimpleNamespace(cli=SimpleNamespace(optimizer_for=lambda *_: optimizer),
                                          loop=SimpleNamespace(run_training=train, _parameter_sha=lambda _: 'trained'))
        self.tokenizer.save_pretrained.side_effect = lambda _: events.append('tokenizer')
        with patch.object(driver, 'scheduler_for', return_value=object()), \
             patch.object(driver, 'require_full_result', return_value=(result, {'adapter_parameters_sha256': 'trained'}, evidence)), \
             patch.object(driver, 'evaluate', side_effect=evaluate), contextlib.redirect_stdout(io.StringIO()):
            driver.run_continue(self.context, self.model, self.tokenizer)
        self.assertEqual(events, ['resume', 'full_B1', 'tokenizer'])
        pending = driver.read_json(self.work / 'validation_B1_pending_baseline.json')
        self.assertTrue(pending['baseline_pending'])
        self.assertFalse((self.work / 'validation_B0.json').exists())
        self.assertFalse((self.work / 'COMPLETE.json').exists())

    def test_deferred_fresh_baseline_finalizes_original_collector_contract(self):
        driver.publish_early(self.context, self.report())
        result = {'checkpoint': '/fixture/checkpoints/step-000005052', 'epoch_completed': True,
                  'completed_optimizer_steps': 5052, 'next_row_cursor': 40415}
        pending = {**driver.identity(self.context), 'evaluation': evaluation(self.validation, 4.0),
                   'checkpoint': result['checkpoint'], 'checkpoint_manifest_sha256': 'e' * 64}
        driver.save_json(self.work / 'validation_B1_pending_baseline.json', pending)
        driver.save_json(self.private / 'mini_B0.json', {**driver.identity(self.context, self.sample), 'base_adapter_sha256': 'base'})
        with patch.object(driver, 'require_full_result', return_value=(result, {}, {'checkpoint_manifest_sha256': 'e' * 64})), \
             patch.object(driver, 'fresh_base_hash', return_value='base'), \
             patch.object(driver, 'evaluate', return_value=(evaluation(self.validation, 5.0), 3.0, 'base')) as evaluate, \
             contextlib.redirect_stdout(io.StringIO()):
            driver.run_full_baseline(self.context, self.model, self.tokenizer)
        self.assertIs(evaluate.call_args.args[3], self.validation)
        baseline = driver.read_json(self.work / 'validation_B0.json')
        final = driver.read_json(self.work / 'validation_B1.json')
        complete = driver.read_json(self.work / 'COMPLETE.json')
        self.assertEqual(baseline['model'], 'base_plus_zero_initialized_lora')
        self.assertTrue(baseline['evaluated_after_training_on_fresh_untrained_model'])
        self.assertEqual(final['delta_target_mean_loss'], -1.0)
        self.assertEqual(complete['status'], 'stage1_epoch_completed')
        self.assertEqual(complete['training'], result)
        self.assertFalse(complete['hop_deployment_ready'])


TORCH_AVAILABLE = importlib.util.find_spec('torch') is not None


@unittest.skipUnless(TORCH_AVAILABLE, 'CPU autograd verification requires torch')
class TorchDriverTests(unittest.TestCase):
    def test_real_accum8_step16_resume_preserves_parameters_rng_optimizer_and_full_schedule(self):
        sys.path.insert(0, str(KIT))
        fixture_spec = importlib.util.spec_from_file_location('existing_loop_tests', KIT / 'tests/test_stage1_training_loop.py')
        fixtures = importlib.util.module_from_spec(fixture_spec)
        fixture_spec.loader.exec_module(fixtures)
        fixture = fixtures.TorchTrainingLoopTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        torch, loop = fixture.torch, fixtures.loop
        config = {'gradient_accumulation_steps': 8, 'warmup_ratio': .03,
                  'learning_rate': 2e-5, 'weight_decay': .01}
        # Reuse the production CPU fixture, retaining a partial last window.
        fixture_rows = [fixture.rows[index % len(fixture.rows)] for index in range(135)]

        def run(model, directory, **kwargs):
            optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],
                                         lr=config['learning_rate'], weight_decay=config['weight_decay'], foreach=False)
            scheduler = driver.scheduler_for(optimizer, config)
            self.assertEqual(optimizer.param_groups[0]['lr'], 0.0)
            for step, expected in ((16, 16 / 152), (152, 1.0), (5052, 0.0)):
                self.assertAlmostEqual(scheduler.lr_lambdas[0](step), expected)
            with contextlib.redirect_stdout(io.StringIO()):
                result = loop.run_training(model, optimizer, fixture_rows, directory, pad_id=0,
                                           bindings=fixture.bindings, accumulation_steps=8, seed=3407,
                                           checkpoint_every=100, max_length=25316, scheduler=scheduler,
                                           restore_adapter=fixture.restore_adapter, **kwargs)
            return result, optimizer, scheduler

        full = fixture.make_model(dropout=.25)
        full_result, full_optimizer, full_scheduler = run(full, fixture.root / 'full')
        initial = fixture.make_model(dropout=.25)
        paused, _, _ = run(initial, fixture.root / 'resume', max_steps=16)
        self.assertEqual((paused['completed_optimizer_steps'], paused['next_row_cursor']), (16, 128))
        self.assertFalse(paused['epoch_completed'])
        before_run = driver.read_json(fixture.root / 'resume/RUN.json')
        self.assertEqual(before_run['plan']['rows'], 135)
        self.assertEqual(before_run['optimizer']['parameter_groups'][0]['options']['lr'], 0.0)
        resumed = fixture.make_model(dropout=.25)
        result, optimizer, scheduler = run(resumed, fixture.root / 'resume', resume_from='latest')
        self.assertEqual(driver.read_json(fixture.root / 'resume/RUN.json'), before_run)
        self.assertEqual((result['completed_optimizer_steps'], result['next_row_cursor']), (17, 135))
        self.assertEqual(result['completed_optimizer_steps'], full_result['completed_optimizer_steps'])
        self.assertTrue(torch.equal(full.adapter.weight, resumed.adapter.weight))
        self.assertTrue(loop._state_equal(full_optimizer.state_dict(), optimizer.state_dict()))
        self.assertEqual(full_scheduler.state_dict(), scheduler.state_dict())
        records = [json.loads(line) for line in (fixture.root / 'resume/train.jsonl').read_text().splitlines()]
        self.assertEqual([r['step'] for r in records], list(range(1, 18)))
        self.assertEqual([r['microbatches'] for r in records], [8] * 16 + [7])
        self.assertEqual(sum(r['supervised_tokens'] for r in records), sum(r['target_length'] for r in fixture_rows))


if __name__ == '__main__':
    unittest.main()
