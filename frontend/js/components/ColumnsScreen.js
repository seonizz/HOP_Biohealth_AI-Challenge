// 6. 칼럼 화면: 곁에 있는 사람을 위한 글 모음 (분류별로 골라 보기, 원문은 새 탭)
const ColumnsScreen={
  filter:"전체",
  render(){return `
<section class="screen" id="columns" hidden>
  ${TopBar(`<span class="pill">칼럼</span><button class="ghost" id="colHome" style="margin-left:auto">처음으로</button><button class="btn" id="colGo" style="padding:10px 26px;font-size:18px">말씨와 시작하기</button>`)}
  <div class="cbody">
    <div class="chero">
      <div>
        <h2>곁에 있는 사람을 위한 <em>읽을거리</em></h2>
        <p>가족이나 친구가 힘들어할 때 무엇을 할 수 있는지, 전문가들이 쓴 글을 골라 핵심만 정리했어요.</p>
      </div>
      <img data-m="cheer" alt="">
    </div>
    <div class="chips cfilter" id="colFilter" role="group" aria-label="칼럼 분류"></div>
    <div class="cgrid" id="colGrid"></div>
    <p class="note" style="margin:0">핵심 정리는 말씨가 원문을 읽고 새로 쓴 요약이에요. 자세한 내용은 원문에서 확인해 주세요. 원문 링크는 새 탭으로 열리고, 글의 저작권은 각 언론사와 기관에 있어요.</p>
  </div>
</section>`;},
  mount(){
    $("colHome").onclick=()=>show("start");
    $("colGo").onclick=begin;
    const cats=["전체",...COLUMN_CATS.map(c=>c[0])];
    $("colFilter").innerHTML=cats.map(c=>`<button class="chip" data-cat="${c}">${c==="통합"?"가족 돌봄 전반":c}</button>`).join("");
    $("colFilter").querySelectorAll("button").forEach(b=>b.onclick=()=>{this.filter=b.dataset.cat;this.draw();});
    this.draw();
  },
  // cat을 주면 그 분류만 보여 주며 열기 (예: 결과 화면의 경향)
  open(cat){this.filter=cat&&COLUMN_CATS.some(c=>c[0]===cat)?cat:"전체";this.draw();show("columns");document.querySelector("#columns .cbody").scrollTop=0;window.scrollTo(0,0);},
  draw(){
    $("colFilter").querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.cat===this.filter));
    const sections=COLUMN_CATS.filter(([c])=>this.filter==="전체"||this.filter===c);
    $("colGrid").innerHTML=sections.map(([cat,desc,face])=>`
      <section class="csec"><h3 class="t"><img src="${M[face]}" alt="">${esc(desc)}</h3>
        <div class="clist">${COLUMNS.filter(a=>a.cat===cat).map(a=>`
          <article class="ccard">
            <span class="pill">${cat==="통합"?"가족 돌봄":esc(cat)}</span>
            <b>${esc(a.title)}</b>
            <p class="clead">${esc(a.lead)}</p>
            <details><summary>핵심 정리</summary><ul>${a.points.map(x=>`<li>${esc(x)}</li>`).join("")}</ul></details>
            <a class="csrc" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.src)} 원문 읽기 <span aria-hidden="true">↗</span><span class="sr">(새 탭에서 열림)</span></a>
          </article>`).join("")}</div>
      </section>`).join("");
  }
};
