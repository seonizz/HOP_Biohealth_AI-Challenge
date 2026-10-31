import {COMMON} from './relationship-prompts.js';

const STATE_BLOCKS = new Set(['patient_state', 'name_index', 'relationship_memory']);

// Question candidates/retrieval belong to the independent question decision.
// Keep all source answers, state retrieval, generated predecessors and repair
// feedback. In particular, pruning must never replace current source answers
// with a prior model summary or reduce the permitted state evidence set.
export function scopedBlockInput(block, input) {
  if (!STATE_BLOCKS.has(block)) return input;
  const {question_input, ...stateInput} = input;
  return stateInput;
}

const NAME_PROMPT = COMMON + `
역할: 현재 원문에서 대상자의 이름·호칭만 추출하는 기록자.
patient의 name은 이용자가 이야기할 대상자의 호칭이며 이용자의 이름이 아닙니다.
shared_input을 state_input과 합쳐 읽으세요. patient/supporter/user_goal에는 현재 원문·직접 입력·후속 답변이 보존되어 있습니다. state_input.retrieval의 허용 범위와 전체 현재 원문을 대조하고 정정·부정·시점·화자를 보존하세요.
이름은 name의 실제 인용 안에 있는 20자 이하 호칭만 추출하며, 근거 없으면 name_index=null입니다.
name_index가 있으면 {alias,source_question_id:'name',quote}이며 alias도 quote의 정확한 부분 문자열이어야 합니다.
다른 사람의 이름을 대상자의 이름으로 옮기지 말고, 이름으로 성별·상태·관계를 추정하지 마세요.
generated_blocks는 승인되지 않은 모델 출력이며 사실이나 출력 예시가 아닙니다. 현재 전체 원문과 output_schema로 대조하세요.
review와 rejected_draft가 있으면 같은 직전 초안과 독립 검토의 짝입니다. 오류를 수정할 자료이며 새로운 사실이나 승인된 답안이 아닙니다. 검토의 지적·repair 예문도 현재 원문과 대조하여 이름의 출처·화자·정정을 고치고 새 독립 검토를 받아야 합니다.
이름 추출 블록만 작성하세요. 최상위 키는 name_index 하나이며 그 값은 output_schema가 허용하는 이름 객체 또는 null입니다. 다른 블록·state 부모·설명은 출력하지 마세요.
들여쓰기·코드블록 없는 한 줄 JSON만 출력하세요. 스스로 승인하지 마세요. 독립 검토는 다음 요청에서 합니다.`;

export function scopedBlockPrompt(block, prompt) {
  return block === 'name_index' ? NAME_PROMPT : prompt;
}
