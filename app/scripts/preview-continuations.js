import {randomBytes, randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createApp} from '../src/server.js';
import {createIntake, buildContext} from '../src/intake.js';
import {configuredModelGateway} from '../src/model-config.js';

const sample = {
  name:'민서', want:'친구에게 안부를 묻고 부담 없는 대화를 이어가고 싶어요.',
  observation:'민서가 이번 주에는 야근이 많아서 피곤하다고 말했어요.',
  feeling:'친구가 걱정되지만 저도 요즘 지쳐서 오래 통화하기는 어려워요.',
  followup:'오늘 민서가 내일 짧게 통화하자고 답했어요. 저는 10분 정도 통화할 수 있어요.',
};
const originalGuide = {
  top:'통합', script:'민서야, 이번 주에 야근이 많아 피곤하다고 했던 말이 생각났어. 괜찮다면 잠깐 안부를 나누고 싶어. 지금 이야기하기 어렵다면 편할 때 말해 줘. 네가 원하는 만큼만 들려줘도 괜찮아.',
  doList:['대화하기 편한 시간인지 먼저 물어보세요.','상대가 이야기하는 동안 판단하지 않고 들어 주세요.','내가 가능한 시간과 도움의 범위를 함께 전해 보세요.'],
  avoid:['바로 답하라고 재촉하지 마세요.','상대의 마음이나 피곤한 이유를 단정하지 마세요.','혼자 모든 문제를 해결해야 한다고 생각하지 마세요.'],
  next:'다음에 이야기하기 편한 시간을 함께 정해 보세요.',
  care:{feel:'친구를 챙기면서 나의 여유도 살펴봐 주세요. 지금 가능한 만큼 마음을 전해도 괜찮아요.',tips:['잠시 쉬어도 괜찮아요.','내가 감당할 수 있는 범위를 말해 주세요.']},
};
const followupGuide = {...originalGuide,
  script:'민서야, 내일 짧게 통화하자고 말해 줘서 고마워. 나는 10분 정도 통화할 수 있어. 너에게도 괜찮을까? 다른 시간이 편하다면 말해 줘. 그 시간에는 네 이야기를 천천히 듣고 싶어.',
  next:'서로 가능한 시간을 정하고, 통화가 끝날 때 다시 이야기할 필요가 있는지 확인해 보세요.',
};
const originalRelationship = {
  patient_summary:sample.observation, supporter_summary:sample.feeling,
  relationship:{label:'친구',supporter_role:'안부를 묻고 싶은 친구',
    dynamics:[{interpretation:'서로 편한 시간과 대화 범위를 확인하는 것이 도움이 될 수 있어요.',certainty:'tentative',evidence:[{subject:'supporter',question_id:'feeling',quote:sample.feeling}]}],
    strengths:[{interpretation:'친구의 이야기를 듣고 싶다는 마음을 표현했어요.',certainty:'tentative',evidence:[{subject:'user_goal',question_id:'want',quote:sample.want}]}],
    boundaries:[{interpretation:'오래 통화하기 어려운 이용자의 여유도 함께 고려할 필요가 있어요.',certainty:'tentative',evidence:[{subject:'supporter',question_id:'feeling',quote:sample.feeling}]}]},
  unknowns:['민서가 지금 나누고 싶은 이야기의 범위'],safety:{urgent:false,evidence:[]},
};
const answer = text => ({text,rawText:text,custom:'',sel:[],skipped:false});
const update = context => ({patient_state:{summary:'미리보기용 상태이며 실제 모델 분석이 아닙니다.',facts:[],unknowns:[],user_goal:context.user_goal?.message?.text||''},
  name_index:null,question_plan:{skip:[]},relationship_memory:{patient:[],supporter:[],relationship:[],unknowns:[]}});

