import json,os,sys,time,signal,subprocess,threading,uuid,gc,traceback,socket,select
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
from json_guard import JsonSchemaGuard,JsonGuardError,response_schema,strict_json_loads
SOURCE=Path('/home/chihun/Documents/HOP/evaluations/12b_state_contract_20261116')
MODEL='latest12b-state-contract-25'
SHA='f941476864d16067667a255055a4818d59f3ac94624091eb6e2d466d62b99e0b'
def read(p):return json.loads(p.read_text())
def save(p,v):
 t=p.with_suffix('.tmp');t.write_text(json.dumps(v,ensure_ascii=False));t.replace(p)
def client_disconnected(connection):
 try:
  readable,_,_=select.select([connection],[],[],0)
  return bool(readable) and connection.recv(1,socket.MSG_PEEK|socket.MSG_DONTWAIT)==b''
 except (ConnectionResetError,BrokenPipeError):return True
 except BlockingIOError:return False

def validate_body(body):
 if not isinstance(body,dict) or body.get('model')!=MODEL:raise ValueError('Wrong model identity')
 if body.get('stream',False):raise ValueError('Only nonstreaming requests supported')
 if body.get('temperature',0)!=0:raise ValueError('This diagnostic decoder requires explicit temperature=0')
 response_schema(body.get('response_format'))
 cap=body.get('max_tokens',8192)
 if type(cap)is not int or not 0<cap<=8192:raise ValueError('max_tokens must be1..8192')
 messages=body.get('messages')
 if not isinstance(messages,list) or not messages or not all(isinstance(m,dict) and m.get('role')in['system','user','assistant'] and isinstance(m.get('content'),str) for m in messages):raise ValueError('Invalid messages')
 return messages,cap
def output_budget(body,prompt_tokens):
 requested=body.get('max_tokens',8192)
 if prompt_tokens+requested>32768:raise ContextBudgetError(prompt_tokens,requested)
 return requested
class ContextBudgetError(ValueError):
 code='context_length_exceeded'
 def __init__(self,prompt_tokens,max_tokens):
  super().__init__(f'Prompt ({prompt_tokens}) plus max_tokens ({max_tokens}) exceeds the 32768-token context budget; no text was truncated')
def reserve_output_budget(body,prompt_tokens,metrics_path):
 # Persist exact capacity evidence even when rejection happens before inference.
 metrics=dict(prompt_tokens=prompt_tokens,requested_max_tokens=body.get('max_tokens'),max_tokens=body.get('max_tokens',8192),context_limit=32768,prefill_chunk=512)
 metrics['budget_accepted']=prompt_tokens+metrics['max_tokens']<=metrics['context_limit']
 save(metrics_path,metrics)
 return output_budget(body,prompt_tokens)
def error_response(error):
 if isinstance(error,ContextBudgetError):
  return 400,{'error':{'message':str(error),'type':'invalid_request_error','code':error.code}}
 status=504 if isinstance(error,TimeoutError) else 400 if isinstance(error,(ValueError,AssertionError)) else 500
 return status,{'error':{'message':str(error),'type':type(error).__name__}}
def constrained_scores(scores,prefix,generated,torch,suppress,grammar=None):
 # Raw model NaNs/infinities are failures. Grammar masking deliberately adds -inf.
 if not bool(torch.isfinite(scores).all()):raise RuntimeError('Nonfinite raw model logits')
 scores=scores.clone();scores[:,suppress]=-float('inf')
 if grammar is not None:
  if tuple(scores.shape)!=(1,grammar.guard.vocab_size):raise JsonGuardError('grammar_runtime_mismatch','Logit vocabulary differs from grammar')
  scores=grammar.processor(torch.tensor([prefix+generated],dtype=torch.long,device=scores.device),scores)
 if not bool(torch.isfinite(scores).any()):raise JsonGuardError('constrained_output_invalid','No finite grammar-valid token logit')
 return scores
