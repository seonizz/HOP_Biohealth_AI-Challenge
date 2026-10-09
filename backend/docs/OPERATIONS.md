# 실행과 운영

## 구성

API는 Node.js 24.19.0 이상에서 TypeScript를 직접 실행합니다. PostgreSQL 16에는 사용자·세션·프로젝트·대화·요청 결과·프로필 버전을 저장합니다. 모델 서버는 별도 프로세스이며 OpenAI 호환 API 또는 Ollama API를 제공합니다.

`compose.yaml`은 Linux 서버용입니다. API와 Caddy는 host networking으로 서버의 로컬 모델에 접근하며, API는 `127.0.0.1:9000`, PostgreSQL은 `127.0.0.1:5433`에만 노출합니다. Caddy가 HTTPS 요청을 받아 API로 전달합니다. 현재 실행 중인 API·DB가 이 포트를 사용한다면 새 Compose 스택을 동시에 실행하지 마세요.

모델 다운로드·빌드·GPU 할당은 이 배포 파일에서 수행하지 않습니다. 연결할 모델 주소와 모델 ID는 별도로 준비합니다. 제목 생성 서버는 선택 사항입니다.

## 환경 준비

```sh
npm ci
node scripts/init-env.mjs --origin https://api.example.com
```

이 명령은 저장소 안의 `.env`만 새로 만들며 기존 파일을 덮어쓰지 않습니다. DB 역할별 비밀번호와 팀 초대 코드를 생성하고 파일 권한을 600으로 설정합니다. 생성한 파일의 실제 값을 공개 채팅·소스·로그에 붙여 넣지 않습니다.

`.env`에서 다음 항목을 지정합니다.

| 설정 | 용도 |
| --- | --- |
| `HOP_STATE_DIR` | PostgreSQL·Caddy 인증서·백업의 절대 경로. 저장소 밖의 전용 운영 폴더 |
| `DATABASE_URL` | API용 `hop_app` 연결. 스키마 변경 권한 없음 |
| `HOP_MIGRATION_DATABASE_URL` | `hop_migrator` 연결. 마이그레이션에만 사용 |
| `HOP_PUBLIC_ORIGIN` | 실제 API origin. 경로·끝 슬래시 없는 정확한 주소 |
| `HOP_DOMAIN` | Caddy가 인증서를 발급할 DNS 호스트명 |
| `HOP_CORS_ORIGINS` | 허용할 프론트 origin의 쉼표 목록. 와일드카드 사용 안 함 |
| `HOP_COOKIE_SECURE` | HTTPS에서 `true` |
| `HOP_COOKIE_SAME_SITE` | 기본 `strict`. 다른 site 쿠키는 `none`과 Secure 필요 |
| `HOP_TRUST_PROXY` | loopback reverse proxy를 사용하는 경우 `true` |
| `HOP_ALLOW_REGISTRATION` | 가입 접수 시에만 `true`; 초대 코드는 항상 필요 |
| `HOP_INVITE_CODE` | 팀 가입용 비밀 코드 |
| `HOP_LLM_BASE_URL` | OpenAI 호환 서버는 예: `http://127.0.0.1:8001/v1` |
| `HOP_LLM_BACKEND` | `openai` 또는 `ollama`; 여기서 openai는 HTTP 규격 이름 |
| `HOP_LLM_MODEL` | 서버의 모델 목록에 있는 정확한 ID |
| `HOP_LLM_API_KEY` | 내부 모델 서버 인증 키 |
| `HOP_LLM_TIMEOUT_MS` | 모델 호출당 제한. 기본 180000ms |
| `HOP_TITLE_BASE_URL`, `HOP_TITLE_MODEL` | 선택적 제목 생성 모델 |
| `HOP_KNOWLEDGE` | 사용 권한을 확인한 지식 JSONL의 절대 경로 |
| `HOP_REQUIRE_KNOWLEDGE` | `true`이면 지식 파일이 없거나 비어 있을 때 시작 거부 |

