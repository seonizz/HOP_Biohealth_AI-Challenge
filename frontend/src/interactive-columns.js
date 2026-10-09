import {$,esc,face} from './ui.js';
import {COLUMN_CATS,COLUMNS} from './columns.js';

// Reading preferences contain article identifiers only. Conversations stay in the server DB.
const STORAGE_KEY='malssi.columns.v1';
const ART=[['listen','경청'],['boundary','건강한 경계'],['together','함께 해결'],['breathe','호흡과 안정'],['beside','곁에 있기'],['quiet','조용한 동행'],['sprout','희망의 새싹'],['walk','함께 걷기'],['family','가족의 연대'],['empathy','공감과 경청']];
const articles=COLUMNS.map((article,index)=>({...article,art:ART[index][0],artLabel:ART[index][1]}));
const category=cat=>cat==='통합'?'가족 돌봄':cat;
const artPath=article=>`/assets/columns/${article.art}.png`;
let filter='전체',only='',pick=-1,current=-1,back=null,toastTimer=null,fontScale=1;
let preferences={read:[],saved:[]};
function load(){try{const data=JSON.parse(localStorage.getItem(STORAGE_KEY));if(data&&Array.isArray(data.read)&&Array.isArray(data.saved))preferences={read:data.read.filter(x=>typeof x==='string'),saved:data.saved.filter(x=>typeof x==='string')};}catch{preferences={read:[],saved:[]};}}
function save(){try{localStorage.setItem(STORAGE_KEY,JSON.stringify(preferences));}catch{/* Private browsing may block local storage. */}}
const isRead=article=>preferences.read.includes(article.art);
const isSaved=article=>preferences.saved.includes(article.art);
function toast(message){const box=$('colToast');if(!box)return;box.textContent=message;box.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{box.hidden=true;},2600);}
function todayIndex(){const date=new Date();return (date.getFullYear()*372+date.getMonth()*31+date.getDate())%articles.length;}
function today(){const article=articles[pick];$('colToday').innerHTML=`<div class="ct-art"><img src="${artPath(article)}" alt=""></div><div class="ct-text"><span class="ct-kicker">오늘의 한 편</span><h2>${esc(article.title)}</h2><p>${esc(article.lead)}</p><div class="ct-act"><button class="btn" id="ctRead">읽어 보기</button><button class="ghost" id="ctShuffle">🎲 다른 글 뽑기</button></div></div>`;
  $('ctRead').onclick=()=>read(pick);$('ctShuffle').onclick=()=>{let next;do{next=Math.floor(Math.random()*articles.length);}while(next===pick&&articles.length>1);pick=next;today();};}
function garden(){const count=articles.filter(isRead).length;$('colGarden').innerHTML=`<div class="cg-head"><b>말씨 정원</b><span>${count} / ${articles.length}</span></div><div class="cg-bar" aria-hidden="true"><i style="width:${count/articles.length*100}%"></i></div><div class="cg-pots">${articles.map((article,index)=>`<button class="cg-pot${isRead(article)?' on':''}" data-i="${index}" aria-label="${esc(article.title)} ${isRead(article)?'(읽음)':'(아직 안 읽음)'}"><img src="${artPath(article)}" alt=""></button>`).join('')}</div><p>${count===articles.length?'정원이 가득 찼어요! 모든 글을 읽어 주셔서 고마워요.':count?'글을 끝까지 읽으면 말씨 친구가 정원에 찾아와요.':'글을 끝까지 읽으면 말씨 친구가 하나씩 정원에 찾아와요.'}</p>`;
  $('colGarden').querySelectorAll('[data-i]').forEach(button=>button.onclick=()=>read(Number(button.dataset.i)));}
