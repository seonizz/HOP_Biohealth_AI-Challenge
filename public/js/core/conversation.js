// 질문 진행·환자 상태 구성·모델 응답·기록 저장은 서버가 담당해요.
let S;
let conversationToken=0;
// 서버에서 호칭을 치환한 문구도 그대로 표시할 수 있어요.
const nm=t=>String(t).replace(/\{name(?::([^}]+))?\}/g,(_,j)=>{const w=S?.name||"그분";return j?w+josa(w,j):w;});

function leaveConversation(){conversationToken++;show("start");}
async function begin(){
  const token=++conversationToken;
  S=null;ChatScreen.clear();ChatScreen.progress(0);ChatScreen.section("");ChatInput.clear();show("chat");
  try{
    const view=await ChatScreen.typing("hello",API.request("/api/intakes",{method:"POST",body:{}}));
    if(token===conversationToken)renderConversation(view,token);
  }catch(error){if(token===conversationToken)ChatInput.error(error.message,begin);}
}

function renderConversation(view,token){
  if(token!==conversationToken)return;
  S=view;ChatScreen.sync(view.log);ChatScreen.progress(view.progress);ChatScreen.section(view.section);
  ChatInput.clear();
  if(view.status==="ready"){finish(token);return;}
  const q=view.question;
  ChatInput.render(q,(text,selected,custom="",skipped=false)=>answer(text,selected,custom,skipped),view.canGoBack?goBack:null);
  if(view.model_warning)ChatInput.error(view.model_warning);
}

async function recoverConversation(error,token,retry){
  if(token!==conversationToken)return;
  // 답변이 서버에 도착했지만 응답을 놓친 경우 현재 버전으로 돌아와요.
  if(error.status===409&&S?.id){
    try{
      const view=await API.request(`/api/intakes/${S.id}`);
      if(view.status==="ready"&&view.revision===S.revision){if(token===conversationToken)ChatInput.error(error.message,retry);return;}
      if(token===conversationToken)renderConversation(view,token);
      return;
    }catch(readError){error=readError;}
  }
  if(token===conversationToken)ChatInput.error(error.message,retry);
}

async function submitConversation(path,body,token){
  if(token!==conversationToken)return;
  try{
    const view=await ChatScreen.typing(S?.question?.face||"ponder",API.request(path,{method:"POST",body}));
    if(token===conversationToken)renderConversation(view,token);
  }catch(error){await recoverConversation(error,token,()=>submitConversation(path,body,token));}
}

function answer(text,selected,custom="",skipped=false){
  if(!S?.question)return;
  const body={revision:S.revision,question_id:S.question.id,text,selected,custom,skipped,follow_up:!!S.question.follow_up};
  return submitConversation(`/api/intakes/${S.id}/answers`,body,conversationToken);
}

function goBack(){
  if(!S?.canGoBack)return;
  return submitConversation(`/api/intakes/${S.id}/back`,{revision:S.revision},conversationToken);
}

async function finish(token=conversationToken){
  if(token!==conversationToken||!S?.id)return;
  const id=S.id,revision=S.revision;
  ChatInput.clear();
  try{
    const result=await ChatScreen.typing("ponder",API.request(`/api/intakes/${id}/result`,{method:"POST",body:{revision}}));
    if(token!==conversationToken)return;
    S.revision=result.revision;
    rememberRec(result.record);
    ResultScreen.open(result.record.profile,result.record.guide,true);
  }catch(error){await recoverConversation(error,token,()=>finish(token));}
}
