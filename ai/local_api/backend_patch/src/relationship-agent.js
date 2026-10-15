import { HttpError } from './errors.js';
import { contextGoal, validatePatientState } from './agent-state.js';
import { modelResponseFormat, riskEvidenceQuotes } from './model-schema.js';
import { retrieveSources, retrievedContext, citedSources, citationsRetrieved } from './relationship-retrieval.js';
import { STATE, ANALYZE, PLAN, WRITE, REVIEW, QUALITY, PROMPT_VERSION } from './relationship-prompts.js';

const string = (maxLength = 2000) => ({ type:'string', minLength:1, maxLength });
const object = properties => ({ type:'object', properties, required:Object.keys(properties), additionalProperties:false });
const array = (items, maxItems = 4, minItems = 0) => ({ type:'array', items, maxItems, minItems });
const evidence = object({ subject:{type:'string',enum:['patient','supporter','user_goal']}, question_id:string(80), quote:string(1000) });
const finding = object({ interpretation:string(500), evidence:array(evidence,3,1), certainty:{type:'string',enum:['reported','tentative']} });

const legacyRelationshipSchema = object({
  patient_summary:string(1000), supporter_summary:string(1000),
  relationship:object({ label:string(100), supporter_role:string(100),
    dynamics:array(finding,3), strengths:array(finding,3), boundaries:array(finding,3) }),
  unknowns:array(string(400),4), safety:object({ urgent:{type:'boolean'}, evidence:array(evidence,3) }),
});
legacyRelationshipSchema.properties.relationship.properties.dynamics.items=structuredClone(finding);
legacyRelationshipSchema.properties.relationship.properties.dynamics.items.properties.certainty.enum=['tentative'];
const observationsSchema=object(Object.fromEntries(['patient','supporter'].map(subject=>{
  const reference=structuredClone(evidence);reference.properties.subject.enum=[subject];
  return [subject,array(reference,2)];
})));
export const relationshipDraftSchema=object({observations:observationsSchema,
  relationship:legacyRelationshipSchema.properties.relationship,
  unknowns:legacyRelationshipSchema.properties.unknowns,safety:legacyRelationshipSchema.properties.safety});
export const relationshipSchema=object({patient_summary:string(2400),supporter_summary:string(2400),
  ...relationshipDraftSchema.properties});
export const planSchema = object({ voice:string(300), opening_evidence:array(evidence,2), user_intent:string(700),
  patient_choice:string(500), supporter_care:array(string(500),3), avoid_patterns:array(string(500),4), next_step:string(500) });
export const reviewSchema = object({ approved:{type:'boolean'}, issues:array(object({
  field:{type:'string',enum:['relationship_analysis','script','doList','avoid','next','care','top']}, reason:string(500), repair:string(600),
}),4) });
export const relationshipMemorySchema = object({
  patient:array(finding,2), supporter:array(finding,2), relationship:array(finding,2), unknowns:array(string(400),4),
});
relationshipMemorySchema.properties.relationship.items=structuredClone(finding);
relationshipMemorySchema.properties.relationship.items.properties.certainty.enum=['tentative'];
export const relationshipMemoryDraftSchema=structuredClone(relationshipMemorySchema);
for (const subject of ['patient','supporter']) {
  const reference=structuredClone(evidence);reference.properties.subject.enum=[subject];
  relationshipMemoryDraftSchema.properties[subject].items={anyOf:[
    object({evidence:array(structuredClone(reference),3,1),certainty:{type:'string',enum:['reported']}}),
    object({interpretation:string(500),evidence:array(structuredClone(reference),3,1),certainty:{type:'string',enum:['tentative']}}),
  ]};
}
const analysisReviewSchema = structuredClone(reviewSchema);
analysisReviewSchema.properties.issues.items.properties.field.enum=['relationship_analysis'];
const qualitySchema = object({ improvements:array(object({
  field:{type:'string',enum:['script','doList','avoid','next','care']}, reason:string(300), repair:string(180),
}),3) });

