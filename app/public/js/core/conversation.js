// 질문 진행·환자 상태 구성·모델 응답·기록 저장은 서버가 담당해요.
let S;
let conversationToken=0;
let resumingConversationId=null;
let conversationRequest=null;
let conversationProgress=null;
let finishingConversation=null;
function cancelConversationRequest(){
  conversationProgress?.();
  if(finishingConversation)finishingConversation.cancelled=true;
  if(!conversationRequest)return;
  const request=conversationRequest;conversationRequest=null;conversationToken++;request.abort();
}
async function requestConversation(path,options={},token){
  if(token!==conversationToken)throw Object.assign(new Error("요청을 취소했어요."),{status:499,code:"REQUEST_CANCELLED"});
  const controller=typeof AbortController==="function"?new AbortController():null;
  conversationRequest?.abort();conversationRequest=controller;
  try{
    const onEvent=typeof options.onEvent==="function"?(type,data)=>{
      if(token===conversationToken&&!controller?.signal.aborted&&conversationRequest===controller)options.onEvent(type,data);
    }:undefined;
    const result=await API.request(path,{...options,...(onEvent?{onEvent}:{}),...(controller?{signal:controller.signal}:{})});
    if(token!==conversationToken||controller?.signal.aborted||conversationRequest!==controller)throw Object.assign(new Error("요청을 취소했어요."),{status:499,code:"REQUEST_CANCELLED"});
    return result;
  }
  finally{if(conversationRequest===controller)conversationRequest=null;}
}
// 서버에서 호칭을 치환한 문구도 그대로 표시할 수 있어요.
const nm=t=>String(t).replace(/\{name(?::([^}]+))?\}/g,(_,j)=>{const w=S?.name||"그분";return j?w+josa(w,j):w;});

function leaveConversation(){ChatScreen.leave(()=>{cancelConversationRequest();conversationToken++;ChatScreen.think(false);show("start");window.scrollTo(0,0);});}
function forgetConversation(id){
  // A history fetch may still be pending after navigating to the chat screen.
  if(typeof RecordsScreen!=="undefined")RecordsScreen._openSequence=(RecordsScreen._openSequence||0)+1;
  if(id&&S?.id!==id&&resumingConversationId!==id)return;
  cancelConversationRequest();
  if(typeof ReferralGuide!=="undefined")ReferralGuide.invalidate();
  resumingConversationId=null;
  conversationToken++;S=null;ChatScreen.clear();ChatInput.clear();ChatScreen.title("");
  if($("rbody"))$("rbody").innerHTML="";
}
async function deleteCurrentConversation(){
  if(!S?.id)return;
  const id=S.id;
  await deleteIntake(id);
  // Deletion invalidates an older history fetch; redraw its already-filtered cache.
  if(typeof RecordsScreen!=="undefined"&&!$("records").hidden){RecordsScreen.draw();return;}
  // The response may arrive after a browser navigation or another chat has opened.
  if(S||resumingConversationId||($("chat").hidden&&$("result").hidden))return;
  if(typeof AppRouter!=="undefined"&&AppRouter.active&&!['chat','result'].some(screen=>window.location.pathname===`/${screen}/${encodeURIComponent(id)}`))return;
  show("start");window.scrollTo(0,0);
}
async function begin(){
  // Wait for the deletion result before a new conversation can use its epoch.
  if(deletingConversations)return;
  if(typeof ConversationDrafts!=="undefined")ConversationDrafts.save();
  cancelConversationRequest();
  if(typeof RecordsScreen!=="undefined")RecordsScreen._openSequence=(RecordsScreen._openSequence||0)+1;
  if(typeof ReferralGuide!=="undefined")ReferralGuide.invalidate();
  resumingConversationId=null;
  const token=++conversationToken,epoch=conversationEpoch;
  S=null;ChatScreen.clear();ChatScreen.progress(0);ChatScreen.title("");ChatScreen.section("");ChatInput.clear();show("chat");ChatInput.waitForQuestion?.();
  try{
    const view=await ChatScreen.typing("hello",()=>token===conversationToken?API.request("/api/intakes",{method:"POST",body:{conversation_epoch:epoch}}):null);
    if(token===conversationToken)renderConversation(view,token,ChatInput.typeAhead?.()||"");
  }catch(error){
    if(error.code==="CONVERSATIONS_CHANGED"&&token===conversationToken){
      try{const data=await API.request("/api/records");if(token===conversationToken)setHistory(data);}
      catch(readError){error=readError;}
    }
    if(token===conversationToken)ChatInput.error(error.message,()=>begin());
  }
}


