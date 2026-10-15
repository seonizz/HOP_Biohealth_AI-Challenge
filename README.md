# 말씨 — 현재 프로젝트 한눈에 보기

어려움을 겪는 사람 곁의 가족·친구가 대화와 행동을 준비하도록 돕는 서비스입니다. **최종 목표 모델은 31B이며, 지금은 12B로 임시 테스트 중입니다.** 아래는 **2026-10-15 로컬 코드·저장된 검증 기준**이며, 실제 서버의 현재 가동 상태를 조회한 결과는 아닙니다.

| 지금 볼 항목 | 현재 기준 | 자세히 보기 |
|---|---|---|
| 현재 테스트 실행본 | `app/` · 임시 Gemma4 12B · `relationship-v3.6.2-canonical-state` | [기술 구조와 사용자 흐름](app/docs/RELATIONSHIP_AGENT.md) |
| 사용 흐름 | 질문 답변 → 원문에 근거한 상태 갱신 → 검토된 가이드 → 기록 | [질문 관리](app/docs/QUESTIONS.md) |
| 실행 방법 | 프로젝트 루트의 공통 명령, 앱별 DB·모델 연결 설정 | [실행·검사 안내](docs/current/실행과_검증.md) |
| 검증 상태 | 로컬 검사는 통과. 실제 모델·웹 의미 검토는 보완 필요 | [확인된 결과와 할 일](docs/current/현황과_할일.md) |
| 데이터·모델 연구 | 31B 전환을 위한 학습·평가 자료와 분류 데이터 | [데이터와 연구](docs/current/데이터와_연구.md) |
| 발표 준비 | 근거정합 발표 기준본·실측 기록, 최종 31B 검증 진행 전 | [발표자료](presentation/README.md) |

**먼저 보기:** [현재 현황과 할 일](docs/current/현황과_할일.md) → [실행과 검증](docs/current/실행과_검증.md).

## 작업 위치

| 폴더 | 담당 |
|---|---|
| [app](app/README.md) | 웹 화면·API·DB·배포 |
| [ai](ai/README.md) | 모델 연결·에이전트 평가·학습 실험 |
| [data](data/README.md) | 원천·가공 데이터와 파이프라인 |
| [presentation](presentation/README.md) | 발표 수치·도구·슬라이드 |
| [docs](docs/README.md) | 공통 문서·대회 안내 |

[전체 문서 목차](docs/README.md) · [정리 이력](docs/organization/README.md)

[적대적 평가 대응 v2](docs/competition/결선_적대적_평가_v2.md) · [제출 범위·사전 검증 조건](docs/competition/04_제출범위와_검증계약.md)
