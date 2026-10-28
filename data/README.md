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

이 명령은 저장된 길이 장부와 결합해 원본 JSONL 행을 보존한 새 후보를 만든다. 모델·토크나이저 실행이나 학습은 하지 않는다. 현재 추가 보류 9행과 검증 결과는 [적대적 재검토 기록](../docs/competition/결선_재평가_지적_수정_v6.md)에 기록한다. 과거 학습 kit·발표 집계 스크립트·실험 산출물은 당시 버전을 유지한다.

## 평가 데이터의 과거 사용 이력

원상담을 보존한 최신 주변인 과업 구성은 [v9](../docs/competition/학습데이터_주변인지원_과업정합성_개선_재검증_v9.md)이며, 원상담 구성은 [입력 총량·절차성 문맥 개선·재검증 v8](../docs/competition/학습데이터_입력총량과_절차문맥_개선_재검증_v8.md)다. [입력 집중도 개선 v7](../docs/competition/학습데이터_입력접두부_집중도개선_재검증_v7.md)과 이전 v6·v5·v4·v3, 주변인 합성 초안·v2는 보존한다. 원상담 후보와 주변인 서비스용 합성 초안은 목적·승인 상태가 다르므로 하나의 학습 행 수로 합산하지 않는다.

`evaluation_history` v2는 실제 원천 release·허용 정책·선별 근거·저장된 토큰 검사와 길이 장부를 명시 입력으로 받는다. `token_admission.validate_and_summarize`로 입력·선별 결정을 검증하고, `source_admission.build_admission`의 기존 규칙을 임시 로컬 경로에서 재계산해 허용 정책·전체 장부와 비교한다. 원천 conversation JSONL의 모든 행 ID·그룹·split을 장부와 대조하고 export 각 행의 원래 JSONL 바이트까지 확인하므로, 장부와 export의 그룹·행 수·보류 사유·원문을 함께 바꾸고 해시를 맞춰도 원천과 다른 후보는 거절한다. 현재 v2 허용 정책을 검증하며 원천과 기존 산출물은 변경하지 않는다.

과거 개발 검토, 데이터 선별, 학습, 튜닝, 프롬프트 설계, 주석 검토를 수행한 행은 **같은 원천 그룹 전체**에 `development_exposed`를 남긴다. 토큰 길이 때문에 제외된 행의 이력도 남은 같은 그룹의 후보에 적용한다. 후보 파일의 이름·압축을 바꾸어도 원래 manifest·입력 해시·그룹 연결을 사용하며, 연결이 끊긴 이력은 무시하지 않고 실패한다.

이벤트 JSONL은 Git 제외 로컬 경로에 보관한다. 각 행의 필수 필드는 다음과 같다. 원문은 이벤트에 복사하지 않는다.

| 필드 | 계약 |
|---|---|
| `schema_version`, `event_id` | `malssi-evaluation-history-event-v1`, 중복되지 않는 로컬 이벤트 ID |
| `purpose`, `occurred_at` | `development_audit`, `data_selection`, `training`, `tuning`, `prompt_design`, `annotation_review`, `custody_record`, `independent_evaluation` 중 하나와 시간대를 포함한 ISO 시각 |
| `source_manifest_sha256` | export가 가리키는 원천 manifest SHA-256 |
| `scope` | `{"kind":"source_split","split":"validation"}`, 또는 `kind`가 `rows`/`source_groups`이고 비어 있지 않은 로컬 `ids` 목록. 모르는 행·그룹·범위는 거절 |
| `input_sha256` | 범위에 해당하는 `conversation/train.jsonl.gz`·`conversation/validation.jsonl.gz`의 원천 해시. 전체 원천 장부를 검사한 근거는 `source_admission_ledger_sha256` 한 개로 연결 가능 |
| `evidence` | 근거 JSON의 `path`, 실제 `sha256`, 그리고 입력 해시별 `input_pointers`. JSON pointer가 실제 근거의 같은 입력 해시를 가리켜야 함. `/`를 키에 포함하면 `~1`로 표기하며 상대 경로는 이벤트 파일 기준 |

빈 이력과 개발 노출이 기록되지 않은 후보는 `history_unverified`다. `custody_record`나 `independent_evaluation` 이벤트도 과거 개발 노출을 지우거나 이력 완전성을 입증하지 않는다. 이 검사기는 독립 평가셋을 인증하는 기능을 제공하지 않으므로 `--intended-use independent_test`는 두 상태 모두 차단하고 종료 코드 2를 반환한다. 해시는 로컬 근거의 연결·변조 검사용이며, 기록되지 않은 과거 사용이나 작성자 신뢰성을 증명하지 않는다. 목적 적합성·라벨 정확도·사람 검토 완료의 대체 근거도 아니다.

