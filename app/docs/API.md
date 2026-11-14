> 새 대화는 `malssi-intake-3.0.0-rc1`의 [v3 질문 계약](QUESTIONS.md)을 따릅니다. 질문·근거·정책 묶음은 대화 시작 시 고정하며, 이전 대화는 당시 스냅샷과 호환 계약을 유지합니다.

# API 계약

동일 Origin에서 호출합니다. `/api/bootstrap`은 `HttpOnly; SameSite=Strict` 익명 쿠키를 만들고 `csrf_token`을 반환합니다. 이후 세션 변경 요청에 `X-CSRF-Token`을 보내고 본문은 JSON으로 전달합니다. 세션을 잃었을 때의 삭제 키 경로는 별도 자격증명과 명시적인 동일 Origin을 요구합니다. 세션 토큰·삭제 키·모델 키는 로그에 남기지 않습니다.

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
| `GET /api/intakes/:id/progress` | `{revision,progress,cards}` 진행 메타데이터·검토를 통과한 카드; 소유자만 조회 |
| `POST /api/intakes/:id/result` | `{revision}`로 실제 모델 결과 생성·저장; 완료 재시도는 기존 기록 반환 |
| `GET /api/records` | `{records, incomplete_intakes, conversation_epoch}` 최신순 완료 기록 및 미완료 요약 |
| `GET /api/records/:id` | `{record}` 상세 |
| `POST /api/records/:id/continuations` | `{request_id,conversation_epoch}`로 추가 대화 시작/활성 회차 재개; `201 {continuation}` |
| `GET /api/records/:id/continuations` | `{continuations}` 원본에 연결된 회차 메타데이터; 생성 순서 |
| `GET /api/continuations/:id` | `{continuation}` 저장된 메시지·대기 요청·새 카드 복원 |
| `POST /api/continuations/:id/messages` | `{revision,request_id,text,reply_to?,skipped?}`로 추가 질문/상황 전송; `{continuation}` |
| `POST /api/continuations/:id/corrections` | `{revision,request_id,answer_ref,replacement}`로 사용자 메시지 정정; `{continuation}` |
| `POST /api/continuations/:id/cards` | `{revision,request_id}`로 검증된 추가 상황의 새 카드 생성; `{continuation,card}` |
| `POST /api/continuations/:id/complete` | `{revision,request_id}`로 추가 대화 마치기; `{continuation}` |
| `DELETE /api/continuations/:id` | 선택 회차 삭제·이후 파생 내용 무효화; `{deleted:true}` |
| `DELETE /api/records/:id` | 기록과 연결된 대화/상태 이력 삭제; `{deleted, intake_id}` |
| `DELETE /api/intakes/:id` | 완료 여부와 무관하게 대화와 결과·상태·이력 삭제; `{deleted, record_ids}` |
| `DELETE /api/conversations` | 소유자의 완료·미완료 대화/결과 전체 삭제; `{deleted, conversation_epoch}`. 칼럼 상태 유지 |
| `POST /api/deletion-key` | 인증된 세션+CSRF로 `{}` 전송; `201 {deletion_key}`. 새 256비트 키를 한 번 반환하며 이전 키는 무효화 |
| `POST /api/conversations/delete-with-key` | `{deletion_key}`로 해당 소유자의 대화만 삭제. 쿠키·CSRF 불필요, 명시적인 허용 Origin 필수. `{deleted,current_session,conversation_epoch?}` |
| `GET /api/columns` | `category=전체/우울/불안/중독/통합`, `only=unread/saved` 필터 |
| `GET /api/columns/today?date=YYYY-MM-DD` | 호환용 오늘의 글 API; 현재 화면에서는 미사용 |
| `GET /api/columns/random?exclude=listen` | 호환용 다른 글 뽑기 API; 현재 화면에서는 미사용 |
| `GET /api/columns/:article` | 칼럼과 상태 |
| `PATCH /api/columns/:article/state` | `{read:true}` 또는 `{saved:true/false}`; 읽음 취소는 기존 UI에 없어 받지 않음 |

