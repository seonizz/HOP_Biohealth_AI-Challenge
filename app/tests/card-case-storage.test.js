import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {Store} from '../src/store.js';
import {fixture} from './helpers/final-flow-fixture.js';

test('reviewed internal case detail survives encrypted final record storage without changing cards',{
 skip:!process.env.TEST_DATABASE_URL&&'Requires isolated PostgreSQL test database',
},async t=>{
 const schema='case_detail_'+randomUUID().replaceAll('-','');
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,connectionTimeoutMillis:5000});
 let store;
 t.after(async()=>{try{await store?.close();}finally{try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);}finally{await admin.end();}}});
 await admin.query(`CREATE SCHEMA "${schema}"`);
 store=await Store.connect(process.env.TEST_DATABASE_URL,randomBytes(32),30,{schema});
 const standard=fixture(),detailed=fixture({detailedCardAnalysis:true,extendedFinalEvidenceIds:true,bundleAnalysisPlan:true});
 const before=await standard.run(),result=await detailed.run();
 assert.deepEqual(result.guide,before.guide);
 assert.equal(result.agent.case_formulation.reviewed,true);
 assert.equal(result.agent.case_formulation.coverage.emotion.status,'unknown');
 const owner=(await store.createBrowser()).id,other=(await store.createBrowser()).id;
 const record={id:await store.nextRecordId(),title:'합성 검증',date:new Date().toISOString(),guide:result.guide,
  relationship_analysis:result.relationship_analysis,provenance:{kind:'model',agent:result.agent}};
 await store.saveRecord(owner,record);
 const loaded=await store.record(owner,record.id);assert.deepEqual(loaded,record);
 assert.deepEqual(loaded.provenance.agent.case_formulation,result.agent.case_formulation);
 assert.equal((await store.records(owner)).length,1);await assert.rejects(store.record(other,record.id),{status:404});
 const encrypted=(await store.pool.query('SELECT content FROM records WHERE owner=$1 AND id=$2',[owner,String(record.id)])).rows[0].content;
 assert.equal(encrypted.includes(result.agent.case_formulation.findings[0].interpretation),false);
});
