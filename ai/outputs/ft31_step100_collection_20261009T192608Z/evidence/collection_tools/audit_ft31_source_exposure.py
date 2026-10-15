#!/usr/bin/env python3
"""Audit exact source-ID overlap against the step100 training corpus, read-only.

Only case/source identifiers are sent through the existing SSH connection.
Remote work uses the Python standard library; no model, training, or API code
is imported and no remote file is written.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import shlex
import subprocess


REMOTE = r'''
import gzip,hashlib,json,pathlib,sys

def require(value,message):
    if not value: raise ValueError(message)

def canonical(value):
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf8')

def sha(data):
    return hashlib.sha256(data).hexdigest()

def file_sha(path):
    h=hashlib.sha256()
    with path.open('rb') as handle:
        for block in iter(lambda:handle.read(8*1024*1024),b''): h.update(block)
    return h.hexdigest()

payload=json.load(sys.stdin)
kit=pathlib.Path(payload['kit_path'])
checkpoint_path=pathlib.Path(payload['checkpoint_path'])/'CHECKPOINT.json'
run_path=kit/'work/training/RUN.json'
dataset_names=('train.jsonl.gz','validation.jsonl.gz','expected_lengths.jsonl.gz','export_manifest.json')
paths=[checkpoint_path,run_path,*[kit/'data'/name for name in dataset_names]]
initial={str(path):(path.stat().st_ino,path.stat().st_size,path.stat().st_mtime_ns) for path in paths}
checkpoint_bytes=checkpoint_path.read_bytes()
require(sha(checkpoint_bytes)==payload['checkpoint_sha256'],'Checkpoint file hash differs from collected model')
checkpoint=json.loads(checkpoint_bytes)
require(checkpoint['step']==100 and checkpoint['cursor']==800,'Unexpected checkpoint step/cursor')
training_run_bytes=run_path.read_bytes()
training_run=json.loads(training_run_bytes)
canonical_run_sha=sha(canonical(training_run))
require(canonical_run_sha==checkpoint['run_sha256'],'Canonical RUN/checkpoint binding mismatch')
export=json.loads((kit/'data/export_manifest.json').read_bytes())
require(export['status']=='verified' and export['dataset_kind']=='source_conversation_only',
        'Unexpected current source dataset export')
hashes={name:file_sha(kit/'data'/name) for name in dataset_names}
dataset_binding_sha=sha(canonical(hashes))
require(dataset_binding_sha==training_run['bindings']['dataset_sha256'],'Four-file dataset binding mismatch')
order=training_run['plan']['order']
require(type(order) is list and len(order)==40415 and all(type(i) is int for i in order)
        and sorted(order)==list(range(40415)),'Training plan is not an exact original-row permutation')
require(training_run['plan']['rows']==40415,'Training plan row count mismatch')
processed_indices=set(order[:checkpoint['cursor']])
cases=payload['cases']
require(len(cases)==32 and len({row['source_id'] for row in cases})==32,'Expected 32 unique DEV source IDs')
selected_ids={row['source_id'] for row in cases}
overlap={name:set() for name in ('full_train','processed_step100','current_validation')}
all_ids=set()
datasets={}
for split,expected_n in (('train',40415),('validation',4298)):
    name=split+'.jsonl.gz'
    path=kit/'data'/name
    entry=export['files'][name]
    require(hashes[name]==entry['sha256'] and path.stat().st_size==entry['bytes'],
            'Compressed dataset hash/size mismatch: '+name)
    raw_hash=hashlib.sha256()
    raw_bytes=0
    count=0
    with gzip.open(path,'rb') as stream:
        for index,line in enumerate(stream):
            raw_hash.update(line); raw_bytes+=len(line)
            row=json.loads(line)
            identity=row['id']
            require(identity not in all_ids and row['split']==split,'Duplicate source ID or wrong dataset split')
            all_ids.add(identity)
            if identity in selected_ids:
                overlap['full_train' if split=='train' else 'current_validation'].add(identity)
                if split=='train' and index in processed_indices:
                    overlap['processed_step100'].add(identity)
            count+=1
    require(count==expected_n==entry['rows'] and raw_hash.hexdigest()==entry['uncompressed_sha256'],
            'Full raw dataset row/hash mismatch: '+name)
    datasets[split]={'path':str(path),'rows':count,'compressed_bytes':path.stat().st_size,
                     'compressed_sha256':hashes[name],'uncompressed_bytes':raw_bytes,
                     'uncompressed_sha256':raw_hash.hexdigest(),'export_manifest_hashes_match':True}
for path in paths:
    stat=path.stat()
    require(initial[str(path)]==(stat.st_ino,stat.st_size,stat.st_mtime_ns),'Source changed during read: '+str(path))
result={'status':'verified','scope':'Exact original source-ID overlap; no text/semantic contamination claim',
        'checkpoint_step':checkpoint['step'],'checkpoint_cursor':checkpoint['cursor'],
        'checkpoint_path':str(checkpoint_path),'checkpoint_sha256':sha(checkpoint_bytes),
        'training_run_path':str(run_path),'training_run_file_sha256':sha(training_run_bytes),
        'training_run_canonical_sha256':canonical_run_sha,'checkpoint_run_binding_matches':True,
        'dataset_binding_files_sha256':hashes,'dataset_binding_sha256':dataset_binding_sha,
        'training_run_dataset_binding_matches':True,'datasets':datasets,
        'processed_original_rows':len(processed_indices),'training_plan_order_sha256':sha(canonical(order)),
        'selected_legacy_cases':32,
        'overlap_counts':{name:len(ids) for name,ids in overlap.items()},
        'cases':[{**row,'in_full_current_train':row['source_id'] in overlap['full_train'],
                 'in_processed_step100_rows':row['source_id'] in overlap['processed_step100'],
                 'in_current_validation':row['source_id'] in overlap['current_validation']} for row in cases],
        'source_files_unchanged_during_audit':True,'remote_files_written':0,
        'model_imports':0,'model_generations':0,
        'limitations':['Exact ID absence does not rule out related text, conversation, or group exposure.',
                       'Cases are legacy development cases; this audit does not make them an independent final test.',
                       'Processed-row mapping uses the bound original-row order and checkpoint cursor; no optimizer state is loaded.']}
print(json.dumps(result,ensure_ascii=False,sort_keys=True,allow_nan=False))
'''


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    parser.add_argument("--host", default="slim@165.194.161.61")
    parser.add_argument("--socket", default="/tmp/qwen38-slim-20522.sock")
    args = parser.parse_args()
    root = args.run.resolve()
    manifest = json.loads((root / "run_manifest.json").read_bytes())
    case_bytes = (root / "case_manifest.jsonl").read_bytes()
    if sha(case_bytes) != manifest["case_manifest_sha256"]:
        raise ValueError("Frozen case manifest changed")
    cases = [json.loads(line) for line in case_bytes.splitlines()]
    legacy = [{key: case[key] for key in ("case_id", "task", "source_id")}
              for case in cases if case["split"] == "legacy_validation_development"]
    config = json.loads((root / "evidence/server_snapshot/config.json").read_bytes())
    payload = {"cases": legacy, "kit_path": config["kit_path"], "checkpoint_path": config["checkpoint_path"],
               "checkpoint_sha256": manifest["checkpoint_sha256"]}
    command = "cd /home/slim/choieram && python3 -B -c " + shlex.quote(REMOTE)
    process = subprocess.run(["ssh", "-S", args.socket, "-p", "20522", "-o", "BatchMode=yes",
                              "-o", "ConnectTimeout=10", args.host, command],
                             input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                             capture_output=True, check=True, timeout=300)
    result = json.loads(process.stdout)
    result.update(run_id=manifest["run_id"], observed_at=datetime.now(timezone.utc).isoformat(),
                  case_manifest_sha256=sha(case_bytes), metadata_only_transmitted=True,
                  script_sha256=sha(Path(__file__).read_bytes()), remote_script_sha256=sha(REMOTE.encode("utf-8")))
    evidence = root / "evidence"
    evidence.mkdir(exist_ok=True)
    (evidence / "audit_ft31_source_exposure.py").write_bytes(Path(__file__).read_bytes())
    (evidence / "training_exposure.remote.py").write_text(REMOTE, encoding="utf-8")
    target = evidence / "training_exposure.json"
    write(target, result)
    print(json.dumps({"status": result["status"], "path": str(target), "sha256": sha(target.read_bytes()),
                      "selected_legacy_cases": result["selected_legacy_cases"],
                      "overlap_counts": result["overlap_counts"],
                      "dataset_binding_matches": result["training_run_dataset_binding_matches"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
