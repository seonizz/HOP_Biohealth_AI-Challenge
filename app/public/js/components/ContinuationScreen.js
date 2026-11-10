// 완료 기록의 맥락으로 이어가는 별도 대화. 원래 결과 카드는 변경하지 않아요.
const ContinuationScreen={
  row:null,sourceRecord:null,sequence:0,busy:false,controller:null,retryAction:null,editing:null,draft:'',sessions:[],listSequence:0,listController:null,listError:'',
  render(){return `<section class="screen" id="continuation" hidden>
    ${NavBar("records")}
    <div class="continuation-wrap">
      <div class="continuation-heading"><div><h2>이어서 이야기해요</h2><p class="note">기존 이야기를 바탕으로 더 궁금한 점이나 달라진 상황을 들려주세요.</p></div><button class="ghost" id="continuationOriginal" type="button">원래 기록 보기</button></div>
      <details class="continuation-history"><summary>이 관계의 추가 대화</summary><div id="continuationSessions"></div><button class="ghost" id="continuationNew" type="button">새 대화 시작</button></details>
      <div id="continuationLog" class="continuation-log" role="log" aria-label="추가 대화"></div>
      <div id="continuationWaiting" class="ai-row" role="status" aria-label="답변을 준비하고 있어요" hidden><img src="${M.think}" alt=""><div class="msg dots"><span></span><span></span><span></span></div></div>
      <p class="note" id="continuationNotice" role="status"></p>
      <button class="ghost" id="continuationRetry" type="button" hidden>다시 시도</button>
      <form id="continuationForm" class="input">
        <label for="continuationText" id="continuationLabel">추가 질문이나 새로운 상황</label>
        <textarea id="continuationText" rows="3" maxlength="10000" placeholder="더 궁금한 점을 자유롭게 물어보세요."></textarea>
        <div class="actions"><button class="ghost" id="continuationCancelEdit" type="button" hidden>수정 취소</button><button class="ghost" id="continuationSkip" type="button" hidden>이 질문 건너뛰기</button><button class="btn" id="continuationSend" type="submit">보내기</button></div>
      </form>
      <div class="actions continuation-actions"><button class="btn" id="continuationCards" type="button">새 카드 만들기</button><button class="ghost" id="continuationComplete" type="button">여기까지 이야기하기</button><button class="ghost" id="continuationDelete" type="button">이 추가 대화 삭제</button></div>
      <p class="note">추가로 들려주신 상황을 반영한 새 카드를 만들 수 있어요. 원래 기록은 그대로 남아요.</p>
      <div id="continuationSummary"></div><div id="continuationCardsList"></div>
    </div>
  </section>`;},
  mount(){
    this.purgeDrafts();
    $("continuationForm").onsubmit=event=>{event.preventDefault();return this.send();};
    $("continuationText").oninput=()=>{this.draft=$("continuationText").value;this.saveDraft();};
    $("continuationOriginal").onclick=()=>RecordsScreen.open(Number(this.sourceRecord));
    $("continuationNew").onclick=()=>this.start(this.sourceRecord);
    $("continuationSkip").onclick=()=>this.send(true);
    $("continuationCards").onclick=()=>this.perform("cards");
    $("continuationComplete").onclick=()=>this.finish();
    $("continuationDelete").onclick=()=>this.remove();
    $("continuationCancelEdit").onclick=()=>{this.editing=null;this.draft='';this.saveDraft();this.draw();};
    $("continuationRetry").onclick=()=>this.retry();
  },
  draftKey(){
    if(typeof ConversationDrafts==="undefined"||!ConversationDrafts.storageKey)return null;
    return "malssi.continuation-drafts.v1."+ConversationDrafts.storageKey.replace(/^malssi\.conversation-drafts\.v1\./,"");
  },
  purgeDrafts(){
    try{
      const current=this.draftKey(),old=[];
      for(let index=0;index<sessionStorage.length;index++){
        const key=sessionStorage.key(index);
        if(key?.startsWith("malssi.continuation-drafts.v1.")&&key!==current)old.push(key);
      }
      old.forEach(key=>sessionStorage.removeItem(key));
    }catch{}
  },
  drafts(){
    try{
      const entries=JSON.parse(sessionStorage.getItem(this.draftKey())||"{}");
      return Object.fromEntries(Object.entries(entries).filter(([,entry])=>entry&&Date.now()-entry.at<86400000));
    }catch{return {};}
  },
  saveDraft(){
    const key=this.draftKey();if(!key||!this.row)return;
    try{
      const entries=this.drafts();
      if(this.draft)entries[this.row.id]={text:this.draft.slice(0,10000),editing:this.editing,sourceRecord:this.sourceRecord,at:Date.now()};else delete entries[this.row.id];
      sessionStorage.setItem(key,JSON.stringify(Object.fromEntries(Object.entries(entries).sort((a,b)=>b[1].at-a[1].at).slice(0,32))));
    }catch{ /* The current input remains usable when tab storage is unavailable. */ }
  },
  clearDraft(id){
    const key=this.draftKey();if(!key)return;
    try{const entries=this.drafts();delete entries[id];sessionStorage.setItem(key,JSON.stringify(entries));}catch{}
  },
  forget(recordId){
    this.purgeDrafts();
    const current=recordId===undefined||String(this.sourceRecord)===String(recordId);
    if(current)this.leave();
    try{
      const key=this.draftKey();
      if(key){
        if(recordId===undefined)sessionStorage.removeItem(key);
        else sessionStorage.setItem(key,JSON.stringify(Object.fromEntries(Object.entries(this.drafts()).filter(([id,entry])=>String(entry.sourceRecord)!==String(recordId)&&(!current||id!==this.row?.id)))));
      }
    }catch{}
    if(!current)return;
    this.row=null;this.sourceRecord=null;this.openingId=null;this.draft='';this.sessions=[];this.retryAction=null;
  },
  cancelList(){this.listSequence++;this.listController?.abort();this.listController=null;this.listError='';},
  leave(){this.saveDraft();this.sequence++;this.controller?.abort();this.controller=null;this.busy=false;this.cancelList();},
  active(sequence){return sequence===this.sequence&&!$("continuation").hidden;},
  notice(message){$("continuationNotice").textContent=message||'';},
  async start(recordId){
    if(this.busy)return;
    this.leave();this.row=null;this.openingId=null;this.sourceRecord=String(recordId);this.draft='';this.editing=null;this.sessions=[];this.retryAction=null;this.deleteConfirmed=false;
    const sequence=this.sequence;show("continuation");this.busy=true;this.draw();
    const same=this.startRequest?.recordId===this.sourceRecord;
    const request=same?this.startRequest:{recordId:this.sourceRecord,body:{request_id:crypto.randomUUID(),conversation_epoch:conversationEpoch}};
    this.startRequest=request;this.controller=new AbortController();let refreshList=false;
    try{
      const data=await API.request(`/api/records/${encodeURIComponent(this.sourceRecord)}/continuations`,{method:"POST",body:request.body,signal:this.controller.signal});
      if(!this.active(sequence))return;
      this.startRequest=null;this.accept(data.continuation,true);this.notice('');
      AppRouter.sync("continuation",{replace:true});refreshList=true;
    }catch(error){if(this.active(sequence)){this.notice(error.message);this.retryAction={action:"start",recordId};}}
    finally{if(this.active(sequence)){this.busy=false;this.controller=null;this.draw();if(refreshList)void this.list(sequence);}}
  },
  async open(id){
    this.leave();this.row=null;this.draft='';this.editing=null;this.sessions=[];this.retryAction=null;this.deleteConfirmed=false;
    // Retain the route ID while the owning record is fetched.
    this.openingId=id;const sequence=this.sequence;show("continuation");this.busy=true;this.draw();this.controller=new AbortController();let refreshList=false;
    try{
      const data=await API.request(`/api/continuations/${encodeURIComponent(id)}`,{signal:this.controller.signal});
      if(!this.active(sequence))return;
      this.accept(data.continuation,true);this.notice('');refreshList=true;
    }catch(error){if(this.active(sequence)){this.notice(error.message);this.retryAction=error.status===404?null:{action:"open",id};}}
    finally{if(this.active(sequence)){this.openingId=null;this.busy=false;this.controller=null;this.draw();if(refreshList)void this.list(sequence);}}
  },
  accept(row,restoreDraft=false){
    this.row=row;this.sourceRecord=String(row.source_record_id);
    if(restoreDraft){const draft=this.drafts()[row.id];this.draft=draft?.text||'';this.editing=draft?.editing||null;}
    if(row.status==='completed')this.editing=null;
    if(row.pending&&!this.retryAction){
      const pending=row.pending,action=pending.action||'messages';
      this.retryAction={action,body:{...(pending.input||{text:pending.text||'',...(pending.reply_to?{reply_to:pending.reply_to}:{}),...(pending.skipped?{skipped:true}:{})}),request_id:pending.request_id,revision:row.revision}};
    }
  },
  async list(sequence=this.sequence){
    if(!this.active(sequence)||!this.sourceRecord||!this.row)return;
    this.cancelList();
    const request=this.listSequence,recordId=this.sourceRecord,id=this.row?.id,revision=this.row?.revision,controller=new AbortController();
    this.listController=controller;
    const current=()=>this.active(sequence)&&request===this.listSequence&&!controller.signal.aborted&&
      this.sourceRecord===recordId&&this.row?.id===id&&this.row?.revision===revision;
    try{
      const data=await API.request(`/api/records/${encodeURIComponent(recordId)}/continuations`,{signal:controller.signal});
      if(current()){this.sessions=data.continuations||[];this.listError='';this.drawSessions();}
    }catch(error){if(current()){this.listError=error.message;this.drawSessions();}}
    finally{if(this.listController===controller)this.listController=null;}
  },
  drawSessions(){
    $("continuationSessions").innerHTML=this.sessions.map(session=>`<button class="ghost" type="button" data-continuation-id="${esc(session.id)}"${this.busy?' disabled':''}>${esc(fmt(session.created_at||session.updated_at))} · ${session.status==='completed'?'마친 대화':'이어가기'}</button>`).join('')+(this.listError?`<p class="note" role="status">${esc(this.listError)}</p>`:'');
    $("continuationSessions").querySelectorAll('[data-continuation-id]').forEach(button=>button.onclick=()=>this.open(button.dataset.continuationId));
  },
  latestClarification(){const last=this.row?.messages?.at(-1);return last?.role==='assistant'&&typeof last.clarification==='string'&&last.clarification?last:null;},
  draw(){
    const row=this.row,completed=row?.status==='completed',waiting=this.busy,pending=Boolean(row?.pending);
    $("continuationWaiting").hidden=!waiting;
    $("continuationLog").innerHTML=(row?.messages||[]).map(message=>{
      const user=message.role==='user';
      const text=message.kind==='skipped'?'이 질문은 건너뛰었어요.':message.text;
      return `<div class="continuation-message ${user?'continuation-user':'continuation-assistant'}"><div class="${user?'msg me':'ai-row'}">${user?'':`<img src="${M.hear}" alt="말씨"><div class="msg">`}${esc(text||'')}${!user&&message.clarification?`<p>${esc(message.clarification)}</p>`:''}${user?'':'</div>'}</div>${user&&!completed&&message.kind!=='skipped'?`<button class="ghost" type="button" data-correct-message="${esc(message.id)}"${waiting?' disabled':''}>이 내용 수정</button>`:''}</div>`;
    }).join('');
    $("continuationLog").querySelectorAll('[data-correct-message]').forEach(button=>button.onclick=()=>this.correct(button.dataset.correctMessage));
    $("continuationForm").hidden=!row||completed;
    $("continuationText").value=this.draft;
    $("continuationText").disabled=completed;
    $("continuationSend").disabled=!row||waiting||(pending&&!this.editing)||completed;
    $("continuationSend").textContent=this.editing?'수정 내용 보내기':'보내기';
    $("continuationLabel").textContent=this.editing?'이전에 보낸 내용 수정':'추가 질문이나 새로운 상황';
    $("continuationCancelEdit").hidden=!this.editing;
    $("continuationCancelEdit").disabled=waiting;
    $("continuationSkip").hidden=!this.latestClarification()||Boolean(this.editing)||completed;
    $("continuationSkip").disabled=waiting||pending;
    $("continuationCards").disabled=!row||waiting||pending||!(row.messages||[]).some(m=>m.role==='user'&&m.kind!=='skipped');
    $("continuationComplete").hidden=completed;
    $("continuationComplete").disabled=!row||(waiting&&this.action==='complete');
    $("continuationDelete").disabled=!row||waiting;
    $("continuationDelete").textContent=this.deleteConfirmed?'추가 대화 삭제 확인':'이 추가 대화 삭제';
    $("continuationOriginal").disabled=!this.sourceRecord;
    $("continuationNew").disabled=!this.sourceRecord||waiting;
    $("continuationRetry").hidden=!this.retryAction||waiting;
    $("continuationSummary").innerHTML=(row?.safety_urgent&&completed?GuideCards.safety():'')+(row?.summary?`<section class="card continuation-summary"><h3>이번 이야기</h3><p>${esc(row.summary)}</p></section>`:'');
    this.drawSessions();this.drawCards();
  },
  drawCards(){
    const cards=this.row?.cards||[];
    $("continuationCardsList").innerHTML=cards.map((card,index)=>`<section class="continuation-card-set" data-card-index="${index}"><h3>추가 상황으로 만든 카드</h3><p class="note">${esc(fmt(card.date))} · 저장했어요.</p><div class="cards">${card.profile?.safety?GuideCards.safety():''}${GuideCards.care(card.guide.care)}${GuideCards.speech(card.guide,card.conversation_detail,{copy:true,ids:false})}${GuideCards.doAvoid(card.guide)}${GuideCards.next(card.guide)}${card.relationship_analysis?GuideCards.relationship(card.relationship_analysis):''}</div></section>`).join('');
    $("continuationCardsList").querySelectorAll('[data-card-index]').forEach(node=>GuideCards.bindCopy(node,cards[Number(node.dataset.cardIndex)].guide.script));
  },
  correct(id){
    if(this.busy)return;
    const message=this.row?.messages.find(m=>m.id===id&&m.role==='user');if(!message)return;
    this.cancelList();
    this.editing=id;this.draft=message.text;this.retryAction=null;this.deleteConfirmed=false;this.saveDraft();this.draw();$("continuationText").focus();
  },
  async send(skipped=false){
    if(this.busy||!this.row||(this.row.pending&&!this.editing))return;
    const text=$("continuationText").value;
    if(!skipped&&!hasAnswerContent(text)){this.notice('질문이나 상황을 입력해 주세요.');return;}
    if(this.editing){
      const retry=this.retryAction;
      if(retry?.action==='corrections'&&retry.body?.answer_ref===this.editing&&retry.body.replacement===text)return this.perform('corrections',{},retry.body);
      return this.perform('corrections',{answer_ref:this.editing,replacement:text});
    }
    const clarification=this.latestClarification();
    const retry=this.retryAction;
    // The server may have saved a turn even when its response was lost. The
    // ordinary Send button must retain the same replay key just like Retry.
    if(retry?.action==='messages'&&retry.body?.text===(skipped?'':text)&&Boolean(retry.body.skipped)===skipped&&
      (!skipped||retry.body.reply_to===clarification?.id))return this.perform('messages',{},retry.body);
    return this.perform('messages',{text:skipped?'':text,...(clarification?{reply_to:clarification.id}:{}),...(skipped?{skipped:true}:{})});
  },
  async perform(action,input={},retryBody){
    if(this.busy||!this.row)return;
    if(action==='cards'&&hasAnswerContent(this.draft)){this.notice('작성한 내용을 먼저 보내면 새 카드에 반영할 수 있어요.');return;}
    this.cancelList();
    const sequence=this.sequence,id=this.row.id;
    const body=retryBody?{...retryBody,revision:this.row.revision}:{revision:this.row.revision,request_id:crypto.randomUUID(),...input};
    this.retryAction={action,body};this.action=action;this.busy=true;this.deleteConfirmed=false;this.controller=new AbortController();this.notice('');
    const submitted=action==='messages'?body.text:action==='corrections'?body.replacement:null;
    if(submitted!==null&&this.draft===submitted){this.draft='';this.saveDraft();}
    this.draw();let refreshList=false;
    try{
      const data=await API.request(`/api/continuations/${encodeURIComponent(id)}/${action}`,{method:'POST',body,signal:this.controller.signal});
      if(!this.active(sequence))return;
      this.retryAction=null;this.editing=null;this.accept(data.continuation);this.saveDraft();
      this.notice('');
      if(action==='cards')this.notice('추가로 들려주신 상황을 반영한 카드를 저장했어요.');
      if(action==='complete')this.notice('여기까지의 대화를 저장했어요.');
      refreshList=true;
    }catch(error){
      if(!this.active(sequence))return;
      if(submitted!==null&&!this.draft)this.draft=submitted;
      try{const current=await API.request(`/api/continuations/${encodeURIComponent(id)}`);if(this.active(sequence))this.accept(current.continuation);}catch(recovery){if(recovery.status===404&&this.active(sequence)){this.row=null;this.retryAction=null;this.clearDraft(id);}}
      if(this.active(sequence)){if(error.status===409&&!this.row?.pending)this.retryAction=null;this.notice(error.message);this.saveDraft();}
    }finally{if(this.active(sequence)){this.busy=false;this.controller=null;this.draw();if(refreshList)void this.list(sequence);}}
  },
  async finish(){
    if(!this.row||this.row.status==='completed'||(this.busy&&this.action==='complete'))return;
    if(hasAnswerContent(this.draft)){this.notice('아직 보내지 않은 내용이 있어요. 보내거나 입력을 지운 뒤 마칠 수 있어요.');return;}
    if(this.busy){
      this.controller?.abort();this.sequence++;this.cancelList();this.busy=true;this.action='complete';this.draw();
      const sequence=this.sequence,id=this.row.id;
      try{
        const data=await API.request(`/api/continuations/${encodeURIComponent(id)}`);
        if(!this.active(sequence))return;
        this.accept(data.continuation);this.busy=false;
        if(this.row.status==='completed'){this.retryAction=null;this.draw();return;}
      }catch(error){if(this.active(sequence)){this.busy=false;this.notice(error.message);this.draw();}return;}
    }
    return this.perform('complete');
  },
  retry(){
    const retry=this.retryAction;if(!retry||this.busy)return;
    if(retry.action==='start')return this.start(retry.recordId);
    if(retry.action==='open')return this.open(retry.id);
    return this.perform(retry.action,{},retry.body);
  },
  async remove(){
    if(this.busy||!this.row)return;
    this.cancelList();
    if(!this.deleteConfirmed){this.deleteConfirmed=true;this.notice('이 추가 대화와 여기서 만든 카드를 삭제해요. 원래 기록은 남아요.');this.draw();return;}
    const id=this.row.id,recordId=this.sourceRecord,sequence=this.sequence;
    this.busy=true;this.draw();
    try{
      await API.request(`/api/continuations/${encodeURIComponent(id)}`,{method:'DELETE'});
      if(!this.active(sequence))return;
      this.draft='';this.clearDraft(id);this.row=null;this.retryAction=null;this.sessions=[];this.busy=false;
      await RecordsScreen.open(Number(recordId));
    }catch(error){if(this.active(sequence))this.notice(error.message);}
    finally{if(this.active(sequence)){this.busy=false;this.deleteConfirmed=false;this.draw();}}
  }
};
