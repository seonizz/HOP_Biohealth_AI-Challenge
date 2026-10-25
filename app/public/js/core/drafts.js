// Unsent answers stay in this tab and authenticated session, never in its URL.
const ConversationDrafts={
  prefix:"malssi.conversation-drafts.v1.",
  ttl:24*60*60*1000,
  limit:32,
  storageKey:null,
  entries:{},
  active:null,
  restoring:false,
  bound:false,
  async init(csrf){
    this.storageKey=null;this.entries={};this.active=null;
    try{
      if(typeof csrf!=="string"||!csrf||!globalThis.crypto?.subtle)return;
      const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(csrf));
      const fingerprint=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
      const key=this.prefix+fingerprint,storage=window.sessionStorage;
      // Remove drafts belonging to a previous anonymous/authenticated session.
      const oldKeys=[];
      for(let index=0;index<storage.length;index++){
        const candidate=storage.key(index);
        if(candidate?.startsWith(this.prefix)&&candidate!==key)oldKeys.push(candidate);
      }
      oldKeys.forEach(candidate=>storage.removeItem(candidate));
      const raw=storage.getItem(key);
      try{this.entries=raw?JSON.parse(raw):{};}catch{this.entries={};}
      if(!this.entries||typeof this.entries!=="object"||Array.isArray(this.entries))this.entries={};
      this.storageKey=key;this.persist();
      if(!this.bound){
        const saveInput=event=>{
          if(event.target instanceof Element&&event.target.closest("#input"))this.save(event.type!=="click"||!!event.target.closest(".chip"));
        };
        document.addEventListener("input",saveInput);
        document.addEventListener("change",saveInput);
        document.addEventListener("click",saveInput);
        window.addEventListener("beforeunload",()=>this.save());
        window.addEventListener("pagehide",()=>this.save());
        document.addEventListener("visibilitychange",()=>{if(document.hidden)this.save();});
        this.bound=true;
      }
    }catch{this.storageKey=null;this.entries={};this.active=null;}
  },
  identity(view){
    if(!view?.question||view.id==null||view.revision==null||view.question.id==null)return null;
    return JSON.stringify([String(view.id),view.revision,String(view.question.id),!!view.question.follow_up]);
  },
  boundedDraft(draft){
    return {...(typeof draft.nextText==="string"&&draft.nextText?{nextText:draft.nextText.slice(0,20000)}:{}),text:typeof draft.text==="string"?draft.text.slice(0,20000):"",
      own:typeof draft.own==="string"?draft.own.slice(0,20000):"",
      selected:Array.isArray(draft.selected)?draft.selected.filter(index=>Number.isInteger(index)&&index>=0&&index<500).slice(0,500):[],
      detailOption:Number.isInteger(draft.detailOption)&&draft.detailOption>=0&&draft.detailOption<500?draft.detailOption:null};
  },
  persist(){
    if(!this.storageKey)return;
    const now=Date.now();
    this.entries=Object.fromEntries(Object.entries(this.entries)
      .filter(([,entry])=>entry&&Number.isFinite(entry.at)&&entry.at<=now&&now-entry.at<this.ttl&&entry.draft&&typeof entry.draft==="object"&&typeof entry.intake==="string")
      .sort((a,b)=>b[1].at-a[1].at).slice(0,this.limit)
      .map(([key,entry])=>[key,{intake:entry.intake,at:entry.at,draft:this.boundedDraft(entry.draft)}]));
    try{window.sessionStorage.setItem(this.storageKey,JSON.stringify(this.entries));}
    catch{this.storageKey=null;this.entries={};this.active=null;}
  },
  save(edited=false){
    if(!this.storageKey||!this.active||this.restoring||typeof ChatInput==="undefined"||ChatInput.draftContext!==this.active.context)return;
    this.active.edited=this.active.edited||edited;
    const draft=ChatInput.captureDraft();
    if(!draft)return;
    const bounded=this.boundedDraft(draft),{text,own,selected,detailOption,nextText}=bounded;
    // An intentionally cleared answer must override an older server pending answer.
    if(!nextText&&!text&&!own&&!selected.length&&detailOption===null&&!this.active.edited&&!this.entries[this.active.key])delete this.entries[this.active.key];
    else this.entries[this.active.key]={intake:this.active.intake,at:Date.now(),draft:bounded};
    this.persist();
  },
  restore(view){
    const key=this.identity(view);
    this.active=key&&typeof ChatInput!=="undefined"?{key,intake:String(view.id),context:ChatInput.draftContext}:null;
    if(!this.storageKey||!this.active)return false;
    this.persist();
    let entry=this.entries[key];
    // Only the server-confirmed source revision can cross a saved pending turn.
    // This preserves edits made after an answer POST lost its connection.
    const pending=view.pending_answer;
    if(!entry&&view.model_pending&&Number.isInteger(pending?.revision)&&pending.revision<view.revision&&pending.question_id===view.question.id&&!!pending.follow_up===!!view.question.follow_up){
      const previousKey=this.identity({...view,revision:pending.revision});
      entry=this.entries[previousKey];
      if(entry){this.entries[key]=entry;delete this.entries[previousKey];this.persist();}
    }
    if(!entry)return false;
    this.restoring=true;
    try{ChatInput.restoreDraft(entry.draft);}finally{this.restoring=false;}
    return true;
  },
  rebind(view){
    const key=this.identity(view),previous=this.active;
    if(!key||!view.model_pending||!previous||typeof ChatInput==="undefined"||ChatInput.draftContext!==previous.context)return false;
    const before=JSON.parse(previous.key),after=JSON.parse(key);
    if(before[0]!==after[0]||before[2]!==after[2]||before[3]!==after[3])return false;
    if(previous.key!==key)delete this.entries[previous.key];
    this.active={key,intake:String(view.id),context:previous.context,edited:previous.edited};
    this.save();
    return true;
  },
  clear(view){
    const key=this.identity(view);
    if(!key)return;
    delete this.entries[key];
    if(this.active?.key===key)this.active=null;
    this.persist();
  },
  removeIntake(id){
    const intake=String(id);
    Object.entries(this.entries).forEach(([key,entry])=>{if(entry?.intake===intake)delete this.entries[key];});
    if(this.active?.intake===intake)this.active=null;
    this.persist();
  },
  clearAll(){
    this.entries={};this.active=null;
    this.persist();
  }
};
