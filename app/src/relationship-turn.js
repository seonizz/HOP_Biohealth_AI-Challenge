import { HttpError } from './errors.js';
import { createHash } from 'node:crypto';
import { answerComponents } from './answer-sources.js';
import { validatePatientState, validateNameIndex, validateQuestionPlan, validateStateResult } from './agent-state.js';
import { relationshipStateRequest, canonicalRelationshipState, assertRetrievedEvidence,
  relationshipQuestionRequest, validateRelationshipQuestions, questionReviewRequest,
  applyQuestionReview, safetyReviewRequest, validateSafetyReview, validateSafetyEvidence, validateEvidence, validateSchema, MAX_REPORTED_MEMORY_EVIDENCE } from './relationship-agent.js';
import { COMMON, STATE_REVIEW, PROMPT_VERSION } from './relationship-prompts.js';
import { claimsOf, auditSchema, validateAuditCoverage, validateAudits } from './grounding-audit.js';
import { literalStateRepairSchema, literalStateRepairInstruction } from './relationship-state-repair.js';
import { scopedBlockInput, scopedBlockPrompt, reviewedNameInput, REVIEWED_NAME_PROMPT, reviewedSafetyRequest } from './turn-input-scope.js';
import { finalReviewBundle } from './final-review-bundle.js';

export const TURN_PROMPT_VERSION = PROMPT_VERSION + '-combined-turn-v56';

const object = properties => ({ type:'object', properties, required:Object.keys(properties), additionalProperties:false });
const absent = {type:'null'};
const invalid = (reason,modelFeedback) => {
  const error=new HttpError(502,'MODEL_INVALID_RESPONSE','모델의 답변을 확인하지 못했어요. 다시 시도해 주세요.');
  error.modelReason=reason;
  if(modelFeedback) error.modelFeedback=modelFeedback;
  throw error;
};
const checked = (reason,validate) => {
  try { return validate(); }
  catch (error) {
    if(error instanceof HttpError && error.code==='MODEL_INVALID_RESPONSE') invalid(reason);
    throw error;
  }
};
const withoutCommon = prompt => prompt.startsWith(COMMON)?prompt.slice(COMMON.length):prompt;
const LATEST_REPORTED_SLOT_REPAIR='latest_answer와 같은 사람·문항의 선택한 최신 reported fact 인용을 모두 포함할 reported 행 또는 빈자리를 확보해 전체 원문에서 근거를 다시 선택하세요. 그 사람의 최대 2개 finding 중 tentative는 최대 1개입니다. 개수만 맞추려고 기존 reported 행이나 필요한 최신 fact·근거를 삭제하지 마세요. tentative를 사실로 바꾸거나 필수 정정·부정·시점을 삭제하지 마세요.';

function shareInputs(inputs) {
  const active=Object.values(inputs).filter(input=>input!==null);
  const shared_input={};
  if(active.length>1)for(const [key,value] of Object.entries(active[0])) {
    if(active.every(input=>Object.hasOwn(input,key)&&JSON.stringify(input[key])===JSON.stringify(value))) shared_input[key]=value;
  }
  return {shared_input,...Object.fromEntries(Object.entries(inputs).map(([name,input])=>[name,input===null?null:
    Object.fromEntries(Object.entries(input).filter(([key])=>!Object.hasOwn(shared_input,key)))]))};
}

function draftReferenceInput(input) {
  if(input===null)return null;
  // All original answers and historical citation retrieval remain in input.
  // Prior model selections and hypotheses are not an output template: they can
  // repeat obsolete unknowns or exceed the current draft's item limits.
  const {prior_state,prior_relationship_memory,...projected}=structuredClone(input);
  return projected;
}

function reviewState(state) {
  // Summaries and fact interpretations are deterministic server renderings;
  // relationship findings and both unknown lists are already present in claims.
  return {patient_state:{facts:state.patient_state.facts.map(({interpretation,...fact})=>fact)},name_index:state.name_index};
}

function draftPrompt(state,questions,block=null,stageScopedQuestionRules=false) {
  // Reuse the existing role rules, removing the separate-call output contract.
  const rules=withoutCommon(state.prompt)
    .replace('prior_state와 prior_relationship_memory는 재검토할 이전 기록입니다.','전체 현재 원문과 검색 범위에서 상태를 새로 검토하세요.')
    .replace('질문 결정은 다음 별도 단계에서 수행합니다. 여기서는 patient_state,name_index,relationship_memory만 출력하세요.','')
    .replace('원문에 없는 정보는 unknowns로 남깁니다. 대상자의 현재 마음·원하는 도움·대화 의향처럼 다음 대화에 필요한 미확인을 우선하세요.',
      'unknowns는 미응답 문항 목록이 아닙니다. 아직 묻지 않았거나 원문에 없다는 이유만으로 목록을 채우지 마세요. 실제 모름·거절·상충 및 현재 해석이나 도움 결정에서 단정하면 안 되는 구체적인 한계만 남기세요. 그 판단에 필요한 동의·시간·부담의 한계는 미질문이어도 보존하며, 해당하는 한계가 없으면 []입니다.')
    .replace('모든 문항에 답했어도 대상자 자신의 마음·도움 의향·동의가 직접 확인된 것은 아닙니다. 현재 중요한 미확인 부분은 unknowns에 남기세요.',
      '대상자를 직접 면담한 것은 아니지만, 이용자가 대상자의 실제 말·요청·거절을 전했다면 그 사람·시점·범위에서 보고된 정보는 확인된 답변입니다. 전언을 대상자에게 직접 확인한 사실로 승격시키지 말고, 포괄적인 마음·도움 의향·동의 미확인으로 덮지도 마세요. 그 범위를 넘어 아직 답하지 않은 중요한 부분만 unknowns에 구체적으로 남기세요. 질문 후보 목록에 남아 있다는 이유만으로 그 내용을 미확인으로 간주하지 마세요.');
  const blockKeys=block&&block!=='name_index'?Object.keys((block==='questions'?questions.schema:state.schema.properties[block]).properties):[];
  const contract=block?((block==='name_index'
    ?'이름 추출 블록만 작성하세요. 최상위 키는 name_index 하나이며 그 값은 output_schema가 허용하는 이름 객체 또는 null입니다. 다른 블록·state 부모·설명은 출력하지 마세요.'
    :`전체 초안의 ${block} 블록 값만 작성하세요. 최상위 키는 ${blockKeys.join(', ')}입니다. 이 키들을 ${block} 또는 state라는 바깥 키로 다시 감싸지 마세요. output_schema에 맞는 객체 하나만 출력하세요.`)+
    ' 아래 state/questions 경로 규칙은 서버가 나중에 조합할 전체 초안을 설명하며 이번 응답의 바깥 키가 아닙니다.'):
    '한 번의 요청에서 상태 기록과 질문 진행 초안을 함께 작성하세요. 최상위 키는 state와 questions입니다. state에는 patient_state,name_index,relationship_memory만 넣고 questions는 state 밖의 형제 키로 반환하세요.';
  return COMMON+'\n'+contract+`
shared_input을 각 *_input과 합쳐 읽되 retrieval은 해당 입력의 허용 범위만 사용하세요.
patient/supporter/user_goal에는 현재까지의 원문·직접 입력·후속 답변이 보존되어 있습니다. 이전 모델의 요약·선택 목록·가설·미확인 문구는 초안의 입력 예시로 제공하지 않습니다. 전체 현재 원문에서 현재 필요한 근거와 중요한 미확인 범위를 새로 선택하고 출력 스키마의 배열 상한을 지키세요. 이름은 name_index에서 보존하므로 facts에 이름·관계·연락 빈도를 빠짐없이 나열할 필요는 없습니다. 현재 retrieval 범위 밖의 인용은 선택하지 마세요.
review와 rejected_draft가 있으면 같은 직전 초안과 그 독립 검토의 짝입니다. rejected_draft.claims의 id로 review.state.audits가 지적한 문장을 확인하세요. 이전 초안과 검토는 수정할 자료이며 새로운 사실이나 승인된 답안이 아닙니다. 현재 전체 원문으로 지적을 고쳐 새 초안을 작성하고 새 독립 검토를 받아야 합니다. rejected_draft에는 서버가 검토용으로 정리한 필드가 있으므로 출력 형식으로 복사하지 말고 output_schema를 따르세요.
review의 repair 예문도 현재 원문과 reason을 대조하세요. 이미 답한 범위를 unknowns에 포함한 오류는 '미확인'이라는 꼬리표만 붙여 수정으로 보지 마세요. 확인된 범위를 실제 문구에서 제외해 남은 중요한 미확인만 구체적으로 적고, 해결된 항목만 삭제하세요. 원문의 모름·거절·상충과 필요한 동의·부담 한계를 일괄 삭제하지 마세요.
state.patient_state는 facts와 unknowns를 모두 포함하고, state.relationship_memory는 patient, supporter, relationship, unknowns를 모두 포함해야 합니다. 이 배열들은 내용이 없어도 []로 출력하고 필드를 생략하지 마세요.
두 unknowns 배열의 각 항목에는 아직 확인되지 않은 단일 사항만 구체적으로 적으세요. 이미 답한 정보와 미확인 정보를 접속사로 묶지 말고, 확인된 부분을 제외한 정확한 범위가 항목 문구 자체에 드러나게 하세요.
patient/supporter의 최신 answered 원문·후속 답변에 상태·관계 해석이나 도움 판단의 의미를 바꾸는 명시적 정정·부정·시점 변경이 있으면, 해당 사람의 relationship_memory finding에 정정된 보고를 우선 보존하세요. certainty=reported와 같은 사람·문항의 정확한 근거를 사용하고, 부정·시점·인용과 실제 상황의 구분을 빠뜨리지 마세요. patient_state.facts의 원문 보존이나 questions.safety의 판정만으로 이 finding을 대신하지 마세요.
서버는 모델이 선택한 최신 answered·reported fact의 인용을 같은 사람의 reported finding에도 보존합니다(name/rel/contact 제외). 같은 인용을 finding에 중복 생성할 필요는 없지만, 의미와 중요한 근거의 선택은 모델이 맡습니다. 모델 초안은 그룹당 2개·finding당 근거 3개 안에서 선택하세요. 서버가 검증된 인용을 보존한 이전 reported finding은 근거가 더 많을 수 있으므로 그대로 복사하지 말고 전체 원문에서 다시 선택하세요.
최신 reported fact를 선택했다면(name/rel/contact 제외), ${LATEST_REPORTED_SLOT_REPAIR}
아래 상태 규칙의 patient_state, name_index, relationship_memory는 출력 state 내부입니다. state_input의 전체 원문을 기준으로 작성하고 그 retrieval에 포함된 근거만 선택하세요.
`+rules+(questions?(stageScopedQuestionRules&&['patient_state','name_index','relationship_memory'].includes(block)?'':`
아래 질문 진행 규칙의 skip, clarify, safety는 출력 questions 내부입니다. question_input의 전체 원문과 후보를 기준으로 작성하고 그 retrieval에 포함된 근거만 선택하세요. 두 retrieval의 허용 근거를 섞지 마세요.
${questions.data.bundle_id==='malssi-intake-3.0.0-rc1'?'questions.clarify는 [] 또는 원문·revision·한 사건·한 축에 묶인 객체 하나입니다. clarification_available=false이면 반드시 []입니다. true여도 해당 확인이 요청 결과에 필요하지 않거나 원문에 이미 답이 있으면 []입니다. clarification_candidates가 비어 있다는 사실은 이 판본의 객체 확인을 금지하는 조건이 아닙니다.':'questions.clarify에 선택할 추가 확인이 없으면 []입니다. clarification_candidates가 비었으면 반드시 []로 반환하세요. 이때 output_schema의 enum에 있는 "none"은 빈 후보를 표현하는 자리표시자이며 실제 선택지가 아니므로 ["none"]을 출력하지 마세요. 후보가 있어도 추가 확인이 불필요하면 []입니다.'}
`+withoutCommon(questions.prompt)):'\n이번 요청은 질문 진행 판단을 하지 않습니다. questions는 null입니다.')+`
들여쓰기·코드블록 없는 한 줄 JSON만 출력하세요. 자유 문구는 짧게, unknowns/가설은 현재 중요한 것만 쓰세요. 일반적 정보 부족으로 목록을 채우지 말되 원문의 모름·거절·상충과 필수 필드·인용·정정은 보존하세요. 스스로 승인하지 마세요. 독립 검토는 다음 요청에서 합니다.
검토 후 수정 요청이면 마지막으로 review.state.audits의 unsupported 항목을 rejected_draft.claims의 같은 id와 대조하세요. 인용 부족이라는 지적은 문장의 말투만 바꿔 해결하지 않습니다. 해당 문장에 남길 각 주장에 맞는 실제 원문을 허용된 evidence 후보에서 다시 선택하거나, 문장을 선택한 인용이 지지하는 범위로 좁히세요. 전체 입력의 다른 곳에 사실이 있어도 현재 finding의 evidence에 빠져 있으면 그 주장의 근거가 아닙니다. repair 예문의 문장만 복사하고 거절된 evidence를 그대로 두지 마세요. 직접 보고를 반복하는 항목은 reported 규칙을 따르고 추론을 새 사실로 바꾸지 마세요. 각 지적을 현재 원문과 대조해 수정한 뒤 기존 독립 검토를 다시 받아야 합니다.`+(block?`
generated_blocks는 승인되지 않은 모델 출력이며 사실이나 출력 예시가 아닙니다. 현재 전체 원문과 output_schema로 대조하세요. ${block==='name_index'?'이번 응답은 name_index 키 하나를 가진 객체입니다.':`이번 응답의 최상위 키는 ${blockKeys.join(', ')}이며 ${block} 바깥 키는 쓰지 않습니다.`} 누락된 배열이나 의미를 서버가 채워주지 않습니다.`:'')+(block==='questions'?`
형식을 재작성하더라도 question_input의 각 후보 질문과 원문을 다시 대조하세요. JSON 형식이 실패했다는 이유만으로 근거 있는 생략·추가 확인 선택을 빈 배열로 바꾸지 마세요. 이미 답한 범위는 already_covered로 판단하되, 원문이 뒷받침하지 않는 선택은 유지하거나 새로 만들지 마세요. 판단 결과만 올바른 skip, clarify, safety 구조에 담고 독립 검토를 받으세요.`:'');
}

