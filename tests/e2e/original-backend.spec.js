import {test,expect} from '@playwright/test';
test.beforeEach(async({page})=>{
  await page.addInitScript(()=>{const delay=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>delay(fn,Math.min(ms||0,15),...args);});
});
async function question(page,id){await page.waitForFunction(id=>typeof S!=='undefined'&&Q[S.i]?.id===id&&document.querySelector('#input button'),id);}
async function textAnswer(page,text){await page.locator('#ta').fill(text);await page.locator('#send').click();}
async function choose(page,label){await page.locator('#input').getByRole('button',{name:label,exact:true}).click();}
async function throughContact(page,rare=true){
  await page.locator('#go').click();await question(page,'name');await textAnswer(page,'검증친구');
  await question(page,'want');await expect(page.locator('#input .skip')).toHaveCount(0);
  await textAnswer(page,'언제나 네 곁에서 이야기를 들어주겠다고 전하고 싶어요');
  await question(page,'goal');await choose(page,'내가 곁에 있다는 걸 알리고 싶어요');await choose(page,'다 골랐어요');
  await question(page,'rel');await choose(page,'친구');await question(page,'contact');await choose(page,rare?'그보다 드물게':'일주일에 몇 번');await question(page,'mood');
}
async function finishRemaining(page){
  for(let step=0;step<40;step++){
    await page.waitForFunction(()=>!document.getElementById('result').hidden||document.querySelector('#input button'));
    if(await page.locator('#result').isVisible())return;
    const q=await page.evaluate(()=>({id:Q[S.i].id,type:Q[S.i].type,opts:Q[S.i].opts?.map(optLabel),required:Q[S.i].required,noSkip:Q[S.i].noSkip}));
    if(q.required||q.noSkip)await expect(page.locator('#input .skip')).toHaveCount(0);
    if(q.type==='text')await textAnswer(page,({concern:'친구가 최근 식사를 거의 하지 않아서 마음이 쓰여요',moment:'지난주 새벽에 연락이 되지 않았을 때 걱정이 됐어요',feeling:'많이 걱정되고 도울 방법을 몰라서 막막했어요'})[q.id]||'가까운 사람들과 함께 이야기를 나누며 도움을 찾고 있어요');
    else{await choose(page,q.opts[q.id==='dur'?2:q.id==='freq'?3:0]);if(q.type==='multi')await choose(page,'다 골랐어요');else if(['support','burden','cgchange_more'].includes(q.id))await textAnswer(page,'가족과 친구에게 구체적으로 이야기를 나누고 있어요');}
  }
  throw new Error('Original questionnaire did not reach the result');
}
test('ea9c607 UI → 30 original answers → API result → PostgreSQL history → server deletion',async({page})=>{
  const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>requests.push(new URL(r.url()).pathname));
  await page.goto('/');await expect(page.locator('#go')).toHaveText('말씨와 시작하기');
  await throughContact(page);await page.locator('#input .back').click();await question(page,'contact');
  expect(await page.evaluate(()=>S.tags.has('rare_contact'))).toBe(false);await choose(page,'그보다 드물게');await question(page,'mood');
  await choose(page,'죽고 싶다거나 사라지고 싶다는 말 또는 행동을 했어요');await choose(page,'다 골랐어요');await question(page,'dur');
  await expect(page.locator('#chat .safety')).toHaveCount(0);await finishRemaining(page);
  await expect(page.locator('#result .safety')).toBeVisible();await expect(page.locator('#scr')).toContainText('지금 바로 대답하지 않아도 돼.');
  const record=await page.evaluate(()=>loadRecs()[0]);expect(Object.keys(record.profile.answers)).toHaveLength(30);expect(record.server_id).toMatch(/^[a-f0-9-]{36}$/);
  const remote=await (await page.request.get('/api/v2/frontend/records')).json();expect(remote.records).toHaveLength(1);expect(remote.records[0].guide).toEqual(record.guide);
  await page.screenshot({path:'artifacts/original-backend-result.png',fullPage:true});
  await page.evaluate(()=>localStorage.removeItem('malssi.records.v1'));await page.reload();await page.locator('#openRec').click();
  await expect(page.locator('#rlist .rcard')).toHaveCount(1);await expect(page.locator('#rdetail')).toContainText(record.guide.script);
  await page.locator('[data-del]').click();await expect(page.locator('[data-del]')).toHaveText('정말 삭제');await page.locator('[data-del]').click();
  await expect(page.locator('#rlist .rcard')).toHaveCount(0);expect((await (await page.request.get('/api/v2/frontend/records')).json()).records).toEqual([]);
  expect(requests).toContain('/js/components/ChatScreen.js');expect(requests).not.toContain('/src/app.js');expect(requests).not.toContain('/js/core/mockModel.js');expect(errors).toEqual([]);
});
test('original conditional skips and mandatory follow-up remain unchanged',async({page})=>{
  await page.goto('/');await throughContact(page,false);await choose(page,'특별히 관찰된 변화가 없음');await choose(page,'다 골랐어요');await question(page,'describe');
  await choose(page,'건너뛰기');await question(page,'concern');await textAnswer(page,'걱정');await expect(page.locator('#log .fu-tag')).toBeVisible();await expect(page.locator('#input .skip')).toHaveCount(0);
  await textAnswer(page,'평소와 달리 친구가 식사를 거의 하지 않는 모습을 봤어요');await question(page,'cause');await choose(page,'아니요');await question(page,'others_why');
  const answers=await page.evaluate(()=>S.ans);expect(answers.dur).toBeUndefined();expect(answers.freq).toBeUndefined();expect(answers.events).toBeUndefined();expect(answers.describe.skipped).toBe(true);
});
test('original home, columns, introduction and mobile controls render unchanged',async({page})=>{
  await page.setViewportSize({width:1920,height:1080});await page.goto('/');await page.screenshot({path:'artifacts/original-backend-home.png',fullPage:true});
  await expect(page.locator('#start .steps')).toContainText('약 10~15분');await page.locator('#openCol').click();await expect(page.locator('.ccard')).toHaveCount(10);
  await page.locator('#colFilter [data-cat="불안"]').click();await expect(page.locator('.ccard')).toHaveCount(2);await page.locator('#colHome').click();await page.locator('#openAbout').click();await expect(page.locator('#about')).toBeVisible();
  await page.locator('#aboutHome').click();await page.setViewportSize({width:390,height:844});await expect(page.locator('#go')).toBeEnabled();await page.screenshot({path:'artifacts/original-backend-mobile.png',fullPage:true});await throughContact(page);await expect(page.locator('#input .done')).toBeEnabled();
});
