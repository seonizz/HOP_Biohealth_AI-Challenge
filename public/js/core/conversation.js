// 질문 진행·환자 상태 구성·모델 응답·기록 저장은 서버가 담당해요.
let S;
let conversationToken=0;
// 서버에서 호칭을 치환한 문구도 그대로 표시할 수 있어요.
const nm=t=>String(t).replace(/\{name(?::([^}]+))?\}/g,(_,j)=>{const w=S?.name||"그분";return j?w+josa(w,j):w;});

function leaveConversation(){ChatScreen.leave(()=>{conversationToken++;ChatScreen.think(false);show("start");window.scrollTo(0,0);});}
async function begin(){
  const token=++conversationToken;
  S=null;ChatScreen.clear();ChatScreen.progress(0);ChatScreen.title("");ChatScreen.section("");ChatInput.clear();show("chat");
  try{
    const view=await ChatScreen.typing("hello",()=>token===conversationToken?API.request("/api/intakes",{method:"POST",body:{}}):null);
    if(token===conversationToken)renderConversation(view,token);
  }catch(error){if(token===conversationToken)ChatInput.error(error.message,begin);}
}

function renderConversation(view,token){
  if(token!==conversationToken)return;
  ChatScreen.think(false);
  S=view;ChatScreen.sync(view.log);ChatScreen.progress(view.progress);ChatScreen.title(view.chat_title);ChatScreen.section(view.section);
  ChatInput.clear();
  if(view.status==="ready"){finish(token);return;}
  const q=view.question;
  ChatInput.render(q,(text,selected,custom="",skipped=false)=>answer(text,selected,custom,skipped),view.canGoBack?goBack:null);
  if(view.model_pending&&view.pending_answer){
    const body={...view.pending_answer,revision:view.revision};
    ChatInput.error("입력한 답변은 저장되어 있어요. 다시 시도하면 이어서 답변을 준비해요.",()=>submitConversation(`/api/intakes/${view.id}/answers`,body,token,{who:"me",text:body.text,fu:!!body.follow_up}));
  }
}

function conversationErrorMessage(error){
  const messages={
    MODEL_UNAVAILABLE:"답변 서버에 잠시 연결하지 못했어요. 대화 내용은 저장되어 있으니 잠시 후 다시 시도해 주세요.",
    MODEL_INVALID_RESPONSE:"답변을 다시 확인했지만 아직 준비하지 못했어요. 대화 내용은 저장되어 있으니 다시 시도해 주세요.",
    MODEL_TIMEOUT:"답변 준비 시간을 초과했어요. 대화 내용은 저장되어 있으니 잠시 후 다시 시도해 주세요.",
    MODEL_CONTEXT_TOO_LONG:"한 번에 처리할 내용이 많아요. 입력한 답변을 수정한 뒤 다시 시도해 주세요.",
    MODEL_AUTH_FAILED:"답변 서비스의 연결 설정을 확인해야 해요. 대화 내용은 저장되어 있어요.",
    MODEL_NOT_CONFIGURED:"답변 서비스의 연결 설정을 확인해야 해요. 대화 내용은 저장되어 있어요.",
    MODEL_NOT_CONNECTED:"답변 서비스의 연결 설정을 확인해야 해요. 대화 내용은 저장되어 있어요.",
  };
  return messages[error.code]||(error.code?.startsWith("MODEL_")?"답변을 준비하지 못했어요. 대화 내용은 저장되어 있으니 다시 시도해 주세요.":error.message);
}

async function recoverConversation(error,token,retry,present=(message,operation)=>ChatInput.error(message,operation)){
  if(token!==conversationToken)return;
  const modelError=error.code?.startsWith("MODEL_");
  // 저장된 대기 답변의 버전을 읽어 수정·되돌리기가 이전 요청을 덮어쓰지 않게 해요.
  if((error.status===409||(modelError&&S?.question))&&S?.id){
    try{
      const id=S.id;
      const view=await ChatScreen.typing(S?.question?.face||"ponder",()=>token===conversationToken?API.request(`/api/intakes/${id}`):null);
      if(token!==conversationToken)return;
      if(view.model_pending&&view.question?.id===S.question?.id&&!!view.question.follow_up===!!S.question.follow_up){
        // 같은 질문의 입력창은 유지하여 실패 직후에도 답을 수정할 수 있어요.
        S=view;ChatScreen.sync(view.log);
      }else{
        if(view.status==="ready"&&view.revision===S.revision){present(conversationErrorMessage(error),retry);return;}
        renderConversation(view,token);return;
      }
    }catch(readError){error=readError;}
  }
  if(token===conversationToken)present(conversationErrorMessage(error),retry);
}

async function submitConversation(path,body,token,message,detailPrompt){
  if(token!==conversationToken)return;
  // 전송한 말은 즉시 보여 주고, 다음 질문은 모델 응답 뒤 서버 기록으로 확정해요.
  // 재시도나 답변 수정도 같은 서버 기록 뒤에 표시하므로 말풍선이 중복되지 않아요.
  let log=pendingConversationLog();
  if(message&&!detailPrompt)detailPrompt=answerDetailPrompt(S.question,body.selected||[]);
  if(detailPrompt&&!sameDetailPrompt(log.at(-1),detailPrompt))log=[...log,detailPrompt];
  if(message)ChatScreen.sync([...log,message]);
  try{
    const view=await ChatScreen.typing(S?.question?.face||"ponder",()=>token===conversationToken?API.request(path,{method:"POST",body}):null);
    if(token===conversationToken)renderConversation(view,token);
  }catch(error){await recoverConversation(error,token,()=>submitConversation(path,{...body,revision:S.revision},token,message,detailPrompt));}
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

function answer(text,selected,custom="",skipped=false){
  if(!S?.question)return;
  const body={revision:S.revision,question_id:S.question.id,text,selected,custom,skipped,follow_up:!!S.question.follow_up};
  const detailPrompt=answerDetailPrompt(S.question,selected);
  return submitConversation(`/api/intakes/${S.id}/answers`,body,conversationToken,{who:"me",text,fu:body.follow_up},detailPrompt);
}

function goBack(){
  if(!S?.canGoBack)return;
  return submitConversation(`/api/intakes/${S.id}/back`,{revision:S.revision},conversationToken);
}

async function finish(token=conversationToken){
  if(token!==conversationToken||!S?.id)return;
  const id=S.id,revision=S.revision;
  ChatInput.clear();ChatScreen.think(true);
  try{
    const result=await API.request(`/api/intakes/${id}/result`,{method:"POST",body:{revision}});
    if(token!==conversationToken)return;
    ChatScreen.thinkStep(3);ChatScreen.think(false);
    S.revision=result.revision;
    rememberRec(result.record);
    ResultScreen.open(result.record.profile,result.record.guide,true);
  }catch(error){await recoverConversation(error,token,()=>finish(token),(message,retry)=>ChatScreen.thinkError(retry,message));}
}
