# AI 에이전트용 질문셋 모델 테스트

AI 에이전트가 질문·답변 세트를 JSON으로 만들고 프로젝트의 실제 AI 경로를 호출해 결과를 분석하는 CLI입니다. `app/src/intake.js`의 입력 검증·문맥 구성과 `app/src/model-config.js`의 모델 설정, `ModelGateway.respond/updateState`를 재사용합니다. 웹 서버·DB 없이 실행하며 서비스 기록을 저장하지 않습니다. 새 의존성 설치는 필요 없고 프로젝트와 동일한 Node.js 24.14 이상 25 미만을 사용합니다.

## 에이전트 실행 순서

프로젝트 루트에서 실행합니다. 자동화는 npm의 안내 로그를 피하도록 아래 `node` 명령을 사용하세요. `--help`를 제외한 stdout은 **한 줄당 JSON 객체 하나(JSONL)**입니다. 최상위 오류도 stderr에 JSON 객체로 출력합니다.

```sh
# 1. 기계 판독용 명령 규격·입력 JSON Schema 확인
node ai/scripts/test_model_question_sets.mjs --describe

# 2. 실제 앱 문항 ID, 문구, 0부터 시작하는 선택지 확인
node ai/scripts/test_model_question_sets.mjs --list-questions

# 3. 로컬 합성 입력 템플릿 생성: 출력 객체의 input 필드가 파일 경로
node ai/scripts/test_model_question_sets.mjs --init

# 4. 위 경로의 JSON을 수정하고 모델 호출 없이 전체 사례 사전 검증
node ai/scripts/test_model_question_sets.mjs --input INPUT.json --dry-run

# 5. 설정된 모델로 실행. 결과 output/artifacts 경로를 읽어 분석
node --env-file-if-exists=app/.env ai/scripts/test_model_question_sets.mjs --input INPUT.json --repeat 3 --timeout-ms 600000
```

`INPUT.json`은 `--init`이 반환한 절대경로로 바꿉니다. 입력 파일은 `ai/outputs/model-tests/private/` 안에서 관리하세요. `npm run ai:model-test -- ...`도 같은 도구를 실행합니다. 입력은 최대 5 MiB, 사례는 1~100개, 반복은 1~20회입니다. 사례별 제한 시간 기본값은 10분, 허용 범위는 1~86,400,000ms입니다. 사례는 순차 실행하며 한 사례의 모델 오류·기대값 불일치 후에도 다음 사례를 실행합니다.

모델 연결은 기존 앱의 `MODEL_*`, 선택적 `MODEL_REVIEW_*` 설정을 사용합니다. 실행 명령은 명시된 목적지로 요청하므로 에이전트는 적용 중인 호스트 사용 제한을 먼저 확인해야 합니다. 현재 프로젝트의 GPU 서버 사용 금지는 그대로 적용됩니다. 로컬 Ollama를 명시해 실행하려면 아래처럼 사용할 수 있습니다. 별도 검토기 설정이 필요 없으면 해당 환경변수를 설정하지 않은 셸에서 실행하세요.

```sh
MODEL_BASE_URL=http://127.0.0.1:11434/v1 MODEL_NAME=gemma4:12b \
  node ai/scripts/test_model_question_sets.mjs --input INPUT.json
```

## 입력 계약

[입력 JSON Schema](model_question_tests.schema.json)를 제공합니다. 문항 ID·선택지 범위·필수 답변·중복 문항 같은 의미 제약은 앱의 검증기가 처리하므로 **스키마 확인 후에도 `--dry-run`을 실행**합니다. 사례 ID는 중복될 수 없습니다. 아래는 직접 작성한 합성 형식 예시이며 학습 데이터가 아닙니다.

```json
{
  "cases": [
    {
      "id": "synthetic_friend",
      "answers": [
        {"question_id": "name", "text": "테스트 친구"},
        {"question_id": "rel", "selected": [4]},
        {"question_id": "want", "text": "부담 없이 이야기를 들어 주고 싶어요."},
        {"question_id": "concern", "text": "최근 일이 많아 피곤하다고 말했어요."}
      ],
      "expectations": [
        {"path": "guide.script", "operator": "exists"},
        {"path": "assessment.safety", "operator": "equals", "value": false},
        {"path": "guide.script", "operator": "not_contains", "value": "확실히 진단"}
      ]
    }
  ]
}
```

- `answers`는 앱의 문항 ID별 답변 배열입니다. 자유 입력은 `text`, 선택형은 `selected:[0]`처럼 0 기반 인덱스, 허용된 직접 입력은 `custom`, 명시적 건너뛰기는 `skipped:true`를 사용합니다. 선택형 추가 설명은 해당 선택지가 설명을 요구할 때만 `text`를 사용합니다. 웹 UI의 `answers` 객체 축약형은 이 CLI에서 지원하지 않습니다.
- 넣지 않은 문항은 `not_asked`로 유지합니다. 빈 부분을 답변으로 생성하지 않습니다. 명시적 생략은 앱 규칙에 맞아야 하며 사실 근거로 사용되지 않습니다.
- `expectations`는 선택 사항입니다. `path`는 결과 객체 기준 점 경로이며 배열 인덱스도 가능합니다. `equals`는 JSON 값의 엄격한 구조 비교, `contains/not_contains`는 대소문자와 공백을 그대로 비교하는 문자열 검사, `exists`는 필드 존재 검사입니다. `exists`에는 `value`를 넣지 않습니다. 없는 필드의 `not_contains`도 실패합니다.
- `exists`는 비어 있지 않음이나 의미 품질을 보장하지 않습니다. 기대값 없는 사례는 `completed`로 표시하며 `passed`로 계산하지 않습니다.

