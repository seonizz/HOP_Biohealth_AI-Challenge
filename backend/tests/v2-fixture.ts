import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {Store} from '../src/storage.ts';
import {ContentCipher} from '../src/v2/crypto.ts';
import {V2Database} from '../src/v2/db.ts';
import {MalssiService,PURPOSES,CONSENT_VERSION} from '../src/v2/service.ts';
export const databaseUrl=process.env.HOP_TEST_DATABASE_URL || process.env.DATABASE_URL || '';
export async function fixture(t:any,modelEnabled=false){
 const schema='malssi_test_'+randomUUID().replaceAll('-',''),admin=await Store.connect(databaseUrl,{schema});
 let runtimeUrl=process.env.HOP_TEST_RUNTIME_DATABASE_URL,createdRole:string|undefined;
 if(!runtimeUrl){
  const role='malssi_rt_'+randomUUID().replaceAll('-',''),password=randomBytes(24).toString('hex');
  await admin.pool.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`);createdRole=role;
  const url=new URL(databaseUrl);url.username=role;url.password=password;runtimeUrl=url.toString();
 }
 const runtimeRole=decodeURIComponent(new URL(runtimeUrl).username);assert.match(runtimeRole,/^[a-z_][a-z0-9_]*$/);
 await admin.pool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}"`);
 await admin.pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${runtimeRole}"`);
 await admin.pool.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${runtimeRole}"`);
 const key=randomBytes(32).toString('base64'),runtime=await Store.connect(runtimeUrl,{schema,migrate:false}),cipher=new ContentCipher(key),db=new V2Database(runtime.pool,cipher);
 await db.assertRuntimeRole();const service=new MalssiService(db,{allowDraft:true,modelEnabled});
 t.after(async()=>{await runtime.close();assert.match(schema,/^malssi_test_[a-f0-9]{32}$/);try{await admin.pool.query(`DROP SCHEMA "${schema}" CASCADE`);if(createdRole)await admin.pool.query(`DROP ROLE "${createdRole}"`);}finally{await admin.close();}});
 async function user(history=true,memory=true){
  const u=await admin.createUser(randomUUID()+'@example.invalid','scrypt$fixture');
  await service.setConsents(u.id,{request_id:randomUUID(),version:CONSENT_VERSION,purposes:Object.fromEntries(PURPOSES.map(p=>[p,p==='history_storage'?history:p==='cross_session_memory'?memory:true]))});
  const project=await service.createProject(u.id,{request_id:randomUUID(),alias:'엄마'});
  const conversation=await service.createConversation(u.id,project.project_id,{request_id:randomUUID(),goal:'understand'});
  return {owner:u.id,pid:project.project_id,cid:conversation.conversation_id};
 }
 async function turn(u:any,action:string,payload:any){const c=await service.readConversation(u.owner,u.cid);return service.turn(u.owner,u.cid,{request_id:randomUUID(),expected_revision:c.resource_revision,action,payload});}
 async function answer(u:any,value:any,disposition='answered'){const c=await service.readConversation(u.owner,u.cid);return service.turn(u.owner,u.cid,{request_id:randomUUID(),expected_revision:c.resource_revision,action:'answer',payload:{question_instance_id:c.question.id,question_id:c.question.question_id,question_version:c.question.question_version,disposition,value}});}
 return {admin,runtime,db,service,user,turn,answer,cipher,schema,key,runtimeUrl};
}