const invalid = reason => {
  const error = new HttpError(502,'MODEL_INVALID_RESPONSE','답변의 근거를 다시 확인하고 있어요. 잠시 후 다시 시도해 주세요.');
  error.modelReason=reason;
  throw error;
};

// Runtime validation remains necessary even when a runner accepts JSON Schema.
function equalJSON(a,b) {
  if (Object.is(a,b)) return true;
  if (!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b)) return false;
  const keys=Object.keys(a);
  return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&equalJSON(a[key],b[key]));
}

export function validateSchema(value, schema, path='output') {
  if (schema.anyOf) {
    for (const variant of schema.anyOf) {
      try { return validateSchema(value,variant,path); }
      catch (error) { if (!(error instanceof HttpError)||error.code!=='MODEL_INVALID_RESPONSE') throw error; }
    }
    invalid('agent_schema');
  }
  if (Object.hasOwn(schema,'const')&&!equalJSON(value,schema.const)) invalid('agent_schema');
  if (schema.type==='object') {
    if (!value || typeof value!=='object' || Array.isArray(value)) invalid('agent_schema');
    const keys=Object.keys(schema.properties);
    if (Object.keys(value).length!==keys.length || keys.some(key=>!Object.hasOwn(value,key))) invalid('agent_schema');
    for (const key of keys) validateSchema(value[key],schema.properties[key],path+'.'+key);
  } else if (schema.type==='array') {
    if (!Array.isArray(value) || value.length>(schema.maxItems??Infinity) || value.length<(schema.minItems??0)) invalid('agent_schema');
    value.forEach(item=>validateSchema(item,schema.items,path));
  } else if (schema.type==='string') {
    if (typeof value!=='string' || !value.trim() || value.length>schema.maxLength) invalid('agent_schema');
  } else if (schema.type==='boolean' && typeof value!=='boolean') invalid('agent_schema');
  else if (schema.type==='null' && value!==null) invalid('agent_schema');
  if (schema.enum && !schema.enum.some(candidate=>equalJSON(value,candidate))) invalid('agent_schema');
  return value;
}

function sourceField(context, ref) {
  if (ref.subject==='user_goal') return ref.question_id==='want' ? context.user_goal?.message
    : ref.question_id==='goal' ? context.user_goal?.desired_outcomes : undefined;
  return context[ref.subject]?.fields?.[ref.question_id];
}

function sourceTexts(field) {
  return [...new Set([field?.rawText,field?.text,field?.custom,field?.followUp?.answer?.rawText,
    field?.followUp?.answer?.text,field?.followUp?.answer?.custom].filter(v=>typeof v==='string'&&v.trim()))];
}