원천 전체와 선별 단계별 대화 위치·코호트·기존 휴리스틱 태그를 비교하고 검토 대기열을 준비하는 명령은 `python3 -B -m counseling_pipeline.source_review`다. 새 출력 폴더에만 쓰며 `source_sft.load_inputs`, `evaluation_history.audit_history`, `annotations.context`의 기존 원천·선별·검토 계약을 재사용한다. 원문이 있는 큐는 `outputs/private/`에만 저장한다. [주변인 정답 작성·검토 계약](docs/support_agent/결선_데이터_검토계약_2026-10-16.md)과 [선별 전후 집계·재현 명령](docs/support_agent/결선_데이터_대표성_2026-10-16.md)을 따른다. 대기열 준비는 사람 검토·정답 생성·학습 승인이 아니다.

```sh
"$COUNSELING_PYTHON" -B -m counseling_pipeline.evaluation_history \
  --export-manifest outputs/private/malssi_partial_exposure_20261015/candidate_4096/source_rows/export_manifest.json \
  --source-ledger outputs/private/malssi_partial_exposure_20261015/admission/admission_rows.jsonl.gz \
  --release 데이터셋/말씨_원본상담_SFT_v1_20261009 \
  --admission-policy outputs/private/malssi_partial_exposure_20261015/admission/admission_policy.json \
  --selection-audit outputs/private/malssi_round4_20261009/selection_audit.json \
  --tokenizer-audit outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/audit.json \
  --row-lengths outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/row_lengths.jsonl.gz \
  --events ../runtime/finals-upgrade/data/evaluation_history_events.jsonl \
  --intended-use development \
  --output ../runtime/finals-upgrade/data/evaluation_history_v2_development.json
```

기본 토큰 정책·장부 위치는 export 디렉터리의 상위 폴더이며 이동한 경우 `--token-policy`, `--token-ledger`로 지정한다. 출력과 표준 출력에는 행·그룹·대화·이벤트 ID나 원문이 없는 집계와 파일 해시만 남긴다. `independent_test` 검사도 차단 결과를 집계 파일로 남기며, 기존 출력·심볼릭 링크는 덮어쓰지 않는다. 잘못된 JSON 구조는 원문을 포함할 수 있는 traceback 대신 `status: invalid`와 종료 코드 2로 처리한다. 원천, split, 기존 장부, 라벨과 사람 검토 상태는 수정하지 않는다.

## 주변인 가중 집중도 정책 v11

**최신 가중 집중도 재검증 v11:** [대안 비교·정책 적용·실제 토큰 재검증](../docs/competition/학습데이터_가중집중도_개선_재검증_v11.md). 2026-10-17, 사용자 선택에 따라 **419행 전부**를 보존하고 양수 가중 정책을 적용했다. train은 입력·정답 균형 성분을 절반씩 섞고 validation은 보조 가중 집계로 사용한다. **정규화 HHI 1항목·CV 5항목 악화는 가중 지표에서 해소**됐으며, 원행 지표와 무가중 primary validation은 그대로 공개한다. **정답 17,220토큰과 과업×split별 총량**, 원문·전체 맥락·기존 대표·분할을 보존했다. 실제 tokenizer에서 출력 **8,192** 및 실제 시퀀스 **4,096 이하** 조건 419/419, 관련 회귀 **125개**를 통과했다. 실제 입력 **157,668토큰**은 그대로이고 가중 입력 질량 **155,184.651**은 토큰 절감량이 아니다. 신규 사례의 상대 영향량 감소와 작은 합성 집합·사람 검토·독립 test·앱 전체 정답 부족도 기록했다. 별도 가중 손실 소비 경로를 추가했으며 모델 학습·점수 상향은 수행하지 않았다.

`supporter_group_weighting build`는 원본을 바꾸지 않고 새 Git 제외 경로에 실제 토큰 장부·정확 분수 가중치·원천/구현 해시를 묶는다. `verify --policy`는 실제 tokenizer로 419행을 재검증한다. [최종 정책](outputs/private/composition_v11_supporter_weighted_20261016/final/manifest.json)과 [실제 명령](../runtime/data-composition-supporter-balance-20261016/commands.json)을 사용한다.

`prepare_view(policy, tokenizer, task=..., split="train")`가 반환한 entries와 bindings를 `supporter_weighted_loss.make_plan()`에 전달하고 `backward_window()`로 고정 epoch 분모의 계수를 소비한다. 기존 stage-1 trainer는 이 가중치를 자동으로 읽지 않는다. `evaluate_losses()`는 무가중 primary와 가중 auxiliary를 함께 반환한다. 과업을 자동 혼합하지 않으며 optimizer·중단/재개·전체 epoch 완료 판정은 호출자 책임이다.

## 실제 주변인 토큰·집중도 재검증 v10

**보존한 실제 토큰 재검증 v10:** [토크나이저 복구·실측·집중도·적대적 검증](../docs/competition/학습데이터_실제토큰_집중도_재검증_v10.md). 기존 서버와 SHA-256이 같은 고정 토크나이저를 로컬에 복구해 **419파생행 전부**를 새로 인코딩했다. 출력 **8,192** 예약과 실제 시퀀스 **4,096 이하** 조건 모두 통과했으며 최장 시퀀스는 **3,909토큰**이다. 전체 입력 **157,668**·정답 **17,220토큰**, 그중 신규 279행은 입력 **129,065**·정답 **12,014토큰**이다. 원문·맥락·split과 원상담 v8은 보존했다. raw HHI 18개 비교는 모두 감소했지만 정규화 HHI 1개·CV 5개 악화는 남는다. 과업별 파생 행의 재고 합계이며 자동 혼합·사람 승인·독립 test나 학습 완료를 뜻하지 않는다.

