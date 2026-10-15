#!/usr/bin/env python3
"""One fresh-process, synthetic capacity probe; never trains on or edits a dataset.

--length is input tokens. Train microsteps accumulate into each requested optimizer update.
Inference reserves --new-tokens in addition to input; --force-budget sets a
minimum generation length and is a capacity stress test, not a quality test.
--layer-split N explicitly places language layers [0,N) on GPU 0 and [N,60)
on GPU 1; omission preserves the original balanced placement.
"""
import argparse
import csv
import datetime as dt
import fcntl
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import random
import signal
import subprocess
import sys
import tempfile
import time
import traceback
import uuid

ROOT = Path('/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009')
MODEL = Path('/home/slim/choieram/models/gemma-4-31B-it-unsloth-bnb-4bit')
GPUS = ('GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c',
        'GPU-a2d3d60c-4eae-7e46-45bc-146e24457642')
CONTEXT_LIMIT = 262144
SCRIPT_PATH = Path(__file__).resolve()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('train', 'inference'), required=True)
    parser.add_argument('--length', type=int, required=True)
    parser.add_argument('--target-tokens', type=int)
    parser.add_argument('--microsteps', type=int, default=1)
    parser.add_argument('--optimizer-steps', type=int, default=1)
    parser.add_argument('--new-tokens', type=int, default=0)
    parser.add_argument('--force-budget', action='store_true')
    parser.add_argument('--seed', type=int, default=3407)
    parser.add_argument('--tiled-mlp', action='store_true')
    parser.add_argument('--layer-split', type=int, help='First language layer on GPU 1 (1..59)')
    args = parser.parse_args(argv)
    if args.length < 2 or args.new_tokens < 0 or args.length + args.new_tokens > CONTEXT_LIMIT:
        parser.error('Require length >= 2, new-tokens >= 0, and total context <= 262144')
    if args.microsteps < 1 or args.optimizer_steps < 1 or not 0 <= args.seed < 2**32:
        parser.error('Require microsteps >= 1 and 0 <= seed < 2**32')
    if args.layer_split is not None and not 1 <= args.layer_split <= 59:
        parser.error('Require 1 <= layer-split <= 59 for the pinned 60-layer model')
    if args.mode == 'train' and (args.target_tokens is None or not 1 <= args.target_tokens < args.length
                                or args.new_tokens or args.force_budget):
        parser.error('Train requires 1 <= target-tokens < length; no generation options')
    if args.mode == 'inference' and (args.new_tokens < 1 or args.target_tokens is not None or args.microsteps != 1 or args.optimizer_steps != 1):
        parser.error('Inference requires new-tokens >= 1; no target-tokens or microstep accumulation')
    return args


def requested_device_map(layer_split):
    if layer_split is None:
        return 'balanced'
    mapping = {'model.vision_tower': 0, 'model.language_model.embed_tokens': 0, 'lm_head': 0,
               'model.language_model.norm': 1, 'model.language_model.rotary_emb': 1,
               'model.embed_vision': 1}
    mapping.update({'model.language_model.layers.' + str(index): 0 if index < layer_split else 1
                    for index in range(60)})
    return mapping


