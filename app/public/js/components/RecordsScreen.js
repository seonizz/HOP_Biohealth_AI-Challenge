// 4. 기록 화면: 완료 기록과 미완료 대화의 삭제
let curRec=null,pendingDel=null;
const RecordsScreen={
  render(){return `
<section class="screen" id="records" hidden>
  ${NavBar("records")}
  <p class="note">완료 기록을 삭제하면 관련 대화도 함께 삭제돼요. 미완료 대화는 이어가거나 삭제할 수 있어요. 마지막 이용 후 ${typeof API!=="undefined"&&API.retentionDays?API.retentionDays():30}일이 지나면 기록을 열 수 없고, 서버 운영 중 1시간 안에 자동 삭제돼요.</p>
  <details class="card" style="margin:0 24px 20px;padding:16px">
    <summary>보관키로 기록 열기</summary>
    <p class="note">보관키를 가진 사람은 해당 기록과 대화 내용을 볼 수 있어요. 키를 안전하게 보관해 주세요. 보유기간이 지나거나 키를 해제하면 열 수 없어요.</p>
    <label for="recordAccessKeyInput">보관키</label>
    <input id="recordAccessKeyInput" type="password" maxlength="43" autocomplete="off" spellcheck="false">
    <button class="ghost" id="openRecordWithKey">기록 열기</button>
    <p class="note" id="recordAccessKeyNotice" role="status"></p>
  </details>
  <details class="card" id="deletion-access" style="margin:0 24px 20px;padding:16px">
    <summary>쿠키를 잃어도 대화 삭제하기</summary>
    <p class="note">삭제 키를 따로 보관하면 쿠키 삭제·접근 기간 만료 후에도 해당 대화를 지울 수 있어요. 이 키로 내용을 열 수는 없어요. 키를 가진 사람은 대화를 삭제할 수 있으니 안전하게 보관해 주세요.</p>
    <button class="ghost" id="createDeletionKey">삭제 키 만들기</button>
    <p class="note" id="deletionKeyNotice" role="status"></p>
    <textarea id="deletionKeyOutput" aria-label="따로 보관할 삭제 키" readonly hidden rows="2" style="width:100%" autocomplete="off" spellcheck="false"></textarea>
    <div class="own" style="margin:12px 0"><label for="deletionKeyInput">보관한 삭제 키</label>
    <input id="deletionKeyInput" type="password" maxlength="43" autocomplete="off" spellcheck="false"></div>
    <button class="ghost" id="deleteWithKey">키로 대화 삭제</button>
    <p class="note" id="deleteWithKeyNotice" role="status"></p>
  </details>
  <div class="wrapk"><div class="rlist" id="rlist"></div><div class="rdetail" id="rdetail"></div></div>
</section>`;},
  mount(){
    $("openRecordWithKey").onclick=()=>this.openWithKey();
    $("createDeletionKey").onclick=()=>this.createKey();
    $("deleteWithKey").onclick=()=>this.removeWithKey();
    $("deletionKeyInput").oninput=()=>{this._pendingKey=null;$("deleteWithKey").textContent="키로 대화 삭제";$("deleteWithKeyNotice").textContent="";};
  },
  async openWithKey(){
    const input=$("recordAccessKeyInput"),notice=$("recordAccessKeyNotice"),button=$("openRecordWithKey");
    const key=input.value.trim();
    if(!/^[A-Za-z0-9_-]{43}$/.test(key)){notice.textContent="보관키 43자를 입력해 주세요.";return;}
    const sequence=this._openSequence=(this._openSequence||0)+1;
    button.disabled=true;notice.textContent="";
    try{
      const {record}=await API.request("/api/records/open-with-key",{method:"POST",body:{access_key:key}});
      if(sequence!==this._openSequence||$("records").hidden)return;
      input.value="";this.renderDetail(record,true);
      notice.textContent="보관키에 연결된 기록을 열었어요. 내 기록 목록에는 추가되지 않아요.";
    }catch(error){if(sequence===this._openSequence)notice.textContent=error.message;}
    finally{button.disabled=false;}
  },
  async manageAccessKey(id,revoke=false){
    const notice=$("recordKeyNotice"),output=$("recordKeyOutput");
    output.value="";output.hidden=true;
    $("createRecordKey").disabled=true;$("revokeRecordKey").disabled=true;
    try{
      const result=await API.request(`/api/records/${id}/access-key`,{method:revoke?"DELETE":"POST"});
      if(!revoke){output.value=result.access_key;output.hidden=false;}
      notice.textContent=revoke?"보관키를 해제했어요.":"이 키는 지금 한 번만 표시돼요. 따로 복사해 보관해 주세요. 이전 키는 사용할 수 없어요.";
    }catch(error){notice.textContent=error.message;}
    finally{if($("createRecordKey"))$("createRecordKey").disabled=false;if($("revokeRecordKey"))$("revokeRecordKey").disabled=false;}
  },
  async createKey(){
    const button=$("createDeletionKey"),notice=$("deletionKeyNotice");
    if(!this._confirmKey){this._confirmKey=true;button.textContent="새 삭제 키 발급 확인";notice.textContent="새 키를 만들면 이전 키는 사용할 수 없어요. 발급한 키를 따로 복사해 보관해 주세요.";return;}
    button.disabled=true;$("deletionKeyOutput").value="";$("deletionKeyOutput").hidden=true;
    try{
      const result=await API.request("/api/deletion-key",{method:"POST"});
      $("deletionKeyOutput").value=result.deletion_key;$("deletionKeyOutput").hidden=false;
      notice.textContent="이 키는 지금 한 번만 표시돼요. 새로고침하기 전에 따로 복사해 보관해 주세요.";
    }catch(error){notice.textContent=error.message+" 이전 키도 교체됐을 수 있어요. 발급 결과를 확인한 키만 보관해 주세요.";}
    finally{this._confirmKey=false;button.disabled=false;button.textContent="새 삭제 키 만들기";}
  },
  async removeWithKey(){
    if(this._deleting!=null)return;
    const input=$("deletionKeyInput"),key=input.value.trim(),button=$("deleteWithKey"),notice=$("deleteWithKeyNotice");
    if(!/^[A-Za-z0-9_-]{43}$/.test(key)){notice.textContent="보관한 삭제 키 43자를 입력해 주세요.";return;}
    if(this._pendingKey!==key){this._pendingKey=key;button.textContent="이 키의 대화 모두 삭제 확인";notice.textContent="이 키에 연결된 완료·미완료 대화를 모두 삭제해요. 지금 열린 기록과 다를 수 있고, 되돌릴 수 없어요.";return;}
    this._deleting="key";this._openSequence=(this._openSequence||0)+1;button.disabled=true;input.disabled=true;this.draw();
    try{
      await deleteConversations(key);this._openSequence=(this._openSequence||0)+1;
      input.value="";this._pendingKey=null;notice.textContent="이 키에 연결된 대화를 삭제했어요.";
    }catch(error){notice.textContent=error.message;}
    finally{this._deleting=null;button.disabled=false;input.disabled=false;button.textContent="키로 대화 삭제";this.draw();}
  },
  async open(id,refresh=true){
    if(id!=null)curRec=id;
    show("records");this.draw(id);
    if(!refresh)return;
    const sequence=this._openSequence=(this._openSequence||0)+1;
    try{
      const data=await API.request("/api/records");
      if(sequence!==this._openSequence||this._deleting!=null||$("records").hidden)return;
      setHistory(data);StartScreen.updRecN();if(!$("records").hidden)this.draw(id);
    }catch(error){if(sequence===this._openSequence&&!$("records").hidden)this.error(error.message);}
  },
  error(message){
    $("rlist").querySelector(".rec-error")?.remove();
    const note=document.createElement("p");note.className="note rec-error";note.setAttribute("role","status");note.textContent=message;$("rlist").appendChild(note);
  },
  draw(id){
    const recs=loadRecs();
    curRec=id??curRec??recs[0]?.id;
    if(!recs.find(r=>r.id===curRec))curRec=recs[0]?.id??null;
    if(!$("records").hidden&&typeof AppRouter!=="undefined")AppRouter.sync("records",{replace:true});
    this.renderList(recs);
    if(!recs.length){
      $("rdetail").innerHTML=`<div class="emptyr" style="height:100%"><div><img src="${M.hear}" alt=""><p>${loadIncomplete().length?"완료된 기록은 아직 없어요.<br>미완료 대화는 목록에서 이어가거나 삭제할 수 있어요.":"아직 저장된 대화가 없어요.<br>말씨와 대화를 나누면 여기에 모여요."}</p></div></div>`;
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
        <button class="ghost" data-intake-resume="${esc(row.id)}" ${busy?"disabled":""}>이어가기</button>
        <button class="x" data-intake-del="${esc(row.id)}" ${busy?"disabled":""} aria-label="${esc(row.title)} ${label('intake:'+row.id)}">${label('intake:'+row.id)}</button></div>`).join(""):"")+
      (recs.length?'<h3 class="record-heading">완료 기록</h3>'+recs.map(r=>`<div class="rcard" role="button" tabindex="0" data-id="${r.id}" aria-current="${r.id===curRec}">
        <img src="${M[r.profile.safety?"empathy":"basic"]}" alt=""><div><b>${esc(r.title)}</b><small>${[r.profile.rel,fmt(r.date)].filter(Boolean).map(esc).join(" · ")}</small></div>
        <button class="x" data-del="${r.id}" ${busy?"disabled":""} aria-label="${esc(r.title)} ${label('record:'+r.id)}">${label('record:'+r.id)}</button></div>`).join(""):"");
    $("rlist").querySelectorAll("[data-id]").forEach(c=>{c.onclick=e=>{if(e.target.dataset.del||busy)return;pendingDel=null;this.open(+c.dataset.id,false);};c.onkeydown=e=>{if(e.target===c&&e.key==="Enter")c.click();};});
    $("rlist").querySelectorAll("[data-del]").forEach(b=>b.onclick=()=>this.remove("record",+b.dataset.del));
    $("rlist").querySelectorAll("[data-intake-resume]").forEach(b=>b.onclick=()=>{if(!busy)return resumeConversation(b.dataset.intakeResume);});
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
  renderDetail(r,shared=false){
    const g=r.guide;
    $("rdetail").innerHTML=`<div class="pill">${[r.profile.rel,g.top+" 안내",`후속 질문 ${r.followUps||0}회`].filter(Boolean).map(esc).join(" · ")}</div>
      <h2 style="margin-top:10px">${esc(r.title)}</h2><p class="note" style="margin:2px 0 0">${fmt(r.date)}</p>
      ${r.profile.safety?GuideCards.safety("margin-top:18px"):""}
      ${g.care?`<div class="card care" style="margin-top:18px;padding:18px 22px"><img src="${M.empathy}" alt="" style="width:64px"><div><h3>당신의 마음도 소중해요</h3><p>${esc(g.care.feel)}</p>${GuideCards.tips(g.care.tips)}</div></div>`:""}
      <div style="margin-top:18px">${GuideCards.speech(g,r.conversation_detail,{copy:true,ids:false})}</div>
      ${GuideCards.doAvoid(g,{wrapStyle:"margin-top:16px",doStyle:"background:var(--bg)"})}
      <div style="margin-top:18px">${GuideCards.next(g)}</div>
      ${r.relationship_analysis?GuideCards.relationship(r.relationship_analysis,{style:"margin-top:18px;background:var(--bg)"}):""}
      <details class="card conversation-history"><summary>대화 기록</summary>
      <div class="tlog">${r.log.map(m=>`<div class="t ${m.who==="me"?"me2":"ai"+(m.fu?" fu":"")}">${esc(m.text)}</div>`).join("")}</div></details>`;
    if(!shared){
      $("rdetail").innerHTML+='<div class="actions" style="margin-top:18px"><button class="btn" id="recordContinue" type="button">추가 질문하기</button></div>';
      $("rdetail").innerHTML+=`<details class="card" style="margin-top:18px;padding:16px"><summary>이 기록의 보관키</summary>
        <p class="note">새 키를 만들면 이전 키는 사용할 수 없어요. 키를 가진 사람은 이 기록과 대화 내용을 볼 수 있어요.</p>
        <button class="ghost" id="createRecordKey">새 보관키 만들기</button>
        <button class="ghost" id="revokeRecordKey">보관키 해제</button>
        <p class="note" id="recordKeyNotice" role="status"></p>
        <textarea id="recordKeyOutput" aria-label="따로 보관할 보관키" readonly hidden rows="2" style="width:100%" autocomplete="off" spellcheck="false"></textarea></details>`;
      $("recordContinue").onclick=()=>ContinuationScreen.start(r.id);
      $("createRecordKey").onclick=()=>this.manageAccessKey(r.id);
      $("revokeRecordKey").onclick=()=>this.manageAccessKey(r.id,true);
    }
    GuideCards.bindCopy($("rdetail"),g.script);
    $("rdetail").scrollTop=0;
  }
};