// Select whole source references in the runner's grammar; do not let independent
// actor, question and quote choices form a reference that never appeared.
export function groundedEvidenceSchema(schema,context) {
  const references=[],safetyReferences=[];
  const add=(list,subject,field,quotes)=>{
    for (const quote of quotes) if (quote.trim()&&quote.length<=1000) {
      const ref={subject,question_id:field.id,quote};
      if (!list.some(item=>JSON.stringify(item)===JSON.stringify(ref))) list.push(ref);
    }
  };
  const fields=['patient','supporter'].flatMap(subject=>
    Object.values(context[subject]?.fields||{}).map(field=>({subject,field})));
  for (const field of Object.values(context.user_goal||{})) if (field?.id) fields.push({subject:'user_goal',field});
  for (const {subject,field} of fields) {
    if (field.status!=='answered') continue;
    const sources=sourceTexts(field);
    for (const text of sources) {
      const quotes=[text,...text.split(/(?<=[.!?。！？])\s+|\n+/u).map(part=>part.trim())];
      // Long answers remain intact in the input. These are citation excerpts only.
      if (text.length>1000) for (let offset=0;offset<text.length;) {
        let end=Math.min(offset+1000,text.length);
        if (end<text.length&&/[\uD800-\uDBFF]/u.test(text[end-1])) end--;
        quotes.push(text.slice(offset,end));offset=end;
      }
      add(references,subject,field,quotes);
    }
    const riskQuotes=riskEvidenceQuotes(field);
    add(safetyReferences,subject,field,riskQuotes.length?riskQuotes:sources);
  }
  // Schema templates reuse nodes; each output path needs its own candidate pool.
  const result=JSON.parse(JSON.stringify(schema));
  const visit=(node,path=[])=>{
    if (path[0]==='observations'&&node.type==='array') {
      const subjects=node.items.properties.subject.enum;
      if (!references.some(ref=>subjects.includes(ref.subject)&&ref.question_id!=='name')) node.maxItems=0;
    }
    if (node.type==='object'&&Object.keys(node.properties||{}).length===3&&
      ['subject','question_id','quote'].every(key=>node.properties[key])) {
      const pool=path.includes('safety')?safetyReferences:references;
      const candidates=pool.filter(ref=>(!node.properties.subject.enum||node.properties.subject.enum.includes(ref.subject))&&
        (!path.includes('observations')||ref.question_id!=='name'));
      // XGrammar rejects an empty enum even in an unused array branch.
      if (candidates.length) node.enum=candidates;
      else delete node.enum;
    }
    for (const [key,child] of Object.entries(node.properties||{})) visit(child,[...path,key]);
    if (node.items) visit(node.items,[...path,'items']);
    for (const child of node.anyOf||[]) visit(child,path);
  };
  visit(result);
  return result;
}

export function validateEvidence(ref, context) {
  const field=sourceField(context,ref);
  if (!field || field.id!==ref.question_id || field.status!=='answered' ||
    !sourceTexts(field).some(source=>source.includes(ref.quote))) invalid('agent_evidence');
  return ref;
}

// These labels repeatedly appeared in live evaluations without being reported.
// Preserve user-supplied wording; do not promote observed behavior to a new label.
function validateReportedLabels(text,sources) {
  for(const pattern of [/완벽주의/gu,/강박/gu,/수면\s*장애/gu]) {
    for(const match of text.matchAll(pattern)) {
      const label=match[0].replace(/\s+/gu,'');
      if(!sources.some(source=>source.replace(/\s+/gu,'').includes(label)))invalid('agent_unreported_label');
    }
  }
}

function validateObservations(observations,context) {
  for (const subject of ['patient','supporter']) for (const ref of observations[subject]) {
    if (ref.subject!==subject) invalid('agent_observation_subject');
    if (ref.question_id==='name') invalid('agent_observation_name_only');
    validateEvidence(ref,context);
  }
}

function observationSummary(subject,observations) {
  if (!observations.length) return subject==='patient'
    ? '대상자의 상태에 관한 답변 근거는 아직 확인되지 않았어요.'
    : '이용자 자신의 상황에 관한 답변 근거는 아직 확인되지 않았어요.';
  const introduction=subject==='patient'?'대상자에 관한 이용자 답변 원문:':'이용자 자신의 상황에 관한 답변 원문:';
  return introduction+'\n'+observations.map(ref=>'“'+ref.quote+'”').join('\n');
}