def chunked_stepper(model,prefix,torch,kernel_options,suppress,cache_factory,expired=lambda:False,chunk=512,grammar=None):
 cache=cache_factory();first=True
 def step(generated):
  nonlocal cache,first
  slices=[(offset,min(len(prefix),offset+chunk)) for offset in range(0,len(prefix),chunk)] if first else [(0,1)]
  for begin,end in slices:
   if expired():raise TimeoutError('Prefill deadline/cancel')
   tokens=prefix[begin:end] if first else [generated[-1]]
   length=end if first else len(prefix)+len(generated)
   output=model(input_ids=torch.tensor([tokens],dtype=torch.long,device='cuda'),attention_mask=torch.ones((1,length),dtype=torch.long,device='cuda'),past_key_values=cache,use_cache=True,logits_to_keep=1,kernel_options=kernel_options)
   cache=output.past_key_values
   if cache is None:raise RuntimeError('Cached forward did not return cache')
  first=False;scores=output.logits[:,-1].float()
  scores=constrained_scores(scores,prefix,generated,torch,suppress,grammar)
  token=int(scores.argmax(-1).item())
  del output,scores
  return token
 return step
def worker():
 sys.path.insert(0,str(SOURCE/'code'))
 import boundary,support
 boundary.real_owned(ROOT);boundary.real_owned(SOURCE)
 plan=read(SOURCE/'plan.json')
 (ROOT/'cache').mkdir()
 support.configure_environment(ROOT/'cache',plan['gpu_uuid'])
 os.environ['TVM_FFI_CACHE_DIR']=str(ROOT/'cache/tvm-ffi')
 save(ROOT/'BOUNDARY.json',boundary.sandbox(ROOT,boundary.DEVICES))
 packages=support.VENV/'lib/python3.12/site-packages';boundary.real_owned(packages)
 sys.path.insert(0,str(packages));sys.prefix=sys.exec_prefix=str(support.VENV)
 overlay=ROOT/'overlay';boundary.real_owned(overlay);sys.path.insert(0,str(overlay))
 import gpu_worker as gpu
 import torch
 from transformers import DynamicCache
 adapter=SOURCE/'work/train/adapter'
 assert gpu.digest(adapter/'adapter_model.safetensors')==SHA
 start=time.monotonic();model,tok,core,course,proof=gpu.initialize(SOURCE,plan,adapter)
 model.gradient_checkpointing_disable();model.eval();model.config.get_text_config().use_cache=True
 core.set_compute_layout(model,128,'cpu',False)
 # The tied frozen head stays in system RAM. Only the final token's hidden state crosses to CPU.
 head=model.get_output_embeddings()
 head.register_forward_pre_hook(lambda module,args:(args[0].to(module.weight.device),*args[1:]))
 torch.cuda.synchronize();gc.collect();torch.cuda.empty_cache()
 eos,suppress=gpu.decode_contract(model.generation_config)
 guard=JsonSchemaGuard(model,tok)
 assert set(eos)==set(guard.stop_ids),'Decoder EOS differs from grammar'
 # Verify cached chunking against the qualified full-prefill decoder before readiness.
 probe_ids=tok.encode('안녕하세요. 오늘 대화를 시작합니다.',add_special_tokens=False)
 with torch.no_grad(),torch.autocast('cuda',dtype=torch.bfloat16):
  full=gpu.forward_stepper(model,probe_ids,torch,core.FLEX_OPTIONS,suppress,lambda:DynamicCache(config=model.config.get_text_config()))
  chunked=chunked_stepper(model,probe_ids,torch,core.FLEX_OPTIONS,suppress,lambda:DynamicCache(config=model.config.get_text_config()),chunk=4)
  a=[];b=[]
  for _ in range(3):a.append(full(a));b.append(chunked(b))
  assert a==b, 'Chunked prefill token parity failed'
  del full,chunked
 save(ROOT/'PREFILL_PARITY.json',dict(passed=True,prompt_tokens=len(probe_ids),checked_generated_tokens=3,full_tokens=a,chunked_tokens=b))
 gc.collect();torch.cuda.empty_cache()
 save(ROOT/'MODEL.json',dict(model=MODEL,adapter_sha256=SHA,model_load_seconds=time.monotonic()-start,proof=proof,approved=False,pid=os.getpid(),grammar={'engine':'xgrammar','version':'0.2.9','schema_required':True,'unconstrained_fallback':False},compute_layout={'embedding_and_head':'cpu','mlp_chunk':128,'prefill_chunk':512},gpu_allocated_bytes=torch.cuda.memory_allocated()))
 last=time.monotonic()
 while time.monotonic()-start<10800 and time.monotonic()-last<1800 and not (ROOT/'STOP').exists():
  for p in sorted((ROOT/'queue').glob('*/request.json'),key=lambda p:p.stat().st_mtime_ns):
   result=p.parent/'response.json'
   if result.exists():continue
   request=read(p);begin=time.monotonic();queue_seconds=max(0,begin-request.get('enqueued_monotonic',begin));last=begin;generated=[];first=None;step=None;timed=None;grammar=None
   try:
    if (p.parent/'CANCEL').exists() or (ROOT/'STOP').exists():raise TimeoutError('Cancelled before inference')
    body=request['body'];messages,cap=validate_body(body)
    grammar=guard.prepare(response_schema(body['response_format']))
    gpu.require_exclusive(plan)
    prompt=tok.apply_chat_template(messages,tokenize=False,add_generation_prompt=True,enable_thinking=False)
    ids=tok.encode(prompt,add_special_tokens=False)
    cap=reserve_output_budget(body,len(ids),p.parent/'input_metrics.json')
    torch.manual_seed(plan['seed']);torch.cuda.manual_seed_all(plan['seed']);torch.cuda.synchronize()
    with torch.no_grad(),torch.autocast('cuda',dtype=torch.bfloat16):
     step=chunked_stepper(model,ids,torch,core.FLEX_OPTIONS,suppress,lambda:DynamicCache(config=model.config.get_text_config()),expired=lambda:time.monotonic()-begin>=900 or (p.parent/'CANCEL').exists() or (ROOT/'STOP').exists(),grammar=grammar)
     def timed(tokens):
      nonlocal first
      value=step(tokens)
      if first is None:first=time.monotonic()
      return value
     reason=gpu.greedy_loop(timed,cap,eos,lambda:time.monotonic()-begin>=900 or (p.parent/'CANCEL').exists() or (ROOT/'STOP').exists(),generated)
     del step
    torch.cuda.synchronize()
    if reason=='timeout':raise TimeoutError('Deadline/cancel')
    content=tok.decode(generated,skip_special_tokens=True)
    grammar.verify(generated,content,cap)
    metrics=dict(request_id=request['id'],queue_seconds=queue_seconds,worker_started_at=time.time()-(time.monotonic()-begin),seconds=time.monotonic()-begin,ttft_seconds=first-begin if first else None,prompt_tokens=len(ids),completion_tokens=len(generated),max_tokens=cap,requested_max_tokens=body.get('max_tokens'),finish_reason=reason,adapter_sha256=SHA,grammar=dict(grammar.evidence))
    response=dict(model=MODEL,choices=[dict(index=0,message=dict(role='assistant',content=content),finish_reason=reason)],usage=dict(prompt_tokens=len(ids),completion_tokens=len(generated),total_tokens=len(ids)+len(generated)));status=200
    save(p.parent/'metrics.json',metrics)
   except Exception as e:
    (p.parent/'error.log').write_text(traceback.format_exc())
    metrics=dict(request_id=request['id'],queue_seconds=queue_seconds,seconds=time.monotonic()-begin,failed=True,error_type=type(e).__name__,error_code=getattr(e,'code',None),adapter_sha256=SHA,grammar=dict(grammar.evidence) if grammar else None,output_token_ids=generated)
    save(p.parent/'metrics.json',metrics)
    status,response=error_response(e)
   finally:
    step=None;timed=None;grammar=None;gc.collect();torch.cuda.empty_cache()
   response['hop_metrics']=metrics
   save(result,dict(status=status,response=response));last=time.monotonic()
  time.sleep(.05)
 save(ROOT/'WORKER_DONE.json',{'status':'stopped','at':time.time()})