질문 카탈로그와 새 상담은 `questions` 테이블에서 읽습니다. 진행 중 상담은 시작 시 질문 스냅샷을 사용합니다. 문맥의 `question_set_version`으로 당시 구성의 해시를, `bundle_id`로 질문셋 판본을 확인할 수 있습니다. 관리 방법은 [질문 관리](QUESTIONS.md)를 참고하세요.

## 답변

```json
{
  "revision": 0,
  "question_id": "q3_01",
  "instance_id": "malssi-intake-3.0.0-rc1:q3_01:1",
  "selected": [0],
  "custom": "무리하지 않고 말을 꺼낼 방법을 정리하고 싶어요.",
  "response_event": "answered"
}
```

새 대화에서는 응답의 현재 `question.id`·`question.instance_id`와 `revision`을 사용합니다. `instance_id`를 보내면 서버가 현재 질문 인스턴스와 대조합니다. `response_event`는 `answered`(기본), `unknown`, `skipped`, `refused`, `not_understood`, `stop` 중 하나입니다. 일반 입력에 포함된 “그만” 같은 인용 문구를 제어 이벤트로 간주하지 않습니다.

- `answered`: 보기의 0 기반 `selected`와 `custom`을 함께 보낼 수 있습니다. 서술형은 `text`로 보냅니다.
- 나머지 제어 이벤트에는 선택 보기를 함께 보내지 않습니다. `text`·`custom`은 원문으로 보존하되, 거절·종료·건너뜀의 문장을 일반 사실 근거로 채택하지 않습니다.
- 첫 `not_understood`는 등록 도움말을 한 번 표시하고 같은 질문 인스턴스를 유지합니다. 같은 질문에서 반복하면 건너뜁니다.
- `stop`은 종료 의사를 즉시 보존하고 일반 질문·새 일반 결과 생성을 막습니다. 모델 실패 후에도 종료 상태를 유지하며 같은 제출만 재시도할 수 있습니다.

아래의 “네, 직접 입력”, 필수·`noSkip`, 기존 `follow_up` 설명은 해당 속성이 있는 이전 질문 스냅샷의 호환 동작입니다. 새 v3 기본 질문에는 필수 이름·최소 답변 수 조건이 없습니다.

`selected`는 해당 질문 보기의 0 기반 번호입니다. 서버가 보기 문구·메타를 제공하고 검증합니다. 단일 보기에는 하나, 단독 보기에는 다른 선택을 함께 보낼 수 없습니다. “네, 직접 입력” 보기의 부가 문구는 `text`로 보냅니다. `follow_up:true`인 현재 질문에는 동일 플래그로 답해야 합니다.

선택적 서술형의 빈 문자열·공백만 있는 입력·정확한 건너뛰기 표시 문자열 `(건너뛰었어요)`는 `skipped:true`와 같은 건너뜀으로 정규화합니다. `skipped`가 생략되거나 false인 이전 클라이언트 요청에도 적용합니다. 이 문항은 답변 수·검색 문서·안전 근거 후보에 포함하지 않습니다. 필수 또는 `noSkip` 서술형은 같은 입력과 명시적 건너뜀을 기존 `400 answer_required`로 거절하며 상태를 바꾸지 않습니다. 단일 보기에서 “네”를 선택하고 선택적인 부가 설명만 비우면 선택 자체는 실제 답변으로 유지합니다. “모름”, “없음”처럼 실제로 입력한 문장은 그대로 보존합니다.

내용 유무는 UI·서버가 같은 함수로 판정합니다. 판정용 사본에서 Unicode `Cc`, `Cf`, `Default_Ignorable_Code_Point`와 가장자리 공백을 제외했을 때 빈값 또는 건너뛰기 표시만 남으면 내용 없는 입력입니다. 실제 내용이 있는 원문의 ZWJ·결합문자·앞뒤 공백은 삭제하지 않습니다. 선택형 `custom`에도 같은 기준을 적용해 필수·`noSkip`를 우회할 수 없게 합니다. 정상 선택과 함께 보낸 내용 없는 `custom`은 선택만 유지하며, 선택적 다중선택을 선택 없이 완료하는 기존 “해당 없음” 동작은 유지합니다. 선택한 “네”의 내용 없는 부가 설명은 원문 이력에 남을 수 있지만 검색·안전·상태 근거에는 포함하지 않습니다. 이 판정은 모든 글꼴의 시각적 공백을 탐지한다는 의미가 아닙니다.

