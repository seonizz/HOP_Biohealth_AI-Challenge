# 말씨 B→A 턴 실행 안내

현재 코드에는 이중 모델 실행 경로가 연결되어 있습니다. Vercel의 공개 API는 GPU/워커를 시작하지 않습니다. 운영 모델의 체크포인트와 서버가 확인되지 않았으므로 공개 시연에서 학습 모델의 평가·응답이 수행되었다고 주장하지 않습니다.

## 실행 구조

사용자 `answer`, `correct_answer`, `message` 턴은 먼저 PostgreSQL에 저장됩니다. 즉시 안전 규칙에 걸리면 기존 `SAFETY_HOLD`와 고정 안전 응답이 바로 실행되어 일반 모델 큐를 기다리지 않습니다. 그 외 턴에서 `HOP_DUAL_ENABLED=true`이고 `HOP_V2_MODEL_ENABLED=true`이면 기존 `agent_runs` 큐가 `dual_turn` 작업을 만듭니다. 워커는 같은 체크포인트 ID를 쓰는 역할 B와 A를 차례로 호출합니다. 각 호출의 system prompt와 입력 메시지는 별도로 구성됩니다. `assessment.schema.json`과 `response.schema.json`을 추론 서버의 `response_format.json_schema`에 전달하고, 엄격 파싱과 서버측 구조·근거 검증을 다시 수행합니다.

B의 원본 수치 JSON과 정규화 결과는 `turn_assessments.encrypted_payload`에 저장됩니다. 실패하면 `evaluation_status=3`, 모든 점수 `-1`로 기록하며 A에는 평가 실패를 명시합니다. 정상 B에서도 근거가 부족한 항목은 `-1`이며 0점으로 바꾸지 않습니다. 비교 가능한 최근 5턴의 유효 점수만 직전값으로 사용하고, 대상 프로젝트·대화·출처·시점·척도·모델 해시·프롬프트 버전이 다른 점수는 변화량을 계산하지 않습니다. A에게는 현재 평가, 이전 유효 평가, 변화량, 평가 가능 여부, 서버가 결정한 `response_policy`를 전달합니다. 이는 추론 문맥 제공이며 가중치 재학습이 아닙니다.

A는 `{ "message": "..." }`만 출력합니다. 검증된 `message`만 `v2_messages`에 저장되고 화면에 일반 대화 문장으로 표시됩니다. A의 실패 시 미검증 출력은 저장·표시하지 않으며 같은 B 평가를 재사용하는 `/api/v2/runs/{id}/retry`를 제공합니다. 기존 문항 순서·분기·동의·메모리·안전 상태는 계속 서버가 관리합니다. 알림 기준도 A가 아니라 서버의 설정값으로 판정합니다. `assessment_alerts`는 turn/response/assessment ID를 연결하며 프론트는 대응 응답을 렌더링한 뒤 알림을 붙이고 `shown`으로 확인합니다. 과거 응답의 알림은 그 응답에만 연결됩니다.

`assessment_sources`는 평가가 참조한 원문 메시지 ID를 기록합니다. 원문 정정·삭제는 해당 평가, 알림, 파생 A 응답까지 제거합니다. 프로젝트·계정 삭제는 DB 외래 키로 연쇄 삭제됩니다. 임시 프로젝트는 기존 24시간 만료·키 삭제 정책을 따릅니다.

## 설정 및 시작

`backend/.env.example`의 `HOP_DUAL_*` 값을 참고하십시오. 체크포인트는 **아직 확정되지 않았습니다**. 같은 학습 체크포인트에 대해 확인한 모델 ID와 SHA-256을 각각 `HOP_DUAL_MODEL_ID`, `HOP_DUAL_MODEL_SHA256`에 입력해야 워커가 시작됩니다. 평가 B와 응답 A는 기본적으로 동일한 `HOP_DUAL_MODEL_URL`을 사용하며, 필요하면 역할별 URL을 지정할 수 있습니다. 두 URL 모두 워커 호스트의 HTTP 루프백 주소만 허용합니다. 대화 원문을 임의의 원격 모델 API로 보내는 설정은 이 구현에서 허용하지 않습니다. 별도 모델 서버를 쓰려면 보호된 서버의 **같은 호스트**에 워커와 모델을 두고, 워커만 Neon DB에 연결하십시오. 모델 서버는 OpenAI 호환 `/v1/chat/completions`에서 `response_format:json_schema` 제약 생성을 실제로 지원해야 합니다. 프로세스 실행·체크포인트 로딩 명령은 검증된 엔진/파일이 정해진 뒤 해당 서버의 운영 절차로 별도 확정해야 합니다.

1. DB 관리 연결로 `backend/migrations/006_dual_turn_assessments.sql`을 적용하고 제한 실행 역할에 `backend/scripts/grant-runtime.ts`의 권한을 부여합니다. 배포 전에 기존 DB 백업을 확보합니다.
2. API와 워커의 환경에 같은 암호화 키·DB 연결을 설정합니다. API는 `HOP_DUAL_ENABLED=true`로 턴 경로를 활성화합니다. 실제 모델 호출은 별도 워커의 `HOP_V2_MODEL_ENABLED=true`와 명시된 이중 모델 설정이 모두 있을 때만 일어납니다.
3. 승인된 CPU 또는 GPU 모델 서버를 운영자가 별도로 켠 뒤, 워커 호스트에서 `npm run worker:v2`를 실행합니다. 이 저장소의 API/배포 스크립트는 학습이나 GPU 추론 서버를 자동 시작하지 않습니다. 지금은 GPU를 실행하지 않았습니다.
4. 모델 서버가 꺼져 있으면 공개 시연의 입력·질문·DB 기록은 동작하지만, 평가는 불가 상태로 저장되고 실제 A 응답은 표시되지 않습니다. 테스트용 합성 응답은 공개 화면에 노출되지 않습니다.

`HOP_DUAL_PROMPT_PROFILE=test|production`과 `HOP_DUAL_PROMPT_VERSION=v1`로 역할별 프롬프트를 선택합니다. 운영 프롬프트는 검토 전 초안이므로 실제 환자·보호자 데이터를 이용한 배포 전에 별도의 임상·콘텐츠 검토가 필요합니다. `HOP_DUAL_EMOTION_ABSOLUTE=3`, `HOP_DUAL_EMOTION_DELTA=2`, `HOP_DUAL_RISK_ABSOLUTE=2`, `HOP_DUAL_RISK_DELTA=1`은 **검증 전 제안값**입니다. 운영자가 `HOP_DUAL_THRESHOLD_VERSION`과 함께 변경할 수 있으며, 서열 척도의 변화량은 진단이나 실제 위험 확률이 아닙니다.

## 현재 검증 범위

GPU 없이 엄격 JSON, 환자/보호자 귀속, 판단 불가, 버전별 비교, 알림 정책, B→A 순서, B 실패·시간 초과, A JSON 실패·재시도, 요청 멱등성, 취소·정정·삭제를 합성 모델과 PostgreSQL로 검증합니다. 실제 학습 체크포인트의 JSON Schema 제약 지원, 한국어 귀속 정확도, 응답 품질, 지연·부하·임계값의 타당성은 아직 검증되지 않았습니다. 해당 검증 전까지 `model_validation=not_release_validated`를 유지합니다.
