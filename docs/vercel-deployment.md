# Vercel HTTPS 시연 배포

현재 공개 시연 주소는 **[https://malssi-demo.vercel.app](https://malssi-demo.vercel.app)**입니다. Vercel은 `*.vercel.app` 공유 주소와 HTTPS를 제공합니다. 이 구성은 정적 프런트엔드를 Vercel CDN에서 제공하고, 같은 주소의 `/api/auth/*`, `/api/v2/*`, `/health/*`를 Node.js Function에 연결합니다. PostgreSQL은 별도 Neon 무료 프로젝트 `malssi-demo`(`icy-star-34398366`)를 사용합니다. 가입 없는 시연은 가상 사례와 초안 답변을 보여주며 실제 모델 추론은 꺼져 있습니다.

## 1. Neon 데이터베이스 준비

[Neon Console](https://console.neon.tech/)에서 무료 PostgreSQL 프로젝트를 생성하고 **direct(비풀링) owner connection URL**을 받으십시오. 이 URL은 마이그레이션에만 사용하고 Vercel Function의 `DATABASE_URL`로 넣지 마십시오. Vercel Marketplace 연동이 owner URL을 자동으로 주입할 수 있으므로 여기서는 별도 Neon 프로젝트를 사용합니다.

로컬에서 이 저장소의 `.runtime/neon-owner.env`에 `HOP_MIGRATION_DATABASE_URL=postgresql://...` 한 줄을 저장합니다. `.runtime/`은 Git에서 제외됩니다. Node 24와 백엔드 패키지를 준비한 후 다음을 실행합니다.

```sh
npm ci --prefix backend
node --env-file=.runtime/neon-owner.env backend/scripts/provision-neon.mjs
```

스크립트는 마이그레이션을 적용하고 테이블 소유자가 아닌 `hop_app` 실행 역할을 만든 뒤 권한과 RLS 조건을 확인합니다. 성공하면 `.runtime/vercel-secrets.json`에 `DATABASE_URL`, `HOP_CONTENT_KEY`, `CRON_SECRET`가 저장됩니다. 이 파일과 owner URL을 GitHub에 올리거나 채팅에 붙여 넣지 마십시오. 재실행 시 같은 암호화 키와 실행 역할 암호를 유지합니다.

## 2. Vercel 프로젝트 배포

Vercel의 `seonizz/malssi-demo` 프로젝트는 이 저장소 루트에서 CLI로 생성하고 운영 배포했습니다. Node.js는 24.x이며 `vercel.json`이 빌드 명령, `frontend/dist` 출력, API 재작성, 일일 정리 작업을 설정합니다. 현재 GitHub PR #4가 열려 있으므로 Git 자동 배포는 연결하지 않았습니다. PR을 `main`에 병합한 뒤 Vercel 프로젝트의 Git 설정에서 저장소를 연결하면 이후 변경을 자동 배포할 수 있습니다. 그 전에는 저장소 루트에서 `vercel deploy --prod`로 배포합니다.

Vercel 프로젝트의 **Production 환경변수**에 `.runtime/vercel-secrets.json`의 세 값을 등록합니다. 값에 따옴표를 추가하지 마십시오. `HOP_PUBLIC_ORIGIN`은 Vercel의 `VERCEL_PROJECT_PRODUCTION_URL` 시스템 변수가 노출되어 있으면 자동으로 `https://...`로 설정됩니다. 이 변수를 사용할 수 없다면 발급된 공유 주소를 `HOP_PUBLIC_ORIGIN=https://프로젝트.vercel.app` 형식으로 직접 등록하십시오. 환경변수를 변경한 후 재배포합니다.

배포 완료 후 `https://malssi-demo.vercel.app/health/ready`가 `ready:true`를 반환하고, 첫 화면에서 가입 없이 시연을 시작할 수 있는지 확인합니다. 시연 모드가 아닌 환경에서는 초안 카탈로그가 승인 전이므로 이 경로가 503을 반환합니다. 브라우저 개발자 도구에서 인증 쿠키에 `Secure`가 붙는지 확인합니다.

## 3. DB 운영과 무료 플랜 제한

스키마, 저장 용량, 역할, 복원은 [Neon Console의 `malssi-demo` 프로젝트](https://console.neon.tech/app/projects/icy-star-34398366)에서 관리합니다. Vercel에는 제한된 `hop_app` 역할의 실행 URL과 암호화 키만 환경변수로 보관합니다. DB owner URL은 배포 시 사용하지 않으며 별도 보관합니다. Neon 무료 플랜은 현재 프로젝트당 1GB, 복원 창 6시간입니다. 장기 백업이 필요한 운영 서비스에는 별도 백업 또는 유료 플랜이 필요합니다.

시연 계정은 생성 후 24시간이 지나면 접근이 차단됩니다. Vercel Hobby Cron은 하루 한 번만 실행할 수 있고 실행 시각에도 최대 약 1시간 오차가 있으므로, 물리적 데이터 삭제는 계정 만료 시점보다 늦을 수 있습니다. 엄격한 25시간 삭제 보장이 필요한 운영 환경에서는 더 빈번한 정리 작업이 가능한 실행 환경을 사용해야 합니다.

공개 시연에서는 **가상 사례만** 입력하십시오. 실제 사용자 데이터 수집 전에는 모델·문항 검토, 백업과 복원 훈련, 데이터 삭제 증빙, 분산 환경의 요청 제한과 로그 모니터링, 개인정보·보안 검토가 더 필요합니다.
