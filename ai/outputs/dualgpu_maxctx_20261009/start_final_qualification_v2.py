"""Create immutable final-config snapshot for GPU qualification while CPU tokenization runs."""
import datetime, hashlib, json, shutil, subprocess
from pathlib import Path
ROOT=Path('/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009')
SOURCE=ROOT/'training_kit'
DEST=ROOT/'qualification_25316_split28_v2'
PYTHON='/home/slim/choieram/malssi-validation-20261009/.venv/bin/python'
assert ROOT==ROOT.resolve() and SOURCE==SOURCE.resolve() and not DEST.exists()
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for b in iter(lambda:f.read(8*1024*1024),b''):h.update(b)
 return h.hexdigest()
manifest=json.loads((SOURCE/'MANIFEST.json').read_text())
for name,entry in manifest['files'].items():
 p=SOURCE/name
 assert p==p.resolve() and p.is_relative_to(SOURCE)
 assert p.stat().st_size==entry['bytes'] and sha(p)==entry['sha256'],name
DEST.mkdir()
for name in manifest['files']:
 p=DEST/name;p.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(SOURCE/name,p)
patched=DEST/'counseling_pipeline/stage1_runtime_probe.py'
shutil.copy2(ROOT/'qualification_fix/stage1_runtime_probe.py',patched)
manifest['files']['counseling_pipeline/stage1_runtime_probe.py']={'sha256':sha(patched),'bytes':patched.stat().st_size}
config_path=DEST/'config/train.json'
config=json.loads(config_path.read_text());config.update(max_length=25316,layer_split=28)
config_path.write_text(json.dumps(config,indent=2,ensure_ascii=False)+'\n')
manifest['files']['config/train.json']={'sha256':sha(config_path),'bytes':config_path.stat().st_size}
(DEST/'MANIFEST.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n')
log=ROOT/'work/collection/qualification-final-25316-split28-v2.log'
with log.open('xb') as out:
 p=subprocess.Popen([PYTHON,'-B',str(DEST/'scripts/malssi_stage1.py'),'qualify','--kit',str(DEST)],stdin=subprocess.DEVNULL,stdout=out,stderr=subprocess.STDOUT,cwd=DEST,start_new_session=True)
state={'pid':p.pid,'started_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'snapshot':str(DEST),'log':str(log),'purpose':'Final numeric qualification concurrent with CPU tokenization; report reusable only on exact binding equality','final_config':config}
report=ROOT/'work/collection/qualification-final-start-v2.json'
with report.open('x') as f:json.dump(state,f,indent=2)
print(json.dumps({k:v for k,v in state.items() if k!='final_config'}))
