"""Pinned, offline stage-1 kit preparation. This module never updates model weights."""
import csv
import gzip
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys

from .gemma4_token_validation import PINNED_TEMPLATE_SHA256, encode_example, collate_examples

AUTHORIZED_ROOT = Path('/home/slim/choieram')
GPU_UUID = 'GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c'
REQUIRED_CHECKS = ('token_contract', 'fused_loss', 'fused_gradient', 'generation_profile', 'gpu_pin', 'weights_unchanged')


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + '\n', encoding='utf-8')
    temp.replace(path)


def beneath(path, root):
    value = Path(path).resolve()
    require(value != root.resolve() and value.is_relative_to(root.resolve()), 'Path outside task root: ' + str(path))
    return value


def verify_bundle(kit):
    manifest = read_json(kit / 'MANIFEST.json')
    require(manifest.get('schema_version') == 'malssi.training-kit-files.v1', 'Unknown file manifest')
    for name, entry in manifest['files'].items():
        path = beneath(kit / name, kit)
        require(path.is_file() and path.stat().st_size == entry['bytes'] and sha_file(path) == entry['sha256'], 'Kit file changed: ' + name)
    for directory in ('counseling_pipeline', 'scripts'):
        actual = {str(p.relative_to(kit)) for p in (kit / directory).rglob('*.py')}
        declared = {p for p in manifest['files'] if p.startswith(directory + '/') and p.endswith('.py')}
        require(actual == declared, 'Executable file inventory differs')
    return manifest


def load_config(kit):
    config = read_json(kit / 'config/train.json')
    fixed = {'schema_version': 'malssi.stage1-config.v1', 'profile': 'original_counselor_continuation', 'max_length': 4096,
             'packing': False, 'truncation': False, 'enable_thinking': False, 'micro_batch_size': 1,
             'gradient_accumulation_steps': 8, 'epochs': 1, 'learning_rate': 2e-5, 'weight_decay': 0.01,
             'warmup_ratio': 0.03, 'max_grad_norm': 1.0, 'seed': 3407, 'checkpoint_every': 100,
             'lora_r': 8, 'lora_alpha': 8, 'lora_dropout': 0.0, 'gpu_uuid': GPU_UUID,
             'intended_use': 'stage1_research_only', 'hop_deployment_ready': False}
    for key, value in fixed.items():
        require(type(config.get(key)) is type(value) and config[key] == value, 'Unqualified training config: ' + key)
    return config


def bindings(kit, config):
    code = {str(p.relative_to(kit)): sha_file(p) for directory in ('counseling_pipeline', 'scripts')
            for p in sorted((kit / directory).rglob('*.py'))}
    return {'dataset_sha256': digest({n: sha_file(kit / 'data' / n) for n in ('train.jsonl.gz', 'validation.jsonl.gz', 'expected_lengths.jsonl.gz', 'export_manifest.json')}),
            'config_sha256': digest(config), 'model_sha256': digest(read_json(kit / 'config/model_fingerprint.json')),
            'template_sha256': PINNED_TEMPLATE_SHA256, 'code_sha256': digest(code),
            'environment_sha256': sha_file(kit / 'config/requirements.server.freeze.txt')}


def read_rows(kit):
    manifest = read_json(kit / 'data/export_manifest.json')
    require(manifest['training_profile'] == 'observed_counselor_imitation' and manifest['selected_cap'] == 4096, 'Wrong dataset profile')
    rows, groups, convos, all_ids = {}, {}, {}, set()
    lengths = {}
    with gzip.open(kit / 'data/expected_lengths.jsonl.gz', 'rt', encoding='utf-8') as stream:
        for line in stream:
            item = json.loads(line)
            require(item['id'] not in lengths and item['status'] == 'encoded', 'Invalid length ledger')
            lengths[item['id']] = item
    for split, count in (('train', 15512), ('validation', 1724)):
        path = kit / 'data' / (split + '.jsonl.gz')
        entry = manifest['files'][path.name]
        require(sha_file(path) == entry['sha256'] and path.stat().st_size == entry['bytes'], 'Dataset hash mismatch')
        rows[split], groups[split], convos[split] = [], set(), set()
        raw_hash = hashlib.sha256()
        with gzip.open(path, 'rb') as stream:
            for line in stream:
                raw_hash.update(line)
                row = json.loads(line)
                require(row['id'] not in all_ids and row['split'] == split, 'Duplicate/wrong split')
                require(row['task'] == 'original_counselor_continuation' and row['target_origin'] == 'observed_counselor_utterance'
                        and row['caregiver_perspective_assumed'] is False, 'Non-source supervision')
                expected = lengths[row['id']]
                require(expected['split'] == split and expected['source_group_id'] == row['source_group_id']
                        and expected['source_conversation_id'] == row['source_conversation_id'], 'Length/source identity mismatch')
                require(expected['template_sha256'] == PINNED_TEMPLATE_SHA256 and 0 < expected['prefix_length'] < expected['sequence_length'] <= 4096, 'Bad token ledger')
                all_ids.add(row['id']); groups[split].add(row['source_group_id']); convos[split].add(row['source_conversation_id']); rows[split].append(row)
        require(len(rows[split]) == count == entry['rows'] and raw_hash.hexdigest() == entry['uncompressed_sha256'], 'Row count/uncompressed hash mismatch')
        require(sum(lengths[r['id']]['target_length'] for r in rows[split]) == manifest['selection'][split]['supervised_tokens'], 'Supervised token total mismatch')
    require(set(lengths) == all_ids and not groups['train'] & groups['validation'] and not convos['train'] & convos['validation'], 'Cross-split leakage or ledger coverage error')
    return rows, lengths


