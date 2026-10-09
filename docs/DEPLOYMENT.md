# 배포 안내

## 1. 구성과 사전 조건

웹은 Caddy가 프론트 정적 파일을 제공하고 `/api/auth/*`, `/api/v2/*`, `/health/*`, `/help/safety`를 API에 전달합니다. 브라우저와 API는 같은 origin을 사용합니다. 기본 Compose는 DB와 API 포트를 외부에 공개하지 않습니다.

PostgreSQL 관리자, 마이그레이션 역할, 실행 역할은 분리됩니다. API·worker는 테이블 소유자가 아니며 RLS를 우회하지 않습니다. 마이그레이션은 원본 001~004를 유지하고 시연 계정 만료용 005를 추가합니다. 새 설치용 DB 볼륨을 사용하며 기존 서버의 DB·모델·학습 작업을 자동 변경하지 않습니다.

Node 24.19.0 이상과 Docker Compose 2.24.4 이상을 권장합니다. Docker 이미지·프로덕션 패키지 잠금 파일을 포함합니다. `npm ci`는 로컬 개발·브라우저 테스트에 필요하며 기본 Docker 배포는 컨테이너 안에서 의존성을 설치합니다.

## 2. 로컬 내부 검토

```sh
npm run setup -- --origin http://localhost:8080
docker compose up --build -d
docker compose ps
npm run doctor
```

초기 설정은 `HOP_V2_ALLOW_DRAFT=true`와 `HOP_DEMO_ENABLED=true`를 명시하는 내부 검토 모드입니다. 첫 화면에서 가입 없이 바로 체험할 수 있습니다. 시연 계정은 방문자별로 분리하고 24시간 후 접근을 차단하며 시간당 정리 작업에서 삭제합니다. 시연 화면은 실제 개인정보 대신 가상 사례만 입력하도록 안내합니다. 기존 사용자별 초대 계정 가입도 가능하며 초대 코드는 생성된 `.env`에서 확인합니다. 등록이 끝나면 `HOP_ALLOW_REGISTRATION=false`로 바꾸고 `docker compose up -d api`로 신규 가입을 닫을 수 있습니다. 시연 진입을 닫으려면 `HOP_DEMO_ENABLED=false`로 변경합니다.

`.env`를 보존하세요. 특히 `HOP_CONTENT_KEY`를 잃으면 저장된 내용은 복구할 수 없습니다. 기존 DB 볼륨을 유지하면서 DB 비밀번호만 새로 생성하면 접속이 실패합니다. `setup`은 기존 파일을 덮어쓰지 않습니다.

## 3. 실제 로컬 모델 연결

필요한 모델 서버 규격은 **llama.cpp 호환 `/tokenize`와 `/v1/chat/completions`의 JSON schema 출력**입니다. 모델 다운로드·학습·추론 프로세스 시작은 이 배포가 수행하지 않습니다. 기존 모델 서버를 운영자가 준비한 후 연결합니다. 클라우드 OpenAI 계정이나 OpenAI API 키는 필요하지 않습니다.

새 환경에서는 다음처럼 생성할 수 있습니다. 모델명은 서버가 실제 제공하는 ID로 바꿉니다.

```sh
npm run setup -- --origin http://localhost:8080 --model-url http://host.docker.internal:18011/v1 --model ACTUAL_MODEL_ID
docker compose up --build -d
```

이미 `.env`가 있으면 파일에서 다음 항목을 설정합니다. 다른 비밀값을 재생성하지 마세요.

```dotenv
COMPOSE_PROFILES=model
HOP_V2_MODEL_ENABLED=true
HOP_LLM_BASE_URL=http://host.docker.internal:18011/v1
HOP_LLM_MODEL=ACTUAL_MODEL_ID
HOP_LLM_API_KEY=EXISTING_LOCAL_SERVER_KEY_IF_REQUIRED
HOP_MODEL_ALLOWED_ORIGINS=http://host.docker.internal:18011
HOP_MODEL_CONTEXT_SIZE=16384
```

`HOP_MODEL_ALLOWED_ORIGINS`는 컨테이너가 접근할 **운영자 지정 모델 origin만** 정확하게 허용합니다. 클라이언트 입력으로 변경할 수 없습니다. 리다이렉트, URL 안의 자격 증명, query와 fragment는 거부합니다. 모델 서버에 내부 키가 있다면 `.env`에만 보관합니다. 실제 문맥 크기에 맞춰 `HOP_MODEL_CONTEXT_SIZE`를 조정합니다.

Docker Desktop은 `host.docker.internal`로 호스트 모델을 연결할 수 있습니다. Linux에서 모델이 `127.0.0.1`에만 바인딩되었다면 아래 구성을 사용하세요. 모델을 외부에 노출할 필요가 없습니다.

```sh
docker compose -f compose.yaml -f compose.model-host.yaml --profile model up --build -d
```

Linux override는 worker만 호스트 네트워크로 연결하고, 이 통합본의 DB를 호스트 루프백 `15433` 포트에 공개합니다. 기존 DB `5433`이나 API `9000`을 덮어쓰지 않습니다. 모델 기본 주소는 `http://127.0.0.1:18011/v1`이며 `.env`의 `HOP_HOST_MODEL_URL`로 변경할 수 있습니다. `15433`이 사용 중이면 override의 포트와 worker `DATABASE_URL`을 함께 조정합니다.

