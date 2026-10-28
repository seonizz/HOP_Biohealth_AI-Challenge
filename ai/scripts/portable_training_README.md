# 말씨 학습 데이터 이관 묶음 — 2026-10-22

현재 검증된 학습 입력 **575행**을 두 데이터셋으로 보관한 로컬 이관본입니다.
학습 데이터이며 공개 배포물이나 Git 업로드 대상이 아닙니다. 이번 작업에서는 GPU 서버에 접속하거나 모델을 실행하지 않았습니다.

## 포함한 데이터

| 데이터셋 / 과업 | train | validation |
|---|---:|---:|
| v11 conversation | 43 | 29 |
| v11 sentence | 86 | 59 |
| v11 word | 102 | 76 |
| v11 state_observations | 6 | 6 |
| v11 relationship_memory | 6 | 6 |
| **v11 합계** | **243** | **176** |
| **r7 relationship_agent_wire** | **123** | **33** |

v11은 주변인 지원 5개 과업의 본학습 입력입니다. 과업마다 독립 어댑터로 학습한 계약을 유지합니다.
r7은 근거 판단·자기 돌봄 관련 잘못된 거절·문장 복구를 보정하는 추가학습 입력입니다.
이 둘이나 v11 과업들을 임의로 합쳐 학습하는 명령은 제공하지 않습니다.
validation은 학습에 넣지 않습니다. 검토에 사용된 개발 분할이며 독립 test나 임상·전문가 검증으로 볼 수 없습니다.

## 폴더

- `data/v11/<task>/train.jsonl`, `validation.jsonl`: messages·정답 메시지 마스크·정확한 유리수 가중치·분할 그룹을 담은 이식용 JSONL.
- `data/r7/relationship_agent_wire/`: 같은 이식용 형식의 추가학습 입력.
- `encoded/v11.jsonl`, `encoded/r7.jsonl`: **고정 Gemma 4 토크나이저 전용** input_ids·attention_mask·labels·가중치. labels의 -100은 손실 제외 위치입니다. 분할을 합쳐 저장했지만 학습기가 task와 train/validation을 분리해 소비합니다.
- `original/v11/`: 원행·계보·정책·검증기·토크나이저를 바이트 그대로 복사한 기존 이관본.
- `original/v11-encoded.json`: 기존 실제 토큰 검증 산출물 원형.
- `original/r7/`: admitted 156행과 검토·중복 제거·분할 근거 원형. 수정 전 실패 데이터는 포함하지 않습니다.
- `reference_code/`: 원 검증·직렬화·가중 소비 코드. 역사적 학습기는 원 환경에 묶인 참고 코드이며 새 환경 실행은 `scripts/portable_train.py`를 사용합니다.
- `scripts/portable_dataset.py`: 네트워크·GPU 없이 묶음 검증. 선택적으로 토크나이저만 사용해 r7 재인코딩 검증.
- `scripts/portable_train.py`: 로컬 Gemma 4 31B NF4 모델을 위한 최소 LoRA 참고 학습기.
- `environment/`: 의존성 명세와 이전 서버의 역사적 패키지 목록.
- `DATASET_MANIFEST.json`, `SOURCE_MAP.json`, `SHA256SUMS`: 파일 해시·행 수·원본 상대 위치.

원본 manifest 내부의 이전 Mac/서버 절대경로는 계보 기록으로 보존했습니다. 이식용 입력과 `scripts/` 실행에는 그 경로가 필요하지 않습니다. 모델 경로는 사용자가 새 환경에서 지정합니다.

## 1. 압축 해제 후 무결성 확인

묶음 폴더 안에서 Python 3.12 이상을 사용합니다. 다음 검사는 표준 라이브러리만 필요합니다.

```sh
python3 -B scripts/portable_dataset.py verify
```

Linux에서는 `sha256sum -c SHA256SUMS`, macOS에서는 `shasum -a 256 -c SHA256SUMS`로 manifest까지 대조할 수 있습니다.
외부 위치로 옮긴 뒤에도 같은 명령을 사용합니다.

## 2. 학습 환경 준비

새 환경의 가상환경에 대상 GPU/드라이버와 호환되는 PyTorch CUDA 빌드를 설치한 뒤 나머지 패키지를 설치합니다.
이번 묶음 생성 시 패키지 설치나 외부 다운로드는 수행하지 않았습니다.

```sh
python3 -m venv .venv
source .venv/bin/activate
# 대상 환경에 맞는 PyTorch를 먼저 준비합니다.
python -m pip install -r environment/requirements-training.txt
```

역사적으로 사용한 버전은 Python 3.12.3, torch 2.13.0+cu126, transformers 5.17.0, peft 0.21.2, bitsandbytes 0.50.2입니다.
`historical-server.freeze.txt`는 당시 전체 기록이며 OS/CUDA가 다른 환경에 일괄 설치하는 요구사항 파일이 아닙니다.
해당 버전을 설치할 수 없는 환경에서는 호환 버전으로 새 환경을 검증해야 합니다.

