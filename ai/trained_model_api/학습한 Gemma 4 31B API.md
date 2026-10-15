# 학습한 Gemma 4 31B API

100 step 학습한 LoRA 체크포인트를 두 RTX 4090에서 읽어 텍스트 채팅 API로 제공합니다. 학습은 중단돼 있으며 API가 optimizer 상태를 읽거나 학습을 재개하지 않습니다. 기준일은 2026-10-10입니다.

**호출하려면 [로컬 이용 안내](LOCAL_USAGE_REFERENCE.md), 실측 결과는 [용량 검증 보고서](CAPACITY_REPORT.md)를 읽습니다.** 이 문서는 서버 운영과 코드 구성을 다룹니다.

## 운영 설정

[config.json](config.json)이 모델 경로·체크포인트·포트·토큰 한도의 기준입니다.

| 항목 | 설정 |
| --- | --- |
| 모델 ID | `malssi-gemma4-31b-step100` |
| 서버 바인딩 | `127.0.0.1:18080` |
| 채팅 경로 | `/v1/chat/completions` |
| 상태·모델 목록 | `/healthz`, `/v1/models` — 모두 Bearer 인증 필요 |
| 합산 문맥 예산 | 입력 + 요청한 `max_tokens` ≤ 131,072 |
| 출력 예약 | 기본 256, 설정 상한 131,071. 실제 허용량은 남은 문맥 예산에 따름 |
| 입력 처리 | 4,096토큰 분할, 요청마다 새 DynamicCache, global attention KV 그룹별 처리 |
| 동시 처리 | 한 번에 추론 요청 1개, 추가 요청은 HTTP 429 |

최대 입력 요청은 실제 HTTP에서 통과했습니다. 최대 길이 출력 완주·128K 장문 이해 품질·전체 학습 완료를 의미하지 않습니다. 세부 측정과 과거 실패는 용량 검증 보고서에 남겼습니다.

## 서버 실행

서버 API 위치는 `/home/slim/choieram/model_Training/trained_model_api`입니다. 로컬 폴더는 코드·호출 도구·문서 사본입니다. 원격 작업 전 [서버 작업 규칙](../Gemma_서버접속_작업규칙_레퍼런스.md)과 해당 서버의 `AGENTS.md`를 확인합니다.

API가 종료돼 있고 지정 GPU를 사용할 수 있을 때, Mac의 별도 터미널에서 실행합니다. 이미 실행 중인 API를 중복 실행하지 않습니다.

```bash
ssh -S /tmp/qwen38-slim-20522.sock -p 20522 \
  slim@165.194.161.61 \
  'cd /home/slim/choieram && bash model_Training/trained_model_api/run_server.sh'
```

포그라운드 실행이므로 해당 터미널에서 `Ctrl+C`로 종료할 수 있습니다. 서버 재부팅 후 자동 시작하는 서비스는 설치하지 않았습니다. 두 GPU에 모델 층을 나눠 배치하고, 기존 학습기와 같은 GPU 잠금을 사용합니다. 다른 프로세스를 자동으로 종료하지 않습니다.

시작 시 기본 모델·환경·체크포인트 해시를 검사하고 모델을 로딩합니다. API 키가 없으면 비공개 키를 생성합니다. 캐시·임시 파일·API 키·실행 상태는 API의 `runtime/` 아래에 둡니다. 모델과 환경은 기존 위치에서 읽습니다.

| 읽기 대상 | 서버 경로 |
| --- | --- |
| 기본 모델 | `/home/slim/choieram/models/gemma-4-31B-it-unsloth-bnb-4bit` |
| LoRA | `/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009/training_kit/work/training/checkpoints/step-000000100` |
| Python | `/home/slim/choieram/malssi-validation-20261009/.venv/bin/python` |

## 상태와 로그