`--mode final`(기본값)은 전체 생성 경로로 카드·상태·관계 분석 등 해당 프로토콜이 반환하는 결과를 저장합니다. `--mode state`는 상태 갱신·기억·질문 선택 결과만 테스트합니다. 두 모드 모두 각 사례의 입력 스냅샷에서 시작하며, 순차 대화 재현이나 이전 사례 기억 전달은 하지 않습니다. `state`에서 `guide.script` 같은 최종 카드 경로를 검사하면 실패하므로 해당 모드의 출력 경로로 기대값을 바꿉니다. 기본 템플릿은 `final`용입니다.

기본 문항은 `app/seeds/questions.json`입니다. 다른 질문 은행을 쓰려면 앱과 동일한 행 형식의 파일을 `--questions ROWS.json`으로 지정합니다. DB에서 수정한 문항은 자동으로 조회하지 않으므로 같은 내용을 명시적으로 제공해야 합니다. `--init`은 기본 질문 은행만 사용합니다.

## 에이전트가 읽을 결과

실행 시작 이벤트의 `output`은 보고서 폴더입니다. 진행 이벤트는 `finished/planned/status`, 마지막 이벤트는 `status/output/artifacts/summary`를 가집니다. 마지막 `status:finished`는 실행 종료를 뜻하며 합격 여부는 종료 코드와 `summary`를 함께 봅니다.

| 파일 | 내용 |
|---|---|
| `report.json` | 입력·질문·앱 소스·실행기 해시, 모델 설정 식별값, 사례별 전체 생성 결과, 기대값/실제값/판정, 단계, 진행 이벤트, 진단 이벤트, 오류, 호출·토큰·시간 통계 |
| `results.csv` | 사례·반복별 결과, 오류, 답변 수, 안전 플래그, 기대값 통과 수, 호출/재시도/토큰/시간 비교. UTF-8 BOM 포함 |
| `summary.md` | 완료·통과·불일치·오류 수와 사례별 요약 |

`report.json.results[].result`에는 선택한 앱 프로토콜이 실제 반환한 값만 들어갑니다. `relationship_agent`의 최종 결과에서는 `guide`, `patient_state`, `assessment`, `name_index`, `relationship_analysis`, `relationship_memory`, `conversation_detail`, `agent` 등을 확인할 수 있습니다. 모델이 반환하지 않은 필드는 만들어 채우지 않습니다. 검증 실패 시 정상 결과가 없을 수 있으며 `error_code`, `trace`에서 실패 단계와 이유를 확인합니다.

`results[].checks`에서 기대값 불일치의 경로와 `actual`을 읽어 다음 테스트를 설계하세요. `summary.expectation_pass_rate`는 **생성에 성공하고 기대값이 있는 사례 실행만** 분모로 씁니다. 실행 오류는 `errors`, 기대값 없는 생성은 `without_expectations`에 따로 기록됩니다. 성공률 판단 시 이 세 항목을 함께 확인합니다.

호출 통계는 기존 `attemptMetrics` 검증기를 재사용합니다. 지원하는 세 진단 이벤트(`model_attempt`, `model_retry_wait`, `model_request_failure`)로 계산하며 나머지는 `trace`에 보존하고 `excluded_diagnostic_events`에 셉니다. 검증할 수 없는 호출 수나 제공되지 않은 토큰 수는 `null`이고 CSV에서는 빈칸입니다. 토큰 수는 HTTP 응답 제공값이며 GPU 연산량이나 비용이 아닙니다. 재시도 통계는 해당 검증기의 시도 번호 기준이며 전체 작업 재시작 횟수와 같지 않습니다.

보고서는 사례 완료마다 갱신합니다. SIGINT/SIGTERM으로 중단하면 현재 요청을 취소하고 부분 보고서와 종료 코드 130을 남깁니다. 강제 종료나 디스크 오류에는 마지막 기록까지만 남을 수 있습니다. API 키·환경변수 전체·원시 예외 메시지는 보고하지 않습니다. 입력/응답과 원문 인용은 개인정보를 포함할 수 있으므로 보고서는 기존 Git 제외 경로 `ai/outputs/model-tests/private/`에만 저장하고 업로드하지 않습니다. 일반 파일 권한은 0600, 실행 폴더는 0700입니다.

| 종료 코드 | 에이전트 처리 |
|---:|---|
| 0 | 입력 검증 또는 생성 완료. 기대값 없는 완료도 포함하므로 `passed`와 혼동하지 않기 |
| 1 | 모델 오류 또는 기대값 불일치. 결과 파일을 읽고 원인 분류 |
| 2 | 입력·설정·실행기 오류. stderr의 JSON 오류 코드를 읽고 수정 |
| 130 | 취소됨. 남은 사례와 부분 보고서 확인 |

이 도구의 필드·키워드 검사 통과는 사실성·상담 적절성·임상 효과를 증명하지 않습니다. `human_review:pending`을 유지하며, 모델 성능과 시간 수치를 프로젝트 대회 점수로 환산하지 않습니다. 질문 선택의 적절성과 근거 없는 사실 생성은 별도로 검토합니다.

## 도구 자체 검증

```sh
npm run test:model-runner
node --test app/tests/test-intake.test.js ai/scripts/evaluation_evidence.test.mjs
```

실제 `ModelGateway`와 가짜 HTTP 응답을 연결해 직렬화·앱 검증·진단 기록을 검사하고, 입력 오류, 반복 격리, 기대값 비교, 제한 시간, 취소, 보고서와 권한을 회귀 검증합니다. 이 테스트 통과는 실제 모델 서버의 접속·생성 품질을 검증한 결과가 아닙니다.
