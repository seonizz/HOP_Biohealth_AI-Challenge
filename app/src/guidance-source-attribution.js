import {normalizeAnswerContext} from './answer-sources.js';
import {sourceDocuments} from './relationship-retrieval.js';

const escape=text=>text.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
const compact=text=>String(text||'').normalize('NFKC').replace(/\s+/gu,'');
const topicOf=text=>compact(text).replace(/^[“"'‘「]+|[”"'’」]+$/gu,'').replace(/(?:에게|한테|에서|을|를|은|는|이|가|도|만|에)$/u,'');
const actionRoot=action=>action.replace(/고$/u,'');
const roleAdverb='(?:직접|본인이|스스로|정말|꼭|많이|조금|함께|같이|(?:지금|현재|이제)(?:은|는)?)';
const roleAdverbs=roleAdverb+'*';
const quoted=String.raw`(?:“([^”\n]+)”|"([^"\n]+)"|‘([^’\n]+)’|'([^'\n]+)'|「([^」\n]+)」)`;
const reportVerb=/(?:라고|다고)(?:직접)?(?:말했|말하셨|말한|말씀했|말씀하셨|했|하셨)|(?:원한|싶|필요하|필요로한)대요|요청했|부탁했/u;
const desire=/원하|원한|희망하|희망한|필요하|필요로하|필요로한|싶|해달|해주세요|요청|부탁/u;
const withdrawal=/원하지(?:는|도)?않|원치않|바라지(?:는|도)?않|희망하지(?:는|도)?않|필요(?:가)?없|필요하지(?:는|도)?않|싶지(?:는|도)?않|말한적(?:은|이|도)?없|요청한적(?:은|이|도)?없|요청하지(?:는|도)?않|말하지(?:는|도)?않|말한것은아니|원한것은아니|철회|취소|거절/u;
const attributionCorrection=/(?:그건|그것은|그도움은)(?:제|저의|내|나의)생각|(?:제|저의|내|나의)생각일뿐|제가필요하다고생각한것|본인(?:이|의)(?:원한것|요청|희망)(?:은|이)?아니/u;
const informantOpinion=/(?:제가|저는|나는|내가).{0,60}생각|(?:제|저의|내|나의)생각|(?:원하는지|원한다고말했는지|요청했는지)(?:는|도)?모르/u;
const hypothetical=/만약|가정|예를들|예시|원할것같|싶어할것같|추측/u;
const historical=/예전|과거|당시|전에는/u;
const clauses=text=>String(text||'').normalize('NFKC').split(/[.!?。！？\n,，;]|하지만|그러나|그런데|반면|다만|그리고|지만/u)
  .map(compact).filter(Boolean);

function targetPatterns(context) {
  const alias=context?.name_index?.alias||context?.patient?.alias;
  const names=[...new Set(['대상자','상대방','그분',...(typeof alias==='string'&&alias.trim()?[alias.trim()]:[])])];
  // Source matching removes spacing and uses NFKC. Keep one target pattern
  // valid for both that representation and the original spaced guide text.
  const target='(?:'+names.map(name=>escape(name.normalize('NFKC')).replace(/\s+/gu,'\\s*')).join('|')+')';
  return {target,subject:target+'(?:이)?(?:가|는|은|이)'};
}

function estimateQuestion(question,{target}) {
  // Match the saved question's meaning, never a question ID. A customized
  // "need" question about the patient's own request must not inherit this role.
  return new RegExp('^(?:현재)?'+target+'(?:에게|한테)(?:가장)?필요하다고생각하는도움은무엇인가요[?？]?$','u')
    .test(compact(question));
}

function requestQuestion(question,{subject}) {
  const text=compact(question);
  return new RegExp('^'+subject+'(?:직접)?(?:원한다고말한|원한다고한|요청한|희망한|원하는)(?:도움|지원|것)(?:은|이)?(?:무엇|뭔|어떤)','u').test(text)||
    new RegExp('^'+subject+'(?:직접)?어떤(?:도움|지원)(?:을|를)?(?:원한다고말|요청|원하)','u').test(text);
}

function removeDiscouragedQuotes(text) {
  return String(text||'').replace(new RegExp(quoted+String.raw`(?=(?:라는|는|와같은|과같은)?\s*(?:조건|표현|말)?[^.!?。！？\n]{0,25}(?:피하|하지|말고|보다는|대신))`,'gu'),'');
}

function assertions(text,patterns) {
  const cleaned=removeDiscouragedQuotes(text.normalize('NFKC')),found=[];
  const boundary=String.raw`(?:^|[\s:：,，;“"'‘「(])`;
  const content=String.raw`([^.!?。！？\n:：,，;“”"'‘’「」]{1,75}?)`;
  const reported=new RegExp(boundary+patterns.subject+String.raw`\s*(?:직접\s*)?`+content+
    String.raw`\s*(?:필요로\s*한다고|필요하다고|원한다고|희망한다고|요청했다고)\s*(?:직접\s*)?(?:말했|말하셨|말한|말씀했|말씀하셨|했|하셨)`,'gu');
  const actions=String.raw`(줄이고|늘리고|받아보고|받고|하고|쉬고|있고|가고|다니고|지내고|나누고)`;
  const wish=new RegExp(String.raw`(?:^|[:：.!?。！？\n,，;“"'‘「])\s*`+content+String.raw`\s*`+actions+
    String.raw`\s*싶어\s*(?:하는|하시는|한다는)\s*`+patterns.target+String.raw`(?:이)?`,'gu');
  for(const [pattern,action] of [[reported,false],[wish,true]])for(const match of cleaned.matchAll(pattern)) {
    const topic=topicOf(match[1]);
    if(topic.length<2)continue;
    const before=cleaned.slice(0,match.index).split(/[.!?。！？\n]/u).at(-1);
    const after=cleaned.slice(match.index+match[0].length);
    // Open/conditional proposals and explicit denials are not asserted wishes.
    if(/만약/u.test(before)||/^\s*(?:적(?:은|이|도)?\s*없|것은\s*아니|(?:가|는|이)?\s*(?:있)?(?:다면|라면|이라면)|는지|을지|다고\s*(?:단정|말|생각|가정)하지|\?)/u.test(after))continue;
    found.push({topic,action:action?actionRoot(match[2]):null,text:match[0].trim()});
  }
  return found;
}

function mentionsHelp(document,assertion) {
  return compact(document.text).includes(assertion.topic);
}

function helpSpeaker(sentence,assertion,patterns) {
  const index=sentence.indexOf(assertion.topic);
  if(index<0)return 'implicit';
  const before=sentence.slice(0,index);
  const target=new RegExp(patterns.subject+roleAdverbs+'[“"\'‘「]?(?:저는|나는|제가|내가)?$','u');
  if(target.test(before))return 'target';
  if(new RegExp('(?:제가|저는|나는|내가|저희는|우리는|(?:[가-힣A-Za-z]+)(?:가|는|은|이))'+roleAdverbs+'[“"\'‘「]?$','u').test(before))return 'other';
  return 'implicit';
}

function otherSpeakerAfterHelp(sentence,assertion,patterns) {
  const index=sentence.indexOf(assertion.topic);
  if(index<0)return false;
  const after=sentence.slice(index+assertion.topic.length);
  const desireIndex=after.search(desire);
  if(desireIndex<0)return false;
  const actor=after.slice(0,desireIndex).replace(/^(?:을|를|은|는|이|가|에)/u,'')
    .replace(new RegExp(roleAdverb,'gu'),'');
  // A named patient can be the reporter of someone else's request. Having the
  // patient and help in the same sentence does not make that inner speaker them.
  return /(?:가|는|은|이)$/u.test(actor)&&!new RegExp('^'+patterns.subject+'$','u').test(actor);
}

function explicitReport(document,assertion,patterns) {
  if(!mentionsHelp(document,assertion))return false;
  const topic=escape(assertion.topic);
  const hasAction=part=>!assertion.action||new RegExp(topic+'.{0,20}'+escape(assertion.action),'u').test(part);
  // Bound the permission to this help and this patient's speech. Another
  // person's request, or the informant speaking TO the patient, is insufficient.
  for(const sentence of clauses(document.text).filter(part=>part.includes(assertion.topic))) {
    if(withdrawal.test(sentence)||attributionCorrection.test(sentence)||informantOpinion.test(sentence)||hypothetical.test(sentence)||
      historical.test(sentence)&&!/(?:지금도|현재도|여전히)/u.test(sentence)||!hasAction(sentence))continue;
    if(helpSpeaker(sentence,assertion,patterns)==='other'||otherSpeakerAfterHelp(sentence,assertion,patterns))continue;
    if(requestQuestion(document.question,patterns))return true;
    const direct=new RegExp(patterns.subject+roleAdverbs+'[“"\'‘「]?(?:저는|나는|제가|내가)?'+topic,'u');
    if(direct.test(sentence)&&desire.test(sentence)&&reportVerb.test(sentence)&&hasAction(sentence))return true;
    for(const quote of sentence.matchAll(new RegExp(quoted,'gu'))) {
      const utterance=quote.slice(1).find(Boolean),after=sentence.slice(quote.index+quote[0].length);
      if(utterance.includes(assertion.topic)&&desire.test(utterance)&&hasAction(utterance)&&
        new RegExp('^(?:이)?라고'+patterns.subject+'(?:직접)?(?:말했|말하셨|말씀했|말씀하셨)','u').test(after))return true;
    }
  }
  return false;
}

function requestVerdict(document,assertion,patterns,earlierRequest=false) {
  const followReference=document.origin==='follow_up'&&earlierRequest&&
    (requestQuestion(document.question,patterns)||/(?:그|이)(?:요청|도움|희망)/u.test(compact(document.question)));
  let verdict=0,targetReference=false;
  for(const sentence of clauses(document.text)) {
    const related=sentence.includes(assertion.topic);
    if(related&&(helpSpeaker(sentence,assertion,patterns)==='other'||otherSpeakerAfterHelp(sentence,assertion,patterns))) {
      targetReference=false;continue;
    }
    const explicit=related&&helpSpeaker(sentence,assertion,patterns)==='target';
    const implicit=related&&(requestQuestion(document.question,patterns)||targetReference||followReference);
    const pointsBack=/(?:그|이)(?:요청|도움|희망)/u.test(sentence)&&(targetReference||followReference);
    const shortWithdrawal=followReference&&/^(?:지금|현재|이제)(?:은|는)?/u.test(sentence)&&withdrawal.test(sentence);
    const correction=attributionCorrection.test(sentence)&&(targetReference||document.origin==='follow_up'&&earlierRequest);
    const directNo=followReference&&/^(?:아니요|아닙니다|아니에요)$/u.test(sentence);
    if(correction||directNo||shortWithdrawal||(explicit||implicit||pointsBack)&&withdrawal.test(sentence)) {
      verdict=-1;targetReference=true;continue;
    }
    if(explicitReport({...document,text:sentence},assertion,patterns)) {
      verdict=1;targetReference=true;
    } else if(!related&&!/(?:그|이)(?:요청|도움|희망)/u.test(sentence)&&
      /요청|원하|원한|희망|싶/u.test(sentence)) {
      // A subsequent request for another help changes the local antecedent of
      // "that request"; do not attach its withdrawal to the earlier target.
      targetReference=false;
    }
  }
  return verdict;
}

function hasMatchingRequest(documents,assertion,patterns) {
  const groups=new Map();
  for(const document of documents) {
    const key=JSON.stringify([document.subject,document.question_id]);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(document);
  }
  let supported=false,contradicted=false;
  for(const rows of groups.values()) {
    if(!rows.some(document=>mentionsHelp(document,assertion)))continue;
    const original=rows.filter(row=>row.origin==='answer_snapshot').map(row=>requestVerdict(row,assertion,patterns)).filter(Boolean);
    // A same-field follow-up supersedes the earlier assertion when it actually
    // addresses this help or explicitly corrects who made the request.
    const follow=rows.filter(row=>row.origin==='follow_up').map(row=>requestVerdict(row,assertion,patterns,original.includes(1))).filter(Boolean);
    const current=follow.length?follow:original;
    if(current.includes(-1))contradicted=true;
    else if(current.includes(1))supported=true;
  }
  // Conflicting reports cannot supply a mechanical exception; ordinary
  // independent review still decides how to express the remaining uncertainty.
  return supported&&!contradicted;
}

export function sourceAttributionIssues(guide,context) {
  if(!context)return [];
  const normalized=normalizeAnswerContext(context),patterns=targetPatterns(normalized);
  // Reuse canonical component identities and original question/follow-up roles.
  // Generated memory and selected labels without a saved answer are not sources.
  const documents=sourceDocuments(normalized);
  const estimates=documents.filter(document=>estimateQuestion(document.question,patterns));
  if(!estimates.length)return [];
  const texts={script:[guide.script],doList:guide.doList||[],next:[guide.next],care:[guide.care?.feel,...(guide.care?.tips||[])],
    avoid:(guide.avoid||[]).map(text=>String(text).split(/대신|대안[:：]?|보다는/u).slice(1).at(-1)||'')};
  const issues=[];
  for(const [field,items] of Object.entries(texts)) {
    const rejected=items.flatMap(text=>assertions(String(text||''),patterns)).filter(assertion=>
      estimates.some(document=>mentionsHelp(document,assertion))&&!hasMatchingRequest(documents,assertion,patterns));
    if(rejected.length)issues.push({field,
      reason:'이용자가 필요하다고 생각한 도움을 대상자가 직접 원하거나 말했다는 사실로 바꾸었습니다.',
      repair:'현재 질문과 원문·후속 답변의 화자를 대조하세요. 같은 도움에 대한 대상자의 실제 요청 근거가 없다면, 이용자의 판단임을 밝히거나 원하는지 열린 질문으로 확인하는 제안으로 고치세요. 대상자의 희망을 사실로 보충하지 마세요. 문제 전제: '+
        [...new Set(rejected.map(item=>item.text))].slice(0,3).join(' / ')});
  }
  return issues;
}
