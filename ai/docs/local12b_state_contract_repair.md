# 12B 상태·판단·앱 생성 규격 보완 — 2026-11-16

학습자료와 평가 설계를 보완하고 CPU 검증을 완료했다. **새 학습·새 모델 추론·서비스 변경은 하지 않았으며 31B에도 접속하거나 변경하지 않았다.** 자료 검증 통과는 모델 성능 개선을 뜻하지 않는다.

## 수정 범위

- [자료 생성·검증](../scripts/local12b_state_contract_repair.py): 동일 사람·속성의 반복 사건과 부정·확실성 변화 후 마지막 사건을 선택하는 예시, 중복 초안을 고치는 예시를 추가한다. 기존 v2 자료를 덮어쓰지 않고 새 원천을 만든다. 출력은 슬롯당 한 항목이며 마지막 time·negated·certainty를 함께 보존한다. 형식은 pipe/object 양쪽, 부정·확실성 변경은 양방향을 유지한다.
- [상태 평가](../scripts/local12b_state_evaluation.py): 기존 평가를 보존한 별도 12B wrapper다. 상태 무효율·중복률을 별도 통과 조건으로 두며 허용 enum을 강제한다. 전체 time 오류, 무효 상태 벌점, 유효 상태의 조건부 오류와 양쪽 유효 슬롯 진단을 분리한다. 조건부 분모로 전체 실패를 가리지 않는다. 부정·확실성×형식×방향별 기존 통과 조건과 퇴행 검사도 유지한다.
- [앱 자료·평가](../scripts/local12b_generation_contract.mjs): 실제 앱 ModelGateway의 입력 구성·근거 변환·검증 callback·재시도 경로에서 `state_observations`, `relationship_memory`, `final_analysis_plan_draft`의 정상·오류 수정 예시를 만든다. 앱 UI나 생성 규격을 완화하지 않았다.

## 생성 자료

새 통합 묶음: `training_data/12b_state_contract_repair_20261116_v1`.
앱 생성 원천 묶음: `training_data/12b_app_contract_repair_20261116_v1`.
모두 Git 제외 경로이며 모델 가중치·학습 원문을 Git에 추가하지 않았다.

| 과제 | 학습 | validation |
|---|---:|---:|
| 현재 상태 및 중복 수정 | 2,304 | 768 |
| 정상/오류 사건 검토 | 2,304 | 768 |
| 기존 답변 검토 | 640 | 160 |
| 기존 메모리 검토 | 640 | 160 |
| 새 앱 생성·수정 | 48 | 24 |
| 합계 | 5,936 | 1,880 |

사건 원천은 train 576 / validation 192 / test 192개, 원천당 8행이다. 앱 생성 원천은 8/4/4개이며 원천당 3단계×정상·수정=6행이다. 사건 test 1,536행과 앱 생성 test 24행은 평가용만 생성하고 학습·토큰화에 넣지 않았다. 기존 앱 검토 자료는 원본 그대로 보존했다.

과거 사건 구조 및 새 분할 사이의 구조·프롬프트 누출을 검사했다. 원천·모델 입력의 분할 교차 중복도 검사했다. 앱 생성 분할은 새 합성 원천으로 분리했지만 같은 문장 템플릿 계열을 공유하므로 독립적인 실사용 일반화 근거로 볼 수 없다. 기존 6개 프로젝트 측정 사례를 새 holdout으로 재사용하지 않았다.

## 검증 근거

- 사건 7,680행의 목표를 역방향 사건 순회 oracle와 대조했다. 상태의 유일성·마지막 사건 선택·여섯 필드 보존 및 단일 필드 오류 쌍을 검사했다.
- 실제 앱 gold callback 96개가 통과했다. 정답은 모델 생성 결과가 아니라 합성 검증용 예시다.
- 학습+validation 7,816행을 실제 12B tokenizer/template로 검사했다. 최대 길이는 학습 10,045, validation 10,061토큰이다. prompt/target 경계와 전체 roundtrip이 맞고 임의 절단은 없다.
- 새 테스트 21개와 기존 관련 테스트 16개가 통과했다. 중복·enum·부정/확실성 양방향·누락·미완료·동일 cohort baseline·test 선택 금지를 검사했다.
- 사건 오류 대조군 28개와 앱 오류 대조군 45개를 거부했다. 모두 승인/거절, 중복 현재/과거 상태, 잘못된 time·enum, 항목·근거 개수 초과, 부정 인용 변조, 미확인 삭제, 잘못된 JSON·중복 키·필수키 누락·추가키·error status 등을 포함한다.
- 소스·tokenizer·평가 코드 해시를 고정했다. 앱 코드가 바뀌면 앱 계약 자료 검증은 실패하며 재생성이 필요하다.

