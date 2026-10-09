// 입력 UI: 질문 객체 하나를 받아 답을 onDone(text, sel, custom, skipped)으로 돌려줌. onBack이 있으면 "이전 질문" 버튼을 보임
const SKIP="(건너뛰었어요)";
const ChatInput={
  clear(){$("input").innerHTML="";},
  render(q,onDone,onBack){
    const box=$("input");box.innerHTML="";
    const addBack=()=>{if(!onBack)return;const b=document.createElement("button");b.className="back";b.textContent="← 이전 질문으로";
      b.onclick=()=>{box.innerHTML="";onBack();};box.prepend(b);};
    // 건너뛰기 (네/아니요 질문은 q.noSkip, 핵심 문항은 q.required로 숨김)
    const canSkip=!q.noSkip&&!q.required;
    // 핵심 문항에 빈 답을 보내려 하면 안내 문구를 띄움
    const need=focusEl=>{let n=box.querySelector(".need");
      if(!n){n=document.createElement("p");n.className="need";n.setAttribute("role","status");n.textContent="이 질문은 꼭 답해 주세요. 맞춤 말하기 방법을 만드는 데 꼭 필요한 정보예요.";box.appendChild(n);}
      focusEl?.focus();};
    const skipBtn=()=>{const s=document.createElement("button");s.className="ghost skip";s.textContent="건너뛰기";
      s.onclick=()=>{box.innerHTML="";onDone(SKIP,[],"",true);};return s;};
    if(q.type==="text"){
      box.innerHTML=`<div class="row"><textarea id="ta" rows="${q.short?1:2}" placeholder="${esc(q.ph||"")}"></textarea><button class="send" id="send">보내기</button></div>`;
      if(canSkip)box.querySelector(".row").appendChild(skipBtn());
      const ta=$("ta");ta.focus();
      $("send").onclick=()=>{const v=ta.value.trim();if(!v&&q.required)return need(ta);box.innerHTML="";onDone(v||SKIP,[]);};
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
          if(m.input) return ChatInput.render({type:"text",ph:m.ph,noSkip:true},t=>onDone(t.startsWith("(")?optLabel(o):`${optLabel(o)}, ${t}`,[k],""),()=>ChatInput.render(q,onDone,onBack));
          box.innerHTML="";return onDone(optLabel(o),[k],"");
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
    row.innerHTML=`<div class="own"><label for="own">직접 입력</label><input id="own" type="text" placeholder="${esc(q.ownPh||(q.type==="multi"?"보기에 없는 내용이 있다면 적어 주세요":"보기에 없다면 적어 주세요"))}">${q.type==="one"?'<button class="send" id="ownSend">보내기</button>':""}</div>`;
    if(canSkip)row.appendChild(skipBtn());
    box.appendChild(row);
    const own=$("own");
    const pick=()=>btns.map((c,k)=>c.getAttribute("aria-pressed")==="true"?k:-1).filter(k=>k>=0);
    if(q.type==="one"){
      const go=()=>{const v=own.value.trim();if(!v){own.focus();return;}box.innerHTML="";onDone(v,[],v);};
      $("ownSend").onclick=go;own.onkeydown=e=>{if(e.key==="Enter"&&!e.isComposing){e.preventDefault();go();}};
    }else{
      const g=document.createElement("button");g.className="btn done";g.textContent="다 골랐어요";
      g.onclick=()=>{const sel=pick(),v=own.value.trim();
        if(q.required&&!sel.length&&!v)return need();
        const parts=sel.map(k=>optLabel(q.opts[k]));if(v)parts.push(v);
        box.innerHTML="";onDone(parts.length?parts.join(", "):"해당 없음",sel,v);};
      own.onkeydown=e=>{if(e.key==="Enter"&&!e.isComposing){e.preventDefault();g.click();}};
      row.appendChild(g);
    }
    addBack();
  }
};
