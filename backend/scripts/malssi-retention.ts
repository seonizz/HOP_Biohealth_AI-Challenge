import { Store } from '../src/storage.ts';
import { getSettings } from '../src/config.ts';
import { ContentCipher } from '../src/v2/crypto.ts';
import { V2Database } from '../src/v2/db.ts';

// Invoke hourly using the existing user-space supervisor. No OS service installation.
const settings=getSettings();const store=await Store.connect(settings.databaseUrl,{schema:settings.databaseSchema,migrate:false});
const db=new V2Database(store.pool,new ContentCipher(settings.contentKey));await db.assertRuntimeRole();
let expired=0,expiredGuests=0;
try{
  const owners=await store.pool.query('SELECT id,demo_expires_at FROM users');
  for(const {id:owner,demo_expires_at:demoExpiry} of owners.rows)await db.transaction(owner,async tx=>{
    const projects=await tx.query('SELECT id FROM v2_projects WHERE owner_id=$1 AND expires_at<=now()',[owner]);
    for(const p of projects.rows){await tx.invalidate(p.id,'CANCELLED');await tx.receipt('delete_project',p.id);await tx.query('DELETE FROM projects WHERE id=$1 AND owner=$2',[p.id,owner]);expired++;}
    if(projects.rowCount)await tx.query('DELETE FROM requests_v2 WHERE owner_id=$1',[owner]);
    await tx.query("DELETE FROM outbox_events WHERE owner_id=$1 AND created_at<now()-interval '24 hours'",[owner]);
    await tx.query("DELETE FROM agent_runs WHERE owner_id=$1 AND status NOT IN ('ACCEPTED','RUNNING') AND created_at<now()-interval '30 days'",[owner]);
    await tx.query("DELETE FROM audit_events WHERE owner_id=$1 AND created_at<now()-interval '90 days'",[owner]);
    await tx.query('DELETE FROM deletion_requests WHERE owner_id=$1 AND purge_after<now()',[owner]);
    if(demoExpiry && new Date(demoExpiry).getTime()<=Date.now()){
      const active=await tx.query('SELECT id FROM v2_projects WHERE owner_id=$1',[owner]);
      for(const p of active.rows)await tx.invalidate(p.id,'CANCELLED');
      await tx.receipt('delete_account',owner);
      await tx.query('DELETE FROM users WHERE id=$1',[owner]);
      expiredGuests++;
    }
  });
  console.log(JSON.stringify({expired_projects:expired,expired_demo_accounts:expiredGuests}));
}finally{await store.close();}