`supporter_token_audit`는 보존된 v9 manifest·내용 해시를 확인하고 5개 과업을 별도로 실측한다. 최종 판정은 [v10 토큰 sidecar](outputs/private/composition_v10_supporter_tokens_20261016/audit/manifest.json), 재현은 [실제 명령](../runtime/data-composition-supporter-tokens-20261016/measure-command.json)을 따른다. 저장소 루트에서 격리 Python과 `PYTHONPATH=data`를 사용하며, 재실행의 `--output`에는 존재하지 않는 Git 제외 폴더를 지정한다. 토큰 길이 측정에 원격 SSH 비밀번호나 모델 가중치가 필요하지 않다.

## 주변인 과업 구성 v9

[대안 비교·적용·적대적 재검증](../docs/competition/학습데이터_주변인지원_과업정합성_개선_재검증_v9.md). 원상담 v8과 기존 주변인 20대화는 그대로 보존하고, 신규 합성 24대화·48응답을 추가해 주변인 후보를 **44대화·72응답**으로 구성했다. validation 다중턴은 **0→12대화**, 동료 관계는 **0→4대화**다. 현재 앱의 원문 관찰·reported 관계 기억 단계도 합성 12맥락에서 **24정답쌍**을 별도로 만들었다. 신규 정답은 다른 AI 검토자가 교정 후 확인했으며 사람·전문가 승인이나 독립 test가 아니다. v9 작성 당시 출력 **8,192**·유효 입력 **61,440** 계약만 적용하고 실제 토큰 길이는 미검증으로 남겼다. 해당 공백은 후속 v10의 동일 tokenizer 실측으로 해소했으며 v9 원본·manifest는 당시 상태로 보존한다. 기존 원상담의 토큰 집중도·총량·맥락·분할은 그대로이고 전체 앱 단계의 목적 정답·실제 주변인 검토는 남는다.

`supporter_task_composition`은 기존 주변인 v2 릴리스와 새로 저작·AI 검토한 독립 합성 사례를 함께 검사한다. 실제 원상담 각색을 synthetic으로 넣지 않는다. 대화·문장·span을 별도 과업으로 저장하고, 원상담 v8은 원문·분할이 고정된 보조 참조로 연결한다. 자동 혼합·상향 표집은 하지 않는다. 새 앱 후보는 현재 앱 두 단계의 실제 요청·응답 형식을 사용하며 전체 대화 prefix와는 다른 현재 답변 기반 계약임을 기록한다.

```sh
python -B -m counseling_pipeline.supporter_task_composition \
  --baseline outputs/private/composition_v2_20261016/supporter/release \
  --source outputs/private/composition_v8_volume_context_20261016/source \
  --additions outputs/private/composition_v9_supporter_task_20261016/authored/revision_2/new_episodes.jsonl \
  --reviews outputs/private/composition_v9_supporter_task_20261016/authored/revision_2/independent_ai_reviews.jsonl \
  --output outputs/private/composition_v9_supporter_task_20261016/supporter \
  --verify
```

위 명령은 `data/`에서 최종본을 검증한다. 새로 생성하려면 `--verify`를 빼고 존재하지 않는 Git 제외 경로를 지정한다. 앱 후보는 저장소 루트에서 `node data/scripts/supporter_app_stage.mjs verify --input data/outputs/private/composition_v9_supporter_task_20261016/app_authored/contexts.jsonl --output data/outputs/private/composition_v9_supporter_task_20261016/app_stages_r2`로 재검증한다. 과거 초안과 최종본을 덮어쓰지 않는다.

기본 Python 로딩은 AI 초안 opt-in 없이 차단된다. `token_batch`는 현재 행을 고정 template으로 새로 인코딩하고 정답 8,192·입력+예약 출력 69,632와 선택적인 실제 합산 4,096 조건을 검사한다. 기존 길이 장부·문자 수·가짜 승인 필드를 토큰화나 사람 검토의 대체 근거로 사용하지 않는다. [최종 구성 장부](outputs/private/composition_v9_supporter_task_20261016/composition-index.json).

## 입력·정답 집중도를 유지하는 입력 총량·절차성 문맥 개선 v8

`source_volume_context_composition`은 v7의 선택 셀·정답 길이·후기 ID를 고정한다. 같은 원래 상담·구간·split의 동일 정답 길이인 적격 전기 원행만 비교한다. 입력 집중도 상한은 v7, 입력·절차성 플래그 수 상한은 split별로 짧은 후보 v5·긴 후보 v6이며, v6에서 없던 셀의 신규 절차성 플래그를 금지한다. v6 대표에서 시작하는 정확한 분수의 결정적 탐색으로 최종 조건을 모두 충족한 첫 구성을 내보낸다. 중간의 지표 단조 감소나 v7의 ±0.2% 입력 조건은 v8 조건이 아니다. 전역 최소 교체 수·의미적 동등성은 보증하지 않는다.

