"""Pinned v11 entry point for the existing stage1 loop; no imports with GPU side effects.

The GPU caller must enforce filesystem/network isolation before invoking this
module. This profile never silently substitutes the legacy unweighted trainer.
"""
from __future__ import annotations

from collections import Counter
from pathlib import Path
import hashlib
import json
import os
import random
import time

ENTRIES_SHA256 = '61f0d99ad064f0b58d2286658d1657d0510618bea7dab2ff013cee93f402dd5a'

CONSUMER_SHA256 = '0868c8317f1dda63bb56843e51dbeede6654ff33bf86baa462b0e5add389a062'

POLICY_SHA256 = '7d1e112fcc2598a03c12683ec09a93746d5cda192007b435b0a40ce811d9dcf6'

MODEL_CONFIG_SHA256 = '7c1b15e76038d3234812c093638bac540c498beb6331feaeebb59ce160302d25'

MODEL_INDEX_SHA256 = 'ea2421fd03e346456c12b324eab5fcb37f095a4b2a1aa8456ac0b0b7d6127d1d'

TASKS = ('conversation', 'sentence', 'word', 'state_observations', 'relationship_memory')

TARGET_MODULES = (r'(?:.*?(?:language|text).*?(?:self_attn|attention|attn|mixer|mlp|feed_forward|ffn|dense|mixer).*?\.(?:linear|q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj))|'
                  r'(?:\bmodel\.layers\.[\d]{1,}(?!.*\.experts\.\d)\..*?(?:self_attn|attention|attn|mixer|mlp|feed_forward|ffn|dense|mixer).*?\.(?:(?:linear|q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)))')

EXPECTED_SHARDS = dict(zip(
    ('model-00001-of-00004.safetensors', 'model-00002-of-00004.safetensors',
     'model-00003-of-00004.safetensors', 'model-00004-of-00004.safetensors'),
    (4955672168, 4968118751, 4996516483, 4161484319)))

def model_device_map():
    result = {'model.vision_tower': 0, 'model.language_model.embed_tokens': 0,
              'lm_head': 0, 'model.language_model.norm': 1,
              'model.language_model.rotary_emb': 1, 'model.embed_vision': 1}
    result.update({'model.language_model.layers.' + str(i): 0 if i < 28 else 1
                   for i in range(60)})
    return result


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def write_json(path, value):
    from .stage1_training_loop import _atomic_json
    _atomic_json(Path(path), value)


def event(phase, **fields):
    print(json.dumps({'phase': phase, **fields}, ensure_ascii=False, allow_nan=False), flush=True)


def validate_inputs(entries_path, model_path):
    """Admit exactly the already audited snapshot, without truncation or rebuilding."""
    from . import supporter_weighted_loss as weights
    require(sha_file(weights.__file__) == CONSUMER_SHA256, 'Frozen v11 consumer changed')
    require(sha_file(entries_path) == ENTRIES_SHA256, 'Immutable 419-row export changed')
    payload = json.loads(Path(entries_path).read_text())
    require(set(payload) == {'bindings', 'entries', 'pad_id', 'vocab_size'}, 'Unexpected export schema')
    require(payload['bindings']['policy_manifest_sha256'] == POLICY_SHA256, 'Policy binding changed')
    require(payload['pad_id'] == 0 and payload['vocab_size'] == 262144, 'Tokenizer vocabulary changed')
    entries = payload['entries']
    require(len(entries) == 419 and Counter(e['split'] for e in entries) == {'train': 243, 'validation': 176},
            'Immutable split counts changed')
    require(set(e['stream'] for e in entries) == set(TASKS), 'Task inventory changed')
    for task in TASKS:
        for split in ('train', 'validation'):
            subset = [e for e in entries if e['stream'] == task and e['split'] == split]
            weights._checked_entries(subset, task=task, split=split, pad_id=0, max_length=4096)
    model_path = Path(model_path)
    require(model_path == model_path.resolve(), 'Model path traverses a link')
    for filename, expected in [('config.json', MODEL_CONFIG_SHA256), ('model.safetensors.index.json', MODEL_INDEX_SHA256)]:
        require(sha_file(model_path / filename) == expected, 'Model identity changed')
    for filename, expected in EXPECTED_SHARDS.items():
        p = model_path / filename
        require(p.is_file() and not p.is_symlink() and p.stat().st_nlink == 1 and p.stat().st_size == expected,
                'Model shard path/size changed')
    return payload


