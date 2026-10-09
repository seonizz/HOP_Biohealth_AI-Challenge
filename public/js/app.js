// 익명 세션과 서버 저장 상태를 읽은 뒤 화면을 시작해요.
const SCREENS=[StartScreen,ChatScreen,ResultScreen,AboutScreen,RecordsScreen,ColumnsScreen];
async function startApp(){
  $("app").innerHTML='<p class="note" role="status">말씨를 준비하고 있어요.</p>';
  try{
    await API.bootstrap();
    $("app").innerHTML=SCREENS.map(c=>c.render()).join("\n");
    applyMascots($("app"));SCREENS.forEach(c=>c.mount());
  }catch(error){
    $("app").innerHTML=`<p class="note" role="status">${esc(error.message)}</p><button class="btn" id="bootRetry">다시 시도</button>`;
    $("bootRetry").onclick=startApp;
  }
}
startApp();
