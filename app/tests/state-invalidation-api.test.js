import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Store} from '../src/store.js';
import {createApp} from '../src/server.js';
import {createIntake,answerIntake,currentView,buildContext} from '../src/intake.js';
import {HttpError} from '../src/errors.js';

// Exercise real HTTP dispatch, with deterministic persistence and no model/DB.
for(const skipped of [false,true])test('unreviewed answer invalidates previous model state: skipped='+skipped,async t=>{
  const owner=randomUUID(),id=randomUUID();
  let state=answerIntake(createIntake(),{question_id:'name',text:'합성 친구'});
  if(skipped)state=answerIntake(state,{question_id:'want',text:'합성 친구의 이야기를 듣고 싶어요.'});
  const derived=['agentMemory','agentRelationshipMemory','agentStateExecution','safetySignal','agentResult','agentRecord'];
  for(const key of derived)state[key]={reviewed:true,old:'synthetic'};
  state.modelStatus='connected';
  let row={id,owner,revision:0,state};
  const store={async close(){},async purgeExpired(){},async browser(){return {id:owner,csrf:'synthetic-csrf'};},
    async updateIntake(candidate,requested,revision,mutate){
      assert.equal(candidate,owner);assert.equal(requested,id);
      if(revision!==row.revision)throw new HttpError(409,'REVISION_CONFLICT','합성 충돌');
      row={...row,revision:revision+1,state:mutate(structuredClone(row.state))};return structuredClone(row);
    }};
  t.mock.method(Store,'connect',async()=>store);
  const app=await createApp({databaseUrl:'synthetic-memory',key:randomBytes(32),gateway:null,referralProvider:null});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.shutdown());
  const question=currentView(state).question;
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/intakes/${id}/answers`,{
    method:'POST',headers:{cookie:'malssi_session=synthetic','x-csrf-token':'synthetic-csrf','content-type':'application/json'},
    body:JSON.stringify({revision:0,question_id:question.id,...(skipped?{skipped:true}:{text:'합성 답변으로 이야기를 듣고 싶어요.'})}),
  });
  assert.equal(response.status,200,JSON.stringify(await response.json()));
  for(const key of derived)assert.equal(row.state[key],undefined,key+' must not survive changed answers');
  assert.equal(row.state.modelStatus,'not_connected');
  assert.equal(buildContext(row.state).agent_state,null);assert.equal(buildContext(row.state).relationship_state,null);
  assert.deepEqual(row.state.ans.name,state.ans.name);
  assert.ok(Object.hasOwn(row.state.ans,question.id),'the newly committed answer must remain stored');
  assert.equal(row.revision,1);
  // Mutations must not change the source snapshot held by another request.
  assert.equal(state.agentStateExecution.reviewed,true);
});
