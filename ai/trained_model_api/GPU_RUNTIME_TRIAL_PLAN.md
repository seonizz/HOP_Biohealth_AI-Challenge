# GPU 추론 엔진 속도 시험 계획 — 2026-10-10

현재 API는 GPU 전용이며 약4.94 token/s로 응답한다. MLP 래퍼 제거와 단일 토큰 컴파일 검사 감소는 적용했다. 더 큰 개선 가능성을 확인할 다음 후보는 별도 환경의 vLLM이다. 아직 설치·전환하지 않았다.

## 변경 경계

- 서버 리부팅·초기화·GPU 리셋·드라이버 변경·기존 환경 재설치는 하지 않는다.
- 작업은 `/home/slim/choieram/model_Training/vllm_trial_20261010/` 아래 새 환경과 산출물로 한정한다. 원본 모델과 step100 어댑터는 읽기 전용으로 사용한다.
- 설치와 import 확인 동안 현재 API를 유지한다. 동일 모델을 두 벌 동시에 GPU에 올리지 않는다. 실제 후보 로딩에는 현재 API 요청을 정상 종료하고 모델 프로세스를 교체하는 시간이 필요하다. 실패하면 검증된 기존 API로 돌아간다.
- CPU/disk 모델 offload는0, 계산과 KV는GPU, BF16 KV를 유지한다. 현재 입력65,536·출력4,096·합산69,632 정책을 임의로 변경하지 않는다.

## 설치 후보와 확인 근거

| 후보 | 설정 |
| --- | --- |
| vLLM | 0.31.0의 공식 cu129 x86_64 wheel; 약553MB이며 전체 의존성 크기는 미확인 |
| BNB 플러그인 | vllm-bnb-plugin0.0.3 |
| PyTorch | vLLM 요구사항에 맞는2.13.0 cu129; 현재 Unsloth 환경에 섞지 않음 |
| Transformers | 현재 사용 버전5.17.0으로 고정 가능 여부를 resolver로 확인 |
| GPU 분할 | pipeline parallel2, tensor parallel1, 동시 요청1 |
| 모델 | 기존 Gemma4-31B NF4 + 평가된 step100 LoRA |

[vLLM0.31 Gemma4 코드](https://github.com/vllm-project/vllm/blob/v0.31.0/vllm/model_executor/models/gemma4_mm.py)는 LoRA·PP·양자화 인터페이스를 구현한다. [BNB 로더](https://github.com/vllm-project/vllm-bnb-plugin/blob/main/vllm_bnb_plugin/bitsandbytes_loader.py)는 사전 양자화 모델에서 TP>1을 거부하므로 PP2가 후보다. **31B·현재 NF4·LoRA·PP2 전체 조합의 검증 성공은 아직 확인되지 않았다.**

드라이버535에서 CUDA12.x의 [minor compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/minor-version-compatibility.html)는 가능하지만, 새 PTX·드라이버 기능을 요구하는 커널은 실패할 수 있다. cu130 기본 패키지를 설치하지 않으며, cu129에서도 문제가 생기면 드라이버를 변경하지 않고 시험을 중단한다. [고정 릴리스](https://github.com/vllm-project/vllm/releases/tag/v0.31.0), [플러그인0.0.3](https://pypi.org/project/vllm-bnb-plugin/0.0.3/)

## 최소 시험과 채택 기준

1. 별도 환경에서 설치·import·GPU 커널 호환성을 확인한다.
2. 기존 모델을 정상적으로 내리고 후보를 로딩한다. LoRA 적용·키 매핑·두 GPU 배치·OOM을 확인한다.
3. 기존 합성 입력34토큰에서32토큰을 생성해 TTFT·decode token/s·출력 이상 여부를 비교한다. 현재4.99 token/s보다 실질적 개선이 없으면 채택하지 않는다. 목표 속도를 달성했다고 사전 보장하지 않는다.
4. 빠른 후보만 입력65,536에서 짧은 실제 생성1회로 용량을 확인한다. 전체4,096토큰 완주나 광범위한 품질 검사를 추가하지 않는다.
5. 시험 결과와 API 통합은 구분한다. vLLM은 현재 `/v1/sessions`의 저장·TTL·정확한 토큰 prefix 정책을 그대로 구현하는 교체품이 아니다. 기존 API 계약을 보존하는 연결을 검증하기 전에는 운영 완료로 보고하지 않는다.

사용자가 제공한 AGENTS.md의 `add dependencies only when explicitly requested` 규칙에 따라 새 의존성 설치는 명시적 요청이 필요하다. 이 계획과 기존 최적화 결과는 설치 전 준비 자료다.
