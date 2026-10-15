# 현재 작업 이어가기

긴 대화를 포함한 학습 40,415행 / 검증 4,298행, 잘림 없음, accumulation8·1 epoch 5,052 optimizer step을 유지한다. 추가 최대 문맥 탐색은 보류하고 서비스 추론 측정은 전체학습·전체B0/B1·최종수집 뒤에 수행한다.

- 서버 root: `/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009`. 모든 원격 명령은 `cd /home/slim/choieram &&`로 시작한다.
- 후속 사용자 승인 채팅: `학습 상태 확인` (`01a12000-fb4f-7fc3-b76d-6435d39db351`). 현재 원래학습의40 step에 중간자료를 원한다는 사용자 정정으로 별도16→40 재현은 취소했다. 기존100 step 평가 요청은 유지한다.
- 12:45 UTC 실제 본학습45/5052, cursor360, 최근loss3.978425114293078. 원본 checkpoint16은 저장됨. checkpoint40은 없으며 런타임은 100마다 저장한다. 최신 진행은 `training_kit/work/training/train.jsonl`의 mode=train으로 갱신한다.
- 현재 원래 driver1046734, 원래 stage1045418 / wrapper1045413 / coordinator1045395는 계속 실행 중이다. 새 조정기1048788 (`scripts/continue_checkpoint100.py`, 상태 `work/collection/checkpoint100_pipeline_v1.json`)는 100 step 저장 경계를 대기한다. 중복 실행 금지.
- 100 step 전환은 학습코드 수정이나 process signal 없이, checkpoint100 디렉터리의 완전한 commit 뒤 `training/latest.json` 편의 포인터 교체만 소유한 디렉터리 guard로 막는다. 이 시점의 정확한 IsADirectoryError와 원래 wrapper exit1/log0는 의도된 전환 증거다. 다른 오류는 정상으로 취급하지 않는다. 101 step은 시작되지 않는다. 모든 이전 owner 종료·CP100/RUN/파일해시/1..100로그 확인 후 guard를 보존 이동하고 latest100 포인터를 복원한다.
- guard 감사자료: `work/collection/checkpoint100_handoff_v1/`. 무조건 삭제/복구/재시작 금지. 소유 marker/inode와 checkpoint100 정합성을 확인하는 기존 boundary helper로만 복원한다.
- 이어질 순서: 원래 exact checkpoint100의 동일고정32 평가 → 원래100부터5052/전체B1 → fresh zero-LoRA fullB0 → strict collector. 별도40 재현 stage는 취소됐다. 서버배포/실행없음, 기존stage순서/manifest그대로유지했다.
- 실제40 모델은 저장되지 않았으며 이후step에서 이를 복원할 수 없다. 원래40의 학습로그는 `work/collection/step40-log-review.json`에 보존했다. loss4.633778586408099는 학습배치loss이며 고정32 검증값이 아니다. 취소된 별도16→40 초안은 재실행하지 않는다. 본학습을 되돌리거나 라이브 메모리에 코드를 주입하지 않는다.
- immutable kit의 Python/config/data/cache와 original early driver (`1f86d192f23c7d32e97834bd22ddc2bce4582f9ad7ea7bd6bd3f971b07c284ba`)를 변경하지 않는다. 새 구현은 root/scripts, 새 평가 산출물은 checkpoint100 경로다.
- 기존16 미니결과 JSON/CSV 보존. 동일32행·2905targets 기준 B0 NLL4.685541869071593, B16 NLL4.6853906363505295, 변화-0.003227646348905832%. 미니평가를 전체 검증이나 응답품질 확인으로 표시하지 않는다.
- 100 경계/재개/평가/중단 게시 복구 테스트 서버18개 PASS, skip0. 기존 토큰화44713행·정답경계·수치qualification7·실제최장accum8 canary2+fresh1 통과근거는 재사용한다.
- 추론 coordinator1044629는 기존대로 전체학습·전체B0/B1·freshstrictcollection 뒤에 GPU를 사용한다. 다른 서비스나 GPU 프로세스를 종료하지 않는다.
- native goal은 사용자 요청으로 PAUSED다. 서버 학습은 별개로 계속한다. 확인 훅은20분 간격, 같은 상태에서는 조용히 끝내고 평가완료/실제오류만 알린다.

`TRAINING_RESULT.json`은 체크포인트 전 이전 step/cursor를 유지할 수 있다. 본학습 로그, 커밋 체크포인트, 재현 분기의 step을 구분하고 오래된 요약 숫자만 보고 실패로 오판하지 않는다.
