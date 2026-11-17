import io
import json
from pathlib import Path
from contextlib import contextmanager
import tempfile
import unittest
from unittest.mock import patch, Mock
from types import SimpleNamespace

try:
    import torch as optional_torch
except ImportError:
    optional_torch = None

import gpu31b_eval_worker as worker
import gpu31b_eval_bootstrap as bootstrap


class Layer:
    def __init__(self):
        self.lora_A, self.lora_B = {}, {}
        self.disable_adapters = False
        self.active_adapters = ['default']
        self.merged = False
        self.scaling = {'default': 1.0}


class Model:
    def __init__(self):
        self.layers = [Layer(), Layer()]
        self.generate = Mock()
    def named_modules(self):
        return iter([('', self)] + [(str(i), layer) for i, layer in enumerate(self.layers)])
    @contextmanager
    def disable_adapter(self):
        for layer in self.layers:
            layer.disable_adapters = True
        try:
            yield
        finally:
            for layer in self.layers:
                layer.disable_adapters = False


class PayloadTests(unittest.TestCase):
    def payload(self, **extra):
        return dict({'model': 'malssi-gemma4-31b-controlled', 'messages': [{'role': 'user', 'content': 'test'}],
                     'max_tokens': 8192, 'temperature': 0, 'seed': 3407, 'cache_prompt': False,
                     'stream': False, 'lora': [{'id': 0, 'scale': 0}]}, **extra)

    def test_both_arms_have_explicit_identity(self):
        self.assertEqual(worker.parse_payload(self.payload())['model'], worker.BASE_ALIAS)
        self.assertEqual(worker.parse_payload(self.payload(lora=[{'id': 0, 'scale': 1}]))['model'], worker.TRAINED_ALIAS)
        self.assertEqual(worker.parse_payload(self.payload(reasoning_effort='none'))['seed'], 3407)

    def test_invalid_generation_and_lora_inputs_rejected(self):
        changes = [dict(temperature=.2), dict(top_p=.9), dict(seed=12), dict(cache_prompt=True),
                   dict(max_tokens=8193), dict(max_tokens=True), dict(stream=True), dict(n=True),
                   dict(lora=[]), dict(lora=[{'id': 1, 'scale': 1}]),
                   dict(lora=[{'id': 0, 'scale': .5}]), dict(lora=[{'id': 0, 'scale': True}]),
                   dict(lora=[{'id': 0, 'scale': float('nan')}]), dict(reasoning_effort='high'),
                   dict(response_format={'type': 'json_object'}), dict(unexpected=True)]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(worker.RequestError):
                worker.parse_payload(self.payload(**change))

    def test_own_alias_must_match_scale(self):
        with self.assertRaisesRegex(worker.RequestError, 'disagree'):
            worker.parse_payload(self.payload(model=worker.TRAINED_ALIAS))
        value = self.payload(model=worker.BASE_ALIAS); value.pop('lora')
        self.assertEqual(worker.parse_payload(value)['scale'], 0)

    def test_messages_are_text_only(self):
        for messages in [[], [{'role': 'tool', 'content': 'x'}], [{'role': 'user', 'content': []}],
                         [{'role': 'user', 'content': 'x', 'other': 'x'}]]:
            with self.assertRaises(worker.RequestError):
                worker.parse_payload(self.payload(messages=messages))

    def test_context_rejection_precedes_any_model_call(self):
        model, tokenizer = Model(), Mock()
        tokenizer.apply_chat_template.return_value = [1] * worker.CONTEXT_TOKENS
        state = {'model': model, 'tokenizer': tokenizer, 'torch': Mock(), 'speed': Mock()}
        with self.assertRaises(worker.RequestError) as caught:
            worker.generate(state, self.payload())
        self.assertEqual(caught.exception.code, 'context_length_exceeded')
        model.generate.assert_not_called()
        self.assertEqual(tokenizer.apply_chat_template.call_args.kwargs,
                         {'tokenize': True, 'add_generation_prompt': True, 'enable_thinking': False})

    def test_context_boundary_is_inclusive_without_truncation(self):
        tokenizer = Mock(); tokenizer.apply_chat_template.return_value = [1] * (worker.CONTEXT_TOKENS - 2)
        self.assertEqual(len(worker.tokenize_full(tokenizer, [], 2)), worker.CONTEXT_TOKENS - 2)
        with self.assertRaises(worker.RequestError):
            worker.tokenize_full(tokenizer, [], 3)


class AdapterTests(unittest.TestCase):
    def test_disabled_context_restores_after_error(self):
        model, evidence = Model(), {}
        with self.assertRaisesRegex(ValueError, 'failure'):
            with worker.selected_adapter(model, 0, evidence):
                self.assertTrue(all(worker.adapter_flags(model).values()))
                raise ValueError('failure')
        self.assertFalse(any(worker.adapter_flags(model).values()))
        self.assertTrue(all(evidence['adapter_flags_during'].values()))
        self.assertEqual(evidence['adapter_flags_before'], evidence['adapter_flags_after'])

    def test_trained_context_leaves_actual_layers_enabled(self):
        model, evidence = Model(), {}
        with worker.selected_adapter(model, 1, evidence):
            self.assertFalse(any(worker.adapter_flags(model).values()))
        self.assertFalse(any(evidence['adapter_flags_during'].values()))

    def test_zero_scale_qualification_control_restores_on_error(self):
        model, evidence = Model(), {}
        with self.assertRaises(ValueError):
            with worker.zero_adapter_scaling(model, evidence):
                self.assertEqual([layer.scaling['default'] for layer in model.layers], [0, 0])
                raise ValueError()
        self.assertEqual([layer.scaling['default'] for layer in model.layers], [1, 1])
        self.assertTrue(evidence['scaling_restored'])

    def test_merged_or_wrong_adapter_cannot_silently_run(self):
        model = Model(); model.layers[0].merged = True
        with self.assertRaises(RuntimeError):
            worker.adapter_flags(model)
        model.layers[0].merged = False; model.layers[0].active_adapters = ['other']
        with self.assertRaises(RuntimeError):
            worker.adapter_flags(model)

    def test_only_transient_cache_metadata_removed(self):
        model = Model(); model._cache = object(); model.layers[0]._previous_max_cache_length = 40
        self.assertEqual(len(worker.clear_request_cache(model)), 2)
        self.assertFalse(hasattr(model, '_cache'))
        self.assertEqual(model.layers[0].scaling, {'default': 1.0})



