# 데이터 파이프라인

데이터 종류·실험 수치·모델 학습 이력은 [데이터와 연구](../docs/current/데이터와_연구.md), 최근 검사 결과는 [현황](../docs/current/현황과_할일.md)에서 관리합니다. 이 문서는 현재 파이프라인의 실행·파일 형식·변환 계약을 설명합니다.

원본을 수정하지 않고 상담·발화·문장·단어, 기존 라벨, 수치 행렬과 주석 작업 이력을 분리한다. 결과는 `outputs/private/`에만 저장하고 Git에 포함하지 않는다. 전체 처리의 실제 완료 여부는 `outputs/private/REPORT.md`와 `verification.json`을 확인한다. **구조 검사 통과는 문장 라벨 정확도·의미 보존·상담 지원 학습 준비를 입증하지 않는다.** 현재 신규 확정 문장 라벨과 검증된 사람 단위 평가가 없으며, TF-IDF 기반 탐색과 원본 정리가 사용 범위다.

## 실행

아래 명령은 `말씨/data/`에서 실행합니다.

```sh
cd /Users/chihun/Documents/ChatGPT/HOP-Final/data
```

새 패키지를 설치하지 않는다. Python 표준 라이브러리와 **기존 NumPy**를 사용한다. 현재 확인한 런타임:

```sh
COUNSELING_PYTHON=/Users/chihun/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3
"$COUNSELING_PYTHON" -m counseling_pipeline environment
"$COUNSELING_PYTHON" -m counseling_pipeline all
"$COUNSELING_PYTHON" -m unittest discover -s tests -v
```

단계별 재개:

```sh
"$COUNSELING_PYTHON" -m counseling_pipeline ingest
"$COUNSELING_PYTHON" -m counseling_pipeline numeric
"$COUNSELING_PYTHON" -m counseling_pipeline suitability
"$COUNSELING_PYTHON" -m counseling_pipeline prepare-ai
"$COUNSELING_PYTHON" -m counseling_pipeline verify
"$COUNSELING_PYTHON" -m counseling_pipeline check
```

`--source`, `--output`, `--config`, `--definitions`로 경로를 지정할 수 있다. 원천 폴더 내부로 출력하는 것은 차단한다. 처음 적재는 원천 전체·위치 검사를 수행하므로 시간이 걸린다. 원본 라벨의 long table과 모든 단어 등장 건을 보존하여 데이터베이스 크기는 압축 원천보다 상당히 크다.

`suitability`는 기존 DB와 수치 행렬을 변경하지 않고 사용 조건·마스크·진단을 추가한다. `verify`와 `all`에서도 실행하며, 입력·기반 행렬·구현·산출물 해시가 모두 일치할 때만 재사용한다. `structural_checks_passed=true`와 `clinical_training_ready=false`는 동시에 성립한다.

적재는 `.building` 데이터베이스에 작성하고 검증 후 교체한다. 전체 적재·집계가 커밋된 stage는 원천 manifest와 모든 source 행이 일치할 때 최종 검증부터 재개한다. SQLite의 hot journal 복구도 유지한다. 완결 표식이 없거나 원천이 달라진 유효 SQLite stage는 자동 삭제하지 않고 보존·거절하므로 새 `--output`으로 안전하게 재실행한다. SQLite가 아닌 임시 파일은 별도 이름으로 보존한 뒤 재구축한다. 이미 완료된 적재는 입력 manifest와 내부 무결성 확인 후 재사용한다. 수치화는 단계 전체 재실행 단위이며 완료 manifest에 입력·설정·구현과 산출물 해시를 기록한다. 파일 손상이나 설정 변경을 감지하면 재계산한다. AI 입력은 레코드 해시로 중복을 방지한다. 원천이나 사용한 사전이 변경되면 주석 이력을 보존하기 위해 새 출력 버전을 사용한다. 동일 출력 디렉터리에 두 프로세스를 동시에 실행하지 않는다.

## SFT 부분 노출 보류

`source_admission`은 기존 전체 응답·문맥 보류 뒤 허용된 train의 과거/최종 assistant 메시지와 validation 정답을 비교한다. NFKC·공백 정규화 후 200자 이상 연속 일치를 발견하면 해당 validation 행만 별도 사유로 보류한다. 원문·split·기존 보류는 유지하고 같은 사람이나 반복 양식인지 자동 확정하지 않는다. `partial_exposure.py`는 100자 창을 50자 간격과 마지막 위치에서 검색하고 실제 포함 및 최장 일치를 검증한다. 이 범위는 200자 이상 연속 일치를 포함하며 짧은·의미·불연속 중복은 보장하지 않는다. SQLite FTS5 trigram을 지원하는 기존 Python 런타임이 필요하다.