자료의 [검증 결과](../../training_data/12b_state_contract_repair_20261116_v1/VERIFICATION.json), [앱 검증](../../training_data/12b_app_contract_repair_20261116_v1/VERIFICATION.json), [사건 오류 대조군](../../runtime/12b-state-contract-repair-20261116/EVENT_CONTROLS.json)을 참고한다.

## 실제 저장 모델 출력 재채점

허용되지 않은 certainty 문자열을 종전 schema가 일반 문자열로 받아들이는 빈틈을 새 평가에서 발견했다. 기존 집계는 `metrics`에 보존하고 아래 엄격한 결과를 `state_metrics`로 구분한다. 서로 다른 평가 정의의 수치를 같은 기준의 성능 변화로 오해하지 않는다.

| 엄격 상태 지표 | A_step565 | 추가25 후보 |
|---|---:|---:|
| 무효 상태 출력 | 43/384 | 52/384 |
| 중복 슬롯을 포함한 출력 | 38/384 | 44/384 |
| 전체 time 오류 | 725/3,406 | 781/3,406 |
| 무효 상태로 인한 time 벌점 | 423/3,406 | 493/3,406 |
| 유효 상태에서의 time 오류 | 302/2,983 | 288/2,913 |

마지막 행은 분모와 출력 집합이 달라 단순 개선을 뜻하지 않는다. 중복은 다른 오류와 동시에 나타난 경우도 포함하므로 이전 단독 원인 집계 37→43과 구별한다. 이 재채점은 과거 validation의 진단이며 새 자료로 학습한 모델 평가가 아니다. [기준 모델 재채점](../../runtime/12b-state-contract-repair-20261116/evaluation/validation-0000.state-summary.json), [추가25 재채점](../../runtime/12b-state-contract-repair-20261116/evaluation/validation-0025.state-summary.json).

## 실행과 한계

`design_ready=true`, `training_ready=false`, `execution_ready=false`, `trainer_hook_connected=false`, `training_started=false`를 유지한다. 기존 학습기에 새 파일만 넣으면 실행되도록 바꾸지 않았다. 향후 별도 학습 요청 시 새 app_generation 과제 손실/마스크와 세 평가 영역(event, 기존 app review, app_generation)의 중단 정책을 12B 학습기에 연결하고 검증해야 한다. task 혼합 제안은 8행 누적 창 742개이며 새 자료로 예산이 달라져 기존 실험과 동일 예산 비교가 아니다.

앱 생성 48개 학습 예시는 계약 보완용 시작 자료다. 자유 문장의 의미 품질은 정확한 reference 일치만으로 일반 평가할 수 없으며, 실사용 개선을 주장하려면 더 다양한 원천과 독립 평가가 필요하다. 어떤 평가기도 배포 승인이나 모델 교체를 허용하지 않는다. test와 진단 자료는 후보 선택에 사용할 수 없다.

재현 명령(저장소 루트):

```sh
PYTHONDONTWRITEBYTECODE=1 runtime/local12b-training-20261113/.venv/bin/python ai/scripts/local12b_state_contract_repair.py verify --output training_data/12b_state_contract_repair_20261116_v1
node ai/scripts/local12b_generation_contract.mjs verify --output training_data/12b_app_contract_repair_20261116_v1
PYTHONDONTWRITEBYTECODE=1 python3 runtime/12b-state-contract-repair-20261116/verify_event_controls.py
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s ai/scripts -p 'test_local12b_*repair*.py'
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s ai/scripts -p 'test_local12b_state_evaluation.py'
node --test ai/scripts/test_local12b_generation_contract.mjs
```

## 후속: 사용자 승인에 따른 학습기 연결

사용자의 추가 학습 요청으로 별도 `runtime/ubuntu12b-state-contract-20261116` 실행 묶음에 새 app_generation 손실, 전체 validation 1,880행, 세 영역의 중단·선택·비교 정책을 연결했다. 원본 자료의 준비 상태는 당시 기록으로 보존하고 `RUNTIME_TOKENIZATION.json`, `RUNTIME_CHECKPOINT_POLICY.json`, `COURSE.json`과 고정 실행 plan으로 새 실행을 허용한다. 전체 7,816행의 토큰·가중치를 원문과 다시 대조했고 실제 학습기 admission 및 CPU 통합 테스트 41개가 통과했다. CUDA canary 통과 전에는 optimizer 업데이트를 하지 않는다.

기준은 A_step565이며 퇴행한 추가25 후보에서 이어 학습하지 않는다. 최대742업데이트, 최초25업데이트 후 전체 검증에서 오승인·상태 중복/무효·앱 생성 실패 또는 퇴행이 확인되면 자동 중단한다. 적합 후보가 없으면 전체 validation 진단 비교만 남기고 새 test는 사용하지 않는다. 31B와 서비스 모델은 변경하지 않는다. 상세 실행 상태·예상 시간·증거는 [실행 기록](../../runtime/ubuntu12b-state-contract-20261116/RUN.md)에 보관한다.
