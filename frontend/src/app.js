import {request,v2,allPages} from './api.js';
import {$,esc,face,GOALS,STATES,date,notice,dialog,guidanceCards} from './ui.js';
import {questionMarkup,bindQuestion,answerText} from './questions.js';
import {demoGuidance} from './demo.js';
import {showColumns} from './interactive-columns.js';

let user=null,capabilities=null,consents=null,current=null,project=null,busy=false,pending=null,pollTimer=null,viewId=0,demoEnabled=false;
const root=$('app');
const goalOptions=()=>Object.entries(GOALS).map(([v,label])=>`<option value="${v}">${label}</option>`).join('');
const on=(id,fn)=>{const el=$(id);if(el)el.onclick=()=>task(fn);};
const terminal=()=>['COMPLETED','ARCHIVED'].includes(current?.state);
function stopPoll(){clearTimeout(pollTimer);pollTimer=null;}
function clearPrivate(){user=null;capabilities=null;consents=null;current=null;project=null;pending=null;stopPoll();$('dialog').close();$('dialog').innerHTML='';location.hash='';}
function lock(value){busy=value;document.querySelectorAll('button:not(:disabled),fieldset:not(:disabled)').forEach(el=>{if(value){el.dataset.taskDisabled='true';el.disabled=true;}});if(!value)document.querySelectorAll('[data-task-disabled]').forEach(el=>{el.disabled=false;delete el.dataset.taskDisabled;});}
async function task(fn){if(busy)return;lock(true);try{await fn();}catch(error){handleError(error);}finally{lock(false);}}
function handleError(error){
  if(error.status===401&&user){const wasDemo=user.is_demo;clearPrivate();if(wasDemo)home();else auth();notice(wasDemo?'24시간 시연 세션이 만료되었습니다. 새 체험을 시작해 주세요.':'접속 시간이 만료되었습니다. 다시 로그인해 주세요.');return;}
  const messages={MODEL_UNAVAILABLE:'모델 서버가 준비되지 않았습니다. 저장된 답변은 그대로 유지됩니다.',QUEUE_FULL:'요청이 많습니다. 잠시 후 다시 시도해 주세요.',REVISION_CONFLICT:'다른 창에서 대화가 변경되었습니다. 새로 불러오기를 눌러 확인해 주세요.',CONSENT_REQUIRED:'서비스 이용 동의를 확인해 주세요.',QUESTION_RETIRED:'현재 문항은 공개 이용 승인이 완료되지 않았습니다. 운영자에게 문의해 주세요.',INVALID_OPTION:'보기와 직접 입력 내용을 확인해 주세요.',FAILED_VERIFICATION:'답변 검증을 통과하지 못했습니다. 가이드 생성을 다시 요청해 주세요.',DEADLINE_EXCEEDED:'응답 시간이 초과되었습니다. 저장된 이야기는 유지됩니다.'};
  notice(messages[error.code]||error.message||'요청을 처리하지 못했습니다.',pending?()=>task(retryPending):null);
}
// The exact body and UUID survive ambiguous network failures in memory; never resend with a new ID.
async function mutate(path,body,after=async()=>{},method='POST'){
  if(pending){notice('처리 결과를 확인하지 못한 요청이 있습니다. 같은 요청을 먼저 다시 보내 주세요.',()=>task(retryPending));return;}
  pending={path:'/api/v2'+path,body:{request_id:crypto.randomUUID(),...body},method,after};
  await retryPending();
}
async function retryPending(){
  const operation=pending;if(!operation)return;
  let result;
  try{result=await request(operation.path,operation.method,operation.body);}catch(error){if(!error.retryable)pending=null;throw error;}
  pending=null;$('notice').hidden=true;
  await operation.after(result);
}
function page(body,id=''){
  stopPoll();viewId++;document.body.classList.remove('noscroll');
  root.innerHTML=`<section class="screen" ${id?`id="${id}"`:''}><header class="top"><button class="logo" id="home" aria-label="말씨 처음으로">말씨<small>●</small></button><nav aria-label="주 메뉴"><button class="ghost" id="about-nav">서비스 소개</button><button class="ghost" id="columns-nav">칼럼</button><button class="ghost" id="help">안전 도움</button>${user?`<button class="ghost" id="records">내 기록</button><button class="ghost" id="settings">내 설정</button><button class="ghost" id="logout">로그아웃</button>`:'<button class="ghost" id="login">로그인</button>'}</nav><div class="crisis">위급할 땐 <b>109</b> 자살예방상담 · <b>1577-0199</b> 정신건강위기상담</div></header>${user?.is_demo?`<div class="status-banner">가입 없는 시연 · 24시간 후 접속이 만료되고 기록은 다음 정리 주기에 삭제됩니다. 실제 개인정보는 입력하지 마세요.${capabilities?.dual_turn_enabled&&!capabilities.model_execution_enabled?' 현재 모델이 연결되지 않아 표현 평가는 불가 상태로 기록됩니다.':''}</div>`:capabilities?.internal_draft?'<div class="status-banner">내부 검토용 · 문항과 모델 응답의 출시 검토가 진행 중입니다.</div>':''}<main id="main" tabindex="-1">${body}</main><footer class="footer">말씨는 진단이나 치료를 대신하지 않습니다. 실명보다 별칭으로 이야기해 주세요.</footer></section>`;
  on('home',()=>{location.hash='';home();});on('about-nav',about);on('columns-nav',()=>columns());on('login',()=>auth());on('records',records);on('settings',settings);on('help',help);
  on('logout',async()=>{await request('/api/auth/logout','POST',{});clearPrivate();home();});
  $('main').focus({preventScroll:true});
  window.scrollTo(0,0);
}
function home(){page(`<div class="hero"><div><span class="pill" style="margin-bottom:18px">우울 · 불안 · 중독을 겪는 사람의 곁에서</span><h1>소중한 사람에게 건넬<br><em>첫 마디</em>를 함께 심어요</h1><p class="lead">말씨가 몇 가지를 여쭤볼게요. 답해 주시면 그분의 상황을 함께 정리하고, 마음이 잘 닿는 말하기 방법을 알려드려요.</p><div class="steps"><div class="step">${face('listen')}<span>질문에 답하기<i>편한 속도로</i></span></div><div class="step">${face('ponder')}<span>상황 정리<i>말씨가 함께 확인해요</i></span></div><div class="step">${face('cheer')}<span>말하는 방법<i>가이드 화면 예시</i></span></div></div><button class="btn" id="begin">${!user&&demoEnabled?'가입 없이 체험하기':'말씨와 시작하기'}</button><p class="note">${!user&&demoEnabled?'시연 기록은 서버에 임시 저장되며 접속은 24시간 후 만료됩니다. 실제 개인정보 대신 가상 사례를 입력해 주세요. 모델 응답은 사용하지 않습니다.':'말씨는 진단이나 치료를 대신하지 않아요. 실명 대신 별칭으로 이야기해 주세요.'}</p></div><div class="stage"><div class="blob"></div>${face('empathy','orbit o1')}${face('joy','orbit o2')}${face('thanks','orbit o3')}${face('hello','main')}<div class="bubble-tip">안녕하세요, 저는 말씨예요!</div></div></div>`,'start');on('begin',()=>user?newProject():demoEnabled?startDemo():auth());}
function about(){page(`<div class="abody"><div class="ahero"><div><span class="pill">말씨를 소개합니다</span><h2>곁에 있는 사람의 <em>첫 마디</em>를 함께 생각해요</h2><p>말씨는 몇 가지 질문으로 상황을 정리하고, 상대에게 건넬 말과 작은 행동을 준비하도록 돕습니다. 진단이나 치료를 대신하지 않습니다.</p></div>${face('hello')}</div><div class="agrid"><article class="acard">${face('listen')}<h3>질문에 답하기</h3><p>모르는 질문은 넘어갈 수 있습니다. 현재 상황만 편한 속도로 알려 주세요.</p></article><article class="acard">${face('ponder')}<h3>상황 정리</h3><p>답변은 보호된 서버 기록에 저장되며 언제든 확인·정정·삭제할 수 있습니다.</p></article><article class="acard">${face('cheer')}<h3>말하는 방법</h3><p>현재 시연의 가이드 화면은 가상의 고정 예시입니다. 실제 모델 분석 결과가 아닙니다.</p></article></div><div class="acta"><button class="btn" id="about-begin">${!user&&demoEnabled?'가입 없이 체험하기':'말씨와 시작하기'}</button></div></div>`,'about');on('about-begin',()=>user?newProject():demoEnabled?startDemo():auth());}
function sampleGuide(){
  const conversationId=current?.conversation_id;
  page(`<div class="wrapr"><div class="rside">${face('cheer')}<span class="pill">가이드 화면 예시</span><h2>이렇게 마음을<br>건네 보세요</h2><p>완벽한 말보다, 곁에 있다는 신호가 더 중요해요.</p></div><div class="cards"><article class="card safety-panel"><h3>AI 생성 결과 아님</h3><p>고정된 가상 사례이며 입력한 답변을 분석하거나 개인화하지 않았습니다.</p></article>${guidanceCards(demoGuidance)}<div class="actions"><button class="ghost" id="back-to-conversation">대화로 돌아가기</button></div></div></div>`,'result');
  on('back-to-conversation',()=>openConversation(conversationId));
}
function columns(cat='전체'){showColumns(page,()=>user?newProject():demoEnabled?task(startDemo):auth(),cat);}
async function startDemo(){
  const data=await request('/api/auth/demo','POST',{});
  user=data.user;
  [capabilities,consents]=await Promise.all([v2('/capabilities'),v2('/consents')]);
  await openConversation(data.conversation_id);
}
function auth(register=false){
  page(`<article class="card narrow"><p class="eyebrow">다시 이어갈 수 있도록</p><h1>${register?'말씨에 가입하기':'말씨에 로그인'}</h1><form id="auth-form"><fieldset class="form-body"><label class="field">이메일<input name="email" type="email" autocomplete="username" maxlength="254" required></label><label class="field">비밀번호<input name="password" type="password" autocomplete="${register?'new-password':'current-password'}" minlength="${register?12:1}" maxlength="128" required>${register?'<small>12자 이상으로 설정해 주세요.</small>':''}</label>${register?'<label class="field">팀 초대 코드<input name="invite_code" type="password" autocomplete="off" required></label>':''}<p class="form-error" id="auth-error" role="alert"></p><div class="actions"><button class="btn">${register?'가입하기':'로그인'}</button><button type="button" class="ghost" id="switch-auth">${register?'기존 계정으로 로그인':'초대 코드로 가입'}</button></div></fieldset></form></article>`);
  on('switch-auth',()=>auth(!register));
  $('auth-form').onsubmit=e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));task(async()=>{try{const data=await request('/api/auth/'+(register?'register':'login'),'POST',body);user=data.user;await loadAccount();}catch(error){if($('auth-error'))$('auth-error').textContent=error.message;else throw error;}});};
}
async function loadAccount(){
  [capabilities,consents]=await Promise.all([v2('/capabilities'),v2('/consents')]);
  if(!consents.purposes.service_processing||!consents.purposes.sensitive_processing){consentPage();return;}
  const match=/^#conversation=([a-f0-9-]{36})$/i.exec(location.hash);
  if(match)await openConversation(match[1]);else await records();
}
function consentMarkup(edit=false){
  const names={service_processing:['필수 · 서비스 이용을 위한 정보 처리','입력하신 이야기를 질문과 대화 제안을 만드는 데 사용합니다.'],sensitive_processing:['필수 · 민감정보 처리','건강과 감정 등 민감한 이야기가 포함될 수 있습니다.'],history_storage:['선택 · 대화 기록 보관','보관하면 같은 프로젝트를 다시 열 수 있습니다. 미동의 시 임시 기록은 24시간 후 만료됩니다. 보관 동의 기록은 기본 90일 뒤 만료됩니다.'],cross_session_memory:['선택 · 다음 대화에서 기억 사용','기록 보관에 동의한 경우, 직접 확인한 기억을 다음 대화에 활용합니다.']};
  return `<form id="consent-form"><fieldset class="form-body">${Object.entries(names).map(([name,[title,desc]])=>`<label class="check-label"><input type="checkbox" name="${name}" ${edit&&consents?.purposes[name]?'checked':''}><span>${title}<small>${desc}</small></span></label>`).join('')}<p class="form-error" id="consent-error" role="alert"></p><button class="btn">${edit?'동의 설정 저장':'동의하고 계속'}</button></fieldset></form>`;
}
function bindConsents(edit=false){
  const form=$('consent-form'),history=form.elements.history_storage,memory=form.elements.cross_session_memory;
  const update=()=>{memory.disabled=!history.checked;if(!history.checked)memory.checked=false;};history.onchange=update;update();
  form.onsubmit=e=>{e.preventDefault();task(async()=>{
    const purposes=Object.fromEntries(['service_processing','sensitive_processing','history_storage','cross_session_memory'].map(k=>[k,form.elements[k].checked]));
    if(!edit&&(!purposes.service_processing||!purposes.sensitive_processing)){$('consent-error').textContent='두 필수 항목에 동의하셔야 시작할 수 있습니다.';return;}
    const destructive=edit&&['service_processing','sensitive_processing','history_storage'].some(k=>consents.purposes[k]&&!purposes[k]);
    if(destructive&&!confirm('선택한 동의를 철회하면 기존 프로젝트와 관련 기록이 삭제됩니다. 계속하시겠습니까?'))return;
    await mutate('/consents',{version:consents.version,purposes},async()=>{consents=await v2('/consents');current=null;location.hash='';if(purposes.service_processing&&purposes.sensitive_processing)await records();else consentPage();});
  });};
}
function consentPage(){page(`<article class="card narrow"><h1>이야기 전에 확인해 주세요</h1><p>어떤 정보를 저장하고 활용할지는 직접 선택하실 수 있어요. 선택 동의 없이도 질문에 답하실 수 있습니다.</p>${consentMarkup()}</article>`);bindConsents();}
async function records(){
  if(!consents?.purposes.service_processing||!consents?.purposes.sensitive_processing){consentPage();return;}
  const projects=await allPages('/projects','projects');current=null;project=null;location.hash='';
  page(`<div class="page-head"><div><p class="eyebrow">천천히 이어 가는 이야기</p><h1>내 기록</h1></div><button class="btn" id="new-project">새 이야기 시작</button></div><div class="wrapk"><div class="rlist">${projects.map(p=>`<article class="rcard"><div class="record-icon">${face('basic')}</div><div><span class="pill">${p.temporary?'24시간 임시 보관':'기록 보관'}</span><h2>${esc(p.alias||p.title)}</h2><small>${esc(p.title)} · 보관 기한 ${date(p.expires_at)}</small><div class="actions"><button class="ghost project-open" data-id="${p.id}">이야기 열기</button><button class="ghost danger-button project-delete" data-id="${p.id}">삭제</button></div></div></article>`).join('')}</div><div class="rdetail">${face(projects.length?'ponder':'hello')}<h2>${projects.length?'다시 이어 볼 이야기를 골라 주세요':'첫 이야기를 함께 시작해 볼까요?'}</h2><p>${projects.length?'왼쪽 기록에서 이야기를 열면 서버에 저장된 질문과 답변을 다시 확인할 수 있어요.':'소중한 사람을 떠올려 주세요. 질문과 답변은 이 브라우저가 아닌 서버에 임시 저장됩니다.'}</p><p class="note">시연 기록은 24시간 뒤 접속이 만료되며 언제든 직접 삭제할 수 있습니다.</p></div></div>`,'records');
  on('new-project',newProject);
  root.querySelectorAll('.project-open').forEach(b=>b.onclick=()=>task(()=>openProject(b.dataset.id)));
  root.querySelectorAll('.project-delete').forEach(b=>b.onclick=()=>task(async()=>{const p=await v2('/projects/'+b.dataset.id);if(!confirm(`“${p.alias}”의 프로젝트와 대화·기억을 삭제하시겠습니까?`))return;await mutate('/projects/'+p.id,{expected_revision:p.revision},async()=>{await records();notice('프로젝트의 온라인 기록이 삭제되었습니다. 백업 만료 상태는 삭제 요청으로 관리됩니다.');},'DELETE');}));
}
function newProject(existingId=null){
  if(!consents?.purposes.service_processing||!consents?.purposes.sensitive_processing){consentPage();return;}
  page(`<article class="card narrow"><p class="eyebrow">지금 필요한 것부터</p><h1>${existingId?'새 대화의 목표':'오늘은 어떤 도움이 필요하세요?'}</h1><form id="new-form"><fieldset class="form-body">${existingId?'':'<label class="field">이야기 제목<input name="title" maxlength="80" value="새 이야기" required></label>'}<div class="goal-choices">${Object.entries(GOALS).map(([goal,label],i)=>`<label class="choice"><input type="radio" name="goal" value="${goal}" ${i===0?'checked':''}><span>${label}</span></label>`).join('')}</div><p class="note">모르는 질문은 넘어가셔도 괜찮아요.</p><button class="btn">이야기 시작</button></fieldset></form></article>`);
  $('new-form').onsubmit=e=>{e.preventDefault();const data=new FormData(e.target),goal=data.get('goal');task(async()=>{
    const createConversation=async(id)=>mutate('/projects/'+id+'/conversations',{goal},async r=>openConversation(r.conversation_id));
    if(existingId)await createConversation(existingId);else await mutate('/projects',{title:data.get('title')},async p=>createConversation(p.project_id));
  });};
}
async function openProject(id){
  const [p,conversations]=await Promise.all([v2('/projects/'+id),allPages('/projects/'+id+'/conversations','conversations')]);project=p;current=null;location.hash='';
  conversations.sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
  page(`<div class="page-head"><div><p class="eyebrow">${esc(p.title)}</p><h1>${esc(p.alias)}의 이야기</h1></div><button class="btn" id="new-conversation">새 대화</button></div><article class="card">${conversations.length?conversations.map(c=>`<div class="conversation-row"><div><span class="pill">${esc(STATES[c.state])}</span><p>${esc(GOALS[c.goal])}<br><small class="muted">${date(c.created_at)}</small></p></div><button class="ghost conversation-open" data-id="${c.conversation_id}">대화 열기</button></div>`).join(''):'<p>아직 대화가 없어요. 새 대화를 시작해 주세요.</p>'}</article>`);
  on('new-conversation',()=>newProject(id));root.querySelectorAll('.conversation-open').forEach(b=>b.onclick=()=>task(()=>openConversation(b.dataset.id)));
}
async function openConversation(id){
  const snapshot=await v2('/conversations/'+id);const p=await v2('/projects/'+snapshot.project_id);
  const visibleMessages=capabilities?.dual_turn_enabled?await allPages('/conversations/'+id+'/messages','messages'):[];
  const pendingAlerts=capabilities?.dual_turn_enabled?(await v2('/conversations/'+id+'/alerts')).alerts:[];
  current=snapshot;project=p;location.hash='conversation='+id;renderConversation(visibleMessages);
  if(pendingAlerts.length)queueAlerts(id,visibleMessages,pendingAlerts,viewId);
}
const alertText=reason=>{
  const [cue,kind]=reason.replace(/_(absolute|increase)$/,'|$1').split('|');
  if(reason==='assessment_unavailable')return '이번 대화의 표현 평가를 완료하지 못했습니다. 답변을 안전하다는 판단으로 받아들이지 마세요.';
  const label={sadness:'슬픔',anxiety:'불안',agitation:'초조',self_harm_cue:'자해 관련',harm_to_others_cue:'타인 위해 관련',acute_danger_cue:'급박한 위험 관련'}[cue]||'상태';
  return `${label} 표현${kind==='increase'?'의 변화':'이'} 관찰되었습니다. 서비스 평가값이며 진단이나 실제 위험 확률이 아닙니다.`;
};
async function queueAlerts(conversationId,items,alerts,generation){
  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  if(viewId!==generation||current?.conversation_id!==conversationId)return;
  const responses=new Map(items.filter(message=>message.kind==='dual_reply').map(message=>[message.id,message]));
  for(const alert of alerts){
    const response=responses.get(alert.response_id);
    const bubble=root.querySelector(`[data-response-id="${alert.response_id}"]`);
    if(!response||response.turn_id!==alert.turn_id||!bubble||bubble.querySelector(`[data-alert-id="${alert.id}"]`))continue;
    const message=document.createElement('p');message.className='score-alert';message.dataset.alertId=alert.id;if(!alert.shown_at)message.role='status';message.textContent=alertText(alert.reason_code);bubble.append(message);
    if(!alert.shown_at)try{await request('/api/v2/alerts/'+alert.id+'/shown','POST',{response_id:alert.response_id});}catch{/* Still pending on the server for reconnect. */}
  }
}
async function refreshConversation(){if(current)await openConversation(current.conversation_id);}
async function turn(action,payload){
  const id=current.conversation_id;
  await mutate('/conversations/'+id+'/turns',{expected_revision:current.resource_revision,action,payload},async r=>{await openConversation(id);if(r.model_unavailable&&action==='message')notice('이야기는 저장했습니다. 현재 모델 응답은 사용할 수 없습니다.');});
}
function renderConversation(messageItems=[]){
  const c=current,held=c.state==='SAFETY_HOLD',ended=terminal(),running=Boolean(c.run_id),history=c.question_history||[];
  const qFor=id=>history.findLast(q=>q.question_id===id);
  const answered=c.coverage.answered+c.coverage.unknown+c.coverage.skipped+c.coverage.not_applicable;
  const historyMarkup=c.answers.map(a=>`<div class="history-item"><p class="question-text">${esc(qFor(a.question_id)?.text||a.question_id)}</p><p>${esc(answerText(a,qFor(a.question_id)))}</p>${!held&&!ended&&!running&&a.disposition!=='not_applicable'?`<button class="ghost correct-answer" data-id="${a.id}">답변 정정</button>`:''}${a.message_id?`<button class="ghost delete-answer" data-id="${a.message_id}">원문 삭제</button>`:''}</div>`).join('');
  page(`<div class="chat-layout"><aside class="sidebar">${face('listen')}<h2>${esc(project.alias)}의 이야기</h2><span class="pill">${esc(STATES[c.state])}</span><p class="note">${esc(GOALS[c.goal])}</p><progress value="${answered}" max="${c.coverage.total}" aria-label="정보 확인 진행"></progress><p class="note">${answered} / ${c.coverage.total}개 항목 확인<br>필요한 만큼만 이야기해 주세요.</p><button class="ghost" id="refresh">새로 불러오기</button><button class="ghost" id="memories">기억 확인하기</button><button class="ghost" id="project-list">이 프로젝트의 대화</button>${!held&&!ended&&!running?'<button class="ghost" id="choose-topic">다른 질문 고르기</button>':''}${!ended?'<button class="ghost" id="finish">대화 마무리</button>':''}</aside><div class="chat-main">
  ${held?`<article class="card safety-panel"><h2>먼저 지금의 안전을 확인해 주세요</h2><p>위험을 시사하는 이야기가 있어 일반 질문과 가이드를 잠시 멈췄어요. 급박한 상황이면 가까운 사람에게 알리고, 현재 계신 지역의 긴급 지원을 이용해 주세요.</p><button class="ghost" id="safety-detail">안전 도움 보기</button><form id="safety-form"><label class="field">누구의 상황인지, 지금은 어떤지 알려 주세요<textarea name="text" required maxlength="4000" rows="3"></textarea></label><label class="check-label"><input type="checkbox" name="resume"><span>현재 즉각적인 위험이 없음을 확인했고 일반 대화를 다시 시작하고 싶어요.<small>위 내용에도 현재 상황을 직접 적어 주세요.</small></span></label><button class="btn">안전 상황 전달</button></form></article>`:''}
  ${running?'<article class="card run-panel" role="status"><span class="run-dot"></span><b id="run-status">이야기를 정리하고 있어요.</b><p>입력은 저장되었습니다. 완료되면 이 화면에서 알려드릴게요.</p><button class="ghost" id="cancel-run">응답 생성 취소</button></article>':''}
  ${messageItems.some(message=>message.kind==='dual_reply')?`<section class="card chat-transcript" aria-label="말씨 대화"><h3>말씨와 나눈 이야기</h3>${messageItems.filter(message=>message.kind==='message'||message.kind==='dual_reply'||message.kind==='answer'&&message.content?.trim()).map(message=>`<article class="chat-bubble ${message.role==='assistant'?'from-assistant':'from-user'}" ${message.kind==='dual_reply'?`data-response-id="${esc(message.id)}"`:''}><b>${message.role==='assistant'?'말씨':'나'}</b><p>${esc(message.content||'')}</p></article>`).join('')}</section>`:''}
  ${!held&&!running&&!ended&&c.question?`<article class="card"><div class="question-head">${face('ponder')}<div><p class="question-meta">천천히 답해 주세요</p><h2>${esc(c.question.text)}</h2></div></div>${questionMarkup(c.question)}</article>`:''}
  ${!held&&c.latest_guidance?guidanceCards(c.latest_guidance,c.state==='GUIDANCE'&&!running):''}
  ${!held&&!running&&!ended?`<article class="card"><h3>어떻게 이어갈까요?</h3>${!capabilities.model_execution_enabled?`<p class="note">현재는 질문과 기록을 이용할 수 있습니다. 맞춤 가이드는 모델 서버 연결 후 제공됩니다.</p>${user?.is_demo?'<button class="ghost" id="sample-guide">가이드 화면 예시 보기</button><p class="note">고정된 가상 예시이며 입력한 답변을 분석하지 않습니다.</p>':''}`:`<p class="note">${c.offer_guidance?'지금까지의 이야기로 대화 제안을 받아보실 수 있어요.':'정보가 적으면 확인된 내용 안에서만 제한적인 제안을 드려요.'}</p><button class="btn" id="generate">말하는 방법 정리하기</button>`}${!c.question?'<button class="ghost" id="ask-more">이야기 더 나누기</button>':''}<details><summary>자유롭게 이야기 추가하기</summary><form id="message-form"><label class="field">덧붙일 이야기<textarea name="text" required maxlength="8000" rows="3"></textarea></label><button class="ghost">이야기 보내기</button></form></details></article>`:''}
  ${!held&&c.plans?.length?`<article class="card"><h3>내가 선택한 작은 행동</h3>${c.plans.map(p=>`<div class="history-item"><p>${esc(p.chosen_action.title)}</p><span class="pill">${esc({selected:'선택함',tried:'해 봄',paused:'잠시 멈춤',completed:'완료',discarded:'취소'}[p.status]||p.status)}</span>${!ended?`<button class="ghost plan-feedback" data-id="${p.id}">해 본 이야기 남기기</button>`:''}</div>`).join('')}</article>`:''}
  ${ended?'<article class="card"><h2>이번 이야기를 마무리했어요</h2><p>같은 프로젝트에서 새 대화를 시작하실 수 있어요.</p><button class="btn" id="continue-new">새 대화 시작</button></article>':''}
  <article class="card"><details ${c.answers.length?'open':''}><summary>지금까지 들려주신 이야기 (${c.answers.length})</summary><div class="history">${historyMarkup||'<p class="note">답변을 보내면 여기에 기록됩니다.</p>'}</div></details><button class="ghost" id="all-messages">추가 대화 기록 보기</button></article>
  </div></div>`);
  on('refresh',refreshConversation);on('project-list',()=>openProject(project.id));on('memories',memories);on('safety-detail',help);on('continue-new',()=>newProject(project.id));
  on('finish',()=>turn('finish',{}));on('generate',()=>turn('request_guidance',{guidance_kind:'communication_guidance'}));on('sample-guide',sampleGuide);on('ask-more',()=>turn('select_topic',{topic_id:'B'}));on('choose-topic',chooseTopic);
  on('cancel-run',()=>mutate('/runs/'+c.run_id+'/cancel',{},refreshConversation));on('all-messages',messages);
  if($('answer-form'))bindQuestion($('answer-form'),c.question,(disposition,value)=>task(()=>turn('answer',{question_instance_id:c.question.id,question_id:c.question.question_id,question_version:c.question.question_version,disposition,value})));
  if($('message-form'))$('message-form').onsubmit=e=>{e.preventDefault();const text=new FormData(e.target).get('text');task(()=>turn('message',{text}));};
  if($('safety-form'))$('safety-form').onsubmit=e=>{e.preventDefault();const data=new FormData(e.target);task(()=>turn(data.has('resume')?'resume_after_safety':'safety_update',{safety_episode_id:c.safety_episode_id,text:data.get('text'),...(data.has('resume')?{acknowledgement:'no_current_immediate_danger'}:{})}));};
  root.querySelectorAll('.correct-answer').forEach(b=>b.onclick=()=>{const a=c.answers.find(a=>a.id===b.dataset.id),q=qFor(a.question_id);dialog('답변 정정',questionMarkup(q),d=>bindQuestion(d.querySelector('form'),q,(disposition,value)=>task(()=>turn('correct_answer',{answer_revision_id:a.id,replacement:{disposition,value}}).then(()=>$('dialog').close()))));});
  root.querySelectorAll('.delete-answer').forEach(b=>b.onclick=()=>task(()=>deleteMessage(b.dataset.id)));
  root.querySelectorAll('.choose-plan').forEach(b=>b.onclick=()=>task(()=>mutate('/conversations/'+c.conversation_id+'/plans',{guidance_id:c.latest_guidance.id,action_index:Number(b.dataset.index)},refreshConversation)));
  root.querySelectorAll('.plan-feedback').forEach(b=>b.onclick=()=>feedback(c.plans.find(p=>p.id===b.dataset.id)));
  if(running)poll(c.conversation_id,c.run_id,viewId);
}
function poll(conversation,run,generation){
  pollTimer=setTimeout(async()=>{
    if(viewId!==generation||!user)return;
    if(busy||pending){poll(conversation,run,generation);return;}
    try{const result=await v2('/runs/'+run);if(viewId!==generation)return;
      if(['ACCEPTED','RUNNING'].includes(result.status)){$('run-status').textContent=result.deadline_at&&Date.parse(result.deadline_at)<Date.now()?'응답 기한이 지났습니다. 생성을 취소하고 운영자에게 연결 상태를 확인해 주세요.':result.status==='ACCEPTED'?'순서를 기다리고 있어요.':'말과 행동을 정리하고 있어요.';poll(conversation,run,generation);}
      else{await openConversation(conversation);if(result.status==='FAILED'){
        if(capabilities?.dual_turn_enabled&&result.error?.retryable)notice('응답을 완료하지 못했습니다. 입력과 평가 기록은 저장되어 있습니다. 같은 턴의 응답만 다시 생성할 수 있습니다.',()=>task(()=>mutate('/runs/'+run+'/retry',{},refreshConversation)));
        else handleError({code:result.error?.code,message:'응답을 완료하지 못했습니다. 입력은 저장되어 있습니다.'});
      }}
    }catch(error){if(viewId!==generation)return;if(error.status===401){handleError(error);return;}if($('run-status'))$('run-status').textContent='연결을 다시 확인하고 있어요. 입력은 저장되어 있습니다.';poll(conversation,run,generation);}
  },2000);
}
async function chooseTopic(){
  const {catalog}=await v2('/questionnaires/'+encodeURIComponent(current.questionnaire_version));
  const answered=new Set(current.answers.map(a=>a.question_id));
  dialog('이야기할 질문 선택',`<div class="goal-choices">${catalog.questions.filter(q=>!answered.has(q.id)).map(q=>`<button class="ghost select-question" data-id="${q.id}">${esc(q.neutral_text)}</button>`).join('')||'<p>모든 질문을 확인하셨어요. 기존 답변을 정정하거나 자유롭게 이야기를 추가하실 수 있습니다.</p>'}</div>`,d=>d.querySelectorAll('.select-question').forEach(b=>b.onclick=()=>task(async()=>{await turn('select_question',{question_id:b.dataset.id});d.close();})));
}
async function messages(){
  const items=await allPages('/conversations/'+current.conversation_id+'/messages','messages');
  dialog('대화 기록',items.filter(m=>m.kind!=='answer').map(m=>`<article class="history-item"><b>${m.role==='assistant'?'말씨':'나'}</b><p>${esc(m.content||'')}</p><button class="ghost message-delete" data-id="${m.id}">이 원문 삭제</button></article>`).join('')||'<p>추가 대화 기록이 없습니다.</p>',d=>d.querySelectorAll('.message-delete').forEach(b=>b.onclick=()=>task(async()=>{await deleteMessage(b.dataset.id);d.close();})));
}
async function deleteMessage(id){
  if(!confirm('이 원문과 여기서 파생된 기억·가이드를 삭제하시겠습니까?'))return;
  const items=await allPages('/conversations/'+current.conversation_id+'/messages','messages'),message=items.find(m=>m.id===id);
  if(!message){await refreshConversation();return;}
  await mutate('/messages/'+id,{expected_revision:message.revision,scope:'delete_source'},refreshConversation,'DELETE');
}
async function memories(){
  const [{memories:items},{catalog}]=await Promise.all([v2('/projects/'+project.id+'/memories'),v2('/questionnaires/'+encodeURIComponent(current.questionnaire_version))]);
  const visible=items.filter(m=>!['superseded','revoked'].includes(m.status));
  dialog('기억을 직접 확인해 주세요',`<p class="note">확인되지 않은 기억은 사실로 확정하지 않습니다. “잊기”를 선택하면 파생 가이드도 제거됩니다.</p>${visible.map(m=>{const q=catalog.questions.find(q=>(q.slot||'relationship')===m.field_path&&q.entity===m.entity);return `<article class="memory-row"><span class="pill">${esc({subject:'그분',supporter:'나',relationship:'우리 관계'}[m.entity])} · ${esc({candidate:'확인 전',validated:'선택으로 확인',active:'기억 중',stale:'재확인 필요'}[m.status]||m.status)}</span><p>${esc(typeof m.value==='string'?m.value:answerText({disposition:'answered',value:m.value},q))}</p><div class="actions">${consents.purposes.cross_session_memory?`<button class="ghost memory-confirm" data-id="${m.id}">이 기억 확인</button>`:''}<button class="ghost memory-correct" data-id="${m.id}">정정</button><button class="ghost danger-button memory-forget" data-id="${m.id}">잊기</button></div></article>`;}).join('')||'<p>아직 저장된 기억이 없습니다.</p>'}`,d=>{
    const bind=(cls,action)=>d.querySelectorAll('.'+cls).forEach(b=>b.onclick=()=>task(()=>action(items.find(m=>m.id===b.dataset.id))));
    bind('memory-confirm',m=>mutate('/memories/'+m.id+'/confirm',{expected_revision:m.revision},async()=>{d.close();await refreshConversation();notice('선택한 기억을 확인했습니다.');}));
    bind('memory-forget',async m=>{if(!confirm('이 기억과 파생 내용을 잊으시겠습니까?'))return;await mutate('/memories/'+m.id,{expected_revision:m.revision,scope:'forget_memory'},async()=>{d.close();await refreshConversation();},'DELETE');});
    bind('memory-correct',m=>{dialog('기억 정정','<form id="memory-edit"><label class="field">바로잡을 내용<textarea name="text" required maxlength="2000"></textarea></label><button class="btn">정정 내용 저장</button></form>',()=>{$('memory-edit').onsubmit=e=>{e.preventDefault();const value=new FormData(e.target).get('text');task(()=>mutate('/memories/'+m.id,{expected_revision:m.revision,corrected_value:value},async()=>{$('dialog').close();await refreshConversation();},'PATCH'));};});});
  });
}
function feedback(plan){
  dialog('해 보니 어떠셨나요?',`<form id="feedback-form"><label class="field">진행 상태<select name="status"><option value="tried">해 봤어요</option><option value="paused">잠시 멈췄어요</option><option value="completed">마쳤어요</option><option value="discarded">하지 않기로 했어요</option></select></label><label class="field">도움이 되었나요?<select name="reported_outcome"><option value="unknown">잘 모르겠어요</option><option value="helpful">도움이 되었어요</option><option value="unhelpful">도움이 되지 않았어요</option><option value="mixed">좋은 점과 어려운 점이 있었어요</option><option value="not_tried">아직 해 보지 않았어요</option></select></label><label class="field">나의 부담은<select name="burden_change"><option value="unknown">잘 모르겠어요</option><option value="decreased">줄었어요</option><option value="same">비슷해요</option><option value="increased">늘었어요</option></select></label><label class="field">덧붙일 이야기<textarea name="notes" maxlength="2000"></textarea></label><button class="btn">경험 저장</button></form>`,()=>{$('feedback-form').onsubmit=e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));if(!body.notes)delete body.notes;task(()=>mutate('/plans/'+plan.id+'/feedback',{expected_revision:plan.revision,...body},async()=>{$('dialog').close();await refreshConversation();}));};});
}
async function settings(){
  if(user?.is_demo){page(`<article class="card narrow"><h1>시연 기록 관리</h1><p>접속은 시작 후 24시간에 만료되고 계정과 기록은 다음 정리 주기에 삭제됩니다.</p><button class="ghost danger-button" id="delete-demo">지금 시연 기록 삭제</button></article>`);on('delete-demo',async()=>{if(!confirm('시연 계정과 기록을 지금 삭제하시겠습니까?'))return;await request('/api/auth/demo','DELETE',{});clearPrivate();home();notice('시연 계정과 온라인 기록을 삭제했습니다.');});return;}
  consents=await v2('/consents');page(`<article class="card narrow"><h1>내 설정</h1><p>${esc(user.email)}</p><h2>동의와 기록 관리</h2><p class="note">필수 처리 또는 기록 보관 동의를 철회하면 기존 프로젝트가 삭제됩니다. 장기 기억만 철회하면 관련 기억의 사용이 중단됩니다.</p>${consentMarkup(true)}<hr><h2>계정 관리</h2><button class="ghost" id="change-password">비밀번호 변경</button><button class="ghost danger-button" id="delete-account">계정과 모든 기록 삭제</button></article>`);bindConsents(true);
  on('change-password',()=>dialog('비밀번호 변경','<form id="password-form"><label class="field">현재 비밀번호<input type="password" name="current_password" autocomplete="current-password" required></label><label class="field">새 비밀번호<input type="password" name="new_password" autocomplete="new-password" minlength="12" maxlength="128" required></label><button class="btn">변경하기</button></form>',()=>{$('password-form').onsubmit=e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));task(async()=>{await request('/api/auth/password','POST',body);$('dialog').close();notice('비밀번호를 변경했습니다. 다른 접속은 종료됩니다.');});};}));
  on('delete-account',()=>dialog('계정과 모든 기록 삭제','<p>계정·프로젝트·대화·기억이 삭제되고 로그인도 종료됩니다. 백업은 별도 보관 기한에 따라 만료됩니다.</p><form id="delete-account-form"><label class="field">현재 비밀번호<input type="password" name="password" autocomplete="current-password" required></label><label class="check-label"><input type="checkbox" required><span>되돌릴 수 없는 삭제임을 확인했습니다.</span></label><button class="btn">모든 기록 삭제</button></form>',()=>{$('delete-account-form').onsubmit=e=>{e.preventDefault();const password=new FormData(e.target).get('password');task(()=>mutate('/account',{current_password:password},async()=>{clearPrivate();home();notice('계정과 온라인 기록을 삭제했습니다.');},'DELETE'));};}));
}
async function help(){
  let text='지금 즉각적인 위험이 있다면 혼자 대응하지 말고 주변의 믿을 수 있는 사람과 현재 계신 지역의 긴급 지원에 도움을 요청해 주세요.';
  try{text=(await request('/help/safety')).text;}catch{/* This help remains available even if the API is unavailable. */}
  dialog('지금 안전이 먼저라면',`<article class="safety-panel card"><p>${esc(text)}</p></article><p class="note">위험을 시사하는 이야기가 있으면 말씨의 일반 질문은 멈춥니다. 지역별 연락처는 현재 제공되지 않으므로 현지 공식 긴급 지원을 이용해 주세요.</p>`);
}
window.addEventListener('beforeunload',event=>{if(pending){event.preventDefault();event.returnValue='';}});
window.addEventListener('pagehide',stopPoll);
async function boot(){
  try{demoEnabled=(await request('/api/auth/demo')).enabled;user=(await request('/api/auth/me')).user;await loadAccount();}
  catch(error){if(error.status===401){clearPrivate();home();}else{home();handleError(error);}}
}
await boot();
