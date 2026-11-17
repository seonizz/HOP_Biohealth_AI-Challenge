// 불씨는 대화가 끝난 결과 화면에서 원문과 서버의 등록 문구를 표시해요.
const ReferralGuide={
  sequence:0,key:null,root:null,screen:null,data:null,retry:null,controller:null,pendingRequest:null,
  mount(){
    if(this.root)this.root.remove();
    this.root=document.createElement("aside");this.root.id="referralGuide";this.root.className="referral-guide";this.root.hidden=true;
    this.root.setAttribute("aria-label","불씨의 도움 안내");this.root.setAttribute("aria-live","polite");this.root.setAttribute("aria-atomic","true");
    const input=$("input");
    const edit=()=>this.invalidate();
    input?.addEventListener("input",edit);input?.addEventListener("change",edit);
    input?.addEventListener("click",event=>{if(event.target.closest("button"))edit();},true);
    this.navigate($("chat")?.hidden?"start":"chat");
  },
  invalidate(){this.controller?.abort();this.controller=null;this.pendingRequest=null;this.sequence++;this.key=null;this.data=null;this.retry=null;if(this.root){this.root.hidden=true;this.root.textContent="";}},
  navigate(screen){
    this.screen=screen;
    if(!this.root)return;
    this.root.dataset.mode=screen;
    if(screen==="result"){
      const cards=$("rbody")?.querySelector?.(".cards"),actions=cards?.querySelector(".actions");
      if(actions)actions.before(this.root);
      else if(cards)cards.appendChild(this.root);
      else $("rbody")?.before(this.root);
    }
    else this.invalidate();
    if(screen==="result"&&this.data)this.draw(this.data,this.retry);
  },
  eligible(view){
    if(!view?.id||!Number.isInteger(view.revision))return false;
    return view.status==="ready"&&!view.model_pending&&view.referral_available===true;
  },
  current(view,sequence){
    return sequence===this.sequence&&S?.id===view.id&&S?.revision===view.revision&&
      this.screen==="result";
  },
  async observe(view,{retry=false}={}){
    if(this.screen!=="result"||!this.eligible(view)){this.invalidate();return;}
    view={...view}; // Result preparation can advance the shared conversation revision.
    if(retry){
      const sequence=this.sequence;
      let finishing;
      while(typeof pendingConversationFinish==="function"&&(finishing=pendingConversationFinish(view))){
        try{await finishing;}catch{ /* The result flow owns its error display. */ }
        if(!this.current(view,sequence))return;
      }
      if(!this.current(view,sequence))return;
    }
    const key=`${view.id}:${view.revision}`;
    if(this.key===key&&!retry)return this.pendingRequest;
    this.invalidate();this.key=key;
    const controller=typeof AbortController==="function"?new AbortController():null;this.controller=controller;
    const sequence=this.sequence;
    let request;
    try{
      request=API.request(`/api/intakes/${encodeURIComponent(view.id)}/guidance`,{method:"POST",body:{revision:view.revision},...(controller?{signal:controller.signal}:{})});
      this.pendingRequest=request;
      const data=await request;
      if(!this.current(view,sequence))return;
      if(data?.revision!==view.revision)return;
      if(typeof data.guidance?.message!=="string")throw new Error("Invalid guidance");
      this.draw(data,()=>this.observe(view,{retry:true}));
    }catch(error){
      if(controller?.signal.aborted||!this.current(view,sequence)||error.status===404||error.status===409&&["REVISION_CONFLICT","REFERRAL_INPUT_PENDING"].includes(error.code))return;
      this.drawUnavailable(()=>this.observe(view,{retry:true}));
    }finally{if(this.controller===controller)this.controller=null;if(this.pendingRequest===request)this.pendingRequest=null;}
  },
  node(tag,className,text){
    const node=document.createElement(tag);node.className=className;
    if(text!==undefined)node.textContent=text;
    return node;
  },
  addRetry(retry){
    const button=this.node("button","ghost referral-retry","안내 다시 확인");button.type="button";button.onclick=retry;this.root.appendChild(button);
  },
  drawUnavailable(retry){
    if(this.screen!=="result"){this.invalidate();return;}
    this.data=null;this.retry=null;
    this.root.textContent="";this.root.hidden=false;this.root.dataset.urgency="unavailable";
    this.root.appendChild(this.node("p","referral-unavailable","도움 안내를 지금 확인하지 못했어요. 잠시 후 다시 확인할 수 있어요."));
    this.addRetry(retry);
  },
  safeAction(action){
    if(!action||typeof action.href!=="string")return null;
    if(action.kind==="phone"&&/^tel:\+?[0-9][0-9 -]{1,30}$/.test(action.href))return action.href;
    if(action.kind==="booking"){
      try{const url=new URL(action.href);if(url.protocol==="https:"&&!url.username&&!url.password)return url.href;}catch{}
    }
    return null;
  },
  draw(data,retry){
    if(this.screen!=="result"){this.invalidate();return;}
    this.data=data;this.retry=retry;
    const warning=urgency=>urgency==="immediate"||urgency==="soon";
    const alerts=[data.safety_alert,data.preserved_safety_alert].filter(alert=>alert&&warning(alert.urgency));
    const concerns=Array.isArray(data.guidance.concerns)?data.guidance.concerns.filter(item=>
      Array.isArray(item?.quotes)&&item.quotes.some(quote=>typeof quote?.text==="string"&&quote.text.trim())):[];
    if(!warning(data.assessment?.urgency)&&!alerts.length&&!concerns.length){
      if(data.status==="model_unavailable")this.drawUnavailable(retry);
      else {this.root.hidden=true;this.root.textContent="";}
      return;
    }
    this.root.textContent="";this.root.hidden=false;this.root.dataset.urgency=data.guidance.urgency;
    const identity=this.node("div","referral-identity");
    const asset=data.presentation?.asset_path;
    if(typeof asset==="string"&&/^\/characters\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:png|webp|jpg|jpeg|gif|avif)$/.test(asset)){
      const image=this.node("img","referral-avatar");image.src=asset;image.alt="";image.onerror=()=>image.remove();identity.appendChild(image);
    }
    identity.appendChild(this.node("strong","referral-name",data.presentation?.display_name||"불씨"));
    if(data.guidance.urgent)identity.appendChild(this.node("span","referral-title","지금 안전을 먼저 살펴 주세요"));
    this.root.appendChild(identity);
    // Keep attribution when concerns involve different people, without exposing
    // a score or turning a model classification into a label for the person.
    const labels={patient:"그분",supporter:"이야기를 전하는 당신",other:"함께 언급된 다른 사람"};
    const concern=(urgency,subjects)=>{
      const target=subjects.map(subject=>labels[subject]||"위험한 상황에 놓인 사람").join(", ");
      this.root.appendChild(this.node("p","referral-subject",urgency==="immediate"?`${target}의 안전을 먼저 살펴 주세요.`:`${target}도 도움을 받을 수 있어요.`));
    };
    if(alerts.length&&warning(data.assessment?.urgency))concern(data.assessment.urgency,["patient"]);
    alerts.forEach(alert=>concern(alert.urgency,Array.isArray(alert.subjects)&&alert.subjects.length?alert.subjects:["unclear"]));
    if(this.screen==="result"){
      this.root.appendChild(this.node("h3","referral-heading",data.guidance.urgent?"대화에서 확인한 안전 안내":"전문가의 상담을 함께 살펴봐요"));
      if(concerns.length){
        this.root.appendChild(this.node("p","referral-intro","대화에서 함께 살펴볼 부분을 찾았어요. 전해 주신 원문과 상담을 권하는 이유예요."));
        for(const item of concerns){
          const entry=this.node("div","referral-concern");
          entry.appendChild(this.node("p","referral-subject",labels[item.subject]||"상황의 당사자"));
          for(const quote of item.quotes||[]){
            if(typeof quote.text==="string")entry.appendChild(this.node("blockquote","referral-quote",quote.text));
          }
          entry.appendChild(this.node("p","referral-reason",item.reason));
          this.root.appendChild(entry);
        }
        this.root.appendChild(this.node("p","referral-recommendation",data.guidance.urgent?"지금은 안전을 확보하고 긴급 도움을 요청하는 것이 먼저예요.":"이 부분을 전문가와 함께 살펴볼 수 있도록 상담을 추천해요."));
      }
    }
    // Do not interpolate, trim, paraphrase, or run speech generation on this text.
    this.root.appendChild(this.node("p","referral-message",data.guidance.message));
    const links=this.node("div","referral-contacts");
    for(const institution of data.guidance.institutions||[]){
      for(const action of institution.actions||[]){
        const href=this.safeAction(action);if(!href||data.guidance.urgent&&action.kind!=="phone")continue;
        const link=this.node("a","referral-contact",`${institution.name} · ${action.kind==="phone"?"전화":"예약 안내"}`);
        link.href=href;if(action.kind==="booking"){link.target="_blank";link.rel="noopener noreferrer";link.referrerPolicy="no-referrer";}
        links.appendChild(link);
      }
    }
    let contacts=this.root;
    if(!data.guidance.urgent){
      contacts=this.node("details","referral-options");
      contacts.appendChild(this.node("summary","referral-options-label","도움받을 곳 살펴보기"));
      this.root.appendChild(contacts);
    }
    if(links.children.length)contacts.appendChild(links);
    else contacts.appendChild(this.node("p","referral-unavailable","연결할 기관 정보를 확인하지 못했어요."));
    contacts.appendChild(this.node("p","referral-privacy","기관에 자동으로 연락하거나 대화 내용을 보내지 않아요."));
    if(data.status==="model_unavailable"){
      this.root.appendChild(this.node("p","referral-unavailable","새 안내를 확인하지 못해, 이미 확인된 긴급 안내를 유지하고 있어요."));this.addRetry(retry);
    }
  }
};