환경 생성기는 같은 운영 DB에 사용할 서로 다른 세 역할의 비밀번호를 생성합니다. Compose를 쓰면 초기 PostgreSQL에 해당 역할을 만듭니다. 외부 DB를 사용한다면 환경 파일의 연결 URL을 실제 역할 정보로 교체하고, 아래 권한 구성을 DB 관리자에게 적용받습니다.

## Linux Compose 실행

1. DNS의 A/AAAA 레코드를 서버로 연결합니다. HTTPS를 사용할 때 서버가 80·443으로 접근 가능해야 합니다.
2. `HOP_STATE_DIR`을 기존 데이터와 겹치지 않는 경로로 지정합니다. 사용자별 작업 루트가 정해진 서버에서는 이 디렉터리도 그 루트 안에 둡니다.
3. 사용 권한이 있는 지식 JSONL을 준비하고 `HOP_KNOWLEDGE`에 지정합니다. API 컨테이너의 UID 1000이 파일을 읽을 수 있도록 파일/상위 디렉터리 권한을 설정합니다. 파일은 읽기 전용으로 마운트됩니다.
4. 모델 URL과 인증을 확인합니다.

```sh
docker compose config --quiet
docker compose build
docker compose up -d postgres
docker compose run --rm migrate
docker compose up -d api
curl --fail http://127.0.0.1:9000/health
curl --fail http://127.0.0.1:9000/ready
docker compose --profile https up -d caddy
```

컨테이너의 `/health` 검사는 API 생존 여부를 확인합니다. DB 또는 모델 장애가 있을 때 API를 반복 재시작하는 것을 피하기 위해 서비스 준비 상태는 별도 `/ready`로 감시합니다. `/ready`가 성공해도 실제 구조화 출력·코칭 검증은 별도 live check로 확인합니다.

Caddy 설정은 기본적으로 API의 내장 점검 페이지까지 전달합니다. 별도 프론트 배포에서는 프론트 호스트의 `/api/*`와 `/openapi.json`을 백엔드로 프록시하거나, 프론트 가이드에 따라 CORS를 설정합니다. 브라우저의 제3자 쿠키 차단을 피하려면 같은 site 또는 같은 origin 구성을 사용합니다.

모델 요청은 최대 300초의 한 턴 제한을 사용합니다. Caddy의 응답 헤더 제한은 330초입니다. 사용자 입력이 모델 실행 중이면 새 메시지를 겹쳐 보내지 않고, 응답 또는 busy 오류를 처리합니다.

## PostgreSQL 역할과 마이그레이션

- `hop_admin`: 새 DB/역할을 초기 구성하는 관리자. API에 전달하지 않습니다.
- `hop_migrator`: 스키마와 테이블의 소유자. 마이그레이션 작업에만 사용합니다.
- `hop_app`: 서비스 테이블의 SELECT/INSERT/UPDATE/DELETE 및 시퀀스 사용 권한. 마이그레이션 기록은 읽기만 가능합니다.

`deploy/init-postgres.sh`는 공식 PostgreSQL 이미지가 **처음 생성하는 비어 있는 DB 디렉터리에서만** 실행됩니다. 기존 DB에 환경 변수만 바꿔도 기존 비밀번호가 바뀌지는 않습니다. 비밀번호 교체는 DB에서 변경한 뒤 연결 설정을 함께 갱신합니다.

```sh
npm run migrate
npm run db:grant
```

마이그레이션은 트랜잭션과 advisory lock을 사용하고 적용한 파일의 SHA-256을 기록합니다. 이미 적용한 SQL 파일을 편집하면 체크섬 불일치로 시작을 거부합니다. `HOP_MIGRATE_ON_START=false`인 API는 필요한 마이그레이션이 준비되었는지 확인만 합니다.

DB 쿼리는 statement 15초·lock 5초·idle transaction 15초 제한을 사용합니다. 테스트는 별도 임의 스키마를 생성하므로 운영 API 역할 대신 테스트 DB의 전용 계정을 사용합니다.

