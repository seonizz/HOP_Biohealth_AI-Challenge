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

export function validateAudits(audits,claims,approved) {
  const reject=()=>{const error=new HttpError(502,'MODEL_INVALID_RESPONSE','해석의 근거를 다시 확인하고 있어요.');error.modelReason='agent_claim_audit';throw error;};
  if(!Array.isArray(audits)||audits.length!==claims.length)reject();
  const seen=new Set();
  for(const audit of audits){
    if(!audit||typeof audit!=='object'||Array.isArray(audit))reject();
    const claim=claims.find(item=>item.id===audit.id);
    if(!claim||seen.has(audit.id)||Object.keys(audit).sort().join(',')!=='id,reason,verdict'||
      !['supported','plausible','unsupported'].includes(audit.verdict)||typeof audit.reason!=='string'||!audit.reason.trim()||audit.reason.length>500)reject();
    seen.add(audit.id);
    if(approved&&(audit.verdict==='unsupported'||(claim.certainty==='reported'&&audit.verdict!=='supported')))reject();
  }
}
