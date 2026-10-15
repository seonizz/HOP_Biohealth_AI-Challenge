# FT31_STEP100 실제 수집 결과

Run: `FT31_STEP100_20261009T192608Z`

모델 `malssi-gemma4-31b-step100`, 체크포인트 100 step / `56244f8a6736e648dd8f4cd13d0889d7499a6bf776b9e55491a4ed59c446effd`.

배정 94건, 실행 가능 94건, 제외 0건, 시도 94건, HTTP 200 응답 93건, 미실행 0건.

| 과제 | 실행 가능 N | 첫 시도 기록 | 유효 | 출력 소진 | 최종 비율 (%) |
|---|---:|---:|---:|---:|---:|
| response | 63 | 63 | 51 | 11 | 80.95 |
| action | 31 | 31 | 31 | 0 | 100.00 |

| 동일 사례 과제 | N | BASE12 (%) | FT31_STEP100 (%) | 차이 (%p) |
|---|---:|---:|---:|---:|
| response | 63 | 98.41 | 80.95 | -17.46 |
| action | 31 | 100.00 | 100.00 | 0.00 |

상태 건수: `{"valid": 82, "length_limit": 11, "input_token_mismatch": 0, "empty_output": 0, "format_error": 0, "unverified_termination": 0, "identity_mismatch": 0, "http_error": 0, "unknown_completion": 1, "unexecuted": 0, "excluded": 0}`.

- 종료·형식·실제 토큰 측정이며 상담 품질·안전성·분류 정확도 점수가 아니다.
- 기존 검증용 개발 사례와 공개 합성 회귀 사례이며 독립 최종 test가 아니다.
- 오류·길이 소진·미실행도 사전 실행 가능 분모에 남긴다. 미측정 토큰은 null이다.
- 각 과제의 첫 시도 기록이 모두 있을 때만 최종 비율과 차이를 표시한다.
- BASE12와의 차이에는 모델 크기·배포 방식·학습 상태가 함께 반영된다.
