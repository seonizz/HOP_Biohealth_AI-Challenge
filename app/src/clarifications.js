// Stable, optional prompts. A model may select a prompt but cannot invent one.
export const clarificationQuestions = [
  { id:'clarify_help', subject:'patient', type:'text', sec:'조금 더 확인할게요', face:'ponder',
    q:'{name:이} 직접 원한다고 말한 도움이나 원하지 않는 도움은 무엇인가요? 들은 말이 없다면 모른다고 답하셔도 괜찮아요.' },
  { id:'clarify_response', subject:'patient', type:'text', sec:'조금 더 확인할게요', face:'ponder',
    q:'이전에 {name}에게 어떤 말을 건넸고, 그분은 어떻게 반응했나요? 기억나는 말이나 행동만 들려주세요.' },
  { id:'clarify_boundary', subject:'supporter', type:'text', sec:'조금 더 확인할게요', face:'ponder',
    q:'지금 당신이 도울 수 있는 범위와 쉬거나 도움을 나누고 싶은 부분은 무엇인가요?' },
];

export function clarificationCandidates(state) {
  // v3 uses one source-bound axis question; the old three prompts are never mixed in.
  if (state.questionSet?.bundle_id === 'malssi-intake-3.0.0-rc1') return [];
  if (state.status!=='ready') return [];
  // Answered, unknown and declined prompts are all consumed. Never ask again.
  return clarificationQuestions.filter(q=>!Object.hasOwn(state.clarificationAnswers||{},q.id));
}
