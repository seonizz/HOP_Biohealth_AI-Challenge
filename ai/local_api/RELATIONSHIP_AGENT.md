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

단계·실행 시간·토큰 사용·원문 검증 결과와 합성 출력은 `ai/outputs/relationship_agent/`에 저장합니다. 모델 호출 실패나 회귀 조건 실패를 통과로 기록하지 않습니다.

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

각 답변의 내부 분석 저장, 최종 관계 분석·품질 검토·결과 저장·기록 재조회를 확인하고 첫마디의 목적·관찰 장면·근거 없는 호칭도 fixture 조건으로 검사합니다. 현재 smoke 스크립트는 기대 프롬프트 버전을 `local_api/backend_patch/src/relationship-prompts.js`에서 읽으므로 실행 전 앱 소스와 사본의 버전 일치를 확인해야 합니다. 사본의 버전만으로 실행 앱의 검증 완료를 판단하지 않습니다.

합성 세션 접근 정보는 Git에서 제외된 `local_api/runtime/relationship-smoke-session.json`에 소유자 전용으로 저장합니다. `--run-id`를 쓰면 파일명에 해당 식별자가 붙습니다. 사용자 기록의 쿠키나 실제 의료 자료를 가져오지 않으며 모델 키·세션 파일을 공유하거나 Git에 넣지 않습니다. [local_api 안내](README.md)의 인증 프록시는 별도 보관 경로입니다.
