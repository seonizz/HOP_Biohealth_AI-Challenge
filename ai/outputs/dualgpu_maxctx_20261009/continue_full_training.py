#!/usr/bin/env python3
"""Finish pinned preparation, then essential canary -> B0 -> epoch -> B1 -> collection."""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import traceback

ROOT=Path('/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009')
KIT=ROOT/'training_kit'
SNAPSHOT=ROOT/'qualification_25316_split28_v2'
PYTHON='/home/slim/choieram/malssi-validation-20261009/.venv/bin/python'
TOKEN_PID=1043658
QUAL_PID=1044574
REPORT=ROOT/'work/collection/full_training_pipeline_v1.json'
STATE={}


def require(value,message):
    if not value: raise RuntimeError(message)


def read(path):
    return json.loads(path.read_text())


def sha(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(8*1024*1024),b''): h.update(block)
    return h.hexdigest()


def running(pid, expected):
    try:
        raw=Path('/proc')/str(pid)/'cmdline'
        command=raw.read_bytes().replace(b'\0',b' ').decode()
    except FileNotFoundError:
        return False
    return expected in command


def save(**values):
    STATE.update(values,updated_utc=datetime.datetime.now(datetime.timezone.utc).isoformat())
    tmp=REPORT.with_suffix('.tmp')
    tmp.write_text(json.dumps(STATE,indent=2,ensure_ascii=False,allow_nan=False)+'\n')
    tmp.replace(REPORT)
    print(json.dumps({k:STATE[k] for k in ('status','phase','updated_utc')},ensure_ascii=False),flush=True)


def progress():
    work=KIT/'work'
    started=(work/'training/RUN.json').is_file()
    completed=0; loss=None
    log=work/'training/train.jsonl'
    if log.is_file():
        with log.open('rb') as handle:
            handle.seek(max(0,log.stat().st_size-8192))
            for line in reversed(handle.read().splitlines()):
                try:
                    record=json.loads(line);completed=record['step'];loss=record['target_mean_loss'];break
                except (ValueError,KeyError): pass
    if (work/'validation_B1.json').is_file(): phase='training_and_B1_completed'
    elif (work/'training/TRAINING_RESULT.json').is_file() and read(work/'training/TRAINING_RESULT.json').get('epoch_completed'): phase='B1_evaluation'
    elif started: phase='full_source_main_training'
    elif (work/'canary_gate.json').is_file(): phase='B0_evaluation'
    elif (work/'canary/checkpoints/step-000000002').is_dir(): phase='canary_fresh_process_resume'
    else: phase='actual_longest_source_canary'
    return {'phase':phase,'main_training_started':started,'completed_optimizer_steps':completed,
            'total_optimizer_steps':5052,'latest_main_training_loss':loss}


def run(command,log,cwd=ROOT,monitor_training=False):
    with log.open('xb') as handle:
        process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=handle,stderr=subprocess.STDOUT,cwd=cwd)
        save(active_child={'pid':process.pid,'command':command,'log':str(log)})
        while process.poll() is None:
            if monitor_training:
                values=progress()
                if any(STATE.get(k)!=v for k,v in values.items()): save(**values)
            time.sleep(10)
        rc=process.returncode
    STATE.pop('active_child',None)
    save(last_process_exit=rc)
    require(rc==0,'Child process failed: '+str(command)+'; log='+str(log))


