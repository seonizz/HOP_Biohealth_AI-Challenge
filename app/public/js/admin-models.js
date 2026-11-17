export async function mountModelAdmin({document,fetchImpl=fetch}) {
  const form=document.getElementById('modelForm');
  const picker=document.getElementById('modelProfile');
  const save=document.getElementById('saveModel');
  const current=document.getElementById('currentModel');
  const status=document.getElementById('modelStatus');
  const apiForm=document.getElementById('apiForm');
  const apiStatus=document.getElementById('apiStatus');
  const apiSave=document.getElementById('saveApi');
  const connectionPicker=document.getElementById('connectionProfile');
  const connectionState=document.getElementById('connectionState');
  const executionForm=document.getElementById('executionForm');
  const executionPicker=document.getElementById('executionProfile');
  const executionSave=document.getElementById('saveExecution');
  const executionStatus=document.getElementById('executionStatus');
  const executionState=document.getElementById('executionState');
  const executionFields=Object.fromEntries([
    ['question_mode','questionMode'],['scheduling','questionScheduling'],
    ['question_source','questionSource'],['review_source','reviewSource'],
  ].map(([key,id])=>[key,document.getElementById(id)]));
  const roleFields=Object.fromEntries(['question','review'].map(role=>[role,{
    container:document.getElementById(role+'ConnectionFields'),keyState:document.getElementById(role+'KeyState'),
    fields:Object.fromEntries(['base_url','model','api_key'].map((key,index)=>[key,
      document.getElementById(role+['BaseUrl','Model','Key'][index])])),
  }]));
  const ids=['local12b','gpu31b'];
  const apiFields=Object.fromEntries(['base_url','model','api_key'].map((key,index)=>[key,
    document.getElementById(['apiBaseUrl','apiModel','apiKey'][index])]));
  const executionChoices={question_mode:['single','two','individual'],scheduling:['individual','parallel'],
    question_source:['general','custom'],review_source:['general','custom']};
  let csrf,profiles=[],connections=[],executions=[],busy=true;
  const controls=()=>{
    picker.disabled=busy||!profiles.some(profile=>profile.available);
    save.disabled=busy||!profiles.some(profile=>profile.id===picker.value&&profile.available);
    const connectionDisabled=busy||!connections.some(item=>item.id===connectionPicker.value);
    connectionPicker.disabled=busy||connections.length===0;
    for(const field of Object.values(apiFields))field.disabled=connectionDisabled;
    apiSave.disabled=connectionDisabled;
    const execution=executions.find(item=>item.id===executionPicker.value);
    const executionDisabled=busy||!execution;
    executionPicker.disabled=busy||executions.length===0;
    for(const field of Object.values(executionFields))field.disabled=executionDisabled;
    executionSave.disabled=executionDisabled||!execution.configured;
    for(const [role,{container,fields}]of Object.entries(roleFields)){
      const custom=executionFields[role+'_source'].value==='custom';
      container.hidden=!custom;
      for(const field of Object.values(fields))field.disabled=executionDisabled||!custom;
    }
  };
  const request=async(method,path,body)=>{
    let response,data;
    try{
      response=await fetchImpl(path,{method,credentials:'same-origin',headers:{
        ...(body?{'Content-Type':'application/json','X-CSRF-Token':csrf}:{}),
      },...(body?{body:JSON.stringify(body)}:{})});
      data=await response.json();
    }catch{throw new Error('설정을 처리하지 못했어요. 연결을 확인하고 다시 시도해 주세요.');}
    if(!response.ok)throw new Error(typeof data?.error?.message==='string'?data.error.message:'설정을 처리하지 못했어요. 다시 시도해 주세요.');
    return data;
  };
  const render=data=>{
    if(!Array.isArray(data?.profiles)||!data.profiles.every(profile=>profile&&ids.includes(profile.id)&&typeof profile.label==='string'&&typeof profile.available==='boolean')||
      !data.profiles.some(profile=>profile.id===data.selected_model_profile))throw new Error('모델 설정 응답을 확인하지 못했어요. 새로고침해 주세요.');
    profiles=data.profiles;picker.textContent='';
    for(const profile of profiles){
      const option=document.createElement('option');option.value=profile.id;
      option.textContent=profile.label+(profile.available?'':' · 연결 설정 필요');
      option.disabled=!profile.available;picker.appendChild(option);
    }
    picker.value=data.selected_model_profile;
    current.textContent=`현재 설정: ${profiles.find(profile=>profile.id===data.selected_model_profile).label}`;
  };
  const showConnection=()=>{
    const connection=connections.find(item=>item.id===connectionPicker.value);
    apiFields.base_url.value=connection?.base_url||'';
    apiFields.model.value=connection?.model||'';
    apiFields.api_key.value='';
    connectionState.textContent=connection?`API 키: ${connection.api_key_configured?'설정됨':'미설정'} · 질문당 1회 호출: ${connection.single_call_turns?'고정됨':'고정되지 않음'}`:'';
  };
  const renderConnections=data=>{
    if(!Array.isArray(data?.connections)||data.connections.length!==2||new Set(data.connections.map(item=>item?.id)).size!==2||
      !data.connections.every(item=>item&&ids.includes(item.id)&&(typeof item.base_url==='string'||item.base_url==null)&&
        (typeof item.model==='string'||item.model==null)&&typeof item.api_key_configured==='boolean'&&typeof item.single_call_turns==='boolean'))
      throw new Error('연결 설정 응답을 확인하지 못했어요. 새로고침해 주세요.');
    connections=data.connections;
    if(!ids.includes(connectionPicker.value))connectionPicker.value=picker.value;
    showConnection();
  };
  const showExecution=()=>{
    const execution=executions.find(item=>item.id===executionPicker.value);
    if(!execution)return;
    for(const [key,field]of Object.entries(executionFields))field.value=execution[key];
    for(const [role,{fields,keyState}]of Object.entries(roleFields)){
      const connection=execution[role+'_connection'];
      fields.base_url.value=connection?.base_url||'';
      fields.model.value=connection?.model||'';
      fields.api_key.value='';
      keyState.textContent=`API 키: ${connection?.api_key_configured?'설정됨':'미설정'}`;
    }
    executionState.textContent=execution.configured?'최종 카드는 범용 모델의 기존 흐름을 사용합니다.':'먼저 위에서 범용 모델 연결을 저장해 주세요.';
  };
  const renderExecutions=data=>{
    const validConnection=value=>value===null||value&&typeof value.base_url==='string'&&typeof value.model==='string'&&typeof value.api_key_configured==='boolean';
    if(!Array.isArray(data?.executions)||data.executions.length!==2||new Set(data.executions.map(item=>item?.id)).size!==2||
      !data.executions.every(item=>item&&ids.includes(item.id)&&typeof item.configured==='boolean'&&
        Object.entries(executionChoices).every(([key,values])=>values.includes(item[key]))&&
        validConnection(item.question_connection)&&validConnection(item.review_connection)))
      throw new Error('질문 실행 설정 응답을 확인하지 못했어요. 새로고침해 주세요.');
    executions=data.executions;
    if(!ids.includes(executionPicker.value))executionPicker.value=picker.value;
    showExecution();
  };
  picker.onchange=controls;
  connectionPicker.onchange=()=>{showConnection();apiStatus.textContent='';controls();};
  executionPicker.onchange=()=>{showExecution();executionStatus.textContent='';controls();};
  for(const field of Object.values(executionFields))field.onchange=controls;
  form.onsubmit=async event=>{
    event.preventDefault();if(busy||!profiles.some(profile=>profile.id===picker.value&&profile.available))return;
    busy=true;controls();status.textContent='설정을 저장하고 있어요.';
    try{
      render(await request('PUT','/api/admin/models',{model_profile_id:picker.value}));
      status.textContent='저장했어요. 다음에 시작하는 새 대화부터 적용됩니다.';
    }catch(error){status.textContent=error.message;}
    finally{busy=false;controls();}
  };
  apiForm.onsubmit=async event=>{
    event.preventDefault();if(busy||!connections.some(item=>item.id===connectionPicker.value))return;
    const input=Object.fromEntries(Object.entries(apiFields).map(([key,field])=>[key,field.value.trim()]));
    if(!input.base_url||!input.model){apiStatus.textContent='API 기본 URL과 모델 이름을 입력해 주세요.';return;}
    if(!input.api_key)delete input.api_key;
    busy=true;controls();apiStatus.textContent='연결 설정을 저장하고 있어요.';
    let saved=false;
    try{
      const data=await request('PUT',`/api/admin/model-connections/${connectionPicker.value}`,input);
      saved=true;
      apiFields.api_key.value='';
      renderConnections(data);
      render(await request('GET','/api/admin/models'));
      renderExecutions(await request('GET','/api/admin/model-execution'));
      apiStatus.textContent='연결을 저장했어요. 새 대화부터 적용되며 기본 모델 선택은 유지됩니다.';
    }catch(error){apiStatus.textContent=(saved?'연결은 저장했지만 표시를 갱신하지 못했어요. ':'')+error.message;}
    finally{busy=false;controls();}
  };
  executionForm.onsubmit=async event=>{
    event.preventDefault();
    const execution=executions.find(item=>item.id===executionPicker.value);
    if(busy||!execution?.configured)return;
    const input=Object.fromEntries(Object.entries(executionFields).map(([key,field])=>[key,field.value]));
    if(!Object.entries(executionChoices).every(([key,values])=>values.includes(input[key]))){
      executionStatus.textContent='호출 방식과 사용할 모델을 다시 선택해 주세요.';return;
    }
    for(const [role,{fields}]of Object.entries(roleFields)){
      if(input[role+'_source']!=='custom')continue;
      const connection=Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,field.value.trim()]));
      if(!connection.base_url||!connection.model){
        executionStatus.textContent=`${role==='question'?'질문용':'검토용'} API 기본 URL과 모델 이름을 입력해 주세요.`;return;
      }
      if(!connection.api_key)delete connection.api_key;
      input[role+'_connection']=connection;
    }
    busy=true;controls();executionStatus.textContent='질문 실행 설정을 저장하고 있어요.';
    let saved=false;
    try{
      const data=await request('PUT',`/api/admin/model-execution/${executionPicker.value}`,input);
      saved=true;
      for(const {fields}of Object.values(roleFields))fields.api_key.value='';
      renderExecutions(data);
      renderConnections(await request('GET','/api/admin/model-connections'));
      executionStatus.textContent='질문 실행 설정을 저장했어요. 새 대화부터 적용되며 최종 카드 흐름과 기본 모델 선택은 유지됩니다.';
    }catch(error){executionStatus.textContent=(saved?'설정은 저장했지만 표시를 갱신하지 못했어요. ':'')+error.message;}
    finally{busy=false;controls();}
  };
  controls();
  try{
    csrf=(await request('GET','/api/bootstrap')).csrf_token;
    if(typeof csrf!=='string'||!csrf)throw new Error('관리자 세션을 시작하지 못했어요. 새로고침해 주세요.');
    render(await request('GET','/api/admin/models'));
    connectionPicker.value=picker.value;
    renderConnections(await request('GET','/api/admin/model-connections'));
    executionPicker.value=picker.value;
    renderExecutions(await request('GET','/api/admin/model-execution'));
    status.textContent='모델을 선택한 뒤 설정을 저장해 주세요.';
    busy=false;
  }catch(error){current.textContent='설정을 불러오지 못했어요.';status.textContent=error.message;}
  controls();
}

if(typeof document!=='undefined')await mountModelAdmin({document});
