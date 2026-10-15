#!/usr/bin/env python3
"""Create a portable source snapshot without model weights or private runtime data."""
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
from urllib.parse import unquote, urlsplit
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT.parent / 'app'
EXCLUDED = {'.git', '.omx', '.codex', '.agents', '__pycache__', 'node_modules',
            '.venv', 'venv', 'runtime', 'outputs', 'downloads', 'archive',
            'models', 'checkpoints', 'weights', '.DS_Store'}
MODEL_SUFFIXES = {'.safetensors', '.gguf', '.ggml', '.bin', '.pt', '.pth', '.onnx',
                  '.ckpt', '.h5', '.npy', '.npz', '.pkl', '.pickle'}
SOURCE_SUFFIXES = {'.py', '.mjs', '.js', '.json', '.md', '.sh', '.yaml', '.yml', '.txt', '.html', '.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.woff', '.woff2', '.ttf', '.ico', '.sql'}

def allowed(path, base):
    relative = path.relative_to(base)
    if path.is_symlink() or any(part in EXCLUDED for part in relative.parts):
        return False
    if path.name.startswith('.env') and path.name != '.env.example':
        return False
    if path.suffix.lower() in MODEL_SUFFIXES or path.suffix.lower() in {'.zip', '.log', '.pyc', '.plist'}:
        return False
    return path.suffix.lower() in SOURCE_SUFFIXES or path.name in {'.env.example', '.gitignore', '.dockerignore', 'Dockerfile'}

def copy_tree(source, destination):
    for path in sorted(source.rglob('*')):
        if path.is_file() and allowed(path, source):
            target = destination / path.relative_to(source)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(path, target)

def copy_shared_docs(project, destination):
    for relative in ['README.md', 'docs/README.md']:
        source = project / relative
        if source.is_file():
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    copy_tree(project / 'docs/current', destination / 'docs/current')


def normalize_document_links(destination, project):
    """Keep packaged links usable and mark references to source-only material."""
    inline = re.compile(r'!?\[([^\]\n]+)\]\((<[^>\n]+>|(?:[^()\s\n]|\([^()\n]*\))*)(?:\s+"[^"\n]*")?\)|`+[^`\n]*`+')
    reference = re.compile(r'^ {0,3}\[([^\]\n]+)\]:\s*(<[^>\n]+>|\S+)(?:\s+.*)?$', re.MULTILINE)
    uses = re.compile(r'!?\[([^\]\n]+)\](?:\[([^\]\n]*)\])?(?!\()|`+[^`\n]*`+')
    project = project.resolve()
    destination = destination.resolve()
    for path in sorted(destination.rglob('*.md')):
        def target_info(raw):
            target = raw.strip('<>')
            url = urlsplit(target)
            if url.scheme or url.netloc or not url.path:
                return None
            decoded = Path(unquote(url.path))
            if decoded.is_absolute():
                original = decoded.resolve()
            else:
                original = (project / path.relative_to(destination).parent / decoded).resolve()
            if original.is_relative_to(project):
                relative = original.relative_to(project)
                packaged = destination / relative
                if packaged.exists():
                    if decoded.is_absolute():
                        local = os.path.relpath(packaged, path.parent)
                        suffix = ('?' + url.query if url.query else '') + ('#' + url.fragment if url.fragment else '')
                        return ('local', '<' + local + suffix + '>')
                    return None
                return ('missing', relative.as_posix())
            return ('missing', str(original))

        def replace_inline(match):
            if match[1] is None:
                return match[0]
            info = target_info(match[2])
            if info is None:
                return match[0]
            kind, target = info
            if kind == 'local':
                return match[0].replace(match[2], target, 1)
            return f'{match[1]} (원본 프로젝트 경로: `{target}`)'

        # Keep fenced and inline code samples intact; process prose only.
        chunks = re.split(r'(^[ \t]*```[^\n]*\n.*?^[ \t]*```[^\n]*$|^[ \t]*~~~[^\n]*\n.*?^[ \t]*~~~[^\n]*$)', path.read_text(), flags=re.MULTILINE | re.DOTALL)
        definitions = {}
        for index in range(0, len(chunks), 2):
            for match in reference.finditer(chunks[index]):
                definitions[match[1].strip().casefold()] = target_info(match[2])

        def replace_reference(match):
            if match[1] is None:
                return match[0]
            key = (match[2] or match[1]).strip().casefold()
            info = definitions.get(key)
            if info and info[0] == 'missing':
                return f'{match[1]} (원본 프로젝트 경로: `{info[1]}`)'
            return match[0]

        def replace_definition(match):
            info = definitions.get(match[1].strip().casefold())
            if info and info[0] == 'missing':
                return ''
            if info and info[0] == 'local':
                return match[0].replace(match[2], info[1], 1)
            return match[0]

        for index in range(0, len(chunks), 2):
            prose = reference.sub(replace_definition, chunks[index])
            prose = inline.sub(replace_inline, prose)
            chunks[index] = uses.sub(replace_reference, prose)
        path.write_text(''.join(chunks))

def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()