async function resumeConversation(id){
  if(deletingConversations||typeof RecordsScreen!=="undefined"&&RecordsScreen._deleting!=null)return;
  if(typeof ConversationDrafts!=="undefined")ConversationDrafts.save();
  cancelConversationRequest();
  if(typeof RecordsScreen!=="undefined")RecordsScreen._openSequence=(RecordsScreen._openSequence||0)+1;
  if(typeof ReferralGuide!=="undefined")ReferralGuide.invalidate();
  const token=++conversationToken;
  resumingConversationId=id;S=null;
  ChatScreen.clear();ChatScreen.progress(0);ChatScreen.title("");ChatScreen.section("");ChatInput.clear();show("chat");ChatInput.waitForQuestion?.();
  const current=()=>token===conversationToken&&!$("chat").hidden;
  try{
    const view=await ChatScreen.typing("ponder",()=>current()?API.request(`/api/intakes/${encodeURIComponent(id)}`):null);
    if(current())renderConversation(view,token,ChatInput.typeAhead?.()||"");
  }catch(error){
    if(current())ChatInput.error(error.message,error.status===404?null:()=>resumeConversation(id));
  }finally{if(token===conversationToken&&S?.id===id)resumingConversationId=null;}
}

function renderConversation(view,token,nextText="",helpDraft=null){
  if(token!==conversationToken)return;
  if(typeof ConversationDrafts!=="undefined")ConversationDrafts.save();
  ChatScreen.think(false);
  S=view;
  if(typeof AppRouter!=="undefined")AppRouter.sync("chat",{replace:true});
  ChatScreen.sync(view.log);ChatScreen.progress(view.progress,{index:view.questionIndex,total:view.totalQuestions,label:view.section,complete:view.status==="ready"});ChatScreen.title(view.chat_title);ChatScreen.section(view.section);
  ChatInput.clear();
  if(view.user_stopped&&!view.safety_urgent&&!view.safety_review_pending&&!view.model_pending){
    ChatInput.error("대화를 여기서 마쳤어요. 새 대화는 처음 화면에서 시작할 수 있어요.");
    return;
  }
  if(view.status==="ready"){finish(token);return;}
  if(view.input_locked&&view.model_pending&&view.pending_answer){
    const body={...view.pending_answer,revision:view.revision};
    ChatInput.error("질문은 여기서 마쳤어요. 저장한 답변의 확인을 다시 시도할 수 있어요.",
      ()=>submitConversation(`/api/intakes/${view.id}/answers`,body,token));
    return;
  }
  const q=view.question;
  ChatInput.render(q,(text,selected,custom="",skipped=false,responseEvent)=>answer(text,selected,custom,skipped,responseEvent),view.canGoBack?goBack:null);
  const restored=typeof ConversationDrafts!=="undefined"&&ConversationDrafts.restore(view);
  if(helpDraft){
    ChatInput.restoreDraft(helpDraft);
    if(typeof ConversationDrafts!=="undefined")ConversationDrafts.save(true);
  }
  if(!view.model_pending){
    ChatInput.acceptTypeAhead?.(nextText);
    if(nextText&&typeof ConversationDrafts!=="undefined")ConversationDrafts.save(true);
  }
  if(view.model_pending&&view.pending_answer){
    const body={...view.pending_answer,revision:view.revision};
    const pendingDraft=pendingAnswerDraft(q,body);
    if(!restored)ChatInput.restoreDraft(pendingDraft);
    if(nextText){
      ChatInput.nextText=nextText;ChatInput.showTypeAhead?.();
      const field=$("input").querySelector("#next-answer");if(field)field.value=nextText;
      if(typeof ConversationDrafts!=="undefined")ConversationDrafts.save(true);
    }
    const resume=()=>submitConversation(`/api/intakes/${view.id}/answers`,body,token,{who:"me",text:body.text,fu:!!body.follow_up});
    const draft=ChatInput.captureDraft();
    const sameDraft=JSON.stringify(draft&&{text:draft.text,own:draft.own,selected:draft.selected,detailOption:draft.detailOption})===JSON.stringify(pendingDraft);
    if(!restored||sameDraft)void ChatInput.run(resume);
    else ChatInput.error("전송한 답변은 저장되어 있어요. 작성 중인 내용을 보내거나 저장된 답변을 이어서 준비할 수 있어요.",resume);
  }
}

