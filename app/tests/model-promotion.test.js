import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {assertStableSingleCall,assertSourceSnapshotUnchanged} from '../src/model-promotion.js';
const draft=()=>({state_agent:{reviewed:false},question_plan:{skip:[{question_id:'q3_03',reason:'not_needed'}]},clarification:null,finish_early:false,safety_signal:{urgent:false}});
const reviewed=value=>({...structuredClone(value),state_agent:{reviewed:true},safety_signal:{...value.safety_signal,review:{basis:'unclear',reason:'Reviewed'}}});
test('independent approval cannot qualify an originally incorrect skip or clarification',()=>{
 const value=draft(),audit=reviewed(value);assert.doesNotThrow(()=>assertStableSingleCall(value,audit));
 audit.question_plan.skip=[];assert.throws(()=>assertStableSingleCall(value,audit),/question_plan/);
 const original={...draft(),clarification:{question_id:'q3_10'}};assert.throws(()=>assertStableSingleCall(original,reviewed(draft())),/clarification/);
});
test('independent safety changes cannot qualify the original one-call answer',()=>{
 const value=draft(),audit=reviewed(value);audit.safety_signal.urgent=true;assert.throws(()=>assertStableSingleCall(value,audit),/urgency/);
 const end=reviewed(value);end.finish_early=true;assert.throws(()=>assertStableSingleCall(value,end),/finish_early/);
});
test('corrected fictional-only skip explanations cannot qualify the unchanged single-call path',()=>{
 const value=draft();value.question_plan.skip[0]={question_id:'q3_03',reason:'not_needed',explanation:'가상 인물이므로 상황을 더 물을 필요가 없습니다.',
  evidence:[{subject:'supporter',question_id:'q3_02',quote:'가상 친구의 사례입니다.'}]};
 const audit=reviewed(value);audit.question_plan.skip[0].explanation='현재 도움 목적에 필요한 사건이 이미 보고되어 이 질문을 더 묻지 않아도 됩니다.';
 assert.throws(()=>assertStableSingleCall(value,audit),/question_plan/);
 const changedEvidence=reviewed(value);changedEvidence.question_plan.skip[0].evidence[0].quote='이미 보고한 사건입니다.';
 assert.throws(()=>assertStableSingleCall(value,changedEvidence),/question_plan/);
});
test('independent safety evidence corrections also prevent single-call approval',()=>{
 const value=draft();value.safety_signal={urgent:true,evidence:[{subject:'patient',question_id:'q3_03',quote:'합성 원문'}]};
 const audit=reviewed(value);audit.safety_signal.evidence=[];
 assert.throws(()=>assertStableSingleCall(value,audit),/safety evidence/);
});
test('a nonurgent independent review can cite the original explicit negation without changing the draft facts',()=>{
 const value=draft();value.safety_signal.evidence=[];
 const audit=reviewed(value);audit.safety_signal.review={basis:'negated',reason:'현재 위험을 직접 부정한 원문입니다.'};
 audit.safety_signal.evidence=[{subject:'supporter',question_id:'q3_01',quote:'지금 다치거나 해칠 생각이 없다고 직접 말했어요.'}];
 assert.doesNotThrow(()=>assertStableSingleCall(value,audit));
 const invalid=draft();invalid.safety_signal.evidence=audit.safety_signal.evidence;
 assert.throws(()=>assertStableSingleCall(invalid,reviewed(invalid)),/Nonurgent draft carried danger evidence/);
});
test('activation rejects changed current or frozen code',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hop-promotion-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const source=join(root,'source'),frozen=join(root,'frozen');await mkdir(source);await mkdir(frozen);
 const text='qualified\n',files=[{path:'entry.js',bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')}];
 for(const dir of [source,frozen])await writeFile(join(dir,'entry.js'),text);
 await writeFile(join(frozen,'snapshot-manifest.json'),JSON.stringify({files,sha256:createHash('sha256').update(JSON.stringify(files)).digest('hex')}));
 await assertSourceSnapshotUnchanged(source,frozen);
 await writeFile(join(source,'entry.js'),'changed!!\n');await assert.rejects(assertSourceSnapshotUnchanged(source,frozen));
 await writeFile(join(source,'entry.js'),text);await writeFile(join(frozen,'entry.js'),'changed!!\n');await assert.rejects(assertSourceSnapshotUnchanged(source,frozen));
});
