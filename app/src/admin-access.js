import {HttpError} from './errors.js';
import {createHash,timingSafeEqual} from 'node:crypto';

const loopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);

// Local access never trusts proxy headers. Optional remote access below uses
// a separately configured HTTPS origin and credentials, not forwarding claims.
export function requireLocalAdmin(req, hostOrigin) {
  const localPeer = loopback(req.socket.remoteAddress);
  const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(hostOrigin).hostname);
  if (!localPeer || !localHost || req.headers.forwarded !== undefined ||
      Object.keys(req.headers).some(name => name.startsWith('x-forwarded-'))) {
    throw new HttpError(403, 'LOCAL_ADMIN_REQUIRED', '관리자 설정은 이 Mac의 로컬 주소에서만 사용할 수 있어요.');
  }
}

const digest=value=>createHash('sha256').update(value).digest();
function credentialsFrom(header){
  if(typeof header!=='string'||header.length>1400)return null;
  const match=/^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if(!match)return null;
  try{
    const bytes=Buffer.from(match[1],'base64');
    if(bytes.length>1024||bytes.toString('base64')!==match[1])return null;
    const value=new TextDecoder('utf-8',{fatal:true}).decode(bytes),colon=value.indexOf(':');
    if(colon<1||/[\u0000-\u001f\u007f]/u.test(value))return null;
    const password=value.slice(colon+1);
    if(Buffer.byteLength(password)<24)return null;
    return {username:value.slice(0,colon),password};
  }catch{return null;}
}

export function configuredAdminAccess(env=process.env){
  const keys=['ADMIN_REMOTE_ORIGIN','ADMIN_REMOTE_USERNAME','ADMIN_REMOTE_PASSWORD_SHA256'];
  if(keys.every(key=>env[key]===undefined))return (req,_res,hostOrigin)=>requireLocalAdmin(req,hostOrigin);
  const [origin,username,passwordHash]=keys.map(key=>env[key]);
  try{
    const url=new URL(origin);
    if(url.origin!==origin||url.protocol!=='https:'||url.username||url.password||
      typeof username!=='string'||!username||username.length>128||/[:\u0000-\u001f\u007f]/u.test(username)||
      typeof passwordHash!=='string'||!/^([a-f0-9]{64})$/u.test(passwordHash))throw new Error();
  }catch{throw new Error('Remote administrator requires an exact HTTPS origin, username and SHA-256 credential hash');}
  const expectedUser=digest(username),expectedPassword=Buffer.from(passwordHash,'hex');
  return (req,res,hostOrigin)=>{
    try{requireLocalAdmin(req,hostOrigin);return;}
    catch(error){if(!loopback(req.socket.remoteAddress)||hostOrigin!==origin)throw error;}
    const credentials=credentialsFrom(req.headers.authorization);
    if(credentials){
      const userMatches=timingSafeEqual(digest(credentials.username),expectedUser);
      const passwordMatches=timingSafeEqual(digest(credentials.password),expectedPassword);
      if(userMatches&&passwordMatches)return;
    }
    res.setHeader('WWW-Authenticate','Basic realm="Malssi admin", charset="UTF-8"');
    res.setHeader('Cache-Control','no-store');
    throw new HttpError(401,'ADMIN_AUTH_REQUIRED','관리자 아이디와 비밀번호로 로그인해 주세요.');
  };
}