출력 **8,192**·합산 **69,632**·유효 입력 **61,440**에서 짧은 후보 **1,052행·1,036상담·후기 50셀**, 긴 후보 **2,376행·1,038상담·후기 1,293셀**을 유지했다. 동일 정답 길이의 전기 원행 **5·4개** 교체로 입력 집중도 **18지표 모두 v7보다 개선**됐고, 입력은 **2,094,059→2,089,385 / 14,190,420→14,183,561토큰**, 절차성 플래그는 **389→387 / 1,199→1,198**로 줄었다. 정답 총량 **75,231·213,050토큰**, 정답 집중도·셀별 길이·그룹별 합·행 집중도는 그대로다. 짧은 split은 v5 입력·플래그 상한, 긴 split은 v6 상한을 충족하고 v6 대비 신규 플래그 셀은 0이다. 긴 validation 입력은 v5보다 **1,456토큰 많고**, 짧은 후보에는 v5 대비 신규 플래그 셀 **1개**가 남는다. 원문·새 정답까지의 전체 맥락·보류·split·후기 ID와 후기 패널 105행의 압축 바이트는 보존했다. 전기 정답의 의미적 동등성·사람 검토·목적 적합성·독립 test는 미검증이며, 짧은 validation 후기 2셀·마지막 ¼ 0행의 부족은 남는다.

현재 선택은 **`selection_v8`**이다. `profiles`, `chosen`, `selection_v5`, `selection_v6`, `selection_v7`는 이력으로 보존한다. 원행 JSONL 바이트·새 정답까지의 전체 접두부·정수 정답 전용 손실 마스크를 유지하며 새 문장을 합성하지 않는다. 두 후보와 패널은 겹치고 사람 검토·학습 승인·독립 test로 승격하지 않는다.

```sh
"$COUNSELING_PYTHON" -B -m counseling_pipeline.source_volume_context_composition \
  --release 데이터셋/말씨_원본상담_SFT_v1_20261009 \
  --frozen 데이터셋/학습용_3종_v1_20261009 \
  --admission-policy outputs/private/malssi_partial_exposure_20261015/admission/admission_policy.json \
  --admission-rows outputs/private/malssi_partial_exposure_20261015/admission/admission_rows.jsonl.gz \
  --selection-audit outputs/private/malssi_round4_20261009/selection_audit.json \
  --tokenizer-audit outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/audit.json \
  --row-lengths outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/row_lengths.jsonl.gz \
  --previous-candidate outputs/private/malssi_partial_exposure_20261015/candidate_4096/source_rows \
  --events outputs/private/finals_source_review_20261016/evaluation_history_events.jsonl \
  --runtime-budget-evidence ../ai/trained_model_api/inference_optimization_verification.json \
  --output outputs/private/composition_v8_volume_context_20261016/source \
  --output-budget 8192 \
  --baseline outputs/private/composition_v3_output8192_20261016/source \
  --balanced-baseline outputs/private/composition_v4_balanced_20261016/source \
  --stratified-baseline outputs/private/composition_v5_stratified_20261016/source \
  --token-balanced-baseline outputs/private/composition_v6_token_balanced_20261016/source \
  --prefix-balanced-baseline outputs/private/composition_v7_prefix_balanced_20261016/source --verify
```

명령은 `data/`에서 실행한다. 새로 만들 때만 `--verify`를 빼고 아직 없는 Git 제외 경로를 지정한다. 기존 출력·심볼릭 링크는 덮어쓰지 않는다. 원천과 v3–v7을 재검증해 해시로 연결하고 설정·전체 장부·선택·원행·요약·이력을 다시 계산한다. 검증을 마친 임시 출력을 새 경로에 한 번에 게시한다. 토큰은 기존 근거를 재사용하며 새 토크나이저·모델·서버 실행은 하지 않는다. [대안 비교·적대적 재검증](../docs/competition/학습데이터_입력총량과_절차문맥_개선_재검증_v8.md) · [실제 생성 명령](../runtime/data-composition-volume-context-20261016/build-command.json).

## 정답 노출량을 유지하는 입력 접두부 집중도 개선 v7 — 보존본

`source_prefix_balanced_composition`은 v6의 상담×구간 셀과 후기 ID를 고정하고, 같은 원래 상담·구간·split의 **정답 길이가 같은 적격 전기 원행**만 교체한다. 각 split 입력 총량 변화는 v6 대비 ±0.2% 이내이며, 매 단계 입력 9지표가 직전보다 커지지 않고 최종 `min(v5,v6)` 이하가 된 첫 지점에서 멈춘다. 정확한 분수와 고정 seed로 재현한다. 전역 최소 교체 수·의미적 동등성은 보증하지 않는다.

