// Prompt representation only. The full schema still governs generation and
// validation; this projection must round-trip before it can be transmitted.
const SOURCE=['source_question_id','source_revision','component','quote_start','quote_end'];
const AXIS=['axis','role','agreement_item_id'];
const FIXED=['event_id','quote'];
const KEYS=[...SOURCE,...AXIS,...FIXED];
const AXES=['actor','execution','source','time','agreement','modality'];
const PATHS=[['properties','clarify','items'],['properties','questions','properties','clarify','items']];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const exactKeys=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const at=(value,path)=>path.reduce((node,key)=>node?.[key],value);
const pick=(value,keys)=>Object.fromEntries(keys.map(key=>[key,value[key]]));
const empty=value=>exactKeys(value,[]);
const stringConstant=node=>object(node)&&typeof node.const==='string'&&node.const.length>0&&
  Object.keys(node).every(key=>['const','type'].includes(key))&&(!Object.hasOwn(node,'type')||node.type==='string');
const integerConstant=node=>object(node)&&Number.isSafeInteger(node.const)&&
  Object.keys(node).every(key=>['const','type'].includes(key))&&(!Object.hasOwn(node,'type')||node.type==='integer');
const integerRange=node=>exactKeys(node,['type','minimum','maximum'])&&node.type==='integer'&&
  Number.isSafeInteger(node.minimum)&&Number.isSafeInteger(node.maximum)&&node.minimum>=0&&node.minimum<=node.maximum;
const boundedString=node=>exactKeys(node,['type','minLength','maxLength'])&&node.type==='string'&&
  Number.isSafeInteger(node.minLength)&&Number.isSafeInteger(node.maxLength)&&node.minLength>=0&&node.minLength<=node.maxLength;
const nullSchema=node=>exactKeys(node,['type'])&&node.type==='null';
const roles=node=>object(node)&&Object.keys(node).every(key=>['enum','type'].includes(key))&&
  (!Object.hasOwn(node,'type')||node.type==='string')&&Array.isArray(node.enum)&&node.enum.length>0&&
  node.enum.every(role=>typeof role==='string'&&role.length>0)&&new Set(node.enum).size===node.enum.length;

export const CLARIFICATION_SCHEMA_PROMPT_INSTRUCTION='확인 질문 스키마의 allOf는 두 조건을 모두 만족해야 한다는 뜻입니다. 원문 조건 anyOf에서 한 묶음, 축 조건 anyOf에서 한 묶음을 함께 지키세요. 서로 다른 원문의 문항·수정번호·component·위치 한도를 섞지 말고, axis와 role·agreement_item_id의 묶음도 유지하세요. 원문과 출력 필드, 독립 검토 기준은 그대로입니다.';

function sourceTuple(value) {
  return exactKeys(value,SOURCE)&&stringConstant(value.source_question_id)&&integerConstant(value.source_revision)&&
    stringConstant(value.component)&&['rawText','custom'].includes(value.component.const)&&
    integerRange(value.quote_start)&&integerRange(value.quote_end);
}
function axisTuple(value) {
  if(!exactKeys(value,AXIS)||!stringConstant(value.axis)||!AXES.includes(value.axis.const))return false;
  return (value.axis.const==='actor'?roles(value.role):nullSchema(value.role))&&
    (value.axis.const==='agreement'?boundedString(value.agreement_item_id):nullSchema(value.agreement_item_id));
}
function closedObject(node,extra=[]) {
  return exactKeys(node,['type','properties','required','additionalProperties',...extra])&&node.type==='object'&&
    exactKeys(node.properties,KEYS)&&Array.isArray(node.required)&&node.required.length===KEYS.length&&
    new Set(node.required).size===KEYS.length&&KEYS.every(key=>node.required.includes(key))&&node.additionalProperties===false;
}
function locations(schema) {
  return PATHS.filter(path=>{
    const array=at(schema,path.slice(0,-1));
    return array?.type==='array'&&array.minItems===0&&array.maxItems===1&&object(array.items);
  });
}
function replaceItem(schema,path,item) {
  const result=structuredClone(schema);
  at(result,path.slice(0,-1)).items=item;
  return result;
}
function expandItem(node) {
  if(!closedObject(node,['allOf'])||!boundedString(node.properties.event_id)||!boundedString(node.properties.quote)||
    ![...SOURCE,...AXIS].every(key=>empty(node.properties[key]))||!Array.isArray(node.allOf)||node.allOf.length!==2)return null;
  const groups=node.allOf.map(group=>exactKeys(group,['anyOf'])&&Array.isArray(group.anyOf)?group.anyOf:null);
  if(!groups.every(group=>group?.length>0)||groups[0].length>128||groups[1].length!==AXES.length)return null;
  const [sources,axes]=groups.map((group,index)=>group.map(fragment=>
    exactKeys(fragment,['properties'])&&(index===0?sourceTuple(fragment.properties):axisTuple(fragment.properties))?fragment.properties:null));
  if([...sources,...axes].some(value=>value===null)||new Set(sources.map(JSON.stringify)).size!==sources.length||
    new Set(axes.map(value=>value.axis.const)).size!==AXES.length)return null;
  const {allOf,...base}=node;
  return {anyOf:sources.flatMap(source=>axes.map(axis=>({...structuredClone(base),properties:Object.fromEntries(
    Object.keys(base.properties).map(key=>[key,structuredClone(source[key]??axis[key]??base.properties[key])]))})))};
}

