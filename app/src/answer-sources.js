import { hasAnswerContent } from './catalog.js';

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
