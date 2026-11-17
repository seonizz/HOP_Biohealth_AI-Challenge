import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join,isAbsolute} from 'node:path';

// An offline reviewer approving a repaired decision is not evidence that the
// original one-call answer was stable. Only unchanged decisions can qualify.
export function assertStableSingleCall(draft,reviewed){
  assert.equal(draft.state_agent?.reviewed,false);
  assert.equal(reviewed.state_agent?.reviewed,true);
  for(const key of ['patient_state','name_index','relationship_memory','question_plan','clarification'])
    assert.deepEqual(draft[key]??null,reviewed[key]??null,`Independent audit changed ${key}`);
  assert.equal(Boolean(draft.finish_early),Boolean(reviewed.finish_early),'Independent audit changed finish_early');
  assert.equal(draft.safety_signal?.urgent,reviewed.safety_signal?.urgent,'Independent audit changed safety urgency');
  // A false single-call draft must carry no positive-danger evidence. A later
  // nonurgent independent review may legitimately cite explicit negation.
  if(draft.safety_signal?.urgent===true)
    assert.deepEqual(draft.safety_signal?.evidence??[],reviewed.safety_signal?.evidence??[],'Independent audit changed safety evidence');
  else if(draft.safety_signal?.urgent===false)
    assert.deepEqual(draft.safety_signal?.evidence??[],[],'Nonurgent draft carried danger evidence');
}

export async function assertSourceSnapshotUnchanged(sourceRoot,frozenRoot){
  const manifest=JSON.parse(await readFile(join(frozenRoot,'snapshot-manifest.json'),'utf8'));
  assert.equal(createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex'),manifest.sha256);
  for(const row of manifest.files){
    assert.ok(typeof row.path==='string'&&!isAbsolute(row.path)&&!row.path.split(/[\\/]/).includes('..'));
    for(const root of [sourceRoot,frozenRoot]){
      const path=join(root,row.path),info=await lstat(path);assert.ok(info.isFile()&&!info.isSymbolicLink());
      const bytes=await readFile(path);assert.equal(bytes.length,row.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),row.sha256,`Snapshot mismatch: ${row.path}`);
    }
  }
  return manifest.sha256;
}
