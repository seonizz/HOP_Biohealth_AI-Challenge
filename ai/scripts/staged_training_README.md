# 원상담 전체 train → 서비스 보정 학습 데이터

2026-10-22 사용자 요청에 따라 만든 **새 학습용 데이터 묶음**이다. 로컬 CPU로 데이터·토큰·마스크를 준비하고 검증했다. 모델 가중치, 과거 어댑터, 인증 정보는 포함하지 않는다. GPU 서버 접속이나 학습은 실행하지 않았다.

## 학습 순서

`COURSE.json`을 실행 설정의 기준으로 사용한다. 논리적으로 두 단계이며, 서비스 보정은 두 세부 단계로 나눈다.

| 단계 ID | 역할 | train | validation | 시작 가중치 |
|---|---|---:|---:|---|
| `01_original` | 전처리한 원상담의 적격 train 전체 | **37,083** | **3,618** | 원본 기반 모델 + 새 LoRA |
| `02a_supporter` | 주변인 관점의 응답·경계·도움 보정 | **43** | **29** | 이번 `01_original`에서 만든 어댑터 |
| `02b_service_wire` | 실제 서비스 JSON 응답 형식·근거 보정 | **123** | **33** | 이번 `02a_supporter`에서 만든 어댑터 |

주 경로의 train 행 합계는 **37,249**, validation은 **3,680**이다. 동일 대화의 여러 시점에서 파생한 행이므로 사람 수나 독립 대화 수가 아니다. 에포크 반복 횟수를 고유 데이터 수에 더하지 않는다.

각 단계는 별도 데이터로 유지하고 **직전 단계가 새로 만든 어댑터를 그대로 로드**한다. 단계가 바뀔 때 기반 모델에서 새 LoRA를 생성하면 원상담 학습이 사라지므로 허용하지 않는다. 직전 단계의 완료 기록·어댑터 파일 SHA-256·전체 train 소비 수를 다음 단계 기록에 결속해야 한다. 단계 사이 optimizer는 새로 만들 수 있지만 어댑터 가중치는 초기화하지 않는다. 예전 step100이나 r7 어댑터로 대신 시작하지 않는다.

학습률·에포크·GPU 배치 구성은 이 데이터 묶음으로 실측한 값이 아니다. 전체 원상담을 최소 한 번 순회한 다음 보정하며, 각 에포크에서 모든 해당 train ID를 정확히 한 번 소비해야 한다. 최종 결론 품질은 동일한 고정 평가로 원상담 학습 직후와 보정 후를 비교해 결정한다. 이 묶음은 품질 향상이나 자동 서비스 배포를 인증하지 않는다.

## 원상담을 얼마나 포함했는가

| 처리 | train | validation |
|---|---:|---:|
| 기존 전처리 SFT | 40,652 | 5,322 |
| 기존 누출·격리 보류 제외 | −237 | −1,033 |
| 기존 의료 맥락 검토 보류 추가 제외 | −3,332 | −671 |
| 이번 학습 경로에 포함 | **37,083** | **3,618** |

기존 구성 장부의 `chosen` 표본, 그룹당 16행 제한, 대화 구간별 대표 선별, 4,096토큰 컷을 적용하지 않는다. 적격 행을 전부 포함한다. 의료 맥락 플래그는 검토 보류 규칙이며 의학적 판정을 의미하지 않는다. 보류 자료를 조용히 다시 학습에 넣지 않는다.

train의 **22,305행은 4,096토큰보다 길다.** 전체 원문 접두부를 유지했고, 같은 대화의 과거 상담사 응답은 입력 맥락으로만 사용한다. 정답 시점 이후 대화는 포함하지 않는다. 기존 원상담 화자·목표를 주변인으로 재명명하지 않는다.

행별 포함 여부와 보류 사유는 `provenance/source_decisions.jsonl.gz`, 기존 판단 근거는 `provenance/full_pool_ledger.jsonl.gz`와 `admission_rows.jsonl.gz`에 있다. 보류된 원문은 이전 전체 보존 묶음에 그대로 있고, 이번 실행용 데이터에는 들어 있지 않다. 원문을 새로 저작하거나 상담 내용·라벨을 바꾸지 않았다.

## 보조 과업

