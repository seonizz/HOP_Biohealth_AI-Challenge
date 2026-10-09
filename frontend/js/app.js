// 앱 시작: 화면 컴포넌트를 그린 뒤 이벤트를 연결
const SCREENS=[StartScreen,ChatScreen,ResultScreen,AboutScreen,RecordsScreen,ColumnsScreen];
$("app").innerHTML=SCREENS.map(c=>c.render()).join("\n");
applyMascots($("app"));
SCREENS.forEach(c=>c.mount());
