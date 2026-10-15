#!/usr/bin/env python3
"""Prepare and test an opt-in collection route; never modify a running API."""
import argparse
import ast
import difflib
import hashlib
import json
import math
from pathlib import Path


def once(text, old, new):
    assert text.count(old) == 1, 'Unexpected serving source; refusing patch'
    return text.replace(old, new, 1)


def validator(source):
    module = ast.parse(source)
    function = next(n for n in module.body if isinstance(n, ast.FunctionDef) and n.name == 'validate_request')
    scope = {'RequestError': ValueError, 'math': math}
    exec(compile(ast.Module(body=[function], type_ignores=[]), '<offline-validator>', 'exec'), scope)
    return scope['validate_request']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    args = parser.parse_args()
    run = args.run.resolve()
    evidence = run / 'evidence/server_snapshot'
    original = (evidence / 'server.py').read_text()
    patched = once(original, 'def validate_request(payload, config):', 'def validate_request(payload, config, *, preserve_history=False):')
    patched = once(patched,
        '        if message["role"] != expected:\n            raise RequestError("After an optional system message, alternate user and assistant messages")\n        expected = "assistant" if expected == "user" else "user"\n',
        '        if preserve_history:\n            if message["role"] not in ("user", "assistant"):\n                raise RequestError("Only an initial system and user/assistant history are allowed")\n        else:\n            if message["role"] != expected:\n                raise RequestError("After an optional system message, alternate user and assistant messages")\n            expected = "assistant" if expected == "user" else "user"\n')
    original_http = (evidence / 'active_cache_server.py').read_text()
    patched_http = once(original_http,
        "                if method == 'POST' and parts == ['v1', 'chat', 'completions']:\n",
        "                if method == 'POST' and parts in (['v1', 'chat', 'completions'], ['v1', 'collection', 'chat', 'completions']):\n")
    patched_http = once(patched_http,
        '                        messages, maximum, temperature, top_p = validate_stateless(payload, config)\n',
        "                        if parts == ['v1', 'collection', 'chat', 'completions']:\n                            messages, maximum, temperature, top_p = validate_stateless(payload, config, preserve_history=True)\n                        else:\n                            messages, maximum, temperature, top_p = validate_stateless(payload, config)\n")
    compile(patched_http, '<collection-http>', 'exec')
    strict, compatible = validator(original), validator(patched)
    config = json.loads((evidence / 'config.json').read_text())
    cases = [json.loads(s) for s in (run / 'case_manifest.jsonl').read_text().splitlines()]
    accepted_strict = 0
    for case in cases:
        messages = json.loads((run / case['input_file']).read_text())['messages']
        body = {'model': config['model_id'], 'messages': messages,
            'max_tokens': 32 if case['task'] == 'action' else 512, 'temperature': 0, 'stream': False}
        try:
            strict(body, config)
            accepted_strict += 1
        except ValueError:
            pass
        assert compatible(body, config, preserve_history=True)[0] is messages
        try:
            result = compatible(body, config)
            assert strict(body, config) == result
        except ValueError:
            try:
                strict(body, config)
            except ValueError:
                continue
            raise AssertionError('Existing strict route changed')
    assert accepted_strict == 60
    invalid = [
        [{'role':'assistant','content':'x'}],
        [{'role':'user','content':'x'},{'role':'system','content':'x'},{'role':'user','content':'x'}],
        [{'role':'tool','content':'x'},{'role':'user','content':'x'}],
        [{'role':'user','content':''}],
        [{'role':'user','content':'x','unexpected':True}],
    ]
    for messages in invalid:
        try:
            compatible({'messages':messages}, config, preserve_history=True)
        except ValueError:
            pass
        else:
            raise AssertionError('Invalid message accepted')
    for options in ({'max_tokens':True},{'temperature':float('nan')},{'stream':True},{'model':'wrong'},{'seed':3407},{'top_p':0}):
        try:
            compatible({'messages':[{'role':'user','content':'x'}],**options}, config, preserve_history=True)
        except ValueError:
            pass
        else:
            raise AssertionError('Invalid request accepted')
    folder = run / 'evidence/compatibility_candidate'
    folder.mkdir(exist_ok=True)
    (folder / 'server.py').write_text(patched)
    (folder / 'active_cache_server.py').write_text(patched_http)
    diff = ''.join(difflib.unified_diff(original.splitlines(True), patched.splitlines(True), 'server.py', 'server.py'))
    diff += ''.join(difflib.unified_diff(original_http.splitlines(True), patched_http.splitlines(True), 'active_cache_server.py', 'active_cache_server.py'))
    (folder / 'compatibility.patch').write_text(diff)
    report = {'status':'passed','original_cases':94,'unchanged_existing_route_accepted':60,
        'collection_route_accepted':94,'input_object_role_order_content_preserved':True,
        'negative_contract_checks':len(invalid)+6,'gpu_models_loaded':0,'model_generations':0,
        'production_modified':False,'new_route':'/v1/collection/chat/completions',
        'before_sha256':{n:hashlib.sha256((evidence/n).read_bytes()).hexdigest() for n in ('server.py','active_cache_server.py')},
        'after_sha256':{n:hashlib.sha256((folder/n).read_bytes()).hexdigest() for n in ('server.py','active_cache_server.py')},
        'application_requires':'Restart only the current step100 API, using existing run_server.sh; existing KV sessions will be lost.'}
    (folder / 'verification.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({k:v for k,v in report.items() if k not in ('before_sha256','after_sha256')}))


if __name__ == '__main__':
    main()
