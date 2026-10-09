// Extend persistence without editing the original UI components or their copy.
const originalLoadRecs=loadRecs,originalSaveRecs=saveRecs;
let originalPersistence=Promise.resolve();
saveRecs=function(records){
  const previous=originalLoadRecs();
  const added=records.filter(r=>!previous.some(p=>p.id===r.id));
  const removed=previous.filter(r=>!records.some(p=>p.id===r.id));
  for(const r of added)if(OriginalBackend.active?.id){
    const active=OriginalBackend.active;
    active.finalRecord??=structuredClone({...r,server_id:active.id});
    Object.assign(r,active.finalRecord);
  }
  const localSaved=originalSaveRecs(records);
  const active=OriginalBackend.active;
  originalPersistence=originalPersistence.catch(()=>{}).then(async()=>{
    try{
      for(const r of added){
        if(!r.server_id)continue;
        const body=active.requests.complete??={request_id:crypto.randomUUID(),record_id:r.id,date:r.date,log:r.log,followUps:r.followUps||0};
        for(let attempt=0;attempt<2;attempt++){
          try{await OriginalBackend.request(`/api/v2/frontend/records/${r.server_id}/complete`,'POST',body);break;}
          catch(error){if(!error.retryable||attempt===1)throw error;}
        }
      }
      for(const r of removed){
        if(!r.server_id)continue;
        const body={request_id:crypto.randomUUID()};
        for(let attempt=0;attempt<2;attempt++){
          try{await OriginalBackend.request(`/api/v2/frontend/records/${r.server_id}`,'DELETE',body);break;}
          catch(error){if([404,410].includes(error.status))break;if(!error.retryable||attempt===1)throw error;}
        }
      }
    }catch(error){originalSaveRecs(previous);throw error;}
  });
  originalPersistence.catch(()=>{});
  return localSaved;
};
const originalBegin=begin;
begin=function(){OriginalBackend.reset();return originalBegin();};
function originalFailure(error){
  window.alert(error.message);
  ChatInput.render({type:'one',noOwn:true,noSkip:true,opts:['다시 시도','처음부터 다시']},(_,selected)=>selected[0]===0?finish():begin());
}
const originalFinish=finish;
finish=async function(){try{await originalFinish();}catch(error){originalFailure(error);}};
const originalResultOpen=ResultScreen.open;
ResultScreen.open=async function(p,g,saved){
  try{await originalPersistence;originalResultOpen.call(this,p,g,saved);}
  catch(error){originalFailure(error);}
};
const originalRecordsOpen=RecordsScreen.open;
RecordsScreen.open=async function(id){
  try{
    await originalPersistence;
    const remote=await OriginalBackend.request('/api/v2/frontend/records');
    const records=originalLoadRecs();
    // Keep existing browser records and the original browser-only UX. Backend
    // records use this browser's HttpOnly session; no login screen is introduced.
    for(const record of remote.records){const at=records.findIndex(r=>r.id===record.id);if(at>=0)records[at]=record;else records.push(record);}
    records.sort((a,b)=>b.id-a.id);originalSaveRecs(records);
  }catch(error){if(error.status!==401)window.alert(error.message);}
  return originalRecordsOpen.call(this,id);
};
