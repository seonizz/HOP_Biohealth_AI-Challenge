import {validateSchema} from '../src/relationship-agent.js';

// Synthetic writers choose IDs only for exact fixture citations in their branch.
export function evidenceWireFixture(input,value) {
  const result=structuredClone(value);
  // Existing synthetic planners explicitly opt out of the new capability.
  // Production output is still required to include this nullable schema field.
  for(const [node,schema] of [[result,input.output_schema],[result?.questions,input.output_schema?.properties?.questions]]) {
    if(node&&schema?.properties?.personalization&&!Object.hasOwn(node,'personalization'))node.personalization=null;
  }
  if(!input.evidence_sources)return result;
  if(Array.isArray(result.skip)&&input.output_schema.properties?.skip?.type==='object'){
    const slots=new Map(Object.keys(input.output_schema.properties.skip.properties).map(id=>[id,null])),seen=new Set();
    for(const {question_id,...decision}of result.skip){
      if(seen.has(question_id))throw new TypeError('Duplicate synthetic question decision');
      seen.add(question_id);slots.set(question_id,decision);
    }
    result.skip=Object.fromEntries(slots);
  }
  if(input.evidence_sources.locations){
    const sources=new Map(input.evidence_sources.sources.map(row=>[JSON.stringify([row.evidence.subject,row.evidence.question_id,row.evidence.quote]),row.id]));
    const visit=(value,schema)=>{
      if(schema.anyOf){
        for(const branch of schema.anyOf){
          const candidate=visit(value,branch);
          try{validateSchema(candidate,branch);return candidate;}catch{}
        }
        const selected=schema.anyOf.find(branch=>branch.properties?.certainty?.const===value?.certainty||branch.properties?.certainty?.enum?.includes(value?.certainty));
        return visit(value,selected||schema.anyOf[0]);
      }
      if(schema.properties?.s&&value&&typeof value==='object'&&!Array.isArray(value)){
        const id=sources.get(JSON.stringify([value.subject,value.question_id,value.quote]));
        if(schema.properties.s.enum?.includes(id))return {s:id,...Object.fromEntries(Object.entries(value).filter(([key])=>!['subject','question_id','quote'].includes(key)))};
      }
      if(schema.properties?.source_ref&&value&&typeof value==='object'&&!Array.isArray(value)){
        const keys=['source_question_id','source_revision','component','quote','quote_start','quote_end'];
        const source=input.evidence_sources.personalization_sources?.find(row=>keys.every(key=>row.binding[key]===value[key]));
        if(source&&schema.properties.source_ref.enum?.includes(source.id))return {...Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key))),source_ref:source.id};
      }
      if(schema.type==='string'&&value&&typeof value==='object'&&!Array.isArray(value)){
        const id=sources.get(JSON.stringify([value.subject,value.question_id,value.quote]));
        return schema.enum?.includes(id)?id:value;
      }
      if(Array.isArray(value)&&schema.items)return value.map(item=>visit(item,schema.items));
      if(value&&typeof value==='object'&&schema.properties)return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,schema.properties[key]?visit(item,schema.properties[key]):item]));
      return value;
    };
    return visit(result,input.output_schema);
  }
  for(const table of input.evidence_sources){
    const match=/properties\.(patient|supporter|relationship)\.items(?:\.anyOf\[(\d+)\])?\.properties\.evidence\.items$/.exec(table.schema_path);
    const [,group,index]=match,items=input.output_schema.properties[group].items;
    const branch=index===undefined?items:items.anyOf[Number(index)];
    for(const row of result[group]||[]){
      const certainty=branch.properties.certainty;
      if(certainty?.const!==row.certainty&&!certainty?.enum?.includes(row.certainty))continue;
      row.evidence=row.evidence?.map(ref=>table.sources.find(source=>JSON.stringify(source.evidence)===JSON.stringify(ref))?.id||ref);
    }
  }
  return result;
}
