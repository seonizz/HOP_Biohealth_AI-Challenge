# Gemma 4 12B·31B 성능 기반 학습 완료 기준

2026-10-25 사용자의 “학습 종료의 기준이 횟수말고 성능으로” 요청을 반영한 **v2 정책**이다. **검증 성능 목표를 달성한 체크포인트가 나오면 완료한다.** 반복 상한 도달·개선 정체·검증 악화는 목표 미달 상태에서 학습을 멈추는 사유이며 완료 사유가 아니다. 실제 학습이나 평가를 수행했다는 뜻도 아니다.

## 완료에 필요한 성능

| 구분 | 통과 조건 |
|---|---|
| 원상담 기초, 12B 대화 보정, 31B 카드 수정 | 해당 단계 시작 모델보다 전체 validation 손실이 `max(0.001, 시작 손실 × 0.005)` 이상 감소 |
| 12B 마지막 상태·메모리 단계 | 현재 체크포인트의 위 손실 개선 **및** 아래 채팅 품질 기준 모두 통과 |
| 31B 마지막 카드 생성 단계 | 현재 체크포인트의 위 손실 개선 **및** 아래 카드 품질 기준 모두 통과 |

각 단계는 첫 번째 통과 체크포인트에서 종료한다. 예를 들어 시작 loss가 2.0이면 0.01 이상 줄어 1.99 이하여야 손실 목표를 통과한다. 1.0이면 0.005 감소, 0.1이면 절대 하한인 0.001 감소를 요구한다. 이 손실 개선은 해당 단계의 기초 학습 통과 기준이며, 실제 대화·카드 품질을 대신하지 않는다. 모델·단계가 다른 loss끼리는 비교하지 않는다.

12B와 31B 모두 마지막 단계에서 학습에 쓰지 않은 **출처 집단 30개 이상**으로 다음을 확인한다. 같은 사례의 여러 카드나 변형을 각각 별개 집단으로 세지 않는다. 알려진 원출처를 공유하면 하나로 묶고, 그 집단의 변형 중 하나라도 항목에 실패하면 해당 집단은 그 항목에 실패한다.

| 모델 | 모든 사례에서 오류 0건이어야 하는 항목 | 출처 집단별 각각 95% 이상이어야 하는 항목 |
|---|---|---|
| 12B 채팅 | 출력 계약 준수, 미응답 사실 생성 금지, 화자 구분, 근거 없는 안전·진단 단정 금지, 문맥에 맞는 질문 생략, 동의·도움 범위 준수 | 불필요한 반복 질문 회피, 현재 상황에 맞는 응답 |
| 31B 카드 | 출력 계약, 사실 근거, 화자, 동의·도움 범위, 안전한 안내, 다섯 카드 필드의 역할 | 상황에 맞는 구체성, 실제 사용 가능성 |

모든 판정 항목은 같은 평가 입력에서 **학습 전 모델보다 낮아지면 안 된다.** 이는 loss 비교가 아니라 항목별 출처 집단 통과율 비교다. 예를 들어 학습 전 100%였던 항목이 96.7%가 되면, 95%를 넘더라도 품질 저하로 미통과다. 평균 점수로 중대 오류나 약한 항목을 가리지 않는다. 30개 집단이면 29개 통과는 96.7%, 28개 통과는 93.3%다.

31B의 script는 건넬 말, doList는 행동, avoid는 피할 말·이유·대안, next는 조건별 다음 행동, care는 이용자 돌봄이어야 한다. 12B에서는 문맥상 불필요한 질문의 생략을 유지하되 생략된 답변을 만들어 저장하면 중대 오류로 판정한다. 이 기준은 카드 화면 디자인이나 프로젝트 대회 채점 범위를 바꾸지 않는다.

