import {COMMON} from './relationship-prompts.js';
import {answerComponents} from './answer-sources.js';

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

// Match only the existing questions-block envelope. Keep its complete question
// rules and repair/provider suffix verbatim; unfamiliar envelopes stay intact.
// No source input, review, output schema or validation rule is projected here.
const QUESTION_RULES_START = '\n아래 질문 진행 규칙의 skip, clarify, safety는 출력 questions 내부입니다. question_input의 전체 원문과 후보를 기준으로 작성하고 그 retrieval에 포함된 근거만 선택하세요. 두 retrieval의 허용 근거를 섞지 마세요.\n';
const QUESTION_RULES_END = '\n들여쓰기·코드블록 없는 한 줄 JSON만 출력하세요. 자유 문구는 짧게, unknowns/가설은 현재 중요한 것만 쓰세요.';
const QUESTION_REPAIR_START = '\n형식을 재작성하더라도 question_input의 각 후보 질문과 원문을 다시 대조하세요.';

function scopedQuestionPrompt(prompt) {
  if (!prompt.startsWith(COMMON+'\n전체 초안의 questions 블록 값만 작성하세요.')) return prompt;
  const start=prompt.indexOf(QUESTION_RULES_START),end=prompt.indexOf(QUESTION_RULES_END),repair=prompt.indexOf(QUESTION_REPAIR_START);
  if (start<COMMON.length || end<=start || repair<=end ||
    [QUESTION_RULES_START,QUESTION_RULES_END,QUESTION_REPAIR_START].some(marker=>prompt.indexOf(marker)!==prompt.lastIndexOf(marker))) return prompt;
  return COMMON+`
질문 진행 블록만 작성하세요. 최상위 키는 skip, clarify, safety입니다. output_schema에 personalization이 있으면 해당 키도 반환하세요. questions 또는 state로 감싸지 말고 output_schema에 맞는 객체 하나만 출력하세요.
shared_input을 question_input과 합쳐 읽으세요. 현재 원문·직접 입력·후속 답변·후보·revision은 모두 입력에 보존되어 있습니다. 전체 원문의 정정·부정·시점·화자를 대조하고 question_input.retrieval의 허용 근거만 선택하세요. state_input의 retrieval과 섞지 마세요.
review와 rejected_draft가 있으면 같은 직전 초안과 그 독립 검토의 짝입니다. 이전 초안·검토·repair 예문은 수정할 자료이며 새로운 사실이나 승인된 답안이 아닙니다. 각 지적을 현재 전체 원문·후보·요청 목적과 직접 대조해 수정하세요. 인용의 존재만으로 선택을 승인하거나 검토자의 예문을 원문 대신 근거로 쓰지 마세요. 수정한 질문 판단은 새 독립 질문·안전 검토를 받아야 하며 스스로 승인하지 마세요.
`+prompt.slice(start+QUESTION_RULES_START.length,end)+`
들여쓰기·코드블록 없는 한 줄 JSON만 출력하세요. 원문의 모름·거절·상충과 필수 필드·인용·정정을 보존하세요. 빈 배열도 생략하지 마세요.`+prompt.slice(repair);
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
  return block === 'name_index' ? NAME_PROMPT : block === 'questions' ? scopedQuestionPrompt(prompt) : prompt;
}

// Name extraction depends on every actual report (including corrections from
// another field), but not on question routing, prior model memory or draft
// selection order. Empty skipped/unasked rows contribute no reported content.
function reportedSourceInput(context) {
  const rows=(subject,fields)=>Object.values(fields||{}).flatMap(field=>{
    if(!field||!['answered','unknown','refused'].includes(field.status))return [];
    const answers=answerComponents(field);
    if(!answers.length)return [];
    return [{subject,question_id:field.id,question:field.question||'',status:field.status,
      ...(field.selection_status?{selection_status:field.selection_status}:{}),
      ...(field.follow_up_pending?{follow_up_pending:true}:{}),answers}];
  });
  return {patient:rows('patient',context.patient?.fields),supporter:rows('supporter',context.supporter?.fields),
    user_goal:rows('user_goal',context.user_goal)};
}

