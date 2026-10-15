# API 계약

동일 Origin에서 호출합니다. `/api/bootstrap`은 `HttpOnly; SameSite=Strict` 익명 쿠키를 만들고 `csrf_token`을 반환합니다. 이후 변경 요청에 `X-CSRF-Token`을 보내고 본문은 JSON으로 전달합니다. 토큰과 모델 키는 로그에 남기지 않습니다.

| 경로 | 기능 |
|---|---|
| `GET /health` | 프로세스 상태, 모델 설정 유무·요청 이름, 앱 소스 해시·프롬프트 버전; 실제 모델 로딩을 보증하지 않음 |
| `GET /api/bootstrap` | 완료 기록·미완료 대화 요약, conversation_epoch, 칼럼 상태·목록·분류, 정확한 질문 목록, CSRF 토큰 |
| `GET /api/questions` | DB의 현재 활성 문항 카탈로그 |
| `POST /api/intakes` | `{conversation_epoch}`로 새 대화 생성; bootstrap 또는 최신 목록의 값을 사용 |
| `GET /api/intakes/:id` | 현재 질문·진행률·대화 로그 |
| `POST /api/intakes/:id/answers` | 원문 답변 저장 → 모델 상태 갱신 → 다음 질문 |
| `POST /api/intakes/:id/back` | `{revision}`로 이전 질문 상태 복원; 첫 문항까지 반복 가능, 후속 질문에서는 본 질문 복원 |
| `GET /api/intakes/:id/context` | `{id,revision,context}` 현재 서버 상태 |
| `POST /api/intakes/:id/result` | `{revision}`로 실제 모델 결과 생성·저장; 완료 재시도는 기존 기록 반환 |
| `GET /api/records` | `{records, incomplete_intakes, conversation_epoch}` 최신순 완료 기록 및 미완료 요약 |
| `GET /api/records/:id` | `{record}` 상세 |
| `DELETE /api/records/:id` | 기록과 연결된 대화/상태 이력 삭제; `{deleted, intake_id}` |
| `DELETE /api/intakes/:id` | 완료 여부와 무관하게 대화와 결과·상태·이력 삭제; `{deleted, record_ids}` |
| `DELETE /api/conversations` | 소유자의 완료·미완료 대화/결과 전체 삭제; `{deleted, conversation_epoch}`. 칼럼 상태 유지 |
| `GET /api/columns` | `category=전체/우울/불안/중독/통합`, `only=unread/saved` 필터 |
| `GET /api/columns/today?date=YYYY-MM-DD` | 호환용 오늘의 글 API; 현재 화면에서는 미사용 |
| `GET /api/columns/random?exclude=listen` | 호환용 다른 글 뽑기 API; 현재 화면에서는 미사용 |
| `GET /api/columns/:article` | 칼럼과 상태 |
| `PATCH /api/columns/:article/state` | `{read:true}` 또는 `{saved:true/false}`; 읽음 취소는 기존 UI에 없어 받지 않음 |

질문 카탈로그와 새 상담은 `questions` 테이블에서 읽습니다. 진행 중 상담은 시작 시 질문 스냅샷을 사용합니다. 문맥의 `question_set_version`으로 당시 구성을 확인할 수 있습니다. 관리 방법은 [질문 관리](QUESTIONS.md)를 참고하세요.

## 답변

```json
{
  "revision": 0,
  "question_id": "name",
  "text": "친구",
  "selected": [],
  "custom": "",
  "skipped": false,
  "follow_up": false
}
```

`selected`는 해당 질문 보기의 0 기반 번호입니다. 서버가 보기 문구·메타를 제공하고 검증합니다. 단일 보기에는 하나, 단독 보기에는 다른 선택을 함께 보낼 수 없습니다. “네, 직접 입력” 보기의 부가 문구는 `text`로 보냅니다. `follow_up:true`인 현재 질문에는 동일 플래그로 답해야 합니다.

선택적 서술형의 빈 문자열·공백만 있는 입력·정확한 건너뛰기 표시 문자열 `(건너뛰었어요)`는 `skipped:true`와 같은 건너뜀으로 정규화합니다. `skipped`가 생략되거나 false인 이전 클라이언트 요청에도 적용합니다. 이 문항은 답변 수·검색 문서·안전 근거 후보에 포함하지 않습니다. 필수 또는 `noSkip` 서술형은 같은 입력과 명시적 건너뜀을 기존 `400 answer_required`로 거절하며 상태를 바꾸지 않습니다. 단일 보기에서 “네”를 선택하고 선택적인 부가 설명만 비우면 선택 자체는 실제 답변으로 유지합니다. “모름”, “없음”처럼 실제로 입력한 문장은 그대로 보존합니다.

