import { HttpError } from './errors.js';

export function claimsOf(groups) {
  return Object.entries(groups).flatMap(([group,items])=>(items||[]).map((item,index)=>({
    id:`${group}.${index}`,claim:item.interpretation,certainty:item.certainty,evidence:item.evidence,
  })));
}

export function auditSchema(claims) {
  return {type:'array',minItems:claims.length,maxItems:claims.length,items:{type:'object',properties:{
    id:{type:'string',enum:claims.length?claims.map(claim=>claim.id):['none']},
    verdict:{type:'string',enum:['supported','plausible','unsupported']},
    reason:{type:'string',minLength:1,maxLength:500},
  },required:['id','verdict','reason'],additionalProperties:false}};
}

export const AUDIT_INSTRUCTION=`
claims의 각 항목을 빠짐없이 독립적으로 검토하고 audits에 같은 id를 한 번씩 반환하세요.
reported는 인용이 주장 전체를 직접 뒷받침할 때 supported입니다. tentative는 실제 원문에서 가능한 해석이고 문장도 가설임을 밝힐 때 plausible입니다. unsupported는 인용 밖 행동·감정·인과·지원자가 추가되거나 일부 주장만 지지되는 경우입니다.
한 문장에 여러 주장이 있으면 전부 대조하세요. 단순히 인용이 있다는 이유나 certainty가 tentative라는 이유로 승인하지 마세요. 원문의 부정·시점·화자도 검토하고 이유를 구체적으로 적으세요.
unsupported가 하나라도 있거나 reported를 plausible로만 판단했다면 approved=false이고 issues에 수정할 부분을 적으세요. 모든 항목이 근거와 확실성에 맞아야 승인할 수 있습니다.`;

function rejectAudit(feedback) {
  const error=new HttpError(502,'MODEL_INVALID_RESPONSE','해석의 근거를 다시 확인하고 있어요.');
  error.modelReason='agent_claim_audit';error.modelFeedback=JSON.stringify(feedback);throw error;
}

export function validateAuditCoverage(audits,claims) {
  const ids=claims.map(claim=>claim.id),counts=new Map(ids.map(id=>[id,0]));
  let unexpected=0;
  for(const audit of Array.isArray(audits)?audits:[]){
    if(audit&&typeof audit==='object'&&!Array.isArray(audit)&&counts.has(audit.id))counts.set(audit.id,counts.get(audit.id)+1);
    else unexpected++;
  }
  const missing=ids.filter(id=>counts.get(id)===0),duplicates=ids.filter(id=>counts.get(id)>1);
  if(!Array.isArray(audits)||audits.length!==claims.length||missing.length||duplicates.length||unexpected)
    rejectAudit({keyword:'auditCoverage',required_audit_ids:ids,missing_audit_ids:missing,duplicate_audit_ids:duplicates,
      unexpected_audit_count:unexpected,actual_audit_count:Array.isArray(audits)?audits.length:null,
      repair:'검토 출력의 audits에 required_audit_ids 각각을 정확히 한 번씩 작성하세요. 누락·중복·목록 밖 ID는 검토 출력의 형식 오류이며 초안의 내용 오류가 아닙니다. 현재 원문과 각 주장을 독립적으로 다시 검토하고 실제 근거 오류는 계속 거절하세요. 자동 승인하지 마세요.'});
}

export function validateAudits(audits,claims,approved) {
  validateAuditCoverage(audits,claims);
  for(const [index,audit] of audits.entries()){
    const claim=claims.find(item=>item.id===audit.id);
    if(Object.keys(audit).sort().join(',')!=='id,reason,verdict'||
      !['supported','plausible','unsupported'].includes(audit.verdict)||typeof audit.reason!=='string'||!audit.reason.trim()||audit.reason.length>500)
      rejectAudit({keyword:'auditFormat',audit_index:index,required_keys:['id','reason','verdict'],
        allowed_verdicts:['supported','plausible','unsupported'],reason_min_length:1,reason_max_length:500,
        repair:'해당 audit의 키·판정·비어 있지 않은 이유를 출력 형식에 맞추세요. 원문과 주장에 대한 독립 검토 없이 판정이나 승인을 바꾸지 마세요.'});
    if(approved&&(audit.verdict==='unsupported'||(claim.certainty==='reported'&&audit.verdict!=='supported')))
      rejectAudit({keyword:'auditApprovalConflict',claim_id:claim.id,verdict:audit.verdict,
        allowed_approved_verdicts:claim.certainty==='reported'?['supported']:['supported','plausible'],
        repair:'approved=true가 해당 audit 판정과 충돌합니다. 현재 원문과 주장을 다시 대조하세요. 근거 오류나 reported의 불확실성이 남으면 approved=false와 구체적인 issues를 반환하세요. 형식에 맞추기 위해 판정을 supported로 올리거나 자동 승인하지 마세요.'});
  }
}