function pendingAnswerDraft(question,body){
  const selected=Array.isArray(body.selected)?body.selected:[];
  const option=question.type==="one"&&selected.length===1?question.opts[selected[0]]:null;
  const detailOption=option&&optMeta(option).input?selected[0]:null;
  let text=body.skipped?"":body.text||"";
  if(detailOption!==null){
    const label=optLabel(option),prefix=label+", ";
    text=text===label?"":text.startsWith(prefix)?text.slice(prefix.length):text;
  }
  return {text:question.type==="text"||detailOption!==null?text:"",own:body.custom||"",selected:detailOption!==null?[]:selected,detailOption};
}

function conversationErrorMessage(error){
  const messages={
    MODEL_UNAVAILABLE:"답변 서버에 잠시 연결하지 못했어요. 대화 내용은 저장되어 있으니 잠시 후 다시 시도해 주세요.",
    MODEL_INVALID_RESPONSE:"답변을 다시 확인했지만 아직 준비하지 못했어요. 대화 내용은 저장되어 있으니 다시 시도해 주세요.",
    MODEL_TIMEOUT:"답변을 다시 준비하고 있어요. 입력한 내용은 저장되어 있어요.",
    MODEL_CONTEXT_TOO_LONG:"한 번에 처리할 내용이 많아요. 입력한 답변을 수정한 뒤 다시 시도해 주세요.",
    MODEL_AUTH_FAILED:"답변 서비스의 연결 설정을 확인해야 해요. 대화 내용은 저장되어 있어요.",
    MODEL_NOT_CONFIGURED:"답변 서비스의 연결 설정을 확인해야 해요. 대화 내용은 저장되어 있어요.",
    MODEL_NOT_CONNECTED:"답변 서비스의 연결 설정을 확인해야 해요. 대화 내용은 저장되어 있어요.",
  };
  return messages[error.code]||(error.code?.startsWith("MODEL_")?"답변을 준비하지 못했어요. 대화 내용은 저장되어 있으니 다시 시도해 주세요.":error.message);
}

// A first help response redisplays the same v3 instance without consuming its answer.
// Carry the editor only across that confirmed response, never another question or stop.
function retainedHelpDraft(before,after,input){
  const question=before?.question,next=after?.question;
  if(input?.response_event!=="not_understood"||!before?.bundle_id||after?.bundle_id!==before.bundle_id||
    after.id!==before.id||after.status!=="active"||after.model_pending||after.user_stopped||after.input_locked||
    !Number.isInteger(after.revision)||after.revision<=before.revision||!question?.instance_id||
    next?.instance_id!==question.instance_id||next.id!==question.id||!!next.follow_up!==!!question.follow_up||
    input.question_id!==question.id||input.instance_id!==question.instance_id)return null;
  return ChatInput.captureDraft();
}

async function recoverConversation(error,token,retry,present=(message,operation)=>ChatInput.error(message,operation),current=()=>token===conversationToken,submittedAnswer=null){
  if(error.code==="REQUEST_CANCELLED")return;
  if(!current())return;
  const modelError=error.code?.startsWith("MODEL_");
  // 저장된 대기 답변의 버전을 읽어 수정·되돌리기가 이전 요청을 덮어쓰지 않게 해요.
  if((error.status===0||error.status===409||(modelError&&S?.question))&&S?.id){
    try{
      const id=S.id;
      const view=await ChatScreen.typing(S?.question?.face||"ponder",()=>current()?API.request(`/api/intakes/${id}`):null);
      if(!current())return;
      if(view.input_locked){renderConversation(view,token);return;}
      if(view.model_pending&&view.question?.id===S.question?.id&&!!view.question.follow_up===!!S.question.follow_up){
        // 같은 질문의 입력창은 유지하여 실패 직후에도 답을 수정할 수 있어요.
        if(typeof ConversationDrafts!=="undefined")ConversationDrafts.rebind(view);
        S=view;ChatScreen.sync(view.log);
      }else{
        if(view.status==="ready"&&view.revision===S.revision){present(conversationErrorMessage(error),retry);return;}
        const nextText=ChatInput.typeAhead?.()||"";
        const helpDraft=retainedHelpDraft(S,view,submittedAnswer);
        if(typeof ConversationDrafts!=="undefined")ConversationDrafts.clear(S);
        renderConversation(view,token,helpDraft?"":nextText,helpDraft);return;
      }
    }catch(readError){error=readError;}
  }
  if(current())present(conversationErrorMessage(error),retry);
}

