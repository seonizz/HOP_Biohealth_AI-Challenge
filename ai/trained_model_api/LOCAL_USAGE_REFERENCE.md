# 학습 모델 로컬 API 이용 레퍼런스

2026-10-17의 **v11 로컬 시연 실행 경로**는 [현재 입출력 한도와 검증](LIVE_TOKEN_BUDGET.md)을 따른다. 입력 최대 65,536·출력 예약 최대 8,192·합산 69,632이며, 아래 step100의 과거 출력 4,096 기록과 구분한다.

2026-10-18부터 Python 클라이언트는 `--model` 또는 `MALSSI_MODEL`로 모델을 선택한다. 현재 v11 API를 호출할 때는 `--model malssi-gemma4-31b-v11-epoch3`를 지정한다. Python 함수에서도 `chat(messages, model="malssi-gemma4-31b-v11-epoch3", ...)`로 선택한다. 명시 인자, `MALSSI_MODEL`, 기존 step100 기본값 순서로 적용한다. 이 선택은 실행 중인 모델·체크포인트를 교체하지 않는다. 연결 주소와 인증은 해당 실행의 설정을 사용하며, 클라이언트는 HTTP 리다이렉트로 인증 키나 대화 내용을 다른 주소에 보내지 않는다.

Mac의 로컬 프로그램에서 **100 step 학습한 Gemma 4 31B 모델**을 호출하는 방법입니다. 모델 계산은 원격 서버의 두 RTX 4090에서 실행하고, Mac은 SSH 터널을 통해 `localhost` API를 사용합니다. Mac에 모델이나 CUDA를 설치할 필요는 없습니다.

```text
로컬 Python·앱 → http://127.0.0.1:18080/v1 → SSH 터널 → 서버의 학습 모델
```

## 1. 복사해서 바로 실행

Mac 터미널에서 실행합니다.

```bash
cd /Volumes/Dev/HOP_Projet/말씨/ai

# SSH 터널 연결 및 API 인증 키 준비
python3 trained_model_api/connect.py

# 학습한 모델에 요청
python3 trained_model_api/client.py "안녕하세요. 짧게 인사해 주세요."

# 응답 본문·모델 이름·토큰 사용량까지 확인
python3 trained_model_api/client.py --max-tokens 128 --json "대화를 시작하기 좋은 질문을 하나 제안해 주세요."
```

`connect.py`가 `"status": "ready"`를 반환하면 연결된 상태입니다. 클라이언트는 Python 표준 라이브러리만 사용하므로 추가 패키지 설치가 필요 없습니다. SSH 연결이 유지되는 동안 요청마다 `connect.py`를 다시 실행할 필요는 없습니다.

## 2. 로컬 앱에 입력할 설정

| 항목 | 값 |
| --- | --- |
| Base URL | `http://127.0.0.1:18080/v1` |
| 채팅 요청 주소 | `http://127.0.0.1:18080/v1/chat/completions` |
| Model | `malssi-gemma4-31b-step100` |
| 인증 헤더 | `Authorization: Bearer <API_KEY>` |
| API 키 파일 | `/Volumes/Dev/HOP_Projet/말씨/ai/trained_model_api/runtime/api_key` |
| 스트리밍 | 끄기: `stream: false` |
| 기본 출력 예약 | `max_tokens: 256` |
| 기본 temperature | `0` — 동일 입력의 반복 비교에 사용 |
| 클라이언트 기본 timeout | 1,800초 |

앱이 Base URL을 요구하면 `/v1`까지 입력합니다. 전체 요청 주소를 요구하면 `/v1/chat/completions`까지 입력합니다. OpenAI 형태의 텍스트 채팅 요청·응답을 지원하며, Responses API·도구 호출·이미지·스트리밍은 지원하지 않습니다.

키가 필요한 로컬 앱에는 위 비공개 키 파일의 값을 넣습니다. 문서나 저장소에 키를 복사하지 않습니다. 이 API의 모델 ID와 키는 기존 `local_api` 폴더의 Ollama 12B API와 별개입니다.

환경변수를 받는 로컬 앱 또는 셸에서는 다음처럼 설정할 수 있습니다.

```bash
export MALSSI_BASE_URL="http://127.0.0.1:18080/v1"
export MALSSI_API_KEY="$(cat /Volumes/Dev/HOP_Projet/말씨/ai/trained_model_api/runtime/api_key)"
```

`client.py` CLI는 `MALSSI_BASE_URL`, `MALSSI_API_KEY`, `MALSSI_MODEL`을 읽습니다. 아래 Python `chat()` 함수에서는 다른 주소가 필요할 때 `base_url=`을 직접 지정합니다. 모델을 지정하지 않은 기존 호출은 100 step 모델을 유지합니다.

### 토큰 예산

