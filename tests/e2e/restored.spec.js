import {test,expect} from '@playwright/test';

// Only shorten the original decorative typing delays in tests.
test.beforeEach(async({page})=>{
  await page.addInitScript(()=>{const delay=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>delay(fn,Math.min(ms||0,15),...args);});
});
async function question(page,id){
  await page.waitForFunction(id=>typeof S!=='undefined'&&Q[S.i]?.id===id&&document.querySelector('#input button'),id);
}
async function textAnswer(page,text){await page.locator('#ta').fill(text);await page.locator('#send').click();}
async function choose(page,label){await page.locator('#input').getByRole('button',{name:label,exact:true}).click();}
async function throughContact(page,rare=true){
  await page.locator('#go').click();await question(page,'name');await textAnswer(page,'검증친구');
  await question(page,'want');
  await expect(page.locator('#input .skip')).toHaveCount(0);
  await page.locator('#send').click();await expect(page.locator('#input .need')).toBeVisible();
  await textAnswer(page,'언제나 네 곁에서 이야기를 들어주겠다고 전하고 싶어요');
  await question(page,'goal');await choose(page,'내가 곁에 있다는 걸 알리고 싶어요');await choose(page,'다 골랐어요');
  await question(page,'rel');await choose(page,'친구');
  await question(page,'contact');await choose(page,rare?'그보다 드물게':'일주일에 몇 번');
  await question(page,'mood');
}
async function finishRemaining(page){
  const visited=[];
  for(let step=0;step<40;step++){
    await page.waitForFunction(()=>!document.getElementById('result').hidden||document.querySelector('#input button'));
    if(await page.locator('#result').isVisible())return visited;
    const q=await page.evaluate(()=>({id:Q[S.i].id,type:Q[S.i].type,opts:Q[S.i].opts?.map(optLabel),required:Q[S.i].required,noSkip:Q[S.i].noSkip}));
    visited.push(q.id);
    if(q.required||q.noSkip)await expect(page.locator('#input .skip')).toHaveCount(0);
    if(q.type==='text'){
      const answers={concern:'친구가 최근 식사를 거의 하지 않아서 마음이 쓰여요',moment:'지난주 새벽에 연락이 되지 않았을 때 걱정이 됐어요',feeling:'많이 걱정되고 도울 방법을 몰라서 막막했어요'};
      await textAnswer(page,answers[q.id]||'가까운 사람들과 함께 이야기를 나누며 도움을 찾고 있어요');
    }else{
      const index=q.id==='dur'?2:q.id==='freq'?3:0;
      await choose(page,q.opts[index]);
      if(q.type==='multi')await choose(page,'다 골랐어요');
      else if(['support','burden','cgchange_more'].includes(q.id))await textAnswer(page,'가족과 친구에게 구체적으로 이야기를 나누고 있어요');
    }
  }
  throw new Error('Original questionnaire did not reach a result');
}

test('original 30-question journey, back, guide, deferred safety, local history and deletion',async({page})=>{
  const errors=[],apiRequests=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))apiRequests.push(r.url());});
  await page.goto('/');await throughContact(page);
  await expect(page.locator('#log')).toContainText('마지막으로 검증친구를 보거나 연락했을 때');
  await page.locator('#input .back').click();await question(page,'contact');
  expect(await page.evaluate(()=>S.tags.has('rare_contact'))).toBe(false);
  await expect(page.locator('#input .back')).toHaveCount(1); // 첫 질문 전까지 몇 번이든 뒤로 갈 수 있음
  await page.locator('#input .back').click();await question(page,'rel');
  await page.locator('#input .back').click();await question(page,'goal');
  await choose(page,'다 골랐어요');await question(page,'rel');await choose(page,'친구');await question(page,'contact');
  await choose(page,'그보다 드물게');await question(page,'mood');
  await choose(page,'죽고 싶다거나 사라지고 싶다는 말 또는 행동을 했어요');await choose(page,'다 골랐어요');
  await question(page,'dur');
  await expect(page.locator('#chat')).toBeVisible();await expect(page.locator('#chat .safety')).toHaveCount(0);
  await expect(page.locator('#log')).toContainText('이런 모습을 처음 알게 된 지 얼마나 됐나요?');
  const visited=await finishRemaining(page);
  expect(visited).toContain('events');expect(visited).toContain('cgchange_more');
  await expect(page.locator('#result .safety')).toBeVisible();
  await expect(page.locator('#result .safety')).toContainText('109');
  await expect(page.locator('#scr')).toContainText('지금 바로 대답하지 않아도 돼');
  const record=await page.evaluate(()=>loadRecs()[0]);
  expect(Object.keys(record.profile.answers)).toHaveLength(30);
  expect(record.profile.safety).toBe(true);expect(record.guide.care.tips.length).toBeGreaterThan(0);
  expect(record.guide.doList.length).toBeGreaterThan(0);expect(record.guide.avoid.length).toBeGreaterThan(0);
  await page.screenshot({path:'artifacts/restored-result.png',fullPage:true});
  await page.locator('#toRec').click();await expect(page.locator('#rdetail')).toContainText(record.guide.script);
  await page.reload();await page.locator('#start [data-nav="records"]').click();await expect(page.locator('#rlist .rcard')).toHaveCount(1);
  await expect(page.locator('#rdetail .safety')).toBeVisible();
  await page.locator('[data-del]').click();await expect(page.locator('[data-del]')).toHaveText('정말 삭제');
  await page.locator('[data-del]').click();await expect(page.locator('#rlist .rcard')).toHaveCount(0);
  expect(await page.evaluate(()=>loadRecs())).toEqual([]);
  expect(apiRequests).toEqual([]);expect(errors).toEqual([]);
});