def supervise():
 sys.path.insert(0,str(SOURCE/'code'));import support,boundary
 boundary.real_owned(ROOT);boundary.real_owned(SOURCE)
 plan=read(SOURCE/'plan.json');baseline=support.gpu_snapshot(plan['gpu_uuid'])
 assert not baseline['compute_pids'] and baseline['memory_free_mib']>=14000
 (ROOT/'queue').mkdir(exist_ok=False)
 env=os.environ.copy();env.update(LD_PRELOAD=str(ROOT/'ubuntu_cuda_name_compat.so'),HOP_CUDA_THREAD_NAME_SINK=str(ROOT/'cuda-threadnames.log'),PYTHONDONTWRITEBYTECODE='1')
 log=(ROOT/'worker.log').open('x')
 child=subprocess.Popen([str(support.VENV/'bin/python'),'-I','-S','-B','-u',str(ROOT/'service.py'),'worker'],cwd=ROOT,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)
 started=time.monotonic();shutdown=threading.Event()
 save(ROOT/'LAUNCH.json',dict(supervisor_pid=os.getpid(),worker_pid=child.pid,started_at=time.time(),baseline=baseline))
 class Handler(BaseHTTPRequestHandler):
  def log_message(self,*args):pass
  def reply(self,status,value):
   data=json.dumps(value,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers()
   try:self.wfile.write(data)
   except (BrokenPipeError,ConnectionResetError):pass
  def do_GET(self):
   ready=(ROOT/'MODEL.json').exists() and child.poll() is None
   if self.path=='/health':self.reply(200 if ready else 503,dict(ready=ready,model=MODEL,adapter_sha256=SHA,worker_pid=child.pid,gpu_inference_concurrency=1,queue_policy='fifo',streaming=False,grammar={'engine':'xgrammar','version':'0.2.9','schema_required':True,'unconstrained_fallback':False}));return
   if self.path=='/v1/models':self.reply(200,{'data':[{'id':MODEL}]});return
   self.reply(404,{})
  def do_POST(self):
   if self.path!='/v1/chat/completions':self.reply(404,{});return
   if not(ROOT/'MODEL.json').exists() or child.poll() is not None:self.reply(503,{'error':{'message':'Model not ready'}});return
   try:
    size=int(self.headers.get('Content-Length','0'));assert 0<size<=2097152
    body=strict_json_loads(self.rfile.read(size));validate_body(body)
   except Exception as error:self.reply(400,{'error':{'message':str(error) or 'Invalid request'}});return
   rid=str(uuid.uuid4());directory=ROOT/'queue'/rid;directory.mkdir();save(directory/'request.json',{'id':rid,'body':body,'enqueued_monotonic':time.monotonic(),'enqueued_at':time.time()})
   deadline=time.monotonic()+950
   while time.monotonic()<deadline and child.poll() is None and not shutdown.is_set():
    if client_disconnected(self.connection):
     (directory/'CANCEL').touch();return
    result=directory/'response.json'
    if result.exists():
     value=read(result);self.reply(value['status'],value['response']);return
    time.sleep(.1)
   (directory/'CANCEL').touch();self.reply(504,{'error':{'message':'Request deadline'}})
 server=None
 def stop(*_):shutdown.set()
 signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
 try:
  server=ThreadingHTTPServer(('127.0.0.1',8765),Handler);server.timeout=1;server.daemon_threads=True
  while not shutdown.is_set() and child.poll() is None and time.monotonic()-started<10800:server.handle_request()
 finally:
  shutdown.set();(ROOT/'STOP').touch()
  if server:server.server_close()
  try:child.wait(timeout=30)
  except subprocess.TimeoutExpired:
   child.terminate()
   try:child.wait(timeout=20)
   except subprocess.TimeoutExpired:child.kill();child.wait(timeout=20)
  log.close();after=support.gpu_snapshot(plan['gpu_uuid'])
  save(ROOT/'DONE.json',dict(returncode=child.returncode,gpu_after=after,owned_gpu_process_absent=child.pid not in after['compute_pids'],memory_returned=after['memory_used_mib']<=baseline['memory_used_mib']+64))
if __name__=='__main__':worker() if sys.argv[-1]=='worker' else supervise()
