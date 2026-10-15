# 학습 중단 및 API 모델 인수인계

2026-10-09 23:56 KST 확인. 사용자의 직접 요청으로 본학습을 중단했다. API 폴더 구현은 `학습 상태 확인` 채팅(`01a12000-fb4f-7fc3-b76d-6435d39db351`)에서 담당한다. 이 작업에서는 API 파일을 변경하거나 서비스를 실행하지 않았다.

## 중단 결과

- 완료한 본학습: **100 / 5,052 optimizer step**, **800 / 40,415행**.
- 학습 누적 토큰: 전체 입력 4,660,316 / prompt 4,595,883 / 정답 64,433.
- 최근 학습 배치 loss: 2.805223510032747.
- 저장되지 않은 **완료 optimizer update는 0개**다. 다음 학습을 위한 모델 로딩 중 종료했다.
- 학습기1052454에 SIGINT, 재개 조정기1048788과 후속 GPU 검사 대기1044629에 SIGTERM을 보냈다. 해당 프로세스와 stage1052187 / wrapper1052182 / tee1052188의 종료를 확인했다.
- wrapper의 실제 종료코드는130, 로그 저장 종료코드는0이다. 원래 signal/traceback/실패 상태를 별도 감사 파일로 보존했다. 이 기록은 사용자 요청에 의한 중단이며 자동 재시작의 근거가 아니다.
- heartbeat `16-step`은 **PAUSED**다. native goal도 paused다. 새 명시적 사용자 요청 없이 학습·자동 재개·후속 GPU 최대치 탐색을 시작하지 않는다.
- GPU reset, 서버 재부팅, 다른 사용자의 프로세스 종료는 하지 않았다.

## 선택할 체크포인트

최신 검증 완료 adapter 디렉터리:

```text
/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009/training_kit/work/training/checkpoints/step-000000100
```

이 디렉터리는 **LoRA adapter와 학습 재개 상태**를 저장한다. 기본 모델과 tokenizer 경로:

```text
/home/slim/choieram/models/gemma-4-31B-it-unsloth-bnb-4bit
```

기존 실행 환경:

```text
/home/slim/choieram/malssi-validation-20261009/.venv/bin/python
```

기존16 step도 `checkpoints/step-000000016`에 보존했다. 실제40 step 저장본과 검증 결과는 없으며, 별도16→40 재현 계획은 취소됐다.

## 무결성과 평가

종료 후 checkpoint100 manifest에 포함된 **모든 파일**과 공개 평가 JSON/CSV의 SHA256을 다시 검증했다.

| 파일 | SHA256 |
|---|---|
| CHECKPOINT.json | `56244f8a6736e648dd8f4cd13d0889d7499a6bf776b9e55491a4ed59c446effd` |
| adapter_model.safetensors | `153b2611645a5ce2cef69362d685fa241d67dac2333a5a47e5630ece99715b73` |
| training_state.pt | `601584697acd66213a3b78134c17a8f14f1839d538ee417bc9fbd6fe5c26a5df` |
| checkpoint100_result.json | `094cd5bdbcbd58fe25f0e74e9cfef9f9d5536c80819ead2aaf44d601e6863c0f` |
| checkpoint100_result.csv | `cc646f6dc51248c728c72e92cab6a28b8332365a05a915f5fce75d02810292f8` |

동일한 고정 검증32행·정답2,905토큰의 target-token-weighted NLL:

| 모델 | NLL |
|---|---:|
| 기본 모델 | 4.685541869071593 |
| 16 step | 4.6853906363505295 |
| 100 step | 2.9222958575017275 |

100 step의 NLL 변화는 base 대비 -1.7632460115698656(-37.631634949390396%), 16 step 대비 -1.763094778848802(-37.62962185415737%)다. 같은32행의 중간 평가이며, 전체4,298행 검증과 전체epoch 학습은 완료하지 않았다. 생성 응답 품질이나 API 구동 성공을 검증한 수치가 아니다.

표본 SHA256: `38b324dda59ce4abbf6b05640fb4a760087904ce18f4be0a20ff2d39360fbf36`.

## 모델 로딩에 필요한 기존 계약

학습 kit 경로는 `/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009/training_kit`이다. 원래 Python/config/data/cache와 체크포인트는 보존한다.

- `config/train.json`: max_length25316, 4bit 기본 모델·BF16 계산, 두 GPU, language layer split28/32, tiled MLP, LoRA r8/alpha8/dropout0.
- 실제 평가에서 성공한 모델 생성 함수: `counseling_pipeline/stage1_preparation.py`의 `load_model(config)`.
- 실제 평가에서 성공한 adapter 복원 함수: `counseling_pipeline/stage1_training_loop.py`의 `_peft_restore(model, checkpoint)`. 내부에서 `load_peft_weights(..., device="cpu")`와 `set_peft_model_state_dict(..., adapter_name="default")`를 사용한다.
- adapter 복원 후 `_parameter_sha(model)` 기대값: `79258bc8ca13ea4a0b0fa91722453c0c0de46dbb539675876d63b30b4cc6f004`.
- GPU 순서: `GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c`, `GPU-a2d3d60c-4eae-7e46-45bc-146e24457642`. 환경변수는 CUDA를 import하기 전에 설정한다.
- `configure_environment()`는 학습 work 아래의 캐시 경로와 현재 디렉터리를 설정한다. 별도 API 폴더에서는 필요한 환경을 API의 캐시/로그 경로에 맞춰 구성하고 원래 학습 CLI나 coordinator를 호출하지 않는다.
- 기존 `load_model()`은 학습용 LoRA 구조를 만들고 `use_cache=False`로 설정한다. API 담당자는 adapter 복원 후 inference mode와 생성/cache 설정을 별도 API 코드에서 확인해야 한다. 이 중단 작업에서는 새 GPU 로딩·생성·서비스 테스트를 실행하지 않았다.
- tokenizer는 위 기본 모델 경로에서 로드한다. 학습의 `enable_thinking=false`와 기존 prompt/template 계약을 참조한다. 서비스 최대 입력·출력 길이는 아직 측정하지 않았다.
- 추론용 adapter 로딩에는 optimizer/scheduler/RNG를 담은 `training_state.pt`가 필요하지 않다. 이 파일은 향후 사용자가 명시적으로 학습 재개를 요청할 경우를 위해 그대로 보존한다.

원래 학습/evaluation에서 사용한 파일을 참조하는 로딩 순서는 `load_config → load_model → _peft_restore → adapter parameter hash 확인 → eval`이다. API 엔드포인트·생성 요청 처리는 별도 API 작업에서 구현하고 검증한다.

## 근거 위치

서버 중단 근거:

```text
/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009/work/collection/USER_STOP.json
/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009/work/collection/user_stop_20261009T1453Z/FINAL_STOP.json
```

평가 결과는 서버 `training_kit/work/checkpoint100_result.json` / `.csv`와 `checkpoint100_evaluation/RESULT_MANIFEST.json`에 있다. 이 문서 옆에도 공개 JSON/CSV와 `checkpoint_milestone_evidence/`의 검증·중단 근거를 보존했다.