def load_model(model_path):
    """Use the same actual two-GPU NF4+LoRA path verified by the r2 canary."""
    import importlib.metadata
    import torch
    from transformers import Gemma4ForConditionalGeneration
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    for name, version in {'torch': '2.13.0+cu126', 'transformers': '5.17.0',
                          'peft': '0.21.2', 'bitsandbytes': '0.50.2'}.items():
        require(importlib.metadata.version(name) == version, 'Unreviewed library version: ' + name)
    require(torch.cuda.device_count() == 2 and all('4090' in torch.cuda.get_device_name(i) for i in range(2)),
            'Expected exactly two visible RTX 4090 GPUs')
    random.seed(3407)
    torch.manual_seed(3407)
    torch.cuda.manual_seed_all(3407)
    torch.set_float32_matmul_precision('highest')
    event('model_load', model='Gemma4-31B', layer_split=28)
    model = Gemma4ForConditionalGeneration.from_pretrained(
        str(model_path), local_files_only=True, trust_remote_code=False,
        dtype=torch.bfloat16, attn_implementation='sdpa', device_map=model_device_map())
    require(getattr(model, 'is_loaded_in_4bit', False), 'Expected serialized 4-bit base')
    require(all(p.device.type == 'cuda' for p in model.parameters()), 'CPU/disk offload forbidden')
    model.config.use_cache = False
    model.config.get_text_config().use_cache = False
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True,
        gradient_checkpointing_kwargs={'use_reentrant': False}, auto_clear_cache=False)
    model = get_peft_model(model, LoraConfig(r=8, lora_alpha=8, lora_dropout=0.0, bias='none',
                          target_modules=TARGET_MODULES, task_type='CAUSAL_LM'))
    params = [(name, p) for name, p in model.named_parameters() if p.requires_grad]
    require(sum(p.numel() for _, p in params) == 61214720 and all('lora_' in n for n, _ in params),
            'Unexpected trainable parameters')
    require({str(p.device) for _, p in params} == {'cuda:0', 'cuda:1'}, 'Adapters must span both GPUs')
    require(all(p.dtype == torch.float32 for _, p in params), 'Expected FP32 adapters')
    return model


LOSS_CALLBACK_ID = 'gemma4-full-context-tail-logits-shifted-target-mean-ce-v1'


def selected_loss(model, encoded):
    """Full input, exact causal target positions; integer tail avoids dispatch ambiguity."""
    import torch
    ids = torch.tensor([encoded['input_ids']], dtype=torch.long, device='cuda:0')
    mask = torch.tensor([encoded['attention_mask']], dtype=torch.long, device='cuda:0')
    positions = [i for i, v in enumerate(encoded['labels'][1:]) if v != -100]
    require(len(positions) == encoded['target_length'] > 0, 'Causal target mask changed')
    first = min(positions)
    keep = encoded['sequence_length'] - first
    tail = model(input_ids=ids, attention_mask=mask, logits_to_keep=keep, use_cache=False).logits
    require(tail.shape == (1, keep, 262144), 'Unexpected logits shape')
    indices = torch.tensor([i-first for i in positions], dtype=torch.long, device=tail.device)
    logits = tail.index_select(1, indices)
    targets = torch.tensor([encoded['labels'][i+1] for i in positions], dtype=torch.long, device=logits.device)
    return torch.nn.functional.cross_entropy(logits[0].float(), targets, reduction='mean')


