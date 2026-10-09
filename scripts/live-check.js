import { createIntake, currentView, answerIntake, buildContext } from '../src/intake.js';
import { ModelGateway } from '../src/model.js';

// Only synthetic content is sent. Never print prompts, generated counselling or credentials.
let state = createIntake();
const texts = {
  name:'친구', want:'친구에게 내가 네 편이라는 말을 부담 없이 건네고 싶어요.',
  concern:'친구가 일 때문에 지쳐서 식사를 자주 거르는 모습이 걱정돼요.',
  need:'부담 없이 쉬고 이야기할 수 있는 시간이 필요해 보여요.',
  moment:'밤늦게 걱정하며 연락을 기다린 순간이 힘들었어요.', feeling:'저도 걱정되고 지쳤어요.'
};
while (state.status === 'active') {
  const q = currentView(state).question;
  const input = { question_id:q.id, follow_up:!!q.follow_up, selected:[] };
  if (texts[q.id]) input.text = texts[q.id];
  else if (!q.required && !q.noSkip) input.skipped = true;
  else if (q.type === 'text') input.text = '조용히 이야기를 들어 주고 싶어요.';
  else input.selected = [q.id === 'rel' ? 4 : q.id === 'cause' ? 1 : 0];
  state = answerIntake(state, input);
}
const context = buildContext(state);
const gateway = new ModelGateway({ baseUrl:process.env.MODEL_BASE_URL, apiKey:process.env.MODEL_API_KEY, model:process.env.MODEL_NAME });
const start = Date.now();
try {
  const memory = await gateway.updateState(context);
  console.log(JSON.stringify({ phase:'state', ok:true, grounded_facts:memory.facts.length, elapsed_ms:Date.now() - start }));
  const result = await gateway.respond(context, memory);
  console.log(JSON.stringify({ phase:'guide', ok:true, category:result.guide.top, script_chars:result.guide.script.length, grounded_facts:result.patient_state.facts.length, elapsed_ms:Date.now() - start }));
} catch (error) {
  console.log(JSON.stringify({ ok:false, code:error.code, status:error.status, elapsed_ms:Date.now() - start }));
  process.exitCode = 1;
}
