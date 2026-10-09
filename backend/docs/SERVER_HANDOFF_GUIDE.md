# 말씨 백엔드 서버 접속·실행·이용 인계서

기준일: 2026-10-09, 한국 시간. 대상은 PR #1의 `feat/malssi-backend-dual-model` 브랜치입니다. 공개 운영 배포가 아닌 내부 개발용 v2 실행 절차입니다.

## 1. 구현 상태와 현재 서버 상태

현재 구현에는 구조화 문답, 동의·암호화 저장, 근거 기반 기억, 작업 큐, 로컬 모델 추출·가이드·검증, 삭제·복원 억제, v2 API가 있습니다. 환자 감정·위험 점수의 **매 턴 B→A 이중 모델은 설계 초안이며 아직 실행 기능이 아닙니다**. CPU/GPU 공통 전환 설정도 해당 후속 설계에 속합니다.

2026-10-09 15:27 KST에 아래 인계 절차를 서버에서 합성 데이터로 검증했습니다. API는 시험 후 종료했으며 기존 서비스를 변경하지 않았습니다.

| 구성 | 위치/상태 |
| --- | --- |
| SSH | `slim@165.194.161.61`, 포트 `20522` |
| 백엔드 작업 허용 루트 | `/home/slim/choieram/ys` |
| 현재 검증 소스 | `/home/slim/choieram/ys/malssi-v2-20261009/Backend` |
| 기존 v1 API | `127.0.0.1:9000`, `/health` 200 확인 |
| 기존 PostgreSQL | `127.0.0.1:5433`, 기존 계정 재사용·새 스키마로 분리 |
| 새 v2 개발 API | 이 문서에서 `127.0.0.1:19010` 사용, 현재 정지 |
| 선택적 테스트 모델 | `127.0.0.1:18011`, 현재 정지 |
| Node | `/home/slim/choieram/ys/hop_node_20261009/runtime/node-v24.19.0-linux-x64/bin/node` |
| GPU | 물리 GPU 1번 RTX 4090 24GB만 사용. GPU 0번은 다른 작업 사용 중 |

현재 main은 README 중심이므로 main에 바로 설치하거나 기존 저장소를 덮어쓰지 않습니다. 이 ZIP의 소스 또는 위 PR 브랜치를 사용합니다. ZIP에는 비밀번호, 실제 `.env`, API 키, SSH 개인키, DB dump, 모델 가중치, node_modules가 들어 있지 않습니다. 서버 접근 권한은 기존 계정 담당자로부터 별도로 받아야 합니다.

GitHub와 ZIP의 폴더명은 사용자 요청에 따라 소문자 `backend/`입니다. 기존 원격 검증 작업 디렉터리의 마지막 경로 `Backend`는 실제 확인된 대문자 이름이므로, 위 서버 경로를 이용할 때에는 대소문자를 그대로 입력합니다.

## 2. Windows에서 서버 접속

PowerShell에서 실행합니다.

```powershell
ssh -p 20522 slim@165.194.161.61
```

계정에서 허용된 SSH 키 또는 대화형 인증을 사용합니다. 비밀번호를 명령 인자나 파일에 적지 않습니다. `Permission denied`이면 서버 계정 권한을 확인해야 하며, 이 ZIP만으로 서버 로그인 권한이 생기지는 않습니다.

접속 후 서버에서 실행합니다.

```bash
cd /home/slim/choieram/ys
pwd -P
export PATH=/home/slim/choieram/ys/hop_node_20261009/runtime/node-v24.19.0-linux-x64/bin:$PATH
node --version
npm --version
ss -ltn
```

`pwd -P`가 지정된 루트인지 확인하고 Node는 v24.19.0 이상을 사용합니다. 시스템 전역 패키지·환경을 변경하지 않습니다. 기존 Jupyter 터널과 다른 모델 프로세스를 종료하지 않습니다.

## 3. 소스 준비: 기존 검증 소스 또는 ZIP

현재 서버의 검증 소스를 그대로 이용하려면 다음과 같습니다.

```bash
cd /home/slim/choieram/ys/malssi-v2-20261009/Backend
```

