// New intake policy only. Historical snapshots without this flag keep their
// original question progression and budget.
export const COMPACT_QUESTION_FLOW = Object.freeze({version:1,target_questions:4,preferred_question_ids:['q3_01','q3_03']});
export const hasCompactQuestionFlow = state => state.v3?.compact_flow?.version === 1;

export function compactQuestionPolicy(state) {
  if (!hasCompactQuestionFlow(state)) return {};
  return {compact_flow:{...structuredClone(COMPACT_QUESTION_FLOW),
    issued_questions:Object.keys(state.v3.issued).length,essential_only:true}};
}

export function compactQuestionIndex(state) {
  const {questions}=state.questionSet,flow=state.v3.compact_flow;
  const eligible=id=>questions.some(q=>q.id===id) && !state.ans[id] && !state.modelSkipped?.[id];
  const edit=state.v3.editingQuestion;
  if(edit&&questions.some(q=>q.id===edit))return questions.findIndex(q=>q.id===edit);
  const core=COMPACT_QUESTION_FLOW.preferred_question_ids.find(eligible);
  const selected=core || [flow.resume_question_id,flow.selected_question_id].find(eligible);
  return selected?questions.findIndex(q=>q.id===selected):questions.length;
}
