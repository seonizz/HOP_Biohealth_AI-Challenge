> **최신 사용자 우선순위 — 2026-10-09:** 긴 대화를 포함한 전체 데이터 본학습과 학습 전후 비교를 먼저 완료한다. 추가 최대 토큰 탐색은 보류하고, 서비스 추론 최대치 측정은 B0 → 본학습 → B1 → 결과 수집 이후에 수행한다. 아래 단일 GPU·4,096토큰·1,939-step 본문은 이전 기준으로 보존한다.
>
> 현재 서버 작업 루트: `/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009`. 기존 단일 GPU 결과와 모든 검사 로그를 보존한다.
>
> **학습 40,415행 / 검증 4,298행**, 기존 split·group 및 보류 1,261행 정책을 유지한다. 최장 학습 길이 **25,316토큰**, 최장 검증 길이 **14,014토큰**을 잘림 없이 처리한다. 긴 행을 제외하거나 합성 검사 데이터를 본학습에 넣지 않는다. accumulation 8·1 epoch의 본학습은 **5,052 optimizer step**이다.
>
> 진행 중이던 28,672토큰·split 25 안정성 검사는 누적 9 microstep / 1 optimizer update 이후 GPU 0 메모리 부족으로 실패했다. 실제 최장 길이 25,316토큰·split 28·Tiled MLP 설정으로 조정한다. 최장 실제 8행을 사용하는 canary의 2회 업데이트와 새 프로세스 재개 1회로 반복 accumulation 8 안정성과 저장/재개를 함께 검증한다. 합성 반복 검사를 별도로 추가하지 않는다.
>
> 필수 검증은 전체 토큰화·정답 경계, 변경 계산의 수치 정확성, 실제 accumulation 8 반복 업데이트, 체크포인트 저장·새 프로세스 재개다. 동일 데이터·코드·설정의 통과 근거는 재사용한다. 검증 후 추가 확인 요청 없이 **B0 → 전체 1 epoch 본학습 → B1 → 결과 수집**으로 진행한다.
>
> 현재 **본학습 시작 전, 0/5,052 step, 본학습 loss 없음**. 서버 코드 단위 검사 99개가 통과했고 전체 44,713행의 토큰화·정답 경계 검증이 완료됐다. 수치 기준값의 행렬 크기를 보정한 검증 코드가 서버 CPU 검사 9개를 통과했으며, 최종 GPU 수치 검증도 통과했다. 현재 최종 설정의 전체 캐시 재검증과 실제 장문 저장·재개 검사를 진행한다. 추론 대기 프로세스는 GPU를 점유하기 전에 중단했으며 취소하지 않고 후순위로 보존했다. 상태 원본: `outputs/dualgpu_maxctx_20261009/plan_state.json`.

# 말씨 GPU 학습 — 단일 인수인계 README

기준일: 2026-10-09. 서버 작업 폴더: **`/home/slim/choieram/model_Training`**.

이 문서는 서비스 설명, 서버 접속 규칙, 최신 학습 패키지, 대회 발표용 수집 지침을 하나로 합친 실행 안내다. **다음 에이전트에게 이 README와 “이 문서대로 학습을 진행해줘”라는 요청을 전달하면 된다.** 서버에 기록된 기존 kit·모델·가상환경이 남아 있으면 추가 문서 전송 없이 진행할 수 있다. README 자체에 데이터·코드·가중치가 들어 있는 것은 아니므로, 기존 kit가 없을 때는 아래 복구 ZIP에도 접근할 수 있어야 한다.

문서 통합 과정에서는 서버 접속이나 학습을 실행하지 않았다. 아래 준비 상태는 로컬 패키지의 실행 코드·설정·저장 증거를 대조한 결과이며, 실제 서버 상태는 실행 에이전트가 다시 확인한다.

## 1. 실행 에이전트에게 전달하는 작업

1. 서버 규칙·인증·GPU 상태를 확인하고, 기존 kit를 **새 작업 폴더 안으로 복사**한다.
2. 데이터·코드·모델·환경 지문을 대조하고 준비 검사를 통과시킨다.
3. 실행별 시각·종료 상태·GPU 사용량 기록을 켠다.
4. 실제 31B optimizer canary를 **2회 실행 → 저장 → 새 프로세스에서 1회 추가 실행**한다.
5. 초기 모델에서 학습 전 검증, 본학습 **1 epoch / optimizer step 1,939회**, 학습 후 검증을 수행한다.
6. 체크포인트·학습 로그·검증 결과·측정 한계를 정리해 반환한다. 이미 완료됐으면 재학습하지 않고 결과를 검증해 반환한다.

