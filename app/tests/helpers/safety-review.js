// Fixed transport fixtures for tests of other agent responsibilities. Dedicated
// safety-boundary tests select their verdict and source IDs independently.
export function safetyReviewFixture(data,basis=data.proposed_safety?.urgent?'current_physical_danger':'unclear') {
  const evidence_ids=data.safety_sources.filter(source=>data.proposed_safety?.evidence.some(ref=>
    ref.subject===source.subject&&ref.question_id===source.question_id)).map(source=>source.id);
  return {basis,reason:'합성 안전 검토에서 전체 현재 원문을 대조했습니다.',evidence_ids};
}