def known_secrets():
    values = []
    for path in [ROOT/'local_api/runtime/config.json', ROOT/'trained_model_api/runtime/api_key']:
        if path.is_file():
            value = json.loads(path.read_text()).get('api_key', '') if path.suffix == '.json' else path.read_text().strip()
            if len(value) > 8:
                values.append(value)
    env = BACKEND/'.env'
    if env.is_file():
        for line in env.read_text().splitlines():
            key, _, value = line.partition('=')
            if any(label in key for label in ['KEY', 'PASSWORD']) and len(value) > 8:
                values.append(value)
    return [value.encode() for value in set(values)]

def main():
    created_at = datetime.now(timezone.utc).isoformat()
    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    name = 'malssi_model_free_' + stamp
    destination = ROOT/'outputs'/'handoff'/name
    destination.mkdir(parents=True, exist_ok=False)
    copy_tree(BACKEND, destination/'app')
    # Copy maintained source only; generated reports and historical archives are excluded.
    for folder in ['local_api', 'trained_model_api', 'scripts', '서비스_문서']:
        copy_tree(ROOT/folder, destination/'ai'/folder)
    kit = ROOT/'downloads/gemma4_training_data_20261010_111326/training_kit'
    if kit.is_dir():
        for folder in ['counseling_pipeline', 'tests', 'scripts', 'config']:
            copy_tree(kit/folder, destination/'ai/legacy_training_kit'/folder)
        shutil.copy2(kit/'run.sh', destination/'ai/legacy_training_kit/run.sh')
    for path in ROOT.glob('*.md'):
        shutil.copy2(path, destination/'ai'/path.name)
    shutil.copy2(ROOT/'.gitignore', destination/'ai/.gitignore')
    copy_shared_docs(ROOT.parent, destination)
    tools = destination/'tools'
    tools.mkdir()
    shutil.copy2(ROOT/'scripts/handoff/configure_local.py', tools/'configure_local.py')
    (destination/'app/compose.portable.yaml').write_text('services:\n  api:\n    extra_hosts:\n      - "host.docker.internal:host-gateway"\n')
    pending = []
    overlay = ROOT/'local_api/backend_patch'
    for path in sorted(overlay.rglob('*')):
        if not path.is_file() or not allowed(path, overlay):
            continue
        relative = path.relative_to(overlay)
        actual = BACKEND/relative
        if not actual.exists() or path.read_bytes() != actual.read_bytes():
            pending.append(str(relative))
    (destination/'PENDING_CHANGES.json').write_text(json.dumps({
        'source': 'ai/local_api/backend_patch', 'target': 'app',
        'status': 'source_comparison_only', 'different_files': pending,
        'warning': 'File differences do not establish deployment or validation status. Review docs/current before applying changes; preserve environment configuration.'
    }, ensure_ascii=False, indent=2)+'\n')
    (destination/'START_HERE.md').write_text('''# 말씨 프로젝트 — 모델 제외 개발 인수인계

공통 문서 스냅샷 시각(UTC): {snapshot_time}

`app`의 서버·웹 소스, 질문은행, DB 마이그레이션, 테스트와 웹 글꼴·이미지 및 `ai`의 모델·에이전트 개발 소스를 포함합니다. 이 프로젝트 루트 아래의 `app/`과 `ai/` 구조를 유지하세요.

## 새 환경에서 실행

Node.js 24.14 이상 25 미만, Python 3, Docker Compose가 필요합니다. 모델 파일과 모델 실행기는 포함하지 않았습니다. 새 환경에서 `gemma4:12b`를 별도로 준비하거나 호환 모델 서버 주소를 설정하세요. 원래 Mac의 Ollama MLX 실행 환경 자체는 이 ZIP으로 복제되지 않습니다.

압축 해제한 이 폴더에서:

```bash
python3 tools/configure_local.py
cd app
npm ci
npm run check
docker compose -f compose.yaml -f compose.portable.yaml up -d --build
```

브라우저에서 `http://127.0.0.1:9000`을 엽니다. 기본 모델 주소는 호스트 `http://127.0.0.1:11434/v1`, Docker `http://host.docker.internal:11434/v1`입니다. 원격 모델은 `app/.env`의 `MODEL_BASE_URL`, `MODEL_DOCKER_BASE_URL`, `MODEL_API_KEY`를 새 환경에 맞게 바꾸세요. 모델 ID는 `MODEL_NAME`입니다. `configure_local.py`는 신규 비밀값을 만들며 기존 비어 있지 않은 설정은 보존합니다. 인증 프록시를 쓰면 실제 키를 직접 설정해야 합니다.

Linux에서 호스트의 모델 서버가 127.0.0.1에만 바인딩돼 있으면 컨테이너에서 접근할 수 없습니다. Docker에서 도달 가능한 주소로 구성하거나, DB만 Docker로 실행하고 `app`에서 `npm start`로 API를 실행하세요. `compose.portable.yaml`은 Docker의 호스트 이름 매핑만 추가합니다. 기존 `.env`의 Tailscale 주소·인증 정보는 이 패키지에 들어 있지 않습니다.

```bash
# PostgreSQL이 실행된 뒤, 별도의 테스트 스키마에서 검사
npm run test:integration
```

## 현재 상태와 다음 작업

이 패키지는 `app/`·`ai/` 소스 일부를 전달하는 스냅샷입니다. 전체 프로젝트의 현재 상태·할 일·실행·데이터 연구 설명은 함께 복사한 [프로젝트 홈](README.md)과 [공통 문서](docs/README.md)를 기준으로 확인하세요. 생성 시각은 `MANIFEST.json`의 `created_at`이며, 복사 시점 이후의 운영 상태나 검증 결과를 보장하지 않습니다.

전체 프로젝트 문서는 그대로 복사하되, 패키지에 없는 데이터·발표·보관·검증 증거를 가리키는 링크는 원본 프로젝트 경로로 표시합니다. 해당 자료가 필요하면 원본 프로젝트에서 확인하세요. 상태·성과 수치를 이 안내에 별도로 복제하지 않습니다.

공통 문서의 루트 명령은 전체 프로젝트 기준입니다. 이 패키지의 실행은 위의 `cd app` 절차를 따르며, 데이터·발표 작업에는 원본 프로젝트의 해당 모듈이 필요합니다.

`PENDING_CHANGES.json`은 패키지 생성 시점에 `ai/local_api/backend_patch`와 `app`의 파일을 비교한 결과입니다. 배포 여부나 검증 통과를 판정하는 자료가 아닙니다. 변경 적용 전 [현재 상태와 할 일](docs/current/현황과_할일.md)을 확인하고 새 환경에서 검증하세요. `apply_relationship_backend.py`는 로컬 모델 설정을 전제로 `.env`까지 바꾸므로 설정과 변경 내용을 먼저 검토해야 합니다.

## 포함하지 않은 항목

모델 가중치·체크포인트, 기존 ZIP, node_modules·가상환경·캐시, Git·OMX 작업 상태, 실제 `.env`·API 키, 쿠키·대화 세션, DB 데이터·덤프, runtime·outputs, 다운로드한 학습 데이터, 과거 문서 archive는 제외했습니다. 따라서 기존 대화/기록은 이전되지 않으며 새 빈 DB로 시작합니다. 다운로드 폴더 안의 학습 코드·테스트·패키지 버전 목록은 `ai/legacy_training_kit`으로 별도 보존했습니다. 모델 API 코드와 모델 경로를 담은 설정 템플릿은 가중치 파일이 아니므로 포함합니다.

`trained_model_api`를 사용할 경우 서버 주소·SSH·체크포인트 경로를 새 환경에 맞게 설정하세요. `config.json`의 `kit_path`는 포함된 `legacy_training_kit` 경로로, 체크포인트 경로는 별도 준비한 모델로 설정해야 합니다. 학습 데이터도 별도로 필요합니다. 원본 프로젝트 파일은 삭제하거나 이동하지 않았습니다.

각 파일의 SHA-256은 `MANIFEST.json`에 있습니다. 압축 CRC와 파일 해시, 비밀값·모델 파일 제외 여부는 패키지 생성 시 검사했습니다. 실제 모델 파일·DB·인증 정보가 없어 새 환경 전체 실행은 별도로 검증해야 합니다.
'''.replace('{snapshot_time}', created_at))
    normalize_document_links(destination, ROOT.parent)
    files = sorted(path for path in destination.rglob('*') if path.is_file())
    secrets = known_secrets()
    for path in files:
        if any(value in path.read_bytes() for value in secrets):
            raise RuntimeError('Known private credential found in package file: '+str(path.relative_to(destination)))
        if path.suffix.lower() in MODEL_SUFFIXES:
            raise RuntimeError('Model artifact found')
    manifest = {
        'created_at': created_at, 'models_included': False,
        'private_runtime_included': False,
        'scope': ['app', 'ai'], 'shared_docs': 'full-project snapshot; source-only links marked',
        'source_commits': {'app': git(BACKEND,'rev-parse','HEAD'), 'ai': git(ROOT,'rev-parse','HEAD')},
        'working_tree_changes_included': True,
        'pending_backend_files': pending,
        'files': [{'path':str(path.relative_to(destination)), 'bytes':path.stat().st_size,
                   'sha256':sha256(path.read_bytes()).hexdigest()} for path in files],
    }
    (destination/'MANIFEST.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
    archive = destination.with_suffix('.zip')
    with ZipFile(archive,'x',ZIP_DEFLATED,compresslevel=9) as zipped:
        for path in sorted(destination.rglob('*')):
            if path.is_file():
                zipped.write(path,Path(name)/path.relative_to(destination))
    with ZipFile(archive) as zipped:
        if zipped.testzip() is not None:
            raise RuntimeError('ZIP CRC verification failed')
        for entry in manifest['files']:
            data=zipped.read(name+'/'+entry['path'])
            if sha256(data).hexdigest()!=entry['sha256']:
                raise RuntimeError('ZIP manifest mismatch')
    digest=sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(digest+'  '+archive.name+'\n')
    print(json.dumps({'zip':str(archive),'bytes':archive.stat().st_size,'files':len(files)+1,
                      'sha256':digest,'pending_files':pending},ensure_ascii=False))

if __name__ == '__main__':
    main()