응답은 `id,revision,name,chat_title,status,question,progress,section,canGoBack,log`를 포함합니다. `chat_title`은 이전 판본에서 모델이 이름 답변의 원문으로 추출한 호칭이며, 이름 문항을 사용하지 않는 v3에서는 보통 빈 문자열입니다. v3 응답은 `bundle_id`, `question_instances`, `maxQuestions:10`, `user_stopped`, `input_locked`, `safety_urgent`도 포함합니다. `status=ready`이면 현재 질문은 `null`입니다. UI는 전송한 글을 즉시 작성창에서 비우고 사용자 말풍선·대기 표시가 그려진 뒤 요청을 시작합니다. 재시도에는 별도로 보관한 같은 답변을 사용하며, 검증된 모델 상태를 받은 뒤 다음 질문을 표시합니다.

모델 호출이 필요한 답변은 원문을 먼저 `modelPending` 대기 상태로 저장하며 모델 실패 시 502/503/504 오류를 반환합니다. 다음 기본 질문으로 넘어가지 않습니다. 같은 답변으로 재시도하면 답변을 중복 저장하지 않고 모델 호출을 다시 진행합니다. 실패한 답변을 수정하면 해당 질문 직전 상태를 기준으로 대기 답변을 교체하며 수정 전 원문은 버전 이력에 남습니다. 현재 `relationship_agent`는 명시적 사용자 건너뛰기도 모델 상태 갱신을 거칩니다. 모델 미설정 경로와 기존 프로토콜의 건너뛰기 처리는 호환용 질문 진행 규칙을 사용합니다.

`GET /api/intakes/:id`에서 모델 처리가 남아 있으면 기존 질문·진행률과 사용자 말풍선을 유지하고 `model_pending:true`, `pending_answer`를 반환합니다. 동일 입력 재시도에는 최초 전송 버전 또는 조회한 현재 `revision`을 사용할 수 있습니다. 답변 수정·되돌리기·명시적 건너뛰기는 현재 버전이 필요합니다. 완료 응답을 받았다면 반환된 `revision`을 다음 요청에 사용합니다. 모델 오류나 409가 발생하면 대기 표시를 유지하면서 현재 상태를 다시 조회하고, 같은 질문의 입력창은 보존합니다.

## 관계도 기반 추가 질문과 새 카드

완료 기록의 원문 문맥과 관계 분석을 바탕으로 사용자가 자유롭게 질문하는 별도 대화입니다. 기존 설문 중의 `follow_up`과 구분하며, 완료 intake를 다시 열거나 원래 관계도·결과 카드를 수정하지 않습니다. 결과·기록 화면의 **추가 질문하기**로 진입하고 `/continuations/:id`에서 새로고침 후 복원합니다. 기록 보관키는 이 기능의 작성 권한을 주지 않습니다. 원래 기록의 익명 세션 소유권이 필요합니다.

### 요청과 반환 값

시작 요청의 `request_id`와 각 변경 요청의 `request_id`는 클라이언트가 만든 UUID입니다. 시작 시 최신 기록 목록의 `conversation_epoch`를 보냅니다. 한 원본에 활성 회차는 하나이며, 다른 시작 토큰으로 요청해도 기존 활성 회차를 반환합니다. 이미 처리한 시작 토큰은 회차를 마친 뒤에도 같은 회차를 가리킵니다. 회차를 삭제한 뒤 같은 시작 토큰으로 재전송하면 404이며 새 회차를 되살리지 않습니다.

