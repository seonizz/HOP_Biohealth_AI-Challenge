import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,chmodSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {checkOperationsEvidence,STORAGE_AREAS} from '../scripts/check-operations.js';
import {sourceFingerprint} from '../src/source-identity.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const script=fileURLToPath(new URL('../scripts/check-operations.js',import.meta.url));
const template=fileURLToPath(new URL('../docs/operations-evidence.template.json',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const codes=report=>report.issues.map(issue=>issue.code);
function fixture(t,{syntheticMarker=true}={}){
  const directory=realpathSync(mkdtempSync(join(tmpdir(),'malssi-operations-test-')));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const proof=name=>{
    const path=`evidence/${name}.json`,content=JSON.stringify({...syntheticMarker?{synthetic:true}:{},description:`Local test evidence for ${name}; no actual approval or deletion.`});
    mkdirSync(dirname(join(directory,path)),{recursive:true});writeFileSync(join(directory,path),content);
    return {path,sha256:hash(content)};
  };
  const value={schema_version:1,evidence_kind:'synthetic',service_id:'fixture-service',reviewed_at:'2026-01-04T00:00:00Z',
    policy:{status:'approved',inactivity_days:30,basis:'last_valid_api_access',approved_by:'Fixture Approver',approved_at:'2026-01-01T00:00:00Z',evidence:proof('approval')},
    deployment:{status:'verified',environment:'synthetic',deployment_id:'fixture-release',verified_by:'Fixture Verifier',verified_at:'2026-01-02T00:00:00Z',inactivity_days:30,source_sha256:sourceFingerprint(root).sha256,migration:'006_data_retention.sql',cleanup_healthy:true,evidence:proof('deployment')},
    storage_areas:STORAGE_AREAS.map(area=>({area,status:'present',owner:'Fixture Operator',inventory_evidence:proof(area+'-inventory'),absence_reason:null,locations:[{id:area+'-fixture',retention_days:30,expiry_rule:'Delete after the documented retention period.',expiration_verified:true,expiration_evidence:proof(area+'-expiration')}]})),
    restore_verification:{status:'verified',verified_by:'Fixture Restorer',verified_at:'2026-01-03T00:00:00Z',deletions_reapplied:true,expired_access_blocked:true,evidence:proof('restore')},
    failure_response:{status:'documented',owner:'Fixture Responder',evidence:proof('failure-response')}};
  const path=join(directory,'operations.json');
  const save=()=>writeFileSync(path,JSON.stringify(value,null,2));save();
  return {directory,path,value,proof,save,run:()=>{save();return checkOperationsEvidence(path);}};
}
function replaceEvidence(f,reference,content){
  writeFileSync(join(f.directory,reference.path),content);reference.sha256=hash(content);
}

test('the actual empty template remains pending with ordered missing fields and no readiness claim',()=>{
  const report=checkOperationsEvidence(template);
  assert.equal(report.status,'pending');assert.equal(report.passed,false);
  assert.equal(report.operational_evidence_complete,false);assert.equal(report.production_ready,false);
  assert.equal(report.evidence_files_checked,0);
  assert.deepEqual(report.issues.slice(0,4).map(issue=>issue.field),['service_id','reviewed_at','policy.status','policy.inactivity_days']);
  assert.ok(report.issues.some(issue=>issue.field==='restore_verification.deletions_reapplied'));
});

test('a fully populated synthetic fixture passes only local checks and never becomes operational evidence',t=>{
  const f=fixture(t),report=f.run();
  assert.equal(report.status,'synthetic_checks_passed');assert.equal(report.passed,true);
  assert.equal(report.operational_evidence_complete,false);assert.equal(report.production_ready,false);
  assert.equal(report.human_approval_authenticated,false);assert.equal(report.physical_deletion_verified,false);
  assert.equal(report.evidence_files_checked,16);assert.deepEqual(report.issues,[]);
});

test('declaring actual evidence does not authenticate people or authorize production',t=>{
  const f=fixture(t,{syntheticMarker:false});f.value.evidence_kind='actual';f.value.deployment.environment='production';
  const report=f.run();
  assert.equal(report.status,'evidence_complete');assert.equal(report.operational_evidence_complete,true);
  assert.equal(report.production_ready,false);assert.equal(report.human_approval_authenticated,false);
  assert.equal(report.physical_deletion_verified,false);
  assert.ok(report.limitations.some(value=>value.includes('truth of evidence')));
});

test('placeholder approvals, unfinished deployment and a wrong period cannot pass',t=>{
  const f=fixture(t);f.value.policy.approved_by='TBD';f.value.deployment.status='pending';f.value.deployment.inactivity_days=90;
  const report=f.run();assert.equal(report.passed,false);
  assert.ok(codes(report).includes('MEANINGFUL_VALUE_REQUIRED'));assert.ok(codes(report).includes('NOT_COMPLETE'));
  assert.ok(codes(report).includes('POLICY_MISMATCH'));
});

test('deployed source, migration and cleanup declarations must match the current contract',t=>{
  const f=fixture(t);f.value.deployment.source_sha256='a'.repeat(64);f.value.deployment.migration='005_conversation_epoch.sql';f.value.deployment.cleanup_healthy=false;
  const report=f.run();assert.equal(report.passed,false);assert.ok(codes(report).includes('CURRENT_SOURCE_MISMATCH'));
  for(const field of ['deployment.migration','deployment.cleanup_healthy'])assert.ok(report.issues.some(issue=>issue.field===field));
});

test('missing and tampered proof files fail without exposing paths, people or content',t=>{
  const f=fixture(t),privateText='synthetic-sensitive-content-do-not-output';
  f.value.policy.approved_by='synthetic-person-do-not-output';
  rmSync(join(f.directory,f.value.policy.evidence.path));
  writeFileSync(join(f.directory,f.value.deployment.evidence.path),privateText);
  const report=f.run(),display=JSON.stringify(report);
  assert.equal(report.passed,false);assert.ok(codes(report).includes('EVIDENCE_NOT_READABLE'));assert.ok(codes(report).includes('EVIDENCE_HASH_MISMATCH'));
  for(const value of [privateText,f.value.policy.approved_by,f.directory,f.value.policy.evidence.path])assert.equal(display.includes(value),false);
});

test('unreadable evidence is blocked even under a process that could bypass permission bits',t=>{
  const f=fixture(t),path=join(f.directory,f.value.policy.evidence.path);chmodSync(path,0o000);
  try{const report=f.run();assert.equal(report.passed,false);assert.ok(codes(report).includes('EVIDENCE_NOT_READABLE'));}
  finally{chmodSync(path,0o600);}
});

test('evidence links, traversal, remote URLs and credential paths are rejected',t=>{
  const f=fixture(t),original=f.value.policy.evidence.path;
  for(const path of ['../outside.json','/tmp/outside.json','https://example.org/proof','.env','evidence/content.key','evidence\\approval.json']){
    f.value.policy.evidence.path=path;assert.ok(codes(f.run()).includes('LOCAL_RELATIVE_EVIDENCE_PATH_REQUIRED'));
  }
  f.value.policy.evidence.path='evidence/link.json';symlinkSync(join(f.directory,original),join(f.directory,'evidence/link.json'));
  assert.ok(codes(f.run()).includes('EVIDENCE_NOT_READABLE'));
});

test('a matching hash cannot make an empty or placeholder document valid evidence',t=>{
  const f=fixture(t),path=join(f.directory,f.value.policy.evidence.path);
  for(const content of ['', '   ', 'TODO']){
    writeFileSync(path,content);f.value.policy.evidence.sha256=hash(content);
    const report=f.run();assert.equal(report.passed,false);
    assert.ok(codes(report).some(code=>['EVIDENCE_NOT_READABLE','EVIDENCE_PLACEHOLDER'].includes(code)));
  }
});

test('empty JSON containers, scalars and nested empty content are not evidence even with a matching hash',t=>{
  const f=fixture(t);
  for(const content of ['{}','[]','null','false','0','""','"   "','{"audit":[{},[],null,{"value":""}]}']){
    replaceEvidence(f,f.value.policy.evidence,content);
    const report=f.run();assert.equal(report.status,'pending');assert.equal(report.operational_evidence_complete,false);
    assert.ok(codes(report).includes('EVIDENCE_JSON_EMPTY'));
  }
  f.value.policy.evidence.path='evidence/approval.txt';replaceEvidence(f,f.value.policy.evidence,'{}');
  assert.ok(codes(f.run()).includes('EVIDENCE_JSON_EMPTY'));
});

test('actual declarations reject explicit synthetic evidence at any JSON depth',t=>{
  const f=fixture(t);f.value.evidence_kind='actual';f.value.deployment.environment='production';
  const report=f.run();assert.equal(report.status,'pending');assert.equal(report.operational_evidence_complete,false);
  assert.equal(report.issues.filter(issue=>issue.code==='EVIDENCE_SYNTHETIC_CONFLICT').length,16);
  const nested=fixture(t,{syntheticMarker:false});nested.value.evidence_kind='actual';nested.value.deployment.environment='production';
  for(const content of ['{"audit":[{"synthetic":true,"description":"Synthetic test proof"}]}','[{"audit":{"synthetic":true}}]']){
    replaceEvidence(nested,nested.value.policy.evidence,content);
    assert.ok(codes(nested.run()).includes('EVIDENCE_SYNTHETIC_CONFLICT'));
  }
  replaceEvidence(nested,nested.value.policy.evidence,'{"audit":[{"synthetic":false,"description":"Synthetic test of an actual-labelled document"}]}');
  assert.equal(nested.run().status,'evidence_complete');
});

test('duplicate evidence keys cannot hide synthetic markers and never expose submitted keys or values',t=>{
  const f=fixture(t,{syntheticMarker:false});f.value.evidence_kind='actual';f.value.deployment.environment='production';
  for(const content of ['{"synthetic":true,"synthetic":false,"private-key":"private-value"}',
    '{"audit":[{"synthetic":true,"synthe\\u0074ic":false,"private-key":"private-value"}]}']){
    replaceEvidence(f,f.value.policy.evidence,content);const report=f.run();
    assert.equal(report.status,'pending');assert.ok(codes(report).includes('EVIDENCE_DUPLICATE_KEYS'));
    for(const secret of ['private-key','private-value'])assert.equal(JSON.stringify(report).includes(secret),false);
  }
  const cli=spawnSync(process.execPath,[script,f.path],{encoding:'utf8'});
  assert.equal(cli.status,1);assert.equal(cli.stderr,'');assert.equal(JSON.parse(cli.stdout).status,'pending');
});

test('invalid JSON evidence and encoding fail without exposing parser messages',t=>{
  const f=fixture(t);
  for(const content of ['{"private-key":"private-value"',Buffer.from([0xff,0xfe,123,0])]){
    replaceEvidence(f,f.value.policy.evidence,content);const report=f.run();
    assert.equal(report.status,'pending');assert.ok(codes(report).includes('EVIDENCE_JSON_INVALID'));
    assert.equal(JSON.stringify(report).includes('private-value'),false);
  }
});

test('OP3 CLI rejects synthetic JSONL, malformed JSON text and invalid UTF-8 text',t=>{
  const f=fixture(t,{syntheticMarker:false});f.value.evidence_kind='actual';f.value.deployment.environment='production';
  for(const [name,content,code] of [
    ['approval.jsonl','{"synthetic":true}\n{"description":"SYNTHETIC_PRIVATE_MARKER"}\n','EVIDENCE_SYNTHETIC_CONFLICT'],
    ['approval.txt','{"description":"SYNTHETIC_PRIVATE_MARKER"','EVIDENCE_JSON_INVALID'],
    ['approval.txt',Buffer.from([0xff,0xfe,123,0]),'EVIDENCE_TEXT_INVALID']]){
    f.value.policy.evidence.path='evidence/'+name;replaceEvidence(f,f.value.policy.evidence,content);f.save();
    const cli=spawnSync(process.execPath,[script,f.path],{encoding:'utf8'});
    assert.equal(cli.status,1,name);assert.equal(cli.stderr,'');
    const report=JSON.parse(cli.stdout);
    assert.equal(report.status,'pending');assert.equal(report.operational_evidence_complete,false);
    assert.equal(report.evidence_files_checked,15);assert.ok(codes(report).includes(code));
    for(const key of ['production_ready','human_approval_authenticated','physical_deletion_verified'])assert.equal(report[key],false);
    for(const hidden of ['SYNTHETIC_PRIVATE_MARKER',name,f.directory])assert.equal(cli.stdout.includes(hidden),false);
  }
});

test('OP3 JSONL and NDJSON inspect every row and allow repeated keys in separate objects',t=>{
  const f=fixture(t,{syntheticMarker:false});f.value.evidence_kind='actual';f.value.deployment.environment='production';
  for(const extension of ['jsonl','ndjson','JSONL']){
    f.value.policy.evidence.path='evidence/approval.'+extension;
    replaceEvidence(f,f.value.policy.evidence,'\ufeff{"description":"First structural control"}\r\n\r\n{"description":"Second structural control"}\n');
    f.save();const cli=spawnSync(process.execPath,[script,f.path],{encoding:'utf8'});
    assert.equal(cli.status,0);assert.equal(cli.stderr,'');
    assert.equal(JSON.parse(cli.stdout).operational_evidence_complete,true);
    replaceEvidence(f,f.value.policy.evidence,'{"description":"First structural control"}\n{"nested":[{"synthetic":true}]}\n');
    assert.ok(codes(f.run()).includes('EVIDENCE_SYNTHETIC_CONFLICT'));
    f.value.evidence_kind='synthetic';f.value.deployment.environment='synthetic';
    const synthetic=f.run();assert.equal(synthetic.status,'synthetic_checks_passed');assert.equal(synthetic.operational_evidence_complete,false);
    f.value.evidence_kind='actual';f.value.deployment.environment='production';
  }
});

test('OP3 line-delimited evidence rejects malformed rows and decoded duplicate keys',t=>{
  const f=fixture(t,{syntheticMarker:false});f.value.evidence_kind='actual';f.value.deployment.environment='production';
  for(const extension of ['jsonl','ndjson']){
    f.value.policy.evidence.path='evidence/approval.'+extension;
    for(const [tail,code] of [
      ['{"description":"SYNTHETIC_PRIVATE_MARKER"','EVIDENCE_JSON_INVALID'],
      ['{"description":"SYNTHETIC_PRIVATE_MARKER"} trailing','EVIDENCE_JSON_INVALID'],
      ['{"nested":[{"synthetic":true,"synthe\\u0074ic":false}]}','EVIDENCE_DUPLICATE_KEYS']]){
      replaceEvidence(f,f.value.policy.evidence,'{"description":"Normal first row"}\n'+tail+'\n');
      const report=f.run();assert.equal(report.passed,false);assert.ok(codes(report).includes(code));
      assert.equal(JSON.stringify(report).includes('SYNTHETIC_PRIVATE_MARKER'),false);
    }
    for(const content of ['{}\n[]\nnull\n','false\n0\n""\n','{"description":"Control"}\nfalse\n']){
      replaceEvidence(f,f.value.policy.evidence,content);
      assert.ok(codes(f.run()).includes('EVIDENCE_JSON_EMPTY'));
    }
  }
});

test('OP3 readable text and Markdown controls pass without authenticating their meaning',t=>{
  const f=fixture(t,{syntheticMarker:false});f.value.evidence_kind='actual';f.value.deployment.environment='production';
  for(const [extension,content] of [['txt','Local structural control.\nNo actual operation occurred.'],['md','# Local structural control\n\nNo actual operation occurred.']]){
    f.value.policy.evidence.path='evidence/approval.'+extension;replaceEvidence(f,f.value.policy.evidence,content);f.save();
    const before=readFileSync(join(f.directory,f.value.policy.evidence.path));
    const cli=spawnSync(process.execPath,[script,f.path],{encoding:'utf8'}),report=JSON.parse(cli.stdout);
    assert.equal(cli.status,0);assert.equal(cli.stderr,'');assert.equal(report.evidence_files_checked,16);
    assert.equal(report.production_ready,false);assert.equal(report.human_approval_authenticated,false);
    assert.deepEqual(readFileSync(join(f.directory,f.value.policy.evidence.path)),before);
  }
});

test('OP3 changing structured evidence to text or Markdown cannot hide parse errors or synthetic markers',t=>{
  const f=fixture(t,{syntheticMarker:false});f.value.evidence_kind='actual';f.value.deployment.environment='production';
  for(const extension of ['txt','md']){
    f.value.policy.evidence.path='evidence/approval.'+extension;
    for(const [content,code] of [
      ['{"description":"First row"}\n{"synthetic":true}','EVIDENCE_JSON_INVALID'],
      ['{"nested":[{"synthetic":true}]}','EVIDENCE_SYNTHETIC_CONFLICT'],
      ['{"synthetic":true,"synthe\\u0074ic":false}','EVIDENCE_DUPLICATE_KEYS']]){
      replaceEvidence(f,f.value.policy.evidence,content);
      assert.ok(codes(f.run()).includes(code));
    }
  }
});

test('OP3 supported formats reject invalid UTF-8 and embedded text controls',t=>{
  const f=fixture(t);
  for(const extension of ['json','jsonl','ndjson','txt','md']){
    f.value.policy.evidence.path='evidence/approval.'+extension;
    for(const content of [Buffer.from([0xff,0xfe,123,0]),Buffer.from('Proof\u0000text'),Buffer.from('Proof\u0007text')]){
      replaceEvidence(f,f.value.policy.evidence,content);
      const report=f.run();assert.equal(report.passed,false,extension);assert.equal(report.evidence_files_checked,15);
      assert.ok(codes(report).some(code=>['EVIDENCE_JSON_INVALID','EVIDENCE_TEXT_INVALID'].includes(code)));
    }
  }
});

test('OP3 unsupported evidence formats cannot become complete from their hash alone',t=>{
  const f=fixture(t,{syntheticMarker:false});f.value.evidence_kind='actual';f.value.deployment.environment='production';
  for(const name of ['approval.pdf','approval.bin','approval.yaml','approval.log','approval']){
    f.value.policy.evidence.path='evidence/'+name;
    replaceEvidence(f,f.value.policy.evidence,'{"description":"Hashed structural control"}');
    const report=f.run();assert.equal(report.operational_evidence_complete,false);
    assert.equal(report.evidence_files_checked,15);assert.ok(codes(report).includes('EVIDENCE_FORMAT_UNSUPPORTED'));
  }
});

test('every storage area is required and duplicate or unknown areas fail',t=>{
  const f=fixture(t);f.value.storage_areas=f.value.storage_areas.filter(area=>area.area!=='backups');
  f.value.storage_areas.push(structuredClone(f.value.storage_areas[0]),{area:'invented'});
  const report=f.run();assert.equal(report.passed,false);
  for(const code of ['STORAGE_AREA_MISSING','DUPLICATE_STORAGE_AREA','UNKNOWN_STORAGE_AREA'])assert.ok(codes(report).includes(code));
});

test('not-used storage needs ownership, explicit absence reason and hashed inventory evidence',t=>{
  const f=fixture(t),area=f.value.storage_areas.find(area=>area.area==='replicas');
  area.status='not_used';area.locations=[];area.absence_reason='No replication is configured in this synthetic fixture.';
  assert.equal(f.run().passed,true);
  area.absence_reason=null;assert.equal(f.run().passed,false);
  area.absence_reason='No replication is configured in this synthetic fixture.';area.inventory_evidence=null;
  assert.equal(f.run().passed,false);
  f.value.storage_areas[0].status='not_used';assert.ok(codes(f.run()).includes('DATABASE_REQUIRED'));
});

test('each actual storage location needs a valid retention, expiration check and evidence',t=>{
  const f=fixture(t),area=f.value.storage_areas.find(area=>area.area==='backups');
  area.locations[0].retention_days=-1;area.locations[0].expiration_verified=false;area.locations[0].expiration_evidence=null;
  area.locations.push(structuredClone(area.locations[0]));
  const report=f.run();assert.equal(report.passed,false);
  for(const code of ['RETENTION_DAYS_INVALID','NOT_COMPLETE','OBJECT_REQUIRED','DUPLICATE_LOCATION'])assert.ok(codes(report).includes(code));
});

test('non-database retention can express hours or immediate expiry without changing the app policy',t=>{
  const f=fixture(t);
  f.value.storage_areas.find(area=>area.area==='wal').locations[0].retention_days=0.25;
  f.value.storage_areas.find(area=>area.area==='exports').locations[0].retention_days=0;
  assert.equal(f.run().passed,true);
  f.value.storage_areas[0].locations[0].retention_days=0.25;
  assert.ok(codes(f.run()).includes('RETENTION_DAYS_INVALID'));
});

test('restore evidence must include deleted-data reapplication and expired-access blocking',t=>{
  const f=fixture(t);f.value.restore_verification.deletions_reapplied=false;f.value.restore_verification.expired_access_blocked=false;
  f.value.failure_response.owner=null;
  const report=f.run();assert.equal(report.passed,false);
  for(const field of ['restore_verification.deletions_reapplied','restore_verification.expired_access_blocked','failure_response.owner'])assert.ok(report.issues.some(issue=>issue.field===field));
});

test('future, invalid and out-of-order completion timestamps are blocked',t=>{
  const f=fixture(t);f.value.policy.approved_at='2099-01-01T00:00:00Z';f.value.deployment.verified_at='2026-02-30T00:00:00Z';
  let report=f.run();assert.equal(report.passed,false);assert.ok(codes(report).includes('COMPLETED_TIMESTAMP_REQUIRED'));
  f.value.policy.approved_at='2026-01-03T00:00:00Z';f.value.deployment.verified_at='2026-01-02T00:00:00Z';f.value.restore_verification.verified_at='2026-01-01T00:00:00Z';
  report=f.run();assert.ok(codes(report).includes('PRECEDES_POLICY_APPROVAL'));assert.ok(codes(report).includes('PRECEDES_DEPLOYMENT_VERIFICATION'));
});

test('unknown fields and duplicated JSON keys cannot hide incomplete declarations',t=>{
  const f=fixture(t);f.value.ready=true;assert.ok(codes(f.run()).includes('UNKNOWN_FIELDS'));delete f.value.ready;f.save();
  const original=readFileSync(f.path,'utf8');
  for(const content of [original.replace('"approved"','"pending", "status":"approved"'),original.replace('"inactivity_days": 30','"inactivity_days": 0, "inactivity_\\u0064ays":30')]){
    writeFileSync(f.path,content);assert.deepEqual(checkOperationsEvidence(f.path).issues,[{field:'$',code:'INPUT_DUPLICATE_KEYS'}]);
  }
});

test('malformed and invalid-encoding manifests produce generic failure without parser text',t=>{
  const f=fixture(t);
  for(const content of ['{"synthetic-secret":"unclosed',Buffer.from([0xff,0xfe,123,0])]){
    writeFileSync(f.path,content);const report=checkOperationsEvidence(f.path);
    assert.equal(report.passed,false);assert.equal(JSON.stringify(report).includes('synthetic-secret'),false);
  }
});

test('CLI defaults to pending, reads only the explicit manifest and does not rewrite inputs',t=>{
  const f=fixture(t),before=readFileSync(f.path);writeFileSync(join(f.directory,'.env'),'THIS_FILE_MUST_NOT_BE_READ=true');
  const normal=spawnSync(process.execPath,[script,f.path],{cwd:f.directory,encoding:'utf8'});
  assert.equal(normal.status,0);assert.equal(normal.stderr,'');assert.equal(JSON.parse(normal.stdout).status,'synthetic_checks_passed');
  assert.deepEqual(readFileSync(f.path),before);
  const pending=spawnSync(process.execPath,[script],{cwd:f.directory,encoding:'utf8'});
  assert.equal(pending.status,1);assert.equal(JSON.parse(pending.stdout).status,'pending');
  assert.equal(JSON.parse(pending.stdout).production_ready,false);
});
