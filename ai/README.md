# AI 모듈

현재 앱 실행 소스는 [app](../app/README.md)입니다. 이 모듈은 모델 연결·관계 에이전트 평가·학습 실험과 미배포 패치를 관리합니다.

| 작업 | 위치 |
|---|---|
| 합성 사례·실제 웹 평가 | [평가 실행 안내](local_api/RELATIONSHIP_AGENT.md) |
| 현재 기술 계약 | [관계 에이전트](../app/docs/RELATIONSHIP_AGENT.md) |
| 미배포 개선본·남은 검증 | [현황과 할 일](../docs/current/현황과_할일.md) |
| 목표 31B 전환·학습 근거 | [데이터와 연구](../docs/current/데이터와_연구.md) |
| 목표 31B API 호출 자료 | [이용 안내](trained_model_api/LOCAL_USAGE_REFERENCE.md) |
| 선택적 Ollama 인증 프록시 | [프록시 안내](local_api/README.md) |
| 서버 작업 위치·경계 | [서버 작업 규칙](Gemma_서버접속_작업규칙_레퍼런스.md) |

`local_api/backend_patch`는 실행 서버 전체가 아닌 적용 후보 코드입니다. 적용 스크립트는 실제 파일·설정을 바꾸므로 평가 도구와 구분합니다. 문서 설명을 다시 덮어쓰는 방식으로 패치를 적용하지 않습니다.

[공통 실행·검사](../docs/current/실행과_검증.md) · [과거 서비스·인수인계 원문](../archive/08_문서통합_원문/ai/)