자유 질문에는 `reply_to`가 필요 없습니다. 서비스가 마지막 메시지에 `clarification`을 제공했을 때 그 확인 질문에 답하거나 건너뛰려면 해당 assistant 메시지 ID를 `reply_to`로 보냅니다. `skipped:true`는 그 확인 질문이 현재 대기 중인 경우에만 허용하며 실제 내용 있는 `text`와 함께 보낼 수 없습니다. 일반 입력과 정정의 `replacement`는 최대 10,000자이며, 공백·비가시 문자만 있는 일반 입력은 거절합니다. 정정의 `answer_ref`는 해당 회차의 건너뛰지 않은 user 메시지 ID입니다.

`continuation`은 `id,source_record_id,revision,status,messages,pending,summary,cards,safety_urgent`를 반환합니다. 메시지는 `id,role,text,kind`와 선택적 `clarification,skipped`를 가집니다. 정정 전 원문 이력·내부 근거 추출·검토 기록·요청 해시는 공개 응답에 포함하지 않습니다. 목록은 원문 없는 `id,source_record_id,source_intake_id,revision,status,created_at,updated_at`만 생성 순서로 반환합니다.

### 입력 저장·재시도·종료

- 새 메시지를 받은 뒤 원문과 요청 ID를 먼저 암호화 저장하고 `status=pending`으로 둡니다. 이후 모델 작업을 수행하며 검증된 답변만 공개 상태로 저장합니다.
- `pending`은 `{action,request_id,input,resume_status}`입니다. `action`은 `messages` 또는 `cards`이며, 소유자는 저장된 `input`으로 같은 요청을 재시도할 수 있습니다. 원문은 URL이나 로그에 넣지 않습니다.
- 같은 요청 ID와 같은 입력의 재전송은 사용자 메시지·완료 카드가 중복되지 않습니다. 처리 완료 후에도 같은 요청 ID는 현재 회차와 이미 생성된 해당 카드를 반환합니다. 같은 ID로 입력이나 작업 종류를 바꾸거나 무효화된 요청 ID를 재사용하면 409입니다.
- 새 입력·정정·종료에는 현재 `revision`이 필요합니다. 모델 실패·연결 종료 뒤에는 입력과 pending을 보존하고 같은 ID로 재시도합니다. 새 질문을 보내려면 pending을 재시도하거나 정정·종료로 정리합니다.
- `complete`는 pending 작업을 취소하고 회차를 `completed`로 저장합니다. 별도 요약 모델을 호출하지 않고, 마지막 검토에서 확인한 사실 인용 또는 고정 종료 안내를 요약으로 남깁니다. 완료 회차에 새 메시지를 추가하려면 새 회차를 시작합니다. 저장된 실제 상황으로 카드 생성은 완료 후에도 요청할 수 있습니다. 이때는 `status=completed`를 유지한 채 `pending`만 설정하므로 더 새로운 활성 회차와 충돌하지 않습니다. 미검토 메시지를 남기고 종료할 때에는 이전 사실을 새 요약으로 확정하지 않고 고정 종료 안내를 사용합니다.
- DB 상태는 `active,pending,retryable,completed`를 허용하지만 현재 모델 실패 경로는 `pending`을 유지합니다. 실패했다고 자동으로 완료 처리하지 않습니다.

### 사실 검증과 카드 생성

현재 관계 모델 전송 계층에서 `continuation_answer`를 작성하고, `support_review_continuation`이 답변·추출 사실·정정 대상·확인 질문을 독립 검토합니다. 이어 `safety_review_continuation`이 사용자 메시지 전체를 기존 안전 분류 계약으로 확인합니다. 정확한 인용·메시지 ID·주체 검증은 저장 경계에서도 수행합니다. 질문·가정·실행 전 제안·모델 답변·건너뜀은 사용자 사실로 채택하지 않도록 검토합니다. 관계도는 당시 해석이며 사실의 대체 근거가 아닙니다. 이는 검증 절차의 구현 설명으로, 실제 모델이 모든 의미 오류를 차단했다는 검증 결과는 아닙니다.

