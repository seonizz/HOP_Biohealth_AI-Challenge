const $=id=>document.getElementById(id);
const esc=t=>String(t).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
// 받침에 맞는 조사: josa("엄마","은") → "는", josa("지수","이") → "가". 한글이 아니면 "은(는)"처럼 둘 다 표시
const JOSA={은:["은","는"],는:["은","는"],이:["이","가"],가:["이","가"],을:["을","를"],를:["을","를"],과:["과","와"],와:["과","와"]};
function josa(word,j){
  const p=JOSA[j];if(!p)return j;
  const c=String(word).trim().slice(-1).charCodeAt(0);
  if(!(c>=0xAC00&&c<=0xD7A3))return `${p[0]}(${p[1]})`;
  return (c-0xAC00)%28?p[0]:p[1];
}
const fmt=d=>{const x=new Date(d);return `${x.getFullYear()}.${x.getMonth()+1}.${x.getDate()} ${String(x.getHours()).padStart(2,"0")}:${String(x.getMinutes()).padStart(2,"0")}`;};

// 화면 전환: 한 번에 한 화면만 보임
const SCREEN_IDS=["start","chat","result","records","about","columns"];
function show(id){SCREEN_IDS.forEach(s=>$(s).hidden=s!==id);if(id==="start")StartScreen.updRecN();}

// ── 등장 애니메이션 (움직임 줄이기 설정이면 모두 건너뛰고 바로 보임) ──
const REDUCED=matchMedia("(prefers-reduced-motion: reduce)").matches;
// 요소들을 차례로 아래에서 떠오르게. scroll:true면 화면에 들어올 때 시작 (서비스 소개처럼 스크롤로 보는 화면)
function reveal(els,{step=90,start=0,scroll=false}={}){
  els=[...els].filter(Boolean);
  els.forEach((e,i)=>{e.classList.add("rv");e.classList.remove("in");e.style.transitionDelay=(start+i*step)+"ms";});
  if(REDUCED||!("IntersectionObserver" in window)){els.forEach(e=>e.classList.add("in"));return;}
  if(!scroll){requestAnimationFrame(()=>requestAnimationFrame(()=>els.forEach(e=>e.classList.add("in"))));return;}
  const io=new IntersectionObserver(es=>es.forEach(x=>{if(x.isIntersecting){x.target.classList.add("in");io.unobserve(x.target);}}),{threshold:.12});
  els.forEach(e=>io.observe(e));
}
// 제목 글자를 한 자씩 톡톡 (줄바꿈 <br>은 그대로 둠)
function popChars(el,{start=0,step=45}={}){
  if(REDUCED||!el)return;let i=0;
  [...el.childNodes].forEach(function walk(n){
    if(n.nodeType===3){const f=document.createDocumentFragment();
      [...n.textContent].forEach(c=>{const s=document.createElement("span");s.className="ch";s.textContent=c;s.style.animationDelay=(start+i++*step)+"ms";f.appendChild(s);});
      n.replaceWith(f);}
    else if(n.nodeType===1&&n.tagName!=="BR")[...n.childNodes].forEach(walk);
  });
}
// 문장을 타자 치듯 빠르게 (긴 문장도 maxMs 안에 끝남)
function typeText(el,text,{start=0,maxMs=1800}={}){
  if(REDUCED||!el){if(el)el.textContent=text;return;}
  el.textContent="";const per=Math.max(1,Math.ceil(text.length/(maxMs/16)));let i=0;
  setTimeout(function tick(){i=Math.min(text.length,i+per);el.textContent=text.slice(0,i);if(i<text.length)requestAnimationFrame(tick);},start);
}
