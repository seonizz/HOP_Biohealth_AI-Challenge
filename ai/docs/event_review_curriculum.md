# 사건 상태·검토 보완 자료와 평가 기준

2026-11-12 단계 비교에서 원상담 종료 step4634부터 `time` 추가 회귀가 관측됐고, 정상 초안 거절은 기반부터 존재했다. 기존 학습 코스에는 이 튜플 추출·정상 승인·정확한 `actual/expected` 대조를 직접 가르치거나 검증하는 단계가 없었다. 이 변경은 그 자료·평가 공백을 보완한다. **모델을 새로 학습하거나 기존 결과의 점수를 바꾸지 않는다.**

## 적용 범위

- 별도 합성 구조화 과제다. 실제 앱의 claims/audits 검토 계약과 다르며 상담·카드 품질을 대체 평가하지 않는다.
- 기존 `controlled-auto-v13-1` 자료·정답·채점과 원본 31B COURSE는 변경하지 않는다.
- 기존 실패 6사례나 상담 원문을 복사하지 않는다. 새 자료는 최소 3명·6개 슬롯의 독립 생성 사건에서 만든다.
- 구조 검증 완료와 실제 학습 승인을 구분한다. `COURSE_PROPOSAL.json`은 `training_ready=false`, `training_started=false`다. 모델별 토큰화·수치 대조, 학습 범위 결정, 단계별 역할 평가가 필요하다. 기존 runner가 자동으로 학습할 COURSE 파일을 생성하지 않는다.

## 생성된 자료

로컬 자료: `training_data/gemma4_31b_event_review_supplement_20261112_v1/`

| 분할 | 사건 원천 | 상태 추출 | 정상 승인 | 한 필드 오류 검토 | 합계 |
|---|---:|---:|---:|---:|---:|
| train | 120 | 240 | 240 | 240 | 720 |
| validation | 36 | 72 | 72 | 72 | 216 |
| test | 36 | 72 | 72 | 72 | 216 |

각 사건은 pipe 문자열/이름 있는 객체의 두 표현으로 제공된다. 두 표현 각각 상태 추출·정상 검토·오류 검토를 만든다. 모든 파생 자료는 같은 split에 둔다. `person`, `attribute`, `value`, `time`, `negated`, `certainty` 오류가 각 분할에서 균형을 이룬다.

핵심 학습 조건:

1. 과거 값이 이력에 있어도 현재 draft가 맞으면 승인한다. 정상 자료도 정정 이력을 포함한다.
2. 정상 초안과 한 필드 오류 초안은 같은 이력과 행 순서를 사용한다. 정답·오류 종류·case/split ID는 메시지에 넣지 않는다.
3. draft를 정렬된 정답과 다른 순서로 제시한다. issue의 index는 실제 draft 위치다.
4. `actual`은 실제 초안 값이고 `expected`는 최신 사실이다. 둘이 같으면 오류로 쓰지 않는다.
5. `time`은 선택된 사건의 순서다. 1부터 연속 증가하는 패턴에 의존하지 않도록 시작값·간격을 바꾼다. 같은 값이 다시 보고돼도 최신 순서를 선택한다.
6. 부정과 미상을 보존한다. 여섯 필드를 복사하는 기호적 과제로, 임의 값의 임상·상담 의미를 주장하지 않는다.

정답 생성은 순방향 상태 누적을 사용하고, 검증기는 역방향 마지막 사건 선택으로 독립 대조한다. 검토 정답은 일치하는 행을 먼저 제거하고 남은 단일 변경을 찾아 생성 과정의 변경 index에 의존하지 않고 확인한다.

검증 항목은 파일 해시, 원천·target 연결, 마지막 assistant loss mask, 정상/오류·표현 쌍 완결성, 여섯 오류 필드 비율, split별 원천·입력 중복이다. 이름·값·순서 간격을 치환한 구조 fingerprint도 split 간 비교한다. 같은 생성기를 사용했으므로 분할 충돌 0건을 자연어·새 도메인 일반화 입증으로 해석하지 않는다.

test는 `evaluation/test/`의 inference/reference 파일로만 제공하고 training data 목록에는 넣지 않는다. 토큰화·학습 입력은 COURSE_PROPOSAL의 train/validation 명시 경로만 사용해야 한다. 자료 폴더 전체 JSONL을 재귀 수집하면 안 된다. test로 학습량·임계값을 조정하지 않는다.

## 재생성과 검증

```bash
python3 ai/scripts/event_review_curriculum.py build \
  --output training_data/gemma4_31b_event_review_supplement_NEW \
  --base-course training_data/gemma4_31b_expanded_20261025/COURSE.json

python3 ai/scripts/event_review_curriculum.py verify \
  --bundle training_data/gemma4_31b_event_review_supplement_20261112_v1

python3 -m unittest discover -s ai/scripts -p 'test_event_review_curriculum.py'
python3 -m unittest discover -s ai/scripts -p 'test_evaluate_event_review.py'
```

