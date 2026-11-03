// Offline synthetic memory-review augmentation. No model/network calls or app edits.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {relationshipStateRequest,canonicalRelationshipState,assertRetrievedEvidence,
  relationshipMemorySchema,validateSchema} from '../../app/src/relationship-agent.js';
import {requestCombinedStateReview} from '../../app/src/relationship-turn.js';
import {claimsOf} from '../../app/src/grounding-audit.js';

const copy=value=>structuredClone(value);
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
export const checksum=value=>createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
const require=(condition,message)=>{if(!condition)throw new Error(message);};
const refKey=f=>checksum({subject:f.subject,turn:f.turn,quote:f.quote}).slice(0,12);
const ref=f=>({subject:f.subject,question_id:f.subject==='user_goal'?(f.turn===1?'want':'goal'):'s_'+refKey(f),quote:f.quote});
const field=(id,text,turn)=>({id,text,rawText:text,custom:'',status:'answered',question:`${turn}차 발화에서 보고한 내용`});
const scalar=value=>JSON.stringify(value);
const unknownText=scope=>`확인되지 않은 정보: “${scope}”`;
function reportText(subject,quotes) {
  const intro='이용자가 '+(subject==='patient'?'대상자에 관해':'자신의 상황에 관해')+' 보고한 답변 원문';
  const text=intro+':\n'+quotes.map(quote=>'“'+quote+'”').join('\n');
  return text.length<=500?text:intro+'은 근거에 보존했어요.';
}

function factsAt(item,stage) {
  return (stage===1?[...item.facts,...item.superseded].filter(f=>f.turn===1):item.facts)
    .filter((f,i,all)=>all.findIndex(other=>checksum(other)===checksum(f))===i);
}

function contextAt(item,stage) {
  const context={patient:{alias:'상대',fields:{}},supporter:{fields:{}},user_goal:{},
    adaptive_questions:false,question_candidates:[],clarification_candidates:[],answered_count:0};
  // Include every chronological source span, including later-corrected excerpts.
  // Nothing identifies a span as a gold/current/superseded training label.
  const spans=[...item.facts,...item.superseded].filter(f=>f.turn<=stage)
    .sort((a,b)=>a.turn-b.turn||item['turn'+a.turn].indexOf(a.quote)-item['turn'+b.turn].indexOf(b.quote));
  for(const f of spans) {
    if(f.subject==='user_goal')continue;
    const r=ref(f);context[f.subject].fields[r.question_id]=field(r.question_id,f.quote,f.turn);
  }
  for(const turn of [1,2].filter(n=>n<=stage)) {
    const quotes=spans.filter(f=>f.subject==='user_goal'&&f.turn===turn).map(f=>f.quote);
    if(quotes.length)context.user_goal[turn===1?'message':'desired_outcomes']=field(turn===1?'want':'goal',quotes.join('\n'),turn);
  }
  const last=spans.at(-1);
  context.latest_answer={subject:last.subject,question_id:ref(last).question_id};
  context.answered_count=Object.keys(context.patient.fields).length+Object.keys(context.supporter.fields).length+Object.keys(context.user_goal).length;
  return context;
}

function buildState(item,stage,context,request) {
  const facts=factsAt(item,stage).filter(f=>f.subject!=='user_goal');
  const unknowns=stage===2?copy(item.unknowns):[];
  const state={patient_state:{facts:[...facts].sort((a,b)=>b.turn-a.turn).slice(0,3)
    .map(f=>({...ref(f),certainty:'reported'})),unknowns},name_index:null,
    relationship_memory:{patient:[],supporter:[],relationship:[],unknowns:unknowns.map(unknownText)}};
  for(const subject of ['patient','supporter']) {
    const own=facts.filter(f=>f.subject===subject);
    for(let start=0;start<own.length;start+=3)state.relationship_memory[subject].push({
      evidence:own.slice(start,start+3).map(ref),certainty:'reported'});
  }
  validateSchema(state,request.schema,'candidate_draft',true);
  assertRetrievedEvidence(state,request.retrieval);
  return canonicalRelationshipState(copy(state),context,request.schema);
}

function claimsFor(state) {
  return [...claimsOf(Object.fromEntries(['patient','supporter','relationship'].map(group=>[group,state.relationship_memory[group]])))
    .map(claim=>({...claim,kind:claim.certainty==='reported'?'reported_excerpt':'tentative_hypothesis',group:claim.id.split('.')[0]})),
    ...['patient_state','relationship_memory'].flatMap(group=>state[group].unknowns.map((claim,index)=>({
      id:group+'.unknowns.'+index,kind:'unresolved_information',claim,certainty:'unknown',evidence:[]})))];
}

