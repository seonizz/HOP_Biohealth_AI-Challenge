// Synthetic writers choose IDs only for exact fixture citations in their branch.
export function evidenceWireFixture(input,value) {
  if(!input.evidence_sources)return value;
  const result=structuredClone(value);
  if(input.evidence_sources.locations){
    const sources=new Map(input.evidence_sources.sources.map(row=>[JSON.stringify([row.evidence.subject,row.evidence.question_id,row.evidence.quote]),row.id]));
    const visit=(value,schema)=>{
      if(schema.anyOf){
        const selected=schema.anyOf.find(branch=>branch.properties?.certainty?.const===value?.certainty||branch.properties?.certainty?.enum?.includes(value?.certainty));
        return visit(value,selected||schema.anyOf[0]);
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
