# 프론트엔드 연동 가이드

API 계약은 [openapi.json](../openapi.json), 브라우저용 TypeScript 클라이언트는 [client/index.ts](../client/index.ts)와 [client/types.ts](../client/types.ts)에 있습니다. 이 문서의 발화 예시는 합성 입력입니다.

## 1. 연결 주소와 인증 방식

프론트엔드와 API를 같은 origin으로 제공하는 구성을 권장합니다. 예를 들어 `https://hop.example.com`에서 프론트엔드를 열고 `/api/...`를 백엔드로 프록시하면 됩니다. origin에는 프로토콜·호스트·포트가 포함됩니다.

- REST JSON 요청·응답을 사용합니다. 메시지 응답은 추출·생성·검증·저장 이후 한 번에 반환됩니다. SSE나 WebSocket 연결은 필요하지 않습니다.
- 요청 본문이 있는 경우 `Content-Type: application/json`을 사용합니다.
- 기본 인증은 `hop_session` HttpOnly 쿠키입니다. 브라우저 요청에 `credentials: "include"`를 지정합니다.
- 쿠키를 JavaScript로 읽거나 토큰을 localStorage에 저장할 필요가 없습니다. 가입·로그인 응답의 `token`은 별도 Bearer 클라이언트용으로도 제공됩니다.
- Bearer 인증을 선택했다면 `Authorization: Bearer <token>`을 사용합니다. 잘못된 Authorization 헤더를 보내면 유효한 쿠키가 있어도 인증되지 않습니다.
- 쿠키 인증으로 POST·DELETE를 보낼 때는 허용된 `Origin`이 필요합니다. 일반 브라우저 fetch가 자동으로 붙입니다. 서버 간 호출은 Bearer 인증을 사용하거나 허용된 Origin을 명시해야 합니다.

별도 프론트엔드 origin을 사용하는 경우 서버 설정에 정확한 origin을 등록합니다.

```dotenv
HOP_PUBLIC_ORIGIN=https://api.example.com
HOP_CORS_ORIGINS=https://app.example.com,http://localhost:5173
HOP_COOKIE_SECURE=true
HOP_COOKIE_SAME_SITE=strict
```

`HOP_PUBLIC_ORIGIN`과 `HOP_CORS_ORIGINS`에는 경로, 끝의 슬래시, 와일드카드를 넣지 않습니다. `http://localhost:5173`과 `http://127.0.0.1:5173`은 다릅니다. 허용되지 않은 origin의 변경 요청은 `403 origin_denied`입니다.

CORS 허용과 쿠키의 SameSite 정책은 별개입니다. 서로 다른 사이트에서 쿠키를 보내야 한다면 HTTPS와 `HOP_COOKIE_SAME_SITE=none`이 필요하지만, 브라우저의 제3자 쿠키 정책으로 차단될 수 있습니다. 같은 origin 배포 또는 개발 서버의 `/api` 프록시를 먼저 사용하십시오. `SameSite=None`에는 `HOP_COOKIE_SECURE=true`가 필수입니다.

`X-Request-Id`는 HTTP 요청 추적용이고, 메시지 본문의 `request_id`는 중복 저장 방지용입니다. 서로 바꾸어 사용하지 않습니다. CORS 응답은 `X-Request-Id`와 `Retry-After`를 브라우저에 노출합니다.

## 2. TypeScript 클라이언트로 시작하기

저장소의 `client/` 폴더를 프론트엔드의 `src/hop-client/`로 복사하거나 워크스페이스 의존 경로로 연결합니다. 별도의 npm 패키지 설치나 Node 전용 모듈은 필요하지 않습니다. 아래 예시는 `src/`에서 사용하는 코드입니다. TypeScript 번들러 설정은 `.ts` 확장자 import를 지원해야 합니다.

```ts
import { HopClient, ApiError, createMessage } from "./hop-client/index.ts";
import type { MessageRequest, MessageResult } from "./hop-client/index.ts";

const api = new HopClient({
  baseUrl: "",           // 같은 origin; 별도 API라면 https://api.example.com
  timeoutMs: 330_000,
  retries: 0,            // 기본값. 화면에서 명시적으로 재시도
});

async function begin(email: string, password: string) {
  await api.login({ email, password });
  const { user } = await api.me();
  const project = await api.createProject();
  const { questions } = await api.questions();
  const initialQuestion = questions.find(
    question => question.id === project.pending_question_id,
  );
  return { user, project, initialQuestion };
}
```

새로고침 시 `api.me()`로 세션을 확인하고 프로젝트 목록을 불러오십시오. `401 unauthorized`이면 로그인 화면으로 전환합니다. 세션은 발급 후 7일간 유효합니다.

