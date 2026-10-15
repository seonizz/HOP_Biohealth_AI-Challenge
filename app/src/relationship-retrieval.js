import { createHash } from 'node:crypto';
import { answerComponents } from './answer-sources.js';

// A fresh, conversation-local index: never index generated memories or other sessions.
const key=row=>JSON.stringify([row.subject,row.question_id]);
const terms=text=>{
  const words=String(text||'').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[];
  return new Set(words.flatMap(word=>[word,...Array.from({length:Math.max(0,word.length-1)},(_,i)=>word.slice(i,i+2))]));
};
const riskPattern=/자해|자살|죽|해치|위협|폭력|위험|안전|suicid|self.harm|kill|danger/iu;
const lanes=[
  ['patient','요즘 보이는 모습 상태 변화 수면 식사 밤 학교 일상 행동 상황 설명'],
  ['patient','가장 걱정 마음 걸리는 부분 반복 확인 장면'],
  ['patient','힘이 되어 주는 사람 관계 활동 지지 친구 자원 편안'],
  ['patient','도움 받는 데 어려웠던 점 장벽 부담 거절 시간 시선'],
  ['supporter','감정 마음 부담 무력 걱정 잠 갈등 변화 한계'],
  ['supporter','해 봤던 방법 도움이 된 것 그렇지 않았던 것 대처 나누거나 기댈 지원'],
  [null,'관계 대화 반응 동의 시도 확인 반복 효과'],
];

export function sourceDocuments(context) {
  const fields=['patient','supporter'].flatMap(subject=>Object.values(context[subject]?.fields||{}).map(field=>({subject,field})));
  for(const field of Object.values(context.user_goal||{})) if(field?.id) fields.push({subject:'user_goal',field});
  return fields.filter(({field})=>field.status==='answered').flatMap(({subject,field})=>answerComponents(field).map(component=>({
    source_id:createHash('sha256').update(JSON.stringify([subject,field.id,component])).digest('hex').slice(0,24),
    subject,question_id:field.id,...component,question:component.question||field.question||field.id,
  })));
}

export function retrieveSources(context,{stage='state',query='',limitPerQuery=2,required=[]}={}) {
  const documents=sourceDocuments(context);
  const indexed=documents.map(document=>({document,tokens:terms(document.question+' '+document.text)}));
  const frequencies=new Map();
  for(const {tokens} of indexed) for(const token of tokens) frequencies.set(token,(frequencies.get(token)||0)+1);
  const selected=new Map();
  const add=(document,reason)=>{
    const entry=selected.get(document.source_id)||{...document,retrieved_for:[]};
    if(!entry.retrieved_for.includes(reason))entry.retrieved_for.push(reason);
    selected.set(document.source_id,entry);
  };
  const requiredKeys=new Set(required.map(key));
  for(const document of documents) {
    if(documents.length<=12)add(document,'short_conversation');
    if(document.subject==='user_goal'||['name','rel'].includes(document.question_id))add(document,'identity_and_goal');
    if(key(document)===key(context.latest_answer||{}))add(document,'latest_answer');
    if(requiredKeys.has(key(document)))add(document,'cited_source');
    // Include the ENTIRE answer, including denials, time and attribution. This is
    // a recall guard, not a danger classifier: a matching word never means urgent.
    if(riskPattern.test(document.text))add(document,'safety_context');
  }
  const goals=documents.filter(row=>row.subject==='user_goal').map(row=>row.text).join(' ');
  const queries=[...lanes,[null,[goals,query].join(' ')]];
  for(const [subject,text] of queries) {
    const queryTerms=terms(text);
    const ranked=indexed.filter(item=>item.document.subject!=='user_goal'&&
      !['name','rel'].includes(item.document.question_id)&&(!subject||item.document.subject===subject)).map(item=>({
      ...item,score:[...queryTerms].reduce((score,token)=>score+(item.tokens.has(token)?Math.log(1+documents.length/(frequencies.get(token)||1)):0),0)/(1+Math.log(1+item.tokens.size)),
    })).sort((a,b)=>b.score-a.score||a.document.source_id.localeCompare(b.document.source_id));
    // Retrieve question groups so custom text and selected options retain context.
    const selectedKeys=new Set();
    for(const item of ranked) {
      if(item.score<=0)break;
      selectedKeys.add(key(item.document));
      if(selectedKeys.size>=Math.max(1,Math.min(6,limitPerQuery)))break;
    }
    for(const {document} of ranked)if(selectedKeys.has(key(document)))add(document,subject||'relationship_and_goal');
  }
  const groupKeys=new Set([...selected.values()].map(key));
  for(const document of documents)if(groupKeys.has(key(document))&&!selected.has(document.source_id))add(document,'answer_context');
  return {method:'conversation_lexical_v1',stage,indexed_sources:documents.length,
    documents:[...selected.values()],unanswered:['patient','supporter'].flatMap(subject=>
      Object.values(context[subject]?.fields||{}).filter(field=>field.status!=='answered').map(field=>({subject,question_id:field.id,status:field.status}))),
  };
}

export function retrievedContext(context,retrieval) {
  const keys=new Set(retrieval.documents.map(key));
  const result={...context};
  for(const subject of ['patient','supporter'])result[subject]={...context[subject],fields:Object.fromEntries(
    Object.entries(context[subject]?.fields||{}).filter(([,field])=>keys.has(key({subject,question_id:field.id}))))};
  return result;
}

export function citedSources(value) {
  const refs=[];
  const visit=node=>{
    if(!node||typeof node!=='object')return;
    if(typeof node.subject==='string'&&typeof node.question_id==='string'&&typeof node.quote==='string')refs.push(node);
    for(const child of Object.values(node))visit(child);
  };
  visit(value);return refs;
}

export function citationsRetrieved(value,retrieval) {
  return citedSources(value).every(ref=>retrieval.documents.some(document=>
    document.subject===ref.subject&&document.question_id===ref.question_id&&document.text.includes(ref.quote)));
}
