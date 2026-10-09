# 말씨 — 원본 프런트 복원

PR #3 직전 프런트 **ea9c607**을 frontend/에 복원했습니다. 원본 HTML·JavaScript·CSS·마스코트 36개 파일을 그대로 사용합니다.

| 항목 | 현재 화면의 동작 |
| --- | --- |
| 질문 | 원본 30문항, 순서·필수·건너뛰기·분기·후속 질문·직전 질문 돌아가기 |
| 기록 | localStorage의 malssi.records.v1, 같은 브라우저·같은 출처에서 조회·삭제 |
| 결과 가이드 | 원본 mockModel.js의 임시 규칙으로 생성 |
| 위기 신호 | 대화를 중단하지 않고 결과 화면에서 안전 안내 |
| 칼럼 | 원본 목록·분류·요약·원문 링크 |
| 화면 | 원본 디자인·마스코트·서비스 소개·기록 화면 |

실제 학습 모델의 평가가 아니라 원본 프로토타입입니다. 서버 24문항, 즉시 안전 보류, DB 저장, B→A 이중 모델 처리는 이 화면의 실행 경로에 연결하지 않습니다. 진행 중 대화의 새로고침 복원도 원본에 없으므로 추가하지 않았습니다.

## 실행

원본처럼 frontend/index.html을 열거나 정적 서버로 frontend/를 제공할 수 있습니다. 브라우저의 localStorage 정책에 따라 파일 직접 열기보다 정적 서버 사용을 권장합니다. 기존 기록을 보려면 접속 주소의 호스트·포트도 같아야 합니다.

빌드: npm ci --ignore-scripts → npm run check → npm test → npm run build.

빌드 결과는 frontend/dist/입니다. 이전 빌드가 있으면 삭제하지 않고 frontend/dist.previous-시간/에 보관합니다. 통합 때 작성된 frontend/src/ 및 css/app.css는 빌드에 포함하지 않습니다.

기존 Docker 배포도 사용할 수 있습니다: npm run setup -- --origin http://localhost:8080 후 docker compose up --build -d. http://localhost:8080 에서 **말씨와 시작하기**를 누르면 가입 없이 원본 대화가 시작됩니다.

## 백엔드와 검증

backend/의 API·PostgreSQL·마이그레이션·모델 작업자는 보존했습니다. 복원한 화면은 API에 답변을 전송하지 않습니다. 백엔드 24문항과 즉시 안전 보류는 기존 API 클라이언트에만 적용됩니다. B→A 이중 모델은 backend/docs/DUAL_MODEL_PIPELINE_DESIGN.md의 설계이며 이번 복원에서 구현·활성화하지 않았습니다.

브라우저 검증: MALSSI_TEST_URL 환경 변수로 정적 서버 주소를 지정하고 npm run test:e2e를 실행합니다. 원본 36개 파일의 해시 일치, 30문항 계약, 필수·분기·이전 질문, 결과 가이드·위기 안내, 기록 조회·삭제·새로고침, 칼럼과 모바일 화면을 검사합니다.

복원 근거는 [복원 기록](docs/FRONTEND_RESTORATION.md)에 있습니다. [이전 README](docs/PR3_README.md), [배포 안내](docs/DEPLOYMENT.md), [통합 기록](docs/INTEGRATION.md)은 PR #3 당시 서버 통합본의 자료입니다.
