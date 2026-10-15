#!/usr/bin/env python3
"""CPU tokenizer-only preflight on the explicitly approved inference server."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import collect_ft31_comparison as collector

REMOTE = r'''
import hashlib,json,pathlib,sys,types
api=pathlib.Path('model_Training/trained_model_api').resolve()
config=json.loads((api/'config.json').read_text())
kit=pathlib.Path(config['kit_path'])
train=json.loads((kit/'config/train.json').read_text())
sys.path[:0]=[str(api),str(kit)]
from transformers import AutoTokenizer
from active_cache_runtime import CacheRuntime
from counseling_pipeline.gemma4_token_validation import CONTROL_PATTERN,_check_template
from server import validate_request
tokenizer=AutoTokenizer.from_pretrained(train['model_path'],local_files_only=True)
runtime=CacheRuntime.__new__(CacheRuntime)
runtime.tokenizer=tokenizer
runtime.backend=types.SimpleNamespace(control_pattern=CONTROL_PATTERN)
results=[]
for row in json.load(sys.stdin):
    record=row['input_record']; messages=record['messages']
    item={key:row[key] for key in ('case_id','task','input_sha256')}
    canonical=json.dumps(record,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
    assert hashlib.sha256(canonical).hexdigest()==row['input_sha256']
    ids=runtime.encode(messages)
    doc_text=tokenizer.apply_chat_template(messages,tokenize=False,add_generation_prompt=True,enable_thinking=False)
    doc_ids=tokenizer(doc_text,add_special_tokens=False,truncation=False)['input_ids']
    reserved=32 if row['task']=='action' else 512
    eligible=len(ids)+reserved<=4096
    item.update(eligible=eligible,input_tokens_preflight=len(ids),input_tokens_doc_path=len(doc_ids),
        exclusion_reason=None if eligible else 'comparison_context_limit',max_new_tokens=reserved,
        tokens_equal=ids==doc_ids,prompt_token_ids_sha256=hashlib.sha256(json.dumps(ids,separators=(',',':')).encode()).hexdigest(),
        tokenizer_ok=True,message_count=len(messages))
    try:
        validate_request({'model':config['model_id'],'messages':messages,'max_tokens':reserved,'temperature':0,'stream':False},config)
        item['api_supported']=True
    except ValueError: item['api_supported']=False
    results.append(item)
out={'cases':results,'summary':{'assigned':len(results),'eligible':sum(x['eligible'] for x in results),
    'api_supported':sum(x['api_supported'] for x in results),'direct_vs_actual_identical':sum(x['tokens_equal'] for x in results)},
    'template_sha256':_check_template(tokenizer),'runtime_code_sha256':hashlib.sha256((api/'active_cache_runtime.py').read_bytes()).hexdigest(),
    'tokenizer_class':type(tokenizer).__name__,'model_path':train['model_path'],
    'comparison_context_tokens':4096,'enable_thinking':False,'truncation':False,'gpu_model_loaded':False,
    'tokenizer_path':str(pathlib.Path(train['model_path']).resolve()),'server_config_sha256':hashlib.sha256((api/'config.json').read_bytes()).hexdigest()}
print(json.dumps(out,ensure_ascii=False,sort_keys=True))
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run', type=Path)
    args = parser.parse_args()
    run = args.run.resolve()
    cases = collector.lines(run / 'case_manifest.jsonl')
    rows = [{k: c[k] for k in ('task', 'case_id', 'input_sha256')} | {'input_record': collector.read(run / c['input_file'])} for c in cases]
    command = ('cd /home/slim/choieram && PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 '
        'TOKENIZERS_PARALLELISM=false HF_HOME=/home/slim/choieram/model_Training/trained_model_api/runtime/cache/huggingface '
        '/home/slim/choieram/malssi-validation-20261009/.venv/bin/python -B -c ' + shlex.quote(REMOTE))
    result = subprocess.run(['ssh', '-S', '/tmp/qwen38-slim-20522.sock', '-p', '20522', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        'slim@165.194.161.61', command], input=collector.encoded(rows), capture_output=True, check=True, timeout=180)
    value = json.loads(result.stdout)
    assert value['summary']['assigned'] == 94
    (run / 'preflight.json').write_bytes(result.stdout)
    (run / 'evidence/preflight_ft31_comparison.py').write_bytes(Path(__file__).read_bytes())
    (run / 'evidence/tokenizer_preflight.remote.py').write_text(REMOTE)
    collector.health(run, 'http://127.0.0.1:18080', 'before')
    health = collector.read(run / 'evidence/health_before.json')
    manifest = collector.read(run / 'run_manifest.json')
    manifest.update(preflight_sha256=collector.sha(result.stdout),
        health_before_sha256=collector.sha((run / 'evidence/health_before.json').read_bytes()),
        expected_system_fingerprint=health['system_fingerprint'],requested_system_fingerprint=collector.FINGERPRINT,
        actual_server_config=collector.read(run / 'evidence/server_snapshot/config.json'),
        actual_tokenizer={'template_sha256':value['template_sha256'],'tokenizer_path':value['tokenizer_path'],
            'runtime_code_sha256':value['runtime_code_sha256'],'preflight_code_sha256':collector.sha(Path(__file__).read_bytes())},
        eligible=dict(__import__('collections').Counter(c['task'] for c in value['cases'] if c['eligible'])),
        compatibility={'supported':value['summary']['api_supported'],'unsupported':94-value['summary']['api_supported']},
        actual_decoding={'temperature':0,'do_sample':False,'top_p':1,'enable_thinking':False,
            'server_config_file':'evidence/server_snapshot/config.json'},
        generation_ready=False,
        deviations_from_document=['Runtime fingerprint is a full serving-policy hash, not step/checkpoint abbreviation.',
            'Current CacheRuntime preserves historical assistant whitespace and adds empty thought channels; 32 legacy token sequences differ from the documented backend renderer.',
            'Actual API context limit is 69632; this comparison still uses 4096.'])
    collector.write(run / 'run_manifest.json', manifest)
    print(json.dumps(value['summary']))


if __name__ == '__main__':
    main()
