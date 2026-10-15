# 현재 작업 이어가기

전체 40,415행·검증 4,298행, 잘림 없음, 1 epoch 5,052 step을 유지한다. 최대 학습 토큰 추가 탐색은 보류한다.

- 최신 승인: `학습 상태 확인` 채팅의 직접 사용자 요청에 따라 중간 결과를 먼저 만들고 전체 학습을 계속한다. 고정32 mini-B0 → 실제 전체 계획 첫16 step → 같은32 mini-B1 → 같은 체크포인트로5,052까지 → 전체B1 → 새 기본 모델 전체B0 → 최종 결과 수집 → 추론 측정.
- 서버 root `/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009`.
- 새 coordinator PID1045395, `scripts/continue_early_training.py`, 상태 `work/collection/early_training_pipeline_v1.json`. 중복 시작하지 않는다.
- 기존 canary2를 완료·저장한 뒤 이전 shell만 종료143으로 의도적으로 교체했다. GPU canary 프로세스를 종료하지 않았다. 이전 coordinator/wrapper 로그 보존.
- 11:00 UTC 기준 canary3·gate SHA 통과, mini-B0 32행/2905targets loss4.685541869071593 완료. Early driver PID1045875에서 실제 본학습1/5052, 최근loss4.578688892521724, 첫step157.264초. 이 숫자는 최신 로그로 갱신한다.
- 외부 driver는 ROOT/scripts/early_training_driver.py. immutable kit 내 Python/config/data/cache를 변경하지 않는다. 고정표본은 work/early/sample.private.json, 공개 중간 결과는 work/early_result.json/.csv.
- 본학습 체크포인트16은 전체5052계획의 일부다. 새 optimizer + 원래 전체5052·warmup152 scheduler로 state/RNG/cursor 재개. 미니 결과는 work/training 밖에 보존한다.
- 전체 B1을 먼저 측정한 뒤 새 zero-LoRA 기본 모델 전체 B0를 측정해 canonical B0/B1/COMPLETE를 작성한다. 전체 비교/수집 전 완료를 선언하지 않는다.
- 추론 coordinator PID1044629: scripts/run_inference_after_training.py. 전체학습+전체B0/B1+freshstrictcollector 전 GPU 점유 없음.
- 상태: 서버 python3 scripts/status_training_priority.py. 본학습 step/loss, canary, 미니 비교, 전체 평가를 구분한다.
- 전체44713 토큰화·정답경계 및 최종25316/split28/tiled cache 재검증 PASS. 수치 qualification7항목 PASS. 같은 근거를 재사용하며 추가 검사를 반복하지 않는다.
- 실패 로그·기존 산출물 보존. 긴 행 삭제/자르기/합성혼입 금지. 다른 프로세스/서비스/GPU 종료 금지.
- native goal은 전체 학습·평가·최종 수집과 후순위 추론 완료까지 active 유지.

라이브 완료 step은 training/train.jsonl을 따른다. TRAINING_RESULT.json은 체크포인트 전에는 이전 cursor/step을 유지할 수 있다. 로그의 step과 커밋된 체크포인트 step을 구분하며 이를 실패로 오판해 재시작하지 않는다.
