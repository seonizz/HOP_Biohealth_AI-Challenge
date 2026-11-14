const TestRunner = {
  csrf:'', questions:[], cases:[], selected:0, active:null,
  async request(path, { method='GET', body, signal } = {}) {
    let response, data;
    try {
      response = await fetch(path, { method, signal, credentials:'same-origin',
        headers:{ Accept:'application/json', ...(method === 'GET' ? {} : { 'Content-Type':'application/json', 'X-CSRF-Token':this.csrf }) },
        ...(body === undefined ? {} : { body:JSON.stringify(body) }) });
      data = await response.json();
    } catch {
      if (signal?.aborted) throw new Error('테스트를 중단했어요.');
      throw new Error('서버에 연결하지 못했어요. 연결 상태를 확인하고 다시 시도해 주세요.');
    }
    if (!response.ok) throw Object.assign(new Error(data.error?.message || '요청을 처리하지 못했어요.'), { status:response.status });
    return data;
  },
  error(message='') { $('test-error').textContent=message; $('test-error').hidden=!message; },
  busy(value) {
    for (const id of ['test-input','test-file','test-example','test-run']) $(id).disabled=value;
    $('test-stop').hidden=!value;
  },
  updateSelector() {
    const labels={ waiting:'대기', running:'생성 중', complete:'완료', failed:'오류', cancelled:'중단' };
    $('test-case').innerHTML=this.cases.map((item,index)=>`<option value="${index}">${esc(item.title)} · ${labels[item.status]}</option>`).join('');
    $('test-case').value=String(this.selected);
    $('test-case').hidden=$('test-case-label').hidden=this.cases.length<2;
    $('test-download').disabled=!this.cases.some(item=>item.result);
  },
  display(index) {
    this.selected=index; this.updateSelector();
    const item=this.cases[index];
    if (!item) return;
    $('test-empty').hidden=true;
    if (item.result) {
      const result=item.result;
      ResultScreen.open(result.profile, result.guide, false, result.relationship_analysis, result.conversation_detail);
      const actions=$('rbody').querySelector('.actions');
      actions.textContent='';
      const note=document.createElement('span');note.className='note';
      note.textContent=`${item.title} · 테스트 결과예요. 내 기록에 저장하지 않았어요.`;
      actions.appendChild(note);
    } else if (item.status==='running') {
      const name=item.answers.find(answer=>answer.question_id==='name')?.text;
      ResultScreen.prepare({ name:name || item.title });
      if (item.progress) { ResultScreen.progress(item.progress.progress); ResultScreen.partial(item.progress.cards); }
    } else {
      show('result');
      $('rbody').innerHTML=`<div class="card"><h3>${esc(item.title)}</h3><p>${esc(item.error || (item.status==='cancelled'?'테스트를 중단했어요. 입력을 확인하고 다시 실행할 수 있어요.':'이 사례의 순서를 기다리고 있어요.'))}</p></div>`;
    }
    document.title='최종 출력 테스트 · 말씨';
  },
  async poll(run, index) {
    while (this.active===run && !run.controller.signal.aborted) {
      try {
        const progress=await this.request(`/api/test-runs/${run.id}/progress`, { signal:run.controller.signal });
        if (this.active!==run) return;
        this.cases[index].progress=progress;
        if (this.selected===index) { ResultScreen.progress(progress.progress); ResultScreen.partial(progress.cards); }
      } catch { /* The POST carries errors; a poll may race request start or completion. */ }
      if (this.active!==run || run.controller.signal.aborted) return;
      await new Promise(resolve=>{run.wake=resolve;run.timer=setTimeout(resolve,1200);});
      run.wake=null;
    }
  },
  async start() {
    if (this.running) return;
    this.error();
    let cases;
    try { cases=TestInput.parse($('test-input').value, this.questions); }
    catch (error) { this.error(error.message); return; }
    this.running=true;this.stopped=false;this.busy(true);
    this.cases=cases.map(item=>({...item,status:'waiting'}));
    try {
      for (let index=0;index<this.cases.length&&!this.stopped;index++) {
        const item=this.cases[index];item.status='running';
        const run={ id:crypto.randomUUID(), controller:new AbortController() };
        this.active=run;this.display(index);
        $('test-status').textContent=`${index+1} / ${this.cases.length} 사례를 생성하고 있어요.`;
        const polling=this.poll(run,index);
        try {
          const result=await this.request(`/api/test-runs/${run.id}`, { method:'POST', body:{answers:item.answers}, signal:run.controller.signal });
          if (this.stopped || run.controller.signal.aborted) item.status='cancelled';
          else { item.result=result;item.status='complete'; }
        } catch (error) {
          item.status=this.stopped||run.controller.signal.aborted?'cancelled':'failed';
          if (item.status==='failed') item.error=error.message || '연결을 확인하고 다시 시도해 주세요.';
          if ([401,403].includes(error.status)) this.stopped=true;
        } finally {
          this.active=null;run.controller.abort();clearTimeout(run.timer);run.wake?.();await polling;
          delete item.progress;
        }
        this.display(this.selected);
      }
      for (const item of this.cases) if (item.status==='waiting') item.status='cancelled';
      this.updateSelector();
      const completed=this.cases.filter(item=>item.result).length;
      const failed=this.cases.filter(item=>item.status==='failed').length;
      $('test-status').textContent=`${completed}개 완료${failed?` · ${failed}개 오류`:''}${this.stopped?' · 실행 중단':''}.`;
    } finally { this.running=false;this.busy(false); }
  },
  stop() {
    this.stopped=true;
    const run=this.active;if (!run) return;
    run.controller.abort();clearTimeout(run.timer);run.wake?.();
    this.request(`/api/test-runs/${run.id}`,{method:'DELETE'}).catch(()=>{});
    $('test-status').textContent='테스트를 중단하고 있어요.';
  },
  download() {
    const data={ cases:this.cases.map(({title,answers,status,result,error})=>({title,answers,status,...(result?{result}:{}),...(error?{error}:{})})) };
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='malssi-test-results.json';link.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  },
  async init() {
    // Keep the service renderer and its progress widgets intact. Unused screens
    // only supply the IDs expected by the shared screen-switching utility.
    $('app').innerHTML=['start','records','about','columns'].map(id=>`<div id="${id}" hidden></div>`).join('')+ChatScreen.render()+ResultScreen.render();
    $('test-run').onclick=()=>this.start();
    $('test-stop').onclick=()=>this.stop();
    $('test-example').onclick=()=>{this.error();$('test-input').value=TestInput.example(this.questions);};
    $('test-case').onchange=()=>this.display(Number($('test-case').value));
    $('test-download').onclick=()=>this.download();
    $('test-file').onchange=async event=>{
      const file=event.target.files[0];if (!file) return;
      try {
        if (file.size>TestInput.maxBytes) throw new Error('테스트 파일은 256 KiB 이내로 넣어 주세요.');
        const text=await file.text();TestInput.parse(text,this.questions);
        if (!this.running) { $('test-input').value=text;this.error(); }
      } catch (error) { this.error(error.message); }
      event.target.value='';
    };
    window.addEventListener('pagehide',()=>this.active?.controller.abort());
    try {
      const data=await this.request('/api/bootstrap');
      this.csrf=data.csrf_token;this.questions=data.questions;
      $('test-questions').innerHTML=this.questions.map(q=>`<section><h3><code>${esc(q.id)}</code> · ${esc(q.q)}</h3>${q.opts?`<p>${q.opts.map((option,index)=>`${index}. ${esc(Array.isArray(option)?option[0]:option)}`).join('<br>')}</p>`:'<p>글로 답하기</p>'}</section>`).join('');
      $('test-input').placeholder=TestInput.example(this.questions);
      this.busy(false);$('test-status').textContent='붙여넣기 또는 파일 불러오기로 시작하세요.';
      if (!data.model_connected) this.error('모델 연결 설정이 필요해요. 서버 설정을 확인한 뒤 다시 열어 주세요.');
    } catch (error) { this.error(`${error.message} 새로고침해서 다시 시도해 주세요.`);$('test-status').textContent='문항을 불러오지 못했어요.'; }
  },
};
TestRunner.init();