def configure_environment(kit, config):
    beneath(kit, AUTHORIZED_ROOT)
    require(Path.cwd().resolve().is_relative_to(AUTHORIZED_ROOT), 'Start beneath authorized server root')
    require(Path(sys.prefix).resolve().is_relative_to(AUTHORIZED_ROOT) and sys.prefix != sys.base_prefix, 'Dedicated workspace venv required')
    beneath(config['model_path'], AUTHORIZED_ROOT)
    work = beneath(kit / 'work', kit)
    work.mkdir(exist_ok=True)
    paths = {'XDG_CACHE_HOME': '.cache', 'HF_HOME': '.cache/huggingface', 'TORCH_HOME': '.cache/torch',
             'TRITON_CACHE_DIR': '.cache/triton', 'TORCHINDUCTOR_CACHE_DIR': '.cache/torchinductor',
             'TORCH_EXTENSIONS_DIR': '.cache/torch_extensions', 'TMPDIR': '.tmp',
             'PIP_CACHE_DIR': '.cache/pip', 'UV_CACHE_DIR': '.cache/uv'}
    for name, relative in paths.items():
        path = beneath(work / relative, work); path.mkdir(parents=True, exist_ok=True); os.environ[name] = str(path)
    os.environ.update(CUDA_VISIBLE_DEVICES=GPU_UUID, CUDA_DEVICE_ORDER='PCI_BUS_ID', HF_HUB_OFFLINE='1',
                      TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1', WANDB_DISABLED='true',
                      UNSLOTH_DISABLE_STATISTICS='1', DO_NOT_TRACK='1', TOKENIZERS_PARALLELISM='false',
                      OMP_NUM_THREADS='4', UNSLOTH_RETURN_LOGITS='0', PYTHONDONTWRITEBYTECODE='1')
    # An inherited override would change the qualified loss implementation.
    for key in ('UNSLOTH_CE_LOSS_N_CHUNKS', 'UNSLOTH_CE_LOSS_TARGET_GB', 'UNSLOTH_COMPILE_DISABLE'):
        require(not os.environ.get(key), 'Unsupported inherited loss override: ' + key)
    os.chdir(work)
    return work


def verify_environment(kit, config):
    actual = {name: importlib.metadata.version(name) for name in config['versions']}
    require(actual == config['versions'], 'Version mismatch: ' + str(actual))
    ce = Path(sys.prefix) / ('lib/python%d.%d/site-packages/unsloth_zoo/fused_losses/cross_entropy_loss.py' % sys.version_info[:2])
    require(sha_file(ce) == config['fused_loss_source_sha256'], 'Installed fused loss source changed')
    subprocess.run([sys.executable, '-m', 'pip', 'check'], check=True)
    expected_freeze = {line.strip().lower().replace('_', '-') for line in (kit/'config/requirements.server.freeze.txt').read_text().splitlines() if line.strip()}
    actual_freeze = {line.strip().lower().replace('_', '-') for line in subprocess.check_output([sys.executable, '-m', 'pip', 'freeze'], text=True).splitlines() if line.strip()}
    require(actual_freeze == expected_freeze, 'Full environment freeze differs from validated venv')
    model_dir = Path(config['model_path'])
    fingerprint = read_json(kit / 'config/model_fingerprint.json')
    for name, entry in fingerprint['local_file_hashes'].items():
        path = beneath(model_dir / name, model_dir)
        require(path.stat().st_size == entry['bytes'] and sha_file(path) == entry['sha256'], 'Model fingerprint mismatch: ' + name)
    return actual


def gpu_lock(work):
    import fcntl
    # Common lock is cooperative. nvidia-smi additionally checks external users.
    path = beneath(AUTHORIZED_ROOT / ('.malssi-' + GPU_UUID + '.lock'), AUTHORIZED_ROOT)
    handle = path.open('a+')
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        output = subprocess.check_output(['nvidia-smi', '--query-compute-apps=gpu_uuid,pid', '--format=csv,noheader,nounits'], text=True)
        require(not any(line.split(',')[0].strip() == GPU_UUID for line in output.splitlines()), 'GPU 0 is busy; do not switch GPU or stop other jobs')
        output = subprocess.check_output(['nvidia-smi', '--query-gpu=uuid,memory.used,utilization.gpu', '--format=csv,noheader,nounits'], text=True)
        records = list(csv.reader(output.splitlines()))
        found = [r for r in records if r[0].strip() == GPU_UUID]
        require(len(found) == 1 and int(found[0][1]) < 512 and int(found[0][2]) == 0, 'Pinned GPU is not idle')
    except BaseException:
        handle.close()
        raise
    return handle


