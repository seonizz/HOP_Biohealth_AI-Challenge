import { HttpError } from './errors.js';
import { validateSchema } from './relationship-agent.js';

const fields=['subject','question_id','quote'];
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));
const type=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
const referenceKey=value=>record(value)&&Reflect.ownKeys(value).length===fields.length&&
  fields.every(key=>Object.hasOwn(value,key)&&typeof Object.getOwnPropertyDescriptor(value,key).value==='string')
  ?JSON.stringify(fields.map(key=>value[key])):null;
const targets=[['observations','patient'],['observations','supporter'],
  ['relationship','dynamics'],['relationship','strengths'],['relationship','boundaries']];

function invalid(path,value,expected) {
  const error=new HttpError(502,'MODEL_INVALID_RESPONSE','답변의 근거를 다시 확인하고 있어요. 잠시 후 다시 시도해 주세요.');
  error.modelReason='agent_evidence_reference';
  error.modelFeedback=JSON.stringify({path,keyword:'evidenceReference',expected,actual:{type:type(value)}});
  throw error;
}

function unsupported(path) {
  throw new TypeError('Unsupported final evidence-reference schema at '+path);
}

function objectShape(node,keys,path,allowEnum=false) {
  if(node?.type!=='object'||!record(node.properties)||Object.keys(node.properties).length!==keys.length||
    !keys.every(key=>Object.hasOwn(node.properties,key))||!Array.isArray(node.required)||
    node.required.length!==keys.length||!keys.every(key=>node.required.includes(key))||
    node.additionalProperties!==false||node.anyOf||(!allowEnum&&Object.hasOwn(node,'enum')))unsupported(path);
}

/**
 * Encode only the five citation leaves in a grounded final selection schema.
 * Private per-path allowlists are detached from the returned schema and table.
 * Hydration never repairs a partial quotation or validates the full analysis:
 * callers must retain the original strict validator and independent review.
 */
export function createFinalEvidenceReferenceCodec(selectionSchema) {
  const schema=structuredClone(selectionSchema);
  objectShape(schema,['observations','relationship','unknowns','safety'],'output');
  objectShape(schema.properties.observations,['patient','supporter'],'observations');
  objectShape(schema.properties.relationship,['label','supporter_role','dynamics','strengths','boundaries'],'relationship');
  objectShape(schema.properties.safety,['urgent','evidence_ids'],'safety');
  const byReference=new Map(),byId=new Map(),scopes=[];
  for(const [group,key]of targets) {
    const path=group+'.'+key,rows=schema.properties[group].properties[key];
    if(rows?.type!=='array'||rows.anyOf||rows.enum)unsupported(path);
    let citations=rows;
    if(group==='relationship') {
      objectShape(rows.items,['interpretation','evidence','certainty'],path+'.items');
      const certainty=rows.items.properties.certainty,allowed=key==='dynamics'?['tentative']:['reported','tentative'];
      if(certainty?.type!=='string'||!Array.isArray(certainty.enum)||certainty.enum.length!==allowed.length||
        !allowed.every(value=>certainty.enum.includes(value)))unsupported(path+'.items.certainty');
      citations=rows.items.properties.evidence;
    }
    const leaf=citations?.items,leafPath=path+(group==='relationship'?'.items.evidence':'')+'.items';
    if(citations?.type!=='array'||citations.anyOf||citations.enum)unsupported(leafPath);
    objectShape(leaf,fields,leafPath,true);
    // Object enums are expected only at citation leaves, so validate them below.
    if(!fields.every(field=>leaf.properties[field]?.type==='string')||
      (Object.hasOwn(leaf,'enum')&&!Array.isArray(leaf.enum)))unsupported(leafPath);
    const subjects=leaf.properties.subject.enum,allowedSubjects=group==='observations'?[key]:['patient','supporter','user_goal'];
    if(!Array.isArray(subjects)||subjects.length!==allowedSubjects.length||
      !allowedSubjects.every(subject=>subjects.includes(subject)))unsupported(leafPath+'.subject');
    const allowedIds=new Set(),allowedReferences=new Map();
    for(const reference of leaf.enum||[]) {
      const referenceId=referenceKey(reference);
      if(referenceId===null)unsupported(leafPath);
      try { validateSchema(reference,leaf); } catch { unsupported(leafPath); }
      let id=byReference.get(referenceId);
      if(id===undefined) {
        id='e'+byReference.size.toString(36);
        byReference.set(referenceId,id);byId.set(id,structuredClone(reference));
      }
      allowedIds.add(id);allowedReferences.set(referenceId,id);
    }
    // Empty enums are not accepted by every runner. The private empty set still
    // rejects every submitted reference, including when the public enum is absent.
    citations.items=allowedIds.size?{type:'string',enum:[...allowedIds]}:{type:'string'};
    scopes.push({group,key,allowedIds,allowedReferences});
  }

  function transform(value,hydrate) {
    if(!record(value))invalid('output',value,{type:'object'});
    for(const group of ['observations','relationship'])if(!Object.hasOwn(value,group)||!record(value[group]))
      invalid('output.'+group,value[group],{type:'object'});
    const replacements=[];
    for(const {group,key,allowedIds,allowedReferences}of scopes) {
      const path='output.'+group+'.'+key,rows=value[group][key];
      if(!Object.hasOwn(value[group],key)||!Array.isArray(rows))invalid(path,rows,{type:'array'});
      const transformReferences=(references,refPath)=>Array.from(references,(reference,index)=>{
        const itemPath=refPath+'['+index+']';
        if(hydrate) {
          if(typeof reference!=='string'||!allowedIds.has(reference))
            invalid(itemPath,reference,{type:'string',allowed_reference_count:allowedIds.size});
          return structuredClone(byId.get(reference));
        }
        const referenceId=referenceKey(reference),id=referenceId===null?undefined:allowedReferences.get(referenceId);
        if(id===undefined)invalid(itemPath,reference,{type:'object',allowed_reference_count:allowedReferences.size});
        return id;
      });
      if(group==='observations')replacements.push({group,key,rows:transformReferences(rows,path)});
      else {
        const evidence=Array.from(rows,(row,index)=>{
          const rowPath=path+'['+index+']';
          if(!record(row))invalid(rowPath,row,{type:'object'});
          if(!Object.hasOwn(row,'evidence')||!Array.isArray(row.evidence))
            invalid(rowPath+'.evidence',row.evidence,{type:'array'});
          return transformReferences(row.evidence,rowPath+'.evidence');
        });
        replacements.push({group,key,evidence});
      }
    }
    const output=structuredClone(value);
    for(const replacement of replacements) {
      const {group,key,rows,evidence}=replacement;
      if(rows)output[group][key]=rows;
      else evidence.forEach((references,index)=>{output[group][key][index].evidence=references;});
    }
    return output;
  }

  return {schema,references:structuredClone(Object.fromEntries(byId)),
    encode:value=>transform(value,false),hydrate:value=>transform(value,true)};
}
