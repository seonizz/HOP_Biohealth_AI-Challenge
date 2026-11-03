import {HttpError} from './errors.js';
import {isDeepStrictEqual} from 'node:util';
import {avoidCardStructureIssue,parseAvoidCardItem} from './avoid-card-structure.js';

const continuationId=/^continuation_\d+_[a-f0-9]{16}$/u;
// Only server-created, reviewed continuation facts enable this review.
export function hasContinuationSources(answers) {
  return ['patient','supporter'].some(subject=>Array.isArray(answers?.[subject])&&answers[subject].some(row=>
    row.subject===subject&&row.status==='answered'&&continuationId.test(row.question_id||'')&&
    Array.isArray(row.answers)&&row.answers.some(answer=>typeof answer.text==='string'&&answer.text.trim())));
}

const invalid=(reason='agent_context_audit',feedback)=>{
  const error=new HttpError(502,'MODEL_INVALID_RESPONSE','답변의 문맥을 확인하지 못했어요. 다시 시도해 주세요.');
  error.modelReason=reason;
  if(feedback)error.modelFeedback=JSON.stringify(feedback);
  throw error;
};
const invalidCheck=(path,reason,repair,details={})=>invalid('agent_context_audit',{path,reason,repair,...details});

export function validateContextPlanChange(plan,before,review) {
  const unchanged=[...new Set(review.issues.filter(issue=>isDeepStrictEqual(plan[issue.field],before[issue.field])).map(issue=>issue.field))];
  if(unchanged.length){
    const error=new HttpError(502,'MODEL_INVALID_RESPONSE','지적된 대화 계획의 수정을 확인하지 못했어요.');
    error.modelReason='agent_plan_review_rejected';
    error.modelFeedback=JSON.stringify({fields:unchanged,
      repair:'지적된 계획 항목이 수정되지 않았습니다. 원문과 review.context_feedback을 다시 대조하고 해당 항목의 실제 오류를 고치세요. 다른 항목만 바꾸거나 거절된 예문을 복사하지 마세요.'});
    throw error;
  }
  return plan;
}

const instruction=`실제 보고와 카드의 행동 시점·합의 전제를 대조하는 감사입니다. 전체적으로 적절한지, 친절한지, 좋은 의도인지 평가하지 마세요.
먼저 sources에서 보고한 행동/가능 시간/제안을 source_events에 정확히 추출하세요. required_source_ids의 모든 추가 상황 원문을 빠짐없이 포함하고, 나머지는 비교에 필요한 원문을 선택하세요. 시점이 없는 원문은 action_time에 '명시 없음'을 쓰세요. source_events의 quote는 해당 원문의 정확한 연속 구절이어야 합니다.
그 후 units 각각을 정확히 한 번 검토하세요. 각 문장의 시간 표현과 원문의 행동 시점을 나란히 작성하고 같은지 비교하세요. candidate_quote는 해당 unit의 정확한 연속 구절이며, 문제가 있으면 바로 그 전제를 인용하세요. 각 unit 안의 모든 사실 전제를 살피고 하나라도 불일치하면 해당 unit을 거절하세요.
이용자 자신의 여유·가능 시간은 사실 주장이라 실제 sources의 해당 시점 보고가 필요합니다. 다른 날의 가능 시간이나 피곤하다는 보고가 현재 날의 여유를 입증하지 않습니다. 입증되지 않은 사실 주장은 unsupported입니다. 원문에 확인된 가능 시간을 말하며 앞으로 합의를 구하는 것은 consistent입니다. 한 사람의 제안과 다른 사람의 가능 시간만으로 상호 합의한 약속을 만들지 마세요. source_events.status의 agreement도 명시적인 상호 합의 보고일 때만 사용하세요.
전체 장면의 행동 시점과 대화 주제의 시점을 구분하세요. 내일 통화하는 장면에서 '오늘 어땠어?'라고 묻는 것은 오늘 통화 제안이 아닙니다. 조건부 미래 대응과 앞으로 합의를 구하는 제안을 이미 발생한 사실로 판정하지 마세요. 새로운 시간 제안 자체는 근거 없는 가능 시간의 단정과 다릅니다. 사실·시점·합의 전제가 없는 안내는 relation을 not_applicable로 두고 consistent로 판정하세요. care는 앱이 이용자에게 건네는 안내이며 script와 alternative는 이용자가 상대에게 할 말입니다. bad_example은 피하라는 나쁜 예문이므로 실제 권고나 발생 사실로 읽지 마세요. reason과 alternative는 각각 실제 설명·권고로 검토하세요.
comparison에는 candidate_action_time과 source_action_time 및 주장/제안/조건의 차이를 구체적으로 비교하세요. 문제가 있으면 짧은 편집 지시를 쓰고, 문제가 없으면 repair는 null입니다. 정상 문장을 취향 때문에 고치거나 같은 오류의 예문을 복사하지 마세요.
각 unit은 독립된 문맥입니다. 다른 unit의 상황이나 발화 장면을 이 unit에 가져오지 마세요. 기본 발화시점은 현재입니다. future_scene은 이 unit 자체에 통화가 진행되거나 마무리되는 장면을 명시한 경우만 선택합니다. 단지 앞으로 통화하고 싶다고 제안하는 것은 현재 말하는 제안이며 future_scene이 아닙니다.
시점 좌표를 먼저 확정하세요. utterance_frame을 먼저 써서 현재 보낼 답장(current_reply)인지, 앞으로 통화하면서 할 말(future_scene)인지, 직접 발화가 아닌지(not_speech) 구분합니다. 통화가 길어질 때/마무리할 때 건넬 말은 그 통화 장면의 발화입니다. 미래 통화 장면에서 “오늘은 짧게 이야기하고 싶어”의 오늘은 통화 당일이며, 현재 답장 시점의 오늘로 읽지 마세요. candidate_action_time에는 인용 속 단어만 복사하지 말고 해당 장면을 현재 보고 시점 기준으로 환산한 행동 시점을 씁니다. 원문이 내일 통화이고 발화가 그 통화 장면이면 당일=원문의 내일입니다. 반대로 장면 이동 없이 지금 보낼 답장에 “오늘 여유가 있어”라고 쓰면 현재의 오늘에 대한 사실 주장입니다. sources의 제안과 실제 합의, 가용성 단정은 여전히 원문 근거가 필요합니다.
안내 문장 안에 인용된 실제 권고 대사도 해당 발화 장면에서 시점·합의 전제를 비교하세요. not_speech나 안내라는 이유만으로 인용 대사의 사실 검토를 생략하거나 승인하지 마세요. JSON만 작성하세요.`;

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const string=maxLength=>({type:'string',minLength:1,maxLength});
const enumeration=values=>({type:'string',enum:values});
const array=(items,minItems,maxItems)=>({type:'array',items,minItems,maxItems});

