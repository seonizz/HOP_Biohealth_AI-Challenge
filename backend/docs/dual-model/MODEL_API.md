# 모델 입출력 HTTP API

말씨의 서비스 API와 모델 입출력 API를 분리합니다. 브라우저는 기존 `/api/v2/conversations/{id}/turns`로 입력을 저장합니다. 서버 워커는 아래 HTTP API로 평가 B → DB 저장·비교 → 응답 A를 순서대로 실행합니다. 모델 API는 동일한 체크포인트를 쓰는 두 역할의 프롬프트와 JSON Schema를 선택합니다. 클라이언트가 시스템 프롬프트나 모델 주소를 본문으로 지정할 수 없습니다.

현재 제공된 추론 서버는 Ollama의 `gemma4:12b` OpenAI 호환 HTTPS API입니다. `HOP_DUAL_TRANSPORT=direct`는 워커가 해당 `/v1/chat/completions`를 직접 사용하고, `api`는 이 문서의 역할별 API를 거칩니다. 두 경로 모두 같은 JSON Schema 검증과 B→A DB 처리를 사용합니다. 실제 주소·키는 Git에서 제외한 `.runtime/gemma-provider.env`와 Vercel 서버 환경변수에 보관합니다. 원격 서버에서는 상태와 모델 목록만 조회했으며 추론은 실행하지 않았습니다.

현재 로컬 설정 파일로 비활성 모델 API만 실행하려면 저장소 루트에서 `node --env-file=.runtime/gemma-provider.env backend/scripts/malssi-model-api.ts`를 사용합니다. 설정 파일의 두 추론 플래그는 false이며, 이 작업에서는 해당 서버나 워커를 시작하지 않았습니다. 공개 명세는 배포 후 `https://malssi-demo.vercel.app/openapi-model.json`에서 확인할 수 있습니다. 역할별 `/v1/assessments`와 `/v1/responses`는 이 별도 모델 API의 경로이며 Vercel의 공개 사용자용 엔드포인트가 아닙니다.

`OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OLLAMA_MODEL`, `GEMMA_API_URL` 환경변수를 그대로 지원합니다. 원격 호스트의 origin은 `HOP_MODEL_ALLOWED_ORIGINS`에 정확히 지정해야 하며 HTTPS와 서버 키가 필요합니다. `HOP_DUAL_PROTOCOL=ollama`는 `stream:false`, `reasoning_effort:none`, `response_format:json_schema`를 사용합니다. 이는 [Ollama OpenAI 호환 규격](https://docs.ollama.com/api/openai-compatibility)과 [구조화 출력 규격](https://docs.ollama.com/capabilities/structured-outputs)을 따릅니다. Ollama에 `/tokenize`가 없으므로 기존 가이드 문맥 예산은 UTF-8 바이트 수에 여유분을 더한 보수적 상한을 사용하며 정확한 토큰 수로 표시하지 않습니다.

`HOP_DUAL_MODEL_SHA256`에는 `/api/tags`에서 확인한 설치 모델의 digest를 기록합니다. Ollama manifest의 버전 식별값이며 원본 학습 체크포인트 파일의 해시나 별도 학습 여부를 검증했다는 의미는 아닙니다. 동일 모델 태그의 내용이 바뀌면 이 digest와 API/워커 설정을 함께 갱신해야 합니다.

```
브라우저 → Vercel 서비스 API → Neon 턴/작업 큐
                                ↓ 별도 CPU 워커
                         모델 입출력 HTTP API
                          ├ B 평가 → 같은 추론 서버
                          └ A 응답 → 같은 추론 서버
```

## 엔드포인트와 인증

모든 경로는 `Authorization: Bearer <HOP_MODEL_API_TOKEN>`을 요구합니다. 본문은 `application/json`이며 최대 256 KiB입니다. 쿠키 인증, 브라우저 Origin, CORS 호출은 지원하지 않습니다. 토큰과 모델 API 주소를 프론트 코드에 넣지 마십시오.

| 메서드·경로 | 입력 | 검증된 출력 |
| --- | --- | --- |
| `POST /v1/assessments` | 현재 입력, 최대 6개 근거 메시지, 대상자·대화 식별자 | 기존 `assessment.schema.json`의 숫자 JSON |
| `POST /v1/responses` | 현재 입력, 최근 대화, 서버가 검증한 현재 평가·직전값·변화량·정책 | `{ "message": "대화 문장" }` |
| `POST /v1/tasks/extract` | 기존 메모리 추출 문맥 | 검증된 추출 후보 |
| `POST /v1/tasks/guide` | 기존 가이드 문맥 | 검증된 가이드 |
| `POST /v1/tasks/verify` | 기존 가이드 문맥과 초안 | `{ "approved": true, "issues": [] }` |
| `POST /v1/tokenize` | `current_message` 문자열 | `{ "tokens": 123 }` |
| `GET /v1/status` | 없음 | 추론 활성화·설정 여부, 모델 정보, 처리 중 여부 |
| `GET /health/live` | 없음 | HTTP API 프로세스 생존 상태 |
| `GET /v1/openapi.json` | 없음 | 입력·출력 스키마를 포함한 OpenAPI 3.1 |

정적 명세는 `backend/openapi-model.json`입니다. `npm run openapi:model`로 생성하며 실제 입력 검증 구현은 `src/model-api/contract.ts`에 있습니다. 상태 확인은 추론 서버를 호출하거나 모델을 로딩하지 않습니다. `inference_readiness=not_probed`는 실제 모델 준비 완료라는 뜻이 아닙니다.

## 공통 요청과 B 입력 예시

아래 모델 이름과 해시는 형식 설명용 값입니다. 실제 학습 체크포인트는 아직 확정하지 않았습니다.

```json
{
  "api_version": "1",
  "request_id": "example-run.B.1.1",
  "expected_model": {
    "model_id": "YOUR_VERIFIED_MODEL_ID",
    "checkpoint_sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "prompt_profile": "test",
    "prompt_version": "v1"
  },
  "input": {
    "current_message": "엄마가 요즘 불안해요",
    "target": {
      "patient_id": "project-id",
      "project_id": "project-id",
      "conversation_id": "conversation-id",
      "speaker": "supporter"
    },
    "messages": [{"message_index": 0, "content": "엄마가 요즘 불안해요", "speaker": "supporter"}],
    "rubric_version": "patient-cues-v1"
  }
}
```

응답은 `api_version`, `request_id`, `operation`, `model`, `output`을 포함합니다. B의 `output` 안에는 문자열 설명 없이 숫자 평가만 들어갑니다. A의 `output`에는 `message`만 있습니다. 모델 API가 형식·근거·응답 규칙을 검증하고, 워커가 DB 원문과 다시 대조한 뒤 저장합니다. API에 돌아온 A 초안을 프론트로 바로 전달하지 않습니다.

A 요청의 `input.patient_cue_context`는 워커가 생성합니다. 필수 필드는 `evaluation_status`, `current`, `previous_valid`, `trend`, `response_policy`, `assessment_available`, `rubric_version`, `model_sha256`, `prompt_version`, `do_not_diagnose`입니다. `current`는 근거 메시지 ID까지 붙인 정규화 평가이며 `previous_valid`와 `trend`는 여섯 평가 항목을 모두 포함합니다. 근거가 없으면 -1이고, 비교할 점수가 없으면 이전값과 변화량은 null입니다. 클라이언트가 평가나 정책을 직접 지정하는 사용자용 API가 아닙니다.

## 현재 실행하지 않는 설정 절차

Node 24를 사용하는 모델 API 호스트에서 `backend/.env.example`을 참고하여 별도 환경 파일을 구성합니다. DB 접속값은 이 HTTP API에 필요하지 않습니다. `HOP_MODEL_API_TOKEN`은 별도로 생성한 32자 이상의 비밀값이어야 합니다.

```dotenv
HOP_MODEL_API_PORT=9010
HOP_MODEL_API_TOKEN=YOUR_RANDOM_SERVER_TO_SERVER_TOKEN
HOP_MODEL_API_INFERENCE_ENABLED=false
HOP_DUAL_MODEL_ID=
HOP_DUAL_MODEL_SHA256=
HOP_DUAL_MODEL_URL=http://127.0.0.1:18021/v1
HOP_DUAL_PROMPT_PROFILE=test
HOP_DUAL_PROMPT_VERSION=v1
```

```sh
cd backend
npm ci
npm run model:api
```

이 명령은 HTTP 서버만 루프백 `127.0.0.1:9010`에 띄웁니다. 추론이 비활성화된 상태에서 POST는 `503 MODEL_DISABLED`를 반환합니다. API 실행 명령에 학습·GPU·모델 로딩·워커 자동 실행은 없습니다. 설정된 모델의 추론 검증을 허용한 뒤에만 운영자가 `HOP_MODEL_API_INFERENCE_ENABLED=true`로 변경합니다. SHA-256은 설정된 신원 값이며 이 API가 모델 파일을 해싱하거나 로딩을 검증하는 것은 아닙니다.

역할별 모델 API를 다른 호스트의 워커에서 접근하려면 운영자 소유의 HTTPS 리버스 프록시로 모델 API의 루프백 포트를 연결합니다. 이 추가 API의 외부 주소는 아직 지정하지 않았습니다. 상위 추론 서버는 로컬 루프백 또는 명시적으로 허용한 HTTPS origin에 연결됩니다. `api` 전송 모드를 사용할 때 워커 설정은 다음과 같습니다.

```dotenv
HOP_DUAL_TRANSPORT=api
HOP_MODEL_API_URL=https://YOUR_MODEL_API_HOST
HOP_MODEL_API_ALLOWED_ORIGIN=https://YOUR_MODEL_API_HOST
HOP_MODEL_API_TOKEN=THE_SAME_SERVER_TO_SERVER_TOKEN
HOP_DUAL_ENABLED=true
HOP_V2_ENABLED=true
HOP_V2_MODEL_ENABLED=true
# 모델 API와 동일한 검증된 ID/해시/프롬프트 버전을 설정합니다.
HOP_DUAL_MODEL_ID=YOUR_VERIFIED_MODEL_ID
HOP_DUAL_MODEL_SHA256=YOUR_VERIFIED_SHA256
HOP_DUAL_PROMPT_PROFILE=test
HOP_DUAL_PROMPT_VERSION=v1
```

같은 호스트이면 `HOP_MODEL_API_URL=http://127.0.0.1:9010`을 쓰고 allowed origin을 비웁니다. 워커는 기존 `DATABASE_URL`, 암호화 키 등도 필요합니다. 운영 서버 API에도 동일한 모델 식별 설정이 있어야 DB 이력에 정확한 모델 버전이 저장됩니다. Vercel에서는 `HOP_V2_MODEL_ENABLED`를 미설정/false로 유지합니다. 모델 API·워커 준비 검증 후 운영자가 명시적으로 true로 전환해야 큐가 실행됩니다. Vercel 배포는 모델 API나 워커를 자동 시작하지 않습니다.

## 오류·재전송·취소

오류는 `{ "api_version": "1", "request_id": "...", "error": { "code": "MODEL_DISABLED", "retryable": true } }` 형태입니다. 입력 원문, 토큰, 미검증 모델 초안은 오류 응답과 로그에 넣지 않습니다.

| 상태 | 코드 예시 | 처리 |
| --- | --- | --- |
| 401 / 403 | UNAUTHORIZED / SERVER_CLIENT_REQUIRED | 서버 인증·호출 경로 수정 |
| 409 | MODEL_IDENTITY_MISMATCH / IDEMPOTENCY_CONFLICT | 체크포인트 설정 또는 요청 ID 확인 |
| 413 / 415 / 422 | REQUEST_TOO_LARGE / JSON_REQUIRED / INVALID_MODEL_REQUEST | 입력 수정 |
| 429 | MODEL_BUSY | 기존 서비스 큐에서 제한된 재시도 |
| 502 | INVALID_MODEL_OUTPUT / FAILED_VERIFICATION | 미검증 출력 폐기 |
| 503 | MODEL_DISABLED / MODEL_UNAVAILABLE | 평가 불가 기록 또는 응답 오류 |
| 504 | MODEL_TIMEOUT | B 최대 1회 재시도, 총 B 시간 예산 유지 |

HTTP API는 한 번에 한 추론만 처리합니다. 동일한 요청 ID와 본문의 동시 재전송은 한 호출로 합치고 결과를 5분 동안 프로세스 메모리에만 보관합니다(최대 100건). 본문이 바뀌면 409입니다. 이 메모리 캐시는 서버 재시작 후 유지되지 않습니다. 장기 이력과 사용자 턴 멱등성은 기존 Neon DB가 담당합니다. 워커의 B 재시도와 A 재생성은 서로 다른 호출 ID를 사용합니다. 클라이언트 연결 취소·시간 초과는 추론 호출에 AbortSignal로 전달되고, 기존 DB 리비전·취소 검증이 늦은 응답의 저장을 막습니다.

## 검증 범위

합성 모델을 테스트 프로세스에 주입해 실제 HTTP B→A 호출, 인증, 입력 검증, 같은 요청 재전송, 오류 비노출, 시간 초과, 취소, 모델 비활성 상태를 검사합니다. 별도의 합성 OpenAI 호환 HTTP 서버로 동일 모델 ID와 역할별 JSON Schema·프롬프트 전달도 확인합니다. PostgreSQL 통합 테스트는 실제 사용자 턴이 이 HTTP 클라이언트 경로를 지나 검증된 답변·알림으로 저장되는지 확인합니다. 실제 학습 모델·GPU는 실행하거나 검증하지 않았습니다.
