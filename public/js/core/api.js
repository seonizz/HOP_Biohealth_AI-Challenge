// 익명 세션 쿠키와 CSRF 토큰으로 같은 서버의 API를 호출해요.
const API={
  csrf:"",data:null,
  async request(path,{method="GET",body}={}){
    const headers={Accept:"application/json"};
    if(method!=="GET"){
      headers["Content-Type"]="application/json";
      headers["X-CSRF-Token"]=this.csrf;
    }
    let response;
    try{response=await fetch(path,{method,headers,credentials:"same-origin",...(method!=="GET"?{body:JSON.stringify(body??{})}:{})});}
    catch{throw Object.assign(new Error("서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요."),{status:0});}
    let data;
    try{data=await response.json();}
    catch{throw Object.assign(new Error("서버 응답을 읽지 못했어요. 다시 시도해 주세요."),{status:response.status});}
    if(!response.ok)throw Object.assign(new Error(data.error?.message||"요청을 처리하지 못했어요. 다시 시도해 주세요."),{status:response.status,code:data.error?.code});
    return data;
  },
  async bootstrap(){
    const data=await this.request("/api/bootstrap");
    this.csrf=data.csrf_token;this.data=data;
    setRecs(data.records);
    COLUMNS.splice(0,COLUMNS.length,...data.columns);
    COLUMN_CATS.splice(0,COLUMN_CATS.length,...data.categories);
    return data;
  }
};
