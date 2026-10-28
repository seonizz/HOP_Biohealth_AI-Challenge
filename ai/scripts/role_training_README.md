# Gemma 4 12B 채팅 / 31B 최종 카드 데이터셋

후속 요청에 따라 **31B 권장 묶음은 `training_data/gemma4_31b_expanded_20261025/`**로 보완했다. 원상담 37,065/3,618행과 카드 생성·수정 708/175행을 단계별로 학습한다. [확장 31B 설명](expanded_card_training_README.md)을 참고한다. 아래 31B 108/25행 표는 보존된 v1 기록이며, 12B 채팅 묶음은 계속 사용한다.

학습 완료는 횟수가 아닌 성능으로 판정한다. `training_data/training_completion_20261025/POLICY.json`의 v2 정책은 기초 단계의 검증 손실 개선과 마지막 단계의 실제 역할별 품질 목표 달성을 요구한다. 반복 상한·개선 정체만으로 통과하지 않는다. 자세한 기준은 `ai/scripts/training_stop_README.md`에 있다. 기존 데이터 묶음의 COURSE와 해시는 유지한다.

2026-10-25 사용자 요청으로 기존 학습 자료를 두 모델의 역할에 맞춰 분리했다. 처음 요청한 14B는 사용자가 **Gemma 4 12B**로 정정했다. 원본 데이터와 앱은 수정하지 않았다.

로컬 산출물: `training_data/role_specialized_gemma4_20261025/`. 이 폴더 전체는 Git 제외 대상이다. 모델 가중치·학습 실행·GPU 서버 접속은 포함하지 않는다.

## 기본 학습 경로

| 모델 / 단계 | train | validation | 목적 |
|---|---:|---:|---|
| 12B `01_dialogue_warmup` | 37,065 | 3,618 | 원상담의 전체 접두부를 읽고 다음 상담사 발화 학습 |
| 12B `02_supporter_dialogue` | 43 | 29 | 주변인 지원의 응답·명확화·경계 표현 |
| 12B `03_state_memory` | 12 | 12 | 원문 근거에 따른 상태와 관계 메모리 |
| **12B 합계** | **37,120** | **3,659** | |
| 31B `01_card_generation` | 88 | 20 | script·doList·next·care의 승인된 정답 |
| 31B `02_card_repair` | 20 | 5 | 위 카드의 근거 오류 수정 |
| **31B 합계** | **108** | **25** | |

행 수는 독립 상담·사람 수가 아니다. 31B 생성 자료는 train 22개, validation 5개 출처 그룹에서 파생됐다. 동일 원문에 대한 서로 다른 카드 필드와 수정 행을 독립 사례로 부풀려 계산하지 않는다.

각 `COURSE.json`의 `phases`만 기본 학습 경로다. 같은 모델 안에서는 순서대로 이어 학습하되 12B·31B 사이 어댑터를 공유하지 않는다. 학습률·에포크·GPU 배치 값은 이번 데이터 작업으로 결정하지 않았다.

## 바뀐 데이터 구성

- **출처별 균형:** 긴 상담에서 파생된 많은 행이 전체 목적함수를 독점하지 않도록 정확 분수 가중치를 부여했다. 한 단계에서 과업별 총 질량을 같게 하고, 과업 안에서는 연결된 출처 가족별 질량을 같게 한다. 여러 그룹을 연결하는 행도 같은 가족으로 계산한다.
- **역할 분리:** 최종 카드 작성 모델의 기본 경로에서 검토 판정 JSON과 구형 설명 스키마를 제외했다. 검토 자료는 `review_only`, 구형 avoid·detail은 `legacy_schema`에 보존한다.
- **승인된 정답만 추출:** `approved=true`, 빈 issues, 누락·중복 없는 전체 claim/audit 대응과 승인 판정을 요구한다. 정답 내용은 과거 승인된 카드 필드 그대로이며 새 상담 정답을 생성하지 않았다. 과거 승인은 새로운 사람·전문가 검토가 아니다.
- **정답이 입력에 노출되지 않게 구성:** 새 카드 생성 입력에서 guide·script·current·plan·claims·검토 결과를 제거했다. 과거 검토 중 검색한 결과도 재사용하지 않고 현재 answers의 원문 전체로 검색 문서를 재구성했다. 생성 과업의 stage는 버전이 고정된 `final_card_*`다.
- **중복 제거:** 동일 task/split/messages는 한 행으로 합치고 모든 원행의 출처·계보를 합쳤다. validation을 train으로 이동하지 않았다.
- **추가 보류:** 원상담 train 18행은 validation 7행과 동일한 두 종류의 짧은 시작 입력을 사용해 `hold_shared_openers`로 분리했다. `training_allowed=false`이며 자동 학습 대상이 아니다. 기존 적격 원상담 37,083/3,618행은 기본 경로와 보류 경로의 합으로 모두 보존된다.