def check_causal_reference(model, payload):
    import torch
    entry = min((e for e in payload['entries'] if e['split'] == 'train'),
                key=lambda e: e['encoded']['sequence_length'])
    encoded = entry['encoded']
    model.eval()
    with torch.no_grad():
        chosen = float(selected_loss(model, encoded).item())
        actual = float(model(input_ids=torch.tensor([encoded['input_ids']], device='cuda:0'),
            attention_mask=torch.tensor([encoded['attention_mask']], device='cuda:0'),
            labels=torch.tensor([encoded['labels']], device='cuda:0'), logits_to_keep=0, use_cache=False).loss.item())
    import math
    require(math.isclose(chosen, actual, rel_tol=1e-3, abs_tol=1e-4), 'Causal loss reference mismatch')
    return {'sequence_length': encoded['sequence_length'], 'selected_ce': chosen, 'native_ce': actual,
            'passed': True, 'rel_tol': 1e-3, 'abs_tol': 1e-4}


def input_bindings(payload, model_path):
    from . import stage1_training_loop as loop
    return {**payload['bindings'], 'entries_sha256': ENTRIES_SHA256,
            'consumer_sha256': CONSUMER_SHA256, 'training_loop_sha256': sha_file(loop.__file__),
            'profile_sha256': sha_file(__file__), 'model_path': str(Path(model_path).resolve()),
            'model_config_sha256': MODEL_CONFIG_SHA256, 'model_index_sha256': MODEL_INDEX_SHA256,
            'model_settings': {'rank': 8, 'alpha': 8, 'dropout': 0, 'target_modules': TARGET_MODULES,
                               'layer_split': 28, 'attention': 'sdpa', 'seed': 3407,
                               'learning_rate': 2e-5, 'weight_decay': 0.01,
                               'loss_callback': LOSS_CALLBACK_ID}}


