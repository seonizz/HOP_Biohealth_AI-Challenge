# 통합 검증 기록

2026-10-09, Windows 호스트 + Docker Linux 컨테이너 + 실제 PostgreSQL 16.15에서 검증했습니다. 모델은 자동 검증 전용 합성 HTTP 서버를 사용했습니다.

| 검증 | 결과 |
| --- | --- |
| 백엔드 TypeScript `tsc --noEmit` | 통과 |
| 백엔드 단위·API·실제 PostgreSQL 회귀 | **174개 통과, 실패 0, skip 0** |
| 프론트 문항 직렬화·한국어/emoji 길이·배타 보기·복합 답변 | **4개 통과** |
| Docker 웹·백엔드 이미지 빌드 | 통과 |
| 제한 DB 역할·마이그레이션·API·worker·retention·Caddy 기동 | 통과 |
| Chromium 브라우저 E2E | **3개 통과**: 전체 기능 흐름·오류 복구·모바일 |
| 웹, API/DB service health, 안전 도움 | HTTP 200 |
| 공개 readiness | HTTP 503: 원본 draft로 의도된 출시 차단 |
| 프로덕션 의존성 보안 감사 (`npm audit --omit=dev`) | 보고된 취약점 0개 |

## 브라우저 검증 내용

1. 실제 가입 → 필수/선택 동의 → 프로젝트/대화 생성 → 호칭/관계/선택형 답변 → 새로고침 복원 → 큐/worker/합성 모델의 검증된 가이드 → 계획 선택 → 후속 경험 저장 → 기억 조회 → 프로젝트 삭제 → 재인증 계정 삭제.
2. 서버는 저장했지만 브라우저 응답만 유실된 상황 → **동일 UUID와 동일 본문**으로 재전송 → 답변 중복 없음 → 호칭 정정 → 안전 신호 즉시 보류 → 새로고침 후 보류 유지 → 직접 작성한 안전 확인으로 재개 → 보관 동의 철회 후 서버 대화 404.
3. 390×844 모바일 레이아웃의 가로 넘침 없음, 비로그인 안전 도움 모달 동작. 데스크톱 가이드 및 모바일 홈 스크린샷을 별도로 확인했습니다.

## 재현

```sh
npm ci
npm run check
npm test
npm run build
npx playwright install chromium
npm run setup
docker compose -p malssi-e2e -f compose.yaml -f compose.e2e.yaml --profile model up --build --wait --wait-timeout 180
npm run test:e2e
docker compose -p malssi-e2e -f compose.yaml -f compose.e2e.yaml --profile model down --volumes
```

이미 `.env`가 있으면 `setup`을 다시 실행하지 않습니다. E2E 구성은 `localhost:18080`, 별도 Compose 프로젝트·DB 볼륨과 합성 모델을 사용합니다. `down --volumes`는 이 테스트 프로젝트에만 사용하며 운영 DB에 사용하지 않습니다. Linux CI에서 브라우저 시스템 의존성은 `npx playwright install --with-deps chromium`으로 준비합니다.

백엔드 전체 검증은 별도 테스트 DB를 만들어 `HOP_TEST_DATABASE_URL`로 지정한 뒤 `backend` 폴더에서 `npm run check`와 `npm run test:ci`를 실행합니다. 테스트마다 임의 스키마와 역할을 만들고 정리하므로 테스트 전용 관리자 계정을 사용합니다. 운영 DB는 PUBLIC CONNECT를 제한하므로 시험용 역할을 만드는 전체 회귀 테스트는 운영 DB 대신 별도 테스트 DB에서 실행합니다.

실제 GPU 모델의 지연·출력 품질, 공개 DNS/TLS, 외부 백업 복구, 원본 명세의 콘텐츠/안전 인수 평가 완료를 이 결과로 주장하지 않습니다.