실제 응답 가능 여부는 [인증된 상태 확인 요청](LOCAL_USAGE_REFERENCE.md#5-연결-상태-확인)으로 판단합니다. 상태 파일만으로 현재 실행 중이라고 단정하지 않습니다.

| 서버 파일 | 용도 |
| --- | --- |
| `runtime/status.json` | 마지막 readiness·PID·체크포인트 기록 |
| `runtime/latest_launch.json` | 최근 백그라운드 실행의 `pid`와 `log` 경로 |
| `runtime/request_timings.jsonl` | 요청별 입력 대화·생성 답변·입출력 시각·처리 시간 |
| `runtime/api_key` | 비공개 인증 키. 문서·저장소·로그에 복사하지 않음 |

`latest_launch.json`은 로그 본문이 아닙니다. 그 안의 `log` 경로를 확인하며, `server.log` 같은 고정 이름을 현재 로그로 가정하지 않습니다.

사용자 요청에 따라 채팅 API의 입력·출력은 별도 `runtime/request_timings.jsonl`에 기록합니다. `received`, `input`, `completed` 이벤트를 같은 `request_id`로 연결합니다. `input`에는 인증·검증을 통과한 전체 `messages`와 생성 옵션, `completed`에는 실제 생성된 `output`, HTTP 상태와 전송 완료 여부, 입력·출력 토큰 수를 저장합니다. 인증 키·헤더·임의 예외 메시지는 저장하지 않습니다. 상태 확인 요청은 이 파일에 기록하지 않습니다.

`received_at`은 요청 처리 시작, `input_received_at`은 본문 수신 완료, `inference_started_at`과 `inference_finished_at`은 모델 처리 시작·완료, `completed_at`은 응답 전송 처리 종료 시각입니다. 시각은 한국 시간(`+09:00`)이며, `elapsed_seconds`와 `inference_elapsed_seconds`는 단조 시계로 측정한 전체 처리 시간과 모델 처리 시간입니다. 클라이언트 화면에 표시되는 시각까지 측정한 값은 아닙니다. 실패·인증 오류·동시 요청 거절도 시작·완료 이벤트를 남깁니다. 실패 요청에는 생성 답변이 없을 수 있습니다.

로그 권한은 `600`이며, 파일당 10 MiB를 넘으면 회전하고 이전 파일은 3개까지 보존합니다. 로그는 `runtime/` 아래에만 저장하고 Git에는 포함하지 않습니다. 과거에 저장하지 않은 대화는 복원하지 않습니다.

서버에서 최근 입출력을 확인하는 명령입니다.

```bash
cd /home/slim/choieram && tail -n 9 model_Training/trained_model_api/runtime/request_timings.jsonl
```

## 코드와 검증 파일

| 파일 | 역할 |
| --- | --- |
| [server.py](server.py) | HTTP·인증·입력 계약·단일 추론 요청 처리 |
| [backend.py](backend.py), [grouped_attention.py](grouped_attention.py) | 모델 무결성·로딩·분할 입력·생성 |
| [client.py](client.py), [connect.py](connect.py) | 로컬 호출과 SSH 터널·키 연결 |
| [run_server.sh](run_server.sh) | 기존 서버 환경으로 API 실행 |
| [test_api.py](test_api.py) | CPU API 계약·오류·동시성·체크포인트 변조 방지 검사 |
| [verify_api.py](verify_api.py) | 실제 모델 기본 대화·오류 응답 검증 |
| [verify_prefill.py](verify_prefill.py), [verify_token_limits.py](verify_token_limits.py) | 장문 응답 비교와 실제 HTTP 용량 측정 |

로컬 CPU 계약 검사 명령입니다. 실제 GPU 용량 검사를 실행하지 않습니다.

```bash
cd /Volumes/Dev/HOP_Projet/말씨/ai
python3 -m unittest discover -s trained_model_api -p 'test_*.py' -v
```

저장된 GPU 결과와 검증 범위는 [용량 검증 보고서](CAPACITY_REPORT.md)에서 확인합니다. 코드·설정 변경으로 필요해진 검사만 다시 수행합니다.
