import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { MalssiService, PURPOSES } from './service.ts';
import { catalog, catalogHash, assertCatalogPublishable } from './questions.ts';
import {inputHash} from './crypto.ts';
import { SAFETY_TEXT } from './safety.ts';
import { V2Error, fail, keys, record, uuid } from './errors.ts';
import { verifyPassword } from '../auth.ts';
import type { Store } from '../storage.ts';

const respond=(res:ServerResponse,status:number,data:any)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
async function readBody(req:IncomingMessage) {
  const deleting=req.method==='DELETE',length=req.headers['content-length'];
  if(deleting&&(length==='0'||length===undefined)&&req.headers['idempotency-key'])return {request_id:req.headers['idempotency-key'],expected_revision:Number(String(req.headers['if-match']||'').replaceAll('"',''))};
  if(!(req.headers['content-type']||'').startsWith('application/json'))fail('UNSUPPORTED_MEDIA_TYPE',415);
  let bytes=0;const chunks:Buffer[]=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>65536)fail('BODY_TOO_LARGE',413);chunks.push(chunk);}
  let value:any;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('MALFORMED_JSON',400);}record(value);
  if(deleting){if(req.headers['idempotency-key']&&req.headers['idempotency-key']!==value.request_id)fail('IDEMPOTENCY_CONFLICT',409);if(req.headers['if-match']&&Number(String(req.headers['if-match']).replaceAll('"',''))!==value.expected_revision)fail('REVISION_CONFLICT',409);}
  return value;
}
export async function publicV2(req:IncomingMessage,res:ServerResponse,service:MalssiService|null,store:Store,demoMode=false) {
  const path=new URL(req.url||'/','http://localhost').pathname;
  if(req.method==='GET'&&path==='/health/live'){respond(res,200,{live:true});return true;}
  if(req.method==='GET'&&path==='/help/safety'){respond(res,200,{text:SAFETY_TEXT,phone_numbers:[],country_required:true});return true;}
  if(req.method==='GET'&&path==='/openapi-v2.json'){res.writeHead(200,{'Content-Type':'application/json'});res.end(readFileSync(new URL('../../openapi-v2.json',import.meta.url)));return true;}
  if(req.method==='GET'&&path==='/health/ready'){
    let ready=Boolean(service);try{await store.pool.query('SELECT 1');if (!(demoMode && service?.allowDraft)) assertCatalogPublishable();}catch{ready=false;}
    respond(res,ready?200:503,{ready,api_version:'2.0',reason:ready?null:'V2 policy, published catalog, encryption key and database must be configured.'});return true;
  }
  if(req.method==='GET'&&/^\/api\/v2\/deletions\/[^/]+$/.test(path)&&req.headers.authorization?.startsWith('Deletion ')) {
    if(!service)fail('FEATURE_UNAVAILABLE',503);
    const [owner,secret]=req.headers.authorization.slice(9).split('.');uuid(owner);const id=uuid(path.split('/').at(-1));
    if(!secret||secret.length>100)fail('UNAUTHENTICATED',401);
    const result=await service.db.transaction(owner,async tx=>{
      const row=await tx.query('SELECT id,scope,online_purged,derived_purged,backup_expires_at FROM deletion_requests WHERE owner_id=$1 AND id=$2 AND receipt_hash=$3 AND receipt_expires_at>now()',[owner,id,inputHash(secret)]);
      return row.rows[0]||fail('UNAUTHENTICATED',401);
    });respond(res,200,result);return true;
  }
  return false;
}
export async function routeV2(req:IncomingMessage,res:ServerResponse,owner:string,service:MalssiService|null,store:Store) {
  const url=new URL(req.url||'/','http://localhost'),path=url.pathname;if(!path.startsWith('/api/v2/'))return false;
  if(!service)fail('FEATURE_UNAVAILABLE',503);
  const method=req.method||'GET',input=method==='GET'?null:await readBody(req);
  const send=(data:any,status=200)=>respond(res,status,data);
  if(path==='/api/v2/capabilities'&&method==='GET'){
    const slot=(await service.db.pool.query('SELECT circuit_until FROM model_slots WHERE id=1')).rows[0];
    send({schema_version:'2.0',structured_interview:true,personalized_guidance:false,model_execution_enabled:service.modelEnabled,dual_turn_enabled:service.dualEnabled,model_validation:'not_release_validated',circuit_open:Boolean(slot?.circuit_until&&new Date(slot.circuit_until).getTime()>Date.now()),reviewed_fallback:false,resource_directory:false,questionnaire_status:catalog.publication_status,internal_draft:service.allowDraft});
  } else if(path==='/api/v2/consents'&&method==='GET')send(await service.consents(owner));
  else if(path==='/api/v2/consents'&&method==='POST')send(await service.setConsents(owner,input),201);
  else if(path==='/api/v2/consents/withdraw'&&method==='POST')send(await service.withdraw(owner,input),202);
  else if(path==='/api/v2/resources'&&method==='GET')send({resources:[],country_required:!url.searchParams.get('country'),reason:'NO_APPROVED_RESOURCES'});
  else if(path.startsWith('/api/v2/questionnaires/')&&method==='GET'){service.checkCatalog();if(decodeURIComponent(path.split('/').at(-1)!)!==catalog.questionnaire_version)fail('NOT_FOUND',404);send({catalog,hash:catalogHash});}
  else if(path==='/api/v2/projects'&&method==='POST')send(await service.createProject(owner,input),201);
  else if(path==='/api/v2/projects'&&method==='GET')send(await service.listProjects(owner,Number(url.searchParams.get('limit')||50),url.searchParams.get('cursor')||undefined));
  else if(path==='/api/v2/account'&&method==='DELETE'){
    keys(record(input),['request_id','current_password'],['request_id','current_password']);uuid(input.request_id);
    const user=await store.getUser(owner),stored=user?await store.findUserByEmail(user.email):null;
    if(!stored||typeof input.current_password!=='string'||!await verifyPassword(input.current_password,stored.password_hash))fail('UNAUTHENTICATED',401);
    const receiptToken=randomBytes(32).toString('base64url');
    const receipt=await service.db.transaction(owner,async tx=>{
      const projects=await tx.query('SELECT id FROM v2_projects WHERE owner_id=$1',[owner]);
      for(const p of projects.rows)await tx.invalidate(p.id,'CANCELLED');
      const receipt=await tx.receipt('delete_account',owner,receiptToken);await tx.query('DELETE FROM users WHERE id=$1',[owner]);return receipt;
    });
    send({deletion_id:receipt.id,receipt:owner+'.'+receiptToken,receipt_expires_in:3600,online_purged:true,derived_purged:true,backup_expires_at:receipt.backup_expires_at},202);
  } else {
    const m=/^\/api\/v2\/(projects|conversations|runs|memories|messages|plans|deletions|alerts)\/([^/]+)(?:\/(conversations|messages|turns|events|memories|confirm|cancel|retry|plans|feedback|alerts|shown))?$/.exec(path);
    if(!m)fail('NOT_FOUND',404);const [,resource,id,action]=m;uuid(id);
    if(resource==='projects'&&!action&&method==='GET')send(await service.readProject(owner,id));
    else if(resource==='projects'&&!action&&method==='PATCH')send(await service.patchProject(owner,id,input));
    else if(resource==='projects'&&!action&&method==='DELETE')send(await service.deleteProject(owner,id,input),202);
    else if(resource==='projects'&&action==='conversations'&&method==='POST')send(await service.createConversation(owner,id,input),201);
    else if(resource==='projects'&&action==='conversations'&&method==='GET')send(await service.listConversations(owner,id,Number(url.searchParams.get('limit')||50),url.searchParams.get('cursor')||undefined));
    else if(resource==='projects'&&action==='memories'&&method==='GET')send(await service.memories(owner,id,url.searchParams.get('status')||undefined,url.searchParams.get('entity')||undefined));
    else if(resource==='conversations'&&!action&&method==='GET')send(await service.readConversation(owner,id));
    else if(resource==='conversations'&&action==='messages'&&method==='GET')send(await service.messages(owner,id,Number(url.searchParams.get('limit')||100),url.searchParams.get('cursor')||undefined));
    else if(resource==='conversations'&&action==='alerts'&&method==='GET')send(await service.alerts(owner,id));
    else if(resource==='alerts'&&action==='shown'&&method==='POST'){keys(record(input),['response_id'],['response_id']);send(await service.acknowledgeAlert(owner,id,input.response_id));}
    else if(resource==='conversations'&&action==='turns'&&method==='POST'){const result=await service.turn(owner,id,input);send(result,result.run_id?202:200);}
    else if(resource==='conversations'&&action==='plans'&&method==='POST')send(await service.choosePlan(owner,id,input),201);
    else if(resource==='runs'&&!action&&method==='GET')send(await service.run(owner,id));
    else if(resource==='runs'&&action==='cancel'&&method==='POST')send(await service.cancel(owner,id,input));
    else if(resource==='runs'&&action==='retry'&&method==='POST')send(await service.retryRun(owner,id,input));
    else if(resource==='memories'&&action==='confirm'&&method==='POST')send(await service.mutateMemory(owner,id,input,'confirm'));
    else if(resource==='memories'&&!action&&method==='PATCH')send(await service.mutateMemory(owner,id,input,'correct'));
    else if(resource==='memories'&&!action&&method==='DELETE')send(await service.mutateMemory(owner,id,{scope:'forget_memory',...input},'forget'),202);
    else if(resource==='messages'&&!action&&method==='DELETE')send(await service.deleteSource(owner,id,{scope:'delete_source',...input}),202);
    else if(resource==='plans'&&action==='feedback'&&method==='POST')send(await service.feedback(owner,id,input),201);
    else if(resource==='deletions'&&!action&&method==='GET')send(await service.deletion(owner,id));
    else if(resource==='conversations'&&action==='events'&&method==='GET'){
      if(url.search)fail(); // Tokens and personal content must never be carried in SSE URLs.
      const last=req.headers['last-event-id'];if(last&&(!/^\d+$/.test(String(last))||String(last).length>18))fail();
      let cursor=BigInt(String(last||0));
      const load=()=>service.db.transaction(owner,async tx=>{await tx.consent();const {c}=await tx.conversation(id);const events=await tx.query("SELECT sequence_id,type,resource_ref FROM outbox_events WHERE owner_id=$1 AND conversation_id=$2 AND created_at>now()-interval '24 hours' ORDER BY sequence_id",[owner,id]);return {c,events:events.rows};});
      const initial=await load();res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Connection':'keep-alive','X-Accel-Buffering':'no'});
      const flush=(snapshot:any)=>{
        const min=snapshot.events.length?BigInt(snapshot.events[0].sequence_id):BigInt(snapshot.c.event_sequence)+1n;
        if(cursor>0n&&(cursor<min-1n||cursor>BigInt(snapshot.c.event_sequence))){res.write(`event: snapshot_required\ndata: ${JSON.stringify({url:'/api/v2/conversations/'+id})}\n\n`);cursor=BigInt(snapshot.c.event_sequence);return;}
        for(const event of snapshot.events)if(BigInt(event.sequence_id)>cursor){res.write(`id: ${event.sequence_id}\nevent: ${event.type}\ndata: ${JSON.stringify({resource_id:event.resource_ref})}\n\n`);cursor=BigInt(event.sequence_id);}
      };
      flush(initial);let checking=false,closed=false;const close=()=>{if(closed)return;closed=true;clearInterval(timer);res.end();};
      const timer=setInterval(async()=>{if(checking||closed)return;checking=true;try{
        const auth=req.headers.authorization?.startsWith('Bearer ')?req.headers.authorization.slice(7):/hop_session=([^;]+)/.exec(req.headers.cookie||'')?.[1];
        if(!auth||await store.authenticate(auth)!==owner){res.write('event: reauthenticate\ndata: {}\n\n');close();return;}
        flush(await load());res.write(': heartbeat\n\n');
      }catch{close();}finally{checking=false;}},15000);timer.unref();res.on('close',close);
    }else fail('NOT_FOUND',404);
  }
  return true;
}
