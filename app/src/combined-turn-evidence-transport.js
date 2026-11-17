import {HttpError} from './errors.js';
import {validateSchema} from './relationship-agent.js';

const fields=['subject','question_id','quote'];
const keywords=new Set(['type','properties','required','additionalProperties','items','anyOf','enum','const',
  'maxItems','minItems','minLength','maxLength','minimum','maximum','description']);
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const referenceKey=ref=>JSON.stringify(fields.map(key=>ref[key]));
const unchanged=schema=>({schema,changed:false,convert:value=>value});
const unsupported=()=>{throw new TypeError('Unsupported combined-turn evidence schema');};
const known=node=>record(node)&&Object.keys(node).every(key=>keywords.has(key))&&
  (!node.properties||record(node.properties)&&Object.values(node.properties).every(known))&&
  (!node.items||known(node.items))&&(!node.anyOf||Array.isArray(node.anyOf)&&node.anyOf.length>0&&node.anyOf.every(known));
const instruction='\n결합 턴의 근거 출력 형식: evidence_sources.locations에 있는 위치만 참조 ID로 반환하세요. kind=fact인 state.patient_state.facts 항목은 subject·question_id·quote 세 필드 대신 s에 해당 위치의 허용 ID를 넣고 certainty와 그 밖의 모델 판단 필드는 그대로 직접 선택하세요. kind=evidence인 관계 기억과 questions.skip의 evidence 항목은 허용 ID 문자열입니다. evidence_sources.sources는 ID와 정확한 원문 객체 대응표이며 같은 객체는 같은 ID입니다. 각 스키마 위치와 anyOf 분기의 허용 목록은 별개이므로 합치지 마세요. ID·원문·주체를 만들거나 바꾸지 마세요. clarify의 원문·위치·축, safety 및 다른 필드는 원래 형식을 지키세요. 전체 원문과 문맥으로 근거를 선택하며 서버는 손실 없이 복원한 뒤 원래 스키마·의미 검증과 독립 검토를 모두 수행합니다.';

// The existing combined validator may merge two validated reports and one
// hypothesis into two findings. This is a parsing allowance only: its original
// source validation, narrow normalization and independent review still decide.
export function combinedTurnStreamSchema(schema) {
  const result=structuredClone(schema);
  for(const subject of ['patient','supporter']) {
    const group=result.properties?.state?.properties?.relationship_memory?.properties?.[subject];
    if(group?.maxItems===2)group.maxItems=3;
  }
  return result;
}

function invalid() {
  const error=new HttpError(502,'MODEL_INVALID_RESPONSE','답변의 근거를 다시 확인하고 있어요.');
  error.modelReason='agent_schema';throw error;
}

// Only the three explicitly selected source paths change representation.
// Construction is transactional; a fallback cannot consume or reassign IDs.
export function combinedTurnEvidenceTransport(stage,originalSchema,registry=new Map()) {
  if(!/^turn_draft(?:_after_review)?$/u.test(stage))return null;
  if(!originalSchema?.properties?.state?.properties?.patient_state||
    !originalSchema.properties.state.properties.relationship_memory)return null;
  return turnEvidenceTransport(originalSchema,registry,false);
}

