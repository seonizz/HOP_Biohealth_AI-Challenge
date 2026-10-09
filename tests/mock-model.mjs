// Synthetic deterministic model used ONLY by compose.e2e.yaml, never the normal stack.
import {createServer} from 'node:http';
const guidance={kind:'communication_guidance',supporter_acknowledgement:'곁에서 고민하고 계시는 마음을 들었습니다.',situation_summary:'친구와 이야기할 방법을 함께 정리하고 있습니다.',suggested_words:[{text:'괜찮다면 요즘 어떻게 지내는지 들어도 될까요?',purpose:'상대가 이야기할지 선택할 수 있도록 여쭤봅니다.',source_refs:[]}],actions:[{title:'편한 시간 물어보기',how:'이야기하기 편한 시간을 먼저 물어보세요.',preconditions:['내가 이야기할 여유가 있을 때'],stop_if:['상대가 원하지 않을 때'],source_refs:[]}],avoid:[{expression:'왜 그렇게 해?',reason:'추궁하는 말로 들릴 수 있습니다.',alternative:'어떤 일이 있었는지 듣고 싶어요.'}],supporter_care:['내가 쉴 시간도 챙겨 주세요.'],limitations:['자동화된 합성 테스트용 출력입니다. 실제 모델 평가 결과가 아닙니다.'],citations:[],next_actions:['choose_plan','ask_more','finish']};
createServer(async(req,res)=>{
  const send=(code,body)=>{res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
  if(req.url==='/v1/models')return send(200,{data:[{id:'synthetic-test-only'}]});
  let data;try{const chunks=[];for await(const c of req)chunks.push(c);data=JSON.parse(Buffer.concat(chunks).toString());}catch{return send(400,{});}
  if(req.url==='/tokenize')return send(200,{tokens:Array(Math.ceil(data.content.length/3)).fill(1)});
  if(req.url!=='/v1/chat/completions')return send(404,{});
  const kind=data.response_format?.json_schema?.name;
  const value=kind==='malssi_guide'?guidance:kind==='malssi_verify'?{approved:true,issues:[]}:{assertion_candidates:[],topic_candidates:[],safety_observations:[],contradictions:[]};
  setTimeout(()=>send(200,{choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]}),200);
}).listen(8081,'0.0.0.0',()=>console.log('Synthetic model fixture listening'));