function validateRelationshipDetails(value,context) {
  const interpretations=new Set();
  for (const key of ['dynamics','strengths','boundaries']) for (const item of value.relationship[key]) {
    const normalized=item.interpretation.normalize('NFKC').replace(/\s+/gu,'');
    if(interpretations.has(normalized))invalid('agent_duplicate_findings');
    interpretations.add(normalized);
    validateReportedLabels(item.interpretation,item.evidence.map(ref=>ref.quote));
    item.evidence.forEach(ref=>validateEvidence(ref,context));
  }
  value.safety.evidence.forEach(ref=>{
    validateEvidence(ref,context);
    const field=sourceField(context,ref);
    const riskQuotes=riskEvidenceQuotes(field);
    const candidates=riskQuotes.length?riskQuotes:sourceTexts(field);
    const normalize=text=>text.trim().replace(/[.!?。！？]+$/u,'');
    if (!candidates.some(quote=>normalize(quote)===normalize(ref.quote))) invalid('agent_safety_context');
  });
  if (value.safety.urgent && !value.safety.evidence.length) invalid('agent_safety_evidence');
  const relation=context.patient?.fields?.rel;
  if (relation?.status==='answered') {
    if (!sourceTexts(relation).some(text=>text.includes(value.relationship.label))) invalid('agent_relationship_label');
  } else if (value.relationship.label!=='확인되지 않음' || value.relationship.supporter_role!=='확인되지 않음') {
    invalid('agent_relationship_unknown');
  }
}

// Stored legacy reports remain readable; new reports must carry literal observations.
export function validateRelationship(value,context) {
  const hasObservations=Boolean(value&&Object.hasOwn(value,'observations'));
  validateSchema(value,hasObservations?relationshipSchema:legacyRelationshipSchema);
  if (hasObservations) {
    validateObservations(value.observations,context);
    for (const subject of ['patient','supporter']) if (value[subject+'_summary']!==observationSummary(subject,value.observations[subject])) {
      invalid('agent_observation_summary');
    }
  }
  for(const subject of ['patient','supporter'])validateReportedLabels(value[subject+'_summary'],
    Object.values(context[subject]?.fields||{}).filter(field=>field.status==='answered').flatMap(sourceTexts));
  validateRelationshipDetails(value,context);
  return structuredClone(value);
}

export function validateRelationshipDraft(value,context) {
  validateSchema(value,relationshipDraftSchema);
  validateObservations(value.observations,context);
  validateRelationshipDetails(value,context);
  return structuredClone(value);
}

// The model selects quotes; only the server creates the display summary strings.
export function canonicalRelationship(value,context) {
  const draft=validateRelationshipDraft(value,context);
  return validateRelationship({patient_summary:observationSummary('patient',draft.observations.patient),
    supporter_summary:observationSummary('supporter',draft.observations.supporter),...draft},context);
}

export function validatePlan(value,context) {
  validateSchema(value,planSchema);
  value.opening_evidence.forEach(ref=>validateEvidence(ref,context));
  return structuredClone(value);
}

export function validateReview(value) {
  validateSchema(value,reviewSchema);
  if (value.approved !== (value.issues.length===0)) invalid('agent_review');
  return value;
}

export function validateRelationshipMemory(value,context) {
  validateSchema(value,relationshipMemorySchema);
  for (const subject of ['patient','supporter','relationship']) for (const item of value[subject]) {
    validateReportedLabels(item.interpretation,item.evidence.map(ref=>ref.quote));
    if (!item.evidence.some(ref=>ref.question_id!=='name')) invalid('agent_memory_name_only');
    for (const ref of item.evidence) {
      validateEvidence(ref,context);
      if (subject!=='relationship' && ref.subject!==subject) invalid('agent_memory_subject');
    }
  }
  return structuredClone(value);
}

function reportedInterpretation(subject,quotes,certainty='reported',maxLength=500) {
  const target=subject==='patient'?'대상자에 관해':'자신의 상황에 관해';
  const report=certainty==='unknown'?'미확인으로 남긴':'보고한';
  const introduction='이용자가 '+target+' '+report+' 답변 원문';
  const literal=introduction+':\n'+quotes.map(quote=>'“'+quote+'”').join('\n');
  return literal.length<=maxLength?literal:introduction+'은 근거에 보존했어요.';
}

export function canonicalPatientState(value,context) {
  const state=validatePatientState(value,context);
  state.facts=state.facts.map(fact=>({...fact,interpretation:reportedInterpretation(fact.subject,[fact.quote],fact.certainty,2000)}));
  const summary=state.facts.map(fact=>fact.interpretation).join('\n');
  state.summary=!summary?'대상자와 이용자의 상황은 아직 확인되지 않았어요.':summary.length<=4000?summary
    :'대상자와 이용자에 관한 답변 원문은 근거에 보존했어요. 미확인 항목은 확정된 관찰이 아니에요.';
  return validatePatientState(state,context);
}