function blockRevisionTargets(block,input) {
  if(!['patient_state','relationship_memory'].includes(block)||input.review?.state?.approved!==false)return [];
  const claims=new Map(input.rejected_draft.claims.map(claim=>[claim.id,claim]));
  return input.review.state.audits.flatMap(audit=>{
    const claim=claims.get(audit.id),match=/^(patient_state|relationship_memory)\.unknowns\.(\d+)$/u.exec(audit.id);
    if(!match||match[1]!==block||claim?.kind!=='unresolved_information'||claim.certainty!=='unknown'||
      !['unsupported','plausible'].includes(audit.verdict)||
      input.rejected_draft.state[block].unknowns[Number(match[2])]!==claim.claim)return [];
    return [{id:claim.id,claim:claim.claim,verdict:audit.verdict,reason:audit.reason}];
  });
}

const BLOCK_REVISION_INSTRUCTION=`
이번 블록의 revision_targets는 같은 rejected_draft와 review에서 골라 표시한 수정 대상입니다. 검토자 판정도 틀릴 수 있는 수정 자료이며 새로운 사실이나 승인된 답안이 아닙니다. 전체 원문의 사람·시점·부정·정정·확인된 범위와 각각 직접 대조하세요.
반려 문구에 이미 확인된 부분이 섞였다면 그 부분을 실제로 고쳐, 아직 확인되지 않았고 현재 판단에 필요한 범위만 모델이 원문에서 새로 작성하세요. 같은 문구를 그대로 복사하거나 '미확인'이라는 꼬리표만 붙이는 것은 수정이 아닙니다. 검토자의 reason을 원문 대신 근거로 쓰거나 내용을 새 사실로 저장하지 마세요.
원문이 같은 사람·시점·범위의 항목 전체에 답했다면 그 항목을 재서술하지 말고 제거하세요. 모든 항목이 해결됐으면 unknowns=[]가 올바릅니다. 행동·사건이 없었다는 명시적 부정 답변과 그 여부를 모른다는 답변을 구분하세요. unknowns에는 아직 모르는 사항만 쓰고, 검토 이유·삭제 지시·수정 경과를 설명하는 문장을 넣지 마세요.
필요한 미확인 한계와 원문의 모름·거절·상충은 계속 보존하세요. 실제로 남은 중요한 미확인까지 지적을 피하려고 삭제하지 말고, 일부만 확인된 항목은 남은 범위로 좁히세요. 서버가 정답 문구를 선택하거나 내용을 삭제·승인하지 않습니다. 원본 output_schema에 맞는 현재 블록만 반환하고, 이 출력은 이후 전체 원문 검증과 새로운 독립 검토를 받아야 합니다.`;

const NAME_REUSE_VERSION='reviewed-name-v1';
const SAFETY_REUSE_VERSION='reviewed-safety-v1';
function reviewedRequestFingerprint(gateway,request,tokenPolicy,version) {
  if(typeof gateway.reviewedNameIdentity!=='string'||!gateway.reviewedNameIdentity)return null;
  // The instance nonce makes records from another gateway/process miss. Only
  // the resulting digest is persisted; credentials/configuration remain local.
  const settings=Object.fromEntries(['reviewedNameIdentity','baseUrl','model','apiKey','protocol','agentFormat','reasoningEffort',
    'stateMode','preserveStringLimits','streamJson','streamCompleteJson','discoverTokenLimits','reuseTokenPolicy'].map(key=>[key,gateway[key]]));
  return createHash('sha256').update(JSON.stringify({version,turn:TURN_PROMPT_VERSION,settings,
    token_policy:tokenPolicy??null,request})).digest('hex');
}

async function requestReusableSafetyReview(gateway,context,request,operation,suffix,reuse,eligible) {
  const reviewer=gateway.reviewGateway||gateway,stage='safety_review'+suffix;
  const execute=async activeOperation=>{
    activeOperation.controller?.signal.throwIfAborted();
    const exactRequest={stage,prompt:request.prompt,payload:request.data,schema:request.schema};
    const fingerprint=eligible?reviewedRequestFingerprint(reviewer,exactRequest,activeOperation.tokenPolicy,SAFETY_REUSE_VERSION):null;
    const prior=context.state_execution,attemptsBefore=activeOperation.metrics?.families?.get('reviewer:safety_review')??0;
    let output,reused=false;
    if(fingerprint&&prior?.reviewed===true&&prior.prompt_version===TURN_PROMPT_VERSION&&
      prior.safety_reuse?.version===SAFETY_REUSE_VERSION&&prior.safety_reuse.fingerprint===fingerprint&&context.safety_signal) {
      try {
        const candidate=structuredClone(prior.safety_reuse.output);
        const signal=validateSafetyReview(candidate,context,request);
        if(JSON.stringify(signal)===JSON.stringify(context.safety_signal)){output=candidate;reused=true;}
      }catch(error) {if(!(error instanceof HttpError)||error.code!=='MODEL_INVALID_RESPONSE')throw error;}
    }
    if(reused) {
      try {gateway.diagnosticLogger?.({event:'model_result_reused',generation:stage,source:'reviewed_safety',
        ...(operation.requestId?{request_id:operation.requestId}:{})});}catch { /* Diagnostics do not approve the result. */ }
    } else output=await reviewer.agentComplete(stage,request.prompt,request.data,request.schema,activeOperation,payload=>{
      validateSafetyReview(payload,context,request);return payload;
    });
    activeOperation.controller?.signal.throwIfAborted();
    const attempts=(activeOperation.metrics?.families?.get('reviewer:safety_review')??0)-attemptsBefore;
    if(fingerprint&&(reused||attempts===1)&&
      fingerprint===reviewedRequestFingerprint(reviewer,exactRequest,activeOperation.tokenPolicy,SAFETY_REUSE_VERSION))
      reuse.entry={version:SAFETY_REUSE_VERSION,fingerprint,output:structuredClone(output),reused};
    return output;
  };
  // Match ordinary reviewer delegation: discover that reviewer's own policy,
  // share cancellation/metrics, and leave whole-operation retries to the writer.
  return reviewer===gateway?execute(operation):reviewer.operation({requestId:operation.requestId,
    signal:operation.controller.signal,onProgress:operation.onProgress,onCard:operation.onCard},execute,
    {retryFailures:false,parentOperation:operation});
}

