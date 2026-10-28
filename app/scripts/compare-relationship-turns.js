// Paired synthetic evaluation. Never load user conversations or training data.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { ModelGateway } from '../src/model.js';
import { modelHttpFetch } from '../src/model-http.js';
import { cases, evaluateTurn } from './turn-comparison-cases.js';

const args=process.argv.slice(2);
const option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const output=resolve(option('--output',resolve(root,'runtime/turn-call-comparison-20261017/paired.json')));
const ids=option('--cases','').split(',').filter(Boolean);
const selected=ids.length?ids.map(id=>cases.find(item=>item.id===id)):cases;
if(!selected.length||selected.some(item=>!item)||new Set(ids).size!==ids.length)throw new Error('Unknown or duplicate comparison case');
const rounds=Number(option('--rounds','1'));
const temperature=Number(option('--temperature','0'));
const modes=option('--modes','staged,combined').split(',');
if(!modes.length||new Set(modes).size!==modes.length||modes.some(mode=>!['staged','combined'].includes(mode)))throw new Error('Invalid comparison modes');
if(!Number.isInteger(rounds)||rounds<1||rounds>5||![0,0.2].includes(temperature))throw new Error('Invalid comparison options');
for(const key of ['MODEL_BASE_URL','MODEL_API_KEY','MODEL_NAME'])if(!process.env[key])throw new Error('Missing required model configuration: '+key);
const files=['app/src/model.js','app/src/relationship-turn.js','app/src/relationship-agent.js','app/src/relationship-prompts.js',
  'app/src/agent-state.js','app/src/model-schema.js','app/src/relationship-retrieval.js','app/src/answer-sources.js',
  'app/scripts/turn-comparison-cases.js','app/scripts/compare-relationship-turns.js'];
const sha=value=>createHash('sha256').update(value).digest('hex');
const report={version:2,synthetic:true,started_at:new Date().toISOString(),model:process.env.MODEL_NAME,
  temperature,rounds,modes,case_ids:selected.map(item=>item.id),
  fixture_sha256:sha(JSON.stringify(selected)),
  input_sha256:sha(JSON.stringify(selected.map(({id,context,priorMemory})=>({id,context,priorMemory:priorMemory??null})))),
  code_sha256:Object.fromEntries(await Promise.all(files.map(async name=>[name,sha(await readFile(resolve(root,name)))]))),
  limitations:['Finite synthetic cases; not a population accuracy or statistical non-inferiority result.',
    'Deterministic checks cover listed source and decision expectations; they do not certify all natural-language meaning.'],results:[]};
await mkdir(dirname(output),{recursive:true});
const save=()=>writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600,flag:'wx'});
for(let round=0;round<rounds;round++)for(const [index,testCase] of selected.entries()) {
  const order=((round+index)%2?['combined','staged']:['staged','combined']).filter(mode=>modes.includes(mode));
  for(const mode of order) {
    const attempts=[],wire=[];
    const model=new ModelGateway({baseUrl:process.env.MODEL_BASE_URL,apiKey:process.env.MODEL_API_KEY,
      model:process.env.MODEL_NAME,protocol:'relationship_agent',stateMode:mode,
      agentFormat:process.env.MODEL_AGENT_FORMAT||'prompt',reasoningEffort:process.env.MODEL_REASONING_EFFORT||'omit',
      timeoutMs:3600000,diagnosticLogger:entry=>attempts.push(entry),
      fetchImpl:async(url,options)=>{
        const body=JSON.parse(options.body);body.temperature=temperature;
        const input=JSON.parse(body.messages.at(-1).content);
        const attempt={stage:input.stage,status:null};wire.push(attempt);
        const response=await modelHttpFetch(url,{...options,body:JSON.stringify(body)});
        attempt.status=response.status;
        // Recording must not change the gateway's error classification or retries.
        // All case inputs are synthetic; raw generations permit independent inspection.
        try { attempt.response=await response.clone().json(); }
        catch { attempt.response_unreadable=true; }
        return response;
      }});
    const result={case_id:testCase.id,round,mode};
    console.log(JSON.stringify({event:'started',case_id:testCase.id,round,mode}));
    const started=performance.now();
    try {
      result.output=await model.updateState(structuredClone(testCase.context),structuredClone(testCase.priorMemory??null));
      result.evaluation=evaluateTurn(testCase,result.output);
      result.completed=true;
    } catch(error) {
      result.completed=false;result.error={code:error.code||'UNEXPECTED',reason:error.modelReason||null};
      result.evaluation={passed:false,checks:evaluateTurn(testCase,null).checks.map(({id})=>
        ({id,passed:false,detail:'No completed output.'}))};
    }
    result.elapsed_ms=Math.round(performance.now()-started);
    result.usage={prompt_tokens:0,completion_tokens:0,reported_calls:0};
    for(const attempt of wire)if(attempt.response?.usage){
      result.usage.prompt_tokens+=attempt.response.usage.prompt_tokens||0;
      result.usage.completion_tokens+=attempt.response.usage.completion_tokens||0;
      result.usage.reported_calls++;
    }
    result.attempts=attempts;result.wire=wire;
    report.results.push(result);await save();
    console.log(JSON.stringify({event:'completed',case_id:testCase.id,round,mode,completed:result.completed,
      passed:result.evaluation.passed,failures:result.evaluation.checks.filter(c=>!c.passed).map(c=>c.id),
      calls:wire.length,elapsed_ms:result.elapsed_ms,usage:result.usage,error:result.error}));
  }
}
const pairs=[];
if(modes.length===2)for(let round=0;round<rounds;round++)for(const testCase of selected){
  const get=mode=>report.results.find(r=>r.case_id===testCase.id&&r.round===round&&r.mode===mode);
  const staged=get('staged'),combined=get('combined');
  const regressions=staged.evaluation.checks.filter(c=>c.passed&&!combined.evaluation.checks.some(n=>n.id===c.id&&n.passed)).map(c=>c.id);
  pairs.push({case_id:testCase.id,round,staged_passed:staged.evaluation.passed,combined_passed:combined.evaluation.passed,
    completion_regression:staged.completed&&!combined.completed,check_regressions:regressions,
    staged_elapsed_ms:staged.elapsed_ms,combined_elapsed_ms:combined.elapsed_ms,
    latency_change_percent:Math.round((combined.elapsed_ms/staged.elapsed_ms-1)*1000)/10});
}
report.completed_at=new Date().toISOString();
report.summary={pairs,modes:Object.fromEntries(modes.map(mode=>{
  const rows=report.results.filter(r=>r.mode===mode);
  return [mode,{total:rows.length,completed:rows.filter(r=>r.completed).length,passed:rows.filter(r=>r.evaluation.passed).length,
    calls:rows.reduce((n,r)=>n+r.wire.length,0),checks:rows.reduce((n,r)=>n+r.evaluation.checks.length,0),
    elapsed_ms:rows.reduce((n,r)=>n+r.elapsed_ms,0),
    prompt_tokens:rows.reduce((n,r)=>n+r.usage.prompt_tokens,0),
    completion_tokens:rows.reduce((n,r)=>n+r.usage.completion_tokens,0),
    failed_checks:rows.reduce((n,r)=>n+r.evaluation.checks.filter(c=>!c.passed).length,0)}];
})),regression_pairs:pairs.filter(p=>p.completion_regression||p.check_regressions.length).length};
await save();
console.log(JSON.stringify({event:'finished',summary:report.summary}));
const targetMode=modes.includes('combined')?'combined':'staged';
if(report.summary.regression_pairs||report.summary.modes[targetMode].passed!==selected.length*rounds)process.exitCode=1;