`optional_auxiliary`에는 문장 86/59, 근거 span 102/76, 상태 추출 6/6, 관계 메모리 6/6행을 보존했다(train/validation). 합계 **200/147행**이다. 이들은 다른 정답 스키마의 과업이므로 주 모델의 기본 순차 학습에 자동 혼합하지 않는다. 별도 어댑터나 명시적으로 검증한 다중 과업 설계를 위한 자료다. 기존 575행 묶음의 모든 행은 주 보정 경로 또는 이 보조 경로에 보존된다.

## 파일 형식

각 `data/<단계 ID>/`에는 train과 validation이 분리돼 있다.

- `train.messages.jsonl.gz`: `messages`, `loss_message_mask`, 행 ID, task, split, 정확 분수 가중치, 출처 group/root, 원행·정답 해시. 원상담은 추가로 원본 메타데이터와 기존 검토 플래그를 보존한다. 다른 프레임워크나 모델에서도 읽을 수 있다.
- `train.tokens.bin`: 동일 Gemma 4 tokenizer로 새로 인코딩한 **little-endian uint32** 토큰 ID. 각 행의 전체 시퀀스를 순서대로 저장하며 패딩하지 않는다.
- `train.index.jsonl`: 토큰 단위 offset, prefix/target/sequence 길이, 가중치, 출처와 메시지 해시. 전체 토큰을 RAM에 올리지 않고 무작위 행 접근이 가능하다.
- `validation.*`: 같은 구조의 검증 전용 파일. 역전파에 넣지 않는다.

토큰 offset을 바이트 주소로 바꿀 때는 **4를 곱한다**. 손실 라벨은 다음과 같이 복원한다.

```python
labels = [-100] * prefix_length + input_ids[prefix_length:]
attention_mask = [1] * len(input_ids)
```

라벨을 미리 한 칸 이동하지 않는다. 마지막 assistant 정답과 종료 토큰만 손실에 포함한다. `messages` 전체의 모든 assistant 발화에 손실을 주는 기본 SFT 설정으로 대체하면 다른 학습이 된다.

서비스 보정의 가중치는 기존 과업·split별 정확 분수를 유지했다. 원상담 가중치는 1이다. 기존 참조 학습과 같은 고정 에포크 가중 목적함수를 사용할 경우 `Z = Σ(weight × target_length)`, 누적창 수 `K`에 대해 각 행의 평균 정답 CE에 `K × weight × target_length / Z`를 곱한다. 여기에 다시 누적창 크기로 나누지 않는다. 전역 배치·분산 평균 규칙을 바꾸는 프레임워크에서는 동일 목적함수가 되도록 조정해야 한다. 이 수식에 validation 행을 포함하지 않는다.

## 다른 환경에서 읽기·검증

압축을 풀고 묶음 디렉터리에서 실행한다. 검증기와 로더는 Python 3.10 이상 표준 라이브러리만 사용하며 GPU나 모델이 필요 없다.

```sh
python3 -B scripts/staged_dataset.py verify --root .
python3 -B scripts/staged_dataset.py inspect --root . --phase 01_original --split train
python3 -B -m unittest discover -s scripts -p test_staged_dataset.py
```

```python
import json
import sys
from pathlib import Path

root = Path(".").resolve()
sys.path.insert(0, str(root / "scripts"))
from staged_dataset import IndexedDataset, verify

verify(root)
course = json.loads((root / "COURSE.json").read_text())
for phase in course["phases"]:
    part = phase["data"]["train"]
    train = IndexedDataset(root / part["index"], root / part["tokens"])
    first = train[0]
    # first["encoded"] supplies input_ids, labels and attention_mask.
    # first["weight"] supplies the exact rational loss weight.
    # Load the previous phase's newly trained adapter before its successor.
```

이것은 데이터 공급 인터페이스 예시이며 학습을 실행하는 명령이 아니다. 이전 575행용 `portable_train.py`의 `--entries`에 이 바이너리나 messages 파일을 직접 넣지 않는다. 그 CLI는 전체 JSONL 토큰을 메모리에 적재하고 별도 과업 목록을 강제하므로, 이번 묶음의 `IndexedDataset`과 `COURSE.json`을 학습기에 연결해야 한다. 수만 행을 전부 적재하는 대신 인덱스만 RAM에 유지한다.

