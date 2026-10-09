# API 계약

동일 Origin에서 호출합니다. `/api/bootstrap`은 `HttpOnly; SameSite=Strict` 익명 쿠키를 만들고 `csrf_token`을 반환합니다. 이후 변경 요청에 `X-CSRF-Token`을 보내고 본문은 JSON으로 전달합니다. 토큰과 모델 키는 로그에 남기지 않습니다.

| 경로 | 기능 |
|---|---|
| `GET /health` | 프로세스 상태와 모델 설정 유무; 실제 모델 준비 여부를 보증하지 않음 |
| `GET /api/bootstrap` | 기록, 칼럼 상태·목록·분류, 정확한 질문 목록, CSRF 토큰 |
| `GET /api/questions` | 30개 문항 카탈로그 |
| `POST /api/intakes` | `{}`로 새 대화 생성 |
| `GET /api/intakes/:id` | 현재 질문·진행률·대화 로그 |
| `POST /api/intakes/:id/answers` | 원문 답변 저장 → 모델 상태 갱신 → 다음 질문 |
| `POST /api/intakes/:id/back` | `{revision}`로 직전 질문 상태 복원 |
| `GET /api/intakes/:id/context` | `{id,revision,context}` 현재 서버 상태 |
| `POST /api/intakes/:id/result` | `{revision}`로 실제 모델 결과 생성·저장; 완료 재시도는 기존 기록 반환 |
| `GET /api/records` | `{records}` 최신순 기록 |
| `GET /api/records/:id` | `{record}` 상세 |
| `DELETE /api/records/:id` | 기록과 연결된 대화/상태 이력 삭제 |
| `GET /api/columns` | `category=전체/우울/불안/중독/통합`, `only=unread/saved` 필터 |
| `GET /api/columns/today?date=YYYY-MM-DD` | 기존 UI의 브라우저 날짜 계산식과 같은 오늘의 글 |
| `GET /api/columns/random?exclude=listen` | 제외한 글과 다른 글 뽑기 |
| `GET /api/columns/:article` | 칼럼과 상태 |
| `PATCH /api/columns/:article/state` | `{read:true}` 또는 `{saved:true/false}`; 읽음 취소는 기존 UI에 없어 받지 않음 |

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

응답은 `id,revision,name,status,question,progress,section,canGoBack,log`를 포함합니다. `status=ready`이면 현재 질문은 `null`입니다. 답변 저장 후 모델 실패 시 HTTP 200과 `model_warning`을 반환합니다. 입력은 이미 저장되어 있으며 다음 질문을 진행할 수 있습니다. 항상 반환된 `revision`을 다음 요청에 사용합니다. 409가 발생하면 현재 상태를 다시 조회합니다.

## 서버 내부 상태

`context`는 다음 책임을 분리합니다.

- `patient.fields`: 당사자에 대한 관계·관찰·전언·대처·도움과 생활 배경의 질문별 원문 근거.
- `supporter.fields`: 앱 이용자의 힘든 순간·감정·부담·대처·지원 자원.
- `user_goal`: 사용자가 전하고 싶은 말과 원하는 도움.
- `payload`: 기존 UI의 모델 입력 계약인 원문 답변·선택 보기·태그.
- `agent_state`: 실제 모델이 수정한 요약·근거별 해석·미확인 정보.

모델 상태의 각 `facts`에는 `subject`, `question_id`, `quote`, `interpretation`, `certainty`가 있습니다. 서버는 현재 답변에 실제로 포함된 인용만 허용하고 당사자/주변인 필드를 섞지 않습니다. 모델의 이전 메모리만으로 근거를 만들 수 없습니다. `unknown` 보기를 확정된 내용으로 승격하지 않습니다. 건너뛴 답변과 미질문에는 사실을 만들 수 없습니다.

원문 상태와 모델 메모리를 동일 트랜잭션에서 버전으로 보존합니다. 외부 모델 호출은 DB 잠금을 잡은 채 실행하지 않습니다. 늦게 도착한 모델 응답은 원래 버전이 달라졌다면 현재 상태에 덮어쓰지 않습니다. 되돌리기는 이후 답변·태그·후속 질문·로그와 그에 따른 모델 해석을 무효화합니다.

## 결과와 오류

`result`는 `{record,revision}`을 반환합니다. `record`의 `profile,guide,log,followUps`는 현재 결과·기록 화면과 같습니다. `profile.scores={}`이며 임의 수치 평가는 없습니다. `guide.top`은 칼럼 분류용입니다. `provenance.kind=model`과 모델 이름을 내부적으로 기록합니다.

오류는 `{error:{code,message,request_id}}`입니다. 원문이나 인증 키는 포함하지 않습니다. 주요 상태는 400/422 입력 오류, 401 익명 세션 만료, 403 Origin/CSRF 거부, 404 소유하지 않은 자원, 409 버전 충돌, 429 요청 제한, 502 모델 출력 검증 실패, 503 모델 연결/인증 문제, 504 모델 응답 제한 시간입니다.