**새 카드 만들기**는 추가 상황을 입력한 뒤 사용자가 직접 요청합니다. 검토된 실제 후속 보고와 유효한 기존 원문을 새 문맥에 결합하고, 명시적으로 정정된 원문은 새 문맥에서 제외합니다. 이전 모델 메모리는 재사용하지 않으며 기존 카드 생성·검토 경로로 새 카드를 준비합니다. 독립 안전 검토가 확인한 현재 위험은 사실 추출에서 누락됐더라도 전체 근거를 새 카드 문맥에 전달하고, 안전 상황을 반영하지 않은 결과는 저장하지 않습니다. 실제 추가 사실이 없고 긴급 안전 상황도 아니면 `409 NO_NEW_FACTS`를 반환합니다. 이 경우 해당 카드 시도만 무효화하고 pending을 해제하여 사용자가 상황을 더 입력할 수 있게 합니다.

완성된 `card`는 `{id,date,profile,guide,relationship_analysis?,conversation_detail?,source_revision,provenance}`입니다. 후속 회차의 암호화된 `state.cards`에 추가하며 **기존 `records` 목록에 새 행을 만들지 않습니다**. 원래 관계도·카드·intake는 그대로 보존합니다. 화면은 기존 공용 카드 컴포넌트와 복사 기능을 재사용하며, 후속 카드 API는 전체 검토와 저장이 끝난 스냅샷을 반환합니다. 기존 intake의 부분 카드 진행 조회와는 별개입니다.

안전 검토가 명시적 긴급 상황을 확인하면 후속 회차를 `completed`로 마치고 고정 안전 안내와 `safety_urgent:true`를 반환합니다. 사실 추출에서 빠진 사용자 원문도 안전 검토에 전달합니다. 불씨 기관 안내를 대화 중 자동으로 추가하는 기능은 구현하지 않습니다.

### 정정·삭제·접근 경계

정정은 해당 회차의 사용자 메시지를 갱신하고 이전 원문을 암호화된 이력으로 남깁니다. 현재 회차의 assistant 답변·카드·검토 요약은 제거하며, 같은 원본의 이후 회차도 자체 user 메시지만 보존하고 파생 답변·카드·요약·pending을 제거합니다. 이후 완료 회차의 완료 상태는 유지합니다. 무효화된 회차의 revision은 증가하고 요청 ID에는 `action,hash,status=invalidated`만 남겨 오래된 입력의 재전송을 차단합니다.

회차 하나를 삭제해도 원본 기록은 남습니다. 해당 회차를 참조할 수 있는 이후 회차에는 같은 무효화 규칙을 적용합니다. 원본 record/intake 삭제, 전체 대화 삭제, 삭제 키 사용, 소유자 보유기간 만료는 연결된 후속 회차·카드·시작 토큰까지 삭제합니다. 삭제·정정·종료는 진행 중 작업을 취소하고 revision/존재 여부로 늦은 결과의 저장을 차단합니다. 소유하지 않은 자원은 404, Origin·CSRF 오류는 403으로 처리합니다.

주요 추가 오류는 `SOURCE_CONTEXT_UNAVAILABLE`(원문 없는 이전 기록), `INTAKE_NOT_COMPLETE`, `CONTINUATION_PENDING`, `CONTINUATION_COMPLETE`, `NO_NEW_FACTS`, `REVISION_CONFLICT`(이상 409), `INVALID_REQUEST_ID`, `INVALID_CLARIFICATION`, `INVALID_MESSAGE`, `ANSWER_REQUIRED`(이상 422)입니다. 현재 카드·관계도 표시 제한과 향후 검증 기준은 [추가 질문 기능 기획·구현](../../최신/관계도_기반_추가질문_기획.md)을 따릅니다.

## 서버 내부 상태

`context`는 다음 책임을 분리합니다.

- `patient.fields`: v3에서는 Q3-02·03·04·07의 질문별 원문 근거.
- `supporter.fields`: v3에서는 Q3-01·05·06·08·09의 질문별 원문 근거.
- 이 구분은 입력 문항의 출처이며 답변 속 모든 사건의 행위자를 뜻하지 않습니다. 복합 답변의 실제 말·행동 주체는 원문에서 별도로 확인합니다.
- `user_goal`: 사용자가 전하고 싶은 말과 원하는 도움.
- `payload`: 기존 UI의 모델 입력 계약인 원문 답변·선택 보기·태그.
- `agent_state`: 실제 모델이 수정한 요약·근거별 해석·미확인 정보.

