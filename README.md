# 말씨 — 원본 디자인과 백엔드 통합

원본 프런트의 색상, 글꼴, 마스코트와 화면 구성을 유지하면서 말씨 v2 API와 PostgreSQL에 연결한 통합본입니다. 공개 HTTPS 시연 주소는 [malssi-demo.vercel.app](https://malssi-demo.vercel.app)입니다. 첫 화면에서 **가입 없이 체험하기**를 누르면 임시 계정으로 바로 시작합니다.

실행 화면은 `frontend/src/`의 API 클라이언트를 사용합니다. 질문과 답변, 프로젝트와 기록은 서버의 24문항 카탈로그와 Neon PostgreSQL에 저장되며, 새로고침 후에도 복원됩니다. 최신 원본 칼럼 화면과 자체 호스팅 글꼴도 반영했습니다. `frontend/js/`는 원본 프런트의 참조용 소스이며 배포 빌드에 포함하지 않습니다. 브라우저의 `localStorage`에는 칼럼 읽음·담기 표시만 저장하고 대화 원문이나 인증 토큰은 저장하지 않습니다.

실제 모델 추론과 GPU 작업은 시연 배포에서 꺼져 있습니다. B→A 이중 모델의 턴별 API·워커·DB·화면 경로는 [실행 안내](backend/docs/dual-model/RUNTIME.md)에 구현되어 있으며, 확인된 학습 체크포인트와 별도 워커가 설정되기 전에는 평가 불가 상태만 기록합니다. 예시 가이드는 고정된 가상 예시임을 표시하며 사용자가 입력한 답변을 분석하지 않습니다. 원본의 30문항과 임시 점수·가이드를 실제 API로 혼동하지 않도록 서버의 24문항 계약을 사용합니다. 원본 자료와 변경 경위는 [프런트 복원 기록](docs/FRONTEND_RESTORATION.md), 운영 구성은 [Vercel 배포 안내](docs/vercel-deployment.md)를 참고하세요.

## 구조

모델의 입력·출력 HTTP 계약과 서버 실행 설정은 [모델 API 안내](backend/docs/dual-model/MODEL_API.md), [OpenAPI 명세](backend/openapi-model.json)에 있습니다. B 평가와 A 응답은 같은 체크포인트를 사용하며 실제 대화 워커에 연결됩니다. 모델 API 자체는 추론 서버나 GPU를 시작하지 않습니다.

- `frontend/`: 원본 디자인 자산과 백엔드 연동 화면
- `backend/`: 인증, 말씨 v2 API, PostgreSQL 마이그레이션, 모델 작업자
- `api/`: Vercel Function 어댑터와 일일 보관 정리
- `scripts/`: 프런트 빌드·검증 도구
- `deploy/`, `compose.yaml`: 로컬 Docker 배포

## 로컬 실행과 검증

Node.js 24.19 이상과 Docker Compose를 사용합니다.

```sh
npm ci
npm run check
npm test
npm run build
npm run setup -- --origin http://localhost:8080
docker compose up --build -d
```

브라우저에서 `http://localhost:8080`을 여십시오. 기본 시연 계정은 24시간 후 접속이 만료되고, 설정에서 즉시 삭제할 수 있습니다. 배포에서는 Neon의 `malssi-demo` 프로젝트가 DB를 관리합니다. 실제 개인정보 대신 가상 사례를 입력해 주세요.

공개 출시 전에는 문항의 권리·콘텐츠 검토, 실제 모델 품질 검증, 백업·복원 훈련, 분산 환경 요청 제한과 모니터링이 필요합니다.
