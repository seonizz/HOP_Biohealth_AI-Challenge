import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=name=>readFileSync(new URL(`../public/js/${name}`,import.meta.url),'utf8');
const oldId='11111111-1111-1111-1111-111111111111',newId='22222222-2222-2222-2222-222222222222';
function harness(){
  const nodes=Object.fromEntries(['start','chat','result','records','about','columns','leaveDlg','rbody'].map(id=>[id,{hidden:id!=='chat',close(){this.open=false;}}]));
  const calls=[];
  let release,releaseRead;
  const deletion=new Promise(resolve=>release=resolve),read=new Promise(resolve=>releaseRead=resolve);
  const location=new URL('http://synthetic.local/chat/'+oldId);
  const navigate=value=>{location.href=new URL(value,location).href;};
  const window={location,scrollTo(){},addEventListener(){},history:{pushState(_state,_title,p){navigate(p);},replaceState(_state,_title,p){navigate(p);}}};
  const context=vm.createContext({window,URL,URLSearchParams,AbortController,
    document:{title:'',getElementById:id=>nodes[id],querySelectorAll:()=>[],body:{classList:{remove(){}}}},
    API:{data:{},request:async(path,options)=>{
      calls.push([path,options?.method]);
      if(options?.method==='DELETE')return deletion;
      if(path==='/api/intakes/'+newId)return read;
      if(path==='/api/intakes')return read;
      throw Error('Unexpected synthetic request: '+path);
    }},StartScreen:{updRecN(){}},
    ChatInput:{clear(){},waitForQuestion(){},render(){},typeAhead(){return '';},acceptTypeAhead(){}},
    ChatScreen:{clear(){},title(){},section(){},progress(){},think(){},sync(){},typing:async(_face,work)=>work()},
    COLUMNS:[],setTimeout,clearTimeout
  });
  vm.runInContext(['core/utils.js','core/store.js','core/conversation.js','core/router.js'].map(source).join('\n')+
    '\nglobalThis.flow={deleteCurrentConversation,begin,state:()=>S,setState:s=>S=s,router:AppRouter,visible:()=>SCREEN_IDS.find(id=>!$(id).hidden)};globalThis.AboutScreen={open:()=>show("about")};',context);
  context.flow.setState({id:oldId,revision:0,question:{id:'name'},log:[]});context.flow.router.init();
  const next={id:newId,revision:0,chat_title:'synthetic',status:'asking',question:{id:'name',type:'text'},log:[]};
  return {nodes,location,calls,release,releaseRead:()=>releaseRead(next),flow:context.flow,navigate};
}

test('deleting the still-visible conversation clears it and returns to start',async()=>{
  const h=harness(),pending=h.flow.deleteCurrentConversation();
  h.release({deleted:true,record_ids:[]});await pending;
  assert.equal(h.flow.visible(),'start');assert.equal(h.location.pathname,'/');assert.equal(h.flow.state(),null);
  assert.deepEqual(h.calls,[['/api/intakes/'+oldId,'DELETE']]);
});

test('a delayed delete cannot replace a newer about route',async()=>{
  const h=harness(),pending=h.flow.deleteCurrentConversation();
  h.navigate('/about');await h.flow.router.restore();
  h.release({deleted:true,record_ids:[]});await pending;
  assert.equal(h.flow.visible(),'about');assert.equal(h.location.pathname,'/about');assert.equal(h.flow.state(),null);
});

for(const readPending of [false,true])test(`a delayed delete preserves a newer chat whose read is ${readPending?'pending':'complete'}`,async()=>{
  const h=harness(),pending=h.flow.deleteCurrentConversation();
  h.navigate('/chat/'+newId);const restoring=h.flow.router.restore();
  if(!readPending){h.releaseRead();await restoring;}
  h.release({deleted:true,record_ids:[]});await pending;
  assert.equal(h.flow.visible(),'chat');assert.equal(h.location.pathname,'/chat/'+newId);
  if(readPending){h.releaseRead();await restoring;}
  assert.equal(h.flow.state().id,newId);assert.equal(h.flow.visible(),'chat');
  assert.equal(h.calls.filter(([,method])=>method==='DELETE').length,1);
});

test('a delayed delete cannot hide a newly starting conversation before its ID arrives',async()=>{
  const h=harness(),pending=h.flow.deleteCurrentConversation(),starting=h.flow.begin();
  assert.equal(h.location.pathname,'/chat');
  h.release({deleted:true,record_ids:[]});await pending;
  assert.equal(h.flow.visible(),'chat');assert.equal(h.location.pathname,'/chat');
  h.releaseRead();await starting;assert.equal(h.flow.state().id,newId);
});

test('deleting the same conversation after its result screen appears still returns to start',async()=>{
  const h=harness(),pending=h.flow.deleteCurrentConversation();
  h.nodes.chat.hidden=true;h.nodes.result.hidden=false;h.navigate('/result/'+oldId);
  h.release({deleted:true,record_ids:[]});await pending;
  assert.equal(h.flow.visible(),'start');assert.equal(h.location.pathname,'/');
});