SDK는 기본적으로 쿠키 인증을 사용합니다. `getToken` 옵션을 주면 쿠키를 보내지 않는 Bearer 모드가 됩니다. SDK 자체는 토큰을 저장하지 않습니다. 가입·로그인·비밀번호 변경으로 새 토큰이 발급되면 Bearer 클라이언트는 메모리에 보관한 값을 갱신해야 합니다.

```ts
let sessionToken: string | null = null;
const bearerApi = new HopClient({
  baseUrl: "https://api.example.com",
  getToken: () => sessionToken,
});

async function loginWithBearer(email: string, password: string) {
  const result = await bearerApi.login({ email, password });
  sessionToken = result.token;
}
```

SDK 없이 쿠키로 호출할 때의 최소 형태입니다.

```ts
const response = await fetch("/api/projects", {
  method: "POST",
  credentials: "include",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "친구를 위한 도움 기록" }),
});
const result = await response.json();
if (!response.ok) {
  // result.code에 따라 입력 수정·로그인·재시도 상태로 전환
  throw new Error(result.detail);
}
// 성공 시 result 자체가 Project입니다.
```

## 3. 계정 API

| 작업 | 요청 | 성공 응답 | SDK |
|---|---|---|---|
| 초대 가입 | POST `/api/auth/register`; `{email,password,invite_code}` | 201 `{user,token,token_type:"bearer"}` + 쿠키 | `register(input)` |
| 로그인 | POST `/api/auth/login`; `{email,password}` | 200 가입과 동일한 형태 | `login(input)` |
| 현재 계정 | GET `/api/auth/me` | 200 `{user:{id,email}}` | `me()` |
| 로그아웃 | POST `/api/auth/logout`; `{}` | 200 `{logged_out:true}` | `logout()` |
| 비밀번호 변경 | POST `/api/auth/password`; `{current_password,new_password}` | 200 새 `AuthResponse` + 쿠키 | `changePassword(input)` |

가입은 서버에서 가입을 허용하고 올바른 팀 초대 코드를 제공했을 때만 가능합니다. 초대 코드를 프론트엔드 번들이나 공개 환경 변수에 넣지 말고 입력값으로 받습니다. 가입 비밀번호와 새 비밀번호는 12~128자이며, 새 비밀번호는 현재 비밀번호와 달라야 합니다. 이메일은 앞뒤 공백 제거와 소문자 정규화를 거칩니다.

로그아웃은 사용 중인 세션을 폐기합니다. 비밀번호 변경은 해당 사용자의 기존 세션을 모두 폐기하고 현재 응답에서 새 세션을 발급합니다. 다른 탭·기기의 다음 요청은 다시 로그인을 요구할 수 있습니다.

## 4. 프로젝트와 대화 목록

| 작업 | 요청 | 성공 응답 |
|---|---|---|
| 질문 목록 | GET `/api/questions` | `{questions,scored_scale:false}` |
| 프로젝트 생성 | POST `/api/projects`; `{}` 또는 `{title}` | 201 `Project` |
| 프로젝트 목록 | GET `/api/projects?limit=50&cursor=...` | `{projects,next_cursor}` |
| 프로젝트 조회 | GET `/api/projects/{id}` | `Project` |
| 프로젝트 삭제 | DELETE `/api/projects/{id}` | `{deleted:true}` |
| 메시지 목록 | GET `/api/projects/{id}/messages?limit=100&cursor=...` | `{messages,next_cursor}` |

프로젝트 제목은 80자 이내입니다. 제목을 생략하거나 빈 문자열을 보내면 기본 이름으로 생성합니다. 기본 이름인 프로젝트는 첫 발화 처리 시 제목이 바뀔 수 있으므로 메시지 응답의 `project.title`을 반영하십시오. 삭제는 해당 프로젝트의 메시지·프로필 변경 이력도 삭제하므로 화면에서 사용자의 삭제 의사를 확인한 뒤 요청하십시오.

프로젝트 생성·개별 조회 응답은 `{project:...}`로 감싸지 않습니다. 메시지 전송 응답만 `project` 필드를 포함합니다. 다른 사용자의 프로젝트는 조회·변경할 수 없습니다.

### 페이지네이션

| 목록 | 기본 limit | 최대 limit | 정렬·페이지 방향 |
|---|---:|---:|---|
| 프로젝트 | 50 | 100 | `updated_at DESC, id DESC`; 다음 페이지를 목록 뒤에 추가 |
| 메시지 | 100 | 500 | 최근 페이지부터 조회하되 페이지 안은 오래된 메시지부터 반환; 다음 페이지는 더 과거이므로 화면 앞에 추가 |