// Routing-only turns retain every allowed question source and the unchanged
// clarification/safety contracts. This codec never supplies a state or a verdict.
export function questionTurnEvidenceTransport(stage,originalSchema,registry=new Map(),{evidenceIds=true}={}) {
  if(stage!=='question_plan'||!originalSchema?.properties?.skip||
    !originalSchema.properties.clarify||!originalSchema.properties.safety)return null;
  if(!known(originalSchema)||!(registry instanceof Map)||originalSchema.type!=='object'||
    Object.keys(originalSchema).some(key=>!['type','properties','required','additionalProperties','description'].includes(key)))return null;
  try {
    // Source allocation remains transactional if fixed-slot admission fails.
    const assigned=new Map(registry);
    const citations=evidenceIds?turnEvidenceTransport(originalSchema,assigned,true):null;
    const logical=structuredClone(originalSchema),base=structuredClone(citations?.schema||logical);
    const slots=questionSlots(base);
    const schema={...base,properties:{...base.properties,skip:slots.schema}};
    const table=citations?structuredClone(citations.table):{sources:[],locations:[]};
    table.locations=table.locations.flatMap(location=>slots.paths.filter(([before])=>
      location.schema_path.startsWith(before+'.')).map(([before,after])=>({...location,
        schema_path:after+location.schema_path.slice(before.length)})));
    const transform=(value,decode)=>{
      validateSchema(value,decode?schema:logical,'output',true);
      if(decode){
        const restored={...value,skip:slots.ids.flatMap(question_id=>value.skip[question_id]===null?[]:
          [{question_id,...value.skip[question_id]}])};
        const result=citations?citations.decode(restored):restored;
        validateSchema(result,logical,'output',true);return structuredClone(result);
      }
      // Never silently collapse duplicate logical decisions into one property.
      if(new Set(value.skip.map(item=>item.question_id)).size!==value.skip.length)invalid();
      const encoded=citations?citations.encode(value):structuredClone(value);
      const selected=new Map(encoded.skip.map(({question_id,...decision})=>[question_id,decision]));
      const result={...encoded,skip:Object.fromEntries(slots.ids.map(id=>[id,selected.get(id)??null]))};
      validateSchema(result,schema,'output',true);return result;
    };
    for(const [key,id]of assigned)registry.set(key,id);
    return {schema:structuredClone(schema),table,
      instruction:(citations?.instruction||'')+'\n질문 진행의 실제 출력 형식: skip은 배열 대신 문항 ID별 고정 객체입니다. output_schema의 모든 문항 키를 정확히 한 번씩 반환하세요. 각 키는 data.question_candidates에서 같은 ID가 묻는 질문에만 대응합니다. 그 문항을 생략하지 않으면 null, 생략하면 허용된 reason·evidence·explanation 객체를 반환하세요. 객체 안에 question_id를 다시 쓰거나 다른 문항의 설명을 넣지 마세요. 생략할 문항이 없거나 safety.urgent=true이면 skip=[]가 아니라 모든 문항 값을 null로 두세요. 후보가 없으면 skip={}입니다. null은 미응답을 사실로 채우거나 영구적으로 질문을 유지하라는 뜻이 아닙니다. 매번 현재 원문으로 각 문항의 필요성을 다시 판단하며 문맥에 따른 생략은 유지합니다. 스키마가 허용하는 문항·이유별 근거 범위를 합치지 마세요. 서버는 선택된 문항만 원래 skip 배열로 복원하고 기존 근거·의미 검증을 적용합니다.',
      encode:value=>transform(value,false),decode:value=>transform(value,true)};
  }catch(error){if(error instanceof TypeError)return null;throw error;}
}

// A generated array can repeat an ID even with uniqueItems: explanations may
// differ. Closed required slots make identity unique in the grammar itself.
function questionSlots(schema) {
  const skip=schema.properties.skip;
  if(skip.type!=='array'||!Number.isInteger(skip.maxItems)||skip.maxItems<0||skip.maxItems>8||
    (skip.minItems??0)!==0||Object.keys(skip).some(key=>!['type','items','minItems','maxItems','description'].includes(key)))unsupported();
  const branches=skip.maxItems===0?[]:skip.items?.anyOf;
  if(!Array.isArray(branches)||skip.maxItems>0&&!branches.length||
    skip.maxItems>0&&Object.keys(skip.items).some(key=>!['anyOf','description'].includes(key)))unsupported();
  const byId=new Map(),paths=[];
  for(const [index,branch]of branches.entries()) {
    const keys=['question_id','reason','evidence','explanation'],idSchema=branch.properties?.question_id;
    if(branch.type!=='object'||branch.additionalProperties!==false||
      Object.keys(branch).some(key=>!['type','properties','required','additionalProperties','description'].includes(key))||
      Object.keys(branch.properties||{}).length!==keys.length||!keys.every(key=>Object.hasOwn(branch.properties,key))||
      !Array.isArray(branch.required)||branch.required.length!==keys.length||new Set(branch.required).size!==keys.length||!keys.every(key=>branch.required.includes(key))||
      idSchema.type!=='string'||Object.keys(idSchema).some(key=>!['type','enum','description'].includes(key))||
      !Array.isArray(idSchema.enum)||!idSchema.enum.length||new Set(idSchema.enum).size!==idSchema.enum.length)unsupported();
    for(const id of idSchema.enum){
      if(typeof id!=='string'||!/^[A-Za-z_][A-Za-z_0-9]{0,79}$/u.test(id)||['__proto__','constructor','prototype'].includes(id))unsupported();
      if(!byId.has(id))byId.set(id,[]);
      const variants=byId.get(id),slotIndex=variants.length+1;
      variants.push({...structuredClone(branch),properties:Object.fromEntries(Object.entries(branch.properties).filter(([key])=>key!=='question_id')),
        required:branch.required.filter(key=>key!=='question_id')});
      paths.push([`output_schema.properties.skip.items.anyOf[${index}]`,`output_schema.properties.skip.properties.${id}.anyOf[${slotIndex}]`]);
    }
  }
  // More slots would permit more selected decisions than the original array.
  if(byId.size>skip.maxItems)unsupported();
  const ids=[...byId.keys()];
  return {ids,paths,schema:{type:'object',properties:Object.fromEntries([...byId].map(([id,variants])=>
    [id,{anyOf:[{type:'null'},...variants]}])),required:ids,additionalProperties:false}};
}

