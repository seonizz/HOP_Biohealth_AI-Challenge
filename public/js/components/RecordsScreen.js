// 4. 기록 화면: 좌 기록 목록 · 우 선택한 기록 상세
let curRec=null,pendingDel=null;
const RecordsScreen={
  render(){return `
<section class="screen" id="records" hidden>
  ${TopBar(`<span class="pill">내 기록</span><button class="ghost" id="recHome" style="margin-left:auto">처음으로</button><button class="btn" id="recNew" style="padding:10px 26px;font-size:18px">새 대화</button>`)}
  <div class="wrapk"><div class="rlist" id="rlist"></div><div class="rdetail" id="rdetail"></div></div>
</section>`;},
  mount(){
    $("recHome").onclick=()=>show("start");
    $("recNew").onclick=begin;
  },
  async open(id,refresh=true){
    show("records");this.draw(id);
    if(!refresh)return;
    const sequence=this._openSequence=(this._openSequence||0)+1;
    try{
      const data=await API.request("/api/records");
      if(sequence!==this._openSequence)return;
      setRecs(data.records);StartScreen.updRecN();this.draw(id);
    }catch(error){if(sequence===this._openSequence)this.error(error.message);}
  },
  error(message){
    $("rlist").querySelector(".rec-error")?.remove();
    const note=document.createElement("p");note.className="note rec-error";note.setAttribute("role","status");note.textContent=message;$("rlist").appendChild(note);
  },
  draw(id){
    const recs=loadRecs();
    if(!recs.length){$("rlist").innerHTML="";$("rdetail").innerHTML=`<div class="emptyr" style="height:100%"><div><img src="${M.hear}" alt=""><p>아직 저장된 기록이 없어요.<br>말씨와 대화를 마치면 여기에 모여요.</p></div></div>`;return;}
    curRec=id??curRec??recs[0].id; if(!recs.find(r=>r.id===curRec)) curRec=recs[0].id;
    this.renderList(recs);
    this.renderDetail(recs.find(x=>x.id===curRec));
  },
  renderList(recs){
    $("rlist").innerHTML=recs.map(r=>`<div class="rcard" role="button" tabindex="0" data-id="${r.id}" aria-current="${r.id===curRec}">
      <img src="${M[r.profile.safety?"empathy":"basic"]}" alt=""><div><b>${esc(r.title)}</b><small>${[r.profile.rel,fmt(r.date)].filter(Boolean).map(esc).join(" · ")}</small></div>
      <button class="x" data-del="${r.id}" ${this._deleting===r.id?"disabled":""}>${this._deleting===r.id?"삭제 중":pendingDel===r.id?"정말 삭제":"삭제"}</button></div>`).join("");
    $("rlist").querySelectorAll(".rcard").forEach(c=>{c.onclick=e=>{if(e.target.dataset.del)return;pendingDel=null;this.open(+c.dataset.id,false);};c.onkeydown=e=>{if(e.target===c&&e.key==="Enter")c.click();};});
    // 삭제는 두 번 눌러야 확정
    $("rlist").querySelectorAll("[data-del]").forEach(b=>b.onclick=async()=>{const id=+b.dataset.del;
      if(this._deleting!=null)return;
      if(pendingDel!==id){pendingDel=id;this.draw();return;}
      this._deleting=id;this._openSequence=(this._openSequence||0)+1;this.draw();
      try{await deleteRec(id);this._openSequence=(this._openSequence||0)+1;pendingDel=null;if(curRec===id)curRec=null;this._deleting=null;this.draw();}
      catch(error){this._deleting=null;this.draw();this.error(error.message);}
    });
  },
  renderDetail(r){
    const g=r.guide;
    $("rdetail").innerHTML=`<div class="pill">${[r.profile.rel,g.top+" 경향",`후속 질문 ${r.followUps||0}회`].filter(Boolean).map(esc).join(" · ")}</div>
      <h2 style="margin-top:10px">${esc(r.title)}</h2><p class="note" style="margin:2px 0 0">${fmt(r.date)}</p>
      ${r.profile.safety?GuideCards.safety("margin-top:18px"):""}
      ${g.care?`<div class="card care" style="margin-top:18px;padding:18px 22px"><img src="${M.empathy}" alt="" style="width:64px"><p>${esc(g.care.feel)}</p></div>`:""}
      <div class="card script" style="margin-top:18px"><h3>이렇게 시작해 보세요</h3><div style="white-space:pre-wrap">${esc(g.script)}</div></div>
      ${GuideCards.doAvoid(g,{wrapStyle:"margin-top:16px",doStyle:"background:var(--bg)"})}
      <p style="margin:16px 0 0"><b style="font-family:var(--display);font-weight:400;color:var(--stem)">다음 단계</b> · ${esc(g.next)}</p>
      <h3 style="font-family:var(--display);font-weight:400;font-size:20px;margin:26px 0 0">대화 기록</h3>
      <div class="tlog">${r.log.map(m=>`<div class="t ${m.who==="me"?"me2":"ai"+(m.fu?" fu":"")}">${esc(m.text)}</div>`).join("")}</div>`;
    $("rdetail").scrollTop=0;
  }
};
