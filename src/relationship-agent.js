import { HttpError } from './errors.js';
import { contextGoal, validatePatientState, validateQuestionPlan } from './agent-state.js';
import { modelResponseFormat, riskEvidenceQuotes } from './model-schema.js';
import { retrieveSources, retrievedContext, citedSources, citationsRetrieved } from './relationship-retrieval.js';
import { COMMON, STATE, ANALYZE, PLAN, WRITE, REVIEW, QUALITY, PLAN_REVIEW, SPEECH_REVIEW, SPEAK, SUPPORT_REVIEW, PROMPT_VERSION, CARD_ROLES, SPEECH_PARTS, DETAIL } from './relationship-prompts.js';
import { claimsOf, auditSchema, validateAudits, AUDIT_INSTRUCTION } from './grounding-audit.js';

const string = (maxLength = 2000) => ({ type:'string', minLength:1, maxLength });
const object = properties => ({ type:'object', properties, required:Object.keys(properties), additionalProperties:false });
const array = (items, maxItems = 4, minItems = 0) => ({ type:'array', items, maxItems, minItems });
const mindReading = /마음.{0,12}때문|완벽.{0,25}(?:때문|싶어서)|네가 얼마나.{0,45}(?:알|보고|느낄|느껴)|다 알고|잘 알고/u;
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