연결 후 `docker compose ps worker`와 worker 로그에서 기동 상태를 확인합니다. 합성 계정을 만들어 답변을 저장하고 “말하는 방법 정리하기”가 검증된 가이드를 반환하는지 운영 모델로 점검합니다. 모델을 켰더라도 서버가 응답하지 않거나 검증에 실패하면 UI에 실패 상태가 나타나며 가짜 결과로 대체하지 않습니다. 기본 동시 실행 슬롯은 1개입니다.

## 4. 서버 HTTPS

서버로 소스 또는 제공 ZIP을 복사하고 Docker를 준비합니다. 외부 DNS의 A/AAAA 레코드를 해당 서버로 설정하고 필요한 80/443 포트를 열어 둡니다. 다음 도메인은 예시입니다.

```sh
npm run setup -- --origin https://malssi.example.com --mode internal --model-url http://127.0.0.1:18011/v1 --model ACTUAL_MODEL_ID
docker compose -f compose.yaml -f compose.model-host.yaml --profile model up --build -d
node scripts/doctor.mjs https://malssi.example.com
```

이때 설정 도구가 Caddy 도메인, secure cookie, 공개 HTTP/HTTPS 포트를 함께 구성합니다. Caddy가 실제 DNS와 접근 가능한 ACME 환경에서 인증서를 발급합니다. 내부 검토 서비스는 조직 VPN·방화벽 등으로 접근 대상을 제한하고 계정 초대를 사용하세요. 로컬 검증은 공개 인증서 발급 성공을 의미하지 않습니다.

공개 출시에는 원본 카탈로그의 실제 권리·콘텐츠 검토와 게시 절차가 선행되어야 합니다. `--mode release` 또는 `HOP_V2_ALLOW_DRAFT=false`는 승인되지 않은 카탈로그 이용을 차단합니다. **통합 작업을 위해 draft를 published로 바꾸거나 검토 증빙을 만들어 넣지 않았습니다.**

## 5. 운영과 백업

```sh
docker compose ps
docker compose logs --tail 80 api worker retention
npm run backup
docker compose down
```

일반 로그에는 대화 본문이나 키를 추가하지 마세요. 기본 백업 도구는 `.runtime/backups`에 PostgreSQL custom dump를 만들고 임시 기록의 복호화 키 테이블은 제외합니다. 출력 파일이 이미 있으면 덮어쓰지 않습니다. 이 dump에는 계정 관련 메타데이터가 있으므로 백업 파일 전체를 별도 암호화·접근 제한·보관 주기 정책으로 관리해야 합니다. `.env`와 콘텐츠 키는 DB 백업과 분리 보관합니다.

삭제 후의 옛 백업을 바로 서비스에 연결하면 안 됩니다. 최신 삭제 원장을 독립적으로 내보내고, `HOP_RESTORE_PENDING=true` 상태에서 복원한 뒤 삭제 원장 재적용·검증이 필요합니다. 기존 도구의 절차는 `backend/docs/MALSSI_IMPLEMENTATION.md`와 `backend/scripts/malssi-deletion-ledger.ts`를 참고하세요. 실제 운영 백업 복원 연습은 이번 로컬 테스트와 별도입니다.

`retention` 컨테이너는 시간마다 만료 기록을 정리합니다. worker는 `model` 프로필에서만 시작하며, 종료 시 진행 중 요청을 정리할 시간을 둡니다. 업데이트는 `docker compose up --build -d`로 수행합니다. DB 마이그레이션이 포함된 변경은 먼저 백업하고 이전 소스와 이미지를 보관하세요. 이전 이미지로 돌아간다고 DB 스키마가 자동으로 되돌아가지는 않습니다.

## 6. 상태 구분과 장애 확인

| 현상 | 확인 사항 |
| --- | --- |
| 웹 502 | `api` health와 DB 마이그레이션 결과 |
| 가입 실패 | 초대 코드, 등록 허용 값, 사용한 origin이 `.env`와 같은지 |
| 로그인 후 문항 이용 차단 | 동의 상태, v2 설정, draft 내부 허용 또는 게시된 카탈로그 |
| 가이드 버튼 없음 | 기본 무모델 설정. 실제 모델 설정 후 API 재기동 필요 |
| 대기 후 가이드 실패 | worker 기동, 모델 주소·ID·내부 키, tokenize 지원, 문맥 크기 |
| `/health/ready` 503 | 현재 원본 draft에서는 의도된 출시 차단. API 고장과 구분 |
| 리비전 충돌 | 다른 창의 변경을 새로 불러온 뒤 정정. 입력을 무조건 덮어쓰지 않음 |
| Windows → Linux DB 초기화 실패 | `.sh` 파일이 LF인지 확인. `.gitattributes`에 LF를 고정했음 |

현재 HTTP 요청 제한은 API 프로세스 단위이며 Caddy 뒤의 연결은 프록시 주소로 집계됩니다. 팀 내부 파일럿 범위를 넘는 운영에서는 신뢰할 프록시 주소 설정, 다중 API 인스턴스의 공용 rate limit, 부하/SLO 검증이 추가로 필요합니다.
