#!/usr/bin/env python3
"""Apply the user-approved collection route and restart only the identified API.

Back up both changed sources. Keep weights, checkpoint, config and normal API
validation intact. No training, packages, GPU reset, or unrelated process control.
"""
import argparse
import base64
import json
from pathlib import Path
import shlex
import subprocess
import time

import collect_ft31_comparison as collector

REMOTE = r'''
import base64,hashlib,json,os,signal,subprocess,sys,time
from pathlib import Path
root=Path('/home/slim/choieram/model_Training/trained_model_api')
payload=json.load(sys.stdin)
status=json.loads((root/'runtime/status.json').read_text())
config_bytes=(root/'config.json').read_bytes()
config=json.loads(config_bytes)
assert status['status']=='ready' and status['checkpoint_step']==100
assert status['checkpoint_sha256']==payload['checkpoint_sha256']
assert config['checkpoint_sha256']==payload['checkpoint_sha256']
assert hashlib.sha256(config_bytes).hexdigest()==payload['config_sha256']
pid=status['pid']
cmdline=Path(f'/proc/{pid}/cmdline').read_bytes()
assert str(root).encode() in cmdline and b'qualify_decode_and_serve.py' in cmdline
deployment=root/'runtime'/payload['deployment_name']
assert deployment.resolve().is_relative_to(root) and not deployment.exists()
deployment.mkdir(mode=0o700)
for name in ('server.py','active_cache_server.py'):
    original=(root/name).read_bytes()
    assert hashlib.sha256(original).hexdigest()==payload['files'][name]['before_sha256']
    data=base64.b64decode(payload['files'][name]['base64'])
    assert hashlib.sha256(data).hexdigest()==payload['files'][name]['after_sha256']
    compile(data,str(root/name),'exec')
    (deployment/(name+'.before')).write_bytes(original)
    (deployment/(name+'.after')).write_bytes(data)
record={'old_pid':pid,'new_pid':None,'started_at':time.time(),'config_sha256':payload['config_sha256'],'checkpoint_sha256':payload['checkpoint_sha256'],
    'deployment_directory':str(deployment),'files':{name:{k:v for k,v in value.items() if k!='base64'} for name,value in payload['files'].items()}}
(deployment/'deployment.json').write_text(json.dumps(record,indent=2))
os.kill(pid,signal.SIGTERM)
deadline=time.monotonic()+60
while Path(f'/proc/{pid}').exists():
    statusfile=Path(f'/proc/{pid}/status')
    if statusfile.exists() and '\nState:\tZ' in statusfile.read_text(): break
    if time.monotonic()>deadline: raise RuntimeError('Approved API did not stop within60s; no new process started')
    time.sleep(.5)
for name in ('server.py','active_cache_server.py'):
    assert hashlib.sha256((root/name).read_bytes()).hexdigest()==payload['files'][name]['before_sha256']
    temp=root/(name+'.collection.tmp')
    temp.write_bytes((deployment/(name+'.after')).read_bytes())
    temp.replace(root/name)
assert (root/'config.json').read_bytes()==config_bytes
log=deployment/'server.log'
with log.open('ab') as output:
    process=subprocess.Popen(['bash',str(root/'run_server.sh')],cwd='/home/slim/choieram',stdin=subprocess.DEVNULL,
        stdout=output,stderr=subprocess.STDOUT,start_new_session=True)
record.update(new_pid=process.pid,log=str(log),launched_at=time.time(),state='loading')
(deployment/'deployment.json').write_text(json.dumps(record,indent=2))
print(json.dumps(record))
'''


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('run',type=Path)
    run=parser.parse_args().run.resolve()
    verification=collector.read(run/'evidence/compatibility_verification.json')
    payload={'checkpoint_sha256':collector.CHECKPOINT,
        'config_sha256':collector.sha((run/'evidence/server_snapshot/config.json').read_bytes()),
        'deployment_name':'collection-route-'+run.name.removeprefix('ft31_step100_collection_'),'files':{}}
    for name,before,after in (('server.py','source_server_sha256','patched_server_sha256'),
        ('active_cache_server.py','source_route_sha256','patched_route_sha256')):
        staged=run/'evidence'/name.replace('.py','.compatibility.py')
        payload['files'][name]={'before_sha256':verification[before],'after_sha256':verification[after],
            'base64':base64.b64encode(staged.read_bytes()).decode()}
    command='cd /home/slim/choieram && /home/slim/choieram/malssi-validation-20261009/.venv/bin/python -B -c '+shlex.quote(REMOTE)
    result=subprocess.run(['ssh','-S','/tmp/qwen38-slim-20522.sock','-p','20522','-o','BatchMode=yes','-o','ConnectTimeout=10',
        'slim@165.194.161.61',command],input=collector.encoded(payload),capture_output=True,check=True,timeout=90)
    value=json.loads(result.stdout)
    (run/'evidence/api_deployment.json').write_bytes(result.stdout)
    (run/'evidence/deploy_ft31_compatibility.py').write_bytes(Path(__file__).read_bytes())
    print(json.dumps(value),flush=True)
    deadline=time.monotonic()+240
    while time.monotonic()<deadline:
        try:
            collector.health(run,'http://127.0.0.1:18080','post_deployment')
            health=collector.read(run/'evidence/health_post_deployment.json')
            assert health['pid']==value['new_pid']
            write=collector.write
            manifest=collector.read(run/'run_manifest.json')
            expected=manifest['expected_system_fingerprint']
            assert health.get('model_fingerprint',health.get('system_fingerprint'))==expected
            manifest.update(generation_ready=True,collection_endpoint='/v1/collection/chat/completions',
                collector_sha256=collector.sha(Path(collector.__file__).read_bytes()),
                compatibility_deployment_sha256=collector.sha(result.stdout))
            write(run/'run_manifest.json',manifest)
            (run/'evidence/collect_ft31_comparison.py').write_bytes(Path(collector.__file__).read_bytes())
            print('READY: same checkpoint and runtime fingerprint; collection route deployed',flush=True)
            return
        except (OSError,ValueError,KeyError):
            time.sleep(3)
    raise RuntimeError('API readiness not confirmed within240s; inspect exact deployment log')


if __name__=='__main__':main()
