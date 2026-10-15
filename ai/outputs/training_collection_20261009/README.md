# 말씨 학습 데이터 수집 키트

학습 실행자에게 **[전달문](학습담당자_전달문.md)**과 **[전체 수집 지침](학습_데이터수집_지침.md)**을 함께 전달한다. 이번 학습의 실제 값을 기록하고 완료 후 결과 폴더를 돌려받기 위한 키트다.

## 바로 시작하기

키트 폴더에서 Python 3로 실행한다. 외부 패키지 설치가 필요하지 않다.

```sh
python3 collection_tools.py init --run-id malssi_sft_001 --output ./runs/malssi_sft_001
python3 collection_tools.py check --run ./runs/malssi_sft_001 --phase before --report ./runs/malssi_sft_001/check_before.json
```

초기화 직후에는 `null` 설정과 빈 로그가 있으므로 검사 실패가 정상이다. 실제 정보를 채워야 한다. 도구가 모델을 실행하거나 값을 추정해서 채우지는 않는다. 이미 존재하는 run 폴더에는 초기화를 거절한다.

`before`는 기본 설정·계획, `after_train`은 학습/검증/이벤트 기록과 저장·재개 근거 참조, `after_eval`은 생성·검토 기록을 추가로 확인한다.

```sh
python3 collection_tools.py check --run ./runs/malssi_sft_001 --phase after_train --report ./runs/malssi_sft_001/check_after_train.json
python3 collection_tools.py check --run ./runs/malssi_sft_001 --phase after_eval --report ./runs/malssi_sft_001/check_after_eval.json
```

종료 코드 0은 **최소 구조 검사 통과**, 2는 누락·형식 오류다. 손실 기준·학습 성공·응답 품질·전체 수집 완료를 보증하지 않는다. 경고도 함께 읽는다. 실제 미실행·중단·실패는 숫자를 꾸며서 검사에 맞추지 말고 원인과 원래 로그를 보존한다.

## 파일 구성

- `학습_데이터수집_지침.md`: 수집 시점, 필드 의미, 계산식, 비교 조건, 전달 목록.
- `학습담당자_전달문.md`: 학습 담당 에이전트에 붙여 넣을 작업 지침.
- `templates/record_templates.json`: 네 설정 파일·다섯 JSONL record의 빈 양식, 최소 필수 필드와 허용 상태.
- `templates/*.template.json`: 네 설정 파일을 직접 편집하려는 경우의 개별 양식.
- `collection_tools.py`: 결과 폴더 초기화·최소 구조 검사 도구.
- `KIT_VERIFICATION.json`: 키트 자체의 검사 기록. 모델 학습 결과가 아니다.

## 돌아올 결과

run 폴더의 네 JSON 설정과 다섯 JSONL 로그, `artifacts/`의 설정·환경·검증·checkpoint 지문을 전달한다. `private/`의 원문·응답·원시 token IDs와 실제 모델 가중치는 별도로 보관한다. 재검토할 응답 사례는 비식별 입력·응답·검토 이유를 추가로 전달할 수 있다.

재개 segment를 포함한 전체 로그를 유지한다. 여러 모델/설정의 실험은 run별 폴더를 나누고, 동일 case ID와 동결 평가 계획으로 비교한다.
