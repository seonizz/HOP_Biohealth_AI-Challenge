import test from 'node:test';
import assert from 'node:assert/strict';
import { finalSafety } from '../src/final-safety.js';

test('shared service safety preserves legacy text/custom/selection fallback and reviewed agent decisions', () => {
  const context = answer => ({payload:{answers:[{selected:[],type:'text',text:'합성 중립 문장',...answer}]}});
  for (const answer of [{text:'지금 자해를 말했어요.'},{type:'choice',custom:'지금 사라지고 싶다고 말했어요.'},
    {selected:[{meta:{s:'suicidal'}}]}]) {
    for (const protocol of ['json_schema','json_prompt']) {
      assert.equal(finalSafety(context(answer),{assessment:{safety:false}},protocol),true);
    }
    assert.equal(finalSafety(context(answer),{assessment:{safety:false}},'relationship_agent'),false);
  }
  for (const protocol of ['json_schema','json_prompt','relationship_agent']) {
    assert.equal(finalSafety(context({}),{assessment:{safety:false}},protocol),false);
    assert.equal(finalSafety(context({}),{assessment:{safety:true}},protocol),true);
  }
});