내용 유무는 UI·서버가 같은 함수로 판정합니다. 판정용 사본에서 Unicode `Cc`, `Cf`, `Default_Ignorable_Code_Point`와 가장자리 공백을 제외했을 때 빈값 또는 건너뛰기 표시만 남으면 내용 없는 입력입니다. 실제 내용이 있는 원문의 ZWJ·결합문자·앞뒤 공백은 삭제하지 않습니다. 선택형 `custom`에도 같은 기준을 적용해 필수·`noSkip`를 우회할 수 없게 합니다. 정상 선택과 함께 보낸 내용 없는 `custom`은 선택만 유지하며, 선택적 다중선택을 선택 없이 완료하는 기존 “해당 없음” 동작은 유지합니다. 선택한 “네”의 내용 없는 부가 설명은 원문 이력에 남을 수 있지만 검색·안전·상태 근거에는 포함하지 않습니다. 이 판정은 모든 글꼴의 시각적 공백을 탐지한다는 의미가 아닙니다.

응답은 `id,revision,name,chat_title,status,question,progress,section,canGoBack,log`를 포함합니다. `chat_title`은 모델이 이름 답변의 실제 원문에서 추출한 호칭이며 식별되지 않으면 빈 문자열입니다. `status=ready`이면 현재 질문은 `null`입니다. UI는 전송한 글을 즉시 작성창에서 비우고 사용자 말풍선·대기 표시가 그려진 뒤 요청을 시작합니다. 재시도에는 별도로 보관한 같은 답변을 사용하며, 검증된 모델 상태를 받은 뒤 다음 질문을 표시합니다.

모델 호출이 필요한 답변은 원문을 먼저 `modelPending` 대기 상태로 저장하며 모델 실패 시 502/503/504 오류를 반환합니다. 다음 기본 질문으로 넘어가지 않습니다. 같은 답변으로 재시도하면 답변을 중복 저장하지 않고 모델 호출을 다시 진행합니다. 실패한 답변을 수정하면 해당 질문 직전 상태를 기준으로 대기 답변을 교체하며 수정 전 원문은 버전 이력에 남습니다. 현재 `relationship_agent`는 명시적 사용자 건너뛰기도 모델 상태 갱신을 거칩니다. 모델 미설정 경로와 기존 프로토콜의 건너뛰기 처리는 호환용 질문 진행 규칙을 사용합니다.

`GET /api/intakes/:id`에서 모델 처리가 남아 있으면 기존 질문·진행률과 사용자 말풍선을 유지하고 `model_pending:true`, `pending_answer`를 반환합니다. 동일 입력 재시도에는 최초 전송 버전 또는 조회한 현재 `revision`을 사용할 수 있습니다. 답변 수정·되돌리기·명시적 건너뛰기는 현재 버전이 필요합니다. 완료 응답을 받았다면 반환된 `revision`을 다음 요청에 사용합니다. 모델 오류나 409가 발생하면 대기 표시를 유지하면서 현재 상태를 다시 조회하고, 같은 질문의 입력창은 보존합니다.

## 서버 내부 상태

`context`는 다음 책임을 분리합니다.

- `patient.fields`: 당사자에 대한 관계·관찰·전언·대처·도움과 생활 배경의 질문별 원문 근거.
- `supporter.fields`: 앱 이용자의 힘든 순간·감정·부담·대처·지원 자원.
- `user_goal`: 사용자가 전하고 싶은 말과 원하는 도움.
- `payload`: 기존 UI의 모델 입력 계약인 원문 답변·선택 보기·태그.
- `agent_state`: 실제 모델이 수정한 요약·근거별 해석·미확인 정보.

모델 상태의 각 `facts`에는 `subject`, `question_id`, `quote`, `interpretation`, `certainty`가 있습니다. 서버는 현재 답변에 실제로 포함된 인용만 허용하고 당사자/주변인 필드를 섞지 않습니다. 모델의 이전 메모리만으로 근거를 만들 수 없습니다. `unknown` 보기를 확정된 내용으로 승격하지 않습니다. 건너뛴 답변과 미질문에는 사실을 만들 수 없습니다.

원문 상태와 모델 메모리를 동일 트랜잭션에서 버전으로 보존합니다. 외부 모델 호출은 DB 잠금을 잡은 채 실행하지 않습니다. 늦게 도착한 모델 응답은 원래 버전이 달라졌다면 현재 상태에 덮어쓰지 않습니다. 되돌리기는 이후 답변·태그·후속 질문·로그와 그에 따른 모델 해석을 무효화합니다.

세션 쿠키와 상담 보관은 분리합니다. 세션이 만료돼도 원문·결과·버전 이력을 자동 삭제하지 않습니다. 내 기록에서 완료 기록과 미완료 대화를 개별 삭제하거나 모두 삭제할 수 있습니다. 관련 상담 원문·결과·현재 상태·수정 이력은 소유자 범위 트랜잭션으로 제거하며 칼럼의 읽음·담음은 보존합니다. 쿠키 상실 또는 접근 기간 만료 후 복구/삭제 기능과 자동 보유기간 삭제는 제공하지 않습니다. 관리자 검증은 브라우저 세션에 의존하지 않는 로컬 `npm run export:verification`으로 수행합니다.

## 현재 관계 에이전트 프로토콜