입력 토큰에는 채팅 템플릿과 대화 이력이 포함됩니다. 현재 서버는 **입력 ≤ 65,536**, **`max_tokens` ≤ 4,096**, **입력 + `max_tokens` ≤ 69,632**를 적용합니다. 기본 출력 예약은 256입니다. 앞서 논의한 합산 65,536 계획과 현재 서버 정책은 다르며, 추론 속도 수정에서는 이 정책을 변경하지 않았습니다.

| 출력 예약 `max_tokens` | 허용 입력 토큰 |
| ---: | ---: |
| 1 | 65,536 |
| 256 (기본값) | 65,536 |
| 4,096 | 65,536 |

출력 예약을 늘리는 예: `python3 trained_model_api/client.py --max-tokens 4096 "요청 내용"`. Python에서는 `chat(messages, max_tokens=4096)`을 사용합니다. 예약은 강제 출력 길이가 아니며, 서버의 모델 실행 제한 시간 안에 종료될 수 있습니다. 4,096토큰 전체 생성 성공을 보장하는 설정은 아닙니다.

최대 입력 실측과 출력 검증 범위는 [용량 검증 보고서](CAPACITY_REPORT.md)에 있습니다. 최대 출력 예약의 수락은 그 길이만큼 실제 생성했다는 뜻이 아닙니다.

## 3. 다른 Python 프로젝트에서 호출

현재 작업 폴더와 관계없이 실행할 수 있는 예제입니다. 키는 `client.py`가 비공개 파일에서 자동으로 읽습니다.

```python
import sys

sys.path.insert(0, "/Volumes/Dev/HOP_Projet/말씨/ai")
from trained_model_api.client import chat

messages = [
    {"role": "system", "content": "한국어로 간결하게 답하세요."},
    {"role": "user", "content": "대화를 시작하기 좋은 질문을 하나 제안해 주세요."},
]

result = chat(
    messages,
    base_url="http://127.0.0.1:18080/v1",
    max_tokens=128,
    temperature=0,
    timeout=1800,
)

answer = result["choices"][0]["message"]["content"]
print(answer)
print(result["model"])
print(result["usage"])
```

이 문서의 `/v1/chat/completions` 호출은 요청 사이에 KV 캐시를 재사용하지 않습니다. 대화를 이어갈 때는 이전 대화와 답변을 함께 전달합니다. 서버의 별도 `/v1/sessions` 기능과 구분합니다.

```python
messages.append({"role": "assistant", "content": answer})
messages.append({"role": "user", "content": "그 질문을 조금 더 부드럽게 바꿔 주세요."})

result = chat(messages, max_tokens=128)
print(result["choices"][0]["message"]["content"])
```

## 4. curl로 호출

먼저 2절의 환경변수를 설정합니다.

```bash
curl --fail-with-body "$MALSSI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $MALSSI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "malssi-gemma4-31b-step100",
    "messages": [{"role": "user", "content": "안녕하세요"}],
    "max_tokens": 128,
    "temperature": 0,
    "stream": false
  }'
```

응답에서 읽을 필드:

| JSON 경로 | 의미 |
| --- | --- |
| `choices[0].message.content` | 생성된 답변 |
| `choices[0].finish_reason` | `stop`: 종료 토큰으로 끝남, `length`: 출력 예산 도달 |
| `model` | 응답한 모델 ID |
| `system_fingerprint` | 체크포인트 식별자 |
| `usage.prompt_tokens` | 채팅 템플릿을 포함한 입력 토큰 수 |
| `usage.completion_tokens` | 실제 생성 토큰 수 |
| `usage.total_tokens` | 입력·생성 토큰 합계 |

`finish_reason: stop`은 답변 내용의 완결성이나 품질을 보증하지 않습니다.

## 5. 연결 상태 확인

2절의 환경변수를 설정한 뒤 실행합니다. 상태 확인과 모델 목록 조회도 인증이 필요합니다.

```bash
curl --fail-with-body http://127.0.0.1:18080/healthz \
  -H "Authorization: Bearer $MALSSI_API_KEY"

curl --fail-with-body "$MALSSI_BASE_URL/models" \
  -H "Authorization: Bearer $MALSSI_API_KEY"
```

정상 상태의 주요 값은 `status: ready`, `model: malssi-gemma4-31b-step100`, `checkpoint_step: 100`입니다. 확인한 체크포인트 SHA-256은 다음과 같습니다.

```text
56244f8a6736e648dd8f4cd13d0889d7499a6bf776b9e55491a4ed59c446effd
```

## 6. 재연결과 다른 로컬 포트

Mac 절전·재부팅 또는 SSH 종료 후에는 먼저 다시 연결합니다.

```bash
python3 /Volumes/Dev/HOP_Projet/말씨/ai/trained_model_api/connect.py
```

기존 SSH 소켓이 없어 인증 연결부터 만들어야 한다면, Mac 터미널에서 아래처럼 API용 별도 연결을 만듭니다. SSH가 인증을 요청하면 터미널에서 인증합니다. 이 명령은 서버에 API를 새로 띄우거나 모델을 다운로드하지 않습니다.

