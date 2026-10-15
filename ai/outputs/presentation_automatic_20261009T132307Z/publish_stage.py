"""Publish only the reviewed allowlist; refuse changed destination documents."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import tempfile

stage = Path(__file__).resolve().parent
manifest = json.loads((stage / 'publication_manifest.json').read_text())
destination = Path(manifest['destination'])
output = destination / 'outputs' / manifest['output_name']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


assert not output.exists(), 'Output already exists; inspect before retrying'
for item in manifest['files']:
    assert sha(destination / item['file']) == item['before_sha256'], item['file']
    assert sha(stage / 'after' / item['file']) == item['after_sha256'], item['file']
for item in manifest['artifacts']:
    assert sha(stage / 'artifacts' / item['file']) == item['sha256'], item['file']
output.mkdir()
for item in manifest['artifacts']:
    shutil.copy2(stage / 'artifacts' / item['file'], output / item['file'])
for item in manifest['files']:
    target = destination / item['file']
    data = (stage / 'after' / item['file']).read_bytes()
    with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.mechanical-', delete=False) as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
        temporary = Path(stream.name)
    os.replace(temporary, target)
for item in manifest['files']:
    assert sha(destination / item['file']) == item['after_sha256'], item['file']
for item in manifest['artifacts']:
    assert sha(output / item['file']) == item['sha256'], item['file']
result = {'published': True, 'directory': str(output), 'documents_updated': len(manifest['files']), 'artifacts_published': len(manifest['artifacts']), 'all_published_hashes_match': True, 'backup_directory': str(stage / 'before')}
(stage / 'publication_result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(result, ensure_ascii=False))
