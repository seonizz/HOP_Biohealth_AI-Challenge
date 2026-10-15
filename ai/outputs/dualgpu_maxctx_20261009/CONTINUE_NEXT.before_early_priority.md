# 현재 작업 이어가기

최우선은 긴 원문 전체 학습·B0/B1 완료. 최대 학습 토큰 추가 탐색 금지(보류). 실제 max25,316에 필요한 안정화만 허용한다.

- 서버 root `/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009`.
- 자동 본학습 coordinator PID1044628, `scripts/continue_full_training.py`, 상태 `work/collection/full_training_pipeline_v1.json`.
- wrapper PID1044842: 최종 준비 확인 → actual longest8 accum8 canary2 → 새 프로세스 canary1 → B0 → full40415/5052step → B1 → strict results. 이미 실행 중이므로 중복 시작하지 않는다.
- 별도 후순위 추론 coordinator PID1044629: `scripts/run_inference_after_training.py`. fulltraining+B0+B1+freshstrictcollector 전 GPU 조회/실행 불가. 기존1044080은중단·보존됨.
- 상태 확인: 서버 `python3 scripts/status_training_priority.py`. 본학습 시작·step/loss와canary분리.
- 전체40415/4298freshtokenize/경계PASS, 최종25,316/split28/tiled 재검증PASS. 원래config26/MANIFEST/cachemanifest는 `work/collection/pre_final_config_v1`과 token-cache-rebind audit에 보존.
- 필수GPUqualification v27checksPASS(loss13,hiddengrad4,bothGPUtiledMLP,generation,unchangedweights). 이전v1 fusedfirstchunk8fail은 BF16GEMM shape reference오류로수정. 허용오차불변. v2snapshot과mainkit6bindingsexactequal 확인·원본report그대로복사완료.
- 현재기준 본학습미시작0/5052, B0미시작. Mainstatus파일과로그를새로읽고보고한다.
- 실패하면 원인/로그보존후필요한검사만다시수행. 데이터를자르거나긴행삭제/합성혼입금지. 다른서비스/process/GPU종료금지.
- 목표는active유지. 실제1epoch/B0B1/results와후순위추론측정완료전완료선언금지.