모델 상태의 각 `facts`에는 `subject`, `question_id`, `quote`, `interpretation`, `certainty`가 있습니다. 서버는 현재 답변에 실제로 포함된 인용만 허용하고 당사자/주변인 필드를 섞지 않습니다. 모델의 이전 메모리만으로 근거를 만들 수 없습니다. `unknown` 보기를 확정된 내용으로 승격하지 않습니다. 건너뛴 답변과 미질문에는 사실을 만들 수 없습니다.

원문 상태와 모델 메모리를 동일 트랜잭션에서 버전으로 보존합니다. 외부 모델 호출은 DB 잠금을 잡은 채 실행하지 않습니다. 늦게 도착한 모델 응답은 원래 버전이 달라졌다면 현재 상태에 덮어쓰지 않습니다. 되돌리기는 이후 답변·태그·후속 질문·로그와 그에 따른 모델 해석을 무효화합니다.

세션 쿠키와 상담 보관은 분리합니다. `DATA_RETENTION_DAYS`는 마지막 유효 세션 API 접근 이후의 보유기간이며 개발 기본값은 30일, 허용 범위는 정수 1~90일입니다. 보유기간에 도달하면 기존 세션 접근과 상담 재저장을 차단하고, 앱 시작 시와 실행 중 매시간 소유자 행을 연쇄 삭제합니다. 세션 만료 자체가 즉시 데이터 삭제를 의미하지는 않습니다. bootstrap의 `retention`은 `{inactivity_days,cleanup_interval_seconds}`를 반환합니다. 청소 실패 시 `/health`는 `503`, `retention_cleanup_ok:false`를 반환하며 다음 주기에 재시도합니다.

내 기록의 개별/전체 삭제 및 삭제 키는 관련 상담 원문·결과·현재 상태·수정 이력을 소유자 범위 트랜잭션으로 제거하며 칼럼의 읽음·담음은 보존합니다. 자동 보유기간 삭제는 세션·삭제 키 해시·칼럼 상태도 함께 제거합니다. 삭제 키는 조회·복구 권한을 주지 않으며 원문 키는 DB에 저장하지 않습니다. 같은 키로 재시도할 수 있고 새 키 발급 시 이전 키는 무효화됩니다. `current_session`은 전달한 쿠키가 삭제 대상과 같은지 알려 주어 화면 캐시를 지우는 용도이며, 만료 쿠키의 조회 권한을 되살리지 않습니다. 다른 소유자 또는 쿠키 없는 요청에는 epoch도 반환하지 않습니다. 키 없는 접근 상실은 보유기간 삭제로 처리하며, 이름·내용으로 소유자를 추정해 삭제하지 않습니다. 자세한 집행·마이그레이션·백업 한계는 [보유와 삭제 운영 계약](DATA_RETENTION.md)을 참고하세요.

## 현재 관계 에이전트 프로토콜

`MODEL_PROTOCOL=relationship_agent`가 새 v3 묶음을 처리합니다. 새 로컬 설치는 `MODEL_STATE_MODE=combined_blocks`를 사용하며 상태·이름·관계 기억·질문 블록을 나누어 생성한 뒤 전체 검증과 독립 검토를 수행합니다. `combined`는 통합 초안 경로, `staged`는 관찰·관계 기억·상태 검토·질문 계획의 순차 경로입니다. 호출 수는 모드·질문 및 안전 검토·재시도에 따라 달라집니다.

질문 계획은 이미 다룬 내용(`already_covered`)과 현재 맥락에 불필요한 질문(`not_needed`)을 구분합니다. 직접 답하지 않은 질문도 원문과 요청 목적이 생략 사유를 지지하면 생략할 수 있습니다. v3의 최소 답변 수는 0이며 기본 9문항과 필요한 확인 1문항을 합쳐 최대 10개 질문 인스턴스를 발행합니다. 확인 질문 Q3-10은 현재 답변 원문의 revision·구간·한 사건·한 축에 결합하고 독립 검토를 통과해야 합니다. 생략은 `auto_skipped` 결정으로 저장하며 답변·사실을 만들어 채우지 않습니다.

