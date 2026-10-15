#!/usr/bin/env python3
"""Check configured context boundaries via the actual authenticated API."""
from pathlib import Path
import datetime,json,os,time,urllib.request,urllib.error
API=Path(__file__).resolve().parent
RUNTIME=API/'runtime'
os.environ.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',
                  HF_HOME=str(RUNTIME/'cache/huggingface'),TOKENIZERS_PARALLELISM='false')
from transformers import AutoTokenizer
config=json.loads((API/'config.json').read_text())
train=json.loads((Path(config['kit_path'])/'config/train.json').read_text())
tokenizer=AutoTokenizer.from_pretrained(train['model_path'],local_files_only=True)
key=(RUNTIME/'api_key').read_text().strip()
state={'status':'running','checkpoint_step':100,'configured_context_tokens':config['max_context_tokens'],
       'configured_output_tokens':config['max_output_tokens'],'source_training_context':25316,
       'source_longest_supervised_response':3922,'generated_output_maximum_measured':False,'checks':[]}
report=API/'token_limits_verification.json'
def save():
 state['updated_utc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
 tmp=report.with_suffix('.tmp');tmp.write_text(json.dumps(state,ensure_ascii=False,indent=2)+'\n');tmp.replace(report)
def prompt_for(target):
 def build(n):
  return [{'role':'user','content':"반복 입력을 읽고 '확인'이라고만 답하세요.\n"+' a'*n}]
 def count(m):
  text=tokenizer.apply_chat_template(m,tokenize=False,add_generation_prompt=True,enable_thinking=False)
  return len(tokenizer(text,add_special_tokens=False,truncation=False)['input_ids'])
 lo,hi=0,target
 while lo<=hi:
  mid=(lo+hi)//2;msg=build(mid);n=count(msg)
  if n==target:return msg,n
  if n<target:lo=mid+1
  else:hi=mid-1
 raise RuntimeError('Unable to construct exact synthetic boundary prompt')
def request(payload):
 req=urllib.request.Request('http://127.0.0.1:18080/v1/chat/completions',data=json.dumps(payload,ensure_ascii=False).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+key})
 with urllib.request.urlopen(req,timeout=1800) as res:return res.status,json.load(res)
save()
try:
 for name,input_tokens,budget,expected in [
   ('maximum_input_plus_one',config['max_context_tokens']-1,1,200),
   ('maximum_output_reservation',64,min(config['max_output_tokens'],config['max_context_tokens']-64),200),
   ('one_token_over_context',config['max_context_tokens'],1,400),
   ('short_after_long_requests',64,16,200)]:
  state['phase']=name;save()
  messages,observed=prompt_for(input_tokens)
  started=time.monotonic()
  try:
   code,value=request({'messages':messages,'max_tokens':budget,'temperature':0,'stream':False})
  except urllib.error.HTTPError as exc:
   code=exc.code;value=json.loads(exc.read())
  item={'case':name,'input_tokens':observed,'requested_output_tokens':budget,'status_code':code,'elapsed_seconds':time.monotonic()-started}
  if code==200:
   item.update(usage=value['usage'],finish_reason=value['choices'][0]['finish_reason'])
   assert value['usage']['prompt_tokens']==observed
   assert value['usage']['total_tokens']<=config['max_context_tokens']
  else:item['error']=value.get('error')
  state['checks'].append(item);save()
  assert code==expected,(name,code,value.get('error'))
 state['status']='passed';state['phase']='completed'
except BaseException as exc:
 state['status']='failed';state['error_type']=type(exc).__name__;state['error']=str(exc)
 raise
finally:save()
print(json.dumps(state,ensure_ascii=False))
