# 말씨 앱 실행

현재 앱은 임시 테스트용 native Ollama `gemma4:12b`와 `relationship_agent`를 사용합니다. 최종 목표는 31B이며 [모델 진행 방향](../docs/current/현황과_할일.md#모델-진행-방향)을 따릅니다. 이 문서는 설치·환경 설정의 기준 문서입니다.

[프로젝트 홈](../README.md) · [통합 실행·검증](../docs/current/실행과_검증.md) · [현황과 할 일](../docs/current/현황과_할일.md)

## 설치와 실행

통합 프로젝트의 `app/` 폴더에서 실행합니다. Node.js 24.14 이상 24.x, Docker·Compose, 접근 가능한 모델 API가 필요합니다. 아래는 로컬 Ollama를 사용하는 기본 절차이며 다른 API는 같은 환경 설정의 주소·모델·인증·지원 형식을 지정합니다.

```sh
cd app
```

Docker와 로컬 Ollama가 실행된 상태에서:

```sh
npm ci --ignore-scripts
npm run setup
ollama list
```

`ollama list`에서 `gemma4:12b`가 있는지 확인합니다. 새 설치의 `npm run setup`은 아래 로컬 모델 설정까지 생성합니다. 기존 `.env`가 있으면 DB 암호·`CONTENT_KEY`·모델 설정을 그대로 보존합니다.

| 설정 | 현재 값 |
| --- | --- |
| `MODEL_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `MODEL_DOCKER_BASE_URL` | 선택 사항. 생략하면 Docker에서 loopback을 `host.docker.internal`로 변환 |
| `MODEL_NAME` | `gemma4:12b` |
| `MODEL_PROTOCOL` | `relationship_agent` |
| `MODEL_STATE_MODE` | `combined_blocks` (상태·이름·관계·질문을 나누어 생성한 뒤 통합 검증) |
| `MODEL_AGENT_FORMAT` | `json_schema` (모델 API의 구조화 출력 사용) |
| `MODEL_STREAM_JSON` | `true` |
| `MODEL_STREAM_COMPLETE_JSON` | `true` (로컬 스트림에서 완성된 JSON 수신 뒤 기존 검증 수행) |
| `MODEL_TIMEOUT_MS` | `0` (답변 시간 제한 없음) |

인증 없는 로컬 Ollama는 더미 값 `MODEL_API_KEY=local-ollama`를 사용합니다. 로컬 주소에서 키가 비어 있어도 같은 더미 값을 사용하며, 인증이 필요한 API는 서버 전용 키를 설정합니다. 실제 키는 브라우저·진단 출력에 전달하지 않습니다. `--model-env`는 별도 게이트웨이의 `json_schema` 설정을 가져오는 기존 경로입니다.

```sh
docker compose up -d --build
```

[말씨 열기](http://127.0.0.1:9000). 기본 API 포트는 9000, 로컬 PostgreSQL 포트는 5433입니다. 호스트에서 실행할 때는 `MODEL_BASE_URL`을 사용합니다. Docker는 명시한 `MODEL_DOCKER_BASE_URL`을 우선하고, 생략하면 loopback 주소만 호스트 별칭으로 변환합니다. 명시한 LAN·다른 API 주소는 유지합니다. Compose에는 Linux 호스트 게이트웨이 매핑도 포함되어 있습니다.

```sh
# 상태 확인: 비밀값을 포함하는 docker compose config 출력은 피합니다.
docker compose ps
# 종료: 데이터 볼륨은 보존됩니다.
docker compose down
```

개발 중에는 PostgreSQL만 Docker로 실행하고 API를 Node.js 24.14 이상 24.x로 실행할 수 있습니다.

```sh
docker compose up -d postgres
npm start
```

같은 환경 설정의 유효성과 실제 작성·검토 API를 확인합니다. 기본 명령은 네트워크에 연결하지 않고, `--generate`는 상담 내용 없는 합성 입력을 각 API에 보냅니다. 선택한 `MODEL_PROTOCOL`의 실제 생성 경로와 검증기를 사용하며, 결과에는 사용한 프로토콜·출력 형식·스트리밍 여부를 표시합니다.

```sh
npm run check:model
npm run check:model -- --generate
```

API 주소는 서버 루트나 `/v1`, `/v1/chat/completions` 형태를 받을 수 있으며 공통 설정이 API 루트로 정규화합니다. 임의 서버를 탐색하거나 장애 시 다른 서버로 원문을 전송하지 않습니다. 일반 OpenAI 호환 서버는 지원 범위에 맞게 `MODEL_AGENT_FORMAT=prompt|json_object|json_schema`, `MODEL_REASONING_EFFORT=omit`, `MODEL_STREAM_JSON=false`를 선택할 수 있습니다. `/healthz`가 사용 가능한 모델 용량 정보를 제공하지 않는 서버에는 `MODEL_DISCOVER_TOKEN_LIMITS=false`를 명시합니다. 용량 조회 옵션은 `true` 또는 `false`를 명시하며, 빈 값은 호스트와 Docker 모두 잘못된 설정으로 처리합니다. 이 옵션도 저장 전 원문·스키마·독립 검토를 바꾸지 않습니다.

## Origin과 모델 연결

로컬 주소는 `http://127.0.0.1:9000`입니다. 공개 도메인을 사용할 때는 `.env`의 `PUBLIC_ORIGIN`과 `ALLOWED_ORIGINS`를 실제 앱 Origin에 맞춥니다. 이전 공개 주소의 현재 가동 여부는 재확인하지 않았습니다. 연결 상태는 실행 환경에서 별도로 확인합니다. `/health`의 `model_configured`는 설정 유무만 나타내며 실제 모델 생성 성공을 보증하지 않습니다.

목표 31B의 기존 학습 모델·SSH 터널 자료는 [데이터와 연구](../docs/current/데이터와_연구.md)에 구분합니다. 다른 장비로 앱·DB를 옮기는 절차는 [서버 이동](docs/DOCKER_HANDOFF.md)을 따릅니다.

이미 실행 중인 v11 31B API를 연결할 때는 해당 실행의 키 파일과 프로필을 명시합니다.

```sh
npm run setup -- --trained-model-key /path/to/v11-key --trained-model-profile v11
```

이 프로필은 `malssi-gemma4-31b-v11-epoch3`, `relationship_agent`, `prompt`, `omit`, `combined`와 기존 v11 대기 한도를 설정합니다. DB 연결·암호·저장 데이터는 유지하며 모델 서버를 시작하거나 학습 체크포인트를 교체하지 않습니다. 프로필을 생략한 기존 `--trained-model-key` 명령은 step100 설정을 유지합니다. `scripts/live-check.js`와 서비스는 같은 작성·검토·스트리밍 설정 모듈을 사용합니다. 연결 검사와 비교 도구의 상세 결과는 서비스 화면에 표시하지 않습니다.

### 검토 모델 분리

`relationship_agent`의 검토 단계를 별도 서버로 보내려면 서버 전용 환경에 `MODEL_REVIEW_BASE_URL`을 설정합니다. 예를 들어 생성은 Mac의 `http://127.0.0.1:11434/v1`, 검토는 별도 서버의 `http://reviewer.example:11434/v1`에서 실행할 수 있습니다. 예시 호스트는 실제로 허용한 서버 주소로 바꿉니다. 이 설정을 생략하면 기존처럼 기본 모델이 생성과 검토를 모두 담당합니다. 검토에도 합성 또는 사용자 답변 원문과 생성 결과가 전달되므로 사용자가 허용한 서버를 지정합니다.

| 설정 | 동작 |
| --- | --- |
| `MODEL_REVIEW_BASE_URL` | 검토 서버의 OpenAI 호환 `/v1` 주소. 비어 있으면 분리하지 않음 |
| `MODEL_REVIEW_DOCKER_BASE_URL` | Docker에서 사용할 별도 검토 주소. 생략하면 작성 모델과 같은 loopback 변환 적용 |
| `MODEL_REVIEW_NAME` | 생략하면 기본 `MODEL_NAME` 사용 |
| `MODEL_REVIEW_AGENT_FORMAT` | `json_schema`(기본), `json_object`, `prompt` |
| `MODEL_REVIEW_REASONING_EFFORT` | `none`(기본), `omit`, `low`, `medium`, `high` |
| `MODEL_REVIEW_API_KEY` | 생략하면 로컬 Ollama용 `local-ollama` 사용. 인증이 필요한 서버는 전용 키 설정 |
| `MODEL_REVIEW_STREAM_JSON` | 허용한 로컬 별칭·loopback·RFC1918 사설 IPv4 주소에서 `true`로 스트리밍 활성화. 기본 `false` |
| `MODEL_REVIEW_STREAM_COMPLETE_JSON` | 검토의 로컬 스트리밍이 켜져 있을 때 완성된 JSON 수신으로 전송 종료. 기본 `false`, 작성 모델과 별도 설정 |
| `MODEL_REVIEW_SCHEMA_STRING_LIMITS` | `true`일 때 검토 요청의 JSON Schema 문자열 길이 제약 보존. 기본 `false` |
| `MODEL_REVIEW_DISCOVER_TOKEN_LIMITS` | 검토 서버 `/healthz` 용량 조회. 기본 `true`, 미지원 API는 명시적으로 `false` |

검토의 기본 전송은 비스트리밍이며, 작성 모델의 스트리밍 옵션은 검토 서버에 적용하지 않습니다. 정확한 `localhost`, `host.docker.internal`, 숫자 loopback(`127.0.0.0/8`, `::1`)와 RFC1918 사설 IPv4 주소에서 스트리밍을 지원합니다. 그 밖의 DNS·공인 주소는 비스트리밍으로 설정합니다. 검토의 시간 제한·원문 검증·취소·단계 의존성은 유지합니다. 잘못된 작성·검토 설정은 DB 연결 전에 오류로 처리합니다. `gateway`를 직접 주입한 테스트 하네스에는 환경 설정을 자동 적용하지 않습니다.

## 모델 전송·수신 한도

웹은 각 생성 작업을 시작할 때 연결된 서버의 `/healthz`를 조회합니다. 요청 모델과 일치하는 `max_output_tokens`·`max_context_tokens`가 있으면 그 출력 상한을 사용하고, 이를 제공하지 않는 Ollama 등에서는 `max_tokens`를 생략하여 서버·모델의 기본 생성 정책을 따릅니다. 이전 단계별 1,000~4,200토큰 상한과 프롬프트의 전체 토큰 수 지시를 제거했습니다. 이 정책은 상태 갱신, 최종 가이드, 별도 검토와 위험 분류에 동일하게 적용됩니다.

구형 `json_prompt` 연결도 모든 응답 완료·모름 항목의 원문, 후속 답변, 목표, 메모리와 질문 후보를 전송합니다. 1,300~3,000자 투영과 문맥 초과 시 추가 축약을 제거했습니다. 서버가 정확한 입력·출력 예약·문맥 상한을 포함한 합산 예산 오류를 반환하면 입력은 그대로 두고 출력 예약만 남은 문맥으로 줄여 재시도합니다. 입력 자체가 초과하거나 유효한 남은 문맥을 확인할 수 없으면 `MODEL_CONTEXT_TOO_LONG`으로 실패합니다. 수신 JSON의 별도 60,000자 상한도 제거했습니다. 미완성 응답, 잘못된 JSON, 출력 필드 구조와 근거 검증은 계속 적용합니다.

서버 정책 사용은 무제한 생성이나 모델의 이론상 최대 문맥을 보장하지 않습니다. Ollama의 생성 기본값·모델 설정·실제 runner 문맥을 따릅니다. 31B 중계기처럼 출력 상한 8,192를 공개하면서 생략 기본값은 512인 서버에서도 웹은 공개된 8,192 범위를 사용하므로 작은 기본값으로 되돌아가지 않습니다. 조회 실패·잘못된 공개 한도는 생성 전에 오류로 처리하며, 인증값과 서버 오류 원문을 로그에 남기지 않습니다. 기존 답변당 10,000자 검증, HTTP 요청 256 KiB 제한, 스키마별 필드 제한은 토큰 예산과 별개입니다.

2026-10-22 사용자 요청으로 앱의 답변 시간 제한을 없앴습니다(`MODEL_TIMEOUT_MS=0`). 일시적인 모델 연결 실패와 응답 검증 실패는 대기 간격을 두고 내부에서 다시 시도합니다. 인증·연결 설정이나 입력 크기 문제는 자동 반복하지 않고 필요한 안내를 표시합니다. 대화 나가기·수정·삭제·연결 종료 시 해당 작업을 취소하며, 다른 요청이 함께 기다리는 작업은 남은 요청이 있을 때 유지합니다.

`MODEL_SCHEMA_STRING_LIMITS=true`는 추론 서버로 보내는 JSON Schema에도 기존 문자열 길이 제약을 보존합니다. 이 제약을 지원하는 로컬 Ollama/XGrammar 검증 환경에서 사용하며, 기본값 `false`는 긴 문자열 문법을 크게 확장하는 다른 서버와의 호환성을 유지합니다. 어느 설정에서도 저장 전 원문·스키마 검증은 동일하며 답변 시간 제한이나 별도 출력 토큰 한도를 추가하지 않습니다.

`MODEL_STREAM_JSON=true`는 정확한 로컬 별칭(`localhost`, `host.docker.internal`), 숫자 loopback과 RFC1918 사설 IPv4 주소의 모델 스트림을 기존 JSON 응답으로 검증합니다. 명시한 API 주소만 사용하며 다른 DNS·공인 주소·그 밖의 IPv6 주소에는 비스트리밍을 사용합니다. JSON 문자열 밖에서 공백만 4,096자 넘게 이어지면 해당 시도를 취소하고, JSON Schema 모드였을 때 같은 단계의 다음 시도만 JSON Object 모드로 바꿉니다. 전체 답변의 시간·토큰·문자 수 제한은 추가하지 않으며 새 응답도 같은 검증을 통과해야 합니다. 새 로컬 설치 기본값은 `true`이고, 옵션을 생략한 API 설정은 `false`입니다.

`MODEL_STREAM_COMPLETE_JSON=true`는 로컬 스트리밍에서 구문상 완성된 JSON 객체를 수신하면 전송을 끝내고 원래 전체 스키마·원문 근거 검증을 수행합니다. 이후의 독립 검토도 유지합니다. JSON을 완성한 뒤에도 생성을 이어 가는 로컬 서버를 위한 옵션이며, 시간·토큰·전체 문자 수 제한은 추가하지 않습니다. 진단에는 서버의 `stop` 대신 `json_complete`로 기록하고, 이미 수신한 실패 종료 사유는 무시하지 않습니다. 새 로컬 설치에서만 기본으로 켜며, 기존 설정과 일반 API의 기본값은 `false`입니다. 별도 검토·기관 안내 API는 각각 `MODEL_REVIEW_STREAM_COMPLETE_JSON`, `REFERRAL_MODEL_STREAM_COMPLETE_JSON`과 해당 `STREAM_JSON` 옵션을 명시해야 합니다. 스트리밍을 끄거나 일반 API로 전환할 때는 이 옵션도 끕니다. 명시적인 setup 프로필·API 설정 가져오기는 기존 로컬 옵션을 제거합니다.

스트리밍 중 배열이 요청 스키마의 기존 `maxItems`를 넘어 더 이상 유효해질 수 없으면 해당 시도만 취소하고 제한값을 기존 수정 절차에 전달합니다. 모든 배열의 유한 상한을 확인할 수 있을 때만 적용하며, 같은 속성 이름의 여러 경로·분기는 가장 큰 허용값을 사용합니다. 자유 형식·미해결 참조 등 불확실한 스키마에는 조기 제한을 추가하지 않습니다. 전체 통합 초안에서 이미 허용하던 두 보고와 한 가설의 관계 메모리 정규화도 유지합니다. 미완성 출력은 수정 예시나 저장 결과로 사용하지 않으며, 완성한 응답에는 기존 근거 검증과 독립 검토가 그대로 적용됩니다.

완성된 JSON 수신으로 전송을 끝내는 옵션이 꺼져 있으면, 같은 유한 스키마 검사에서 한 JSON 뒤 다음 객체·배열을 계속 출력하는 경우 단일 JSON 응답이 될 수 없으므로 `content_json`으로 중단해 재시도합니다. 정상 코드블록의 닫기와 공백, 중첩 객체, 문자열 안의 괄호는 유지합니다. 어느 모드에서도 구문 완성만으로 답변을 승인하지 않습니다.

객체 값 뒤 구분자가 빠진 채 새 문자열·객체·배열이 시작되는 명백한 구문 오류도 같은 절차로 중단합니다. 유효한 값 위치와 다른 경우에만 적용하며 정상 숫자·불리언·null·문자열·중첩 구조의 구분자는 유지합니다. 완성된 전체 JSON 파싱과 원문 검증은 계속 수행합니다.

문자열 안에서 공백 등을 끝없이 출력하는 경우도 원래 스키마의 모든 문자열 값에 유한한 상한이 있으면 그 상한을 초과한 시도만 중단해 수정 요청으로 넘깁니다. 이 스트림 검사에서 직접 확인한 초과라면 JSON Schema 요청의 다음 시도를 JSON Object 형식으로 전환하고 원래 전체 스키마로 검증합니다. 일반 스키마 오류에는 이 전환을 적용하지 않습니다. 추론 서버에 길이 제약을 보내지 않는 설정에서도 원래 검증 기준을 사용합니다. 키 이름·사고 내용·전체 출력 길이에 새 제한을 두지 않으며, 상한을 확정할 수 없는 스키마는 이 조기 검사를 끕니다. 잘못된 부분 출력은 저장하거나 승인하지 않습니다.

JSON 재작성에는 해당 단계에서 검증에 실패한 직전 출력과 오류를 함께 전달합니다. 이 후보는 요청 안에서만 유지하며 로그나 승인된 상태로 저장하지 않습니다. `combined` 초안에서 형식 오류가 세 번 이어지면 모델이 네 블록을 각각 다시 생성하고, 조합한 결과에 전체 검증과 새 독립 검토를 적용합니다. 새 로컬 설정의 `combined_blocks`는 같은 네 블록 경로를 처음부터 사용해 큰 통합 출력의 반복 실패를 피합니다. 모든 원문과 질문 생략 판단·전체 검증·독립 검토는 유지합니다. 네트워크 오류·인증 실패·취소를 형식 오류로 세지 않습니다. 저장용 과거 기록은 출력 양식과 구분해 전달하며 원문 근거와 미확인 내용은 보존합니다.

2026-10-22 로컬 확인: Ollama 0.40.5의 `gemma4:12b`는 `safetensors` 형식이며 모델 파라미터에 별도 생성 토큰 상한이 없었습니다. 해당 버전의 MLX 경로는 입력 자동 축약을 끄고, 실제 입력이 문맥 한계에 도달하면 거절하며 남은 문맥 안에서 출력을 생성합니다([입력 처리](https://github.com/ollama/ollama/blob/d919272e53593d1d55d40e1180eaa06dfbede3ac/server/routes.go#L3244-L3249), [출력 범위 계산](https://github.com/ollama/ollama/blob/d919272e53593d1d55d40e1180eaa06dfbede3ac/mlxrunner/pipeline.go#L73-L83)). 고정 토큰값 없는 합성 요청은 HTTP 200, 입력 72·출력 8토큰, `finish_reason:stop`으로 완료했습니다. 이는 연결 검증이며 최대 문맥·최대 출력 용량 검증은 아닙니다.

로컬 Ollama에서 GPU 서버의 31B로 옮길 때는 기존 `MODEL_BASE_URL`·`MODEL_NAME`·`MODEL_API_KEY`와 프로토콜 설정을 해당 서버에 맞춰 적용합니다. 웹 소스의 토큰 숫자를 다시 수정할 필요는 없습니다. 한도는 각 작업에서 새로 확인합니다. 31B의 실제 대용량 추론과 GPU 자원 검증은 서버 전환 시 별도로 수행합니다.

## URL과 새로고침 복원

화면은 `/`, `/about`, `/chat/:intakeId`, `/result/:intakeId`, `/records/:recordId`, `/columns/:articleId` 경로를 사용합니다. 칼럼 분류와 담은 글·안 읽은 글 필터는 쿼리로 유지합니다. 뒤로·앞으로 이동과 경로 직접 열기를 지원하며, 화면 경로도 서버에서 `index.html`로 연결합니다. URL에는 원문·호칭·인증값을 넣지 않습니다. 대화와 결과는 기존 세션 쿠키로 접근 권한을 확인하므로 URL만으로 다른 세션에 공유되지는 않습니다.

전송한 답변과 질문 위치는 서버에서 복원합니다. 전송 중 새로고침한 답변은 저장된 대기 입력으로 이어서 준비합니다. 보내지 않은 입력·선택·추가 설명은 같은 탭의 `sessionStorage`에 최대 24시간, 최근 32개 질문까지 보관합니다. 초안은 세션·대화·질문·버전에 연결하고, 제출 성공 또는 대화 삭제 시 정리합니다. 탭을 닫거나 저장 기능을 지원하지 않는 환경에서는 초안을 복원하지 못할 수 있습니다.

대화와 결과 준비는 칸 구분 없는 연속 진행바로 표시하며 저장을 마친 뒤 100%가 됩니다. 단계 번호와 단계별 목록은 표시하지 않습니다. 로딩·입력은 일반 화면 흐름에 배치하고 작은 화면에서는 버튼과 헤더를 줄바꿈합니다.

불씨는 대화 종료 후 원문 인용 카드(버전 2)만 사용합니다. 일시적인 걱정이나 서비스 이용 목적만으로 상담을 권하지 않습니다. 지속·반복되는 어려움과 생활 지장 또는 명시적인 전문 상담 요청이 원문에 있고 독립 분류가 일치할 때 일반 상담 카드를 표시합니다. 기존의 명시적인 안전 신호는 별도로 유지합니다. 자세한 표시 기준은 [UI 정보 원칙](docs/UI_CONTENT_POLICY.md)을 따릅니다.

2026-10-22: 사용자 요청으로 URL·초안·배치·진행바 변경의 테스트와 실제 모델 확인은 추후 일괄 수행합니다. 현재 변경에 대한 검증 완료를 의미하지 않습니다.

## 관리와 상세 계약

| 할 일 | 기준 문서 |
| --- | --- |
| 코드·DB·실제 모델 검증과 비공개 자료 내보내기 | [통합 실행·검증](../docs/current/실행과_검증.md) |
| 질문 문구·보기·순서·사용 여부 수정 | [질문 관리](docs/QUESTIONS.md) |
| 상태 갱신·검색·최종 검토·화면·저장 구조 | [관계 에이전트 계약](docs/RELATIONSHIP_AGENT.md) |
| HTTP 요청·응답과 오류 | [API 계약](docs/API.md), [OpenAPI](docs/openapi.json) |

정리 전 설명과 당시 검증 기록은 [원문 보관](../archive/08_문서통합_원문/app/README.md)에 남깁니다.
