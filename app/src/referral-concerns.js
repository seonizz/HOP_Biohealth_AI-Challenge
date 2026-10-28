import { TRIAGE_SIGNALS } from './risk-classification.js';

const reasons = Object.freeze({
  current_suicidal_thoughts:'스스로 목숨을 끊는 생각이나 의도에 대한 우려가 있어 전문가의 상담을 추천해요.',
  self_harm_action:'스스로를 다치게 하는 행동에 대한 우려가 있어 전문가의 도움을 추천해요.',
  immediate_violence:'누군가를 해치는 행동이나 위협에 대한 우려가 있어 전문적인 도움을 추천해요.',
  physical_emergency:'신체 안전에 대한 우려가 있어 전문적인 도움을 추천해요.',
  wish_to_die_or_self_harm_concern:'죽음이나 자해와 관련된 우려가 있어 전문가의 상담을 추천해요.',
  self_harm_history:'과거 스스로를 다치게 한 경험과 관련해 전문가와 상담해 보면 도움이 될 수 있어요.',
  abuse_or_neglect:'학대나 돌봄의 어려움에 대한 우려가 있어 전문가의 상담을 추천해요.',
  severe_function_impairment:'기본적인 일상을 이어 가는 어려움에 대한 우려가 있어 전문가의 상담을 추천해요.',
  mental_health_concern:'마음의 어려움에 대해 전문가와 상담해 보면 도움이 될 수 있어요.',
  substance_use_concern:'음주나 약물 사용과 관련된 우려가 있어 전문가의 상담을 추천해요.',
  support_requested:'상담이나 지원을 원하는 내용이 있어 전문가와 상담할 곳을 함께 살펴보면 좋겠어요.',
});
const subjects = new Set(['patient', 'supporter', 'other', 'unclear']);
const codes = new Set(TRIAGE_SIGNALS);
const fields = ['code', 'subject', 'evidence_source_ids'];

// Provider prose and quote strings never cross this boundary. Only current
// source identifiers are accepted; the server resolves the complete originals.
export function validReferralConcerns(concerns, sources) {
  if (concerns === undefined) return true;
  if (!Array.isArray(concerns) || concerns.length > 100) return false;
  const eligible = new Set(sources.filter(source => source.question_id !== 'name').map(source => source.id));
  const seen = new Set();
  return Array.from(concerns).every(concern => {
    if (!concern || typeof concern !== 'object' || Array.isArray(concern) ||
        Object.keys(concern).length !== fields.length || fields.some(key => !Object.hasOwn(concern, key)) ||
        !codes.has(concern.code) || !subjects.has(concern.subject) ||
        !Array.isArray(concern.evidence_source_ids) || !concern.evidence_source_ids.length || concern.evidence_source_ids.length > 100 ||
        new Set(concern.evidence_source_ids).size !== concern.evidence_source_ids.length ||
        Array.from(concern.evidence_source_ids).some(id => !eligible.has(id))) return false;
    const key = JSON.stringify([concern.code, concern.subject, [...concern.evidence_source_ids].sort()]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function quotesFor(ids, sources) {
  const selected = new Set(ids), seen = new Set();
  return sources.filter(source => selected.has(source.id) && source.question_id !== 'name').flatMap(source =>
    source.components.flatMap(component => {
      const quote = {question_id:source.question_id, text:component.text};
      const key = JSON.stringify(quote);
      if (seen.has(key)) return [];
      seen.add(key);
      return [quote];
    }));
}

export function resolveReferralConcerns(concerns = [], sources, existing = null) {
  const result = concerns.map(concern => ({subject:concern.subject, code:concern.code,
    reason:reasons[concern.code], quotes:quotesFor(concern.evidence_source_ids, sources)}));
  if (existing?.urgent) {
    const covered = new Set(concerns.flatMap(concern => concern.evidence_source_ids));
    const quotes = quotesFor(existing.evidence_source_ids.filter(id => !covered.has(id)), sources);
    if (quotes.length) result.push({subject:'unclear', code:null,
      reason:'지금 안전을 확인하고 전문적인 도움을 받을 필요가 있는 내용이 있어요.', quotes});
  }
  return result;
}
