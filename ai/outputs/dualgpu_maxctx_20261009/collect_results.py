#!/usr/bin/env python3
"""Read-only verification and privacy-filtered collection for the pinned stage-1 kit.

Only a new work/collection/results-<UTC>-<random>/ directory is written. Existing
training artifacts are never changed. No torch imports, pickle loads, GPU calls,
network access, or training commands are used. Exit 0 means verified completion;
--allow-incomplete permits an explicitly incomplete report and also exits 0.
"""
import argparse
import collections
import csv
import datetime as dt
import hashlib
import gzip
import io
import json
import math
from pathlib import Path
import re
import stat
import sys
import types
import uuid
import zipfile

GPU_UUIDS = ('GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c',
             'GPU-a2d3d60c-4eae-7e46-45bc-146e24457642')
TEMPLATE_SHA256 = '845f1ee48e39fc942fe190da9df6a1c5db229e17a96ea08966ad1c9274e73d1b'
SPLITS = {'train': (40415, 3291230), 'validation': (4298, 362003)}
PREPARATION_CHECKS = ('token_contract', 'fused_loss', 'fused_gradient',
                      'tiled_mlp_equivalence', 'generation_profile', 'gpu_pin', 'weights_unchanged')
CANARY_CHECKS = ('weights_updated', 'checkpoint_saved', 'checkpoint_resumed', 'longest_source_context')
CANARY_ARTIFACTS = (
    'canary/RUN.json', 'canary/TRAINING_RESULT.json', 'canary_execution.json',
    'canary-resume_execution.json', 'canary/checkpoints/step-000000002/CHECKPOINT.json',
    'canary/checkpoints/step-000000003/CHECKPOINT.json', 'canary/train.jsonl',
)
TRAIN_FIELDS = ('step', 'next_row_cursor', 'microbatches', 'supervised_tokens',
                'target_mean_loss', 'gradient_norm_before_clip', 'learning_rates',
                'elapsed_seconds', 'mode')
CONFIG_NUMBERS = ('max_length', 'micro_batch_size', 'gradient_accumulation_steps',
                  'epochs', 'learning_rate', 'weight_decay', 'warmup_ratio',
                  'max_grad_norm', 'seed', 'checkpoint_every', 'lora_r', 'lora_alpha',
                  'lora_dropout')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value, *, ascii=False):
    return json.dumps(value, sort_keys=True, separators=(',', ':'),
                      ensure_ascii=ascii, allow_nan=False).encode('utf-8')


def digest(value, *, ascii=False):
    return hashlib.sha256(canonical(value, ascii=ascii)).hexdigest()


def is_sha(value):
    return isinstance(value, str) and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def number(value, *, minimum=0):
    return type(value) in (int, float) and math.isfinite(value) and value >= minimum


def integer(value, *, minimum=0):
    return type(value) is int and value >= minimum


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'Duplicate JSON key')
        result[key] = value
    return result


def parse_json(data):
    value = json.loads(data, object_pairs_hook=unique_object)
    canonical(value)  # Reject NaN, Infinity, and exponent overflow at every depth.
    return value


