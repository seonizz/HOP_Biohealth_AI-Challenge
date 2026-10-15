# 128K API 용량 검증

기준: 2026-10-10 01:20 KST까지 저장된 GPU 검증 결과. 로컬 문서 정리 과정에서 GPU 검사를 다시 실행하지 않았습니다. 호출 예제는 [로컬 이용 안내](LOCAL_USAGE_REFERENCE.md), 설정은 [config.json](config.json)에 있습니다.

- 최종 상태: 131,072토큰 입력·출력 합산 한도를 실제 API에서 확인함.
- 요청 계약: 입력 토큰(채팅 템플릿 포함) + 요청한 `max_tokens` ≤ 131,072. 출력 예약 설정 상한 131,071, 기본값 256, 요청 본문 최대 8 MiB.
- 모델: `malssi-gemma4-31b-step100`, 체크포인트 step 100, 학습 재개 없음.
- 장비: RTX 4090 24GB 두 장. 기본 모델과 환경·어댑터 해시를 시작 시 확인함.
- 최종 설정: chunked prefill 4,096, fresh DynamicCache, global attention의 KV head별 SDPA 처리(`grouped_global_attention: true`). 같은 query head/KV head 대응과 마스크를 사용하면서 한 번에 복제하는 KV head 수를 줄임.

## 필수 검증 결과

1. CPU API 계약·오류 복구 테스트 15개 통과.
2. 다양한 내용의 합성 장문 8,193토큰 1건을 기존 전체 입력 처리와 새 처리로 비교. 양쪽 모두 `AB-314`, 출력 6토큰, 종료 방식 동일. 실제 입력 처리 조각은 `[4096, 4096, 1]`, 관측 캐시는 DynamicCache.
3. 실제 HTTP 입력 131,071 + 출력 1: HTTP 200, 165.654초.
4. 입력 64 + 출력 예약 131,008: HTTP 200, 약 0.87초. 실제 출력은 3토큰으로 종료했으므로 131,008토큰 생성 성공으로 해석하지 않음.
5. 합산 한도 1토큰 초과: HTTP 400, 입력을 자르지 않고 거절.
6. 긴 요청 뒤 짧은 요청: 성공, 약 0.85초.

## 변경 판단과 실측의 범위

이전 25,316/3,922는 학습 원문의 길이에서 가져온 설정이었다. 기존 전체 입력 처리에서는 32K 통과, 64K 메모리 부족이 관측됐다. 단순 분할 입력만 적용한 첫 128K HTTP 요청도 메모리 부족으로 실패했다. KV 전체 복제를 그룹별 처리로 바꾼 뒤 동일한 128K 경계 요청이 통과했다.

분할 처리와 기존 처리의 내부 logits는 완전히 같지 않다. 퇴화된 반복 문자 입력의 초기 엄격 비교는 상대 L2 기준을 통과하지 못했다. 층별 진단에서는 전체 처리 반복이 동일했고, 관측한 마스크 경계는 일치했다. 작은 attention 출력 차이가 여러 층에서 증폭되는 현상을 확인했으나 모든 Q/K/V 텐서의 모든 위치를 비교한 것은 아니다. 이 때문에 수치 완전 일치를 주장하지 않고, 위의 한 건의 합성 장문 응답 비교와 실제 API 용량 성공을 각각 보고한다.

이는 현재 단일 요청·텍스트 입력 API의 실행 용량 검증이다. 전체 1에폭 학습, 상담 품질 평가, 128K 장문 이해 품질, 최대 길이 출력 완주는 검증하지 않았다. 운영 한도를 모든 설정의 수학적 최대치로 해석하지 않는다.

128K 검증 원본: [prefill_verification.json](prefill_verification.json), [token_limits_verification.json](token_limits_verification.json). 이전 실패·진단은 서버 API 폴더의 `runtime/experiments/`, `runtime/diagnose_chunk.json`, `runtime/diagnose_summary.json`, `runtime/token_limits_128k_before_grouping.json`에 보존했다. 채택하지 않은 attention 후보는 runtime으로 옮겼으며 API가 import하지 않는다.

최초 기본 호출 기록인 [verification.json](verification.json)은 128K 확장 전 검사입니다. 그 안의 `maximum_context_capacity_measured: false`는 당시 상태이며, 이후 용량 결과는 위 `token_limits_verification.json`을 기준으로 합니다. 저장된 기록은 각 검사 시점의 증거이며 현재 서버 생존 여부는 `/healthz`로 확인합니다.
