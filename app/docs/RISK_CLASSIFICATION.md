# 기관 연결을 위한 모델 분류 계약

작성일: 2026-10-18. 사용자 지정: 모델의 분류 구성을 이 작업에서 담당하고 UI/UX는 다른 에이전트가 담당한다. 서비스 화면에는 이용에 필요한 안내만 표시하고 모델·검증 상세는 이 문서에 둔다. 사용자 최신 우선순위는 속도보다 품질이다.

## 구현 범위와 현재 상태

`src/risk-classification.js`는 주변인이 전한 당사자 정보를 근거 신호로 분류한다. 모델이 신호의 대상·시점·부정·정보 출처를 구조화하고, 서버의 고정 규칙이 필요한 다음 행동으로 변환한다. 진단, 자살 확률, 임상 척도 점수, 미래 위험의 저·중·고 예측을 산출하지 않는다.

새 분류 모듈은 기존 질의응답 및 최종 결론 생성 경로와 분리되어 있다. 이 분류 기능을 위해 기존 최종 결론의 프롬프트나 생성 예산을 변경하지 않았다. 이전 최종 결과 시험에는 이 모듈을 끼워 넣지 않았으며, 해당 시험은 종료 후 정상 서비스로 복구했다. 실제 모델 정확도 검증 및 운영 연결 전까지 임상 검증 완료나 서비스 활성화로 표시하지 않는다.

기존 HTTP 경계는 [REFERRAL_GUIDANCE.md](REFERRAL_GUIDANCE.md)를 따른다. 동일한 기관의 이름·전화·예약 주소를 새 레지스트리에 복제하지 않는다. 기관별 적합성 정보는 등록된 ID에 결합하고 실제 기관 선정은 서버가 수행한다. 모델에는 연락처와 기관 선택 권한을 주지 않는다.

## 분류와 공개 안내의 대응

| 내부 `action` | HTTP `urgency` | 다음 행동 |
| --- | --- | --- |
| `emergency` | `immediate` | 현재 보고된 즉각적 위험에 대한 긴급 대응. 일반 상담 예약으로 대체하지 않음 |
| `prompt_assessment` | `soon` | 가능한 빠른 전문가 확인 |
| `routine_support` | `planned` | 확인된 지원 요구에 맞는 일반 상담 연결 |
| `insufficient_information` | `undetermined` | 정보·검토 부족을 알리고 전문가 문의 또는 필요한 정보 확인 |

이 네 상태는 **이 제품의 미검증 연결 정책**이다. `routine_support`는 안전 판정이나 치료 제외의 근거가 아니다. `insufficient_information`은 위험 없음이 아니다. 기관이 없거나 지역·연령을 모른다는 이유로 이미 확인한 긴급 대응 우선순위를 낮추지 않는다.

- 명시된 현재 적극적 자살 사고, 진행 중 자해·신체 응급·구체적인 현재 폭력은 긴급 경로의 후보다. 계획이나 수단을 모른다는 이유만으로 제외하지 않는다.
- 수동적 죽음 희망, 불확실한 자해 우려, 과거 자해 보고는 일반 상담으로 자동 처리하지 않고 전문 평가 경로로 보낸다. 과거 사건만으로 현재 응급상황이라고 단정하지 않는다. 과거 사건의 일괄 전문 평가 우선 처리는 보수적인 제품 규칙이며 추가 전문가 검토 대상이다.
- 부정과 가정은 실제 발생 보고로 승격하지 않는다. 부정의 범위는 해당 명제에 한정한다. 계획을 부정했다고 사고·행동까지 부정한 것으로 해석하지 않는다.
- 주변인 자신의 위험은 `patient_action`에 넣지 않는다. 누구에게든 현재 응급상황이 보고되면 전체 `action`은 보존하고 `emergency_people`로 대상 범위를 따로 남긴다. UI의 `subject:patient`는 평가 요청의 대상이며 실제 위험 행위자의 단정 문구로 사용하면 안 된다.