export function canonicalRelationshipMemory(value,context) {
  validateSchema(value,relationshipMemorySchema);
  const memory=structuredClone(value);
  for (const subject of ['patient','supporter']) for (const item of memory[subject]) if (item.certainty==='reported') {
    item.interpretation=reportedInterpretation(subject,item.evidence.map(ref=>ref.quote));
  }
  return validateRelationshipMemory(memory,context);
}

export function canonicalRelationshipState(payload,context,schema=relationshipStateRequest(context,null).schema) {
  validateSchema(payload,schema);
  const facts=payload.patient_state.facts.map(fact=>({...fact,
    interpretation:reportedInterpretation(fact.subject,[fact.quote],fact.certainty,2000)}));
  const patient_state=canonicalPatientState({summary:'원문 근거를 확인했어요.',facts,
    unknowns:payload.patient_state.unknowns,user_goal:contextGoal(context)},context);
  const internal=structuredClone(payload.relationship_memory);
  for (const subject of ['patient','supporter']) for (const item of internal[subject]) if (item.certainty==='reported') {
    item.interpretation=reportedInterpretation(subject,item.evidence.map(ref=>ref.quote));
  }
  return {patient_state,name_index:payload.name_index,relationship_memory:canonicalRelationshipMemory(internal,context)};
}

export function currentRelationshipMemory(context) {
  try { return canonicalRelationshipMemory(context.relationship_state,context); } catch { return null; }
}

function reviewedRelationshipMemory(analysis,context) {
  const resources=[...analysis.relationship.strengths,...analysis.relationship.boundaries];
  const substantive=item=>item.evidence.some(ref=>ref.question_id!=='name');
  const findings=subject=>resources.filter(item=>substantive(item)&&item.evidence.every(ref=>ref.subject===subject)).slice(0,2);
  return canonicalRelationshipMemory({patient:findings('patient'),supporter:findings('supporter'),
    relationship:analysis.relationship.dynamics.filter(substantive).slice(0,2).map(item=>({...item,certainty:'tentative'})),
    unknowns:analysis.unknowns},context);
}

// Current question snapshots own IDs and subjects; no hard-coded 29-question schema.
export function agentContext(context) {
  const fields = subject => Object.values(context[subject]?.fields||{}).filter(field=>
    ['answered','unknown','refused','skipped','auto_skipped'].includes(field.status)).map(field=>({
      subject,question_id:field.id,question:field.question,status:field.status,
      answers:['answered','unknown'].includes(field.status)?sourceTexts(field):[],
    }));
  const goals=['message','desired_outcomes'].map(key=>context.user_goal?.[key]).filter(Boolean).map(field=>({
    subject:'user_goal',question_id:field.id,question:field.question,status:field.status,
    answers:field.status==='answered'?sourceTexts(field):[],
  }));
  return { patient:fields('patient'),supporter:fields('supporter'),user_goal:goals,
    supplied_user_goal:contextGoal(context),alias:context.patient?.alias||'그분',
    prior_relationship_memory:currentRelationshipMemory(context) };
}