이 실행 범위는 **원본 상담사의 마지막 응답을 학습하는 1단계 SFT**다. 말씨의 최종 목표는 가족·주변인에게 구체적인 대화법과 행동을 안내하는 것이며, 이번 학습 완료만으로 그 목표의 성능이나 서비스 출시가 검증되지는 않는다. AI 초안 24건·설계 예시를 새 정답으로 추가하지 않는다.

## 2. 고정 접속 정보와 작업 경계

| 항목 | 값 |
|---|---|
| SSH | `slim@165.194.161.61`, 포트 `20522` |
| 기존 인증 ControlPath | `/tmp/qwen38-slim-20522.sock` — 유효성 확인 후 재사용 |
| 새 작업 루트 | `/home/slim/choieram/model_Training` |
| 이번 실행 kit | `/home/slim/choieram/model_Training/malssi_stage1_training_20261009` |
| 복사 원본으로 기록된 서버 kit | `/home/slim/choieram/malssi-training-preparation-20261009/kit` |
| 읽기용 모델 | `/home/slim/choieram/models/gemma-4-31B-it-unsloth-bnb-4bit` |
| 기존 Python | `/home/slim/choieram/malssi-validation-20261009/.venv/bin/python` |
| 사용할 GPU | 물리 GPU 0, UUID `GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c` |

새 코드·데이터 사본·로그·체크포인트·캐시·임시 파일은 모두 `model_Training` 아래에 둔다. 기존 모델·venv는 그 위치에서 읽고 재사용한다. 실행기는 중복 GPU 사용 방지를 위해 기존 공통 잠금 파일 `/home/slim/choieram/.malssi-GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c.lock`도 사용한다. 이 잠금 경로를 임의 변경하면 기존 실행과의 잠금 공유가 깨진다.

원격 명령은 `cd /home/slim/choieram && ...`으로 시작한다. 루트 및 작업 경로에 적용되는 `AGENTS.md`를 먼저 읽고, 심볼릭 링크가 다른 위치를 가리키지 않는지 확인한다. 서버 재부팅·GPU reset·드라이버 변경·기존 환경 업그레이드·다른 프로세스 종료·기존 파일 삭제/덮어쓰기를 하지 않는다. 기존 8888 터널과 정지된 `ys/hop_node_20261009`, `ys/hop-serving` 서비스를 유지한다. 학습을 `ys`에서 실행하지 않는다.

### 로컬에서 인증과 서버 확인

```bash
ssh -S /tmp/qwen38-slim-20522.sock -p 20522 -O check slim@165.194.161.61
ssh -S /tmp/qwen38-slim-20522.sock -p 20522 \
  -o BatchMode=yes -o ConnectTimeout=10 slim@165.194.161.61 \
  'cd /home/slim/choieram && pwd && cat AGENTS.md && nvidia-smi'
```

소켓이 만료됐다면 기존 연결을 종료하지 말고 사용자가 Terminal에서 직접 인증한다. 새 인증은 별도 소켓으로 만들 수 있다. 비밀번호를 문서·채팅·스크립트·로그에 넣지 않는다. 이후 명령의 `-S`도 실제 사용하는 소켓으로 맞춘다.

```bash
ssh -MNf -p 20522 -o ControlMaster=yes -o ControlPersist=600 \
  -o ControlPath=/tmp/malssi-training-20522.sock slim@165.194.161.61
```

GPU가 다른 작업에 사용 중이면 시작하지 않는다. 실행기는 지정 UUID에 compute process가 없고, 사용 메모리 512 MiB 미만·사용률 0%인지 검사한다. 두 GPU의 VRAM을 합치거나 GPU 1로 자동 전환하지 않는다.

## 3. 새 폴더에 실행 자료 준비

**이하 명령은 서버의 Bash에서 실행한다.** 로컬 에이전트라면 인증된 SSH로 전달한다. 최초 작업 전에 아래 규칙 파일 중 존재하는 것을 읽는다.

```bash
cd /home/slim/choieram && \
for MALSSI_RULE in AGENTS.md model_Training/AGENTS.md \
  model_Training/malssi_stage1_training_20261009/AGENTS.md; do
  if [ -f "$MALSSI_RULE" ]; then cat "$MALSSI_RULE"; fi
done
```

다음 명령은 서버의 기존 kit를 새 위치로 복사한다. **기존 학습 출력은 복사하지 않는다.** 검증된 토큰 캐시와 비업데이트 qualification만 재사용한다. 목적지가 이미 있으면 덮어쓰지 않고 이후 검증·상태 확인으로 넘어간다. 기존 kit가 없으면 같은 명령이 작업 루트의 복구 ZIP을 사용한다.

