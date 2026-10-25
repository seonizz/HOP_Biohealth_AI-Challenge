// Restrict new claims, without editing a rejected answer into an approved one.
// Facts, names, unknowns, questions and their original validation stay intact.
export function literalStateRepairSchema(schema,{combined=false}={}) {
  const result=structuredClone(schema);
  const state=combined?result.properties.state:result;
  const memory=state.properties.relationship_memory.properties;
  for(const subject of ['patient','supporter']) {
    const items=memory[subject].items;
    if(items.anyOf)memory[subject].items=items.anyOf.find(branch=>branch.properties.certainty.enum.includes('reported'));
  }
  memory.relationship.maxItems=0;
  return result;
}

export const literalStateRepairInstruction=({combined=false}={})=>'\n이번 STATE 재시도에서는 관계 가설을 만들지 마세요. '+
  (combined?'state.':'')+'relationship_memory.relationship는 []이고 patient/supporter는 원문 evidence와 certainty=reported만 작성합니다. interpretation을 쓰거나 이전 가설을 사실로 바꾸지 마세요.';
