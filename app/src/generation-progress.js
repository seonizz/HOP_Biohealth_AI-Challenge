// Only public stage metadata: never model text, prompts, quotes or reasoning.
const labels = [
  [/^retry$/, '답변을 다시 준비하고 있어요'],
  [/^turn_draft/, '들려주신 내용 정리'], [/^turn_review/, '답변 내용 확인'],
  [/^card_care/, '사용자 감정·부담·지원 자원 작성'], [/^card_doList/, '행동의 방법과 목적 작성'],
  [/^card_avoid/, '피할 표현의 이유와 대안 작성'], [/^card_next/, '상대 반응별 다음 단계 작성'],
  [/^state_observations/, '들려주신 원문 확인'], [/^relationship_memory/, '두 사람의 상태 갱신'],
  [/^state_review/, '상태 근거 검토'], [/^relationship_analysis/, '관계 분석'],
  [/^analysis_review/, '관계 해석 검토'], [/^analysis_repair/, '관계 해석 보완'], [/^communication_plan/, '말하기 전략 작성'],
  [/^plan_review/, '말하기 전략 검토'], [/^guide_write/, '다섯 카드 초안 작성'],
  [/^guide_quality/, '다섯 카드 품질 검토'], [/^guide_refine/, '다섯 카드 내용 보완'],
  [/^speech_opening/, '첫마디와 관찰 장면 작성'], [/^speech_listening/, '마음을 전하고 듣는 말 작성'],
  [/^speech_offer/, '작은 제안과 선택권 작성'], [/^speech_write/, '첫 대화 전체 통합'],
  [/^speech_detail_review/, '단계별 설명과 원문 근거 검토'], [/^speech_detail/, '말하기 단계와 이유 정리'],
  [/^speech_review/, '건넬 말과 행동의 근거 검토'], [/^support_review/, '사용자 돌봄과 다음 단계 검토'],
  [/^guide_repair/, '검토에서 발견한 내용 수정'], [/^guide_review/, '최종 답안 검토'],
  [/^card_review_bundle/, '건넬 말과 행동의 근거 검토'], [/^final_review_bundle/, '최종 답안 검토'],
];
const phases = [
  {label:'이야기 살펴보기',matches:/^(?:state|turn_|relationship_|analysis_)/},
  {label:'안내 방향 정하기',matches:/^(?:communication_plan|plan_review)/},
  {label:'말과 행동 정리하기',matches:/^(?:card_|(?:speech_review|support_review|guide_repair)_card_|guide$|guide_write|guide_quality|guide_refine|speech_opening|speech_listening|speech_offer|speech_write)/},
  {label:'원문과 안내 확인하기',matches:/^(?:guide_repair|guide_review|speech_review|support_review|speech_detail|final_review_bundle)/},
  {label:'결과 저장하기',matches:null},
];
const guideCardIds=['care','doList','avoid','next','script'];
const cardIds=[...guideCardIds,'relationship'];
const singleCard=/^(card|speech_review_card|support_review_card|card_review_bundle)_(care|doList|avoid|next|script)(?:_|$)/;
const writing={
  care:'당신의 마음을 돌보는 방법을 적고 있어요',
  doList:'해 볼 행동과 방법을 정리하고 있어요',
  avoid:'피할 말과 대신 쓸 표현을 찾고 있어요',
  next:'상대의 반응에 따른 다음 행동을 정리하고 있어요',
};

// Descriptions and card IDs are allowlisted here before any progress is published.
function cardProcess(stage,fields) {
  const single=stage.match(singleCard);
  if(single) {
    const [,kind,id]=single;
    return {ids:[id],label:writing[id]&&kind==='card'?writing[id]:
      kind==='support_review_card'?'부담 없이 실천할 수 있는지 확인하고 있어요':'답변에 근거한 안내인지 확인하고 있어요'};
  }
  const process=[
    [/^(?:final_analysis_plan_draft|relationship_analysis)/,['relationship'],'두 분의 상황과 관계를 정리하고 있어요'],
    [/^analysis_repair/,['relationship'],'관계 해석을 보완하고 있어요'],
    [/^analysis_review/,['relationship'],'관계 해석을 답변과 대조하고 있어요'],
    [/^(?:guide_write|guide$)/,guideCardIds,'카드 초안을 작성하고 있어요'],
    [/^speech_opening/,['script'],'대화를 시작할 첫마디를 만들고 있어요'],
    [/^speech_listening/,['script'],'마음을 전하고 이야기를 들을 말을 만들고 있어요'],
    [/^speech_offer/,['script'],'부담 없이 건넬 제안을 만들고 있어요'],
    [/^speech_write/,['script'],'첫마디부터 제안까지 하나의 대화로 잇고 있어요'],
    [/^speech_detail_review/,['script'],'대화문의 각 부분이 답변에 맞는지 확인하고 있어요'],
    [/^speech_detail_repair/,['script'],'대화문의 각 부분을 다시 정리하고 있어요'],
    [/^speech_detail/,['script'],'대화문의 각 부분을 정리하고 있어요'],
    [/^(?:guide_refine|guide_repair)/,fields,'검토에서 지적된 내용을 수정하고 있어요'],
    [/^guide_quality/,guideCardIds,'안내가 구체적이고 이해하기 쉬운지 검토하고 있어요'],
    [/^support_review/,['care','next'],'부담 없이 실천할 수 있는지 확인하고 있어요'],
    [/^(?:speech_review|continuation_context_review)/,guideCardIds,'안내를 들려주신 답변과 대조하고 있어요'],
    [/^guide_review/,cardIds,'전체 안내의 근거와 일관성을 최종 확인하고 있어요'],
    [/^final_review_bundle/,fields,'여러 카드의 내용과 근거를 함께 검토하고 있어요'],
  ].find(([pattern])=>pattern.test(stage));
  if(process) {
    const [,ids=[],label]=process;
    return {ids,label};
  }
}

