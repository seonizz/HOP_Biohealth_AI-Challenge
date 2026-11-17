# 12B 정상 초안 검토·사건 순서 보완 자료

후속 준비 완료: 토큰화·의미 검토와 수정2행을 반영한 새 학습 묶음은 [12B 추가 학습 자료 준비 완료](local12b_training_ready.md)를 따른다. 이 문서의 원본 v2 묶음은 변경하지 않았으며 아래 pending 상태는 당시 자료 상태를 설명한다.

2026-11-12. 기존 A_original 통제 평가에서 정상 초안 30/30 거절, 대조 가능한 time 120/120 오류가 관측됐다. 기반 모델의 내용 진단에서도 같은 문제가 있었다. 이 자료는 확인된 실패를 학습·평가에서 구분하도록 보완하며, 실제 12B 모델의 개선을 주장하지 않는다.

31B의 실행·자료·공용 생성기·평가기는 수정하지 않았다. 새 코드에서 기존 순수 유틸리티를 읽어 사용하고, 새 12B 경로에만 자료를 생성한다. 기존 12B A/B/C COURSE 및 앱 설정·화면도 바꾸지 않는다. v1 작업 중간 후보 대신 아래 **v2 최종 묶음**을 사용한다.

## 자료 구성

| 묶음 | train | validation | test | 용도 |
|---|---:|---:|---:|---|
| `training_data/gemma4_12b_event_review_supplement_20261112_v2` | 720 | 240 | 240 | 새 합성 사건 상태·정상 승인·오류 검토 |
| `training_data/gemma4_12b_app_review_supplement_20261112_v2` | 1,280 | 320 | 없음 | 기존 답변·메모리 검토 자료의 계약 갱신과 누락 평가 보완 |

두 묶음은 합산한 단일 평가 점수로 사용하지 않는다. 이벤트 묶음은 실제 앱 계약이 아닌 기호적 진단이다. 답변 검토는 기존 **dataset-only answer_review 계약**, 메모리 검토는 **현재 앱의 memory_review 계약**이다. 답변 검토를 실제 앱 전체 답변 검토 검증이라고 부르지 않는다.

모두 원문을 담는 Git 제외 경로에 저장한다. 토크나이저와 수치 마스크 감사, 새 의미 검토, 실제 학습은 수행하지 않았다. `training_ready=false`이며 학습 완료·배포 승인 파일을 만들지 않는다. 학습 시 intended 12B의 정확한 tokenizer/template/revision을 고정해야 한다. Ollama MLX NVFP4와 A_original Q8 LoRA는 동일한 모델 구성이 아니다.

## 사건 자료의 변경

새 사건 원천 200개를 train120/validation40/test40으로 분할했다. 원천마다 pipe/객체 표현과 상태·정상·오류 과제를 만들어 6행을 얻는다. 같은 원천의 모든 변형은 같은 분할에 남고, 이름·값을 치환해도 같은 사건 구조가 분할을 넘지 않도록 fingerprint를 검사한다. 같은 생성기를 사용한 합성 일반화 시험이며 실제 자연어 일반화의 증거는 아니다.

- 정상과 오류 검토는 각 split에서 1:1이다. 정정 이력이 있어도 초안이 이미 현재 사실과 일치하면 승인한다.
- 오류의 절반은 time이고, 나머지는 person/attribute/value/negated/certainty가 균등하다. time의 네 종류도 균등하다: 날짜·값 복사, 사람 ID 복사, none, 값은 같지만 이전 사건 순서 사용.
- 날짜·대상 슬롯을 다양화한다. 같은 값이 재확인된 뒤 다른 사람·속성의 사건이 이어지는 경우도 포함한다. 전역 마지막 사건을 고르는 지름길을 막고 슬롯별 최신 사실을 요구한다.
- time은 날짜가 아니라 사건 순서 문자열이라는 기존 진단 계약을 유지한다. 공개 규칙과 학습 예시에 이를 명시하며 앱 저장 스키마는 변경하지 않는다.
- actual은 반드시 현재 draft의 index/field 값이고 expected는 해당 슬롯의 최신 사건 값이다. 과거 대화의 잘못된 값을 현재 초안의 오류라고 지목하면 실패다.
- train/validation은 마지막 assistant만 학습 대상으로 표시한다. test는 추론 입력·정답 파일만 제공하며 학습 data 목록에는 포함하지 않는다. 폴더 전체 JSONL 재귀 수집을 학습 입력으로 사용하지 않는다.

순방향 정답 생성과 역방향 사건 선택을 대조하고, 검토 정답은 일치 행을 제거해 남은 변경 필드를 독립적으로 찾는다. 묶음 해시·현재 메시지·정답·원천·split·정상/오류 쌍·필드 비율을 검증한다.

## 답변·메모리 검토 자료의 변경

기존 가상 200원천의 train160/validation40 분할을 유지한다. 새 독립 원천이나 독립 test로 계산하지 않는다. 답변800행, 메모리800행이며 각각 시점1·2의 정상/오류 쌍을 보존한다.