test('no-change branch skips duration and frequency; optional questions skip and follow-up stays required',async({page})=>{
  await page.goto('/');await throughContact(page,false);
  await choose(page,'자주 우울하거나 가라앉아 보여요');
  await choose(page,'특별히 관찰된 변화가 없음');
  expect(await page.locator('#input .chip[aria-pressed=true]').allTextContents()).toEqual(['특별히 관찰된 변화가 없음']);
  await choose(page,'다 골랐어요');await question(page,'describe');
  await choose(page,'건너뛰기');await question(page,'concern');await textAnswer(page,'걱정');
  await expect(page.locator('#log .fu-tag')).toBeVisible();
  await expect(page.locator('#input .skip')).toHaveCount(0);
  await textAnswer(page,'평소와 달리 친구가 식사를 거의 하지 않는 모습을 봤어요');
  await question(page,'cause');await choose(page,'아니요');await question(page,'others_why');
  const answers=await page.evaluate(()=>S.ans);
  expect(answers.dur).toBeUndefined();expect(answers.freq).toBeUndefined();expect(answers.events).toBeUndefined();
  expect(answers.describe.skipped).toBe(true);
  expect(answers.concern.text).toContain('식사를 거의');
});

test('original columns, links, service introduction and mobile interaction',async({page},testInfo)=>{
  await page.setViewportSize({width:1920,height:1080});
  await page.goto('/');await expect(page.locator('#start')).toBeVisible();
  await page.screenshot({path:'artifacts/restored-home.png',fullPage:true});
  await page.locator('#start [data-nav="columns"]').click();await expect(page.locator('.ccard')).toHaveCount(10);
  await page.locator('#colFilter [data-cat="불안"]').click();await expect(page.locator('.ccard')).toHaveCount(2);
  await expect(page.locator('#columns .chero')).toBeVisible();
  // 카드를 누르면 읽기 화면에 기사 전문과 새 탭 원문 링크
  await page.locator('.ccard .cc-open').first().click();await expect(page.locator('#colReader .cr-body p').nth(3)).toBeVisible();
  await expect(page.locator('#colReader a[target="_blank"][rel="noopener noreferrer"]')).toHaveCount(1);
  await page.locator('#crClose').click();await expect(page.locator('#colReader')).toBeHidden();
  await page.locator('#columns [data-home]').click();await page.locator('#start [data-nav="about"]').click();await expect(page.locator('#about')).toBeVisible();
  // 왼쪽 위 말씨 로고로 처음 화면
  await page.locator('#about [data-home]').click();await expect(page.locator('#start')).toBeVisible();await page.setViewportSize({width:390,height:844});
  // The accepted original targets 1920×1080 and overflows on narrow screens.
  // Record that existing limitation while checking that its controls still work.
  const mobile=await page.evaluate(()=>({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth}));
  await testInfo.attach('original-mobile-layout',{body:JSON.stringify(mobile),contentType:'application/json'});
  await expect(page.locator('#go')).toBeEnabled();
  await page.screenshot({path:'artifacts/restored-mobile.png',fullPage:true});
  await throughContact(page);await expect(page.locator('#input .done')).toBeEnabled();
});
test('leaving mid-conversation asks before discarding answers',async({page})=>{
  await page.goto('/');await page.locator('#go').click();await question(page,'name');
  // 아직 아무 답도 없으면 바로 나감
  await page.locator('#restart1').click();await expect(page.locator('#start')).toBeVisible();
  await page.locator('#go').click();await question(page,'name');await textAnswer(page,'검증친구');await question(page,'want');
  await page.locator('#restart1').click();await expect(page.locator('#leaveDlg')).toBeVisible();
  await expect(page.locator('#leaveDlg')).toContainText('저장되지 않아요');
  await page.locator('#leaveStay').click();await expect(page.locator('#leaveDlg')).toBeHidden();await expect(page.locator('#chat')).toBeVisible();
  await page.locator('#chat [data-home]').click();await expect(page.locator('#leaveDlg')).toBeVisible();
  await page.locator('#leaveGo').click();await expect(page.locator('#start')).toBeVisible();
});