## 업데이트와 종료

수정된 소스를 검사한 뒤 이미지를 빌드하고 마이그레이션을 먼저 실행합니다.

```sh
npm run check
npm run test:ci
docker compose build
docker compose run --rm migrate
docker compose up -d api
```

API는 SIGTERM을 받으면 새 연결을 닫고 최대 30초 동안 진행 중인 작업을 기다립니다. 종료 도중 응답을 받지 못한 메시지는 로그인 후 **같은 request_id와 같은 본문**으로 조회 겸 재시도합니다. 응답을 받지 못했다는 사실만으로 저장 실패를 확정하지 않습니다.

프로젝트 수정은 revision을 확인하고 한 턴을 원자적으로 저장합니다. API는 단일 인스턴스 운영을 기준으로 합니다. 프로세스별 속도 제한과 모델 동시 실행 제한을 사용하므로 같은 DB를 공유하는 여러 API 복제본으로 늘리기 전에 공유 제한기와 작업 조정을 추가해야 합니다.

이전 이미지로 되돌릴 때도 DB 파일은 그대로 보존합니다. 새 마이그레이션을 이전 코드가 이해하는지 확인하고, 호환되지 않는 경우 검증된 백업을 새 DB로 복원해 전환합니다.

## 백업과 복원

PostgreSQL 서버와 같은 메이저 버전의 `pg_dump`, `pg_restore`를 준비합니다. 서버에서 포터블 실행 파일을 사용하면 `HOP_PG_DUMP`, `HOP_PG_RESTORE`에 절대 경로를 지정할 수 있습니다.

```sh
node --env-file=.env scripts/backup.mjs
```

백업은 `HOP_STATE_DIR/backups` 아래에 mode 600의 새 custom archive를 만듭니다. 실패한 출력은 `.partial`로 보존하고 정상 백업 이름으로 바꾸지 않습니다. 성공 출력의 `archiveVerified:true`는 목차 검증이며 전체 복원 검증을 의미하지 않습니다.

복원은 운영 DB를 덮어쓰지 말고 별도로 만든 빈 DB에서 실행합니다. 접속 비밀번호는 환경 변수나 권한이 제한된 pgpass 파일로 제공합니다.

```sh
# PGHOST/PGPORT/PGUSER/PGPASSWORD는 별도로 설정
# hop_restore_check는 관리자가 미리 만든 빈 검증용 DB
pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname=hop_restore_check /absolute/path/to/backup.dump
```

복원 후 스키마 체크섬, 테이블 건수, 프로젝트의 메시지 순서와 외래키를 확인합니다. 검증된 복원 DB에 런타임 역할 권한을 적용하고 별도 포트에서 API를 점검한 뒤 전환합니다. 백업 보관 기간과 접근 권한은 팀 운영 정책에 맞춰 정하며, 백업 자동 삭제 명령은 제공하지 않습니다.

## 상태와 로그

`/health`는 인증 없이 API가 응답하는지, `/ready`는 DB와 실제 모델 목록을 확인합니다. `/ready` 실패 사유를 구분해 API·DB·모델 중 해당 서비스를 점검합니다. Compose 로그는 서비스별 10MiB 파일 3개로 제한합니다.

앱 오류 로그에는 입력 원문·모델 원문·비밀번호·토큰·DB URL을 기록하지 않습니다. 장애 조사에서 원문이 필요하더라도 저장소나 CI 산출물로 내보내지 않습니다. [테스트 가이드](TEST_PROMPTS.md)의 live check 결과는 계수와 상태 위주로 기록합니다.

## 참고

- [Node 공식 이미지](https://hub.docker.com/_/node)
- [PostgreSQL 공식 이미지와 초기화 규칙](https://hub.docker.com/_/postgres)
- [Caddy reverse_proxy 설정](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [GitHub Actions PostgreSQL 서비스](https://docs.github.com/en/actions/tutorials/use-containerized-services/create-postgresql-service-containers)