## 입력, 원문과 결과의 결속

호출자는 소유자가 확인된 최신 서버 `context`, 실제 `intakeId`, `revision`을 제공한다. 모델이 작성한 이전 메모리를 원문의 대체물로 사용하지 않는다.

```js
const result = await classifyForReferral(gateway, context, {
  intakeId, revision, requestId, signal,
  existingUrgent: false // 서버가 이미 확인한 현재 긴급 신호만 true; 클라이언트 입력 금지
});
assertCurrentTriage(result, latestContext, {intakeId, revision});
```

- 한 문항의 원문·직접 입력·후속 정정은 전체 `components` 묶음으로 제공한다. 검색 결과나 위험 단어 주변 일부 문장으로 줄이지 않는다. 입력이 모델 한도를 넘으면 실패를 반환하며 조용히 자르지 않는다.
- `triage_…` 참조 ID는 저장 문항의 주체, 문항 ID, 답변 상태, 전체 components의 해시에 결속된다. 인용을 생성하거나 단어만 보고 근거를 골라 붙이지 않는다.
- `record_subject`는 저장 문항의 소유자다. 모델의 `person`은 실제 말·행동의 대상이다. 두 값을 동일시하지 않는다.
- `unknown` 답변은 정보 공백 판단에 사용하며 발생·부정·추정 신호의 근거로 선택할 수 없다. “모름” 선택과 별도의 구체적 직접 입력이 함께 저장된 경우는 기존 답변 정규화 규칙을 사용한다.
- `snapshot_id`는 intake·revision·정규화한 전체 근거에 결속된다. 답변 정정, 소유 대화 변경, 리비전 변경 뒤에는 이전 결과를 재사용하지 않는다. HTTP 경계도 호출 종료 시 원래 소유자의 최신 대화·리비전을 다시 검사한다.
- raw 모델 입력과 결과의 `findings`는 서비스 UI용 데이터가 아니다. `publicTriageSummary`는 행동·상태 등 제한된 필드만 반환한다. 운영 로그에 원문을 기록하지 않는다.

모델 출력은 `signals`와 `unknowns` 두 필드다. 각 신호는 `code`, `person`, `assertion`, `timeframe`, `report_type`, `statement`, `source_ids`를 가진다. `report_type`은 직접 관찰, 전해 들은 당사자의 말, 다른 사람의 전언, 출처 불명을 구별한다. 이 분류도 주변인의 보고에 대한 해석이며 임상적으로 확인된 사실이라는 뜻이 아니다.

## 검토, 실패와 취소

일반 상황은 동일 원문을 두 번 분류한다. 두 번째 요청에는 첫 번째 결과를 보여 주지 않는다. 같은 모델의 반복 호출이므로 독립적인 임상 전문가 평가나 서로 독립적인 모델의 검증을 뜻하지 않는다.

- 현재 응급 신호가 첫 요청에서 확인되면 두 번째 요청을 기다리지 않고 `expedited_emergency`와 검토 필요 상태로 반환한다.
- 두 결과가 다르면 높은 대응 우선순위를 보존한다. 일반 상담과 정보 부족이 엇갈리면 정보 부족으로 보류한다. 전문 분야 기관 추천은 합의된 경우에만 허용한다.
- 현재 안전·행위자·시점·의도/계획·수단·최근 행동의 중요한 공백이 명시되면 두 분류가 같아도 일반 상담 확정과 전문 분야 추천을 보류한다. 이미 확인한 긴급/전문 평가 우선순위는 유지한다. 이는 보수적인 제품 정책이며 확인 질문의 충분성도 별도 검증한다.
- 응답 오류·형식 실패·취소는 안전이나 일반 상담 판정으로 바꾸지 않는다. 첫 요청에서 이미 확인한 전문 평가 필요성은 검토 실패 뒤에도 내부 결과에 남는다.
- `AbortSignal`은 실제 gateway 작업의 controller에 전달하고, 취소된 작업에서 두 번째 요청을 시작하지 않는다. 모델 작업 deadline은 호출자와 gateway가 함께 관리한다.
- 기존 긴급 신호를 전달할 때 `assessment.safety:false`나 `guide.top`을 새 분류에 사용하지 않는다. 현재 snapshot에 대해 서버가 이미 확인한 긴급 신호만 우선권을 갖는다.

