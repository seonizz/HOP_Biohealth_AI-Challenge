# 말씨 프론트엔드·백엔드 통합본

기존 프론트의 말씨 마스코트와 화면 분위기를 유지하고, 백엔드 v2 계약에 맞게 실제 서버 연동으로 교체한 배포용 프로젝트입니다.

- 프론트 원본: `main`의 `b88342022446ff0402e9907a30e3f980d0a55c51`
- 백엔드 원본: `feat/malssi-backend-dual-model`의 `66bc2ac7af3ab6d35583a6e02e216b50a64efadd`
- 제공 명세: `말씨_백엔드_구현_명세_서버이용_20261009.zip`
- 통합 브랜치: `feat/malssi-fullstack-integration`

## 폴더

```text
frontend/        화면, 서버 문항 렌더러, API 클라이언트, 마스코트
backend/         인증, 말씨 v2 API, PostgreSQL, 모델 작업자, 원본 명세
  docs/          원본 백엔드 명세·질문 카탈로그·운영 자료
  client/        TypeScript 연동 클라이언트
  migrations/    DB 마이그레이션
  tests/         단위·API·실제 DB 통합 테스트
deploy/          웹 Dockerfile, Caddy 프록시·HTTPS
scripts/         환경 생성, 프론트 빌드, 상태 확인, 백업
tests/          프론트 계약 테스트, 브라우저 E2E, 합성 모델 fixture
compose.yaml    기본 배포 구성
compose.model-host.yaml  Linux 호스트의 기존 로컬 모델 연결
compose.e2e.yaml         자동 검증 전용 구성
```

## 바로 실행

Docker Engine/Desktop와 Docker Compose v2.24.4 이상, Node.js를 준비합니다. 전체 개발에는 Node 24.19.0 이상을 권장합니다. 컨테이너 안의 Node 버전은 고정되어 있습니다.

```sh
npm run setup -- --origin http://localhost:8080
docker compose up --build -d
npm run doctor
```

브라우저에서 `http://localhost:8080`을 열고 **가입 없이 체험하기**를 누르면 바로 첫 질문이 열립니다. 내부 시연 모드는 방문자별 임시 계정을 만들고 24시간 후 접속을 만료시킵니다. 계정·기록은 이후 시간당 정리 작업에서 삭제하거나 설정에서 즉시 삭제할 수 있습니다. 실제 개인정보 대신 가상의 사례를 입력해 주세요. 모델 서버가 없을 때의 **가이드 화면 예시**는 고정된 가상 내용이며 답변을 분석한 결과가 아닙니다.

기존 계정으로 이용하려면 상단의 로그인으로 들어가세요. 새 계정 가입에는 `.env`의 `HOP_INVITE_CODE`가 필요합니다. `.env`의 값은 저장소나 공개 문서에 올리지 마세요. 생성 도구는 기존 `.env`를 덮어쓰지 않습니다. 시연 기능은 `HOP_DEMO_ENABLED=true`일 때만 노출되며, `npm run setup -- --mode release`로 생성한 설정에서는 꺼져 있습니다.

기본 실행에서는 **가입 없는 시연·로그인·동의·질문·답변·대화 복원·기억·삭제**를 사용할 수 있습니다. 실제 모델을 연결하지 않은 상태에서는 가이드 생성 버튼을 제공하지 않습니다. 시연 계정에 한해 고정된 가상 가이드 화면을 별도로 보여주되 AI 응답과 구분합니다.

모델 연결, 서버 HTTPS 배포, Linux GPU 서버 연결은 [배포 안내](docs/DEPLOYMENT.md)를 확인하세요.

## 연결한 기능

- HttpOnly 쿠키 인증, 초대 코드 가입, 로그인·로그아웃·비밀번호 변경·계정 삭제
- 내부 시연용 1회 클릭 임시 계정, 방문자별 기록 분리, 24시간 만료·즉시 삭제
- 필수 처리 동의와 기록 보관·장기 기억 동의 분리, 동의 철회
- 서버가 제공하는 24개 문항 계약: 서술형, 선택형, 관계/접촉 빈도 복합형, 대처 방법/효과 입력
- 목표별 질문, 모름·건너뛰기, 답변 정정, 질문 직접 선택
- PostgreSQL 저장, 프로젝트별 대화 목록, 새로고침과 재로그인 후 복원
- 비동기 모델 작업 상태·취소, 검증 완료 가이드, 행동 계획·경험 기록
- 안전 신호에 따른 즉시 보류, 새로고침 후에도 보류 유지, 명시적 재개
- 기억 확인·정정·잊기, 원문·프로젝트·계정 삭제
- 요청 UUID와 리비전을 이용한 충돌 방지, 응답 유실 시 같은 요청으로 재시도
- DB 마이그레이션 → API → 웹 순서의 기동, 제한 DB 역할, 암호화 키, 보관 만료 작업

브라우저에는 인증 토큰이나 대화 원문을 localStorage에 저장하지 않습니다. 프론트의 임시 점수 계산과 mockModel은 배포 산출물에서 제거했습니다.

## 배포 범위

**컨테이너로 설치하고 내부 검토용으로 실행할 수 있는 통합본**입니다. 제공된 질문 카탈로그 자체가 draft이므로 공개 출시 승인까지 완료된 서비스라고 표시하지 않습니다.

- `/health/service`: 실제 API·DB 동작 상태
- `/health/ready`: 카탈로그의 게시·권리·콘텐츠 승인 상태. 현재 원본은 draft여서 503이 정상입니다.
- `npm run check:release`: 공개 카탈로그 승인 여부를 검사합니다. 현재는 실패하는 것이 맞습니다.
- 실제 로컬 모델의 품질·GPU 성능, 공개 도메인의 TLS 발급, 외부 백업 복구는 운영 환경에서 별도 검증해야 합니다.
- 원본의 B→A 감정·위험 수치 평가 문서는 후속 설계입니다. 이번 통합의 실행 경로는 기존 v2의 정보 추출·가이드·검증 파이프라인입니다.

상세 범위와 한계는 [통합 변경 사항](docs/INTEGRATION.md), 검증 결과는 [검증 기록](docs/VALIDATION.md)에 기록합니다.

## 개발·테스트

```sh
npm ci
npm run check
npm test
npm run build

cd backend
npm ci
npm run check
# 별도 테스트 DB: 스키마 생성·역할 생성이 가능한 테스트 전용 계정
# HOP_TEST_DATABASE_URL을 환경 변수로 설정한 뒤 실행
npm run test:ci
```

브라우저 통합 테스트는 [검증 안내](docs/VALIDATION.md)를 따릅니다. 자동화 테스트의 모델 fixture를 운영 환경에 사용하지 마세요.

중지: `docker compose down`. 일반 중지에 `--volumes`를 붙이면 DB 데이터가 제거되므로 사용하지 않습니다.