function firstEvidence(item,stage,subject) {
  return factsAt(item,stage).find(f=>f.subject===subject);
}

function perturb(item,stage,state,index) {
  const changed=copy(state),memory=changed.relationship_memory;
  let error;
  const reject=(id,type,reason,repair,verdict='unsupported')=>{
    error={error_type:type,failed_claim_id:id,verdict,reason,repair};
  };
  const replaceClaim=(subject,quote,type,reason,repair,replacementReference=null)=>{
    require(memory[subject].length,'Missing source finding');
    const finding=memory[subject][0],quotes=finding.evidence.map(r=>r.quote);
    quotes[0]=quote;
    if(replacementReference)finding.evidence[0]=replacementReference;
    finding.interpretation=reportText(subject,quotes);
    reject(subject+'.0',type,reason,repair);
  };
  const answeredAsUnknown=()=>{
    require(stage===2&&memory.unknowns.length>0,'Known/unknown contrasts require an existing final unknown');
    const known=factsAt(item,stage).filter(f=>f.subject!=='user_goal').at(-1);
    // Same wrapper and array length as the normal candidate. The original
    // genuine unknown remains in patient_state, so no necessary limit is lost.
    const n=0;
    memory.unknowns[n]=unknownText(known.quote);
    reject('relationship_memory.unknowns.'+n,'known_as_unknown',
      `원문에 “${known.quote}”라는 보고가 있어, 그 보고된 범위를 통째로 미확인으로 둘 수 없다. 전언의 실재 여부를 외부에서 검증했다는 뜻은 아니다.`,
      `relationship_memory.unknowns.${n}에서 이미 보고된 범위를 제거하고 patient_state에 남아 있는 실제 미확인 범위를 유지한다.`,'already_answered');
  };
  const ownGoal=()=>{
    const goal=firstEvidence(item,stage,'user_goal');
    const patient=firstEvidence(item,stage,'patient');
    replaceClaim('patient',goal.quote,'goal_as_patient_wish',
      `“${goal.quote}”는 이용자의 도움 목적이다. 이를 대상자에 관한 보고로 분류한 patient.0은 원문의 화자·역할과 다르다.`,
      `patient.0에는 대상자 보고 “${patient.quote}”를 보존하고 이용자의 목적을 대상자 의향으로 옮기지 않는다.`,ref(goal));
  };
  const supporterAsPatient=()=>{
    const supporter=firstEvidence(item,stage,'supporter');
    const patient=firstEvidence(item,stage,'patient');
    replaceClaim('patient',supporter.quote,'supporter_as_patient',
      `“${supporter.quote}”는 이용자 자신의 보고인데 patient.0이 대상자의 상황으로 저장했다.`,
      `해당 보고는 supporter에 유지하고 patient.0에는 “${patient.quote}” 등 대상자에 관한 근거만 쓴다.`,ref(supporter));
  };
  const unsupportedClaim=()=>{
    const patient=firstEvidence(item,stage,'patient');
    const variants=[
      '대상자가 이 대화의 모든 내용을 다른 사람에게 공개해도 된다고 명시적으로 허락했다.',
      '대상자는 이용자가 자신 대신 모든 약속과 결정을 확정해도 된다고 허락했다.',
      '대상자는 이용자가 앞으로 언제든지 연락을 받아 주기로 확약했다고 확인했다.',
      '대상자는 사적인 연락 내용을 모임 전체에 전달하는 데 이미 동의했다.',
    ];
    const claim=variants[Math.floor(index/4)%variants.length];
    replaceClaim('patient',claim,'unsupported_permission_or_commitment',
      `현재 원문은 “${patient.quote}” 등을 보고했을 뿐, patient.0의 포괄적인 허락·확약을 확인하지 않았다.`,
      `포괄적인 허락·확약을 사실로 저장하지 말고 “${patient.quote}”처럼 실제 보고된 범위만 남긴다.`);
  };
  if(stage===1) {
    [ownGoal,supporterAsPatient,unsupportedClaim][index%3]();
  } else if(item.superseded.some(f=>f.subject!=='user_goal')) {
    const prior=item.superseded.find(f=>f.subject!=='user_goal');
    const latest=item.facts.find(f=>f.subject===prior.subject&&f.turn===2);
    if(latest) {
      const existing=memory[prior.subject][0];
      const latestIndex=existing.evidence.findIndex(r=>r.question_id===ref(latest).question_id);
      require(latestIndex>=0,'Latest corrected source must be present before mutation');
      existing.evidence[latestIndex]=ref(prior);
      existing.interpretation=reportText(prior.subject,existing.evidence.map(r=>r.quote));
      reject(prior.subject+'.0','superseded_as_current',
        `“${prior.quote}”는 이후 “${latest.quote}”로 정정됐는데 이전 내용을 현재 확정 사실로 저장했다.`,
        `${prior.subject}.0을 최신 정정 “${latest.quote}”에 맞춰 고치고 과거 보고를 현재 사실로 되살리지 않는다.`);
    } else answeredAsUnknown();
  } else {
    [answeredAsUnknown,ownGoal,supporterAsPatient,unsupportedClaim][Math.floor(index/4)%4]();
  }
  // Validate candidate shape AFTER corruption; never canonicalize it again,
  // since that would overwrite the intentionally incorrect interpretation.
  validateSchema(memory,relationshipMemorySchema,'candidate_memory',true);
  require(error,'No negative mutation');
  return {state:changed,error};
}

