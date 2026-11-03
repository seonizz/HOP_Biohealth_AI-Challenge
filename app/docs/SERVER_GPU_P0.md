# 서버 GPU 전용 P0 구현

후속 변경: API에 operation 내 토큰 정책 재사용을 위한 revision 계약을 추가했다. 서버 교체 시 stale revision 요청을 추론 전에 거절하며 readiness 확인은 유지한다. [추가 반영과 최신 검증](REMAINING_MODEL_OPTIMIZATIONS.md)을 참고한다.

이 문서는 모델 호출 최적화 기획의 P0(요청 호환성·공통 대기열·준비/취소 상태·계측) 구현 범위다. 실제 서버 설정 변경, 모델 기동, 배포는 포함하지 않는다. **GPU 서버 접속·실검증 전에 사용자 승인을 받아야 한다.**

## 1. 변경 범위

- `MODEL_SERVER_GPU_ONLY=true`: 생성·검토·기관 분류를 하나의 명시적 목적지·모델·인증 범위로 묶는다. 검토는 별도 Gateway와 기존 독립 검토 요청으로 유지한다.
- `trained_chat` API 프로필: GPU API가 거절하는 `response_format`, `reasoning_effort`, streaming 필드를 보내지 않는다. schema는 프롬프트에 전달하고 기존 검증기는 모두 유지한다.
- 공용 Python 서버: opt-in FIFO 대기열, 물리 요청 한 건에 한 슬롯, 개수·바이트 제한, 대기 중 연결 종료/서버 종료 처리.
- 준비 상태: backend의 `inference_status()`가 `ready`인 경우만 새 추론에 진입한다. 상태 조회가 모델을 시작하거나 재시작하지 않는다.
- 별도 guarded bridge/remote worker: 명시적 시작, worker identity 대조, 취소와 원격 종료 확인 분리. 불확실한 종료는 `draining` 또는 `unavailable`로 유지한다.
- 앱 진단 로그: 생성·검토·분류의 operation ID, 재시작 번호, HTTP 시도 순번, 논리 family 계수, gateway fingerprint를 추가한다. 총 시간 제한이나 재시도 상한은 새로 적용하지 않는다.

기존 `.env`, 현재 실행 중인 서비스, 기존 runtime bridge는 바꾸지 않는다. O4의 카드 재생성 축소(26→18회)와 O5의 검토 재사용(16회 후보)은 이 P0 구현에 포함하지 않는다. 안전 검토·질문 생략·기존 카드 디자인·상세 저장 계약은 유지한다.

후속 작업으로 [O4 최종 초안 재사용](FINAL_DRAFT_REUSE.md)을 구현했다. 현재 GPU overlay는 O4를 활성화하고 extras 생략을 금지한다. 아래 P0 검증 기록은 당시 기준이며, O4의 호출 수·검토 후 수정·최신 검증은 별도 문서를 따른다.

## 2. 앱 설정 계약

| 항목 | 서버 GPU 전용 모드 |
| --- | --- |
| `MODEL_SERVER_GPU_ONLY` | 명시적 `true`. 미지정/`false`는 기존 동작 |
| `MODEL_BASE_URL` / Docker override | 검증할 서버 GPU bridge 목적지. loopback 중계도 가능 |
| `MODEL_NAME`, `MODEL_API_KEY` | 명시적으로 필수. 로컬 Ollama 인증 기본값을 자동 사용하지 않음 |
| `MODEL_PROTOCOL` | `relationship_agent` 유지 |
| `MODEL_API_PROFILE`, `MODEL_REVIEW_API_PROFILE` | 미지정이면 `trained_chat`, 명시적 다른 값은 거절 |
| agent format / reasoning | 기본 `prompt` / `omit`. 기존 `json_schema`, `none`이 명시돼 있으면 구성 오류 |
| stream / complete JSON stream | false만 허용 |
| `MODEL_REVIEW_*` 목적지·모델·인증 | 미지정이면 생성 설정 상속. 명시된 값이 다르면 구성 오류 |
| `REFERRAL_MODEL_*` 목적지·모델·인증 | 같은 값만 허용하며 공통 생성 Gateway 재사용 |
| 총 처리 시간 | 기존 `MODEL_TIMEOUT_MS`와 기본값 0 유지 |

