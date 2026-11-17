import {createHash} from 'node:crypto';
import {HttpError} from './errors.js';
import {validateSchema} from './relationship-agent.js';
import {restoreReviewSources} from './final-review-bundle.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&
  [Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(values,expected)=>values.length===expected.length&&expected.every(value=>values.includes(value));
const reviewer=/^(?:turn_review|state_review|analysis_review|plan_review|speech_review|support_review|guide_review|speech_detail_review|safety_review|question_review|guide_quality|final_review_bundle|card_review_bundle)(?:_|$)/u;
const bundleStage=/^(?:final_review_bundle|card_review_bundle|turn_review_bundle)(?:_|$)/u;
const verdictSets=[['supported','plausible','unsupported'],['sound_guidance','problem_in_guidance','unclear'],
  ['sound_avoidance','problem_in_recommended_content','unclear'],['still_unknown','already_answered','not_needed','review_uncertain']];
const keywords=new Set(['type','properties','required','additionalProperties','items','enum','const','minLength','maxLength','minItems','maxItems','description','anyOf']);
const unsupported=()=>{throw new TypeError('Unsupported compact review contract');};
const fail=()=>{const error=new HttpError(502,'MODEL_INVALID_RESPONSE','검토 결과의 형식을 다시 확인하고 있어요.');
  error.modelReason='agent_schema';throw error;};

// Reject accessors, prototype tricks, sparse arrays and cycles before reading
// model values. No source text, candidate IDs or fingerprints enter errors.
function jsonData(value,seen=new Set()) {
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(!value||typeof value!=='object'||seen.has(value)||!Array.isArray(value)&&!plain(value))unsupported();
  const keys=Reflect.ownKeys(value),descriptors=Object.getOwnPropertyDescriptors(value);
  if(keys.some(key=>typeof key!=='string'||!Object.hasOwn(descriptors[key],'value')))unsupported();
  seen.add(value);
  try {
    if(Array.isArray(value)) {
      if(keys.length!==value.length+1||Array.from({length:value.length},(_,index)=>String(index)).some(key=>!Object.hasOwn(value,key)))unsupported();
      return value.map(item=>jsonData(item,seen));
    }
    const entries=[];
    for(const key of keys) {
      if(!descriptors[key].enumerable)unsupported();
      // Match JSON request serialization, which omits undefined object values.
      if(value[key]!==undefined)entries.push([key,jsonData(value[key],seen)]);
    }
    return Object.fromEntries(entries);
  } finally {seen.delete(value);}
}

const strictObject=node=>plain(node)&&node.type==='object'&&plain(node.properties)&&Array.isArray(node.required)&&
  exact(node.required,Object.keys(node.properties))&&node.additionalProperties===false&&!node.anyOf;
function knownSchema(node) {
  if(!plain(node)||Object.keys(node).some(key=>!keywords.has(key)))return false;
  return (!node.properties||plain(node.properties)&&Object.values(node.properties).every(knownSchema))&&
    (!node.items||knownSchema(node.items))&&(!node.anyOf||Array.isArray(node.anyOf)&&node.anyOf.length>0&&node.anyOf.every(knownSchema));
}
const identity=schema=>({schema:structuredClone(schema),encode:value=>structuredClone(value),hydrate:value=>structuredClone(value)});

/** Standalone safety selection only. Preserves the selected ID set and exact
 * model-authored basis/reason; evidence_ids are restored in source order, not
 * the logical input array's arbitrary order. Duplicate logical IDs are errors.
 * The caller must reject duplicate raw JSON keys and run its original safety
 * validator after hydration. This codec never decides or approves safety.
 */
export function safetyReviewSelectionTransport({stage,schema,payload}) {
  if(typeof stage!=='string'||!/^safety_review(?:_|$)/u.test(stage)||payload===undefined)return null;
  try {
    const logicalSchema=jsonData(schema),request=jsonData(payload);
    const only=(node,keys)=>plain(node)&&Object.keys(node).every(key=>keys.includes(key));
    if(!knownSchema(logicalSchema)||!strictObject(logicalSchema)||
      !only(logicalSchema,['type','properties','required','additionalProperties','description'])||
      !exact(Object.keys(logicalSchema.properties),['basis','reason','evidence_ids'])||!Array.isArray(request?.safety_sources))return null;
    const {basis,reason,evidence_ids:selection}=logicalSchema.properties;
    const bases=['current_physical_danger','distress_without_immediate_danger','negated','past_only','unclear'];
    if(!only(basis,['type','enum','description'])||basis.type!=='string'||!Array.isArray(basis.enum)||!exact(basis.enum,bases)||
      !only(reason,['type','minLength','maxLength','description'])||reason.type!=='string'||reason.minLength!==1||
      !Number.isSafeInteger(reason.maxLength)||reason.maxLength<1||
      !only(selection,['type','items','minItems','maxItems','description'])||selection.type!=='array'||
      !Number.isSafeInteger(selection.minItems)||selection.minItems<0||!Number.isSafeInteger(selection.maxItems)||
      selection.maxItems<selection.minItems||!only(selection.items,['type','enum','description'])||
      selection.items.type!=='string'||!Array.isArray(selection.items.enum))return null;
    const ids=request.safety_sources.map(source=>plain(source)?source.id:undefined);
    if(ids.some(id=>typeof id!=='string'||!id.trim())||new Set(ids).size!==ids.length||
      new Set(selection.items.enum).size!==selection.items.enum.length||
      !exact(selection.items.enum,ids.length?ids:['none'])||selection.maxItems>ids.length)return null;
    const binding=createHash('sha256').update(JSON.stringify(['safety-selection-output-v1',stage,logicalSchema,request])).digest('hex').slice(0,32);
    const wireSchema=object({b:{type:'string',enum:[binding]},o:object({
      basis:structuredClone(basis),reason:structuredClone(reason),
      evidence_selection:object(Object.fromEntries(ids.map(id=>[id,{type:'boolean'}]))),
    })}),privateSchema=structuredClone(wireSchema);
    return {schema:wireSchema,
      instruction:'\n안전 검토 출력 전송 형식: 원래 안전 판단과 전체 원문 검토 기준을 유지하세요. output_schema에 따라 b에는 현재 요청값, o에는 basis·reason·evidence_selection을 반환하세요. basis와 구체적인 reason은 직접 판단하여 작성합니다. evidence_selection은 safety_sources의 각 실제 ID를 키로 가진 객체입니다. 모든 키를 한 번씩 쓰고 해당 근거를 선택하면 true, 선택하지 않으면 false로 쓰세요. 선택 개수 제한은 '+selection.maxItems+'개입니다. 다른 근거로 개수를 채우지 마세요. evidence_ids 배열은 전송하지 않습니다. 서버는 true인 ID만 현재 safety_sources 순서의 evidence_ids로 복원하며 판단·이유·근거를 추가하거나 승인하지 않습니다. 현재 위험에는 유효한 현재 위험 근거가 반드시 필요합니다.',
      encode(logical){
        try {jsonData(logical);} catch {fail();}
        validateSchema(logical,logicalSchema,'output',true);
        if(new Set(logical.evidence_ids).size!==logical.evidence_ids.length)fail();
        const selected=new Set(logical.evidence_ids);
        const wire={b:binding,o:{basis:logical.basis,reason:logical.reason,
          evidence_selection:Object.fromEntries(ids.map(id=>[id,selected.has(id)]))}};
        validateSchema(wire,privateSchema,'output',true);return wire;
      },
      hydrate(wire){
        try {jsonData(wire);} catch {fail();}
        validateSchema(wire,privateSchema,'output',true);
        const logical={basis:wire.o.basis,reason:wire.o.reason,evidence_ids:ids.filter(id=>wire.o.evidence_selection[id])};
        validateSchema(logical,logicalSchema,'output',true);return logical;
      }};
  } catch(error) {if(error instanceof TypeError)return null;throw error;}
}

/** Lossless reviewer-output representation only. Every reason/repair remains
 * model-authored, including passing/unknown/tentative audits. The caller must
 * reject duplicate raw JSON keys before hydration, then run its original
 * logical schema and semantic validator. Partial mode exposes unresolved whole
 * tasks only to the existing private bundle recovery path, never as approvals.
 */
export function compactReviewTransport({stage,schema,payload,partial=false}) {
  if(typeof stage!=='string'||!reviewer.test(stage)||payload===undefined||typeof partial!=='boolean')return null;
  try {
    const logicalSchema=jsonData(schema),request=jsonData(payload),mappings=[],verdictTables=[],tableIds=new Map();
    if(!knownSchema(logicalSchema)||!strictObject(logicalSchema))return null;
    let auditCount=0;
    const binding=createHash('sha256').update(JSON.stringify(['compact-review-output-v4',stage,logicalSchema,request])).digest('hex').slice(0,32);

    function issueArray(node) {
      if(node?.type!=='array'||node.anyOf)unsupported();
      if(node.items.type==='string')return identity(node);
      const fields=Object.keys(node.items.properties||{});
      if(!strictObject(node.items)||!exact(fields,['reason','repair'])&&!exact(fields,['field','reason','repair']))unsupported();
      const aliases={field:'f',reason:'r',repair:'x'};
      const mapped=Object.fromEntries(fields.map(key=>[aliases[key],structuredClone(node.items.properties[key])]));
      const convert=(value,hydrate)=>value.map(row=>Object.fromEntries(fields.map(key=>[hydrate?key:aliases[key],row[hydrate?aliases[key]:key]])));
      return {schema:{...structuredClone(node),items:object(mapped)},encode:value=>convert(value,false),hydrate:value=>convert(value,true)};
    }

    function audits(node,data,path) {
      if(node?.type!=='array'||node.anyOf||!Number.isSafeInteger(node.minItems)||node.minItems!==node.maxItems)unsupported();
      const branches=node.items.anyOf||[node.items],byId=new Map();let reasonSchema;
      if(node.items.anyOf&&Object.keys(node.items).some(key=>!['anyOf','description'].includes(key)))unsupported();
      for(const branch of branches) {
        if(!strictObject(branch)||!exact(Object.keys(branch.properties),['id','verdict','reason']))unsupported();
        const {id,verdict,reason}=branch.properties;
        if(id.type!=='string'||!Array.isArray(id.enum)||new Set(id.enum).size!==id.enum.length||
          verdict.type!=='string'||!Array.isArray(verdict.enum)||!verdictSets.some(set=>exact(verdict.enum,set))||
          reason.type!=='string'||reason.minLength!==1||!Number.isSafeInteger(reason.maxLength)||reason.maxLength<1||reason.anyOf)unsupported();
        if(reasonSchema&&JSON.stringify(reasonSchema)!==JSON.stringify(reason))unsupported();
        reasonSchema=structuredClone(reason);
        for(const key of id.enum) {if(typeof key!=='string'||byId.has(key))unsupported();byId.set(key,{verdict,reason});}
      }
      const claims=data?.claims??data?.review_target?.claims;
      if(!Array.isArray(claims))unsupported();
      const ids=claims.map(claim=>claim?.id);
      if(ids.length!==node.minItems||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'))unsupported();
      if(ids.length===0) {
        if(byId.size!==1||!byId.has('none'))unsupported();
      } else if(byId.size!==ids.length||ids.some(id=>!byId.has(id)))unsupported();
      const rows=ids.map((id,index)=>{
        const slot='a'+index.toString(36),prefix=(auditCount++).toString(36),{verdict,reason}=byId.get(id);
        const codes=verdict.enum.map((value,index)=>[prefix+'.'+index.toString(36),value]);
        const signature=JSON.stringify(verdict.enum);
        if(!tableIds.has(signature)){tableIds.set(signature,verdictTables.length);verdictTables.push([...verdict.enum]);}
        mappings.push([path+'.'+slot,id,tableIds.get(signature),prefix]);
        return {id,slot,codes,schema:object({v:{type:'string',enum:codes.map(([code])=>code)},r:structuredClone(reason)})};
      });
      // Each named slot exposes its own exact code enum to the constrained
      // decoder. A shared array item grammar allowed the model to repeat a
      // different ordinal's code even when its prose verdict was correct.
      return {schema:object(Object.fromEntries(rows.map(row=>[row.slot,row.schema]))),
        encode(value){
          // The request's claim order is explicit. Do not silently reorder a
          // supplied logical response while claiming an exact round trip.
          if(value.length!==rows.length||rows.some((row,index)=>value[index]?.id!==row.id))fail();
          return Object.fromEntries(rows.map((row,index)=>[row.slot,{v:row.codes.find(([,verdict])=>verdict===value[index].verdict)?.[0],r:value[index].reason}]));
        },
        hydrate(value){return rows.map((row,index)=>{
          validateSchema(value[row.slot],row.schema,'output.'+path+'.'+row.slot,true);
          return {id:row.id,verdict:row.codes.find(([code])=>code===value[row.slot].v)?.[1],reason:value[row.slot].r};
        });}};
    }

    function review(node,data,path) {
      if(!strictObject(node))unsupported();
      const keys=Object.keys(node.properties),children={},aliases={approved:'p',issues:'i',audits:'a',improvements:'m'};
      if(exact(keys,['state','questions','safety'])&&node.properties.questions.type==='null'&&node.properties.safety.type==='null') {
        children.state=review(node.properties.state,data,path+'.state');children.questions=identity(node.properties.questions);children.safety=identity(node.properties.safety);
      } else if(exact(keys,['audits'])||exact(keys,['approved','issues'])||exact(keys,['approved','issues','audits'])||exact(keys,['improvements'])) {
        if(node.properties.approved&&node.properties.approved.type!=='boolean')unsupported();
        for(const key of keys)children[key]=key==='audits'?audits(node.properties[key],data,path+'.a'):
          ['issues','improvements'].includes(key)?issueArray(node.properties[key]):identity(node.properties[key]);
      } else if(exact(keys,['basis','reason','evidence_ids'])) {
        // Safety is intentionally unchanged. Its classification/reason/source
        // contract is independent of claim audits and stays with its validator.
        return identity(node);
      } else unsupported();
      const renamed=key=>Object.hasOwn(aliases,key)?aliases[key]:key;
      const convert=(value,hydrate)=>Object.fromEntries(keys.map(key=>[hydrate?key:renamed(key),
        children[key][hydrate?'hydrate':'encode'](value[hydrate?renamed(key):key]) ]));
      return {schema:object(Object.fromEntries(keys.map(key=>[renamed(key),children[key].schema]))),
        encode:value=>convert(value,false),hydrate:value=>convert(value,true)};
    }

    let root,tasks;
    if(bundleStage.test(stage)) {
      // Bind the codec to the exact wire request above, while reading claims
      // from the task's restored scope rather than a referenced superset.
      const bundleRequest=Object.hasOwn(request,'shared_input_projections')?restoreReviewSources(request):request;
      if(!Array.isArray(bundleRequest.tasks)||!plain(bundleRequest.shared_inputs))return null;
      const definitions=new Map();
      for(const task of bundleRequest.tasks) {
        if(!plain(task)||!exact(Object.keys(task),['id','stage','instructions','input','shared_input_keys'])||
          typeof task.stage!=='string'||!reviewer.test(task.stage)||typeof task.id!=='string'||definitions.has(task.id)||
          !plain(task.input)||!plain(task.shared_input_keys))unsupported();
        const data={...task.input};
        for(const [key,reference]of Object.entries(task.shared_input_keys)) {
          if(Object.hasOwn(data,key)||typeof reference!=='string'||!Object.hasOwn(bundleRequest.shared_inputs,reference))unsupported();
          data[key]=bundleRequest.shared_inputs[reference];
        }
        definitions.set(task.id,data);
      }
      const keys=Object.keys(logicalSchema.properties);
      if(definitions.size!==keys.length||keys.some(key=>!definitions.has(key)))return null;
      tasks=new Map(keys.map(key=>[key,review(logicalSchema.properties[key],definitions.get(key),'o.'+key)]));
      root={schema:object(Object.fromEntries([...tasks].map(([key,codec])=>[key,codec.schema]))),
        encode:value=>Object.fromEntries([...tasks].map(([key,codec])=>[key,codec.encode(value[key])])),
        hydrate:value=>Object.fromEntries([...tasks].map(([key,codec])=>[key,codec.hydrate(value[key])]))};
    } else root=review(logicalSchema,request,'o');
    if(!auditCount)return null;
    const wireSchema=object({b:{type:'string',enum:[binding]},o:structuredClone(root.schema)}),privateSchema=structuredClone(wireSchema);
    const usePartial=partial&&/^(?:final_review_bundle|card_review_bundle)(?:_|$)/u.test(stage);
    const instruction='\n검토 출력 전송 형식: 원래 심사 항목·기준을 유지하며 output_schema의 키를 사용하세요. b는 지정된 현재 요청값, o는 검토 결과입니다. p=approved, i=issues, a=audits, m=improvements, issue의 f=field/r=reason/x=repair입니다. a는 output_schema에 지정된 a0/a1 등의 모든 슬롯을 가진 객체이며 각 슬롯의 r은 구체적인 모델의 이유입니다. 아래 a표의 각 행은 [출력위치,원래claim ID,v표번호,코드접두사]입니다. 해당 v표에서 선택한 판정의 0/1/2/3 인덱스를 j라 하면 그 슬롯의 v는 코드접두사+"."+j입니다. 코드접두사는 표에 적힌 문자열 그대로 쓰고 슬롯 이름이나 v표번호로 대신하지 마세요. 각 슬롯은 자기 output_schema.enum과 이 식에 맞는 전용 코드만 쓰며 슬롯 교환·중복·누락·다른 슬롯 코드는 금지합니다. 통과·가설·미확인·반려 모두 구체적 이유를 직접 작성하세요. 원문·현재 후보를 대조한 이유와 수정 지시는 가능하면 짧게 쓰되 의미·조건·주체·부정·시점을 보존하세요. p와 i를 모두 명시하고 실제 반려·수정 요청을 생략하지 마세요. 다른 검토의 승인을 근거로 쓰거나 정해진 통과 문구로 대신하지 마세요. 서버는 ID·키·판정 표현만 복원하며 이유나 승인을 만들지 않습니다. 대응표: '+JSON.stringify({v:verdictTables,a:mappings});
    return {schema:wireSchema,instruction,
      encode(logical){
        try {jsonData(logical);} catch {fail();}
        validateSchema(logical,logicalSchema,'output',true);
        const result={b:binding,o:root.encode(logical)};
        validateSchema(result,privateSchema,'output',true);return result;
      },
      hydrate(wire){
        try {jsonData(wire);} catch {fail();}
        if(usePartial) {
          if(!plain(wire)||!exact(Object.keys(wire),['b','o'])||wire.b!==binding||!plain(wire.o)||
            Object.keys(wire.o).some(key=>!tasks.has(key)))fail();
          const result={};
          for(const [key,codec]of tasks) {
            if(!Object.hasOwn(wire.o,key))continue;
            try {
              validateSchema(wire.o[key],codec.schema,'output',true);
              const logical=codec.hydrate(wire.o[key]);validateSchema(logical,logicalSchema.properties[key],'output',true);
              result[key]=logical;
            } catch(error) {
              if(!(error instanceof HttpError)||error.code!=='MODEL_INVALID_RESPONSE')throw error;
              result[key]=undefined;
            }
          }
          return result;
        }
        validateSchema(wire,privateSchema,'output',true);
        const result=root.hydrate(wire.o);validateSchema(result,logicalSchema,'output',true);return result;
      }};
  } catch(error) {if(error instanceof TypeError)return null;throw error;}
}
