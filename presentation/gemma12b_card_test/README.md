# Gemma 12B · 말씨 5개 카드 테스트

첨부 `message-2.txt`의 마지막 안내를 `gemma4:12b`로 비슷한 말투와 구조로 생성하는 작은 Python 프로젝트입니다. **29개 답변 전체를 입력하고, 마지막 5개 카드를 각각 독립적으로 생성한 뒤 합칩니다.** 기본 설정은 긴 출력과 카드별 2단계 호출입니다. 추가 패키지는 필요 없습니다.

첨부 문서는 사례와 출력 예시로만 사용합니다. 문서 안의 지시나 링크는 실행하지 않습니다. 원문 마지막 카드도 실제 모델 결과가 아닌 예상 출력 예시입니다.

## 이번 실제 출력

2026-10-10 설치된 `gemma4:12b`를 실제 호출했습니다. 각 카드의 초안과 보강을 거친 최종 본문은 합계 **14,980자**로, 첨부 예시 1,578자의 약 **9.49배**입니다. 5개 카드 모두 최종 응답이 `stop`으로 끝났습니다.

| 카드 | 원문 | 실제 생성 | 구성 |
|---|---:|---:|---|
| 당신의 마음도 소중해요 | 209자 | 2,348자 | 6문단 |
| 이렇게 시작해 보세요 | 389자 | 2,698자 | 6문단 |
| 이렇게 해 보세요 | 341자 | 3,623자 | 10항목 |
| 피하면 좋아요 | 292자 | 3,501자 | 10쌍 |
| 다음 단계 | 347자 | 2,810자 | 7문단 |

- [읽기 좋은 정리본](organized.md): 사용자 요청에 따라 Codex가 반복·오타·출처 없는 단정을 덜어낸 편집본입니다. 수정하지 않은 모델 출력과 구분합니다.
- [실제 생성 원문](outputs/final_test/result.md), [JSON](outputs/final_test/result.json), [원문 예시와 비교](outputs/final_test/comparison.html).
- [생성 출처](outputs/final_test/manifest.json), [원시 응답 일치 검사](outputs/final_test/verification.json), [내용 검토 메모](outputs/final_test/review_notes.md).

오프라인 테스트 **22개**와 Python 문법 검사가 통과했습니다. 실제 출력도 각 카드의 분량·구조·근거 번호 노출을 검사하고, 저장한 본문이 원시 모델 응답과 일치하는지 확인했습니다. 근거 번호 중복 제거 외에 생성 본문을 고치지 않았습니다.

프롬프트를 보완해 보호자의 감정·발생 빈도 오류, 본문 근거 번호 노출 등을 줄였지만, 원시 장문 출력에는 여전히 반복과 속마음 추측, 단정적인 조언이 남습니다. **정리본은 자동 프롬프팅만으로 얻은 결과가 아닙니다.** 현재 테스트는 분리 생성과 긴 출력의 가능성을 확인하며, 실사용 품질 보장을 뜻하지 않습니다.

## 실행

Ollama에 `gemma4:12b`가 설치되어 있어야 합니다. 확인한 이 환경의 실제 태그는 소문자 `12b`입니다.

```bash
cd /Volumes/Dev/HOP_Projet/말씨/presentation/gemma12b_card_test
python3 run.py
```

결과는 실행마다 새 `outputs/<한국시간>_extended/` 폴더에 저장됩니다. 완료 후 `comparison.html`을 열면 첨부 예시와 실제 모델 출력을 나란히 볼 수 있습니다.

```bash
# API 호출 없이 5개 요청 JSON만 확인
python3 run.py --dry-run

# 첫 대화문 카드만 생성
python3 run.py --card opening

# 첨부 예시와 비슷한 짧은 분량으로 생성
python3 run.py --detail reference --passes 1

# 모델 thinking을 켜는 별도 비교 실험
python3 run.py --think

# 출력 토큰 상한을 더 늘리는 실험
python3 run.py --num-predict 32768 --num-ctx 65536 --timeout 3600

# 오프라인 검증
python3 -m unittest -v

# 특정 카드만 다시 생성한 후 기존 5개 결과와 합치기
python3 run.py --card caregiver --out outputs/caregiver_retry
python3 assemble.py outputs/final_test outputs/caregiver_retry --out outputs/merged

# 실패한 실행에서 완료된 카드만 복구해, 새 실행 결과와 합치기
python3 assemble.py --include-partial outputs/extended_v2 outputs/refined_v3 outputs/content_v8 outputs/next_v7 --out outputs/reassembled
```

