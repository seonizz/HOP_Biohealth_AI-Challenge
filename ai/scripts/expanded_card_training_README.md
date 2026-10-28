# Gemma 4 31B 원상담 기초 학습 + 최종 카드 확장 v2

사용자 요청(2026-10-25)에 따라 31B에도 원상담 기초 학습을 연결하고, 새 가상 사례의 다섯 카드 필드를 추가한 로컬 데이터 묶음이다. 12B 채팅 묶음과 기존 v1 파일은 유지한다. 학습 실행이나 모델 성능 검증 결과는 포함하지 않는다.

후속 요청에 따라 학습 완료를 횟수가 아닌 성능으로 판정한다. `training_data/training_completion_20261025/POLICY.json`의 v2 정책은 원상담·카드 수정 단계에서 검증 손실 개선을, 최종 카드 단계에서 검증 손실과 실제 카드 품질 목표의 동시 달성을 요구한다. 상한·정체만으로 완료하지 않는다. 원저장소 설명은 `ai/scripts/training_stop_README.md`에 있으며 기존 COURSE와 데이터·토크나이저 해시는 유지한다.

<!-- COUNTS -->

## 학습 순서

1. `00_original_warmup`: 원상담의 전체 이전 대화를 읽고 다음 상담사 발화를 학습한다. 원상담을 가족·친구의 답변으로 재명명하지 않는다. 기존 적격 자료 중 validation과 동일한 짧은 입력을 가진 train 18행의 보류를 유지한다.
2. `01_card_repair`: 기존의 승인된 카드 오류 수정 20/5행을 이어 학습한다. 이 자료의 과거 입력 계약은 그대로 보존한다.
3. `02_card_generation`: 기존 승인 카드와 신규 사례의 script·doList·typed avoid·next·care를 학습한다. 마지막 단계가 카드 생성이다.

같은 31B 모델 안에서 앞 단계가 새로 만든 어댑터를 다음 단계가 이어받는다. 첫 단계만 새 LoRA이며 중간 초기화·예전 체크포인트 대체·12B 어댑터 재사용은 허용하지 않는다. 실제 학습 시 단계 완료 체크포인트의 해시를 다음 실행에 결합해야 한다. `COURSE.json`은 이 계약이며 학습 실행기는 아니다.

각 단계의 train 전체를 사용하고 validation은 역전파에 넣지 않는다. 단계별 학습률·에포크·메모리 구성은 이 데이터 준비 작업에서 결정하지 않았다. 32,768토큰 용량을 지정하며 긴 원상담을 4,096토큰으로 자르지 않는다. 실제 메모리 적합성은 학습 환경에서 별도 확인해야 한다.

## 새 카드의 출처와 검토

- 새 사례는 실제 환자나 원상담의 파생 기록이 아닌 **AI가 별도로 작성한 가상 성인 관계 사례**다. 가족·친구·직장·공동생활 등의 서로 다른 사건을 작성했다. 기존 평가·봉인 사례·실행 로그에서 가져오지 않았다. 같은 카드의 이름만 바꾸거나 반복 복사해 행 수를 늘리지 않았다.
- 작성 전에 `SPLITS.json`으로 사례별 train/validation을 고정했다. 한 사례의 다섯 필드는 같은 출처 ID와 분할에 속한다. 다섯 필드를 독립 사례 다섯 개로 세지 않는다.
- 사실과 정답을 분리했다. 카드 생성 입력에는 이용자의 보고 사실과 그 사실로만 만든 검색 문서가 들어간다. 다른 카드 정답·검토 결과·교사용 근거표는 입력에서 제외한다.
- 새 `avoid`는 `avoid_phrase`, `reason`, `alternative`를 명시한다. 앱의 기존 저장 형식으로 변환해 스키마를 검증하지만 앱 화면·배치·표시 정보는 바꾸지 않는다.
- 새 가상 사례만 독립 검토한다. 지정 LAN 검토 서버는 연결되지 않아 Mac 로컬 Ollama `gemma4:12b`를 사용했으며, 응답 지연·시간 초과에 대비해 작성에 참여하지 않은 native Codex 검토자의 판정 파일도 구분해 기록한다. 실제 채택 검토자별 수는 `ADMISSION.json`의 `admission_reviewer_counts`에 있다. 검토 요청마다 근거 없는 단정·무단 동의 확대 등 오류 대조군을 넣으며 그 오류를 놓친 배치는 학습 승인으로 사용하지 않는다. 대조군은 학습 데이터에 포함하지 않는다.
- 다섯 필드 모두 통과한 현재 사례 해시만 채택한다. 복수 검토가 있으면 하나라도 반려한 현재 사례는 보류한다. 원문·응답 또는 native 판정 파일·모델·검토 프롬프트·해시는 `provenance/expansion/`에 보존한다. 내용을 고치면 과거 승인은 무효다. 이는 **독립 AI 검토**이며 사람·임상 전문가 검토가 아니다.
- 정규화된 문자 4-gram 유사도로 신규 사례끼리와 기존 카드 근거를 비교한다. 임계값 0.75 이상이면 보류한다. 이 검사는 의미적 독립성을 증명하지 않는다. 기존 봉인 평가 자료는 이번 작업에서 열거나 학습에 사용하지 않는다.

