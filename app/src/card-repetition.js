// Reject only clear generation loops, not ordinary rhetorical repetition.
// This diagnostic never edits the candidate or turns it into approved text.
export function cardRepetition(field,value) {
  const texts=typeof value==='string'?[value]:Array.isArray(value)?value:
    field==='care'&&value?[value.feel,...(value.tips||[])]:[];
  const sentences=texts.filter(text=>typeof text==='string').flatMap(text=>
    text.split(/(?<=[.!?。！？])\s+|\n+/u).map(sentence=>sentence.trim()).filter(Boolean));
  const counts=new Map();let totalCharacters=0;
  for(const sentence of sentences){const length=Array.from(sentence).length;totalCharacters+=length;
    if(length>=12)counts.set(sentence,(counts.get(sentence)||0)+1);}
  const repeated=[...counts].filter(([,count])=>count>=8);
  const duplicateCharacters=repeated.reduce((sum,[sentence,count])=>sum+Array.from(sentence).length*(count-1),0);
  if(!repeated.length||!totalCharacters||duplicateCharacters/totalCharacters<0.5)return null;
  return {field,sentence_count:sentences.length,maximum_occurrences:Math.max(...repeated.map(([,count])=>count)),
    duplicate_fraction:duplicateCharacters/totalCharacters};
}

export function cardRepetitionIssue(field,value) {
  return cardRepetition(field,value)?{field,
    reason:'같은 문장이 과도하게 반복되는 생성 오류입니다.',
    repair:'반복된 이전 카드 문구를 복사하지 말고 answers의 원문과 plan에서 이 카드 하나를 새로 작성하세요. 필요한 내용은 한 번씩만 전달하고 사실·부정·시점·선택권·도움 범위는 보존하세요. 다른 카드나 사실을 새로 만들지 마세요.'}:null;
}
