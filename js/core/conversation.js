// ── 대화 흐름: 질문 → 답 → 후속 질문 → 마무리(가이드 생성·기록 저장) ──
let S; // 현재 대화 상태
// {name} → 호칭, {name:은} → 호칭 + 받침에 맞는 조사
const nm=t=>t.replace(/\{name(?::([^}]+))?\}/g,(_,j)=>{const w=S?.name||"그분";return j?w+josa(w,j):w;});

function gapCheck(){
  const g=[];
  // 가장 걱정되는 부분(concern)은 필수 문항이라, 그 답도 없을 때만 보충 질문
  if(S.d+S.a+S.x===0&&!S.extraObs&&isThin(S.ans.concern?.text,1)) g.push({id:"gap_obs",type:"text",q:"말하는 방법을 정확히 맞추려면 {name:의} 요즘 모습을 조금 더 알아야 해요. 가장 마음에 걸리는 장면을 떠올려 적어 주세요.",ph:"예: 밥을 거의 안 먹고 잠만 자요"});
  return g;
}
// 자유 서술에서 신호어를 찾아 점수와 라벨에 반영
function readCues(t){CUES.forEach(([re,k,v,s])=>{if(re.test(t)){if(k)S[k]+=v;S.sym.add(s);}});}
// 고른 보기의 메타(점수·라벨·태그)를 상태에 반영
function applyMeta(m){S.d+=m.d||0;S.a+=m.a||0;S.x+=m.x||0;if(m.s)S.sym.add(m.s);if(m.r)S.risk.add(m.r);if(m.p)S.prot.add(m.p);if(m.t)S.tags.add(m.t);}
const clamp=v=>Math.min(3,Math.round(v*10)/10);
// 최근 2주 빈도(2-2)로 점수 보정
const scores=()=>{const f=S.tags.has("freq_high")?1.3:S.tags.has("freq_low")?0.6:1;
  return {우울:clamp(S.d/5*f),불안:clamp(S.a/4*f),중독:clamp(S.x/5*f)};};

function begin(){
  S={ans:{},d:0,a:0,x:0,sym:new Set(),risk:new Set(),prot:new Set(),tags:new Set(),i:0,log:[],name:"",fuCount:0,extraObs:""};
  ChatScreen.clear();show("chat");
  ChatScreen.aiSay("안녕하세요, 말씨예요. 누군가에게 다가가려는 마음을 먹으셨군요.\n천천히 답해 주셔도 괜찮아요.","hello");
  setTimeout(ask,700);
}
async function ask(){
  while(S.i<Q.length&&Q[S.i].when&&!Q[S.i].when(S))S.i++; // 조건에 맞지 않는 문항은 건너뜀
  if(S.i>=Q.length)return finish();
  const q=Q[S.i];ChatScreen.progress(S.i/Q.length*100);ChatScreen.section(nm(q.sec));ChatInput.clear();
  if(q.intro){await ChatScreen.typing(q.face,600);ChatScreen.aiSay(q.intro,q.face);}
  await ChatScreen.typing(q.face,600);ChatScreen.aiSay(q.q,q.face,q.why);
  ChatInput.render(q,answer);
}
async function followUp(f,face="ponder"){
  S.fuCount++;await ChatScreen.typing(face,700);ChatScreen.aiSay(f.q,face,"","",true);
  return new Promise(res=>ChatInput.render(f,(text,sel,custom="")=>{ChatScreen.meSay(text);res({text,sel,custom});}));
}
async function answer(text,sel,custom="",skipped=false){
  const q=Q[S.i];ChatScreen.meSay(text);
  let a={text,sel,custom};
  // 후속 질문 (문항당 최대 1회, 건너뛴 문항은 다시 묻지 않음)
  const f=FOLLOW[q.id];
  if(f&&!skipped&&f.when(a)){const r=await followUp(f.q);a=f.merge(a,r);}
  S.ans[q.id]=a;
  if(q.id==="name") S.name=isThin(a.text,1)?"그분":a.text.slice(0,20);
  if(q.id==="mood"&&a.custom) S.extraObs=a.custom;
  if(q.cue) readCues(q.type==="text"?a.text:a.custom||"");
  a.sel.forEach(k=>{const o=q.opts[k];if(Array.isArray(o))applyMeta(o[1]||{});});
  // 위험 신호(suicidal)는 대화 중에 끊지 않고 결과 화면의 안전 카드로 안내
  S.i++;setTimeout(ask,400);
}
async function finish(){
  ChatScreen.progress(100);
  // 마무리 전 정보 충분성 점검
  for(const g of gapCheck()){const r=await followUp(g,"think");if(!isThin(r.text,1)){S.extraObs=r.text;readCues(r.text);}}
  await ChatScreen.typing("ponder",1400);
  ChatScreen.aiSay("고마워요. 들려주신 이야기를 바탕으로 말하는 방법을 정리했어요.","thanks");
  const A=S.ans,val=k=>{const t=A[k]?.text;return t&&!t.startsWith("(")?t:undefined;}; // 건너뛴 답은 비움
  const p={name:S.name,rel:val("rel"),contact:val("contact"),obs:S.extraObs,concern:val("concern"),moment:val("moment"),feeling:val("feeling"),want:val("want"),
    scores:scores(),safety:S.sym.has("suicidal"),symptoms:[...S.sym],risks:[...S.risk],protect:[...S.prot],tags:[...S.tags],
    answers:Object.fromEntries(Object.entries(A).map(([k,v])=>[k,v.text]))};
  const g=await generateGuide(p);
  const rec={id:Date.now(),title:S.name||"그분",date:new Date().toISOString(),profile:p,guide:g,log:S.log,followUps:S.fuCount};
  const all=loadRecs();all.unshift(rec);const ok=saveRecs(all);
  setTimeout(()=>ResultScreen.open(p,g,ok),1100);
}
