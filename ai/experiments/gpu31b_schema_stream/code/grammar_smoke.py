"""CPU-only smoke inside this task's write sandbox, before loading the model."""
import hashlib,json,os,runpy,sys,time
from pathlib import Path

def capacity_verdict(token_rows):
 assert all(type(row.get('required_for_launch')) is bool for row in token_rows),'Every capacity case needs an explicit launch selection'
 selected=[row for row in token_rows if row['required_for_launch']]
 selected_fit=bool(selected) and all(row['revised_margin_tokens']>=0 for row in selected)
 return {'status':'passed' if selected_fit else 'failed',
  'all_recorded_requests_fit':all(row['revised_margin_tokens']>=0 for row in token_rows),
  'selected_requests_fit':selected_fit,'selected_request_count':len(selected),
  'excluded_overflows':[{key:row[key] for key in ['request','stage','revised_margin_tokens']}
   for row in token_rows if not row['required_for_launch'] and row['revised_margin_tokens']<0]}

TASK=Path(__file__).resolve().parent.parent
assert TASK==Path('/home/slim/choieram/evaluations/gpu31b_stream_20261116')
assert sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
boundary=TASK/'code/boundary.py'
assert hashlib.sha256(boundary.read_bytes()).hexdigest()=='8cd7cd20bd41a9161b553975aae717c22c78da6a32d50116e5691d92d165c6fc'
b=runpy.run_path(str(boundary));b['real_owned'](TASK);work=TASK/'smoke';b['real_owned'](work)
b['sandbox'](work,['/dev/null'])
# A failed rerun must never leave a previous successful result as its evidence.
(work/'RESULT.json').write_text(json.dumps({'status':'failed','stage':'initializing'})+'\n')
for key in ['TMPDIR','TMP','TEMP','XDG_CACHE_HOME','XDG_CONFIG_HOME','HF_HOME','TORCH_HOME','TRITON_CACHE_DIR','TVM_FFI_CACHE_DIR']:
 p=work/key.lower();p.mkdir(mode=0o700,exist_ok=True);os.environ[key]=str(p)
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',CUDA_VISIBLE_DEVICES='',TOKENIZERS_PARALLELISM='false',PYTHONDONTWRITEBYTECODE='1')
venv=Path('/home/slim/choieram/malssi-validation-20261009/.venv')
sys.path[:0]=[str(TASK/'code'),'/home/slim/choieram/evaluations/gpu31b_v3_admin_20261116T153000/overlay',str(venv/'lib/python3.12/site-packages')]
sys.prefix=sys.exec_prefix=str(venv);os.chdir(work)
started=time.monotonic()
import xgrammar as xgr
from xgrammar.contrib.hf import LogitsProcessor
import torch
from json_guard import audit_schema
info=xgr.TokenizerInfo([bytes([i]) for i in range(256)]+[b'<eos>'],stop_token_ids=[256],vocab_size=257)
compiler=xgr.GrammarCompiler(info,max_threads=2,cache_enabled=False)
simple={'type':'object','properties':{'ok':{'type':'boolean'}},'required':['ok'],'additionalProperties':False}
compiled=compiler.compile_json_schema(simple,strict_mode=True,any_order=False,any_whitespace=False,separators=(',',':'))
matcher=xgr.GrammarMatcher(compiled)
assert matcher.accept_string('{"ok":true}') and matcher.accept_token(256) and matcher.is_terminated()
for bad in ['{"ok":true}}','{"ok":true,"ok":false}','{"ok":"true"}','{}']:
 assert not xgr.GrammarMatcher(compiled).accept_string(bad),bad
processor=LogitsProcessor(compiled)
scores=processor(torch.tensor([[42]]),torch.zeros((1,257)))
assert not torch.isneginf(scores[0,ord('{')]) and torch.isneginf(scores[0,ord('x')])
fixtures=json.loads((TASK/'SCHEMA_FIXTURES.json').read_text())
for row in fixtures:
 audit_schema(row['schema'])
 compiler.compile_json_schema(row['schema'],strict_mode=True,any_order=False,any_whitespace=False,separators=(',',':'))
enum=compiler.compile_json_schema({'enum':[{'quote':'합성 정확한 원문','id':'q3_01'}]},strict_mode=True,any_order=False,any_whitespace=False,separators=(',',':'))
assert xgr.GrammarMatcher(enum).accept_string('{"quote":"합성 정확한 원문","id":"q3_01"}')
assert not xgr.GrammarMatcher(enum).accept_string('{"quote":"변조한 원문","id":"q3_01"}')
result={'status':'failed','cpu_only':True,'actual_schema_compilations':len(fixtures),'malformed_duplicate_wrong_type_missing_key_rejected':True,
 'unicode_object_enum_enforced':True,'actual_hf_logits_processor_mask_verified':True,'seconds':time.monotonic()-started}
from transformers import AutoTokenizer
token_fixture=json.loads((TASK/'TOKEN_FIXTURES.json').read_text())
context_tokens=token_fixture['context_tokens'];assert context_tokens==40960
model_path=Path(token_fixture['tokenizer']['path']);b['real_owned'](model_path)
for name,entry in token_fixture['tokenizer']['files'].items():
 assert Path(name).name==name
 path=model_path/name;b['real_owned'](path,directory=False)
 assert path.stat().st_size==entry['bytes'] and hashlib.sha256(path.read_bytes()).hexdigest()==entry['sha256']
