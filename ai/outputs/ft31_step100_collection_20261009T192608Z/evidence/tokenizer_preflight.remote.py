
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