async function generateDraftBlocks(gateway,state,questions,input,schema,operation,suffix,literalState,feedback,feedbackBlock,stages,context,contextKey,nameReuse) {
  const parts={},validated={},stateStages=[],questionStages=[];
  const recovery=operation.recovery;
  const retained=recovery?.combinedBlocks;
  // Only blocks validated before cancellation can survive a structural failure.
  // Exact inputs include the repair phase and each state's generated predecessors;
  // questions depend solely on the original inputs, never on generated state.
  const cached=retained?.contextKey===contextKey&&retained.requestId===operation.requestId&&
    !operation.controller?.signal.aborted?retained.blocks:{};
  if(recovery)delete recovery.combinedBlocks;
  const scopedRules=gateway.stateMode==='combined_blocks'&&gateway.stageScopedQuestionRules===true;
  const scopedInputs=scopedRules&&gateway.blockScopedInputs===true;
  const generateBlock=async(block,branchOperation,blockStages)=>{
    branchOperation.controller?.signal.throwIfAborted();
    const valueSchema=block==='questions'?schema.properties.questions:schema.properties.state.properties[block];
    // Name extraction can legitimately return null; retain its existing
    // wrapper rather than exposing a root anyOf to object-only APIs.
    const wrapped=block==='name_index',blockSchema=wrapped?object({name_index:valueSchema}):valueSchema;
    const stage='turn_draft_block_'+block+suffix;
    const revisionTargets=blockRevisionTargets(block,input);
    const scopedFeedback=!feedbackBlock||feedbackBlock===block?feedback:undefined;
    const normalizedName=block==='name_index'&&gateway.stateMode==='combined_blocks'&&gateway.reuseReviewedName===true;
    const basePrompt=draftPrompt(state,questions,block,scopedRules);
    const prompt=(normalizedName?REVIEWED_NAME_PROMPT:scopedInputs?scopedBlockPrompt(block,basePrompt):basePrompt)+
      (literalState?literalStateRepairInstruction({combined:true}):'')+
      (revisionTargets.length?BLOCK_REVISION_INSTRUCTION:'');
    const payload={
      ...(normalizedName?reviewedNameInput(context,input):scopedInputs?scopedBlockInput(block,input):input),output_block:block,
      // Keep source inputs and scoped feedback, never a failed draft template.
      ...(scopedFeedback?{combined_validation_feedback:scopedFeedback}:{}),
      ...(block==='questions'||normalizedName?{}:{generated_blocks:structuredClone(parts)}),
      ...(revisionTargets.length?{revision_targets:revisionTargets}:{}),
    };
    const cacheKey=createHash('sha256').update(JSON.stringify({contextKey,context,requestId:operation.requestId,
      stage,prompt,payload,schema:blockSchema,literalState})).digest('hex');
    const validateBlock=value=>{
      validateSchema(value,blockSchema,'output',true);
      if(block==='questions')validateRelationshipQuestions(value,context,questions);
      if(normalizedName)validateNameIndex(value.name_index,context);
      return structuredClone(wrapped?value.name_index:value);
    };
    // No inference or cross-turn cache is needed when null is the sole value
    // allowed by the current name schema. Still use the block and full-state
    // validators, and do not report this constant as a model generation stage.
    if(block==='name_index'&&valueSchema.type==='null'&&Object.keys(valueSchema).length===1) {
      return validateBlock({name_index:null});
    }
    try {
      let value,reusedName=false;
      // Rejected/repair work never mints a reusable approval. The current
      // whole-state independent review still runs after an eligible hit.
      const nameRequest={stage,prompt,payload,schema:blockSchema};
      const nameKey=normalizedName&&!suffix&&!literalState&&!feedback&&!input.review
        ?reviewedRequestFingerprint(gateway,nameRequest,branchOperation.tokenPolicy,NAME_REUSE_VERSION):null;
      const nameAttemptsBefore=branchOperation.metrics?.families?.get('writer:turn_name_index')??0;
      const prior=context.state_execution;
      if(nameKey&&prior?.reviewed===true&&prior.prompt_version===TURN_PROMPT_VERSION&&
        prior.name_reuse?.version===NAME_REUSE_VERSION&&prior.name_reuse.fingerprint===nameKey&&
        JSON.stringify(prior.name_reuse.name_index)===JSON.stringify(context.name_index)) {
        try {value=validateBlock({name_index:structuredClone(prior.name_reuse.name_index)});reusedName=true;}
        catch(error) {if(!(error instanceof HttpError)||error.code!=='MODEL_INVALID_RESPONSE')throw error;}
      }
      if(reusedName) {
        try {gateway.diagnosticLogger?.({event:'model_result_reused',generation:stage,source:'reviewed_name',
          ...(operation.requestId?{request_id:operation.requestId}:{})});}catch { /* Diagnostics do not approve the result. */ }
      }else if(cached?.[block]?.key===cacheKey){
        const retainedValue=structuredClone(cached[block].value);
        value=validateBlock(wrapped?{name_index:retainedValue}:retainedValue);
      }else value=await gateway.agentComplete(stage,prompt,payload,blockSchema,branchOperation,validateBlock);
      branchOperation.controller?.signal.throwIfAborted();
      const nameAttempts=(branchOperation.metrics?.families?.get('writer:turn_name_index')??0)-nameAttemptsBefore;
      // An internally repaired response saw a different prompt/feedback. Do
      // not register that response under the original first-attempt request.
      if(nameKey&&(reusedName||nameAttempts===1)&&
        nameKey===reviewedRequestFingerprint(gateway,nameRequest,branchOperation.tokenPolicy,NAME_REUSE_VERSION))
        nameReuse.entry={version:NAME_REUSE_VERSION,fingerprint:nameKey,name_index:structuredClone(value),reused:reusedName};
      validated[block]={key:cacheKey,value:structuredClone(value)};
      blockStages.push(stage);
      return value;
    } catch(error) {
      // Paths in a block validator start at output, not the full draft root.
      // Retain their origin so a later operation cannot apply them elsewhere.
      if(error instanceof HttpError&&error.code==='MODEL_INVALID_RESPONSE') {
        Object.defineProperty(error,'modelFeedbackBlock',{value:block,configurable:true});
      }
      throw error;
    }
  };
  const generateState=async branchOperation=>{
    for(const block of ['patient_state','name_index','relationship_memory'])
      parts[block]=await generateBlock(block,branchOperation,stateStages);
  };
  let questionResult=null;
  try {
    if(questions){
      // Keep question results out of the state prefix regardless of completion
      // order, so prompts and cache keys remain identical to sequential drafting.
      [,questionResult]=await parallelTurnTasks(operation,[generateState,
        branchOperation=>generateBlock('questions',branchOperation,questionStages)]);
    }else await generateState(operation);
  } catch(error) {
    // Siblings are drained before recording recovery. Never retain a late result
    // or let a sibling's cancellation replace the first structural failure.
    if(error instanceof HttpError&&error.code==='MODEL_INVALID_RESPONSE'&&recovery&&
      !operation.controller?.signal.aborted&&
      ['agent_schema','content_json','stream_whitespace_stall'].includes(error.modelReason))
      recovery.combinedBlocks={contextKey,requestId:operation.requestId,blocks:validated};
    throw error;
  }
  stages.push(...stateStages,...questionStages);
  return {state:{patient_state:parts.patient_state,name_index:parts.name_index,relationship_memory:parts.relationship_memory},questions:questionResult};
}