출력 **8,192**·합산 **69,632**·유효 입력 **61,440** 조건에서 짧은 후보 **1,052행·1,036상담·후기 50셀**, 긴 후보 **2,376행·1,038상담·후기 1,293셀**을 유지했다. 정답 길이가 같은 전기 원행 **1·2개** 교체로 입력 접두부 18지표가 모두 **min(v5,v6) 이하**이며, v6 대비 **15개 개선·3개 동일**이다. v6의 정답 집중도 18지표와 split·그룹별 정답 합·길이 분포·행 집중도는 정확히 유지된다. 정답 총량은 **75,231·213,050토큰**이다. 입력 총량은 split별 최대 **0.126578%** 증가하며 상위 그룹의 절대 입력량은 그대로여서 비중 감소에는 분모 증가가 작용한다. 원문·새 정답까지의 전체 맥락·보류·원래 split·후기 대표는 보존하지만 전기 정답 시점·내용의 의미적 동등성은 미검증이다. 후기 validation 패널 **105행(짧은 2·긴 103)**은 v6와 압축 바이트까지 같고, 짧은 validation 후기 **2셀·마지막 ¼ 0행**, 사람 검토·목적 적합성·독립 test의 한계는 남는다.

v7 선택은 **`selection_v7`**에서 읽는다. 과거 `profiles`, `chosen`, `selection_v5`, `selection_v6`는 이력으로 보존한다. 원문 JSONL 바이트·새 정답까지의 전체 접두부·정수 정답 전용 손실 마스크를 유지하며 새 행이나 문장을 합성하지 않는다. 두 프로파일과 후기 패널은 겹친다. 사람 검토·학습 승인·독립 test로 자동 승격하지 않는다.

```sh
"$COUNSELING_PYTHON" -B -m counseling_pipeline.source_prefix_balanced_composition \
  --release 데이터셋/말씨_원본상담_SFT_v1_20261009 \
  --frozen 데이터셋/학습용_3종_v1_20261009 \
  --admission-policy outputs/private/malssi_partial_exposure_20261015/admission/admission_policy.json \
  --admission-rows outputs/private/malssi_partial_exposure_20261015/admission/admission_rows.jsonl.gz \
  --selection-audit outputs/private/malssi_round4_20261009/selection_audit.json \
  --tokenizer-audit outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/audit.json \
  --row-lengths outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/row_lengths.jsonl.gz \
  --previous-candidate outputs/private/malssi_partial_exposure_20261015/candidate_4096/source_rows \
  --events outputs/private/finals_source_review_20261016/evaluation_history_events.jsonl \
  --runtime-budget-evidence ../ai/trained_model_api/inference_optimization_verification.json \
  --output outputs/private/composition_v7_prefix_balanced_20261016/source \
  --output-budget 8192 \
  --baseline outputs/private/composition_v3_output8192_20261016/source \
  --balanced-baseline outputs/private/composition_v4_balanced_20261016/source \
  --stratified-baseline outputs/private/composition_v5_stratified_20261016/source \
  --token-balanced-baseline outputs/private/composition_v6_token_balanced_20261016/source --verify
```

명령은 `data/`에서 실행한다. 새로 생성할 때만 `--verify`를 빼고 아직 없는 Git 제외 경로를 지정한다. 기존 출력·심볼릭 링크를 덮어쓰지 않는다. 원천과 v3·v4·v5·v6를 재검증해 해시로 연결하고 v7의 장부·선택·원행·설정·요약·이력을 재계산한다. 토큰 길이는 기존 근거를 사용하며 모델·토크나이저·현재 서버를 새로 실행하거나 변경하지 않는다. [대안 비교·적대적 재검증](../docs/competition/학습데이터_입력접두부_집중도개선_재검증_v7.md)과 [실제 생성 명령](../runtime/data-composition-prefix-balance-20261016/build-command.json)에 근거를 연결한다.

## 정답 토큰 총량과 후기 대표를 유지하는 집중도 개선 v6 — 보존본

`source_token_balanced_composition`은 검증된 v5의 선택 셀을 고정하고, 같은 상담×구간의 적격 전기 원행만 짝지어 교체한다. 같은 split의 큰 그룹에서 줄인 정답 토큰량을 작은 그룹에 정확히 더하므로 split별 정답 총량·행 수·그룹별 구간 수·상담·모든 후기 ID가 그대로다. 매번 현재 그룹 합으로 `0 < 2d <= 큰 그룹 합 - 작은 그룹 합`을 확인하며 9개 정답 토큰 지표가 v5와 이전 기준 모두 이하가 된 첫 지점에서 멈춘다. 정확한 분수와 고정 순서로 재현하며 전역 최소 교체 수를 주장하지 않는다.

출력 8,192·합산 69,632·유효 입력 61,440 조건에서 `strict_4096/`는 1,052행(train 955·validation 97), `runtime_capped/`는 2,376행(train 2,138·validation 238)을 유지한다. 각각 전기 10개·6개를 교체했고, 전체 정답 토큰의 상위 5그룹 비중은 8.7251%→7.7654%, 8.6656%→8.4384%다. 정답 총량 75,231·213,050과 행 집중도는 그대로다. 과거 `profiles`, `chosen`, `selection_v5` 결정은 유지하고 **v6 선택은 `selection_v6`**에서 읽는다. 원문 JSONL 바이트·새 정답까지의 전체 원래 접두부·정답 전용 손실 마스크·기존 보류·원래 split을 보존한다. 전기 정답 시점·내용·접두부 길이와 일부 입력 토큰 집중도는 달라지며 의미적 동등성을 보증하지 않는다.