def versions():
    values = {'python': sys.version}
    for name in ('torch', 'transformers', 'accelerate', 'unsloth', 'unsloth_zoo',
                 'bitsandbytes', 'peft', 'triton'):
        try:
            values[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            values[name] = None
    return values


def metadata_fingerprints():
    # Metadata hashes link to the parent's full model preflight; no shard hash claim.
    result = {'full_model_shards_verified_here': False, 'files': {}}
    for path in (MODEL / 'config.json', MODEL / 'generation_config.json', MODEL / 'tokenizer_config.json',
                 ROOT / 'training_kit/config/model_fingerprint.json', ROOT / 'training_kit/config/train.json'):
        require(path == path.resolve(), 'Metadata file must not traverse symlinks')
        if path.is_file():
            data = path.read_bytes()
            result['files'][str(path)] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
        elif path == MODEL / 'config.json':
            raise RuntimeError('Pinned model config.json is missing')
        else:
            result['files'][str(path)] = None
    return result


def confined(path):
    require(path == path.resolve() and path.is_relative_to(ROOT), 'Unsafe work path or symlink')
    return path


def environment():
    require(ROOT == ROOT.resolve(), 'Work root must not traverse symlinks')
    ROOT.mkdir(parents=True, exist_ok=True)
    paths = {'XDG_CACHE_HOME': '.cache', 'HF_HOME': '.cache/huggingface',
             'HF_HUB_CACHE': '.cache/huggingface/hub', 'HF_DATASETS_CACHE': '.cache/datasets',
             'TORCH_HOME': '.cache/torch', 'TRITON_CACHE_DIR': '.cache/triton',
             'TORCHINDUCTOR_CACHE_DIR': '.cache/inductor', 'TORCH_EXTENSIONS_DIR': '.cache/extensions',
             'CUDA_CACHE_PATH': '.cache/cuda', 'NUMBA_CACHE_DIR': '.cache/numba',
             'MPLCONFIGDIR': '.cache/matplotlib', 'TORCH_COMPILE_DEBUG_DIR': '.cache/compile-debug',
             'UNSLOTH_COMPILE_LOCATION': '.cache/unsloth', 'TMPDIR': '.tmp',
             'PIP_CACHE_DIR': '.cache/pip', 'UV_CACHE_DIR': '.cache/uv'}
    for key, relative in paths.items():
        path = confined(ROOT / relative)
        path.mkdir(parents=True, exist_ok=True)
        os.environ[key] = str(path)
    os.environ.update(CUDA_VISIBLE_DEVICES=','.join(GPUS), CUDA_DEVICE_ORDER='PCI_BUS_ID',
                      HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
                      WANDB_DISABLED='true', UNSLOTH_DISABLE_STATISTICS='1', DO_NOT_TRACK='1',
                      TOKENIZERS_PARALLELISM='false', OMP_NUM_THREADS='4',
                      UNSLOTH_RETURN_LOGITS='0', PYTHONDONTWRITEBYTECODE='1')
    sys.dont_write_bytecode = True
    tempfile.tempdir = os.environ['TMPDIR']
    os.chdir(ROOT)


def lock_and_check(handles):
    # These two pre-existing shared lock locations are the sole write exception.
    for gpu in GPUS:
        path = Path('/home/slim/choieram') / ('.malssi-' + gpu + '.lock')
        require(path == path.resolve(), 'Shared GPU lock must not be a symlink')
        handle = os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), 'a+')
        handles.append(handle)
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    def query(fields, apps=False):
        flag = '--query-compute-apps=' if apps else '--query-gpu='
        result = subprocess.run(['nvidia-smi', flag + fields, '--format=csv,noheader,nounits'],
                                text=True, capture_output=True, check=True, timeout=30)
        return list(csv.reader(result.stdout.splitlines()))
    processes = query('gpu_uuid,pid', apps=True)
    require(not any(row and row[0].strip() in GPUS for row in processes), 'A requested GPU has a compute process')
    rows = query('uuid,index,name,memory.total,memory.used,utilization.gpu')
    snapshot = []
    for gpu in GPUS:
        matches = [row for row in rows if row and row[0].strip() == gpu]
        require(len(matches) == 1 and len(matches[0]) == 6, 'Missing/invalid pinned GPU inventory')
        row = [value.strip() for value in matches[0]]
        require(float(row[4]) < 512 and float(row[5]) == 0, 'Requested GPU is not idle')
        snapshot.append(dict(zip(('uuid', 'physical_index', 'name', 'memory_total_mib',
                                  'memory_used_mib', 'utilization_percent'), row)))
    return snapshot


def synchronize(torch):
    for index in range(2):
        torch.cuda.synchronize(index)


def placement(model):
    counts = {}
    for parameter in model.parameters():
        name = str(parameter.device)
        counts[name] = counts.get(name, 0) + parameter.numel()
    require(set(counts) == {'cuda:0', 'cuda:1'}, 'Model must occupy both GPUs without CPU/meta/offload parameters')
    mapping = {key: str(value) for key, value in getattr(model, 'hf_device_map', {}).items()}
    require(all(value in ('0', '1', 'cuda:0', 'cuda:1') for value in mapping.values()), 'CPU/disk device map rejected')
    return {'parameter_numel_by_device': counts, 'hf_device_map': mapping}


def adapter_hash(torch, parameters):
    digest = hashlib.sha256()
    for name, parameter in parameters:
        digest.update(name.encode())
        digest.update(parameter.detach().cpu().contiguous().view(torch.uint8).numpy().tobytes())
    return digest.hexdigest()