function positiveReason(claim) {
  if(claim.kind==='unresolved_information')return `“${claim.claim}”의 답은 현재 원문에서 확인되지 않으며 도움 범위를 판단할 때 필요한 한계다.`;
  return `같은 화자의 원문 “${claim.evidence[0].quote}” 등 선택된 인용이 이 보고를 뒷받침하며 현재 정정과 모순되지 않는다.`;
}

async function reviewRow(item,stage,state,request,error) {
  const {prior_state,prior_relationship_memory,...raw}=request.data;
  // Raw complete utterances supplement the app's structured source excerpts.
  // They are source material only, not gold facts, replies, or review labels.
  raw.reported_dialogue=Array.from({length:stage},(_,i)=>({turn:i+1,role:'user',content:item['turn'+(i+1)]}));
  const claims=claimsFor(state);
  const payload={shared_input:{},review_target:{input:raw,
    state:{patient_state:{facts:state.patient_state.facts.map(({interpretation,...fact})=>fact)},name_index:state.name_index},
    claims,reference_roles:{known_name:state.name_index,
      user_goal_fields:raw.user_goal.map(({question_id,status})=>({question_id,status,role:question_id==='want'?'intended_message':'desired_outcome'})),
      supporter_report_fields:raw.supporter.map(({question_id,status})=>({question_id,status}))}},questions:null,safety:null};
  let result;
  await requestCombinedStateReview({async agentComplete(appStage,prompt,data,schema,operation,validate) {
    require(appStage==='turn_review','Unexpected app stage');
    const target={state:{audits:data.review_target.claims.map(claim=>({id:claim.id,
      reason:claim.id===error?.failed_claim_id?error.reason:positiveReason(claim),
      verdict:claim.id===error?.failed_claim_id?error.verdict:claim.kind==='unresolved_information'?'still_unknown':'supported'})),
      issues:error?[{reason:error.reason,repair:error.repair}]:[],approved:!error},questions:null,safety:null};
    validate(copy(target));
    result={task:'memory_review',variant:`memory_turn${stage}_${error?'repair_needed':'accepted'}`,
      messages:[{role:'system',content:prompt+'\nreview_target.input.reported_dialogue는 이용자의 전체 원문이며 시점 순서대로 대조하세요. 구조화된 원문 조각은 정답 표지가 아니고 이전 보고도 포함합니다.'},
        {role:'user',content:scalar({stage:appStage,data,output_schema:schema})},
        {role:'assistant',content:scalar(target)}],
      review_metadata:{stage,approved:!error,error_type:error?.error_type??'none',
        failed_claim_id:error?.failed_claim_id??null,
        source_case_id:item.case_id,source_split:item.split,
        origin:'deterministic_synthetic_candidate_perturbation',
        semantic_independent_review:false,app_structural_validation:true,
        candidate_memory_sha256:checksum(state.relationship_memory)}};
    return target;
  }},payload,{});
  require(result,'Request capture failed');
  return result;
}