```bash
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
```

실패한 `.preparing-*`는 진단용으로 보존하고, 완성된 kit로 취급하지 않는다. 원본 kit 자체가 맞지 않으면 아래 ZIP을 준비한 뒤 `export MALSSI_USE_ZIP=1`을 설정하고 위 명령을 다시 실행한다. 이미 만들어진 목적지는 자동 대체하지 않으며, 해당 실패 폴더를 보존한 새 목적지에서 복구한다.

**기존 kit가 없을 때만 사용하는 로컬 복구 전송:** 앞 명령이 `model_Training`을 만든 뒤 실행한다. 같은 이름의 서버 ZIP이 이미 있으면 해시부터 확인하고 덮어쓰지 않는다.

```bash
scp -P 20522 -o ControlPath=/tmp/qwen38-slim-20522.sock \
  '/Users/chihun/Documents/ChatGPT/HOP_agent/말씨_학습_에이전트_인수인계_2026-10-09.zip' \
  slim@165.194.161.61:/home/slim/choieram/model_Training/말씨_학습_에이전트_인수인계_2026-10-09.zip
```

복구 ZIP은 **985,343,952 bytes**, SHA-256은 `18e5cffe5efa77e79c7aa56e739c52dfdf334af8aa9623f0b24743ead44f35ed`다. 약 19.11GB의 베이스 모델과 인증 정보는 ZIP에 없다. 새 README로 ZIP 내부 README를 덮어쓰면 패키지 무결성 검사가 실패하므로 이 문서는 실행 안내로 별도 보관한다.

## 4. 지문과 준비 상태 확인

새 서버 셸을 열 때마다 아래 작업 위치를 설정한다. 이후 `MALSSI_KIT`은 항상 이 경로다.

```bash
cd /home/slim/choieram || exit 1
set -euo pipefail
export MALSSI_KIT=/home/slim/choieram/model_Training/malssi_stage1_training_20261009
cd "$MALSSI_KIT"
PYTHONDONTWRITEBYTECODE=1 /home/slim/choieram/malssi-validation-20261009/.venv/bin/python - <<'PY'
from pathlib import Path
from counseling_pipeline.stage1_preparation import bindings, load_config, verify_bundle, read_rows, sha_file
kit = Path.cwd()
expected = {
    'dataset_sha256': 'fa7f2c09be9b2c7ffa3f10c360f9abe533302b9002c25396d7f59c1bc8f842f2',
    'config_sha256': 'a3982a83de30f81a333fb70b5c2894cc264496b61b99d3ce4eef307efd866a35',
    'model_sha256': '3834bee34ebfb601c03e1de0c19510aa969cb1087d9a1501434d1333fcfff1d5',
    'template_sha256': '845f1ee48e39fc942fe190da9df6a1c5db229e17a96ea08966ad1c9274e73d1b',
    'code_sha256': '75e813d39ba9c6acb04e7f79d0218778515093ae25c864856f693924abc7ef55',
    'environment_sha256': '984128ac0d5cfcf38652259d3a463ec63c86d56e2189a9012e3d2427e583b689',
}
verify_bundle(kit)
actual = bindings(kit, load_config(kit))
if actual != expected:
    raise SystemExit('기준 패키지와 binding 불일치. 원인을 확인하고 중단하세요.')
if sha_file(kit / 'run.sh') != 'e3090b8d1e71446b654d8996d27006f810460aba3da2a7a5dcccaecea573520d':
    raise SystemExit('run.sh 불일치')
rows, _ = read_rows(kit)
print('지문/데이터 확인:', {k: len(v) for k, v in rows.items()})
for name in ('work/canary_gate.json', 'work/training/RUN.json', 'work/COMPLETE.json'):
    print(name, (kit / name).exists())
PY
```

이 값들은 파일 자체 SHA와 정규화된 복합 binding을 구분한다. 예를 들어 `config_sha256`은 JSON 정규화 hash이며 `config/train.json`의 원시 파일 SHA와 같지 않다. 실제 환경·모델 파일은 다음 `prepare`가 다시 검사한다.

| 저장 증거상 완료 | 저장 증거상 아직 미실행 |
|---|---|
| 실제 tokenizer로 후보 17,236건 전체 재인코딩 | 실제 31B optimizer canary 및 PEFT 재개 |
| 서버 CPU 회귀 335개 통과, skip 0 | 본학습 1 epoch 및 전체 validation B0/B1 |
| 새 기준 GPU loss 비교 13개, hidden gradient 비교 4개 통과 | 보호자 지원 응답 품질·독립 test·다중 턴 평가 |
| 실제 생성 2건, adapter 불변 확인 | 서비스 배포 승인 |

