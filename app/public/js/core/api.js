// 익명 세션 쿠키와 CSRF 토큰으로 같은 서버의 API를 호출해요.
const API={
  csrf:"",data:null,
  async request(path,{method="GET",body,signal,onEvent}={}){
    const headers={Accept:typeof onEvent==="function"?"text/event-stream":"application/json"};
    if(method!=="GET"){
      headers["Content-Type"]="application/json";
      headers["X-CSRF-Token"]=this.csrf;
    }
    let response;
    try{response=await fetch(path,{method,headers,credentials:"same-origin",...(signal?{signal}:{}),...(method!=="GET"?{body:JSON.stringify(body??{})}:{})});}
    catch{
      if(signal?.aborted)throw Object.assign(new Error("요청을 취소했어요."),{status:499,code:"REQUEST_CANCELLED"});
      throw Object.assign(new Error("서버에 연결하지 못했어요. 연결을 확인하고 다시 시도해 주세요."),{status:0});
    }
    if(response.ok&&typeof onEvent==="function"&&response.headers.get("content-type")?.split(";")[0].trim().toLowerCase()==="text/event-stream")
      return this.streamResponse(response,{signal,onEvent});
    let data;
    try{data=await response.json();}
    catch{
      if(signal?.aborted)throw Object.assign(new Error("요청을 취소했어요."),{status:499,code:"REQUEST_CANCELLED"});
      throw Object.assign(new Error("서버 응답을 읽지 못했어요. 다시 시도해 주세요."),{status:response.status});
    }
    if(!response.ok)throw Object.assign(new Error(data.error?.message||"요청을 처리하지 못했어요. 다시 시도해 주세요."),{status:response.status,code:data.error?.code});
    return data;
  },
  async streamResponse(response,{signal,onEvent}){
    let reader;
    const cancelled=()=>{void reader?.cancel().catch(()=>{});};
    try{
      reader=response.body.getReader();
      signal?.addEventListener("abort",cancelled,{once:true});
      signal?.throwIfAborted();
      const decoder=new TextDecoder("utf-8",{fatal:true});
      let line="",data=[],event="",skipLF=false,result,complete=false;
      const dispatch=()=>{
        const type=event||"message",text=data.join("\n");data=[];event="";
        if(!text||!["progress","result","error"].includes(type))return;
        const value=JSON.parse(text);
        if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Invalid event");
        if(type==="error")throw Object.assign(new Error(value.error?.message||"요청을 처리하지 못했어요. 다시 시도해 주세요."),{
          status:Number.isInteger(value.status)&&value.status>=400&&value.status<=599?value.status:500,
          code:value.error?.code||"STREAM_ERROR",
        });
        if(type==="result"){result=value;complete=true;return;}
        // A presentation callback cannot invalidate an authoritative result.
        try{onEvent(type,value);}catch{ /* Keep reading the saved result. */ }
      };
      const readLine=()=>{
        if(line==="")dispatch();
        else if(line==="data")data.push("");
        else if(line.startsWith("data:"))data.push(line.slice(5).replace(/^ /u,""));
        else if(line.startsWith("event:"))event=line.slice(6).replace(/^ /u,"");
        line="";
      };
      const segment=text=>{
        for(const char of text){
          if(skipLF){skipLF=false;if(char==="\n")continue;}
          if(char==="\r"||char==="\n"){readLine();skipLF=char==="\r";}
          else line+=char;
          if(complete)break;
        }
      };
      while(!complete){
        const chunk=await reader.read();signal?.throwIfAborted();
        segment(decoder.decode(chunk.value,{stream:!chunk.done}));
        if(chunk.done)break;
      }
      // A terminal event must be fully framed. An interrupted connection can
      // have committed its result already; recovery reads state before retrying.
      if(!complete)throw new Error("Incomplete event stream");
      return result;
    }catch(error){
      if(signal?.aborted)throw Object.assign(new Error("요청을 취소했어요."),{status:499,code:"REQUEST_CANCELLED"});
      if(error.code&&Number.isInteger(error.status))throw error;
      throw Object.assign(new Error("서버 응답을 읽지 못했어요. 다시 시도해 주세요."),{status:0});
    }finally{
      signal?.removeEventListener("abort",cancelled);
      if(reader){try{await reader.cancel();}catch{ /* The connection may already be closed. */ }reader.releaseLock();}
    }
  },
  async bootstrap(){
    const data=await this.request("/api/bootstrap");
    this.csrf=data.csrf_token;this.data=data;
    setHistory(data);
    COLUMNS.splice(0,COLUMNS.length,...data.columns);
    COLUMN_CATS.splice(0,COLUMN_CATS.length,...data.categories);
    return data;
  },
  retentionDays(){
    return this.data?.retention?.inactivity_days ?? 30;
  }
};
