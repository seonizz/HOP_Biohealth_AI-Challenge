"""Read aggregate progress under the user's full-training-first priority."""
import datetime
import json
from pathlib import Path
ROOT=Path('/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009')
WORK=ROOT/'training_kit/work'
def read(path):
 try:return json.loads(path.read_text())
 except (OSError,ValueError):return {}
def tail_records(path):
 try:
  with path.open('rb') as f:
   f.seek(max(0,path.stat().st_size-65536));lines=f.read().splitlines()
 except OSError:return []
 out=[]
 for line in lines:
  try:
   value=json.loads(line)
   if isinstance(value,dict):out.append(value)
  except ValueError:pass
 return out
def select(item,keys):return {k:item[k] for k in keys if k in item}
result={'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'priority':'fixed32_early_comparison_then_complete_source_epoch_and_full_B0_B1','training_maximum_search':'deferred','inference_maximum_measurements':'after_full_training_full_B0_B1_strict_results'}
records=[item for item in tail_records(WORK/'training/train.jsonl') if item.get('mode')=='train']
latest=records[-1] if records else {}
result['main_training']={'started':(WORK/'training/RUN.json').is_file(),'completed_optimizer_steps':latest.get('step',0),'total_optimizer_steps':5052,'latest_loss':latest.get('target_mean_loss'),'last_step':select(latest,('next_row_cursor','microbatches','elapsed_seconds'))}
pipeline_path=ROOT/'work/collection/checkpoint100_pipeline_v1.json'
if not pipeline_path.is_file():pipeline_path=ROOT/'work/collection/early_training_pipeline_v1.json'
if not pipeline_path.is_file():pipeline_path=ROOT/'work/collection/full_training_pipeline_v1.json'
result['pipeline']=select(read(pipeline_path),('status','phase','error_type','error','active_child','updated_utc','intentional_handoff','prior_wrapper_exit','previous_wrapper_exit','pid','target_optimizer_step','checkpoint100_result_ready'))
result['pipeline']['source']=str(pipeline_path)
driver=read(WORK/'early/driver_status.json')
result['early_driver']=select(driver,('stage','phase','status','utc','pid'))
result['early_comparison']={'completed':(WORK/'early_result.json').is_file(),'validation_rows':32,'optimizer_step_boundary':16}
early=read(WORK/'early_result.json')
if early:result['early_comparison']['report']=early
result['checkpoint100_comparison']={'result_exists':(WORK/'checkpoint100_result.json').is_file(),'manifest_exists':(WORK/'checkpoint100_evaluation/RESULT_MANIFEST.json').is_file(),'checkpoint_committed':(WORK/'training/checkpoints/step-000000100/CHECKPOINT.json').is_file()}
result['checkpoint100_comparison']['report']=read(WORK/'checkpoint100_result.json')
result['step40_log_review']=read(ROOT/'work/collection/step40-log-review.json')
result['checkpoint40_replay']={'separate_from_main_training':True,'plan':read(ROOT/'work/collection/checkpoint40_replay_plan.json'),'driver':select(read(WORK/'checkpoint40_replay/driver_status.json'),('stage','phase','status','utc','pid')),'result_exists':(WORK/'checkpoint40_result.json').is_file(),'manifest_exists':(WORK/'checkpoint40_replay/RESULT_MANIFEST.json').is_file(),'checkpoint_committed':(WORK/'checkpoint40_replay/training/checkpoints/step-000000040/CHECKPOINT.json').is_file()}
branch_records=tail_records(WORK/'checkpoint40_replay/training/train.jsonl')
result['checkpoint40_replay']['last_branch_step']=select(branch_records[-1] if branch_records else {},('step','target_mean_loss','next_row_cursor'))
result['checkpoint40_replay']['report']=read(WORK/'checkpoint40_result.json')
if result['pipeline'].get('phase')=='actual_longest_source_canary' and not (WORK/'canary/RUN.json').is_file():
 result['pipeline']['phase']='canary_preparation'
tokens=read(WORK/'tokens/manifest.json')
result['tokenization']={'status':tokens.get('status','running_or_not_finalized'),'splits':{name:select(entry,('rows','input_tokens','supervised_tokens')) for name,entry in tokens.get('files',{}).items()},'rebind_provenance':tokens.get('rebind_provenance')}
if not tokens:
 records=tail_records(ROOT/'work/collection/prepare-long-tokens-28672.log');result['tokenization']['latest_progress']=records[-1] if records else None
q=WORK/'qualification.json'
if not q.is_file():
 candidates=sorted(path for path in ROOT.glob('qualification_25316_split28*') if path.is_dir())
 if candidates:q=candidates[-1]/'work/qualification.json'
qual=read(q)
result['qualification']={'source':str(q),'status':qual.get('status','loading_or_running'),'checks':[select(c,('name','passed')) for c in qual.get('checks',[])],'error':qual.get('error')}
records=tail_records(WORK/'canary/train.jsonl')
result['canary']={'passed':(WORK/'canary_gate.json').is_file(),'latest_step':select(records[-1] if records else {},('step','target_mean_loss','microbatches','next_row_cursor')),'separate_from_main_training':True}
for name in ('B0','B1'):
 item=read(WORK/('validation_'+name+'.json'))
 result[name]={'completed':bool(item),'evaluation':item.get('evaluation')}
pending=read(WORK/'validation_B1_pending_baseline.json')
result['full_B1_pending_fresh_baseline']={'evaluation_completed':bool(pending),'evaluation':pending.get('evaluation')}
logs=sorted((WORK/'collection').glob('*/console.log'))
if logs:
 events=[r for r in tail_records(logs[-1]) if r.get('event')=='evaluation_progress']
 if events:result['latest_evaluation_progress']=events[-1]
result['completion_marker_exists']=(WORK/'COMPLETE.json').is_file()
print(json.dumps(result,ensure_ascii=False,indent=2))