function turnEvidenceTransport(originalSchema,registry,questionOnly) {
  if(!known(originalSchema)||originalSchema.type!=='object')return null;
  try {
    if(!(registry instanceof Map))unsupported();
    const assigned=new Map(registry),used=new Set(),sources=new Map(),locations=[];
    for(const [key,id]of assigned) {
      let parts;try{parts=JSON.parse(key);}catch{unsupported();}
      if(!Array.isArray(parts)||parts.length!==3||!parts.every(part=>typeof part==='string')||
        typeof id!=='string'||!/^e[0-9a-z]+$/u.test(id)||used.has(id))unsupported();
      used.add(id);
    }
    const sourceId=ref=>{
      const key=referenceKey(ref);let id=assigned.get(key);
      if(id===undefined){let next=assigned.size;do{id='e'+(next++).toString(36);}while(used.has(id));assigned.set(key,id);used.add(id);}
      sources.set(id,Object.fromEntries(fields.map(key=>[key,ref[key]])));return id;
    };
    const compile=(node,path,dataPath)=>{
      if(node.anyOf) {
        // Sibling constraints could couple branches. Keep their original form.
        if(Object.keys(node).some(key=>!['anyOf','description'].includes(key)))unsupported();
        const branches=node.anyOf.map((branch,index)=>compile(branch,`${path}.anyOf[${index}]`,dataPath));
        if(!branches.some(branch=>branch.changed))return unchanged(node);
        return {schema:{...node,anyOf:branches.map(branch=>branch.schema)},changed:true,convert(value,decode){
          const matches=[];
          for(const [index,branch]of branches.entries()){
            try{validateSchema(value,decode?branch.schema:node.anyOf[index],'output',true);}
            catch(error){if(error instanceof HttpError&&error.code==='MODEL_INVALID_RESPONSE')continue;throw error;}
            matches.push(branch.convert(value,decode));
          }
          if(!matches.length||matches.some(match=>JSON.stringify(match)!==JSON.stringify(matches[0])))invalid();
          return matches[0];
        }};
      }
      const fact=!questionOnly&&dataPath==='state.patient_state.facts.*';
      const evidence=questionOnly?dataPath==='skip.*.evidence.*':
        /^state\.relationship_memory\.(?:patient|supporter|relationship)\.\*\.evidence\.\*$|^questions\.skip\.\*\.evidence\.\*$/u.test(dataPath);
      if(fact||evidence) {
        if(node.type!=='object'||!record(node.properties)||node.additionalProperties!==false||!Array.isArray(node.required))unsupported();
        // Empty source pools use the original empty/unbounded object contract.
        if(!fields.every(key=>Object.hasOwn(node.properties,key))) {
          if(Object.keys(node.properties).length===0)return unchanged(node);
          unsupported();
        }
        if(fields.some(key=>!node.required.includes(key)||node.properties[key].type!=='string')||
          (evidence&&(Object.keys(node.properties).length!==3||node.required.length!==3))||
          (fact&&(!node.properties.certainty||!node.required.includes('certainty')||Object.hasOwn(node.properties,'s'))))unsupported();
        if(Object.hasOwn(node,'const')||fact&&Object.hasOwn(node,'enum'))unsupported();
        const referenceSchema={type:'object',properties:Object.fromEntries(fields.map(key=>[key,node.properties[key]])),required:fields,additionalProperties:false};
        let pool=node.enum;
        if(pool===undefined) {
          const props=node.properties;
          if(typeof props.subject.const!=='string'||typeof props.question_id.const!=='string'||!Array.isArray(props.quote.enum))return unchanged(node);
          pool=props.quote.enum.map(quote=>({subject:props.subject.const,question_id:props.question_id.const,quote}));
        }
        if(!Array.isArray(pool)||!pool.length)unsupported();
        const refs=new Map(),ids=new Map();
        for(const ref of pool){
          if(!record(ref)||Object.keys(ref).length!==3||!fields.every(key=>typeof ref[key]==='string'))unsupported();
          try{validateSchema(ref,evidence?node:referenceSchema,'output',true);}catch{unsupported();}
          const id=sourceId(ref);refs.set(id,structuredClone(sources.get(id)));ids.set(referenceKey(ref),id);
        }
        const idSchema={type:'string',enum:[...refs.keys()]};
        const schema=fact?{...node,properties:{s:idSchema,...Object.fromEntries(Object.entries(node.properties).filter(([key])=>!fields.includes(key)))},
          required:['s',...node.required.filter(key=>!fields.includes(key))]}:idSchema;
        locations.push({schema_path:path,kind:fact?'fact':'evidence',...(fact?{source_key:'s'}:{}),allowed_source_ids:[...refs.keys()]});
        return {schema,changed:true,convert(value,decode){
          if(decode) {
            const ref=refs.get(fact?value.s:value);if(!ref)invalid();
            return fact?{...structuredClone(ref),...Object.fromEntries(Object.entries(value).filter(([key])=>key!=='s'))}:structuredClone(ref);
          }
          const id=ids.get(referenceKey(value));if(id===undefined)invalid();
          return fact?{s:id,...Object.fromEntries(Object.entries(value).filter(([key])=>!fields.includes(key)))}:id;
        }};
      }
      if(node.properties) {
        const children=Object.fromEntries(Object.entries(node.properties).map(([key,child])=>[key,compile(child,`${path}.properties.${key}`,dataPath?`${dataPath}.${key}`:key)]));
        if(!Object.values(children).some(child=>child.changed))return unchanged(node);
        if(Object.hasOwn(node,'enum')||Object.hasOwn(node,'const'))unsupported();
        return {schema:{...node,properties:Object.fromEntries(Object.entries(children).map(([key,child])=>[key,child.schema]))},changed:true,
          convert:(value,decode)=>Object.fromEntries(Object.entries(value).map(([key,item])=>[key,children[key]?children[key].convert(item,decode):item]))};
      }
      if(node.items) {
        const item=compile(node.items,path+'.items',dataPath+'.*');
        if(!item.changed)return unchanged(node);
        if(Object.hasOwn(node,'enum')||Object.hasOwn(node,'const'))unsupported();
        return {schema:{...node,items:item.schema},changed:true,convert:(value,decode)=>value.map(row=>item.convert(row,decode))};
      }
      return unchanged(node);
    };
    const logical=structuredClone(originalSchema),codec=compile(logical,'output_schema','');
    if(!codec.changed)return null;
    const wireValidation=combinedTurnStreamSchema(codec.schema),logicalValidation=combinedTurnStreamSchema(logical);
    const transform=(value,decode)=>{
      validateSchema(value,decode?wireValidation:logicalValidation,'output',true);
      const result=codec.convert(structuredClone(value),decode);
      validateSchema(result,decode?logicalValidation:wireValidation,'output',true);
      return result;
    };
    for(const [key,id]of assigned)registry.set(key,id);
    return {schema:structuredClone(codec.schema),table:{sources:[...sources].map(([id,evidence])=>({id,evidence:structuredClone(evidence)})),locations},
      instruction:questionOnly?'\n질문 진행 근거 형식: skip의 evidence에는 해당 output_schema 위치에 허용된 ID만 반환하세요. evidence_sources.sources는 ID와 subject·question_id·quote 원문 객체의 대응표이며 locations는 위치별 허용 범위입니다. 다른 위치의 허용 목록을 합치거나 ID·주체·문항·인용을 만들거나 바꾸지 마세요. 전체 원문으로 생략 이유를 판단하고, 선택한 근거가 설명 전체를 지지해야 합니다. clarify와 safety는 원래 형식을 유지하세요. 서버는 손실 없이 복원해 원래 스키마·원문 검증을 적용합니다. 이 질문 결정은 독립 검토의 승인이 아니며 최종 결과는 별도로 검토합니다.':instruction,
      encode:value=>transform(value,false),decode:value=>transform(value,true)};
  } catch(error) {if(error instanceof TypeError)return null;throw error;}
}