export function reviewPrompt({typedUnknowns=false}={}) {
  const unknownAccepted=typedUnknowns?'still_unknown':'supported',unknownAnswered=typedUnknowns?'already_answered':'unsupported';
  const stateRules=withoutCommon(STATE_REVIEW)
    .replace('각 해석을 최소 주장으로 나누어 그 항목의 evidence가 모든 내용을 뒷받침하는지 확인하세요.',
      'certainty=reported 또는 tentative인 해석을 최소 주장으로 나누어 그 항목의 evidence가 모든 내용을 뒷받침하는지 확인하세요. kind=unresolved_information은 해석이 아니라 미확인 범위이므로 아래의 별도 기준으로 판정하세요.')
    .replace('approved=true이면 issues=[]이며 문제가 있으면 false입니다.',
      '출력 state.approved=true이면 state.issues=[]이며 실제 내용 오류가 있으면 false입니다.');
  const prompt=COMMON+`
다른 요청이 만든 초안을 원문과 독립적으로 대조하세요. 출력은 state, questions, safety 세 필드입니다.
입력 review_target은 검토 대상이고 출력 state는 검토 결과입니다. 서로 다른 객체입니다. 입력 review_target에 approved/issues/audits가 없어도 정상이며 그 출력 필드는 검토자인 당신이 작성합니다.
출력 state에는 approved(boolean), issues(array), audits(array) 세 키를 모두 포함하세요. state.issues의 각 항목은 reason과 repair 두 키, state.audits의 각 항목은 id, verdict, reason 세 키를 모두 포함합니다. state.claims의 각 id를 state.audits에 정확히 한 번씩 반환하고, claims가 비었을 때만 audits=[]입니다. approved=true여도 audits를 생략하거나 빈 배열로 바꾸지 마세요. 입력 questions나 safety가 null이면 대응 출력도 null이며 해당 최상위 키를 생략하지 마세요.
이번 요청은 상태만 검토합니다. 질문 생략·추가 확인·위험 제안은 별도 요청에서 검토하므로 questions와 safety는 null입니다. skip/clarify/위험 제안의 찬반을 state.issues에 넣거나 상태 거절 사유로 삼지 마세요.
shared_input을 state.input과 합쳐 읽고 해당 retrieval 범위만 사용하세요.
state.input은 전체 원문, state.state는 facts/name_index, state.claims는 관계 주장과 두 unknowns 전체입니다. 서버가 만든 summary/facts.interpretation과 claims 중복은 생략했습니다. 아래 규칙으로 이 상태 전체를 검토하고 출력 state에 판정하세요.
state.reference_roles는 원문의 역할을 구분하는 참고 표이며 새로운 사실·판정·답변 요약이 아닙니다. known_name은 검증된 지칭 이름이고 user_goal_fields는 이용자가 전하고 싶은 말이나 바라는 결과입니다. supporter_report_fields의 실제 보고와 혼동하지 말고 state.input의 각 원문·사람·시점을 대조하세요.
현재 state.state와 state.claims를 전체 최신 원문으로 독립적으로 검증하세요. 각 주장의 현재 문구·근거·범위를 판정하고 현재 남은 오류와 새로 생긴 실제 오류는 계속 거절하세요. 이번 입력에 없는 이전 문구나 이전 판정을 추정해 현재 오류로 재사용하지 마세요.
`+stateRules+`
review_target.claims의 kind와 certainty를 먼저 구분한 뒤 각 id를 출력 state.audits에 정확히 한 번씩 기록하세요.
${typedUnknowns?'kind=unresolved_information, certainty=unknown인 id의 verdict는 still_unknown, already_answered, not_needed, review_uncertain 중 하나만 사용하세요. still_unknown은 같은 사람·시점·범위가 실제로 아직 확인되지 않았고 현재 판단에 필요한 한계라는 뜻입니다. already_answered는 실제 원문이 그 범위를 이미 답했거나 최신 정정과 모순된다는 뜻입니다. not_needed는 실제로 현재 판단과 관계없는 불필요한 미확인 범위라는 뜻이며 구체적인 이유를 적으세요. review_uncertain은 검토자가 그 범위가 실제 미확인인지 또는 현재 판단에 필요한지 판정하지 못했다는 뜻입니다. 원문에서 명시적으로 모른다고 보고한 사실 자체는 review_uncertain의 이유가 아닙니다. 이 유형에는 supported, plausible, unsupported를 사용하지 마세요. reported_excerpt와 tentative_hypothesis에는 기존 supported, plausible, unsupported를 사용하고 미확인 전용 판정 이름을 사용하지 마세요.':''}
kind=unresolved_information은 전체 원문에서 그 범위가 실제로 미확인이고 현재 판단에 필요한 한계인지 검토합니다. evidence가 없는 것은 이 유형의 정상 구조이며, 사실 인용의 supported 조건을 이 유형에 적용하지 마세요. 이미 답한 범위·정정과 모순되는 내용·불필요한 미확인 목록은 계속 거절하세요.
kind=reported_excerpt는 선택한 원문 발췌의 보고이며 전체 답변을 빠짐없이 요약했다는 주장이 아닙니다. 선택한 인용이 현재 claim 전체를 직접 뒷받침하면 supported입니다. 인용하지 않은 다른 답변을 나열하지 않았다는 이유만으로 이 claim을 거절하지 마세요. 발췌가 부정·조건·시점·화자·정정을 잘라 의미를 바꾸었다면 계속 거절하세요.
facts에 이전 답변의 인용과 그 답변을 정정한 최신 인용이 함께 있는 것은 대화 이력의 보존입니다. 이전 인용에 '생각했어요'처럼 이용자의 과거 판단이 명시되어 있고 최신 정정이 해당 사람의 reported finding에도 보존됐다면, 과거 인용의 존재 자체를 현재 상태의 모순이나 정정 누락으로 판정하지 마세요. 현재 가설이 과거 판단을 계속 사실로 사용하거나 정정된 내용을 누락·왜곡했다면 계속 거절하세요.
kind=tentative_hypothesis는 선택한 인용이 지지하는 가설이며 원문의 범위와 현재 문장의 양태를 대조합니다. 근거가 있고 가설임을 밝히면 plausible입니다. 명시적으로 의도만 말한 가설에 실제 행동이나 대상자의 동의를 요구하지 마세요. 실제 행동·동의·상태를 추가로 주장했다면 해당 부분의 근거를 계속 요구하세요.
group은 원래 patient/supporter/relationship 묶음을 표시합니다. evidence의 subject·question_id를 대조해 사람·문항·원문의 역할을 유지하고 다른 사람의 감정·자원·의도로 옮기지 마세요.
${typedUnknowns?'일반 주장 중 ':''}unsupported가 하나라도 있거나 reported가 supported가 아니면 출력 state.approved=false로 거절하고 state.issues에 실제 내용의 수정을 적으세요. unknown의 승인 조건은 아래에서 별도로 유지합니다.
claims에 있는 주장뿐 아니라 최신 answered 원문·후속 답변의 의미를 바꾸는 명시적 정정·부정·시점 변경이 해당 사람의 reported finding에서 누락됐는지도 검사하세요. patient_state.facts에 원문이 전부 있거나 safety 판정이 맞아도 관계 기록의 정정 누락을 승인할 수 없습니다. claims가 비었거나 기존 claims가 모두 ${typedUnknowns?'각 유형의 승인 기준을 충족해도':'supported여도'} 이 누락이 있으면 state.approved=false로 거절하고 issues.repair에 해당 사람·문항과 보존할 정정 범위를 적으세요. 없는 claim의 audit id를 만들지 말고, 다음 초안에 정정 finding이 실제 반영된 뒤 독립 검토하세요.
서버가 최신 fact의 인용을 옮긴 reported finding도 다른 주장과 똑같이 전체 원문으로 검토하세요. 인용 보존 자체는 의미나 선택의 승인 근거가 아닙니다.
kind=unresolved_information, certainty=unknown인 항목은 보고된 사실이나 관계 가설이 아니라 "이 정보가 아직 확인되지 않았다"는 제안입니다. evidence가 비어 있다고 승인하지 말고 state.input의 전체 최신 답변·후속 답변·정정을 대조하세요.
unknowns의 명사구는 해당 범위가 미확인이라는 뜻이며 그 내용을 사실로 주장하는 문장이 아닙니다. 원문에 해당 내용이 언급되지 않았다는 사실 자체를 근거 부족이나 ${typedUnknowns?'거절':'unsupported'}의 이유로 삼지 마세요. 전체 원문에서 같은 사람·시점·범위가 실제로 답해졌는지와 정정에 모순되는지를 확인하세요.
원문의 '모른다', '확인되지 않았다', '도움을 말한 적이 없다'는 미확인 상태에 관한 보고이며, 원하는 도움·본인 가치관·실제 부담의 값이 확인됐다는 뜻이 아닙니다. 같은 사람·시점·범위의 실제 공백이며 현재 판단에 필요할 때만 그 보고가 해당 unknown을 뒷받침합니다. 불필요하다는 판단은 별도로 현재 해석·도움 판단에 왜 필요하지 않은지 구체적으로 설명하세요. 이미 확인됐다고 거절할 때는 해당 값을 실제로 확인해 준 원문과 확인된 범위를 지목하세요. 명시적인 모름이나 원문에 언급이 없다는 사실을 이미 확인된 값으로 바꾸어 거절하지 마세요.
이미 알려진 이름·호칭을 주어로 사용한 것과 그 이름·관계 자체를 미확인이라고 주장한 것을 구분하세요. 알려진 이름·호칭이 들어 있다는 이유만으로 확인된 정보와 미확인 정보가 섞였다고 판정하지 마세요. 무엇이 미확인이라는 항목인지 그 범위를 검토하세요.
예를 들어 known_name이 지민일 때 '지민과의 구체적인 관계'는 관계가 미확인이라는 뜻이며 지민의 이름이 미확인이라는 뜻이 아닙니다. 실제 관계가 이미 보고됐다면 그 원문 근거로 거절하고, 이름이 들어 있다는 이유만으로 거절하지 마세요.
user_goal의 '부담 없이 이야기를 듣고 싶다'는 전달 의도만으로 이용자가 현재 심리적 부담을 느낀다고 확정하지 마세요. 의도에 들어 있는 단어를 supporter의 감정 보고로 옮기지 말고, 실제 감정·부담이 따로 보고됐는지 확인하세요. 실제 보고된 부분과 미확인 부분이 섞인 항목의 거절 기준은 그대로 유지합니다.
실제로 미확인인지와 현재 해석·도움 판단에 필요한 한계인지는 구분해서 검토하세요. 현재 판단과 관계없는 일반적인 미응답 목록이면 그 불필요성이나 필요한 범위를 reason/repair에 구체적으로 적으세요. 이미 답한 정보와 섞였다는 거절에는 실제로 확인된 범위를, 정정과 모순된다는 거절에는 그 모순을 명시하고, 미언급 자체를 그런 오류로 바꾸어 설명하지 마세요.
이 항목의 ${unknownAccepted}는 같은 사람·시점·범위의 정보가 실제로 아직 확인되지 않았다는 뜻입니다.${typedUnknowns?' 현재 판단에 필요한 한계라는 조건도 충족해야 합니다.':''} 이미 원문에서 답한 정보, 직접 전해진 의향·요청·거절을 포괄적인 미확인 표현으로 덮은 항목, 현재 정정과 모순되는 항목은 ${unknownAnswered}입니다. 답변의 일부만 확인됐다면 나머지 미확인 범위를 구체적으로 한정했는지 확인하세요. 이용자가 원한다는 말과 대상자가 직접 원한다고 전해진 말은 구분하고, 전언을 대상자를 직접 면담한 사실로 승격시키지 마세요. 질문 후보 목록에 남아 있는지는 미확인 여부의 근거가 아닙니다.
unknown 주장은 초안 문구 그대로의 전체 범위를 검토하세요. 이미 확인된 부분과 미확인 부분이 섞인 항목은 일부가 미확인이어도 ${unknownAnswered}입니다. reason에서 초안에 없는 한정을 보태거나 범위를 임의로 좁혀 ${unknownAccepted}로 승인하지 마세요. 한정이나 문구 수정이 있어야 타당해지는 항목은 state.approved=false로 거절하고 issues.repair에 수정할 범위를 적으세요. 다음 초안이 그 범위를 명시적으로 고친 뒤 다시 독립 검토해야 하며, 검토 이유만 바꾸는 것은 초안 수정이 아닙니다.
${typedUnknowns?'검토자가 미확인 여부나 필요성을 판정하지 못하면 review_uncertain으로 판정하고 그 한계를 구체적으로 설명하세요. 판정 불확실성을 실제 불필요함인 not_needed로 바꾸지 마세요.':'미확인으로 남기는 것이 타당한지 판단하지 못하면 plausible입니다.'} unknown 항목은 ${unknownAccepted}일 때만 승인할 수 있습니다. unknown 항목 중 ${typedUnknowns?'already_answered, not_needed 또는 review_uncertain':'unsupported 또는 plausible'}이 하나라도 있으면 state.approved=false이고 issues에 해당 id와 수정할 범위를 적으세요. 이 ${unknownAccepted} 전용 기준은 kind=unresolved_information인 unknown 항목에만 적용합니다. certainty=tentative인 가설의 plausible 판정 자체는 오류나 거절 사유가 아닙니다. 가설도 현재 주장에 실제 근거 오류나 중요한 정정 누락이 있으면 계속 거절하세요. 필요한 미확인 항목을 일괄 삭제하지 말고 이미 확인된 부분만 제거하거나 범위를 정정하도록 하세요.
patient_state.unknowns와 relationship_memory.unknowns의 용도는 겹칠 수 있습니다. 두 배열 사이에 같은 미확인 범위나 문구가 있다는 사실 자체는 근거 오류나 ${typedUnknowns?'거절':'unsupported'} 또는 state.approved=false의 사유가 아닙니다. 동일 문구도 각 id의 실제 미확인 여부·현재 판단에 필요한 한계를 각각 독립적으로 검토하고, 각 항목의 범위·모순·필요성은 기존 기준대로 심사하세요.
서로 다른 두 unknowns 배열에서 원문 문자열이 완전히 같은 항목만 일대일로 묶어 검토 목록에 한 번씩 제시했습니다. review_target.claims에 나열된 각 id만 다른 주장과 마찬가지로 audits에 빠짐없이 정확히 한 번씩 반환하세요. 보이지 않는 다른 배열의 항목·id를 재구성하거나 추가하지 마세요. 원본 배열 구성을 추정해 중복을 오류로 만들지 말고, 현재 목록 각 항목의 범위·필요성과 전체 최신 원문을 대조하세요.
최종 반환 전에 각 audit와 issues가 같은 현재 주장에 대해 일관되는지 대조하세요. 한 가설의 과거 판단과 최신 정정이 모두 반영됐다고 plausible로 판정했다면, 그 두 내용이 함께 있다는 사실만 다시 오류로 적지 마세요. 실제 근거 오류가 있다면 그 내용과 맞는 audit 판정 및 구체적인 수정 지시를 반환하고, 내용이 타당한데 문체나 서술 순서만 다르면 issues를 만들지 마세요. 주장에 없는 중요한 최신 정정의 누락은 별도 오류이므로 audits가 모두 타당해도 계속 거절하세요.
issues에는 현재 남은 구체적인 결함만 적고, 해당 claim id 또는 누락된 범위와 판단 근거인 원문·불일치를 지목하세요. '누락이 있는지 다시 확인' 같은 가능성·검토 과제만으로 issues를 만들지 마세요. 최신 정정이 현재 claims에 이미 보존됐다면 그 정정의 재확인을 오류로 반복하지 말고, 두 unknowns 배열 사이에서 허용된 중복도 거절 사유로 다시 적지 마세요. 모든 audit가 각 유형의 승인 기준을 충족하고 구체적인 현재 오류나 중요한 최신 정정 누락이 없다면 state.approved=true와 issues=[]를 반환하세요. 모든 audit가 타당해도 실제로 누락된 중요한 최신 정정이 있다면 그 원문과 누락 범위를 지목해 계속 거절하세요.
들여쓰기·코드블록 없는 한 줄 JSON만 출력하세요. 모든 판정은 유지하고 reason/repair는 원문을 반복하지 않는 짧은 근거 한 문장(가능하면 60자 이내)으로 쓰세요.`;
  return prompt.replaceAll('state.input','review_target.input').replaceAll('state.state','review_target.state')
    .replaceAll('state.claims','review_target.claims').replaceAll('state.reference_roles','review_target.reference_roles');
}