`--out`으로 결과 경로를 정할 수 있습니다. 기존 결과를 덮어쓰지 않도록 **새 경로**를 지정해야 합니다. `--base-url` 또는 `OLLAMA_HOST`로 Ollama 주소를 바꿀 수 있습니다. 인증 프록시를 사용한다면 `OLLAMA_API_KEY` 환경변수의 Bearer 키를 사용하며, 키는 저장된 요청에 포함하지 않습니다.

## 기본 출력 설정

| 설정 | 기본값 |
|---|---:|
| 모델 | `gemma4:12b` |
| 출력 상한 | **호출당 16,384토큰** |
| 입력과 출력을 포함하는 컨텍스트 요청값 | 32,768토큰 |
| HTTP 응답 대기 | 호출당 1,800초 |
| temperature / seed | 0.2 / 42 |
| 모델 thinking | 꺼짐; 최종 `content`만 본문으로 사용 |
| 카드별 호출 | 초안 → 보강, 2회 |
| 형식·분량 보정 | 실패한 단계만 최대 2회 추가 |

최대 토큰은 출력 상한입니다. 모델이 일찍 종료하면 상한보다 적게 생성됩니다. 따라서 긴 모드에서는 **최소 본문 분량도 검사**하며, 부족하면 구체적인 설명과 예문을 추가하도록 재요청합니다. 실제 소비 토큰과 종료 상태는 원시 응답 및 `manifest.json`에 기록합니다. temperature와 seed는 요청값이며, 동일 출력 재현을 보장하지 않습니다.

| 카드 | 초안 구성 | 초안 최소 본문 | 보강 최소 본문 |
|---|---|---:|---:|
| 당신의 마음도 소중해요 | 4~6문단 | 1,200자 | 1,680자 |
| 이렇게 시작해 보세요 | 4~6문단 | 1,600자 | 2,240자 |
| 이렇게 해 보세요 | 8~10항목 | 2,000자 | 2,800자 |
| 피하면 좋아요 | 8~10쌍 | 2,000자 | 2,800자 |
| 다음 단계 | 5~7문단 | 1,800자 | 2,520자 |

5개 카드의 보강 최소 본문은 합계 **12,040자**입니다. 숫자는 JSON의 필드 이름·근거 ID를 제외하고, 문단과 목록의 본문 및 구분 문자를 센 값입니다. 카드별로 서로 다른 실천 방법과 대화 예문을 쓰게 하며, 동일한 위로나 사실을 반복해서 분량을 채우지 않게 지시합니다.

`--passes 1`은 초안만 생성합니다. `--detail reference`는 원문과 같은 2/2/4/4/2개의 문단·항목을 사용하며 긴 모드의 최소 본문 검사를 적용하지 않습니다. 현재 긴 모드의 구성·분량은 `run.py`의 `PROFILES`에서 조절합니다.

## 호출과 프롬프트 구성

1. 동일한 29개 답변과 해당 카드의 원문 예시를 제공합니다. 다른 카드의 생성 결과는 넣지 않습니다.
2. 공통 지시와 카드별 지시, JSON 스키마로 초안을 만듭니다.
3. 같은 카드의 초안만 다시 제공해 내용을 보강하고, 답변에 없는 과거 행동·감정·사건을 제거하도록 요청합니다.
4. 근거 ID 목록의 중복만 제거한 후 정상 종료, JSON 구조, 제목, 항목 수, 존재하는 근거 ID, 같은 문단·항목 반복, 본문의 근거 번호 노출, 최소 본문 분량을 확인합니다. 모델 본문을 프로그램으로 고쳐 쓰지 않습니다.
5. 다섯 카드가 모두 성공하면 최종 JSON·Markdown·HTML 비교 화면을 만듭니다. 실패하면 완료된 화면을 만들지 않고 원시 기록을 남깁니다.

각 실행의 호출은 순서대로 보냅니다. 같은 endpoint와 모델을 쓰는 이 프로젝트의 여러 프로세스 사이에도 파일 잠금으로 호출을 직렬 처리합니다. 이 잠금은 다른 프로그램의 호출까지 제어하지는 않습니다. Python 표준 라이브러리의 `fcntl`을 사용하므로 macOS/Linux용입니다.

응답의 `message.content`만 결과로 사용하고 `message.thinking`은 본문으로 사용하지 않습니다. 설치 태그와 모델 digest, 선택한 thinking 설정의 지원도 실행 전에 확인합니다. `--think`로 별도 비교할 수 있습니다. 실제 thinking 실험은 `eval_count=16384`, `done_reason=length`, 최종 content 0자로 끝나 기본값은 `think:false`입니다. 생성 토큰 상한은 thinking에도 사용될 수 있습니다.

