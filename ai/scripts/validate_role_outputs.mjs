// Offline structural/source-reference checks. Never supplies semantic approvals.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';

let repository=path.dirname(fileURLToPath(import.meta.url));
while(!fs.existsSync(path.join(repository,'app/src/relationship-agent.js'))) {
  const parent=path.dirname(repository);
  if(parent===repository)throw new Error('Run within the source checkout containing app/src');
  repository=parent;
}
const {validateSchema,relationshipStateRequest,canonicalRelationshipState,assertRetrievedEvidence,
  relationshipQuestionRequest,validateRelationshipQuestions,questionReviewRequest,applyQuestionReview}=
  await import(pathToFileURL(path.join(repository,'app/src/relationship-agent.js')));
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(sorted(value))).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const rows=p=>fs.readFileSync(p,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const require=(ok,message)=>{if(!ok)throw new Error(message);};

export function checkResponse(request,text,reference) {
  require(typeof text==='string'&&text.trim(),'Missing response');
  if(request.format==='text') {require(text.length<=8000,'Overlong dialogue response');return;}
  const payload=JSON.parse(request.messages.at(-1).content),value=JSON.parse(text);
  validateSchema(value,payload.output_schema,'output',true);
  if(!reference.source_context||request.task.startsWith('final_card_'))return;
  const context=reference.source_context;
  const stateRequest=relationshipStateRequest(context,null);
  if(['state_observations','relationship_memory','turn_draft'].includes(request.task)) {
    assertRetrievedEvidence(value,stateRequest.retrieval);
    if(request.task==='turn_draft') {
      canonicalRelationshipState(value.state,context,stateRequest.schema);
      validateRelationshipQuestions(value.questions,context,relationshipQuestionRequest(context));
    }
  }
  if(request.task==='question_plan')validateRelationshipQuestions(value,context,relationshipQuestionRequest(context));
  if(request.task==='question_review') {
    // The request itself holds the reviewed claims; schema and exact IDs are
    // automatic checks. Whether verdicts/reasons are correct requires a judge.
    const expected=payload.data.claims?.map(c=>c.id)||payload.data.audits?.map(c=>c.id);
    if(expected)require(value.audits.length===expected.length&&new Set(value.audits.map(a=>a.id)).size===expected.length
      &&value.audits.every(a=>expected.includes(a.id)),'Missing/duplicate review claim');
  }
}

export function validateOutputs(root,role,split,outputPath) {
  const folder=path.join(root,role,split),suite=read(path.join(folder,'SUITE.json'));
  const inputs=rows(path.join(folder,'INPUTS.jsonl')),referenceRows=rows(path.join(folder,'REFERENCES.jsonl')),
    refs=new Map(referenceRows.map(c=>[c.case_id,c]));
  require(suite.schema==='malssi-role-evaluation-suite-v1'&&suite.model_role===role&&suite.split===split
    &&Array.isArray(suite.cases)&&suite.cases.length>0,'Wrong suite contract');
  const inventory=new Map(suite.cases.map(c=>[c.case_id,c]));
  require(inventory.size===suite.cases.length&&new Set(inputs.map(c=>c.case_id)).size===inputs.length
    &&inventory.size===inputs.length&&inventory.size===refs.size&&refs.size===referenceRows.length,'Case inventory mismatch');
  const requestIds=new Set();
  for(const input of inputs) {
    const frozen=inventory.get(input.case_id),reference=refs.get(input.case_id);
    require(frozen&&reference&&digest(input)===frozen.input_sha256&&reference.input_sha256===frozen.input_sha256
      &&digest(reference)===frozen.reference_sha256,
      'Input/reference differs from frozen suite');
    require(Array.isArray(input.requests)&&input.requests.length>0,'Empty request inventory');
    for(const request of input.requests) {
      require(typeof request.request_id==='string'&&request.request_id&&!requestIds.has(request.request_id),'Duplicate/missing request ID');
      requestIds.add(request.request_id);
    }
  }
  const output=read(outputPath);
  require(output.schema==='malssi-role-model-outputs-v1'&&output.model_role===role&&output.split===split
    &&output.suite_sha256===digest(suite)&&/^[0-9a-f]{64}$/.test(output.checkpoint_sha256),'Wrong output/suite/checkpoint binding');
  const expected=new Map(inputs.flatMap(c=>c.requests.map(r=>[c.case_id+'\0'+r.request_id,{request:r,reference:refs.get(c.case_id)}])));
  require(Array.isArray(output.responses),'Missing response inventory');
  const seen=new Set(),valid=Object.fromEntries(inputs.map(c=>[c.case_id,true])),errors=[];
  for(const row of output.responses) {
    const id=row.case_id+'\0'+row.request_id;
    require(expected.has(id)&&!seen.has(id),'Unexpected or duplicate response');seen.add(id);
    try {const item=expected.get(id);checkResponse(item.request,row.text,item.reference);}
    catch(error) {valid[row.case_id]=false;errors.push({case_id:row.case_id,request_id:row.request_id,
      reason:String(error.modelReason||error.message).slice(0,300)});}
  }
  for(const [id] of expected)if(!seen.has(id)) {
    const [case_id,request_id]=id.split('\0');valid[case_id]=false;errors.push({case_id,request_id,reason:'missing_response'});
  }
  return {checkpoint_sha256:output.checkpoint_sha256,suite_sha256:output.suite_sha256,
    expected_responses:expected.size,received_responses:seen.size,schema_valid_by_case:valid,errors,
    semantic_quality_evaluated:false,model_calls:0};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(validateOutputs(...process.argv.slice(2,6))));
}