메모리800행을 현재 앱 요청 코드로 재생성하고 현재 스키마·callback으로 검증한다. 앱 계약과 생성·평가 코드의 해시를 기록해 이후 drift가 생기면 검증을 실패시킨다. 답변의 후보 excerpt 및 사용자 발화 인용은 실제 문자열·시점과 대조한다. 이미 답한 질문의 반복과 문맥상 불필요한 질문 생략을 구분하는 기존 정책을 보존한다.

개발 평가320행은 과제별160행, 각각 정상80/오류80이다. 이전 역할 평가에서 빠져 있던 answer_review·memory_review를 명시적으로 평가한다. 메모리 감사의 id/verdict와 인용 존재를 검사하되 자유서술 reason/repair의 완전한 의미 정확도를 자동 검증했다고 주장하지 않는다. 정확한 문자열 참조 일치는 의미적으로 동등한 다른 답을 모두 인정하는 판정이 아니다.

## 평가 지표와 실패 처리

응답 JSONL 공통 형식:

```json
{"request_id":"입력의 식별자","status":"ok","finish_reason":"stop","text":"수정하지 않은 모델 출력 문자열"}
```

모델에 전달하는 것은 inputs의 messages뿐이다. reference/target·오류 종류·split 메타데이터는 입력에 넣지 않는다.

미실행·실행 오류·길이 제한·JSON 오류·중복 키·스키마 위반은 성공으로 바꾸지 않고 고정 배정 분모에 남긴다. 코드블록 제거·JSON 복구·자동 재생성·정답 대체를 하지 않는다. 중복/미배정 request ID는 평가 입력 오류로 중단한다.

정상 승인율, 정상 오거절률, 오류 거절률, 이슈 정확도, 근거 정확도를 분리한다. 이벤트에서는 최신 값 정확도와 time 정확도를 따로 계산한다. 오류 거절률이 100%여도 정상 승인율이 낮으면 실패다. 최신 값이 맞아도 time이 틀리면 상태 정답으로 세지 않는다.

이벤트 연구용 기본 gate: 완결 유효 형식100%, 정상 승인95%, 오류 거절95%, 정확한 이슈95%, 전체 사실95%, time98%. **네 가지 time 오류 유형도 각각 이슈 정확도95%**를 요구한다. 전체 평균으로 취약한 유형을 가리지 않는다. 앱 관련 개발 평가도 과제별 형식·정상 승인·오류 거절·감사 및 근거를 독립적으로 gate한다. 이 임계값은 임상·제품 배포 승인 기준이 아니다.

기반 모델과 후보는 같은 평가집단·추론 조건으로 비교한다. `--baseline-report`는 동일 cohort/version/split만 허용하고 핵심 지표 회귀를 차단한다. validation으로 학습 단계·후보를 고르고, 고정된 최종 후보에만 event test를 적용한다. test로 학습량이나 임계값을 바꾸지 않는다. 향후 원상담 종료와 각 역할 단계마다 동일 validation으로 회귀 시점을 기록한다.

## 실행

새 출력 경로에만 생성한다. 기존 묶음 덮어쓰기는 허용하지 않는다.

```bash
python3 ai/scripts/local12b_event_review.py build \
  --output training_data/gemma4_12b_event_review_NEW
python3 ai/scripts/local12b_app_review.py build \
  --source training_data/gemma4_12b_review_expanded_20261101_v2 \
  --output training_data/gemma4_12b_app_review_NEW

python3 ai/scripts/local12b_event_review.py verify \
  --bundle training_data/gemma4_12b_event_review_supplement_20261112_v2
python3 ai/scripts/local12b_app_review.py verify \
  --bundle training_data/gemma4_12b_app_review_supplement_20261112_v2

python3 ai/scripts/local12b_event_review.py score \
  --bundle training_data/gemma4_12b_event_review_supplement_20261112_v2 \
  --outputs runtime/EXPERIMENT/event-validation.jsonl --split validation \
  --report runtime/EXPERIMENT/event-report.json
python3 ai/scripts/local12b_app_review.py score \
  --bundle training_data/gemma4_12b_app_review_supplement_20261112_v2 \
  --outputs runtime/EXPERIMENT/app-validation.jsonl \
  --report runtime/EXPERIMENT/app-report.json

python3 -m unittest discover -s ai/scripts -p 'test_local12b_*.py'
```

보고서는 묶음 외부의 새 파일에 저장한다. gate 실패 시 score CLI는 종료 코드2를 반환하므로 후속 자동화가 실패를 성공으로 처리하지 않도록 한다.

검증 대조군은 정답 참조만 통과해야 한다. 항상 거절·항상 승인·time 복사/none/옛순서·허위 actual/인용·누락 응답은 실패해야 한다. 이 대조군은 **평가 코드 검사**이며 모델 추론 결과가 아니다. 검증 증거는 `runtime/local12b-improvements-20261112/`에 저장한다.