async function submitConversation(path,body,token,message,detailPrompt){
  if(token!==conversationToken)return;
  const submittedView=S;
  if(typeof ConversationDrafts!=="undefined")ConversationDrafts.save();
  if(typeof ReferralGuide!=="undefined")ReferralGuide.invalidate();
  // 전송한 말은 즉시 보여 주고, 다음 질문은 모델 응답 뒤 서버 기록으로 확정해요.
  // 재시도나 답변 수정도 같은 서버 기록 뒤에 표시하므로 말풍선이 중복되지 않아요.
  let log=pendingConversationLog();
  if(message&&!detailPrompt)detailPrompt=answerDetailPrompt(S.question,body.selected||[]);
  if(detailPrompt&&!sameDetailPrompt(log.at(-1),detailPrompt))log=[...log,detailPrompt];
  if(message)ChatScreen.sync([...log,message]);
  if(message||path.endsWith("/back"))ChatInput.waitForQuestion?.();
  try{
    const onEvent=(type,data)=>{
      if(type!=="progress"||token!==conversationToken||S!==submittedView||data.revision!==body.revision)return;
      if(typeof ChatScreen.thinkProgress==="function")ChatScreen.thinkProgress(data.progress);
    };
    const view=await ChatScreen.typing(S?.question?.face||"ponder",()=>token===conversationToken?requestConversation(path,{method:"POST",body,onEvent},token):null);
    if(token===conversationToken){
      const nextText=ChatInput.typeAhead?.()||"";
      const helpDraft=retainedHelpDraft(submittedView,view,body);
      if(message&&typeof ConversationDrafts!=="undefined")ConversationDrafts.clear(submittedView);
      renderConversation(view,token,helpDraft?"":nextText,helpDraft);
    }
  }catch(error){await recoverConversation(error,token,()=>submitConversation(path,{...body,revision:S.revision},token,message,detailPrompt),undefined,undefined,body);}
}

function pendingConversationLog(){
  let log=S.model_pending&&S.log.at(-1)?.who==="me"?S.log.slice(0,-1):S.log;
  if(S.model_pending){
    const previous=answerDetailPrompt(S.question,S.pending_answer?.selected||[]);
    if(previous&&sameDetailPrompt(log.at(-1),previous))log=log.slice(0,-1);
  }
  return log;
}

function answerDetailPrompt(question,selected){
  const meta=question?.type==="one"&&selected.length===1?optMeta(question.opts[selected[0]]):{};
  return meta.input&&meta.ask?{who:"ai",text:meta.ask,face:question.face||"ponder",fu:true}:null;
}
const sameDetailPrompt=(message,prompt)=>message?.who==="ai"&&message.text===prompt.text&&message.face===prompt.face&&message.fu===true;

function answer(text,selected,custom="",skipped=false,responseEvent){
  if(!S?.question)return;
  const body={revision:S.revision,question_id:S.question.id,text,selected,custom,skipped,follow_up:!!S.question.follow_up};
  if(responseEvent)body.response_event=responseEvent;
  if(S.question.instance_id)body.instance_id=S.question.instance_id;
  const detailPrompt=answerDetailPrompt(S.question,selected);
  return submitConversation(`/api/intakes/${S.id}/answers`,body,conversationToken,{who:"me",text,fu:body.follow_up},detailPrompt);
}

function goBack(){
  if(!S?.canGoBack)return;
  return submitConversation(`/api/intakes/${S.id}/back`,{revision:S.revision},conversationToken);
}

async function finish(token=conversationToken){
  if(token!==conversationToken||!S?.id)return;
  if(finishingConversation&&!finishingConversation.cancelled&&finishingConversation.token===token&&finishingConversation.id===S.id){
    return finishingConversation.revision===S.revision?finishingConversation.promise:finishingConversation.retry();
  }
  const run={id:S.id,revision:S.revision,token,cancelled:false};
  finishingConversation=run;
  run.promise=finishConversation(run);
  return run.promise;
}

function pendingConversationFinish(view){
  const run=finishingConversation;
  if(!run||run.cancelled||run.id!==view.id)return null;
  // An automatic result retry has priority over a separate guidance retry.
  return run.promise.then(()=>run.retryPromise);
}

