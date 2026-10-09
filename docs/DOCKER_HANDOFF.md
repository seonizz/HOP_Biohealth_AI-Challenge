# 같은 구성으로 서버에서 시연하기

Docker와 Compose가 설치된 서버에 소스와 비공개 `.env`를 옮긴 뒤 `docker compose up -d --build`로 실행합니다. 학습 모델 ID와 인증 키를 유지하고, 새 장비의 API 컨테이너에서 접근 가능한 모델 주소를 `MODEL_DOCKER_BASE_URL`에 지정합니다. `MODEL_BASE_URL`은 호스트에서 Node로 실행할 때의 주소입니다.

현재 Mac에서는 SSH 터널 `127.0.0.1:18080`에 Docker Desktop의 `host.docker.internal:18080`으로 접근합니다. 이 주소는 Mac의 터널에 해당하므로 다른 서버로 옮길 때 자동으로 같은 모델에 연결되지는 않습니다. 대상 장비에서도 모델 API 레퍼런스에 따라 SSH 연결을 준비하고 컨테이너에서 접근 가능한 비공개 주소를 설정합니다. Linux Docker에서 호스트 주소를 사용하는 경우 해당 주소와 호스트 게이트웨이 설정도 대상 장비에 맞춰야 합니다.

기본 Compose는 API와 DB 포트를 호스트의 `127.0.0.1`에만 열어 개인 시연을 제공합니다. 원격 서버에서도 화면을 로컬로 보려면 SSH 포트 전달을 사용할 수 있습니다.

```sh
ssh -L 9000:127.0.0.1:9000 user@server
```

브라우저는 `http://127.0.0.1:9000`에 접속합니다. `.env`의 `PUBLIC_ORIGIN`도 그대로 유지할 수 있습니다. 외부 공개 도메인으로 제공할 때는 해당 Origin과 HTTPS 프록시를 별도로 구성해야 합니다. 이번 요청에는 외부 공개와 운영용 동의 화면을 포함하지 않았습니다.

Docker 이름 있는 볼륨은 장비마다 따로 있습니다. 소스와 `.env`만 옮기면 새 DB가 만들어집니다. 기존 시연 기록도 이동하려면 PostgreSQL 덤프를 함께 옮기고 **기존 CONTENT_KEY**를 유지합니다. 실행 중인 API를 먼저 중지하면 덤프 중 상태가 계속 바뀌지 않습니다.

```sh
docker compose stop api
docker compose exec -T postgres pg_dump -U malssi -d malssi -Fc > malssi-demo.dump
# 대상 서버의 새 DB에 복원
docker compose exec -T postgres pg_restore -U malssi -d malssi --no-owner < malssi-demo.dump
docker compose up -d api
```

같은 장비에서는 쿠키가 유지되어 기존 익명 기록에 접근합니다. 다른 호스트/브라우저로 이동하면 익명 쿠키도 달라집니다. 따라서 DB 이동이 사용자 계정 동기화를 의미하지는 않습니다.

`.env`, DB 덤프와 볼륨은 Git에 넣지 않습니다. `docker compose down`은 데이터를 보존하고 `docker compose down -v`는 DB 볼륨을 제거하므로 일반 종료에는 `-v`를 붙이지 않습니다. 학습 모델 서버와 SSH 터널이 연결되어 있어야 추론할 수 있습니다.

질문은 `questions` 테이블에서 관리합니다. `002_questions.sql` 적용 때 기본 질문을 한 번 넣으며, 이후 수정·삭제는 재시작으로 되돌리지 않습니다. DB 볼륨과 `CONTENT_KEY`를 함께 보존하면 기존 상담의 질문 버전·답변·모델 이력이 유지됩니다. [질문 관리 명령](QUESTIONS.md).
