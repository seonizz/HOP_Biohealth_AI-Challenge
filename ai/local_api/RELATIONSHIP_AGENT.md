# 관계 에이전트 합성 평가

실행 앱은 통합 프로젝트의 [`app/`](../../app/README.md)입니다. 모델의 상태·검색·분석·검토·저장 계약은 [앱 기술 계약](../../app/docs/RELATIONSHIP_AGENT.md), 확인된 결과와 미확인 범위는 [현황과 할 일](../../docs/current/현황과_할일.md)을 기준으로 봅니다. 이 문서는 AI 평가 스크립트의 사용법만 다룹니다.

`backend_patch/`는 앱 변경 파일의 보관 사본이며 실행 앱의 기준 소스가 아닙니다. `scripts/apply_relationship_backend.py`는 적용 전에 파일과 `.env`를 비공개 `runtime/`에 백업하지만 현재 앱을 사본으로 덮어쓸 수 있으므로 통합 프로젝트의 일반 실행에는 사용하지 않습니다.

## 합성 사례 평가

모든 명령은 `말씨/ai/`에서 실행합니다. 평가 스크립트는 `local_api/runtime/config.json`의 로컬 Ollama 연결·키와 `local_api/agent_data/`의 질문·합성 사례를 사용하며 기본적으로 `../app/src/model.js`를 불러옵니다. 연결 설정과 앱 준비 절차는 [통합 실행·검증](../../docs/current/실행과_검증.md)을 참고합니다.

```sh
# 말씨 프로젝트 루트에서
cd ai
node scripts/evaluate_relationship_agent.mjs
node scripts/evaluate_relationship_agent.mjs local_api/agent_data/friend_boundaries.json
node scripts/evaluate_relationship_agent.mjs local_api/agent_data/denied_risk_unknown_relation.json
node scripts/evaluate_relationship_agent.mjs local_api/agent_data/current_danger_friend.json
# 초기 메모리와 추가 답변을 이어서 처리
node scripts/evaluate_relationship_agent.mjs --state-only --incremental
```

기본 사례는 합성 부모·자녀 대화입니다. 추가 사례는 친구 관계·이용자의 한계·지원망, 위험 부정문·미확인 관계·답변 속 지시, 현재의 직접적인 위험 보고를 확인합니다. `--state-only --incremental`은 초기 메모리를 만든 뒤 추가 답변에 따라 상태·이용자 부담·지원 자원이 갱신되는지 검사합니다. `expectations`는 안전 표시·관계·목적·근거 없는 호칭·메모리 근거에 대한 회귀 조건이며 모든 의미나 임상 타당성을 인증하지 않습니다.

단계·실행 시간·토큰 사용·원문 검증 결과와 합성 출력은 Git 제외 경로 `ai/local_api/runtime/evaluations/`에 실행별 고유 파일로 저장합니다. `MALSSI_EVALUATION_DIR`로 다른 비공개 출력 경로를 지정할 수 있습니다. 실패도 실행 ID·소스 해시·모델·지연·재시도와 함께 남깁니다. 합성 출력만 허용하며 `synthetic:true`가 없는 사례는 거부합니다. 자동 통과와 사람 의미 검토를 구분해 `human_review:pending`을 유지합니다.

## 실제 Docker 웹 흐름

같은 `ai/` 폴더에서 실행합니다. 앱과 모델이 실행 중이어야 하며 `../app/.env`의 포트·Origin을 사용합니다.

```sh
node scripts/smoke_relationship_web.mjs
# 저장한 합성 세션을 이어서 실행
node scripts/smoke_relationship_web.mjs --resume
# 별도 합성 실행을 구분하고 이어서 실행
node scripts/smoke_relationship_web.mjs --run-id review
node scripts/smoke_relationship_web.mjs --run-id review --resume
```

각 답변의 내부 분석 저장, 최종 관계 분석·품질 검토·결과 저장·기록 재조회를 확인하고 첫마디의 목적·관찰 장면·근거 없는 호칭도 fixture 조건으로 검사합니다. smoke는 실제 `app/`의 프롬프트 버전·소스 해시와 실행 서버 `/health`를 대조합니다. 모델 이름은 앱 `.env`의 `MODEL_NAME`과 저장 결과가 같아야 하며 12B로 고정하지 않습니다. 다른 실행본이면 요청을 진행하지 않습니다.

합성 세션 접근 정보는 Git에서 제외된 `local_api/runtime/relationship-smoke-session.json`에 소유자 전용으로 저장합니다. `--run-id`를 쓰면 파일명에 해당 식별자가 붙습니다. 사용자 기록의 쿠키나 실제 의료 자료를 가져오지 않으며 모델 키·세션 파일을 공유하거나 Git에 넣지 않습니다. [local_api 안내](README.md)의 인증 프록시는 별도 보관 경로입니다.


