// 4. 기록 화면: 좌 기록 목록 · 우 선택한 기록 상세
let curRec=null,pendingDel=null;
const RecordsScreen={
  render(){return `
<section class="screen" id="records" hidden>
  ${NavBar("records")}
  <div class="wrapk"><div class="rlist" id="rlist"></div><div class="rdetail" id="rdetail"></div></div>
  <p class="note" style="margin:12px 0 0">기록은 이 브라우저에만 저장돼요. 다른 기기에서는 보이지 않아요.</p>
</section>`;},
  mount(){},
  open(id){
    const recs=loadRecs();show("records");
    if(!recs.length){$("rlist").innerHTML="";$("rdetail").innerHTML=`<div class="emptyr" style="height:100%"><div><img src="${M.hear}" alt=""><p>아직 저장된 기록이 없어요.<br>말씨와 대화를 마치면 여기에 모여요.</p></div></div>`;return;}
    curRec=id??curRec??recs[0].id; if(!recs.find(r=>r.id===curRec)) curRec=recs[0].id;
    this.renderList(recs);
    this.renderDetail(recs.find(x=>x.id===curRec));
  },
  renderList(recs){
    $("rlist").innerHTML=recs.map(r=>`<div class="rcard" role="button" tabindex="0" data-id="${r.id}" aria-current="${r.id===curRec}">
      <img src="${M[r.profile.safety?"empathy":"basic"]}" alt=""><div><b>${esc(r.title)}</b><small>${[r.profile.rel,fmt(r.date)].filter(Boolean).map(esc).join(" · ")}</small></div>
      <button class="x" data-del="${r.id}">${pendingDel===r.id?"정말 삭제":"삭제"}</button></div>`).join("");
    $("rlist").querySelectorAll(".rcard").forEach(c=>{c.onclick=e=>{if(e.target.dataset.del)return;pendingDel=null;this.open(+c.dataset.id);};c.onkeydown=e=>{if(e.key==="Enter")c.click();};});
    // 삭제는 두 번 눌러야 확정
    $("rlist").querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>{const id=+b.dataset.del;
      if(pendingDel===id){saveRecs(loadRecs().filter(r=>r.id!==id));pendingDel=null;curRec=null;}else pendingDel=id;this.open();});
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