// Reviewed immediate-help actions: generation must select these exact values.
// The caller supplies only a source-validated name index, never a fallback alias.
export function urgentGuideActions(name) {
  const salutation=typeof name?.alias==='string'&&name.alias.trim()?name.alias+', ':'';
  return {
    script:salutation+'지금 안전이 가장 걱정돼요. 길게 설명하지 않아도 괜찮아요. 지금 응급 도움을 요청할게요. 혼자 감당하지 않고 함께 도움을 구할게요.',
    doList:[
      '지금 지역 응급기관에 현재 위험과 위치를 알리세요. 동의나 답변을 기다리며 도움 요청을 늦추지 마세요.',
      '이용자 자신의 안전을 먼저 지키세요. 함께 있어도 안전할 때만 곁에 머무르고, 위험하면 안전한 곳에서 도움을 요청하세요.',
      '신뢰할 수 있는 주변 사람에게도 도움을 요청해 역할을 나누세요. 혼자 물리적으로 제압하거나 붙잡으려 하지 마세요.',
    ],
    avoid:[
      '비밀을 지키겠다고 약속하며 도움 요청을 미루지 마세요. 지금 필요한 응급 도움을 요청하세요.',
      '상황 설명이나 답변을 재촉하지 마세요. 상대의 대답과 별개로 응급 도움은 지금 요청하세요.',
      '혼자 감당하겠다고 약속하거나 위험을 무릅쓰고 붙잡지 마세요. 자신의 안전을 지키며 주변 도움을 구하세요.',
    ],
    next:'지금 지역 응급기관에 연락해 현재 위험과 위치를 알리세요. 동의를 기다리며 미루지 마세요. 자신의 안전을 먼저 지키고 신뢰할 수 있는 주변 사람에게도 함께 도움을 요청하세요.',
    care:{tips:['안전한 곳에서 도움을 요청하세요.','혼자 판단하거나 감당하지 말고 주변의 도움을 함께 구하세요.']},
  };
}