`next_cursor === null`이면 더 가져올 페이지가 없습니다. 커서는 불투명한 문자열로 취급하고 그대로 전달하십시오. 계정·프로젝트가 바뀌면 기존 커서를 버립니다. 잘못된 값은 `422 invalid_pagination` 또는 `422 invalid_cursor`로 반환됩니다.

```ts
const first = await api.messages(projectId, { limit: 50 });
let timeline = first.messages;
let olderCursor = first.next_cursor;

if (olderCursor) {
  const older = await api.messages(projectId, {
    limit: 50,
    cursor: olderCursor,
  });
  timeline = [...older.messages, ...timeline];
  olderCursor = older.next_cursor;
}
```

메시지는 서버가 반환한 순서를 유지하고 `id`로 중복을 제거하십시오. 같은 시각의 메시지가 있을 수 있으므로 `created_at`만으로 재정렬하지 않습니다. 프로젝트 목록은 새 메시지로 정렬이 바뀔 수 있으므로 전송 완료 시 첫 페이지를 갱신하고 `id`로 병합합니다. 페이지네이션은 특정 시점의 스냅샷을 고정하지 않습니다.

## 5. 메시지 전송과 중복 방지

POST `/api/projects/{id}/messages`에는 사용자 행동 한 번에 생성한 UUID `request_id`를 보냅니다.

| 행동 | 본문 예시 |
|---|---|
| 답변 입력 | `{request_id,text:"저는 친구이고 매주 연락합니다."}` |
| 현재 질문 건너뛰기 | `{request_id,skip:true}` |
| 확보된 정보로 코칭 요청 | `{request_id,coach_now:true}` |
| 추가 설명과 함께 코칭 요청 | `{request_id,text:"지금은 짧게 안부를 전하고 싶습니다.",coach_now:true}` |

`text`는 최대 8,000자입니다. `skip:true`는 텍스트나 `coach_now:true`와 함께 보낼 수 없습니다. 알 수 없는 필드는 거절됩니다. 17개 질문을 순서대로 모두 제출할 필요는 없으며, 다음 질문과 코칭 전환은 서버 응답에 따릅니다.

```ts
// 사용자 행동 시 한 번 생성합니다.
const pending: MessageRequest = createMessage({
  text: "저는 친구이고 매주 연락합니다.",
});

async function deliver(): Promise<MessageResult> {
  // 재시도 버튼에서도 pending을 그대로 사용합니다.
  return api.sendMessage(projectId, pending);
}
```

- 동일 프로젝트에 같은 `request_id`와 같은 본문을 다시 보내면 진행 중인 처리를 공유하거나 저장된 응답을 반환합니다.
- 재시도할 때 UUID를 새로 만들거나 본문을 바꾸지 않습니다. 새 UUID는 새로운 사용자 행동에만 사용합니다.
- 진행 중인 ID를 다른 본문에 재사용하면 `409 request_id_conflict`입니다. 저장된 요청의 본문 불일치 등은 `409 conflict`로 반환될 수 있습니다.
- 다른 메시지가 처리 중인 프로젝트는 `409 project_busy`입니다. 현재 요청을 대기 상태로 보관하고 기존 처리가 끝난 후 재시도합니다.
- 해당 프로젝트의 전송 중에는 보내기·건너뛰기·코칭 요청·삭제 버튼을 잠가 중복 행동을 줄이십시오.
- 재시도 응답은 최초 처리 시점의 프로젝트 상태일 수 있습니다. 다른 턴이 이미 진행되었다면 `GET /api/projects/{id}`로 최신 상태를 다시 확인합니다.

성공 응답의 주요 필드는 다음과 같습니다.

| 필드 | 화면 처리 |
|---|---|
| `reply` | 사용자에게 보여줄 질문·코칭·안전 안내 텍스트 |
| `project` | 최신 프로필·제목·진행 상태·정보 확보 현황 |
| `question` | 다음 질문 객체 또는 `null` |
| `coaching` | 코칭 세부 항목 또는 `null` |
| `sources` | 검색된 참고 자료 목록 |
| `validation` | 응답 처리 방식과 근거 사용 정보 |
| `request_id` | 보낸 행동과 응답 연결 |

200 응답은 사용자 메시지·답변·프로필·재시도 결과가 함께 저장된 상태입니다. 낙관적으로 표시한 메시지는 성공 후 서버 메시지 목록으로 맞추고, 같은 답변을 두 번 추가하지 않도록 합니다. 이전 대화를 다시 열 때는 메시지의 `metadata.question`, `metadata.coaching`, `metadata.validation`도 사용할 수 있습니다.