class Collector:
    def __init__(self, kit):
        self.kit = Path(kit).absolute()
        require(self.kit == self.kit.resolve() and self.kit.is_dir(),
                'Kit must be an existing absolute directory without symlinks')
        self.sources = {}
        self.errors = []
        self.warnings = []
        self.exports = {}
        self.bound = None
        self.config = None
        self.summary = {
            'schema_version': 'malssi.stage1-dualgpu-collection.v1',
            'created_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
            'kit_path': str(self.kit), 'gpu_uuids': list(GPU_UUIDS),
            'stage1_sft_completed': False, 'hop_deployment_ready': False,
            'behavioral_evaluation': 'not_verified_by_this_collector',
            'scope': 'original_counselor_last_response_sft',
        }

    def path(self, name):
        relative = Path(name)
        require(not relative.is_absolute() and bool(relative.parts)
                and '..' not in relative.parts, 'Unsafe relative artifact path')
        path = self.kit / relative
        require(path.resolve() == path and path.is_relative_to(self.kit),
                'Artifact symlink or path escape rejected')
        return path

    def read(self, name, *, contents=True):
        path = self.path(name)
        before = path.stat()
        require(stat.S_ISREG(before.st_mode), 'Artifact is not a regular file')
        sha = hashlib.sha256()
        chunks = []
        with path.open('rb') as handle:
            for block in iter(lambda: handle.read(8 * 1024 * 1024), b''):
                sha.update(block)
                if contents:
                    chunks.append(block)
        after = path.stat()
        signature = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        require(signature == (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns),
                'Artifact changed while being read')
        previous = self.sources.get(name)
        require(previous is None or previous['sha256'] == sha.hexdigest(),
                'Artifact changed between verification stages')
        self.sources[name] = {'sha256': sha.hexdigest(), 'bytes': after.st_size,
                              '_signature': signature}
        return b''.join(chunks) if contents else sha.hexdigest()

    def sha(self, name):
        return self.read(name, contents=False)

    def json(self, name):
        result = parse_json(self.read(name))
        require(isinstance(result, dict), 'Expected JSON object')
        return result

    def export(self, name, value):
        # Every caller builds an explicit projection; raw source dictionaries are never exported.
        self.exports[name] = json.dumps(value, ensure_ascii=False, indent=2,
                                        allow_nan=False).encode('utf-8') + b'\n'

    def check(self, section, function):
        try:
            value = function()
            self.summary[section] = value
            return value
        except (ValueError, KeyError, TypeError, AttributeError, OSError, OverflowError, csv.Error) as exc:
            # Exception values may contain source text/IDs. Publish only controlled section/type.
            self.errors.append({'section': section, 'error_type': type(exc).__name__})
            self.summary[section] = {'verified': False}
            return None

    def bindings(self, report):
        require(self.bound is not None and report.get('bindings') == self.bound,
                'Artifact bindings mismatch')

    def verify_identity(self):
        manifest = self.json('MANIFEST.json')
        require(manifest.get('schema_version') == 'malssi.training-kit-files.v1',
                'Wrong kit manifest schema')
        files = manifest['files']
        require(isinstance(files, dict) and bool(files), 'Empty kit manifest')
        for name, entry in files.items():
            require(self.sha(name) == entry['sha256']
                    and self.sources[name]['bytes'] == entry['bytes'], 'Kit hash mismatch')
        code = {}
        for directory in ('counseling_pipeline', 'scripts'):
            root = self.path(directory)
            actual = {str(p.relative_to(self.kit)) for p in root.rglob('*.py')}
            declared = {p for p in files if p.startswith(directory + '/') and p.endswith('.py')}
            require(actual == declared and actual, 'Code inventory mismatch')
            for name in sorted(actual):
                code[name] = self.sha(name)
        config = self.json('config/train.json')
        actual = {
            'dataset_sha256': digest({n: self.sha('data/' + n) for n in
                ('train.jsonl.gz', 'validation.jsonl.gz', 'expected_lengths.jsonl.gz',
                 'export_manifest.json')}, ascii=True),
            'config_sha256': digest(config, ascii=True),
            'model_sha256': digest(self.json('config/model_fingerprint.json'), ascii=True),
            'template_sha256': TEMPLATE_SHA256,
            'code_sha256': digest(code, ascii=True),
            'environment_sha256': self.sha('config/requirements.server.freeze.txt'),
        }
        required_files = {'run.sh', 'config/train.json', 'config/model_fingerprint.json',
                          'config/requirements.server.freeze.txt', 'data/train.jsonl.gz',
                          'data/validation.jsonl.gz', 'data/expected_lengths.jsonl.gz', 'data/export_manifest.json'}
        require(required_files <= set(files), 'Manifest omits immutable input artifacts')
        require(config.get('schema_version') == 'malssi.stage1-dualgpu-config.v1'
                and config.get('gpu_uuids') == list(GPU_UUIDS)
                and type(config.get('max_length')) is int and 25316 <= config['max_length'] <= 262144,
                'Invalid dual-GPU context configuration')
        for key, value in {'profile': 'original_counselor_continuation', 'packing': False,
                           'truncation': False, 'enable_thinking': False, 'micro_batch_size': 1,
                           'gradient_accumulation_steps': 8, 'epochs': 1, 'learning_rate': 2e-5,
                           'weight_decay': 0.01, 'warmup_ratio': 0.03, 'max_grad_norm': 1.0,
                           'seed': 3407, 'checkpoint_every': 100, 'lora_r': 8, 'lora_alpha': 8,
                           'lora_dropout': 0.0, 'hop_deployment_ready': False}.items():
            require(type(config.get(key)) is type(value) and config[key] == value, 'Invalid training setting')
        require(config.get('device_map') in ('balanced', 'layer_split'), 'Invalid device map')
        require(('layer_split' not in config) if config['device_map'] == 'balanced'
                else type(config.get('layer_split')) is int and 1 <= config['layer_split'] <= 59,
                'Invalid layer split')
        require(type(config.get('unsloth_tiled_mlp', False)) is bool, 'Invalid tiled MLP setting')
        self.bound = actual
        self.config = config
        safe_config = {k: config[k] for k in CONFIG_NUMBERS if number(config.get(k))}
        safe_config.update({k: config[k] for k in ('packing', 'truncation', 'enable_thinking')
                            if type(config.get(k)) is bool})
        require(re.fullmatch(r'[0-9a-f]{40}', config['model_revision']) is not None,
                'Invalid model revision')
        safe_config.update({'model': 'gemma-4-31B-it-unsloth-bnb-4bit',
                            'device_map': config['device_map'], 'layer_split': config.get('layer_split'),
                            'unsloth_tiled_mlp': config.get('unsloth_tiled_mlp', False),
                            'model_revision': config['model_revision'],
                            'training_method': '4-bit QLoRA; BF16 compute; AdamW foreach=False',
                            'lora_selection': {'language_layers': True, 'attention_modules': True,
                                               'mlp_modules': True, 'vision_layers': False,
                                               'explicit_target_modules_argument': None}})
        self.export('config.sanitized.json', safe_config)
        result = {'verified': True, 'bindings': actual, 'manifest_files_verified': len(files),
                  'manifest_sha256': self.sources['MANIFEST.json']['sha256'],
                  'configuration': safe_config,
                  'live_model_environment_rechecked': False}
        self.export('bundle.sanitized.json', result)
        return result

    def verify_source_data(self):
        manifest = self.json('data/export_manifest.json')
        require(manifest.get('selected_cap') == 32768
                and manifest.get('training_profile') == 'observed_counselor_imitation', 'Invalid full-source export')
        ledger = {}
        with gzip.open(self.path('data/expected_lengths.jsonl.gz'), 'rb') as stream:
            for line in stream:
                row = parse_json(line)
                require(row['id'] not in ledger and row.get('status') == 'encoded'
                        and row.get('template_sha256') == TEMPLATE_SHA256, 'Invalid length ledger')
                require(all(integer(row.get(k), minimum=1) for k in
                            ('sequence_length', 'prefix_length', 'target_length'))
                        and row['sequence_length'] == row['prefix_length'] + row['target_length']
                        and row['sequence_length'] <= min(32768, self.config['max_length']), 'Invalid source length')
                ledger[row['id']] = row
        require(len(ledger) == 44713 and max(r['sequence_length'] for r in ledger.values()) == 25316,
                'Incomplete full-source ledger')
        used, groups, conversations, splits = set(), {}, {}, {}
        for split, (expected_rows, expected_tokens) in SPLITS.items():
            path = 'data/' + split + '.jsonl.gz'
            entry = manifest['files'][split + '.jsonl.gz']
            require(self.sha(path) == entry['sha256'] and self.sources[path]['bytes'] == entry['bytes'],
                    'Source gzip hash mismatch')
            raw_sha = hashlib.sha256()
            count = supervised = inputs = 0
            groups[split], conversations[split] = set(), set()
            with gzip.open(self.path(path), 'rb') as stream:
                for line in stream:
                    raw_sha.update(line)
                    row = parse_json(line)
                    require(row['id'] not in used and row.get('split') == split
                            and row.get('task') == 'original_counselor_continuation'
                            and row.get('target_origin') == 'observed_counselor_utterance'
                            and row.get('caregiver_perspective_assumed') is False, 'Invalid source supervision')
                    length = ledger[row['id']]
                    require(all(length[k] == row[k] for k in ('split', 'source_group_id', 'source_conversation_id')),
                            'Source/ledger identity mismatch')
                    used.add(row['id']); groups[split].add(row['source_group_id'])
                    conversations[split].add(row['source_conversation_id'])
                    count += 1; supervised += length['target_length']; inputs += length['sequence_length']
            require(count == expected_rows == entry['rows'] and supervised == expected_tokens
                    and raw_sha.hexdigest() == entry['uncompressed_sha256'], 'Source count/hash mismatch')
            selection = manifest['selection'][split]
            require(selection['supervised_tokens'] == supervised and selection['full_tokens'] == inputs,
                    'Export/ledger token totals mismatch')
            splits[split] = {'rows': count, 'supervised_tokens': supervised, 'input_tokens': inputs}
        require(set(ledger) == used and not groups['train'] & groups['validation']
                and not conversations['train'] & conversations['validation'], 'Source split leakage')
        result = {'verified': True, 'splits': splits, 'longest_source_sequence_length': 25316}
        self.export('source_data.sanitized.json', result)
        return result

    def verify_tokens(self):
        report = self.json('work/tokens/manifest.json')
        self.bindings(report)
        require(report.get('status') == 'passed', 'Token cache did not pass')
        safe = {}
        for split, (rows, tokens) in SPLITS.items():
            inputs = self.summary['source_data']['splits'][split]['input_tokens']
            name = split + '.jsonl.gz'
            entry = report['files'][name]
            require(entry['rows'] == rows and entry['supervised_tokens'] == tokens
                    and entry['input_tokens'] == inputs, 'Token counts mismatch')
            sha = self.sha('work/tokens/' + name)
            require(sha == entry['sha256'], 'Token cache hash mismatch')
            safe[split] = {'rows': rows, 'supervised_tokens': tokens,
                           'input_tokens': inputs, 'cache_sha256': sha}
        self.export('tokens.sanitized.json', safe)
        return {'verified': True, 'splits': safe,
                'mask': 'last_response_and_native_end_only; shifted_nonignored_target_tokens',
                'cache_contents_retokenized': False}

    def gate(self, name, mode, steps, expected_checks):
        report = self.json(name)
        self.bindings(report)
        # Reuse the pinned JSON-only validator, including its fixed numeric
        # tolerances and generation provenance checks. Compile verified source
        # bytes directly so neither stale bytecode nor installed packages can
        # override this kit. All three modules use only the standard library.
        package = '_malssi_verified_gate_' + uuid.uuid4().hex
        loaded = []
        old_bytecode = sys.dont_write_bytecode
        sys.dont_write_bytecode = True
        try:
            namespace = types.ModuleType(package)
            namespace.__path__ = []
            sys.modules[package] = namespace
            loaded.append(package)
            for module_name in ('gemma4_token_validation', 'gemma4_generation_validation',
                                'stage1_readiness'):
                relative = 'counseling_pipeline/' + module_name + '.py'
                qualified = package + '.' + module_name
                module = types.ModuleType(qualified)
                module.__package__ = package
                module.__file__ = str(self.path(relative))
                sys.modules[qualified] = module
                loaded.append(qualified)
                exec(compile(self.read(relative), module.__file__, 'exec'), module.__dict__)
                setattr(namespace, module_name, module)
            contracts = {'fused_loss': 'bf16_linear_fp32_softcap_v1',
                         'fused_gradient': 'hidden_gradient_bf16_v1'} if mode == 'preparation' else None
            if contracts is not None and 'tiled_mlp_equivalence' in expected_checks:
                contracts['tiled_mlp_equivalence'] = 'tiled_mlp_bf16_v1'
            module.validate_report(report, expected_bindings=self.bound,
                                   required_checks=expected_checks, mode=mode,
                                   expected_check_contracts=contracts)
        finally:
            for loaded_name in reversed(loaded):
                sys.modules.pop(loaded_name, None)
            sys.dont_write_bytecode = old_bytecode
        require(report.get('schema_version') == 'malssi.stage1-readiness.v1'
                and report.get('mode') == mode and report.get('status') == 'passed'
                and type(report.get('optimizer_steps')) is int
                and report['optimizer_steps'] == steps, 'Gate header mismatch')
        checks = report['checks']
        require(isinstance(checks, list) and checks, 'Missing gate checks')
        names = [c['name'] for c in checks]
        require(len(names) == len(set(names)) and set(expected_checks) <= set(names),
                'Missing or duplicate gate checks')
        require(all(c.get('passed') is True and c.get('status', 'passed') == 'passed'
                    and isinstance(c.get('evidence'), dict) and c['evidence'] for c in checks),
                'Gate check failed')
        return report, {c['name']: c['evidence'] for c in checks}

    def verify_qualification(self):
        require(self.config is not None, 'Kit identity must verify before qualification')
        required = tuple(n for n in PREPARATION_CHECKS
                         if n != 'tiled_mlp_equivalence' or self.config.get('unsloth_tiled_mlp', False))
        report, checks = self.gate('work/qualification.json', 'preparation', 0,
                                   required)
        for name, criterion in (('fused_loss', 'bf16_linear_fp32_softcap_v1'),
                                ('fused_gradient', 'hidden_gradient_bf16_v1')):
            require(checks[name].get('criterion') == criterion, 'Qualification contract mismatch')
        gpu = checks['gpu_pin']
        require(gpu.get('requested_uuids') == list(GPU_UUIDS) and gpu.get('actual_uuids') == list(GPU_UUIDS)
                and set(gpu['placement']) == {'cuda:0', 'cuda:1'}, 'Qualification GPU mismatch')
        placement = {}
        for device in ('cuda:0', 'cuda:1'):
            placement[device] = {key: gpu['placement'][device][key] for key in ('tensors', 'elements', 'trainable_tensors')}
            require(all(integer(v, minimum=1) for v in placement[device].values()), 'Invalid GPU placement evidence')
        require(checks['token_contract'].get('context_budget') == self.config['max_length'], 'Qualification context mismatch')
        upstream = checks['fused_gradient']['upstream_gradients_by_device']
        require(set(upstream) == {'cuda:0', 'cuda:1'} and all(
            v.get('all_finite') is True and integer(v.get('tensors'), minimum=1)
            and number(v.get('l2_norm')) for v in upstream.values()), 'Missing two-GPU finite backward evidence')
        same = checks['weights_unchanged']
        require(is_sha(same.get('before')) and same.get('before') == same.get('after')
                and same.get('optimizer_steps') == 0, 'Qualification updated weights')
        losses, gradients = [], []
        for item in checks['fused_loss']['comparisons']:
            values = {k: item[k] for k in ('actual', 'reference', 'atol', 'rtol')}
            require(all(number(v) for v in values.values()) and item.get('passed') is True,
                    'Invalid loss comparison')
            require(abs(values['actual'] - values['reference']) <= values['atol']
                    + values['rtol'] * abs(values['reference']), 'Loss tolerance exceeded')
            losses.append(values)
        for item in checks['fused_gradient']['results']:
            values = {k: item[k] for k in ('relative_l2_error', 'maximum_relative_l2_error',
                                          'cosine', 'minimum_cosine', 'reference_norm')}
            require(all(number(v) for v in values.values()) and item.get('passed') is True
                    and values['relative_l2_error'] <= values['maximum_relative_l2_error']
                    and values['cosine'] >= values['minimum_cosine']
                    and values['reference_norm'] > 0, 'Invalid gradient comparison')
            gradients.append(values)
        require(losses and gradients, 'Missing numerical comparisons')
        # No generation cases, raw/prefill/suffix IDs, source IDs or arbitrary evidence values.
        safe = {'verified': True, 'optimizer_steps': 0, 'bindings': self.bound,
                'source_sha256': self.sources['work/qualification.json']['sha256'],
                'checks': [{'name': name, 'passed': True} for name in required],
                'gpu_uuids': list(GPU_UUIDS), 'parameter_placement': placement,
                'loss_criterion': 'bf16_linear_fp32_softcap_v1',
                'gradient_criterion': 'hidden_gradient_bf16_v1',
                'loss_comparisons': losses, 'gradient_comparisons': gradients,
                'generation_case_count': len(checks['generation_profile'].get('cases', [])),
                'fresh_gpu_reexecution': False,
                'validation_scope': 'saved status, bindings, contracts, numerical tolerances and unchanged-weight evidence; probes not rerun'}
        if 'tiled_mlp_equivalence' in checks:
            safe['tiled_mlp_equivalence'] = self.tiled_evidence(checks['tiled_mlp_equivalence'])
        self.export('qualification.sanitized.json', safe)
        return safe

    def tiled_evidence(self, evidence):
        require(evidence.get('criterion') == 'tiled_mlp_bf16_v1' and evidence.get('passed') is True
                and evidence.get('patched_language_mlp_count') == 60 and evidence.get('optimizer_steps') == 0
                and evidence.get('weights_unchanged') is True and evidence.get('synthetic_inputs') is True
                and is_sha(evidence.get('adapter_hash_before'))
                and evidence.get('adapter_hash_before') == evidence.get('adapter_hash_after'), 'Invalid tiled MLP gate')
        modules = evidence['modules']
        require(len(modules) == 2 and {m['device'] for m in modules} == {'cuda:0', 'cuda:1'}, 'Tiled gate must cover both GPUs')
        safe = []
        for module in modules:
            calls = ([{'shape': [1, 5376, 5376], 'grad_enabled': False}] * 2
                     + [{'shape': [1, 5376, 5376], 'grad_enabled': True}] * 2)
            require(module.get('passed') is True and module.get('input_shape') == [1, 10752, 5376]
                    and module.get('expected_tiles') == 2 and module.get('observed_tile_calls') == calls,
                    'Tiled gate did not execute the expected two tiles')
            metrics = module['metrics']
            require(isinstance(metrics['lora_gradients'], dict) and metrics['lora_gradients'], 'Missing tiled LoRA evidence')
            values = [metrics['output'], metrics['hidden_gradient'], *metrics['lora_gradients'].values()]
            for item in values:
                require(all(number(item.get(k)) for k in ('reference_norm', 'observed_norm', 'relative_l2_error', 'cosine'))
                        and item.get('passed') is True, 'Invalid tiled numerical metric')
                zeros = item['reference_norm'] == item['observed_norm'] == 0
                require(item.get('both_exactly_zero') is zeros and (zeros or item['reference_norm'] > 0
                        and item['relative_l2_error'] <= .02 and .999 <= item['cosine'] <= 1.000001), 'Tiled tolerance exceeded')
            safe.append({'device': module['device'], 'input_shape': [1, 10752, 5376], 'tiles': 2,
                         'lora_tensor_count': len(metrics['lora_gradients']),
                         'maximum_relative_l2_error': max(v['relative_l2_error'] for v in values),
                         'minimum_cosine': min(v['cosine'] for v in values), 'passed': True})
        return {'criterion': 'tiled_mlp_bf16_v1', 'patched_language_mlp_count': 60, 'modules': safe,
                'weights_unchanged': True, 'synthetic_inputs': True}

    def run(self, directory, mode, rows, steps):
        run = self.json(directory + '/RUN.json')
        self.bindings(run)
        require(run.get('schema_version') == 1 and run.get('mode') == mode
                and run.get('output_directory') == str(self.path(directory)), 'Run identity mismatch')
        plan = run['plan']
        require(plan['rows'] == rows and plan['optimizer_steps'] == steps
                and is_sha(plan['encoded_rows_sha256']), 'Run plan mismatch')
        order = plan['order']
        require(isinstance(order, list) and len(order) == rows
                and all(type(i) is int for i in order) and set(order) == set(range(rows)),
                'Run order is not a complete index permutation')
        settings = run['settings']
        for key, value in {'epochs': 1, 'microbatch_size': 1, 'accumulation_steps': 8,
                           'max_length': self.config['max_length'], 'seed': 3407, 'clip_grad_norm': 1.0}.items():
            require(settings.get(key) == value, 'Run setting mismatch')
        require(settings.get('shuffle') is (mode == 'train'), 'Run shuffle mismatch')
        require(plan['supervised_tokens'] == 3291230 if mode == 'train'
                else integer(plan['supervised_tokens'], minimum=1), 'Run token count mismatch')
        safe = {'schema_version': 1, 'mode': mode, 'bindings': self.bound,
                'run_sha256': digest(run), 'rows': rows, 'optimizer_steps': steps,
                'supervised_tokens': plan['supervised_tokens'],
                'encoded_rows_sha256': plan['encoded_rows_sha256'],
                'order_sha256': digest(order), 'order_indices_redacted': True}
        self.export(directory + '/RUN.sanitized.json', safe)
        return run

    def checkpoint(self, directory, run, step, cursor):
        relative = directory + '/checkpoints/step-' + str(step).zfill(9)
        root = self.path(relative)
        manifest = self.json(relative + '/CHECKPOINT.json')
        require(manifest.get('schema_version') == 1 and manifest.get('step') == step
                and manifest.get('cursor') == cursor
                and manifest.get('run_sha256') == digest(run)
                and is_sha(manifest.get('adapter_parameters_sha256')), 'Checkpoint identity mismatch')
        files = manifest['files']
        require(isinstance(files, dict) and 'training_state.pt' in files
                and any(k.startswith('adapter_model.') or k.startswith('adapter_model-')
                        for k in files), 'Checkpoint inventory incomplete')
        actual = {str(p.relative_to(root)) for p in root.rglob('*')
                  if p.is_file() and p.name != 'CHECKPOINT.json'}
        require(actual == set(files), 'Checkpoint inventory mismatch')
        for name, expected in files.items():
            require(re.fullmatch(r'(README\.md|adapter_config\.json|training_state\.pt|'
                    r'adapter_model(?:-\d+-of-\d+)?\.(?:safetensors|bin)|'
                    r'adapter_model\.safetensors\.index\.json)', name) is not None,
                    'Unexpected checkpoint filename')
            require(is_sha(expected) and self.sha(relative + '/' + name) == expected,
                    'Checkpoint file hash mismatch')
        safe = {'schema_version': 1, 'step': step, 'cursor': cursor,
                'run_sha256': digest(run), 'files': {k: files[k] for k in sorted(files)},
                'adapter_parameters_sha256': manifest['adapter_parameters_sha256'],
                'manifest_sha256': self.sources[relative + '/CHECKPOINT.json']['sha256'],
                'actual_file_hashes_verified': True, 'tensor_state_deserialized': False}
        self.export(relative + '/CHECKPOINT.sanitized.json', safe)
        return safe

    def result(self, result, directory, run, steps, rows, *, completed=True):
        require(result.get('schema_version') == 1 and result.get('mode') == run['mode']
                and result.get('status') == ('completed' if completed else 'step_cap_reached')
                and result.get('completed_optimizer_steps') == steps
                and result.get('next_row_cursor') == rows
                and result.get('epoch_completed') is completed
                and result.get('run_sha256') == digest(run)
                and result.get('checkpoint') == str(self.path(directory +
                    '/checkpoints/step-' + str(steps).zfill(9))), 'Training result mismatch')
        require(result.get('hop_readiness') is False, 'Unexpected HOP readiness claim')

    def verify_canary(self):
        report, checks = self.gate('work/canary_gate.json', 'optimizer_canary', 3, CANARY_CHECKS)
        require(set(report['artifacts']) == set(CANARY_ARTIFACTS), 'Canary artifact set mismatch')
        for name in CANARY_ARTIFACTS:
            require(self.sha('work/' + name) == report['artifacts'][name], 'Canary artifact hash mismatch')
        run = self.run('work/canary', 'canary', 24, 3)
        step2 = self.checkpoint('work/canary', run, 2, 16)
        step3 = self.checkpoint('work/canary', run, 3, 24)
        result = self.json('work/canary/TRAINING_RESULT.json')
        self.result(result, 'work/canary', run, 3, 24)
        require(result.get('total_rows') == 24, 'Canary row count mismatch')
        require(checks['checkpoint_saved'].get('checkpoint') == result['checkpoint'],
                'Canary saved checkpoint mismatch')
        resumed = checks['checkpoint_resumed']
        require(resumed.get('resumed_in_separate_process') is True
                and resumed.get('step2_manifest_sha256') == step2['manifest_sha256']
                and resumed.get('step2_adapter_sha256') == step2['adapter_parameters_sha256']
                and resumed.get('step3_adapter_sha256') == step3['adapter_parameters_sha256']
                and step2['adapter_parameters_sha256'] != step3['adapter_parameters_sha256'],
                'Canary resume evidence mismatch')
        longest = checks['longest_source_context']
        require(longest.get('max_source_sequence_length') == 25316
                and longest.get('configured_context_limit') == self.config['max_length']
                and longest.get('microbatch_size') == 1 and longest.get('accumulation_steps') == 8
                and longest.get('gpu_uuids') == list(GPU_UUIDS)
                and longest.get('canary_only_repeat_longest_eight_each_step') is True
                and longest.get('max_sequence_length_each_step') == [25316, 25316, 25316],
                'Canary length evidence mismatch')
        peaks = {}
        for name, steps, rows, completed in (('canary', 2, 16, False),
                                             ('canary-resume', 3, 24, True)):
            execution = self.json('work/' + name + '_execution.json')
            self.result(execution['result'], 'work/canary', run, steps, rows, completed=completed)
            before, after = execution['initial_base_adapter_sha256'], execution['after_adapter_sha256']
            require(is_sha(before) and is_sha(after) and before != after, 'No canary adapter update')
            # runtime_probe.adapter_hash and training_loop._parameter_sha use
            # different serialization; their hash values must not be equated.
            if steps == 2:
                initial_adapter = before
            else:
                require(before == initial_adapter
                        and checks['weights_updated'].get('before') == before
                        and checks['weights_updated'].get('after') == after,
                        'Canary execution/gate adapter evidence mismatch')
            values = execution['gpu_peaks']
            require(len(values) == 2 and [v.get('uuid') for v in values] == list(GPU_UUIDS), 'Missing per-GPU canary peaks')
            peaks[name] = {v['uuid']: {k: v[k] for k in ('peak_allocated_gib', 'peak_reserved_gib')} for v in values}
            require(all(number(p['peak_allocated_gib']) and number(p['peak_reserved_gib'])
                        and 0 < p['peak_allocated_gib'] <= p['peak_reserved_gib']
                        for p in peaks[name].values()), 'Invalid canary memory metric')
        safe = {'verified': True, 'optimizer_steps': 3, 'separate_process_resume_attested': True,
                'artifact_hashes_verified': True, 'allocator_peaks_gib': peaks,
                'max_sequence_length_each_step': [25316, 25316, 25316],
                'checks': [{'name': n, 'passed': True} for n in CANARY_CHECKS]}
        self.export('canary.sanitized.json', safe)
        return safe

    def verify_training(self):
        run = self.run('work/training', 'train', 40415, 5052)
        result = self.json('work/training/TRAINING_RESULT.json')
        self.result(result, 'work/training', run, 5052, 40415)
        require(result.get('total_rows') == 40415, 'Training row count mismatch')
        checkpoint = self.checkpoint('work/training', run, 5052, 40415)
        complete = self.json('work/COMPLETE.json')
        self.bindings(complete)
        require(complete.get('status') == 'stage1_epoch_completed'
                and complete.get('training') == result
                and complete.get('hop_deployment_ready') is False, 'Completion marker mismatch')
        safe = {'verified': True, 'optimizer_steps': 5052, 'cursor': 40415,
                'epoch_completed': True, 'checkpoint_path': result['checkpoint'],
                'checkpoint_manifest_sha256': checkpoint['manifest_sha256'],
                'run_sha256': digest(run), 'hop_deployment_ready': False}
        self.export('training_result.sanitized.json', safe)
        return safe

    def verify_validation(self):
        b0 = self.json('work/validation_B0.json')
        b1 = self.json('work/validation_B1.json')
        complete = self.json('work/COMPLETE.json')
        self.bindings(complete)
        for report in (b0, b1):
            self.bindings(report)
            evaluation = report['evaluation']
            require(evaluation.get('rows') == 4298 and evaluation.get('supervised_tokens') == 362003
                    and evaluation.get('weighting') == 'shifted_nonignored_target_tokens'
                    and evaluation.get('behavioral_quality_verified') is False
                    and number(evaluation.get('target_mean_loss')), 'Invalid validation evaluation')
        require(b0.get('model') == 'base_plus_zero_initialized_lora', 'Baseline identity mismatch')
        require(b1.get('checkpoint') == complete['training']['checkpoint']
                and complete.get('baseline') == b0['evaluation']
                and complete.get('final') == b1['evaluation'], 'Completion validation mismatch')
        first, final = b0['evaluation']['target_mean_loss'], b1['evaluation']['target_mean_loss']
        delta = final - first
        require(type(b1.get('delta_target_mean_loss')) in (int, float)
                and math.isclose(b1['delta_target_mean_loss'], delta, rel_tol=1e-12, abs_tol=1e-12),
                'Validation delta mismatch')
        safe = {'verified': True, 'rows': 4298, 'supervised_tokens': 362003,
                'weighting': 'shifted_nonignored_target_tokens',
                'base_untrained_B0_nll': first, 'stage1_sft_B1_nll': final,
                'delta_nll_B1_minus_B0': delta,
                'decrease_percent': 100 * (first - final) / first if first else None,
                'decrease_percent_denominator_B0': first,
                'independent_test': False, 'behavioral_quality_verified': False}
        self.export('validation.sanitized.json', safe)
        return safe

    def collect_train_log(self):
        records = []
        for line in self.read('work/training/train.jsonl').splitlines():
            require(bool(line.strip()), 'Blank training log row')
            row = parse_json(line)
            require(isinstance(row, dict) and row.get('mode') == 'train', 'Invalid training log mode')
            for key in ('step', 'next_row_cursor', 'microbatches', 'supervised_tokens'):
                require(integer(row.get(key), minimum=1), 'Invalid training log integer')
            require(1 <= row['step'] <= 5052 and row['next_row_cursor'] == min(row['step'] * 8, 40415)
                    and row['microbatches'] == (7 if row['step'] == 5052 else 8), 'Training step cursor mismatch')
            for key in ('target_mean_loss', 'gradient_norm_before_clip', 'elapsed_seconds'):
                require(number(row.get(key)), 'Nonfinite training metric')
            require(isinstance(row.get('learning_rates'), list) and row['learning_rates']
                    and all(number(v) for v in row['learning_rates']), 'Invalid learning rates')
            records.append({k: row[k] for k in TRAIN_FIELDS})
        require(records, 'Empty training log')
        counts = collections.Counter(r['step'] for r in records)
        require(set(counts) == set(range(1, 5053)), 'Training log does not cover all optimizer steps')
        duplicates = {str(k): v for k, v in sorted(counts.items()) if v > 1}
        contiguous = [r['step'] for r in records] == list(range(1, 5053))
        committed = self.summary.get('training', {}).get('verified') is True
        observed = sum(r['elapsed_seconds'] for r in records)
        require(number(observed), 'Training elapsed sum overflow')
        tokens = sum(r['supervised_tokens'] for r in records)
        if contiguous:
            require(tokens == 3291230, 'Training log target-token total mismatch')
        path_verified = contiguous and committed
        safe = {'verified': True, 'record_count': len(records), 'unique_steps': len(counts),
                'duplicate_steps': duplicates, 'duplicate_extra_records': len(records) - len(counts),
                'missing_steps': sorted(set(range(1, 5053)) - set(counts)),
                'observed_all_logged_step_wall_seconds': observed,
                'observed_all_logged_supervised_tokens': tokens,
                'successful_path_step_wall_seconds': observed if path_verified else None,
                'retry_logged_step_wall_seconds': 0 if path_verified else None,
                'successful_path_proven_from_log_structure': path_verified,
                'proof_scope': 'contiguous unique steps and final checkpoint cursor agree' if path_verified
                    else 'append log has no attempt IDs; successful path and retry costs are not attributable',
                'unlogged_failed_attempt_cost_seconds': None,
                'timing_scope': 'step wall time excluding checkpoint saves; no explicit CUDA synchronization',
                'learning_rate_scope': 'after scheduler update, for next step'}
        self.exports['work/training/train.sanitized.jsonl'] = b''.join(canonical(r) + b'\n' for r in records)
        return safe

    def collect_segments(self):
        collection = self.path('work/collection')
        segments = []
        if not collection.exists():
            self.warnings.append('No wrapper collection directory; time/GPU metrics unmeasured.')
            return {'segments': [], 'sampled_device_memory_max_mib_by_uuid': {gpu: None for gpu in GPU_UUIDS}}
        for directory in sorted(collection.iterdir()):
            if not directory.is_dir() or directory.name.startswith('results-'):
                continue
            if not re.fullmatch(r'[0-9]{8}T[0-9]{6}Z-(prepare|start|resume|evaluate)-[0-9]+', directory.name):
                continue
            self.path(str(directory.relative_to(self.kit)))
            relative = 'work/collection/' + directory.name
            item = {'segment_id': directory.name, 'elapsed_seconds': None,
                    'action': directory.name.split('-')[1],
                    'command_exit_code': None, 'log_exit_code': None, 'sample_count': 0,
                    'sampled_device_memory_max_mib_by_uuid': {gpu: None for gpu in GPU_UUIDS}, 'monitor_stderr_bytes': None,
                    'measurement_issues': []}
            try:
                events = [parse_json(line) for line in self.read(relative + '/events.jsonl').splitlines()]
                require(len(events) == 2 and events[0].get('event') == 'start'
                        and events[1].get('event') == 'end', 'Incomplete event pair')
                for event in events:
                    require(event.get('segment_id') == directory.name
                            and event.get('action') == item['action']
                            and number(event.get('monotonic_seconds')), 'Event identity mismatch')
                    stamp = dt.datetime.fromisoformat(event['utc'])
                    require(stamp.tzinfo is not None, 'Event UTC timezone missing')
                require(events[0]['action'] == events[1]['action'], 'Event action changed')
                elapsed = events[1]['monotonic_seconds'] - events[0]['monotonic_seconds']
                require(number(elapsed), 'Invalid event elapsed')
                for key in ('exit_code', 'log_exit_code'):
                    require(integer(events[1].get(key)), 'Missing exit code')
                item.update({'action': events[0]['action'], 'elapsed_seconds': elapsed,
                             'start_utc': events[0]['utc'], 'end_utc': events[1]['utc'],
                             'command_exit_code': events[1]['exit_code'],
                             'log_exit_code': events[1]['log_exit_code']})
                self.export(relative + '/events.sanitized.json', [{k: event[k] for k in
                    ('event', 'action', 'segment_id', 'utc', 'monotonic_seconds',
                     'exit_code', 'log_exit_code')} for event in events])
            except (ValueError, KeyError, TypeError, OSError):
                item['measurement_issues'].append('missing_or_invalid_start_end_events')
            try:
                stderr = self.read(relative + '/gpu_monitor.stderr')
                item['monitor_stderr_bytes'] = len(stderr)
                if stderr.strip():
                    item['measurement_issues'].append('gpu_monitor_stderr_nonempty')
            except (ValueError, OSError):
                item['measurement_issues'].append('gpu_monitor_stderr_missing')
            try:
                data = self.read(relative + '/gpu_samples.csv').decode('utf-8')
                rows = list(csv.reader(io.StringIO(data)))
                expected = ['timestamp', 'uuid', 'memory.used [MiB]', 'memory.total [MiB]',
                            'utilization.gpu [%]', 'temperature.gpu', 'power.draw [W]']
                if rows and 'index' in [v.strip() for v in rows[0]]:
                    index = [v.strip() for v in rows[0]].index('index')
                    require(all(len(row) == 8 for row in rows), 'Malformed indexed GPU CSV')
                    rows = [row[:index] + row[index + 1:] for row in rows]
                require(rows and [v.strip() for v in rows[0]] == expected, 'Unexpected GPU CSV header')
                safe_rows = []
                for row in rows[1:]:
                    require(len(row) == 7 and row[1].strip() in GPU_UUIDS, 'GPU CSV device mismatch')
                    stamp = dt.datetime.strptime(row[0].strip(), '%Y/%m/%d %H:%M:%S.%f')
                    values = []
                    for value in row[2:]:
                        match = re.fullmatch(r'\s*(\d+(?:\.\d+)?)\s*(?:MiB|%|W)?\s*', value)
                        require(match is not None, 'GPU CSV metric unavailable')
                        values.append(float(match.group(1)))
                    require(all(number(v) for v in values), 'Nonfinite GPU metric')
                    safe_rows.append([stamp.strftime('%Y/%m/%d %H:%M:%S.%f'), row[1].strip()] + values)
                require(safe_rows, 'GPU CSV has no samples')
                item['sample_count'] = len(safe_rows)
                for gpu in GPU_UUIDS:
                    memory = [r[2] for r in safe_rows if r[1] == gpu]
                    item['sampled_device_memory_max_mib_by_uuid'][gpu] = max(memory) if memory else None
                    if not memory:
                        item['measurement_issues'].append('gpu_samples_missing_for_' + gpu)
                output = io.StringIO()
                writer = csv.writer(output)
                writer.writerow(expected)
                writer.writerows(safe_rows)
                self.exports[relative + '/gpu_samples.sanitized.csv'] = output.getvalue().encode()
            except (ValueError, TypeError, OSError, csv.Error, UnicodeError):
                item['measurement_issues'].append('gpu_csv_missing_empty_or_invalid')
            # Console may include sensitive content; only its hash/size are retained.
            if self.path(relative + '/console.log').is_file():
                self.sha(relative + '/console.log')
            segments.append(item)
        if not segments:
            self.warnings.append('No recognized wrapper segments; time/GPU metrics unmeasured.')
        if any(s['measurement_issues'] for s in segments):
            self.warnings.append('Some wrapper measurements are missing or invalid; see segment issues.')
        peaks = {}
        for gpu in GPU_UUIDS:
            values = [s['sampled_device_memory_max_mib_by_uuid'][gpu] for s in segments
                      if s['sampled_device_memory_max_mib_by_uuid'][gpu] is not None]
            peaks[gpu] = max(values) if values else None
        success_times = [s['elapsed_seconds'] for s in segments if s['command_exit_code'] == 0
                         and s['elapsed_seconds'] is not None]
        failed_times = [s['elapsed_seconds'] for s in segments if s['command_exit_code'] not in (None, 0)
                        and s['elapsed_seconds'] is not None]
        return {'segments': segments, 'sampled_device_memory_max_mib_by_uuid': peaks,
                'sampling_interval_requested_seconds': 5,
                'memory_scope': '5-second sampled whole-device memory.used, not allocator or instantaneous peak',
                'recorded_successful_command_elapsed_seconds': sum(success_times) if success_times else None,
                'recorded_failed_command_elapsed_seconds': sum(failed_times) if failed_times else None,
                'time_scope': 'per-command wrapper time includes preparation, loading, canary, evaluation and saves; sums may overlap',
                'training_allocator_peak_gib': None, 'precise_gpu_step_seconds': None}

    def verify_command_completion(self):
        segments = self.summary.get('measurements', {}).get('segments', [])
        attempts = [s for s in segments if s['action'] in ('start', 'resume', 'evaluate')]
        require(attempts, 'No recorded training/evaluation command')
        final = attempts[-1]
        require(final['elapsed_seconds'] is not None and final['command_exit_code'] == 0
                and final['log_exit_code'] == 0, 'Final wrapper command has not ended successfully')
        return {'verified': True, 'final_segment_id': final['segment_id'],
                'command_exit_code': 0, 'log_exit_code': 0}

    def verify_stable(self):
        for name, evidence in self.sources.items():
            current = self.path(name).stat()
            require((current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns)
                    == evidence['_signature'], 'Source changed during collection')
        return {'verified': True, 'files_checked': len(self.sources)}

    def collect(self):
        for name, function in (
            ('identity', self.verify_identity), ('source_data', self.verify_source_data), ('tokens', self.verify_tokens),
            ('qualification', self.verify_qualification), ('canary', self.verify_canary),
            ('training', self.verify_training), ('validation', self.verify_validation),
            ('train_log', self.collect_train_log), ('measurements', self.collect_segments),
            ('command_completion', self.verify_command_completion),
            ('snapshot_stability', self.verify_stable),
        ):
            self.check(name, function)
        self.summary['stage1_sft_completed'] = not self.errors
        self.summary['status'] = 'verified_complete' if not self.errors else 'incomplete_or_unverified'
        self.summary['verification_errors'] = self.errors
        if any(e['section'] == 'snapshot_stability' for e in self.errors):
            self.warnings.append('Artifacts changed during collection; this is a nonfinal snapshot, not proof of corruption.')
        self.summary['warnings'] = self.warnings
        # Only fixed/recognized source paths are published; package filenames are not recursively dumped.
        public_sources = {}
        for name, evidence in self.sources.items():
            if name.startswith('work/') and (name in (
                'work/qualification.json', 'work/canary_gate.json', 'work/tokens/manifest.json',
                'work/canary_execution.json', 'work/canary-resume_execution.json',
                'work/training/RUN.json', 'work/training/TRAINING_RESULT.json',
                'work/training/train.jsonl', 'work/COMPLETE.json', 'work/validation_B0.json',
                'work/validation_B1.json') or name.startswith('work/canary/')
                or name.startswith('work/training/checkpoints/') or name.startswith('work/collection/')):
                public_sources[name] = {k: evidence[k] for k in ('sha256', 'bytes')}
        self.summary['private_server_source_references'] = public_sources
        self.summary['privacy'] = {
            'raw_qualification_excluded': True, 'run_order_and_row_ids_excluded': True,
            'raw_text_token_ids_weights_optimizer_console_excluded': True,
            'archive_policy': 'generated explicit field projections only; no source-file copying',
        }
        return self.summary

    def write(self):
        parent = self.path('work/collection')
        parent.mkdir(parents=True, exist_ok=True)
        name = 'results-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
        destination = self.path('work/collection/' + name)
        destination.mkdir()
        self.export('summary.json', self.summary)
        status = '1단계 원문 상담 응답 SFT 완료 (검증됨)' if self.summary['stage1_sft_completed'] else '미완료 또는 검증 불충분 — 완료로 보고하지 않음'
        lines = ['# 말씨 1단계 결과', '', status, '',
                 '- 실행 kit: `' + str(self.kit) + '`',
                 '- 수집 UTC: ' + self.summary['created_utc'],
                 '- GPU UUID: `' + '`, `'.join(GPU_UUIDS) + '`',
                 '- `hop_deployment_ready=false`; 보호자 지원·독립 test·다중 턴 평가 완료를 뜻하지 않습니다.',
                 '- 수집 ID: `' + name + '`',
                 '- 기계 판독용 전체 근거: `summary.json`.', '']
        identity = self.summary.get('identity', {})
        if identity.get('verified'):
            lines.extend(['입력 지문:', '', '| Binding | SHA-256 |', '|---|---|'])
            lines.extend('| ' + key + ' | `' + value + '` |'
                         for key, value in identity['bindings'].items())
            config = identity['configuration']
            lines.extend(['', '- 모델: `' + config['model'] + '` / revision `' + config['model_revision'] + '`',
                          '- 학습 방식: ' + config['training_method'],
                          '- LoRA: r=' + str(config['lora_r']) + ', alpha=' + str(config['lora_alpha'])
                          + ', dropout=' + str(config['lora_dropout'])
                          + '; language/attention/MLP 선택, vision 제외. 명시적 target_modules 인자는 없음.',
                          '- epoch=1 / microbatch=1 / accumulation=8 / max_length=' + str(config['max_length']) + ' / seed=3407.',
                          '- device_map=' + config['device_map'] + ' / layer_split=' + str(config.get('layer_split')) + ' / tiled_mlp=' + str(config['unsloth_tiled_mlp']) + '.',
                          '- learning_rate=' + str(config['learning_rate'])
                          + ' / weight_decay=' + str(config['weight_decay'])
                          + ' / warmup_ratio=' + str(config['warmup_ratio']) + '.',
                          '- 마지막 상담사 응답과 원래 종료 직렬화만 감독. 과거 문맥은 attention에 유지; packing/truncation/thinking 비활성.', ''])
        tokens = self.summary.get('tokens', {})
        if tokens.get('verified'):
            lines.extend(['| Split | 행 | 입력 token | 감독 token |', '|---|---:|---:|---:|'])
            for split, values in tokens['splits'].items():
                lines.append('| ' + split + ' | ' + str(values['rows']) + ' | '
                             + str(values['input_tokens']) + ' | ' + str(values['supervised_tokens']) + ' |')
            lines.append('')
        canary = self.summary.get('canary', {})
        if canary.get('verified'):
            lines.extend(['- Canary: 초기 2 step 저장 + 별도 프로세스 1 step 재개 = 총 3 step 검증.',
                          '- Canary의 세 optimizer step 각각 최장 원문 25,316 token 문맥을 포함합니다.',
                          '- Canary artifact와 step 2/3 checkpoint inventory·실제 SHA 검증 통과.'])
            for phase, peak in canary['allocator_peaks_gib'].items():
                for gpu, values in peak.items():
                    lines.append('- ' + phase + ' / ' + gpu + ' allocator peak: allocated '
                                 + str(values['peak_allocated_gib']) + ' GiB / reserved '
                                 + str(values['peak_reserved_gib']) + ' GiB.')
            lines.append('')
        training = self.summary.get('training', {})
        if training.get('verified'):
            lines.extend(['- optimizer step: 5,052 / cursor: 40,415 / epoch: 1 완료.',
                          '- 최종 checkpoint: `' + training['checkpoint_path'] + '`',
                          '- Run ID (canonical RUN SHA-256): `' + training['run_sha256'] + '`',
                          '- checkpoint manifest SHA-256: `' + training['checkpoint_manifest_sha256'] + '`'])
        validation = self.summary.get('validation', {})
        if validation.get('verified'):
            lines.extend(['- 동일 validation: 4,298행 / 감독 token 362,003개.',
                          '- B0 (base_untrained) NLL: ' + str(validation['base_untrained_B0_nll']),
                          '- B1 (stage1_sft) NLL: ' + str(validation['stage1_sft_B1_nll']),
                          '- ΔNLL (B1−B0): ' + str(validation['delta_nll_B1_minus_B0'])])
        log = self.summary.get('train_log', {})
        if log.get('verified'):
            lines.extend(['', '- 학습 로그: ' + str(log['record_count']) + '개 기록 / '
                          + str(log['unique_steps']) + '개 고유 step / 중복 추가 '
                          + str(log['duplicate_extra_records']) + '개.',
                          '- 전체 관측 step wall time: ' + str(log['observed_all_logged_step_wall_seconds']) + '초.',
                          '- 성공 경로 step wall time: ' + str(log['successful_path_step_wall_seconds'])
                          + '초 / 재시도 기록 step wall time: ' + str(log['retry_logged_step_wall_seconds']) + '초.',
                          '- 로그 구조로 최종 성공 경로 확인: ' + str(log['successful_path_proven_from_log_structure']) + '.'])
        metrics = self.summary.get('measurements', {})
        if 'segments' in metrics:
            lines.extend(['', '- 5초 장치 memory.used 표본 최대: '
                          + str(metrics.get('sampled_device_memory_max_mib_by_uuid')) + ' MiB (GPU별).',
                          '- 성공 명령 wrapper 시간 합: '
                          + str(metrics.get('recorded_successful_command_elapsed_seconds')) + '초 / 실패 명령 시간 합: '
                          + str(metrics.get('recorded_failed_command_elapsed_seconds')) + '초.',
                          '', '| Segment | 명령 exit | 로그 exit | wrapper 초 | GPU 표본 수 | stderr bytes |',
                          '|---|---:|---:|---:|---:|---:|'])
            for segment in metrics['segments']:
                lines.append('| ' + ' | '.join(str(segment.get(k)) for k in
                    ('segment_id', 'command_exit_code', 'log_exit_code', 'elapsed_seconds',
                     'sample_count', 'monitor_stderr_bytes')) + ' |')
        lines.extend(['', '측정 해석:', '',
                      '- train.jsonl은 append 로그입니다. 중복 step을 삭제하지 않고 그대로 수치 원장에 보존했습니다.',
                      '- 중복이 있으면 최종 성공 경로와 재시도 step 비용의 분리는 미확인/null입니다. 로그에 없는 실패 비용도 null입니다.',
                      '- step 시간은 저장을 제외한 wall time이며 CUDA 동기화에 의한 정밀 GPU 시간이 아닙니다.',
                      '- GPU 최대는 5초 간격 장치 memory.used 표본의 최대값입니다. 본학습 allocator peak는 미측정/null입니다.',
                      '- wrapper 시간에는 준비·로드·canary·검증·저장이 포함됩니다. 실패 명령 시간과 성공 명령 시간을 구분했습니다.',
                      '- 기존 qualification의 재사용 검증이며 신규 GPU 수치 실행이나 현재 설치 환경 재검사가 아닙니다.',
                      '- checkpoint는 실제 파일 inventory와 SHA를 검증했으나 tensor/optimizer/RNG state를 역직렬화하지 않았습니다.',
                      '- 원본 qualification/RUN/콘솔·토큰·가중치·optimizer는 서버에 보존하며 발표 ZIP에서 제외했습니다.', ''])
        if self.errors:
            lines.extend(['검증되지 않은 영역:'] + ['- ' + e['section'] + ' (' + e['error_type'] + ')' for e in self.errors])
        if self.warnings:
            lines.extend(['', '측정 누락:'] + ['- ' + w for w in self.warnings])
        self.exports['RESULTS.md'] = ('\n'.join(lines) + '\n').encode('utf-8')
        # This dictionary is the strict archive allowlist. Never glob the kit or copy a raw artifact.
        for relative in ('RESULTS.md', 'summary.json'):
            with (destination / relative).open('xb') as handle:
                handle.write(self.exports[relative])
        archive = destination / 'presentation_results.zip'
        with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as handle:
            for relative, data in sorted(self.exports.items()):
                require(not Path(relative).is_absolute() and '..' not in Path(relative).parts,
                        'Unsafe archive entry')
                handle.writestr(relative, data)
        with zipfile.ZipFile(archive) as handle:
            require(set(handle.namelist()) == set(self.exports) and handle.testzip() is None,
                    'Archive verification failed')
        return destination


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--kit', required=True, type=Path, help='Existing server kit path')
    parser.add_argument('--allow-incomplete', action='store_true',
                        help='Write a clearly incomplete report when evidence fails verification')
    args = parser.parse_args(argv)
    try:
        collector = Collector(args.kit)
        summary = collector.collect()
        if not summary['stage1_sft_completed'] and not args.allow_incomplete:
            print(json.dumps({'status': summary['status'], 'verification_errors': collector.errors,
                              'report_written': False}, ensure_ascii=False), file=sys.stderr)
            return 2
        output = collector.write()
        print(json.dumps({'status': summary['status'], 'output_directory': str(output),
                          'stage1_sft_completed': summary['stage1_sft_completed'],
                          'hop_deployment_ready': False}, ensure_ascii=False))
        return 0
    except (ValueError, OSError, TypeError, KeyError) as exc:
        print('Collection failed: ' + type(exc).__name__, file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