## 31B 전환과 증거 확인

`MODEL_BASE_URL`, `MODEL_NAME`, `MODEL_API_KEY`를 지정하면 해당 모델을 호출합니다. 명시한 endpoint에는 별도의 키와 모델명이 필요하며 기존 12B 키·이름을 대신 쓰지 않습니다. `MODEL_TIMEOUT_MS`는 양의 정수입니다. `MODEL_CHECKPOINT_SHA256`은 선택적인 선언값이며 서버의 실제 로딩 확인을 대신하지 않습니다. 키는 비공개 환경에서 주입하고 명령 이력·공유 로그에 복사하지 않습니다.

```sh
# 프로젝트 루트. 모델을 호출하지 않고 구성과 파일 해시만 확인
node ai/scripts/evaluate_relationship_agent.mjs --state-only --check-only
# 새 결과들을 모델·소스·프롬프트·평가 모드별로 집계
node ai/scripts/summarize_relationship_evaluations.mjs ai/local_api/runtime/evaluations
npm run test:evidence
```

집계의 분모는 실패를 포함한 모든 실행입니다. 같은 사례의 반복은 별도 실행 수와 고유 사례 수로 구분합니다. 서로 다른 소스·모델·모드·timeout은 합치지 않습니다. p50/p95는 nearest-rank 방식이며 평가 실행 시간과 모델 요청 대기를 구분합니다. 전체 사용자 세션 시간·현장 동시성·비용·독립 test 성능으로 해석하지 않습니다. 사용량 미제공은 0토큰이 아닌 `null`입니다. 사람 평가 조건은 [제출 범위와 검증 계약](../../docs/competition/04_제출범위와_검증계약.md)을 따릅니다.

## 재평가 N2–N4 이후의 기록 계약

실제 fetch에는 고유 `attempt_id`, 한 생성 호출에는 `generation_id`를 부여합니다. 재시도 대기 사건은 `model_retry_wait`로 별도 저장하고 요청·실패·토큰 수에 더하지 않습니다. 요청 ID가 없는 이전 trace나 충돌하는 trace의 정확한 요청 집계는 `null`, `attempt_count_verified:false`로 남깁니다. 기존 원시 기록을 덮어써 숫자를 소급 수정하지 않습니다.

실험군은 비밀 정보를 제외한 endpoint의 SHA256과 선택적 `MODEL_DEPLOYMENT_ID` 선언의 SHA256도 구분합니다. URL의 사용자 정보·query·fragment는 해시 입력에서 제외하고 경로를 포함한 URL 원문이나 키를 결과에 쓰지 않습니다. 같은 endpoint 뒤의 배포가 바뀌면 운영자가 배포 선언도 바꿔야 합니다. 이 해시는 실제 로딩·하드웨어 증명이 아니며 `runtime_model_identity_verified:false`와 `environment_identity_verified:false`를 유지합니다. endpoint가 없는 이전 결과는 실행별로 나눕니다.

웹 smoke는 재개용 세션 파일과 시도 이력을 분리합니다. 실행별 UUID 경로 `ai/local_api/runtime/relationship-smoke-attempts/<attempt_id>/`에 `started.json`과 `result.json`을 배타적으로 생성합니다. 같은 세션의 재실패·성공은 각각 남고, 완료 전 중단도 시작 파일로 확인할 수 있습니다. 기존 실패·성공 파일은 보존합니다. 원문이 포함된 결과와 세션 접근 정보는 계속 Git 제외·소유자 전용이며 예상하지 못한 오류 메시지는 원문 대신 일반 오류 코드로 기록합니다.

재평가 v3 이후에는 누락·빈 trace, 연결된 요청 없는 대기, generation·request 불일치, 시도 번호 누락·역전, 완료 이후 재시도와 미완료 대기를 미검증으로 처리합니다. 실행을 먼저 개별 검증하므로 다른 실행의 로그로 누락을 메울 수 없습니다. 정확히 같은 이벤트의 중복 전달만 한 번 집계합니다. 현재 생성 호출의 재시도 상한은 3회이며 앱 계약 변경 시 집계 검사도 함께 갱신해야 합니다.

`attempt_count_verified:true`는 받은 trace의 구조·연결 검사가 통과했다는 뜻입니다. `attempt_count_scope=validated_trace_events`, `trace_completeness_verified:false`로 범위를 표시합니다. 생성 호출 전체가 로그에서 사라졌는지는 외부 완료 기록 없이는 증명할 수 없습니다. 오류 코드는 `trace_integrity_errors`에 남기며 원문·주소·키를 넣지 않습니다. 이전 원시 기록과 당시 집계는 보존합니다.

변경별 재현 결과와 남은 검증 범위는 [수정 v4](../../docs/competition/결선_재평가_지적_수정_v4.md)에 기록합니다.