## 6. 시간 초과와 오류 처리

서버의 모델 처리 흐름은 전체 300초 제한을 사용합니다. 모델 호출별 제한과 별도로 적용하며, DB 처리와 네트워크 시간까지 포함한 브라우저 대기는 기본 SDK 설정인 330초를 사용합니다. 요청이 길어질 때 로딩 상태를 유지하고 같은 프로젝트의 추가 전송을 막으십시오. 사용자에게 확정되지 않은 진행률을 표시할 필요는 없습니다.

브라우저 timeout·AbortController 취소·탭 종료·네트워크 끊김은 서버 처리가 중단되었다는 뜻이 아닙니다. 이미 저장되었거나 아직 진행 중일 수 있습니다. 전송 본문과 `request_id`를 유지하고 같은 요청으로 다시 시도하십시오. 입력창에 내용을 복원하면서 새 UUID로 보내면 중복 대화가 생길 수 있습니다.

| 상태 / code | 화면 동작 |
|---|---|
| 400·415·422 | JSON·Content-Type·필드·길이·커서를 수정하고 다시 요청 |
| 401 `unauthorized` | 세션 만료 처리 후 로그인 |
| 401 `invalid_credentials` | 로그인 또는 현재 비밀번호 입력 확인 |
| 403 `invite_required` | 초대 코드·가입 허용 여부 확인 |
| 403 `origin_denied` / `origin_required` | 연결 origin·쿠키 호출 설정 확인 |
| 404 | 프로젝트가 없거나 접근할 수 없음; 목록 새로고침 |
| 409 `registration_conflict` | 가입 대신 기존 계정 로그인 안내 |
| 409 `project_busy` | 잠시 기다린 뒤 같은 메시지 ID·본문으로 재시도 |
| 409 `request_id_conflict` / `conflict` | 자동 재시도 중단; 프로젝트와 요청 내용을 다시 확인 |
| 429 `rate_limited` | `Retry-After`만큼 기다리기 |
| 503 모델 오류 | 서버가 이번 메시지를 저장하지 않았음을 알리고 입력 유지; 재시도 버튼 제공 |
| 500 / 네트워크 오류 / 응답 형식 오류 | 저장 여부가 불확실할 수 있으므로 같은 ID·본문으로 확인·재시도 |

오류 JSON의 `detail`은 안내 문구, `code`는 분기용입니다. `message_saved:false`는 해당 요청이 새 턴을 저장하지 않았다는 뜻입니다. 이전에 성공한 다른 요청까지 없다는 뜻은 아닙니다. `message_saved:null` 또는 해당 필드를 읽을 수 없는 네트워크 오류는 저장 여부 미확정으로 취급합니다.

503의 `connection`, `http_error`, `timeout`은 모델 연결·응답 문제입니다. `invalid_output`, `ungrounded_output`, `invalid_evidence`, `verification_failed`는 생성 결과가 형식·근거·검증을 통과하지 못한 경우입니다. `retryable:true`가 다음 시도의 성공을 보장하지는 않으므로 무한 재시도를 하지 않습니다.

```ts
try {
  const result = await api.sendMessage(projectId, pending);
  // result를 화면 상태에 반영한 뒤 pending을 비웁니다.
} catch (error) {
  if (error instanceof ApiError) {
    if (error.code === "project_busy") {
      // pending을 유지하고 잠시 후 재시도 가능 상태로 전환합니다.
    } else if (error.messageSaved === null) {
      // 저장 여부 미확정: 같은 pending으로 재시도합니다.
    }
    // error.traceId는 문의 시 전달할 추적 ID입니다.
    // 토큰·비밀번호·발화 원문을 로그에 남기지 않습니다.
  } else {
    // 호출자가 전달한 AbortSignal의 취소 사유일 수 있습니다.
    // 이 경우에도 pending을 유지합니다.
  }
}
```

SDK의 `retries`는 기본 0, 최대 2입니다. 자동 재시도 대상은 GET과 동일 본문·ID를 유지하는 `sendMessage`뿐입니다. 가입·로그인·프로젝트 생성·삭제·비밀번호 변경은 자동 재시도하지 않습니다. `ApiError.status === 0`은 HTTP 응답을 받지 못한 연결 오류 또는 SDK 시간 초과입니다.

