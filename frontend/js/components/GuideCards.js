// 가이드의 "이렇게 해 보세요 / 피하면 좋아요" 카드 쌍 (결과 화면·기록 화면 공용)
const GuideCards={
  // 위험 신호가 있었을 때 맨 위에 보이는 안전 안내 카드
  safety:(style="")=>`<div class="card safety"${style?` style="${style}"`:""} role="alert"><img src="${M.empathy}" alt=""><div>
    <h3>대화보다 안전이 먼저예요</h3>
    <p>죽고 싶다거나 사라지고 싶다는 신호가 있었다고 알려 주셨어요. 말씀해 주셔서 정말 고마워요. 이건 혼자 감당하지 않으셔도 돼요.</p>
    <ul><li>자살예방 상담전화 <b>109</b> (24시간)</li><li>정신건강위기 상담전화 <b>1577-0199</b></li><li>지금 위험하다면 <b>112 / 119</b></li></ul></div></div>`,
  list:items=>`<ul>${items.map(x=>`<li>${esc(x)}</li>`).join("")}</ul>`,
  doAvoid(g,{wrapStyle="",doStyle=""}={}){
    return `<div class="two"${wrapStyle?` style="${wrapStyle}"`:""}><div class="card do"${doStyle?` style="${doStyle}"`:""}><h3>이렇게 해 보세요</h3>${this.list(g.doList)}</div>
    <div class="card avoid"><h3>피하면 좋아요</h3>${this.list(g.avoid)}</div></div>`;
  }
};
