// 2. 대화 화면: 말풍선 표시만 담당 (흐름은 core/conversation.js)
const ChatScreen={
  render(){return `
<section class="screen" id="chat" hidden>
  ${TopBar(`<div class="prog" aria-label="진행"><i id="prog" style="width:0"></i></div><span class="pill" id="sec" hidden></span><button class="ghost" id="restart1" style="margin-left:auto">처음으로</button>`)}
  <div class="body">
    <div class="log" id="log" aria-live="polite"></div>
    <div class="input" id="input"></div>
    <div class="thinking" id="thinking" hidden role="status" aria-live="polite">
      <div class="th-card">
        <img class="th-img" data-m="ponder" alt="">
        <h3>말을 정리하고 있어요 <span class="dots" aria-hidden="true"><span></span><span></span><span></span></span></h3>
        <p class="th-sub">들려주신 이야기에 따라 조금 걸릴 수 있어요.</p>
        <ol class="th-steps"><li>들려주신 이야기를 다시 읽고 있어요</li><li>그분의 상황을 정리하고 있어요</li><li>마음이 잘 닿는 첫 문장을 고르고 있어요</li></ol>
        <div class="th-err" hidden><p>정리하는 중에 문제가 생겼어요. 답해 주신 내용은 그대로 있으니 다시 시도해 주세요.</p><button class="btn" id="thRetry">다시 시도</button></div>
      </div>
    </div>
  </div>
  <dialog class="leave" id="leaveDlg" aria-labelledby="leaveT">
    <img data-m="ponder" alt="">
    <h3 id="leaveT">정말 처음으로 돌아갈까요?</h3>
    <p>지금 나가면 이 대화는 저장되지 않아요.<br>지금까지 답해 주신 내용이 모두 사라져요.</p>
    <div class="acts"><button class="btn" id="leaveStay" autofocus>계속 이야기하기</button><button class="ghost" id="leaveGo">나가기</button></div>
  </dialog>
</section>`;},
  mount(){
    // 자동 스크롤: 메시지 추가, 입력 상자 크기 변화(대화창이 줄어듦) 때마다 즉시 맨 아래로
    // (부드러운 스크롤은 진행 중에 입력 상자가 커지면 예전 위치에서 멈춰 맨 아래까지 가지 못해서 쓰지 않음)
    const l=$("log"),toBottom=()=>{l.scrollTop=l.scrollHeight;};
    new MutationObserver(toBottom).observe(l,{childList:true,subtree:true});
    new ResizeObserver(toBottom).observe(l);
    $("restart1").onclick=()=>this.leave(()=>show("start"));
    // 새로고침·탭 닫기: 답한 내용이 있으면 브라우저가 나가기 전에 확인 (문구는 브라우저 기본 문구로 나옴)
    window.addEventListener("beforeunload",e=>{if(this.started()){e.preventDefault();e.returnValue="";}});
    const d=$("leaveDlg");
    $("leaveStay").onclick=()=>d.close();
    d.onclick=e=>{if(e.target===d)d.close();}; // 바깥(배경)을 누르면 계속 이야기하기
  },
  // 답을 하나라도 했거나 입력 중이면 저장되지 않는다고 확인한 뒤 나감 (마무리되면 기록이 저장되므로 묻지 않음)
  started(){
    if($("chat").hidden||typeof S==="undefined"||!S)return false;
    return Object.keys(S.ans).length>0||[...document.querySelectorAll("#input textarea,#input input")].some(e=>e.value.trim())||!!document.querySelector("#input .chip[aria-pressed=true]");
  },
  leave(go){
    if(!this.started())return go();
    $("leaveGo").onclick=()=>{$("leaveDlg").close();go();};
    $("leaveDlg").showModal();
  },
  clear(){$("log").innerHTML="";this.think(false);},
  // 결과를 만드는 동안 보이는 로딩 카드: 단계(0~2)가 실제 모델 처리에 맞춰 하나씩 완료로 바뀜
  think(on){const t=$("thinking");t.hidden=!on;if(on){t.querySelector(".th-err").hidden=true;this.thinkStep(0);}},
  thinkStep(i){[...$("thinking").querySelectorAll(".th-steps li")].forEach((l,k)=>l.className=k<i?"done":k===i?"now":"");},
  thinkError(retry){$("thinking").querySelector(".th-err").hidden=false;$("thinking").querySelectorAll(".th-steps li.now").forEach(l=>l.className="");$("thRetry").onclick=retry;},
  // 이전 질문으로 돌아갈 때 그 뒤에 쌓인 말풍선을 지움
  count(){return $("log").children.length;},
  truncate(n){const l=$("log");while(l.children.length>n)l.lastChild.remove();},
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
