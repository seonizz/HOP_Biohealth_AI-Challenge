import { HttpError } from './errors.js';
import { validateSchema } from './relationship-agent.js';

const fields=['subject','question_id','quote'];
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));
const type=value=>value===null?'null':Array.isArray(value)?'array':typeof value;
const referenceKey=value=>record(value)&&Reflect.ownKeys(value).length===fields.length&&
  fields.every(key=>Object.hasOwn(value,key)&&typeof Object.getOwnPropertyDescriptor(value,key).value==='string')
  ?JSON.stringify(fields.map(key=>value[key])):null;

function invalid(path,value,expected) {
  const error=new HttpError(502,'MODEL_INVALID_RESPONSE','답변의 근거를 다시 확인하고 있어요. 잠시 후 다시 시도해 주세요.');
  error.modelReason='agent_evidence_reference';
  // Do not echo unknown IDs, object keys, or source text into repair feedback.
  error.modelFeedback=JSON.stringify({path,keyword:'evidenceReference',expected,actual:{type:type(value)}});
  throw error;
}

function unsupported(path) {
  throw new TypeError('Unsupported evidence-reference schema at '+path);
}

/**
 * Compact only combined-draft relationship-memory citations. The returned
 * schema/table are detached from the private allowlists used by both methods.
 * Hydration must precede the existing full draft validator and normalizers:
 * this codec deliberately does not validate finding/evidence cardinalities,
 * interpretations, questions, or any other part of the original contract.
 */
export function createEvidenceReferenceCodec(draftSchema) {
  const schema=structuredClone(draftSchema);
  const memory=schema?.properties?.state?.properties?.relationship_memory;
  if(memory?.type!=='object')unsupported('state.relationship_memory');
  const byReference=new Map(),byId=new Map(),groups=new Map();

  for(const subject of ['patient','supporter','relationship']) {
    const path='state.relationship_memory.'+subject,group=memory.properties?.[subject];
    if(group?.type!=='array')unsupported(path);
    // The gateway's existing literal-only retry retains just the reported
    // object. Support that explicit restriction, never an unknown branch shape.
    const certainties=subject==='relationship'?['tentative']:group.items?.anyOf?['reported','tentative']:['reported'];
    const variants=group.items?.anyOf||[group.items];
    if(!Array.isArray(variants)||variants.length!==certainties.length)unsupported(path+'.items');
    const branches=new Map();
    for(const variant of variants) {
      const choices=variant?.properties?.certainty?.enum;
      if(variant?.type!=='object'||!Array.isArray(choices)||choices.length!==1||
        !certainties.includes(choices[0])||branches.has(choices[0]))unsupported(path+'.items.certainty');
      branches.set(choices[0],variant);
    }
    const scopes=new Map();
    // The fixed order also keeps IDs stable if anyOf branches are reordered.
    for(const certainty of certainties) {
      const variant=branches.get(certainty),evidence=variant.properties.evidence;
      const leaf=evidence?.items,leafPath=path+'.'+certainty+'.evidence.items';
      if(evidence?.type!=='array'||leaf?.type!=='object'||!record(leaf.properties)||
        Object.keys(leaf.properties).length!==fields.length||!fields.every(key=>Object.hasOwn(leaf.properties,key))||
        !Array.isArray(leaf.required)||leaf.required.length!==fields.length||!fields.every(key=>leaf.required.includes(key))||
        leaf.additionalProperties!==false||(Object.hasOwn(leaf,'enum')&&!Array.isArray(leaf.enum)))unsupported(leafPath);
      const allowedIds=new Set(),allowedReferences=new Map();
      for(const reference of leaf.enum||[]) {
        const key=referenceKey(reference);
        if(key===null)unsupported(leafPath);
        try { validateSchema(reference,leaf); } catch { unsupported(leafPath); }
        let id=byReference.get(key);
        if(id===undefined) {
          id='e'+byReference.size.toString(36);
          byReference.set(key,id);byId.set(id,structuredClone(reference));
        }
        allowedIds.add(id);allowedReferences.set(key,id);
      }
      // XGrammar rejects an empty enum, even inside an unused zero-item array.
      // An empty private allowlist still rejects every nonempty citation here.
      evidence.items=allowedIds.size?{type:'string',enum:[...allowedIds]}:{type:'string'};
      scopes.set(certainty,{allowedIds,allowedReferences});
    }
    groups.set(subject,scopes);
  }

  function transform(draft,hydrate) {
    if(!record(draft))invalid('output',draft,{type:'object'});
    if(!Object.hasOwn(draft,'state')||!record(draft.state))invalid('output.state',draft.state,{type:'object'});
    if(!Object.hasOwn(draft.state,'relationship_memory')||!record(draft.state.relationship_memory))
      invalid('output.state.relationship_memory',draft.state.relationship_memory,{type:'object'});
    const memory=draft.state.relationship_memory,replacements=[];
    for(const [subject,scopes]of groups) {
      const path='output.state.relationship_memory.'+subject,rows=memory[subject];
      if(!Object.hasOwn(memory,subject)||!Array.isArray(rows))invalid(path,rows,{type:'array'});
      for(let index=0;index<rows.length;index++) {
        const row=rows[index],rowPath=path+'['+index+']';
        if(!record(row))invalid(rowPath,row,{type:'object'});
        const scope=Object.hasOwn(row,'certainty')?scopes.get(row.certainty):undefined;
        if(!scope)invalid(rowPath+'.certainty',row.certainty,{enum:[...scopes.keys()]});
        if(!Object.hasOwn(row,'evidence')||!Array.isArray(row.evidence))
          invalid(rowPath+'.evidence',row.evidence,{type:'array'});
        const evidence=Array.from(row.evidence,(reference,refIndex)=>{
          const refPath=rowPath+'.evidence['+refIndex+']';
          if(hydrate) {
            if(typeof reference!=='string'||!scope.allowedIds.has(reference))
              invalid(refPath,reference,{type:'string',allowed_reference_count:scope.allowedIds.size});
            return structuredClone(byId.get(reference));
          }
          const key=referenceKey(reference),id=key===null?undefined:scope.allowedReferences.get(key);
          if(id===undefined)invalid(refPath,reference,{type:'object',allowed_reference_count:scope.allowedReferences.size});
          return id;
        });
        replacements.push({subject,index,evidence});
      }
    }
    const output=structuredClone(draft);
    for(const {subject,index,evidence}of replacements)output.state.relationship_memory[subject][index].evidence=evidence;
    return output;
  }

  return {schema,references:structuredClone(Object.fromEntries(byId)),
    encode:draft=>transform(draft,false),hydrate:draft=>transform(draft,true)};
}
