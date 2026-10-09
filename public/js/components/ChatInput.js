// 입력 UI: 질문 객체 하나를 받아 답을 onDone(text, sel, custom, skipped)으로 돌려줌. onBack이 있으면 "이전 질문" 버튼을 보임
const SKIP="(건너뛰었어요)";
const ChatInput={
  version:0,
  clear(){this.version++;$("input").innerHTML="";$("input").dataset.busy="";},
  busy(value){const box=$("input");box.dataset.busy=value?"true":"";box.querySelectorAll("button,input,textarea").forEach(el=>el.disabled=value);},
  async run(operation){
    if($("input").dataset.busy)return;
    const version=this.version;$("input").querySelector(".api-error")?.remove();this.busy(true);
    try{await operation();}
    catch(error){if(version===this.version)this.error(error.message,operation);}
    finally{if(version===this.version)this.busy(false);}
  },
  error(message,retry){
    const box=$("input");box.querySelector(".api-error")?.remove();
    const wrap=document.createElement("div");wrap.className="api-error";
    const note=document.createElement("p");note.className="need";note.setAttribute("role","status");note.textContent=message;wrap.appendChild(note);
    if(retry){const b=document.createElement("button");b.className="ghost";b.textContent="다시 시도";b.onclick=()=>this.run(retry);wrap.appendChild(b);}
    box.appendChild(wrap);
  },
  render(q,onDone,onBack){
    this.clear();const box=$("input");
    const submit=(...args)=>this.run(()=>onDone(...args));
    const addBack=()=>{if(!onBack)return;const b=document.createElement("button");b.className="back";b.textContent="← 이전 질문으로";
      b.onclick=()=>this.run(onBack);box.prepend(b);};
    // 건너뛰기 (네/아니요 질문은 q.noSkip, 핵심 문항은 q.required로 숨김)
    const canSkip=!q.noSkip&&!q.required;
    // 핵심 문항에 빈 답을 보내려 하면 안내 문구를 띄움
    const need=focusEl=>{let n=box.querySelector(".need");
      if(!n){n=document.createElement("p");n.className="need";n.setAttribute("role","status");n.textContent="이 질문은 꼭 답해 주세요. 맞춤 말하기 방법을 만드는 데 꼭 필요한 정보예요.";box.appendChild(n);}
      focusEl?.focus();};
    const skipBtn=()=>{const s=document.createElement("button");s.className="ghost skip";s.textContent="건너뛰기";
      s.onclick=()=>submit(SKIP,[],"",true);return s;};
    if(q.type==="text"){
      box.innerHTML=`<div class="row"><textarea id="ta" rows="${q.short?1:2}" placeholder="${esc(q.ph||"")}"></textarea><button class="send" id="send">보내기</button></div>`;
      if(canSkip)box.querySelector(".row").appendChild(skipBtn());
      const ta=$("ta");ta.focus();
      $("send").onclick=()=>{const v=ta.value.trim();if(!v&&q.required)return need(ta);submit(v||SKIP,[]);};
      ta.onkeydown=e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.isComposing){e.preventDefault();$("send").click();}};addBack();return;
    }
    // 보기 버튼 (묶음 이름 g가 있으면 묶음별 제목을 붙임)
    const wrap=document.createElement("div");wrap.className="chipwrap";
    const btns=[];let chips=null,lastG;
    q.opts.forEach((o,k)=>{
      const m=optMeta(o);
      if(!chips||m.g!==lastG){
        if(m.g){const h=document.createElement("div");h.className="chip-group";h.textContent=m.g;wrap.appendChild(h);}
        chips=document.createElement("div");chips.className="chips";
        // 묶음 뒤에 오는 묶음 없는 보기(예: "특별히 관찰된 변화가 없음")는 앞 묶음과 떨어뜨려 보여 줌
        if(!m.g&&lastG)chips.classList.add("apart");
        wrap.appendChild(chips);lastG=m.g;
      }
      const b=document.createElement("button");b.className="chip";b.textContent=optLabel(o);b.setAttribute("aria-pressed","false");
      b.onclick=()=>{
        if(q.type==="one"){
          // "네 [직접 입력]": 고르면 입력창으로 바뀜
          if(m.input) return ChatInput.render({type:"text",ph:m.ph,noSkip:true},t=>onDone(t===SKIP?optLabel(o):`${optLabel(o)}, ${t}`,[k],""),onBack);
          btns.forEach(x=>x.setAttribute("aria-pressed",x===b?"true":"false"));
          return submit(optLabel(o),[k],"");
        }
        const on=b.getAttribute("aria-pressed")!=="true";
        // "없어요"류 보기는 다른 보기와 함께 고를 수 없음
        if(on)btns.forEach((x,j)=>{if(j!==k&&(m.none||optMeta(q.opts[j]).none))x.setAttribute("aria-pressed","false");});
        b.setAttribute("aria-pressed",on?"true":"false");
      };
      btns.push(b);chips.appendChild(b);
    });
    box.appendChild(wrap);
    if(q.noOwn&&q.type==="one"){
      if(canSkip){const r=document.createElement("div");r.className="inrow only";r.appendChild(skipBtn());box.appendChild(r);}
      addBack();return;
    }
    // 선택형 문항의 직접 입력
    const row=document.createElement("div");row.className="inrow";
    row.innerHTML=`<div class="own"><label for="own">직접 입력</label><input id="own" type="text" placeholder="${q.type==="multi"?"보기에 없는 내용이 있다면 적어 주세요":"보기에 없다면 적어 주세요"}">${q.type==="one"?'<button class="send" id="ownSend">보내기</button>':""}</div>`;
    if(canSkip)row.appendChild(skipBtn());
    box.appendChild(row);
    const own=$("own");
    const pick=()=>btns.map((c,k)=>c.getAttribute("aria-pressed")==="true"?k:-1).filter(k=>k>=0);
    if(q.type==="one"){
      const go=()=>{const v=own.value.trim();if(!v){own.focus();return;}submit(v,[],v);};
      $("ownSend").onclick=go;own.onkeydown=e=>{if(e.key==="Enter"&&!e.isComposing){e.preventDefault();go();}};
    }else{
      const g=document.createElement("button");g.className="btn done";g.textContent="다 골랐어요";
      g.onclick=()=>{const sel=pick(),v=own.value.trim();
        if(q.required&&!sel.length&&!v)return need();
        const parts=sel.map(k=>optLabel(q.opts[k]));if(v)parts.push(v);
        submit(parts.length?parts.join(", "):"해당 없음",sel,v);};
      own.onkeydown=e=>{if(e.key==="Enter"&&!e.isComposing){e.preventDefault();g.click();}};
      row.appendChild(g);
    }
    addBack();
  }
};