export function previewConfig(env) {
  let url;
  try {url=new URL(env.PREVIEW_DATABASE_URL);} catch {throw new Error('PREVIEW_DATABASE_URL must point to the dedicated local preview database');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||
    url.pathname!=='/hop_followup_preview'||url.search||url.hash||env.NODE_ENV==='production') {
    throw new Error('Only the loopback hop_followup_preview database is allowed');
  }
  const modelMode=env.PREVIEW_MODEL_MODE??'synthetic';
  if(!['synthetic','local'].includes(modelMode))throw new Error('PREVIEW_MODEL_MODE must be synthetic or local');
  const port=Number(env.PREVIEW_PORT??(modelMode==='local'?9012:9011));
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PREVIEW_PORT must be an integer from 1 to 65535');
  return {databaseUrl:url.href,port,modelMode};
}

export function isolatePreviewCookies(req,res,port) {
  const name=`malssi_continuation_preview_${port}`;
  const cookies=String(req.headers.cookie||'').split(';').map(value=>value.trim());
  const token=cookies.find(value=>value.startsWith(name+'='));
  // Cookies share a host across ports. Never let this preview read or replace
  // a regular app session, even if both are running on the same loopback host.
  req.headers.cookie=token?'malssi_session='+token.slice(name.length+1):'';
  const setHeader=res.setHeader;
  res.setHeader=function(header,value) {
    if(String(header).toLowerCase()==='set-cookie') {
      const rename=cookie=>String(cookie).replace(/^malssi_session=/,name+'=');
      value=Array.isArray(value)?value.map(rename):rename(value);
    }
    return setHeader.call(this,header,value);
  };
}

export async function seedPreview(store, owner, {modelMode='synthetic'}={}) {
  // This fixed historical record uses legacy question IDs. New preview chats
  // still obtain the active bank from Store; never mix this fixture with it.
  const state=createIntake();
  state.name=sample.name;state.chatTitle='[예시] 친구 민서';state.status='ready';state.pendingFollow=null;
  state.ans={name:answer(sample.name),rel:answer('친구'),want:answer(sample.want),describe:answer(sample.observation),feeling:answer(sample.feeling)};
  state.log=[{who:'ai',text:'로컬 미리보기용으로 만든 예시 대화예요.',fu:false},
    ...[sample.want,sample.observation,sample.feeling].map(text=>({who:'me',text,fu:false}))];
  const intake=await store.createIntake(owner,state,0),id=await store.nextRecordId();
  const record={id,title:state.chatTitle,date:new Date().toISOString(),profile:{name:sample.name,rel:'친구',safety:false},
    guide:structuredClone(originalGuide),relationship_analysis:structuredClone(originalRelationship),log:state.log,followUps:0,context:buildContext(state)};
  await store.saveRecord(owner,record,intake.id);
  let continuation=await store.createContinuation(owner,id,0,randomUUID());
  // The real-model mode starts empty: every additional response and card must
  // be generated by the normal model pipeline, never by a seeded fixture.
  if(modelMode==='local')return {record,continuation};
  continuation=await store.updateContinuation(owner,continuation.id,continuation.revision,value=>{
    const userId=randomUUID();
    value.messages=[{id:userId,role:'user',kind:'question',text:sample.followup},
      {id:randomUUID(),role:'assistant',kind:'response',text:'미리보기 예시 답변이에요. 내일 통화할 수 있는 시간을 먼저 전하고, 민서에게도 편한지 물어보세요.',clarification:null}];
    value.cards=[{id:randomUUID(),date:new Date().toISOString(),profile:record.profile,guide:structuredClone(followupGuide),
      relationship_analysis:structuredClone(originalRelationship),source_revision:1,provenance:{kind:'preview',model:'synthetic-preview',source_record_id:String(id)}}];
    return value;
  });
  return {record,continuation};
}

