import {createFinalEvidenceReferenceCodec,createFinalStageEvidenceReferenceCodec} from './final-evidence-references.js';
import {validateSchema} from './relationship-agent.js';

const stages=new Set(['relationship_analysis','analysis_repair','analysis_repair_after_guide_review']);
const keywords=new Set(['type','properties','required','additionalProperties','items','enum','const',
  'maxItems','minItems','minLength','maxLength','description']);
const instruction='\n최종 분석 출력 형식: evidence_sources.locations에 나열된 위치만 근거 객체 대신 해당 위치 output_schema.enum의 ID 문자열을 반환하세요. observations.patient/supporter의 각 항목과 relationship의 evidence 각 항목도 이 규칙을 따릅니다. evidence_sources.sources는 ID와 원래 subject·question_id·quote 전체 객체의 대응표입니다. 같은 원문 객체는 같은 ID지만 각 위치의 허용 ID 목록은 별개입니다. 다른 위치의 허용 목록을 합치거나 ID·원문을 만들거나 바꾸지 마세요. 대응표에 없는 위치와 safety.evidence_ids는 기존 output_schema를 그대로 따르세요. 전체 원문과 문맥으로 근거가 주장을 뒷받침하는지 판단하세요. 서버는 정확한 객체로 복원한 뒤 원래 스키마·근거·의미 검증과 독립 검토를 모두 수행합니다.';
const extendedInstruction='\n전략·발화 상세의 근거 출력 형식: evidence_sources.locations에 나열된 위치만 근거 객체 대신 해당 위치 output_schema.enum의 ID 문자열을 반환하세요. evidence_sources.sources는 ID와 원래 subject·question_id·quote 전체 객체의 대응표입니다. 각 위치의 허용 ID 목록을 지키며 다른 위치의 목록을 합치거나 ID·인용문을 만들거나 바꾸지 마세요. 이전 출력의 ID라도 현재 위치의 허용 목록에 없으면 사용하지 마세요. 나머지 필드·why·발화 구간 경계는 기존 output_schema를 따르며 서버가 대신 생성하지 않습니다. 전체 원문·문맥으로 근거의 적합성을 판단하세요. 서버는 정확한 객체로 복원한 뒤 기존 전체 스키마·근거·의미 검증과 독립 검토를 모두 수행합니다.';

function transportFor(codec,originalSchema,locations,instruction) {
  const wireSchema=structuredClone(codec.schema),logicalSchema=structuredClone(originalSchema);
  return {schema:codec.schema,table:{sources:Object.entries(codec.references).map(([id,evidence])=>({id,evidence})),locations},instruction,
    decode(value){
      validateSchema(value,wireSchema,'output',true);
      const result=codec.hydrate(value);
      validateSchema(result,logicalSchema,'output',true);
      return result;
    }};
}

// Narrow adapter around the existing five-path codec. Unsupported schemas use
// the original representation; no pool is invented or narrowed to fit transport.
export function finalEvidenceTransport(stage,originalSchema,{extended=false,registry}={}) {
  if(stage==='final_analysis_plan_draft'&&extended) {
    const keys=Object.keys(originalSchema.properties||{});
    if(originalSchema.type!=='object'||originalSchema.additionalProperties!==false||keys.length!==2||
      !keys.includes('analysis')||!keys.includes('plan')||!Array.isArray(originalSchema.required)||
      originalSchema.required.length!==2||keys.some(key=>!originalSchema.required.includes(key)))return null;
    const ids=registry??new Map(),parts={
      analysis:finalEvidenceTransport('relationship_analysis',originalSchema.properties.analysis,{registry:ids}),
      plan:finalEvidenceTransport('communication_plan',originalSchema.properties.plan,{extended:true,registry:ids}),
    };
    if(!parts.analysis&&!parts.plan)return null;
    const schema=structuredClone(originalSchema),sources=new Map(),locations=[];
    for(const [key,part]of Object.entries(parts))if(part) {
      schema.properties[key]=part.schema;
      for(const source of part.table.sources)sources.set(source.id,source);
      locations.push(...part.table.locations.map(location=>({...location,
        schema_path:location.schema_path.replace(/^output_schema/u,'output_schema.properties.'+key)})));
    }
    const wire=structuredClone(schema),logical=structuredClone(originalSchema);
    return {schema,table:{sources:[...sources.values()],locations},instruction:extendedInstruction+
      '\n이번 복합 출력의 analysis와 plan 내부에서도 위치 대응표에 나열된 근거만 ID로 반환하세요. 다른 위치와 safety.evidence_ids는 기존 스키마 그대로입니다.',
      decode(value){
        validateSchema(value,wire,'output',true);
        const result=structuredClone(value);
        for(const [key,part]of Object.entries(parts))if(part)result[key]=part.decode(value[key]);
        validateSchema(result,logical,'output',true);return result;
      }};
  }
  const kind=extended&&/^communication_plan(?:_repair)?(?:_after_analysis_repair)?$/u.test(stage)?'plan':
    extended&&/^speech_detail(?:_repair)?$/u.test(stage)?'detail':null;
  if(!stages.has(stage)&&!kind)return null;
  const supported=node=>node&&typeof node==='object'&&!Array.isArray(node)&&Object.keys(node).every(key=>keywords.has(key))&&
    (!node.properties||Object.values(node.properties).every(supported))&&(!node.items||supported(node.items));
  if(!supported(originalSchema))return null;
  if(kind) {
    let codec;
    try { codec=createFinalStageEvidenceReferenceCodec(originalSchema,{kind,registry}); }
    catch(error){if(error instanceof TypeError)return null;throw error;}
    return transportFor(codec,originalSchema,codec.locations,extendedInstruction);
  }
  const paths=[['observations','patient'],['observations','supporter'],
    ['relationship','dynamics'],['relationship','strengths'],['relationship','boundaries']];
  const nodes=paths.map(([group,key])=>{
    const rows=originalSchema.properties?.[group]?.properties?.[key];
    return group==='observations'?rows?.items:rows?.items?.properties?.evidence?.items;
  });
  // The existing codec uses a private empty allowlist for an absent pool. That
  // is stricter than legacy schema semantics, so retain legacy behavior here.
  if(nodes.some(node=>!Array.isArray(node?.enum)||!node.enum.length))return null;
  let codec;
  try { codec=createFinalEvidenceReferenceCodec(originalSchema,{registry}); }
  catch(error){if(error instanceof TypeError)return null;throw error;}
  const locations=paths.map(([group,key])=>{
    const rows=codec.schema.properties[group].properties[key];
    const leaf=group==='observations'?rows.items:rows.items.properties.evidence.items;
    return {schema_path:`output_schema.properties.${group}.properties.${key}.items`+
      (group==='observations'?'':'.properties.evidence.items'),allowed_source_ids:[...leaf.enum]};
  });
  return transportFor(codec,originalSchema,locations,instruction);
}