명시적 빈 문자열·오래된 로컬 검토 설정을 그대로 남기면 충돌 오류가 날 수 있다. 설정을 정리한 뒤 **네트워크를 사용하지 않는 구성 검사**로 먼저 확인한다. `apiProfile`·`serverGpuOnly`는 설정 의도이며 실제 GPU 하드웨어를 확인했다는 증거가 아니다.

독립적으로 `MODEL_API_PROFILE=trained_chat` 또는 `MODEL_REVIEW_API_PROFILE=trained_chat`만 사용할 수도 있다. 이 경우 GPU 전용 공유 목적지 계약까지 자동 활성화되지는 않는다.

Docker에는 명시적 `compose.gpu.yaml` overlay를 추가했다. 기본 Compose 동작은 변경하지 않았다. overlay는 검토·기관 설정을 생성의 목적지로 명시적으로 묶는다. 실제 적용·컨테이너 기동은 GPU 사용 승인 후에만 수행한다.

## 3. 대기열·remote worker 계약

| 옵션 | 의미 |
| --- | --- |
| `inference_queue_max_requests` | 대기 요청 수. 기본 0은 기존 즉시 429, 양수는 FIFO 대기 활성화(최대 128) |
| `inference_queue_max_bytes` | 대기 payload 바이트 합계. 기본 16 MiB, 최대 64 MiB |
| `require_backend_status` | true이면 상태 hook 없는 backend를 구성 단계에서 거절 |

현재 실행 중 요청은 대기 한도와 별도다. 개수·바이트 한도는 수락된 대기 payload에 적용되며, 연결 수 자체의 네트워크 admission 제한을 대신하지 않는다. 각 HTTP 요청의 기존 8 MiB 한도와 인증·형식 검증도 유지한다.

공통 슬롯은 한 번의 `backend.generate` 호출에만 부여한다. operation 전체를 잠그지 않으므로 writer→review→repair의 순차 요청이 같은 슬롯을 사용할 수 있다. 대기 중 취소된 요청은 backend를 호출하지 않는다. 서버 종료는 대기자를 깨우고 새 입장을 막는다. 여러 앱·alias proxy가 **같은 공용 bridge**를 사용해야 이 슬롯을 공유한다. 별도 bridge 인스턴스 두 개가 같은 원격 worker 자원을 쓰는 구성을 자동 조정하지 않는다.

backend hook은 읽기 전용 `inference_status() -> {"status": ...}`다.

| 상태 | health | 새 추론 |
| --- | --- | --- |
| ready | 200 | 허용 |
| busy | 200 | 현재 작업 뒤 대기 |
| draining | 503 | 해당 원격 request 종료 확인 전 불가 |
| unavailable / 잘못된 응답 / hook 오류 | 503 | 불가 |

일반 동기 backend의 hook 미지정은 기존 호환 동작을 유지한다. SSH bridge는 `require_backend_status=true`로 사용해야 한다. HTTP client가 끊겼다는 사실이나 cancel 접수 응답만으로 원격 완료를 주장하지 않는다. idle 이후에 발행된 matching terminal reply나 process 종료를 확인하며, process 종료는 `ready`가 아니라 `unavailable`이다. health 요청으로 원격 작업을 재시작하지 않는다. 추론 중 transport·EOF 등으로 준비 상태를 잃으면 503이며, 실제 입력·토큰 예산 오류의 400과 구분한다.

새 `guarded_bridge.py`는 import 시 모델이나 SSH를 시작하지 않는다. CLI를 실행하면 명시적으로 준비·identity 검증 후 HTTP 서비스를 시작하므로 **명령 실행 전에 GPU 사용 승인이 필요하다**. 기존 검증된 SSH 명령·원격 격리 bootstrap·checkpoint identity·토큰 한도를 별도 config에 공급해야 한다. 임의 모델 경로나 신규 환경을 자동 설치하지 않는다.