## HTTP 경계와의 연결 시 확인할 사항

`createApp({referralProvider})` 주입 지점을 사용한다. 이 분류를 일반 답변마다 추가 호출하는 것이 아니라 별도의 도움 연결 요청에 연결한다. 캐릭터 선택은 모델에 전달하지 않는다.

1. HTTP 입력의 `intake_id/revision/context`를 그대로 내부 분류 snapshot에 결속한다.
2. 모델 측 `triage_…`와 HTTP 측 `safety_…`는 다른 ID다. 같은 문항 주체·ID·전체 components인지 검증한 뒤 대응하는 `safety_…`만 반환한다. 접두사만 치환하지 않는다.
3. `reviewed`는 모델이 생성하는 필드가 아니다. provider가 두 분류의 일치와 남은 검토 필요 상태를 확인해 정한다. 임상 검토 완료를 뜻하지 않는다.
4. 2026-10-18 서버 계약 확장에 따라 `reviewed:false`의 `soon`을 유지하고 `planned`만 `undetermined`로 보류한다. `immediate`도 미검토 상태에서 유지한다.
5. 현재 HTTP 기본 timeout은 20초, 최대 120초다. 실제 모델의 두 번 분류가 이 안에 끝난다는 검증은 없다. 품질을 위해 출력을 줄이거나 검토를 생략하는 해결은 하지 않는다. 실제 처리량에 맞춘 비동기 작업/대기 계약 또는 충분한 deadline을 API 담당자가 정해야 한다.
6. 서버가 추가한 `safety_alert:{urgency,subjects,evidence_source_ids}`에 동의한다. `patient_action`은 당사자 urgency로, 주변인·다른 사람·행위자 불명의 심각한 우려는 별도 alert로 전달한다. 긴급 대응과 빠른 전문가 확인 모두 보존한다.
7. 안내 및 기관 선택은 당사자 urgency와 alert의 높은 우선순위를 사용한다. 실제 행위자는 근거 없이 당사자로 표시하지 않는다. `triage_…`를 접두사만 바꿔 `safety_…`로 반환하지 않는다.
8. `buildContext`에는 기존 `state.safetySignal`이 없다. 운영 연결에는 서버가 검증한 `existing_safety:{urgent:boolean,evidence_source_ids:string[]}` 입력이 추가로 필요하다. true인 경우 현재 sources에 대응하는 근거가 최소 하나 있어야 하며, 대상이 확인되지 않으면 `unclear` alert로 보존한다. 브라우저 요청이나 과거 결과에서 무조건 복사하지 않는다. 서버 timeout/실패 처리에서도 이미 확인한 긴급 신호를 잃지 않도록 경계에서 보존해야 한다.

## 지정 기관의 적합성

사용자는 2026-10-18 지정 목록이 없다고 답했다. 이에 공식 공공 창구 4곳을 기본 후보로 구성했다. 기관명·전화·예약 링크는 기존 `referral-directory.js`와 단일 `seeds/referral-institutions.json`에만 두고, ID별 자격은 `seeds/referral-eligibility.json`에 분리한다. 지역별 실제 상담센터나 민간기관은 임의 등록하지 않는다. 이 등록은 제휴·예약 보장·상담 접수 완료를 의미하지 않는다.

모델에게 기관명을 생성시키지 않고, 서버에서 기관 ID별 업무 범위와 확인된 조건을 사용한다. 필요한 조건은 국가·관할 지역, 수용 연령, 주변인 상담 수용 여부, 실제 상담 분야, 긴급 대응 가능 여부와 운영 시간, 공식 출처 및 확인 유효기간이다. 모르는 연령·지역은 가족관계나 IP로 추정하지 않는다.

