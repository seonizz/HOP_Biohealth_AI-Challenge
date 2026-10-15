# 말씨 앱 실행

현재 앱은 임시 테스트용 native Ollama `gemma4:12b`와 `relationship_agent`를 사용합니다. 최종 목표는 31B이며 [모델 진행 방향](../docs/current/현황과_할일.md#모델-진행-방향)을 따릅니다. 이 문서는 설치·환경 설정의 기준 문서입니다.

[프로젝트 홈](../README.md) · [통합 실행·검증](../docs/current/실행과_검증.md) · [현황과 할 일](../docs/current/현황과_할일.md)

## 설치와 실행

통합 프로젝트의 `app/` 폴더에서 실행합니다. Node.js 24.14 이상 24.x, Docker Desktop, Mac의 Ollama가 필요합니다.

```sh
cd app
```

Docker Desktop과 Ollama가 실행된 상태에서:

```sh
npm ci --ignore-scripts
npm run setup
ollama list
```

`ollama list`에서 `gemma4:12b`가 있는지 확인합니다. 새 설치에서는 `npm run setup`으로 생성한 서버 전용 `.env`에 아래 모델 설정을 반영한 뒤 앱을 시작합니다. 기존 DB 암호와 `CONTENT_KEY`는 유지합니다.

| 설정 | 현재 값 |
| --- | --- |
| `MODEL_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `MODEL_DOCKER_BASE_URL` | `http://host.docker.internal:11434/v1` |
| `MODEL_NAME` | `gemma4:12b` |
| `MODEL_PROTOCOL` | `relationship_agent` |
| `MODEL_TIMEOUT_MS` | `600000` |

앱의 연결 검사는 비어 있지 않은 `MODEL_API_KEY`도 요구합니다. 서버 전용 `.env`에서 설정하며 실제 값은 문서와 브라우저에 전달하지 않습니다. `npm run setup`은 기존 `.env`를 덮어쓰지 않고 기본 DB 설정을 준비하므로, 이 명령만으로 기존 모델 연결이 위 표로 전환되지는 않습니다. `--model-env`는 별도 게이트웨이의 `json_schema` 설정을 가져오는 기존 경로이므로 현재 관계 에이전트 실행 설정으로 사용하지 않습니다.

```sh
docker compose up -d --build
```

[말씨 열기](http://127.0.0.1:9000). 기본 API 포트는 9000, 로컬 PostgreSQL 포트는 5433입니다. `compose.yaml`의 API 컨테이너는 `MODEL_DOCKER_BASE_URL`을 사용하고, 호스트에서 `src/server.js`를 실행할 때는 `MODEL_BASE_URL`을 사용합니다. 현재 모델은 호스트 Ollama의 11434 포트에서 호출합니다.

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

## Origin과 모델 연결

로컬 주소는 `http://127.0.0.1:9000`입니다. 공개 도메인을 사용할 때는 `.env`의 `PUBLIC_ORIGIN`과 `ALLOWED_ORIGINS`를 실제 앱 Origin에 맞춥니다. 이전 공개 주소의 현재 가동 여부는 재확인하지 않았습니다. 연결 상태는 실행 환경에서 별도로 확인합니다. `/health`의 `model_configured`는 설정 유무만 나타내며 실제 모델 생성 성공을 보증하지 않습니다.

목표 31B의 기존 학습 모델·SSH 터널 자료는 [데이터와 연구](../docs/current/데이터와_연구.md)에 구분합니다. 다른 장비로 앱·DB를 옮기는 절차는 [서버 이동](docs/DOCKER_HANDOFF.md)을 따릅니다.

## 관리와 상세 계약

| 할 일 | 기준 문서 |
| --- | --- |
| 코드·DB·실제 모델 검증과 비공개 자료 내보내기 | [통합 실행·검증](../docs/current/실행과_검증.md) |
| 질문 문구·보기·순서·사용 여부 수정 | [질문 관리](docs/QUESTIONS.md) |
| 상태 갱신·검색·최종 검토·화면·저장 구조 | [관계 에이전트 계약](docs/RELATIONSHIP_AGENT.md) |
| HTTP 요청·응답과 오류 | [API 계약](docs/API.md), [OpenAPI](docs/openapi.json) |

정리 전 설명과 당시 검증 기록은 [원문 보관](../archive/08_문서통합_원문/app/README.md)에 남깁니다.
