#!/usr/bin/env python3
"""Verify the pinned A_original files and launch their loopback-only llama server.

No downloads, model conversion, background processes, or process termination.
--check and --print-command perform verification without loading the model.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = Path(__file__).with_name('a_original_manifest.json')


def server_environment():
    # Inherited llama flags could activate a remote RPC device, tools, downloads,
    # or a different bind address. This launcher uses the checked manifest only.
    return {key: value for key, value in os.environ.items()
            if not key.startswith('LLAMA_') and key not in {'HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'}}


def verified_file(entry):
    path = (ROOT / entry['path']).resolve(strict=True)
    path.relative_to(ROOT)
    if not path.is_file():
        raise ValueError('Expected a regular model file: ' + entry['path'])
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(8 * 1024 * 1024), b''):
            digest.update(chunk)
    if digest.hexdigest() != entry['sha256']:
        raise ValueError('SHA-256 mismatch: ' + entry['path'])
    return path


def checked_command(manifest):
    if manifest['schema_version'] != 1:
        raise ValueError('Unsupported manifest schema version')
    server = manifest['server']
    if server['host'] != '127.0.0.1' or server['port'] != 11436:
        raise ValueError('This launcher requires loopback port 11436')
    if server['context_shift'] or not server['jinja']:
        raise ValueError('Context shifting must be disabled and Jinja enabled')
    binary = Path(server['binary'])
    if not binary.is_file() or not os.access(binary, os.X_OK):
        raise ValueError('Installed llama-server is missing or not executable')
    model = verified_file(manifest['base_model'])
    adapter = verified_file(manifest['adapter'])
    command = [str(binary), '--model', str(model), '--lora', str(adapter),
               '--alias', manifest['model_alias'], '--host', server['host'],
               '--port', str(server['port']), '--ctx-size', str(server['context_size']),
               '--parallel', str(server['parallel_slots']),
               '--flash-attn', server['flash_attention'],
               '--cache-type-k', server['cache_type_k'],
               '--cache-type-v', server['cache_type_v'],
               '--no-context-shift', '--reasoning-budget', str(server['reasoning_budget']),
               '--jinja', '--offline', '--no-ui']
    help_text = subprocess.run([str(binary), '--help'], check=True, capture_output=True,
                               text=True, env=server_environment(), timeout=30).stdout
    missing = [flag for flag in command[1:] if flag.startswith('--') and flag not in help_text]
    if missing:
        raise ValueError('Installed llama-server lacks required flags: ' + ', '.join(missing))
    return command


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check', action='store_true', help='Verify both hashes and supported flags, then exit')
    mode.add_argument('--print-command', action='store_true', help='Verify and print the launch command without executing it')
    args = parser.parse_args()
    try:
        manifest = json.loads(MANIFEST.read_text())
        command = checked_command(manifest)
        if args.print_command:
            print(shlex.join(command))
        elif args.check:
            print(json.dumps({'verified': True, 'model': manifest['model_alias'],
                              'endpoint': 'http://127.0.0.1:11436/v1',
                              'base_sha256': manifest['base_model']['sha256'],
                              'adapter_sha256': manifest['adapter']['sha256'],
                              'training_base_revision': manifest['adapter']['training_base_revision']}))
        else:
            os.execve(command[0], command, server_environment())
        return 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print('A_original launcher: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
