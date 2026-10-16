// Only public stage metadata: never model text, prompts, quotes or reasoning.
const labels = [
  [/^card_care/, '사용자 감정·부담·지원 자원 작성'], [/^card_doList/, '행동의 방법과 목적 작성'],
  [/^card_avoid/, '피할 표현의 이유와 대안 작성'], [/^card_next/, '상대 반응별 다음 단계 작성'],
  [/^state_observations/, '들려주신 원문 확인'], [/^relationship_memory/, '두 사람의 상태 갱신'],
  [/^state_review/, '상태 근거 검토'], [/^relationship_analysis/, '관계 분석'],
  [/^analysis_review/, '관계 해석 검토'], [/^communication_plan/, '말하기 전략 작성'],
  [/^plan_review/, '말하기 전략 검토'], [/^guide_write/, '다섯 카드 초안 작성'],
  [/^guide_quality/, '다섯 카드 품질 검토'], [/^guide_refine/, '다섯 카드 내용 보완'],
  [/^speech_opening/, '첫마디와 관찰 장면 작성'], [/^speech_listening/, '마음을 전하고 듣는 말 작성'],
  [/^speech_offer/, '작은 제안과 선택권 작성'], [/^speech_write/, '첫 대화 전체 통합'],
  [/^speech_detail_review/, '단계별 설명과 원문 근거 검토'], [/^speech_detail/, '말하기 단계와 이유 정리'],
  [/^speech_review/, '건넬 말과 행동의 근거 검토'], [/^support_review/, '사용자 돌봄과 다음 단계 검토'],
  [/^guide_repair/, '검토에서 발견한 내용 수정'], [/^guide_review/, '최종 답안 검토'],
];
export function generationProgress() {
  const state={status:'running',completed:[],current:'답안 준비',attempt:1};
  return {
    state,
    event({stage,status,attempt=1}) {
      const label=labels.find(([pattern])=>pattern.test(stage))?.[1] || '답안 작성·검토';
      state.current=label;state.attempt=attempt;
      if(status==='completed')state.completed.push({label});
    },
    finish(status) { state.status=status;state.current=status==='complete'?'검토·저장 완료':status==='failed'?'답안 준비 중단':'결과 저장'; },
  };
}