function sourceData(answers) {
  const sources=[],required=[];
  for(const subject of ['patient','supporter','user_goal'])for(const row of answers[subject]||[]) {
    if(row.subject!==subject||row.status!=='answered')continue;
    for(const [index,answer] of (row.answers||[]).entries()) {
      if(typeof answer.text!=='string'||!answer.text.trim())continue;
      const id=`${subject}:${row.question_id}:${index}`;
      if(sources.some(source=>source.id===id))invalidCheck(`input.answers.${subject}`,'duplicate_source_id',
        '같은 문항과 답변 순서의 원문 식별자가 중복됩니다. 입력 원문의 식별자를 확인하세요.');
      sources.push({id,subject,text:answer.text});
      if(['patient','supporter'].includes(subject)&&continuationId.test(row.question_id||''))required.push(id);
    }
  }
  return {sources,required};
}

function guideUnits(guide) {
  const units=[];
  const add=(id,field,role,text,context={})=>{
    if(typeof text==='string'&&text.trim())units.push({id,field,role,text,...context});
  };
  add('script.0','script','direct_speech',guide.script);
  add('care.feel','care','care',guide.care?.feel);
  (guide.care?.tips||[]).forEach((text,index)=>add(`care.tips.${index}`,'care','care',text));
  (guide.doList||[]).forEach((text,index)=>add(`doList.${index}`,'doList','guidance',text));
  const issue=avoidCardStructureIssue(guide.avoid||[],{requireBundle:true});
  if(issue)invalid('agent_avoid_structure',issue);
  (guide.avoid||[]).forEach((text,index)=>{
    const parts=parseAvoidCardItem(text);
    for(const role of ['reason','alternative'])add(`avoid.${index}.${role}`,'avoid',role,parts[role],{bad_example:parts.avoid_phrase});
  });
  // Split only explicit paragraph boundaries. A long single paragraph remains
  // intact; sentence punctuation and quoted speech are never rewritten.
  (guide.next||'').split(/\n[\t ]*\n/u).forEach((text,index)=>add(`next.${index}`,'next','guidance',text));
  return units;
}

