import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {Store} from '../src/store.js';

test('intake metadata is owner-scoped and never decrypts or fetches intake content', async () => {
  const requests=[];
  const store=new Store({query:async (sql,values)=>{
    requests.push({sql,values});
    return {rowCount:values[1]==='owner'?1:0,rows:[{revision:7}]};
  }},randomBytes(32));
  store.open=()=>assert.fail('metadata must not decrypt intake content');
  assert.deepEqual(await store.intakeMetadata('owner','intake'),{id:'intake',revision:7});
  await assert.rejects(store.intakeMetadata('other-owner','intake'),{status:404});
  assert.equal(requests.length,2);
  for(const {sql} of requests) {
    assert.match(sql,/SELECT revision FROM intakes WHERE id=\$1 AND owner=\$2/u);
    assert.doesNotMatch(sql,/content|UPDATE/u);
  }
});

function sourceFixture(previousCount=0,{found=true,revision=3,ownerExists=true}={}) {
  const statements=[],owner='owner',id='current',source='record';
  let store;
  const record={id:source,profile:{name:'합성 기록'}};
  const history=Array.from({length:previousCount},(_,index)=>({id:`previous-${index}`,owner,
    content:null,messages:[{id:`user-${index}`,role:'user',text:`합성 보고 ${index}`}]}));
  const row={id,owner,revision,source_record_id:source,sequence:previousCount+1,
    content:null,record_content:null};
  const client={release(){statements.push({sql:'RELEASE'});},async query(sql,values){
    statements.push({sql,values});
    if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK')return {};
    if(sql.includes('FROM browsers')) {
      assert.match(sql,/FOR SHARE$/u);
      assert.deepEqual(values,[owner,30]);
      return {rowCount:ownerExists?1:0,rows:[{conversation_epoch:0}]};
    }
    if(sql.includes('JOIN records')) {
      assert.deepEqual(values,[owner,id]);
      assert.match(sql,/r.owner=s.owner AND r.id=s.source_record_id/u);
      return {rowCount:found?1:0,rows:[row]};
    }
    assert.match(sql,/owner=\$1 AND source_record_id=\$2 AND sequence<\$3 ORDER BY sequence/u);
    assert.deepEqual(values,[owner,source,previousCount+1]);
    return {rowCount:history.length,rows:history};
  }};
  store=new Store({connect:async()=>client},randomBytes(32));
  row.content=store.seal({messages:[{id:'latest',role:'user',text:'현재 합성 보고'}]},`${owner}:continuation:${id}`);
  row.record_content=store.seal(record,`${owner}:record:${source}`);
  for(const previous of history)previous.content=store.seal({messages:previous.messages},`${owner}:continuation:${previous.id}`);
  return {store,statements,row,history,record,owner,id};
}

for(const count of [0,1,7])test(`source snapshot uses one transaction and fixed query count for ${count} previous rounds`,async()=>{
  const f=sourceFixture(count),decrypted=[];
  const open=f.store.open.bind(f.store);
  f.store.open=(value,aad)=>{decrypted.push(aad);return open(value,aad);};
  const snapshot=await f.store.continuationSources(f.owner,f.id,3);
  assert.deepEqual(snapshot,{record:f.record,messages:[...f.history.flatMap(row=>row.messages),{id:'latest',role:'user',text:'현재 합성 보고'}]});
  assert.equal(f.statements.filter(({sql})=>sql==='BEGIN').length,1);
  assert.equal(f.statements.filter(({sql})=>sql.startsWith('SELECT')).length,3);
  assert.deepEqual(f.statements.slice(-2).map(({sql})=>sql),['COMMIT','RELEASE']);
  assert.deepEqual(decrypted,[`${f.owner}:record:record`,...f.history.map(row=>`${f.owner}:continuation:${row.id}`),`${f.owner}:continuation:${f.id}`]);
});

for(const [label,options,error] of [
  ['missing session',{found:false},{status:404}],
  ['changed current revision',{revision:4},{code:'REVISION_CONFLICT'}],
  ['expired or deleted owner',{ownerExists:false},{status:404}],
])test(`source snapshot rejects ${label} before opening record or prior messages`,async()=>{
  const f=sourceFixture(2,options);
  f.store.open=()=>assert.fail('invalid snapshots must not decrypt');
  await assert.rejects(f.store.continuationSources(f.owner,f.id,3),error);
  assert.deepEqual(f.statements.slice(-2).map(({sql})=>sql),['ROLLBACK','RELEASE']);
  assert.equal(f.statements.some(({sql})=>sql.includes('sequence<$3')),false);
});

test('source snapshot retains per-round AAD authentication instead of accepting swapped ciphertext',async()=>{
  const f=sourceFixture(2);
  [f.history[0].content,f.history[1].content]=[f.history[1].content,f.history[0].content];
  await assert.rejects(f.store.continuationSources(f.owner,f.id,3));
  assert.deepEqual(f.statements.slice(-2).map(({sql})=>sql),['ROLLBACK','RELEASE']);
});