const invalid = (reason,feedback) => {
  const error = new HttpError(502,'MODEL_INVALID_RESPONSE','답변의 근거를 다시 확인하고 있어요. 잠시 후 다시 시도해 주세요.');
  error.modelReason=reason;
  if(feedback)error.modelFeedback=feedback;
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
        (!node.properties.subject.const||node.properties.subject.const===ref.subject)&&
        (!node.properties.question_id.const||node.properties.question_id.const===ref.question_id)&&
        (!node.properties.quote.enum||node.properties.quote.enum.includes(ref.quote))&&
        ref.quote.length<=(node.properties.quote.maxLength??1000)&&
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
function unreportedLabelIssues(text,sources) {
  const issues=[];
  for(const pattern of [/완벽주의/gu,/강박/gu,/수면\s*장애/gu,/방관/gu,/무관심/gu,/무책임/gu,/안쓰러/gu]) {
    for(const match of text.matchAll(pattern)) {
      const label=match[0].replace(/\s+/gu,'');
      if(!sources.some(source=>source.replace(/\s+/gu,'').includes(label)))issues.push(
        '수정할 해석: '+text+'\n근거에 없는 명칭: '+match[0]+'\n이 해석을 인용에 실제 있는 행동 표현으로 다시 쓰세요. 인용은 '+JSON.stringify(sources)+'입니다.');
    }
  }
  return issues;
}
function validateReportedLabels(text,sources) {
  const issues=unreportedLabelIssues(text,sources);
  if(issues.length)invalid('agent_unreported_label',issues.join('\n'));
}

function validateHypotheses(groups) {
  for(const items of Object.values(groups)) for(const item of items) {
    if(item.certainty==='tentative'&&!/수 있|가능|가설|추정|듯|확인.{0,8}필요/u.test(item.interpretation)) invalid('agent_hypothesis_language');
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

export function validateSafetyEvidence(safety,context) {
  validateSchema(safety,relationshipDraftSchema.properties.safety);
  safety.evidence.forEach(ref=>{
    validateEvidence(ref,context);
    const field=sourceField(context,ref);
    const riskQuotes=riskEvidenceQuotes(field);
    const candidates=riskQuotes.length?riskQuotes:sourceTexts(field);
    const normalize=text=>text.trim().replace(/[.!?。！？]+$/u,'');
    if (!candidates.some(quote=>normalize(quote)===normalize(ref.quote))) invalid('agent_safety_context');
  });
  if (safety.urgent && !safety.evidence.length) invalid('agent_safety_evidence');
  return safety;
}

function validateRelationshipDetails(value,context) {
  const interpretations=new Set(),labelIssues=[];
  for (const key of ['dynamics','strengths','boundaries']) for (const item of value.relationship[key]) {
    const normalized=item.interpretation.normalize('NFKC').replace(/\s+/gu,'');
    if(interpretations.has(normalized))invalid('agent_duplicate_findings');
    interpretations.add(normalized);
    labelIssues.push(...unreportedLabelIssues(item.interpretation,item.evidence.map(ref=>ref.quote)));
    item.evidence.forEach(ref=>validateEvidence(ref,context));
  }
  if(labelIssues.length)invalid('agent_unreported_label',labelIssues.join('\n'));
  validateSafetyEvidence(value.safety,context);
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
  validateHypotheses(Object.fromEntries(['dynamics','strengths','boundaries'].map(key=>[key,value.relationship[key]])));
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
  validateHypotheses(Object.fromEntries(['patient','supporter','relationship'].map(key=>[key,payload.relationship_memory[key]])));
  const latest=context.latest_answer;
  const latestField=['patient','supporter'].includes(latest?.subject)?sourceField(context,latest):null;
  const latestSources=latestField?.followUp?.answer
    ? [...sourceTexts(latestField.followUp.answer),...sourceTexts(latestField)] : sourceTexts(latestField);
  const latestQuote=latestField?.status==='answered'?latestSources.find(text=>text.length<=10000):null;
  const selected=structuredClone(payload.patient_state.facts);
  // The source is already persisted. Keep the complete latest report even if
  // the model selects only familiar early observations; do not invent a summary.
  if (latestQuote) {
    const previous=selected.findIndex(f=>f.subject===latest.subject&&f.question_id===latest.question_id);
    if(previous>=0)selected.splice(previous,1);
    selected.unshift({...latest,quote:latestQuote,certainty:'reported'});
  }
  const facts=selected.map(fact=>({...fact,
    interpretation:reportedInterpretation(fact.subject,[fact.quote],fact.certainty,2000)}));
  const patient_state=canonicalPatientState({summary:'원문 근거를 확인했어요.',facts,
    unknowns:payload.patient_state.unknowns,user_goal:contextGoal(context)},context);
  const internal=structuredClone(payload.relationship_memory);
  if (latestQuote?.length<=1000 && latest.question_id!=='name') {
    const entries=internal[latest.subject].filter(item=>!item.evidence.some(ref=>ref.subject===latest.subject&&ref.question_id===latest.question_id));
    internal[latest.subject]=[{evidence:[{...latest,quote:latestQuote}],certainty:'reported'},...entries].slice(0,2);
  }
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

export function knownSpeechIssues(guide,context) {
  const texts={script:[guide.script],doList:guide.doList,next:[guide.next||''],care:guide.care?.tips||[],
    avoid:guide.avoid.map(text=>text.split(/대신|대안[:：]?|보다는/u).slice(1).at(-1)||'')};
  const issues=Object.entries(texts).filter(([,items])=>items.some(text=>mindReading.test(text))).map(([field])=>({field,
    reason:'대상자의 마음이나 행동 원인을 아는 것처럼 말합니다.',
    repair:'마음을 설명하는 발화를 삭제하고 관찰한 행동만 되짚은 뒤 무엇이 걱정되는지 또는 어떤 도움이 필요한지 물으세요. “잘하고 싶어서 애쓰는구나”, “얼마나 노력하는지 알아”로 바꾸지 마세요.'}));
  if(guide.doList.some(text=>/안아|포옹|손을\s*잡|손잡/u.test(text)&&!/원하|괜찮|허락|동의|물어|묻|의사/u.test(text)))issues.push({field:'doList',
    reason:'상대가 신체 접촉을 원하는지 확인하지 않은 행동입니다.',
    repair:'먼저 “안아줘도 괜찮을까?”처럼 물어보고 상대가 원할 때만 접촉하세요. 원하지 않으면 말로 들어주는 대안을 제시하세요.'});
  for(const [field,items] of Object.entries(texts)) {
    if(items.some(text=>/쉬고 싶(?:구나|은 거구나|다는)/u.test(text)))issues.push({field,
      reason:'대화 거절만으로 쉬고 싶다는 마음을 대신 해석할 수 없습니다.',
      repair:'거절의 속마음을 해석하지 말고 “알겠어. 지금은 이야기하지 않을게”처럼 거절한 사실만 받아들이세요.'});
    if(items.some(text=>/어떤.{0,35}(?:걱정|힘든|힘들).{0,20}들어줄 수/u.test(text)))issues.push({field,
      reason:'상대의 이야기를 듣고 싶다는 뜻이 상대에게 들어 달라는 요청으로 뒤집혔습니다.',repair:'“어떤 점이 걱정되는지 말해줄 수 있어?” 또는 “어떤 점이 걱정되는지 듣고 싶어”처럼 청자와 화자를 구분하세요.'});
    if(items.some(text=>/(?:네|너의|당신의?) 곁에.{0,6}항상|항상.{0,6}(?:네|너의|당신의?) 곁에/u.test(text)))issues.push({field,
      reason:'이용자가 밝히지 않은 상시 지원을 약속합니다.',repair:'“항상”을 빼고 듣고 싶다는 마음이나 가능한 작은 도움을 제안하세요.'});
    if(items.some(text=>/네가 내 곁에.{0,20}알려/u.test(text)))issues.push({field,
      reason:'곁에 있어 주려는 발화의 주어와 지원 방향이 뒤집혔습니다.',repair:'이용자가 상대에게 곁에 있겠다는 뜻이라면 “내가 네 곁에 있을게”로 쓰세요.'});
    if(items.some(text=>/하루빨리.{0,12}괜찮아|빨리.{0,12}나아져/u.test(text)))issues.push({field,
      reason:'회복을 재촉하는 말을 권하고 있습니다.',repair:'회복 속도를 요구하지 말고 함께 하고 싶은 일을 상대가 편할 때 선택할 수 있게 제안하세요.'});
  }
  if(texts.avoid.some(text=>/[“"「][^”"」]{0,90}(?:물어보세요|확인하세요|말해보세요)[”"」]\s*라고/u.test(text)))issues.push({field:'avoid',
    reason:'사용자에게 주는 작성 지시를 대상자에게 말하라고 권합니다.',repair:'따옴표 안에 실제 대상자에게 건넬 질문을 쓰세요. 예: “지금 이야기해도 괜찮아?”'});
  for(const [field,items] of Object.entries(texts)) {
    if(items.some(text=>/(?:괜찮아지면|나아지면|회복하면).{0,35}(?:외식|밥|만나|맛있는|먹으|식사)/u.test(text)))issues.push({field,
      reason:'관계 활동을 회복한 뒤에만 가능한 일로 제안합니다.',repair:'“괜찮아지면”을 “원하면”이나 “편할 때”로 바꾸고 회복을 만남의 조건으로 삼지 마세요.'});
    if(items.some(text=>/언제든.{0,12}도와줄/u.test(text)))issues.push({field,
      reason:'이용자의 가능한 범위를 확인하지 않고 무제한 도움을 약속합니다.',repair:'“어떤 도움이 필요한지 듣고 싶어”처럼 마음을 전하고 할 수 있는 범위는 따로 정하세요.'});
  }
  if(guide.next&&/도와드릴 수 있/u.test(guide.next))issues.push({field:'next',
    reason:'안내자가 직접 도움을 수행하겠다는 약속이 섞였습니다.',repair:'대상자가 동의하면 이용자가 실제 할 수 있는 후속 행동으로 쓰세요. 앱이 대신 기관을 찾거나 예약하겠다고 약속하지 마세요.'});
  if(context){
    const ownReports=Object.entries(context.supporter?.fields||{}).filter(([key,field])=>key!=='moment'&&field.status==='answered').flatMap(([,field])=>sourceTexts(field)).join('\n');
    if(/혼자.{0,12}(?:감당해야|감당하[고는]|짊어|책임|부담감)/u.test(guide.care?.feel||'')&&!/혼자|홀로|저뿐|나뿐/u.test(ownReports))issues.push({field:'care',
      reason:'가족과 의견이 다르다는 답을 혼자 돌봄을 감당한다는 사실로 넓혔습니다.',repair:'혼자 책임진다는 설명을 제거하고 보고된 감정과 가족 간 의견 차이만 공감하세요. 자기 돌봄은 실제 도움이 된 대처와 지원 자원에 연결하세요.'});
    const sources=[...Object.values(context.patient?.fields||{}),...Object.values(context.supporter?.fields||{}),
      ...Object.values(context.user_goal||{})].filter(field=>field?.status==='answered').flatMap(sourceTexts).join('\n');
    const roleTexts={...texts,next:[guide.next||''],care:[guide.care?.feel||'',...(guide.care?.tips||[])]};
    for(const [field,items] of Object.entries(roleTexts)){
      const unsupported=items.flatMap(text=>[...text.matchAll(/(?:^|[^\p{L}])(형|누나|오빠|언니|남동생|여동생|엄마|아빠|딸|아들)(?=으로서|로서|인|가|는|의|이|께|에게|을|를|은|다|야|아|와|과|한테|[ .,!?]|$)/gu)])
        .map(match=>match[1]).filter(role=>!new RegExp('(?:^|[^\\p{L}])'+role+'(?=으로서|로서|인|가|는|의|이|께|에게|을|를|은|다|야|아|와|과|한테|[ .,!?]|$)','u').test(sources));
      if(unsupported.length)issues.push({field,reason:'원문에서 확인하지 않은 성별·서열 호칭입니다: '+[...new Set(unsupported)].join(', '),
        repair:'이름 또는 이용자님을 쓰고 형제자매라는 관계에서 성별이나 나이 순서를 추측하지 마세요.'});
    }
  }
  return issues;
}

export async function runRelationshipAgent(gateway,context,memory,name,operation) {
  memory=canonicalPatientState(memory,context);
  const data=agentContext(context);
  const speechAlias=name?.alias&&!['그분','상대방','대상자'].includes(name.alias)?name.alias:null;
  const stages=[], retrievalTrace=[];
  const generate=async (stage,prompt,payload,schema,tokens,validate)=>{
    const required=citedSources(payload);
    if(/^(?:card_care|support_review|speech_detail)/u.test(stage))required.push(...Object.keys(context.supporter?.fields||{}).map(question_id=>({subject:'supporter',question_id})));
    const retrieval=retrieveSources(context,{stage,required,
      query:[payload.analysis?.patient_summary,payload.analysis?.supporter_summary,
        payload.script,payload.guide?JSON.stringify(payload.guide):'',
        ...(payload.review?.issues||[]).map(issue=>typeof issue==='string'?issue:issue.reason+' '+issue.repair)].filter(Boolean).join(' ')});
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
  const reviewAnalysis=async stage=>{
    const claims=claimsOf(Object.fromEntries(['dynamics','strengths','boundaries'].map(key=>[key,analysis.relationship[key]])));
    const schema=structuredClone(analysisReviewSchema);schema.properties.audits=auditSchema(claims);schema.required.push('audits');
    return generate(stage,analysisReviewPrompt+AUDIT_INSTRUCTION,{answers:data,analysis,claims},schema,2400,value=>{
      validateSchema(value,schema);validateAudits(value.audits,claims,value.approved);
      return validateReview({approved:value.approved,issues:value.issues});
    });
  };
  let analysisRepairs=0;
  const repairAnalysis=async (review,late=false)=>{
    if (analysisRepairs>=1) invalid('agent_analysis_review_rejected');
    analysisRepairs++;
    const analysisIssues={approved:false,issues:review.issues.filter(issue=>issue.field==='relationship_analysis')};
    analysis=await generate(late?'analysis_repair_after_guide_review':'analysis_repair',
      analysisPrompt+'\n검토의 중대한 분석 오류를 바로잡고 원문 근거로 전체 분석을 다시 작성하세요.',
      {answers:data,draft:analysis,review:analysisIssues},analysisSchema,2400,v=>canonicalRelationship(v,context));
    const repairedReview=await reviewAnalysis(late?'analysis_review_after_guide_review_repair':'analysis_review_after_repair');
    if (!repairedReview.approved) invalid('agent_analysis_review_rejected');
  };
  const analysisReview=await reviewAnalysis('analysis_review');
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
  const validateDraft = (draft,{checkSpeech=true}={}) => {
    validateSchema(draft,guideSchema);
    if (draft.assessment.safety!==analysis.safety.urgent) invalid('agent_safety_mismatch');
    if (analysis.safety.urgent) {
      const actions=urgentGuideActions(name);
      if (['script','doList','avoid','next'].some(key=>JSON.stringify(draft.guide[key])!==JSON.stringify(actions[key]))||
        JSON.stringify(draft.guide.care.tips)!==JSON.stringify(actions.care.tips)) invalid('agent_urgent_action');
    } else {
      for(const key of ['script','next'])draft.guide[key]=draft.guide[key].replace(/[ \t]*\(줄바꿈\)[ \t]*/gu,'\n\n');
      // Recurrent live failure: converting a caregiver's hypothesis into a
      // confident explanation of the other person's mind in the spoken line.
      if(checkSpeech&&mindReading.test(draft.guide.script))invalid('agent_script_inference');
      if(checkSpeech&&!speechAlias&&/그분(?:이|은|의|에 대해)|대상자/u.test(draft.guide.script))invalid('agent_speech_address');
      const permissions=draft.guide.script.split(/(?<=[.!?。！？])\s+|\n+/u).filter(text=>
        /지금|잠깐|잠시/u.test(text)&&/이야기|대화/u.test(text)&&/괜찮|할 수|나눌 수|나누실 수|해도/u.test(text)&&!/어떤|무엇|무슨|전문가|상담|진료/u.test(text));
      if(checkSpeech&&permissions.length>1)invalid('agent_speech_repeat');
      if(checkSpeech){
        const issues=knownSpeechIssues(draft.guide,context).filter(issue=>issue.field==='script');
        if(issues.length)invalid('agent_speech_specific','거절된 발화: '+draft.guide.script+'\n'+issues.map(issue=>issue.reason+' '+issue.repair).join('\n'));
      }
    }
    const goal=context.user_goal?.desired_outcomes;
    const treatmentGoal=goal?.status==='answered'&&goal.selected?.some(option=>option.meta?.t==='goal_treat');
    // The initial script is provisional; the dedicated speech writer replaces it.
    // Enforce the requested goal on the final speech and every subsequent repair.
    if(checkSpeech&&treatmentGoal&&!analysis.safety.urgent&&!/상담|진료|전문가|의사|치료사/u.test(draft.guide.script))invalid('agent_goal_missing');
    return draft;
  };
  const reviewGuide=async (stage,draft,plan)=>{
    if(!analysis.safety.urgent){
      const speechClaims=Object.entries({
        script:draft.guide.script.split(/(?<=[.!?。！？])\s+|\n+/u),doList:draft.guide.doList,avoid:draft.guide.avoid,
        next:draft.guide.next.split(/\n+/u),care:[draft.guide.care.feel,...draft.guide.care.tips],
      }).flatMap(([field,texts])=>texts.filter(text=>text.trim()).map((text,index)=>({id:field+'.'+index,field,claim:text.trim(),certainty:'reported'})));
      const speechSchema=structuredClone(reviewSchema);speechSchema.properties.issues.items.properties.field.enum=['script','doList','avoid','next','care'];
      speechSchema.properties.audits=auditSchema(speechClaims);speechSchema.required.push('audits');
      const speech=await generate(stage.replace('guide_review','speech_review'),SPEECH_REVIEW,
        {answers:data,plan,script:draft.guide.script,guide:draft.guide,claims:speechClaims},speechSchema,4000,value=>{
          validateSchema(value,speechSchema);validateAudits(value.audits,speechClaims,value.approved);
          return validateReview({approved:value.approved,issues:value.issues});
        });
      const requiredFixes=knownSpeechIssues(draft.guide,context);
      if(requiredFixes.length)return {approved:false,issues:[...requiredFixes,...speech.issues.filter(issue=>!requiredFixes.some(fix=>fix.field===issue.field))].slice(0,3)};
      if(!speech.approved)return speech;
      const supportClaims=speechClaims.filter(claim=>['next','care'].includes(claim.field));
      const supportSchema=structuredClone(speechSchema);
      supportSchema.properties.issues.items.properties.field.enum=['next','care'];
      supportSchema.properties.audits=auditSchema(supportClaims);
      const support=await generate(stage.replace('guide_review','support_review'),SUPPORT_REVIEW,
        {answers:data,guide:{next:draft.guide.next,care:draft.guide.care},claims:supportClaims},supportSchema,2200,value=>{
          validateSchema(value,supportSchema);validateAudits(value.audits,supportClaims,value.approved);
          return validateReview({approved:value.approved,issues:value.issues});
        });
      if(!support.approved)return support;
    }
    const request=currentReviewRequest(false);
    return generate(stage,REVIEW,{answers:data,analysis,plan,guide:draft.guide,...request.metadata},request.schema,1400,value=>{
      validateSchema(value,request.schema);
      return validateReview(value);
    });
  };
  const composeGuide=async suffix=>{
    let plan=await generate('communication_plan'+suffix,PLAN,{answers:data,analysis},groundedEvidenceSchema(planSchema,context),1600,v=>validatePlan(v,context));
    const planReviewSchema=structuredClone(reviewSchema);
    planReviewSchema.properties.issues.items.properties.field.enum=Object.keys(planSchema.properties);
    for(let repair=0;repair<2;repair++){
      const review=await generate((repair?'plan_review_after_repair':'plan_review')+suffix,PLAN_REVIEW,
        {answers:data,analysis,plan},planReviewSchema,1800,value=>{
          validateSchema(value,planReviewSchema);
          if(value.approved!==(value.issues.length===0))invalid('agent_review');
          return value;
        });
      if(review.approved)break;
      if(repair===1)invalid('agent_plan_review_rejected');
      plan=await generate('communication_plan_repair'+suffix,PLAN+'\n검토한 오류를 원문으로 바로잡아 전략 전체를 다시 작성하세요.',
        {answers:data,analysis,draft:plan,review},groundedEvidenceSchema(planSchema,context),1600,v=>validatePlan(v,context));
    }
    const writerData={answers:data,analysis,plan};
    let draft=await generate('guide_write'+suffix,WRITE,writerData,currentGuideSchema(),3600,value=>validateDraft(value,{checkSpeech:false}));
    if(!analysis.safety.urgent)for(const [field,role] of Object.entries(CARD_ROLES)){
      const schema=object({[field]:guideSchema.properties.guide.properties[field]});
      const expanded=await generate('card_'+field+suffix,COMMON+'\n'+role,
        {...writerData,task:role,requirements:'각 항목 안에서도 구체적인 방법, 이유, 실제 말이나 대안을 나누어 작성하세요. 이미 알고 있는 사실과 앞으로의 제안을 구분하세요.'},schema,2800,value=>validateSchema(value,schema));
      draft=validateDraft({...draft,guide:{...draft.guide,...expanded}},{checkSpeech:false});
    }
    const qualityRequest=currentReviewRequest(true);
    const quality=await generate('guide_quality'+suffix,QUALITY,{...writerData,guide:draft.guide,...qualityRequest.metadata},
      qualityRequest.schema,1100,value=>validateSchema(value,qualityRequest.schema));
    if (quality.improvements.length) {
      const refinementSchema=currentGuideSchema();
      if (analysis.safety.urgent) refinementSchema.properties.guide.properties.top.enum=[draft.guide.top];
      draft=await generate('guide_refine'+suffix,WRITE+'\n품질 검토의 제안을 적용하되 사실·관계·목적·안전 판단은 원문을 유지하세요.',
        {...writerData,draft:draft.guide,quality},refinementSchema,3600,value=>{
          validateDraft(value,{checkSpeech:false});
          validateSchema(value.guide.top,refinementSchema.properties.guide.properties.top);
          return value;
        });
      const checkedQuality=await generate('guide_quality_check'+suffix,COMMON+
        '\n역할: 편집이 끝난 다섯 카드의 최종 사용 가능성 검토. 개인적인 문체 선호·문장 수·문단 수·분량은 검토 대상이 아닙니다. script가 실제 장면·이용자 목적을 잃었는지, 뜻이 통하지 않는 문장이 있는지, 행동에 실행할 방법이나 대안이 없는지, 사용자 부담·경계가 누락됐는지만 확인하세요. 문제가 없으면 improvements=[]입니다. 오류 수정은 근거를 유지하는 구체적인 최소 지시로 작성하세요. review_scope가 있으면 그 범위만 검토하세요.',
        {...writerData,guide:draft.guide,...qualityRequest.metadata},qualityRequest.schema,1100,
        value=>validateSchema(value,qualityRequest.schema));
      if (checkedQuality.improvements.length) invalid('agent_quality_review_rejected');
    }
    if(!analysis.safety.urgent){
      const parts={};
      for(const [part,role] of Object.entries(SPEECH_PARTS)){
        const fields=part==='opening'?['permission','observed_scene']:part==='listening'?['user_intent','open_question','wait_for_answer']:['small_invitation','help_choice','decline_choice'];
        const schema=object(Object.fromEntries(fields.map(field=>[field,string(600)])));
        parts[part]=await generate('speech_'+part+suffix,COMMON+'\n'+role+'\n발화문만 반환하세요. 다른 단계에서 말할 내용은 반복하지 마세요.',
          {...writerData,task:role,alias:speechAlias,fields,earlier_parts:parts},schema,1800,value=>validateSchema(value,schema));
      }
      const spoken=await generate('speech_write'+suffix,SPEAK,
        {parts,alias:speechAlias,voice:plan.voice,observations:plan.opening_evidence,user_goal:data.user_goal,
          speech_contract:{speaker:'supporter: 내가 듣고 도움을 제안하는 사람',listener:'patient: 자신의 이야기를 말하거나 제안을 거절할 수 있는 사람',
            include_treatment_offer:context.user_goal?.desired_outcomes?.selected?.some(option=>option.meta?.t==='goal_treat')===true,
            excluded_words:['항상','언제든','하루빨리'],
            required_action:'상대 이야기를 듣고 싶다면 듣고 싶어/말해줄 수 있어로 쓰세요. 들어줄 수 있어로 뒤집지 마세요.'},
          patient_choice:plan.patient_choice,answers:data},
        object({script:guideSchema.properties.guide.properties.script}),2400,value=>{
          validateSchema(value,object({script:guideSchema.properties.guide.properties.script}));
          const checked=validateDraft({...draft,guide:{...draft.guide,script:value.script}});
          return {script:checked.guide.script};
        });
      draft={...draft,guide:{...draft.guide,script:spoken.script}};
    }
    const review=await reviewGuide('guide_review'+suffix,draft,plan);
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
    const repairSchema=currentGuideSchema(),changedFields=new Set(review.issues.map(issue=>issue.field));
    if(!analysis.safety.urgent){
      let index=0;
      for(const field of changedFields){
        const schema=object({[field]:guideSchema.properties.guide.properties[field]});
        const issues=review.issues.filter(issue=>issue.field===field);
        const fixed=await generate('guide_repair'+suffix+(index++?'_'+field:''),
          COMMON+'\n'+(field==='script'?SPEAK:CARD_ROLES[field]||WRITE)+'\n지적된 카드 하나의 오류만 고칩니다. 다른 카드는 작성하지 마세요.',
          {answers:data,plan:writerData.plan,field,current:draft.guide[field],task:issues.map(issue=>issue.repair).join('\n'),issues},
          schema,2800,value=>validateSchema(value,schema));
        draft={...draft,guide:{...draft.guide,...fixed}};
      }
      validateDraft(draft);
      review=await reviewGuide('guide_review_after_repair'+suffix,draft,writerData.plan);
      continue;
    }
    for(const [field,schema] of Object.entries(repairSchema.properties.guide.properties)){
      if(!changedFields.has(field))schema.enum=[draft.guide[field]];
    }
    draft=await generate('guide_repair'+suffix,WRITE+'\n검토에서 지적한 필드만 바로잡고 전체 JSON을 다시 작성하세요. 이미 검증한 다른 필드는 스키마 enum 그대로 보존하세요.',
      {...writerData,draft:draft.guide,review,
        task:'새 답안을 쓰는 작업이 아니라 아래 오류를 고치는 작업입니다. 각 repair 지시를 해당 필드에 그대로 적용하세요. 회복을 조건으로 한 제안과 재촉은 의도와 달라도 삭제해야 합니다. 수정 대상 이외의 카드는 보존하세요.',
        required_edits:review.issues.map(issue=>({field:issue.field,problem:issue.reason,change:issue.repair})),
        edited_fields:[...changedFields]},repairSchema,4200,value=>{validateDraft(value);return validateSchema(value,repairSchema);});
    review=await reviewGuide('guide_review_after_repair'+suffix,draft,writerData.plan);
  }
  let conversationDetail;
  if(!analysis.safety.urgent){
    const section=object({excerpt:string(8000),why:string(1000),evidence:array(evidence,3,1)});
    const schema=object(Object.fromEntries(Object.keys(SPEECH_PARTS).map(key=>[key,section])));
    let detailReview;
    for(let repair=0;repair<2;repair++){
      conversationDetail=await generate('speech_detail'+(repair?'_repair':''),DETAIL,
        {answers:data,script:draft.guide.script,plan:writerData.plan,...(detailReview?{previous:conversationDetail,review:detailReview}:{})},schema,3200,value=>{
          validateSchema(value,schema);
          const normalize=text=>text.replace(/\s+/gu,'');
          if(normalize(Object.values(value).map(item=>item.excerpt).join(''))!==normalize(draft.guide.script))invalid('agent_detail_excerpt','세 excerpt를 순서대로 합치면 최종 script와 같아야 합니다. 생략·중복·문구 변경을 하지 마세요.');
          for(const item of Object.values(value)){
            item.evidence.forEach(ref=>validateEvidence(ref,context));
            validateReportedLabels(item.why,item.evidence.map(ref=>ref.quote));
          }
          return value;
        });
      const claims=Object.entries(conversationDetail).map(([id,item])=>({id,claim:item.why,certainty:'reported',evidence:item.evidence}));
      const schemaReview=object({approved:{type:'boolean'},issues:array(string(800),4),audits:auditSchema(claims)});
      detailReview=await generate('speech_detail_review'+(repair?'_after_repair':''),COMMON+AUDIT_INSTRUCTION+
        '\n이제 최종 발화의 단계별 설명을 검토하세요. why에 들어 있는 개인화 사실은 인용이 전부 뒷받침해야 합니다. 일반적인 제안의 목적은 사실 추가가 아니지만 효과·진단·속마음을 단정하면 거절하세요. 이미 검토한 script를 바꾸지 마세요. 전체 발화와 단계 설명이 모순되는지도 확인하세요.',
        {answers:data,script:draft.guide.script,detail:conversationDetail,claims},schemaReview,2200,value=>{
          validateSchema(value,schemaReview);validateAudits(value.audits,claims,value.approved);
          if(value.approved!==(value.issues.length===0))invalid('agent_review');return value;
        });
      if(detailReview.approved)break;
      if(repair===1)invalid('agent_detail_review_rejected');
    }
  }
  return {payload:{...draft,patient_state:memory,name_index:name},relationship_analysis:analysis,
    ...(conversationDetail?{conversation_detail:conversationDetail}:{}),
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
    const field=sourceField(scoped,{subject:variant.properties.subject.const,question_id:variant.properties.question_id.const});
    const complete=sourceTexts(field).filter(text=>text.length<=10000);
    if(complete.length)variant.properties.quote={type:'string',enum:complete,maxLength:10000};
  }
  const variants=state.properties.facts.items.anyOf;
  if(variants){
    const substantive=variants.filter(v=>!['name','rel','contact'].includes(v.properties.question_id.const));
    if(substantive.length)state.properties.facts.items.anyOf=substantive;
    state.properties.facts.items.anyOf.sort((a,b)=>Number(b.properties.question_id.const===context.latest_answer?.question_id)-Number(a.properties.question_id.const===context.latest_answer?.question_id));
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

export function relationshipQuestionRequest(context) {
  const data=agentContext(context);
  // Keep the final ordinary question: its response gives us a turn to decide
  // on clarifications after any previous automatic skips.
  const sources=['patient','supporter'].flatMap(subject=>Object.values(context[subject]?.fields||{}).filter(f=>f.status==='answered').flatMap(sourceTexts));
  const candidates=(context.question_candidates||[]).slice(0,-1).filter(q=>hasQuestionSpecificAnswer(q.id,sources));
  const retrieval=retrieveSources(context,{stage:'question_plan',query:candidates.map(q=>q.question).join(' ')});
  const scoped=retrievedContext(context,retrieval);
  const base=modelResponseFormat({...scoped,question_candidates:candidates},false).json_schema.schema.properties.question_plan;
  const variants=(base.properties.skip.items.anyOf||[]).filter(v=>v.properties.reason.const==='already_covered');
  // A goal is not evidence that the patient has the same wish or has consented.
  for (const variant of variants) variant.properties.evidence.items.anyOf=variant.properties.evidence.items.anyOf.filter(ref=>
    ref.properties.subject.const===candidates.find(q=>variant.properties.question_id.enum.includes(q.id))?.subject);
  const valid=variants.filter(v=>v.properties.evidence.items.anyOf.length);
  const ids=(context.clarification_candidates||[]).map(q=>q.id);
  const schema=object({skip:array(valid.length?{anyOf:valid}:object({}),valid.length?3:0),
    clarify:array({type:'string',enum:ids.length?ids:['none']},ids.length?1:0),
    safety:relationshipDraftSchema.properties.safety});
  return {retrieval,schema:groundedEvidenceSchema(schema,scoped),data:{...data,retrieval,question_candidates:candidates,clarification_candidates:context.clarification_candidates||[]},
    prompt:COMMON+`\n역할: 질문 중복과 중요한 정보 공백을 확인하는 진행자.
safety.urgent는 현재 즉각적인 자해·타해·신체 위험이 명시적으로 보고된 경우에만 true입니다. 완전한 원문 문장 evidence를 선택하고 부정·과거·인용·화자를 대조하세요. 위험 단어의 존재만으로 판단하지 마세요. true이면 skip과 clarify는 빈 배열로 두세요. 서버가 질문을 중단하고 별도 관계 분석·안전 검토로 전달합니다.
skip은 앞으로 물을 question_candidates 중 이미 원문에서 충분히 답한 질문만 선택합니다. 이유는 already_covered뿐이며 같은 사람의 정확한 원문 인용과 어떤 질문에 답한 것인지 설명해야 합니다. 단어가 비슷하다는 이유로 생략하지 마세요. 모름·거절·건너뜀을 답변 완료로 만들지 마세요. 후보에 없는 질문은 생략할 수 없습니다.
clarify는 clarification_candidates에서 꼭 필요한 질문 하나의 id만 고르거나 빈 배열입니다. 대상자가 직접 원한 도움, 이전 말에 대한 실제 반응, 이용자의 부담·도울 수 있는 범위가 최종 말과 행동을 바꾸는데 아직 확인되지 않았거나 모순될 때만 선택하세요. 이미 답한 내용이나 모른다고 한 내용, 거절·건너뛴 질문을 다른 표현으로 다시 묻지 마세요. 원문에 답이 있으면 다시 확인하지 않습니다. 원문에 현재 즉각적인 신체 위험이 보고됐다면 추가 질문을 선택하지 말고 최종 안전 안내로 진행하세요. 후보당 한 번만 묻고 추가 질문은 최대 세 개입니다. 새 질문 문장을 생성하지 마세요.`};
}

export function validateRelationshipQuestions(value,context,request) {
  validateSchema(value,request.schema);
  assertRetrievedEvidence(value,request.retrieval);
  const plan=validateQuestionPlan({skip:value.skip},context);
  plan.skip=plan.skip.filter(item=>hasQuestionSpecificAnswer(item.question_id,item.evidence.map(ref=>ref.quote)));
  validateSafetyEvidence(value.safety,context);
  if(value.safety.urgent&&(value.skip.length||value.clarify.length))invalid('agent_urgent_questions');
  return {question_plan:plan,clarification:value.clarify[0]||null,finish_early:value.safety.urgent,safety_signal:value.safety};
}

export function safetyReviewRequest(request,decision) {
  return {data:{...request.data,proposed_safety:decision.safety_signal},schema:object({
    basis:{type:'string',enum:['current_physical_danger','distress_without_immediate_danger','negated','past_only','unclear']},
    reason:string(600),
  }),prompt:COMMON+`\n역할: 질문 진행자가 제안한 현재 위험을 독립적으로 확인하는 안전 검토자. 이 판단은 평소 질문을 중단시킬 수 있으므로 명시된 원문 사건만 대조하세요.
current_physical_danger는 지금 자신이나 다른 사람을 해치겠다는 구체적인 말·행동, 진행 중 폭력·신체적 응급상황이 직접 보고된 경우입니다. 단순한 걱정·불안·불면·계획 변경·반복 확인·무력감·가족 갈등은 distress_without_immediate_danger입니다. “다 망한 것 같아”만으로 현재 자해 위험을 확정하지 마세요.
부정한 위험은 negated, 과거만 언급한 것은 past_only, 지금 위험이 명시되지 않아 판정할 수 없으면 unclear입니다. 위험 단어가 있다는 이유나 도움을 권하는 것이 좋겠다는 이유로 현재 위험으로 판정하지 마세요.
proposed_safety.evidence의 전체 원문 답변에서 시점·부정·누구의 말인지 확인하고 basis와 구체적인 reason만 반환하세요.`};
}

// These stock questions request a new perspective, priority, or an invitation
// to add information. Broad symptom descriptions repeatedly fooled the local
// planner AND its reviewer. Require an explicit source cue before either may
// skip them; this is conservative eligibility, not a replacement for review.
export function hasQuestionSpecificAnswer(id,sources) {
  if(id==='extra')return false;
  if(id==='concern')return sources.some(text=>/(?:가장|제일|특히).{0,100}(?:걱정|마음에 걸)|(?:걱정|마음에 걸).{0,100}(?:가장|제일|특히)/u.test(text));
  if(['others_why','others_help'].includes(id))return sources.some(text=>/(?:남편|아내|친구|동료|선생님|담임|어머니|아버지|엄마|아빠|부모|형|누나|언니|동생|할머니|할아버지|가족|주변 사람|의사|상담사)(?:은|는|이|가|께서).{0,140}(?:말|이야기|생각|권|하자|보자|추천|조언|[“「])/u.test(text));
  return true;
}

export function questionReviewRequest(decision,request) {
  const claims=decision.question_plan.skip.map(item=>({id:'skip.'+item.question_id,certainty:'reported',
    claim:'이 질문 전체에 이미 답했음: '+request.data.question_candidates.find(q=>q.id===item.question_id)?.question,
    evidence:item.evidence,proposal:item.explanation}));
  if(decision.clarification)claims.push({id:'clarify.'+decision.clarification,certainty:'reported',
    claim:'아직 답하지 않았고 추가 확인이 필요함: '+request.data.clarification_candidates.find(q=>q.id===decision.clarification)?.question,evidence:[]});
  return {claims,schema:object({audits:auditSchema(claims)}),data:{...request.data,claims},
    prompt:COMMON+`\n역할: 다른 요청이 제안한 질문 생략·추가 확인만 독립적으로 심사하는 진행 검토자.
skip 주장은 인용이 그 질문 전체에 이미 직접 답한 경우에만 supported입니다. 단어가 비슷하거나 관련된 행동을 설명한 것만으로는 unsupported입니다.
행동·기분 묘사는 생활 배경·가치관의 답이 아닙니다. 걱정되는 모습을 나열한 것만으로 가장 걱정되는 우선순위를 답한 것이 아닙니다. 스트레스를 추측한 것만으로 최근 일어난 사건 전체에 답한 것이 아닙니다. 추가로 걱정되는 부분을 초대하는 질문은 이전 관찰을 말한 것만으로 생략하지 마세요.
clarify 주장은 원문에 없고 최종 말·행동을 바꿀 중요한 정보일 때 supported입니다. 이미 답했거나 모른다·거절했다고 했다면 unsupported입니다. 사용자가 바라는 도움과 대상자가 직접 원한다고 전해진 도움은 다릅니다.
claims의 id를 audits에 한 번씩 모두 판정하고 구체적인 reason을 적으세요. 불확실하면 plausible입니다. unsupported나 plausible인 생략은 서버가 취소하여 원래 질문을 묻고, 불필요한 추가 확인은 취소합니다. 질문을 새로 만들지 마세요.`};
}

export function applyQuestionReview(value,decision,request) {
  validateSchema(value,request.schema);validateAudits(value.audits,request.claims,false);
  const accepted=new Set(value.audits.filter(a=>a.verdict==='supported').map(a=>a.id));
  return {...decision,question_plan:{skip:decision.question_plan.skip.filter(item=>accepted.has('skip.'+item.question_id))},
    clarification:accepted.has('clarify.'+decision.clarification)?decision.clarification:null};
}
