// 서버에서 읽어 온 기록을 화면에서 사용하는 동안만 보관해요.
let recordCache=[];
function loadRecs(){return recordCache;}
function setRecs(records){recordCache=records;}
function rememberRec(record){setRecs([record,...loadRecs().filter(r=>r.id!==record.id)]);StartScreen.updRecN();}
async function deleteRec(id){
  const result=await API.request(`/api/records/${id}`,{method:"DELETE"});
  if(!result.deleted)throw new Error("기록을 삭제하지 못했어요. 다시 시도해 주세요.");
  setRecs(loadRecs().filter(r=>r.id!==id));StartScreen.updRecN();
}