생성기는 기존 출력 폴더를 덮어쓰지 않는다. 자료는 Git 제외 `training_data/`에만 보관하고, 생성 코드와 원문 없는 설계 문서만 추적한다. manifest는 파일 해시, 생성기 해시, seed, 원천 수를 기록하며 생성기·평가기와 필요한 공통 도구의 스냅샷도 자료에 포함한다.

## 평가와 모델 선택

추론에는 `evaluation/validation/inputs.jsonl`의 `messages`만 전달한다. reference/target은 보내지 않는다. 모델 출력 JSONL의 행 계약은 다음 필드다.

- `request_id`: 입력과 같은 식별자
- `status`: 성공 실행은 `ok`
- `finish_reason`: 자연 종료는 `stop`; 길이 제한 등은 성공으로 세지 않음
- `text`: 수정하지 않은 모델 응답 문자열

```bash
python3 ai/scripts/evaluate_event_review.py \
  --bundle training_data/gemma4_31b_event_review_supplement_20261112_v1 \
  --outputs runtime/EXPERIMENT/validation-responses.jsonl \
  --split validation \
  --report runtime/EXPERIMENT/validation-report.json
```

후속 checkpoint 비교는 `--baseline-report runtime/EXPERIMENT/base-report.json`을 추가한다. 입력과 정답의 평가집단 해시가 같은 경우만 비교하며 핵심 지표가 기준보다 내려가면 차단한다. 기준점을 뒤 단계에서 임의로 교체하지 않는다. 원상담 종료·수정 종료·생성 종료마다 동일 validation을 사용하고, 최종 후보와 기준·생성 설정을 고정한 뒤 test를 실행한다.

| 연구용 제안 통과 기준 | 최솟값 |
|---|---:|
| 완결·유효 형식 | 100% |
| 정상 초안 승인 | 95% |
| 오류 초안 거절 | 95% |
| 오류 index/field/expected/actual/rule 전체 일치 | 95% |
| 전체 사실 튜플 일치 | 95% |
| gold 슬롯 기준 time 정확도 | 98% |

이 숫자는 새 연구용 기본 기준이며, 임상·제품 배포 기준으로 보정된 값이 아니다. 최종 test를 본 뒤 기준을 낮추지 않는다. 실제 사용 분포에서 정상/오류 비율과 비용을 별도로 검증해야 한다.

누락·실행 실패·형식 오류·길이 제한 응답도 전체 배정 분모에 남긴다. 중복/알 수 없는 request ID는 오류로 중단한다. 코드블록 제거·출력 보정·정답 대체를 하지 않는다. JSON 중복 키, 추가 필드, 중복 사실/issue, approval과 빈 issues의 불일치도 거른다.

정상 승인/오거절, 오류 거절, 균형 정확도, issue 정확도와 actual/expected 근거, 최신 값과 time 정확도, 오류 필드별 성적을 분리한다. 오류 거절만 잘하는 것으로 정상 검토 실패를 가릴 수 없다. 각 오류 필드별 결과도 모델 선택 시 확인해야 한다.

## 이번 확인 결과와 남은 범위

- 새 자료 1,152행 전수 검증 통과. split 간 원천·정규화 구조 충돌 0건.
- 검증 216개에 대한 채점기 대조군: 정답 대조 응답 통과, 전부 거절/사람 ID를 time으로 복사/허위 actual 응답 모두 탈락.
- 전부 거절 대조군은 오류 거절률 100%지만 정상 승인 0%, 균형 정확도 50%로 탈락했다.
- time 오류 대조군은 최신 값 정확도 100%라도 time 정확도 0%라 탈락했다.
- 대조군은 코드 검증이다. 새 모델 추론·학습·성능 개선 측정은 수행하지 않았다.
- 지정된 로컬 Ollama `gemma4:12b` 코드 검토 API는 연결 시간 초과로 응답을 받지 못했다. 독립 모델 검토를 완료했다고 주장하지 않는다. 로컬 전수 검사·회귀 테스트·채점기 대조 결과를 근거로 삼는다.

대조 결과: `runtime/event-review-curriculum-20261112/CONTROLS.json`. 실제 자료 검증: 자료 폴더의 `VERIFICATION.json`. 원본 COURSE의 해시가 변경되지 않았음을 대조 결과에 기록했다.

향후에는 이 보완 과제를 기존 상담·카드 유지 평가와 함께 사용해야 한다. 현재 범위는 단일 필드 오류이며, 누락/중복 초안과 다중 오류 및 자연어 원문→구조 변환까지 검증한 자료는 아니다. 실제 앱 역할은 기존 answer/memory review 자료와 앱 검증기를 별도로 사용한다.
