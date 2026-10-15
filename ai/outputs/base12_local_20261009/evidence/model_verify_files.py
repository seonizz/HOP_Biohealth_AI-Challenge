#!/usr/bin/env python3
"""Read-only model-store audit. Writes only model_* evidence in the run directory."""
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
import hashlib
import json
import math
import struct
import time

RUN = Path(__file__).resolve().parents[1]
STORE = Path('/Users/chihun/.ollama/models')
COMPAT = STORE / 'manifests/registry.ollama.ai/library/gemma4/12b'
INDEX = STORE / 'manifests-v2/ollama.com/library/gemma4/12b'
started = datetime.now(timezone.utc)
t0 = time.monotonic()

def sha_bytes(data):
    return hashlib.sha256(data).hexdigest()

def fingerprint(path, expected_hash=None, expected_size=None):
    row = {'path': str(path), 'expected_sha256': expected_hash, 'expected_size_bytes': expected_size,
           'exists': path.is_file(), 'hash_verified': False, 'size_verified': False, 'verified': False}
    if not row['exists']:
        return row
    before = path.stat()
    h = hashlib.sha256()
    counted = 0
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            h.update(block)
            counted += len(block)
    after = path.stat()
    unchanged = (before.st_size, before.st_mtime_ns, before.st_ino) == (after.st_size, after.st_mtime_ns, after.st_ino)
    row.update(actual_sha256=h.hexdigest(), actual_size_bytes=counted,
               mtime_utc=datetime.fromtimestamp(after.st_mtime, timezone.utc).isoformat(),
               unchanged_during_hash=unchanged,
               hash_verified=expected_hash is not None and h.hexdigest() == expected_hash,
               size_verified=expected_size is not None and counted == expected_size)
    row['verified'] = row['hash_verified'] and (expected_size is None or row['size_verified']) and unchanged
    return row

def read_json(path):
    return json.loads(path.read_bytes())

def blob_path(digest):
    return STORE / 'blobs' / digest.replace(':', '-')

def save(name, data):
    (RUN / name).write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')

compat = read_json(COMPAT)
index = read_json(INDEX)
show_path = RUN / 'show.json'
show = read_json(show_path)
selected = next(m for m in index['manifests'] if m.get('runner') == 'mlx')
selected_manifest = read_json(blob_path(selected['digest']))
refs = {}

def add_ref(ref, source, required):
    digest = ref['digest']
    entry = refs.setdefault(digest, {'digest': digest, 'required_for_selected_installation': False, 'references': []})
    entry['required_for_selected_installation'] |= required
    evidence = {k: v for k, v in ref.items() if k != 'digest'}
    evidence['source_manifest'] = str(source)
    if evidence not in entry['references']:
        entry['references'].append(evidence)

def walk_manifest(manifest, source, required):
    if 'config' in manifest:
        add_ref(manifest['config'], source, required)
    for layer in manifest.get('layers', []):
        add_ref(layer, source, required)
    for child in manifest.get('manifests', []):
        add_ref(child, source, required and child.get('runner') == 'mlx')

walk_manifest(compat, COMPAT, True)
walk_manifest(index, INDEX, True)
walk_manifest(selected_manifest, blob_path(selected['digest']), True)
# The installed compatibility manifest embeds the original manifest-list blob.
for layer in compat['layers']:
    if layer['mediaType'] == 'application/vnd.ollama.manifest.list.v2+json':
        walk_manifest(read_json(blob_path(layer['digest'])), blob_path(layer['digest']), True)

blob_rows = []
for n, (digest, ref) in enumerate(refs.items(), 1):
    sizes = sorted({x['size'] for x in ref['references'] if 'size' in x})
    row = fingerprint(blob_path(digest), digest.split(':', 1)[1], sizes[0] if sizes else None)
    row.update(ref)
    row['reference_sizes_consistent'] = len(sizes) <= 1
    row['verified'] = row['verified'] and row['reference_sizes_consistent']
    blob_rows.append(row)
    if n % 200 == 0:
        print(f'Hashed {n}/{len(refs)} unique referenced blobs', flush=True)

