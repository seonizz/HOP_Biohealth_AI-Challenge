import {pathToFileURL,fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {writeFile,mkdir} from 'node:fs/promises';
import {modelHttpFetch} from '../src/model-http.js';
import {JSON_STREAM_COMPLETE,streamJsonResponse,schemaArrayLimit,schemaPropertyArrayLimits,schemaArrayPaths,schemaStringLimit} from '../src/model-stream.js';
import {compactReviewTransport} from '../src/compact-review-transport.js';
import {auditSchema,validateAudits} from '../src/grounding-audit.js';
import {validateSchema} from '../src/relationship-agent.js';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const text={type:'string',minLength:1,maxLength:120};

// This diagnostic never reads app/.env or accepts a remote/GPU destination.
export async function localReviewSmoke({baseUrl='http://127.0.0.1:11434/v1',model='gemma4:12b',fetchImpl=modelHttpFetch,timeoutMs=90000}={}) {
  const url=new URL(baseUrl);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||
    url.username||url.password||url.search||url.hash||url.pathname!=='/v1'||model!=='gemma4:12b')
    throw new Error('This smoke test accepts only the local gemma4:12b endpoint');
  const results=[];
  for(const [name,claim,expected]of [
    ['supported','일요일 저녁에 20분 통화할 수 있다고 말했어요.',true],
    ['contradiction','어제 이미 통화를 마쳤다고 말했어요.',false],
  ]) {
    const claims=[{id:'script.0',claim,certainty:'reported',evidence:[{subject:'supporter',question_id:'available',quote:'일요일 저녁에 20분 통화할 수 있어요.'}]}];
    const payload={synthetic:true,answers:{supporter:[{question_id:'available',text:'일요일 저녁에 20분 통화할 수 있어요.'}]},claims};
    const schema=object({audits:auditSchema(claims),issues:{type:'array',maxItems:1,items:object({field:{type:'string',enum:['script']},reason:text,repair:text})},approved:{type:'boolean'}});
    const codec=compactReviewTransport({stage:'speech_review',schema,payload});
    if(!codec)throw new Error('Compact review schema is unavailable');
    const started=performance.now();let result,error,usage,finish;
    try {
      const controller=new AbortController(),signal=AbortSignal.any([AbortSignal.timeout(timeoutMs),controller.signal]);
      let response=await fetchImpl(baseUrl+'/chat/completions',{method:'POST',signal,
        headers:{'Content-Type':'application/json',Authorization:'Bearer local-ollama'},body:JSON.stringify({model,stream:true,reasoning_effort:'none',temperature:0,max_tokens:384,
          response_format:{type:'json_schema',json_schema:{name:'synthetic_compact_review',strict:true,schema:codec.schema}},
          messages:[{role:'system',content:'합성 원문과 claims를 독립적으로 대조하세요. 실제로 보고한 사실·시점만 supported이며 미래의 가능성을 이미 일어난 사건으로 바꾸면 unsupported입니다. 각 audit의 구체적 이유는 짧은 한 문장으로 쓰세요. 모든 주장이 supported일 때만 approved=true와 issues=[]입니다. 반려면 approved=false와 실제 오류·수정 지시를 쓰세요. JSON 객체만 반환하세요.'+codec.instruction},
            {role:'user',content:JSON.stringify({stage:'speech_review',data:payload,output_schema:codec.schema})}]})});
      if(!response.ok)throw new Error('HTTP_'+response.status);
      response=await streamJsonResponse(response,{signal,completeJson:true,abort:error=>controller.abort(error),
        arrayLimit:schemaArrayLimit(codec.schema),propertyArrayLimits:schemaPropertyArrayLimits(codec.schema),
        arrayPaths:schemaArrayPaths(codec.schema),stringLimit:schemaStringLimit(codec.schema)});
      const answer=await response.json();usage=answer.usage;finish=answer.choices?.[0]?.finish_reason;
      if(response[JSON_STREAM_COMPLETE]===true&&finish===null)finish='json_complete';
      if(!['stop','json_complete'].includes(finish))throw new Error('INCOMPLETE_OUTPUT');
      result=codec.hydrate(JSON.parse(answer.choices[0].message.content));
      validateSchema(result,schema);validateAudits(result.audits,claims,result.approved);
      if(result.approved!==(result.issues.length===0)||result.approved!==expected)throw new Error('REVIEW_VERDICT_MISMATCH');
    } catch(failure) {error=failure.code||(/^(?:HTTP_\d+|INCOMPLETE_OUTPUT|REVIEW_VERDICT_MISMATCH)$/u.test(failure.message)?failure.message:failure.name);}
    results.push({case:name,ok:!error,error,elapsed_ms:Math.round(performance.now()-started),finish_reason:finish,
      usage:usage?{prompt_tokens:usage.prompt_tokens,completion_tokens:usage.completion_tokens}:null});
  }
  return {ok:results.every(result=>result.ok),synthetic_only:true,model,scope:'Two local format/grounding smoke requests; no production model or end-to-end latency measurement',results};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv.slice(2).join(' ')!=='--run')throw new Error('Use --run to send the two local synthetic requests');
  const report=await localReviewSmoke();
  const directory=new URL('../../runtime/response-latency-20261110/',import.meta.url);
  await mkdir(directory,{recursive:true});
  await writeFile(fileURLToPath(new URL('local-compact-smoke.json',directory)),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;
}
