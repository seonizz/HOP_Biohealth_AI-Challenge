import { createIntake, currentView, prepareModelAnswer, completeModelAnswer, answerIntake,
  buildContext, applyModelUpdate } from '../../app/src/intake.js';
import { sha256 } from './evaluation_evidence.mjs';
import { clarificationQuestions } from '../../app/src/clarifications.js';

export function workflowAnswerSlots(questionSet) {
  return [
    ...questionSet.questions.flatMap(question => [{question_id:question.id,follow_up:false},
      ...(question.follow_up ? [{question_id:question.id,follow_up:true}] : [])]),
    ...(questionSet.gapQuestion ? [{question_id:questionSet.gapQuestion.id,follow_up:true}] : []),
    ...clarificationQuestions.map(question => ({question_id:question.id,follow_up:true})),
  ];
}

// Same final state-application boundary used by server.js and test-runs.js.
// The runner deliberately does not create a service record or write to a DB.
export function applyFinalResult(state, result) {
  return applyModelUpdate(state, {
    patient_state:result.patient_state, name_index:result.name_index, question_plan:{skip:[]},
    ...(result.agent?.safety_signal ? {safety_signal:result.agent.safety_signal} : {}),
    ...(result.relationship_memory ? {relationship_memory:result.relationship_memory} : {}),
  });
}

// Follow the app-selected question, including model skips and follow-ups. Only
// explicitly supplied answers may be submitted. A missing answer pauses replay.
export async function runIntakeWorkflow({answers, questionSet, gateway, options, onCheckpoint = () => {}}) {
  let state = createIntake(questionSet), lastResult = null;
  const used = new Set(), turns = [];
  let phase = 'answer';
  const snapshot = () => ({status:state.status, completed:false, phase, next_question:currentView(state).question,
    answered_count:buildContext(state).answered_count, model_skipped:structuredClone(state.modelSkipped || {}),
    unused_answers:answers.map((answer,index) => ({index, question_id:answer.question_id, follow_up:Boolean(answer.follow_up)}))
      .filter(answer => !used.has(answer.index)), turns});
  const checkpoint = () => onCheckpoint(snapshot(), lastResult);
  checkpoint();
  while (state.status !== 'ready') {
    options.signal?.throwIfAborted();
    const question = currentView(state).question;
    if (!question) throw Object.assign(new Error('WORKFLOW_QUESTION_MISSING'), {code:'WORKFLOW_QUESTION_MISSING'});
    const index = answers.findIndex((answer,index) => !used.has(index) && answer.question_id === question.id &&
      Boolean(answer.follow_up) === Boolean(question.follow_up));
    if (index < 0) return {result:lastResult, workflow:{...snapshot(), completed:false}, awaitingInput:true};
    const input = structuredClone(answers[index]);
    const turn = {index:turns.length, input_index:index, question:structuredClone(question), applied:false};
    turns.push(turn);
    checkpoint();
    // Mirrors server.js's legacy skipped-answer branch. The relationship agent
    // receives explicit skips too, so its question/safety review still runs.
    if (!input.skipped || gateway.protocol === 'relationship_agent') {
      const pending = prepareModelAnswer(state, input, turns.length - 1);
      const context = buildContext(pending);
      Object.assign(turn, {context_sha256:sha256(JSON.stringify(context)), latest_answer:context.latest_answer,
        question_candidates:context.question_candidates.map(question => question.id),
        prior_memory_present:Boolean(state.agentMemory)});
      const output = await gateway.updateState(context, state.agentMemory || null, options);
      options.signal?.throwIfAborted();
      state = completeModelAnswer(pending, output);
      lastResult = output;
      turn.result = output;
    } else state = answerIntake(state, input);
    used.add(index);
    turn.applied = true;
    turn.next_question = currentView(state).question;
    checkpoint();
  }
  phase = 'final';
  checkpoint();
  const context = buildContext(state);
  const result = await gateway.respond(context, state.agentMemory || null, options);
  options.signal?.throwIfAborted();
  state = applyFinalResult(state, result);
  return {result, workflow:{...snapshot(), completed:true, final_context_sha256:sha256(JSON.stringify(context)),
    final_prior_memory_present:Boolean(context.agent_state), final_state_applied:true}, awaitingInput:false};
}