def load_model(config):
    from unsloth import FastModel
    import torch
    from transformers import AutoTokenizer
    require(torch.cuda.device_count() == 1 and str(torch.cuda.get_device_properties(0).uuid).removeprefix('GPU-') == GPU_UUID.removeprefix('GPU-'), 'Physical GPU pin mismatch')
    tokenizer = AutoTokenizer.from_pretrained(config['model_path'], local_files_only=True)
    model, _ = FastModel.from_pretrained(model_name=config['model_path'], max_seq_length=4096, dtype=torch.bfloat16,
                                         load_in_4bit=True, full_finetuning=False, device_map={'': 0}, local_files_only=True)
    model = FastModel.get_peft_model(model, finetune_vision_layers=False, finetune_language_layers=True,
                                    finetune_attention_modules=True, finetune_mlp_modules=True, r=8, lora_alpha=8,
                                    lora_dropout=0, bias='none', random_state=3407, use_gradient_checkpointing='unsloth')
    require({str(p.device) for p in model.parameters()} == {'cuda:0'} and model.is_loaded_in_4bit, 'Model placement/quantization mismatch')
    parameters = [(n, p) for n, p in model.named_parameters() if p.requires_grad]
    require(parameters and all('lora_' in n for n, p in parameters) and sum(p.numel() for n, p in parameters) == 61214720, 'Unexpected trainable parameters')
    model.config.use_cache = False
    torch.set_float32_matmul_precision('highest')
    return model, tokenizer


_TOKENIZER = None


def _initialize_tokenizer(model_path):
    global _TOKENIZER
    from transformers import AutoTokenizer
    _TOKENIZER = AutoTokenizer.from_pretrained(model_path, local_files_only=True)


def _encode(row):
    value = encode_example(row, _TOKENIZER, max_length=4096)
    value['id'] = row['id']
    return value


def prepare_tokens(kit, config, current_bindings):
    from concurrent.futures import ProcessPoolExecutor
    import multiprocessing
    rows, lengths = read_rows(kit)
    import uuid
    destination = beneath(kit / 'work/tokens', kit)
    require(not destination.exists(), 'Token cache already exists; use verify-cache')
    directory = beneath(kit / ('work/tokens-building-' + uuid.uuid4().hex), kit)
    directory.mkdir(parents=True)
    files = {}
    with ProcessPoolExecutor(max_workers=4, mp_context=multiprocessing.get_context('spawn'), initializer=_initialize_tokenizer, initargs=(config['model_path'],)) as pool:
        for split in ('train', 'validation'):
            path = directory / (split + '.jsonl.gz')
            count = supervised = total = 0
            with gzip.open(path, 'wt', encoding='utf-8') as stream:
                for row in pool.map(_encode, rows[split], chunksize=32):
                    ledger = lengths[row['id']]
                    require(all(row[key] == ledger[key] for key in ('prefix_length', 'target_length', 'sequence_length', 'template_sha256')), 'Fresh tokenization differs from audited ledger')
                    collate_examples([row], 0, 4096)
                    stream.write(json.dumps(row, separators=(',', ':')) + '\n')
                    count += 1; supervised += row['target_length']; total += row['sequence_length']
                    if count % 1000 == 0:
                        print(json.dumps({'event': 'tokenized', 'split': split, 'rows': count}), flush=True)
            files[path.name] = {'sha256': sha_file(path), 'rows': count, 'supervised_tokens': supervised, 'input_tokens': total}
    result = {'status': 'passed', 'bindings': current_bindings, 'files': files}
    write_json(directory / 'manifest.json', result)
    directory.rename(destination)
    return result


def load_tokens(kit, current_bindings):
    directory = kit / 'work/tokens'
    manifest = read_json(directory / 'manifest.json')
    require(manifest['status'] == 'passed' and manifest['bindings'] == current_bindings, 'Token cache bindings changed')
    source, lengths = read_rows(kit)
    values = {}
    for split in ('train', 'validation'):
        path = directory / (split + '.jsonl.gz')
        require(sha_file(path) == manifest['files'][path.name]['sha256'], 'Token cache hash mismatch')
        with gzip.open(path, 'rt', encoding='utf-8') as stream:
            values[split] = [json.loads(line) for line in stream]
        require([r['id'] for r in values[split]] == [r['id'] for r in source[split]], 'Cached row order changed')
        for row in values[split]:
            collate_examples([row], 0, 4096)
            require(all(row[k] == lengths[row['id']][k] for k in ('sequence_length', 'prefix_length', 'target_length', 'template_sha256')), 'Cache ledger mismatch')
    return values