ZIP의 정확한 스냅샷을 별도로 설치하려면 Windows에서 ZIP을 원하는 폴더에 풉니다. 아래 `$packageRoot`는 압축 해제한 패키지의 실제 루트로 바꾸고, 새 원격 디렉터리 이름이 기존 자료와 겹치지 않게 정합니다.

```powershell
$packageRoot = 'C:\YOUR_PATH\말씨_백엔드_구현_명세_서버이용_20261009'
scp -P 20522 -r (Join-Path $packageRoot '02_백엔드\backend') slim@165.194.161.61:/home/slim/choieram/ys/malssi-handoff-source-20261009
```

위 원격 대상이 아직 없을 때 `backend` 디렉터리 자체가 `malssi-handoff-source-20261009`라는 이름으로 복사됩니다. 기존 대상을 재사용하면 하위 디렉터리 구조가 달라질 수 있으므로 새 경로를 사용하고 `package.json` 위치를 확인합니다.

```bash
cd /home/slim/choieram/ys/malssi-handoff-source-20261009
test -f package.json
export npm_config_cache=/home/slim/choieram/ys/malssi-handoff-source-20261009/.npm-cache
npm ci --ignore-scripts
npm run check
```

`npm ci`는 npm registry에 접근할 수 있어야 합니다. 모델이나 DB를 설치·초기화하는 명령은 아닙니다. 이미 검증 소스에 node_modules가 준비되어 있으면 재설치 없이 다음 단계로 진행할 수 있습니다.

이하 명령은 선택한 소스 디렉터리에 있는 상태에서 실행합니다. 현재 위치를 보관합니다.

```bash
export MALSSI_CODE="$PWD"
export MALSSI_STATE=/home/slim/choieram/ys/malssi-handoff-runtime-20261009
```

## 4. 비밀 설정 생성과 DB 준비

새 실행 환경은 기존 v1과 **다른 스키마**를 사용합니다. 기존 public 스키마에 새 마이그레이션을 적용하지 않습니다.

```bash
node scripts/prepare-handoff-env.mjs \
  "$MALSSI_STATE" malssi_handoff_demo_20261009
```

이 도구는 서버 안의 기존 DB 접속 설정을 읽고 새 디렉터리에 아래 파일을 mode 600으로 만듭니다. 실제 값을 화면에 출력하지 않습니다. 기존 디렉터리가 있으면 덮어쓰기를 거부하므로 이름을 새로 정하거나 이미 만든 환경을 그대로 재사용합니다.

| 파일 | 용도 |
| --- | --- |
| `runtime.env` | 제한 DB 계정, 독립 콘텐츠 암호화 키, 개발용 초대 코드, v2 API/worker 설정 |
| `migration.env` | 마이그레이션 계정과 지정 스키마. API에 전달하지 않음 |
| `model.env` | 기존 모델 파일·GPU 1 launcher 경로. 모델 API 키 자체 대신 키 파일 경로 |

`runtime.env`는 v2와 내부 draft 문항을 켜고 모델 실행은 끕니다. localhost SSH 터널용 HTTP 설정이므로 공개 배포용 설정으로 재사용하지 않습니다. 새 스키마에는 새 사용자·세션이 생기므로 기존 v1 로그인 계정은 자동으로 이관되지 않습니다. 키 파일을 잃으면 해당 암호문을 복호화할 수 없으므로 실행 환경은 별도로 안전하게 보관합니다.

이어서 스키마 마이그레이션과 제한 역할 권한을 적용합니다.

```bash
node --env-file="$MALSSI_STATE/migration.env" scripts/migrate.ts
node --env-file="$MALSSI_STATE/migration.env" scripts/grant-runtime.ts
```

각각 `PostgreSQL migration verified.`, `Runtime database privileges applied.`가 나오는지 확인합니다. 마이그레이션 오류는 계정·스키마·checksum을 확인하여 해결하고 기존 SQL 파일이나 DB를 초기화하지 않습니다.

## 5. 모델 없이 v2 API 실행

터미널 A에서 실행합니다. foreground 실행이므로 이 터미널을 열어 둡니다.