export async function projectMemoryCase(item,index=Number(item.case_id.match(/(\d+)$/)?.[1]??1)-1) {
  const rows=[];
  for(const stage of [1,2]) {
    const context=contextAt(item,stage),request=relationshipStateRequest(context,null);
    const state=buildState(item,stage,context,request);
    rows.push(await reviewRow(item,stage,state,request,null));
    const bad=perturb(item,stage,state,index);
    rows.push(await reviewRow(item,stage,bad.state,request,bad.error));
  }
  return {case_id:item.case_id,case_sha256:checksum(item),rows};
}

export async function buildMemoryReview(source,output) {
  require(!fs.existsSync(output),'Output already exists');
  const assignments=JSON.parse(fs.readFileSync(path.join(source,'SPLITS.json'),'utf8')).assignments;
  const frozen=new Map(assignments.map(item=>[item.case_id,item.split]));
  const cases=fs.readdirSync(path.join(source,'source')).filter(name=>name.endsWith('.jsonl')).sort()
    .flatMap(name=>fs.readFileSync(path.join(source,'source',name),'utf8').trim().split('\n').map(JSON.parse))
    .sort((a,b)=>a.case_id.localeCompare(b.case_id));
  require(cases.length===200&&frozen.size===200,'Expected frozen 200-case source');
  const ids=new Set(),counts={},errors={};
  const records=[];
  for(const item of cases) {
    require(!ids.has(item.case_id)&&frozen.get(item.case_id)===item.split,'Source identity/split mismatch');ids.add(item.case_id);
    const projected=await projectMemoryCase(item);records.push(projected);
    for(const row of projected.rows) {
      const key=item.split+'/'+row.review_metadata.stage+'/'+(row.review_metadata.approved?'approved':'rejected');
      counts[key]=(counts[key]??0)+1;
      const error=row.review_metadata.error_type;errors[error]=(errors[error]??0)+1;
    }
  }
  const allRows=records.flatMap(record=>record.rows);
  const oldRule=row=>JSON.parse(row.messages[1].content).data.review_target.claims.some(claim=>
    claim.certainty==='reported'&&!claim.claim.startsWith('이용자가 ')||claim.claim.includes('라고 보고했는지 여부'));
  const oldRuleCorrect=allRows.filter(row=>oldRule(row)===!row.review_metadata.approved).length;
  require(oldRuleCorrect===400,'Old surface shortcut has returned');
  for(const record of records)for(const stage of [1,2]) {
    const pair=record.rows.filter(row=>row.review_metadata.stage===stage).map(row=>JSON.parse(row.messages[1].content).data.review_target.claims);
    require(pair[0].length===pair[1].length,'Candidate claim count reveals label');
    require(pair[0].filter(c=>c.kind==='unresolved_information').length===pair[1].filter(c=>c.kind==='unresolved_information').length,
      'Unknown count reveals label');
  }
  fs.writeFileSync(output,records.map(row=>JSON.stringify(row)).join('\n')+'\n',{flag:'wx'});
  const appFiles=['relationship-agent.js','relationship-turn.js','relationship-prompts.js','grounding-audit.js','agent-state.js'];
  const appRoot=new URL('../../app/src/',import.meta.url);
  const app_sha256=Object.fromEntries(appFiles.map(name=>[name,createHash('sha256').update(fs.readFileSync(new URL(name,appRoot))).digest('hex')]));
  const report={status:'passed',cases:200,rows:800,counts,error_types:errors,
    projection_sha256:createHash('sha256').update(fs.readFileSync(output)).digest('hex'),app_sha256,
    app_request_and_output_schema_validated_rows:800,candidate_memory_shape_validated_negative_rows:400,
    source_split_reassigned:false,models_called:0,semantic_independent_review:false,
    surface_shortcut_audit:{old_rule_correct:oldRuleCorrect,total:800,accuracy:oldRuleCorrect/800,paired_claim_and_unknown_counts_equal:true},
    input_extension:'reported_dialogue contains complete chronological user utterances; gold/current status excluded'};
  fs.writeFileSync(output+'.verification.json',JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  return report;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);
  const option=name=>{const index=args.indexOf(name);return index<0?null:args[index+1];};
  const source=option('--source'),output=option('--output');
  require(source&&output,'Usage: node project_memory_review_cases.mjs --source SOURCE_ROOT --output FRESH.jsonl');
  console.log(JSON.stringify(await buildMemoryReview(path.resolve(source),path.resolve(output))));
}