function reviewReferenceRoles(state,input) {
  return {
    known_name:state.name_index ? structuredClone(state.name_index) : null,
    user_goal_fields:input.user_goal.map(({question_id,status})=>({question_id,status,
      role:question_id==='want'?'intended_message':'desired_outcome'})),
    supporter_report_fields:input.supporter.map(({question_id,status})=>({question_id,status})),
  };
}

function stateReviewSchema(claims) {
  return object({approved:{type:'boolean'},issues:{type:'array',maxItems:3,items:object({
    reason:{type:'string',minLength:1,maxLength:500},repair:{type:'string',minLength:1,maxLength:600},
  })},audits:auditSchema(claims)});
}

function stateClaims(state) {
  return [...claimsOf({patient:state.relationship_memory.patient,supporter:state.relationship_memory.supporter,
    relationship:state.relationship_memory.relationship}).map(claim=>({...claim,
      kind:claim.certainty==='reported'?'reported_excerpt':'tentative_hypothesis',group:claim.id.split('.')[0]})),
  ...['patient_state','relationship_memory'].flatMap(group=>state[group].unknowns.map((claim,index)=>({
    id:group+'.unknowns.'+index,kind:'unresolved_information',claim,certainty:'unknown',evidence:[],
  })))];
}

function uniqueReviewClaims(claims) {
  const unique=[],aliases=new Map(),pending={patient_state:new Map(),relationship_memory:new Map()};
  for(const claim of claims) {
    const group=/^(patient_state|relationship_memory)\.unknowns\.\d+$/u.exec(claim.id)?.[1];
    if(!group||claim.kind!=='unresolved_information'||claim.certainty!=='unknown'||
      !Array.isArray(claim.evidence)||claim.evidence.length!==0||typeof claim.claim!=='string'){
      unique.push(claim);continue;
    }
    // Exact raw strings only. Consuming one opposite-group entry preserves
    // every same-group duplicate and limits each audit to one cross-group pair.
    const other=group==='patient_state'?'relationship_memory':'patient_state';
    const canonical=pending[other].get(claim.claim)?.shift();
    if(canonical!==undefined){aliases.set(claim.id,canonical);continue;}
    if(!pending[group].has(claim.claim))pending[group].set(claim.claim,[]);
    pending[group].get(claim.claim).push(claim.id);unique.push(claim);
  }
  return {claims:unique,aliases};
}

function combinedStateReviewRequest(payload,suffix='') {
  const claims=payload.review_target.claims,reviewClaims=uniqueReviewClaims(claims);
  const schema=object({state:stateReviewSchema(claims),questions:absent,safety:absent});
  const canonicalSchema=object({state:stateReviewSchema(reviewClaims.claims),questions:absent,safety:absent});
  const unknownIds=new Set(reviewClaims.claims.filter(claim=>claim.kind==='unresolved_information'&&claim.certainty==='unknown').map(claim=>claim.id));
  const reviewSchema=structuredClone(canonicalSchema),stateSchema=reviewSchema.properties.state;
  // Constrained decoders may follow property order. Review each claim before
  // choosing the overall result; the canonical contract and validators stay
  // unchanged and do not depend on JSON member order.
  stateSchema.properties={audits:stateSchema.properties.audits,issues:stateSchema.properties.issues,approved:stateSchema.properties.approved};
  stateSchema.required=Object.keys(stateSchema.properties);
  const audit=stateSchema.properties.audits.items;
  audit.properties={id:audit.properties.id,reason:audit.properties.reason,verdict:audit.properties.verdict};
  audit.required=Object.keys(audit.properties);
  if(unknownIds.size)reviewSchema.properties.state.properties.audits.items={anyOf:[
    {...audit,properties:{...audit.properties,id:{type:'string',enum:[...unknownIds]},
      verdict:{type:'string',enum:['still_unknown','already_answered','not_needed','review_uncertain']}}},
    ...(reviewClaims.claims.length===unknownIds.size?[]:[{...audit,properties:{...audit.properties,
      id:{type:'string',enum:reviewClaims.claims.filter(claim=>!unknownIds.has(claim.id)).map(claim=>claim.id)}}}]),
  ]};
  return {key:'state',stage:'turn_review'+suffix,prompt:reviewPrompt({typedUnknowns:true})+
    '\n각 claim의 원문 근거와 판정을 audits에 먼저 기록하고, 남은 구체적 오류를 issues에 적은 뒤 그 결과에 맞게 approved를 결정하세요.',payload:{
    ...payload,review_target:{...payload.review_target,claims:reviewClaims.claims},
  },schema:reviewSchema,validate:output=>{
    validateSchema(output,reviewSchema,'output',true);
    validateAuditCoverage(output.state.audits,reviewClaims.claims);
    const canonical={...output,state:{...output.state,audits:output.state.audits.map(audit=>unknownIds.has(audit.id)?{
      ...audit,verdict:audit.verdict==='still_unknown'?'supported':audit.verdict==='review_uncertain'?'plausible':'unsupported',
    }:audit)}};
    let validated;
    try { validated=validateCombinedStateReview(canonical,canonicalSchema,reviewClaims.claims); }
    catch(error) {
      // Keep the canonical rejection, but explain it in the verdict vocabulary
      // requested on this wire. Unknown approvals require still_unknown only.
      if(error instanceof HttpError&&error.code==='MODEL_INVALID_RESPONSE'&&output.state.approved){
        let conflictId;
        if(error.modelReason==='agent_unknown_audit')
          conflictId=output.state.audits.find(audit=>unknownIds.has(audit.id)&&audit.verdict!=='still_unknown')?.id;
        else if(error.modelReason==='agent_claim_audit'){
          try { const feedback=JSON.parse(error.modelFeedback);if(feedback.keyword==='auditApprovalConflict')conflictId=feedback.claim_id; } catch { /* Preserve the original failure. */ }
        }
        const audit=unknownIds.has(conflictId)&&output.state.audits.find(audit=>audit.id===conflictId);
        if(audit)error.modelFeedback=JSON.stringify({keyword:'auditApprovalConflict',claim_id:audit.id,verdict:audit.verdict,
          allowed_approved_verdicts:['still_unknown'],
          repair:'미확인 정보의 approved=true는 해당 audit가 still_unknown일 때만 가능합니다. 현재 원문과 미확인 범위를 다시 대조하세요. already_answered·not_needed·review_uncertain 판정이 남으면 approved=false와 구체적인 issues를 반환하세요. 형식에 맞추기 위해 판정을 still_unknown으로 올리거나 자동 승인하지 마세요.'});
      }
      throw error;
    }
    if(!reviewClaims.aliases.size)return validated;
    const audits=new Map(validated.state.audits.map(audit=>[audit.id,audit]));
    const expanded={...validated,state:{...validated.state,audits:claims.map(claim=>({
      ...audits.get(reviewClaims.aliases.get(claim.id)??claim.id),id:claim.id,
    }))}};
    return validateCombinedStateReview(expanded,schema,claims);
  }};
}

export async function requestCombinedStateReview(gateway,payload,operation,suffix='') {
  const request=combinedStateReviewRequest(payload,suffix);
  return gateway.agentComplete(request.stage,request.prompt,request.payload,request.schema,operation,request.validate);
}

// Independent draft/review tasks share cancellation, never intermediate output.
// A semantic rejection is a complete result, not an operational failure:
// question decisions and confirmed danger must survive state repair.
async function parallelTurnTasks(operation,tasks) {
  const controller=new AbortController(),parentSignal=operation.controller?.signal;
  const abort=()=>controller.abort(parentSignal.reason);
  parentSignal?.addEventListener('abort',abort,{once:true});
  if(parentSignal?.aborted)abort();
  const branchOperation={...operation,controller,onProgress:event=>{
    if(!controller.signal.aborted)operation.onProgress?.(event);
  }};
  let failed=false,failure;
  try {
    const results=await Promise.allSettled(tasks.map(async task=>{
      try {
        controller.signal.throwIfAborted();
        // Policy refresh/retry state belongs to this branch. Share cancellation,
        // metrics and the guarded cache, not a sibling's active token budget.
        const value=await task({...branchOperation});
        controller.signal.throwIfAborted();
        return value;
      } catch(error) {
        if(!failed){
          failed=true;failure=error;
          // Do not abort the owning operation: its existing retry policy needs
          // the original failure, not a cancellation manufactured by a sibling.
          controller.abort(new HttpError(499,'MODEL_CANCELLED','답변 처리를 중단했어요.'));
        }
        throw error;
      }
    }));
    // Drain every branch before retrying, applying results, or allowing a save.
    parentSignal?.throwIfAborted();
    if(failed)throw failure;
    return results.map(result=>result.value);
  } finally {
    parentSignal?.removeEventListener('abort',abort);
  }
}

