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
const SCREEN_IDS=["start","chat","result","records","about"];
function show(id){SCREEN_IDS.forEach(s=>$(s).hidden=s!==id);if(id==="start")StartScreen.updRecN();}
