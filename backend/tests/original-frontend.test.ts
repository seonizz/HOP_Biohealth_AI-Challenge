import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {OriginalFrontendService,originalPayload} from '../src/original-frontend.ts';
import {ModelGateway} from '../src/llm.ts';
import {fixture,databaseUrl} from './v2-fixture.ts';
const catalog=JSON.parse(readFileSync(new URL('../data/original-frontend.json',import.meta.url),'utf8'));
const integration=databaseUrl?test:test.skip;
const request=()=>({request_id:randomUUID()});
function payload(){return {name:'검증친구',tags:[],answers:catalog.questions.filter((q:any)=>q.id!=='gap_obs').map((q:any)=>({id:q.id,question:q.q,type:q.type,freeText:!!q.cue,text:q.id==='name'?'검증친구':q.type==='text'?'친구가 식사를 거의 하지 않아서 걱정이 됩니다.':Array.isArray(q.opts[0])?q.opts[0][0]:q.opts[0],custom:'',skipped:false,selected:q.opts?[{label:Array.isArray(q.opts[0])?q.opts[0][0]:q.opts[0],meta:{d:999,s:'forged',t:'forged'}}]:[]}))};}
test('original 30-question payload uses server option metadata and rejects a v2 catalog ID',()=>{
  const raw=payload(),clean=originalPayload(raw);
  assert.equal(clean.answers.length,30);
  const mood=clean.answers.find((a:any)=>a.id==='mood');
  assert.equal(mood.selected[0].meta.d,2);assert.equal(mood.selected[0].meta.s,'depressive_mood');
  assert.ok(!clean.tags.includes('forged'));
  raw.answers[0].id='N00';assert.throws(()=>originalPayload(raw));
});
integration('prototype main flow persists encrypted original result, restores history, enforces ownership and deletes idempotently',async t=>{
  const f=await fixture(t),u=await f.user(),other=await f.user();
  const gateway={} as ModelGateway; // Prototype mode must not call a live gateway.
  const adapter=new OriginalFrontendService(f.service,gateway,'prototype');
  const create={...request(),payload:payload()},created=await adapter.create(u.owner,create);
  const repeated=await adapter.create(u.owner,create);assert.equal(repeated.project_id,created.project_id);
  const id=created.project_id,context=await adapter.context(u.owner,id,request());
  assert.equal(context.model_mode,'prototype');assert.ok(context.scores.우울>0);
  await adapter.draft(u.owner,id,request());const {guide}=await adapter.guide(u.owner,id,request());
  assert.ok(guide.script.includes('지금 바로 대답하지 않아도 돼.'));assert.ok(guide.care.tips.length>0);
  const complete={...request(),record_id:Date.now(),date:new Date().toISOString(),log:[{who:'me',text:'합성 검증 답변'}],followUps:1};
  await adapter.complete(u.owner,id,complete);await adapter.complete(u.owner,id,complete);
  const records=(await adapter.list(u.owner)).records;assert.equal(records.length,1);assert.equal(records[0].profile.answers.want,'친구가 식사를 거의 하지 않아서 걱정이 됩니다.');
  assert.deepEqual(records[0].guide,guide);
  const cipher=await f.admin.pool.query('SELECT encrypted_payload FROM v2_projects WHERE id=$1',[id]);
  assert.ok(!JSON.stringify(cipher.rows[0]).includes('합성 검증 답변'));
  assert.deepEqual((await adapter.list(other.owner)).records,[]);
  await assert.rejects(adapter.data(other.owner,id),(e:any)=>e.status===404);
  const deletion=request();await adapter.delete(u.owner,id,deletion);await adapter.delete(u.owner,id,deletion);
  assert.deepEqual((await adapter.list(u.owner)).records,[]);
  assert.equal((await f.admin.pool.query('SELECT id FROM projects WHERE id=$1',[id])).rowCount,0);
});
integration('disabled live model saves input and does not manufacture a prototype result',async t=>{
  const f=await fixture(t),u=await f.user(),adapter=new OriginalFrontendService(f.service,{} as ModelGateway,'local');
  const {project_id:id}=await adapter.create(u.owner,{...request(),payload:payload()});
  await assert.rejects(adapter.context(u.owner,id,request()),(e:any)=>e.code==='MODEL_UNAVAILABLE');
  assert.equal((await adapter.data(u.owner,id)).payload.answers.length,30);
  assert.equal((await adapter.data(u.owner,id)).guide,undefined);
  assert.deepEqual((await adapter.list(u.owner)).records,[]);
});
