// v3.1 synthetic UI fixture for checking the shared result screen.
async function openTestResult(){
  $("app").innerHTML='<p class="note" role="status">테스트 결과를 준비하고 있어요.</p>';
  try{
    const response=await fetch('test-data/relationship-result.json');
    if(!response.ok)throw new Error('테스트 결과를 불러오지 못했어요.');
    const sample=await response.json();
    if(sample.synthetic!==true||sample.preview_kind!=='ui_fixture'||sample.bundle_id!=='malssi-intake-3.1.0-rc1'||!Array.isArray(sample.answers)||!sample.answers.length)throw new Error('가상 테스트 자료를 확인하지 못했어요.');
    await API.bootstrap();
    const screens=[StartScreen,ChatScreen,ResultScreen,AboutScreen,RecordsScreen,ColumnsScreen];
    $("app").innerHTML=screens.map(screen=>screen.render()).join('\n');
    applyMascots($("app"));screens.forEach(screen=>screen.mount());
    document.querySelectorAll('[data-home]').forEach(button=>button.onclick=leaveConversation);
    const open={about:()=>AboutScreen.open(),columns:()=>ColumnsScreen.open(),records:()=>RecordsScreen.open()};
    document.querySelectorAll('[data-nav]').forEach(button=>button.onclick=()=>{open[button.dataset.nav]();window.scrollTo(0,0);});
    document.querySelectorAll('[data-go]').forEach(button=>button.onclick=begin);
    ResultScreen.open(sample.profile,sample.guide,false,sample.relationship_analysis);
    document.title='가상 답변 결과 테스트 · 말씨';
    const notice=document.createElement('p');
    notice.className='note';notice.setAttribute('role','status');
    notice.style.cssText='max-width:1100px;margin:12px auto;padding:12px 20px;background:#fff4d9;border-radius:12px';
    notice.textContent='v3.1 화면 확인용 가상 예시 · 질문과 안내를 미리 작성해 화면을 확인하는 자료예요.';
    $("result").insertBefore(notice,$("rbody"));
    const inputs=document.createElement('details');inputs.className='card';
    inputs.innerHTML='<summary style="cursor:pointer">v3.1 가상 답변 '+sample.answers.length+'개 보기</summary>'+sample.answers.map(item=>
      '<section style="margin-top:16px"><h3 style="font-size:17px">'+esc(item.question)+'</h3><p style="white-space:pre-wrap">'+esc(item.answer)+'</p></section>').join('');
    $("rbody").querySelector('.cards').insertBefore(inputs,$("rbody").querySelector('.actions'));
    $("rbody").querySelector('.actions .note').textContent='화면 확인용으로 미리 작성한 가상 안내예요.';
  }catch(error){
    $("app").innerHTML='<p class="note" role="alert">'+esc(error.message)+'</p><a href="/">처음 화면으로</a>';
  }
}
openTestResult();
