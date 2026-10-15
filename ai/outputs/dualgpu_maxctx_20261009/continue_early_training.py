#!/usr/bin/env python3
"""Preserve the active canary, then switch at its committed process boundary."""
from pathlib import Path
import datetime
import fcntl
import json
import os
import signal
import subprocess
import time
import traceback

ROOT=Path('/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009')
KIT=ROOT/'training_kit'
WORK=KIT/'work'
PYTHON='/home/slim/choieram/malssi-validation-20261009/.venv/bin/python'
REPORT=ROOT/'work/collection/early_training_pipeline_v1.json'
STATE={}


def require(value,message):
    if not value:raise RuntimeError(message)


def read(path):return json.loads(path.read_text())


def process(pid):
    try:
        p=Path('/proc')/str(pid)
        argv=p.joinpath('cmdline').read_bytes().split(b'\0')
        state=next(s for s in p.joinpath('status').read_text().splitlines() if s.startswith('State:')).split()[1]
        return argv,state
    except FileNotFoundError:return [],None


def save(**values):
    STATE.update(values,updated_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
    tmp=REPORT.with_suffix('.tmp');tmp.write_text(json.dumps(STATE,indent=2,ensure_ascii=False)+'\n');tmp.replace(REPORT)
    print(json.dumps({k:STATE.get(k) for k in ('status','phase','updated_utc')},ensure_ascii=False),flush=True)


def latest(path):
    if not path.is_file():return {}
    with path.open('rb') as f:
        f.seek(max(0,path.stat().st_size-8192));lines=f.read().splitlines()
    for line in reversed(lines):
        try:return json.loads(line)
        except ValueError:pass
    return {}


def progress():
    row=latest(WORK/'training/train.jsonl')
    stage=read(WORK/'early/driver_status.json') if (WORK/'early/driver_status.json').is_file() else {}
    return {'driver_status':stage,'main_training_started':(WORK/'training/RUN.json').is_file(),
            'completed_optimizer_steps':row.get('step',0),'total_optimizer_steps':5052,
            'latest_main_training_loss':row.get('target_mean_loss'),
            'early_result_ready':(WORK/'early_result.json').is_file(),
            'canary_gate_passed':(WORK/'canary_gate.json').is_file()}


def main():
    require(ROOT==ROOT.resolve() and KIT==KIT.resolve(),'Unsafe root')
    lock=(ROOT/'work/collection/.early_training_pipeline.lock').open('a+')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    STATE.update(status='running',phase='waiting_for_current_canary2',pid=os.getpid(),
        started_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        supersedes='full_training_pipeline_v1.json',priority='fixed32 miniB0 -> first16 full-plan steps -> same32 miniB1 -> full training/B1 -> fresh-base fullB0 -> final collection',
        original_canary_pid=1044898,held_old_controller_pid=1044847,main_training_started=False,
        completed_optimizer_steps=0,total_optimizer_steps=5052,latest_main_training_loss=None)
    with REPORT.open('x') as f:json.dump(STATE,f,indent=2)
    try:
        save()
        while True:
            argv,state=process(1044898)
            if b'scripts/malssi_stage1.py' not in argv or b'canary' not in argv or state=='Z':break
            time.sleep(5)
        result=read(WORK/'canary/TRAINING_RESULT.json')
        execution=read(WORK/'canary_execution.json')
        checkpoint=read(WORK/'canary/checkpoints/step-000000002/CHECKPOINT.json')
        require(result['completed_optimizer_steps']==2 and result['next_row_cursor']==16
                and result['status']=='step_cap_reached' and execution['result']==result,
                'Current canary did not finish both updates successfully')
        require(checkpoint['step']==2 and checkpoint['cursor']==16,'Committed step2 checkpoint missing')
        require(not (WORK/'training/RUN.json').exists() and not (WORK/'validation_B0.json').exists(),'Old main path unexpectedly started')
        argv,state=process(1044847)
        require(argv[:3]==[b'bash',str(KIT/'run.sh').encode(),b'start'] and state=='T','Held controller identity/state changed')
        save(phase='switching_at_committed_canary2_boundary',canary2_completed=True)
        # Only the held shell is signalled. Its GPU child already exited cleanly.
        os.kill(1044847,signal.SIGTERM);os.kill(1044847,signal.SIGCONT)
        for _ in range(60):
            owners=[pid for pid in (1044847,1044842,1044628) if process(pid)[0] and process(pid)[1]!='Z']
            if not owners:break
            time.sleep(.5)
        require(not owners,'Previous controllers have not exited; no replacement GPU process launched')
        old_events=[json.loads(s) for s in (WORK/'collection/20261009T095750Z-start-1044842/events.jsonl').read_text().splitlines()]
        require(old_events[-1]['event']=='end' and old_events[-1]['exit_code']==143,'Unexpected old wrapper termination evidence')
        save(phase='canary_resume_then_early_comparison_and_full_training',prior_wrapper_exit=143,
             intentional_handoff=True,old_canary_preserved=True)
        log=ROOT/'work/collection/early-training-start-v1.log'
        with log.open('xb') as out:
            child=subprocess.Popen(['bash',str(ROOT/'scripts/run_with_metrics_early_v1.sh')],stdin=subprocess.DEVNULL,stdout=out,stderr=subprocess.STDOUT,cwd=KIT)
            save(active_child={'pid':child.pid,'log':str(log)})
            while child.poll() is None:
                values=progress()
                if any(STATE.get(k)!=v for k,v in values.items()):save(**values)
                time.sleep(5)
            code=child.returncode
        STATE.pop('active_child',None)
        save(last_process_exit=code,**progress())
        require(code==0,'Early/full training wrapper failed; preserve logs and committed checkpoints')
        save(phase='strict_final_collection')
        with (ROOT/'work/collection/early-training-final-results-v1.log').open('xb') as out:
            rc=subprocess.run([PYTHON,'-B',str(ROOT/'scripts/collect_results.py'),'--kit',str(KIT)],stdin=subprocess.DEVNULL,stdout=out,stderr=subprocess.STDOUT,cwd=KIT).returncode
        require(rc==0,'Strict final collection failed')
        save(status='passed',phase='training_and_all_evaluations_collected')
    except BaseException as error:
        (ROOT/'work/collection/early_training_pipeline_v1.error.log').write_text(traceback.format_exc())
        save(status='failed',error_type=type(error).__name__,error=str(error))
        return 1
    finally:lock.close()
    return 0


if __name__=='__main__':raise SystemExit(main())