`validation_late_stratified.jsonl.gz`는 v5와 압축 바이트까지 같은 105행(짧은 2·긴 103)이다. 짧은 validation 후기 2셀·마지막 ¼ 0행, 개발 노출·사람 미검토·학습 미승인 상태는 그대로다. 전기 validation 대표는 각 후보에서 2개 교체됐지만 원래 validation 밖으로 이동하지 않았다. 모델·토크나이저·서버 설정 변경은 수행하지 않는다.

```sh
"$COUNSELING_PYTHON" -B -m counseling_pipeline.source_token_balanced_composition \
  --release 데이터셋/말씨_원본상담_SFT_v1_20261009 \
  --frozen 데이터셋/학습용_3종_v1_20261009 \
  --admission-policy outputs/private/malssi_partial_exposure_20261015/admission/admission_policy.json \
  --admission-rows outputs/private/malssi_partial_exposure_20261015/admission/admission_rows.jsonl.gz \
  --selection-audit outputs/private/malssi_round4_20261009/selection_audit.json \
  --tokenizer-audit outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/audit.json \
  --row-lengths outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/row_lengths.jsonl.gz \
  --previous-candidate outputs/private/malssi_partial_exposure_20261015/candidate_4096/source_rows \
  --events outputs/private/finals_source_review_20261016/evaluation_history_events.jsonl \
  --runtime-budget-evidence ../ai/trained_model_api/inference_optimization_verification.json \
  --baseline outputs/private/composition_v3_output8192_20261016/source \
  --balanced-baseline outputs/private/composition_v4_balanced_20261016/source \
  --stratified-baseline outputs/private/composition_v5_stratified_20261016/source \
  --output-budget 8192 \
  --output outputs/private/composition_v6_token_balanced_20261016/source --verify
```

명령은 `data/`에서 실행한다. 새로 생성할 때만 `--verify`를 빼고 아직 없는 Git 제외 출력 경로를 지정한다. 기존 출력·심볼릭 링크는 덮어쓰지 않는다. v3·v4·v5를 재검증해 해시로 연결하며, v6의 선택·원행·설정·요약·이력을 다시 계산해 검증한다. 실제 실행 명령과 집계·공격 결과는 [v6 보고서](../docs/competition/학습데이터_정답토큰_집중도개선_재검증_v6.md)에 있다.

## 상담·후기 대표를 유지하는 집중도 완화 v5 — 보존본

`source_stratified_composition`은 v3·v4를 재검증한 뒤 전기 대표 일부만 새 후보에서 제외한다. 원문 JSONL 바이트·전체 접두부·정답 전용 손실 마스크·보류·원래 split과 모든 기존 상담·후기 대표·그룹×구간을 유지한다. 출력 예약은 8,192, 합산은 69,632, 유효 입력은 61,440이다. 모델·토크나이저 실행이나 실제 서버 설정 변경은 아니다.

`strict_4096/`는 1,052행(train 955·validation 97), `runtime_capped/`는 2,376행(train 2,138·validation 238)이다. 각 디렉터리의 `train.jsonl.gz`와 `validation.jsonl.gz`가 해당 후보이며 두 후보는 서로 겹친다. 짧은 후보는 전기 95.25%·후기 50셀, 긴 후보는 전기 45.58%·후기 1,293셀이다. 관측 그룹 최대는 각각 10·19행이다. 긴 후보의 기본 상한 16에 대해 필수 후기·그룹 구간을 보존하는 6그룹만 17–19행 예외를 갖는다. 행 기준 상위 5·10그룹 점유율과 HHI는 train·validation·전체에서 모두 이전 기준보다 커지지 않아야 하며, 정답 토큰 기준 집중도는 별도 통계다.

`validation_late_stratified.jsonl.gz`는 짧은 후기 대표 2행과 긴 후기 대표 103행이다. 같은 셀에서는 짧은 대표를 우선해 중복 셀을 제거하므로 긴 후보와 정확히 같은 ID의 부분집합은 아니다. 새 상담·독립 test로 합산하지 않는다. 짧은 validation의 마지막 ¼은 여전히 0행이다. 기존 ledger의 `profiles`와 `chosen`은 v3·v4의 결정이고, 현재 선택은 `selection_v5`에서 읽는다.

```sh
"$COUNSELING_PYTHON" -B -m counseling_pipeline.source_stratified_composition \
  --release 데이터셋/말씨_원본상담_SFT_v1_20261009 \
  --frozen 데이터셋/학습용_3종_v1_20261009 \
  --admission-policy outputs/private/malssi_partial_exposure_20261015/admission/admission_policy.json \
  --admission-rows outputs/private/malssi_partial_exposure_20261015/admission/admission_rows.jsonl.gz \
  --selection-audit outputs/private/malssi_round4_20261009/selection_audit.json \
  --tokenizer-audit outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/audit.json \
  --row-lengths outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/row_lengths.jsonl.gz \
  --previous-candidate outputs/private/malssi_partial_exposure_20261015/candidate_4096/source_rows \
  --events outputs/private/finals_source_review_20261016/evaluation_history_events.jsonl \
  --runtime-budget-evidence ../ai/trained_model_api/inference_optimization_verification.json \
  --baseline outputs/private/composition_v3_output8192_20261016/source \
  --balanced-baseline outputs/private/composition_v4_balanced_20261016/source \
  --output-budget 8192 \
  --output outputs/private/composition_v5_stratified_20261016/source --verify
```