bridge config는 `api`와 `worker` 두 객체를 갖는다. `api`에는 기존 서버 설정을, `worker.command`에는 검토한 실행 명령의 인자 배열을 넣는다. `worker.expected`는 ready 이벤트의 `checkpoint_sha256`, `adapter_sha256`, `checkpoint_path`, `checkpoint_step`, `max_input_tokens`, `max_output_tokens`, `max_context_tokens`, `gpu_only:true`, `terminal_reply_after_idle:true`를 필수로 대조한다. 추가 identity 필드도 명시하면 대조한다. API가 광고하는 checkpoint·토큰 한도와 worker 기대값이 다르면 구성 오류다. CLI는 `--config`와 기존 인증 파일의 `--key-file`을 명시적으로 받으며 비밀값을 새로 만들지 않는다.

검토에서 기존 remote worker가 오류 reply를 먼저 발행하고 그 뒤 `active`를 비우는 경합을 발견했다. **기존 worker를 그대로 새 bridge에 연결하지 않는다.** [호환성 패치](../../ai/trained_model_api/live_worker_terminal_idle.patch)는 복구 가능한 오류에도 먼저 `active`를 해제하고, 이 계약을 ready metadata로 선언한다. bridge는 선언이 없는 기존 worker의 준비 상태를 거절한다. 로컬에 보관된 두 worker 소스의 임시 복사본에 패치가 적용됨을 확인했고, 추론 없이 분리한 `serve` 함수에서 입력 거절·취소·deadline 세 경합을 재현해 패치 후 해소를 확인했다. 원격 적용은 승인 후 실제 파일·경로를 대조한 별도 배포 단계다. 기존 `runtime/` 파일은 수정하지 않았다.

worker의 전체 생성 시간 제한은 기본 `None`이다. `worker.send_timeout`은 기본 5초로, 비차단 파이프에 요청·제어 메시지를 전송하는 데만 적용한다. 시작 확인 대기와 취소 후 완료 응답을 기다리는 유예 시간도 별도 설정이며, 유예 시간 경과로 `ready`가 되지는 않는다. 부분 전송·종료가 불확실하면 채널을 사용 불가로 유지한다. worker 객체는 명시적 `start()`를 한 번만 허용한다. 종료 시 관리하는 것은 이번에 만든 로컬 자식 프로세스뿐이며, SSH 채널 종료를 원격 GPU 반환 증거로 취급하지 않는다. 실제 반환은 승인된 실검증에서 별도로 확인한다.

## 4. 계측 해석

기존 `model_attempt`, `model_operation_retry`, `model_retry_wait` 이벤트를 확장한다. 원문·프롬프트·API 키·endpoint URL은 새 계측에 넣지 않는다.

- `operation_id`: 하나의 Gateway operation 안에서 자동 복구와 위임한 검토 Gateway를 연결한다. 기관 분류처럼 별도 operation으로 시작한 호출은 별도 ID다. 사용자 요청 전체를 묶을 때는 기존 `request_id`도 함께 사용한다.
- `operation_restart`: 자동 전체 재시작 번호. 시간 제한이나 상한을 뜻하지 않는다.
- `http_attempt_index`: 그 operation에서 fetch 호출을 시작한 순서. 로컬에서 발송을 시도했지만 연결이 실패한 경우도 포함한다.
- `model_role`: writer / reviewer / classifier.
- `family_http_attempts`: 수정 stage와 원 stage의 논리 범위별 누적 계수. aggregate 작성은 여러 카드 family를 함께 센다. 각 family 값을 합산해 전체 HTTP 요청 수로 사용하면 중복 집계가 된다.
- `gateway_fingerprint`: 설정 URL·모델의 해시. 18080과 proxy 18081처럼 같은 물리 backend의 alias를 자동으로 같은 값으로 합치지 않는다.

HTTP 시도는 실제 GPU dispatch와 다르다. 429·연결 실패·queue 취소를 실제 추론 수로 집계하지 않는다. 공용 bridge의 admission/실행 결과와 함께 대조한다. GET token capability 조회는 생성 POST 계수에 포함하지 않는다.