최신 준비 증거의 실제 31B optimizer step은 **0회**다. 이전 서비스 문서의 “295개 검사·엄격 loss gate 실패”는 과거 기록이며, 새 기준 통과가 과거 실패를 지우는 것은 아니다. 새 loss 기준은 `bf16_linear_fp32_softcap_v1`, gradient 기준은 `hidden_gradient_bf16_v1`다. CPU 작은 모델의 재개 시험을 실제 31B 재개 성공으로 보고하지 않는다.

## 5. 실행 기록을 켜고 학습 시작

기존 실행기는 step loss·감독 token·gradient norm·LR·step wall time을 저장한다. 아래 외부 wrapper는 학습 코드를 변경하지 않고 **명령별 UTC 시각, 종료 코드, 콘솔 로그, 5초 간격 GPU 표본**을 추가한다. 모델·코드 지문을 바꾸지 않도록 wrapper는 `work/`에 둔다.

먼저 `work`의 실제 경로를 확인한 뒤 wrapper를 만든다. 기존 wrapper가 있으면 덮어쓰지 말고 내용을 확인해 사용한다.

```bash
cd /home/slim/choieram || exit 1
set -euo pipefail
cd "$MALSSI_KIT"
PYTHONDONTWRITEBYTECODE=1 /home/slim/choieram/malssi-validation-20261009/.venv/bin/python - <<'PY'
from pathlib import Path
from counseling_pipeline.stage1_preparation import beneath
p = beneath(Path('work/collection'), Path.cwd())
p.mkdir(parents=True, exist_ok=True)
PY

if [ -e "$MALSSI_KIT/work/run_with_metrics.sh" ]; then
  cat "$MALSSI_KIT/work/run_with_metrics.sh"
else
  (set -o noclobber; cat > "$MALSSI_KIT/work/run_with_metrics.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
MALSSI_KIT=/home/slim/choieram/model_Training/malssi_stage1_training_20261009
MALSSI_ACTION=${1:?prepare/start/resume/evaluate 필요}
case "$MALSSI_ACTION" in prepare|start|resume|evaluate) ;; *) exit 2;; esac
cd /home/slim/choieram
cd "$MALSSI_KIT"
export PYTHONDONTWRITEBYTECODE=1
MALSSI_SEGMENT="$(date -u +%Y%m%dT%H%M%SZ)-${MALSSI_ACTION}-$$"
MALSSI_OUT="$MALSSI_KIT/work/collection/$MALSSI_SEGMENT"
mkdir "$MALSSI_OUT"
malssi_event() {
  /home/slim/choieram/malssi-validation-20261009/.venv/bin/python - \
    "$MALSSI_OUT/events.jsonl" "$1" "$2" "$MALSSI_ACTION" "$MALSSI_SEGMENT" "${3:-}" <<'PY'
import datetime, json, sys, time
with open(sys.argv[1], 'a') as f:
    f.write(json.dumps({'event': sys.argv[2], 'exit_code': int(sys.argv[3]) if sys.argv[3] else None,
        'action': sys.argv[4], 'segment_id': sys.argv[5],
        'log_exit_code': int(sys.argv[6]) if sys.argv[6] else None,
        'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'monotonic_seconds': time.monotonic()}) + '\n')
PY
}
malssi_event start ''
nvidia-smi --id=GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c \
  --query-gpu=timestamp,uuid,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw \
  --format=csv -l 5 > "$MALSSI_OUT/gpu_samples.csv" 2> "$MALSSI_OUT/gpu_monitor.stderr" &
MALSSI_MONITOR_PID=$!
trap 'kill "$MALSSI_MONITOR_PID" 2>/dev/null || true; wait "$MALSSI_MONITOR_PID" 2>/dev/null || true' EXIT
set +e
bash "$MALSSI_KIT/run.sh" "$MALSSI_ACTION" 2>&1 | tee "$MALSSI_OUT/console.log"
MALSSI_PIPE=("${PIPESTATUS[@]}")
MALSSI_RC=${MALSSI_PIPE[0]}
MALSSI_LOG_RC=${MALSSI_PIPE[1]}
set -e
malssi_event end "$MALSSI_RC" "$MALSSI_LOG_RC"
if [ "$MALSSI_RC" -ne 0 ]; then exit "$MALSSI_RC"; fi
exit "$MALSSI_LOG_RC"
SH
  )
fi
```