export async function runRelationshipAgent(gateway,context,memory,name,operation) {
  memory=canonicalPatientState(memory,context);
  const data=agentContext(context);
  const stages=[], retrievalTrace=[];
  const generate=async (stage,prompt,payload,schema,tokens,validate)=>{
    const retrieval=retrieveSources(context,{stage,required:citedSources(payload),
      query:[payload.analysis?.patient_summary,payload.analysis?.supporter_summary,
        ...(payload.review?.issues||[]).map(issue=>issue.reason+' '+issue.repair)].filter(Boolean).join(' ')});
    const scoped=retrievedContext(context,retrieval);
    const result=await gateway.agentComplete(stage,prompt,{...payload,retrieval},groundedEvidenceSchema(schema,scoped),tokens,operation,value=>{
      assertRetrievedEvidence(value,retrieval);
      return validate(value);
    });
    retrievalTrace.push({stage,indexed_sources:retrieval.indexed_sources,source_ids:retrieval.documents.map(row=>row.source_id)});
    stages.push(stage);
    return result;
  };
  const relationKnown=context.patient?.fields?.rel?.status==='answered';
  const analysisPrompt=ANALYZE+(relationKnown ? '' : '\n관계 답변이 미확인입니다. relationship.label과 supporter_role은 반드시 확인되지 않음으로 쓰세요.');
  const analysisSchema=groundedEvidenceSchema(relationshipDraftSchema,context);
  let analysis=await generate('relationship_analysis',analysisPrompt,data,analysisSchema,2400,v=>canonicalRelationship(v,context));
  const analysisReviewPrompt=REVIEW+'\n지금은 analysis만 원문과 대조하세요. 안내 문장은 아직 없으며 평가하지 마세요. 모든 issue.field는 relationship_analysis입니다.';
  let analysisRepairs=0;
  const repairAnalysis=async (review,late=false)=>{
    if (analysisRepairs>=1) invalid('agent_analysis_review_rejected');
    analysisRepairs++;
    const analysisIssues={approved:false,issues:review.issues.filter(issue=>issue.field==='relationship_analysis')};
    analysis=await generate(late?'analysis_repair_after_guide_review':'analysis_repair',
      analysisPrompt+'\n검토의 중대한 분석 오류를 바로잡고 원문 근거로 전체 분석을 다시 작성하세요.',
      {answers:data,draft:analysis,review:analysisIssues},analysisSchema,2400,v=>canonicalRelationship(v,context));
    const repairedReview=await generate(late?'analysis_review_after_guide_review_repair':'analysis_review_after_repair',
      analysisReviewPrompt,{answers:data,analysis},analysisReviewSchema,900,validateReview);
    if (!repairedReview.approved) invalid('agent_analysis_review_rejected');
  };
  const analysisReview=await generate('analysis_review',analysisReviewPrompt,{answers:data,analysis},analysisReviewSchema,900,validateReview);
  if (!analysisReview.approved) await repairAnalysis(analysisReview);
  const finalSchema=modelResponseFormat(context,true).json_schema.schema;
  const guideSchema=object({ guide:finalSchema.properties.guide,assessment:finalSchema.properties.assessment });
  const currentGuideSchema=()=>{
    const schema=structuredClone(guideSchema);
    if (analysis.safety.urgent) {
      const actions=urgentGuideActions(name),properties=schema.properties.guide.properties;
      for (const key of ['script','doList','avoid','next']) properties[key].enum=[actions[key]];
      properties.care.properties.tips.enum=[actions.care.tips];
    }
    return schema;
  };
  const currentReviewRequest=quality=>{
    const schema=structuredClone(quality?qualitySchema:reviewSchema);
    if (!analysis.safety.urgent) return {schema,metadata:{}};
    schema.properties[quality?'improvements':'issues'].items.properties.field.enum=quality
      ?['care']:['relationship_analysis','care','top'];
    return {schema,metadata:{review_scope:{
      guide_fields:quality?['care.feel']:['care.feel','top'],include_analysis:!quality,
      fixed_action_fields:['script','doList','avoid','next','care.tips'],fixed_action_version:'immediate-help-v1',
    }}};
  };
  const validateDraft = draft => {
    validateSchema(draft,guideSchema);
    if (draft.assessment.safety!==analysis.safety.urgent) invalid('agent_safety_mismatch');
    if (analysis.safety.urgent) {
      const actions=urgentGuideActions(name);
      if (['script','doList','avoid','next'].some(key=>JSON.stringify(draft.guide[key])!==JSON.stringify(actions[key]))||
        JSON.stringify(draft.guide.care.tips)!==JSON.stringify(actions.care.tips)) invalid('agent_urgent_action');
    } else {
      for(const key of ['script','next'])draft.guide[key]=draft.guide[key].replace(/[ \t]*\(줄바꿈\)[ \t]*/gu,'\n\n');
    }
    const goal=context.user_goal?.desired_outcomes;
    const treatmentGoal=goal?.status==='answered'&&goal.selected?.some(option=>option.meta?.t==='goal_treat');
    if(treatmentGoal&&!analysis.safety.urgent&&!/상담|진료|전문가|의사|치료사/u.test(draft.guide.script))invalid('agent_goal_missing');
    return draft;
  };
  const reviewGuide=async (stage,draft)=>{
    const request=currentReviewRequest(false);
    return generate(stage,REVIEW,{answers:data,analysis,guide:draft.guide,...request.metadata},request.schema,900,value=>{
      validateSchema(value,request.schema);
      return validateReview(value);
    });
  };
  const composeGuide=async suffix=>{
    const plan=await generate('communication_plan'+suffix,PLAN,{answers:data,analysis},groundedEvidenceSchema(planSchema,context),1200,v=>validatePlan(v,context));
    const writerData={answers:data,analysis,plan};
    let draft=await generate('guide_write'+suffix,WRITE,writerData,currentGuideSchema(),3600,validateDraft);
    const qualityRequest=currentReviewRequest(true);
    const quality=await generate('guide_quality'+suffix,QUALITY,{...writerData,guide:draft.guide,...qualityRequest.metadata},
      qualityRequest.schema,1100,value=>validateSchema(value,qualityRequest.schema));
    if (quality.improvements.length) {
      const refinementSchema=currentGuideSchema();
      if (analysis.safety.urgent) refinementSchema.properties.guide.properties.top.enum=[draft.guide.top];
      draft=await generate('guide_refine'+suffix,WRITE+'\n품질 검토의 제안을 적용하되 사실·관계·목적·안전 판단은 원문을 유지하세요.',
        {...writerData,draft:draft.guide,quality},refinementSchema,3600,value=>{
          validateDraft(value);
          validateSchema(value.guide.top,refinementSchema.properties.guide.properties.top);
          return value;
        });
    }
    const review=await reviewGuide('guide_review'+suffix,draft);
    return {writerData,draft,review};
  };
  let phaseSuffix='';
  let {writerData,draft,review}=await composeGuide(phaseSuffix);
  let guideRepairs=0;
  while (!review.approved) {
    if (review.issues.some(issue=>issue.field==='relationship_analysis')) {
      await repairAnalysis(review,true);
      phaseSuffix='_after_analysis_repair';
      ({writerData,draft,review}=await composeGuide(phaseSuffix));
      continue;
    }
    if (guideRepairs>=2) invalid('agent_review_rejected');
    guideRepairs++;
    const suffix=(guideRepairs===1?'':'_2')+phaseSuffix;
    draft=await generate('guide_repair'+suffix,WRITE+'\n검토에서 지적한 중대한 문제를 바로잡고 전체 JSON을 다시 작성하세요.',
      {...writerData,draft:draft.guide,review},currentGuideSchema(),3600,validateDraft);
    review=await reviewGuide('guide_review_after_repair'+suffix,draft);
  }
  return {payload:{...draft,patient_state:memory,name_index:name},relationship_analysis:analysis,
    relationship_memory:reviewedRelationshipMemory(analysis,context),
    agent:{prompt_version:PROMPT_VERSION,stages,reviewed:true,quality_reviewed:true,
      ...(analysis.safety.urgent?{safety_guidance_version:'immediate-help-v1'}:{}),
      retrieval:{method:'conversation_lexical_v1',stages:retrievalTrace}}};
}