function cards(){const selected=articles.map((article,index)=>[article,index]).filter(([article])=>(filter==='전체'||article.cat===filter)&&(only!=='unread'||!isRead(article))&&(only!=='saved'||isSaved(article)));
  $('colGrid').innerHTML=selected.length?selected.map(([article,index])=>`<article class="ccard${isRead(article)?' read':''}"><button class="cc-open" data-i="${index}" aria-label="${esc(article.title)} 읽기"><figure class="cart"><img src="${artPath(article)}" alt="" loading="lazy"><figcaption>${esc(article.artLabel)}</figcaption>${isRead(article)?'<span class="cc-done">✓ 읽었어요</span>':''}</figure><span class="pill">${esc(category(article.cat))}</span><b>${esc(article.title)}</b><p class="clead">${esc(article.lead)}</p><small class="cc-meta">${esc(article.src)} · 요약</small></button><button class="cc-heart" data-save="${index}" aria-pressed="${isSaved(article)}" aria-label="마음에 담기">${isSaved(article)?'♥':'♡'}</button></article>`).join(''):`<div class="cempty">${face('hear')}<p>${only==='saved'?'아직 담아 둔 글이 없어요. 마음에 드는 글의 ♡를 눌러 보세요.':'이 분류의 글을 모두 읽었어요!'}</p></div>`;
  $('colGrid').querySelectorAll('.cc-open').forEach(button=>button.onclick=()=>read(Number(button.dataset.i)));
  $('colGrid').querySelectorAll('[data-save]').forEach(button=>button.onclick=()=>toggleSaved(articles[Number(button.dataset.save)]));}
