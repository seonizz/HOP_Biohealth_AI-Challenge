# 말씨 발표 자료

[발표용 수치 자료](발표용_데이터_추출_활용안.md)는 **고정 원시기록에서 기계적으로 재계산할 수 있는 수치**로 구성한다.

- [확인 수치](발표데이터_최신확인_20261009.json): 관측 시점과 근거 기록.
- [에이전트용 수치 수집 지침](에이전트용_발표수치_수집지침.md): 원자료·계산·자동 검증·반영 절차.
- [분류 출력 검증 부록](LLM_학습전후_분류평가.md): 허용 코드 형식·종료 상태·실제 토큰·출력 라벨 건수.
- [최신 결과](outputs/presentation_automatic_20261009T132307Z/comparison.md) · [JSON](outputs/presentation_automatic_20261009T132307Z/metrics.json) · [CSV](outputs/presentation_automatic_20261009T132307Z/local_measurements.csv).
- [재계산 검증 코드](outputs/presentation_automatic_20261009T132307Z/verify_measurements.py) · [검증 결과](outputs/presentation_automatic_20261009T132307Z/verification.json).

12B는 `google/gemma-4-12B-it`의 Ollama `gemma4:12b` 배포본(MLX NVFP4)이다. 설치·생성을 확인했으며 Google 원본 revision 연결은 미확인이다. 상담 63건 중 정상 종료 62건, 행동 분류 31건 중 형식 유효 31건이다. 형식 유효율은 내용상 분류 정확도가 아니다.

현재 자료는 개발용·공개 합성 회귀 기록이다. 공개 합성 31개 실행 단위는 28개 상황 그룹이다. 수치는 같은 원시파일에서 다시 계산할 수 있다는 의미이며, 향후 모델 실행에서도 같은 출력·수치가 나온다는 보증은 아니다. 모델의 상담 품질·의미상 적절성·안전성이나 모델 간 우위를 입증하지 않는다.

비교 조건은 **원본 31B / 원본 12B / 학습 후 31B**다. 동일 사례·프롬프트·예산과 FT31 본학습 완료 증거가 확보되어야 조건 간 차이를 계산한다. 실행 환경에 따라 달라지는 응답 시간·처리속도·메모리는 발표 지표에 포함하지 않는다.
