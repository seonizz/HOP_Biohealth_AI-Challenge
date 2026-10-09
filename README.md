# 말씨 — ea9c607 원본 UI와 메인 기능 연결

PR #3 직전 `ea9c607519ce2269d8da14a166a7b99d7e287233`의 화면·문구·30문항 흐름을 그대로 실행합니다. 시작 → 원본 질문 → 결과 가이드 → 기록 보기·삭제의 메인 기능만 우선 백엔드에 연결했습니다.

원본 화면 컴포넌트·CSS·마스코트·질문 파일은 해당 커밋과 같습니다. HTML에는 모델 API 어댑터와 기록 저장 어댑터의 로딩만 추가합니다. `frontend/src/`의 재작성 UI와 24문항 화면은 배포 빌드에서 제외합니다. 기존 브라우저 기록은 보존하며 새 완료 결과를 PostgreSQL에도 암호화 저장합니다.

이번 서버 배포는 `HOP_ORIGINAL_FRONTEND_MODEL_MODE=prototype`을 명시해 원본 프로토타입 가이드를 서버에서 실행합니다. 실제 모델 추론과 매 턴 B→A 파이프라인은 이번 메인 UI에 연결하지 않았습니다. 연결·미연결 기능과 병행 작업 지점은 [명세표](docs/MAIN_FEATURE_CONNECTIONS.md)를 참고하십시오.

## 구조

- `frontend/js/components/`, `frontend/css/`, `frontend/assets/`: ea9c607 원본 UI.
- `frontend/js/backend/`: 별도 API·저장 어댑터.
- `backend/src/original-frontend.ts`: 원본 계약, 소유권 검사와 암호화 저장.
- `backend/data/original-*`: ea9c607 질문·프로토타입 모델 스냅샷.
- `backend/src/v2/`: 기존 기능과 모델 워커. 후속 병행 작업 대상으로 보존.

## 실행·검증

Node 24.19 이상을 사용합니다.

```sh
npm ci --ignore-scripts
npm ci --prefix backend --ignore-scripts
npm run check
npm test
npm run build
npm run check --prefix backend
```

기존 Linux 서버의 웹 주소는 `http://localhost:8088`이며 SSH 터널로 접근합니다. 운영 중 API와 데이터는 그대로 두고 새 API는 19021 포트와 독립 스키마를 사용합니다. 배포 기록은 [서버 배포·검증 기록](docs/ORIGINAL_UI_DEPLOYMENT.md)에 정리합니다.

현재 서버 기록은 기존 임시 브라우저 계정의 24시간 세션 정책을 사용합니다. 원본 localStorage 기록은 원래와 같이 유지됩니다. 실제 모델 연결은 명시적으로 `local` 모드를 설정한 후 검증해야 하며, 모델 오류를 프로토타입 결과로 자동 대체하지 않습니다. 기존 Vercel 주소는 이번 Linux 서버 배포 대상에 포함하지 않습니다.
