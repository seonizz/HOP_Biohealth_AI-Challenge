export const $=(id)=>document.getElementById(id);
export const esc=(value)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const face=(name='hello',cls='')=>`<img class="${cls}" src="/assets/mascot/${name}.png" alt="">`;
export const GOALS={understand:'상황을 이해하고 싶어요',what_to_say:'어떤 말을 할지 고민돼요',what_to_do:'도울 방법을 찾고 있어요',support_me:'제 마음도 돌보고 싶어요',find_help:'도움받을 곳을 찾고 싶어요',unsure:'아직 잘 모르겠어요'};
export const STATES={SETUP:'시작',EXPLORING:'이야기 나누는 중',REVIEWING:'함께 정리 중',GUIDANCE:'가이드 확인',FOLLOW_UP:'다음 이야기',SAFETY_HOLD:'안전 확인',COMPLETED:'마무리',ARCHIVED:'보관'};
export const date=(value)=>new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeZone:'Asia/Seoul'}).format(new Date(value));
export function notice(text,retry) {
  const box=$('notice');box.hidden=false;box.replaceChildren(document.createTextNode(text));
  if(retry){const b=document.createElement('button');b.className='ghost';b.textContent='같은 요청 다시 보내기';b.onclick=retry;box.append(b);}
  const close=document.createElement('button');close.className='ghost';close.textContent='닫기';close.onclick=()=>box.hidden=true;box.append(close);
}
export function dialog(title,body,bind) {
  const d=$('dialog');d.innerHTML=`<header><h2 id="dialog-title">${esc(title)}</h2><button class="ghost" id="dialog-close" aria-label="닫기">닫기</button></header>${body}`;
  $('dialog-close').onclick=()=>d.close();bind?.(d);if(!d.open)d.showModal();
}
export const list=(values)=>`<ul>${values.map(v=>`<li>${esc(v)}</li>`).join('')}</ul>`;
export function guidanceCards(g,canChoose=false) {
  if(!g)return '';
  return `<div class="guide-grid"><article class="card care">${face('empathy')}<p>${esc(g.supporter_acknowledgement)}</p></article>
    <article class="card"><h3>함께 정리한 이야기</h3><p>${esc(g.situation_summary)}</p></article>
    ${g.suggested_words.map(w=>`<article class="card script"><h3>이렇게 말을 건네 보세요</h3><p>${esc(w.text)}</p><p class="note">${esc(w.purpose)}</p></article>`).join('')}
    ${g.actions.map((a,i)=>`<article class="card"><h3>${esc(a.title)}</h3><p>${esc(a.how)}</p>${a.preconditions.length?`<p class="note">먼저 확인해 주세요</p>${list(a.preconditions)}`:''}${a.stop_if.length?`<p class="note">이럴 때는 멈춰 주세요</p>${list(a.stop_if)}`:''}${canChoose?`<button class="ghost choose-plan" data-index="${i}">이 행동을 계획으로 선택</button>`:''}</article>`).join('')}
    <article class="card avoid"><h3>조심하면 좋은 표현</h3>${g.avoid.map(a=>`<p><b>${esc(a.expression)}</b><br>${esc(a.reason)}<br>대신: ${esc(a.alternative)}</p>`).join('')}</article>
    <article class="card"><h3>당신도 함께 돌봐 주세요</h3>${list(g.supporter_care)}</article>
    <article class="card"><h3>참고해 주세요</h3>${list(g.limitations)}<p class="note">입력하신 이야기를 바탕으로 한 제한적인 대화 제안입니다. 진단·치료나 검증된 효과를 뜻하지 않습니다.</p></article></div>`;
}
