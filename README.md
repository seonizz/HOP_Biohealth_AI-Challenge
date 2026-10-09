# HOP Biohealth AI Challenge

환자를 돕고 싶은 주변인이 상황을 설명하면 필요한 질문으로 정보를 정리하고, 관계와 맥락에 맞는 대화 방법을 제안하는 HOP의 팀 저장소입니다.

## 저장소 구조

```text
Backend/                 백엔드 코드·API·DB 마이그레이션·배포 설정
  client/                프론트엔드용 TypeScript API 클라이언트
  docs/                  연동·운영·모델·테스트 가이드
  src/                   인증·프로젝트·대화·모델·검색 구현
  tests/                 단위·API·PostgreSQL 통합 테스트
.github/workflows/       백엔드 자동 검사
```

백엔드 개발 작업은 `Backend/`에서 진행합니다.

```sh
cd Backend
npm ci
npm run check
```

실행에는 PostgreSQL 연결과 환경 설정이 필요합니다. 전체 절차는 [백엔드 README](Backend/README.md)를 확인하세요.

| 작업 | 문서 |
| --- | --- |
| 현재 화면에서 점검할 기능 | [프론트 연결 전 점검](Backend/docs/BEFORE_FRONTEND.md) |
| 프론트 연동·인증·오류 처리 | [프론트엔드 가이드](Backend/docs/FRONTEND.md) |
| API 계약 | [OpenAPI](Backend/openapi.json) |
| 복사해서 쓰는 테스트 입력 | [테스트 프롬프트](Backend/docs/TEST_PROMPTS.md) |
| DB·HTTPS·백업과 운영 | [운영 가이드](Backend/docs/OPERATIONS.md) |
| 인터뷰·RAG·응답 검증 | [모델 파이프라인](Backend/docs/MODEL_PIPELINE.md) |

CI는 `Backend/`를 기준으로 타입 검사, 실제 PostgreSQL 통합 테스트, 의존성 점검, Docker 빌드와 API 기동을 확인합니다.

실제 상담 데이터, 모델 가중치, DB 파일, 비밀번호, 팀 초대 코드와 실행 로그는 커밋하지 않습니다. 모델과 지식 데이터의 준비 방법은 백엔드 문서를 따릅니다.
