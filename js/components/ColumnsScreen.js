// 6. 칼럼 화면: 오늘의 한 편, 말씨 정원(읽은 글 모으기), 분류·안 읽은 글·담아 둔 글 골라 보기, 읽기 화면
// 읽음·담음 기록은 이 브라우저에만 저장 (localStorage)
const COL_KEY="malssi.columns.v1";
const colKey=a=>a.url.replace(/^https?:\/\//,"");          // 본문(COLUMN_BODIES) 찾는 열쇠
const colBody=a=>(typeof COLUMN_BODIES!=="undefined"&&COLUMN_BODIES[colKey(a)])||null;
const colMinutes=a=>{const b=colBody(a);const n=b?b.join("").length:(a.lead+a.points.join("")).length;return Math.max(1,Math.round(n/500));};
const catLabel=c=>c==="통합"?"가족 돌봄":c;

const ColumnsScreen={
  filter:"전체", only:"",                                    // only: "" | "unread" | "saved"
  st:{read:[],saved:[]},
  load(){try{const s=JSON.parse(localStorage.getItem(COL_KEY));if(s)this.st={read:s.read||[],saved:s.saved||[]};}catch(e){}},
  save(){try{localStorage.setItem(COL_KEY,JSON.stringify(this.st));}catch(e){}},
  isRead(a){return this.st.read.includes(a.art);}, isSaved(a){return this.st.saved.includes(a.art);},

  render(){return `
<section class="screen" id="columns" hidden>
  ${TopBar(`<span class="pill">칼럼</span><button class="ghost" id="colHome" style="margin-left:auto">처음으로</button><button class="btn" id="colGo" style="padding:10px 26px;font-size:18px">말씨와 시작하기</button>`)}
  <div class="cbody">
    <div class="ctop">
      <div class="ctoday" id="colToday"></div>
      <div class="cgarden" id="colGarden"></div>
    </div>
    <div class="cbar">
      <div class="chips" id="colFilter" role="group" aria-label="분류"></div>
      <div class="chips" id="colOnly" role="group" aria-label="골라 보기">
        <button class="chip" data-only="unread">안 읽은 글</button><button class="chip" data-only="saved">♥ 담아 둔 글</button>
      </div>
    </div>
    <div class="cgrid" id="colGrid"></div>
    <p class="note" style="margin:0">글의 저작권은 각 언론사와 기관에 있어요. 원문 링크는 새 탭으로 열려요. 읽은 글과 담아 둔 글은 이 브라우저에만 기억돼요.</p>
  </div>
  <div class="creader" id="colReader" hidden role="dialog" aria-modal="true" aria-labelledby="crTitle"></div>
  <div class="ctoast" id="colToast" role="status" hidden></div>
</section>`;},

  mount(){
    this.load();
    $("colHome").onclick=()=>show("start");
    $("colGo").onclick=begin;
    $("colFilter").innerHTML=["전체",...COLUMN_CATS.map(c=>c[0])].map(c=>`<button class="chip" data-cat="${c}">${c==="통합"?"가족 돌봄 전반":c}</button>`).join("");
    $("colFilter").querySelectorAll("button").forEach(b=>b.onclick=()=>{this.filter=b.dataset.cat;this.draw();});
    $("colOnly").querySelectorAll("button").forEach(b=>b.onclick=()=>{this.only=this.only===b.dataset.only?"":b.dataset.only;this.draw();});
    this.pick=this.todayIndex();
    this.draw();
  },
  // cat을 주면 그 분류만 보여 주며 열기 (예: 결과 화면의 경향)
  open(cat){this.filter=cat&&COLUMN_CATS.some(c=>c[0]===cat)?cat:"전체";this.only="";this.draw();show("columns");document.querySelector("#columns .cbody").scrollTop=0;window.scrollTo(0,0);},

  // 오늘의 한 편: 날짜마다 다른 글 (같은 날에는 같은 글)
  todayIndex(){const d=new Date();return (d.getFullYear()*372+d.getMonth()*31+d.getDate())%COLUMNS.length;},
  shuffle(){let i;do{i=Math.floor(Math.random()*COLUMNS.length);}while(COLUMNS.length>1&&i===this.pick);this.pick=i;this.drawToday(true);},

  draw(){
    $("colFilter").querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.cat===this.filter));
    $("colOnly").querySelectorAll("button").forEach(b=>b.setAttribute("aria-pressed",b.dataset.only===this.only));
    this.drawToday();this.drawGarden();this.drawGrid();
  },
  drawToday(anim){
    const a=COLUMNS[this.pick];
    $("colToday").innerHTML=`
      <div class="ct-art${anim?" pop":""}"><img src="assets/columns/${a.art}.png" alt=""></div>
      <div class="ct-text">
        <span class="ct-kicker">오늘의 한 편</span>
        <h2>${esc(a.title)}</h2>
        <p>${esc(a.lead)}</p>
        <div class="ct-act"><button class="btn" id="ctRead">읽어 보기</button><button class="ghost" id="ctShuffle">🎲 다른 글 뽑기</button></div>
      </div>`;
    $("ctRead").onclick=()=>this.read(COLUMNS.indexOf(a));
    $("ctShuffle").onclick=()=>this.shuffle();
  },
  // 말씨 정원: 끝까지 읽은 글의 말씨가 하나씩 찾아와요
  drawGarden(){
    const n=COLUMNS.filter(a=>this.isRead(a)).length;
    $("colGarden").innerHTML=`
      <div class="cg-head"><b>말씨 정원</b><span>${n} / ${COLUMNS.length}</span></div>
      <div class="cg-bar" aria-hidden="true"><i style="width:${n/COLUMNS.length*100}%"></i></div>
      <div class="cg-pots">${COLUMNS.map((a,i)=>`<button class="cg-pot${this.isRead(a)?" on":""}" data-i="${i}" title="${esc(a.artLabel)} · ${esc(a.title)}" aria-label="${esc(a.title)} ${this.isRead(a)?"(읽음)":"(아직 안 읽음)"}"><img src="assets/columns/${a.art}.png" alt=""></button>`).join("")}</div>
      <p>${n===COLUMNS.length?"정원이 가득 찼어요! 모든 글을 읽어 주셔서 고마워요.":n?"글을 끝까지 읽으면 말씨 친구가 정원에 찾아와요.":"글을 끝까지 읽으면 말씨 친구가 하나씩 정원에 찾아와요. 첫 친구를 만나 보세요!"}</p>`;
    $("colGarden").querySelectorAll(".cg-pot").forEach(b=>b.onclick=()=>this.read(+b.dataset.i));
  },
  drawGrid(){
    const list=COLUMNS.map((a,i)=>[a,i]).filter(([a])=>(this.filter==="전체"||a.cat===this.filter)&&(this.only!=="unread"||!this.isRead(a))&&(this.only!=="saved"||this.isSaved(a)));
    $("colGrid").innerHTML=list.length?list.map(([a,i])=>`
      <article class="ccard${this.isRead(a)?" read":""}">
        <button class="cc-open" data-i="${i}" aria-label="${esc(a.title)} 읽기">
          <figure class="cart"><img src="assets/columns/${a.art}.png" alt="" loading="lazy"><figcaption>${esc(a.artLabel)}</figcaption>${this.isRead(a)?'<span class="cc-done">✓ 읽었어요</span>':""}</figure>
          <span class="pill">${esc(catLabel(a.cat))}</span>
          <b>${esc(a.title)}</b>
          <p class="clead">${esc(a.lead)}</p>
          <small class="cc-meta">${esc(a.src)} · ${colBody(a)?`약 ${colMinutes(a)}분`:"요약"}</small>
        </button>
        <button class="cc-heart" data-save="${i}" aria-pressed="${this.isSaved(a)}" aria-label="마음에 담기">${this.isSaved(a)?"♥":"♡"}</button>
      </article>`).join(""):`<div class="cempty"><img src="${M.hear}" alt=""><p>${this.only==="saved"?"아직 담아 둔 글이 없어요. 마음에 드는 글의 ♡를 눌러 보세요.":"이 분류의 글을 모두 읽었어요!"}</p></div>`;
    $("colGrid").querySelectorAll(".cc-open").forEach(b=>b.onclick=()=>this.read(+b.dataset.i));
    $("colGrid").querySelectorAll("[data-save]").forEach(b=>b.onclick=()=>this.toggleSave(COLUMNS[+b.dataset.save]));
  },
  toggleSave(a){const s=this.st.saved;s.includes(a.art)?s.splice(s.indexOf(a.art),1):s.push(a.art);this.save();this.draw();if(this.cur!=null)this.drawReaderFoot();},
  markRead(a){if(this.isRead(a))return;this.st.read.push(a.art);this.save();this.draw();this.toast(`정원에 '${a.artLabel}' 말씨가 찾아왔어요!`);},
  toast(t){const el=$("colToast");el.textContent=t;el.hidden=false;clearTimeout(this._tt);this._tt=setTimeout(()=>el.hidden=true,2600);},

  // ── 읽기 화면 ──
  size:1,
  read(i){
    this.cur=i;const a=COLUMNS[i],body=colBody(a),r=$("colReader");
    if(r.hidden)this.back=document.activeElement;
    r.innerHTML=`
      <div class="cr-panel" style="--fs:${this.size}">
        <div class="cr-top">
          <div class="cr-prog" aria-hidden="true"><i id="crProg"></i></div>
          <button class="ghost cr-sz" data-sz="-1" aria-label="글자 작게">가−</button><button class="ghost cr-sz" data-sz="1" aria-label="글자 크게">가+</button>
          <button class="ghost" id="crClose" aria-label="닫기">✕ 닫기</button>
        </div>
        <div class="cr-scroll" id="crScroll">
          <figure class="cr-art"><img src="assets/columns/${a.art}.png" alt="${esc(a.artLabel)} 그림 속 말씨"><figcaption>${esc(a.artLabel)}</figcaption></figure>
          <span class="pill">${esc(catLabel(a.cat))}</span>
          <h2 id="crTitle">${esc(a.title)}</h2>
          <p class="cr-meta">${esc(a.src)} · ${body?`읽는 데 약 ${colMinutes(a)}분`:"요약"} · <a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">원문 보기 ↗<span class="sr">(새 탭에서 열림)</span></a></p>
          <p class="cr-lead">${esc(a.lead)}</p>
          <div class="cr-body">${body?body.map(p=>`<p>${esc(p)}</p>`).join(""):
            `<ul>${a.points.map(x=>`<li>${esc(x)}</li>`).join("")}</ul><p class="note">이 글은 아직 본문이 없어서 요약으로 보여 드려요. 전체 내용은 원문에서 읽어 보세요.</p>`}</div>
          <div class="cr-foot" id="crFoot"></div>
        </div>
      </div>`;
    r.hidden=false;document.body.classList.add("noscroll");
    r.querySelectorAll(".cr-sz").forEach(b=>b.onclick=()=>{this.size=Math.min(1.3,Math.max(.85,Math.round((this.size+(+b.dataset.sz)*.15)*100)/100));r.querySelector(".cr-panel").style.setProperty("--fs",this.size);});
    $("crClose").onclick=()=>this.close();
    r.onclick=e=>{if(e.target===r)this.close();};
    r.onkeydown=e=>{if(e.key==="Escape")this.close();};
    // 읽은 정도 막대, 끝까지 내려오면 읽음으로 기록
    const sc=$("crScroll");sc.onscroll=()=>{const p=sc.scrollTop/Math.max(1,sc.scrollHeight-sc.clientHeight);$("crProg").style.width=Math.min(100,p*100)+"%";if(p>.97&&!this.isRead(a)){this.markRead(a);this.drawReaderFoot();}};
    this.drawReaderFoot();$("crClose").focus();
  },
  drawReaderFoot(){
    const i=this.cur,a=COLUMNS[i],n=COLUMNS.length,prev=COLUMNS[(i-1+n)%n],next=COLUMNS[(i+1)%n];
    $("crFoot").innerHTML=`
      <div class="cr-end"><img src="${M[this.isRead(a)?"cheer":"listen"]}" alt=""><p>${this.isRead(a)?`끝까지 읽어 주셔서 고마워요. '${esc(a.artLabel)}' 말씨가 정원에 있어요.`:"여기까지 읽으셨다면, 다 읽었다고 알려 주세요."}</p></div>
      <div class="cr-act">
        ${this.isRead(a)?"":`<button class="btn" id="crDone">🌱 다 읽었어요</button>`}
        <button class="ghost" id="crSave" aria-pressed="${this.isSaved(a)}">${this.isSaved(a)?"♥ 담아 뒀어요":"♡ 마음에 담기"}</button>
        <button class="ghost" id="crTalk">이 마음, 말씨와 정리하기</button>
      </div>
      <div class="cr-nav"><button class="ghost" id="crPrev">← ${esc(prev.title)}</button><button class="ghost" id="crNext">${esc(next.title)} →</button></div>`;
    if($("crDone"))$("crDone").onclick=()=>{this.markRead(a);this.drawReaderFoot();};
    $("crSave").onclick=()=>this.toggleSave(a);
    $("crTalk").onclick=()=>{this.close();begin();};
    $("crPrev").onclick=()=>{this.read((i-1+n)%n);$("crScroll").scrollTop=0;};
    $("crNext").onclick=()=>{this.read((i+1)%n);$("crScroll").scrollTop=0;};
  },
  close(){$("colReader").hidden=true;$("colReader").innerHTML="";document.body.classList.remove("noscroll");this.cur=null;this.back?.focus?.();}
};
