// ── 대화 흐름: 질문 → 답 → 후속 질문 → 마무리(모델 분석·가이드 생성·기록 저장) ──
// 프론트는 답을 계산하지 않고 원래 답과 흐름 태그만 모아요. 맥락 추출·수치화는 Model(mockModel.js)이 맡아요.
let S; // 현재 대화 상태
// {name} → 호칭, {name:은} → 호칭 + 받침에 맞는 조사
const nm=t=>t.replace(/\{name(?::([^}]+))?\}/g,(_,j)=>{const w=S?.name||"그분";return j?w+josa(w,j):w;});

const GAP_Q={type:"text",q:"말하는 방법을 정확히 맞추려면 {name:의} 요즘 모습을 조금 더 알아야 해요. 가장 마음에 걸리는 장면을 떠올려 적어 주세요.",ph:"예: 밥을 거의 안 먹고 잠만 자요"};
function gapCheck(){
  const g=[];
  // 보이는 모습을 하나도 고르거나 적지 않았고, 가장 걱정되는 부분(필수)도 비었을 때만 보충 질문
  if(!S.ans.mood?.sel.length&&!S.extraObs&&isThin(S.ans.concern?.text,1)) g.push(GAP_Q);
  return g;
}

// 위기 신호 안전장치: 모델이 응답하지 않거나 놓쳐도 결과 화면에 안전 카드가 뜨도록 프론트에서도 확인 (계산 없이 있는지만 봄)
const DANGER=/죽고\s?싶|사라지고\s?싶|없어지고\s?싶|자살|자해/;
function safetyFlag(){
  return Q.some(q=>{const a=S.ans[q.id];if(!a)return false;
    return a.sel.some(k=>optMeta(q.opts?.[k]).s==="suicidal")||DANGER.test(a.text)||DANGER.test(a.custom||"");})||DANGER.test(S.extraObs);
}

// 모델에 보낼 원래 답: 문항별 질문 문구, 고른 보기(라벨 + 메타), 직접 입력, 건너뜀 여부
function buildPayload(){
  const strip=({g,none,input,ph,...m})=>m; // 화면용 메타는 빼고 보냄
  const answers=Q.filter(q=>S.ans[q.id]).map(q=>{const a=S.ans[q.id];
    return {id:q.id,question:nm(q.rare&&RARE(S)?q.rare:q.q),type:q.type,freeText:!!q.cue,
      text:a.text,custom:a.custom||"",skipped:!!a.skipped,selected:a.sel.map(k=>({label:optLabel(q.opts[k]),meta:strip(optMeta(q.opts[k]))}))};});
  if(S.ans.gap_obs) answers.push({id:"gap_obs",question:nm(GAP_Q.q),type:"text",freeText:true,text:S.ans.gap_obs.text,custom:"",skipped:false,selected:[]});
  return {name:S.name,answers,tags:[...S.tags]};
}

// ── 이전 질문으로 (첫 질문까지 몇 번이든) ──
// 질문마다 보여 주기 직전 상태(답·흐름 태그·대화 기록)를 S.hist에 쌓아 두었다가 되돌릴 때 복원
function snapshot(){return {i:S.i,tags:[...S.tags],ans:JSON.parse(JSON.stringify(S.ans)),name:S.name,fuCount:S.fuCount,extraObs:S.extraObs,logLen:S.log.length,dom:ChatScreen.count()};}
function restore(s){
  Object.assign(S,{i:s.i,tags:new Set(s.tags),ans:s.ans,name:s.name,fuCount:s.fuCount,extraObs:s.extraObs});
  S.log.length=s.logLen;ChatScreen.truncate(s.dom);
}
function goBack(){if(S.hist.length<2)return;S.hist.pop();restore(S.hist.pop());ask();}
// 후속·보충 질문에서 뒤로: 방금 답한 본 질문을 다시 물음
function redo(){restore(S.hist.pop());ask();}