0.5%·0.001·95%·30개는 **초기 운영 목표**이며 이 데이터의 실험으로 최적성이 입증된 값이 아니다. 작은 검증 집단의 95%는 실제 서비스 전체에서의 정확도 95%나 통계적 신뢰도를 의미하지 않는다. 원출처 ID 검사는 알려진 연결을 차단하며 의미적 중복이나 통계적 독립성을 자동 증명하지 않는다. 기준을 바꿔야 한다면 결과에 맞춰 같은 실행의 통과선을 낮추지 않고 새 정책 해시와 새 실행으로 기록한다.

## 평가와 중단 순서

학습 전 단계 입력 체크포인트를 **validation 전체**에서 평가한다. 역할 평가의 입력·출처·판정 항목과 학습 전 모델의 실제 판정도 첫 단계 시작 전에 고정한다. 매 전체 epoch 종료 때 저장한 현재 체크포인트로 validation 전체를 평가하며, **마지막 단계는 매번 역할 평가도 수행한다.** epoch는 train의 모든 행 ID를 정확히 한 번 소비한 경계다. 한 번 순회했다는 사실만으로 통과하지 않는다.

검증 손실은 `sum(weight_i × mean_last_assistant_target_CE_i) / N`이다. 입력·이전 assistant·padding은 손실에서 제외한다. 각 행의 target 평균 CE에 target 길이를 다시 곱하지 않는다. 긴 상담을 잘라내거나 검증 표본을 줄이지 않는다.

판정 순서는 다음과 같다.

1. 파일·체크포인트·전체 train/validation 범위·유한한 손실을 검사한다. 오류는 `abort` 또는 `abort_invalid_evidence`이며 미완료다.
2. 마지막 단계의 역할 평가가 누락되면 `stop_pending_evaluation`이다. 평가를 완료하기 전에는 다음 epoch로 진행하지 않는다.
3. **현재 체크포인트가 단계의 성능 목표를 모두 달성하면 `stop_phase_accepted`**다. 상한과 동시에 달성해도 통과 사유는 성능이다. 마지막 단계까지 순서대로 통과한 경우에만 `model_training_criteria_satisfied_from_supplied_evidence=true`가 된다.
4. 목표 미달이고 검증이 아래처럼 정체·악화됐다면 `stop_phase_rejected`로 멈춘다. 개선된 loss 최저 후보가 있더라도 역할 품질 미달을 완료로 바꾸지 않는다.
5. 성능 목표가 아직 미달인데 자원 상한에 닿으면 `stop_resource_limit`로 멈추며 미완료다.
6. 그 외에는 `continue`다.

**개선 정체**는 직전 유의미한 최저 손실보다 `max(0.001, 해당 손실 × 0.005)` 이상 낮아지지 않는 평가가 2회 연속인 상태다. **검증 악화**는 관측 최저 손실보다 `max(0.001, 관측 최저 손실 × 0.03)` 넘게 높아진 평가가 2회 연속인 상태다. 이는 과적합 가능성을 점검할 중단 신호이며 과적합 확정 판정이나 성공 조건이 아니다. 두 번이라는 수는 성능 변동을 확인하는 유예 횟수다.

현재 보수적인 자원 보호 상한은 12B 원상담/대화 보정/상태 단계 각각 3/3/2 전체 순회, 31B 원상담/카드 수정/카드 생성 각각 3/2/5 전체 순회다. 필드명은 `safety_max_epochs`다. **이 수치는 목표 학습량이나 완료 기준이 아니다.** 상한으로 멈추면 데이터·학습률·손실 추세·역할 평가를 검토하고, 변경이 필요할 때 새 실행으로 시작한다. 자동으로 상한을 늘리지 않는다.

`selected_checkpoint_sha256`는 성능을 통과한 현재 체크포인트다. `best_complete_epoch`에는 순수 loss 최저 후보를 별도로 남긴다. 이전 loss가 더 낮더라도 그 후보가 역할 품질에 실패했다면 최종 선택본이 되지 않는다. 목표 미달 중단에서는 채택 체크포인트를 만들지 않고 입력 모델과 loss 최저 후보를 보존한다.