def probe(args, report, event, torch, FastModel):
    require(torch.cuda.device_count() == 2, 'Exactly two visible CUDA devices required')
    for index, expected in enumerate(GPUS):
        actual = str(torch.cuda.get_device_properties(index).uuid).removeprefix('GPU-')
        require(actual == expected.removeprefix('GPU-'), 'CUDA UUID ordering mismatch')
        torch.cuda.reset_peak_memory_stats(index)
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    require(MODEL.is_dir() and MODEL == MODEL.resolve(), 'Pinned model path missing or symlinked')
    report['metadata_fingerprints'] = metadata_fingerprints()
    event('model_load_start')
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(str(MODEL), local_files_only=True)
    model, _ = FastModel.from_pretrained(model_name=str(MODEL),
        max_seq_length=args.length + args.new_tokens, dtype=torch.bfloat16,
        load_in_4bit=True, full_finetuning=False, device_map=report['requested_device_map'], local_files_only=True,
        unsloth_tiled_mlp=args.tiled_mlp)
    report['loaded_hf_device_map'] = {key: str(value) for key, value in getattr(model, 'hf_device_map', {}).items()}
    model = FastModel.get_peft_model(model, finetune_vision_layers=False, finetune_language_layers=True,
        finetune_attention_modules=True, finetune_mlp_modules=True, r=8, lora_alpha=8, lora_dropout=0,
        bias='none', random_state=args.seed, use_gradient_checkpointing='unsloth')
    report['tiled_language_mlp_modules'] = [name for name, module in model.named_modules()
        if 'language_model.layers.' in name and name.endswith('.mlp')
        and getattr(module.forward, '__name__', '') == 'tiled_forward_arctic_size']
    require(not args.tiled_mlp or len(report['tiled_language_mlp_modules']) == 60,
            'Tiled MLP must be active on all 60 language layers')
    report['placement'] = placement(model)
    require(model.is_loaded_in_4bit, 'Expected 4-bit model')
    parameters = [(name, p) for name, p in model.named_parameters() if p.requires_grad]
    require(parameters and all('lora_' in name for name, _ in parameters)
            and sum(p.numel() for _, p in parameters) == 61214720, 'Unexpected trainable parameters')
    report['trainable_parameters'] = 61214720
    text_config = getattr(model.config, 'text_config', model.config)
    report['model_language_layers'] = getattr(text_config, 'num_hidden_layers', None)
    require(args.layer_split is None or report['model_language_layers'] == 60,
            'Explicit map requires the pinned 60-language-layer model')
    report['model_context_limit'] = getattr(text_config, 'max_position_embeddings', None)
    require(type(report['model_context_limit']) is int
            and args.length + args.new_tokens <= report['model_context_limit'], 'Loaded model context limit exceeded')
    device = model.get_input_embeddings().weight.device
    special = set(tokenizer.all_special_ids)
    candidates = [value for value in tokenizer.encode('Hello friend.', add_special_tokens=False) if value not in special]
    require(candidates, 'No benign non-special synthetic token')
    inputs = torch.full((1, args.length), candidates[0], dtype=torch.long, device=device)
    if tokenizer.bos_token_id is not None:
        inputs[0, 0] = tokenizer.bos_token_id
    mask = torch.ones_like(inputs)
    report.update(actual_input_tokens=inputs.shape[1], synthetic_only=True,
                  synthetic_pattern='BOS then repeated token from Hello friend.; not a dataset or quality test')
    event('model_loaded', placement=report['placement'])
    synchronize(torch)
    started = time.monotonic()
    report['phase_started_monotonic'] = started
    if args.mode == 'train':
        model.train()
        model.config.use_cache = False
        before = adapter_hash(torch, parameters)
        optimizer = torch.optim.AdamW([p for _, p in parameters], lr=2e-5, weight_decay=0.01, foreach=False)
        optimizer.zero_grad(set_to_none=True)
        labels = torch.full_like(inputs, -100)
        labels[:, -args.target_tokens:] = inputs[:, -args.target_tokens:]
        report.update(actual_supervised_tokens_per_microstep=args.target_tokens, microsteps_completed=0,
                      optimizer_steps_completed=0, losses=[])
        for optimizer_step in range(args.optimizer_steps):
            optimizer.zero_grad(set_to_none=True)
            for index in range(args.microsteps):
                loss = model(input_ids=inputs, attention_mask=mask, labels=labels).loss
                require(loss.ndim == 0 and torch.isfinite(loss).item(), 'Nonfinite training loss')
                report['losses'].append(float(loss.detach().item()))
                (loss / args.microsteps).backward()
                del loss
                report['microsteps_completed'] += 1
                event('backward_completed', optimizer_step=optimizer_step + 1, microstep=index + 1)
            devices = set()
            for _, parameter in parameters:
                require(parameter.grad is not None and torch.isfinite(parameter.grad).all().item(), 'Missing/nonfinite adapter gradient')
                devices.add(str(parameter.grad.device))
            require(devices == {'cuda:0', 'cuda:1'}, 'Finite gradients required on both GPUs')
            report['finite_gradient_devices'] = sorted(devices)
            norm = torch.nn.utils.clip_grad_norm_([p for _, p in parameters], 1.0, error_if_nonfinite=True)
            report['gradient_norm_before_clip'] = float(norm.item())
            optimizer.step()
            report['optimizer_steps_completed'] = optimizer_step + 1
            require(all(torch.isfinite(p).all().item() for _, p in parameters), 'Nonfinite updated adapter')
            event('optimizer_completed', optimizer_step=optimizer_step + 1)
        after = adapter_hash(torch, parameters)
        report.update(adapter_before_sha256=before, adapter_after_sha256=after, adapter_changed=before != after)
        require(before != after, 'Optimizer did not change adapter')
    else:
        model.eval()
        model.config.use_cache = True
        kwargs = dict(input_ids=inputs, attention_mask=mask, max_new_tokens=args.new_tokens,
                      do_sample=False, use_cache=True, logits_to_keep=1)
        if args.force_budget:
            kwargs['min_new_tokens'] = args.new_tokens
        with torch.inference_mode():
            generated = model.generate(**kwargs)
        count = generated.shape[1] - inputs.shape[1]
        require(0 < count <= args.new_tokens, 'Invalid generated token count')
        require(not args.force_budget or count == args.new_tokens, 'Forced generation budget not reached')
        report.update(actual_generated_tokens=count, actual_total_tokens=generated.shape[1],
                      generation_budget_forced=args.force_budget, generation_budget_reached=count == args.new_tokens)
    synchronize(torch)
    report['measured_phase_seconds'] = time.monotonic() - started
    report['timing_scope'] = 'synchronized post-load phase; includes input-independent adapter hashing/optimizer setup for train'
    report['final_placement'] = placement(model)
    event('probe_completed')


