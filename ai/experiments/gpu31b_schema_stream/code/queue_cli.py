"""Fixed task queue interface. No arbitrary path, command or model selection."""
import hashlib,json,os,re,sys,time,uuid
from pathlib import Path
ROOT=Path('/home/slim/choieram/evaluations/gpu31b_stream_20261116')
sys.path.insert(0,str(ROOT/'code'))
from boundary import real_owned,sandbox
from gpu31b_stream_protocol import follow_response
assert sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
real_owned(ROOT)
sandbox(ROOT,[])
request=json.loads(sys.stdin.read(8*1024*1024+1));action=request.get('action')
if action=='status':
 print((ROOT/'STATUS.json').read_text())
elif action in ('stop','cancel'):
 name='STOP' if action=='stop' else 'CANCEL'
 with (ROOT/name).open('a'):pass
 if action=='stop':
  deadline=time.monotonic()+240
  while time.monotonic()<deadline:
   state=json.loads((ROOT/'STATUS.json').read_text())
   if state.get('stage')=='closed':print(json.dumps(state));break
   time.sleep(1)
  else:print(json.dumps({'status':'cleanup_pending','stage':'closing_worker'}))
 else:print(json.dumps({'status':'cancel_requested'}))
elif action=='request':
 identifier=request['id'];assert re.fullmatch('[a-f0-9-]{36}',identifier)
 assert str(uuid.UUID(identifier))==identifier
 assert set(request)=={'action','id','payload'}
 payload=request['payload'];assert payload['model']=='malssi-gemma4-31b-step5128' and payload['lora']==[{'id':0,'scale':1}]
 state=json.loads((ROOT/'STATUS.json').read_text());assert state.get('status')=='running'
 path=ROOT/'requests'/(identifier+'.json');data=json.dumps({'id':identifier,'payload':payload},ensure_ascii=False,allow_nan=False)+'\n'
 if path.exists():assert path.read_text()==data
 else:
  temp=path.with_suffix('.tmp')
  with temp.open('x') as handle:handle.write(data);handle.flush();os.fsync(handle.fileno())
  os.replace(temp,path)
 if payload.get('stream') is True:
  def validate_file(file):
   real_owned(file,directory=False);assert file.stat().st_nlink==1 and file.stat().st_size<=32*1024*1024
  def cancel():
   with (ROOT/'CANCEL').open('a'):pass
  def emit(value):print(json.dumps(value,ensure_ascii=False,allow_nan=False),flush=True)
  try:
   follow_response(ROOT/'responses'/path.name,ROOT/'responses'/(identifier+'.stream.jsonl'),identifier,
    lambda:json.loads((ROOT/'STATUS.json').read_text()),emit,cancel,validate_file)
  except (ValueError,RuntimeError,TimeoutError,UnicodeError,OSError) as error:
   cancel()
   emit({'event':'result','envelope':{'id':identifier,'error':{'code':'queue_timeout' if isinstance(error,TimeoutError) else 'stream_protocol_error','message':'Streaming worker response was not verified','fatal':True},'fatal':True}})
 else:
  deadline=time.monotonic()+990
  while time.monotonic()<deadline:
   response=ROOT/'responses'/path.name
   if response.exists():print(response.read_text());break
   state=json.loads((ROOT/'STATUS.json').read_text())
   if state['status']=='failed' or state.get('stage')=='closed':
    print(json.dumps({'id':identifier,'error':{'code':'worker_failed','message':'Worker unavailable','fatal':True},'fatal':True}));break
   time.sleep(.25)
  else:
   with (ROOT/'CANCEL').open('a'):pass
   print(json.dumps({'id':identifier,'error':{'code':'queue_timeout','message':'Remote response deadline','fatal':True},'fatal':True}))
else:raise ValueError('Unknown queue action')
