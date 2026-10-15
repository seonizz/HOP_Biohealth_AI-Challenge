# 실제 주석 레코드 계약

이 문서는 형식을 설명한다. 예시·테스트를 실제 상담 AI 판단으로 수입하면 안 된다.

공통 레코드 키: `sentence_id`, `context_hash`(batch의 값), `run`.

`run`은 `run_id`, 실제 `environment`, `model_id`(미확인이면 null), `prompt_version`, `dictionary_version`, `dictionary_hash`, ISO `timestamp`가 필요하다. 사전 hash는 `annotations.digest(definitions)`이다. 생성과 검증은 다른 run_id와 실제 독립 작업이어야 한다. DB는 ID와 필수 근거를 검사하지만 독립 사고가 실제 있었는지 기계적으로 증명하지는 못한다.

생성 레코드는 `candidates` 배열을 포함한다. 각 후보는 원천 사전 `key`, `value`, 짧은 `reason`, `evidence` 배열이다. 각 증거는 `start`, `end`, `text`이며 위치는 발화 원문 code point로 대상 문장 안이어야 한다. 정의와 증거가 없는 숫자 판정은 거부한다. 판단 불가 후보의 value는 null이다. 후보 목록에 없는 키는 판단 완료를 주장하지 않는다.

검증 레코드는 생성 import의 `record_id`를 `generation_id`로 참조하고 `independent_candidates`, `independent_judgment_recorded_first: true`, `verdict`(agree/disagree/uncertain), `reason`을 포함한다. 선택적 `per_label_verdicts`는 키별 판정이다. 값과 타입이 같고 각 정의를 충족한 후보만 수용한다. 생성·검증·준비된 사전의 hash와 버전은 같아야 한다.

사람 결정 레코드는 `sentence_id`, `context_hash`, `dictionary_hash`, 실제 `reviewer`, `timestamp`, `decision`(accept/correct/reject), `candidates`를 포함한다. 사람이 확정·거절한 후 AI가 상태를 덮어쓸 수 없다. 보류가 아닌 문장에 대한 새로운 사람 수정 워크플로는 별도 버전으로 다룬다.

`labels/confirmed.jsonl`의 학습용 수용값은 `effective_candidates`다. 이력의 과거 `generations`/`verifications`를 현재 정답으로 읽지 않는다. `effective_provenance`로 AI 검증과 사람 확정을 구분한다. `partially_ai_verified`는 열거된 후보만 수용됐다는 의미이며 `pending_candidates`까지 정답으로 쓰면 안 된다.

사람이 보류된 키만 확정하면 앞서 AI가 확인한 다른 키는 유지한다. 혼합된 결과는 `human_review_resolved`와 키별 `candidate_provenance`로 출처를 표시한다. `reject`의 기본 범위는 현재 보류된 키이며 이미 수용된 키를 자동으로 거절하지 않는다. 다른 키를 거절하려면 `rejected_keys`에 명시한다. 사람 검토를 종료하려면 보류된 모든 키를 후보 또는 거절로 해결해야 한다.

`annotations.sqlite`의 jobs는 문장별 작업 상태, generation/verification/human_decision/history는 append-only 판정 기록이다. source corpus 버전이 바뀌면 새 출력 디렉터리에서 재개하여 이전 결과를 보존한다.
