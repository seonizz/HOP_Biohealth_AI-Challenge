# 지식 데이터 연결

이 디렉터리는 기본 지식 파일의 위치를 설명합니다. 공개 저장소에는 실제 상담 CSV, JSONL 발췌문, 참여자 식별자, 선정표, manifest를 포함하지 않습니다. 서비스의 기존 비공개 지식 파일은 별도로 보존하며, 배포 환경에서 읽기 전용으로 연결합니다. 설정명과 마운트 방법은 [배포 문서](../docs/OPERATIONS.md)를 확인하십시오.

## JSONL 계약

한 줄에 JSON 객체 하나를 저장합니다. UTF-8, 전체10MiB 이하, 최대10000개 문서이며 문서 ID는 중복될 수 없습니다. `id` 최대128자, `title` 최대300자, `text` 최대8000자입니다. HTML은 실행하지 않고 텍스트로 처리합니다. 프론트엔드도 원문을 HTML로 렌더링하지 않아야 합니다.

| 필드 | 내용 |
| --- | --- |
| id | 공백 없는 앞뒤가 정리된 안정적인 문서 ID |
| title | 문서 제목 |
| text | 실제로 검색·참조할 텍스트 |
| kind | guidance 또는 representative_case |
| source_url | 선택. 인증정보 없는 HTTP(S) 출처 URL |
| reviewed | guidance에는 true 필수 |
| consent_cleared | reviewed=true인 사례 자료를 사용할 때 true 필요 |
| deidentified/provenance | 또는 representative_case는 deidentified=true와 비어있지 않은 provenance 필요 |

이 플래그는 자료 제공자의 준비 상태 선언이며 독립적인 검토나 사용 권한을 만들어주지 않습니다. 원자료의 사용 조건과 검토 기록을 별도로 보관하십시오. 검토되지 않은 원문 전체를 자동으로 넣지 않습니다.

아래는 **형식 설명 전용 합성 예시**입니다. 서비스 기본 지식으로 제공하지 않습니다.

~~~json
{"id":"synthetic-format-only","title":"형식 검사용 문자열","text":"실제 상담이나 권고 내용이 없는 형식 검사용 문자열입니다.","kind":"representative_case","deidentified":true,"provenance":{"dataset":"synthetic-test-only"},"source_url":"https://example.invalid/test-only"}
~~~

없는 파일은 빈 지식 저장소로 취급합니다. 잘못된 형식·중복키/ID·문서 한도 초과는 부분 로딩하지 않고 오류로 처리합니다. 필수 지식을 사용하는 배포에서는 파일과 문서 수를 준비 상태 확인에 포함하십시오.

## 검토된 CSV 발췌 빌드

`scripts/build-cases.ts`는 비공개 검토 선정표를 입력받습니다. 고정된 내담자 발화, 실제 행 번호, 원자료 해시는 소스 코드에 들어있지 않습니다. 실행은 다음 네 경로를 모두 명시해야 합니다.

~~~sh
node scripts/build-cases.ts \
  --dataset-dir /path/to/private/source \
  --selection /path/to/private/selection.json \
  --destination /path/to/private/output/knowledge.jsonl \
  --manifest /path/to/private/output/manifest.json
~~~

`--verify-only`를 추가하면 기존 출력과의 일치 여부만 검사하고 파일을 생성하지 않습니다. 기존 출력 내용이 다르면 덮어쓰지 않습니다. 입력 CSV를 변경하지 않으며 출력은 입력 디렉터리 밖에 있어야 합니다. 실제 경로는 해당 서버에서 허용된 작업 경로만 사용하십시오.

선정표 TypeScript 형식은 `scripts/build-cases.ts`의 `CaseSelection`을 따릅니다.

- `schema_version:1`, `data_permission_verified:true`, `selected_excerpts_reviewed:true`
- `source_filename`: 경로 없는 CSV 파일명
- `source_file_sha256`: 검토한 원파일 SHA-256
- `source_url`와 `label_method`: 출처와 원자료 라벨링 방식
- `records`:1–200개. 각 항목은 ID·제목·1부터 시작하는 CSV 데이터 행 번호·원자료 label/label_id·발췌 범위·발췌 SHA-256
- 범위는 UTF-16 문자열 인덱스이며 `start_character` 포함, `end_character_exclusive` 제외

입력 CSV에는 `text,label,label_id,split,participant_id,label_method,quality_flags`가 있어야 합니다. train split·품질 플래그 없음·라벨/해시 일치·서로 다른 참여자 조건을 검사합니다. 각 발췌는35–500자이며 직접 식별자로 보이는 일부 패턴을 추가 검사합니다. 이 패턴 검사는 사람이 수행한 발췌 검토를 대체하지 않습니다.

출력 manifest에는 출처 해시·발췌 범위·선정 행 등 민감한 출처 메타데이터가 포함될 수 있으므로 지식 파일과 함께 비공개로 관리합니다. 테스트는 `tests/knowledge.test.ts` 내부에서 새로 작성한 합성 문자열만 사용합니다.
