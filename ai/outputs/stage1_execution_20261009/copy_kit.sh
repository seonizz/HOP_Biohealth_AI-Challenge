cd /home/slim/choieram && \
PYTHONDONTWRITEBYTECODE=1 /home/slim/choieram/malssi-validation-20261009/.venv/bin/python - <<'PY'
import hashlib, json, os, shutil, stat, uuid, zipfile
from pathlib import Path

base = Path('/home/slim/choieram').resolve()
root = base / 'model_Training'
if root.resolve() != root:
    raise SystemExit('model_Training 경로의 symlink를 먼저 확인하세요.')
root.mkdir(exist_ok=True)
dest = root / 'malssi_stage1_training_20261009'
if dest.exists():
    if not dest.is_dir() or dest.resolve() != dest:
        raise SystemExit('기존 목적지의 종류/실제 경로를 확인하세요.')
    print('기존 폴더 보존. 4절의 지문 및 실행 상태를 확인하세요:', dest)
    raise SystemExit(0)

def sha(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(8 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()

def inside(path, parent):
    p = path.resolve()
    if not p.is_relative_to(parent.resolve()) or p == parent.resolve():
        raise ValueError('허용 경로 밖: ' + str(path))
    return p

source = base / 'malssi-training-preparation-20261009/kit'
stage = root / ('.preparing-' + uuid.uuid4().hex)
stage.mkdir()
if source.is_dir() and os.environ.get('MALSSI_USE_ZIP') != '1':
    inside(source, base)
    manifest = json.loads((source / 'MANIFEST.json').read_text())
    if manifest.get('schema_version') != 'malssi.training-kit-files.v1':
        raise ValueError('기존 kit manifest 형식 불일치')
    for name, info in manifest['files'].items():
        src, dst = inside(source / name, source), inside(stage / name, stage)
        if src.stat().st_size != info['bytes'] or sha(src) != info['sha256']:
            raise ValueError('원본 무결성 불일치: ' + name)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    shutil.copy2(source / 'MANIFEST.json', stage / 'MANIFEST.json')
    for name in ('work/qualification.json', 'work/tokens/manifest.json',
                 'work/tokens/train.jsonl.gz', 'work/tokens/validation.jsonl.gz'):
        src, dst = inside(source / name, source), inside(stage / name, stage)
        if src.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
else:
    archive = root / '말씨_학습_에이전트_인수인계_2026-10-09.zip'
    if not archive.is_file():
        raise SystemExit('기존 kit가 없습니다. 아래 복구 ZIP 전송 후 재실행하세요.')
    if sha(archive) != '18e5cffe5efa77e79c7aa56e739c52dfdf334af8aa9623f0b24743ead44f35ed':
        raise ValueError('복구 ZIP SHA-256 불일치')
    prefix = 'malssi_stage1_training_20261009/'
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            if not item.filename.startswith(prefix) or stat.S_ISLNK(item.external_attr >> 16):
                raise ValueError('예상하지 않은 ZIP 경로/링크')
            name = item.filename[len(prefix):]
            if not name:
                continue
            dst = inside(stage / name, stage)
            if item.is_dir():
                dst.mkdir(parents=True, exist_ok=True)
            else:
                dst.parent.mkdir(parents=True, exist_ok=True)
                with z.open(item) as src, dst.open('xb') as out:
                    shutil.copyfileobj(src, out)
os.rename(stage, dest)
print('준비 완료:', dest)
PY