```bash
node --env-file="$MALSSI_STATE/runtime.env" src/server.ts
```

별도 SSH 터미널 B에서 확인합니다.

```bash
curl -sS http://127.0.0.1:19010/health/live
curl -sS -i http://127.0.0.1:19010/health/ready
curl -sS http://127.0.0.1:19010/help/safety
```

예상 결과는 `/health/live` 200, `/health/ready` 503입니다. **draft 문항이므로 ready 503은 출시 미승인 상태를 나타내며, 이 경우 재시작으로 해결되지 않습니다.** 모델이 꺼져 있어도 구조화 문답·동의·저장·수정·삭제 API를 사용할 수 있습니다. 모델 가이드는 사용할 수 없습니다.

## 6. 내 PC에서 서버 API 접속

Windows PowerShell에 터널 전용 창을 하나 열고 실행합니다.

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 19010:127.0.0.1:19010 -p 20522 slim@165.194.161.61
```

이 창을 켜 둔 채 로컬 브라우저 또는 API 클라이언트에서 아래 주소를 이용합니다.

- `http://127.0.0.1:19010/health/live` — 생존 확인
- `http://127.0.0.1:19010/openapi-v2.json` — Postman 등에서 가져올 API 명세
- `http://127.0.0.1:19010/help/safety` — 공개 도움 경로

**현재 `/`의 내장 화면은 v1 점검 페이지입니다. v2 화면이 아니므로 v2 문답은 API 예제나 별도 프론트에서 이용합니다.** 서버의 19010 포트를 외부에 직접 공개할 필요가 없습니다. 이 터널은 기존 8888 터널과 별개입니다.

## 7. 실제로 동작하는 문답 예제

터미널 B에서 소스·Node·환경 경로를 다시 설정하고 실행합니다.

```bash
cd /home/slim/choieram/ys/malssi-v2-20261009/Backend
# ZIP 소스를 설치했다면 위 cd를 해당 경로로 바꿉니다.
export PATH=/home/slim/choieram/ys/hop_node_20261009/runtime/node-v24.19.0-linux-x64/bin:$PATH
export MALSSI_STATE=/home/slim/choieram/ys/malssi-handoff-runtime-20261009
node --env-file="$MALSSI_STATE/runtime.env" \
  examples/v2-synthetic-demo.mjs --synthetic-demo
```

예제는 합성 계정을 생성하여 가입, 로그인, 동의, 프로젝트·상담 생성, N00 답변, 다음 질문 T01 조회까지 수행하고 **자신이 방금 만든 합성 계정만 삭제**합니다. 실제 계정이나 환자 자료를 입력하지 않습니다. 출력에 `passed:true`, `synthetic_account_deleted:true`, `next_question_id:"T01"`이 있으면 성공입니다. 비밀번호·초대 코드·토큰은 출력하지 않습니다. 반복 실행하면 인증 속도 제한에 걸릴 수 있으므로 연속 호출은 피합니다.

직접 연동할 때는 다음 순서입니다. 모든 JSON의 UUID 예시는 새 UUID로 바꾸고, 서버가 반환한 ID·버전을 사용합니다.

| 순서 | 요청 | 핵심 입력/응답 |
| --- | --- | --- |
| 가입 | `POST /api/auth/register` | email, 12~128자 password, invite_code → token |
| 로그인 | `POST /api/auth/login` | email, password → token |
| 동의 | `POST /api/v2/consents` | request_id, version, purposes |
| 프로젝트 | `POST /api/v2/projects` | request_id, 선택적 title/alias → project_id |
| 상담 | `POST /api/v2/projects/{id}/conversations` | request_id, goal=`understand` → conversation_id |
| 현재 질문 | `GET /api/v2/conversations/{id}` | question, resource_revision |
| 답변 | `POST /api/v2/conversations/{id}/turns` | 아래 JSON → 저장 결과·새 revision |
| 다음 질문 | `GET /api/v2/conversations/{id}` | 실제 질문 본문·선택지 조회 |

로그인 뒤 인증은 `Authorization: Bearer <token>` 헤더를 사용합니다. 브라우저 쿠키 쓰기에는 허용된 `Origin`이 필요합니다. 실제 사용자의 동의 값은 UI에서 각각 선택받아야 하며 합성 예제의 동의 값을 그대로 적용하지 않습니다.

