// 앱 시작: 화면 컴포넌트를 그린 뒤 이벤트를 연결
const SCREENS=[StartScreen,ChatScreen,ResultScreen,AboutScreen,RecordsScreen,ColumnsScreen];
$("app").innerHTML=SCREENS.map(c=>c.render()).join("\n");
applyMascots($("app"));
SCREENS.forEach(c=>c.mount());
// 왼쪽 위 말씨 로고: 어느 화면에서든 처음 화면으로
document.querySelectorAll("[data-home]").forEach(b=>b.onclick=()=>{show("start");window.scrollTo(0,0);});
