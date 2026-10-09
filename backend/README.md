# HOP Backend

서버에 접속해 현재 구현을 실행하는 순서는 [서버 접속·실행·이용 인계서](docs/SERVER_HANDOFF_GUIDE.md)를 확인해 주세요. 기존 서비스와 분리된 스키마·포트, 환경 준비 도구, 실제 검증한 합성 API 예제를 포함합니다.

말씨 v2 개발 구현은 [구현·운영 범위](docs/MALSSI_IMPLEMENTATION.md), [검증 기록](docs/MALSSI_VALIDATION.md), [v2 OpenAPI](openapi-v2.json), [TypeScript 클라이언트](client/v2.ts)를 확인해 주세요. v2는 기본 비활성화이며 draft 문항의 공개 게시와 운영 배포는 별도 검토 대상입니다. 아래 기존 실행·화면 안내는 v1을 설명합니다.

환자의 감정·위험 단서를 평가하는 **B→A 이중 모델 후속 설계**는 [아키텍처·개발 순서](docs/DUAL_MODEL_PIPELINE_DESIGN.md), [수치 JSON 스키마](docs/dual-model/assessment.schema.json), [장치·프롬프트 설정 예제](docs/dual-model/settings.example.json)에 있습니다. 예제 설정과 프롬프트는 설계 자료이며 현재 API에 연결되지 않았습니다.

이 문서의 실행 명령은 저장소의 `backend/` 디렉터리를 기준으로 합니다. 저장소 루트에 있다면 먼저 `cd backend`를 실행하세요.

HOP은 환자를 돕고 싶은 가족·친구·동료에게 대화와 도움 방법을 제안하는 서비스입니다. 주변인이 답한 내용을 프로젝트별로 기억하고, 17개 인터뷰 문항에서 필요한 정보가 모이면 관계와 상황에 맞는 코칭으로 이어갑니다.

**Node.js 24 · TypeScript · PostgreSQL 16 · OpenAI 호환 로컬 모델 API**

## 문서

| 목적 | 문서 |
| --- | --- |
| 지금 화면에서 할 검사와 복사할 입력 | [프론트 연결 전 점검](docs/BEFORE_FRONTEND.md) |
| 프론트엔드 연동, 인증, 요청·응답, 재시도 | [프론트엔드 가이드](docs/FRONTEND.md) |
| 전체 API 스키마 | [OpenAPI 3.1](openapi.json) |
| 브라우저용 TypeScript 클라이언트 | [client/](client/) |
| 실행, 환경 변수, HTTPS, 백업과 복원 | [운영 가이드](docs/OPERATIONS.md) |
| 인터뷰, 정보 추출, RAG, 응답 검증 | [모델 파이프라인](docs/MODEL_PIPELINE.md) |
| 복사해서 사용할 테스트 프롬프트 | [테스트 가이드](docs/TEST_PROMPTS.md) · [JSON 사례](test-prompts.json) |
| 상담 데이터 등록 | [data/README.md](data/README.md) |

## 동작 흐름

1. 팀 초대 코드로 가입한 사용자가 도움 프로젝트를 만듭니다.
2. 주변인의 답변에서 관계·관찰·어려움·현재 필요한 도움을 발화 근거와 함께 추출합니다.
3. 아직 필요한 질문을 선택합니다. 충분한 정보가 있으면 17문항을 모두 반복하지 않고 코칭을 시작합니다.
4. 관련 상담 사례를 검색하고, 모델이 사용할 표현과 행동 제안을 작성합니다.
5. 근거·인용·응답 형식을 검증한 뒤 대화와 프로필 변경을 PostgreSQL에 함께 저장합니다.

17문항은 상황 이해를 위한 인터뷰입니다. 답변 길이나 주변인의 추측을 우울·불안·중독 진단 점수로 변환하지 않습니다. 프로필은 확인된 보고와 출처를 보존하며, 실제 관찰과 해석을 구분합니다.

## 빠른 시작

Node.js 24.19.0 이상과 PostgreSQL 16 이상을 준비합니다.

```sh
npm ci
node scripts/init-env.mjs --origin http://127.0.0.1:9000
```

생성한 `.env`에서 접근 가능한 PostgreSQL 연결, 로컬 모델 주소, 사용 권한이 있는 지식 파일 경로를 설정합니다. `.env`는 기존 파일을 덮어쓰지 않으며 Git에서 제외됩니다.

```sh
npm run migrate
npm start
```

기본 API 주소는 `http://127.0.0.1:9000`입니다. `GET /health`는 API 상태를, `GET /ready`는 DB와 설정된 모델의 준비 상태를 확인합니다. `GET /openapi.json`에서 실행 중인 API 명세를 읽을 수 있습니다.

실제 모델 연결을 사용하려면 모델 서버가 해당 모델 ID와 구조화 JSON 출력을 제공해야 합니다. 이 저장소는 모델 다운로드나 추론 프로세스를 자동으로 시작하지 않습니다. 모델 연결이 실패하면 오류를 반환하고 성공한 코칭으로 저장하지 않습니다.

## 프론트엔드 연결

가능하면 프론트엔드와 API를 같은 origin에서 `/api`로 연결합니다. 분리된 개발 서버라면 백엔드 `HOP_CORS_ORIGINS`에 정확한 프론트 주소를 등록하고 브라우저 요청에 `credentials: 'include'`를 사용합니다.

```ts
const response = await fetch('/api/auth/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
const result = await response.json();
if (!response.ok) throw new Error(result.detail);
```

메시지 전송 전에 `crypto.randomUUID()`로 `request_id`를 한 번 만들고, 네트워크 오류로 재전송할 때 같은 ID와 본문을 유지합니다. 새 메시지에는 새 ID를 사용합니다. 응답은 완성된 JSON이며 토큰 스트리밍을 사용하지 않습니다.

## 개발과 테스트

```sh
npm run check
npm test
# 실제 PostgreSQL 테스트 DB URL을 환경 변수로 제공한 뒤 실행
npm run test:ci
```

`test:ci`는 `HOP_TEST_DATABASE_URL`을 필수로 확인합니다. 테스트는 각각 임의 이름의 별도 스키마를 사용합니다. 테스트 계정에는 해당 DB의 스키마 생성 권한이 필요합니다. 일반 `npm test`에서 DB 설정이 없으면 DB 테스트가 건너뛰어지므로 CI에서는 `test:ci`를 사용합니다.

테스트의 모델 응답과 가상 발화는 API 동작을 재현하기 위한 것입니다. 실제 모델 평가는 [테스트 가이드](docs/TEST_PROMPTS.md)의 별도 절차를 따릅니다.

## 구조

```text
src/          HTTP API, 인증, 대화 흐름, 모델 호출, PostgreSQL, 검색
client/       프론트엔드용 TypeScript 클라이언트
migrations/   검증 가능한 DB 마이그레이션
tests/        단위·API·PostgreSQL 통합 테스트
scripts/      환경 준비, 마이그레이션, 데이터 등록, 테스트, 백업
deploy/       PostgreSQL 초기 권한, Caddy HTTPS 설정
docs/         프론트엔드·운영·모델·테스트 문서
data/         지식 파일 등록 안내
```

실제 상담 데이터, 비밀번호, 초대 코드, 모델 파일, DB 파일, 실행 로그는 저장소에 포함하지 않습니다. 검색에 사용할 데이터는 권한을 확인한 뒤 운영 환경에 별도로 배치합니다.