정확히 맞는 기관이 없으면 미연결 상태와 필요한 정보를 반환한다. 실제 수용 여부는 기관에 확인해야 하며, 명단에 올라 있다는 이유만으로 긴급 대응 기관으로 인정하지 않는다. 기관 연락은 사용자 동작으로 열리는 정적 링크만 제공한다. 분류 결과만으로 상담 원문을 전송하거나 예약을 확정하지 않는다.

```js
const routing = routeInstitutions(result, {
  institutions: directory.list().institutions,
  eligibilityById // 등록 기관 ID별 승인된 자격 정보; 연락처는 넣지 않음
}, {
  country, region, age, requester: 'supporter', asOf,
  effectiveUrgency // HTTP 계층이 실제 공개할 값; 필요할 때만 전달
});
```

`eligibilityById[id]`의 필수 키는 `capabilities`, `country`, `regions`, `nationwide`, `min_age`, `max_age`, `accepts_supporter`, `official_source_url`, `valid_until`, `availability`다. 확인일은 기존 기관의 `last_verified_on`을 재사용한다. `country/region/age`를 모르면 `null`을 전달한다. `asOf`는 서버가 정한 현재 기준 날짜다. 기관 ID만 반환하고 연락처는 기존 디렉터리에서 읽는다. 기존 HTTP 응답 한도는 최대 20개이므로 선택 ID는 최대 20개로 전달한다.

기본 후보에는 `signal_codes`와 `matches_unknown`을 추가해 업무 범위를 제한한다. 자살·자해 전문 상담을 일반적인 정보 부족에 무조건 추천하지 않고, 의료 응급과 폭력 대응을 구분한다. 응급 시에는 실제 현재 응급을 만든 신호만 기관 범위 비교에 사용한다. 과거 폭력 언급만으로 현재 신체 응급의 연결 기관을 경찰로 바꾸지 않는다. 확인한 한국 내 서비스에 연결하려면 국가 KR이 명시적으로 확인되어야 한다.