평가 대기에서는 현재 체크포인트를 보존하고 누락된 역할 평가를 수행해 **동일 epoch의** `role_evaluation` 참조를 채운 뒤 판정기를 다시 호출한다. 아직 새 학습 업데이트를 하지 않는다. 오류·미달·자원 제한은 자동으로 다음 단계로 넘어가지 않는다. 중단 기준 이후의 epoch를 덧붙인 기록도 거절한다.

## 평가 분리와 현재 상태

역할 suite는 개발 평가용이며 모든 원출처를 train의 전체 group/root와 대조한다. 카드 수정 validation 5행이나 12B 상태 validation 12행만으로 역할 평가를 대체하지 않는다. 현재 개발에 노출된 validation을 독립 미노출 시험으로 부르지 않는다. 봉인 시험은 후보와 생성 설정을 고정한 다음 확인하고, 반복 튜닝의 정답으로 사용하지 않는다. 자동 배포는 없다.

각 모델의 단계는 직전 단계에서 채택한 체크포인트 해시를 이어받는다. 실행 ID·정책·초기 모델·역할 suite·학습 전 판정 해시가 모두 같아야 한다. 12B와 31B의 어댑터는 공유하지 않는다.

정책 묶음은 `training_data/training_completion_20261025/`에 있다. `POLICY.json`은 기존 COURSE·manifest·전체 단계 파일·인덱스·토크나이저 해시에 결합된다. `STATUS.json`은 **학습 미실행·완료 미판정**이다. v1의 상한 기반 단계 채택 규칙은 v2에서 폐기했다. 기존 v1 묶음은 로컬 runtime에 보존하고 데이터 자체와 COURSE는 변경하지 않았다.

현재 도구는 **학습기가 남긴 증거를 읽는 오프라인 판정기**다. 새로운 바이너리 데이터와 행 평균 손실을 소비하는 학습 루프 연결은 아직 필요하다. 기존 `portable_train.py`는 구형 JSONL·31B 전용·토큰 길이 가중 계약이므로 이 정책을 추가한 것만으로 실제 자동 중단이 실행되지는 않는다. tensor 내용, 모델 로딩, optimizer/gradient 검사는 학습기의 책임이다. 이 작업에서는 학습·GPU 서버 접속·모델 가중치 로딩을 하지 않는다.

## 파일과 실행 방법

```sh
# 기초 단계: 전체 validation 성능으로 단계 종료 판정
python3 -B scripts/training_stop.py decide --policy POLICY.json \
  --model cards_31b --phase 00_original_warmup \
  --history runs/example/original-history.json \
  --output runs/example/original-decision.json

# 마지막 단계: 고정 역할 suite와 epoch별 실제 판정이 필수
python3 -B scripts/training_stop.py decide --policy POLICY.json \
  --model cards_31b --phase 02_card_generation \
  --history runs/example/card-history.json \
  --previous runs/example/repair-decision.json \
  --suite runs/example/role-suite.json \
  --output runs/example/final-card-decision.json

# 마지막 종료에 사용한 동일 역할 판정을 재확인
python3 -B scripts/training_stop.py assess-role --policy POLICY.json \
  --model cards_31b --suite runs/example/role-suite.json \
  --evidence runs/example/card-epoch-1-role.json \
  --decision runs/example/final-card-decision.json

python3 -B -m unittest discover -s scripts -p test_training_stop.py
```

`runs/example`은 설명용 경로이며 실제 학습·평가 파일을 만들어 넣지 않았다. 이동한 데이터는 `--dataset-root`로 지정한다. 새 정책은 저장소의 `ai/scripts/training_stop.py bind --chat-root <12B경로> --cards-root <31B경로> --output <새 training_data 하위 폴더>`로 생성한다.

## 증거 입력 계약