먼저 준비 검사를 실행한다.

```bash
cd /home/slim/choieram && cd "$MALSSI_KIT" && \
bash work/run_with_metrics.sh prepare
```

`prepare`는 가중치를 업데이트하지 않는다. 전체 환경 freeze·모델 파일·token 계약을 검사하고, 캐시가 없으면 새로 토큰화한다. **기존 `work/qualification.json`이 있으면 저장 보고서의 binding·검사 기준을 검증해 재사용한다.** 없을 때만 GPU 수치·생성을 다시 실행한다. 재사용을 당일 새 GPU 수치검사로 보고하지 않는다.

준비가 통과하고 기존 본학습이 없으면 시작한다. SSH 종료 후에도 유지하려면 아래처럼 실행한다. 이미 가동 중인 같은 작업을 중복 실행하지 않는다.

```bash
cd /home/slim/choieram || exit 1
set -euo pipefail
cd "$MALSSI_KIT"
MALSSI_LAUNCH="work/collection/launcher-$(date -u +%Y%m%dT%H%M%SZ)-$$"
nohup bash work/run_with_metrics.sh start > "$MALSSI_LAUNCH.log" 2>&1 < /dev/null &
printf '%s\n' "$!" > "$MALSSI_LAUNCH.pid"
```

`nohup`의 PID 생성은 학습 성공을 뜻하지 않는다. `work/collection/`의 콘솔·이벤트·GPU CSV와 `work/logs/`, `work/training/train.jsonl`을 읽어 시작·진행·완료를 확인한다. 기존 tmux 세션 관리 방식을 사용할 때는 그 안에서 wrapper를 전경 실행해도 된다.

자동 순서는 **prepare → canary 2 step → 새 프로세스 canary 1 step → 초기 adapter의 검증 NLL → 초기 adapter에서 본학습 → 최종 NLL**이다. canary adapter를 본학습 초기값으로 사용하지 않는다.

## 6. 데이터·토크나이징·학습 방법

| 입력 파일 — kit 기준 | 행 수 | 역할 |
|---|---:|---|
| `data/train.jsonl.gz` | 15,512 | 유일한 본학습 입력 |
| `data/validation.jsonl.gz` | 1,724 | 학습 전후 검증 전용 |
| `data/expected_lengths.jsonl.gz` | 17,236 | 전수 길이·감독 위치 원장 |
| `source_reference/` | 원본 SFT 45,974행 / 1,069상담 | 참고·추적용, 자동 합치지 않음 |
| `analysis_only/sentence/` | 513,170문장 | 분석용 |
| `analysis_only/word/` | 4,496,325단어 등장 건 | 분석용, 고유 단어·모델 token 수가 아님 |

참고·보조 자료는 전체 ZIP에 포함돼 있으며 서버의 기존 경량 kit에는 없을 수 있다. 본학습에는 필요하지 않다. `verification_source`의 합성 fixture도 학습 정답이 아니다.

원본 45,974행에서 내용 노출 보류 1,261행을 제외한 44,713행 중, **전체 입력이 4,096 token 이내인 17,236행**을 사용한다. 기존 source group·상담 split을 유지하고 교차 중복을 검사한다. 관측 그룹을 확인된 실제 사람 수로 해석하지 않는다. 이 validation은 개발 검증셋이며 미사용 독립 test가 아니다.

토크나이징은 고정 Gemma native chat template와 실제 모델 tokenizer를 사용한다. `내담자→user`, `상담사→assistant`를 유지한다. 전체 대화 배열과 마지막 답변 직전 생성 prefix를 각각 인코딩하고 정확한 prefix 일치를 확인한다. **마지막 상담사 응답과 원래 종료 직렬화만 감독**하고 system·user·과거 assistant·오른쪽 padding의 labels는 `-100`이다. 이전 대화는 attention 문맥에 남긴다. packing·truncation·임의 요약·미래 발화 삽입은 하지 않는다. `enable_thinking=false`다.

| split | 입력 token 합 | 마지막 응답 감독 token 합 |
|---|---:|---:|
| Train | 30,666,067 | 1,077,219 |
| Validation | 3,486,856 | 123,191 |
| 합계 | 34,152,923 | 1,200,410 |

위 수치는 패키지의 전수 재인코딩 기록이다. 실제 실행의 `work/tokens/manifest.json`과 일치하는지 확인한다. 감독 비중은 약 3.51%이며 앞선 문맥도 계산하므로 연산 절감률을 뜻하지 않는다. validation의 목표 위치는 원문 앞 1/3에 87.88%가 집중되고 마지막 1/3은 0행이어서 후반 대화 일반화를 입증하지 못한다.

