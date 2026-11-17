import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {requireLocalAdmin,configuredAdminAccess} from '../src/admin-access.js';

const request=(remoteAddress,headers={})=>({socket:{remoteAddress},headers});

test('administrator requires a local peer and literal local host',()=>{
 for(const peer of ['127.0.0.1','::1','::ffff:127.0.0.1']){
  for(const origin of ['http://127.0.0.1:9000','http://localhost:9000','http://[::1]:9000']){
   assert.doesNotThrow(()=>requireLocalAdmin(request(peer),origin));
  }
 }
 for(const peer of ['192.168.1.3','203.0.113.1','::ffff:203.0.113.1',undefined]){
  assert.throws(()=>requireLocalAdmin(request(peer,{host:'localhost:9000'}),'http://localhost:9000'),{status:403,code:'LOCAL_ADMIN_REQUIRED'});
 }
 for(const origin of ['http://localhost.evil.example','http://example.test','http://192.168.1.3']){
  assert.throws(()=>requireLocalAdmin(request('127.0.0.1'),origin),{status:403,code:'LOCAL_ADMIN_REQUIRED'});
 }
});

test('forwarding headers never grant or preserve administrator access',()=>{
 for(const headers of [{forwarded:'for=127.0.0.1'},{forwarded:''},{'x-forwarded-for':'127.0.0.1'},{'x-forwarded-host':'localhost'},{'x-forwarded-proto':'http'},{'x-forwarded-port':'9000'}]){
  assert.throws(()=>requireLocalAdmin(request('127.0.0.1',headers),'http://localhost:9000'),{status:403,code:'LOCAL_ADMIN_REQUIRED'});
 }
});

const remoteOrigin='https://admin.example.ts.net',password='synthetic-admin-credential-123456789';
const remoteEnv={ADMIN_REMOTE_ORIGIN:remoteOrigin,ADMIN_REMOTE_USERNAME:'admin',ADMIN_REMOTE_PASSWORD_SHA256:createHash('sha256').update(password).digest('hex')};
const basic=(username='admin',value=password)=>'Basic '+Buffer.from(username+':'+value).toString('base64');
const response=()=>({headers:{},setHeader(name,value){this.headers[name]=value;}});

test('remote administrator requires configured credentials and challenges missing or invalid authentication',()=>{
 const guard=configuredAdminAccess(remoteEnv);
 for(const authorization of [undefined,'Bearer anything','Basic !!!','Basic YTpi','Basic '+Buffer.from('admin:'+password+'\n').toString('base64'),basic('other'),basic('admin','wrong-password-with-more-than-24-bytes')]){
  const res=response();
  assert.throws(()=>guard(request('127.0.0.1',{authorization}),res,remoteOrigin),{status:401,code:'ADMIN_AUTH_REQUIRED'});
  assert.equal(res.headers['WWW-Authenticate'],'Basic realm="Malssi admin", charset="UTF-8"');
  assert.equal(res.headers['Cache-Control'],'no-store');
 }
 assert.doesNotThrow(()=>guard(request('127.0.0.1',{authorization:basic()}),response(),remoteOrigin));
});

test('remote credentials do not grant access from another origin or a nonlocal proxy peer',()=>{
 const guard=configuredAdminAccess(remoteEnv);
 for(const origin of ['https://other.example.ts.net','http://admin.example.ts.net','http://192.168.1.3']){
  assert.throws(()=>guard(request('127.0.0.1',{authorization:basic()}),response(),origin),{status:403,code:'LOCAL_ADMIN_REQUIRED'});
 }
 assert.throws(()=>guard(request('203.0.113.1',{authorization:basic()}),response(),remoteOrigin),{status:403,code:'LOCAL_ADMIN_REQUIRED'});
 for(const headers of [{forwarded:'for=127.0.0.1'},{'x-forwarded-for':'127.0.0.1'},{'tailscale-user-login':'admin@example.test'}]){
  assert.throws(()=>guard(request('127.0.0.1',headers),response(),remoteOrigin),{status:401,code:'ADMIN_AUTH_REQUIRED'});
 }
 assert.doesNotThrow(()=>guard(request('127.0.0.1',{authorization:basic(),'x-forwarded-proto':'https'}),response(),remoteOrigin));
});

test('optional remote authentication preserves strict local administrator behavior',()=>{
 for(const env of [{},remoteEnv]){
  const guard=configuredAdminAccess(env);
  assert.doesNotThrow(()=>guard(request('127.0.0.1'),response(),'http://127.0.0.1:9000'));
  assert.throws(()=>guard(request('127.0.0.1',{'x-forwarded-host':'localhost'}),response(),'http://127.0.0.1:9000'),{status:403,code:'LOCAL_ADMIN_REQUIRED'});
 }
 assert.throws(()=>configuredAdminAccess({})(request('127.0.0.1',{authorization:basic()}),response(),remoteOrigin),{status:403,code:'LOCAL_ADMIN_REQUIRED'});
});

test('partial and malformed remote administrator configuration fails closed',()=>{
 for(const env of [
  {ADMIN_REMOTE_ORIGIN:remoteOrigin},
  {...remoteEnv,ADMIN_REMOTE_ORIGIN:'http://admin.example.ts.net'},
  {...remoteEnv,ADMIN_REMOTE_ORIGIN:remoteOrigin+'/path'},
  {...remoteEnv,ADMIN_REMOTE_ORIGIN:'https://user:password@admin.example.ts.net'},
  {...remoteEnv,ADMIN_REMOTE_USERNAME:''},
  {...remoteEnv,ADMIN_REMOTE_USERNAME:'admin:other'},
  {...remoteEnv,ADMIN_REMOTE_PASSWORD_SHA256:'not-a-hash'},
  {...remoteEnv,ADMIN_REMOTE_PASSWORD_SHA256:undefined},
 ])assert.throws(()=>configuredAdminAccess(env),/Remote administrator requires/);
});