function begin(){
  S={ans:{},tags:new Set(),i:0,log:[],name:"",fuCount:0,extraObs:"",hist:[]};
  ChatScreen.clear();show("chat");
  ChatScreen.aiSay("안녕하세요, 말씨예요. 누군가에게 다가가려는 마음을 먹으셨군요.\n천천히 답해 주셔도 괜찮아요.","hello");
  setTimeout(ask,700);
}
// 응원: 7문항, 14문항에 답할 때마다 끝까지 함께하도록 북돋움 (답한 수 = 쌓인 질문 수 - 1, 뒤로 가면 기록과 함께 사라짐)
const CHEER={7:"벌써 3분의 1을 함께 왔어요. 들려주신 이야기 하나하나가 큰 도움이 돼요. 조금만 더 함께해 주세요.",14:"거의 다 왔어요! 이제 몇 가지만 더 여쭤볼게요. 끝까지 함께해 주셔서 고마워요."};
async function ask(){
  while(S.i<Q.length&&Q[S.i].when&&!Q[S.i].when(S))S.i++; // 조건에 맞지 않는 문항은 건너뜀
  if(S.i>=Q.length)return finish();
  S.hist.push(snapshot());
  const q=Q[S.i];ChatScreen.progress(S.i/Q.length*100);ChatScreen.section(nm(q.sec));ChatInput.clear();
  const cheer=CHEER[S.hist.length-1];if(cheer){await ChatScreen.typing("cheer",600);ChatScreen.aiSay(cheer,"cheer");}
  if(q.intro){await ChatScreen.typing(q.face,600);ChatScreen.aiSay(q.intro,q.face);}
  await ChatScreen.typing(q.face,600);ChatScreen.aiSay(q.rare&&RARE(S)?q.rare:q.q,q.face,q.why);
  const shown=typeof q.ph==="function"?{...q,ph:q.ph(S)}:q; // 답변 예시가 앞의 답에 따라 바뀌는 문항
  ChatInput.render(shown,answer,S.hist.length>1?goBack:null); // 첫 질문만 뒤로 가기 없음
}
// 후속 질문은 건너뛸 수 없고 빈 답도 받지 않음 (required)
async function followUp(f,face="ponder"){
  S.fuCount++;await ChatScreen.typing(face,700);ChatScreen.aiSay(f.q,face,"","",true);
  return new Promise(res=>ChatInput.render({...f,required:true},(text,sel,custom="")=>{ChatScreen.meSay(text);res({text,sel,custom});},redo));
}
async function answer(text,sel,custom="",skipped=false){
  const q=Q[S.i];ChatScreen.meSay(text);
  let a={text,sel,custom,skipped};
  // 후속 질문 (문항당 최대 1회, 건너뛴 문항은 다시 묻지 않음)
  const f=FOLLOW[q.id];
  if(f&&!skipped&&f.when(a)){const r=await followUp(f.q);a=f.merge(a,r);}
  S.ans[q.id]=a;
  if(q.id==="name") S.name=isThin(a.text,1)?"그분":a.text.slice(0,20);
  if(q.id==="mood"&&a.custom) S.extraObs=a.custom;
  // 흐름 태그만 모음 (점수·라벨 계산은 모델이 함)
  a.sel.forEach(k=>{const t=optMeta(q.opts[k]).t;if(t)S.tags.add(t);});
  // 위험 신호(suicidal)는 대화 중에 끊지 않고 결과 화면의 안전 카드로 안내
  S.i++;setTimeout(ask,400);
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function finish(){
  ChatScreen.progress(100);
  // 마무리 전 정보 충분성 점검
  for(const g of gapCheck()){const r=await followUp(g,"think");if(!isThin(r.text,1)){S.extraObs=r.text;S.ans.gap_obs={text:r.text,sel:[]};}}
  await ChatScreen.typing("ponder",900);
  ChatScreen.aiSay("고마워요. 들려주신 이야기를 바탕으로 말하는 방법을 정리해 볼게요.","thanks");
  await wait(500);ChatInput.clear();ChatScreen.think(true);
  analyze();
}
// 모델 1(맥락 추출) → 모델 2(수치화) → 가이드. 로딩 카드의 단계를 실제 처리에 맞춰 넘기고, 실패하면 다시 시도
async function analyze(){
  const mine=S,gone=()=>S!==mine||$("chat").hidden; // 기다리는 사이 처음으로 나갔거나 새 대화를 시작했으면 결과를 띄우지 않음
  const step=async(i,job)=>{ChatScreen.thinkStep(i);const [r]=await Promise.all([job(),wait(900)]);return r;}; // 단계마다 최소 0.9초는 보여 줌
  let p,g;
  try{
    const payload=buildPayload();
    const ctx=await step(0,()=>Model.extractContext(payload));if(gone())return;
    const scores=await step(1,()=>Model.scoreAnswers(payload,ctx));if(gone())return;
    const A=S.ans,val=k=>{const t=A[k]?.text;return t&&!t.startsWith("(")?t:undefined;}; // 건너뛴 답은 비움
    p={name:S.name,rel:val("rel"),contact:val("contact"),obs:S.extraObs,concern:val("concern"),moment:val("moment"),feeling:val("feeling"),want:val("want"),
      scores,safety:!!ctx.safety||safetyFlag(),symptoms:ctx.symptoms,risks:ctx.risks,protect:ctx.protect,tags:[...S.tags],
      answers:Object.fromEntries(Object.entries(A).map(([k,v])=>[k,v.text]))};
    g=await step(2,()=>Model.guide(p));if(gone())return;
  }catch(e){if(!gone())ChatScreen.thinkError(()=>{ChatScreen.think(true);analyze();});return;}
  ChatScreen.thinkStep(3);
  const rec={id:Date.now(),title:S.name||"그분",date:new Date().toISOString(),profile:p,guide:g,log:S.log,followUps:S.fuCount};
  const all=loadRecs();all.unshift(rec);const ok=saveRecs(all);
  await wait(500);if(gone())return;
  ChatScreen.think(false);ResultScreen.open(p,g,ok);
}
