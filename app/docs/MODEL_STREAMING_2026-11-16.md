# 31B 모델 스트리밍 적용 완료 — 2026-11-16

**소스 구현과 현재 실행 앱 적용을 모두 완료했다.** 이전 “소스만 완료·기존 앱 미적용” 설명은 최초 작업 시점의 기록이다. [이전 구현·검증 기록](MODEL_STREAMING_INITIAL_2026-11-16.md)을 별도로 보존했으며 현재 상태는 이 문서를 따른다.

## 현재 실행 상태

| 항목 | 적용 결과 |
| --- | --- |
| 실제 웹 앱 | PID 64197, health 소스 일치, 적용 후 재시작 유지 확인 |
| 공개 웹 | [말씨](https://s-macbook-pro.tail85b0de.ts.net/) |
| 외부 관리자 | [모델 설정](https://s-macbook-pro.tail85b0de.ts.net/admin/models), 기존 별도 로그인 유지 |
| 31B 생성·검토 모델 전송 | **`stream:true`**, OpenAI 호환 SSE의 실제 `delta.content` 청크 전달 |
| 완료 경계 | 최종 JSON·XGrammar·종료 토큰·원문 일치 검증 후에만 finish/usage/`[DONE]` 전달 |
| 앱→브라우저 | 진행 상태와 검토 완료 카드 SSE 유지. DB 저장 후 완료 표시 |
| 표시·저장 | 미검토 원문 JSON·추론 조각은 화면에 노출하지 않음. 기존 카드 디자인 유지 |
| 적용 범위 | **새 대화부터 새 스트리밍 연결 버전 사용**. 기존 대화는 원래 연결 버전 유지 |
| 독립 검토 | 유지. 단일 호출 고정은 승인하지 않았으며 꺼짐 |

`GPU31B_MODEL_STREAM_JSON=true`와 `GPU31B_MODEL_REVIEW_STREAM_JSON=true`를 적용했다. 최종 검증을 생략하는 조기 JSON 완료 옵션은 writer·reviewer 모두 false다. 환경 파일만 바꿔 기존 암호화 연결의 false 설정에 가려지는 일이 없도록 **새 불변 연결 버전** `gpu31b_6318d384091022595f69599ecda53ed2`를 추가했다. 이전 연결 행·대화·기록·관리자 인증은 변경하지 않았다.

## 실제 모델 검증

임시 DB의 실제 질문 1건에서 생성 및 독립 검토를 수행했다. 모델이 생성 중 내보낸 청크를 받고, 최종 검증을 통과한 답변만 저장했다.

| 호출 | 실제 요청 | 생성 중 청크 | 완료 전 수신·최종 원문 일치 |
| --- | --- | ---: | --- |
| 질문 초안 | `stream:true` | 65 | 통과 |
| 안전 검토 | `stream:true` | 40 | 통과 |
| 상태 검토 | `stream:true` | 49 | 통과 |

총 **154개 실제 생성 청크**를 확인했다. 초안의 첫 청크는 `2026-11-16 20:12:32.267 KST`, 최종 응답 수신은 `20:12:43.763 KST`였다. 완료 후 응답을 잘라 스트리밍처럼 보이게 한 것이 아니다. HF 생성 함수의 streamer 콜백→원격 큐→로컬 SSE→앱 JSON 재구성으로 전달했다. 각 호출의 최종 문법 검증과 청크 연결 문자열의 최종 원문 일치도 확인했다.

앱의 실제 HTTP 응답은 SSE 진행 이벤트 9개와 최종 질문 view를 전달했고, DB에서 `reviewed:true` 상태와 갱신 버전을 확인했다. 검증용 임시 DB는 삭제했다. **이 검증은 질문 응답·독립 검토·상태 저장이며 전체 최종 카드 생성 성공을 새로 검증했다는 뜻은 아니다.** 과거 최종 상세 검토 실패 기록은 그대로 남긴다.

기존 대화가 보내는 `stream:false` 요청도 같은 주소·인증으로 실제 재실행했다. 스트리밍 요청과 생성 내용·토큰 사용량이 정확히 일치했고 문법 검증도 통과했다. 따라서 예전 연결을 새 프로필로 강제로 바꾸지 않았다.

## 검사와 전송 경계

- 전체 앱 회귀 **3,049/3,049 통과**, 실패·건너뜀 0개. 구문·JSON 검사 통과.
- 스트리밍 관련 검사 **57/57**, 원격 프로토콜·안전 경계 **24/24** 통과. 검사 범위가 겹치므로 합산하지 않는다.
- 한글·UTF-8 분할, 잘못된 순서/ID, 불완전 응답, 최종 근거·내용 불일치, 마지막 청크와 완료 파일의 경쟁조건을 검사했다.
- 브라우저 한 곳의 연결 해제는 해당 소비자만 취소한다. 공유 GPU 실행과 다음 요청을 종료하지 않으며 진행 중 응답의 최종 검증까지 수집한 뒤 FIFO 슬롯을 반환한다.
- 기존 GPU worker 정상 종료·메모리 11MiB/30MiB 복귀 후 새 전용 경로 `/home/slim/choieram/evaluations/gpu31b_stream_20261116`에서 실행했다. 모델·체크포인트·가중치·JSON 제약·입출력 한도는 유지했고 학습·설치·전역 변경은 하지 않았다.
- 현재 worker 4189637·supervisor 4189634, 모델 브리지 63380을 웹 사용용으로 유지한다. 20분 추론 미사용·최대 6시간 제한은 유지한다.

## 증거와 변경 소스

현재 앱 소스 fingerprint는 `c936bafd22f2e003a4f0d7d407fe049be9958a01f230f420a03e217e25d4ebe2`다. 동결 파일 목록 169개 해시는 `fdbcf256bf0cc41ccae0acdb4241d956be172c7a9ff31d297a586e52e43cc9b7`이며 계산 범위가 다르다.

Git 제외 경로 `app/runtime/gpu31b-stream-20261116/`에 다음을 보관한다.

- 실제 생성·앱 SSE·저장: `LIVE_APPLICATION_STREAM.json`, `live-application-events.json`, `service-requests/`
- 기존 연결 호환: `NONSTREAM_COMPATIBILITY.json`
- 실제 적용·재시작·기존 데이터 보존: `ACTIVATION.json`
- 검사: `full-tests.log`, `syntax-check.log`, `local-stream-tests.log`
- 모델·경계·이전 GPU 반환: `ready-proof.json`, `boundary-proof.json`, `PREVIOUS_SERVICE_RETURN.json`

재사용 가능한 소스는 `app/src/queue-event-stream.js`, `queue-process-response.js`, `queue-model-stream.js`, `app/scripts/serve-gpu31b-queue.mjs`, `app/src/model-config.js`, `ai/scripts/gpu31b_stream_protocol.py`다. 실행별 원격 코드 10개와 해시는 `runtime/gpu31b-stream-20261116/`에서 고정했다. 기존 평가용 worker를 덮어쓰지 않았다.

프로토콜 참고: [Hugging Face streamer API](https://huggingface.co/docs/transformers/main/internal/generation_utils), [OpenAI 채팅 스트림 계약](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).
