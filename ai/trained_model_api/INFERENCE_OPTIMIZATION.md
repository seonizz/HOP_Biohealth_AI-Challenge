# GPU 추론 최적화 기록 — 2026-10-10

현재 서버에는 학습용 MLP 래퍼 제거와 Unsloth의 단일 토큰 eager decode 경로를 적용했다. 모델 파라미터와 KV 캐시는 CUDA 두 장에 있으며 CPU/disk offload를 사용하지 않는다. 토큰화·HTTP·GPU 작업 제출에는 CPU를 사용한다.

| 비교 | 순수 decode 속도 |
| --- | ---: |
| 기존 MLP 래퍼 | 4.254 token/s |
| 언어 모델 60개 MLP 래퍼 제거 | 4.441 token/s |
| CPU 컴파일 검사 감소 경로 추가 | 4.985 token/s |
| 최종 실제 HTTP 요청 | 4.940 token/s |

서로 다른 재로딩에서 측정한 처음과 마지막 수치의 개선은 약 16.1%다. CPU 경로 자체의 동일 프로세스 A/B는 4.438 → 4.985 token/s, 동일한 입력34·출력32토큰 요청의 CPU 시간은 7.243 → 6.474초였다. 단일 짧은 합성 요청 기준이며 하드웨어의 최대 성능이나 모든 요청의 개선을 뜻하지 않는다.

## 변경과 검증

- 학습 설정·학습 라이브러리·step100 가중치를 변경하지 않았다. 추론 인스턴스의 언어 MLP 60개만 저장된 원래 forward로 복원한다. 비전 MLP와 GPU 경계 처리는 보존한다.
- 이미 설치된 `unsloth_eager_decode()`를 캐시가 있는 1토큰 추론에 연결했다. 긴 prefill, gradient 활성화, 외부 컴파일 추적에는 적용하지 않는다. 스레드별 상태가 호출 종료·예외 후 복구된다.
- MLP 제거 전후에는 비교한 32토큰과 마지막 logits가 정확히 일치했다. eager decode 비교에서는 32토큰이 같았지만 마지막 logits 최대 절대 차이는 0.359375였다. 부동소수점 경로 차이가 있으며 모든 입력의 출력 동일성이나 광범위한 품질 검증을 주장하지 않는다.
- 최종 경로로 입력65,536 + 출력2토큰을 실제 처리했다. MLP 제거 단계에서는 내부 합성 입력69,630 + 출력2의 캐시 길이도 검사했다. 후자는 HTTP 입력 허용치가 아니다. 출력4,096 전체 생성이나 전체 장문 품질 검사는 수행하지 않았다.
- 준비된 추론 단위 테스트4개가 통과했다. 최종 API `/healthz`와 합성32토큰 요청은 HTTP200이었다.
- 현재 운영 한도는 입력65,536·출력4,096·합산69,632이다. 이 수정에서는 정책을 변경하지 않았다. 앞서 선택한 합산65,536 계획과는 구분한다.

## 운영

서버의 `config.json`에서 `inference_mlp_mode: "original"`, `inference_eager_decode: true`가 활성화돼 있다. `run_server.sh`는 현재 서버의 `active_cache_server.py`를 실행한다. 로컬 폴더에는 이전 서버 코드도 있으므로 전체 폴더를 서버에 덮어쓰지 않는다. 로컬 클라이언트는 기존 SSH 터널을 그대로 사용한다.

서버 원본 증거는 `/home/slim/choieram/model_Training/trained_model_api/runtime/inference-opt-20261010-v2/`와 `runtime/decode-opt-20261010/`에 보존했다. 원복 파일은 각 폴더의 `backend.before.py`, `config.before.json`이다. 원복은 진행 중 요청을 정상 종료한 뒤 해당 소스와 설정을 복원하고 API를 재시작해야 적용된다.

수치와 현재 모델 식별자는 [검증 JSON](inference_optimization_verification.json)에 있다. 같은 고정 합성 문장만 사용했고 사용자 상담 내용을 재생하지 않았다.