function draw(){document.querySelectorAll('#colFilter button').forEach(button=>button.setAttribute('aria-pressed',button.dataset.cat===filter));document.querySelectorAll('#colOnly button').forEach(button=>button.setAttribute('aria-pressed',button.dataset.only===only));today();garden();cards();}
function toggleSaved(article){const list=preferences.saved;const index=list.indexOf(article.art);if(index<0)list.push(article.art);else list.splice(index,1);save();draw();if(current>=0)readerFoot();}
function markRead(article){if(isRead(article))return;preferences.read.push(article.art);save();draw();readerFoot();toast(`정원에 '${article.artLabel}' 말씨가 찾아왔어요!`);}
function closeReader(){const overlay=$('colReader');if(!overlay)return;overlay.hidden=true;overlay.innerHTML='';document.body.classList.remove('noscroll');current=-1;back?.focus?.();}
function readerFoot(){const article=articles[current],previous=articles[(current-1+articles.length)%articles.length],next=articles[(current+1)%articles.length];if(!article)return;
  $('crFoot').innerHTML=`<div class="cr-end">${face(isRead(article)?'cheer':'listen')}<p>${isRead(article)?`끝까지 읽어 주셔서 고마워요. '${esc(article.artLabel)}' 말씨가 정원에 있어요.`:'여기까지 읽으셨다면, 다 읽었다고 알려 주세요.'}</p></div><div class="cr-act">${isRead(article)?'':'<button class="btn" id="crDone">🌱 다 읽었어요</button>'}<button class="ghost" id="crSave" aria-pressed="${isSaved(article)}">${isSaved(article)?'♥ 담아 뒀어요':'♡ 마음에 담기'}</button><button class="ghost" id="crTalk">이 마음, 말씨와 정리하기</button></div><div class="cr-nav"><button class="ghost" id="crPrev">← ${esc(previous.title)}</button><button class="ghost" id="crNext">${esc(next.title)} →</button></div>`;
  if($('crDone'))$('crDone').onclick=()=>markRead(article);
  $('crSave').onclick=()=>toggleSaved(article);
  $('crTalk').onclick=()=>{closeReader();beginAction();};
  $('crPrev').onclick=()=>read((current-1+articles.length)%articles.length);
  $('crNext').onclick=()=>read((current+1)%articles.length);
}
let beginAction=()=>{};
function read(index){current=index;const article=articles[index],overlay=$('colReader');if(overlay.hidden)back=document.activeElement;
  overlay.innerHTML=`<div class="cr-panel" style="--fs:${fontScale}"><div class="cr-top"><div class="cr-prog" aria-hidden="true"><i id="crProg"></i></div><button class="ghost cr-sz" data-sz="-1" aria-label="글자 작게">가−</button><button class="ghost cr-sz" data-sz="1" aria-label="글자 크게">가+</button><button class="ghost" id="crClose" aria-label="닫기">✕ 닫기</button></div><div class="cr-scroll" id="crScroll"><figure class="cr-art"><img src="${artPath(article)}" alt="${esc(article.artLabel)} 그림 속 말씨"><figcaption>${esc(article.artLabel)}</figcaption></figure><span class="pill">${esc(category(article.cat))}</span><h2 id="crTitle">${esc(article.title)}</h2><p class="cr-meta">${esc(article.src)} · 요약 · <a href="${esc(article.url)}" target="_blank" rel="noopener noreferrer">원문 보기 ↗<span class="sr">(새 탭에서 열림)</span></a></p><p class="cr-lead">${esc(article.lead)}</p><div class="cr-body"><ul>${article.points.map(point=>`<li>${esc(point)}</li>`).join('')}</ul><p class="note">이 글은 요약으로 보여 드려요. 전체 내용은 원문에서 읽어 보세요.</p></div><div class="cr-foot" id="crFoot"></div></div></div>`;
  overlay.hidden=false;document.body.classList.add('noscroll');
  overlay.querySelectorAll('.cr-sz').forEach(button=>button.onclick=()=>{fontScale=Math.min(1.3,Math.max(.85,Math.round((fontScale+Number(button.dataset.sz)*.15)*100)/100));overlay.querySelector('.cr-panel').style.setProperty('--fs',fontScale);});
  $('crClose').onclick=closeReader;overlay.onclick=event=>{if(event.target===overlay)closeReader();};overlay.onkeydown=event=>{if(event.key==='Escape')closeReader();};
  const scroller=$('crScroll');scroller.onscroll=()=>{const progress=scroller.scrollTop/Math.max(1,scroller.scrollHeight-scroller.clientHeight);$('crProg').style.width=`${Math.min(100,progress*100)}%`;if(progress>.97)markRead(article);};
  readerFoot();$('crClose').focus();
}
export function showColumns(page,onBegin,cat='전체'){
  load();beginAction=onBegin;filter=COLUMN_CATS.some(([name])=>name===cat)?cat:'전체';only='';pick=todayIndex();
  page(`<div class="cbody"><h1 class="column-heading">함께 알아보는 <em>마음 돌봄</em></h1><div class="ctop"><div class="ctoday" id="colToday"></div><div class="cgarden" id="colGarden"></div></div><div class="cbar"><div class="chips" id="colFilter" role="group" aria-label="칼럼 분류">${['전체',...COLUMN_CATS.map(([name])=>name)].map(name=>`<button class="chip" data-cat="${esc(name)}">${name==='통합'?'가족 돌봄 전반':esc(name)}</button>`).join('')}</div><div class="chips" id="colOnly" role="group" aria-label="골라 보기"><button class="chip" data-only="unread">안 읽은 글</button><button class="chip" data-only="saved">♥ 담아 둔 글</button></div></div><div class="cgrid" id="colGrid"></div><p class="note">글의 저작권은 각 언론사와 기관에 있습니다. 원문은 새 탭으로 열리며, 읽음·담기 표시는 이 브라우저에만 저장됩니다.</p></div><div class="creader" id="colReader" hidden role="dialog" aria-modal="true" aria-labelledby="crTitle"></div><div class="ctoast" id="colToast" role="status" hidden></div>`,'columns');
  $('colFilter').querySelectorAll('button').forEach(button=>button.onclick=()=>{filter=button.dataset.cat;draw();});
  $('colOnly').querySelectorAll('button').forEach(button=>button.onclick=()=>{only=only===button.dataset.only?'':button.dataset.only;draw();});
  draw();
}