| ID | 담당 범위와 연결 정책 | 공식 확인 근거 |
| --- | --- | --- |
| `kr-mental-health-15770199` | 전국 정신건강 상담·정보·기관 안내. 일반 지원과 정신건강 전문 확인, 내용 부족 시 문의 후보 | [보건복지부 운영 안내](https://www.mohw.go.kr/menu.es?mid=a10706040100), [보건복지상담센터 담당 분야 안내](https://www.129.go.kr/109) |
| `kr-suicide-prevention-109` | 자살·자해 관련 전문 상담 후보. 일반 상담 전체나 출동기관으로 확대하지 않음 | hotline 조회와 [공식 사이트](https://www.129.go.kr/109?oai_link_source=model_response_hotline) |
| `kr-emergency-medical-119` | 현재 신체 응급·자해 등 즉각적 구조·구급 도움 | [소방청 119 서비스](https://www.nfa.go.kr/nfa/news/pressrelease/press/?cntId=1851&mode=view), [응급의료 신고 안내](https://www.nfa.go.kr/nfa/news/pressrelease/explanation/?cntId=44&mode=view) |
| `kr-police-112` | 진행 중 폭력 등 즉각적 경찰 도움 | [경찰청 긴급신고 안내](https://ecrm.police.go.kr/minwon/main), [112 사건 범위](https://www.police.go.kr/www/open/publice/publice0203.jsp) |

기본 후보는 전국 공공 상담·신고 창구로 연령 제한 없이 문의 가능한 범위만 등록한다. 개별 치료·입소·지원사업의 나이·거주 자격까지 보장하지 않는다. 기관 정보 확인일은 2026-10-18이며 `valid_until:2027-01-16`은 90일 후 다시 확인하도록 정한 제품 관리 정책이다. 기관의 실제 운영 종료일이 아니다. 공식 소개 페이지를 예약 링크로 잘못 표시하지 않도록 기본 후보의 `booking_url`은 null이다.

`createModelReferralProvider`의 연결 어댑터는 모델 gateway·기관 자격·서버 소유 `resolveRoutingContext`를 명시적으로 주입해 사용한다. 이 함수는 모델을 자동 활성화하지 않는다. resolver는 실제 위험 대상의 국가·지역·나이·문의자를 이미 저장된 정보에서 동기적으로 제공해야 하며, 주변인 위험에 당사자의 나이를 재사용하면 안 된다. 외부 조회를 기다리는 Promise는 허용하지 않는다. 서버의 `existing_safety` 입력이 없으면 호출 전에 거절한다. 새로운 서버 입력·실제 모델 의미 평가·처리시간에 맞는 요청 계약 확인 전에는 활성화하지 않는다.

모델이 전혀 분류하지 못한 경우는 일반적인 정보 부족 결과로 바꾸지 않고 기존 HTTP `model_unavailable` 경로로 전달한다. 반면 분류 완료 후 자격 정보·기관 설정 확인만 실패하면 확인된 대응 우선순위와 alert를 보존하고 기관 ID를 비운다. 이때 내부 진단에 `REFERRAL_ROUTING_UNAVAILABLE` 고정 코드만 남기며 대화·오류 원문·stack은 기록하지 않는다. 진단 함수의 동기/비동기 실패도 응급 안내를 없애지 않는다. 일반적인 적격기관 없음과 설정 오류를 진단에서 구별한다.

현재 목록에는 별도 중독 전문 상담기관과 학대·방임 전문기관이 없다. 일반 중독 우려를 확인했다고 정신건강 전화의 역량을 중독 전문 상담으로 바꾸지 않는다. 해당 전문 범위에 맞는 기관이 없으면 빈 목록을 반환한다. 심각하거나 정보가 부족한 정신건강 우려의 전문 확인 경로와 구분한다.

응급 대응에는 `immediate` 지원, `emergency_response` 역량, `availability:always`, 실제 전화 액션이 모두 필요하다. 미검토·정보 부족·빠른 평가 상태는 `crisis_assessment` 기관만 대상으로 삼는다. 현재 API가 미검토 결과를 `undetermined`로 보류하는 경우에도 그 긴급성에 맞는 기관만 선택한다. `effectiveUrgency`로 응급을 낮추거나 보류 상태를 일반 상담으로 바꿀 수 없다.

## 검증과 학습 기준

단위 검사는 코드·출처 계약 검증이며 모델의 의미 이해 정확도 검증이 아니다. 현재 테스트는 합성 응답을 사용하고 외부 모델을 호출하지 않는다. 실제 모델의 정확도, 기존 품질 보존, 임상 타당성이 입증되었다고 보고하지 않는다.

2026-10-18 구현 검증: 새 분류 27개와 기관 연결 17개, 기존 출처·기관 경계 검사까지 합계 81개가 통과했다. `npm run check`도 통과했다. 독립 코드 검토에서 발견한 핵심 정보 부족의 일반 상담 확정 및 행위자 불명 우려 누락을 수정한 뒤 44개 새 검사를 재확인했고, 해당 범위에서 남은 P1/P2 구현 결함은 확인되지 않았다. 근거는 Git 제외 경로 `runtime/risk-referral-20261018-r1/verification-r1.json`, `independent-review-r2.json`에 보관한다. 이 결과는 실제 모델의 분류 품질을 측정한 점수가 아니다.

같은 날 기관 목록·provider 확장 후 새 관련 검사 63개, 기존 출처/안전/서버 경계를 포함한 통합 검사 **111개가 모두 통과**했다. 구문 검사도 통과했다. 독립 검토는 704개 합성 신호 조합에서 우선순위·행위자 분리·부정/가정 제외를 확인했다. 모델 전체 실패가 일반 정보 부족으로 바뀌던 문제, 라우팅 예외로 긴급성이 사라지던 문제, 비동기 진단 함수의 미처리 rejection을 수정했다. 확인한 5개 구현·설정 파일 범위에 남은 P1/P2 결함은 없었다. 새 분류와 기관 기본값은 코드에 저장했지만 실행 중 서버에 provider를 주입하거나 이 기능을 활성화하지 않았다. 연락처 seed 변경도 현재 실행 인스턴스의 목록을 자동 갱신하지 않는다. 근거는 `runtime/risk-referral-20261018-r2/`에 보존한다.

운영 전 의미 평가에는 최소한 현재 사고/행동, 수동적 죽음 희망, 과거에 한정된 사건, 명제별 부정, 타인 인용, 가정문, 직접 관찰과 전언, 현재 정정, 정보 부족, 주변인의 위험을 구분한 독립 사례가 필요하다. 현재 응급 신호 누락, 수동적 죽음 희망의 일반 상담 처리, 다른 사람으로의 오귀속은 별도의 차단 결함으로 기록한다. 기관 범위·유효기간·연령·지역 오매칭도 분류 점수와 별도로 평가한다.

추가 파인튜닝은 원문 가족 단위 분할, 독립 라벨 검토, 오류 유형별 검증을 갖춘 뒤 진행한다. 실제 평가 대화와 그 수정문을 학습에 재사용하지 않는다. raw 학습/평가 자료는 Git 제외 경로에만 둔다. 새 분류 코드나 프롬프트를 작성했다는 사실은 가중치 학습 완료를 뜻하지 않는다.

## 참고한 공식 근거와 한계

- [NIMH ASQ Toolkit](https://www.nimh.nih.gov/research/research-conducted-at-nimh/asq-toolkit-materials): 의료 환경에서 당사자에게 질문하는 선별과 훈련된 임상가의 후속 평가를 구분한다. 이 앱의 제3자 자유서술 분석을 검증된 ASQ 검사라고 부르지 않는다.
- [NIMH ASQ 문항](https://www.nimh.nih.gov/sites/default/files/documents/research/research-conducted-at-nimh/asq-toolkit-materials/asq-tool/screening-tool-asq-nimh-toolkit.pdf), [성인 외래 BSSA](https://www.nimh.nih.gov/sites/default/files/documents/research/research-conducted-at-nimh/asq-toolkit-materials/adult-outpatient/bssa_outpatient_adult_asq_nimh_toolkit.pdf): 수동적 죽음 희망도 추가 평가 대상으로 보며 현재 적극적 사고, 계획·수단, 과거 행동을 구별한다. 임상 평가 후의 시간 기준을 앱의 일괄 SLA로 옮기지 않는다.
- [NICE NG225 §1.6](https://www.nice.org.uk/guidance/ng225/chapter/recommendations#risk-assessment-tools-and-scales): 척도나 저·중·고 등급으로 미래 자살·반복 자해를 예측하거나 치료 제공·퇴원 여부를 결정하지 않도록 권고한다. 이 문서의 행동 상태는 해당 지침의 임상 등급이 아니다.
- [국립정신건강센터 2025 위험평가 안내 발간 공지](https://www.ncmh.go.kr/ncmh/board/boardView.do?bn=newsView&fno=37&menu_cd=01_01&no=10197&pageIndex=&search_content=&search_item=), [기관 현황 자료 목록](https://www.ncmh.go.kr/mentalhealth/main.do): 안내와 2026년 상반기 기관 현황집의 존재를 확인했다. 안내 PDF 본문은 이번 작업에서 읽지 못했으므로 한국 공식 척도·임계값을 구현했다고 주장하지 않는다.

확인일은 2026-10-18이다. 위 자료는 한국어 제3자 보고 기반 모델, 타해·학대 등 전체 분류의 임상 정확도를 검증하지 않는다. 해당 범위는 별도 전문가 검토가 필요하다.
