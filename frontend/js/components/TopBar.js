// 상단 바: 로고(누르면 처음 화면) + 화면별 내용(버튼, 진행 막대, 위기 상담 번호 등)
const TopBar=(inner="")=>`<div class="top"><button type="button" class="logo" data-home aria-label="말씨 처음 화면으로">말씨<small aria-hidden="true">●</small></button>${inner}</div>`;
