// 3. 결과 화면: 좌 마스코트 · 우 가이드 카드
const ResultScreen={
  render(){return `
<section class="screen" id="result" hidden>
  ${NavBar()}
  <div class="wrapr" id="rbody"></div>
</section>`;},
  mount(){},
  prepare(view){
    this.previewCards=new Map();
    $("rbody").innerHTML=`
     <div class="rside"><img src="${M.cheer}" alt="하트를 안은 말씨">
       <div class="pill">${esc(view.name||"그분")}</div>
       <h2>대화를 함께<br>살펴보고 있어요</h2></div>
     <div class="cards">
       <div class="result-stream" aria-live="polite" aria-relevant="additions text"></div>
       <div class="card result-pending" role="status" aria-live="polite">${ChatScreen.progressMarkup()}</div>
     </div>`;
    show("result");
    this.progress({status:"running",current:"이야기 살펴보기",attempt:1});
  },
  progress(value){
    const card=$("rbody").querySelector(".result-pending");
    if(card)ChatScreen.thinkProgress(value,card);
  },
  partial(cards){
    const stream=$("rbody").querySelector(".result-stream");
    if(!stream||!Array.isArray(cards))return;
    const incoming=new Set(cards.map(card=>card.id));
    for(const [id,entry] of this.previewCards){
      if(!incoming.has(id)){entry.node.remove();this.previewCards.delete(id);}
    }
    // The next card also uses tips from the currently approved care card.
    const care=cards.find(card=>card.id==='care')?.value;
    for(const card of cards){
      const signature=JSON.stringify(card.id==='next'?{...card,care}:card),previous=this.previewCards.get(card.id);
      if(previous?.signature===signature)continue;
      const html=GuideCards.partial(card,{care});if(!html)continue;
      const node=previous?.node||document.createElement("div");
      node.className="result-live-card";node.dataset.card=card.id;
      // Preserve an expanded relationship/evidence section across reviewed updates.
      const expanded=[...node.querySelectorAll("details")].map(section=>section.open);
      node.innerHTML=html;
      [...node.querySelectorAll("details")].forEach((section,index)=>{if(expanded[index])section.open=true;});
      if(card.id==='script')GuideCards.bindCopy(node,card.value);
      if(!previous)stream.appendChild(node);
      this.previewCards.set(card.id,{node,signature,html});
    }
    // Show either action as soon as it is ready. When both are ready, reuse
    // their nodes in the original two-column pair at the first action's place.
    const actions=['doList','avoid'].map(id=>this.previewCards.get(id)?.node);
    let pair=stream.querySelector('.guide-actions');
    if(actions.every(Boolean)){
      if(!pair){pair=document.createElement('div');pair.className='two guide-actions';}
      if(actions.some((node,index)=>pair.children[index]!==node)){
        actions.forEach(node=>{node.remove();pair.appendChild(node);});
      }
    }else if(pair){
      [...pair.children].forEach(node=>{node.remove();stream.appendChild(node);});
      pair.remove();pair=null;
    }
    // A removed/reapproved card can move within one polling interval. Follow
    // the server's completion order while preserving the existing DOM nodes.
    const ordered=[];
    for(const card of cards){
      const node=pair&&['doList','avoid'].includes(card.id)?pair:this.previewCards.get(card.id)?.node;
      if(node&&!ordered.includes(node))ordered.push(node);
    }
    if(ordered.some((node,index)=>stream.children[index]!==node)){
      ordered.forEach(node=>{node.remove();stream.appendChild(node);});
    }
  },
  pendingError(message,retry){
    this.partial([]);
    const card=$("rbody").querySelector(".result-pending");if(!card)return;
    card.setAttribute("role","alert");card.textContent="";
    const heading=document.createElement("h3");heading.textContent="말하는 방법을 준비하지 못했어요";
    const detail=document.createElement("p");detail.textContent=message;
    const button=document.createElement("button");button.className="ghost";button.type="button";button.textContent="다시 시도";button.onclick=retry;
    card.appendChild(heading);card.appendChild(detail);card.appendChild(button);
  },
  open(p,g,saved,analysis,detail,recordId){
    const selectors={care:'.care',script:'.script',doList:'.do',avoid:'.avoid',next:'.next',relationship:'.relationship'};
    const visible=$("rbody").querySelector('.result-stream')?Object.keys(selectors).filter(id=>
      this.previewCards?.get(id)?.html===GuideCards.partial({id,value:id==='relationship'?analysis:g[id],detail},{care:g.care})):[];
    this.previewCards=new Map();
    $("rbody").innerHTML=`
     <div class="rside"><img src="${M.cheer}" alt="하트를 안은 말씨">
       <div class="pill">${[p.name||"그분",p.rel,g.top+" 안내"].filter(Boolean).map(esc).join(" · ")}</div>
       <h2>이렇게 마음을<br>건네 보세요</h2><p>완벽한 말보다, 곁에 있다는 신호가 더 중요해요.</p></div>
     <div class="cards">
       ${p.safety?GuideCards.safety():""}
       ${GuideCards.care(g.care)}
       ${GuideCards.speech(g,detail,{copy:true})}
       ${GuideCards.doAvoid(g)}
       ${GuideCards.next(g)}
       ${analysis?GuideCards.relationship(analysis):""}
       <div class="actions"><span class="note" style="margin-right:auto;align-self:center">${saved?`"${esc(p.name||"그분")}" 기록으로 저장했어요.`:"기록을 저장하지 못했어요."}</span>${saved&&recordId?'<button class="btn" id="resultContinue" type="button">추가 질문하기</button>':""}<button class="ghost" id="toCol">${esc(g.top)} 관련 칼럼</button><button class="ghost" id="toRec">내 기록 보기</button><button class="ghost" id="again">처음부터 다시</button></div>
       ${CrisisLine("위급할 땐 <b>109</b> 자살예방상담 · <b>1577-0199</b> 정신건강위기상담 · <b>112 / 119</b>")}
     </div>`;
    show("result");this.animate(visible.map(id=>$("rbody").querySelector(selectors[id])).filter(Boolean));
    if(saved&&recordId)$("resultContinue").onclick=()=>ContinuationScreen.start(recordId);
    $("toRec").onclick=()=>RecordsScreen.open();
    $("toCol").onclick=()=>ColumnsScreen.open(g.top);
    GuideCards.bindCopy($("rbody"),g.script);
    $("again").onclick=()=>show("start");
  },
  // 등장 효과: 왼쪽 말씨·제목이 먼저, 이어서 오른쪽 카드가 한 칸씩 통째로 떠오름
  animate(alreadyVisible=[]){
    const b=$("rbody"),side=b.querySelector(".rside");
    reveal(side.children,{step:120});
    const order=[];[...b.querySelector(".cards").children].forEach(c=>c.classList.contains("two")?order.push(...c.children):order.push(c));
    const appearing=order.filter(card=>!alreadyVisible.includes(card));
    appearing.forEach(c=>c.classList.add("pop"));reveal(appearing,{start:300,step:170});
  }
};
