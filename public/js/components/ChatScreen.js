// 2. 대화 화면: 말풍선 표시만 담당 (흐름은 core/conversation.js)
const ChatScreen={
  render(){return `
<section class="screen" id="chat" hidden>
  ${TopBar(`<div class="prog" aria-label="진행"><i id="prog" style="width:0"></i></div><span class="pill" id="sec" hidden></span><button class="ghost" id="restart1" style="margin-left:auto">처음으로</button>`)}
  <div class="body">
    <div class="log" id="log" aria-live="polite"></div>
    <div class="input" id="input"></div>
  </div>
</section>`;},
  mount(){
    // 자동 스크롤: 메시지 추가, 입력 상자 크기 변화(대화창이 줄어듦) 때마다 즉시 맨 아래로
    // (부드러운 스크롤은 진행 중에 입력 상자가 커지면 예전 위치에서 멈춰 맨 아래까지 가지 못해서 쓰지 않음)
    const l=$("log"),toBottom=()=>{l.scrollTop=l.scrollHeight;};
    new MutationObserver(toBottom).observe(l,{childList:true,subtree:true});
    new ResizeObserver(toBottom).observe(l);
    $("restart1").onclick=leaveConversation;
  },
  clear(){$("log").innerHTML="";this.messages=[];},
  // 이전 질문으로 돌아갈 때 그 뒤에 쌓인 말풍선을 지움
  count(){return $("log").children.length;},
  truncate(n){const l=$("log");while(l.children.length>n)l.lastChild.remove();},
  progress(pct){$("prog").style.width=pct+"%";},
  // 지금 어떤 단계의 질문인지 (예: 관계, 당신의 마음)
  section(label){$("sec").hidden=!label;$("sec").textContent=label||"";},
  // 서버 기록의 공통 부분은 유지하고, 되돌리기/새 메시지만 화면에 반영해요.
  sync(log){
    const previous=this.messages||[];let common=0;
    while(common<previous.length&&common<log.length&&JSON.stringify(previous[common])===JSON.stringify(log[common]))common++;
    this.truncate(common);
    log.slice(common).forEach(m=>m.who==="me"?this.meSay(m.text):this.aiSay(m.text,m.face||"ponder",m.why,"",m.fu));
    this.messages=log.map(m=>({...m}));
  },
  aiSay(text,face,why,cls="",fu=false){
    // 호칭과 조사는 서버에서 이미 치환했으므로 받은 문구를 그대로 표시해요.
    const r=document.createElement("div");r.className="ai-row";
    r.innerHTML=`<img src="${M[face]}" alt=""><div class="msg ${cls}">${fu?'<span class="fu-tag">조금 더 알려 주세요</span><br>':""}${esc(text)}${why?`<span class="why">${esc(why)}</span>`:""}</div>`;
    $("log").appendChild(r);$("log").scrollTop=1e9;
  },
  meSay(t){const d=document.createElement("div");d.className="msg me";d.textContent=t;$("log").appendChild(d);$("log").scrollTop=1e9;},
  // 서버/모델을 기다리는 동안 입력 중… 점 애니메이션을 보여 줘요.
  typing(face,work){const r=document.createElement("div");r.className="ai-row";
    r.innerHTML=`<img src="${M[face]}" alt=""><div class="msg"><span class="dots"><span></span><span></span><span></span></span></div>`;
    $("log").appendChild(r);$("log").scrollTop=1e9;return Promise.resolve(work).finally(()=>r.remove());}
};
