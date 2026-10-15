"""Fail-closed operational boundaries, without torch/model dependencies."""
import contextlib
import fcntl
import gzip
import hashlib
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

from counseling_pipeline import stage1_preparation as prep


class PreparationBoundaries(unittest.TestCase):
    def test_path_resolution_blocks_symlink_escape(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            root = Path(a); (root/'escape').symlink_to(b, target_is_directory=True)
            with self.assertRaises(ValueError): prep.beneath(root/'escape/out.json', root)
            with self.assertRaises(ValueError): prep.beneath(root, root)
            self.assertEqual(prep.beneath(root/'inside', root), (root/'inside').resolve())

    def test_file_manifest_detects_changed_and_extra_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ('scripts','counseling_pipeline'): (root/name).mkdir()
            source = root/'scripts/start.py'; source.write_text('pass\n')
            manifest = {'schema_version':'malssi.training-kit-files.v1','files':{'scripts/start.py':{'bytes':source.stat().st_size,'sha256':prep.sha_file(source)}}}
            (root/'MANIFEST.json').write_text(json.dumps(manifest))
            prep.verify_bundle(root)
            extra = root/'scripts/extra.py'; extra.write_text('pass\n')
            with self.assertRaises(ValueError): prep.verify_bundle(root)
            extra.unlink(); source.write_text('boom\n')
            with self.assertRaises(ValueError): prep.verify_bundle(root)

    def test_gpu_in_use_and_busy_graphics_fail_without_switching(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            idle = ''.join(gpu + ', 11, 0\n' for gpu in prep.GPU_UUIDS)
            with patch.object(prep,'AUTHORIZED_ROOT',root):
                for gpu in prep.GPU_UUIDS:
                    with self.subTest(gpu=gpu):
                        with patch.object(prep.subprocess,'check_output',return_value=gpu+', 99\n'):
                            with self.assertRaises(ValueError): prep.gpu_lock(root)
                        for busy in (gpu+', 1024, 0\n', gpu+', 11, 20\n'):
                            snapshot = idle.replace(gpu+', 11, 0\n', busy)
                            with patch.object(prep.subprocess,'check_output',side_effect=['', snapshot]):
                                with self.assertRaises(ValueError): prep.gpu_lock(root)
                with patch.object(prep.subprocess,'check_output',side_effect=['', idle]):
                    handle = prep.gpu_lock(root)
                    self.assertEqual(len(handle.handles), 2)
                    handle.close(); handle.close()

    def test_second_gpu_lock_failure_releases_first_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            second = root / ('.malssi-' + prep.GPU_UUIDS[1] + '.lock')
            with second.open('a+') as occupied, patch.object(prep, 'AUTHORIZED_ROOT', root):
                fcntl.flock(occupied, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with patch.object(prep.subprocess, 'check_output') as query:
                    with self.assertRaises(BlockingIOError): prep.gpu_lock(root)
                    query.assert_not_called()
                first = root / ('.malssi-' + prep.GPU_UUIDS[0] + '.lock')
                with first.open('a+') as released:
                    fcntl.flock(released, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_dualgpu_configuration_context_and_identity(self):
        config = {'schema_version': 'malssi.stage1-dualgpu-config.v1',
                  'profile': 'original_counselor_continuation', 'max_length': 25316,
                  'packing': False, 'truncation': False, 'enable_thinking': False,
                  'micro_batch_size': 1, 'gradient_accumulation_steps': 8, 'epochs': 1,
                  'learning_rate': 2e-5, 'weight_decay': 0.01, 'warmup_ratio': 0.03,
                  'max_grad_norm': 1.0, 'seed': 3407, 'checkpoint_every': 100,
                  'lora_r': 8, 'lora_alpha': 8, 'lora_dropout': 0.0,
                  'gpu_uuids': list(prep.GPU_UUIDS), 'device_map': 'balanced',
                  'intended_use': 'stage1_research_only', 'hop_deployment_ready': False}
        with patch.object(prep, 'read_json', return_value=config):
            for length in (25316, 32768, 262144):
                config['max_length'] = length
                self.assertEqual(prep.load_config(Path('/fixture'))['max_length'], length)
            for length in (4096, 25315, 262145, 32768.0, True):
                config['max_length'] = length
                with self.assertRaises(ValueError): prep.load_config(Path('/fixture'))
            config['max_length'] = 32768
            config['gpu_uuids'].reverse()
            with self.assertRaises(ValueError): prep.load_config(Path('/fixture'))
            config['gpu_uuids'].reverse()
            config.update(device_map='layer_split', layer_split=28)
            self.assertEqual(prep.load_config(Path('/fixture'))['layer_split'], 28)
            config['layer_split'] = True
            with self.assertRaises(ValueError): prep.load_config(Path('/fixture'))

    def test_strict_layer_maps_and_boundary_assignments(self):
        self.assertEqual(prep.model_device_map({'device_map': 'balanced'}), 'balanced')
        for split in (1, 18, 28, 59):
            with self.subTest(split=split):
                result = prep.model_device_map({'device_map': 'layer_split', 'layer_split': split})
                self.assertEqual(len(result), 66)
                self.assertEqual(result['model.language_model.layers.'+str(split-1)], 0)
                self.assertEqual(result['model.language_model.layers.'+str(split)], 1)
                self.assertEqual(result['model.language_model.layers.0'], 0)
                self.assertEqual(result['model.language_model.layers.59'], 1)
                for name in ('model.vision_tower', 'model.language_model.embed_tokens', 'lm_head'):
                    self.assertEqual(result[name], 0)
                for name in ('model.embed_vision', 'model.language_model.norm', 'model.language_model.rotary_emb'):
                    self.assertEqual(result[name], 1)
        bad = [{'device_map': value} for value in ('cpu', 'auto', {'': 0}, None)]
        bad += [{'device_map': 'layer_split', 'layer_split': value}
                for value in (None, True, 0, 60, 28.0, '28')]
        bad += [{'device_map': 'balanced', 'layer_split': value} for value in (None, 28)]
        for config in bad:
            with self.subTest(config=config), self.assertRaises(ValueError): prep.model_device_map(config)

    def test_model_loader_passes_and_enforces_requested_split(self):
        config = {'device_map': 'layer_split', 'layer_split': 28, 'max_length': 32768, 'model_path': '/fixture'}
        requested = prep.model_device_map(config)
        parameters = [types.SimpleNamespace(device='cuda:'+str(i), requires_grad=True,
                                           numel=lambda: 30607360) for i in range(2)]
        model = types.SimpleNamespace(config=types.SimpleNamespace(text_config=types.SimpleNamespace(num_hidden_layers=60)),
                    hf_device_map=dict(requested), is_loaded_in_4bit=True,
                    get_input_embeddings=lambda: types.SimpleNamespace(weight=types.SimpleNamespace(device='cuda:0')),
                    get_output_embeddings=lambda: types.SimpleNamespace(weight=types.SimpleNamespace(device='cuda:0')),
                    parameters=lambda: iter(parameters),
                    named_parameters=lambda: iter([('lora_'+str(i), p) for i, p in enumerate(parameters)]))
        fast = types.SimpleNamespace(from_pretrained=Mock(return_value=(model, None)),
                                     get_peft_model=Mock(return_value=model))
        torch = types.SimpleNamespace(bfloat16=object(), set_float32_matmul_precision=Mock(),
                    cuda=types.SimpleNamespace(device_count=lambda: 2,
                        get_device_properties=lambda i: types.SimpleNamespace(uuid=prep.GPU_UUIDS[i])))
        modules = {'unsloth': types.SimpleNamespace(FastModel=fast), 'torch': torch,
                   'transformers': types.SimpleNamespace(AutoTokenizer=types.SimpleNamespace(from_pretrained=Mock()))}
        with patch.dict('sys.modules', modules):
            prep.load_model(config)
            self.assertEqual(fast.from_pretrained.call_args.kwargs['device_map'], requested)
            self.assertEqual(fast.from_pretrained.call_args.kwargs['max_seq_length'], 32768)
            model.hf_device_map['model.language_model.layers.28'] = 0
            with self.assertRaises(ValueError): prep.load_model(config)
            model.hf_device_map = dict(requested)
            model.get_output_embeddings = lambda: types.SimpleNamespace(weight=types.SimpleNamespace(device='cuda:1'))
            with self.assertRaises(ValueError): prep.load_model(config)
            model.get_output_embeddings = model.get_input_embeddings
            parameters[1].device = 'cpu'
            with self.assertRaises(ValueError): prep.load_model(config)

    def test_long_ledger_preserves_hash_split_and_target_contracts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'data').mkdir()
            ledger, files, selection = [], {}, {}
            for split in ('train', 'validation'):
                row = {'id': split, 'split': split, 'task': 'original_counselor_continuation',
                       'target_origin': 'observed_counselor_utterance', 'caregiver_perspective_assumed': False,
                       'source_group_id': split, 'source_conversation_id': split}
                raw = (json.dumps(row)+'\n').encode()
                path = root/'data'/(split+'.jsonl.gz')
                with gzip.open(path, 'wb') as stream: stream.write(raw)
                files[path.name] = {'rows': 1, 'bytes': path.stat().st_size,
                                    'sha256': prep.sha_file(path), 'uncompressed_sha256': hashlib.sha256(raw).hexdigest()}
                selection[split] = {'supervised_tokens': 4}
                ledger.append({**row, 'status': 'encoded', 'prefix_length': 25312, 'sequence_length': 25316,
                               'target_length': 4, 'template_sha256': prep.PINNED_TEMPLATE_SHA256})
            manifest = {'training_profile': 'observed_counselor_imitation', 'selected_cap': 32768,
                        'files': files, 'selection': selection}
            (root/'data/export_manifest.json').write_text(json.dumps(manifest))
            def save_ledger():
                with gzip.open(root/'data/expected_lengths.jsonl.gz', 'wt') as stream:
                    for row in ledger: stream.write(json.dumps(row)+'\n')
            save_ledger()
            with patch.object(prep, 'SPLIT_COUNTS', {'train': 1, 'validation': 1}):
                rows, _ = prep.read_rows(root, {'max_length': 25316})
                self.assertEqual(len(rows['train']), 1)
                with self.assertRaises(ValueError): prep.read_rows(root, {'max_length': 25315})
                ledger[0]['target_length'] = 5; save_ledger()
                with self.assertRaises(ValueError): prep.read_rows(root, {'max_length': 32768})
                ledger[0]['target_length'] = 4; ledger[0]['source_group_id'] = 'wrong'; save_ledger()
                with self.assertRaises(ValueError): prep.read_rows(root, {'max_length': 32768})
                ledger[0]['source_group_id'] = 'train'; save_ledger()
                manifest['files']['train.jsonl.gz']['uncompressed_sha256'] = '0'*64
                (root/'data/export_manifest.json').write_text(json.dumps(manifest))
                with self.assertRaises(ValueError): prep.read_rows(root, {'max_length': 32768})

    def test_worker_encoding_uses_configured_context(self):
        with patch.object(prep, '_MAX_LENGTH', 32768), patch.object(prep, '_TOKENIZER', object()):
            with patch.object(prep, 'encode_example', return_value={}) as encode:
                self.assertEqual(prep._encode({'id': 'long'})['id'], 'long')
                self.assertEqual(encode.call_args.kwargs['max_length'], 32768)

    def test_long_cached_rows_keep_exact_last_response_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'work/tokens').mkdir(parents=True)
            row = {'id': 'long', 'input_ids': [3]*5000, 'attention_mask': [1]*5000,
                   'labels': [-100]*4999+[3], 'sequence_length': 5000,
                   'prefix_length': 4999, 'target_length': 1, 'template_sha256': prep.PINNED_TEMPLATE_SHA256}
            manifest = {'status': 'passed', 'bindings': {'fixture': True}, 'files': {}}
            def save_cache():
                for split in ('train', 'validation'):
                    path = root/'work/tokens'/(split+'.jsonl.gz')
                    with gzip.open(path, 'wt') as stream: stream.write(json.dumps(row)+'\n')
                    manifest['files'][path.name] = {'sha256': prep.sha_file(path)}
                (root/'work/tokens/manifest.json').write_text(json.dumps(manifest))
            save_cache()
            source = {split: [{'id': 'long'}] for split in ('train', 'validation')}
            with patch.object(prep, 'load_config', return_value={'max_length': 32768}), \
                 patch.object(prep, 'read_rows', return_value=(source, {'long': dict(row)})):
                self.assertEqual(prep.load_tokens(root, {'fixture': True})['train'][0]['sequence_length'], 5000)
                row['labels'][0] = 3; save_cache()
                with self.assertRaises(ValueError): prep.load_tokens(root, {'fixture': True})

    def test_json_digest_and_report_refuse_nan(self):
        with self.assertRaises(ValueError): prep.digest({'loss':float('nan')})


if __name__ == '__main__': unittest.main()