function validateStateAudits(audits,claims,approved) {
  validateAudits(audits,claims,approved);
  // Unknowns describe absence of information, not reported facts. Their review
  // must positively confirm that absence; a merely plausible gap is insufficient.
  const unknownIds=new Set(claims.filter(claim=>claim.kind==='unresolved_information').map(claim=>claim.id));
  if(approved&&audits.some(audit=>unknownIds.has(audit.id)&&audit.verdict!=='supported')) invalid('agent_unknown_audit');
}

export function validateCombinedStateReview(payload,schema,claims) {
  validateSchema(payload,schema,'output',true);
  if(payload.state.approved!==(payload.state.issues.length===0)) invalid('state_review_schema');
  validateStateAudits(payload.state.audits,claims,payload.state.approved);
  // All IDs have already passed the exact audit coverage check above. Asking
  // this reviewer to fill its own audits is not a defect in the source draft.
  if(payload.state.issues.some(issue=>{
    const missingClaims=/^claims(?:의)?\s*(?:모든|전체)\s*항목(?:이|을)?\s*(?:포함(?:하|되)?지\s*않|누락)/u.test(issue.reason);
    const ownAuditRepair=/\baudits?\b/iu.test(issue.reason)&&/\baudits?\b/iu.test(issue.repair);
    return missingClaims&&(/audits/u.test(issue.repair)||claims.length>0&&claims.every(claim=>issue.repair.includes(claim.id)))||
      ownAuditRepair;
  }))
    invalid('state_review_schema',JSON.stringify({keyword:'reviewScope',required_audit_ids:claims.map(claim=>claim.id),
      repair:'audits는 이미 현재 claims 전체를 정확히 포함합니다. 자신의 검토 출력 형식 문제를 data.state 초안 오류로 issues에 쓰지 마세요. 원문과 현재 주장을 다시 검토하고 실제 근거·내용 오류만 남기세요. 자동 승인하지 마세요.'}));
  // These arrays may record the same unresolved range. Only a narrowly worded
  // duplicate-only complaint with positively supported unknown audits is a
  // reviewer scope error; genuine source defects still reject the draft.
  const unknownClaims=claims.filter(claim=>claim.kind==='unresolved_information');
  const hasBothUnknownGroups=['patient_state','relationship_memory'].every(group=>
    unknownClaims.some(claim=>claim.id.startsWith(group+'.unknowns.')));
  const audits=new Map(payload.state.audits.map(audit=>[audit.id,audit]));
  const supportedClaims=claims.every(claim=>audits.get(claim.id).verdict!=='unsupported'&&
    (claim.certainty!=='reported'&&claim.kind!=='unresolved_information'||audits.get(claim.id).verdict==='supported'));
  const duplicateOnly=issue=>{
    const normalized=text=>text.normalize('NFKC').replace(/\s+/gu,' ').trim();
    const reasonText=normalized(issue.reason),repairText=normalized(issue.repair);
    const idPattern=/\b(patient_state|relationship_memory)\.unknowns\.(\d+)(?:[~–-](\d+))?(?![\w.~–-])/gu;
    if(/\b(?:patient_state|relationship_memory)\.unknowns/u.test((reasonText+' '+repairText).replace(idPattern,'')))return false;
    const references=[...reasonText.matchAll(idPattern)];
    if(references.length!==2||references[0][1]===references[1][1])return false;
    if([...repairText.matchAll(idPattern)].some(reference=>!references.some(known=>known[0]===reference[0])))return false;
    const ranges=references.map(([,group,start,end=start])=>{
      const first=Number(start),last=Number(end);
      if(!Number.isSafeInteger(first)||!Number.isSafeInteger(last)||String(first)!==start||String(last)!==end||
        last<first||last-first+1>unknownClaims.length)return null;
      return Array.from({length:last-first+1},(_,offset)=>unknownClaims.find(claim=>claim.id===group+'.unknowns.'+(first+offset)));
    });
    if(!ranges.every(range=>range&&range.every(claim=>claim&&typeof claim.claim==='string'))||
      ranges[0].length!==ranges[1].length||!ranges[0].every((claim,index)=>normalized(claim.claim)===normalized(ranges[1][index].claim)))return false;
    // Equality is established from the actual claims, never inferred from the
    // reviewer's wording. Accept varied duplication wording only for a local
    // duplicate-removal/merge/distinction repair with no independent defect.
    const text=reasonText+' '+repairText;
    if(/원문|근거|정정|모순|누락|이미|알려|답(?:했|한)|확인(?:됐|되었|된)|보고(?:됐|되었|된)|불일치|오류|잘못|왜곡|허위|단정|동의|거절|부적절|부정확|불명확|불완전|불확실|빠(?:졌|진|져|짐)|결함|불충분|부족|위반|형식|필수|오타|불필요|필요하지|필요없|unsupported|또한|하지만|그러나|다만|동시에|추가로|뿐만? 아니라|게다가|아울러/iu.test(text))return false;
    if(/\b(?:patient|supporter|relationship)\.\d+\b/u.test(text)||/(?:전체|모든|전부).*(?:삭제|제거|없애)/u.test(repairText))return false;
    if(/중복[^.!?]*(?:아니|아닙|아님|않)|겹치지|반복되지|같지|동일하지/u.test(reasonText))return false;
    return /중복|반복|겹(?:치|쳐|칩)|(?:동일한?|같은) (?:내용|범위|문구|정보)|똑같/u.test(reasonText)&&
      /삭제|제거|통합|합치|합쳐|정리|구분|조정|분리|나누|남기|남겨|없애|줄이|줄여/u.test(repairText)&&
      /중복|반복|겹|두\s*(?:항목|배열)|각각|서로|하나로|한쪽|한 항목|고유|다른 미확인 범위/u.test(repairText);
  };
  if(hasBothUnknownGroups&&supportedClaims&&payload.state.issues.length>0&&payload.state.issues.every(duplicateOnly))
    invalid('state_review_schema',JSON.stringify({keyword:'reviewScope',required_audit_ids:claims.map(claim=>claim.id),
      repair:'patient_state.unknowns와 relationship_memory.unknowns 사이의 같은 미확인 범위는 허용됩니다. 배열 사이 중복 자체를 초안 오류로 삼지 마세요. 각 항목의 실제 미확인 범위·최신 원문과의 모순·현재 판단에 필요한 한계를 독립적으로 다시 심사하고 실제 내용 오류는 계속 거절하세요. 자동 승인하지 마세요.'}));
  return payload;
}

function retainedStateSchema(request) {
  const schema=structuredClone(request.schema);
  for(const subject of ['patient','supporter']) {
    const reported=schema.properties.relationship_memory.properties[subject].items.anyOf
      .find(variant=>variant.properties.certainty.enum.includes('reported'));
    reported.properties.evidence.maxItems=MAX_REPORTED_MEMORY_EVIDENCE;
  }
  return schema;
}

function preserveSelectedLatestFacts(payload,context,request) {
  const latest=context.latest_answer,memory=payload.relationship_memory;
  if(!['patient','supporter'].includes(latest?.subject)||['name','rel','contact'].includes(latest.question_id)||
    context[latest.subject]?.fields?.[latest.question_id]?.status!=='answered') return memory;
  const unique=refs=>[...new Map(refs.map(ref=>[JSON.stringify([ref.subject,ref.question_id,ref.quote]),ref])).values()];
  const selected=unique(payload.patient_state.facts.filter(fact=>fact.certainty==='reported'&&
    fact.subject===latest.subject&&fact.question_id===latest.question_id).map(({subject,question_id,quote})=>({subject,question_id,quote})));
  const rows=memory[latest.subject],missing=selected.filter(ref=>!rows.some(row=>row.certainty==='reported'&&
    row.evidence.some(existing=>existing.subject===ref.subject&&existing.question_id===ref.question_id&&existing.quote.includes(ref.quote))));
  if(!missing.length) return memory;
  const groupSchema=request.schema.properties.relationship_memory.properties[latest.subject];
  const maxEvidence=MAX_REPORTED_MEMORY_EVIDENCE;
  const next=structuredClone(memory),candidates=rows.map((row,index)=>({row,index})).filter(({row})=>row.certainty==='reported')
    .sort((a,b)=>Number(b.row.evidence.some(ref=>ref.question_id===latest.question_id))-Number(a.row.evidence.some(ref=>ref.question_id===latest.question_id)));
  const merge=candidates.map(({row,index})=>({index,evidence:unique([...missing,...row.evidence])}))
    .find(candidate=>candidate.evidence.length<=maxEvidence);
  if(merge) next[latest.subject][merge.index]={certainty:'reported',evidence:merge.evidence};
  else if(rows.length<groupSchema.maxItems&&missing.length<=maxEvidence) next[latest.subject].push({certainty:'reported',evidence:missing});
  else invalid('agent_latest_fact_capacity',JSON.stringify({
    path:`output.state.relationship_memory.${latest.subject}`,keyword:'latestFactCapacity',
    expected:{max_findings:groupSchema.maxItems,max_evidence_per_finding:maxEvidence,
      reported_slot_required:true,max_tentative_count:Math.max(0,groupSchema.maxItems-1)},
    actual:{selected_latest_refs:selected.length,missing_latest_refs:missing.length,
      reported_count:candidates.length,tentative_count:rows.filter(row=>row.certainty==='tentative').length},
    repair:LATEST_REPORTED_SLOT_REPAIR,
  }));
  // Never truncate existing citations or discard a hypothesis to make room.
  // The ordinary draft-repair path must make an explicit bounded selection.
  validateSchema(next,retainedStateSchema(request).properties.relationship_memory);
  assertRetrievedEvidence(next,request.retrieval);
  return next;
}

function validateState(payload,context,request,retained=false) {
  assertRetrievedEvidence(payload,request.retrieval);
  // Validate the complete original draft first, including findings that a merge
  // could otherwise overwrite. Reuse model selections, not the full raw facts
  // the canonicalizer adds automatically for the latest answer.
  let canonical=canonicalRelationshipState(payload,context,retained?retainedStateSchema(request):request.schema);
  const memory=preserveSelectedLatestFacts(payload,context,request);
  if(memory!==payload.relationship_memory) canonical=canonicalRelationshipState({...payload,relationship_memory:memory},context,retainedStateSchema(request));
  const state={patient_state:canonical.patient_state,name_index:canonical.name_index,question_plan:{skip:[]}};
  checked('patient_state_validation',()=>validatePatientState(state.patient_state,context));
  checked('name_index_validation',()=>validateNameIndex(state.name_index,context));
  checked('question_plan_validation',()=>validateQuestionPlan(state.question_plan,context));
  return {...validateStateResult(state,context),relationship_memory:canonical.relationship_memory};
}