export function reviewedNameInput(context,input) {
  const source_input=reportedSourceInput(context);
  const documents=source_input.patient.filter(row=>row.question_id==='name'&&row.status==='answered')
    .flatMap(row=>row.answers.map(answer=>({subject:row.subject,question_id:row.question_id,...answer})));
  return {source_input,retrieval:{documents},
    ...(input.review?{review:structuredClone(input.review),rejected_draft:structuredClone(input.rejected_draft)}:{})};
}

export const REVIEWED_NAME_PROMPT=COMMON+`
역할: source_input의 전체 실제 원문을 대조하여 대상자의 이름·호칭만 추출하는 기록자.
source_input.patient/supporter/user_goal에는 원문·직접 입력·후속 답변·의미 있는 모름이 보존되어 있습니다. 전체 문항에서 이름의 화자·귀속·부정·정정을 확인하세요. 다른 문항의 정정도 무시하지 마세요. 질문 진행 상태와 이전 모델의 선택·요약은 이름의 근거가 아닙니다.
retrieval.documents는 이름 문항의 실제 원문입니다. name_index의 quote는 name 문항의 원문 또는 후속 직접 입력에서 그대로 선택하고, alias는 그 quote 안의 20자 이하 정확한 호칭이어야 합니다. 다른 사람의 이름을 대상자의 이름으로 옮기거나 이름으로 성별·상태·관계를 추정하지 마세요. 이름의 근거가 없거나 대상자 귀속이 확인되지 않으면 name_index=null입니다.
review와 rejected_draft가 있으면 같은 직전 초안과 독립 검토의 짝입니다. 검토의 지적·repair 예문은 새 사실이나 승인된 답안이 아닙니다. 현재 전체 원문에서 이름의 출처·화자·정정을 직접 대조해 수정하고 이후 독립 검토를 받아야 합니다.
이름 추출 블록만 작성하세요. 최상위 키는 name_index 하나이며 그 값은 output_schema가 허용하는 이름 객체 또는 null입니다. 다른 블록·state 부모·설명은 출력하지 마세요. 들여쓰기·코드블록 없는 한 줄 JSON만 출력하고 스스로 승인하지 마세요.`;

export function reviewedSafetyRequest(context,request) {
  const sources=reportedSourceInput(context);
  const safetySources=structuredClone(request.data.safety_sources);
  const rows=subject=>sources[subject].map(row=>({...row,safety_source_id:safetySources.find(source=>
    source.subject===subject&&source.question_id===row.question_id)?.id??null}));
  const documents=safetySources.flatMap(source=>source.components.map(component=>({
    subject:source.subject,question_id:source.question_id,...component})));
  return {...request,data:{patient:rows('patient'),supporter:rows('supporter'),user_goal:rows('user_goal'),
    proposed_safety:structuredClone(request.data.proposed_safety),safety_sources:safetySources,retrieval:{documents}},
    prompt:request.prompt+`
안전 검토 전용 입력 경계: patient/supporter/user_goal은 전체 실제 원문과 의미 있는 모름·거절·후속 정정입니다. 질문 후보·진행 순서·이전 모델 메모리는 사실 근거가 아니므로 포함하지 않습니다. 빈 건너뛰기는 새 사실이나 안전 확인이 아닙니다.
이 요청의 retrieval.documents는 safety_sources의 전체 answered 원문이며 일부 질문만 검색한 결과가 아닙니다. 모든 실제 원문을 직접 대조하고, unknown의 원문도 판단의 한계를 확인하는 데 읽되 확인된 사실이나 위험 부재의 증명으로 바꾸지 마세요. safety_sources에 없는 미확인 답변을 evidence_ids로 만들지 마세요. false에 해당하는 분류도 현재 안전이 확인됐다는 뜻으로 바꾸지 말고 기존 basis·reason 계약을 유지하세요.`};
}