모델 가중치·어댑터·optimizer 상태·인증키는 포함하지 않습니다. 대상 환경에 호환되는 **Gemma 4 31B NF4 로컬 모델 디렉터리**가 별도로 있어야 합니다.
토크나이저 3개 파일의 해시가 묶음과 같은 모델만 토큰 입력을 사용할 수 있습니다. 다른 모델에 이 토큰 ID를 그대로 넣으면 안 됩니다.
다른 모델을 사용하려면 `data/`의 messages와 mask를 새 토크나이저로 다시 인코딩하고, 토큰 수에 따른 가중 정책을 다시 검증해야 합니다.

## 3. 본학습 데이터 사용

먼저 CPU 사전검증을 실행합니다.

```sh
python -B scripts/portable_train.py --validate-only \
  --entries encoded/v11.jsonl --task conversation \
  --tokenizer original/v11/tokenizer \
  --epochs 1 --seed 3407 --accumulation-steps 8 --rank 8 \
  --learning-rate 0.00002 --max-length 4096
```

학습 예시입니다. `/absolute/path/to/gemma4-31b-nf4`를 새 환경의 실제 로컬 모델 경로로 바꿉니다. 출력은 새 폴더로 지정합니다.

```sh
python -B scripts/portable_train.py \
  --entries encoded/v11.jsonl --task conversation \
  --model /absolute/path/to/gemma4-31b-nf4 \
  --tokenizer original/v11/tokenizer --output runs/v11-conversation \
  --device-map auto --epochs 1 --seed 3407 --accumulation-steps 8 \
  --rank 8 --learning-rate 0.00002 --max-length 4096
```

다른 과업은 `--task`와 출력 경로를 각각 바꿔 독립 실행합니다. 가용 GPU 한 장을 쓸 때는 `--device-map cuda:0`을 지정할 수 있지만, 모델과 전체 입력이 들어갈 메모리가 필요합니다.

가중 목적함수는 **K × w_i × n_i / Z**입니다. K는 전체 에포크의 누적 창 수, w_i는 행별 유리수 가중치, n_i는 정답 토큰 수, Z는 전체 과업 train의 가중 정답 토큰 합계입니다. 창 크기로 다시 나누지 않습니다. 마스크·가중치를 무시한 일반 JSONL 학습은 기존 실험의 재현이 아닙니다.

## 4. r7 추가학습 사용

```sh
python -B scripts/portable_train.py --validate-only \
  --entries encoded/r7.jsonl --task relationship_agent_wire \
  --tokenizer original/v11/tokenizer \
  --epochs 1 --seed 3407 --accumulation-steps 8 --rank 8 \
  --learning-rate 0.00001 --max-length 69632
```

실제 학습은 위 본학습 명령의 entries/task/출력을 바꾸고, `--learning-rate 0.00001 --max-length 69632`를 사용합니다.
기존 r7 실험을 이어 재현하려면 `--initial-adapter /absolute/path/to/v11-conversation-epoch3-adapter`도 지정해야 합니다.
기존 시작 checkpoint manifest SHA는 `11c976512809ab5d6d025d28c75374fa0a828fc6b6f1d1b3e47d4f87b9eaabe6`이고 adapter parameter SHA는 `8b1286f9056c100ed0ea86b30817b1dbff0265fcff19d1a6f7ad2e0bedd4cde6`입니다.
이 가중치는 로컬 이관본에 없고 이번 GPU 접속 금지에 따라 가져오지 않았습니다. 이를 생략한 새 base LoRA 학습은 다른 시작점의 새 실험입니다.
참고 학습기는 초기 어댑터 경로를 받지만 기존 체크포인트의 전체 재개 상태나 정확한 동일성까지 인증하지 않습니다.

r7 토큰·가중치를 다시 계산해 포함된 결과와 대조하려면 모델 없이 토크나이저만 사용합니다.

```sh
python -B scripts/portable_dataset.py prepare-wire --output r7-reencoded.jsonl
```

v11의 원 이관 검증을 다시 수행하려면 다음 명령을 사용합니다.

```sh
python -B original/v11/runners/portable_data_verify.py \
  --bundle original/v11 --output-dir v11-reencoded
```

## 포함하지 않은 자료와 검증 범위

과거 보조 분류 3종, 원상담 SFT 대량 자료, v8 후보, 수정 전 r7 이력, 미승인 검토 후보는 최신 본학습 입력과 섞지 않았습니다.
원상담 전체를 단순 합치면 목적·누출 정책이 다른 자료가 다시 포함되므로 이 묶음은 검증된 현재 입력만 대상으로 합니다.
평가용 24사례, 봉인된 6가족, 모델 생성 평가 결과도 학습 입력에서 제외했습니다. 별도의 독립 test는 포함하지 않았습니다.

묶음 생성 시 원본 해시·분할·마스크·가중치, 실제 로컬 토크나이저 인코딩, 압축 해제 후 상대경로 검증을 수행합니다.
참고 학습기는 CPU 사전검증과 순수 테스트를 제공하지만 **새 하드웨어에서 실제 GPU 학습·수치 동일성·학습 후 품질은 이번 이관 작업에서 검증하지 않았습니다.**
입력을 자르거나 packing해서 메모리를 맞추지 않습니다. 메모리가 부족하면 환경·실험 설정을 명시적으로 조정하고 다시 검증해야 합니다.