```json
{
  "request_id": "새 UUID",
  "version": "malssi-consent-v1",
  "purposes": {
    "service_processing": true,
    "sensitive_processing": true,
    "history_storage": false,
    "cross_session_memory": false
  }
}
```

첫 질문 N00에 대한 답변 예시입니다. 뒤 문항은 각 스냅샷의 입력 형식을 따릅니다.

```json
{
  "request_id": "새 UUID",
  "expected_revision": 0,
  "action": "answer",
  "payload": {
    "question_instance_id": "GET에서 받은 question.id",
    "question_id": "N00",
    "question_version": "GET에서 받은 question.question_version",
    "disposition": "answered",
    "value": {"text": "가족"}
  }
}
```

같은 요청의 통신 재시도에는 같은 request_id와 같은 본문을 사용합니다. 409 revision 충돌은 현재 상담을 다시 읽고 새 요청으로 처리합니다. 모델 실행을 켠 경우 자유문/가이드 요청은 202와 run_id를 반환할 수 있으며, `GET /api/v2/runs/{run_id}` 또는 상담 events SSE로 완료를 확인합니다. SSE에는 원문 대신 자원 참조가 오므로 최종 본문은 조회 API로 읽습니다. 자세한 액션은 `openapi-v2.json`, `client/v2.ts`에 있습니다.

## 8. 선택: 기존 모델을 GPU 1번에 연결

이 절차는 **기존 추출·가이드 파이프라인**을 시험할 때 사용합니다. 새 이중 평가 모델을 켜는 절차가 아닙니다. 해당 모델은 기본적으로 정지 상태이며 이 인계 검증에서는 다시 시작하지 않았습니다. 실행이 필요한 사용자가 GPU 1번의 사용 가능 여부를 확인하고 실행합니다.

```bash
nvidia-smi --query-gpu=index,name,memory.total,memory.used --format=csv
ss -ltn
```

GPU 1번이나 18011 포트가 이미 사용 중이면 해당 작업을 종료하지 말고 조정합니다. 별도 터미널 C에서 소스 경로·PATH·MALSSI_STATE를 같은 값으로 지정한 뒤 실행합니다.

```bash
node --env-file="$MALSSI_STATE/model.env" scripts/serve-gpu1.mjs
```

launcher가 물리 GPU 1번을 UUID로 선택합니다. `CUDA_VISIBLE_DEVICES` 격리 후 프로세스 안에서는 cuda:0으로 보일 수 있습니다. GPU 0번으로 자동 대체하지 않습니다. 가중치와 런타임은 기존 `/home/slim/choieram/ys/hop-serving` 파일을 사용하며 다운로드하지 않습니다.

이어서 터미널 A의 API를 Ctrl+C로 종료하고 모델 실행 플래그를 켜서 다시 실행합니다.

```bash
HOP_V2_MODEL_ENABLED=true node --env-file="$MALSSI_STATE/runtime.env" src/server.ts
```

터미널 D에서는 같은 소스·Node·환경 경로를 설정한 다음 worker를 실행합니다.

```bash
HOP_V2_MODEL_ENABLED=true node --env-file="$MALSSI_STATE/runtime.env" scripts/malssi-worker.ts
```

`GET /api/v2/capabilities`의 `model_execution_enabled:true`를 확인합니다. `personalized_guidance:false`, `model_validation:not_release_validated`는 출시 검증 미완료를 뜻합니다. API만 켜고 worker를 실행하지 않으면 작업이 대기합니다. 모델은 `/v1/chat/completions`와 `/tokenize`가 필요합니다.

## 9. 종료·재접속·운영 전환

foreground 실행 창에서 자신이 실행한 worker, API, 모델 순서로 Ctrl+C를 보내 정상 종료합니다. 터널도 해당 창에서 Ctrl+C로 종료합니다. 기존 v1·PostgreSQL·다른 모델을 종료하는 `pkill`, 서버 재시작, DB 초기화 명령은 필요하지 않습니다.

