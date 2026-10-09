import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const context=vm.createContext({});
vm.runInContext(read('frontend/js/core/questions.js')+'\nglobalThis.catalog={Q,FOLLOW,RARE};',context);
const {Q,FOLLOW,RARE}=context.catalog;
test('all 36 frontend source files match the accepted pre-PR3 commit',()=>{
  const manifest=JSON.parse(read('docs/frontend-original-manifest.json'));
  assert.equal(manifest.commit,'ea9c607519ce2269d8da14a166a7b99d7e287233');
  assert.equal(manifest.files.length,36);
  // 복구 이후 일부러 고친 파일은 accepted_edits의 지문과 비교 (그 밖의 파일은 원본과 같아야 함)
  const accepted=manifest.accepted_edits||{};
  for(const {path,sha256} of manifest.files){
    const content=readFileSync(new URL(path==='index.html'?'frontend/original/index.html':'frontend/'+path,root));
    // Git checkouts may use CRLF on Windows; binary assets are compared byte-for-byte.
    const bytes=/\.(js|html|css)$/.test(path)?Buffer.from(content.toString('utf8').replace(/\r\n/g,'\n')):content;
    assert.equal(createHash('sha256').update(bytes).digest('hex'),accepted[path]?.sha256??sha256,path);
  }
});
test('original question order, required questions and no-skip rules',()=>{
  assert.deepEqual(Array.from(Q,q=>q.id),'name want goal rel contact mood dur freq describe concern cause events others_why support burden values values_effect extra coping help barrier need others_help moment moment_freq feeling cgchange cgchange_more mycoping mysupport'.split(' '));
  assert.deepEqual(Array.from(Q.filter(q=>q.required),q=>q.id),'want rel mood dur freq concern need moment'.split(' '));
  assert.deepEqual(Array.from(Q.filter(q=>q.noSkip),q=>q.id),'cause support burden cgchange_more'.split(' '));
});
test('conditional questions and rare-contact wording retain the original contract',()=>{
  const state={tags:new Set(['no_change','rare_contact']),ans:{mood:{custom:''},cause:{sel:[1]},cgchange:{custom:''}}};
  const byId=id=>Q.find(q=>q.id===id);
  assert.equal(RARE(state),true);
  for(const id of ['mood','dur','freq','concern'])assert.ok(byId(id).rare);
  for(const id of ['dur','freq','events','cgchange_more'])assert.equal(byId(id).when(state),false);
  state.ans.mood.custom='직접 관찰한 변화';state.ans.cause.sel=[0];state.tags.add('cg_sleep');
  for(const id of ['dur','freq','events','cgchange_more'])assert.equal(byId(id).when(state),true);
  assert.equal(FOLLOW.concern.when({text:'걱정'}),true);
  assert.equal(FOLLOW.concern.when({text:'최근 친구가 식사를 거의 하지 않아서 걱정돼요'}),false);
});