| 설정 | 고정값 |
|---|---|
| 기반 모델 / revision | Gemma 4 31B IT, `8e256fc6d63003fc0ca8c91b976e6dcc38433385` |
| 방법 | Unsloth 사전 양자화 4bit + BF16 계산 + QLoRA |
| LoRA | r=8, alpha=8, dropout=0; 언어 attention·MLP, 61,214,720 trainable parameters |
| 입력 / 배치 | 최대 4,096; microbatch 1 × accumulation 8 |
| 학습 | 1 epoch, optimizer step 1,939회, seed 3407 |
| optimizer | PyTorch AdamW, `foreach=False`, LR 2e-5, weight decay 0.01 |
| scheduler / clip | warmup 59 step(3% 올림) 후 cosine, gradient norm 1.0 |
| checkpoint / 평가 | 100 step마다 및 epoch 끝 저장; 전체 validation은 학습 전·후 2회 |
| 환경 | torch 2.13.0+cu126, transformers 5.17.0, unsloth/unsloth_zoo 2026.10.3, bitsandbytes 0.50.2, peft 0.21.2, triton 3.7.1 |

검증된 token 배열을 직접 받는 PyTorch 루프이며, Unsloth의 모델·gradient checkpointing·fused loss를 사용한다. 누적 window의 응답 token 수로 microbatch loss를 가중한다. `config/train.json`을 임의 변경하면 검증이 무효화된다. 모델·12B 전환·길이·batch 변경은 별도 패키지와 재검증이 필요하다.

코드의 scheduler상 첫 본학습 optimizer step LR은 0이다. 따라서 **optimizer step 1,939회**와 **실제 가중치가 달라진 횟수**를 같다고 보고하지 않는다. 설정은 재현 가능한 첫 실험이며 최적값 탐색 결과가 아니다.

## 7. 실패·재개 처리

| 상태 | 처리 |
|---|---|
| `work/COMPLETE.json` 있음 | 지문·최종 checkpoint·1,939 step·B0/B1을 검증하고 결과 반환; 다시 start하지 않음 |
| 본학습 중단 + 확정 `step-*` 있음 | 같은 경로에서 아래 `resume` 실행 |
| 본학습 첫 저장 이전 실패 | resume 불가. 실패 기록을 보존하고 원인 해결 후 새 실험 폴더에서 초기 시작 |
| canary 실패 | step-000000002와 `canary_execution.json` 등 필요한 증거가 완전한지 확인. 불완전하면 실패 폴더를 보존하고 새 실험으로 시작 |
| OOM·NaN/Inf·해시/환경/수치 불일치 | 해당 실행 중단·로그 보존·원인 확인. gate 우회나 조용한 설정 변경 금지 |
| GPU 점유 / 인증 만료 | 다른 작업을 종료하지 않음. GPU 가용 또는 사용자 직접 인증이 필요함을 보고 |

```bash
cd /home/slim/choieram && cd "$MALSSI_KIT" && \
bash work/run_with_metrics.sh resume
```

긴 재개도 5절 `nohup` 명령의 `start`를 `resume`으로 바꿔 실행할 수 있다. 새 실험이 필요하면 `model_Training` 아래 새 이름을 사용하고 wrapper·변수의 경로를 함께 맞춘다. **이미 시작한 run 폴더를 이동해서 재개하지 않는다.** `RUN.json`에 절대 경로가 고정돼 있다.

확정 checkpoint는 임시 `.writing-*` 폴더가 `step-*`로 rename된 것이다. `latest.json`만 보고 판단하지 않는다. adapter·optimizer·scheduler·Python/CPU/CUDA RNG·행 순서·cursor·파일 hash가 복원된다. canary 통과는 실제 저장과 새 프로세스의 추가 업데이트를 확인해야 한다.

완료 후 NLL 재계산만 필요할 때는 `bash work/run_with_metrics.sh evaluate`를 사용한다. 완료된 epoch가 필요하고, 기존 B1·COMPLETE를 다시 쓰므로 이전 평가 파일을 `work/collection` 안에 별도 보존한 뒤 실행한다.

## 8. 발표용으로 반드시 수집할 결과

### 자동 산출물과 이번 wrapper의 기록

