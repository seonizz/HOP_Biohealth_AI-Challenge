// Adapter for the original Model contract; rendering and question flow stay intact.
const OriginalBackend={
  active:null,sessionPromise:null,
  async request(path,method='GET',body){
    let response;
    try{response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(55000),headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});}
    catch{const error=new Error('서버와 연결하지 못했습니다.');error.retryable=true;throw error;}
    const data=await response.json().catch(()=>({}));
    if(!response.ok){const error=new Error(data.error?.message||data.detail||'요청을 처리하지 못했습니다.');error.status=response.status;error.retryable=response.status>=500||response.status===429;throw error;}
    return data;
  },
  async session(){
    if(!this.sessionPromise)this.sessionPromise=(async()=>{
      try{await this.request('/api/auth/me');}
      catch(error){if(error.status!==401)throw error;await this.request('/api/auth/demo','POST',{});}
    })().catch(error=>{this.sessionPromise=null;throw error;});
    return this.sessionPromise;
  },
  reset(){this.active=null;},
  async stage(name,path,body={}){
    const state=this.active;
    state.requests[name]??={request_id:crypto.randomUUID(),...body};
    // A transport retry reuses its UUID/body. The server explicitly declares its
    // model mode; a failing live model never falls back to the prototype.
    for(let attempt=0;attempt<2;attempt++){
      try{return await this.request(path,'POST',state.requests[name]);}
      catch(error){if(!error.retryable||attempt===1)throw error;}
    }
  }
};
const Model={
  async extractContext(payload){
    await OriginalBackend.session();
    const serialized=JSON.stringify(payload);
    if(!OriginalBackend.active||OriginalBackend.active.serialized!==serialized)OriginalBackend.active={serialized,requests:{}};
    const state=OriginalBackend.active;
    if(!state.id){const result=await OriginalBackend.stage('create','/api/v2/frontend/records',{payload});state.id=result.project_id;}
    const result=await OriginalBackend.stage('context',`/api/v2/frontend/records/${state.id}/context`);
    state.scores=result.scores;
    return result.context;
  },
  async scoreAnswers(){return OriginalBackend.active.scores;},
  async guide(){
    const id=OriginalBackend.active.id;
    await OriginalBackend.stage('draft',`/api/v2/frontend/records/${id}/draft`);
    return (await OriginalBackend.stage('guide',`/api/v2/frontend/records/${id}/guide`)).guide;
  }
};