export function previewGateway(modelMode='synthetic') {
  if(modelMode==='local')return configuredModelGateway({env:{
    MODEL_BASE_URL:'http://127.0.0.1:11434/v1',MODEL_NAME:'gemma4:12b',
    MODEL_PROTOCOL:'relationship_agent',MODEL_STATE_MODE:'combined_blocks',
    MODEL_AGENT_FORMAT:'json_schema',MODEL_REASONING_EFFORT:'none',
    MODEL_STREAM_JSON:'true',MODEL_STREAM_COMPLETE_JSON:'true',
    MODEL_DISCOVER_TOKEN_LIMITS:'true',MODEL_TIMEOUT_MS:'0',
  }});
  if(modelMode!=='synthetic')throw new Error('PREVIEW_MODEL_MODE must be synthetic or local');
  return {model:'synthetic-preview',protocol:'relationship_agent',
    async updateState(context,_memory,{signal}={}) {await delay(350,undefined,{signal});return update(context);},
    async continueConversation({messages},{signal}={}) {
      await delay(650,undefined,{signal});
      // These are fixed, disclosed UI fixtures, not an NLP classifier. Only the
      // seeded exact report is treated as a fact; arbitrary questions are not.
      const facts=messages.filter(m=>m.role==='user'&&!m.skipped&&m.text===sample.followup)
        .map(m=>({message_id:m.id,subject:'supporter',quote:m.text}));
      return {answer:'미리보기 예시 답변이에요. 서로 편한 시간인지 먼저 확인하고, 내가 가능한 대화 범위를 짧게 전해 보세요. 아래 버튼으로 예시 새 카드를 살펴볼 수 있어요.',
        clarification:null,facts,superseded:[],safety:{urgent:false}};
    },
    async respond(context,_memory,{signal}={}) {
      await delay(1000,undefined,{signal});
      return {...update(context),guide:structuredClone(followupGuide),assessment:{safety:false},relationship_analysis:structuredClone(originalRelationship)};
    },
  };
}

export async function startPreview(config) {
  const schema='continuation_preview_'+randomBytes(8).toString('hex');
  const admin=new pg.Pool({connectionString:config.databaseUrl,connectionTimeoutMillis:5000});
  let app,created=false,stopping;
  const stop=()=>stopping||=(async()=>{
    try {await app?.shutdown();}
    finally {try {if(created)await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally {await admin.end();}}
  })();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);created=true;
    app=await createApp({databaseUrl:config.databaseUrl,schema,key:randomBytes(32),gateway:previewGateway(config.modelMode),referralProvider:null});
    const createBrowser=app.store.createBrowser.bind(app.store);
    app.store.createBrowser=async()=>{const browser=await createBrowser();await seedPreview(app.store,browser.id,{modelMode:config.modelMode});return browser;};
    const notice=config.modelMode==='local'
      ?'로컬 모델 검증 · 원본 관계도·카드는 예시이며, 추가 답변·새 카드는 실제 로컬 모델이 생성합니다. 실제 상담 내용은 입력하지 마세요.'
      :'로컬 미리보기 · 예시 데이터와 모의 응답입니다. 실제 상담 내용은 입력하지 마세요.';
    // Only this isolated preview process adds the notice. Existing app files,
    // security headers, cards and relation markup stay untouched.
    app.server.prependListener('request',(req,res)=>{
      isolatePreviewCookies(req,res,config.port);
      let html=false;
      const writeHead=res.writeHead,end=res.end;
      res.writeHead=function(status,...args){
        const headers=args.find(value=>value&&typeof value==='object'&&!Array.isArray(value));
        html=status===200&&String(headers?.['Content-Type']||'').startsWith('text/html');
        return writeHead.call(this,status,...args);
      };
      res.end=function(chunk,...args){
        if(html&&chunk)chunk=String(chunk).replace('<body>',`<body><aside role="note" style="padding:10px 20px;text-align:center;background:#fff4c7;color:#514522;font-size:14px">${notice}</aside>`);
        return end.call(this,chunk,...args);
      };
    });
    await new Promise((resolveListen,reject)=>{
      app.server.once('error',reject);app.server.listen(config.port,'127.0.0.1',()=>{app.server.removeListener('error',reject);resolveListen();});
    });
    return {app,stop,url:`http://127.0.0.1:${app.server.address().port}`,schema};
  }catch(error){await stop();throw error;}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const config=previewConfig(process.env),preview=await startPreview(config);
    console.log(JSON.stringify({preview:true,url:preview.url+'/records',pid:process.pid,schema:preview.schema,model_calls:config.modelMode==='local'}));
    const stop=()=>preview.stop().then(()=>process.exit(0),()=>process.exit(1));
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
  }catch(error){console.error(error.message.startsWith('PREVIEW_')||error.message.startsWith('Only the loopback')?error.message:'Unable to start the isolated local preview');process.exitCode=1;}
}
