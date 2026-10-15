"""Focused ownership checks and real CPU checkpoint-boundary/resume equivalence."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import checkpoint100_boundary as boundary
import continue_checkpoint100 as coordinator

HERE = Path(__file__).resolve().parent
KIT = Path(os.environ.get('CHECKPOINT100_KIT', HERE / 'training_kit')).resolve()


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.training = self.root / 'training'
        self.training.mkdir()
        self.audit = self.root / 'audit'
        boundary.atomic_json(self.training / 'RUN.json', {'plan': {'rows': 40415}})
        boundary.atomic_json(self.training / 'latest.json', {'checkpoint': 'checkpoints/step-000000016'})
        (self.training / 'train.jsonl').write_text(json.dumps({'step': 30, 'mode': 'train'}) + '\n')
        self.prior = (self.training / 'latest.json').read_bytes()

    def test_owned_guard_is_reversible_and_preserves_original_bytes(self):
        plan = boundary.arm(self.training, self.audit)
        self.assertEqual(boundary.read(self.training / 'latest.json/OWNERSHIP.json'), plan)
        self.assertEqual((self.audit / 'prior_latest.json').read_bytes(), self.prior)
        with self.assertRaises(IsADirectoryError):
            boundary.atomic_json(self.training / 'latest.json', {'checkpoint': 'checkpoints/step-000000100'})
        boundary.release(self.training, self.audit)
        self.assertEqual((self.training / 'latest.json').read_bytes(), self.prior)
        self.assertEqual(len(list(self.audit.glob('released_pointer_guard_*'))), 1)
        self.assertEqual(len(list(self.training.glob('.latest.json.*.tmp'))), 1)

    def test_late_installation_and_wrong_prior_are_rejected_without_mutation(self):
        (self.training / 'train.jsonl').write_text(json.dumps({'step': 98, 'mode': 'train'}) + '\n')
        with self.assertRaisesRegex(RuntimeError, 'Too close'):
            boundary.arm(self.training, self.audit)
        self.assertEqual((self.training / 'latest.json').read_bytes(), self.prior)
        (self.training / 'train.jsonl').write_text(json.dumps({'step': 30, 'mode': 'train'}) + '\n')
        boundary.atomic_json(self.training / 'latest.json', {'checkpoint': 'checkpoints/step-000000100'})
        with self.assertRaisesRegex(RuntimeError, 'Unexpected prior'):
            boundary.arm(self.training, self.audit)

    def test_unknown_guard_contents_and_changed_inode_prevent_release(self):
        boundary.arm(self.training, self.audit)
        unknown = self.training / 'latest.json/other'
        unknown.write_text('preserve')
        with self.assertRaisesRegex(RuntimeError, 'Unknown contents'):
            boundary.release(self.training, self.audit)
        self.assertEqual(unknown.read_text(), 'preserve')
        unknown.unlink()
        info = boundary.read(self.audit / 'guard_installed.json')
        boundary.atomic_json(self.audit / 'guard_installed.json', {**info, 'inode': info['inode'] + 1})
        with self.assertRaisesRegex(RuntimeError, 'inode changed'):
            boundary.release(self.training, self.audit)

    def test_installation_failure_restores_pointer_without_leaving_guard(self):
        original = boundary.atomic_json
        def fail_installed(path, value):
            if Path(path).name == 'guard_installed.json':
                raise OSError('simulated audit write failure')
            return original(path, value)
        with patch.object(boundary, 'atomic_json', side_effect=fail_installed):
            with self.assertRaisesRegex(OSError, 'simulated'):
                boundary.arm(self.training, self.audit)
        self.assertEqual((self.training / 'latest.json').read_bytes(), self.prior)
        self.assertTrue((self.audit / 'staged_pointer_guard').is_dir())

    def test_release_can_recover_after_archiving_guard_before_pointer_write(self):
        boundary.arm(self.training, self.audit)
        original = boundary.atomic_bytes
        def fail_pointer(path, data):
            if Path(path) == self.training / 'latest.json':
                raise OSError('simulated pointer write failure')
            return original(path, data)
        with patch.object(boundary, 'atomic_bytes', side_effect=fail_pointer):
            with self.assertRaisesRegex(OSError, 'simulated'):
                boundary.release(self.training, self.audit)
        self.assertFalse((self.training / 'latest.json').exists())
        boundary.release(self.training, self.audit)
        self.assertEqual((self.training / 'latest.json').read_bytes(), self.prior)
        boundary.release(self.training, self.audit)
        self.assertEqual((self.training / 'latest.json').read_bytes(), self.prior)

    def test_only_the_exact_planned_error_and_metrics_exit_are_accepted(self):
        events = [{'event': 'start'}, {'event': 'end', 'exit_code': 1, 'log_exit_code': 0}]
        target = self.training / 'latest.json'
        text = "Traceback (most recent call last):\nIsADirectoryError: [Errno 21] Is a directory: '/tmp/.latest.json.uuid.tmp' -> '" + str(target) + "'\n"
        coordinator.validate_previous_exit(events, text, target)
        for bad in (text.replace('IsADirectoryError', 'RuntimeError'), text + 'Traceback (most recent call last):\n', text.replace(str(target), '/different/latest.json')):
            with self.assertRaises(RuntimeError):
                coordinator.validate_previous_exit(events, bad, target)
        with self.assertRaises(RuntimeError):
            coordinator.validate_previous_exit([events[0], {**events[1], 'exit_code': 0}], text, target)

    def test_exit_cmdline_race_is_not_pid_reuse_but_new_start_time_is(self):
        original = {'pid': 123, 'state': 'R', 'start_ticks': 45, 'argv': ['python', 'owned.py']}
        with patch.object(coordinator, 'process', return_value={**original, 'argv': []}):
            self.assertFalse(coordinator.live(original))
        with patch.object(coordinator, 'process', return_value={**original, 'start_ticks': 46}):
            with self.assertRaisesRegex(RuntimeError, 'reused'):
                coordinator.live(original)


@unittest.skipUnless(importlib.util.find_spec('torch') is not None, 'Server CPU torch required')
class RealCheckpointTests(unittest.TestCase):
    def test_commit100_then_pointer_failure_prevents101_and_resume_is_exact(self):
        sys.path.insert(0, str(KIT))
        spec = importlib.util.spec_from_file_location('boundary_fixture', KIT / 'tests/test_stage1_training_loop.py')
        fixtures = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fixtures)
        fixture = fixtures.TorchTrainingLoopTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        torch, loop = fixture.torch, fixtures.loop
        spec = importlib.util.spec_from_file_location('original_early_for_boundary', HERE / 'early_training_driver.py')
        original = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(original)
        rows = [fixture.rows[i % len(fixture.rows)] for i in range(40415)]
        config = {'gradient_accumulation_steps': 8, 'warmup_ratio': .03}

        def objects():
            model = fixture.make_model(dropout=.25)
            optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=2e-5, weight_decay=.01, foreach=False)
            scheduler = original.scheduler_for(optimizer, config)
            return model, optimizer, scheduler

        def run(objects, directory, **kwargs):
            model, optimizer, scheduler = objects
            with contextlib.redirect_stdout(io.StringIO()):
                return loop.run_training(model, optimizer, rows, directory, pad_id=0,
                    bindings=fixture.bindings, accumulation_steps=8, seed=3407, max_length=25316,
                    checkpoint_every=100, scheduler=scheduler, restore_adapter=fixture.restore_adapter, **kwargs)

        reference = objects()
        run(reference, fixture.root / 'reference', max_steps=101)
        reference_rng = loop._rng_state()
        training, audit = fixture.root / 'training', fixture.root / 'boundary-audit'
        run(objects(), training, max_steps=16)
        plan = boundary.arm(training, audit)
        with self.assertRaises(IsADirectoryError) as caught:
            run(objects(), training, max_steps=101, resume_from='latest')
        self.assertEqual(caught.exception.filename2, str(training / 'latest.json'))
        evidence = boundary.committed100(training, plan)
        self.assertEqual((evidence['step'], evidence['cursor']), (100, 800))
        self.assertEqual(boundary.last_record(training)['step'], 100)
        self.assertFalse((training / 'checkpoints/step-000000101').exists())
        self.assertEqual(boundary.read(training / 'TRAINING_RESULT.json')['completed_optimizer_steps'], 16)
        cp = training / 'checkpoints/step-000000100'
        expected = torch.load(fixture.root / 'reference/checkpoints/step-000000100/training_state.pt', weights_only=True)
        actual = torch.load(cp / 'training_state.pt', weights_only=True)
        # Output directories intentionally give the independent reference a
        # different RUN hash; the actual optimizer/scheduler/RNG/order match.
        self.assertTrue(loop._state_equal({k: v for k, v in expected.items() if k != 'run_sha256'},
                                         {k: v for k, v in actual.items() if k != 'run_sha256'}))
        # The latest convenience pointer may remain a guard: exact restoration
        # discovers committed checkpoint directories and performs zero updates.
        restored = objects()
        step, cursor, chosen = loop._load_checkpoint(*restored, training,
            boundary.read(training / 'RUN.json'), 'latest', fixture.restore_adapter)
        self.assertEqual((step, cursor, chosen), (100, 800, cp))
        boundary.release(training, audit, committed=True)
        self.assertEqual(boundary.read(training / 'latest.json'), {'checkpoint': 'checkpoints/step-000000100'})
        resumed = objects()
        result = run(resumed, training, max_steps=101, resume_from='latest')
        self.assertEqual(result['completed_optimizer_steps'], 101)
        self.assertTrue(torch.equal(reference[0].adapter.weight, resumed[0].adapter.weight))
        self.assertTrue(loop._state_equal(reference[1].state_dict(), resumed[1].state_dict()))
        self.assertTrue(loop._state_equal(reference[2].state_dict(), resumed[2].state_dict()))
        self.assertTrue(loop._state_equal(reference_rng, loop._rng_state()))
        self.assertEqual([json.loads(x)['step'] for x in (training / 'train.jsonl').read_text().splitlines()], list(range(1, 102)))


if __name__ == '__main__':
    unittest.main()