## 데이터와 손실

`data/<phase>/<split>.jsonl.gz`에는 원문 messages, 마지막 assistant만 선택하는 `loss_message_mask`, 출처, 정확 분수 가중치가 있다. `encoded/<phase>/`에는 little-endian uint32 토큰과 JSONL 인덱스가 있다. 모든 offset은 토큰 단위이므로 바이트 주소는 `offset_tokens * 4`다.

원상담 토큰은 검증된 **기존 31B** 묶음에서 선택해 바이트 그대로 재사용한다. 12B 데이터에서 동일한 적격 행 목록을 참조하지만 12B 토큰 파일을 31B로 재표시하지 않는다. 새 카드와 기존 카드 수정 행은 고정된 31B tokenizer/config/template로 다시 인코딩하고 원문 왕복·정답 경계를 검사한다. 토큰을 자르거나 padding을 미리 저장하지 않는다.

각 행의 최종 정답 토큰 평균 CE를 `L_i`로 두고 `sum(weight_i * L_i) / N`을 사용한다. 분할 안에서 과업별 총 질량, 과업 안에서 연결된 출처 가족별 질량이 같고 `sum(weight_i) == N`이다. 이 목적함수를 토큰 전체 평균이나 배치별 단순 평균으로 바꾸면 가중치 의도가 달라진다. 입력·이전 assistant·padding은 손실에서 제외하고 labels를 미리 이동하지 않는다.

```python
import json
import sys
from pathlib import Path

root = Path("training_data/gemma4_31b_expanded_20261025").resolve()
sys.path.insert(0, str(root / "scripts"))
from expanded_card_dataset import verify
from role_dataset import IndexedTokens

verify(root)
course = json.loads((root / "COURSE.json").read_text())
for phase in course["phases"]:
    part = phase["data"]["train"]
    rows = IndexedTokens(root / part["token_index"], root / part["token_binary"])
    example = rows[0]
    # example['encoded']: input_ids, labels, attention_mask, target/prefix lengths
    # example['weight']: exact numerator/denominator for mean target-token CE per row
```

## 재현과 확인

기존 tokenizer 환경(Python 3.12.14, tokenizers 0.23.2, Jinja2 3.1.6, transformers 5.17.0)을 사용했다. 새 패키지나 PyTorch를 설치하지 않고 모델 가중치도 로드하지 않는다. 독립 AI 검토는 별도 로컬 Ollama에서 실행했다.

```sh
# 원저장소에서 새로운 출력 경로를 사용한다. 기존 출력 덮어쓰기는 거절한다.
python -B ai/scripts/expanded_card_dataset.py build \
  --source training_data/two_stage_training_20261022 \
  --prior training_data/role_specialized_gemma4_20261025 \
  --cases training_data/card_expansion_gemma4_20261025 \
  --output training_data/gemma4_31b_expanded_NEW

# 아래 검증은 표준 라이브러리만 필요하다.
python3 -B scripts/expanded_card_dataset.py verify --root .
python3 -B -m unittest discover -s scripts -p test_card_expansion.py

# 별도 토큰 검사: tokenizer/Jinja2 환경과 원래 31B 출처 묶음이 필요하다.
python -B scripts/audit_expanded_card_numeric.py --root . \
  --source /absolute/path/to/two_stage_training_20261022
```

`VERIFICATION.json`은 파일 해시, 원행 선택, 검토와 정답의 결합, 손실 가중치, 토큰 인덱스, 출처 및 동일 입력의 train/validation 중복을 검사한다. 빌드는 `NUMERIC_AUDIT.json`의 원상담 전량 31B 토큰 바이트 대조와 카드 전량 독립 렌더링·재토큰화를 반드시 수행한다. 이후 표준 라이브러리 `verify`는 그 감사의 정확한 행/토큰 범위와 현재 데이터·토큰·토크나이저 해시를 결합해 검사하며, 감사 누락이나 감사 후 변경을 거절한다. `verify` 자체가 매번 새 토큰화를 수행하는 것은 아니다. `APP_SCHEMA_AUDIT.json`은 기존 앱의 typed avoid 및 저장 스키마 검사이며 현재 서비스 요청 전체와 동일하다는 의미는 아니다.

## 남아 있는 범위

이 묶음은 기존 108/25행보다 넓은 **실험용 기초·카드 학습 자료**다. 행 수만으로 학습 성능이나 충분성을 보장하지 않는다. 새 사례는 비위기 성인 관계 상황에 한정하며 안전 판정·의료 진단·약물·학대·미성년자 대응 정답을 추가하지 않는다. 현재 앱의 분석·계획·발화 상세·안전 검토 전체 계약도 이 다섯 카드로 대체하지 않는다.

validation은 개발·품질 점검용이며 독립된 미노출 성능 시험이 아니다. 실제 학습, 사람/전문가 검토, 별도 고정 평가를 통한 배포 적합성 판단은 아직 수행하지 않았다. GPU 서버 접속·학습·앱 변경은 이번 데이터 작업에 포함하지 않는다.

모든 원상담·합성 정답·토큰·검토 원문은 Git에서 제외된 로컬 `training_data/` 아래에만 보관한다. 원문 없는 코드·검사·통계만 버전 관리 대상이다.