export function relationshipStateRequest(context,memory,final=false) {
  if (memory) {
    try { memory=canonicalPatientState(memory,context); } catch { memory=null; }
  }
  const retrieval=retrieveSources(context,{stage:'state',required:citedSources({memory,relationship:currentRelationshipMemory(context)})});
  const data={...agentContext(context),prior_state:memory,final,retrieval};
  data.latest_answer=[...data.patient,...data.supporter,...data.user_goal].find(row=>
    row.question_id===context.latest_answer?.question_id&&row.subject===context.latest_answer?.subject)||null;
  const scoped=retrievedContext(context,retrieval);
  const schema=modelResponseFormat({...scoped,question_candidates:[]},false).json_schema.schema;
  const state=schema.properties.patient_state;
  for (const key of ['summary','user_goal']) delete state.properties[key];
  state.required=state.required.filter(key=>!['summary','user_goal'].includes(key));
  for (const variant of state.properties.facts.items.anyOf||[]) {
    delete variant.properties.interpretation;
    variant.required=variant.required.filter(key=>key!=='interpretation');
  }
  state.properties.facts.maxItems=3;state.properties.unknowns.maxItems=4;
  const internal=structuredClone(relationshipMemoryDraftSchema);
  let prompt=STATE;
  for (const subject of ['patient','supporter']) {
    const available=Object.values(scoped[subject]?.fields||{}).some(field=>field.status==='answered'&&field.id!=='name'&&sourceTexts(field).length);
    if (!available) {
      internal.properties[subject].maxItems=0;
      prompt+='\n'+subject+'의 분석에 사용할 answered 원문이 없으므로 relationship_memory.'+subject+'=[]입니다. user_goal의 원문을 옮겨 넣지 마세요.';
    }
  }
  return {data,retrieval,schema:groundedEvidenceSchema(object({patient_state:state,name_index:schema.properties.name_index,relationship_memory:internal}),scoped),prompt};
}

export function assertRetrievedEvidence(value,retrieval) {
  if(!citationsRetrieved(value,retrieval))invalid('agent_retrieval_evidence');
}