@unittest.skipIf(optional_torch is None, 'Existing torch runtime is optional for CPU logit proof tests')
class FunctionalQualificationTests(unittest.TestCase):
    def state(self, broken=False):
        torch = optional_torch
        model, tokenizer = Model(), Mock()
        model.get_input_embeddings = lambda: SimpleNamespace(weight=SimpleNamespace(device='cpu'))
        tokenizer.apply_chat_template.return_value = [1, 2, 3]
        def generate(**kwargs):
            disabled = all(layer.disable_adapters for layer in model.layers)
            zero = all(layer.scaling['default'] == 0 for layer in model.layers)
            delta = 0 if disabled or zero else .25
            scores = [torch.tensor([[1.0 + delta, 2.0, -float('inf')]]) for _ in range(2)]
            if broken and zero:
                scores[1][0, 0] += .5
            return SimpleNamespace(scores=scores, sequences=torch.tensor([[1, 2, 3, 4, 5]]))
        model.generate.side_effect = generate
        return {'model': model, 'tokenizer': tokenizer, 'torch': torch}

    def test_actual_prefill_and_decode_control_with_equal_negative_inf(self):
        state = self.state()
        with patch.object(worker, 'verify_unchanged'), patch.object(optional_torch.cuda, 'synchronize'), patch.object(optional_torch.cuda, 'manual_seed_all'):
            result = worker.qualify_adapter_disable(state)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['actual_generated_tokens'], 6)
        self.assertEqual(result['disabled_zero_max_absolute_logit_difference'], [0.0, 0.0])
        self.assertGreater(result['enabled_disabled_first_step_max_absolute_logit_difference'], 0)
        self.assertFalse(any(worker.adapter_flags(state['model']).values()))
        self.assertEqual([layer.scaling['default'] for layer in state['model'].layers], [1, 1])

    def test_decode_mismatch_blocks_and_restores_all_adapter_metadata(self):
        state = self.state(broken=True)
        with patch.object(worker, 'verify_unchanged'), patch.object(optional_torch.cuda, 'synchronize'), patch.object(optional_torch.cuda, 'manual_seed_all'):
            with self.assertRaises(worker.RequestError) as caught:
                worker.qualify_adapter_disable(state)
        self.assertEqual(caught.exception.code, 'adapter_disable_qualification_failed')
        self.assertFalse(caught.exception.evidence['disabled_matches_zero_scaling'])
        self.assertEqual([layer.scaling['default'] for layer in state['model'].layers], [1, 1])
        self.assertFalse(any(worker.adapter_flags(state['model']).values()))


class ServeAndBoundaryTests(unittest.TestCase):
    def test_request_rejection_does_not_kill_resident_worker(self):
        emitted, report = [], {'requests': []}
        lines = 'broken\n' + json.dumps({'id': 'bad', 'payload': {}}) + '\n' + json.dumps({'id': 'ok', 'payload': {'valid': True}}) + '\n'
        def generate(state, payload):
            if not payload:
                raise worker.RequestError('invalid_request', 'bad request')
            return {'choices': []}, {'output_ids_sha256': 'a' * 64}
        with tempfile.TemporaryDirectory() as directory, patch.object(worker, 'generate', side_effect=generate):
            worker.serve({}, io.StringIO(lines), emitted.append, report, Path(directory))
        self.assertEqual(len(emitted), 3)
        self.assertEqual(emitted[0]['error']['code'], 'invalid_json')
        self.assertEqual(emitted[1]['error']['code'], 'invalid_request')
        self.assertIn('response', emitted[2])
        self.assertEqual(len(report['requests']), 3)

    def test_nonfinite_json_is_rejected_without_process_error(self):
        emitted, report = [], {'requests': []}
        with tempfile.TemporaryDirectory() as directory:
            worker.serve({}, io.StringIO('{"id":1,"payload":{"temperature":NaN}}\n'), emitted.append, report, Path(directory))
        self.assertEqual(emitted[0]['error']['code'], 'invalid_json')

    def test_work_path_cannot_escape_fixed_task(self):
        self.assertEqual(bootstrap.selected_work('work/worker-v1'), bootstrap.TASK / 'work/worker-v1')
        for value in ['/tmp/job', '../job', 'work/../../job', 'code/worker']:
            with self.assertRaises(RuntimeError):
                bootstrap.selected_work(value)

    def test_cache_paths_are_all_relative_and_inside_work(self):
        for value in bootstrap.CACHE_PATHS.values():
            self.assertFalse(Path(value).is_absolute())
            self.assertNotIn('..', Path(value).parts)


if __name__ == '__main__':
    unittest.main()