// Independent, transient review. No output or source is rewritten and no
// canonical card/audit storage contract is extended by these extraction rows.
export function focusedContextReviewRequest({answers,guide,validateSchema}) {
  if(!hasContinuationSources(answers))return null;
  if(typeof validateSchema!=='function')throw new TypeError('validateSchema is required');
  const {sources,required}=sourceData(answers),units=guideUnits(guide);
  if(!units.length)invalidCheck('input.guide','missing_units','검토할 카드 문장이 없습니다. 현재 카드 입력을 확인하세요.');
  const sourceIds=sources.map(source=>source.id),unitIds=units.map(unit=>unit.id);
  const schema=object({
    source_events:array(object({source_id:enumeration(sourceIds),quote:string(1800),
      actor:enumeration(['supporter','patient','both','other']),action:string(180),action_time:string(160),
      status:enumeration(['proposal','availability','agreement','other'])}),required.length,Math.max(sources.length*2,required.length)),
    checks:array(object({id:enumeration(unitIds),utterance_frame:enumeration(['current_reply','future_scene','not_speech']),
      candidate_quote:string(1800),candidate_action_time:string(160),
      source_action_time:string(160),source_ids:array(enumeration(sourceIds),0,sources.length),
      relation:enumeration(['same','different','not_stated','not_applicable']),
      statement:enumeration(['reported_fact','proposal','conditional_future','other']),comparison:string(400),
      verdict:enumeration(['consistent','conflict','unsupported']),repair:{anyOf:[string(180),{type:'null'}]}}),units.length,units.length),
  });
  return {prompt:instruction,schema,payload:{sources,required_source_ids:required,units},validate:output=>{
    try { validateSchema(output,schema,'output',true); }
    catch(error) {
      if(error instanceof HttpError&&error.code==='MODEL_INVALID_RESPONSE') {
        error.modelReason='agent_context_audit';
        let feedback;
        try { feedback=JSON.parse(error.modelFeedback); } catch { feedback={path:'output',reason:'schema_mismatch'}; }
        error.modelFeedback=JSON.stringify({...feedback,
          repair:'지적된 경로의 JSON 형식과 허용된 값을 스키마에 맞추세요. sources와 units의 실제 식별자를 사용하고 각 unit 검토를 정확히 한 번 포함하세요. 기존의 의미 판정은 형식 수정만을 위해 바꾸지 마세요.'});
      }
      throw error;
    }
    const sourceMap=new Map(sources.map(source=>[source.id,source]));
    const eventSources=new Set();
    for(const [index,event] of output.source_events.entries()) {
      const source=sourceMap.get(event.source_id);
      if(!source)invalidCheck(`output.source_events[${index}].source_id`,'unknown_source_id',
        'sources에 실제로 있는 id를 선택하세요. 새 식별자를 만들지 마세요.');
      if(!event.quote.trim()||!source.text.includes(event.quote))invalidCheck(`output.source_events[${index}].quote`,'source_quote_mismatch',
        '선택한 source_id의 text에서 비어 있지 않은 연속 구절을 그대로 인용하세요. 띄어쓰기·구두점·표현을 바꾸거나 다른 원문을 합치지 마세요.');
      eventSources.add(event.source_id);
    }
    const missingSources=required.flatMap((id,index)=>eventSources.has(id)?[]:[index]);
    if(missingSources.length)invalidCheck('output.source_events','missing_required_sources',
      'required_source_ids의 모든 원문을 source_events에 포함하세요. 누락된 원문에서 실제 사건과 정확한 인용을 추가하고 기존 원문은 변경하지 마세요.',
      {missing_required_source_indices:missingSources});
    const unitMap=new Map(units.map(unit=>[unit.id,unit])),seen=new Set(),feedback=[];
    for(const [index,check] of output.checks.entries()) {
      const unit=unitMap.get(check.id);
      if(!unit)invalidCheck(`output.checks[${index}].id`,'unknown_unit_id',
        'units에 실제로 있는 id를 선택하세요. 새 식별자를 만들지 마세요.');
      if(seen.has(check.id))invalidCheck(`output.checks[${index}].id`,'duplicate_unit_id',
        '각 units.id를 checks에 정확히 한 번 포함하세요. 같은 단위를 중복 검토한 행 대신 누락된 단위를 실제로 검토하세요.');
      if(!check.candidate_quote.trim()||!unit.text.includes(check.candidate_quote))invalidCheck(`output.checks[${index}].candidate_quote`,'unit_quote_mismatch',
        '이 check.id에 해당하는 unit.text에서 비어 있지 않은 연속 구절을 그대로 인용하세요. 다른 unit·bad_example·sources를 인용하거나 문장을 수정하지 마세요.');
      if(new Set(check.source_ids).size!==check.source_ids.length)invalidCheck(`output.checks[${index}].source_ids`,'duplicate_source_reference',
        '이 검토가 참조한 실제 sources.id를 중복 없이 나열하세요. 인용과 의미 판정은 그대로 확인하세요.');
      const unknownSource=check.source_ids.findIndex(id=>!sourceMap.has(id));
      if(unknownSource!==-1)invalidCheck(`output.checks[${index}].source_ids[${unknownSource}]`,'unknown_source_reference',
        'sources에 실제로 있는 id만 참조하세요. 없는 근거를 만들지 마세요.');
      seen.add(check.id);
      if(check.verdict!=='consistent')feedback.push({...structuredClone(check),field:unit.field,
        repair:check.repair||'이 항목의 행동 시점과 합의 전제를 실제 원문과 다시 대조하고, 확인되지 않은 사실 단정을 고치세요.'});
    }
    if(seen.size!==units.length)invalidCheck('output.checks','missing_unit_checks',
      '모든 units.id에 대한 검토를 정확히 한 번 작성하세요. 누락된 문장의 원문 비교를 추가하세요.',
      {missing_unit_indices:units.flatMap((unit,index)=>seen.has(unit.id)?[]:[index])});
    return {approved:feedback.length===0,
      issues:feedback.map(check=>({field:check.field,reason:check.comparison,repair:check.repair})),
      context_feedback:feedback};
  }};
}