새 정책은 `malssi-source-admission-v2`이며, ID·해시·좌표·보류 사유는 Git 제외 로컬 장부에만 남긴다. `token_admission`은 과거 v1을 읽을 수 있고, v2에서는 부분 노출 목록·사유·집계의 일치를 필수로 검사한다. 새 출력 경로를 지정하며 기존 결과를 덮어쓰지 않는다. `counseling_pipeline all`은 아래 SFT 선별 명령을 대신 실행하지 않는다.

```sh
python3 -B -m counseling_pipeline.source_admission \
  --release 데이터셋/말씨_원본상담_SFT_v1_20261009 \
  --selection-audit outputs/private/malssi_round4_20261009/selection_audit.json \
  --output outputs/private/malssi_partial_exposure_20261015/admission

python3 -B -m counseling_pipeline.token_admission \
  --release 데이터셋/말씨_원본상담_SFT_v1_20261009 \
  --admission-policy outputs/private/malssi_partial_exposure_20261015/admission/admission_policy.json \
  --admission-rows outputs/private/malssi_partial_exposure_20261015/admission/admission_rows.jsonl.gz \
  --tokenizer-audit outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/audit.json \
  --row-lengths outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/row_lengths.jsonl.gz \
  --output outputs/private/malssi_partial_exposure_20261015/candidate_4096 \
  --cap 4096 --export-source-rows
```

이 명령은 저장된 길이 장부와 결합해 원본 JSONL 행을 보존한 새 후보를 만든다. 모델·토크나이저 실행이나 학습은 하지 않는다. 현재 추가 보류 9행과 검증 결과는 [대응 수정 v6](../docs/competition/결선_재평가_지적_수정_v6.md)에 기록한다. 과거 학습 kit·발표 집계 스크립트·실험 산출물은 당시 버전을 유지한다.

## 파일과 사용 단위

| 산출물 | 내용 |
|---|---|
| `corpus.sqlite` | 원본 상담·발화·문장·단어·라벨·출처·TXT/JSON 대응 |
| `source_manifest_before.json`, `source_manifest_after.json` | 모든 파일/ZIP 멤버, 원래 경로·해시 |
| `schema_dictionary.json`, `label_dictionary.json` | 원천에서 관측한 모든 경로·키·유형·값·결측 |
| `ingestion_report.json` | 중복·대응 차이·오류·보류·분할 충돌 |
| `pairing_audit.json` | TXT의 원래 화자 접두어를 포함하여 재비교한 대응 결과 |
| `numeric/manifest.json` | 실제 계산한 방법, fit 범위, 파일·해시·차원·행 매핑, 미실행 사유 |
| `suitability/manifest.json`, `usage_contract.json`, `report.json` | 기반 수치화에 연결된 사용 조건, 유효성 마스크, 의미 손실 반례, 중복·불균형 진단 |
| `annotations.sqlite` | 작업·실제 생성·독립 검증·사람 결정·변경 이력 |
| `annotation_queue/` | 버전이 있는 정의·Codex 주석 프로토콜 |
| `labels/confirmed.jsonl` | 실제 검증된 후보만, 허용된 split만. 비어 있으면 확정 라벨이 없음 |
| `labels/held.jsonl` | 미처리/정의 미확인/기술적 보류 및 격리된 결과 |
| `labels/human_review.jsonl` | 실제 AI 검토 뒤 남은 불확실성, 문맥·후보·사람 입력란 |
| `verification.json`, `REPORT.md` | 전수 검증 증거, AC01~AC12, 실제 범위와 제한 |
| `tests_result.json`, `tests.log` | 합성 회귀 테스트 결과와 검증 당시 구현 해시 |

세 학습 단위는 다음처럼 서로 독립적으로 읽을 수 있다. 원본·파생 라벨은 따로 join한다.

```python
import sqlite3
con = sqlite3.connect('outputs/private/corpus.sqlite')
con.row_factory = sqlite3.Row
conversations = con.execute("SELECT * FROM conversations WHERE split='train'")
sentences = con.execute("SELECT * FROM sentences WHERE split='train'")
words = con.execute("SELECT * FROM words WHERE split='train'")
```

`conversations.raw_json`은 전체 원천 JSON, `source_payloads.raw_json`은 각 입력의 원래 JSON 문자열이다. JSON 오류의 원래 bytes는 `source_error_bytes`에 보존한다. TXT 전체는 `source_texts`에 있다. `utterances.raw_json`과 `original_labels`에는 원래 발화 라벨이 남는다. 관측되지 않은 키, `null`, 숫자 `0`, bool `false`를 구분한다. JSON 문법 오류는 임의로 교정하지 않는다.