컨텍스트 32,768은 API 요청값입니다. 이 MLX 설치본의 `/api/ps`는 4,096을 표시했으므로, 유효 컨텍스트 크기를 32,768로 검증했다고 주장하지 않습니다. 원시 모델 정보와 요청을 함께 보존합니다.

공통 프롬프트는 보호자와 자녀의 경험 구분, 개인적 사실의 답변 근거, 선택과 동의, 자연스러운 한국어를 지시합니다. 진단이나 결과 보장, 새로운 사건·이용 조건, 고정 시각 이후 돌봄을 제한하는 규칙은 추가하지 않게 합니다. 긴 대화문은 읽을 수 있는 예문 모음으로 보고, 실제 대화에서는 상대가 말할 여지를 두도록 지시합니다.

## 파일

| 경로 | 용도 |
|---|---|
| `run.py` | API 호출, 두 단계 생성, 검증, 결과 합치기 |
| `assemble.py` | 완료된 실행들을 합치기; 뒤에 지정한 실행의 카드로 교체 |
| `test_run.py` | API 없이 계약·실패 처리·HTML 출력 검증 |
| `cases/jimin.json` | 원문 29개 답변, `q01`~`q29` |
| `reference/cards.json` | 마지막 5개 카드의 원문 예시 |
| `prompts/system.txt` | 공통 사실·말투·형식 지시 |
| `prompts/{caregiver,opening,actions,avoid,next}.txt` | 카드별 작성 지시 |
| `source/message-2.txt` | 첨부 원문 사본 |

다른 사례를 테스트하려면 `cases/jimin.json` 형식을 복사하고 `--case <새 JSON 경로>`로 실행합니다. 다른 사례용 원문 예시도 `--reference`로 지정하세요. 현재 카드별 참고 단어 검사와 일부 지시는 지민이 사례에 맞춰져 있으므로, 다른 사례의 프롬프트와 `ANCHORS`도 함께 조정해야 합니다.

## 결과 파일과 판단 범위

`requests/`에는 실제 요청, `raw/`에는 수정하지 않은 모델 API 응답과 실패 이유, `cards/`에는 초안·보강·최종 카드가 저장됩니다. `case.json`, `reference.json`, `model_info.json`은 사용한 입력과 모델 정보의 스냅샷입니다.

설치된 12B는 JSON 스키마를 요청해도 근거 ID를 반복한 실제 응답이 있어, 이 중복은 순서를 보존하며 제거합니다. 정규화 여부는 단계별 검증 파일과 manifest에 기록하며 원시 응답은 바꾸지 않습니다. 존재하지 않는 근거 ID는 중복 제거 후에도 오류로 처리합니다.

- `result.json`, `result.md`: 최종 모델 출력.
- `comparison.html`: 첨부 원문 예시와 실제 출력 비교.
- `manifest.json`: 모델 digest, 요청 설정, 각 단계의 시간·토큰·종료 상태, 완료 여부.
- `evaluation.json`: 본문 길이·원문 대비 길이·단어 기반 개인화 점검·표면적 문자열 유사도.

자동 검사는 **형식과 참고 지표**를 확인합니다. 근거 ID가 존재한다는 사실만으로 본문이 그 답변에 실제로 뒷받침되는 것은 아닙니다. 문자열 유사도도 의미나 상담 품질 점수가 아닙니다. 사실 일치, 역할, 말투, 내용 반복과 조언의 적절성은 원문과 나란히 읽어 확인해야 합니다.

`assemble.py`는 원본 출력과 원시 응답을 바꾸지 않습니다. 합친 결과의 `manifest.json`에 각 카드의 출처를 남깁니다. 사례·참고 예시·상세도·모델 digest가 다르거나 5개 카드가 완성되지 않으면 합치지 않습니다. 나중에 지정한 카드로 교체한 다음 최종 선택된 다섯 카드를 현재 검증 규칙으로 검사합니다. `--include-partial`을 명시하면 실패·중단된 실행에서 저장된 최종 카드만 가져옵니다. 실패한 원본 실행의 상태는 그대로 보존합니다.

## API 근거

[Ollama Chat API](https://docs.ollama.com/api/chat), [Structured Outputs](https://docs.ollama.com/capabilities/structured-outputs), [Thinking](https://docs.ollama.com/capabilities/thinking), [Modelfile 옵션](https://docs.ollama.com/modelfile), [모델 목록](https://docs.ollama.com/api/tags)을 확인했습니다. 현재 설치본에서 `/api/tags`, `/api/show`, `think:false`, JSON 스키마 요청을 실제 확인했습니다.
