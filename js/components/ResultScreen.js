// 3. 결과 화면: 좌 마스코트 · 우 가이드 카드
const ResultScreen={
  render(){return `
<section class="screen" id="result" hidden>
  ${TopBar(`<div class="crisis">위급할 땐 <b>109</b> · <b>1577-0199</b> · <b>112 / 119</b></div>`)}
  <div class="wrapr" id="rbody"></div>
</section>`;},
  mount(){},
  open(p,g,saved){
    $("rbody").innerHTML=`
     <div class="rside"><img src="${M.cheer}" alt="하트를 안은 말씨">
       <div class="pill">${[p.name||"그분",p.rel,g.top+" 경향"].filter(Boolean).map(esc).join(" · ")}</div>
       <h2>이렇게 마음을<br>건네 보세요</h2><p>완벽한 말보다, 곁에 있다는 신호가 더 중요해요.</p></div>
     <div class="cards">
       ${p.safety?GuideCards.safety():""}
       <div class="card care"><img src="${M.empathy}" alt=""><div><h3 style="margin-bottom:6px">당신의 마음도 소중해요</h3><p>${esc(g.care.feel)}</p><p class="tips">${esc(g.care.tips[0])}</p></div></div>
       <div class="card script"><h3>이렇게 시작해 보세요</h3><button class="ghost copy" id="cp">문장 복사</button><div id="scr" style="white-space:pre-wrap">${esc(g.script)}</div></div>
       ${GuideCards.doAvoid(g)}
       <div class="card next"><img src="${M.think}" alt=""><div><h3 style="margin-bottom:4px">다음 단계</h3>${esc(g.next)}<p class="note" style="margin:8px 0 0">당신을 위해서도: ${esc(g.care.tips.slice(1).join(" "))}</p></div></div>
       <div class="actions"><span class="note" style="margin-right:auto;align-self:center">${saved?`"${esc(p.name||"그분")}" 기록으로 저장했어요.`:"이 브라우저에서는 기록을 저장할 수 없어요."}</span><button class="ghost" id="toRec">내 기록 보기</button><button class="ghost" id="again">처음부터 다시</button></div>
     </div>`;
    show("result");
    $("toRec").onclick=()=>RecordsScreen.open();
    $("cp").onclick=()=>navigator.clipboard.writeText($("scr").innerText).then(()=>$("cp").textContent="복사했어요",()=>{const r=document.createRange();r.selectNodeContents($("scr"));getSelection().removeAllRanges();getSelection().addRange(r);});
    $("again").onclick=()=>show("start");
  }
};
