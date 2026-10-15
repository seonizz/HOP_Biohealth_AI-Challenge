#!/usr/bin/env python3
"""Inbound-only snapshot of allowlisted serving code and non-secret metadata."""
import argparse
import base64
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

REMOTE = r'''
import base64, hashlib, json
from pathlib import Path
from importlib import metadata
import platform
root = Path('/home/slim/choieram/model_Training/trained_model_api')
files = ['server.py', 'backend.py', 'active_cache_server.py', 'active_cache_runtime.py', 'inference_decode.py', 'config.json', 'run_server.sh']
config = json.loads((root / 'config.json').read_text())
files += [config['active_cache_policy'], str(Path(config['checkpoint_path']) / 'CHECKPOINT.json'), str(Path(config['checkpoint_path']) / 'adapter_config.json'), 'runtime/decode-opt-20261010/qualification.json']
model = Path('/home/slim/choieram/models/gemma-4-31B-it-unsloth-bnb-4bit')
files += [str(model / n) for n in ('chat_template.jinja', 'tokenizer_config.json', 'special_tokens_map.json', 'generation_config.json') if (model / n).exists()]
out = {'files': [], 'python': platform.python_version(), 'libraries': {}}
for name in ('torch', 'transformers', 'tokenizers', 'unsloth', 'unsloth_zoo', 'peft', 'bitsandbytes', 'accelerate', 'triton'):
    try: out['libraries'][name] = metadata.version(name)
    except metadata.PackageNotFoundError: out['libraries'][name] = None
for name in files:
    path = Path(name) if Path(name).is_absolute() else root / name
    assert path.resolve().is_relative_to(Path('/home/slim/choieram'))
    data = path.read_bytes()
    out['files'].append({'path': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'base64': base64.b64encode(data).decode()})
tokenizer_data = (model / 'tokenizer.json').read_bytes()
out['tokenizer_json_sha256'] = hashlib.sha256(tokenizer_data).hexdigest()
print(json.dumps(out))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    args = parser.parse_args()
    command = 'cd /home/slim/choieram && /home/slim/choieram/malssi-validation-20261009/.venv/bin/python -B -c ' + shlex.quote(REMOTE)
    result = subprocess.run(['ssh', '-S', '/tmp/qwen38-slim-20522.sock', '-p', '20522', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        'slim@165.194.161.61', command], capture_output=True, check=True)
    value = json.loads(result.stdout)
    folder = args.run / 'evidence/server_snapshot'
    folder.mkdir(parents=True, exist_ok=True)
    manifest = {k: v for k, v in value.items() if k != 'files'}
    manifest['files'] = []
    for entry in value['files']:
        path = Path(entry['path'])
        name = path.name
        if name in ('qualification.json', 'CHECKPOINT.json', 'adapter_config.json'):
            name = name
        data = base64.b64decode(entry.pop('base64'))
        assert hashlib.sha256(data).hexdigest() == entry['sha256']
        (folder / name).write_bytes(data)
        manifest['files'].append({**entry, 'local_file': 'evidence/server_snapshot/' + name})
    (args.run / 'evidence/server_environment.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'files_saved': len(manifest['files']), 'evidence_directory': str(folder)}))


if __name__ == '__main__':
    main()
