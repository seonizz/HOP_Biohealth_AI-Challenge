# 모델 입력 최적화 — 공통 지시·null 이름·단계별 입력

후속 미적용 항목인 토큰 정책 재사용·최종 검토 입력 축소·부분 품질 수정·GPU overlay 연결은 [추가 반영 기록](REMAINING_MODEL_OPTIMIZATIONS.md)을 따른다. 아래 기록은 최초 세 변경의 구현 시점 기준이다.

사용자가 요청한 세 변경만 적용한다. 기존 상태·질문·안전 검토, 최종 카드 검토와 상세 저장, 문맥에 따른 질문 생략, 카드 UI를 유지한다. GPU 서버·실제 모델 사용 전에는 사용자 승인을 받는다.

## 1. 적용 범위

| 변경 | 적용 조건 | 효과 |
| --- | --- | --- |
| 공통 지시 중복 제거 | 최종 대화문 또는 WRITE 기반 카드 수정 | SPEAK/WRITE에 이미 들어 있는 COMMON을 한 번만 전달. 수정 요청당 5,546 UTF-8 bytes 감소 |
| null 이름 블록 생략 | 블록 생성의 현재 이름 스키마가 정확히 `{type:'null'}` | 이름 추론 1회 생략. 기존 스키마와 전체 결과 검증·독립 검토는 계속 수행 |
| 단계별 질문 지시 축소 | `combined_blocks` + `MODEL_STAGE_SCOPED_QUESTION_RULES=true` | 상태·이름·관계 작성에서 질문 단계 전용 지시 제외 |
| 단계별 입력·이름 지시 축소 | 위 조건 + `MODEL_BLOCK_SCOPED_INPUTS=true` | 첫 세 블록의 question_input을 제외하고 이름에는 이름 전용 지시 사용 |

COMMON의 내용은 삭제하지 않는다. SPEAK/WRITE가 공통 지시를 포함한 경우 재추가만 하지 않으며, 개별 카드 역할에는 기존 공통 지시·avoid 형식 요구를 유지한다.

null 이름은 이전 턴의 이름 캐시나 모델의 생략 결정이 아니다. 현재 스키마가 유일하게 허용하는 상수를 기존 검증에 넣는다. 이름이 답변된 nullable schema에서는 호칭이 짧거나 enum이 하나여도 모델 추출을 유지한다. 이름 정정·후속 답변을 임의로 확정하지 않는다. 실제 호출하지 않은 이름 stage를 모델 실행 목록에 추가하지 않는다.

## 2. 입력과 검토 보존

- `shared_input`과 `state_input`을 합치면 전체 현재 원문·직접 입력·후속 답변을 복원할 수 있다. 상태 retrieval과 근거 허용 범위를 유지한다.
- 질문 작성의 원문·후보·retrieval은 유지하며, 상태·질문·안전 검토 요청을 축소하지 않는다. 생략·추가 질문 판단은 기존 모델 생성과 독립 검토를 거친다.
- 선행 블록, 거절 출력과 검토의 짝, 수정 지시, 부정·정정·화자·시점, unknown 검증을 유지한다. 검토 실패를 승인으로 바꾸지 않는다.
- 기존 구조 복구의 prefix 캐시는 실제 prompt·payload·schema와 문맥에 묶인다. 옵션이나 이름 원문이 달라지면 다른 요청으로 처리하며, 취소 시 후속 생성·검토를 진행하지 않는다.
- `combined`의 통합 요청과 그 fallback에는 단계별 입력 옵션을 적용하지 않는다. null 상수 생략은 fallback의 블록 생성에도 적용한다. `staged`의 관찰·이름 통합 요청을 제거하지 않는다.
- 저장 schema·DB 처리·최종 `conversation_detail`은 변경하지 않는다. 턴 프롬프트 버전은 변경된 생성 계약을 구분하도록 v50으로 올린다.

## 3. 설정

| 설정 | 기본값 | 의미 |
| --- | --- | --- |
| `MODEL_STAGE_SCOPED_QUESTION_RULES` | false | 명시적 true이면 combined_blocks의 첫 세 작성 지시 축소 |
| `MODEL_BLOCK_SCOPED_INPUTS` | false | 앞 옵션이 true일 때 입력·이름 지시도 축소 |
| `MODEL_STATE_MODE` | 기존 값 유지 | 이번 작업에서 combined로 전환하거나 combined_blocks로 강제하지 않음 |
| 검토 Gateway의 두 옵션 | false | 생성 옵션을 검토기에 상속하지 않음 |

두 옵션은 `relationship_agent`에서만 허용하며 `true`/`false` 외 값은 구성 오류다. 앞 옵션 없이 block 입력 옵션만 켜면 구성 오류다. `combined`·`staged`에서는 두 옵션이 켜져 있어도 해당 생성 입력을 바꾸지 않는다. 기본 Compose는 두 환경변수를 기본 false로 전달하며 GPU overlay는 둘 다 true로 준비한다. 현재 선택한 상태 모드가 combined_blocks인지 별도로 확인해야 한다.

