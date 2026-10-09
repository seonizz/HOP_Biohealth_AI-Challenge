export class ApiError extends Error {
  constructor(status,body) {
    super(body?.error?.message||body?.detail||'서버와 연결하지 못했습니다.');
    this.status=status;this.code=body?.error?.code||body?.code||'NETWORK_ERROR';
    this.retryable=status===0||status>=500||status===429;
  }
}
export async function request(path,method='GET',body,signal) {
  let response;
  try {
    response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',signal:signal||AbortSignal.timeout(20000),headers:body?{'Content-Type':'application/json'}:{},...(body?{body:JSON.stringify(body)}:{})});
  } catch { throw new ApiError(0,{}); }
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new ApiError(response.status,data);
  return data;
}
export const v2=(path)=>request('/api/v2'+path);
export async function allPages(path,key) {
  const result=[];let cursor=null;
  do {const page=await v2(path+(cursor?(path.includes('?')?'&':'?')+'cursor='+encodeURIComponent(cursor):''));result.push(...page[key]);cursor=page.next_cursor;}while(cursor);
  return result;
}
