// 서버에서 읽어 온 기록을 화면에서 사용하는 동안만 보관해요.
let recordCache=[],incompleteCache=[],conversationEpoch=0,deletingConversations=false;
function loadRecs(){return recordCache;}
function loadIncomplete(){return incompleteCache;}
function setRecs(records){recordCache=records;if(typeof API!=="undefined"&&API.data)API.data.records=records;}
function setHistory(data){
  setRecs(data.records);incompleteCache=data.incomplete_intakes||[];
  if(Number.isInteger(data.conversation_epoch))conversationEpoch=data.conversation_epoch;
  if(typeof API!=="undefined"&&API.data){API.data.incomplete_intakes=incompleteCache;API.data.conversation_epoch=conversationEpoch;}
}
function rememberRec(record,intakeId){
  setHistory({records:[record,...loadRecs().filter(r=>r.id!==record.id)],incomplete_intakes:incompleteCache.filter(row=>row.id!==intakeId)});
  StartScreen.updRecN();
}
async function deleteRec(id){
  const result=await API.request(`/api/records/${id}`,{method:"DELETE"});
  if(!result.deleted)throw new Error("기록을 삭제하지 못했어요. 다시 시도해 주세요.");
  setHistory({records:loadRecs().filter(r=>r.id!==id),incomplete_intakes:incompleteCache.filter(row=>row.id!==result.intake_id)});StartScreen.updRecN();
  if(result.intake_id&&typeof forgetConversation==="function")forgetConversation(result.intake_id);
}
async function deleteIntake(id){
  const result=await API.request(`/api/intakes/${id}`,{method:"DELETE"});
  if(!result.deleted)throw new Error("대화를 삭제하지 못했어요. 다시 시도해 주세요.");
  incompleteCache=incompleteCache.filter(row=>row.id!==id);
  setRecs(loadRecs().filter(record=>!(result.record_ids||[]).includes(String(record.id))));
  if(API.data)API.data.incomplete_intakes=incompleteCache;
  StartScreen.updRecN();
  if(typeof forgetConversation==="function")forgetConversation(id);
}
async function deleteConversations(){
  if(deletingConversations)throw new Error("대화를 삭제하고 있어요. 삭제를 마친 뒤 다시 시도해 주세요.");
  deletingConversations=true;
  const starts=[...document.querySelectorAll("[data-go],#go,#crTalk")].map(button=>({button,disabled:button.disabled}));
  starts.forEach(({button})=>button.disabled=true);
  try{
    const result=await API.request("/api/conversations",{method:"DELETE"});
    if(!result.deleted)throw new Error("대화를 삭제하지 못했어요. 다시 시도해 주세요.");
    setHistory({records:[],incomplete_intakes:[],conversation_epoch:result.conversation_epoch});
    if(typeof forgetConversation==="function")forgetConversation();
    StartScreen.updRecN();
  }finally{
    deletingConversations=false;
    starts.forEach(({button,disabled})=>button.disabled=disabled);
  }
}