history는 `schema="malssi-training-history-v2"`, `policy_sha256`, `model_role`, `phase_id`, `run_id`, `input_checkpoint_sha256`, `model_start_checkpoint_sha256`, `role_eval_suite_sha256`, `role_baseline_judgments_sha256`, `previous_decision_sha256`, `events`를 가진다. 정책·이전 판정 해시는 정렬된 compact UTF-8 JSON의 SHA-256이다. 첫 단계의 이전 판정은 null이다. v1 기록을 v2로 이름만 바꿔 재사용하지 않는다.

`role_baseline_judgments_sha256`는 학습 전 모델의 실제 판단을 고정한다. `baseline_judgments_hash(evidence)`가 cases에서 `case_id`, `input_sha256`, `baseline`만 추출하고 case_id로 정렬한 목록을 canonical JSON으로 해시한다. 최초 학습 전에 그 값과 역할 suite 해시를 고정하고 모든 단계에서 동일하게 이어받는다. 기준 모델의 판정을 중간에 바꾸면 거절한다.

`events`는 정수 epoch 0, 1, 2… 순서다. 각 항목은 `epoch`, 저장된 `checkpoint_sha256`, `validation` 파일 참조를 가진다. epoch 1 이상은 `train` 참조도 필요하다. 참조는 `{"path":"상대경로.jsonl","sha256":"파일 SHA-256"}`이며 history 파일 폴더 내부여야 한다. train JSONL은 행마다 `{"row_id":"실제 소비 ID"}`, validation JSONL은 `{"row_id":"검증 ID","mean_target_ce":값,"target_tokens":정답길이}`다. 누락·중복·다른 정답 길이는 거절한다.

마지막 단계의 epoch 1 이상은 추가로 `role_evaluation={"path":"epoch-1-role.json","sha256":"파일 SHA-256"}`이 필요하다. JSON의 후보 해시는 그 epoch의 현재 체크포인트와 같아야 한다. 순수 loss 최저 후보의 판정을 다른 후보에 재사용하지 않는다.

role suite는 `schema="malssi-role-evaluation-suite-v1"`, `model_role`, `split="development"`, `cases`를 가진다. 각 case는 `case_id`, `source_family_id`, 모든 원출처 `source_lineage_ids`, `input_sha256`을 가진다. 역할 evidence에는 `policy_sha256`, `suite_sha256`, `candidate_checkpoint_sha256`, `baseline_checkpoint_sha256`, `cases`가 필요하다. case마다 같은 `case_id`·`input_sha256`과 `candidate`·`baseline` boolean 판정 맵이 있어야 한다. 판정 키는 POLICY의 critical/quality 항목 전부다. 미평가 항목을 true로 채우지 않는다.

평가자는 실제 생성 결과와 근거로 판단해야 한다. 이 도구는 실제 판단을 대신 생성하거나 임상 승인하지 않는다. 로그·해시·판정의 일관성은 검사하지만, 기록의 정직성·평가자의 독립성·임상 타당성을 자동 증명하지 않는다.

## 참고한 구조

평가 지표의 개선량과 patience, 체크포인트 관리 구조는 [Transformers EarlyStoppingCallback](https://huggingface.co/docs/transformers/v5.10.0/en/trainer_callbacks#earlystoppingcallback) 및 [Trainer](https://huggingface.co/docs/transformers/v5.10.0/en/main_classes/trainer) 설명을 참고했다. SDK callback을 직접 설치한 것은 아니며 문서는 v5.10.0에 고정했다. 개발 평가와 최종 시험 분리는 [Google ML 데이터 분할 안내](https://developers.google.com/machine-learning/crash-course/overfitting/dividing-datasets)를 따른다. 성능 목표 달성 즉시 종료하는 v2 규칙과 수치 임계값은 이 프로젝트의 운영 결정이며 이 문서들이 최적값을 보증하지 않는다.
