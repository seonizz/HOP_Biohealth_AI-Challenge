# 앱과 DB를 다른 장비로 옮기기

현재 임시 테스트 구성은 native Ollama `gemma4:12b` 관계 에이전트입니다. 최종 목표 모델은 31B입니다. 설치·모델 설정은 [앱 실행](../README.md)을 따르고, 아래는 장비 이동에 필요한 차이만 설명합니다. 명령은 양쪽 장비의 `말씨/app/`에서 실행합니다.

## 모델과 앱 연결

Docker·Compose가 설치된 대상 장비에 소스와 비공개 `.env`를 옮깁니다. 기존 DB 암호와 `CONTENT_KEY`를 보존합니다. `MODEL_BASE_URL`은 호스트의 Node.js 실행용 주소이며, Docker는 loopback 주소를 `host.docker.internal`로 변환합니다. Compose의 `host-gateway` 매핑은 Linux도 지원합니다. 대상 컨테이너에서 다른 주소를 써야 할 때만 `MODEL_DOCKER_BASE_URL`을 지정합니다. 검토와 별도 기관 안내 API도 각각 `MODEL_REVIEW_DOCKER_BASE_URL`, `REFERRAL_MODEL_DOCKER_BASE_URL`로 재정의할 수 있습니다. 호스트의 모델 API는 컨테이너에서 접근 가능하게 실행되어 있어야 하며, 앱은 모델 서비스나 방화벽을 자동 변경하지 않습니다.

새 로컬 설치의 `MODEL_STREAM_COMPLETE_JSON=true`는 `MODEL_STREAM_JSON=true`인 로컬 API에서 완성된 JSON을 수신한 뒤 전송을 끝내고 기존 전체 검증·독립 검토를 수행합니다. 일반 API나 비스트리밍 설정으로 옮길 때는 두 옵션을 `false`로 설정합니다. Compose에서 생략한 완료 옵션은 `false`이며, 별도 검토·기관 안내 API는 `MODEL_REVIEW_STREAM_COMPLETE_JSON`, `REFERRAL_MODEL_STREAM_COMPLETE_JSON`을 각각 명시해야 합니다. 기존 `.env`를 사용하는 plain setup은 이 옵션을 자동으로 추가하지 않습니다.

목표 31B로 전환할 때는 사용할 모델 API와 필요한 SSH 터널을 준비합니다. 과거 Mac 터널의 `127.0.0.1:18080`·`host.docker.internal:18080`은 현재 12B 기본 주소가 아닙니다. 학습 경로는 [데이터와 연구](../../docs/current/데이터와_연구.md)에 구분합니다.

기본 Compose는 API와 DB를 호스트 `127.0.0.1`에만 노출합니다. 원격 화면을 로컬에서 보려면 다음처럼 전달합니다.

```sh
ssh -L 9000:127.0.0.1:9000 user@server
```

브라우저는 `http://127.0.0.1:9000`에 접속하고 로컬 `PUBLIC_ORIGIN`을 유지할 수 있습니다. 외부 도메인으로 제공할 때는 앱 Origin·허용 Origin과 HTTPS 프록시를 실제 주소에 맞춥니다.

## 기존 기록 보존

이름 있는 Docker 볼륨은 장비마다 따로 있습니다. 소스와 `.env`만 옮기면 새 DB가 만들어집니다. 기존 기록도 옮기려면 PostgreSQL 덤프와 **기존 `CONTENT_KEY`**가 함께 필요합니다. 아래 `malssi`는 기본 DB 사용자·DB 이름이므로 변경한 환경에서는 실제 설정을 사용합니다.

원본 장비에서 API 쓰기를 멈추고 덤프합니다.

```sh
docker compose stop api
docker compose exec -T postgres pg_dump -U malssi -d malssi -Fc > malssi-demo.dump
```

덤프를 대상 장비로 안전하게 옮긴 뒤 비어 있는 새 DB에 복원합니다. 기존 자료가 있는 DB에 그대로 덮어쓰는 절차가 아닙니다. 대상 API를 먼저 시작하면 마이그레이션으로 테이블이 생성될 수 있으므로 PostgreSQL만 먼저 실행합니다.

```sh
docker compose up -d postgres
# PostgreSQL이 준비된 뒤 복원
docker compose exec -T postgres pg_restore -U malssi -d malssi --no-owner < malssi-demo.dump
docker compose up -d --build api
```

원본 장비를 계속 사용하려면 덤프 후 `docker compose up -d api`로 다시 실행합니다. DB 볼륨·암호화 키를 보존하면 기존 상담의 질문 스냅샷·답변·모델 이력을 유지합니다. 현재 코드의 `010_questionnaire_v3.sql`은 이전 질문 행을 보관하고 비활성화한 뒤 새 v3 기본 9문항을 등록합니다. 과거 대화의 선택 번호·원문·결과를 새 질문으로 변환하지 않으며, 새 대화에만 `malssi-intake-3.0.0-rc1`을 적용합니다. 현재 묶음의 부분 문구 수정은 허용하지 않으며 판본 단위 변경은 [질문 계약](QUESTIONS.md)을 따릅니다.

동일 호스트·브라우저의 기존 쿠키가 있어야 익명 기록에 접근합니다. 호스트나 브라우저가 달라지면 DB 이동만으로 사용자 계정 동기화가 되지는 않습니다. `.env`, 덤프와 볼륨은 Git에 넣지 않습니다. 일반 종료는 `docker compose down`을 사용하며 DB 볼륨을 제거하는 `-v`를 붙이지 않습니다.
