"""Task-owned, detached, network-free queue controller; never starts training."""
import hashlib,json,os,signal,subprocess,sys,threading,time,traceback
from pathlib import Path
ROOT=Path('/home/slim/choieram/evaluations/gpu31b_stream_20261116')
PYTHON='/home/slim/choieram/malssi-validation-20261009/.venv/bin/python'
sys.path.insert(0,str(ROOT/'code'))
from boundary import real_owned,sandbox,DEVICES
from gpu31b_eval_bridge import WorkerSession

def atomic(path,value):
 temp=path.with_suffix('.tmp');temp.write_text(json.dumps(value,ensure_ascii=False,allow_nan=False)+'\n');os.replace(temp,path)
def gpu():
 return {'gpu':subprocess.check_output(['nvidia-smi','--query-gpu=index,memory.used,utilization.gpu,power.draw,temperature.gpu','--format=csv,noheader,nounits'],text=True),'compute':subprocess.check_output(['nvidia-smi','--query-compute-apps=pid,used_memory','--format=csv,noheader,nounits'],text=True)}
def main():
 assert sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode
 real_owned(ROOT);real_owned(ROOT/'code')
 for name,digest in json.loads((ROOT/'SOURCE_SHA256.json').read_text()).items():
  path=ROOT/'code'/name;real_owned(path,directory=False)
  assert path.stat().st_nlink==1 and hashlib.sha256(path.read_bytes()).hexdigest()==digest
 sandbox(ROOT,DEVICES)
 state={'status':'starting','stage':'preflight','supervisor_pid':os.getpid(),'started_at':time.time(),'completed_requests':0,'model':'malssi-gemma4-31b-step5128','checkpoint_step':5128,'job_limit_seconds':21600,'ssh_lifetime_dependency':False}
 def save(**kw):state.update(kw,updated_at=time.time());atomic(ROOT/'STATUS.json',state)
 child=session=None;sample_done=threading.Event();watch_done=threading.Event();samples=[];stderr=None
 deadline=time.monotonic()+21600
 try:
  before=gpu();assert not before['compute'].strip(),'Existing compute work; no model started'
  save(status='running',gpu_before=before)
  stderr=(ROOT/'worker.stderr.log').open('x')
  child=subprocess.Popen([PYTHON,'-I','-S','-B',str(ROOT/'code/gpu31b_eval_bootstrap.py'),'--work','work/worker'],cwd=ROOT,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=stderr,text=True,bufsize=1)
  save(stage='loading_model',worker_pid=child.pid)
  def sample():
   with (ROOT/'gpu-samples.jsonl').open('x') as handle:
    while not sample_done.is_set():
     try:
      row={'at':time.time(),**gpu()};samples.append(row);handle.write(json.dumps(row)+'\n');handle.flush()
     except Exception as error:handle.write(json.dumps({'at':time.time(),'error':type(error).__name__})+'\n');handle.flush()
     sample_done.wait(5)
  def watch():
   while not watch_done.wait(1):
    if time.monotonic()>=deadline or (ROOT/'CANCEL').exists():
     atomic(ROOT/'CANCELLATION.json',{'at':time.time(),'reason':'deadline' if time.monotonic()>=deadline else 'client_cancel','owned_pid':child.pid})
     if child.poll() is None:child.terminate()
     return
  sampler=threading.Thread(target=sample,daemon=True);sampler.start()
  watcher=threading.Thread(target=watch,daemon=True);watcher.start()
  session=WorkerSession(child,ROOT/'bridge',remote_root=str(ROOT),request_timeout=1000)
  ready=session.wait_ready(1200)
  assert ready['adapter_tensor_digest']==json.loads((ROOT/'plan.json').read_text())['checkpoint']['adapter_tensor_digest']
  save(stage='ready',worker_ready=ready,model_load_seconds=time.time()-state['started_at'])
  last_activity=time.monotonic()
  while not (ROOT/'STOP').exists():
   if time.monotonic()>=deadline:raise TimeoutError('Job deadline')
   if child.poll() is not None or session.failure:raise RuntimeError(session.failure or 'Worker exited')
   pending=[p for p in sorted((ROOT/'requests').glob('*.json')) if not (ROOT/'responses'/p.name).exists()]
   if not pending:
    if time.monotonic()-last_activity>1200:raise TimeoutError('No client request for 1200 seconds')
    time.sleep(.2);continue
   request=pending[0];real_owned(request,directory=False);assert request.stat().st_nlink==1 and request.stat().st_size<=8*1024*1024
   envelope=json.loads(request.read_text());assert set(envelope)=={'id','payload'} and envelope['id']==request.stem
   payload=envelope['payload'];assert payload['model']=='malssi-gemma4-31b-step5128' and payload['lora']==[{'id':0,'scale':1}]
   save(stage='generating',current_request_id=envelope['id'],inference_started_at=time.time())
   stream_handle=None
   try:
    if payload.get('stream') is True:
     stream_handle=(ROOT/'responses'/(envelope['id']+'.stream.jsonl')).open('x',encoding='utf-8')
    def on_chunk(chunk):
     value={**chunk,'id':envelope['id']}
     stream_handle.write(json.dumps(value,ensure_ascii=False,allow_nan=False)+'\n');stream_handle.flush()
    response=session.request(payload,on_chunk=on_chunk if stream_handle else None)
   finally:
    if stream_handle is not None:stream_handle.close()
   response['id']=envelope['id'];response['queue']={'submitted_at':request.stat().st_mtime,'inference_started_at':state['inference_started_at'],'completed_at':time.time()}
   atomic(ROOT/'responses'/request.name,response)
   last_activity=time.monotonic();save(stage='ready',completed_requests=state['completed_requests']+1,current_request_id=None)
  save(status='finishing',stage='closing_worker')
 except BaseException as error:
  save(status='failed',stage='failed',error={'type':type(error).__name__,'message':str(error)})
  traceback.print_exc()
 finally:
  close_verified=False
  if session is not None and child is not None and child.poll() is None:
   try:close_verified=session.close(timeout=180)
   except Exception as error:state['close_error']=type(error).__name__
  if child is not None:
   try:child.wait(timeout=30)
   except subprocess.TimeoutExpired:
    child.terminate()
    try:child.wait(timeout=15)
    except subprocess.TimeoutExpired:child.kill();child.wait(timeout=15)
  watch_done.set();sample_done.set()
  if 'sampler' in locals():sampler.join(timeout=10)
  if stderr is not None:stderr.close()
  after=gpu()
  before_values=[int(row.split(',')[1].strip()) for row in state.get('gpu_before',{}).get('gpu','').splitlines()]
  after_values=[int(row.split(',')[1].strip()) for row in after['gpu'].splitlines()]
  for _ in range(5):
   if after['compute'].strip() or before_values==after_values:break
   time.sleep(1);after=gpu();after_values=[int(row.split(',')[1].strip()) for row in after['gpu'].splitlines()]
  released=not after['compute'].strip() and before_values==after_values
  save(status='completed' if state['status']=='finishing' and close_verified else 'failed',stage='closed',completed_at=time.time(),worker_close_verified=close_verified,worker_exit_code=child.returncode if child else None,owned_worker_absent=child is None or child.poll() is not None,gpu_after=after,gpu_memory_returned_to_baseline=released)
if __name__=='__main__':main()
