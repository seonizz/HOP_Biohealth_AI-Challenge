# 두 GPU 장문 학습 진행 기록

최신 우선순위: 긴 대화를 포함한 전체 데이터 본학습과 B0/B1 비교를 먼저 완료한다. 추가 최대 토큰 탐색은 보류하고 서비스 추론 측정은 결과 수집 이후로 미룬다.

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
| Tiled MLP, split 25, 28,672 | 실패: 9 microstep / 1 update 후 GPU 0 메모리 부족 |
| 서비스 추론 | 분할 입력 처리와 full/chunk 동일성 검사 코드 준비; GPU 실측 미완료 |

위 실패는 해당 배치와 실행 조건의 결과다. 모든 가능한 설정에 대한 수학적 최대치를 뜻하지 않는다. 최종 설정은 단발 성공보다 누적·반복 업데이트와 실제 source 저장/재개 검사를 우선한다.

## 본학습까지 필요한 검증과 실행 순서

1. 실제 최장 길이 25,316·split 28·Tiled MLP 설정으로 조정한다. 더 높은 한도를 탐색하지 않는다.
2. 전체 44,713행의 fresh tokenization을 기존 길이·label 경계와 대조한다. 설정 변경 시 원래 근거를 보존하며 모든 캐시 행을 재검증한다.
3. 최종 binding의 fused-loss·hidden-gradient·양 GPU MLP 동등성·generation qualification을 수행한다. 같은 데이터·코드·설정의 통과 검사는 재사용한다.
4. 최장 실제8행의 accumulation8 반복 업데이트 2회 → 저장 → 새 프로세스 업데이트1회를 수행한다. 이 검사가 안정성과 저장/재개를 함께 입증하므로 별도 합성 반복 검사를 추가하지 않는다.
5. 필수 검증 통과 즉시 B0(검증4,298행) → 전체 학습5,052step → 동일 기준B1 → 결과 수집을 실행한다.
6. 학습과 평가·결과 수집이 끝난 뒤 서비스 추론 최대 입력/출력 측정을 재개한다. 기존 대기 프로세스1044080은 GPU 사용 전 정지했고 로그·계획을 보존했다.

현재 본학습은 시작 전이며 **0/5,052step, 최근 본학습loss 없음**이다. 용량 검사의 synthetic loss나 canary step은 본학습 진행률에 합산하지 않는다.

서버의 실제 PyTorch 환경에서 준비 코드 단위 검사 99개가 통과했다. 결과 수집기의 별도 테스트 9개도 통과했다. 학습 완료와 서비스 준비 완료는 아직 주장하지 않는다. `hop_deployment_ready=false`를 유지한다.

진행 데이터: `plan_state.json`, `status-latest.json`, `probe-results-latest.json`. 서버 원본 기록과 토큰화 설정을 보존하며, 본학습 완료 결과 ZIP에는 상담 원문·토큰 ID·콘솔 원문을 넣지 않는다.

## 필수 검증 갱신 — 2026-10-09 09:55 UTC

전체 학습 40,415행과 검증 4,298행의 fresh tokenization·정답 경계 검증이 완료됐다. 최종 25,316·split 28 설정에서 loss13개·hidden-gradient4개·양GPU tiledMLP·generation·weights-unchanged qualification이 통과했다. BF16 참조값은 실제 chunk 행렬 크기에 맞춘 독립 eager 계산으로 보정했으며 기존 허용오차는 유지했다. 서버 CPU 회귀 검사9개와 캐시 재사용 검사16개가 통과했다.

자동 실행 PID1044628은 캐시 전체 행 재검증 후 actual-source canary2회 → 새 프로세스1회 → B0 → 5,052step → B1 → strict 결과 수집을 수행한다. 추론 PID1044629는 전체 학습·B0/B1·결과 검증 전에는 GPU 조회나 검사를 실행하지 않는다. 현재 본학습은0/5,052step이며 canary와 구분한다.

## 실제 장문 canary 첫 업데이트 — 2026-10-09 10:18 UTC

