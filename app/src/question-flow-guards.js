// Flow guards declared by the active questionnaire bundle (3.1+). Bundles
// without these flags, including stored 3.0 snapshots, keep their behaviour.
const appId = id => id.replace(/^Q3-(\d\d)$/u, 'q3_$1');
const planning = bundle => bundle?.questions?.planning || {};

// Once a later-priority question has been shown, earlier unshown questions are
// no longer offered: the interview never steps back from "what you can do
// next" to "what you did before".
// The mark is derived from the questions actually shown, so a discarded model
// turn cannot move it. A correction forgets what was shown before it, so that
// the changed goal or source is replanned from the start. Only the short
// purpose-first flow of new conversations applies this rule.
const priorityOf = (bundle, id) => (bundle?.questions?.default_priority || []).map(appId).indexOf(id);
const active = state => planning(state.questionSet?.bundle).forward_only === true && state.v3?.compact_flow?.version === 1;

export function resetForwardProgress(state) {
  if (active(state)) state.v3.forward_reset_ids = Object.keys(state.v3.issued);
}

export function forwardOnlyFilter(state) {
  if (!active(state)) return () => true;
  const bundle = state.questionSet.bundle, before = new Set(state.v3.forward_reset_ids || []);
  const reached = Math.max(-1, ...Object.keys(state.v3.issued).filter(id => !before.has(id)).map(id => priorityOf(bundle, id)));
  return id => priorityOf(bundle, id) === -1 || priorityOf(bundle, id) > reached;
}

// A model-written follow-up may not ask again for the topic of a registered
// question that was already shown in this conversation.
export function blockedCustomFocuses(context) {
  const rule = planning(context?.questionnaire_bundle).custom_followup;
  if (!rule?.focus_owner) return [];
  const taken = new Set(context.issued_question_ids || []);
  return Object.entries(rule.focus_owner).filter(([, owners]) => owners.every(id => taken.has(appId(id)))).map(([focus]) => focus);
}

const unspecific = /더\s*(?:있다면|있으면|있나요|있으신가요|있을까요)|자유롭게|덧붙이|반영하고\s*싶은|그\s*밖에|하고\s*싶은\s*(?:말|이야기)/u;
export const isUnspecificFollowUp = (context, question) =>
  planning(context?.questionnaire_bundle).custom_followup?.reject_unspecific_questions === true && unspecific.test(question || '');