공통 지시 중복 제거와 스키마 고정 null 처리는 별도 활성화 옵션이 없는 좁은 수정이다. O4 활성화와 독립적이며, O4 정상 최종 생성 18회·검토 14회는 유지한다. 총 시간 제한·출력 토큰 한도를 추가하지 않는다.

기존 `.env`, 실행 중인 9060 별도 복사본, runtime 소스·프로세스·GPU 서버는 변경하지 않았다. 배포된 기능과 현재 `app/` 소스를 구분한다. 준비한 GPU overlay 적용도 서버 사용 승인 후에 수행한다.

## 4. 호출 수 해석

| 정상 경로 | 이름 추론 필요 | 이름 스키마가 null로 고정 |
| --- | ---: | ---: |
| 적응형 combined_blocks 답변 | 6~7 | 5~6 |
| 비적응형 combined_blocks 상태 갱신 | 4 | 3 |
| O4 비긴급 최종 생성 | 18 | 18 |

위 범위의 차이 1회는 조건부 질문 검토다. 이름을 생략해도 상태·안전·조건부 질문 검토는 그대로 남는다. `combined` 정상 답변 3~4회와 `staged` 정상 답변 5~6회는 이번 변경으로 줄지 않는다. 수정·fallback·재시도는 별도 가산하며 이름이 없는 모든 사례에 동일한 전체 절감률을 적용하지 않는다.

입력 크기는 합성 요청의 UTF-8 바이트로 비교한다. 입력 바이트가 줄어도 토큰·실제 출력 품질·GPU 시간의 같은 비율 감소를 보장하지 않는다.

현재 앱의 이름 있는 합성 사례를 같은 응답으로 비교하면 요청 7회의 body 합계가 **187,886→157,170 bytes**, **30,716 bytes·16.35% 감소**했다. 질문 작성과 상태·질문·안전 검토의 요청 본문은 완전히 같고, 반환 결과도 같았다. 앞선 기획의 16.2%는 다른 runtime 복사본에서 측정한 값이며 이번 수치와 구분한다.

## 5. 변경 파일

- [카드 수정 지시](../src/relationship-agent.js), [블록 생성·상수 처리](../src/relationship-turn.js), [블록 입력·이름 지시](../src/turn-input-scope.js)
- [Gateway](../src/model.js), [환경 설정](../src/model-config.js), [기본 Compose](../compose.yaml), [GPU overlay](../compose.gpu.yaml)
- [최종 생성·수정 검사](../tests/final-draft-reuse.test.js), [턴 입력·null·복구 검사](../tests/turn-input-optimization.test.js), [설정 검사](../tests/model-config.test.js)
- [검토 기획](../../docs/archive/2026-10/모델_호출_추가_최적화_검토_2026-10-31.md), [전체 사용량](../../docs/archive/2026-10/전체_모델_사용량_재조사_2026-10-31.md)

## 6. 구현 후 검토·검증

세 구현과 설정 연결을 먼저 끝낸 뒤 작성자를 바꿔 두 건의 독립 검토를 수행했다. 한 검토는 null 조건·원문·복구·검토 경계를, 다른 검토는 공통 지시·설정·배포 옵션을 확인했다. 검토 범위에서 추가 수정이 필요한 결함은 발견되지 않았다.

| 검사 | 결과 |
| --- | --- |
| 공통 지시 회귀 | 수정 전 중복 검사 5개 실패를 재현한 뒤 통과. script·care·avoid·top 요청에서 COMMON 1회, 기존 검토·상세 유지 확인 |
| 턴 입력·null 회귀 | 원문·후속 정정·이름 스키마·전체 반환값·모든 검토 요청, 긴급·취소·구조/의미 복구·옵션 변경·combined fallback 검사 통과 |
| 설정·Compose | 기본 false·엄격한 값·옵션 의존성·검토기 격리·GPU overlay true·상태 모드 유지 확인 |
| 앱 전체 `env -u TEST_DATABASE_URL node --test tests/*.test.js` | **1,902 통과, 0 실패, 85 건너뜀**. 실제 DB 검사는 미실행 |
| `node scripts/check.js` | JavaScript 구문·JSON 검사 통과 |
| YAML·문서 | Compose 파싱 및 옵션 매핑, 문서 링크·표·수치 대조 통과 |

지침에서 허용한 별도 Ollama 검토 API에도 개인정보·비밀값 없는 구현 요약으로 검토를 시도했으나 `No route to host`로 결과를 얻지 못했다. 완료 판단은 네이티브 교차 검토와 로컬 검사에 근거한다. 실제 GPU 모델의 출력 품질·토큰·처리시간·운영 DB 저장은 이번 검증 범위에 포함하지 않았다.