async function finishConversation(run){
  const {token}=run;
  const id=S.id,revision=S.revision;
  ChatInput.clear();ChatScreen.think(true);
  const pending=typeof ResultScreen!=="undefined"&&typeof ResultScreen.prepare==="function";
  const editAnswer=S.canGoBack&&!S.input_locked?()=>{
    if(S?.id!==id||S.revision!==revision||S.status!=="ready")return;
    cancelConversationRequest();
    ++conversationToken;
    show("chat");
    return goBack();
  }:null;
  if(pending)ResultScreen.prepare(S,editAnswer);
  const current=()=>!run.cancelled&&token===conversationToken&&S?.id===id&&(!pending||!$("result")?.hidden);
  run.retry=()=>{
    if(!current())return;
    if(finishingConversation!==run)return finish(token);
    return run.retryPromise??=run.promise.then(()=>current()?finish(token):undefined);
  };
  const observe=async()=>{
    if(!current()||typeof ReferralGuide==="undefined")return;
    try{await ReferralGuide.observe(S);}catch{ /* Guidance failures have their own retry UI. */ }
  };
  // Only a v3 view with an explicit completed nonurgent result changes order.
  // Missing/unknown/urgent safety flags retain guidance-first behavior.
  const resultFirst=Boolean(S.bundle_id)&&S.safety_urgent===false&&S.safety_review_pending!==true;
  let polling=true,timer,pollTimer,pollController,rejectPoll;
  const stopPolling=()=>{
    polling=false;clearTimeout(timer);clearTimeout(pollTimer);
    pollController?.abort();rejectPoll?.(new Error("Progress polling cancelled"));
    if(conversationProgress===stopPolling)conversationProgress=null;
  };
  const poll=async()=>{
    if(!polling||!current())return;
    let delay=500;
    const controller=typeof AbortController==="function"?new AbortController():null;
    pollController=controller;
    try{
      const timeout=new Promise((_,reject)=>{
        rejectPoll=reject;
        pollTimer=setTimeout(()=>{controller?.abort();reject(new Error("Progress polling timed out"));},8000);
      });
      const data=await Promise.race([API.request(`/api/intakes/${id}/progress`,controller?{signal:controller.signal}:{}),timeout]);
      if(polling&&current()&&data.revision===revision){
        ChatScreen.thinkProgress(data.progress);
        if(typeof ResultScreen.progress==="function")ResultScreen.progress(data.progress);
        if(typeof ResultScreen.partial==="function")ResultScreen.partial(data.cards||[]);
      }
    }catch(error){
      // The server limits each IP to 600 API requests per minute by default.
      // A single active poll uses at most 120/min; honor a shared-IP rejection.
      if(error.status===429)delay=60000;
    }finally{clearTimeout(pollTimer);pollController=null;rejectPoll=null;}
    if(polling&&current())timer=setTimeout(poll,delay);
  };
  try{
    if(resultFirst&&typeof ReferralGuide!=="undefined"&&ReferralGuide.pendingRequest){
      try{await ReferralGuide.pendingRequest;}catch{ /* Its own retry UI reports guidance failure. */ }
      if(!current())return;
    }
    if(pending&&!resultFirst&&typeof ReferralGuide!=="undefined"){await observe();if(!current())return;}
    conversationProgress=stopPolling;
    timer=setTimeout(poll,250);
    let saved=false;
    try{
      const onEvent=(type,data)=>{
        if(type!=="progress"||!current()||data.revision!==revision)return;
        // New servers push snapshots on this request. Polling remains only for
        // older JSON servers, and an in-flight fallback poll is cancelled here.
        stopPolling();
        ChatScreen.thinkProgress(data.progress);
        if(typeof ResultScreen.progress==="function")ResultScreen.progress(data.progress);
        if(typeof ResultScreen.partial==="function")ResultScreen.partial(data.cards||[]);
      };
      const result=await requestConversation(`/api/intakes/${id}/result`,{method:"POST",body:{revision},onEvent},token);
      stopPolling();
      if(!current())return;
      ChatScreen.think(false);
      S.revision=result.revision;run.revision=result.revision;
      rememberRec(result.record,id);
      ResultScreen.open(result.record.profile,result.record.guide,true,result.record.relationship_analysis,result.record.conversation_detail,result.record.id);
      saved=true;
    }catch(error){
      stopPolling();
      await recoverConversation(error,token,run.retry,(message,retry)=>{
        if(pending&&typeof ResultScreen.pendingError==="function")ResultScreen.pendingError(message,retry);
        else ChatScreen.thinkError(retry,message);
      },current);
    }finally{
      stopPolling();
      // A failed main result must not permanently skip deferred guidance. Keep
      // retries queued until this call settles, so model generations stay serial.
      if(saved||resultFirst)await observe();
    }
  }finally{
    stopPolling();
    if(finishingConversation===run)finishingConversation=null;
  }
}