function normalizeEvidenceExcerpts(payload,context,request) {
  let projected=payload;
  const diagnostics=[];
  for(const subject of ['patient','supporter']) {
    const rows=payload?.state?.relationship_memory?.[subject];
    if(!Array.isArray(rows))continue; // The ordinary validator reports malformed envelopes.
    const variants=request.schema.properties.relationship_memory.properties[subject].items.anyOf;
    for(const [rowIndex,row]of rows.entries()) {
      const schema=variants.find(variant=>variant.properties.certainty.enum.includes(row?.certainty))?.properties.evidence.items;
      if(!schema?.enum||!Array.isArray(row.evidence))continue;
      for(const [refIndex,ref]of row.evidence.entries()) {
        const path=`output.state.relationship_memory.${subject}[${rowIndex}].evidence[${refIndex}]`;
        let originalError;
        try { validateSchema(ref,schema,path,true);continue; }
        catch(error) {
          const failure=error.modelFeedback?JSON.parse(error.modelFeedback):null;
          if(error.modelReason!=='agent_schema'||failure?.path!==path||failure.keyword!=='enum')throw error;
          originalError=error;
        }
        // Only enum membership may differ. The original characters, attribution
        // and retrieval provenance must already be valid before adding context.
        const originalSchema={...schema};delete originalSchema.enum;
        validateSchema(ref,originalSchema,path,true);
        validateEvidence(ref,context);
        assertRetrievedEvidence(ref,request.retrieval);
        const field=context[subject]?.fields?.[ref.question_id];
        const texts=answerComponents(field).map(component=>component.text);
        const sentences=new Set(texts.flatMap(text=>text.split(/(?<=[.!?。！？])\s+|\n+/u).map(part=>part.trim())));
        const complete=new Set([...texts,...sentences]);
        const candidates=schema.enum.map((candidate,index)=>({candidate,index})).filter(({candidate})=>
          candidate.subject===ref.subject&&candidate.question_id===ref.question_id&&
          candidate.quote.includes(ref.quote)&&complete.has(candidate.quote));
        // Full answers may contain a unique matching sentence. Competing
        // sentences remain ambiguous even when one is shorter or nested in
        // another source component with different surrounding context.
        if(candidates.filter(({candidate})=>sentences.has(candidate.quote)).length>1)throw originalError;
        const minimal=candidates.filter(({candidate})=>!candidates.some(({candidate:other})=>
          other.quote!==candidate.quote&&candidate.quote.includes(other.quote)));
        if(minimal.length!==1)throw originalError;
        const {candidate,index}=minimal[0];
        validateSchema(candidate,schema,path,true);
        validateEvidence(candidate,context);
        assertRetrievedEvidence(candidate,request.retrieval);
        if(projected===payload)projected=structuredClone(payload);
        projected.state.relationship_memory[subject][rowIndex].evidence[refIndex]=structuredClone(candidate);
        const digest=value=>createHash('sha256').update(value).digest('hex');
        diagnostics.push({event:'citation_excerpt_expanded',path,enum_index:index,
          from_length:ref.quote.length,to_length:candidate.quote.length,
          from_sha256:digest(ref.quote),to_sha256:digest(candidate.quote)});
      }
    }
  }
  return {payload:projected,diagnostics};
}

function normalizeReportedOverflow(payload,context,request,draftSchema) {
  let originalError;
  try { validateSchema(payload,draftSchema,'output',true);return {payload,retained:false}; }
  catch(error) {
    if(!(error instanceof HttpError)||error.modelReason!=='agent_schema')throw error;
    originalError=error;
  }
  const failure=JSON.parse(originalError.modelFeedback||'null');
  const subject=['patient','supporter'].find(subject=>failure?.path===`output.state.relationship_memory.${subject}`);
  if(!subject||failure.keyword!=='maxItems')throw originalError;
  const groupSchema=request.schema.properties.relationship_memory.properties[subject];
  const rows=payload.state.relationship_memory[subject];
  const reportedCount=rows.filter(row=>row?.certainty==='reported').length;
  const tentativeCount=rows.filter(row=>row?.certainty==='tentative').length;
  // Explain the observed overflow without accepting, deleting or reclassifying
  // any row. A count-only retry otherwise fits two hypotheses by removing the
  // reported row needed for the selected latest fact.
  if(groupSchema.maxItems===2&&rows.length===3&&reportedCount===1&&tentativeCount===2) {
    const latest=context.latest_answer;
    const facts=payload.state.patient_state?.facts;
    const selected=latest?.subject===subject&&!['name','rel','contact'].includes(latest.question_id)&&
      context[subject]?.fields?.[latest.question_id]?.status==='answered'&&Array.isArray(facts)
      ?[...new Set(facts.filter(fact=>fact?.certainty==='reported'&&fact.subject===subject&&
        fact.question_id===latest.question_id&&typeof fact.quote==='string').map(fact=>fact.quote))]:[];
    const reportedRefs=rows.filter(row=>row.certainty==='reported').flatMap(row=>Array.isArray(row.evidence)?row.evidence:[]);
    const missing=selected.filter(quote=>!reportedRefs.some(ref=>ref?.subject===subject&&ref.question_id===latest.question_id&&
      typeof ref.quote==='string'&&ref.quote.includes(quote)));
    if(missing.length)originalError.modelFeedback=JSON.stringify({...failure,
      expected:{...failure.expected,reported_slot_required:true,max_tentative_count:1},
      actual:{...failure.actual,reported_count:reportedCount,tentative_count:tentativeCount,
        selected_latest_refs:selected.length,missing_latest_refs:missing.length},repair:LATEST_REPORTED_SLOT_REPAIR});
    throw originalError;
  }
  // This representation exception covers only the observed two literal reports
  // plus one hypothesis. Other excesses still require model repair.
  if(groupSchema.maxItems!==2||rows.length!==3||reportedCount!==2||tentativeCount!==1)throw originalError;

  const projected=structuredClone(payload);
  projected.state.relationship_memory[subject]=[];
  validateSchema(projected,draftSchema,'output',true);
  validateState(projected.state,context,request); // All other state fields and their source contracts.
  for(const [index,row]of rows.entries()) {
    validateSchema(row,groupSchema.items,`output.state.relationship_memory.${subject}[${index}]`,true);
    assertRetrievedEvidence(row,request.retrieval);
    // Validate each original row with the unchanged canonical contracts, rather
    // than raising the group limit or hiding a bad row while merging.
    canonicalRelationshipState({...projected.state,relationship_memory:{...projected.state.relationship_memory,[subject]:[row]}},context,request.schema);
  }

  const reported=rows.filter(row=>row.certainty==='reported');
  const latest=context.latest_answer;
  const selected=latest?.subject===subject&&!['name','rel','contact'].includes(latest.question_id)&&
    context[subject]?.fields?.[latest.question_id]?.status==='answered'
    ?payload.state.patient_state.facts.filter(fact=>fact.certainty==='reported'&&fact.subject===subject&&fact.question_id===latest.question_id)
      .map(({subject,question_id,quote})=>({subject,question_id,quote})):[];
  const references=[...reported.flatMap(row=>row.evidence),...selected];
  const covers=(a,b)=>a.subject===b.subject&&a.question_id===b.question_id&&a.quote.includes(b.quote);
  // A longer quote must already be model-selected. Exact containment keeps the
  // original characters and attribution; no text rewriting or source expansion.
  const evidence=references.filter((ref,index)=>!references.some((other,otherIndex)=>otherIndex!==index&&covers(other,ref)&&
    (other.quote.length>ref.quote.length||otherIndex<index&&other.quote===ref.quote)));
  const retainedSchema=retainedStateSchema(request);
  const reportedSchema=retainedSchema.properties.relationship_memory.properties[subject].items.anyOf
    .find(variant=>variant.properties.certainty.enum.includes('reported'));
  if(evidence.length>reportedSchema.properties.evidence.maxItems||!references.every(ref=>evidence.some(next=>covers(next,ref))))throw originalError;
  const merged={certainty:'reported',evidence};
  validateSchema(merged,reportedSchema,`output.state.relationship_memory.${subject}[0]`,true);
  assertRetrievedEvidence(merged,request.retrieval);
  let inserted=false;
  projected.state.relationship_memory[subject]=rows.flatMap(row=>{
    if(row.certainty!=='reported')return [structuredClone(row)];
    if(inserted)return [];
    inserted=true;return [merged];
  });
  validateSchema(projected,{...draftSchema,properties:{...draftSchema.properties,state:retainedSchema}},'output',true);
  return {payload:projected,retained:true}; // Original rows passed the generation contract before this server merge.
}

