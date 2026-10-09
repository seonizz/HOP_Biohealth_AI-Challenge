import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {Store} from '../src/storage.ts';
import {getSettings} from '../src/config.ts';
import {ContentCipher} from '../src/v2/crypto.ts';
import {V2Database} from '../src/v2/db.ts';
import {replayTombstones} from '../src/v2/restore.ts';
const [mode,file]=process.argv.slice(2);
if(!['export','apply'].includes(mode)||!file)throw new Error('Usage: malssi-deletion-ledger.ts export|apply absolute-ledger-file');
const path=resolve(file);if(realpathSync(dirname(path))!==dirname(path))throw new Error('Use a canonical ledger directory');
const settings=getSettings(),store=await Store.connect(settings.databaseUrl,{schema:settings.databaseSchema,migrate:false}),cipher=new ContentCipher(settings.contentKey),db=new V2Database(store.pool,cipher);
await db.assertRuntimeRole();
try{
 if(mode==='export') {
  const owners=(await store.pool.query('SELECT DISTINCT owner_id FROM deletion_index')).rows,records=[];
  for(const row of owners)records.push(...await db.transaction(row.owner_id,async tx=>(await tx.query('SELECT owner_id,scope,random_resource_id FROM deletion_requests WHERE owner_id=$1 AND purge_after>now()',[row.owner_id])).rows));
  writeFileSync(path,JSON.stringify(cipher.seal({version:1,exported_at:new Date().toISOString(),records},'malssi-deletion-ledger-v1')),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({exported:records.length}));
 } else {
  if(process.env.HOP_RESTORE_PENDING!=='true')throw new Error('Keep restored API disabled with HOP_RESTORE_PENDING=true until ledger replay completes');
  const ledger=cipher.open(JSON.parse(readFileSync(path,'utf8')),'malssi-deletion-ledger-v1');
  if(ledger.version!==1||!Array.isArray(ledger.records))throw new Error('Invalid deletion ledger');
  console.log(JSON.stringify(await replayTombstones(db,ledger.records)));
 }
}finally{await store.close();}
