# PostgreSQL 질문 관리

기존 UI의 기본 30문항과 마무리 보충 질문 1개를 `questions` 테이블에 최초 한 번 넣습니다. 이후 질문 목록과 새 상담은 DB를 읽습니다. 재시작·빌드로 수정한 질문을 덮어쓰거나 삭제한 질문을 복구하지 않습니다. `seeds/questions.json`은 최초 구성과 이전 상담 호환용이므로 실제 질문 수정은 DB에서 합니다. 질문 관리 웹 화면이나 공개 수정 API는 추가하지 않았습니다.

## 빠른 수정

로컬 `.env`와 PostgreSQL이 준비된 작업 폴더에서 실행합니다. `--silent`는 npm 안내 문구가 JSON 파일에 섞이지 않게 합니다.

```sh
# 문항 ID·순서·사용 여부·문구 보기
npm run --silent questions -- list

# 질문 하나를 JSON으로 꺼내기
npm run --silent questions -- get name > runtime/name-question.json

# 파일의 definition.q, opts, sort_order 등을 수정한 뒤 반영
npm run --silent questions -- set runtime/name-question.json

# 사용 중지 / 다시 사용
npm run --silent questions -- disable extra
npm run --silent questions -- enable extra

# 삭제: 새 상담에서 제외, 기존 상담의 질문·답변은 보존
npm run --silent questions -- delete extra
```

`set`은 같은 ID면 수정하고 새로운 ID면 추가합니다. 모든 쓰기는 트랜잭션으로 검증합니다. 잘못된 문항·분기 설정이나 기본 질문이 하나도 남지 않는 변경은 취소됩니다. 비활성 문항도 `set` 때 내용을 검증합니다.

다음 JSON 파일을 `set`으로 넣으면 이름 질문(100)과 전하고 싶은 말(200) 사이에 텍스트 질문이 추가됩니다. 이 예시는 자동 등록하지 않습니다.

```json
{
  "id": "patient_note",
  "kind": "base",
  "sort_order": 150,
  "enabled": true,
  "subject": "patient",
  "definition": {
    "sec": "현재 겪고 있는 어려움",
    "face": "listen",
    "type": "text",
    "q": "추가로 알려 주고 싶은 상황이 있나요?",
    "ph": "관찰한 모습을 적어 주세요."
  }
}
```

## 필드와 버전

| 필드 | 용도 |
|---|---|
| `id` | 영문 소문자로 시작하는 영문 소문자·숫자·밑줄, 최대 80자 |
| `kind` | 기본 문항 `base`, 기존 마무리 보충 문항 `gap` |
| `sort_order` | 작은 정수부터 표시. 초기 간격은 100이라 중간 삽입 가능 |
| `enabled` | `false`이면 새 상담에서 제외 |
| `subject` | 당사자 정보 `patient`, 앱 이용자 정보 `supporter`. `user_goal`은 기존 `want`, `goal`만 사용 |
| `definition` | 문구·보기·입력 속성·조건·후속 질문 JSON |

`gap`은 기존 `gap_obs` 한 개입니다. 비활성화하면 마무리 보충 질문도 제외됩니다. 기존 이름 인덱싱은 `name`, 목표는 `want/goal`, 원인 분기는 `cause`를 사용하므로 이 ID의 기능 의미는 유지하세요. 일반 당사자·주변인 질문은 새 ID를 추가하면 모델 근거 필드와 질문 후보에 자동 반영됩니다. 기존 문항의 의미가 바뀌면 새로운 ID를 사용하세요.

`definition.type`은 `text`, `one`, `multi`입니다. 선택형에는 `opts`를 넣습니다. 보기는 문자열 또는 `[문구, 메타]`입니다. `t`는 분기 태그, `s/r/p`는 기존 모델 메타, `g`는 보기 묶음, `none:1`은 단독 선택, `input:true`는 기존 직접 입력창, `ph`는 입력 안내입니다. `required/noSkip/noOwn/short/cue`는 기존 입력 속성입니다. `{name}`과 `{name:은}`, `{name:이}`, `{name:을}`, `{name:와}` 등은 호칭과 조사로 렌더링됩니다.

보기 순서를 바꾸면 새 상담의 보기 번호가 바뀝니다. 진행 중·완료된 상담은 시작 시 질문 전체를 암호화된 상태에 저장하므로 기존 선택 번호와 문구를 유지합니다. 질문·보기·조건의 버전 해시는 `context.question_set_version`에 남습니다. 원문 스냅샷은 검증 내보내기의 `intakes[].state.questionSet`에서 확인합니다. 이번 변경 전 저장한 상담은 원래 구성을 사용합니다.

## 조건과 후속 질문

DB에는 실행 코드를 넣지 않습니다. `when`과 `rare_when`은 아래 JSON 조건만 사용합니다.

```json
{"tag": "rare_contact"}
{"not": {"tag": "no_change"}}
{"any": [{"not": {"tag": "no_change"}}, {"custom": "mood"}]}
{"all": [{"tag": "rare_contact"}, {"custom": "mood"}]}
{"selected": {"question_id": "cause", "option": "네"}}
{"tag_prefix": "cg_"}
```

`when`이 참이면 질문을 표시합니다. `rare_when`이 참이면 `rare` 문구를 씁니다. `custom`은 해당 문항의 직접 입력 여부입니다. 조건이 참조한 문항은 앞에 있어야 하며 선택 보기는 문구로 연결하므로 보기 재정렬에도 의미가 유지됩니다. 참조 문항·보기를 삭제하거나 비활성화할 때 연결된 조건도 함께 수정·제거해야 합니다. 분기 기준 질문은 모델이 자동으로 건너뛰지 않습니다.

`follow_up.when.rule`은 `thin_text`, `thin_custom`, `empty_selection_thin_custom`, `min`은 최소 길이입니다. `merge`는 이름 대체 `name`, 텍스트 대체 `replace_text`, '해당 없음'을 제외한 텍스트 대체 `replace_text_or_none`, 관찰 입력 병합 `custom`입니다. `question`에 기존 문항과 같은 형식의 문구·타입·보기를 넣습니다.

직접 SQL로 수정해도 다음 목록 조회와 새 상담부터 반영됩니다. 잘못된 활성 설정은 `QUESTION_BANK_INVALID`로 알려주며 코드의 질문으로 대체하지 않습니다. 이미 시작한 상담은 저장된 버전으로 계속 조회·응답할 수 있습니다.
