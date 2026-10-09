# ea9c607 메인 기능 서버 배포·검증 기록

2026-10-09 22:52 KST에 기존 Linux 서버의 8088 웹 주소를 새 메인 기능 연결본으로 전환했습니다. 프론트 기준은 PR #3 직전 `ea9c607519ce2269d8da14a166a7b99d7e287233`입니다.

## 실행 구성

| 항목 | 현재 값 |
| --- | --- |
| 브라우저 주소 | `http://localhost:8088` — 기존 SSH 터널 경유 |
| 서버 웹 | `127.0.0.1:8088`, 기존 Caddy 실행 파일 재사용 |
| 새 API | `127.0.0.1:19021` |
| 코드 | `/home/slim/choieram/ys/malssi-original-ui-backend-20261009-ea9c607` |
| 실행 상태·로그 | `/home/slim/choieram/ys/malssi-original-ui-state-20261009` |
| PostgreSQL | 기존 DB 서버에 독립 스키마 `malssi_handoff_original_ui_20261009` |
| 원본 모델 계약 | 명시적 `HOP_ORIGINAL_FRONTEND_MODEL_MODE=prototype` |
| 실제 추론·GPU | 실행하지 않음. 기존 모델 정지 상태 유지 |
| 기존 API·보관 정리 | 기존 9000·19020 API와 기존 정리 프로세스 유지 |
| 기존 원본 웹 디렉터리 | 보존. 새 Caddy 설정은 새 release의 `frontend/dist`만 제공 |

메인 기능과 미연결 기능은 [명세표](MAIN_FEATURE_CONNECTIONS.md)에 정리했습니다. 현재 가이드·임시 점수는 `ea9c607` 프로토타입의 서버 실행 결과이며 학습 모델의 실제 평가 결과가 아닙니다. 웹에서 기존 문구·화면을 바꾸는 표식이나 배너를 추가하지 않았습니다.

## 확인한 검증

- 원본 36개 참조 파일의 해시 대조 통과. 개행만 LF로 정규화하여 검사합니다.
- 실행 HTML은 원본과 비교해 Model 로딩 변경과 저장 어댑터 로딩 추가, 두 지점 외에는 같습니다.
- 프론트·원본 계약 테스트 8개, Node 24 구문 검사, TypeScript 검사와 빌드 통과.
- 격리 PostgreSQL에서 전체 백엔드 테스트 187개 통과, 건너뛴 테스트 없음.
- 로컬 및 실제 Linux 서버 검증 주소에서 브라우저 테스트 3개 통과: 30문항 완주·위험 안내·결과·서버 복원·삭제, 조건부 생략·필수 후속 질문, 원본 칼럼·소개·모바일 기본 조작.
- API·웹·새 보관 정리 서비스 실행 확인. `/health/service` 200 및 `ready:true` 확인.
- 기존 API·보관 정리 프로세스의 PID와 실행 상태 유지 확인.

배포 패키지 SHA-256은 `44309a1d0df77a3d082342c9fdf3cb56e7920399e51c9b64fc7e7c0aae7b7d6e`입니다. 실제 환경 파일과 키는 서버 상태 디렉터리에만 존재하며 패키지·Git에 포함하지 않았습니다.

## 서비스 관리

서버 `/home/slim/choieram/ys` 안에서 다음을 실행합니다. Node 경로와 서비스 제어기는 기존 검증 도구를 재사용합니다.

```bash
NODE=/home/slim/choieram/ys/hop_node_20261009/runtime/node-v24.19.0-linux-x64/bin/node
STATE=/home/slim/choieram/ys/malssi-original-ui-state-20261009
"$NODE" "$STATE/control/manage-services.mjs" status api web retention
```

후속 배포는 새 release에서 빌드·검증 후 서비스 관리 도구로 적용합니다. 서버 모델 시작이나 전역 설정·기존 저장소 덮어쓰기는 이 배포 절차에 포함하지 않습니다.

## 이전 웹으로 복구

새 웹만 종료한 뒤 보존한 기존 웹을 시작하면 같은 8088 주소에 이전 원본 정적 화면이 다시 제공됩니다. DB 초기화·삭제가 필요하지 않습니다.

```bash
NODE=/home/slim/choieram/ys/hop_node_20261009/runtime/node-v24.19.0-linux-x64/bin/node
"$NODE" /home/slim/choieram/ys/malssi-original-ui-state-20261009/control/manage-services.mjs stop web
"$NODE" /home/slim/choieram/ys/malssi-fullstack-state-20261009/control/manage-services.mjs start web
```
