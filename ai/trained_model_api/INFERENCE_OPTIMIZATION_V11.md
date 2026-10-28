# v11 질의응답 추론 최적화 — 2026-10-18

사용자는 같은 모델의 답변별 호출을 줄이는 작업에 추론 최적화를 추가하도록 지정했다. 최종 결론은 최대한 기존 방식을 사용하고, 질의응답 중 대기시간을 줄이는 것이 목적이다. 모델·학습·평가·개발 상세는 서비스 화면에 추가하지 않는다.

## 적용 경로와 보존 범위

현재 서비스는 `local_live.Worker → bounded_live.py → live_worker.Backend → supporter_stage1.load_model` 경로로 Transformers Gemma4와 PEFT를 직접 실행한다. 이전 step100 Unsloth 실행의 MLP·eager decode 측정값을 현재 v11의 개선 근거로 사용하지 않는다.

모델은 `malssi-gemma4-31b-v11-epoch3`의 conversation epoch 3 / step 6이다. 체크포인트 manifest `11c976512809ab5d6d025d28c75374fa0a828fc6b6f1d1b3e47d4f87b9eaabe6`, adapter `8b1286f9056c100ed0ea86b30817b1dbff0265fcff19d1a6f7ad2e0bedd4cde6`를 유지한다. 입력 65,536·출력 예약 8,192·합산 69,632 토큰, 입력 비절단, prefill 1,024, DynamicCache, 2GPU 배치, 기존 양자화와 생성 설정을 유지한다.

최종 안내의 프롬프트·단계·검증·토큰 예산은 변경하지 않는다. 최적화는 질의응답의 `turn_draft`·`turn_review` 및 재작성 단계에만 적용하고, 최종 안내 요청은 기존 attention 경로를 사용한다.

## 비교 후보

기존 전역 attention은 새 토큰 하나를 생성할 때도 KV head마다 별도 SDPA를 호출하고 K/V를 확장·복사한다. [후보 구현](inference_attention.py)은 한 KV head를 공유하는 query head들을 독립 query 위치로 배치하여 원래 K/V로 SDPA를 한 번 호출한다. query 길이 1, 추론 모드, 전역 attention 등 기존 허용 조건을 만족할 때만 사용한다. 지원하지 않는 텐서·마스크 형상은 기존 경로로 돌아간다.

Head 대응·마스크·scale·`dropout=0`·`is_causal=False`를 보존한다. 이는 수학적 동등성을 목표로 하며, 커널과 부동소수점 연산 순서가 달라질 수 있으므로 bitwise 동일성은 가정하지 않는다. 실제 생성 토큰과 logits를 별도로 비교한다.