// Keep the existing state and question evidence scopes independent, even though
// their two drafts share a model request. Only independent reviews can approve them.
export async function runCombinedRelationshipState(gateway,context,memory,operation,final=false) {
  const stateRequest=relationshipStateRequest(context,memory,final);
  const questions=context.adaptive_questions&&!final?relationshipQuestionRequest(context):null;
  const baseDraftSchema=object({state:stateRequest.schema,questions:questions?.schema||absent});
  const {prior_state,prior_relationship_memory,...raw}=stateRequest.data;
  const draftInputs=shareInputs({state_input:draftReferenceInput(stateRequest.data),question_input:draftReferenceInput(questions?.data||null)});
  const contextKey=createHash('sha256').update(JSON.stringify({version:TURN_PROMPT_VERSION,final,state:stateRequest,questions})).digest('hex');
  const recovery=operation.recovery;
  if(recovery?.combinedTurn?.contextKey!==contextKey&&recovery)delete recovery.combinedTurn;
  if(recovery?.combinedDraft?.contextKey!==contextKey&&recovery)delete recovery.combinedDraft;
  if(recovery?.combinedBlocks?.contextKey!==contextKey&&recovery)delete recovery.combinedBlocks;
  if(recovery?.turnReviewBundlesDisabled?.contextKey!==contextKey&&recovery)delete recovery.turnReviewBundlesDisabled;
  // Both draft modes retain the same independent review tasks and ordered
  // fallback. The combined opt-in can use one draft + one review envelope.
  const bundleReviews=gateway.bundleTurnReviews===true&&gateway.stateMode==='combined_blocks'||
    gateway.bundleCombinedTurnReviews===true&&gateway.stateMode==='combined';
  let useReviewBundles=bundleReviews&&!recovery?.turnReviewBundlesDisabled;
  const retained=recovery?.combinedTurn;
  let blockDraft=gateway.stateMode==='combined_blocks'||Boolean(recovery?.combinedDraft),failedCandidate=recovery?.combinedDraft?.candidate,
    blockFeedback=recovery?.combinedDraft?.feedback,feedbackBlock=recovery?.combinedDraft?.feedbackBlock;
  let semanticRejections=retained?.semanticRejections||0;
  const literalState=semanticRejections>=2&&retained.literalState===true;
  const draftSchema=literalState?literalStateRepairSchema(baseDraftSchema,{combined:true}):baseDraftSchema;
  const stages=[];
  let previousReview=retained?structuredClone(retained.review):null,
    previousDraft=retained?structuredClone(retained.draft):null,
    previousDanger=retained?.danger?structuredClone(retained.danger):null;
  for(let repair=0;repair<2;repair++) {
    const suffix=repair?'_after_review':'';
    const nameReuse={},safetyReuse={};
    const input={
      ...draftInputs,
      ...(previousReview?{review:previousReview,rejected_draft:previousDraft}:{}),
    };
    let lastCandidate;
    const validateDraft=payload=>{
      lastCandidate=structuredClone(payload);
      // Check the original candidate before any representation normalization.
      // A JSON-object runner must not sneak hypotheses into literal recovery.
      if(literalState)validateSchema(payload,draftSchema,'output',true);
      const excerpts=normalizeEvidenceExcerpts(payload,context,stateRequest);
      const normalized=normalizeReportedOverflow(excerpts.payload,context,stateRequest,draftSchema);
      const result={state:validateState(normalized.payload.state,context,stateRequest,normalized.retained),
        questions:questions?validateRelationshipQuestions(normalized.payload.questions,context,questions):null};
      // This records a structurally validated draft, never independent approval.
      for(const entry of excerpts.diagnostics) {
        try { gateway.diagnosticLogger?.({...entry,generation:'turn_draft'+suffix,
          ...(operation.requestId?{request_id:operation.requestId}:{})}); } catch { /* Diagnostics cannot fail the draft. */ }
      }
      return result;
    };
    const rememberBlocks=()=>{
      if(recovery)recovery.combinedDraft={contextKey,...(failedCandidate===undefined?{}:{candidate:structuredClone(failedCandidate)}),
        ...(blockFeedback?{feedback:blockFeedback,...(feedbackBlock?{feedbackBlock}:{})}:{})};
    };
    let drafted;
    if(!blockDraft) {
      try {
        drafted=await gateway.agentComplete('turn_draft'+suffix,draftPrompt(stateRequest,questions)+
          (literalState?literalStateRepairInstruction({combined:true}):''),input,draftSchema,operation,validateDraft,
          {relationshipBlockRecovery:true});
      } catch(error) {
        const repeatedKeys=error?.modelRelationshipBlockRecovery===true&&error.modelAttempts===2&&error.modelStructuralFailures===2;
        if(!(error instanceof HttpError)||error.code!=='MODEL_INVALID_RESPONSE'||
          (!repeatedKeys&&(error.modelAttempts!==3||error.modelStructuralFailures!==3))||
          !['agent_schema','content_json','stream_whitespace_stall'].includes(error.modelReason))throw error;
        blockDraft=true;failedCandidate=lastCandidate;blockFeedback=error.modelFeedback;feedbackBlock=undefined;
        rememberBlocks();
      }
    }
    if(blockDraft) {
      try {
        const candidate=await generateDraftBlocks(gateway,stateRequest,questions,input,draftSchema,operation,suffix,literalState,blockFeedback,feedbackBlock,stages,context,contextKey,nameReuse);
        drafted=validateDraft(candidate);
      } catch(error) {
        if(error instanceof HttpError&&error.code==='MODEL_INVALID_RESPONSE') {
          if(lastCandidate!==undefined)failedCandidate=lastCandidate;
          blockFeedback=error.modelFeedback;feedbackBlock=error.modelFeedbackBlock;rememberBlocks();
        }
        throw error;
      }
    }
    if(!blockDraft)stages.push('turn_draft'+suffix);
    const result=drafted.state;
    let decision=drafted.questions;
    const claims=stateClaims(result);
    const questionRequest=decision&&(decision.question_plan.skip.length||decision.clarification)
      ?questionReviewRequest(decision,questions):null;
    // A memory repair cannot silently withdraw danger that the independent
    // reviewer already confirmed. Re-review its full evidence alongside any new
    // danger proposal, and persist exactly the proposal that was reviewed.
    const safetyProposal=decision?{
      urgent:decision.finish_early||Boolean(previousDanger),evidence:[...new Map([
        ...(previousDanger?.evidence||[]),...(decision.finish_early?decision.safety_signal.evidence:[]),
      ].map(ref=>[JSON.stringify(ref),ref])).values()],
    }:null;
    if(safetyProposal) validateSafetyEvidence(safetyProposal,context);
    let safetyRequest=safetyProposal?safetyReviewRequest(questions,{safety_signal:safetyProposal}):null;
    const reusableSafety=gateway.stateMode==='combined_blocks'&&gateway.reuseReviewedSafety===true;
    if(safetyRequest&&reusableSafety)safetyRequest=reviewedSafetyRequest(context,safetyRequest);
    // Foreign decisions cannot become reasons to reject otherwise valid state.
    // Each reviewer receives only its own proposal, claims and retrieval scope.
    const stateReviewRequest=combinedStateReviewRequest({
      shared_input:{},review_target:{input:raw,state:reviewState(result),claims,reference_roles:reviewReferenceRoles(result,raw)},
      questions:null,safety:null,
    },suffix);
    const requests=[stateReviewRequest];
    if(questionRequest) {
      requests.push({key:'questions',stage:'question_review'+suffix,prompt:questionRequest.prompt,payload:questionRequest.data,schema:questionRequest.schema,validate:payload=>{
        applyQuestionReview(payload,decision,questionRequest);return payload;
      }});
    }
    if(safetyRequest) {
      requests.push({key:'safety',stage:'safety_review'+suffix,prompt:safetyRequest.prompt,payload:safetyRequest.data,schema:safetyRequest.schema,validate:payload=>{
        validateSafetyReview(payload,context,safetyRequest);return payload;
      }});
    }
    let reviewed;
    if(useReviewBundles&&requests.length>1) {
      const stage='turn_review_bundle'+suffix,bundle=finalReviewBundle(requests,validateSchema);
      try {
        const output=await gateway.agentComplete(stage,bundle.prompt+
          '\n이번 tasks는 상태·질문·안전 검토입니다. 각 task의 원래 입력 경계를 그대로 적용하세요. 상태의 원문은 review_target.input이고, 질문과 안전의 원문은 각 task 입력의 patient/supporter/user_goal입니다. 서로 다른 task의 retrieval·proposal·판정을 섞지 마세요. state task 출력의 questions/safety=null은 그 task 안의 계약이며 독립 questions/safety task를 생략한다는 뜻이 아닙니다.',
          bundle.payload,bundle.schema,operation,bundle.validate);
        operation.controller?.signal.throwIfAborted();
        reviewed=requests.map(request=>output[request.key]);stages.push(stage);
      } catch(error) {
        operation.controller?.signal.throwIfAborted();
        const exhausted=error instanceof HttpError&&error.code==='MODEL_INVALID_RESPONSE'&&error.modelAttempts===3&&
          ['agent_schema','content_json','stream_whitespace_stall','state_review_schema','agent_claim_audit','agent_unknown_audit','agent_review_stale'].includes(error.modelReason);
        const contextLimit=error instanceof HttpError&&error.code==='MODEL_CONTEXT_TOO_LONG'&&error.modelReason==='context_budget';
        if(!exhausted&&!contextLimit)throw error;
        // No partial approval survives a failed envelope. Original requests
        // restore their own schema/scope repair behavior and retry limits.
        useReviewBundles=false;
        if(recovery)recovery.turnReviewBundlesDisabled={contextKey};
        try {gateway.diagnosticLogger?.({event:'model_review_bundle_fallback',generation:stage,reason:error.modelReason,
          ...(operation.requestId?{request_id:operation.requestId}:{})});}catch { /* Diagnostics do not approve reviews. */ }
      }
    }
    if(!reviewed)reviewed=await parallelTurnTasks(operation,requests.map(request=>activeOperation=>
      // An envelope changes the actual reviewer request. Never read or mint a
      // standalone safety fingerprint from its result, including its fallback.
      request.key==='safety'&&reusableSafety&&!bundleReviews
        ?requestReusableSafetyReview(gateway,context,safetyRequest,activeOperation,suffix,safetyReuse,
          !suffix&&!literalState&&!blockFeedback&&!input.review)
        :gateway.agentComplete(request.stage,request.prompt,request.payload,request.schema,activeOperation,request.validate)));
    const [review,...independent]=reviewed;
    // Keep persisted stage order and application precedence independent of
    // network completion order. No partial review becomes approved state.
    stages.push('turn_review'+suffix);
    if(questionRequest){review.questions=independent.shift();stages.push('question_review'+suffix);}
    if(safetyRequest){review.safety=independent.shift();stages.push('safety_review'+suffix);}
    const reviewedSafety=safetyRequest?validateSafetyReview(review.safety,context,safetyRequest):null;
    if(reviewedSafety) previousDanger=reviewedSafety.urgent?reviewedSafety:null;
    if(!review.state.approved) {
      semanticRejections=Math.min(2,semanticRejections+1);
      previousReview=structuredClone(review);
      previousDraft=structuredClone({state:result,questions:decision,claims});
      // Only a fully validated draft/review pair can survive this operation's
      // transport restart. Retain one pair, scoped to unchanged source inputs.
      if(recovery)recovery.combinedTurn={contextKey,review:previousReview,draft:previousDraft,
        danger:previousDanger?structuredClone(previousDanger):null,semanticRejections,literalState:semanticRejections>=2};
      if(repair===1) invalid('state_review_rejected');
      continue;
    }
    if(questionRequest) decision=applyQuestionReview(review.questions,decision,questionRequest);
    if(safetyRequest) {
      decision.finish_early=reviewedSafety.urgent;
      decision.safety_signal=reviewedSafety;
      if(decision.finish_early) { decision.question_plan={skip:[]};decision.clarification=null; }
    }
    if(decision) Object.assign(result,decision);
    result.state_agent={prompt_version:TURN_PROMPT_VERSION,stages,reviewed:true,
      ...(nameReuse.entry&&JSON.stringify(nameReuse.entry.name_index)===JSON.stringify(result.name_index)
        ?{name_reuse:nameReuse.entry}:{}),...(safetyReuse.entry?{safety_reuse:safetyReuse.entry}:{})};
    if(recovery){delete recovery.combinedTurn;delete recovery.combinedDraft;}
    return result;
  }
}