def main(argv=None):
    args = arguments(argv)
    require(not os.environ.get('UNSLOTH_TILED_MLP'), 'Inherited tiled MLP override is forbidden')
    environment()
    out = confined(ROOT / 'work' / 'probes' / (dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:12]))
    out.mkdir(parents=True, exist_ok=False)
    report = {'schema_version': 'malssi.dualgpu-capacity-probe.v4', 'status': 'running',
              'arguments': vars(args), 'gpu_uuids': list(GPUS), 'model_path': str(MODEL),
              'requested_device_map': requested_device_map(args.layer_split),
              'script_sha256': hashlib.sha256(SCRIPT_PATH.read_bytes()).hexdigest(),
              'probe_directory': str(out), 'context_limit': CONTEXT_LIMIT, 'capacity_maximum_claimed': False,
              'gpu_memory_scope': 'PyTorch allocator peaks since before model load; not device-wide memory'}
    def save():
        temporary = out / 'result.json.tmp'
        temporary.write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False) + '\n')
        temporary.replace(out / 'result.json')
    def event(name, **values):
        with (out / 'events.log').open('a') as handle:
            handle.write(json.dumps({'event': name, 'utc': dt.datetime.now(dt.timezone.utc).isoformat(),
                                     'monotonic_seconds': time.monotonic(), **values}, allow_nan=False) + '\n')
        save()
    handles, torch = [], None
    began = time.monotonic()
    def interrupted(signum, frame):
        raise InterruptedError('Probe interrupted by signal ' + str(signum))
    signal.signal(signal.SIGTERM, interrupted)
    try:
        event('probe_start')
        report['library_versions'] = versions()
        report['idle_snapshot'] = lock_and_check(handles)
        event('both_gpu_locks_acquired')
        from unsloth import FastModel
        import torch as torch_module
        torch = torch_module
        report['torch_runtime'] = {'version': str(torch.__version__), 'cuda': torch.version.cuda}
        probe(args, report, event, torch, FastModel)
        report['status'] = 'passed'
    except BaseException as exc:
        message = str(exc)
        report.update(status='failed', error_type=type(exc).__name__, error=message,
                      oom=isinstance(exc, MemoryError) or 'out of memory' in message.lower())
        (out / 'error.log').write_text(traceback.format_exc())
    finally:
        report['total_process_seconds'] = time.monotonic() - began
        if 'phase_started_monotonic' in report:
            report['phase_elapsed_until_exit_seconds'] = time.monotonic() - report['phase_started_monotonic']
        report['gpu_memory'] = []
        if torch is not None:
            for index, gpu in enumerate(GPUS):
                try:
                    report['gpu_memory'].append({'uuid': gpu, 'logical_device': index,
                        'peak_allocated_bytes': torch.cuda.max_memory_allocated(index),
                        'peak_reserved_bytes': torch.cuda.max_memory_reserved(index)})
                except Exception as exc:
                    report['gpu_memory'].append({'uuid': gpu, 'measurement_error': type(exc).__name__})
        else:
            report['gpu_memory'] = [{'uuid': gpu, 'peak_allocated_bytes': None, 'peak_reserved_bytes': None}
                                    for gpu in GPUS]
        for handle in reversed(handles):
            handle.close()
        event('probe_end', status=report['status'])
    print(json.dumps({'status': report['status'], 'result': str(out / 'result.json')}))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
