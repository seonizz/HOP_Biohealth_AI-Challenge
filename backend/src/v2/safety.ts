export const SAFETY_TEXT = '현재 본인이나 다른 사람의 생명·신체에 즉각적인 위험이 있다면, 안전한 거리를 확보하고 가까운 긴급 도움이나 믿을 수 있는 주변 사람에게 도움을 요청해 주세요. 혼자 위험을 감당하거나 직접 제압하려 하지 않으셔도 됩니다. 현재 계신 국가·지역을 확인한 뒤 이용 가능한 도움 정보를 안내할 수 있습니다.';
export type SafetyAssessment = { route:'no_signal'|'clarify'|'urgent'|'assessment_unavailable'; subject:'supporter'|'subject'|'other'|'unknown'; temporality:'current'|'past'|'hypothetical'|'negated'|'unknown'; policy_version:string };
export function assessSafety(value: string): SafetyAssessment {
  const base: SafetyAssessment = {route:'no_signal',subject:'unknown',temporality:'unknown',policy_version:'malssi-safety-v1'};
  // This conservative local gate is a routing rule, never a diagnosis or calibrated classifier.
  const signal = /(죽(?:고\s*싶|을|겠|이겠)|자살|자해|해치|목숨|뛰어내|숨을?\s*못\s*쉬|의식이?\s*없|약을?\s*(?:한꺼번에|많이)|칼을?\s*(?:들|쥐))/u;
  const clauses = value.normalize('NFC').split(/[.!?\n]|(?:하지만|그런데|그렇지만|지금은|지만|는데)/u);
  let result = base;
  for (const clause of clauses.filter(c => signal.test(c))) {
    const negated = /(?:생각|의도|계획)(?:은|이|는|도)?\s*없|(?:죽|해치|자해|자살).{0,12}(?:않|안\s*할|없)/u.test(clause);
    const past = /과거|예전|작년|어릴\s*때|지난\s*해|했던/u.test(clause);
    const hypothetical = /만약|가정|영화|드라마|소설|뉴스/u.test(clause);
    const quoted = /라고|말했|들었/u.test(clause);
    const current = /지금|당장|오늘|방금|곧|(?:숨|의식)|한꺼번에/u.test(clause);
    const subject = /(?:제가|나는|저는|내가|저\s*자신)/u.test(clause) ? 'supporter' : /엄마|아빠|아들|딸|친구|그분|배우자/u.test(clause) ? 'subject' : 'unknown';
    const route = negated || past || hypothetical || (quoted && !current) ? 'clarify' : 'urgent';
    const next: SafetyAssessment = {route,subject,temporality:negated?'negated':past?'past':hypothetical?'hypothetical':current?'current':'unknown',policy_version:base.policy_version};
    if (result.route !== 'urgent') result = next;
  }
  return result;
}
export function inputText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(v=>v && typeof v==='object').map(inputText).filter(Boolean).join('\n');
  if (value && typeof value === 'object') return Object.entries(value).filter(([k]) => ['text','detail','corrected_value','replacement','notes','user_edited_text'].includes(k) || typeof (value as any)[k] === 'object').map(([,v]) => inputText(v)).join('\n');
  return '';
}
