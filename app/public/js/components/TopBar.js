// 상단 바: 로고 그림(assets/logo.png, 누르면 처음 화면) + 화면별 내용 (대화 화면의 진행 막대 등)
const TopBar=(inner="")=>`<div class="top"><button type="button" class="logo" data-home aria-label="말씨 처음 화면으로"><img src="assets/logo.png" alt=""></button>${inner}</div>`;
// 공통 내비게이션 바 (시작·서비스 소개·칼럼·내 기록·결과). 지금 보고 있는 메뉴는 aria-current로 표시
const NAV_ITEMS=[["about","서비스 소개"],["columns","칼럼"],["records","내 기록"]];
const NavBar=(active="")=>`<nav class="top nav" aria-label="주요 메뉴"><button type="button" class="logo" data-home aria-label="말씨 처음 화면으로"><img src="assets/logo.png" alt=""></button>
  <div class="navlinks">${NAV_ITEMS.map(([k,t])=>`<button type="button" class="navlink" data-nav="${k}"${k===active?' aria-current="page"':""}>${t}${k==="records"?' <span class="recN"></span>':""}</button>`).join("")}</div>
  <button type="button" class="btn navcta" data-go>말씨와 시작하기</button></nav>`;
// 위기 상담 번호 줄 (내비게이션 바 아래 오른쪽)
const CrisisLine=t=>`<div class="crisis-row"><div class="crisis">${t}</div></div>`;
