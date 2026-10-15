import csv, datetime, json, subprocess
from pathlib import Path
kit=Path('/home/slim/choieram/model_Training/malssi_stage1_training_20261009')
w=kit/'work'
out={'observed_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kit':str(kit)}
for rel in ['canary/TRAINING_RESULT.json','canary_execution.json','canary-resume_execution.json','canary_gate.json','training/TRAINING_RESULT.json','validation_B0.json','validation_B1.json','COMPLETE.json']:
 p=w/rel
 if p.exists():
  d=json.loads(p.read_text())
  out[rel]={k:v for k,v in d.items() if k in ['status','optimizer_steps','completed_optimizer_steps','next_row_cursor','epoch_completed','checkpoint','evaluation','delta_target_mean_loss','peak_allocated_gib','peak_reserved_gib','hop_deployment_ready']}
for phase in ['canary','training']:
 p=w/phase/'train.jsonl'
 if p.exists():
  lines=p.read_text().splitlines()
  out[phase+'_log']={'lines':len(lines),'last':json.loads(lines[-1]) if lines else None}
segments=[]
for p in sorted((w/'collection').glob('*/events.jsonl')):
 events=[json.loads(l) for l in p.read_text().splitlines() if l]
 gpu=p.parent/'gpu_samples.csv'
 stats={'directory':str(p.parent),'events':events,'gpu_bytes':gpu.stat().st_size if gpu.exists() else None}
 if gpu.exists():
  lines=gpu.read_text().splitlines()
  stats['gpu_last']=lines[-1] if len(lines)>1 else None
 stderr=p.parent/'gpu_monitor.stderr'
 stats['gpu_monitor_stderr']=stderr.read_text() if stderr.exists() else None
 console=p.parent/'console.log'
 stats['console_bytes']=console.stat().st_size if console.exists() else None
 segments.append(stats)
out['segments']=segments
out['gpu']=subprocess.check_output(['nvidia-smi','--query-gpu=uuid,memory.used,utilization.gpu','--format=csv,noheader'],text=True).splitlines()
processes=subprocess.check_output(['ps','-eo','pid,ppid,etime,args'],text=True).splitlines()
out['processes']=[l for l in processes if ('scripts/malssi_stage1.py' in l or 'bash work/run_with_metrics.sh' in l) and 'ps -eo' not in l and 'python -' not in l]
print(json.dumps(out,ensure_ascii=False,indent=2))