최장 실제8행 accumulation8의 첫 optimizer 업데이트 완료. 검증용 target-mean loss4.302671840831415, 536정답토큰, 경과766.613초. step1체크포인트 adapter244,980,744bytes·training_state490,432,379bytes 저장 확인. 두 번째 업데이트를 실행 중이며, 이후 step2저장·새프로세스step3재개가 남아 있다. 본학습은아직0/5,052step; 이검증loss를본학습loss로표시하지않는다.

## 중간 결과 우선 실행 승인 — 2026-10-09 10:30 UTC

사용자는 별도 `학습 상태 확인` 채팅에서 중간 결과를 먼저 받되 전체 학습을 계속하도록 승인했다. 고정 검증32건 mini-B0 → 전체 계획의 첫16step → 같은32건 mini-B1 및 JSON/CSV → 전체5,052step 계속·전체B1 → 새 기본 모델 전체B0 → 최종 수집으로 순서를 조정했다. 표본 비교는 전체 검증 결과를 대체하지 않는다.

최장 실제8행의 accumulation8 업데이트2회와 checkpoint2가 통과했다. 이전 실행 shell을 안전한 저장 경계에서 종료143으로 교체했고, GPU canary는 중단하지 않았다. 새 coordinator1045395와 canary-resume1045420이 실행 중이다. 본학습은 아직0/5052이며 새 프로세스 재개 검증 후 바로 중간 비교·본학습으로 이어진다.

외부 early driver(kit 밖 scripts/) SHA256 `1f86d192f23c7d32e97834bd22ddc2bce4582f9ad7ea7bd6bd3f971b07c284ba`를 고정 배포했다. 서버 CPU 테스트11/11 통과, skip0,7.517초. accumulation8 cap16 이후 새 모델/optimizer/scheduler 재개가 연속 학습과 exact 일치하며, private 표본 선택과 공개 보고서의 원문/ID 배제도 검사했다. 독립 소스 검토에서 중요한 결함 없음. 기존 kit Python/config/data/cache는 변경하지 않았다.

10:37 UTC: 검증32건 표본 고정 완료, seed3407·길이4분위 각8건, sequence172,842토큰/target2,905토큰, 길이318~12,323. 표본SHA `38b324dda59ce4abbf6b05640fb4a760087904ce18f4be0a20ff2d39360fbf36`. private ID는 서버에만 보존. 본학습미시작0/5052; 실제장문canary2 완료(loss4.310013148766845), freshprocess3 진행중.

## 필수 장문 저장·재개 검증 완료 — 2026-10-09 10:46 UTC

실제 최장25316을 포함한8행 accumulation8 업데이트3회 완료. 최초2회 후checkpoint2에서 새프로세스로 복구한3회차는756.323초,검사용loss4.295423256817148이며checkpoint3·gate가정상완료됐다. 반복 구간 모두25316을검증했다. allocator메모리경고32회는남았지만fatalexception없음;gate에참조된모든파일SHA를재검증했다.

필수게이트는모두통과했으므로추가용량탐색없이자동으로early driver1045875가mini-B0 입력검증에진입했다. 본학습은아직0/5052,본학습loss없음. 현재실행상태는로그를다시확인한다.

## 본학습 시작·첫 업데이트 완료 — 2026-10-09 11:00 UTC

고정32 mini-B0 완료: target2,905토큰,가중loss4.685541869071593,131.425초. 표본선정→mini-B0→RUN생성의파일시각순서와fullRUN40415행/5052step/3291230targettokens/25316context/accum8/1epoch/shuffle3407을확인했다.

실제본학습1/5052 완료:8microbatch,461targets,최근loss4.578688892521724,157.264초. canary가아닌mode=train로그다. 현재오류없음. 초기중간보고예상은11:00UTC부터40~60분이며첫step기준이므로이후실측으로갱신한다. 미니평가와학습배치loss의직접비교는하지않으며동일32 mini-B1을기다린다.