```bash
ssh -MNf -p 20522 \
  -o ControlMaster=yes \
  -o ControlPersist=600 \
  -o ControlPath=/tmp/malssi-api-20522.sock \
  slim@165.194.161.61

python3 /Volumes/Dev/HOP_Projet/말씨/ai/trained_model_api/connect.py \
  --socket /tmp/malssi-api-20522.sock
```

로컬 18080 포트를 다른 프로그램이 사용한다면:

```bash
python3 /Volumes/Dev/HOP_Projet/말씨/ai/trained_model_api/connect.py --port 18081

python3 /Volumes/Dev/HOP_Projet/말씨/ai/trained_model_api/client.py \
  --base-url http://127.0.0.1:18081/v1 "안녕하세요"
```

새 SSH 소켓을 사용 중이면 위 연결 명령에도 `--socket /tmp/malssi-api-20522.sock`를 함께 지정합니다. 앱 설정, 상태 확인 주소, Python `base_url`도 같은 로컬 포트로 변경합니다.

## 7. 오류별 확인 순서

| 증상 | 확인 및 조치 |
| --- | --- |
| `Connection refused` / 연결 실패 | `connect.py`로 터널을 연결하고 `/healthz` 확인 |
| `SSH connection failed` | SSH 소켓·인증 연결 확인, 필요하면 6절의 별도 소켓으로 연결 |
| `Address already in use` / 포트 전달 실패 | 현재 포트의 `/healthz` 확인 후, 다른 앱이 사용 중이면 18081 사용 |
| HTTP 401 | `connect.py`로 현재 서버 키를 가져온 뒤 앱에 저장한 키 또는 환경변수 갱신 |
| HTTP 400, 문맥 예산 초과 | 대화 이력이나 `max_tokens`를 줄여 재요청. 서버가 입력을 자동으로 자르지 않음 |
| HTTP 400, 지원하지 않는 필드 | `stream:false`, `n:1` 사용. `tools`, `stop`, `reasoning_effort` 등 제거 |
| HTTP 400, 예약 토큰 오류 | 메시지 본문에서 `<\|turn>` 같은 모델 제어 토큰 제거 |
| HTTP 429 | 다른 요청이 끝난 뒤 재시도. 한 번에 한 요청 처리 |
| HTTP 500 | 서버 상태·로그 확인. 자동 학습 재개나 모델 변경은 하지 않음 |
| 응답이 `length`로 끝남 | 입력과 출력 합산 한도 안에서 `max_tokens`를 늘림 |

`MALSSI_API_KEY` 환경변수가 설정돼 있으면 파일보다 우선합니다. 갱신한 파일 키를 사용하려면 환경변수를 다시 설정하거나 `unset MALSSI_API_KEY`를 실행합니다.

서버 실행·상태 파일·로그 위치는 [서버 운영 안내](<%ED%95%99%EC%8A%B5%ED%95%9C%20Gemma%204%2031B%20API.md>)에 있습니다. `connect.py`는 터널과 키를 연결하며 종료된 서버 API를 자동으로 시작하지 않습니다.

채팅 요청의 입력 대화·생성 답변과 입출력 시각은 서버의 `runtime/request_timings.jsonl`에 기록됩니다. 한국 시간과 요청 ID, HTTP 상태, 처리 시간, 토큰 수를 함께 저장하며 인증 키는 기록하지 않습니다. 파일 권한은 `600`, 회전 크기는 10 MiB, 이전 파일 보존은 3개입니다.

## 8. 요청 제약과 관련 문서

- 입력은 텍스트 메시지 `1–128개`입니다. 선택적 첫 `system` 뒤에 `user`/`assistant`를 번갈아 넣고 마지막은 `user`로 끝냅니다.
- `temperature` 범위는 `0–2`, `top_p`는 `0 초과–1 이하`입니다.
- 요청 본문은 최대 8 MiB, 동시 추론은 1개입니다.
- 모델 계산에는 원격 서버와 SSH 연결이 필요합니다. `127.0.0.1`은 이 Mac에서만 접근하는 주소입니다. 다른 PC는 해당 PC의 SSH 터널이 필요합니다.
- 브라우저 프런트엔드에서 키를 배포하지 않고 로컬 백엔드에서 호출합니다. 이 서버는 브라우저 CORS 설정을 제공하지 않습니다.

관련 문서: [서버 운영·코드 안내](<%ED%95%99%EC%8A%B5%ED%95%9C%20Gemma%204%2031B%20API.md>) · [용량 검증 보고서](CAPACITY_REPORT.md) · [프로젝트 시작 안내](../README.md)

모델은 800행을 학습한 중간 체크포인트입니다. 전체 1에폭 학습이나 상담 품질 평가가 완료된 모델로 표시하지 않습니다. 이 안내는 2026-10-10까지 저장된 검증 결과를 기준으로 하며, 현재 연결 상태는 위 `/healthz`로 확인합니다.
