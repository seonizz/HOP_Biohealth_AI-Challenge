import {V2Database} from './db.ts';
import {MalssiService} from './service.ts';
import {fail,uuid} from './errors.ts';
export interface Tombstone {owner_id:string;scope:string;random_resource_id:string;}

/** Apply an independently retained, authenticated deletion ledger before exposing a restored database.
 * Conservative invalidation removes dependent guides/plans too. It never reconstructs source text.
 */
export async function replayTombstones(db:V2Database,records:Tombstone[]) {
 const service=new MalssiService(db);let applied=0;
 for(const tombstone of records) {
  uuid(tombstone.owner_id);uuid(tombstone.random_resource_id);
  if(!['delete_account','delete_project','delete_source','forget_memory','withdraw_consent'].includes(tombstone.scope))fail();
  await db.transaction(tombstone.owner_id,async tx=>{
   const id=tombstone.random_resource_id;
   if(tombstone.scope==='delete_account'){await tx.query('DELETE FROM users WHERE id=$1',[id]);return;}
   if(tombstone.scope==='delete_project'){await tx.query('DELETE FROM projects WHERE id=$1 AND owner=$2',[id,tx.owner]);return;}
   if(tombstone.scope==='withdraw_consent') {
    await tx.query('DELETE FROM projects WHERE owner=$1 AND api_version=2',[tx.owner]);
    await tx.query("UPDATE consent_records SET accepted=false WHERE owner_id=$1 AND purpose IN ('service_processing','sensitive_processing')",[tx.owner]);return;
   }
   const table=tombstone.scope==='delete_source'?'v2_messages':'memory_items';
   const raw=await tx.query(`SELECT * FROM ${table} WHERE id=$1 AND owner_id=$2`,[id,tx.owner]);if(!raw.rowCount)return;
   const project=raw.rows[0].project_id;
   // Temporary keys are deliberately absent from a backup. Such projects must be purged unread.
   const temporary=await tx.query('SELECT temporary FROM v2_projects WHERE id=$1 AND owner_id=$2',[project,tx.owner]);
   if(temporary.rows[0]?.temporary){await tx.query('DELETE FROM projects WHERE id=$1 AND owner=$2',[project,tx.owner]);return;}
   const p=await tx.project(project,true),record=tx.decode(raw.rows[0]);
   const refs=tombstone.scope==='delete_source'?[id]:record.data.source_refs.flatMap((s:any)=>[s.message_id,s.answer_revision_id]).filter(Boolean);
   await service.invalidateSources(tx,p,refs,true);
   if(tombstone.scope==='delete_source') {
    for(const answer of await tx.rows('answer_revisions',project))if(answer.data.message_id===id)await tx.query('DELETE FROM answer_revisions WHERE id=$1 AND owner_id=$2',[answer.id,tx.owner]);
   }
   await tx.query(`DELETE FROM ${table} WHERE id=$1 AND owner_id=$2`,[id,tx.owner]);
  });applied++;
 }
 return {applied};
}
