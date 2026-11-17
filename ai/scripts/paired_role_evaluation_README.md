# 학습 전후 역할 평가 기록

`run_paired_role_evaluation.py`는 동결된 **development** 입력을 같은 로컬 llama 서버에 보내고 요청마다 LoRA scale 0(기반)과 1(첨부 어댑터)을 교대로 지정한다. 최종 test 입력을 실행하거나 학습하지 않는다. 서버 실행·종료와 기반 가중치 확보는 별도이다.

```sh
python3 ai/scripts/run_paired_role_evaluation.py \
  --suite-root training_data/role_evaluation_20261031/chat_12b/development \
  --output runtime/새로운_평가_실행 \
  --endpoint http://127.0.0.1:11438 \
  --base-model /절대경로/검증한_기반.gguf \
  --adapter /절대경로/검증한_어댑터.gguf
node ai/scripts/summarize_paired_role_evaluation.mjs runtime/새로운_평가_실행
```

파일럿은 `--limit-groups 1`로 고정한다. 상한을 생략하면 기존 개발 자료 전체를 배정한다. 실행 폴더는 새로 생성해야 하며 기존 결과를 덮어쓰거나 실패를 자동 재시도하지 않는다. 사람 판정과 별도로 최초 형식 실패를 보존한다.

입력 `messages`만 추론에 사용한다. 정답은 suite 무결성 검사에만 읽으며 요청에 첨부하지 않는다. 출력 스키마는 고정 입력 안에 포함되며, 이 실행기는 `response_format`이나 문법 제약으로 생성을 강제하지 않는다. 이 조건의 M01을 앱의 제약 생성 조건과 합산하지 않는다.

주요 증거:

- `metadata.json`: suite·기반·어댑터 해시, 서버 식별, 생성 조건.
- `assignments.jsonl`: 추론 전에 고정한 모델별 요청·원천 그룹 배정.
- `attempts.jsonl`: 전송 전 started와 전송 후 completed, 실제 전송 본문 해시.
- `http/`: 전송 JSON, 원시 HTTP 응답 바이트, 응답 헤더·상태·해시.
- `outputs.jsonl`: 최초 출력·finish_reason·usage·실패 원인.
- `summary.json`: 배정·수신·실패·미실행 수. 실행 중 미완료 요청의 판단에는 attempts도 확인한다.
- `format-metrics.json`: 과제별 M01과 개별 형식 판정. started만 있고 완료 증거가 없으면 `missing_execution_evidence`로 확정을 보류한다.

M01은 스키마 적합성이다. 사실 정확성·질문 타당성·유용성 및 신규 독립 test의 성능으로 해석하지 않는다. 다른 지표는 기획서의 정답·관측·사람 판정 조건을 별도로 충족해야 한다. 학습 당시 기반 revision이 없으면 미확인으로 남긴다. 서로 다른 실행 기반이나 어댑터를 같은 비교 쌍으로 합치지 않는다.

원문·정답·응답·모델 가중치는 Git 제외 `runtime/` 등에 보관한다. 실행 자료를 문서나 테스트 코드에 복사하지 않는다.

검증:

```sh
python3 -m unittest discover -s ai/scripts -p test_paired_role_evaluation.py -q
node --test ai/scripts/summarize_paired_role_evaluation.test.mjs
```