tokenizer=AutoTokenizer.from_pretrained(str(model_path),local_files_only=True)
token_rows=[]
for row in token_fixture['cases']:
 assert type(row.get('required_for_launch')) is bool,'Every capacity case needs required_for_launch=true or false'
 audit_schema(row['grammar_schema']);compiler.compile_json_schema(row['grammar_schema'],strict_mode=True,any_order=False,any_whitespace=False,separators=(',',':'))
 counts=[]
 for messages in [row['original_messages'],row['revised_messages']]:
  ids=tokenizer.apply_chat_template(messages,tokenize=True,add_generation_prompt=True,enable_thinking=False,return_dict=False)
  assert isinstance(ids,list) and ids and all(type(value) is int for value in ids)
  counts.append(len(ids))
 if row['expected_original_tokens'] is not None:assert counts[0]==row['expected_original_tokens']
 cap=row['max_tokens'];assert cap==8192
 token_rows.append({'request':row['request'],'stage':row['stage'],'required_for_launch':row['required_for_launch'],
  'scenario':row.get('scenario','recorded'),'prompt_compacted':row.get('prompt_compacted',False),'original_input_tokens':counts[0],
  'revised_input_tokens':counts[1],'output_reserved_tokens':cap,'saved_input_tokens':counts[0]-counts[1],
  'original_total_tokens':counts[0]+cap,'revised_total_tokens':counts[1]+cap,
  'baseline_32768_margin_tokens':32768-counts[1]-cap,'revised_margin_tokens':context_tokens-counts[1]-cap,'input_truncated':False})
# Exact tokenizer counts of losslessly represented, previously accepted output.
# These measurements cannot establish fresh inference latency or quality.
output_rows=[]
for row in token_fixture.get('output_cases',[]):
 assert row['lossless_roundtrip'] is True
 original=len(tokenizer.encode(row['original_output'],add_special_tokens=False))
 revised=len(tokenizer.encode(row['revised_output'],add_special_tokens=False))
 output_rows.append({k:row[k] for k in ['request','request_id','stage','lossless_roundtrip','audit_order_normalized']}|
  {'original_output_tokens':original,'revised_output_tokens':revised,'saved_output_tokens':original-revised})
result['output_representation_measurements']=output_rows
# An actual GPU prefill near the new limit is required before application E2E.
probe_schema={'type':'object','properties':{'ok':{'const':True}},'required':['ok'],'additionalProperties':False}
compiler.compile_json_schema(probe_schema,strict_mode=True,any_order=False,any_whitespace=False,separators=(',',':'))
def probe_messages(repetitions):
 return [{'role':'system','content':'This is a synthetic context capacity check. Ignore padding and output only {"ok":true}.'},
  {'role':'user','content':json.dumps({'stage':'context_capacity_probe','data':{'synthetic':True,'padding':' probe'*repetitions},'output_schema':probe_schema},separators=(',',':'))}]
def probe_count(repetitions):
 return len(tokenizer.apply_chat_template(probe_messages(repetitions),tokenize=True,add_generation_prompt=True,enable_thinking=False,return_dict=False))
low,high=0,context_tokens*2
target=context_tokens-256
while low<high:
 mid=(low+high+1)//2
 if probe_count(mid)<=target:low=mid
 else:high=mid-1
actual=probe_count(low);assert target-4<=actual<=target and actual>32768
probe={'expected_input_tokens':actual,'context_tokens':context_tokens,'scope':'synthetic GPU near-limit prefill; independent of application E2E',
 'payload':{'model':'malssi-gemma4-31b-step5128','messages':probe_messages(low),'max_tokens':128,'temperature':0,'seed':3407,'stream':False,'n':1,'lora':[{'id':0,'scale':1}],
  'response_format':{'type':'json_schema','json_schema':{'name':'app_output','strict':True,'schema':probe_schema}}}}
from gpu31b_eval_worker import parse_payload,tokenize_full
parsed= parse_payload(probe['payload'])
assert len(tokenize_full(tokenizer,parsed['messages'],parsed['max_tokens']))==actual
result['long_probe_contract_validated']=True
probe_bytes=(json.dumps(probe,separators=(',',':'))+'\n').encode();(work/'LONG_CONTEXT_PROBE.json').write_bytes(probe_bytes)
result.update(context_tokens=context_tokens,long_probe_input_tokens=actual,long_probe_sha256=hashlib.sha256(probe_bytes).hexdigest(),token_fixture_sha256=hashlib.sha256((TASK/'TOKEN_FIXTURES.json').read_bytes()).hexdigest(),tokenizer_files_verified=True,recorded_token_counts_matched=True,token_measurements=token_rows,full_request_schema_compilations=len(token_rows),capacity_forecasts_are_not_live_results=True,
 **capacity_verdict(token_rows),seconds=time.monotonic()-started)
(work/'RESULT.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
assert result['selected_request_count']>0,'No request was selected for the launch capacity gate'
assert result['selected_requests_fit'],'A selected request still exceeds context; do not launch inference'
