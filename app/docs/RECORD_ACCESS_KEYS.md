# 기록 보관키

보관키는 완료된 기록 하나와 그 안의 대화 내용을 읽는 권한이다. 삭제 전용 키와 호환되지 않으며, 소유자 세션을 복원하거나 다른 기록 접근·수정·삭제를 허용하지 않는다.

- `POST /api/records/:id/access-key` (`{}`): 소유자 쿠키와 CSRF가 필요하다. `{access_key}`를 한 번 반환하며 기존 키를 교체한다.
- `DELETE /api/records/:id/access-key` (`{}`): 소유자 쿠키와 CSRF가 필요하다. 키를 해제하고 `{revoked:true}`를 반환한다.
- `POST /api/records/open-with-key` (`{access_key}`): 동일 앱 Origin이 필요하다. 쿠키와 무관하게 `{record}` 하나만 반환한다. 입력은 URL이나 클라이언트 저장소에 남기지 않는다.

32바이트 암호학적 난수를 base64url 43자로 발급하고 DB에는 SHA-256 해시만 저장한다. 키 조회는 보유기간을 연장하지 않는다. 소유자의 이용 중단 보유기간이 지나거나 기록 삭제·키 교체·해제가 이루어지면 조회는 `ACCESS_KEY_INVALID` 404다. 세션 쿠키 만료만으로는 키가 해제되지 않는다. 모든 API 응답에는 기존 `Cache-Control: no-store`가 적용된다.

기록 화면에서 키를 입력해 조회할 수 있다. 소유한 완료 기록 아래에서 키를 만들거나 해제한다. 키로 연 기록은 내 기록 목록에 추가되지 않고 키 관리 버튼도 제공하지 않는다. 기존 최종 카드 디자인은 유지한다.

검증: `TEST_DATABASE_URL`을 지정해 `node --test tests/record-access-key.test.js` 실행. 테스트는 별도 임시 PostgreSQL 스키마를 만들고 종료 시 제거한다.
