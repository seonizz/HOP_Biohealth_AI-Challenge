# 남은 미확인 항목

생성 수집 완료와 품질·모델 간 비교 완료는 별개다. 기존 원자료와 실패 기록은 수정하지 않았다.

| 항목 | 사유 | 필요 자료·다음 작업 |
|---|---|---|
| 요청 해결률·구체성·불필요 질문률 | 사람 검토 미수집 | 상담 63건 review_queue.jsonl에 generation_id+response_sha256로 사람 판정 연결; 실제32/합성31을 별도 보고 |
| 행동 분류 정확도 | 승인 정답 없음 | 현재 합성31건의 사후 정답은 개발 보조 분석에만 사용. 최종 정확도는 모델 출력 전 2명 독립 검토로 gold를 확정한 새 미사용 test에서 측정; 현재 사례를 최종 test로 승격하지 않음 |
| BASE31·FT31 및 Δ학습·Δ소형 | 동일 사례의 비교 모델 출력 없음 | 모델별 길이 검사 후 같은 정책·예산으로 수집, 완료 FT31 adapter 검증 |
| 독립 최종 test 성능 | legacy 개발용·공개 합성 회귀 사용 | 학습/개발 중복 감사와 미사용 test 확보 |
| NLL 및 감소율 | 로컬 BASE12 생성 수집 범위 밖 | 동일 31B tokenizer·마스크·평가 ID의 B0/B1; BASE12 NLL은 비적용 |
| 본학습 완료·업데이트·승인 사례 수 | 이 수집에서 확인하지 않음 | 동일 학습 run 완료 기록·checkpoint·승인 기록 별도 검증 |
| 원본 모델 revision 연결 | 로컬 배포 digest만 검증 | 원본 revision과 배포 변환 기록 연결 |
| peak GPU 메모리·절대 최대 길이 | ps snapshot과 지정 예산만 있음 | 별도 계측·용량 검증; snapshot을 peak로 표기하지 않음 |
| 심리학·CBT 학습 계획 | 승인 자료·일정 미수집 | 승인 계획과 자료 manifest 확보 |

## 사전 제외 사례

- T29-64: pre_generation_context_limit
- T29-256: pre_generation_context_limit
- T30: data_production_pipeline_not_model_response

## 수집 오류·누락

기록된 비유효 시도: 1건. 배정 후 생성 누락: 0건. 세부 상태는 metrics.json의 local_measurements에 보존했다.

- 실제 상담 legacy validation 개발용 32건과 공개 합성 회귀 상담 31건, 행동 분류 31건이다. 독립 최종 test가 아니다.
- 상담 63건과 행동 분류 31건은 서로 다른 작업이다. 전체 요청 94건을 품질 평가 분모로 사용하지 않는다.
- BASE12는 프로젝트 학습 adapter가 없는 Ollama MLX NVFP4 배포본이다. BF16 원본 가중치와 수치적으로 동일하다고 검증하지 않았다.
- 로컬 배포 manifest와 모델 blob 무결성을 확인했지만 Google/Hugging Face 원본 revision 연결은 미확인이다.
- BASE31·FT31 결과와 공통 길이 검사가 없어 Δ학습·Δ소형·속도 배율을 계산하지 않는다.
- 사람 검토·승인 정답이 없으므로 해결률·구체성·불필요 질문률·분류 정확도는 null이다. 형식 유효성은 의미 정확도가 아니다.
- 종료 이유 length는 유효 완료에 포함하지 않는다. 오류·길이 소진·누락도 사전 배정 분모에서 제외하지 않는다.
- wall latency는 요청 전체 경과 시간이며 모델 API eval_duration과 다르다. pooled 속도는 Σ출력 토큰/Σeval_duration이다.
- 수집 전에 smoke 요청 1건으로 모델을 로드했다. 본 수집은 warm-run·동시성 1의 측정이며 cold-start 지연이 아니다.
- prompt cache 사용 요청을 포함한다. ps 메모리는 마지막 관측의 모델 메모리 표시이며 peak GPU 메모리나 최대 용량 검사가 아니다.
- 4096 문맥과 출력 예약량 512/32는 설정값이다. 모델의 절대 최대 추론 길이 또는 전체 예약량 생성 성공을 뜻하지 않는다.
- 실제 상담 원문·응답은 private에만 보존하며 공개 사례에는 공개 합성 시나리오만 사용한다.

AI 보조 검토 31건을 별도 수집했다. 사람 검토 대기 및 최종 test 미확인 상태는 유지한다.