index_layer = next(x for x in compat['layers'] if x['mediaType'] == 'application/vnd.ollama.manifest.list.v2+json')
manifest_rows = [fingerprint(COMPAT), fingerprint(INDEX, index_layer['digest'].split(':')[1], index_layer['size'])]
manifest_rows[0]['verification_note'] = 'Locally generated compatibility manifest has no independently supplied expected digest; fingerprint only.'
manifest_rows[1]['verification_note'] = 'Compared with embedded original manifest-list digest.'

layers_by_name = {a['name']: a for a in compat['layers'] if a.get('name')}
json_metadata = {name: read_json(blob_path(a['digest'])) for name, a in layers_by_name.items()
                 if a['mediaType'] == 'application/vnd.ollama.image.json' and name not in ('tokenizer.json', 'draft/tokenizer.json')}
container_config = read_json(blob_path(compat['config']['digest']))
config = json_metadata['config.json']
generation = json_metadata['generation_config.json']
quant = json_metadata['hf_quant_config.json']

inventory = []
physical_type_count = Counter()
logical_by_component = defaultdict(int)
show_by_name = {t['name']: t for t in show['tensors']}
header_errors = []
for a in compat['layers']:
    if a['mediaType'] != 'application/vnd.ollama.image.tensor':
        continue
    p = blob_path(a['digest'])
    with p.open('rb') as f:
        size_bytes = f.read(8)
        header_size = struct.unpack('<Q', size_bytes)[0]
        if header_size > a['size'] - 8:
            raise ValueError(f'Invalid safetensors header size: {p}')
        header = json.loads(f.read(header_size))
    data_size = p.stat().st_size - 8 - header_size
    tensors = {k: v for k, v in header.items() if k != '__metadata__'}
    for name, tensor in tensors.items():
        physical_type_count[tensor['dtype']] += 1
        low, high = tensor['data_offsets']
        if not 0 <= low <= high <= data_size:
            header_errors.append({'path': str(p), 'tensor': name, 'reason': 'offset out of bounds'})
    core = tensors[a['name']]
    quant_type = header.get('__metadata__', {}).get('quant_type')
    logical_shape = list(core['shape'])
    if quant_type == 'nvfp4':
        # 32-bit stored word / 4-bit configured weight = 8 logical elements.
        assert core['dtype'] == 'U32'
        logical_shape[-1] *= 8
    count = math.prod(logical_shape)
    component = 'draft' if a['name'].startswith('draft.') else '.'.join(a['name'].split('.')[:2])
    logical_by_component[component] += count
    shown = show_by_name.get(a['name'])
    inventory.append({'name': a['name'], 'path': str(p), 'digest': a['digest'], 'size_bytes': a['size'],
                      'header_size_bytes': header_size, 'data_size_bytes': data_size,
                      'safetensors_header': header, 'logical_shape': logical_shape,
                      'logical_parameter_count': count, 'component': component,
                      'logical_shape_matches_show': shown is not None and logical_shape == shown['shape'],
                      'listed_in_show': shown is not None})

tokenizers = {}
for prefix in ('', 'draft/'):
    name = prefix + 'tokenizer.json'
    tok_ref = layers_by_name[name]
    tok = read_json(blob_path(tok_ref['digest']))
    tc = json_metadata[prefix + 'tokenizer_config.json']
    special_map = {a['content']: a['id'] for a in tok['added_tokens'] if a.get('special')}
    vocab = tok['model']['vocab']
    tokenizers[prefix or 'main'] = {
        'path': str(blob_path(tok_ref['digest'])), 'sha256': tok_ref['digest'].split(':')[1],
        'tokenizer_config_path': str(blob_path(layers_by_name[prefix + 'tokenizer_config.json']['digest'])),
        'tokenizer_config_sha256': layers_by_name[prefix + 'tokenizer_config.json']['digest'].split(':')[1],
        'model_type': tok['model']['type'], 'base_vocabulary_size': len(vocab),
        'added_token_count': len(tok['added_tokens']), 'special_tokens': special_map,
        'bos': {'token': tc.get('bos_token'), 'id': vocab.get(tc.get('bos_token'))},
        'eos': {'token': tc.get('eos_token'), 'id': vocab.get(tc.get('eos_token'))},
        'pad': {'token': tc.get('pad_token'), 'id': vocab.get(tc.get('pad_token'))},
        'padding_side': tc.get('padding_side'), 'padding_config': tok.get('padding'),
        'chat_template_present_in_tokenizer_config': 'chat_template' in tc,
        'chat_template_sha256': sha_bytes(tc['chat_template'].encode()) if isinstance(tc.get('chat_template'), str) else None,
        'configured_model_max_length': tc.get('model_max_length'),
        'configured_model_max_length_note': 'Tokenizer sentinel; use text_config.max_position_embeddings for architectural context limit.'}

