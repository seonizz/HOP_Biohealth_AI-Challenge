// Recreate a persisted v3 intake written before compact question flow existed.
// Only legacy-contract regressions should use this helper; new HTTP intakes
// must keep the policy marker supplied by createIntake.
export async function restoreLegacyV3Flow(store, id) {
  const {rows:[{owner}]}=await store.pool.query('SELECT owner FROM intakes WHERE id=$1',[id]);
  const current=await store.intake(owner,id);
  return store.updateIntake(owner,id,current.revision,state=>{
    delete state.v3.compact_flow;
    return state;
  },'model_update');
}