원상담의 기존 누출·의료 맥락 보류 정책은 그대로다. 원상담의 상담사 역할을 주변인 역할로 재명명하지 않고 원문·정답·접두부를 유지했다. 더 짧게 만들려고 과거 대화나 최종 정답을 자르지 않았다.

## 손실과 토큰

`messages`와 `loss_message_mask`가 모델과 독립적인 원본이다. 마지막 assistant만 손실 대상으로 삼는다. 이전 assistant 발화는 문맥이며 정답으로 다시 학습하지 않는다.

각 행의 최종 정답 토큰에 대한 평균 CE를 `L_i`라 할 때 한 단계/분할의 목적함수는 다음과 같다.

```text
sum(weight_i * L_i) / N
sum(weight_i) == N
```

**토큰 총합으로 다시 평균내는 가중 방식과 다르다.** 분산 학습·gradient accumulation에서도 동일한 전역 목적함수가 되도록 합산해야 한다. padding과 입력 토큰은 CE에서 제외하고 validation은 역전파에 넣지 않는다. 정답 토큰 수를 가중치에 다시 곱하지 않는다. 과거 v11의 고정 토큰 질량 가중치를 이 데이터의 새 가중치 대신 사용하지 않는다. 원 가중치는 `source_weight`와 provenance에 보존된다.

