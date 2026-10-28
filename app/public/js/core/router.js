// URL에는 화면과 서버 기록 ID만 담아요. 대화 원문과 입력 중인 내용은 넣지 않아요.
const AppRouter={
  active:false,applying:false,sequence:0,
  init(){
    if(this.active)return;
    this.active=true;
    window.addEventListener("popstate",()=>this.restore());
  },
  path(screen){
    if((screen==="chat"||screen==="result")&&typeof S!=="undefined"&&S?.id){
      const target=screen==="result"||S.status==="ready"?"result":"chat";
      return `/${target}/${encodeURIComponent(S.id)}`;
    }
    if(screen==="chat"&&typeof resumingConversationId!=="undefined"&&resumingConversationId)return `/chat/${encodeURIComponent(resumingConversationId)}`;
    if(screen==="records"){
      const selected=typeof curRec!=="undefined"&&loadRecs().some(record=>String(record.id)===String(curRec));
      return selected?`/records/${encodeURIComponent(curRec)}`:"/records";
    }
    if(screen==="columns"){
      const article=ColumnsScreen.cur==null?null:COLUMNS[ColumnsScreen.cur];
      const query=new URLSearchParams();
      if(ColumnsScreen.filter!=="전체")query.set("category",ColumnsScreen.filter);
      if(ColumnsScreen.only)query.set("view",ColumnsScreen.only);
      const suffix=query.toString();
      return `/columns${article?`/${encodeURIComponent(article.art)}`:""}${suffix?`?${suffix}`:""}`;
    }
    return screen==="about"?"/about":screen==="chat"?"/chat":"/";
  },
  sync(screen,{replace=false}={}){
    if(!this.active||this.applying)return;
    const path=this.path(screen);
    if(window.location.pathname+window.location.search===path)return;
    window.history[replace?"replaceState":"pushState"]({screen},"",path);
  },
  parse(){
    const url=new URL(window.location.href);
    const parts=url.pathname.split("/").filter(Boolean).map(part=>decodeURIComponent(part));
    const [screen,id]=parts;
    if(parts.length>2)return {screen:"start"};
    if(["chat","result"].includes(screen)&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id||""))return {screen,id};
    if(screen==="records"&&(!id||/^\d+$/.test(id)))return {screen,id:id?Number(id):undefined};
    if(screen==="columns")return {screen,id,category:url.searchParams.get("category"),only:url.searchParams.get("view")};
    return {screen:screen==="about"&&!id?"about":"start"};
  },
  async restore(){
    const sequence=++this.sequence;
    if(typeof ConversationDrafts!=="undefined")ConversationDrafts.save();
    cancelConversationRequest();conversationToken++;resumingConversationId=null;
    if(typeof ReferralGuide!=="undefined")ReferralGuide.invalidate();
    // A reader/dialog belongs to one route and must not cover the next screen.
    if(typeof ColumnsScreen!=="undefined"&&ColumnsScreen.cur!=null)ColumnsScreen.close({route:false});
    $("leaveDlg")?.close();document.body.classList.remove("noscroll");
    let route;
    try{route=this.parse();}catch{route={screen:"start"};}
    this.applying=true;
    let pending;
    try{
      if(route.screen==="chat"||route.screen==="result")pending=resumeConversation(route.id);
      else if(route.screen==="records")pending=RecordsScreen.open(route.id);
      else if(route.screen==="about")AboutScreen.open();
      else if(route.screen==="columns"){
        ColumnsScreen.open(route.category);
        ColumnsScreen.only=["saved","unread"].includes(route.only)?route.only:"";
        ColumnsScreen.draw();
        if(route.id){const index=COLUMNS.findIndex(article=>article.art===route.id);if(index>=0)ColumnsScreen.read(index);}
      }else show("start");
    }finally{this.applying=false;}
    if(pending)await pending;
    if(sequence!==this.sequence)return;
    const visible=SCREEN_IDS.find(id=>!$(id)?.hidden)||"start";
    this.sync(visible,{replace:true});
  }
};
