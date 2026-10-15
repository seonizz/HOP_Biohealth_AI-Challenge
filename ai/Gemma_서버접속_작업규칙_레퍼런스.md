# Gemma 작업용 서버 접속·작업 규칙 레퍼런스

원격 규칙 확인: 2026-10-09. 로컬 문서 갱신: 2026-10-10 (한국 시간). 이번 문서 정리에서 원격 규칙을 다시 조회하지 않았습니다.

이 문서는 다음 Codex 채팅에서 서버 접속과 작업 범위를 전달하기 위한 레퍼런스다. 이 문서 자체는 학습, 패키지 설치, 모델 로딩, 프로세스 종료를 지시하지 않는다. 실제 작업은 해당 채팅의 사용자 요청 범위에서만 수행한다.

## 1. 접속 대상과 기존 인증 세션

| 항목 | 설정 |
| --- | --- |
| 서버 | `165.194.161.61` |
| SSH 포트 | `20522` |
| 계정 | `slim` |
| 인증 | 비밀번호. 사용자가 로컬 Terminal에서 직접 입력 |
| 기존 SSH ControlPath | `/tmp/qwen38-slim-20522.sock` |
| 기존 로컬 포워딩 | `8888 → 서버 127.0.0.1:8888` |
| 학습 모델 API 포워딩 | `18080 → 서버 127.0.0.1:18080` — [연결 안내](trained_model_api/LOCAL_USAGE_REFERENCE.md) |
| 허용된 서버 작업 루트 | `/home/slim/choieram` |

이전 채팅에서 만든 인증 세션을 재사용한다. 소켓 이름에 `qwen38`이 들어 있어도 같은 서버 접속이므로 Gemma 작업에 사용할 수 있다. 도구의 숫자형 실행 세션 ID보다 **ControlPath**를 접속 기준으로 사용한다. 소켓은 임시 연결 정보이며, 종료·재부팅 이후에도 유효하다고 가정하지 않는다.

로컬에서 기존 연결 확인:

```bash
ssh -S /tmp/qwen38-slim-20522.sock -p 20522 \
  -O check slim@165.194.161.61
```

기존 인증 연결을 이용한 읽기 전용 확인:

```bash
ssh -S /tmp/qwen38-slim-20522.sock -p 20522 \
  -o BatchMode=yes -o ConnectTimeout=10 slim@165.194.161.61 \
  'cd /home/slim/choieram && pwd && cat AGENTS.md'
```

연결이 없으면 사용자가 비밀번호를 직접 입력할 수 있는 로컬 Terminal에서 새로 접속한다. 먼저 기존 터널·소켓이 남아 있는지 확인하고, 살아 있는 연결을 덮어쓰거나 종료하지 않는다.

```bash
ssh -p 20522 \
  -o ControlMaster=yes \
  -o ControlPath=/tmp/qwen38-slim-20522.sock \
  -o ControlPersist=600 \
  -L 8888:127.0.0.1:8888 slim@165.194.161.61
```

- 비밀번호를 채팅, Markdown, 스크립트, 명령 인자, 로그에 저장하지 않는다.
- 기존 `8888` 터널을 유지한다. 포트 충돌 시 기존 연결을 종료하거나 같은 포워딩을 중복 생성하지 않는다.
- `8888`은 기존 앱이 사용할 수 있으므로 새 Jupyter/학습 UI가 자동으로 점유하지 않도록 확인한다.
- 원격 규칙에 로컬 SSH 별칭 `choieram-model`과 래퍼 `choieram-ssh`가 기록돼 있다. 로컬 설치 여부를 먼저 확인해야 하며, 래퍼 사용도 아래 경로 제한을 대체하지 않는다.

## 2. 작업 경로와 환경 격리

**서버에서 쓰기 작업이 허용된 범위는 `/home/slim/choieram`과 그 하위뿐이다.** 로컬 문서·코드 작업은 `/Volumes/Dev/HOP_Projet/말씨/ai`에서 허용돼 있다. 서버 경로 제한을 로컬 폴더에 적용하지 않는다.

