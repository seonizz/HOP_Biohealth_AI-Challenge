# 31B 학습 실행기와 최종 평가 연결

2026-11-01. **새 reference 실행에 선택적으로 적용하는 로컬 구현**이다. GPU 서버에 적용하거나 실제 모델 학습을 실행하지 않았다. 기존 실행의 코드·binding·체크포인트를 소급 수정하지 않는다.

## 해결한 문제

기존 실행기는 마지막 단계의 첫 전체 epoch 뒤 `stop_pending_evaluation`로 멈췄고, 실제 평가 파일을 준비해도 이를 소비해 다음 epoch 또는 완료로 전환하지 못했다. 새 `--completion-config` 옵션은 다음을 연결한다.

1. 학습 전에 실제 baseline 판정, 개발 suite, 종료 정책을 파일 해시로 고정한다.
2. 각 epoch의 전체 train 소비 기록과 validation, adapter identity, 체크포인트 필수 파일·해시를 대조한다.
3. `training_stop.decide()`로 모든 단계의 손실·역할 평가를 판정한다.
4. 최종 역할 평가가 없으면 대기하고, 들어온 실제 평가를 재시작 시 모델 로드 전에 확인한다.
5. 같은 체크포인트가 손실·역할 기준을 통과하면 채택한다. 미달이지만 계속 조건이면 다음 epoch로 진행하고, 정체·악화·상한이면 미완료로 종료한다.

기존 옵션 없는 실행은 종전 동작을 유지한다. 평가 결과를 임의 작성하거나 과거 baseline을 학습 전에 고정한 것처럼 소급 등록하는 기능은 없다.

## 먼저 필요한 실제 증거

- `POLICY.json`: `cards_31b`의 현재 데이터·tokenizer·개발 suite에 결합된 정책.
- 개발 `SUITE.json`: 기준 모델과 후보가 평가받는 같은 원천·입력의 고정 목록.
- 실제 baseline 판정 JSON: `baseline_checkpoint_sha256`와 `cases`를 포함한다. 각 case에 `case_id`, `input_sha256`, `baseline`의 모든 critical/quality boolean 판정이 필요하다. 미평가 null을 true로 채우지 않는다.
- baseline 체크포인트 identity는 실행기의 `parameter_sha()`와 같은 어댑터 identity다. 전체 파일 SHA와 혼용하지 않는다. 기본 모델·데이터·실행 코드는 별도 runner binding으로 고정한다.

독립 평가자가 실제 출력을 본 판정이 필요하다. 이 연결기는 그 판정의 정직성·전문성·임상 타당성을 증명하지 않는다. 여기서 baseline은 원래 모델 시작점이며 단계별 validation baseline과 구분한다.

## 로컬 준비 명령

아래는 필요한 실제 파일을 확보한 뒤 사용할 형식이다. 현재 미측정 결과를 대신 만들기 위해 실행하지 않는다.

```sh
python3 -B ai/scripts/cards31b_completion.py prepare \
  --policy /absolute/path/POLICY.json \
  --suite /absolute/path/development/SUITE.json \
  --baseline /absolute/path/actual-baseline-judgments.json \
  --dataset /absolute/path/gemma4_31b_expanded_20261025 \
  --output /absolute/path/training_data/cards31b_completion_NEW \
  --run-id cards31b-reference-NEW
```

준비기는 입력을 새 디렉터리에 복사하고 해시·정책·데이터·baseline 검사를 통과한 경우에만 `completion.json`을 확정한다. 기존 출력은 덮어쓰지 않는다. 실패 시 이번 준비기의 임시 디렉터리만 정리한다. 학습·모델 호출은 없다.

실제 학습이 별도로 허용된 새 실행에서는 기존 trainer 인자에 다음 옵션을 추가한다.

```text
--compute-profile reference
--completion-config /absolute/path/training_data/cards31b_completion_NEW/completion.json
```

canary·resume-canary·train에 같은 설정과 코드를 사용해야 한다. completion 설정과 관련 소스 파일 해시도 `BINDING.json`에 포함되므로 **이미 시작한 예전 실행에 옵션만 추가하여 재개할 수 없다**. 기존 증거를 무효화하지 않도록 원래 실행 코드·디렉터리를 보존한다. optimized/evaluation 프로파일과의 연결은 아직 허용하지 않는다.

## 최종 epoch 평가 전달

외부 평가 도구로 실제 후보·baseline 출력과 독립 판정에서 생성한 role evidence를 다음 위치에 둔다.

```text
<work>/role-evaluations/e001.json
<work>/role-evaluations/e002.json
...
```

형식은 `training_stop.score_role()`의 기존 evidence 계약을 따른다. `policy_sha256`, `suite_sha256`, `candidate_checkpoint_sha256`, `baseline_checkpoint_sha256`, 실제 항목별 판정 `cases`가 필요하다. 후보는 해당 epoch의 `CHECKPOINT.json.adapter_sha256`와 일치해야 한다. 평가 baseline 판정은 학습 전에 고정한 것과 같아야 한다.

역할 평가가 없는 상태에서는 `COURSE_STATE.json`을 수동으로 continue로 바꾸지 않는다. 증거를 준비한 뒤 **같은 실행 설정**으로 재개하면 모델 로드 전에 대기 상태를 재판정한다. 원격 실행은 서버 사용 재허용 이후에만 한다.

## 보존되는 경계

- `adapter_config.json`, `adapter_model.safetensors`, `training_state.pt`가 존재하고 비어 있지 않아야 하며 파일 해시와 LoRA 유형을 확인한다. 빈 manifest만으로 완료할 수 없다.
- 모델 텐서·optimizer를 CPU에서 역직렬화해 실제 업데이트를 재현하는 검사는 하지 않는다. 원래 학습기의 canary·저장·복원 검증은 계속 필요하다.
- validation의 adapter·target 길이·전체 행 수·가중 평균이 저장된 단계 결과와 일치해야 한다.
- train ID는 전체를 정확히 한 번 소비해야 한다. 누락·중복·미완료 epoch·이전 후보의 평가를 거절한다.
- `completion-evidence/`에는 원문 없는 손실 지표의 내용 해시 스냅샷을 보관한다. 소비한 체크포인트 manifest·validation·coverage·역할 evidence 해시는 `completion_receipt`로 결합한다.
- 다음 baseline이 아직 없는 단계 전환 재시작에서도 이전 승인 단계를 검증한다. 이미 소비한 평가 파일이 바뀌면 자동으로 새 승인으로 교체하지 않는다.
- 최종 통과 상태는 `training_criteria_satisfied`와 `training_complete=true`다. 공급된 성능 증거의 기준 충족을 뜻하며 미노출 test·배포·임상 검증 완료를 뜻하지 않는다. `unseen_test_passed=false`, `automatic_deployment=false`를 유지한다.

## 로컬 검증

```sh
python3 -B -m unittest discover -s ai/scripts -p test_cards31b_completion.py
python3 -B -m unittest discover -s ai/scripts -p test_train_cards_31b.py
python3 -B -m unittest discover -s ai/scripts -p test_training_stop.py
```

합성 checkpoint·손실·평가 자료로 대기→통과/계속/거절, 상한, stale 후보, baseline 변경, 증거 변조, 미완료 epoch, 빈 파일, 재시작을 검사한다. 실제 가중치·GPU·학습 데이터를 사용한 모델 검증과 구분한다.
