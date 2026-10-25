// 2. 대화 화면: 말풍선 표시만 담당 (흐름은 core/conversation.js)
const ChatScreen={
  render(){return `
<section class="screen" id="chat" hidden>
  ${TopBar(`<div class="chat-progress"><div class="prog" role="progressbar" aria-label="대화 진행" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i id="prog" style="width:0"></i></div></div><span class="pill" id="chatTitle" hidden></span><span class="pill" id="sec" hidden></span><button class="ghost" id="restart1">처음으로</button>`)}
  <div class="body">
    <div class="log" id="log" aria-live="polite"></div>
    <div class="input" id="input"></div>
    <div class="thinking" id="thinking" hidden role="status" aria-live="polite">
      <div class="th-card">
        <img class="th-img" data-m="ponder" alt="">
        ${this.progressMarkup()}
        <div class="th-err" hidden><p>정리하는 중에 문제가 생겼어요. 답해 주신 내용은 그대로 있으니 다시 시도해 주세요.</p><button class="btn" id="thRetry">다시 시도</button></div>
      </div>
    </div>
  </div>
  <dialog class="leave" id="leaveDlg" aria-labelledby="leaveT">
    <img data-m="ponder" alt="">
    <h3 id="leaveT">정말 처음으로 돌아갈까요?</h3>
    <p>저장된 대화는 「내 기록」에서 이어가거나 삭제할 수 있어요. 작성 중인 입력은 같은 탭에서 잠시 보관돼요.</p>
    <div class="leave-actions">
      <button class="btn" id="leaveStay" autofocus>계속 이야기하기</button>
      <button class="ghost" id="leaveGo">나가기</button>
      <button class="ghost" id="leaveDelete">이 대화 삭제하고 나가기</button>
    </div>
    <p id="leaveDeleteNotice" role="status" hidden></p>
  </dialog>
</section>`;},
  mount(){
    this.mountViewport();
    // 자동 스크롤: 메시지 추가, 입력 상자 크기 변화(대화창이 줄어듦) 때마다 즉시 맨 아래로
    // (부드러운 스크롤은 진행 중에 입력 상자가 커지면 예전 위치에서 멈춰 맨 아래까지 가지 못해서 쓰지 않음)
    const l=$("log"),toBottom=()=>{l.scrollTop=l.scrollHeight;};
    new MutationObserver(toBottom).observe(l,{childList:true,subtree:true});
    new ResizeObserver(toBottom).observe(l);
    $("restart1").onclick=leaveConversation;
    window.addEventListener("beforeunload",e=>{
      // 저장을 지원하지 않는 환경에서만 보내지 않은 입력의 이탈을 확인해요.
      const unsent=[...$("input").querySelectorAll("textarea,input")].some(el=>el.value.trim())||[...$("input").querySelectorAll(".chip")].some(el=>el.getAttribute("aria-pressed")==="true");
      if(!$("chat").hidden&&unsent&&(typeof ConversationDrafts==="undefined"||!ConversationDrafts.storageKey)){e.preventDefault();e.returnValue="";}
    });
    const d=$("leaveDlg");
    $("leaveStay").onclick=()=>{if(!this._deleting)d.close();};
    d.onclick=e=>{if(e.target===d&&!this._deleting)d.close();};
    d.oncancel=e=>{if(this._deleting)e.preventDefault();};
  },
  mountViewport(){
    const viewport=window.visualViewport;
    if(!viewport)return; // 오래된 브라우저는 기존 반응형 배치와 기본 포커스 스크롤을 사용해요.
    const chat=$("chat"),input=$("input"),body=chat.querySelector(".body");
    let frame=0,restingHeight=viewport.height,restingWidth=viewport.width,compact=false;
    const update=()=>{
      frame=0;
      const active=document.activeElement,inside=input.contains(active);
      const editing=inside&&active.matches("input,textarea");
      const unzoomed=Math.abs(viewport.scale-1)<.05;
      // 회전·창 너비 변경 전 높이를 키보드가 차지한 공간으로 오인하지 않아요.
      if(Math.abs(viewport.width-restingWidth)>1){restingHeight=window.innerHeight;restingWidth=viewport.width;}
      const reduced=window.innerHeight-viewport.height>80||restingHeight-viewport.height>80;
      // 키보드가 layout viewport를 줄이지 않는 경우도 처리하고, 핀치 확대는 그대로 유지해요.
      const next=!chat.hidden&&unzoomed&&viewport.width<=900&&
        (editing||compact&&(inside||reduced))&&reduced;
      if(!inside&&!compact||viewport.height>restingHeight)restingHeight=viewport.height;
      const opening=next&&!compact;
      compact=next;
      chat.classList.toggle("keyboard-open",compact);
      if(!compact){
        chat.style.removeProperty("--chat-visible-height");
        chat.style.removeProperty("--chat-visible-top");
        return;
      }
      chat.style.setProperty("--chat-visible-height",`${viewport.height}px`);
      chat.style.setProperty("--chat-visible-top",`${viewport.offsetTop}px`);
      // 필드만 따라가면 바로 아래 완료 버튼이 가려져요. 두 요소가 있는 행을 함께 드러내요.
      const row=(inside?active.closest(".row,.inrow"):null)||input.querySelector(".row,.inrow");
      if(!row)return;
      const bounds=body.getBoundingClientRect(),controls=row.getBoundingClientRect();
      const top=Math.max(bounds.top,viewport.offsetTop)+6;
      const bottom=Math.min(bounds.bottom,viewport.offsetTop+viewport.height)-6;
      if(controls.bottom>bottom)body.scrollTop+=controls.bottom-bottom;
      else if(controls.top<top)body.scrollTop-=top-controls.top;
      // 모바일 브라우저의 기본 포커스 이동이 끝난 프레임에도 버튼 경계를 확인해요.
      if(opening)requestAnimationFrame(schedule);
    };
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(update);};
    viewport.addEventListener("resize",schedule);
    viewport.addEventListener("scroll",schedule);
    window.addEventListener("resize",schedule);
    chat.addEventListener("focusin",schedule);
    chat.addEventListener("focusout",schedule);
    // 질문 교체·필수 입력 안내·불씨 안내로 행 위치가 바뀔 때도 다시 맞춰요.
    new MutationObserver(schedule).observe(body,{childList:true,subtree:true});
    new MutationObserver(schedule).observe(chat,{attributes:true,attributeFilter:["hidden"]});
    const resize=new ResizeObserver(schedule);resize.observe(input);resize.observe(body);
    schedule();
  },
  started(){
    if($("chat").hidden||typeof S==="undefined"||!S)return false;
    return (this.messages||S.log).some(m=>m.who==="me")||[...$("input").querySelectorAll("textarea,input")].some(e=>e.value.trim())||
      [...$("input").querySelectorAll(".chip")].some(e=>e.getAttribute("aria-pressed")==="true");
  },
  leave(go){
    if(!this.started())return go();
    const button=$("leaveDelete"),notice=$("leaveDeleteNotice");
    let confirmed=false;
    button.hidden=!S?.id;button.disabled=false;button.textContent="이 대화 삭제하고 나가기";notice.hidden=true;
    $("leaveGo").onclick=()=>{if(!this._deleting){$("leaveDlg").close();go();}};
    button.onclick=async()=>{
      if(this._deleting)return;
      if(!confirmed){confirmed=true;button.textContent="삭제하고 나가기 확인";notice.textContent="이 대화와 관련 결과가 삭제돼요. 되돌릴 수 없어요.";notice.hidden=false;return;}
      this._deleting=true;button.disabled=true;$("leaveGo").disabled=true;$("leaveStay").disabled=true;
      try{await deleteCurrentConversation();$("leaveDlg").close();}
      catch(error){notice.textContent=error.message;notice.hidden=false;}
      finally{this._deleting=false;button.disabled=false;$("leaveGo").disabled=false;$("leaveStay").disabled=false;}
    };
    $("leaveDlg").showModal();
  },
  clear(){$("log").innerHTML="";this.messages=[];this.think(false);},
  progressMarkup(){return `<div class="waiting-dots" role="status" aria-label="안내를 준비하고 있어요" aria-busy="true"><span class="dots" aria-hidden="true"><span></span><span></span><span></span></span></div>`;},
  think(on){const t=$("thinking");t.hidden=!on;if(on){t.querySelector(".th-err").hidden=true;this.thinkProgress({status:"running"});}},
  thinkProgress(p,target=$("thinking")){
    const waiting=target?.querySelector(".waiting-dots");
    if(p&&waiting)waiting.setAttribute("aria-busy",String(p.status!=="complete"&&p.status!=="failed"));
  },
  thinkError(retry,message="정리하는 중에 문제가 생겼어요. 답해 주신 내용은 그대로 있으니 다시 시도해 주세요."){
    const error=$("thinking").querySelector(".th-err");error.hidden=false;
    error.querySelector("p").textContent=message;
    $("thRetry").onclick=retry;
  },
  // 이전 질문으로 돌아갈 때 그 뒤에 쌓인 말풍선을 지움
  count(){return $("log").children.length;},
  truncate(n){const l=$("log");while(l.children.length>n)l.lastChild.remove();},
  progress(pct,step){
    const total=Number.isInteger(step?.total)&&step.total>0?step.total:0;
    const index=total?Math.min(step.complete?total:total-1,Math.max(0,Number.isInteger(step.index)?step.index:0)):0;
    const percent=total?(step.complete?100:index/total*100):Math.min(100,Math.max(0,Number(pct)||0));
    const bar=$("prog").parentElement;
    $("prog").style.width=`${percent}%`;
    bar.setAttribute("aria-valuenow",String(Math.round(percent)));
    bar.setAttribute("aria-valuetext",percent===100?"대화를 마쳤어요":step?.label||"대화 진행 중");
  },
  title(label){
    const name=typeof label==="string"?label.trim():"";
    $("chatTitle").textContent=name;$("chatTitle").hidden=!name;
    document.title=name?`${name} · 말씨`:"말씨";
  },
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
  async typing(face,work){const r=document.createElement("div");r.className="ai-row";
    r.innerHTML=`<img src="${M[face]}" alt=""><div class="msg" role="status" aria-label="AI 응답을 기다리고 있어요"><span class="dots" aria-hidden="true"><span></span><span></span><span></span></span></div>`;
    $("log").appendChild(r);$("log").scrollTop=1e9;
    try{
      if(typeof work==="function"){
        // 말풍선과 대기 표시를 한 번 그린 뒤 요청을 시작해요.
        if(typeof requestAnimationFrame==="function"&&document.visibilityState!=="hidden")await new Promise(resolve=>{
          const timer=setTimeout(resolve,100);
          requestAnimationFrame(()=>requestAnimationFrame(()=>{clearTimeout(timer);resolve();}));
        });
        return await work();
      }
      return await work;
    }finally{r.remove();}}
};