답변·모름·거절·건너뜀을 단순 미응답으로 되돌려 반복 질문하지 않으며, 요청 목적이나 일반 답변을 정정하면 아직 제시하지 않은 질문의 필요성을 다시 판단합니다. 마지막 Q10에서 돌아와 앞선 답변을 정정한 경우에도 같은 규칙을 적용하며, 무효화된 Q10을 다시 발급하거나 사용 예산을 환불하지 않습니다. 즉각적 위험에 따른 조기 종료에는 전체 원문과 독립된 안전 검토가 필요합니다. 최종 결과는 기존 가이드에 `relationship_analysis`, 선택적 `conversation_detail`, `provenance.agent`의 실행·검토·검색 정보를 더합니다. 단계별 출력·근거·저장 계약은 [관계 에이전트 계약](RELATIONSHIP_AGENT.md)을 따릅니다.

## 이전 프로토콜 호환 계약

아래는 이전 질문 판본에 대한 `json_prompt`·`json_schema` 호환 경로의 설명입니다. 이 프로토콜로 새 v3 묶음을 처리하면 모델 호출 전에 `MODEL_PROTOCOL_UNSUPPORTED`로 거절합니다. 상태 모델은 `{patient_state,name_index,question_plan:{skip:[]}}`를 JSON으로 반환하며 이 경로에서는 검증된 생략 항목을 허용합니다. 이름 인덱스는 `{alias,source_question_id:"name",quote}`이며 실제 이름 입력·후속 답변만 인용할 수 있습니다. `skip` 항목은 `{question_id,reason,explanation,evidence:[{subject,question_id,quote}]}`입니다. 현재 미응답 후보만 선택하고 `already_covered`는 이미 답한 원문 근거를 요구합니다. `not_needed`는 5개 이상 답변 이후의 선택 질문만 허용합니다. 이름·전하고 싶은 말·원인 분기 기준은 제외하고 필수 질문은 `already_covered`만 허용합니다. 결정은 `auto_skipped` 상태와 근거로 저장하며 `payload.answers`에 답변을 만들지 않습니다. 최종 내부 결과는 `{guide,patient_state,assessment,name_index}`입니다.

`MODEL_PROTOCOL=json_prompt`인 학습 모델은 지원하는 텍스트 Chat Completions 필드만 사용합니다. 상태 정리와 최종 가이드는 모델 서버가 공개한 출력 상한을 사용하고 공개하지 않으면 `max_tokens`를 생략하며 `user_goal`은 서버 원문으로 채웁니다. 모델 JSON의 `guide,assessment`에 검증된 상태·이름 인덱스를 결합한 뒤 동일 검증을 적용합니다. `script`는 5~8문장·약 300~500자, `doList,avoid,care.tips`는 각각 3~4개 항목을 목표로 요청하고 방법·이유·대안을 구체적으로 설명하게 합니다. 이는 생성 목표로 분량을 채우기 위한 사실 추가·반복은 금지하며, 응답 길이 자체를 새로운 실패 조건으로 삼지 않습니다. 현재 결과 화면과 저장 구조로 긴 가이드를 그대로 표시·보관합니다. 모델 입력에 전체 대화 로그를 중복 전송하지 않습니다. `json_schema`인 Ollama 경로도 별도 출력 토큰 상한 없이 같은 상세 지침을 사용하며 JSON Schema 출력 제약을 유지합니다. 두 경로 모두 근거 없는 JSON을 저장하지 않습니다.

## 생성 진행 조회

