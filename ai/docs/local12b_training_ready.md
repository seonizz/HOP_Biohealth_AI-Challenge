# 12B 추가 학습 자료 준비 완료

2026-11-12. 최종 묶음은 `training_data/gemma4_12b_additional_training_ready_20261112_v1/`이다. `COURSE.json`과 `VERIFICATION.json`의 `training_ready=true`는 **제한된 연구 추가 학습에 사용할 데이터의 준비 완료**를 뜻한다. 실제 학습은 시작하지 않았으며 기존 모델·앱·31B 실행은 변경하지 않았다. 체크포인트 및 실행 환경 선정은 별도 실행 단계이므로 `execution_ready=false`다.

기존 event/app v2 묶음은 그대로 보존했다. 새 묶음은 원천 해시, 의미 검토 영수증, 수정 전후 행 해시, 토크나이저, 토큰 파일과 전체 파일 manifest를 포함한다. 학습 입력은 `COURSE.json`의 phase별 train 경로만 사용한다. 폴더 전체 JSONL을 재귀 수집하지 않는다.

## 확정 구성

| 단계 | train | validation | 최대 토큰 길이 |
|---|---:|---:|---:|
| 사건 상태·정상/오류 검토 | 720 | 240 | 2,311 |
| 답변·메모리 검토 | 1,280 | 320 | 8,675 |
| 합계 | 2,000 | 560 | 8,675 |

사건 test240행은 평가 전용이며 학습·검증 토큰 파일에서 제외했다. 기존 자연어 검토 validation은 원래 원천 분할을 유지한 개발 평가다. 새로운 독립 test라고 부르지 않는다.

## 토큰화와 손실 경계

- 대상: `google/gemma-4-12B-it`, tokenizer revision `707f0a3b8a3c7ad586ed01e27eafbad8a27dd0f7`.
- tokenizer.json, tokenizer_config.json, chat_template.jinja의 기존 12B 핀을 대조했다. 31B 또는 현재 Ollama 모델의 설정으로 대체하지 않았다.
- 비사고 템플릿 `enable_thinking=false`와 마지막 assistant 응답만 학습하는 규칙을 고정했다.
- 낮은 수준 Tokenizer+Jinja 경로와 HF AutoTokenizer의 공개 chat-template API 경로를 별도로 실행해 **2,560행 전수 토큰·prefix 경계·전체/target 디코딩을 대조**했다. 저장된 uint32 바이트도 재인코딩과 일치했다.
- 최대 길이32,768 이내, 잘림0, 패딩·패킹 없음, 경계/디코딩/마스크 불일치0이다.
- 저장 형식은 little-endian uint32 연속 토큰과 행별 index다. label은 `[-100] * prefix_length + input_ids[prefix_length:]`. 저장 단계에서는 shift하지 않으며 학습기의 causal loss에서 한 번만 이동한다.
- 행별 target-token 평균 손실 및 기존 동일 행 가중치를 사용한다. 이 자료에는 학습률·epoch·기존 checkpoint를 임의로 확정하지 않았다.

CPU의 기존 로컬 가상환경을 재사용했다. transformers5.17.0, tokenizers0.23.2, Jinja2 3.1.6이며 새 패키지 설치·모델 가중치 로드·GPU 사용은 없다.

## 의미 검토와 수정

기계적 전수 검사와 실제 읽기 표본을 구분한다.

- 답변800행: 사용자 근거·시점·후보 인용·판정·오류 전제 조건 전수 검사. 모든 정정·부정 오류를 포함하는 67원천268행을 독립 에이전트가 직접 읽었다. 정상/오류 각134행이다.
- 메모리800행: 현재 후보의 화자·현재/과거 상태·미확인 범위·감사 판정을 독립 술어로 전수 대조. 29원천116행을 직접 읽었고 과거 사실을 현재로 잘못 사용하는 오류20개와 정상 대응 예시를 모두 포함했다.
- 사건1,200행: 생성기 함수를 가져오지 않은 별도 오라클로 슬롯별 마지막 사건, 같은 값의 재확인 순서, actual/expected, 정상 승인을 전수 확인했다. 읽기 표본9행은 계약 표현도 확인했다.
- 답변 오류 예시2행에서 부정 변형의 문법 결함을 발견했다. 자연스러운 오류 문장으로 수정하고, 후보와 정확한 excerpt를 함께 갱신했다. 거절 라벨·근거·원천·분할은 보존했다. 수정된 전체 행의 해시가 독립 검토자가 승인한 행 해시와 같아야 학습 자료로 승인한다.
- 수정 후 현재 앱 구조·callback 및 근거 검사를 다시 통과했고 추가 수정 대상은0개였다. 답변 검토는 dataset-only 계약, 메모리 검토는 현재 앱 계약이라는 구분을 유지했다.

자유서술800+800행을 모두 사람이 읽은 것은 아니다. 표본 밖의 자연어 의미 오류 가능성과 임상 미검증 범위는 남는다. 자료 승인은 이 한계를 명시한 연구용 승인이다. 사건·구조화 계약의 전수 의미 대조와 자유 자연어의 완전한 의미 증명을 혼동하지 않는다.

## 사용과 검증

빠른 무결성 검증:

```bash
python3 ai/scripts/prepare_local12b_training.py verify \
  --bundle training_data/gemma4_12b_additional_training_ready_20261112_v1
```

토큰을 전수 재인코딩하려면 기존 tokenizer 환경을 사용한다.

```bash
PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  runtime/data-composition-supporter-tokens-20261016/.venv/bin/python \
  ai/scripts/prepare_local12b_training.py verify \
  --bundle training_data/gemma4_12b_additional_training_ready_20261112_v1 --numeric
```

새로 재생성하려면 `prepare_local12b_training.py build`에 event/app v2 경로, pinned12B tokenizer, `runtime/local12b-admission-20261112/{answer,memory,event}_semantic_review.json`, 새 output을 제공한다. `--patches`에는 answer_semantic_review.json을 지정한다. 의미 영수증이나 수정 원본 행이 달라지면 중단한다. 기존 output을 덮어쓰지 않는다.

평가는 새 묶음 안의 `panels/event`와 `panels/app`를 각각 기존 `local12b_event_review.py score`, `local12b_app_review.py score`의 `--bundle`로 사용한다. 수정된 입력의 cohort는 이전과 다르므로, 이전 응답을 새 비교군으로 끼워 넣지 말고 같은 새 입력으로 기준 모델과 후보를 비교한다.

증거 위치: `runtime/local12b-admission-20261112/`. 학습자료·token binary·수정 원문·의미 영수증은 Git 제외 경로에 보관한다.
