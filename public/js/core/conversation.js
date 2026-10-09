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
    ChatInput.error("답변을 준비하지 못했어요. 다시 시도해 주세요.",()=>submitConversation(`/api/intakes/${view.id}/answers`,body,token,{who:"me",text:body.text,fu:!!body.follow_up}));
  }
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
        if(view.status==="ready"&&view.revision===S.revision){present(error.message,retry);return;}
        renderConversation(view,token);return;
      }
    }catch(readError){error=readError;}
  }
  if(token===conversationToken)present(error.code?.startsWith("MODEL_")?"답변을 준비하지 못했어요. 다시 시도해 주세요.":error.message,retry);
}

async function submitConversation(path,body,token,message){
  if(token!==conversationToken)return;
  // 전송한 말은 즉시 보여 주고, 다음 질문은 모델 응답 뒤 서버 기록으로 확정해요.
  // 재시도나 답변 수정도 같은 서버 기록 뒤에 표시하므로 말풍선이 중복되지 않아요.
  const log=S.model_pending&&S.log.at(-1)?.who==="me"?S.log.slice(0,-1):S.log;
  if(message)ChatScreen.sync([...log,message]);
  try{
    const view=await ChatScreen.typing(S?.question?.face||"ponder",()=>token===conversationToken?API.request(path,{method:"POST",body}):null);
    if(token===conversationToken)renderConversation(view,token);
  }catch(error){await recoverConversation(error,token,()=>submitConversation(path,{...body,revision:S.revision},token,message));}
}

function answer(text,selected,custom="",skipped=false){
  if(!S?.question)return;
  const body={revision:S.revision,question_id:S.question.id,text,selected,custom,skipped,follow_up:!!S.question.follow_up};
  return submitConversation(`/api/intakes/${S.id}/answers`,body,conversationToken,{who:"me",text,fu:body.follow_up});
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
  }catch(error){await recoverConversation(error,token,()=>finish(token),(_,retry)=>ChatScreen.thinkError(retry));}
}