`scripts/export_staged_training.py`는 원저장소의 고정 입력 경로에서 묶음을 재현하는 참고 코드다. 이미 옮긴 묶음을 읽을 때는 원저장소 없이 동작하는 `staged_dataset.py`를 사용한다.

## 토큰·모델 호환성

포함된 토큰은 기존 Gemma 4 31B의 고정 tokenizer/config/template용이다. `tokenizer/`의 해시와 `COURSE.json`을 대조한다. 원상담 전 행은 기존 길이 장부와 비교해 새로 인코딩했고, 서비스 575행은 기존 토큰 ID 전체와 일치하는지도 확인했다.

Gemma의 native completed-assistant 템플릿과 non-thinking generation prefix가 달라 `scripts/gemma4_token_validation.py`가 prefix와 completion을 명시적으로 결합한다. 일반 `apply_chat_template` 결과의 문자열 검색으로 정답 경계를 추정하지 않는다. source의 `messages`는 바꾸지 않으며, 템플릿이 처리하는 경계 공백 여부를 인덱스에 기록한다.

현재 전체 시퀀스 최대는 **25,316토큰**이며, 32,768 이상 문맥을 온전히 처리하는 학습 구성을 사용해야 한다. 데이터가 길이 제한 안에 든다는 사실이 특정 GPU 메모리에 들어간다는 뜻은 아니다. 자르기·요약·packing·자동 행 건너뛰기는 기본 계약에 없다. 다른 tokenizer/model을 사용하면 `messages`부터 전부 다시 인코딩하고 길이와 정답 마스크를 검증한다. 변환용 버전은 `requirements-tokenizer.txt`에 있다.

## 검증과 기록의 범위

`DATASET_MANIFEST.json`, `SHA256SUMS`, `BUILD_COMPLETE.json`, `VERIFICATION.json`에 파일 해시·행 수·정확한 전체 선택 ID 집합·마스크·출처 분할·학습 순서 검증을 남긴다. 기존 데이터와 split을 수정하지 않았고, 검증행을 train으로 이동하지 않았다. 원문과 보류·토큰 장부의 연결은 export 시 전체 행에서 검사한다.

사용자가 지정한 LAN `gemma4:12b`에 구성·검증 코드와 원문 없는 설명을 검토받았다. 지적별 실제 판정과 반영 내용은 `provenance/REVIEW_DECISIONS.json`에 있다. 모델의 지적을 그대로 적용하지 않고 실행 계약과 검사로 대조했다. 원상담 원문을 해당 검토 요청에 보내지 않았다.

이 검증은 데이터 구조·재현·분할의 확인이다. validation은 이미 개발에 노출된 자료이며 독립 test로 부르지 않는다. 합성 보정 자료의 사람·전문가 검토나 임상 유효성을 새로 주장하지 않는다. 과거 provenance의 승인 상태도 그대로 보존한다. 새 학습·생성 품질·GPU 호환성 검증은 아직 수행하지 않았다.

### 추가 수치 검증 — 2026-10-23

원저장소의 `ai/scripts/audit_staged_numeric.py`로 41,276행·232,414,341개 토큰을 독립적으로 재계산해 저장값·마스크와 대조했다. 불일치는 0이다. 정답 175행의 양끝 공백은 고정 템플릿에 따라 제거되며 원문은 보존된다. 기존 표준 라이브러리 검증기는 구조·해시 검사이므로 원문부터의 재토큰화를 대신하지 않는다. 추가 검사에는 `tokenizers`와 `Jinja2`가 필요하며, 실행 명령과 제한은 원저장소 `docs/competition/학습데이터_수치화_엄격검증_2026-10-23.md`를 따른다. 이 추가 검사 코드는 이전 ZIP 안에 소급해서 들어 있지 않다.

서비스 보정 validation 33행 중 28행은 train 정답과 정규화 후 연속 200자 이상 겹쳤다. 반복 JSON 구조·문구가 포함된 결과로 동일 상담 사례의 누출을 단정하지 않지만, 독립 일반화 평가의 근거로는 부족하다. 명시적인 위험 등급 정답도 확인되지 않아 토큰 수치화 통과를 위험도 점수의 타당성으로 해석하지 않는다. 원본 묶음과 split은 변경하지 않았다.

학습 원문·토큰·분할·이 압축 파일은 Git에 올리지 않는다. 이번 묶음은 `.gitignore`가 적용된 로컬 `training_data/` 아래에서 관리한다.