새로 생성할 때만 `--verify`를 빼고 아직 없는 Git 제외 출력 경로를 지정한다. 이미 있는 출력이나 심볼릭 링크는 덮어쓰지 않는다. 선택과 산출물 검증의 성공은 사람 검토·학습 승인이나 의미적 완전성 판정이 아니다.

## 원문을 추가하는 후기 보강 v4

`source_balanced_composition`은 출력 8,192 조건의 기존 v3 주 후보를 재검증한 뒤 모든 행을 유지하고, 아직 선택되지 않은 후기 상담×구간에서 한 행씩 추가한다. 대표는 고정 seed·ID 해시로 선택하며 원문·전체 접두부·기존 보류·split을 유지한다. 기존 v3 코드·설정·산출물은 수정하지 않는다.

주 후보는 `train.jsonl.gz`와 `validation.jsonl.gz`다. `validation_late_audit.jsonl.gz`는 같은 validation의 후기만 모은 부분집합으로, 독립 test나 추가 사례 수로 합산하지 않는다. v3의 전체 4,096 이하 후보는 해시로 연결한 별도 보존본이다. 새 보강본의 긴 문맥을 자르거나 4,096 이하로 표시하지 않는다.

```sh
"$COUNSELING_PYTHON" -B -m counseling_pipeline.source_balanced_composition \
  --release 데이터셋/말씨_원본상담_SFT_v1_20261009 \
  --frozen 데이터셋/학습용_3종_v1_20261009 \
  --admission-policy outputs/private/malssi_partial_exposure_20261015/admission/admission_policy.json \
  --admission-rows outputs/private/malssi_partial_exposure_20261015/admission/admission_rows.jsonl.gz \
  --selection-audit outputs/private/malssi_round4_20261009/selection_audit.json \
  --tokenizer-audit outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/audit.json \
  --row-lengths outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/row_lengths.jsonl.gz \
  --previous-candidate outputs/private/malssi_partial_exposure_20261015/candidate_4096/source_rows \
  --events outputs/private/finals_source_review_20261016/evaluation_history_events.jsonl \
  --runtime-budget-evidence ../ai/trained_model_api/inference_optimization_verification.json \
  --baseline outputs/private/composition_v3_output8192_20261016/source \
  --output-budget 8192 \
  --output outputs/private/composition_v4_balanced_20261016/source --verify
```

새로 생성할 때는 `--verify`를 빼고 아직 없는 출력 경로를 지정한다. 입력·정답·합산 예약은 각각 검사하며 유효 입력 상한은 61,440이다. 기존 그룹당 16행 상한은 v3 핵심 후보에 적용된 값이고, v4 최종본은 해당 그룹의 빠진 후기 셀 수만큼 늘어날 수 있다. 최종 집중도와 행 수·정답 토큰량을 구분해 집계한다. 학습·사람 검토 승인 상태를 바꾸지 않는다.

## 입출력 예산과 4,096 이하 후반부 구성 v3

`source_budget_composition`은 두 RTX 4090 환경의 저장된 실행 근거 `/live/health`를 해시로 연결한다. 당시 입력 65,536·출력 4,096·합산 69,632는 `recorded_runtime_budget`에 보존하고, 사용자 요청으로 출력을 두 배 늘린 **8,192 평가 조건**은 `evaluation_budget`으로 구분한다. 합산 69,632를 유지하므로 이 조건의 유효 입력 상한은 **61,440**이다. 과거 로컬 기본 config의 128K 값이나 학습 kit의 `max_length`와 혼동하지 않는다. 현재 서버 설정을 변경하거나 라이브 운영 상태를 확인하는 명령은 아니다.

`runtime_budget`은 입력·정답 한도와 `prefix_length + 8192 <= 69632`를 검사한다. `strict_4096`은 추가로 `prefix_length + target_length <= 4096`인 풀을 **선택 전에** 만든다. 큰 후보의 선택 결과를 사후 필터링하지 않는다. 두 풀에서 각각 구간을 확보하고 그룹당 최대 16행·상담×구간당 최대 1행을 선택한다. 작은 후보는 후반부의 모든 적격 상담×구간 셀을 우선 보존한다. 필수 셀과 구간 보장이 그룹 상한을 초과하면 누락시키지 않고 실패한다. 전체 4,096인 학습 행과 최대 8,192 출력 예약은 별개의 조건이다.