PyTorch의 비정방 causal 마스크는 위쪽 왼쪽 정렬이므로 single-token cached decode에서 임의로 `is_causal=True`로 바꾸지 않는다. [PyTorch SDPA 계약](https://github.com/pytorch/pytorch/blob/cf30153c4c131c8164ee7798e5022d810682e2cb/torch/nn/functional.py#L6460-L6474)

현재 후보는 새 엔진이나 패키지를 설치하지 않는다. Flash attention의 head 차원 제약, native GQA backend 지원, bitsandbytes의 compile 지원을 확인했으며, 설정 플래그만 켜서 Flash·컴파일 가속이 적용됐다고 판단하지 않는다. [PyTorch CUDA SDPA 선택](https://github.com/pytorch/pytorch/blob/cf30153c4c131c8164ee7798e5022d810682e2cb/aten/src/ATen/native/transformers/cuda/sdp_utils.cpp#L181-L210), [Transformers compile 조건](https://github.com/huggingface/transformers/blob/856157a2f3e9594954310df18fdccc31ffddebe9/src/transformers/generation/utils.py#L2250-L2286)

## 검증 방법

동일 Backend를 한 번 로드한 뒤 두 모드를 각각 8토큰 워밍업한다. 짧은 합성 요청·실제 형태의 일반 Q&A 초안·긴 정정 Q&A 초안, 총 3개 고정 요청으로 비교한다. 출력 예약은 각각 64토큰이다.

이 수치 비교는 프로토타입의 전역 grouped/folded 모드 제어로 수행했으며, 모든 응답은 64토큰 한도에서 끝났다. 실제 적용 경로는 별도의 `ContextVar`로 Q&A 네 단계에 한정한다. 프로토타입의 짧은 토큰 비교와 실제 r2 worker의 전체 응답 검증을 같은 검사로 취급하지 않는다.

1. 별도 정확성 실행에서 전체 생성 토큰의 일치와 마지막 raw logits의 차이·argmax를 비교한다.
2. 3라운드 동안 실행 순서를 교대한다. 전체 `Backend.generate`와 GPU 동기화를 포함한 시간, CPU 시간, GPU별 peak memory를 기록한다. 시간 측정에서는 logits 복사 비용을 제외한다.
3. 수학적 참조·head 대응·마스크·비연속 텐서·원래 K/V 사용·fallback의 11개 검사를 실제 모델 환경에서 실행한다. 실패·제외가 있으면 모델 로드 전에 중단한다.
4. 유한한 greedy 토큰 비교는 전체 상담 정확도 증명이 아니다. Q&A 전체 출력의 원문·정정·모름·거절·질문·안전 회귀와 독립 의미 검토를 별도로 유지한다.

원격 작업은 이번 요청의 새 작업 폴더 `work/inference-opt-20261018-r1`에 한정한다. 기존 가상환경을 읽기 전용으로 사용하고, Landlock·seccomp로 쓰기·캐시·임시 경로를 격리한다. 시작 PID와 startticks를 기록하여 해당 프로세스만 정리하며, GPU 메모리와 계산 프로세스가 시작 전 상태로 돌아왔는지 확인한다. 기존 앱 인증 정보는 사용하지 않는다.

## 동일 모델 추론 실측

실제 환경은 PyTorch 2.13.0+cu126, Transformers 5.17.0, PEFT 0.21.2, bitsandbytes 0.50.2였다. 같은 모델 객체에서 3개 요청을 각각 3회 측정했다.

| 입력 토큰 / 출력 64토큰 | 기존 평균 | 최적화 평균 | 변화 |
| --- | ---: | ---: | ---: |
| 34 | 10.639초 | 10.533초 | −1.0% |
| 5,823 | 16.764초 | 16.196초 | −3.4% |
| 16,522 | 43.062초 | 30.816초 | −28.4% |

세 입력을 같은 횟수로 측정한 총 시간은 211.397→172.633초(−18.3%)였다. 모든 요청에 18.3% 개선이 적용된다는 뜻이 아니며, 짧은 입력의 차이는 작다. 긴 입력에서는 실행 순서를 바꾼 세 라운드 모두 개선됐다. 이 측정은 prefill과 decode를 합친 64토큰 응답 전체 시간이며, 단계별 시간이나 decode 전용 token/s는 측정하지 않았다.

3개 별도 정확성 실행과 9개 시간 측정 쌍에서 생성 토큰이 모두 같았다. 마지막 raw logits는 3개 모두 최대 절대차 0·argmax 일치·NaN 없음이었다. 수치 참조 검사 11개도 실제 모델 환경에서 제외 없이 통과했다. 긴 입력의 전체 요청 peak allocation은 두 모드 모두 GPU 0 16,162.3MiB / GPU 1 11,829.3MiB였으므로, 이 수치로 전체 peak memory 감소를 주장하지 않는다.

측정 본문은 완료·정리 성공·종료 코드 0을 기록했지만 SSH 프로세스는 255를 반환했다. 원격 PID 부재와 GPU 11/30MiB 복귀는 별도로 확인했다. 종료 시점에 buffered stdin을 읽는 daemon이 남는 패턴을 로컬 검사로 확인했고, 기존 읽기 방식의 종료 검사도 실패했다. 다만 원격 255와 같은 원인인지는 확정하지 않았다. 후속 도구는 `os.read`를 사용하고 완료 이벤트에서 stdin을 닫도록 수정했으며 로컬 종료 검사는 0으로 통과했다. 이 도구 종료 수정 때문에 GPU 시간 측정을 다시 실행하지는 않았다. 원래 측정 파일·manifest와 `*-measured.py`는 보존하고, 앱 worker의 요청·종료 경로와 구분한다.

## 토큰 용량 확인

최적화가 켜지는 Q&A 요청으로 실제 API를 검사했다. 입력 65,536토큰과 출력 2토큰은 HTTP 200으로 완료되어 cached decode까지 실행했다. 입력 65,537토큰과 입력 61,441+출력 예약 8,192=69,633토큰은 각각 한도 초과 HTTP 400으로 거절됐으며 입력을 절단하지 않았다. 짧은 입력의 출력 8,192토큰 예약은 수락됐고 실제 생성은 6토큰에서 종료됐다. 따라서 출력 한도 예약의 수락을 확인한 것이며 8,192토큰 전체 생성 시험은 아니다. 긴 요청 뒤의 짧은 요청도 정상 처리됐다. 작업 PID 부재와 GPU 11/30MiB 복귀를 확인했다.

## 종료 처리 보완

r2 worker에도 열린 stdin의 buffered reader가 남은 채 유휴 종료하는 경로가 있어, 모델을 로드하지 않는 로컬 subprocess에서 `_enter_buffered_busy`와 SIGABRT를 재현했다. 사용자가 제공한 macOS Python 충돌 보고서는 이 검사와 시각·스택이 일치하지만, 재현 당시 PID를 별도로 기록하지 않아 PID 자체의 독립 대조는 하지 못했다.

중단 가능한 `select/os.read` 판독과 reader 종료 대기로 보완했다. 프레임 길이·JSON·요청 검증은 유지한다. 열린 stdin의 유휴 종료와 미완성 프레임을 읽는 중 SIGTERM 모두 종료 코드 0·stderr 없음으로 통과했고, reader가 남는 회귀는 검사 프로세스를 즉시 실패시켜 macOS 충돌 알림을 다시 만들지 않도록 했다. worker·Q&A 범위 검사 33개가 로컬과 실제 서버의 Python 3.12.3 가상환경에서 각각 실패·제외 없이 통과했다. 원격 검사는 모델을 로드하지 않고 작업 폴더 안에서 실행했으며 기존 환경은 변경하지 않았다. 최종 생성 설정이나 모델 계산은 변경하지 않았다.

최적화된 r2 worker에서 질의응답 고정 16개·166개 검사를 모두 통과했다. 핵심 5개 쌍 비교의 통합+추론 최적화 합산 시간은 457.383→233.246초로 49.0% 줄었다. 호출 통합과 추론 변경을 함께 적용한 결과이므로 위 attention 단독 측정과 구분한다. 서비스 기본 `temperature=0.2`에서도 별도 4개·42개 검사가 각 2회 호출로 통과했고, 독립 의미 검토에서 차단 결함을 발견하지 않았다. 단일 실행의 유한한 사례이며 일반 정확도나 최종 생성 문구의 동일성을 보장하지 않는다.

로컬 서비스를 새 임시 인증의 r2 실행과 `combined` 모드로 전환했다. 실제 모델 연결·앱 `/health` 정상 응답·전환 전후 암호화된 DB 행 fingerprint 일치를 확인했으며, 시작 점검 worker PID 부재와 GPU 11/30MiB 복귀도 확인했다. 기존 대화 데이터는 보존했고 기존 API 인증은 재사용하지 않았다. 웹 서비스는 유지되며 다음 요청에서 모델을 다시 로드한다. 이 최초 로딩 시간은 Q&A 개선율에서 제외했다.

[원문 없는 검증 근거](inference_optimization_v11_verification.json)에 실제 버전·측정값·GPU 반환·서비스 전환과 도구 종료 한계를 기록한다. 원시 근거는 로컬 `runtime/inference-opt-20261018-r1/`에 보관한다.

질의응답 호출 통합의 별도 결과는 [호출 통합 비교 기록](../../app/docs/TURN_CALL_COMPARISON.md)에 남긴다.