최종 결과 요청과 같은 소유자·대화·revision의 실행을 조회합니다. `cards`는 카드별 검토를 통과한 `{id,value,detail?}`의 스냅샷이며 완료 순서로 정렬됩니다. `id`는 `care`, `doList`, `avoid`, `next`, `script`, `relationship` 중 하나입니다. 재검토가 필요한 카드는 제거되고, 승인된 수정본은 갱신되며, 실행 취소·전체 재시도에서는 이전 카드가 사라집니다. 화면은 스냅샷에 없는 카드를 지우고 기존 DOM을 유지하며 순서를 동기화합니다. `progress`는 `status`, `completed:[{label}]`, `current`, `attempt`만 공개하며 원문·초안·내부 추론은 보내지 않습니다. 실패한 시도에는 완료 칸을 추가하지 않습니다. 중복 결과 요청은 같은 실행과 진행 정보를 공유합니다. DB records 저장까지 끝나면 `complete`, 모델 결과만 대화에 보존되고 기록 저장이 실패하면 `failed`, 실행이 없으면 `idle`을 반환하며 서버 재시작 뒤에는 이전 실행의 진행 목록을 복원하지 않습니다. 삭제한 대화와 다른 소유자의 대화는 404입니다.

## 결과와 오류

`result`는 `{record,revision}`을 반환합니다. `record`의 `profile,guide,log,followUps`는 현재 결과·기록 화면과 같습니다. `profile.scores={}`이며 임의 수치 평가는 없습니다. `guide.top`은 칼럼 분류용입니다. `provenance.kind=model`, 요청 모델 이름, `source_sha256`을 내부적으로 기록합니다. `/health`의 앱 해시와 대조할 수 있습니다. `runtime_model_identity_verified:false`이며 모델 alias만으로 실제 체크포인트를 확인했다는 뜻은 아닙니다.

오류는 `{error:{code,message,request_id}}`입니다. 원문이나 인증 키는 포함하지 않습니다. 주요 상태는 400/422 입력 오류, 401 익명 세션 만료, 403 Origin/CSRF 거부, 404 소유하지 않은 자원, 409 버전 충돌, 429 요청 제한, 502 모델 출력 검증 실패, 503 모델 연결/인증 문제, 504 모델 응답 제한 시간입니다.

## 삭제와 동시 요청

- `incomplete_intakes`는 완료 기록이 없는 상담의 `{id, title, updated_at}` 요약만 반환하며 답변 원문·상태·이력을 목록에 추가하지 않습니다.
- 전체 삭제와 새 상담 생성·결과 저장은 같은 브라우저 행을 잠급니다. 전체 삭제는 `conversation_epoch`를 증가시킵니다. 삭제 전에 시작한 생성 요청은 이전 epoch로 보내므로 삭제 뒤에 실행되면 `409 CONVERSATIONS_CHANGED`가 됩니다. 이 경우 최신 목록을 읽고 이용자가 다시 시작해야 합니다. epoch 누락·음수·비정수는 `422 INVALID_REVISION`입니다.
- 삭제된 상담의 진행 중 답변·결과 저장은 `404 NOT_FOUND`로 끝나며 새 행을 만들지 않습니다. 완료·미완료 목록과 epoch는 삭제/저장과 일관된 범위에서 읽습니다.
- 삭제 키도 동일 소유자 행 잠금과 epoch 증가를 사용합니다. 보유기간 청소는 해당 행을 제거하므로 진행 중인 생성·저장으로 삭제한 행을 재생성할 수 없습니다. 만료된 소유자는 청소 전이라도 신규 저장을 거절합니다.
- 화면은 개별/전체 삭제를 두 단계로 확인하고 성공 응답 후에만 로컬 기록·현재 대화를 지웁니다. 삭제 실패 시 목록과 입력을 유지합니다. 목록 요청 순서와 현재 대화 토큰으로 삭제 이전의 목록·응답·결과가 다시 표시되지 않게 합니다.

카드 작업은 공통 분석·계획 승인 후 최대 3개씩 병렬로 생성·개별 검토합니다. 부분 카드는 실행 메모리에만 있고, 최종 전체 검토가 통과한 결과만 기록으로 저장합니다. 저장 트랜잭션이 끝나기 전에는 원래 요청 revision으로 `saving`을 반환합니다. 저장 실패 재시도는 보존된 최종 결과를 재사용하며 모델을 다시 호출하지 않습니다.