| 경로 — kit 기준 | 보존할 내용 |
|---|---|
| `MANIFEST.json`, `config/`, `data/export_manifest.json` | 코드·모델·환경·데이터·설정의 근거 |
| `work/tokens/manifest.json` | 실제 행 수·입력/감독 token 합·캐시 hash |
| `work/qualification.json` | 사용한 비업데이트 수치·생성 검증과 기준 |
| `work/canary_gate.json`, `work/canary*_execution.json` | 3 step·저장/재개·adapter 변화, canary CUDA peak allocated/reserved GiB |
| `work/training/RUN.json`, `TRAINING_RESULT.json` | 고정 순서·설정·진행 cursor·완료 step |
| `work/training/train.jsonl` | step·감독 token·loss·gradient norm·LR·wall time |
| `work/training/checkpoints/step-*/CHECKPOINT.json` | checkpoint 파일별 SHA 및 adapter 지문 |
| `work/training/tokenizer/` | 저장된 tokenizer |
| `work/validation_B0.json`, `work/validation_B1.json` | 동일 validation의 전후 token 가중 평균 NLL |
| `work/COMPLETE.json` | 1단계 학습 완료 기록 |
| `work/collection/<segment>/`, `work/logs/` | 명령별 시작/종료·오류·콘솔·GPU 표본 |

완료 여부와 별도로 GPU CSV에 실제 행이 있고 `gpu_monitor.stderr`에 오류가 없는지 확인한다. 학습을 시작한 상태에서 wrapper를 뒤늦게 붙이면 시작 시점의 자료는 복원할 수 없다. 기록이 없으면 **미측정/null**로 둔다.

### 수치 계산 시 고정 규칙

- 이 패키지의 **B0=학습 전 NLL, B1=학습 후 NLL**이다. 발표에는 `base_untrained`, `stage1_sft`라는 명시적 이름을 함께 쓴다. 이전 수집 문서의 B0/B1/B2는 프롬프트·모델 조건 코드였으므로 그대로 섞지 않는다.
- NLL은 마지막 응답의 유효 shifted token 수로 가중한다. B0와 B1 모두 **1,724행 / 감독 token 123,191개**가 같은지 확인한다. `ΔNLL=B1−B0`; 감소율을 쓰면 `100×(B0−B1)/B0`와 분모를 함께 표시한다. 기존 분류 정확도와 생성 NLL을 같은 성능 지표로 비교하지 않는다.
- 마지막 epoch checkpoint를 이번 결과로 고정한다. 중간 NLL을 자동 평가하지 않으므로 best checkpoint 선정이나 100 step 간격 validation 곡선이 있다고 주장하지 않는다.
- `train.jsonl`은 재개 시 append된다. 미저장 step을 재실행하면 같은 step이 중복된다. **최종 checkpoint에 이어지는 성공 경로의 step**과 **중단·재실행 비용**을 분리하고, 세그먼트 콘솔·체크포인트 cursor로 대조한다. 무조건 합산하거나 근거 없이 중복 줄을 삭제하지 않는다.
- `target_mean_loss`는 해당 누적 window의 token 가중 loss다. `learning_rates`는 scheduler 갱신 후 다음 step용 값이다. `elapsed_seconds`는 저장 시간 제외·명시 CUDA synchronize 없는 wall time이므로 정밀 GPU 처리 시간으로 이름 붙이지 않는다.
- GPU CSV의 최대 `memory.used`는 **5초 표본의 장치 메모리 최대값**이다. PyTorch peak allocated/reserved와 다르며 순간 peak를 놓칠 수 있다. 이 wrapper는 본학습의 정확한 PyTorch peak를 측정하지 않는다.
- wrapper 전체 시간에는 prepare·모델 로드·canary·B0/B1·저장 등이 포함된다. 순수 학습 시간·종단 시간·재시도 비용의 분모를 구분한다. 이전 약 17시간 추정은 실측값으로 쓰지 않는다.
- 정밀 step GPU timing·본학습 allocator peak·모든 실패 attempt의 구조화 행은 현재 코드에 없다. 필요하면 **학습 전에** 별도 계측 버전을 만들어 코드 binding·수치·canary를 재검증한다. 기존 통과 보고서에 변경 코드를 끼워 넣지 않는다.

### 기반 모델과 응답 품질 비교 — 후속 평가의 수집 계약

현재 자동 실행은 NLL 비교까지다. 실제 응답 품질을 비교할 때는 같은 기반 모델과 이번 adapter에 **동일 prompt·사례 ID·tokenizer·context·출력 예약·decoding·seed**를 적용한다. 미학습 모델을 별도로 다시 로드해 비교할 수 있도록 원본 모델 지문을 보존한다. 미실행 생성·사람 평가는 완료로 채우지 않는다.

