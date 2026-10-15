# 두 GPU 장문 학습 진행 기록

최신 요구: 기존 4,096토큰 제한으로 제외한 긴 대화를 포함하고, 학습과 서비스 추론의 입출력 한도를 각각 실제 GPU 실행으로 확인한다.

- 원문 학습 40,415행, 검증 4,298행. 기존 보류 1,261행과 split/group 정책을 유지한다.
- 최장 학습 문맥 25,316토큰, 최장 정답 3,922토큰. 토큰을 자르거나 합성 용량 검사 입력을 학습 데이터에 섞지 않는다.
- 전체 source 내 기존 4,096 이하 subset이 이전 kit의 원문과 정확히 일치함을 검증했다.
- 실제 본학습은 accumulation 8, 1 epoch, 5,052 optimizer step이다.
- 새 서버 kit: `/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009/training_kit`.

## 측정 범위

두 RTX 4090의 VRAM은 각 24GB이며, 단일 프로세스에서 모델 층을 나눠 배치한다. 모델 구조상의 262,144토큰 한도를 실제 실행 가능 한도로 보고하지 않는다. 학습 용량은 입력과 정답을 합친 길이이며, 서비스 추론은 입력과 생성 출력의 공유 예산이다.

| 검사 | 결과 |
|---|---|
| 기본 balanced, 16,384 | 실제 역전파 및 업데이트 1회 통과 |
| 기본 balanced, 25,316 / 32,768 | 메모리 부족 |
| 일반 MLP, 명시적 split 26·28, 25,316 | 메모리 부족 |
| Tiled MLP, split 28, 25,316 | 실제 역전파 및 업데이트 1회 통과 |
| Tiled MLP, split 26, 28,672 | 단일 업데이트 통과, accumulation 8 검사 중 두 번째 역전파에서 메모리 부족 |
| Tiled MLP, 29,440 / 30,720 / 32,768 | 해당 시험 배치에서 메모리 부족 |
| Tiled MLP, split 25, 28,672 | accumulation 8 × optimizer 2 안정성 검사 진행 중 |
| 서비스 추론 | 분할 입력 처리와 full/chunk 동일성 검사 코드 준비; GPU 실측 미완료 |

위 실패는 해당 배치와 실행 조건의 결과다. 모든 가능한 설정에 대한 수학적 최대치를 뜻하지 않는다. 최종 설정은 단발 성공보다 누적·반복 업데이트와 실제 source 저장/재개 검사를 우선한다.

## 완료 전 남은 검증

1. 최종 학습 용량·GPU 배치를 확정한다.
2. 서비스 추론에서 입력이 긴 경우와 출력이 긴 경우를 각각 측정한다. 단순 prefill 성공을 긴 출력 생성 성공으로 보고하지 않는다.
3. 전체 44,713행의 fresh tokenization을 기존 길이·label 경계와 대조한다.
4. 새 binding의 fused-loss 13개·hidden-gradient 4개·양 GPU MLP 동등성·generation 검사를 통과한다.
5. canary에만 최장8행을 3개 누적 window에 반복해, 상태 생성 전·후와 새 프로세스에서의 저장/재개를 검증한다.
6. 초기 모델 B0, 전체 학습 5,052 step, B1, checkpoint 파일 SHA, 실행 종료 상태를 검증한다.

서버의 실제 PyTorch 환경에서 준비 코드 단위 검사 99개가 통과했다. 결과 수집기의 별도 테스트 9개도 통과했다. 학습 완료와 서비스 준비 완료는 아직 주장하지 않는다. `hop_deployment_ready=false`를 유지한다.

진행 데이터: `plan_state.json`, `status-latest.json`, `probe-results-latest.json`. 서버 원본 기록과 토큰화 설정을 보존하며, 본학습 완료 결과 ZIP에는 상담 원문·토큰 ID·콘솔 원문을 넣지 않는다.