function compactItem(node) {
  if(!exactKeys(node,['anyOf'])||!Array.isArray(node.anyOf)||node.anyOf.length<AXES.length||node.anyOf.length>768)return null;
  const first=node.anyOf[0];
  if(!closedObject(first)||!boundedString(first.properties.event_id)||!boundedString(first.properties.quote))return null;
  const header=Object.fromEntries(Object.entries(first).filter(([key])=>key!=='properties'));
  const fixed=pick(first.properties,FIXED),sources=new Map(),axes=new Map();
  for(const branch of node.anyOf){
    if(!closedObject(branch)||!same(Object.keys(branch.properties),Object.keys(first.properties))||
      !same(Object.fromEntries(Object.entries(branch).filter(([key])=>key!=='properties')),header)||!same(pick(branch.properties,FIXED),fixed))return null;
    const source=pick(branch.properties,SOURCE),axis=pick(branch.properties,AXIS);
    if(!sourceTuple(source)||!axisTuple(axis))return null;
    sources.set(JSON.stringify(source),source);axes.set(JSON.stringify(axis),axis);
  }
  if(axes.size!==AXES.length||sources.size*axes.size!==node.anyOf.length)return null;
  const compact={...structuredClone(first),properties:Object.fromEntries(Object.keys(first.properties).map(key=>
    [key,Object.hasOwn(fixed,key)?structuredClone(fixed[key]):{}])),allOf:[
      {anyOf:[...sources.values()].map(properties=>({properties:structuredClone(properties)}))},
      {anyOf:[...axes.values()].map(properties=>({properties:structuredClone(properties)}))},
    ]};
  // Exact equality also rejects missing/duplicate pairs and reordered products.
  // No cross-product is invented merely from matching group counts.
  if(!same(expandItem(compact),node)||JSON.stringify(compact).length>=JSON.stringify(node).length)return null;
  return {schema:compact,sourceChoices:sources.size,axisChoices:axes.size,originalBranches:node.anyOf.length};
}

export function compactClarificationPromptSchema(schema) {
  const unchanged=()=>({schema:structuredClone(schema),compacted:false,proof:null,instruction:''});
  const paths=locations(schema);
  if(paths.length!==1)return unchanged();
  const path=paths[0],result=compactItem(at(schema,path));
  if(!result)return unchanged();
  const compacted=replaceItem(schema,path,result.schema);
  return {schema:compacted,compacted:true,instruction:CLARIFICATION_SCHEMA_PROMPT_INSTRUCTION,
    proof:{kind:'v3_clarification_cartesian',path:[...path],originalBranches:result.originalBranches,
      sourceChoices:result.sourceChoices,axisChoices:result.axisChoices,roundTripEqual:true,
      beforeCharacters:JSON.stringify(schema).length,afterCharacters:JSON.stringify(compacted).length}};
}

export function expandClarificationPromptSchema(schema) {
  const paths=locations(schema).filter(path=>Object.hasOwn(at(schema,path),'allOf'));
  if(paths.length===0)return structuredClone(schema);
  if(paths.length!==1)throw new TypeError('Ambiguous compact clarification schema');
  const path=paths[0],expanded=expandItem(at(schema,path));
  if(!expanded)throw new TypeError('Invalid compact clarification schema');
  const compacted=compactItem(expanded);
  if(!compacted||!same(compacted.schema,at(schema,path)))throw new TypeError('Invalid compact clarification schema');
  return replaceItem(schema,path,expanded);
}