`GET /health`는 API 프로세스 상태 확인용이며 모델 준비 완료를 뜻하지 않습니다. `GET /ready`가 503이면 API가 실행 중이더라도 모델을 사용하는 전송이 불가능할 수 있습니다. 과도한 주기 조회 대신 진입 시와 오류 후 필요한 시점에 확인하십시오.

## 7. 프로필·코칭·출처 표시

`project.readiness`는 정보 확보 현황입니다. `answered_count / total_questions`를 질문 답변 수로 표시할 수 있으나 증상 점수나 위험도 백분율로 표시하지 않습니다. `addressed_count`에는 모름·건너뛰기도 포함됩니다. `basis`는 판단 기준 설명이고, `ready`는 코칭에 필요한 맥락이 확보되었는지를 나타냅니다.

`profile`은 질문 ID 문자열을 키로 사용합니다. 각 항목의 `source`를 구분해 표시하면 주변인의 관찰과 해석을 섞지 않을 수 있습니다.

| source | 표시 예시 |
|---|---|
| `observation` | 직접 관찰 |
| `reported` | 전달받은 말 |
| `interpretation` | 주변인의 해석 |
| `unknown` | 확인되지 않음 |

`status:unknown`과 `status:skipped`는 증상이 없다는 뜻이 아닙니다. `previous_reports`는 과거 보고이고 최신 값과 함께 현재 사실로 단정하지 않습니다. `domains`의 depression·anxiety·addiction·other는 발화에서 다룬 주제이며 진단명이 아닙니다.

코칭은 `reply`, `suggested_words`, `actions`, `avoid`를 각각 본문·건넬 말·실행할 행동·피할 표현으로 나누어 표시합니다. 코칭 카드가 있으면 동일한 `reply`를 별도 말풍선과 중복 표시하지 않도록 구성하십시오. `question`이 `null`이면 다음 질문 입력을 강제하지 않습니다.

`validation.method === "safety_response"`이면 일반 코칭 카드 대신 서버의 안전 안내 `reply`를 우선 표시합니다. `clinical_validation:false`는 의료 전문가가 검증했다는 표시가 아닙니다.

코칭 근거 사용 여부는 아래 필드로 구분합니다.

- `retrieved_count`: 검색된 참고 자료 수
- `cited_count`: 답변에 실제로 인용된 자료 수
- `grounding:"retrieved_reference_used"`: 검색 자료를 인용한 답변
- `grounding:"no_reference_used"`: 인용 자료를 사용하지 않은 답변
- `limited_profile:true`: 필요한 정보가 충분하지 않은 상태에서 요청한 코칭

`coaching.citations`는 `sources[].id`를 가리킵니다. 검색된 자료 전부를 답변의 근거처럼 표시하지 말고 실제 citations에 있는 자료만 인용 목록으로 표시하십시오. citations가 빈 배열인 것은 유효한 응답입니다. 대표 사례는 해당 대상자의 실제 경험이나 동일한 회복 결과를 의미하지 않습니다.

모든 사용자·모델·검색 텍스트는 일반 텍스트로 렌더링합니다. DOM에서는 `textContent`, React에서는 텍스트 JSX를 사용하고 `innerHTML`이나 `dangerouslySetInnerHTML`에 넣지 않습니다.

```ts
replyElement.textContent = result.reply;

const cited = new Set(result.coaching?.citations ?? []);
for (const source of result.sources.filter(item => cited.has(item.id))) {
  const title = document.createElement("span");
  title.textContent = source.title;
  sourcesElement.append(title);
}
```

출처 링크를 만들 경우에도 URL 프로토콜이 HTTP(S)인지 확인하고 새 창 링크에 `rel="noopener noreferrer"`를 적용합니다. UI 분석 이벤트·오류 수집 도구에는 발화·프로필·비밀번호·토큰을 보내지 않습니다.

## 8. 연동 확인 순서

1. 허용된 브라우저 origin에서 로그인하고 새로고침 후 `me()`가 유지되는지 확인합니다.
2. 프로젝트를 생성하고 질문 목록의 `pending_question_id`에 맞는 첫 질문을 표시합니다.
3. [test-prompts.json](../test-prompts.json)의 합성 입력으로 질문·코칭 분기를 확인합니다.
4. 같은 메시지 객체를 재전송해 대화가 중복 저장되지 않는지 확인합니다.
5. 메시지 페이지를 과거 방향으로 불러와 순서와 중복 제거를 확인합니다.
6. 모델 연결 실패, 응답 대기 취소, 409, 429에서 입력과 동일 `request_id`가 유지되는지 확인합니다.
7. 프로젝트 다시 열기·로그아웃·비밀번호 변경 후 세션 동작을 확인합니다.