```sh
"$COUNSELING_PYTHON" -B -m counseling_pipeline.source_budget_composition \
  --release 데이터셋/말씨_원본상담_SFT_v1_20261009 \
  --frozen 데이터셋/학습용_3종_v1_20261009 \
  --admission-policy outputs/private/malssi_partial_exposure_20261015/admission/admission_policy.json \
  --admission-rows outputs/private/malssi_partial_exposure_20261015/admission/admission_rows.jsonl.gz \
  --selection-audit outputs/private/malssi_round4_20261009/selection_audit.json \
  --tokenizer-audit outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/audit.json \
  --row-lengths outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/row_lengths.jsonl.gz \
  --previous-candidate outputs/private/malssi_partial_exposure_20261015/candidate_4096/source_rows \
  --events outputs/private/finals_source_review_20261016/evaluation_history_events.jsonl \
  --runtime-budget-evidence ../ai/trained_model_api/inference_optimization_verification.json \
  --output-budget 8192 \
  --output outputs/private/composition_v3_output8192_20261016/source --verify
```

새로 생성하려면 `--verify`를 빼고 존재하지 않는 새 출력 경로를 지정한다. 같은 시각으로 재현하려면 생성 시에만 `--occurred-at`에 시간대가 있는 ISO 시각을 지정할 수 있다. 기존 경로는 덮어쓰지 않는다.

새 출력 경로로 생성할 때는 `--verify`를 뺀다. 출력 한도 기본값은 기록된 4,096이므로 이번 8,192 결과를 검증할 때도 `--output-budget 8192`를 명시한다. 각 프로파일의 `train.jsonl.gz`·`validation.jsonl.gz`는 원래 JSONL 바이트를 보존한다. 루트 장부 `selection_ledger.jsonl.gz`의 `profiles.<name>`에 선택·보류 이유가 있고, `summary.json`에 위치·입출력 길이·후기 셀 보존·프로파일 간 중첩 수가 있다. 두 후보는 같은 원천을 사용하므로 독립 사례 수로 합산하지 않는다. 원문 전체 접두부·원래 split·기존 내용/의료 문맥 보류·사람 미검토 상태를 유지하며, 모든 후보는 개발 노출·학습 미승인 상태다.

## 구성 v2의 재검증과 재생성

`source_composition`은 기존 원천·부분 노출 보류·사용 이력을 다시 검증하고, 전체 접두부를 보존한 32,768 이하 풀에서 출처 그룹당 최대 16행, 상담별 위치 1/4 구간당 최대 1행을 선택한다. 이 상한은 실험용 구성 규칙이며 모집단 대표성 기준이 아니다. 과거 assistant 문맥의 의학 관련 검토 표현은 추가 보류하고, 절차 관련 표현은 별도 검토 표시를 남긴다. 정규식이 임상적 위해를 판정한 것은 아니다. 모든 후보는 사람 미검토 상태를 유지한다.

```sh
"$COUNSELING_PYTHON" -B -m counseling_pipeline.source_composition \
  --release 데이터셋/말씨_원본상담_SFT_v1_20261009 \
  --frozen 데이터셋/학습용_3종_v1_20261009 \
  --admission-policy outputs/private/malssi_partial_exposure_20261015/admission/admission_policy.json \
  --admission-rows outputs/private/malssi_partial_exposure_20261015/admission/admission_rows.jsonl.gz \
  --selection-audit outputs/private/malssi_round4_20261009/selection_audit.json \
  --tokenizer-audit outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/audit.json \
  --row-lengths outputs/private/malssi_round3_20261009/remote/tokenizer_training_env/row_lengths.jsonl.gz \
  --previous-candidate outputs/private/malssi_partial_exposure_20261015/candidate_4096/source_rows \
  --events outputs/private/finals_source_review_20261016/evaluation_history_events.jsonl \
  --output outputs/private/composition_v2_20261016/source --verify
```

새로 생성하려면 `--verify`를 빼고 **아직 없는 새 출력 경로**를 지정한다. 기존 결과는 덮어쓰지 않는다. `train.jsonl.gz`·`validation.jsonl.gz`는 원본 JSONL 바이트를 보존한 전체 길이 후보이고, `*.compatible_4096.jsonl.gz`는 그중 기존 4,096 조건도 만족한 부분집합이다. 두 구성의 분포는 다르다. 길이 장부를 사용한 선별이며 모델 실행·토크나이저 재실행·학습 승인은 하지 않는다. `selection_ledger.jsonl.gz`에는 전체 원본 행의 선택·보류 사유, 위치·출처·문맥 검토 표시를 남긴다.

주변인 합성 실험은 `agent_dataset`의 기존 `experimental_ai_draft` 경로를 사용한다. 실제 별도 AI 검토와 내용 해시를 요구하고, 로딩에는 `allow_ai_draft=True`가 필요하다. 동일 대화·접두부의 공백·NFKC 유니코드 차이는 중복 검사에서 무시하며, 실제 문장과 문자 위치는 변경하지 않는다. 단어·구절의 주체를 확인할 수 없을 때는 `subject:unknown`을 사용해 `user`·`subject`·`other`와 구분한다. `ASK_CFI`·`SAFETY_SUPPORT` 및 사람 승인용 사례는 기존 `agent_training`의 출처·사람·전문가 승인 조건을 그대로 따른다.

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