1. 생성 전 `work/collection/evaluation_plan.json`에 사례·분할·출처 그룹·prompt hash·checkpoint 선택·max_new_tokens·seed·평가 기준과 적용 대상을 고정한다. 검증 공통 ID 1,335건(`data/common_profile_ids.json`)은 개발 비교용이며 독립 test가 아니다.
2. 생성 시 `generations.jsonl`에 모든 시도와 오류를 남긴다: model/checkpoint·case/group·input hash·실제 입력/생성 token·전체 latency·종료 사유. 비공개 원장에는 실제 prefill/suffix token IDs·응답·최종 적용 generation config·override를 보존한다. 강제 EOS·길이 소진·자연 종료·의미적 완결을 구분한다. 첫 token을 실제 관측하지 않았다면 TTFT는 null이다.
3. `reviews.jsonl`에는 응답 hash·검토자 ID/사람·전문가·AI 구분·rubric hash·판정 근거를 기록한다. 기준은 요청 해결, 구체적 지원 행동, 인물/근거 보존, 질문 필요성, 거절/정정 반영, 안전, 의미적 완결이다. 모델 이름을 가리고 실제 검토한 결과만 기록한다.
4. 결과를 pass/fail/uncertain/미검토로 나눈다. 사전 비적용 사례만 분모에서 제외한다. 통과율은 확정 pass/사전 적용 전체 사례로 표시하고 검토 완료율·실패·미확정을 함께 낸다. 모델 차이는 percentage point로 표기한다. 그룹 단위 paired 비교와 학습 seed 반복 여부를 명시한다.
5. 원문 응답 재현과 가족·주변인 지원을 구분한다. 미사용 최종 test와 모델 응답이 누적되는 다중 턴 평가는 별도 진행하며, 학습 loss 감소로 대체하지 않는다.

## 9. 완료 후 사용자에게 반환

새 작업 루트 안의 `work/collection/RESULTS.md`에 다음을 정리한다.

- run/segment ID, 실제 실행 경로, 모델·환경·코드·데이터 지문, 사용 GPU UUID.
- canary 3 step 결과와 본학습 완료 여부, optimizer step·cursor·마지막 checkpoint 절대 경로와 SHA.
- 실제 데이터 행·입력/감독 token 수, 토큰 마스크·학습 방법·설정.
- B0/B1 NLL·차이, 측정 시간의 범위, GPU 표본 최대값과 canary allocator peak.
- 재개·중복 step·OOM·오류·측정 누락, 행동 평가의 실행/미실행 상태.

발표 분석용 묶음에는 위 결과 문서, 설정·manifest·qualification/canary 결과, 학습 JSONL, B0/B1, COMPLETE, 세그먼트 이벤트·GPU CSV, checkpoint manifest를 넣는다. **가중치·optimizer state·원문 상담·원시 token ID·비밀번호는 발표용 묶음에 넣지 않는다.** 전체 checkpoint와 비공개 원장은 서버에 보존하고 위치·hash로 연결한다. 콘솔을 외부 전달할 때는 원문 노출 여부를 먼저 확인한다.

완료 보고는 “1단계 원문 상담 응답 SFT 완료”로 표현한다. HOP 행동 평가가 끝나지 않았다면 `hop_deployment_ready=false`를 유지한다. 수집 결과를 사용자에게 돌려주면 이를 바탕으로 대회용 표·차트·모델 비교 수치를 만들 수 있다.

## 10. 통합 근거와 문서 우선순위

이 README는 로컬의 `00_에이전트_인수인계.md`, `01_다음에이전트에게_전달할요청.md`, `Gemma_서버접속_작업규칙_레퍼런스.md`, `서비스_문서/`, `outputs/training_collection_20261009/`, 학습 인수인계 ZIP을 통합했다. 실행 명령·설정은 ZIP의 `run.sh`, `scripts/malssi_stage1.py`, `counseling_pipeline/stage1_*.py`와 대조했다.

현재 실행은 **사용자의 최신 요청과 원격 적용 규칙 → 실제 코드/설정과 현재 검사 → 최신 저장 증거 → 과거 문서** 순서로 판단한다. 이번 작업 폴더는 사용자가 지정한 `model_Training`이 우선한다. 오래된 manifest의 `model_training_authorized:false`나 과거 실패 기록은 당시의 상태로 보존하며 값을 수정해 통과를 만들지 않는다. 다른 문서를 순서대로 읽어야만 실행할 수 있도록 의존시키지 않았으며, 원본 문서는 변경 이력의 근거로 남긴다.
