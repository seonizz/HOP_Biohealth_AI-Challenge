// 가이드의 "이렇게 해 보세요 / 피하면 좋아요" 카드 쌍 (결과 화면·기록 화면 공용)
const GuideCards={
  // 위험 신호가 있었을 때 맨 위에 보이는 안전 안내 카드
  safety:(style="")=>`<div class="card safety"${style?` style="${style}"`:""} role="alert"><img src="${M.empathy}" alt=""><div>
    <h3>대화보다 안전이 먼저예요</h3>
    <p>죽고 싶다거나 사라지고 싶다는 신호가 있었다고 알려 주셨어요. 말씀해 주셔서 정말 고마워요. 이건 혼자 감당하지 않으셔도 돼요.</p>
    <ul><li>자살예방 상담전화 <b>109</b> (24시간)</li><li>정신건강위기 상담전화 <b>1577-0199</b></li><li>지금 위험하다면 <b>112 / 119</b></li></ul></div></div>`,
  list:items=>`<ul>${items.map(x=>`<li style="white-space:pre-wrap">${esc(x)}</li>`).join("")}</ul>`,
  tips:items=>Array.isArray(items)&&items.length?`<p class="tips">${esc(items[0])}</p>`:"",
  care(value){return `<div class="card care"><img src="${M.empathy}" alt=""><div><h3 style="margin-bottom:6px">당신의 마음도 소중해요</h3><p>${esc(value.feel)}</p>${this.tips(value.tips)}</div></div>`;},
  action(id,value){return `<div class="card ${id==='doList'?'do':'avoid'}"><h3>${id==='doList'?'이렇게 해 보세요':'피하면 좋아요'}</h3>${this.list(value)}</div>`;},
  partial(card,{care}={}){
    if(card.id==='care')return this.care(card.value);
    if(card.id==='doList'||card.id==='avoid')return this.action(card.id,card.value);
    if(card.id==='next')return this.next({next:card.value,care});
    if(card.id==='script')return this.speech({script:card.value},card.detail,{copy:true,ids:false});
    if(card.id==='relationship')return this.relationship(card.value);
    return "";
  },
  speech(g,detail,{copy=false,ids=true}={}){
    return `<div class="card script"><h3>이렇게 시작해 보세요</h3>${copy?`<button class="copy"${ids?' id="cp"':""} type="button">⧉ 문장 복사</button>`:""}
      <div class="speech-text"${copy&&ids?' id="scr"':""} style="white-space:pre-wrap">${esc(g.script)}</div></div>`;
  },
  bindCopy(root,script){
    const button=root.querySelector(".copy"),text=root.querySelector(".speech-text");
    if(!button||!text)return;
    button.onclick=()=>Promise.resolve().then(()=>navigator.clipboard.writeText(script)).then(
      ()=>{button.textContent="복사했어요";},
      ()=>{const range=document.createRange();range.selectNodeContents(text);getSelection().removeAllRanges();getSelection().addRange(range);}
    );
  },
  doAvoid(g,{wrapStyle="",doStyle=""}={}){
    return `<div class="two guide-actions"${wrapStyle?` style="${wrapStyle}"`:""}><div class="card do"${doStyle?` style="${doStyle}"`:""}><h3>이렇게 해 보세요</h3>${this.list(g.doList)}</div>
    <div class="card avoid"><h3>피하면 좋아요</h3>${this.list(g.avoid)}</div></div>`;
  },
  next(g){
    const tips=Array.isArray(g.care?.tips)?g.care.tips.slice(1):[];
    return `<div class="card next"><img src="${M.think}" alt=""><div><h3 style="margin-bottom:4px">다음 단계</h3><p style="margin:0;white-space:pre-wrap">${esc(g.next)}</p>${tips.length?`<p class="note" style="margin:8px 0 0">당신을 위해서도: ${esc(tips.join(" "))}</p>`:""}</div></div>`;
  },
  relationship(a,{style=""}={}){
    if(!a||typeof a!=="object")return "";
    const relation=a.relationship||{},hasText=value=>typeof value==="string"&&value.trim();
    const evidence=items=>{
      const quotes=Array.isArray(items)?items.filter(item=>hasText(item?.quote)):[];
      if(!quotes.length)return "";
      return `<details style="margin-top:8px"><summary class="note" style="cursor:pointer">근거로 살펴본 답변</summary><ul style="margin-top:8px">${quotes.map(item=>`<li><span class="note">${item.subject==="patient"?"그분에 대해 들려주신 말":item.subject==="supporter"?"당신에 대해 들려주신 말":"들려주신 말"}</span><br><q style="white-space:pre-wrap">${esc(item.quote)}</q></li>`).join("")}</ul></details>`;
    };
    const group=(title,items)=>{
      const entries=Array.isArray(items)?items.filter(item=>hasText(item?.interpretation)):[];
      if(!entries.length)return "";
      return `<section style="margin-top:20px"><h3 style="font-size:19px;margin-bottom:8px">${esc(title)}</h3><ul>${entries.map(item=>`<li><span>${esc(item.interpretation)}</span>${item.certainty==="tentative"?'<p class="note" style="margin:4px 0 0">아직 확인이 필요해요.</p>':""}${evidence(item.evidence)}</li>`).join("")}</ul></section>`;
    };
    const unknowns=Array.isArray(a.unknowns)?a.unknowns.filter(hasText):[];
    return `<details class="card relationship"${style?` style="${esc(style)}"`:""}>
      <summary style="cursor:pointer;font-family:var(--display);font-size:22px;color:var(--stem)">함께 살펴본 관계</summary>
      <p class="note" style="margin:12px 0 0">들려주신 내용을 바탕으로 살펴봤어요. 두 분의 마음이나 관계를 단정하는 내용은 아니에요.</p>
      ${[relation.label,relation.supporter_role].filter(hasText).length?`<p style="margin:14px 0 0">${[relation.label,relation.supporter_role].filter(hasText).map(esc).join(" · ")}</p>`:""}
      ${hasText(a.patient_summary)?`<section style="margin-top:18px"><h3 style="font-size:19px;margin-bottom:8px">그분의 상황</h3><p style="margin:0;white-space:pre-wrap">${esc(a.patient_summary)}</p></section>`:""}
      ${hasText(a.supporter_summary)?`<section style="margin-top:18px"><h3 style="font-size:19px;margin-bottom:8px">당신의 마음</h3><p style="margin:0;white-space:pre-wrap">${esc(a.supporter_summary)}</p></section>`:""}
      ${group("관계 특징",relation.dynamics)}${group("관계의 강점",relation.strengths)}${group("서로의 한계",relation.boundaries)}
      ${unknowns.length?`<section style="margin-top:20px"><h3 style="font-size:19px;margin-bottom:8px">아직 알기 어려운 부분</h3>${this.list(unknowns)}</section>`:""}
    </details>`;
  }
};