12B는 [Google의 Gemma 4 12B IT](https://huggingface.co/google/gemma-4-12B-it/tree/707f0a3b8a3c7ad586ed01e27eafbad8a27dd0f7) revision `707f0a3b8a3c7ad586ed01e27eafbad8a27dd0f7`의 tokenizer/config/template를 사용한다. 31B는 기존 검증된 Gemma 4 31B 자산을 고정했다. 어휘 파일 SHA-256은 같지만 config와 template SHA-256은 다르므로 각 모델의 템플릿으로 새로 인코딩했다. 개별 파일 해시는 각 `COURSE.json`, 결과 길이는 `TOKENIZATION.json`에 있다. 템플릿이 제거하는 메시지 양끝 공백은 원본 messages에 보존하고 정답의 공백 정규화 여부를 토큰 메타데이터에 기록한다.

12B는 `*.tokens.bin`의 little-endian uint32 배열과 `*.index.jsonl`을 사용한다. offset 단위는 토큰이므로 바이트 주소는 `offset_tokens * 4`다. 31B의 작은 기본 데이터는 `encoded/<phase>/<split>.jsonl`에 배열과 마스크를 담았다. 보조·보류 과업은 messages만 보존한다.

```python
import sys
from pathlib import Path

root = Path("training_data/role_specialized_gemma4_20261025").resolve()
sys.path.insert(0, str(root / "scripts"))
from role_dataset import IndexedTokens, verify_bundle

verify_bundle(root)
part = root / "chat_12b/encoded/01_dialogue_warmup"
train = IndexedTokens(part / "train.index.jsonl", part / "train.tokens.bin")
row = train[0]
# row['encoded']: input_ids, labels, attention_mask, prefix/target/sequence lengths
# row['weight']: exact numerator/denominator for mean row CE
```

12B 인코더는 32,768토큰 초과 시 자르지 않고 실패한다. 31B 인코더도 토큰을 자르지 않는다. 토큰 길이 검증은 GPU 메모리 적합성이나 학습 완료를 뜻하지 않는다. labels는 입력과 같은 위치에 두며 미리 한 칸 이동하지 않는다.

## 재현과 검증

표준 라이브러리 검증은 Python 3.10 이상에서 실행한다. 실제 토큰 변환 환경은 Python 3.12.14, tokenizers 0.23.2, Jinja2 3.1.6, transformers 5.17.0이며 PyTorch 없이 실행했다.

```sh
# 원저장소에서 새로운 출력 경로를 사용한다. 기존 출력은 덮어쓰지 않는다.
python3 -B ai/scripts/role_dataset.py build \
  --source training_data/two_stage_training_20261022 \
  --output training_data/role_specialized_gemma4_NEW --chat-size 12B

# 기존 토크나이저 환경의 Python으로 실행한다. 네트워크/모델/GPU를 사용하지 않는다.
python -B ai/scripts/role_dataset.py encode31 \
  --root training_data/role_specialized_gemma4_NEW \
  --tokenizer training_data/two_stage_training_20261022/tokenizer
python -B ai/scripts/encode_chat_role.py \
  --root training_data/role_specialized_gemma4_NEW \
  --tokenizer training_data/role_specialized_gemma4_20261025/chat_12b/tokenizer

python3 -B ai/scripts/role_dataset.py verify \
  --root training_data/role_specialized_gemma4_20261025
python3 -B -m unittest discover -s ai/scripts -p test_role_dataset.py
```

이동한 묶음에서는 `python3 -B scripts/role_dataset.py verify --root .`로 검증한다. 재생성은 원본 staged 묶음과 원저장소 코드가 필요하다. 인코더는 모든 행의 원문↔토큰 왕복과 정답 경계를 검사한다. 일반 `verify`는 파일 해시·행/출처·분할·가중치·마스크·인덱스·토큰 범위를 검사하며 새 토큰화를 대신하지 않는다.

완료 검증에서는 기본 경로 **40,912행·231,795,519토큰**을 확인했다. 12B의 새 토큰 231,592,525개를 기존 독립 수치 검증본과 바이트·정답 경계 단위로 대조했고, 31B의 202,994토큰은 별도 렌더러와 Rust 토크나이저로 다시 계산했다. 불일치는 0건, 회귀 테스트는 44개 통과다. 12B 최대 길이는 25,316토큰, 31B는 4,645토큰이다. 두 모델 전체의 출처 train/validation 겹침과 학습 허용 데이터의 동일 입력 겹침은 0건이다. 보류 파일의 의도된 동일 입력은 이 0건 집계에서 제외한다.

별도 수치 검사를 재현하려면 tokenizers/Jinja2가 있는 Python으로 `scripts/audit_numeric.py --root . --source <기존 two_stage_training_20261022 경로>`를 실행한다. 결과는 `NUMERIC_AUDIT.json`에 보존했다.

## 남아 있는 데이터 범위

이 자료는 **역할별 기초 학습 데이터**이며 현재 앱 전체 계약을 충족한 학습 완료본이 아니다.

- 12B에는 현재 앱의 통합 `turn_draft`, `turn_review`, `question_review`, `safety_review` 정답이 없다. 기존 `conversation`의 action/components/user_text는 다른 계약이다. 문맥상 질문 생략 기능을 유지하며 임의의 skip·안전·답변 라벨을 만들지 않았다.
- 31B 생성 입력은 `final_card_*` 계약이다. 현재 앱 요청과 동일하다고 주장하지 않는다. 최신 typed avoid와 분석·계획·발화 분할/detail을 위한 검증된 정답은 추가 확보가 필요하다. 구형 avoid 문자열을 임의로 세 필드로 해석해 새 정답을 만들지 않았다.
- 기존 validation은 개발에 노출됐고 반복 정답 문구가 남아 있다. 출처와 동일 입력의 분할 누출 검증 통과를 독립 test·의미 정확도·임상 타당성으로 해석하지 않는다. 현재 학습 결과나 생성 품질을 평가하지 않았다.
- 요청한 LAN `gemma4:12b` 검토는 완료하지 못했다. 내부 구성 전송은 자동 승인 검토가 거부했고, 내부 정보를 제거한 일반 질문은 승인됐으나 연결이 시간 초과됐다. 이 모델의 검토를 받았다고 표시하지 않는다. 실행 검증과 합성 fixture 회귀 검사는 로컬에서 수행했다.

`COVERAGE_GAPS.json`, `VERIFICATION.json`, `provenance/`에서 범위·원행 연결·보류 사유를 확인할 수 있다. 모든 학습 원문·파생 정답·토큰·출처 장부는 로컬 Git 제외 폴더에만 보관한다.
