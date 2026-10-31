import { HttpError, object } from './errors.js';
import { createTestIntake, buildContext, applyModelUpdate } from './intake.js';
import { generationProgress } from './generation-progress.js';
import { finalSafety } from './final-safety.js';

const missing = () => new HttpError(404, 'TEST_RUN_NOT_FOUND', '실행 중인 테스트를 찾을 수 없어요.');
const cancelled = () => new HttpError(499, 'MODEL_CANCELLED', '테스트를 중단했어요.');

// Test inputs and cards live only for the connected request. Never write intakes,
// records, model memory or raw inputs into the normal service's database.
export function createTestRuns({ gateway, questionSet }) {
  const runs = new Map();
  const keyOf = (owner, id) => `${owner}:${id}`;
  return {
    async start(owner, id, input, { signal, requestId } = {}) {
      object(input, ['answers']);
      if (!gateway) throw new HttpError(503, 'MODEL_NOT_CONNECTED', '모델 API 설정을 확인해 주세요.');
      if ([...runs.values()].some(run => run.owner === owner)) throw new HttpError(409, 'TEST_RUN_ACTIVE', '실행 중인 테스트가 있어요. 완료하거나 중단한 뒤 다시 시도해 주세요.');
      if (runs.size >= 4) throw new HttpError(429, 'TEST_RUN_BUSY', '테스트가 진행 중이에요. 잠시 후 다시 시도해 주세요.');
      const key = keyOf(owner, id), controller = new AbortController(), progress = generationProgress();
      const run = { owner, controller, progress };
      runs.set(key, run);
      const abort = () => controller.abort(cancelled());
      signal?.addEventListener('abort', abort, { once:true });
      if (signal?.aborted) abort();
      try {
        const state = createTestIntake(input.answers, await questionSet());
        const context = buildContext(state);
        controller.signal.throwIfAborted();
        const result = await gateway.respond(context, null, { requestId, signal:controller.signal,
          onProgress:event => { if (!controller.signal.aborted) progress.event(event); },
          onCard:event => { if (!controller.signal.aborted) progress.card(event); } });
        controller.signal.throwIfAborted();
        const reviewed = applyModelUpdate(state, { patient_state:result.patient_state,
          name_index:result.name_index, question_plan:{ skip:[] },
          ...(result.agent?.safety_signal ? { safety_signal:result.agent.safety_signal } : {}),
          ...(result.relationship_memory ? { relationship_memory:result.relationship_memory } : {}) });
        const profile = { ...context.profileInput, name:reviewed.name, scores:{},
          safety:finalSafety(context, result, gateway.protocol), symptoms:[], risks:[], protect:[] };
        return { test:true, saved:false, profile, guide:result.guide,
          ...(result.relationship_analysis ? { relationship_analysis:result.relationship_analysis } : {}),
          ...(result.conversation_detail ? { conversation_detail:result.conversation_detail } : {}) };
      } finally {
        signal?.removeEventListener('abort', abort);
        if (runs.get(key) === run) runs.delete(key);
      }
    },
    progress(owner, id) {
      const run = runs.get(keyOf(owner, id));
      if (!run || run.controller.signal.aborted) throw missing();
      return { progress:structuredClone(run.progress.state), cards:run.progress.cards() };
    },
    cancel(owner, id) {
      const run = runs.get(keyOf(owner, id));
      if (!run) throw missing();
      run.controller.abort(cancelled());
    },
    cancelOwner(owner) {
      for (const run of runs.values()) if (run.owner === owner) run.controller.abort(cancelled());
    },
    shutdown() { for (const run of runs.values()) run.controller.abort(cancelled()); },
  };
}
