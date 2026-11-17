// Sparse, source-grounded case detail belongs to final card creation. The
// ordinary relationship/UI schema and question-turn memory stay unchanged.
export const CARD_CASE_VERSION='card-case-v1';
export const CARD_CASE_DIMENSIONS=['situation','behavior','emotion','relationship','change'];
const string=maxLength=>({type:'string',minLength:1,maxLength});
const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const reference=object({subject:{type:'string',enum:['patient','supporter','user_goal']},question_id:string(80),quote:string(1000)});
export const cardCaseFormulationSchema=object({findings:{type:'array',maxItems:8,items:object({
  dimension:{type:'string',enum:CARD_CASE_DIMENSIONS},
  actor:{type:'string',enum:['patient','supporter','other','unclear']},
  source_kind:{type:'string',enum:['reported_observation','reported_speech','user_interpretation','model_hypothesis']},
  interpretation:string(400),
  time_scope:{type:'string',enum:['current','past','change','unclear']},
  certainty:{type:'string',enum:['reported','tentative']},
  evidence:{type:'array',minItems:1,maxItems:3,items:reference},
})}});

export function cardCaseClaims(formulation) {
  return (formulation?.findings||[]).map((item,index)=>({
    id:'case.'+index,
    // Attribution and time are part of the claim, not unaudited metadata.
    claim:JSON.stringify({dimension:item.dimension,actor:item.actor,source_kind:item.source_kind,
      time_scope:item.time_scope,interpretation:item.interpretation}),
    certainty:item.certainty,evidence:structuredClone(item.evidence),
  }));
}

// Called only after the independent analysis gate approves every case claim.
// No absent dimension is filled from a model guess or a skipped question.
export function reviewedCardCase(formulation) {
  const findings=structuredClone(formulation.findings).map((item,index)=>({id:'case.'+index,...item}));
  return {version:CARD_CASE_VERSION,reviewed:true,findings,
    coverage:Object.fromEntries(CARD_CASE_DIMENSIONS.map(dimension=>{
      const rows=findings.filter(item=>item.dimension===dimension);
      return [dimension,{status:rows.length?'source_linked':'unknown',finding_ids:rows.map(item=>item.id)}];
    }))};
}