문장과 단어의 `start_char:end_char`는 **발화 원문의 Unicode code point 위치**, 끝 제외다. 발화의 위치는 줄바꿈으로 결합한 `conversations.text` 기준이다. 문장 `ordinal`은 상담 안의 순서이고 단어 `ordinal`은 문장 안의 순서다. 원본 `index`·시간 등은 raw JSON에 그대로 남긴다. 문장별 시간을 균등 배분하지 않는다.

단어는 문자 범주와 구두점 경계를 이용한 표면 단위이며 한국어 형태소가 아니다. 등장 건과 어휘를 구분하고 NFKC/casefold 정규화와 원문 span을 보존한다. 정규화 문자열의 내부 문자 위치가 필요하면 원문 span에서 다시 계산해야 한다. 정규화된 문자열 위치를 원문 위치로 오인하면 안 된다.

## 수치 표현

밀집 배열은 NPY, 희소 배열은 SciPy 호환 CSR NPZ(`format`, `shape`, `data`, `indices`, `indptr`)다. 전용 scipy 설치 없이도 NumPy로 이 구성요소를 읽을 수 있다.

```python
from counseling_pipeline.suitability import load_features
bundle = load_features('outputs/private', 'sentence', 'tfidf')
csr = bundle['matrix']  # data, indices, indptr, shape
rows = bundle['rows']  # 같은 순서의 row, id, split
use = bundle['row_use_mask']  # 텍스트/특성 사용 조건; 라벨 정답 자격이 아님
train = [r['row'] for r in rows if r['split'] == 'train' and use[r['row']]
if train:
    row = train[0]
    start, end = csr['indptr'][row:row+2]
    columns, values = csr['indices'][start:end], csr['data'][start:end]
```

기본 로더는 `tfidf`, `word_hash`, `char_hash`, `statistics`, 원래 상담/발화 단위의 `source_numeric`만 허용한다. 행 ID·split·사용 마스크를 함께 반환하고 해시나 행 매핑이 다르면 실패한다. SVD·라벨·요약·탐색 통계·cosine을 포함하는 structure는 기본 입력에서 제외한다. 원래 `numeric/` 파일을 직접 읽는 분석은 이 제한을 자동 적용하지 않으므로 사용 계약을 별도로 지켜야 한다. `source_numeric`은 NumPy masked array로 반환하며 invalid 칸을 가린다. `.data`를 직접 꺼내면 마스크를 잃는다.

- train 문장만으로 단어 unigram/bigram 어휘·DF·IDF를 만든다. validation은 같은 변환기의 transform만 사용한다. 단어/문자 feature hashing은 fit하지 않는다.
- 공기 행렬과 PPMI/SVD를 train 문장 안의 창에서 계산한다. 단어 벡터와 문장/상담 평균 pooling에 coverage를 함께 제공한다. 이는 신경망 의미 임베딩·감정 점수가 아니다.
- 단어 등장 건은 `word_occurrence_mapping.npy`의 lexical/distributional 행 번호로 벡터를 참조한다. OOV `-1`은 배열 인덱스로 사용하기 전에 제외해야 한다. OOV=0 벡터와 관측 마스크를 함께 적용한다.
- 전체 어휘 inventory의 행 ID는 저장소 식별자다. 해당 숫자를 거리나 학습 feature로 사용하지 않는다. train 출현 여부와 빈도는 별도 열이다.
- 전체 코퍼스 빈도는 `numeric/exploration/`에 분리한다. 학습 입력으로 사용하지 않는다.
- 원본 라벨의 typed one-hot·presence·nonnull 배열은 **target 전용**이며 원래 상담/발화 단위다. 문장·단어의 정답으로 전파하지 않는다. 관측 마스크는 적용 가능성 마스크가 아니며 적용 가능성은 정의 미확인 상태다.
- 원래 수치 메타데이터는 source_numeric 배열과 observed 마스크로 보존한다. `suitability/*_source_numeric_valid.npy`는 유한한 비음수 수치, 정수 글자 수, 시작≤종료 조건을 검사하며 reason bit 배열에 사유를 남긴다. 관측값 0은 유효할 수 있고, bool·문자열·null·결측은 수치 0과 다르다. 개별 시간값이 유효해도 양쪽 시간이 없으면 duration은 invalid다. 이것은 원문 정확성·단위 교정·임상 유효성 판정이 아니다.
- 불완전 상담은 `conversation_text_masks.npy`의 `whole_conversation_usable`로 전체 상담 입력에서 기본 제외한다. 정상 문장 자체는 보존하며, 전체 상담 문맥이 필요한 경우 `load_features(..., require_complete_context=True)`를 사용한다. 이 마스크는 기존 확정 라벨을 삭제하거나 정답 자격을 부여하지 않는다.
- 원본 요약과 라벨·AI/사람 판정은 기본 입력에 들어가지 않는다. 상담 전체 통계는 오프라인 전체 대화 특성이며 실시간 예측용 prefix가 아니다.
- 원래 split은 보존한다. 동일 ID/동일 본문이 split을 가로지르면 후보 그룹 전체를 `quarantine`한다. ID의 실제 동일인 의미는 미검증이며 `ingestion_report.json`의 제한을 확인한다.