- 모든 원격 개발 명령은 `cd /home/slim/choieram`으로 시작한다. 이동에 실패하면 뒤 명령을 실행하지 않도록 `&&`를 사용한다.
- 작업 전에 원격 `/home/slim/choieram/AGENTS.md`를 다시 읽는다. 해당 하위 폴더의 `AGENTS.md`도 확인한다. 서버 규칙은 이 문서 작성 이후 바뀔 수 있다.
- 파일 작업 전 실제 경로를 확인한다. 심볼릭 링크가 허용 루트 밖을 가리키면 그 링크를 통해 쓰지 않는다.
- 코드, 가상환경, 데이터, 체크포인트, 로그, 캐시, 임시 파일을 모두 허용 루트 안에 둔다.
- 서버 홈의 `.ssh`, `.bashrc`, `.profile`, `.codex`와 다른 사용자 폴더를 수정하지 않는다.
- 시스템·공유 환경에 패키지를 설치하거나 기존 환경을 업그레이드하지 않는다. 추후 설치가 요청되면 허용 루트 안의 전용 가상환경을 사용한다.
- 현재 API 폴더는 `/home/slim/choieram/model_Training/trained_model_api`다. 학습 kit와 체크포인트 경로는 [당시 인수인계](../archive/08_문서통합_원문/ai/00_에이전트_인수인계.md)를 따른다. 새로운 작업이 필요하면 별도 폴더를 사용하고 기존 폴더를 지우거나 재생성하지 않는다.

추후 환경 생성·학습이 요청될 때 적용할 캐시 위치 예시:

```bash
cd /home/slim/choieram && \
export HF_HOME=/home/slim/choieram/.cache/huggingface \
       XDG_CACHE_HOME=/home/slim/choieram/.cache \
       TORCH_HOME=/home/slim/choieram/.cache/torch \
       TRITON_CACHE_DIR=/home/slim/choieram/.cache/triton \
       TORCHINDUCTOR_CACHE_DIR=/home/slim/choieram/.cache/torchinductor \
       PIP_CACHE_DIR=/home/slim/choieram/.cache/pip \
       TMPDIR=/home/slim/choieram/.tmp \
       PYTHONDONTWRITEBYTECODE=1
```

위 경로는 실제 경로와 기존 파일을 확인한 후 사용한다. 필요한 디렉터리가 없으면 허용 루트 안에만 생성한다. 실행 로그·출력 경로도 명시적으로 지정한다.

## 3. 금지 사항과 기존 작업 보호

다음 작업은 수행하지 않는다.

- 서버 **재부팅, 리셋, 종료, 초기화**: `reboot`, `shutdown`, `poweroff`, `init 6` 및 동등한 동작.
- **GPU 리셋**, 드라이버·CUDA 교체, 시스템 서비스 재시작, 관리자 권한을 이용한 시스템 변경.
- 환경 초기화·재초기화, 기존 가상환경 삭제·재생성, `conda init`.
- `git reset`, `git clean`, 재귀 강제 삭제, 파괴적 정리, `systemd-run`.
- GPU 메모리를 확보하려고 다른 채팅·사용자·서비스의 프로세스를 임의로 종료하거나 일시 정지하는 작업. `killall`·광범위한 `pkill`도 사용하지 않는다.
- 기존 SSH 연결·터널 종료, 인증 설정 변경, 비밀번호 저장.
- 기존 노트북, 데이터셋, 모델, 체크포인트, 환경의 삭제·이동·덮어쓰기.

GPU가 점유돼 있으면 프로세스 소유자·명령·작업 경로를 읽기 전용으로 확인한다. 사용자의 명시적 요청 없이 기존 작업을 중단하지 않는다. OOM이 나면 자신이 실행한 학습의 배치·문맥 길이 등을 낮추거나 안전하게 종료한다. 서버나 GPU를 리셋하지 않는다.

## 4. 서버 폴더 구분

2026-10-09 확인한 원격 규칙에 따르면:

- 기존 `models`, `venvs`, `counselor_analysis`, 캐시, 복구 작업, 노트북은 현재 위치를 유지한다. `ys`로 옮기지 않는다.
- HOP 백엔드가 만든 파일만 `/home/slim/choieram/ys` 아래에 둔다.
- 백엔드 API·PostgreSQL 경로는 `/home/slim/choieram/ys/hop_node_20261009`다.
- 백엔드 모델 서빙 산출물 경로는 `/home/slim/choieram/ys/hop-serving`이다. 원격 규칙에는 이 서비스들을 정지 상태로 유지하도록 기록돼 있다. 임의로 기동하지 않는다.
- 백엔드 작업에는 `ys/AGENTS.md`를 추가로 읽는다. Gemma 학습 작업을 백엔드 작업으로 간주해 `ys`로 이동하지 않는다.
- 기존 `/home/slim/choieram/models`는 다른 작업도 사용한다. Gemma 원본 체크포인트는 읽기용으로 보존하고, 추후 LoRA 어댑터·학습 로그는 전용 학습 폴더에 저장한다.
- 새로운 모델 추론·다운로드·빌드·패키지 설치·학습은 해당 작업을 요청받았을 때만 수행한다.

## 5. Gemma 모델 위치와 다운로드 이력

| 항목 | 값 |
| --- | --- |
| 체크포인트 | `unsloth/gemma-4-31B-it-unsloth-bnb-4bit` |
| 서버 모델 경로 | `/home/slim/choieram/models/gemma-4-31B-it-unsloth-bnb-4bit` |
| 다운로드 상태 파일 | `/home/slim/choieram/models/gemma-4-31B-it-unsloth-bnb-4bit.download-status.json` |
| 다운로드 로그 | `/home/slim/choieram/models/gemma-4-31B-it-unsloth-bnb-4bit.download.log` |
| 고정 리비전 | `8e256fc6d63003fc0ca8c91b976e6dcc38433385` |
| 확인된 상태 | 다운로드 완료, 13/13 파일 검증 완료 |
| 총 파일 용량 | `19,114,388,791` bytes (약 19.11GB) |

위 표는 2026-10-09 다운로드 확인 기록이다. 이후 100 step 학습·중단과 별도 128K API 실측을 완료했으며 [당시 인수인계](../archive/08_문서통합_원문/ai/00_에이전트_인수인계.md)와 [용량 검증 보고서](trained_model_api/CAPACITY_REPORT.md)에 근거가 있다. API는 두 RTX 4090에 모델 층을 나누어 실행한다. `ys`의 정지된 기존 서비스와 별개이며, 이 문서만으로 학습을 재개하지 않는다.

학습 전 읽기 전용 GPU 확인 예시:

```bash
ssh -S /tmp/qwen38-slim-20522.sock -p 20522 \
  -o BatchMode=yes slim@165.194.161.61 \
  'cd /home/slim/choieram && nvidia-smi'
```

GPU는 RTX 4090 두 장으로 확인했으나, 여유 VRAM과 실행 프로세스는 매번 확인한다. 두 장의 VRAM이 자동으로 하나의 메모리처럼 합쳐진다고 가정하지 않는다.

## 6. 다음 채팅에 전달할 접속 지시문

> 서버는 slim@165.194.161.61:20522이고, 기존 인증 SSH ControlPath는 /tmp/qwen38-slim-20522.sock이다. 먼저 연결을 확인하고 같은 세션을 재사용해라. 비밀번호는 저장하지 말고 인증이 필요하면 사용자가 Terminal에 직접 입력하도록 해라. 모든 원격 개발 명령은 cd /home/slim/choieram으로 시작하고, 서버 AGENTS.md와 작업 하위 폴더 규칙을 다시 읽어라. 모든 파일·환경·캐시·임시 파일·로그·체크포인트는 이 루트 안에서만 다뤄라. 서버 재부팅·종료·리셋·초기화, GPU 리셋, 시스템 변경, 기존 환경 초기화, 파괴적 삭제를 금지한다. 다른 프로세스나 기존 SSH 터널을 임의로 중단하지 마라. Gemma 모델은 /home/slim/choieram/models/gemma-4-31B-it-unsloth-bnb-4bit에 있고 원본을 보존해라. 새 학습 산출물은 별도 작업 폴더에 저장해라. 학습을 요청받았을 때만 GPU 점유·라이브러리 호환성·데이터·설정을 확인한 뒤 실행해라. 이 접속 레퍼런스를 받았다는 이유만으로 학습이나 설치를 시작하지 마라.
