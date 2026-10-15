# Gemma 12B HTTPS API

이 폴더는 Mac Ollama `gemma4:12b`를 Tailscale Funnel로 제공하는 별도 구성의 설치·호출 안내입니다. 이번 문서 정리에서는 12B 서비스의 현재 실행 상태를 확인하지 않았습니다.

학습한 **Gemma 4 31B step100**은 원격 서버의 `trained_model_api`이며, 이 12B 구성과 모델·주소·인증 키가 다릅니다. 31B 호출은 [로컬 API 이용 안내](../trained_model_api/LOCAL_USAGE_REFERENCE.md)를 따릅니다. 31B의 128K 공유 예산을 아래 Ollama 설정에 그대로 적용하지 않습니다.

| 설정 | 값 |
| --- | --- |
| 공개 HTTPS 주소 | `https://s-macbook-pro.tail85b0de.ts.net` |
| OpenAI 호환 Base URL | `https://s-macbook-pro.tail85b0de.ts.net/v1` |
| 모델 | `gemma4:12b` |
| 인증 | `Authorization: Bearer <API_KEY>` |
| 로컬 인증 프록시 | `http://127.0.0.1:11435` |
| Ollama | `http://127.0.0.1:11434` |

인증 키와 클라이언트 환경변수는 **`local_api/runtime/client.env`**에 있습니다. 원본 설정은 `local_api/runtime/config.json`입니다. 두 파일은 Git에서 제외하고 소유자만 읽고 쓸 수 있게 설정했습니다. 키를 사용하는 외부 앱에는 `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OLLAMA_MODEL` 값을 입력합니다.

## 바로 호출

프로젝트 루트에서 실행합니다. Python 예제는 추가 패키지가 필요 없습니다.

```bash
python3 local_api/call_gemma.py "한국어로 짧게 자기소개해 주세요."

# 로컬 프록시로 호출
python3 local_api/call_gemma.py --local "안녕하세요"
```

curl로 OpenAI 호환 API 호출:

```bash
set -a
source local_api/runtime/client.env
set +a

curl --fail-with-body "$OPENAI_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemma4:12b","messages":[{"role":"user","content":"안녕하세요"}],"stream":false,"max_tokens":256,"reasoning_effort":"none"}'
```

Ollama native API 호출:

```bash
curl --fail-with-body "$GEMMA_API_URL/api/chat" \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemma4:12b","messages":[{"role":"user","content":"안녕하세요"}],"stream":false,"think":false,"options":{"num_predict":256,"num_ctx":4096}}'
```

`stream:true`이면 OpenAI API는 SSE, native API는 NDJSON을 반환합니다. curl에서는 `-N`을 추가합니다. `reasoning_effort:"none"` / `think:false`는 짧은 일반 답변에 사용합니다.

이미 OpenAI Python SDK를 사용하는 앱의 설정:

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url=os.environ["OPENAI_BASE_URL"],
    api_key=os.environ["OPENAI_API_KEY"],
)
response = client.chat.completions.create(
    model="gemma4:12b",
    messages=[{"role": "user", "content": "안녕하세요"}],
    max_tokens=256,
    reasoning_effort="none",
)
print(response.choices[0].message.content)
```

## 실행과 관리

프록시는 `com.chihun.gemma-api` 사용자 LaunchAgent로 설치했습니다. 로그인 후 자동 시작하며 종료되면 다시 실행됩니다. 설치본은 `~/Library/Application Support/GemmaAPI/`에 있습니다. 시작 시 Ollama에 연결되지 않으면 Ollama 앱을 엽니다. Tailscale Funnel은 `--bg` 설정으로 유지됩니다.

Mac이 켜져 있고 로그인 상태이며 인터넷과 Tailscale 연결이 유지돼야 응답할 수 있습니다. 절전 중에는 API가 응답하지 않을 수 있습니다.

상태 확인:

```bash
launchctl print "gui/$(id -u)/com.chihun.gemma-api"
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel status

curl --fail-with-body "$GEMMA_API_URL/healthz" \
  -H "Authorization: Bearer $OPENAI_API_KEY"
```

코드나 설정을 바꾼 뒤 설치본 갱신:

```bash
python3 local_api/install_macos.py
```

이 명령은 기존 키를 유지하고 프록시 서비스를 다시 시작합니다. 인증 키를 교체하려면 `runtime/config.json`의 `api_key`와 `runtime/client.env`의 `OPENAI_API_KEY`를 같은 새 값으로 바꾼 뒤 재설치합니다.

공개 HTTPS 연결을 끄거나 다시 켜기:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --https=443 off
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg --https=443 --yes http://127.0.0.1:11435
```

프록시 중지 / 다시 시작:

```bash
launchctl bootout "gui/$(id -u)/com.chihun.gemma-api"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.chihun.gemma-api.plist"
```

로그는 `~/Library/Application Support/GemmaAPI/gateway.stderr.log`에 기록됩니다. 프롬프트와 인증 키는 기록하지 않습니다.

## API 동작

모든 엔드포인트는 Bearer 인증을 요구합니다. 채팅·생성·모델 목록과 상태 확인 경로를 허용하며 모델 다운로드·삭제·생성 경로는 차단합니다. 요청의 모델을 생략하면 `gemma4:12b`를 사용하고 다른 모델을 요청하면 HTTP 400을 반환합니다.

요청 본문은 최대 8 MiB이며 모델 추론은 한 번에 한 요청을 받습니다. 다른 추론이 진행 중이면 HTTP 429, Ollama가 응답하지 않으면 HTTP 503을 반환합니다. `/healthz`는 Ollama 연결 및 모델 설치 상태를 확인합니다.

구현과 설정의 기본값은 [Ollama Chat API](https://docs.ollama.com/api/chat), [OpenAI 호환 API](https://docs.ollama.com/api/openai-compatibility), [Tailscale Funnel CLI](https://tailscale.com/docs/reference/tailscale-cli/funnel)를 기준으로 합니다.

검증 기록은 `runtime/verification.json`에 저장합니다. 테스트는 다음 명령으로 실행합니다.

```bash
python3 -m unittest discover -s local_api -p 'test_*.py' -v
```