export function reviewBundleCardIds(stages) {
  return [...new Set(stages.flatMap(stage=>cardProcess(stage)?.ids??[]))];
}

export async function withCardProgress(operation,stage,fields,work) {
  const process=operation.onCardProcess&&cardProcess(stage,fields);
  if(!process?.ids.length)return work();
  const token=Symbol();
  const report=status=>{
    try{operation.onCardProcess({stage,fields,status,token});}
    catch{/* Progress cannot stop generation. */}
  };
  report('started');
  try{return await work();}
  finally{report('settled');}
}

export function generationProgress() {
  const state={status:'running',completed:[],current:phases[0].label,attempt:1,
    step_index:0,step_total:phases.length,progress:0,
    steps:phases.map(({label},index)=>({label,status:index===0?'current':'pending'})),card_stages:{}};
  const completedStages=new Map(),cards=new Map(),activeProcesses=new Map(),listeners=new Set();
  const publish=()=>{for(const listener of listeners){try{listener();}catch{/* An observer cannot stop generation. */}}};
  const refreshCardStages=()=>{
    const stages={};
    for(const {ids,label} of activeProcesses.values())for(const id of ids)if(cardIds.includes(id))stages[id]=label;
    state.card_stages=stages;
  };
  const clearCardStages=()=>{activeProcesses.clear();refreshCardStages();};
  const refreshCompleted=()=>{state.completed=[...completedStages.values()].map(({label})=>({label}));};
  const advance=index=>{
    // Re-entering an earlier phase discards its dependent work. The progress
    // reflects the current draft, including when a late review requests repair.
    if(index<state.step_index){
      for(const [stage,completed] of completedStages)if(completed.phase>=index)completedStages.delete(stage);
      refreshCompleted();
    }
    state.step_index=index;
    state.steps.forEach((step,position)=>{step.status=position<state.step_index?'complete':position===state.step_index?'current':'pending';});
    state.progress=state.step_index/phases.length*100;
  };
  return {
    state,
    cards:()=>structuredClone([...cards.values()]),
    subscribe(listener){listeners.add(listener);return ()=>listeners.delete(listener);},
    card(event){
      if(event?.type==='reset'){cards.clear();clearCardStages();publish();return;}
      if(!cardIds.includes(event?.id))return;
      if(event.type==='remove'){cards.delete(event.id);publish();return;}
      if(event.type==='upsert'){cards.set(event.id,structuredClone({id:event.id,value:event.value,...(event.detail?{detail:event.detail}:{})}));publish();}
    },
    cardProcess({stage,fields,status,token}) {
      if(status==='started'&&state.status==='running'){
        const process=cardProcess(stage,fields);
        if(!process?.ids.length)return;
        activeProcesses.set(token,process);
      }else if(status!=='settled'||!activeProcesses.delete(token))return;
      refreshCardStages();publish();
    },
    event({stage,status,attempt=1}) {
      const label=labels.find(([pattern])=>pattern.test(stage))?.[1] || '답안 작성·검토';
      state.current=label;state.attempt=attempt;
      // ModelGateway retries the whole operation after this event; no draft
      // or completed phase from the discarded operation remains valid.
      if(stage==='retry'){
        cards.clear();completedStages.clear();refreshCompleted();state.status='running';
        clearCardStages();
        advance(0);state.attempt=attempt+1;publish();return;
      }
      const phase=phases.findIndex(({matches})=>matches?.test(stage));
      // Parallel branches may finish an earlier phase after another branch has
      // started reviewing. Only an explicit rewrite/repair invalidates work.
      if(phase>=0&&(phase>=state.step_index||status==='started'&&/repair|guide_write/.test(stage)))advance(phase);
      if(status==='completed'&&!completedStages.has(stage)){
        completedStages.set(stage,{label,phase});refreshCompleted();
      }
      publish();
    },
    finish(status) {
      state.status=status;
      clearCardStages();
      if(status==='complete'){
        state.step_index=phases.length;state.progress=100;
        state.steps.forEach(step=>{step.status='complete';});
        state.current='검토·저장 완료';
      }else if(status==='saving'){
        advance(phases.length-1);state.current=phases.at(-1).label;
      }else if(status==='failed'){
        state.current='답안 준비 중단';
      }
      publish();
    },
  };
}