def main():
    require(QUAL_PID > 0, 'Final qualification PID was not configured')
    require(ROOT==ROOT.resolve() and KIT==KIT.resolve() and SNAPSHOT==SNAPSHOT.resolve(),'Unsafe workspace path')
    lock=(ROOT/'work/collection/.full_training_pipeline.lock').open('a+')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    STATE.update(status='running',phase='waiting_for_tokenization_and_qualification',pid=os.getpid(),
        main_training_started=False,started_utc=datetime.datetime.now(datetime.timezone.utc).isoformat(),
        training_policy={'train_rows':40415,'validation_rows':4298,'max_source_length':25316,
                         'accumulation_steps':8,'epochs':1,'optimizer_steps':5052,
                         'synthetic_data_in_training':False,'truncation':False},
        inference='deferred until full training, B1, and strict result collection')
    with REPORT.open('x') as f: json.dump(STATE,f,indent=2)
    try:
        save()
        while running(TOKEN_PID,str(KIT/'scripts/malssi_stage1.py')) or running(QUAL_PID,str(SNAPSHOT/'scripts/malssi_stage1.py')):
            if not running(TOKEN_PID,str(KIT/'scripts/malssi_stage1.py')):
                require((KIT/'work/tokens/manifest.json').is_file(),'Tokenization exited without finalized cache')
            if not running(QUAL_PID,str(SNAPSHOT/'scripts/malssi_stage1.py')):
                require(read(SNAPSHOT/'work/qualification.json')['status']=='passed','Final numeric qualification failed')
            time.sleep(10)
        require(read(KIT/'work/tokens/manifest.json')['status']=='passed','Incomplete token cache')
        require(read(SNAPSHOT/'work/qualification.json')['status']=='passed','Incomplete numeric qualification')
        save(phase='final_config_and_verified_cache_rebind')
        # Copy only final config after both old writers exited; immutable data/code must match.
        old_bundle=read(KIT/'MANIFEST.json'); snapshot_bundle=read(SNAPSHOT/'MANIFEST.json')
        allowed={'config/train.json','counseling_pipeline/stage1_runtime_probe.py','counseling_pipeline/stage1_readiness.py'}
        require(set(old_bundle['files'])==set(snapshot_bundle['files']),'Snapshot inventory changed')
        for name,entry in old_bundle['files'].items():
            require(sha(KIT/name)==entry['sha256'] and (KIT/name).stat().st_size==entry['bytes'],'Main kit integrity changed: '+name)
            require(sha(SNAPSHOT/name)==snapshot_bundle['files'][name]['sha256'],'Snapshot file integrity changed: '+name)
            if name not in allowed:
                require(entry==snapshot_bundle['files'][name] and sha(SNAPSHOT/name)==entry['sha256'],'Snapshot identity differs: '+name)
        final=read(SNAPSHOT/'config/train.json'); old=read(KIT/'config/train.json')
        require(final['max_length']==25316 and final['layer_split']==28 and final['unsloth_tiled_mlp'] is True,'Wrong final configuration')
        require({k for k in set(old)|set(final) if old.get(k)!=final.get(k)} <= {'max_length','layer_split'},'Unexpected config change')
        backup=ROOT/'work/collection/pre_final_config_v1'; backup.mkdir()
        for relative in (*allowed,'MANIFEST.json','work/tokens/manifest.json'):
            target=backup/relative; target.parent.mkdir(parents=True,exist_ok=True); shutil.copy2(KIT/relative,target)
        for name in allowed:
            source=SNAPSHOT/name;target=KIT/name
            temporary=target.with_suffix(target.suffix+'.final-tmp');shutil.copy2(source,temporary);temporary.replace(target)
            old_bundle['files'][name]=snapshot_bundle['files'][name]
        manifest_tmp=KIT/'MANIFEST.json.final-tmp'; manifest_tmp.write_text(json.dumps(old_bundle,indent=2,ensure_ascii=False)+'\n'); manifest_tmp.replace(KIT/'MANIFEST.json')
        run([PYTHON,'-B',str(ROOT/'scripts/rebind_token_cache_v2.py'),'--kit',str(KIT),'--old-config',str(ROOT/'work/collection/tokenization_config_28672_split26.json'),'--old-bundle',str(backup/'MANIFEST.json')], ROOT/'work/collection/rebind-final-25316-split28.log')
        sys.path.insert(0,str(KIT))
        from counseling_pipeline.stage1_preparation import verify_bundle,load_config,bindings
        from scripts.malssi_stage1 import validate_preparation
        verify_bundle(KIT); final_bindings=bindings(KIT,load_config(KIT))
        qualification=validate_preparation(SNAPSHOT/'work',final_bindings)
        require(read(KIT/'work/tokens/manifest.json')['bindings']==final_bindings,'Rebound cache identity mismatch')
        target=KIT/'work/qualification.json'
        with target.open('xb') as f: f.write((SNAPSHOT/'work/qualification.json').read_bytes())
        validate_preparation(KIT/'work',final_bindings)
        save(phase='essential_canary_then_B0_full_training_B1',final_bindings=final_bindings,
             qualification_reuse={'source':str(SNAPSHOT/'work/qualification.json'),'sha256':sha(target),'exact_binding_equality':True})
        run(['bash',str(KIT/'work/run_with_metrics_v3.sh'),'start'],ROOT/'work/collection/full-training-start-v1.log',KIT,monitor_training=True)
        save(phase='strict_result_collection',main_training_started=True)
        run([PYTHON,'-B',str(KIT/'work/collect_results.py'),'--kit',str(KIT)],ROOT/'work/collection/full-training-results-v1.log',KIT)
        save(status='passed',phase='training_evaluation_collection_completed',inference='ready for deferred measurements after GPU release')
    except BaseException as error:
        (ROOT/'work/collection/full_training_pipeline_v1.error.log').write_text(traceback.format_exc())
        save(status='failed',error_type=type(error).__name__,error=str(error))
        return 1
    finally:
        lock.close()
    return 0


if __name__=='__main__':
    raise SystemExit(main())
