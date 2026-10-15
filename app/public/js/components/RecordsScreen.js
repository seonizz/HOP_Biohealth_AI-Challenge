// 4. 기록 화면: 완료 기록과 미완료 대화의 삭제
let curRec=null,pendingDel=null;
const RecordsScreen={
  render(){return `
<section class="screen" id="records" hidden>
  ${NavBar("records")}
  <p class="note">완료 기록을 삭제하면 관련 대화도 함께 삭제돼요. 미완료 대화도 아래에서 지울 수 있어요. 쿠키를 지우거나 접근 기간이 끝나면 기존 기록을 열거나 삭제할 수 없지만, 서버에 저장된 내용은 자동으로 삭제되지 않아요.</p>
  <div class="wrapk"><div class="rlist" id="rlist"></div><div class="rdetail" id="rdetail"></div></div>
</section>`;},
  mount(){},
  async open(id,refresh=true){
    show("records");this.draw(id);
    if(!refresh)return;
    const sequence=this._openSequence=(this._openSequence||0)+1;
    try{
      const data=await API.request("/api/records");
      if(sequence!==this._openSequence||this._deleting!=null)return;
      setHistory(data);StartScreen.updRecN();this.draw(id);
    }catch(error){if(sequence===this._openSequence)this.error(error.message);}
  },
  error(message){
    $("rlist").querySelector(".rec-error")?.remove();
    const note=document.createElement("p");note.className="note rec-error";note.setAttribute("role","status");note.textContent=message;$("rlist").appendChild(note);
  },
  draw(id){
    const recs=loadRecs();
    curRec=id??curRec??recs[0]?.id;
    if(!recs.find(r=>r.id===curRec))curRec=recs[0]?.id??null;
    this.renderList(recs);
    if(!recs.length){
      $("rdetail").innerHTML=`<div class="emptyr" style="height:100%"><div><img src="${M.hear}" alt=""><p>${loadIncomplete().length?"완료된 기록은 아직 없어요.<br>미완료 대화는 목록에서 삭제할 수 있어요.":"아직 저장된 대화가 없어요.<br>말씨와 대화를 나누면 여기에 모여요."}</p></div></div>`;
      return;
    }
    this.renderDetail(recs.find(x=>x.id===curRec));
  },
  renderList(recs){
    const incomplete=loadIncomplete(),busy=this._deleting!=null;
    const label=(key)=>this._deleting===key?"삭제 중":pendingDel===key?"정말 삭제":"삭제";
    $("rlist").innerHTML=`<div class="record-actions"><button class="ghost" id="deleteAll" ${busy||!recs.length&&!incomplete.length?"disabled":""}>${this._deleting==="all"?"삭제 중":pendingDel==="all"?"모두 삭제 확인":"내 대화 모두 삭제"}</button>
      ${pendingDel==="all"?'<p class="note" role="status">완료·미완료 대화와 결과를 모두 삭제해요. 되돌릴 수 없어요. 칼럼의 읽음·담음은 유지돼요.</p>':""}
      ${pendingDel&&!busy?'<button class="ghost" id="cancelDelete">삭제 취소</button>':""}</div>`+
      (incomplete.length?'<h3 class="record-heading">미완료 대화</h3>'+incomplete.map(row=>`<div class="rcard">
        <div><b>${esc(row.title)}</b><small>미완료 · ${esc(fmt(row.updated_at))}</small></div>
        <button class="x" data-intake-del="${esc(row.id)}" ${busy?"disabled":""} aria-label="${esc(row.title)} ${label('intake:'+row.id)}">${label('intake:'+row.id)}</button></div>`).join(""):"")+
      (recs.length?'<h3 class="record-heading">완료 기록</h3>'+recs.map(r=>`<div class="rcard" role="button" tabindex="0" data-id="${r.id}" aria-current="${r.id===curRec}">
        <img src="${M[r.profile.safety?"empathy":"basic"]}" alt=""><div><b>${esc(r.title)}</b><small>${[r.profile.rel,fmt(r.date)].filter(Boolean).map(esc).join(" · ")}</small></div>
        <button class="x" data-del="${r.id}" ${busy?"disabled":""} aria-label="${esc(r.title)} ${label('record:'+r.id)}">${label('record:'+r.id)}</button></div>`).join(""):"");
    $("rlist").querySelectorAll("[data-id]").forEach(c=>{c.onclick=e=>{if(e.target.dataset.del||busy)return;pendingDel=null;this.open(+c.dataset.id,false);};c.onkeydown=e=>{if(e.target===c&&e.key==="Enter")c.click();};});
    $("rlist").querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>this.remove("record",+b.dataset.del));
    $("rlist").querySelectorAll("[data-intake-del]").forEach(b=>b.onclick=()=>this.remove("intake",b.dataset.intakeDel));
    $("deleteAll").onclick=()=>this.remove("all");
    if($("cancelDelete"))$("cancelDelete").onclick=()=>{pendingDel=null;this.draw();};
  },
  async remove(kind,id){
    if(this._deleting!=null)return;
    const key=kind==="all"?"all":kind+":"+id;
    if(pendingDel!==key){pendingDel=key;this.draw();return;}
    this._deleting=key;this._openSequence=(this._openSequence||0)+1;this.draw();
    try{
      if(kind==="all")await deleteConversations();
      else if(kind==="intake")await deleteIntake(id);
      else await deleteRec(id);
      this._openSequence=(this._openSequence||0)+1;pendingDel=null;
      if(kind==="all"||kind==="record"&&curRec===id)curRec=null;
      this._deleting=null;this.draw();
    }catch(error){this._deleting=null;this.draw();this.error(error.message);}
  },
  renderDetail(r){
    const g=r.guide;
    $("rdetail").innerHTML=`<div class="pill">${[r.profile.rel,g.top+" 안내",`후속 질문 ${r.followUps||0}회`].filter(Boolean).map(esc).join(" · ")}</div>
      <h2 style="margin-top:10px">${esc(r.title)}</h2><p class="note" style="margin:2px 0 0">${fmt(r.date)}</p>
      ${r.profile.safety?GuideCards.safety("margin-top:18px"):""}
      ${g.care?`<div class="card care" style="margin-top:18px;padding:18px 22px"><img src="${M.empathy}" alt="" style="width:64px"><p>${esc(g.care.feel)}</p></div>`:""}
      <div class="card script" style="margin-top:18px"><h3>이렇게 시작해 보세요</h3><div style="white-space:pre-wrap">${esc(g.script)}</div></div>
      ${GuideCards.doAvoid(g,{wrapStyle:"margin-top:16px",doStyle:"background:var(--bg)"})}
      <p style="margin:16px 0 0;white-space:pre-wrap"><b style="font-family:var(--display);font-weight:400;color:var(--stem)">다음 단계</b> · ${esc(g.next)}</p>
      ${r.relationship_analysis?GuideCards.relationship(r.relationship_analysis,{style:"margin-top:18px;background:var(--bg)"}):""}
      <h3 style="font-family:var(--display);font-weight:400;font-size:20px;margin:26px 0 0">대화 기록</h3>
      <div class="tlog">${r.log.map(m=>`<div class="t ${m.who==="me"?"me2":"ai"+(m.fu?" fu":"")}">${esc(m.text)}</div>`).join("")}</div>`;
    $("rdetail").scrollTop=0;
  }
};
