// User-provided interview wording, not a validated symptom scoring instrument.
const wording = [
  ['A', '대상자와 어떤 관계이며, 평소 얼마나 자주 만나거나 연락하시나요?'],
  ['B', '대상자가 현재 어떤 어려움을 겪고 있다고 생각하시나요?'],
  ['B', '대상자의 어려움을 다른 가족이나 주변 사람에게 설명한다면 어떻게 설명하시겠나요?'],
  ['B', '대상자의 어려움 중 가장 걱정되거나 마음에 걸리는 부분은 무엇인가요?'],
  ['C', '대상자의 현재 어려움에 영향을 준 경험이나 상황이 있다고 생각하시나요?'],
  ['C', '가족이나 주변 사람들은 대상자의 어려움에 대해 어떤 이유가 있다고 이야기하나요?'],
  ['C', '대상자가 현재 어려움을 견디는 데 도움이 되는 사람, 관계, 활동 또는 환경이 있나요?'],
  ['C', '대상자의 어려움을 더 크게 만들거나 회복을 어렵게 하는 생활 속 부담이 있나요?'],
  ['D', '대상자를 이해하기 위해 알아두어야 할 생활 배경이나 가치관이 있나요?'],
  ['D', '이러한 생활 배경이나 가치관이 대상자의 현재 어려움에 어떤 영향을 준다고 생각하시나요?'],
  ['D', '대상자의 생활 배경이나 가치관과 관련하여 추가로 걱정되는 어려움이 있나요?'],
  ['E', '대상자는 현재의 어려움을 해결하거나 견디기 위해 어떤 방법을 사용해 왔나요?'],
  ['E', '대상자가 지금까지 가족, 친구, 의료기관, 상담기관 또는 기타 기관으로부터 받은 도움은 무엇인가요?'],
  ['E', '대상자가 필요한 도움을 받는 데 어려움을 겪은 이유나 방해가 된 요인이 있나요?'],
  ['F', '현재 대상자에게 가장 필요하다고 생각하는 도움은 무엇인가요?'],
  ['F', '가족이나 주변 사람들은 대상자에게 어떤 도움을 권하고 있나요?'],
  ['F', '대상자가 상담사나 의료진과 이야기할 때 특별히 고려하거나 배려해야 할 점이 있나요?'],
];
export const QUESTIONS = wording.map(([section, text], index) => ({ id: index + 1, section, text }));
const priority = [1, 2, 4, 15, 7, 8, 12, 17, 14, 5, 13, 9, 10, 11, 6, 16, 3];
export type PriorReport = {status:string;value:string|null;source:string;evidence:string;message_id:string;updated_at:string};
export type Profile = Record<string, PriorReport & { question_id?: number; previous_reports?: PriorReport[] }>;

export function readiness(profile: Profile) {
  const answered = new Set(Object.entries(profile).filter(([, entry]) => entry.status === 'answered').map(([id]) => Number(id)));
  const missing = [1, 2, 4, 15].filter(id => !answered.has(id));
  const contextPresent = [7, 8, 12, 14, 17].some(id => answered.has(id));
  return { ready: missing.length === 0 && contextPresent, answered_count: answered.size,
    addressed_count: Object.keys(profile).length, total_questions: 17, missing_required_ids: missing,
    context_present: contextPresent, basis: '관계·어려움·주요 걱정·필요한 도움과 맥락 정보의 확보 여부입니다. 임상 점수가 아닙니다.' };
}
export function nextQuestion(profile: Profile) {
  const id = priority.find(value => !Object.hasOwn(profile, String(value)));
  return id ? QUESTIONS[id - 1] : null;
}