def run_cli(args):
    """Continue complete task plans through the existing loop, never a subset plan."""
    import torch
    from . import stage1_training_loop as loop
    from . import supporter_weighted_loss as weights
    command = args.command
    require(command in {'train-v11', 'resume-v11'}, 'Unsupported v11 training command')
    for attr in ('v11_entries', 'v11_model', 'v11_run_root'):
        require(getattr(args, attr, None) is not None, 'Missing --' + attr.replace('_', '-'))
    root = Path(args.v11_run_root).absolute()
    require(root == root.resolve(), 'Run root traverses a link')
    root.mkdir(parents=True, exist_ok=True)
    report_path = root / ('initial-process.json' if command == 'train-v11' else 'resumed-process.json')
    require(not report_path.exists(), 'Process evidence exists; preserve it before another attempt')
    report = {'schema': 'malssi-v11-main-training-process-v1', 'status': 'running', 'command': command,
              'pid': os.getpid(), 'started_unix': time.time(), 'tasks': {}, 'full_service_ready': False,
              'reserved_output_tokens': 8192, 'generation_8192_executed': False}
    phase = 'admission'
    try:
        payload = validate_inputs(args.v11_entries, args.v11_model)
        bound = input_bindings(payload, args.v11_model)
        report['bindings'] = bound
        model = load_model(args.v11_model)
        report['causal_reference'] = check_causal_reference(model, payload)
        initial = {n: p.detach().cpu().clone() for n, p in model.named_parameters() if p.requires_grad}
        initial_sha = loop._parameter_sha(model)
        report['initial_adapter_sha256'] = initial_sha
        for task in TASKS:
            phase = task
            with torch.no_grad():
                for n, p in model.named_parameters():
                    if p.requires_grad:
                        p.copy_(initial[n].to(p.device))
            model.zero_grad(set_to_none=True)
            require(loop._parameter_sha(model) == initial_sha, 'Task initial adapter reset failed')
            train = [e for e in payload['entries'] if e['stream'] == task and e['split'] == 'train']
            validation = [e for e in payload['entries'] if e['stream'] == task and e['split'] == 'validation']
            directory = root / 'tasks' / task / 'work' / 'training'
            optimizer = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad],
                                         lr=2e-5, weight_decay=0.01, foreach=False)
            before_checkpoint = None
            if command == 'resume-v11':
                checkpoints = sorted((directory / 'checkpoints').glob('step-[0-9]*'))
                require(bool(checkpoints), 'Missing initial-process checkpoint')
                before_checkpoint = json.loads((checkpoints[-1] / 'CHECKPOINT.json').read_text())
            event('task_training', task=task, command=command, complete_train_rows=len(train))
            result = loop.run_training(model, optimizer, [e['encoded'] for e in train], directory,
                pad_id=0, bindings=bound, max_length=4096, accumulation_steps=8, seed=3407,
                checkpoint_every=100, max_steps=args.v11_max_steps, resume_from='latest' if before_checkpoint else None,
                weighted_entries=train, task=task, loss_callback=lambda row: selected_loss(model, row),
                loss_callback_id=LOSS_CALLBACK_ID, required_gradient_devices=['cuda:0', 'cuda:1'], device='cuda:0')
            task_report = {'training': result, 'adapter_sha256': loop._parameter_sha(model),
                           'before_resume_checkpoint': before_checkpoint, 'initial_adapter_sha256': initial_sha}
            if result['epoch_completed'] and command == 'resume-v11':
                phase = task + '/validation'
                model.eval()
                before_eval = loop._parameter_sha(model)
                require(all(p.grad is None for p in model.parameters() if p.requires_grad), 'Gradient left before validation')
                losses = []
                with torch.no_grad():
                    for e in validation:
                        loss = selected_loss(model, e['encoded'])
                        require(bool(torch.isfinite(loss).item()), 'Nonfinite validation loss')
                        losses.append(float(loss.item()))
                task_report['validation'] = weights.evaluate_losses(validation, losses)
                require(loop._parameter_sha(model) == before_eval, 'Validation mutated adapter')
                require(all(p.grad is None for p in model.parameters() if p.requires_grad), 'Validation produced gradient')
                task_report['validation_parameters_and_gradients_unchanged'] = True
                write_json(directory / 'validation.json', task_report['validation'])
            report['tasks'][task] = task_report
            write_json(report_path, report)
            del optimizer
            event('task_complete', task=task, optimizer_steps=result['completed_optimizer_steps'],
                  cursor=result['next_row_cursor'], epoch_completed=result['epoch_completed'])
        require(sha_file(args.v11_entries) == ENTRIES_SHA256, 'Encoded input changed')
        report.update(status='passed', inputs_unchanged=True,
            all_epochs_completed=all(t['training']['epoch_completed'] for t in report['tasks'].values()),
            base_parameters_frozen=all(not p.requires_grad for n, p in model.named_parameters() if n not in initial))
        require(report['base_parameters_frozen'], 'Base parameters became trainable')
    except Exception as exc:
        report.update(status='failed', failure_phase=phase, exception_type=type(exc).__name__,
                      exception_message=str(exc)[:700])
        frames, trace = [], exc.__traceback__
        while trace:
            frames.append({'file': trace.tb_frame.f_code.co_filename, 'function': trace.tb_frame.f_code.co_name,
                           'line': trace.tb_lineno})
            trace = trace.tb_next
        report['exception_frames'] = frames
        event('failed', phase_failed=phase, exception_type=type(exc).__name__)
    finally:
        if torch.cuda.is_initialized():
            report['gpu_memory'] = {str(i): {'peak_allocated_bytes': torch.cuda.max_memory_allocated(i),
                'peak_reserved_bytes': torch.cuda.max_memory_reserved(i)} for i in range(torch.cuda.device_count())}
        report['finished_unix'] = time.time()
        write_json(report_path, report)
    return 0 if report['status'] == 'passed' else 1