`MODEL_PROTOCOL=relationship_agent`의 상태 출력은 `patient_state`, `relationship_memory`, `name_index`, `question_plan:{skip:[]}`입니다. 모델 판단으로 질문을 자동 생략하거나 새 질문을 만들지 않습니다. 서버의 조건부 분기·후속 질문·허용된 사용자 건너뛰기는 유지합니다. 최종 결과는 기존 가이드에 `relationship_analysis`와 `provenance.agent`의 실행·검토·검색 정보를 더합니다. 단계별 출력, 근거와 저장 계약은 [관계 에이전트 계약](RELATIONSHIP_AGENT.md)을 기준으로 합니다.

## 이전 프로토콜 호환 계약

아래는 현재 관계 에이전트가 아닌 `json_prompt`·`json_schema` 경로의 설명입니다. 상태 모델은 `{patient_state,name_index,question_plan:{skip:[]}}`를 JSON으로 반환하며 이 경로에서는 검증된 생략 항목을 허용합니다. 이름 인덱스는 `{alias,source_question_id:"name",quote}`이며 실제 이름 입력·후속 답변만 인용할 수 있습니다. `skip` 항목은 `{question_id,reason,explanation,evidence:[{subject,question_id,quote}]}`입니다. 현재 미응답 후보만 선택하고 `already_covered`는 이미 답한 원문 근거를 요구합니다. `not_needed`는 5개 이상 답변 이후의 선택 질문만 허용합니다. 이름·전하고 싶은 말·원인 분기 기준은 제외하고 필수 질문은 `already_covered`만 허용합니다. 결정은 `auto_skipped` 상태와 근거로 저장하며 `payload.answers`에 답변을 만들지 않습니다. 최종 내부 결과는 `{guide,patient_state,assessment,name_index}`입니다.

`MODEL_PROTOCOL=json_prompt`인 학습 모델은 지원하는 텍스트 Chat Completions 필드만 사용합니다. 상태 정리는 출력 최대 2,048토큰으로 수행하고 `user_goal`은 서버 원문으로 채웁니다. 최종 가이드는 최대 4,096토큰을 예약하며, 모델 JSON의 `guide,assessment`에 검증된 상태·이름 인덱스를 결합한 뒤 동일 검증을 적용합니다. `script`는 5~8문장·약 300~500자, `doList,avoid,care.tips`는 각각 3~4개 항목을 목표로 요청하고 방법·이유·대안을 구체적으로 설명하게 합니다. 이는 생성 목표로 분량을 채우기 위한 사실 추가·반복은 금지하며, 응답 길이 자체를 새로운 실패 조건으로 삼지 않습니다. 현재 결과 화면과 저장 구조로 긴 가이드를 그대로 표시·보관합니다. 모델 입력에 전체 대화 로그를 중복 전송하지 않습니다. `json_schema`인 Ollama 경로도 최종 출력 최대 4,096토큰과 같은 상세 지침을 사용하며 JSON Schema 출력 제약을 유지합니다. 두 경로 모두 근거 없는 JSON을 저장하지 않습니다.

## 결과와 오류

`result`는 `{record,revision}`을 반환합니다. `record`의 `profile,guide,log,followUps`는 현재 결과·기록 화면과 같습니다. `profile.scores={}`이며 임의 수치 평가는 없습니다. `guide.top`은 칼럼 분류용입니다. `provenance.kind=model`, 요청 모델 이름, `source_sha256`을 내부적으로 기록합니다. `/health`의 앱 해시와 대조할 수 있습니다. `runtime_model_identity_verified:false`이며 모델 alias만으로 실제 체크포인트를 확인했다는 뜻은 아닙니다.

오류는 `{error:{code,message,request_id}}`입니다. 원문이나 인증 키는 포함하지 않습니다. 주요 상태는 400/422 입력 오류, 401 익명 세션 만료, 403 Origin/CSRF 거부, 404 소유하지 않은 자원, 409 버전 충돌, 429 요청 제한, 502 모델 출력 검증 실패, 503 모델 연결/인증 문제, 504 모델 응답 제한 시간입니다.

## 삭제와 동시 요청

- `incomplete_intakes`는 완료 기록이 없는 상담의 `{id, title, updated_at}` 요약만 반환하며 답변 원문·상태·이력을 목록에 추가하지 않습니다.
- 전체 삭제와 새 상담 생성·결과 저장은 같은 브라우저 행을 잠급니다. 전체 삭제는 `conversation_epoch`를 증가시킵니다. 삭제 전에 시작한 생성 요청은 이전 epoch로 보내므로 삭제 뒤에 실행되면 `409 CONVERSATIONS_CHANGED`가 됩니다. 이 경우 최신 목록을 읽고 이용자가 다시 시작해야 합니다. epoch 누락·음수·비정수는 `422 INVALID_REVISION`입니다.
- 삭제된 상담의 진행 중 답변·결과 저장은 `404 NOT_FOUND`로 끝나며 새 행을 만들지 않습니다. 완료·미완료 목록과 epoch는 삭제/저장과 일관된 범위에서 읽습니다.
- 화면은 개별/전체 삭제를 두 단계로 확인하고 성공 응답 후에만 로컬 기록·현재 대화를 지웁니다. 삭제 실패 시 목록과 입력을 유지합니다. 목록 요청 순서와 현재 대화 토큰으로 삭제 이전의 목록·응답·결과가 다시 표시되지 않게 합니다.
