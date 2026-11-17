import {HttpError} from './errors.js';
import {validateSchema} from './relationship-agent.js';

const sourceKeys=['source_question_id','source_revision','component','quote','quote_start','quote_end'];
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const bindingKey=value=>JSON.stringify(sourceKeys.map(key=>value[key]));
const fail=()=>{const error=new HttpError(502,'MODEL_INVALID_RESPONSE','답변에 맞춘 질문의 근거를 확인하지 못했어요.');error.modelReason='agent_personalization_source';throw error;};

// Candidates are exact slices, never summaries. Full short sources and sentence
// spans retain the complete input alongside them; long sentences use bounded
// adjacent slices so no source text is silently dropped from the candidate set.
export function personalizationSourceSpans(sources) {
  const result=[],seen=new Set(),segmenter=new Intl.Segmenter('ko',{granularity:'sentence'});
  for(const source of sources) {
    if(!source||!['patient','supporter'].includes(source.subject)||typeof source.source_question_id!=='string'||
      !Number.isSafeInteger(source.source_revision)||source.source_revision<1||!['rawText','custom'].includes(source.component)||
      typeof source.text!=='string'||!source.text.trim())fail();
    const points=Array.from(source.text);
    const add=(start,end)=>{
      while(start<end&&/\s/u.test(points[start]))start++;
      while(end>start&&/\s/u.test(points[end-1]))end--;
      if(start===end||end-start>160)return;
      const binding={source_question_id:source.source_question_id,source_revision:source.source_revision,component:source.component,
        quote:points.slice(start,end).join(''),quote_start:start,quote_end:end};
      const key=bindingKey(binding);if(seen.has(key))return;seen.add(key);
      result.push({id:'ps'+result.length,binding});
    };
    if(points.length<=160)add(0,points.length);
    for(const sentence of segmenter.segment(source.text)) {
      const start=Array.from(source.text.slice(0,sentence.index)).length,end=start+Array.from(sentence.segment).length;
      for(let offset=start;offset<end;offset+=160)add(offset,Math.min(end,offset+160));
      // A leading emoji/space is not part of the following spoken sentence.
      const leading=sentence.segment.match(/^[\s\p{S}]+/u)?.[0]||'';
      if(leading)add(start+Array.from(leading).length,end);
    }
  }
  return result;
}

// Compose outside the existing skip/evidence codec. Only the provider wire
// representation changes; the existing app validates the restored decision.
export function personalizationSourceTransport(stage,originalSchema,payload,base=null) {
  if(!/^(?:question_plan|turn_draft(?:_block_questions)?)(?:_after_review)?$/u.test(stage))return base;
  const schema=structuredClone(base?.schema||originalSchema),path=schema.properties?.personalization?['personalization']:
    schema.properties?.questions?.properties?.personalization?['questions','personalization']:null;
  if(!path)return base;
  const parent=path.length===1?schema:schema.properties.questions,node=parent.properties.personalization;
  if(node.type==='null')return base;
  const input=payload.question_input||payload,sources=input.personalization_sources;
  if(!Array.isArray(sources))fail();
  const spans=personalizationSourceSpans(sources),byId=new Map(spans.map(row=>[row.id,row.binding]));
  if(!spans.length||!Array.isArray(node.anyOf))fail();
  const ids=new Map(spans.map(row=>[bindingKey(row.binding),row.id]));
  parent.properties.personalization={anyOf:node.anyOf.map(branch=>{
    if(branch.type==='null')return branch;
    if(branch.type!=='object'||branch.additionalProperties!==false||Object.keys(branch).some(key=>!['type','properties','required','additionalProperties','description'].includes(key))||
      !sourceKeys.every(key=>branch.properties?.[key]&&branch.required?.includes(key)))fail();
    const sourceSchema=object(Object.fromEntries(sourceKeys.map(key=>[key,branch.properties[key]])));
    const allowed=spans.filter(row=>{try{validateSchema(row.binding,sourceSchema,'output',true);return true;}catch{return false;}}).map(row=>row.id);
    if(!allowed.length)fail();
    const remaining=Object.fromEntries(Object.entries(branch.properties).filter(([key])=>!sourceKeys.includes(key)));
    return object({...remaining,source_ref:{type:'string',enum:allowed}});
  })};
  const at=value=>path.length===1?value:value.questions;
  const transform=(value,decode)=>{
    validateSchema(value,decode?schema:originalSchema,'output',true);
    let result=decode?structuredClone(value):base?base.encode(value):structuredClone(value);
    const parent=at(result),decision=parent.personalization;
    if(decision!==null) {
      if(decode){
        const binding=byId.get(decision.source_ref);if(!binding)fail();
        const {source_ref,...rest}=decision;parent.personalization={...rest,...structuredClone(binding)};
      } else {
        const id=ids.get(bindingKey(decision));if(id===undefined)fail();
        parent.personalization={...Object.fromEntries(Object.entries(decision).filter(([key])=>!sourceKeys.includes(key))),source_ref:id};
      }
    }
    if(decode&&base)result=base.decode(result);
    validateSchema(result,decode?originalSchema:schema,'output',true);return result;
  };
  return {schema:structuredClone(schema),table:{...(base?.table||{sources:[],locations:[]}),personalization_sources:structuredClone(spans)},
    instruction:(base?.instruction||'')+'\n맞춤 질문의 실제 출력 형식: personalization의 source_ref에는 evidence_sources.personalization_sources에서 선택한 정확한 인용 구절의 ID 하나만 넣으세요. source_question_id/source_revision/component/quote/quote_start/quote_end를 직접 생성하지 마세요. 서버가 선택된 ID의 원문과 Unicode 위치를 그대로 복원하고 기존 근거 검증을 수행합니다. 전체 data 원문으로 적절한 질문과 이유를 판단하며, 인용 후보 자체는 답변·사실·질문의 자동 승인이 아닙니다. 적절한 근거가 없으면 personalization=null입니다.',
    encode:value=>transform(value,false),decode:value=>transform(value,true)};
}
