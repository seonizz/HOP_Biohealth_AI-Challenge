import {createHash, randomUUID} from 'node:crypto';

// Counters describe HTTP attempts, not GPU starts or successfully generated
// tokens. A proxy may queue or reject a dispatched request before inference.
export function createOperationMetrics() {
  return {id:randomUUID(),started:performance.now(),httpAttempts:0,families:new Map()};
}

export function operationMetrics(operation) {
  const metrics=operation.metrics;
  return metrics?{operation_id:metrics.id,operation_restart:operation.restart,
    operation_elapsed_ms:Math.round(performance.now()-metrics.started)}:{};
}

const cards=['script','care','doList','avoid','next','top'];
const blocks=['patient_state','name_index','relationship_memory','questions'];
export function modelStageRole(stage) {
  return /^referral_triage(?:_|$)/u.test(stage)?'classifier':
    /^(?:turn_review|state_review|analysis_review|plan_review|speech_review|support_review|guide_review|speech_detail_review|safety_review|question_review|guide_quality|final_review_bundle|card_review_bundle)(?:_|$)/u.test(stage)?'reviewer':'writer';
}

function familiesOf(stage,request) {
  if(typeof stage!=='string')return ['other'];
  if(modelStageRole(stage)==='classifier')return ['referral_triage'];
  if(modelStageRole(stage)==='reviewer') {
    const bundle=stage.match(/^(turn_review_bundle|final_review_bundle|card_review_bundle)(?:_|$)/u);
    if(bundle)return [bundle[1]];
    const card=stage.match(/^(speech_review|support_review)_card_(script|care|doList|avoid|next)(?:_|$)/u);
    if(card)return [card[1]+'_card_'+card[2]];
    return [stage.match(/^(turn_review|state_review|analysis_review|plan_review|speech_review|support_review|guide_review|speech_detail_review|safety_review|question_review|guide_quality)(?:_|$)/u)[1]];
  }
  const block=stage.match(/^turn_draft_block_(patient_state|name_index|relationship_memory|questions)(?:_|$)/u);
  if(block)return ['turn_'+block[1]];
  if(/^turn_draft(?:_|$)/u.test(stage))return blocks.map(value=>'turn_'+value);
  if(/^state_observations(?:_|$)/u.test(stage))return ['turn_patient_state','turn_name_index'];
  if(/^relationship_memory(?:_|$)/u.test(stage))return ['turn_relationship_memory'];
  if(stage==='question_plan')return ['turn_questions'];
  if(stage==='state')return ['turn_patient_state','turn_name_index','turn_questions'];
  if(/^(?:relationship_analysis|analysis_repair)(?:_|$)/u.test(stage))return ['final_analysis'];
  if(/^communication_plan(?:_|$)/u.test(stage))return ['communication_plan'];
  const card=stage.match(/^(?:card_|guide_repair_card_)(script|care|doList|avoid|next|top)(?:_|$)/u);
  if(card)return ['card_'+card[1]];
  if(/^guide_repair(?:_|$)/u.test(stage)) {
    // Only a bounded field name enters diagnostics, never the source payload.
    let field;
    try {field=JSON.parse(request.messages.find(message=>message.role==='user').content).data?.field;}catch{}
    return (cards.includes(field)?[field]:cards).map(value=>'card_'+value);
  }
  if(/^(?:guide_write|guide_refine|guide)(?:_|$)/u.test(stage))return cards.map(value=>'card_'+value);
  if(/^speech_write(?:_|$)/u.test(stage))return ['card_script'];
  const speech=stage.match(/^speech_(opening|listening|offer|detail)(?:_|$)/u);
  if(speech)return ['speech_'+speech[1]];
  return ['other'];
}

export function beginHttpAttempt(operation,gateway,stage,request) {
  if(!operation.metrics)return {};
  const role=modelStageRole(stage),families=familiesOf(stage,request),metrics=operation.metrics;
  const counts=Object.fromEntries(families.map(family=>{
    const key=role+':'+family,count=(metrics.families.get(key)||0)+1;
    metrics.families.set(key,count);return [family,count];
  }));
  return {...operationMetrics(operation),http_attempt_index:++metrics.httpAttempts,
    model_role:role,family_http_attempts:counts,
    // This identifies the configured gateway, not necessarily a physical GPU.
    // Never log URLs, credentials, model input or user-controlled labels here.
    gateway_fingerprint:createHash('sha256').update(JSON.stringify([gateway.baseUrl,gateway.model])).digest('hex')};
}
