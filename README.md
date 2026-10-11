# 말씨 개인 시연 백엔드

`seonizz/HOP_Biohealth_AI-Challenge`의 프론트 `feat/column-full-text`, 커밋 `e811e871e5da95d429ee4ad1fec2cc6a0ad07268`과 기존 PostgreSQL 저장 구조를 유지합니다. 현재 로컬 구성은 Linux Ollama `gemma4:12b`와 `relationship-v3.8-grounded`입니다. 하나의 모델을 역할별로 따로 호출하는 에이전트 흐름을 사용합니다. 원문 관찰 → 관계 메모리 → 근거 검토 → 질문 결정·검토, 최종 관계 분석 → 분석 검토 → 말하기 전략 → 전략 검토 → 다섯 카드 초안 → 카드별 전담 작성 → 품질 검토·수정 → 첫마디·듣기·제안 분리 작성 → 전체 발화 통합 → 다섯 카드 주장 검토 → 최종 검토 → 단계별 이유·인용 작성 및 검토 순서입니다. 검토 실패는 제한 안에서 수정하고 다시 검토하며, 해결되지 않은 결과는 저장하지 않습니다. [현재 계약과 검증 기록](docs/RELATIONSHIP_AGENT.md).

현재 머신에서는 Ollama, `hop-grounded-local-postgres-1`, 사용자 서비스 `hop-malssi-local.service`로 실행합니다. [말씨 열기](http://127.0.0.1:9000). 재시작은 `systemctl --user restart hop-malssi-local.service`, 로그 확인은 `journalctl --user -u hop-malssi-local.service -n 30`입니다. 이 API 서비스는 이번 로그인 세션에서 만든 transient unit이므로 재부팅 후에는 아래 실행 스크립트를 사용할 수 있습니다.

```sh
# 이 머신의 Node 24 런타임도 자동으로 찾습니다.
# 이미 서비스가 실행 중이면 먼저 systemctl --user stop hop-malssi-local.service
bash scripts/run-local.sh
```


## 실행

다른 환경에 처음 설치할 때는 Node.js 24, Docker Compose와 Ollama가 필요합니다:

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

### 자체 파인튜닝 모델로 교체

다단계 흐름을 유지하려면 `MODEL_PROTOCOL=relationship_agent`를 그대로 두고 `MODEL_BASE_URL`, `MODEL_NAME`, 서버 전용 `MODEL_API_KEY`를 교체합니다. OpenAI 호환 `/chat/completions` 응답을 반환하는 서버가 필요합니다. 모델 이름이 달라도 단계별 역할·원문 검색·검토·수정 제한은 같습니다.

- `MODEL_AGENT_FORMAT=json_schema`: 현재 로컬 설정. 서버가 JSON Schema 강제 출력을 지원할 때 사용합니다.
- `MODEL_AGENT_FORMAT=json_object`: JSON 객체 모드만 지원하는 서버용입니다.
- `MODEL_AGENT_FORMAT=prompt`: 응답 형식 옵션을 보내지 않고 프롬프트의 스키마를 따르게 합니다.
- `MODEL_REASONING_EFFORT=omit`: 해당 확장 옵션을 받지 않는 서버에서는 생략합니다. 현재 Ollama 기본은 `none`입니다.

어떤 형식도 서버 측 스키마·인용·주장 검토를 생략하지 않습니다. 형식이 맞지 않으면 제한된 재시도 후 실패하며 자동으로 검증을 낮추지 않습니다. 새 모델의 실제 품질은 같은 예시로 다시 검증해야 합니다. 기존 `json_prompt`는 별도 과거 단일 생성 계약이므로 자체 모델 연결 시 이를 선택하면 현재 관계 에이전트 흐름이 유지되지 않습니다. `apply_relationship_backend.py`는 코드 적용 시 기존 모델 설정을 보존합니다.

개발 폴더 `HOP_agent`에서 다음과 같이 동일 사례를 모델별로 비교합니다. 환경 변수에 새 모델 연결을 설정하지 않으면 기존 비공개 `local_api/runtime/config.json`을 사용합니다. 키를 명령문이나 로그에 적지 마세요.

```sh
HOP_EVAL_LABEL=baseline node scripts/evaluate_relationship_agent.mjs local_api/agent_data/sibling_computer.json
HOP_EVAL_LABEL=candidate node --env-file=/private/model.env scripts/evaluate_relationship_agent.mjs local_api/agent_data/sibling_computer.json
HOP_EVAL_LABEL=incremental node scripts/evaluate_relationship_agent.mjs local_api/agent_data/sibling_computer.json --state-only --incremental
# 같은 GPU에서 5개 검증을 순차 실행합니다.
HOP_EVAL_LABEL=candidate-suite node --env-file=/private/model.env scripts/evaluate_relationship_suite.mjs
```

평가 보고서는 Git에서 제외된 `outputs/relationship_agent`에 mode 600으로 저장됩니다. `HOP_EVAL_CAPTURE=1`이면 단계별 초안도 포함하므로 비공개로 다루세요. 통과 표시는 구조·근거 검증 및 사례별 최소 조건을 통과했다는 뜻이며, 답안 품질의 독립적인 인증이 아닙니다. 다섯 카드와 연결된 인용을 사람이 함께 검토해야 합니다.

### 별도 31B 학습 모델 경로

`malssi-gemma4-31b-step100`의 학습·runtime 자료와 별도 모델 API 경로는 기존 구성으로 유지합니다. 31B는 따로 선택하는 학습 모델·SSH 터널 경로이며, 이 README의 현재 실행 절차는 12B 관계 에이전트 기준입니다. 이전 31B 연결·이동 기록은 [별도 서버 이동 안내](docs/DOCKER_HANDOFF.md)와 [이전 검증 기록](docs/VALIDATION.md)에서 확인합니다.

## 대화와 내부 상태

1. 브라우저별 익명 세션을 만듭니다. 이메일·회원 가입은 요구하지 않습니다.
2. 기존 기본 질문과 보충 질문을 PostgreSQL에서 읽습니다. 변경하지 않은 기본 문항만 마이그레이션으로 갱신하며 기존 상담과 관리자 수정을 보존합니다. 조건부 분기, 후속 질문과 첫 문항까지 반복해서 되돌리기를 서버에서 처리합니다. 후속·보충 질문에서도 본 질문으로 돌아갈 수 있습니다.
3. 답변 원문과 선택한 보기, 건너뛰기, 후속 답변을 PostgreSQL에 먼저 저장합니다.
4. 같은 Gemma4 12B 모델이 누적된 현재 답변 원문 전체와 검증된 이전 관계 메모리를 읽습니다. 기존 `patient_state`와 이름 인덱스에 더해 대상자·이용자·관계의 관찰과 가설을 `agentRelationshipMemory`로 분리하여 암호화된 상태에 저장합니다. 모든 finding은 정확한 인용과 사람·문항 검증이 필요합니다. 해당 사람의 `answered` 원문 근거가 없으면 매 턴 스키마에서 메모리 배열을 `maxItems:0`으로 제한하며 이름만으로 finding을 만들 수 없습니다. 최신 pending 질문의 `latest_answer`를 새 원문 항목으로 전달하여 관찰·생활 변화·이용자 부담·지원 자원을 갱신합니다. 인과·동기 추론과 관계 패턴은 `tentative`, 미확인은 `unknowns`로 남깁니다. 사용자 건너뛰기도 모델 상태 갱신을 거치고, 뒤로가기·정정은 이후 메모리와 결과를 무효화합니다. 원문에 이미 답한 같은 사람의 질문만 근거를 붙여 생략할 수 있습니다. 질문 결정은 별도 모델 요청입니다.
5. 마지막에는 관계 분석 → 분석 검토 → 말하기 전략·전략 검토 → 가이드 작성·품질 검토 → 발화 전담 작성 → 카드별 주장 검토 → 최종 검토를 수행합니다. 최종 검토에서 분석 오류가 발견돼도 수정 예산이 남아 있으면 분석을 수정·재검토한 후 새 분석으로 전략부터 다시 작성하고 검토합니다. 분석 수정은 초기와 최종 검토 후를 합쳐 전체 한 번입니다. 문장 품질은 각 작성 흐름에서 필요 시 한 번 다듬고, 중대한 가이드 오류 수정은 재작성 전후를 합쳐 최대 두 번이며 매번 다시 검토합니다. 모든 검증이 통과하면 기존 안내 5개와 관계 분석·전체 대화 기록·실행 단계·검색 출처 ID 정보를 저장합니다. 최종 `relationship_memory`는 승인된 분석으로 다시 구성하여 거절된 이전 해석을 되살리지 않습니다. 분석 재검토나 최종 오류 검토가 끝까지 통과하지 못하면 실패로 처리하고 최종 결과를 저장하지 않습니다.

당사자 정보와 앱 이용자의 감정·부담은 별도 필드로 관리합니다. 답변은 사용자의 보고이며 임상적으로 확인된 사실이 아닙니다. 내부 `patient_state`의 요약·해석은 모델 생성물입니다. 서버는 인용이 현재 답변의 실제 부분 문자열인지, 대상과 문항이 일치하는지 검사하지만 의미의 임상적 타당성을 인증하지 않습니다. 임의 질환 점수는 계산하지 않습니다. 결과의 분류는 기존 칼럼 연결용이며 진단이 아닙니다.

기본 질문·보기는 기존 UI를 유지하며 이름은 필수 입력이고 별도 이름 후속 질문을 사용하지 않습니다. 기존 상담의 질문 버전과 관리자가 수정한 문항은 유지합니다. [질문 관리 안내](docs/QUESTIONS.md)의 로컬 명령으로 문구·보기·순서·사용 여부를 수정하거나 문항을 추가·삭제할 수 있습니다. 새 상담에 즉시 반영되며 진행 중·완료된 상담은 질문 스냅샷을 보존합니다. 현재 `relationship_agent`는 이미 답한 내용에 한해 근거를 확인하고 생략하며, 기본 질문 뒤 부족한 도움 의향·이전 대화 반응·이용자 한계를 최대 세 개의 고정 확인 질문으로 보충합니다. 이미 답하거나 거절한 확인 질문은 재선택할 수 없습니다. 기존 질문 조건·후속 질문·사용자가 허용된 문항을 건너뛰는 동작은 유지합니다.

현재 Ollama 호출은 `stream:false`, `reasoning_effort:none`, `temperature:0.2`와 단계별 JSON Schema를 사용합니다. 서버는 전체 원문을 보존하고 상태 갱신마다 누적된 현재 답변 원문 전체와 검증된 이전 상태·관계 메모리, 검색한 원문을 전달합니다. 이전 관계 메모리도 현재 원문으로 다시 검증하며 오래된 근거는 승인하지 않습니다. 분석은 답변을 사람·문항별로 나누고 해석마다 실제 원문 인용을 요구합니다. 상태 갱신 한 번 또는 최종 에이전트 실행 한 번의 공통 제한 시간은 각각 `600000`ms입니다. 최종 분석·품질 개선·오류 검토·수정·재시도는 모두 같은 마감 시간 안에서 수행하며 단계마다 시간이 새로 부여되지는 않습니다. 일시적인 연결 오류·응답 검증 실패의 재요청은 단계별 최대 3회이고, 전체 분석 수정 1회·가이드 수정 최대 2회의 공유 예산 및 각 작성 흐름의 품질 개선과 별개입니다. 제한 시간 안에서 검토를 끝까지 통과하지 못하면 최종 결과를 저장하지 않습니다. 이름은 실제 이름 입력과 후속 답변에서만 추출합니다.

`conversation_lexical_v1` RAG는 현재 세션의 최신 `answered` 원문만 매번 새로 색인합니다. 한국어 단어·문자 bigram의 IDF 가중 겹침으로 역할별 질문과 이용자 목적에 맞는 원문을 고릅니다. 최신 답변·이름·관계·목적·위험 문맥은 유지하고 검증된 이전 메모리와 최종 단계에서 이미 인용한 문항도 선택합니다. 선택한 문항의 보기·직접 입력·후속 답변 원문 전체를 함께 제공하며 전체 현재 답변도 대조 자료로 유지합니다. 생성 메모리나 다른 세션은 검색 대상에 넣지 않습니다. BM25나 vector 검색을 사용하는 구성은 아닙니다. [대화 원문 기반 RAG](docs/RELATIONSHIP_AGENT.md#대화-원문-기반-rag).

매 상태 갱신과 최종 모든 단계에 검색 payload를 전달하며, `groundedEvidenceSchema`는 `{subject,question_id,quote}` 전체 객체를 검색된 `answered` 원문·문장·인용 발췌 후보의 enum으로 제한합니다. 생성 후에도 인용이 실제 검색 원문에 있는지와 현재 원문·사람·문항이 일치하는지 검사합니다. 후보 발췌는 인용 선택용이며 모델 입력의 전체 원문은 축약하지 않습니다. 위험 근거는 부정·화자·시점을 보존한 완전한 문장 후보를 사용하고 빈 enum은 생성하지 않습니다. [근거 객체 enum](docs/RELATIONSHIP_AGENT.md#근거-객체-enum).

Ollama 0.40.0 MLX의 OpenAI 채팅 경로는 `truncate=false`를 사용합니다. 모델이 입력 문맥 한계의 HTTP 400 오류를 반환하면 현재 관계 프로토콜은 `MODEL_CONTEXT_TOO_LONG`으로 명시 실패하며 원문을 축약해서 다시 생성하지 않습니다. `/api/ps`의 `context_length:32768`만으로 실제 하드 한계를 단정하지 않습니다. [버전 소스와 오류 처리 근거](docs/RELATIONSHIP_AGENT.md#전체-원문과-문맥-한계).

전송한 글은 즉시 작성창에서 비우고 사용자 말풍선과 대기 표시를 먼저 그린 뒤 요청합니다. 재시도에는 캡처한 원문을 사용합니다. 자동 복구 후에도 모델이 실패하면 원문 답변은 서버의 대기 상태와 버전 이력에 남으며, 같은 질문에서 재시도할 수 있습니다. 화면은 연결·응답 확인·시간 초과를 구분해 안내합니다. 운영 로그에는 요청 ID와 오류 단계·시도 횟수·상태 코드·처리 시간 같은 진단 정보만 남기며, 대화 본문·모델 출력·인증 키는 기록하지 않습니다. 모델 응답 검증이 성공해야 다음 질문으로 진행합니다. 실패한 답변을 수정하면 대기 답변을 교체하고, 같은 입력을 재시도하면 답변을 중복 추가하지 않습니다. 최종 결과 생성 실패는 결과를 꾸며 저장하지 않고 기존 대화 화면에서 재시도할 수 있습니다.

## 기존 UI 기능

기존 결과 안내 5개(자기돌봄, 첫마디, 해볼 행동, 피할 표현, 다음 단계)를 유지하고, 아래에 접힌 **함께 살펴본 관계** 카드를 추가합니다. 펼치면 그분의 상황과 이용자의 마음, 관계 특징·강점·서로의 한계·미확인 내용을 볼 수 있고 원문 근거도 따로 펼쳐 볼 수 있습니다. 추정은 확인이 필요하다고 표시하며 생성 문장과 인용은 HTML 이스케이프합니다. 기록 화면도 같은 분석을 표시하고, 분석이 없는 이전 기록은 기존 표시를 유지합니다. 기존 위기 안내 카드를 유지하며 모델이 새 연락처를 생성하지 않습니다.

시작·서비스 소개·대화·결과·내 기록·칼럼의 6개 화면을 유지합니다. 단일/다중 선택, 직접 입력, 단독 보기, 필수 입력, 건너뛰기, 후속 질문, 되돌리기, 문장 복사, 두 번 눌러 기록 삭제, 공통 내비게이션, 칼럼 분류·안 읽음·담음 필터, 읽기 완료, 글자 크기와 이전/다음 읽기, 대화 종료 확인, 응원 문구, 결과 생성 로딩과 카드 등장 애니메이션을 지원합니다. 새 프론트의 이미지 로고·통일된 입력 버튼 위치·선택 후 세부 설명·새로고침 시 나가기 확인·칼럼 출처 배지·결과 카드 사선 등장 효과를 적용했습니다. 대처와 받아 본 도움을 한 문항으로 합쳤고, 이용자의 힘들었던 순간을 묻습니다. 최신 프론트에서 제거된 오늘의 글·다른 글 뽑기·말씨 정원은 화면에서도 제외했습니다.

칼럼은 GitHub 최신 프론트에 포함된 10편의 목록·요약·원문 링크와 9편의 본문을 사용합니다. 본문이 없는 1편은 원래 UI대로 요약을 표시합니다. 새 기사 수집은 하지 않았습니다. 요청에 따라 익명 세션과 개인 시연용 서버 저장을 설명하는 문구는 UI에서 제거했습니다. 브라우저 쿠키를 지우면 해당 기록에 다시 접근할 수 없고, 다른 브라우저와 동기화되지 않습니다.

## 저장 구조와 검증

- `questions`: 질문 문구·보기·순서·대상·조건·후속 질문.
- `browsers`: 익명 토큰의 해시와 세션 정보.
- `intakes`: 대화 진행 상태·원문 답변·기존 `agentMemory`·별도 `agentRelationshipMemory`.
- `patient_states`: 현재 당사자/주변인 문맥과 모델 내부 메모리.
- `patient_state_revisions`: 답변·정정·모델 변경의 버전 이력.
- `records`: UI 결과 카드와 전체 대화 기록, 선택적 `relationship_analysis`, `provenance.agent`의 프롬프트 버전·실행 단계·검토 수행 여부·검색 방식과 단계별 원문 수/출처 ID. 검색 추적 metadata에는 원문 내용을 넣지 않습니다.
- `column_states`: 읽음·담음 상태.

상담·상태·이력·결과는 AES-256-GCM으로 암호화합니다. PostgreSQL 데이터는 Docker 이름 있는 볼륨에 저장합니다. 브라우저에는 접근용 쿠키만 두고 상담 내용은 저장하지 않습니다. 세션은 기본 30일로 만료되지만 검증용 서버 기록은 남습니다. 기존 UI에서 기록을 명시적으로 삭제하면 연결된 대화와 상태 이력도 삭제합니다.

서버에 저장된 전체 원문·모델 상태·버전 이력·결과를 검증하려면 로컬에서 `npm run export:verification`을 실행합니다. 비공개 `runtime/server-verification.json`에 복호화한 자료를 저장합니다. 이 파일은 Git과 웹 제공 대상에서 제외됩니다. 다른 브라우저나 쿠키 삭제 후에도 서버 자료를 이 방식으로 확인할 수 있습니다.

현재 공개 앱 주소는 `https://s-macbook-pro.tail85b0de.ts.net`입니다. `.env`의 `ALLOWED_ORIGINS`에 이 정확한 Origin을 지정해 기존 Funnel을 통한 앱 요청을 허용합니다. 현재 모델 API는 호스트 Ollama의 로컬 `11434`에서 호출하며 브라우저는 모델 키를 받지 않습니다.

```sh
npm run check
npm test
# 생성한 로컬 .env의 DB에 격리된 임시 테스트 스키마를 생성/제거
npm run test:integration
```

`npm test`는 `TEST_DATABASE_URL`이 없으면 PostgreSQL 테스트를 건너뜁니다. 모든 저장 검증은 `npm run test:integration`으로 실행합니다. 테스트에는 합성 데이터만 사용합니다.

2026-10-11 실제 `HOP_backend`의 **v3.5-rag 통합검사 229/229**와 `npm run check`가 통과했으며 Docker에 반영했습니다. 관찰 요약은 새 자유 서술 대신 검증된 원문 인용으로 구성합니다. 이전 v3.4의 합성 29문항 최종 생성·웹 저장·기록 재조회는 약 268.6초에 통과했습니다. 실제 모델과 전체 웹 흐름의 버전별 검증 범위를 구분하며 최적화 목표는 사용자의 `ok` 전까지 활성 상태입니다. [현재 검증 범위](docs/RELATIONSHIP_AGENT.md#검증-현황).

[관계 에이전트 안내](docs/RELATIONSHIP_AGENT.md) · [API 계약](docs/API.md) · [OpenAPI](docs/openapi.json) · [31B 서버 이동 안내](docs/DOCKER_HANDOFF.md) · [이전 검증 기록](docs/VALIDATION.md).
