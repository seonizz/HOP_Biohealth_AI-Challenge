import { hasAnswerContent } from './catalog.js';

// A choice can be unknown while the same answer reports concrete free text.
// Require the saved choice and custom input: ordinary unknown fields must not
// become evidence merely because their label or rawText is nonempty.
export function normalizeAnswerField(field) {
  if (!field || !['answered','unknown'].includes(field.status) || field.skipped ||
    !Array.isArray(field.selected) ||
    !field.selected.some(option=>typeof option?.label==='string'&&option.label.includes('잘 모르겠어요'))) return field;
  const hasCustom=typeof field.custom==='string'&&hasAnswerContent(field.custom);
  return {...field,status:hasCustom?'answered':'unknown',selection_status:'unknown'};
}

// Older encrypted snapshots retain their original storage/history. Normalize
// only the read view so reopening a saved mixed answer repairs its evidence.
export function normalizeAnswerContext(context) {
  if (!context || typeof context!=='object') return context;
  const result={...context};
  for (const subject of ['patient','supporter']) if (context[subject]?.fields) {
    result[subject]={...context[subject],fields:Object.fromEntries(Object.entries(context[subject].fields)
      .map(([id,field])=>[id,normalizeAnswerField(field)]))};
    if (context[subject].relationship) result[subject].relationship=normalizeAnswerField(context[subject].relationship);
  }
  if (context.user_goal) result.user_goal=Object.fromEntries(Object.entries(context.user_goal)
    .map(([id,field])=>[id,normalizeAnswerField(field)]));
  return result;
}

// The main field is a current snapshot: text/custom may already contain a
// merged follow-up. Preserve storage provenance rather than inventing a turn.
// Identical follow-up text remains distinct from the main snapshot.
export function answerComponents(field) {
  return [['answer_snapshot',field,field?.question],['follow_up',field?.followUp?.answer,field?.followUp?.question]]
    .flatMap(([origin,answer,question])=>{
      const components=[];
      for (const key of ['rawText','text','custom']) {
        const text=answer?.[key];
        if (typeof text!=='string'||!hasAnswerContent(text)) continue;
        const existing=components.find(row=>row.text===text);
        if (existing) existing.fields.push(key);
        else components.push({origin,fields:[key],question:typeof question==='string'?question:'',text});
      }
      return components;
    });
}