## 5. 로컬 검증과 GPU 검증 경계

설정·request body, fake backend FIFO·취소·draining, fake subprocess identity·late reply, operation 계측은 로컬에서 검증한다. loopback HTTP 테스트는 합성 backend만 사용하며 GPU API로 요청하지 않는다.

P0의 구현 후 독립 코드 검토를 수행하고 지적사항을 수정한다. 그 다음 실서버 검증 전에 사용자에게 아래 범위를 제시해 승인을 받는다.

1. 기존 인증 세션에서 지정 서버·작업 경로·GPU 점유의 최소 읽기 전용 확인.
2. 기존 가중치·격리 환경·사용할 프로세스·출력 경로 확인. 다른 작업은 중지하지 않음.
3. 승인된 범위의 새 bridge와 합성 요청으로 생성·검토·분류 요청 호환성, 슬롯 1개, 취소 종료, 원격 identity 확인.
4. 실제 상담 원문 없는 사례로 기존 검증·저장 계약 확인. 이번 검증에서 시작한 작업만 종료·반환 확인.

승인 전에는 이 절차를 실행하지 않는다. 로컬 테스트 통과를 실제 GPU 검토 능력·서버 가동·배포 완료로 보고하지 않는다.

## 6. 구현 후 검토·최종 검증

구현을 마친 뒤 작성자와 검토 대상을 교차하여 독립 검토했고, 다음 문제를 수정한 후 재검토했다.

| 발견한 문제 | 수정·재검토 결과 |
| --- | --- |
| 정체된 stdin 쓰기와 stdout 읽기 잠금 때문에 종료가 무한 대기 | 버퍼 없는 비차단 파이프, 전송·종료 제한, 정체된 pipe 회귀 검사 |
| 종료가 겹칠 때 닫힌 파일 번호를 재사용해 다른 파일에 쓰는 경합 | 같은 잠금 안에서 번호를 무효화한 후 닫음. 재사용된 임시 파일이 변경되지 않음을 확인 |
| 원격 EOF·채널 장애를 입력 오류 400으로 반환 | backend 준비 상태 오류를 분리해 503, 실제 입력 예산 오류는 400 유지 |
| 기존 worker가 오류 reply 이후에 active를 해제 | 종료 계약 선언을 필수 확인하고, active 해제 순서를 바꾸는 호환성 패치 준비. 원격에는 미적용 |

| 최종 검사 | 결과 |
| --- | --- |
| 앱 전체 `env -u TEST_DATABASE_URL node --test tests/*.test.js` (`app/`에서 실행) | **1,858 통과, 0 실패, 85 건너뜀**. 실제 DB 연결이 필요한 검사는 실행하지 않음 |
| Python `python3 -B -m unittest test_inference_queue test_api_queue test_api test_remote_worker` (`ai/trained_model_api/`에서 실행) | **65 통과, 0 실패**. 합성 backend·가짜 subprocess·localhost HTTP만 사용 |
| `node scripts/check.js` (`app/`에서 실행) | JavaScript 구문·JSON 검사 통과 |
| Compose overlay | YAML 파싱 및 생성·검토·분류의 동일 목적지·모델·인증 매핑 검사 통과. 컨테이너는 기동하지 않음 |
| 원격 호환성 패치 | 두 기존 로컬 소스의 임시 복사본에 적용 가능. 입력 거절·취소·deadline의 세 경합을 패치 전 재현하고 패치 후 해소 확인 |
| 독립 재검토 | 검토 범위의 미해결 지적사항 없음 |

지침에서 예외로 허용한 별도 Ollama 검토 API에도 원문·비밀값 없는 설계 요약으로 검토를 시도했으나 응답 시간 초과로 검토 결과를 얻지 못했다. 위 완료 판단은 네이티브 독립 검토와 실제 로컬 검사에 근거한다. GPU 서버 접속·SSH·실제 GPU 추론·배포·기존 실행 설정 변경은 하지 않았다.