재접속 시 같은 코드와 runtime.env를 사용합니다. 이미 만든 상태 디렉터리에 환경 생성기를 다시 실행하지 않습니다. 모델을 끄고 이용하려면 worker/모델을 종료하고 API를 기본 runtime.env로 재시작합니다.

보관 작업은 `node --env-file="$MALSSI_STATE/runtime.env" scripts/malssi-retention.ts`이며 실제 만료 데이터를 변경하므로 운영 보관 정책이 확정된 실행 환경에서만 사용합니다. 백업·삭제 원장·복원 절차는 `MALSSI_IMPLEMENTATION.md`를 확인합니다. 이 인계에는 운영 DB dump나 암호화 키 백업을 포함하지 않습니다.

현재 서버에는 Docker가 없으므로 이 문서의 기본 경로는 Node 직접 실행입니다. ZIP에 있는 Compose는 기존 v1 배포 예제이며 기본 포트 9000/5433이 현재 서비스와 충돌합니다. 그대로 `docker compose up`하여 v2가 배포된다고 보지 마세요. v2 운영 Compose/worker 서비스, HTTPS, 승인 카탈로그, 관리자 권한, 독립 백업과 부하 검증은 별도 작업입니다.

## 10. 문제 해결

| 증상 | 확인할 사항 |
| --- | --- |
| SSH 접속 실패 | IP·20522 포트·계정 권한·네트워크 |
| 환경 생성기가 기존 경로 거부 | 기존 키를 보존하고 해당 runtime.env 재사용 또는 새 이름 사용 |
| Node에서 `.ts` 실행 불가 | 지정한 Node 24 PATH인지 확인 |
| `permission denied`/`BYPASSRLS` 관련 오류 | runtime에 migration 계정을 넣지 않았는지, db grant 실행 여부 |
| migration checksum 오류 | 코드 스냅샷과 적용 SQL 일치 여부. 기존 SQL/DB를 지우지 않음 |
| 19010 포트 점유 | `ss -ltn` 확인. 자신이 시작한 API인지 확인 후 재사용 |
| localhost 접근 실패 | API 실행 터미널과 SSH 터널이 모두 살아 있는지 확인 |
| ready 503 | 현재 draft 카탈로그에서는 예상 상태 |
| 가입 403 | 생성된 실행 환경의 초대 코드·가입 허용 설정 확인 |
| API 401/403 | 로그인 토큰 또는 쿠키/Origin·동의 상태 확인 |
| 409 | 최신 revision 조회. 동일 멱등키에 다른 본문 사용 금지 |
| 모델 작업 대기/실패 | 모델 프로세스·18011 포트·API 키·worker 실행·모델 활성 플래그 확인 |
| 내장 화면과 v2 질문이 다름 | 내장 화면은 v1용. v2 API 또는 별도 프론트 이용 |

## 11. 검증 근거와 문서 위치

기존 코드의 GitHub CI 전체 171개 테스트, 타입 검사, 의존성 감사, Docker 빌드·기동이 통과했습니다. 이 인계에서는 추가로 환경 파일 0600 권한·기존 설정 덮어쓰기 방지, 별도 스키마 migrate/grant, v2 API 생존과 예상 draft readiness, 합성 가입/로그인/문답/삭제, API 종료 및 기존 9000 API 정상 상태를 확인했습니다.

- 구현 범위·미완료 항목: `MALSSI_IMPLEMENTATION.md`
- 기존 테스트·GPU 실측: `MALSSI_VALIDATION.md`
- 이중 모델 후속 설계: `DUAL_MODEL_PIPELINE_DESIGN.md`
- 원본 명세·문항: `MALSSI_BACKEND_SPEC_V1.md`, `MALSSI_QUESTIONNAIRE_V1.json`
- GitHub PR: https://github.com/seonizz/HOP_Biohealth_AI-Challenge/pull/1

이 문서의 접속 정보는 팀 내부 인계용이며 인증 비밀값은 포함하지 않습니다. 패키지의 `manifest.json`과 `SHA256SUMS.txt`로 전달받은 소스·명세 파일의 무결성을 확인할 수 있습니다.