def revision_fields(obj, path=''):
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            child = f'{path}.{k}' if path else k
            if any(t in k.lower() for t in ('revision', 'commit', '_name_or_path')):
                found.append({'field': child, 'value': v})
            found.extend(revision_fields(v, child))
    elif isinstance(obj, list):
        for n, v in enumerate(obj):
            if isinstance(v, (dict, list)):
                found.extend(revision_fields(v, f'{path}[{n}]'))
    return found

required = [r for r in blob_rows if r['required_for_selected_installation']]
optional = [r for r in blob_rows if not r['required_for_selected_installation']]
show_params = sum(math.prod(t['shape']) for t in show['tensors'])
all_params = sum(t['logical_parameter_count'] for t in inventory)
not_shown = [{'name': t['name'], 'logical_shape': t['logical_shape'], 'logical_parameter_count': t['logical_parameter_count']} for t in inventory if not t['listed_in_show']]
quant_groups = {g: {k: (len(v) if k == 'targets' else v) for k, v in c.items()}
                for g, c in config['quantization_config']['config_groups'].items()}
finished = datetime.now(timezone.utc)
result = {
    'schema_version': 1, 'model_tag': 'gemma4:12b',
    'started_at_utc': started.isoformat(), 'completed_at_utc': finished.isoformat(),
    'completed_at_asia_seoul': finished.astimezone(ZoneInfo('Asia/Seoul')).isoformat(),
    'elapsed_seconds': round(time.monotonic() - t0, 3),
    'method': {'hash_algorithm': 'SHA256', 'stream_chunk_bytes': 8 * 1024 * 1024,
               'model_store_access': 'read_only', 'downloads': False, 'inference': False, 'api_calls': False,
               'raw_weight_copies': False, 'tensor_inspection': 'Safetensors JSON headers only; no tensor values loaded.'},
    'verified': all(r['verified'] for r in required) and manifest_rows[1]['verified'] and not header_errors,
    'verification_scope': 'Integrity of selected local MLX installation against local content-addressed manifests; not upstream authenticity or numerical correctness.',
    'summary': {'selected_required_unique_blobs': len(required),
                'selected_verified_blobs': sum(r['verified'] for r in required),
                'selected_expected_total_bytes': sum(r['expected_size_bytes'] or 0 for r in required),
                'selected_actual_total_bytes': sum(r.get('actual_size_bytes', 0) for r in required),
                'referenced_unique_blobs_including_alternative_runner': len(blob_rows),
                'all_referenced_blobs_present': all(r['exists'] for r in blob_rows),
                'missing_selected_blobs': [r['digest'] for r in required if not r['exists']],
                'invalid_selected_blobs': [r['digest'] for r in required if not r['verified']],
                'missing_alternative_runner_blobs': [r['digest'] for r in optional if not r['exists']],
                'tensor_blob_count': len(inventory), 'header_validation_errors': header_errors},
    'identity': {'runner': selected_manifest.get('runner'), 'format': selected_manifest.get('format'),
                 'family': show['details']['family'], 'quantization_level': show['details']['quantization_level'],
                 'selected_distribution_manifest_digest': selected['digest'],
                 'distribution_index_digest': index_layer['digest'],
                 'local_compatibility_manifest_sha256': manifest_rows[0]['actual_sha256'],
                 'upstream_google_revision': None, 'upstream_revision_verified': False,
                 'local_revision_fields': revision_fields(json_metadata),
                 'note': 'Distribution digest is not a Google/Hugging Face source revision. No source revision is established by local metadata.'},
    'model_metadata': {'show_details': show['details'], 'show_model_info': show['model_info'],
                       'config_architectures': config['architectures'], 'text_config': config['text_config'],
                       'config_declared_dtype': config['dtype'], 'generation_config': generation,
                       'quantization': {'producer': quant.get('producer'),
                                        'algorithm': quant['quantization']['quant_algo'],
                                        'kv_cache_quant_algo_declared_in_metadata': quant['quantization'].get('kv_cache_quant_algo'),
                                        'kv_cache_runtime_dtype_verified': False,
                                        'quantized_layers_count': len(quant['quantization']['quantized_layers']),
                                        'config_groups': quant_groups},
                       'container_config': container_config,
                       'logical_parameter_counts': {'from_show_metadata': show['model_info']['general.parameter_count'],
                                                    'sum_of_show_tensor_shapes': show_params,
                                                    'sum_of_all_blob_logical_shapes_including_draft': all_params,
                                                    'by_component_including_draft': dict(logical_by_component),
                                                    'main_excluding_draft': all_params - logical_by_component['draft'],
                                                    'draft': logical_by_component['draft'],
                                                    'blob_tensors_omitted_by_show': not_shown,
                                                    'note': 'For nvfp4 U32 storage, logical last dimension = stored dimension * 8; scaling tensors are excluded from logical parameter count. Show total includes draft and omits four bias tensors.'},
                       'physical_safetensors_entry_dtypes': dict(physical_type_count),
                       'show_tensors_count': len(show['tensors']),
                       'show_tensor_type_counts': dict(Counter(t['type'] for t in show['tensors'])),
                       'all_show_shapes_match_blob_headers': all(t['logical_shape_matches_show'] for t in inventory if t['listed_in_show'])},
    'tokenizers': tokenizers,
    'chat_template': {'source': str(show_path), 'value': show.get('template'),
                      'utf8_sha256': sha_bytes(show.get('template', '').encode()),
                      'renderer': container_config.get('renderer'), 'parser': container_config.get('parser'),
                      'renderer_implementation_fingerprint': None,
                      'note': 'The visible template is a passthrough. Effective chat serialization uses built-in gemma4 renderer; its implementation was not captured or evaluated in this read-only file audit. No chat_template field is present in packaged tokenizer configs.'},
    'eos_pad': {'config_eos_token_id': config.get('eos_token_id'),
                'text_config_eos_token_id': config['text_config'].get('eos_token_id'),
                'generation_config_eos_token_id': generation.get('eos_token_id'),
                'text_config_pad_token_id': config['text_config'].get('pad_token_id'),
                'generation_config_pad_token_id': generation.get('pad_token_id'),
                'note': 'Generation stop IDs differ from text config EOS; retain each source separately.'},
    'input_show_fingerprint': fingerprint(show_path),
    'manifest_files': manifest_rows,
    'blobs': blob_rows,
    'evidence_files': ['evidence/model_verify_files.py', 'evidence/model_tensor_inventory.json', 'evidence/model_metadata.json'],
    'known_limitations': [
        'Hashes establish consistency with local manifests, not authenticity relative to an independently retrieved upstream release.',
        'The upstream Google revision was not established and must not be replaced with a distribution manifest digest.',
        'The alternate llama.cpp/GGUF manifest advertised by the index is not installed; only the selected MLX artifact is verified complete.',
        'The installed artifact is mixed-precision NVFP4/BF16 with a draft model, not unquantized original BF16 weights.',
        'Ollama show parameter count includes draft parameters and omits four vision bias tensors; exact inventory counts are provided separately.',
        'The built-in gemma4 renderer implementation and its effective serialized prompt were not verified.',
        'No inference, download, API call, runtime KV-cache inspection, benchmark, or numerical equivalence validation was performed.'
    ]
}
save('evidence/model_tensor_inventory.json', {'description': 'Tensor headers and derived shape counts only; no weight data.', 'tensors': inventory})
save('evidence/model_metadata.json', {'container_config': container_config, 'packaged_json_metadata': json_metadata})
save('model_verification.json', result)
print(json.dumps({'verified': result['verified'], 'summary': result['summary'], 'parameter_counts': result['model_metadata']['logical_parameter_counts'], 'elapsed_seconds': result['elapsed_seconds']}, indent=2))
assert result['verified'], 'Selected installation integrity check failed'
assert result['model_metadata']['all_show_shapes_match_blob_headers'], 'Show/header shape mismatch'
assert show_params == show['model_info']['general.parameter_count']
assert tokenizers['main']['eos']['id'] == 1 and tokenizers['main']['pad']['id'] == 0
