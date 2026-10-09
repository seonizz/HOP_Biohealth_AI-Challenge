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
    // 자동 스크롤: 메시지 추가, 입력창 크기 변화 때마다 맨 아래로
    const scrollDown=()=>{const l=$("log");requestAnimationFrame(()=>l.scrollTo({top:l.scrollHeight,behavior:matchMedia("(prefers-reduced-motion:reduce)").matches?"auto":"smooth"}));};
    new MutationObserver(scrollDown).observe($("log"),{childList:true,subtree:true});
    new ResizeObserver(scrollDown).observe($("log"));
    $("restart1").onclick=()=>show("start");
  },
  clear(){$("log").innerHTML="";},
  progress(pct){$("prog").style.width=pct+"%";},
  // 지금 어떤 단계의 질문인지 (예: 관계, 당신의 마음)
  section(label){$("sec").hidden=!label;$("sec").textContent=label||"";},
  aiSay(text,face,why,cls="",fu=false){
    text=nm(text);S.log.push({who:"ai",text,fu});
    const r=document.createElement("div");r.className="ai-row";
    r.innerHTML=`<img src="${M[face]}" alt=""><div class="msg ${cls}">${fu?'<span class="fu-tag">조금 더 알려 주세요</span><br>':""}${esc(text)}${why?`<span class="why">${esc(nm(why))}</span>`:""}</div>`;
    $("log").appendChild(r);$("log").scrollTop=1e9;
  },
  meSay(t){S.log.push({who:"me",text:t});const d=document.createElement("div");d.className="msg me";d.textContent=t;$("log").appendChild(d);$("log").scrollTop=1e9;},
  // 입력 중… 점 애니메이션을 ms 동안 보여 줌
  typing(face,ms){return new Promise(res=>{const r=document.createElement("div");r.className="ai-row";
    r.innerHTML=`<img src="${M[face]}" alt=""><div class="msg"><span class="dots"><span></span><span></span><span></span></span></div>`;
    $("log").appendChild(r);$("log").scrollTop=1e9;setTimeout(()=>{r.remove();res();},ms);});}
};
