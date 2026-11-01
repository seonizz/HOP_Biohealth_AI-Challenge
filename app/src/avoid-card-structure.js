// Display labels belong to the serializer. Model-authored values contain one
// role each; a failed bundle must be rewritten, never split or deduplicated here.
const displayLabel=/(?:^|\s)(?:피할\s*말\s*[·/]\s*행동|이유|대신)\s*[:：]/u;
const normalized=text=>text.normalize('NFKC').replace(/\s+/gu,' ').trim();
const repair='avoid_phrase에는 피할 말·행동만, reason에는 이유만, alternative에는 대안만 작성하세요. 각 값에 피할 말·행동:, 이유:, 대신: 같은 표시 라벨이나 전체 묶음을 넣지 마세요. 원문의 의미와 근거는 보존하면서 중복 설명을 다시 작성하고, 같은 항목을 반복하지 마세요.';

export function avoidPartsProblem(parts) {
  for(const [field,text] of Object.entries(parts))if(displayLabel.test(text))return {field,
    reason:'역할별 값 안에 이미 표시용 라벨이나 다른 역할의 설명 묶음이 들어 있습니다.'};
  const entries=Object.entries(parts);
  for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++)if(normalized(entries[i][1])===normalized(entries[j][1]))return {
    field:entries[j][0],reason:'서로 다른 역할에 같은 설명을 중복 작성했습니다.'};
  return null;
}

// Read a validated bundle without rewriting its model-authored wording.
export function parseAvoidCardItem(text) {
  const match=text.trim().match(/^피할 말·행동:\s*([\s\S]+?)\s+이유:\s*([\s\S]+?)\s+대신(?:\s*:\s*|\s+)([\s\S]+)$/u);
  if(!match||match.slice(1).some(part=>!part.trim()))return null;
  const parts=Object.fromEntries(['avoid_phrase','reason','alternative'].map((field,index)=>[field,match[index+1]]));
  return avoidPartsProblem(parts)?null:parts;
}

export function avoidCardStructureIssue(items,{requireBundle=false}={}) {
  const seen=new Set();
  for(const text of items) {
    const key=normalized(text);
    if(seen.has(key))return {field:'avoid',reason:'피할 말·행동 카드에 같은 항목이 중복됐습니다.',repair};
    seen.add(key);
    // Legacy unstructured seeds still receive the existing semantic review.
    // Any labelled bundle, including a later quality rewrite, must be atomic.
    if(!requireBundle&&!displayLabel.test(text))continue;
    const match=text.trim().match(/^피할 말·행동:\s*([\s\S]+?)\s+이유:\s*([\s\S]+?)\s+대신(?:\s*:\s*|\s+)([\s\S]+)$/u);
    if(!match||match.slice(1).some(part=>!part.trim()))return {field:'avoid',
      reason:'피할 말·행동과 이유, 실제 대안이 한 항목 안에 완결된 묶음으로 구분되지 않았습니다.',repair};
    const problem=avoidPartsProblem(Object.fromEntries(['avoid_phrase','reason','alternative'].map((field,index)=>[field,match[index+1]])));
    if(problem)return {field:'avoid',reason:problem.reason,repair};
  }
  return null;
}

export const avoidPartsRepair=repair;
