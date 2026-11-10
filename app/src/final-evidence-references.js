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

// The operation owns this registry. Retain assignments for removed candidates
// so an ID in earlier repair feedback can never name a different source.
// Construction is transactional: unsupported schemas do not change the map.
function referenceIds(registry) {
  if(registry!==undefined&&!(registry instanceof Map))unsupported('registry');
  const assigned=new Map(registry),used=new Set();
  for(const [key,id]of assigned) {
    if(typeof key!=='string')unsupported('registry');
    let parts;
    try { parts=JSON.parse(key); } catch { unsupported('registry'); }
    if(!Array.isArray(parts)||parts.length!==fields.length||!parts.every(part=>typeof part==='string')||
      typeof id!=='string'||!/^e[0-9a-z]+$/u.test(id)||used.has(id))unsupported('registry');
    used.add(id);
  }
  return {get(key){
    let id=assigned.get(key);
    if(id===undefined) {
      let index=assigned.size;
      do { id='e'+(index++).toString(36); } while(used.has(id));
      assigned.set(key,id);used.add(id);
    }
    return id;
  },commit(){if(registry)for(const [key,id]of assigned)registry.set(key,id);}};
}

/**
 * Encode only the five citation leaves in a grounded final selection schema.
 * Private per-path allowlists are detached from the returned schema and table.
 * Hydration never repairs a partial quotation or validates the full analysis:
 * callers must retain the original strict validator and independent review.
 */
export function createFinalEvidenceReferenceCodec(selectionSchema,{registry}={}) {
  const schema=structuredClone(selectionSchema);
  objectShape(schema,['observations','relationship','unknowns','safety'],'output');
  objectShape(schema.properties.observations,['patient','supporter'],'observations');
  objectShape(schema.properties.relationship,['label','supporter_role','dynamics','strengths','boundaries'],'relationship');
  objectShape(schema.properties.safety,['urgent','evidence_ids'],'safety');
  const byReference=new Map(),byId=new Map(),scopes=[],ids=referenceIds(registry);
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
        id=ids.get(referenceId);
        byReference.set(referenceId,id);byId.set(id,structuredClone(reference));
      }
      allowedIds.add(id);allowedReferences.set(referenceId,id);
    }
    // Empty enums are not accepted by every runner. The private empty set still
    // rejects every submitted reference, including when the public enum is absent.
    citations.items=allowedIds.size?{type:'string',enum:[...allowedIds]}:{type:'string'};
    scopes.push({group,key,allowedIds,allowedReferences});
  }
  ids.commit();

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

/**
 * The plan and speech-detail writers have only direct citation arrays. Keep
 * these explicit shapes separate from the five-path analysis contract.
 * Only citation leaves change; why, boundary choices and all other values
 * remain model-authored and still require the caller's original validators.
 */
export function createFinalStageEvidenceReferenceCodec(selectionSchema,{kind,registry}={}) {
  const schema=structuredClone(selectionSchema),ids=referenceIds(registry);
  let paths;
  if(kind==='plan') {
    objectShape(schema,['voice','opening_evidence','user_intent','patient_choice','supporter_care','avoid_patterns','next_step'],'output');
    paths=[['opening_evidence']];
  } else if(kind==='detail') {
    objectShape(schema,['opening_end','listening_end','opening','listening','offer'],'output');
    for(const key of ['opening','listening','offer'])objectShape(schema.properties[key],['why','evidence'],key);
    paths=['opening','listening','offer'].map(key=>[key,'evidence']);
  } else unsupported('stage');
  const byId=new Map(),scopes=[];
  for(const path of paths) {
    let parent=schema;
    for(const key of path.slice(0,-1))parent=parent.properties[key];
    const key=path.at(-1),citations=parent.properties[key],leaf=citations?.items,leafPath=path.join('.')+'.items';
    if(citations?.type!=='array'||citations.anyOf||citations.enum)unsupported(leafPath);
    objectShape(leaf,fields,leafPath,true);
    if(!fields.every(field=>leaf.properties[field]?.type==='string')||!Array.isArray(leaf.enum)||!leaf.enum.length)
      unsupported(leafPath);
    const subjects=leaf.properties.subject.enum;
    if(!Array.isArray(subjects)||subjects.length!==3||!['patient','supporter','user_goal'].every(subject=>subjects.includes(subject)))
      unsupported(leafPath+'.subject');
    const allowedIds=new Set(),allowedReferences=new Map();
    for(const reference of leaf.enum) {
      const referenceId=referenceKey(reference);
      if(referenceId===null)unsupported(leafPath);
      try { validateSchema(reference,leaf); } catch { unsupported(leafPath); }
      const id=ids.get(referenceId);
      byId.set(id,structuredClone(reference));allowedIds.add(id);allowedReferences.set(referenceId,id);
    }
    citations.items={type:'string',enum:[...allowedIds]};
    scopes.push({path,allowedIds,allowedReferences});
  }
  ids.commit();

  function transform(value,hydrate) {
    if(!record(value))invalid('output',value,{type:'object'});
    const replacements=[];
    for(const {path,allowedIds,allowedReferences}of scopes) {
      let parent=value,outputPath='output';
      for(const key of path.slice(0,-1)) {
        outputPath+='.'+key;
        if(!Object.hasOwn(parent,key)||!record(parent[key]))invalid(outputPath,parent[key],{type:'object'});
        parent=parent[key];
      }
      const key=path.at(-1),references=parent[key];outputPath+='.'+key;
      if(!Object.hasOwn(parent,key)||!Array.isArray(references))invalid(outputPath,references,{type:'array'});
      replacements.push({path,references:Array.from(references,(reference,index)=>{
        const itemPath=outputPath+'['+index+']';
        if(hydrate) {
          if(typeof reference!=='string'||!allowedIds.has(reference))
            invalid(itemPath,reference,{type:'string',allowed_reference_count:allowedIds.size});
          return structuredClone(byId.get(reference));
        }
        const key=referenceKey(reference),id=key===null?undefined:allowedReferences.get(key);
        if(id===undefined)invalid(itemPath,reference,{type:'object',allowed_reference_count:allowedReferences.size});
        return id;
      })});
    }
    const output=structuredClone(value);
    for(const {path,references}of replacements) {
      let parent=output;
      for(const key of path.slice(0,-1))parent=parent[key];
      parent[path.at(-1)]=references;
    }
    return output;
  }
  return {schema,references:structuredClone(Object.fromEntries(byId)),
    locations:scopes.map(({path,allowedIds})=>({schema_path:'output_schema.'+path.map(key=>'properties.'+key).join('.')+'.items',
      allowed_source_ids:[...allowedIds]})),
    encode:value=>transform(value,false),hydrate:value=>transform(value,true)};
}
