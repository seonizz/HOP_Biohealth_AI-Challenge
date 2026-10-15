import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root=resolve(import.meta.dirname,'..');
const backend=process.env.MALSSI_BACKEND_PATH||resolve(root,'../app');
const load=file=>import(pathToFileURL(resolve(backend,'src',file)));
const {ModelGateway}=await load('model.js');
const {PROMPT_VERSION}=await load('relationship-prompts.js');
const {validatePatientState}=await load('agent-state.js');
const {validateRelationshipMemory,validateEvidence}=await load('relationship-agent.js');
if(PROMPT_VERSION!=='relationship-v3.5-rag')throw new Error('comparison_requires_v35');
const input=JSON.parse(readFileSync(resolve(root,'outputs/relationship_agent/state_prior_comparison_context.json'),'utf8'));
if(input.synthetic!==true)throw new Error('synthetic_context_required');
const context=input.context;
validatePatientState(context.agent_state,context);
validateRelationshipMemory(context.relationship_state,context);

function sourceOnly(payload) {
  const copy=structuredClone(payload),refs=[];
  for(const fact of copy.prior_state.facts)refs.push({subject:fact.subject,question_id:fact.question_id,quote:fact.quote});
  for(const actor of ['patient','supporter','relationship'])for(const finding of copy.prior_relationship_memory[actor])refs.push(...finding.evidence);
  const unique=new Map();
  for(const ref of refs){validateEvidence(ref,context);unique.set(JSON.stringify(ref),ref);}
  delete copy.prior_state;delete copy.prior_relationship_memory;
  copy.prior_evidence=[...unique.values()];
  return copy;
}

const {relationshipStateRequest}=await load('relationship-agent.js');
const original=relationshipStateRequest(context,context.agent_state).data;
const transformed=sourceOnly(original);
assert.deepEqual(transformed.retrieval,original.retrieval);
assert.deepEqual(transformed.latest_answer,original.latest_answer);
assert.deepEqual(transformed.patient,original.patient);
assert.deepEqual(transformed.supporter,original.supporter);
assert.ok(!Object.hasOwn(transformed,'prior_state'));
assert.ok(!Object.hasOwn(transformed,'prior_relationship_memory'));
assert.ok(transformed.prior_evidence.length>0);
if(process.argv.includes('--check')) {
  console.log(JSON.stringify({status:'transform_passed',references:transformed.prior_evidence.length}));
} else {
  if(process.argv.length!==2)throw new Error('unknown_option');
  const config=JSON.parse(readFileSync(resolve(root,'local_api/runtime/config.json'),'utf8'));
  if(config.ollama_url!=='http://127.0.0.1:11434'||config.model!=='gemma4:12b')throw new Error('local_model_required');
  const report={synthetic:true,prompt_version:PROMPT_VERSION,latest_answer:context.latest_answer,measured_at:new Date().toISOString(),conditions:[]};
  const output=resolve(root,'outputs/relationship_agent/state_prior_comparison-v35.json');
  for(const condition of ['baseline','source_only']) {
    const trace=[];
    const gateway=new ModelGateway({baseUrl:config.ollama_url+'/v1',apiKey:config.api_key,model:'gemma4:12b',protocol:'relationship_agent',timeoutMs:600000,diagnosticLogger:entry=>trace.push(entry)});
    const complete=gateway.agentComplete.bind(gateway);
    gateway.agentComplete=async(stage,prompt,payload,...rest)=>complete(stage,prompt,condition==='source_only'&&stage==='state'?sourceOnly(payload):payload,...rest);
    const started=performance.now();
    try {
      const result=await gateway.updateState(structuredClone(context),structuredClone(context.agent_state));
      const memory=result.relationship_memory;
      const latest=context.latest_answer;
      const coverage=Object.fromEntries(['patient','supporter','relationship'].map(actor=>[actor,memory[actor].some(item=>item.evidence.some(ref=>ref.subject===latest.subject&&ref.question_id===latest.question_id))]));
      report.conditions.push({condition,duration_ms:Math.round(performance.now()-started),latest_evidence:coverage,result,trace});
      console.log(JSON.stringify({condition,status:'passed',duration_ms:report.conditions.at(-1).duration_ms,latest_evidence:coverage}));
    } catch(error) {
      report.conditions.push({condition,duration_ms:Math.round(performance.now()-started),error:error.code||error.message,reason:error.modelReason,trace});
      process.exitCode=1;
      console.log(JSON.stringify({condition,status:'failed',code:error.code||error.message,reason:error.modelReason}));
    }
    writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  }
}
