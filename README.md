# 말씨 개인 시연 백엔드

`seonizz/HOP_Biohealth_AI-Challenge`의 `feat/columns-interactive` 브랜치, 커밋 `aa144758fdcece6a01a69d9e0507d51e9dc1a9ff`를 기준으로 기존 서비스 화면을 PostgreSQL과 실제 `gemma4:12b`에 연결합니다. 로그인 화면이나 새 서비스 기능은 추가하지 않았습니다.

## 실행

Docker Desktop이 실행된 상태에서:

```sh
npm ci --ignore-scripts
npm run setup
# 모델 키가 들어 있는 환경 파일을 서버용 .env로 가져오기
npm run setup -- --model-env /absolute/path/to/client.env
docker compose up -d --build
```

[말씨 열기](http://127.0.0.1:9000). 기본 API 포트는 9000, 로컬 PostgreSQL 포트는 5433입니다. 모델은 `https://s-macbook-pro.tail85b0de.ts.net/v1`, `gemma4:12b`로 설정합니다. API 키는 `.env`에만 저장되고 브라우저에 전달되지 않습니다. 제공한 환경 파일의 `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OLLAMA_MODEL`을 읽습니다.

`npm run setup`은 기존 `.env`를 덮어쓰지 않습니다. `--model-env`를 지정할 때 모델 설정만 갱신합니다. 생성한 `.env`의 DB 암호와 `CONTENT_KEY`를 보관해야 기존 데이터를 다시 읽을 수 있습니다.

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

## 대화와 내부 상태

1. 브라우저별 익명 세션을 만듭니다. 이메일·회원 가입은 요구하지 않습니다.
2. 기존 UI의 정확한 30개 문항, 조건부 분기, 후속 질문과 직전 문항 되돌리기를 서버에서 처리합니다.
3. 답변 원문과 선택한 보기, 건너뛰기, 후속 답변을 PostgreSQL에 먼저 저장합니다.
4. 모델이 현재 상태와 이전 메모리를 읽고 당사자 상태 메모리를 갱신합니다. 원문 인용과 대상 구분을 검증한 변경만 저장합니다.
5. 마지막에 누적 상태를 읽어 기존 결과 카드에 필요한 첫마디·해볼 행동·피할 표현·다음 단계·주변인 자기돌봄을 생성합니다. 결과와 전체 대화 기록을 저장합니다.

당사자 정보와 앱 이용자의 감정·부담은 별도 필드로 관리합니다. 답변은 사용자의 보고이며 임상적으로 확인된 사실이 아닙니다. 내부 `patient_state`의 요약·해석은 모델 생성물입니다. 서버는 인용이 현재 답변의 실제 부분 문자열인지, 대상과 문항이 일치하는지 검사하지만 의미의 임상적 타당성을 인증하지 않습니다. 임의 질환 점수는 계산하지 않습니다. 결과의 분류는 기존 칼럼 연결용이며 진단이 아닙니다.

질문·보기는 브랜치와 동일하게 유지합니다. 모델이 모든 문항을 마음대로 바꾸거나 질문은행의 17문항으로 교체하지 않습니다. 모델이 실패해도 원문 답변은 남고, 다음 답변에서 상태 갱신을 다시 시도합니다. 최종 결과 생성 실패는 결과를 꾸며 저장하지 않고 기존 대화 화면에서 재시도할 수 있습니다.

## 기존 UI 기능

시작·서비스 소개·대화·결과·내 기록·칼럼의 6개 화면을 유지합니다. 단일/다중 선택, 직접 입력, 단독 보기, 필수 입력, 건너뛰기, 후속 질문, 되돌리기, 문장 복사, 두 번 눌러 기록 삭제, 칼럼 분류·안 읽음·담음 필터, 오늘의 글, 다른 글 뽑기, 읽기 완료, 말씨 정원, 글자 크기와 이전/다음 읽기를 지원합니다.

칼럼은 기존 10편의 요약과 원문 링크를 그대로 사용합니다. 기사 전문을 새로 수집하지 않습니다. 요청에 따라 익명 세션과 개인 시연용 서버 저장을 설명하는 문구는 UI에서 제거했습니다. 브라우저 쿠키를 지우면 해당 기록에 다시 접근할 수 없고, 다른 브라우저와 동기화되지 않습니다.

## 저장 구조와 검증

- `browsers`: 익명 토큰의 해시와 세션 정보.
- `intakes`: 대화 진행 상태·원문 답변·모델 메모리.
- `patient_states`: 현재 당사자/주변인 문맥과 모델 내부 메모리.
- `patient_state_revisions`: 답변·정정·모델 변경의 버전 이력.
- `records`: UI 결과 카드와 전체 대화 기록.
- `column_states`: 읽음·담음 상태.

상담·상태·이력·결과는 AES-256-GCM으로 암호화합니다. 기록 삭제는 연결된 대화와 상태 이력도 삭제합니다. PostgreSQL 데이터는 Docker 이름 있는 볼륨에 저장합니다. 세션은 기본 30일로 만료되며 만료 세션의 데이터는 이후 API 요청 때 정리합니다. 이는 개인 시연의 설정이며 실제 서비스 동의·보관 정책은 아직 확정하지 않았습니다.

```sh
npm run check
npm test
# 생성한 로컬 .env의 DB에 격리된 임시 테스트 스키마를 생성/제거
npm run test:integration
```

`npm test`는 `TEST_DATABASE_URL`이 없으면 PostgreSQL 테스트를 건너뜁니다. 모든 저장 검증은 `npm run test:integration`으로 실행합니다. 테스트에는 합성 데이터만 사용합니다.

[API 계약](docs/API.md) · [OpenAPI](docs/openapi.json) · [서버 이동 안내](docs/DOCKER_HANDOFF.md) · [검증 기록](docs/VALIDATION.md).