## 의미·평가 품질의 제한

SVD pooling은 빈도가 높은 제한된 어휘만 평균하므로 중요한 단어가 OOV이면 뜻이 다른 문장이 동일해질 수 있다. `suitability/report.json`은 합성 문장 “자살하고 싶어요”/“행복하고 싶어요”를 저장된 변환기로 검사한다. 기본 설정의 실데이터에서는 SVD가 두 문장을 구분하지 못한다. TF-IDF·문자 해시의 이 쌍 구분 성공은 일반 의미 정확도를 입증하지 않는다. SVD의 zero 검사는 마지막 coverage 열을 제외하며, full coverage와 nonzero 모두 의미 보존의 충분조건이 아니다. SVD·인접 cosine은 탐색에 한정한다.

`sentence_seen_in_train.npy`와 `sentence_evaluation_masks.npy`는 NFKC와 공백 정규화 후의 동일 문장 진단이다. 후자는 validation 중 train 미등장 전체 문장, 그중 30자 이상 문장의 두 subset이며 다른 split은 0이다. 사람 단위 독립성·라벨 신뢰도 마스크가 아니다. subset을 이용할 때 원래 검증 분모·제외 수·잠정 그룹 수를 함께 보고한다. 이 감사는 학습 vocabulary/fit과 원래 split을 바꾸지 않는다. 실제 사람 관계 확인 전에는 성능을 사람 단위 일반화나 상담 지원 효과로 해석하지 않는다.

숫자 원본 라벨의 0 비중은 typed value 기준으로 보고한다. 0이 증상 부재 또는 적용 불가라는 뜻으로 추정하지 않는다. 공식 판정 정의·적용 조건과 독립 검토 정답을 확보한 뒤 목적별 평가가 필요하다.

## Codex 생성·독립 검증·사람 검토

`docs/label_evidence.md`에 공식 사전 조회 결과를 기록했다. 현재 0~3의 판정 의미가 미확인인 라벨은 자동 생성하지 않는다. `prepare-ai`는 작업 준비이며 실제 AI 호출을 만들지 않는다. 미처리 항목을 사람 검토나 검증 완료로 바꾸지 않는다. 별도 AI API나 Codex CLI를 자동 호출하지 않는다.

정식 판정 정의를 확보하면 원본 출처와 버전을 기록한 사전을 제공하고 실제 현재 Codex 세션에서 준비된 문맥을 읽어 생성한다. 검증은 생성과 다른 run에서 먼저 독립 후보를 판단하고 비교한다. 결과는 다음 명령으로 수용한다.

```sh
"$COUNSELING_PYTHON" -m counseling_pipeline ai-batch --file outputs/private/batch.jsonl --limit 20
"$COUNSELING_PYTHON" -m counseling_pipeline import-generation --file outputs/private/generation.jsonl
"$COUNSELING_PYTHON" -m counseling_pipeline import-verification --file outputs/private/verification-records.jsonl
"$COUNSELING_PYTHON" -m counseling_pipeline import-human --file outputs/private/human-decisions.jsonl
```

레코드 형식은 `docs/annotation_format.md`에 설명한다. import는 실제 실행을 대체하지 않는다. 모델 ID는 확인할 수 없으면 null이며 확신도를 확률로 만들지 않는다. 최초 검증 1회+재검토 1회까지만 수용하며 미해결 후보는 사람 검토에 남는다. 같은 문장의 일부 라벨만 불확실하면 확인된 다른 라벨은 별도로 export한다. 사람 결정은 비어 있는 입력란을 채우는 것으로 완료되지 않고 실제 reviewer·시각·정의·증거가 있는 새 레코드가 필요하다. 원본과 이전 이력은 덮어쓰지 않는다.
