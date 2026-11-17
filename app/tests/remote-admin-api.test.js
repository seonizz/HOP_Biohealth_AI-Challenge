import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash,randomBytes} from 'node:crypto';
import pg from 'pg';
import {createApp} from '../src/server.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
const remoteOrigin='https://admin.example.ts.net';
const password='synthetic-remote-admin-password-123456789';
const authorization='Basic '+Buffer.from('admin:'+password).toString('base64');
const adminEnv={ADMIN_REMOTE_ORIGIN:remoteOrigin,ADMIN_REMOTE_USERNAME:'admin',ADMIN_REMOTE_PASSWORD_SHA256:createHash('sha256').update(password).digest('hex')};
const dbtest=(name,fn)=>test(name,{skip:!databaseUrl},fn);

async function fixture(t){
 const pool=new pg.Pool({connectionString:databaseUrl}),schema='remote_admin_'+randomBytes(8).toString('hex');
 await pool.query(`CREATE SCHEMA ${schema}`);
 let app;
 t.after(async()=>{if(app)await app.shutdown();await pool.query(`DROP SCHEMA ${schema} CASCADE`);await pool.end();});
 const local={model:'synthetic-local',protocol:'relationship_agent',async updateState(){throw new Error('No inference expected');},async respond(){throw new Error('No inference expected');}};
 app=await createApp({databaseUrl,schema,key:randomBytes(32),gateway:null,modelProfiles:{local12b:local,gpu31b:null},publicOrigin:remoteOrigin,allowedOrigins:['http://127.0.0.1'],adminEnv});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const port=app.server.address().port;
 const request=(path,{method='GET',body,headers={},host='admin.example.ts.net'}={})=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:'127.0.0.1',port,path,method,headers:{host,...(body?{'content-type':'application/json'}:{}),...headers}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.once('end',()=>{let data;try{data=JSON.parse(text);}catch{}resolve({status:res.statusCode,headers:res.headers,text,data});});
  });
  req.once('error',reject);req.end(body?JSON.stringify(body):undefined);
 });
 const bootstrap=await request('/api/bootstrap');assert.equal(bootstrap.status,200);
 const cookie=bootstrap.headers['set-cookie'][0].split(';')[0];
 return {...app,request,cookie,csrf:bootstrap.data.csrf_token};
}

dbtest('remote admin page and every configuration API require credentials even with a public session',async t=>{
 const f=await fixture(t);
 for(const path of ['/admin/models','/admin/models/','/admin-models.html','/admin%2fmodels','/api/admin/models','/api/admin/model-connections','/api/admin/model-connections/gpu31b']){
  for(const headers of [{cookie:f.cookie},{cookie:f.cookie,authorization:'Basic '+Buffer.from('admin:wrong-password-long-enough-123').toString('base64')},{cookie:f.cookie,'x-forwarded-for':'127.0.0.1','tailscale-user-login':'admin@example.test'}]){
   const denied=await f.request(path,{headers});assert.equal(denied.status,401,path);assert.match(denied.headers['www-authenticate'],/^Basic /);assert.equal(denied.data.error.code,'ADMIN_AUTH_REQUIRED');
  }
 }
 const page=await f.request('/admin/models',{headers:{authorization}});assert.equal(page.status,200);assert.match(page.text,/모델 설정/);
 for(const path of ['/api/admin/models','/api/admin/model-connections']){
  assert.equal((await f.request(path,{headers:{authorization}})).status,401,'Authentication does not replace a browser session');
  assert.equal((await f.request(path,{headers:{authorization,cookie:f.cookie}})).status,200);
 }
 assert.equal((await f.request('/admin/models',{host:'127.0.0.1'})).status,200,'Local access remains available');
});

dbtest('authenticated remote admin retains CSRF and origin checks for model and connection writes',async t=>{
 const f=await fixture(t),headers={authorization,cookie:f.cookie};
 for(const [path,body]of [['/api/admin/models',{model_profile_id:'local12b'}],['/api/admin/model-connections/gpu31b',{base_url:'http://127.0.0.1:19001/v1',model:'synthetic-only',api_key:'synthetic-no-network'}]]){
  const csrf=await f.request(path,{method:'PUT',body,headers});assert.equal(csrf.status,403);assert.equal(csrf.data.error.code,'CSRF_REJECTED');
  const origin=await f.request(path,{method:'PUT',body,headers:{...headers,'x-csrf-token':f.csrf,origin:'https://foreign.example'}});assert.equal(origin.status,403);assert.equal(origin.data.error.code,'ORIGIN_REJECTED');
 }
 const saved=await f.request('/api/admin/models',{method:'PUT',body:{model_profile_id:'local12b'},headers:{...headers,'x-csrf-token':f.csrf,origin:remoteOrigin}});assert.equal(saved.status,200);assert.equal(saved.data.selected_model_profile,'local12b');
 const connection=await f.request('/api/admin/model-connections/gpu31b',{method:'PUT',body:{base_url:'http://127.0.0.1:19001/v1',model:'synthetic-only',api_key:'synthetic-no-network'},headers:{...headers,'x-csrf-token':f.csrf,origin:remoteOrigin}});assert.equal(connection.status,200);assert.equal(connection.data.connections.find(row=>row.id==='gpu31b').api_key_configured,true);assert.doesNotMatch(JSON.stringify(connection.data),/synthetic-no-network/);
});
